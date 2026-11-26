import { openAsBlob } from 'node:fs';
import * as C from '../../web/reel/core.js';
import { StorageClient, FirestoreClient } from '../../web/reel/cloud.js';

const check = (value, message) => { if (!value) throw Error(message); };

/** Explicit, main-process-only sharing for completed local meeting recordings. */
export function createMeetingShare({ auth, store, org, cfg: cloudOverrides = {}, copy = () => {},
  storageFactory = (session, cfg, nonce) => new StorageClient(session, cfg, nonce),
  firestoreFactory = (session, cfg) => new FirestoreClient(session, cfg) } = {}) {
  check(typeof auth?.getProfile === 'function' && typeof auth?.getIdToken === 'function'
    && typeof store?.getShareRecord === 'function' && typeof store?.bindShare === 'function'
    && typeof store?.saveShareState === 'function' && org, 'Meeting sharing is unavailable.');
  const cfg = { ...C.CLOUD, projectID: org.projectID, bucket: org.bucket, apiKey: org.apiKey,
    viewerBase: org.viewerBase, viewerPath: org.viewerPath, allowedEmailDomain: org.allowedEmailDomain,
    firestoreDatabase: org.firestoreDatabase, ...cloudOverrides };

  function current(ownerUserID) {
    check(typeof ownerUserID === 'string' && ownerUserID && auth.getProfile()?.userID === ownerUserID,
      'Sign in as the meeting owner to share this recording.');
  }
  const active = new Map();
  async function runShare({ ownerUserID, id, includeTranscript = false }) {
    current(ownerUserID);
    const record = await store.getShareRecord({ ownerUserID, id });
    check(record?.meeting === true, 'This saved meeting recording is unavailable.');
    let bound = record.share;
    let published=false;
    try {
      if (!bound) {
        const recordingNonce = C.newRecordingNonce();
        const shareID = await C.ownerShareID(ownerUserID, recordingNonce);
        current(ownerUserID);
        bound = await store.bindShare({ ownerUserID, expectedOwnerUserID: ownerUserID, id, recordingNonce, shareID, includeTranscript: includeTranscript === true });
      }
      current(ownerUserID);
      if (bound.upload === 'uploaded') {
        published=true;
        const url = C.viewerURL(bound.shareID, cfg); current(ownerUserID); copy(url); return { url, uploaded: true };
      }
      const date = new Date(record.createdAt);
      check(Number.isFinite(date.getTime()) && Number.isFinite(record.durationSeconds)
        && record.durationSeconds > 0 && record.durationSeconds <= 604800,
        'The saved meeting recording is incomplete.');
      check(Number.isInteger(record.width) && record.width > 0 && Number.isInteger(record.height) && record.height > 0,
        'The saved meeting recording dimensions are unavailable.');
      const title=String(record.title??'').trim().slice(0,500)||'Meeting';
      const remote = C.newRecording({ id, shareID: bound.shareID, title, createdAt: date, mode: 'window', upload: 'uploaded' });
      Object.assign(remote, { durationSeconds: record.durationSeconds, width: record.width, height: record.height,
        captureState: 'complete', transcriptStatus: 'none', playback: { hls: false, mp4: true }, meeting: {} });
      let transcript;
      if (bound.includeTranscript === true) {
        const processing = store.getProcessing({ ownerUserID, id });
        check(processing?.transcriptComplete === true && processing.text?.trim()
          && processing.segments?.length, 'This recording has no finished transcript to share.');
        transcript = {
          schemaVersion: 1, id: bound.shareID, title, createdAt: date.toISOString(),
          durationSeconds: remote.durationSeconds, language: processing.language ?? 'en', engine: processing.engine,
          timingGranularity: processing.timingGranularity, text: processing.text,
          segments: processing.segments.map(({ start, end, text }) => ({ start, end, text })),
        };
        remote.transcriptStatus = 'ready';
      }
      await store.saveShareState({ ownerUserID, expectedOwnerUserID: ownerUserID, id, shareID: bound.shareID, upload: 'uploading' });
      current(ownerUserID);
      const profile = auth.getProfile();
      const session = { uid: ownerUserID, email: profile.email, displayName: profile.displayName,
        assertCurrent: () => current(ownerUserID), isCurrent: () => auth.getProfile()?.userID === ownerUserID,
        getIdToken: async () => { current(ownerUserID); const token = await auth.getIdToken(); current(ownerUserID); return token; } };
      const storage = storageFactory(session, cfg, bound.recordingNonce);
      const firestore = firestoreFactory(session, cfg);
      await firestore.ensureRoom(C.recordingRoom(remote), date, null, 0, bound.recordingNonce);
      current(ownerUserID);
      const video = await openAsBlob(record.path, { type: 'video/mp4' });
      check(video.size>0,'The saved meeting video is empty.');
      current(ownerUserID);
      await storage.uploadLarge(bound.shareID, C.File.video, video, {
        options: { contentDisposition: C.attachmentDisposition(title) },
      });
      current(ownerUserID);
      if (transcript) {
        await storage.upload(bound.shareID, C.File.transcriptJSON, C.encodeJSON(transcript));
        current(ownerUserID);
        await storage.upload(bound.shareID, C.File.transcriptText, C.transcriptText(transcript));
        current(ownerUserID);
      }
      await storage.upload(bound.shareID, C.File.meta,
        C.encodeJSON(C.remoteMeta(remote, 'ready', profile.displayName || profile.email, 'Reel Windows meeting')));
      current(ownerUserID);
      await firestore.upsertLibraryEntry(remote);
      current(ownerUserID);
      await store.saveShareState({ ownerUserID, expectedOwnerUserID: ownerUserID, id, shareID: bound.shareID, upload: 'uploaded' });
      published=true;
      const url = C.viewerURL(bound.shareID, cfg); current(ownerUserID); copy(url); return { url, uploaded: true };
    } catch (error) {
      if (bound && !published) await store.saveShareState({ ownerUserID, expectedOwnerUserID: ownerUserID, id, shareID: bound.shareID,
        upload: { failed: String(error?.message || 'Upload failed').slice(0, 240) } }).catch(() => {});
      throw error;
    }
  }
  function share(args) {
    const key = `${args?.ownerUserID}:${args?.id}`;
    if (active.has(key)) return active.get(key);
    const task = runShare(args).finally(() => active.delete(key));
    active.set(key, task); return task;
  }
  return { share };
}

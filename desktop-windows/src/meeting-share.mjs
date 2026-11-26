import { openAsBlob } from 'node:fs';
import * as C from '../../web/reel/core.js';
import { StorageClient, FirestoreClient } from '../../web/reel/cloud.js';

const check = (value, message) => { if (!value) throw Error(message); };
const MIN_PASSWORD_LENGTH = 12;

/** Explicit, main-process-only sharing for completed local meeting recordings. */
export function createMeetingShare({ auth, store, org, cfg: cloudOverrides = {}, copy = () => {}, now = () => new Date(),
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
  const accessActive = new Map();
  async function runShare({ ownerUserID, id, includeTranscript = false, password = '', expiry = 'never' }) {
    current(ownerUserID);
    const record = await store.getShareRecord({ ownerUserID, id });
    check(record?.meeting === true, 'This saved meeting recording is unavailable.');
    let bound = record.share;
    check(!bound?.accessUpdate, 'A link settings update is pending. Retry that update before copying the link.');
    let published=false;
    try {
      if (!bound) {
        check(typeof password === 'string' && password.length <= 1024, 'Invalid recording password.');
        let key = null, passwordSalt = null;
        if (password) {
          check(password.length >= MIN_PASSWORD_LENGTH,
            `Use at least ${MIN_PASSWORD_LENGTH} characters for the recording password.`);
          passwordSalt = C.newSalt();
          key = await C.deriveKey(password, passwordSalt);
          check(C.isValidKey(key), "Couldn't derive a key from that password.");
        }
        check(typeof expiry === 'string' && Object.hasOwn(C.EXPIRY_OPTIONS, expiry), 'Choose a valid link expiry.');
        const expiresAt = C.expiryDate(expiry, now());
        const recordingNonce = C.newRecordingNonce();
        const shareID = await C.ownerShareID(ownerUserID, recordingNonce);
        current(ownerUserID);
        bound = await store.bindShare({ ownerUserID, expectedOwnerUserID: ownerUserID, id, recordingNonce, shareID,
          includeTranscript: includeTranscript === true,
          access: { key, passwordSalt, expiresAt: expiresAt ? C.iso8601(expiresAt) : null } });
      }
      const access = bound.access && typeof bound.access === 'object' ? bound.access : { key: null, passwordSalt: null, expiresAt: null };
      check((access.key === null || C.isValidKey(access.key))
        && (access.passwordSalt === null || /^[0-9a-f]{32}$/.test(access.passwordSalt))
        && ((access.key === null && access.passwordSalt === null) || (access.key !== null && access.passwordSalt !== null))
        && (access.expiresAt == null || (typeof access.expiresAt === 'string'
          && Number.isFinite(Date.parse(access.expiresAt))
          && new Date(access.expiresAt).toISOString().replace('.000Z', 'Z') === access.expiresAt)),
      'This recording has invalid saved sharing settings.');
      const expiresAt = access.expiresAt == null ? null : new Date(access.expiresAt);
      check(!expiresAt || (Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() > now().getTime()),
        'This share has expired and cannot be resumed.');
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
        captureState: 'complete', transcriptStatus: 'none', playback: { hls: false, mp4: true }, meeting: {},
        access: { key: access.key, passwordSalt: access.passwordSalt, expiresAt } });
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
      await firestore.ensureRoom(C.recordingRoom(remote), date, expiresAt, 0, bound.recordingNonce);
      current(ownerUserID);
      const uploadOptions = { key: access.key, options: { expiresAt } };
      if (access.key) {
        await storage.upload(bound.shareID, C.File.meta,
          C.encodeJSON(C.lockedStub(bound.shareID, access.passwordSalt, expiresAt, 'processing')),
          { key: null, options: { expiresAt } });
        current(ownerUserID);
      }
      const video = await openAsBlob(record.path, { type: 'video/mp4' });
      check(video.size>0,'The saved meeting video is empty.');
      current(ownerUserID);
      await storage.uploadLarge(bound.shareID, C.File.video, video, {
        ...uploadOptions, options: { ...uploadOptions.options, contentDisposition: C.attachmentDisposition(title) },
      });
      current(ownerUserID);
      if (transcript) {
        await storage.upload(bound.shareID, C.File.transcriptJSON, C.encodeJSON(transcript), uploadOptions);
        current(ownerUserID);
        await storage.upload(bound.shareID, C.File.transcriptText, C.transcriptText(transcript), uploadOptions);
        current(ownerUserID);
      }
      await storage.upload(bound.shareID, C.File.meta,
        C.encodeJSON(C.remoteMeta(remote, 'ready', profile.displayName || profile.email, 'Reel Windows meeting')),
        uploadOptions);
      current(ownerUserID);
      if (access.key) {
        await storage.upload(bound.shareID, C.File.meta,
          C.encodeJSON(C.lockedStub(bound.shareID, access.passwordSalt, expiresAt, 'ready')),
          { key: null, options: { expiresAt } });
        current(ownerUserID);
      }
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
    const task = (store.withRecordingLock
      ? store.withRecordingLock({ ownerUserID: args?.ownerUserID, id: args?.id }, () => runShare(args))
      : runShare(args)).finally(() => active.delete(key));
    active.set(key, task); return task;
  }
  async function runAccessUpdate({ ownerUserID, id, password = '', removePassword = false, expiry = 'keep' }) {
    current(ownerUserID);
    const record = await store.getShareRecord({ ownerUserID, id });
    check(record?.meeting === true && (record.share?.upload === 'uploaded' || record.share?.accessUpdate), 'This meeting has no published link to update.');
    let bound = record.share;
    let update = bound.accessUpdate;
    const validAccess = access => access && (access.key === null || C.isValidKey(access.key))
      && (access.passwordSalt === null || /^[0-9a-f]{32}$/.test(access.passwordSalt))
      && ((access.key === null && access.passwordSalt === null) || (access.key !== null && access.passwordSalt !== null))
      && (access.expiresAt == null || (typeof access.expiresAt === 'string' && Number.isFinite(Date.parse(access.expiresAt))));
    if (update) {
      check(validAccess(update.from) && validAccess(update.to), 'This recording has invalid saved sharing settings.');
    } else {
      const from = bound.access ?? { key:null, passwordSalt:null, expiresAt:null };
      check(validAccess(from), 'This recording has invalid saved sharing settings.');
      check(typeof password === 'string' && password.length <= 1024, 'Invalid recording password.');
      check(typeof removePassword === 'boolean' && !(removePassword && password), 'Choose either a new password or remove the password.');
      check(typeof expiry === 'string' && (expiry === 'keep' || Object.hasOwn(C.EXPIRY_OPTIONS, expiry)), 'Choose a valid link expiry.');
      let key = from.key, passwordSalt = from.passwordSalt;
      if (removePassword) { key = null; passwordSalt = null; }
      else if (password) {
        check(password.length >= MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters for the recording password.`);
        passwordSalt = C.newSalt(); key = await C.deriveKey(password, passwordSalt);
        check(C.isValidKey(key), "Couldn't derive a key from that password.");
      }
      const expiresAt = expiry === 'keep' ? from.expiresAt : (C.expiryDate(expiry, now()) ? C.iso8601(C.expiryDate(expiry, now())) : null);
      const to = { key, passwordSalt, expiresAt };
      check(JSON.stringify(from) !== JSON.stringify(to), 'Choose a different password or expiry for this link.');
      update = { from:structuredClone(from), to };
      current(ownerUserID);
      await store.saveShareAccessUpdate({ownerUserID,expectedOwnerUserID:ownerUserID,id,shareID:bound.shareID,update});
      current(ownerUserID);
    }

    const from = update.from, to = update.to;
    const files = [C.File.video, ...(bound.includeTranscript === true ? [C.File.transcriptJSON,C.File.transcriptText] : [])];
    const expiresAt = to.expiresAt == null ? null : new Date(to.expiresAt);
    const priorExpiry = new Date(Math.min(now().getTime() - 60_000, Date.parse(from.expiresAt ?? '1970-01-01T00:00:00.000Z')));
    const profile = auth.getProfile();
    const session = { uid:ownerUserID, email:profile.email, displayName:profile.displayName,
      assertCurrent:()=>current(ownerUserID), isCurrent:()=>auth.getProfile()?.userID===ownerUserID,
      getIdToken:async()=>{current(ownerUserID);const token=await auth.getIdToken();current(ownerUserID);return token;} };
    const storage = storageFactory(session,cfg,bound.recordingNonce), firestore = firestoreFactory(session,cfg);
    const oldRoom=C.recordingRoom({shareID:bound.shareID,access:{key:from.key}});
    const newRoom=C.recordingRoom({shareID:bound.shareID,access:{key:to.key}});
    const oldFiles = [...files,C.File.meta];
    const date = new Date(record.createdAt);
    check(Number.isFinite(date.getTime()) && Number.isFinite(record.durationSeconds) && record.durationSeconds>0,
      'The saved meeting recording is incomplete.');
    const title=String(record.title??'').trim().slice(0,500)||'Meeting';
    const remote=C.newRecording({id,shareID:bound.shareID,title,createdAt:date,mode:'window',upload:'uploaded'});
    Object.assign(remote,{durationSeconds:record.durationSeconds,width:record.width,height:record.height,captureState:'complete',
      transcriptStatus:bound.includeTranscript===true?'ready':'none',playback:{hls:false,mp4:true},meeting:{},
      access:{key:to.key,passwordSalt:to.passwordSalt,expiresAt}});
    let transcript=null;
    if(bound.includeTranscript===true) {
      const processing=store.getProcessing({ownerUserID,id});
      check(processing?.transcriptComplete===true&&processing.text?.trim()&&processing.segments?.length,
        'The shared transcript is unavailable.');
      transcript={schemaVersion:1,id:bound.shareID,title,createdAt:date.toISOString(),durationSeconds:remote.durationSeconds,
        language:processing.language??'en',engine:processing.engine,timingGranularity:processing.timingGranularity,text:processing.text,
        segments:processing.segments.map(({start,end,text})=>({start,end,text}))};
    }
    const targetOptions={expiresAt};
    const setLocationExpiry=async(key,at,items)=>{for(const file of items){current(ownerUserID);await storage.setExpiry(at,bound.shareID,file,key);current(ownerUserID);}};
    const writeProtected=async()=>{
      const stub=C.encodeJSON(C.lockedStub(bound.shareID,to.passwordSalt,expiresAt,'processing'));
      await storage.upload(bound.shareID,C.File.meta,stub,{key:null,options:targetOptions});current(ownerUserID);
      const video=await openAsBlob(record.path,{type:'video/mp4'});check(video.size>0,'The saved meeting video is empty.');
      await storage.uploadLarge(bound.shareID,C.File.video,video,{key:to.key,options:{...targetOptions,contentDisposition:C.attachmentDisposition(title)}});current(ownerUserID);
      if(transcript){await storage.upload(bound.shareID,C.File.transcriptJSON,C.encodeJSON(transcript),{key:to.key,options:targetOptions});current(ownerUserID);
        await storage.upload(bound.shareID,C.File.transcriptText,C.transcriptText(transcript),{key:to.key,options:targetOptions});current(ownerUserID);}
      await storage.upload(bound.shareID,C.File.meta,C.encodeJSON(C.remoteMeta(remote,'ready',profile.displayName||profile.email,'Reel Windows meeting')),
        {key:to.key,options:targetOptions});current(ownerUserID);
      await storage.upload(bound.shareID,C.File.meta,C.encodeJSON(C.lockedStub(bound.shareID,to.passwordSalt,expiresAt,'ready')),
        {key:null,options:targetOptions});current(ownerUserID);
    };
    const writeOpenStaged=async()=>{
      const staged={expiresAt:priorExpiry};
      const video=await openAsBlob(record.path,{type:'video/mp4'});check(video.size>0,'The saved meeting video is empty.');
      await storage.uploadLarge(bound.shareID,C.File.video,video,{key:null,options:{...staged,contentDisposition:C.attachmentDisposition(title)}});current(ownerUserID);
      if(transcript){await storage.upload(bound.shareID,C.File.transcriptJSON,C.encodeJSON(transcript),{key:null,options:staged});current(ownerUserID);
        await storage.upload(bound.shareID,C.File.transcriptText,C.transcriptText(transcript),{key:null,options:staged});current(ownerUserID);}
      await storage.upload(bound.shareID,C.File.meta,C.encodeJSON(C.remoteMeta(remote,'ready',profile.displayName||profile.email,'Reel Windows meeting')),
        {key:null,options:staged});current(ownerUserID);
    };

    try {
      const ownsOldRoom=await firestore.ownsRoom(oldRoom);current(ownerUserID);
      const ownsNewRoom=oldRoom===newRoom?ownsOldRoom:await firestore.ownsRoom(newRoom);current(ownerUserID);
      check(ownsOldRoom || (Boolean(bound.accessUpdate) && ownsNewRoom),'The published meeting room is unavailable to this account.');
      if(from.key===to.key) {
        await setLocationExpiry(to.key,expiresAt,files);
        if(to.key) { await storage.setExpiry(expiresAt,bound.shareID,C.File.meta,to.key);current(ownerUserID); }
        await firestore.setExpiry(oldRoom,expiresAt);current(ownerUserID);
        if(to.key) await storage.upload(bound.shareID,C.File.meta,C.encodeJSON(C.remoteMeta(remote,'ready',profile.displayName||profile.email,'Reel Windows meeting')),{key:to.key,options:targetOptions});
        await storage.upload(bound.shareID,C.File.meta,C.encodeJSON(to.key?C.lockedStub(bound.shareID,to.passwordSalt,expiresAt,'ready'):C.remoteMeta(remote,'ready',profile.displayName||profile.email,'Reel Windows meeting')),
          {key:null,options:targetOptions});current(ownerUserID);
      } else if(to.key) {
        // Storage authorizes each object separately and has no shared link-level ACL.
        // Keep the current public metadata / old password stub in place until every old
        // direct object has an expiry barrier; only then may writeProtected publish the
        // new locked stub, so it never claims protection before the revocation completes.
        await setLocationExpiry(from.key,priorExpiry,oldFiles);current(ownerUserID);
        await firestore.setExpiry(oldRoom,priorExpiry);current(ownerUserID);
        await writeProtected();
        await firestore.migrate(oldRoom,newRoom,date,expiresAt,bound.recordingNonce);current(ownerUserID);
        await storage.delete(bound.shareID,oldFiles.filter(file=>from.key||file!==C.File.meta),from.key);current(ownerUserID);
      } else {
        // Stage the public destination with past-dated objects. It becomes readable only
        // after all media is present and the new comments room is ready; meta is activated last.
        await setLocationExpiry(from.key,priorExpiry,oldFiles);current(ownerUserID);
        await firestore.setExpiry(oldRoom,priorExpiry);current(ownerUserID);
        await writeOpenStaged();
        await firestore.migrate(oldRoom,newRoom,date,expiresAt,bound.recordingNonce);current(ownerUserID);
        await setLocationExpiry(null,expiresAt,files);current(ownerUserID);
        await storage.setExpiry(expiresAt,bound.shareID,C.File.meta,null);current(ownerUserID);
        await storage.delete(bound.shareID,oldFiles.filter(file=>from.key||file!==C.File.meta),from.key);current(ownerUserID);
      }
      await firestore.upsertLibraryEntry(remote);current(ownerUserID);
      await store.saveShareAccessUpdate({ownerUserID,expectedOwnerUserID:ownerUserID,id,shareID:bound.shareID,update:null});
      current(ownerUserID);
      return {url:C.viewerURL(bound.shareID,cfg),updated:true};
    } catch(error) {
      current(ownerUserID);
      throw error;
    }
  }
  function updateAccess(args) {
    const key=`${args?.ownerUserID}:${args?.id}`;
    if(accessActive.has(key))return accessActive.get(key);
    const task=(store.withRecordingLock?store.withRecordingLock({ownerUserID:args?.ownerUserID,id:args?.id},()=>runAccessUpdate(args)):runAccessUpdate(args))
      .finally(()=>accessActive.delete(key));
    accessActive.set(key,task);return task;
  }
  return { share, updateAccess };
}

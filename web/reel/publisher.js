// Everything remote and the local library, ported from Sources/Reel/Publisher.swift,
// Recovery.swift and RecorderController.finalizeLocal. The share ID is allocated when recording
// starts and segments stream up during capture, so the link is copied the moment recording stops
// and plays within seconds. Then video.mp4 (assembled locally from the segments), the thumbnail
// and meta are uploaded in the background. Same remote layout as the Mac app.
import * as C from "./core.js?v=20261126-local-import";
import * as store from "./store.js?v=20261126-hls-publication";
import { StorageClient, FirestoreClient, SegmentUploader, CloudError, concurrently } from "./cloud.js?v=20261119-owner2";
import { remux, parseInit, fragmentDuration } from "./fmp4.js";

export const APP_VERSION = "1.2.9";
export const APP = `Reel ${APP_VERSION} (web)`;

/** In-memory library mirrored to IndexedDB; dispatches "change" events. */
export class Library extends EventTarget {
  constructor() { super(); this.items = new Map(); this.progress = new Map(); }
  async load() { for (const r of await store.loadRecordings()) this.items.set(r.id, r); this.changed(); }
  list() { return [...this.items.values()].sort((a, b) => b.createdAt - a.createdAt); }
  get(id) { const r = this.items.get(id); return r ? structuredClone(r) : null; }
  async refresh(id) {
    const present = this.items.has(id), row = await store.getRow(id);
    if (present && row && this.items.has(id)) this.items.set(id, C.recordingFromJSON(row.json));
    else this.items.delete(id);
    this.changed(); return this.get(id);
  }
  async update(r, extra) {
    const next = C.preserveRecordingBinding(structuredClone(r), this.items.get(r.id));
    this.items.set(r.id, next);
    const saved = await store.saveRecording(next, extra);
    const current = this.items.get(r.id);
    if (current) C.preserveRecordingBinding(current, saved);
    this.changed();
  }
  async bind(r, uid, meetingShareUID = null, assertCurrent = null) {
    const saved = await store.bindRecording(r.id, r.recordingNonce, uid, meetingShareUID, assertCurrent);
    const current = this.items.get(r.id);
    if (!current) throw new Error("This recording is no longer available.");
    C.preserveRecordingBinding(current, saved);
    this.changed();
    return this.get(r.id);
  }
  async updateExisting(r, extra) {
    if (!this.items.has(r.id)) return false;
    const saved = await store.updateExistingRecording(r, extra);
    const current = this.items.get(r.id);
    if (!saved || !current) return false;
    if (C.isMeeting(saved)) {
      this.items.set(r.id, C.preserveRecordingBinding(structuredClone(r), saved));
    } else {
      const { transcriptStatus, summary, summaryEngine } = r;
      Object.assign(current, { transcriptStatus, summary, summaryEngine });
      C.preserveRecordingBinding(current, saved);
    }
    this.changed(); return true;
  }
  async importLocalVideo(file, { durationSeconds, width, height }, session) {
    if (!session?.uid || !session.isCurrent()) throw new Error("Sign in to import a local video.");
    if (!file.size || !/\.mp4$/i.test(file.name) || !Number.isFinite(durationSeconds) || durationSeconds <= 0 ||
      !Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
      throw new Error("Choose a playable MP4 video.");
    }
    const createdAt = new Date(), recordingNonce = C.newRecordingNonce();
    const shareID = await C.ownerShareID(session.uid, recordingNonce);
    const title = C.cleanTitle(file.name.replace(/\.mp4$/i, ""));
    const recording = C.newRecording({ shareID, title, createdAt, upload: "localOnly" });
    Object.assign(recording, { durationSeconds, width, height, recordingNonce, recordingOwnerUID: session.uid,
      localImport: true, captureState: "complete", transcriptStatus: "none" });
    await store.saveImportedVideo(recording, file, session.isCurrent);
    this.items.set(recording.id, recording);
    this.changed();
    return this.get(recording.id);
  }
  async remove(id) { this.items.delete(id); await store.deleteRecording(id); this.changed(); }
  setProgress(id, p) { if (p == null) this.progress.delete(id); else this.progress.set(id, p); this.changed(); }
  changed() { this.dispatchEvent(new Event("change")); }
}

/**
 * auth: {session(): Promise<session|null>} where session = {uid, email, displayName, getIdToken()}.
 * ui: {toast(text, isError), notify(title, body, url), copy(text, nav)}.
 */
export class Publisher {
  constructor({ library, auth, settings, ui, cfg = C.CLOUD }) {
    Object.assign(this, { library, auth, settings, ui, cfg });
    this.accessChanges = new Map();
    this.deletions = new Map();
    this.uploads = new Map(); this.liveFinish = new Map(); this.stopToPlayable = new Map();
  }
  owner(s) { return s.displayName || s.email; }
  storage(s, r) {
    if (!s || (r.recordingNonce && r.recordingOwnerUID !== s.uid) || (r.meeting?.ownerUID && r.meeting.ownerUID !== s.uid)) {
      throw new Error("Sign in with this recording's original account to share it.");
    }
    return new StorageClient(s, this.cfg, r.recordingNonce);
  }
  firestore(s) { return new FirestoreClient(s, this.cfg); }
  async session() { return this.auth.session(); }

  meetingSession(session, expectedOwnerUID, consentIsCurrent) {
    const isCurrent = () => Boolean(expectedOwnerUID && session?.uid === expectedOwnerUID &&
      session.isCurrent?.() !== false && consentIsCurrent?.() !== false);
    const assertCurrent = () => {
      if (!isCurrent()) throw new CloudError("The account changed. Confirm sharing again.", true);
    };
    assertCurrent();
    return { ...session, isCurrent, assertCurrent, async getIdToken() {
      assertCurrent();
      const token = await session.getIdToken();
      assertCurrent();
      return token;
    } };
  }

  async syncCloudLibrary() {
    const eligible = this.library.list().filter((r) => C.automaticCloudAllowed(r) && r.upload === "uploaded");
    if (!eligible.length) return;
    const s = await this.session();
    if (!s) return;
    try {
      const client = this.firestore(s);
      for (const r of eligible) {
        if (r.recordingNonce && r.recordingOwnerUID !== s.uid) continue;
        if (await client.ownsRoom(C.recordingRoom(r))) await client.upsertLibraryEntry(r);
      }
    } catch (e) { this.ui.toast("Online library sync failed. Reload the recorder to retry. " + e.message, true); }
  }

  // ---------------------------------------------------------------- live upload

  /** Called when capture starts: "recording" meta + room; returns the uploader or null. */
  async beginLive(r) {
    if (!C.automaticCloudAllowed(r)) return null;
    const st = this.settings();
    if (!st.autoUpload || !st.liveUpload) return null;
    const s = await this.session();
    if (!s || (r.recordingNonce && r.recordingOwnerUID !== s.uid)) return null;
    r.upload = "uploading";
    await this.library.update(r);
    try {
      await this.uploadMeta(r, "recording", this.storage(s, r), this.owner(s));
    } catch (e) {
      console.warn("Live upload disabled:", e.message);
      r.upload = "pending"; await this.library.update(r);
      return null;
    }
    this.firestore(s).ensureRoom(C.recordingRoom(r), r.createdAt, r.access.expiresAt, 0, r.recordingNonce).catch(() => {});
    const row = await store.getRow(r.id);
    return new SegmentUploader({
      storage: this.storage(s, r), shareID: r.shareID, key: r.access.key, expiresAt: r.access.expiresAt, cfg: this.cfg,
      files: (f) => store.getBytes(r.id, f), progress: row && row.progress, persist: (p) => store.updateRow(r.id, { progress: p }),
    });
  }

  /** After stop: last segments + final playlist, meta → ready (the link plays). */
  finishLive(id, uploader, log, stoppedAt) {
    const current = this.library.get(id);
    if (!current || !C.automaticCloudAllowed(current) || !uploader) return Promise.resolve(false);
    const task = (async () => {
      try {
        await uploader.finish(log);
        const r = this.library.get(id);
        if (!r) return false;
        r.playback.hls = true;
        r.durationSeconds = Math.max(r.durationSeconds, Math.round(C.SegmentLog.totalDuration(log) * 1000) / 1000);
        await this.library.update(r);
        const s = await this.session();
        await this.uploadMeta({ ...r, transcriptStatus: "pending" }, "ready", this.storage(s, r), this.owner(s));
        await this.firestore(s).upsertLibraryEntry(r);
        this.stopToPlayable.set(id, (Date.now() - stoppedAt) / 1000);
        if (s.isCurrent?.() !== false) this.ui.notify("Video ready", r.title, C.shareURL(r, this.cfg));
        return true;
      } catch (e) {
        console.error("Finishing live upload failed:", e);
        return false;
      }
    })();
    this.liveFinish.set(id, task);
    return task;
  }

  // ---------------------------------------------------------------- local finalize + recovery

  /** Segments → video.mp4 (progressive), duration; marks capture complete (or recovered). */
  async finalizeLocal(id, log, recovered = false, isCurrent = () => true) {
    const row = await store.getRow(id);
    const init = await store.getBytes(id, C.File.initSegment);
    const segs = await store.segmentBlobs(id, log);
    const mp4 = remux(init, segs, row.codecs);
    if (!isCurrent()) return null;
    await store.putFile(id, C.File.video, new Blob([mp4], { type: "video/mp4" }));
    const hasThumbnail = !!(await store.getFile(id, C.File.thumbnail));
    if (!isCurrent()) return null;
    // Live publishing can finish during those writes; preserve its latest playback/upload state.
    const r = this.library.get(id);
    r.durationSeconds = Math.round(C.SegmentLog.totalDuration(log) * 1000) / 1000;
    r.hasThumbnail = hasThumbnail;
    r.captureState = recovered ? "recovered" : "complete";
    await this.library.update(r, { log });
    return r;
  }

  /** Launch-time crash recovery (Recovery.swift): rebuild unfinished recordings from their segments. */
  async recover({ include = () => true, isCurrent = () => true, autoPublish = true, expectedOwnerUID = null } = {}) {
    const out = { recovered: [], discarded: [], failed: {} };
    for (const r of this.library.list()) {
      if (!isCurrent()) break;
      if (!include(r)) continue;
      if (r.captureState !== "recording" && r.captureState !== "finalizing") continue;
      if (await isRecordingElsewhere(r.id)) continue;            // still recording in another tab
      try {
        const row = (await store.getRow(r.id)) || {};
        const files = await store.listFiles(r.id);
        const log = row.log || C.newSegmentLog();
        log.hasInit = log.hasInit || files.includes(C.File.initSegment);
        C.SegmentLog.adopt(log, files, C.SEGMENT_INTERVAL);
        if (log.hasInit && log.segments.length && row.codecs) {
          const tracks = parseInit(await store.getBytes(r.id, C.File.initSegment));
          for (const s of log.segments) s.duration = fragmentDuration(await store.getBytes(r.id, C.segmentFile(s.index)), tracks);
        }
        const hasVideo = files.includes(C.File.video);
        const plan = C.recoveryPlan(r.captureState, hasVideo, log.hasInit && !!row.codecs, log.segments.length);
        if (!isCurrent()) break;
        if (plan === "none") continue;
        if (plan === "discard") { await this.delete(r); out.discarded.push(r.id); continue; }
        if (plan === "rebuildFromSegments") {
          log.ended = true;
          if (!await this.finalizeLocal(r.id, log, true, isCurrent)) break;
        }
        else { const d = this.library.get(r.id); d.captureState = "recovered"; await this.library.update(d); }
        const saved = this.library.get(r.id);
        if (autoPublish && isCurrent() && C.automaticCloudAllowed(saved) && this.settings().autoUpload && saved.upload !== "localOnly") {
          this.publish(saved, { copyLink: false, expectedOwnerUID });
        }
        out.recovered.push(r.id);
      } catch (e) {
        out.failed[r.id] = e.message;
        console.error("Recovery failed", r.folderName, e);
      }
    }
    if (isCurrent() && out.recovered.length) {
      const n = out.recovered.length;
      this.ui.toast(`Recovered ${n} interrupted recording${n === 1 ? "" : "s"}`);
    }
    return out;
  }

  // ---------------------------------------------------------------- publish (idempotent)

  publish(recording, { copyLink = false, allowMeetingShare = false, expectedOwnerUID = null, consentIsCurrent = null } = {}) {
    const id = recording.id;
    // A previously reserved access migration must finish before deletion; all
    // other new publication stops once deletion owns this recording.
    if (this.deletions.has(id) && !this.accessChanges.has(id)) return Promise.resolve(false);
    if (C.isMeeting(recording) && (!allowMeetingShare || !expectedOwnerUID || consentIsCurrent?.() === false)) return Promise.resolve(false);
    if (this.uploads.has(id)) return this.uploads.get(id);
    const task = (async () => {
      try {
        const live = this.liveFinish.get(id);
        const retryLiveMetadata = live ? !(await live) : false;
        if (live) this.liveFinish.delete(id);
        let r = this.library.get(id);
        if (!r) return;
        let s = await this.session();
        if (expectedOwnerUID && s?.uid !== expectedOwnerUID) return false;
        if (!s) {
          if (!r.recordingNonce || !r.recordingOwnerUID) {
            r.upload = "localOnly"; await this.library.update(r);
          }
          if (copyLink) this.ui.toast("Saved locally · sign in to share");
          return;
        }
        const meetingShare = C.isMeeting(r);
        try {
          if (meetingShare) {
            if (!allowMeetingShare) return false;
            s = this.meetingSession(s, expectedOwnerUID, consentIsCurrent);
          }
          if (r.recordingNonce || meetingShare) {
            r = await this.library.bind(r, s.uid, meetingShare ? expectedOwnerUID : null, s.assertCurrent);
          }
          s.assertCurrent?.();
        } catch (e) {
          this.ui.toast(e.message, true);
          return false;
        }
        r.upload = "uploading"; await this.library.update(r);
        this.library.setProgress(id, 0);
        try {
          s.assertCurrent?.();
          await this.sync(id, s, meetingShare ? false : copyLink, meetingShare, retryLiveMetadata);
          r = this.library.get(id); r.upload = "uploaded"; await this.library.update(r);
          if (meetingShare && copyLink && s.isCurrent()) this.ui.copy(C.shareURL(r, this.cfg));
        } catch (e) {
          console.error("Upload failed", e);
          r = this.library.get(id); r.upload = { failed: e.message }; await this.library.update(r);
          this.ui.toast(`Upload failed: ${e.message}. It's saved in this browser; retry from the list.`, true);
        }
      } finally {
        this.uploads.delete(id);
        this.library.setProgress(id, null);
      }
    })();
    this.uploads.set(id, task);
    return task;
  }

  async sync(id, s, copyLink, allowMeetingShare = false, retryLiveMetadata = false) {
    let r = this.library.get(id);
    if (C.isMeeting(r)) {
      if (!allowMeetingShare || !s.assertCurrent) throw new Error("Confirm sharing as the meeting owner.");
      s.assertCurrent();
    }
    const storage = this.storage(s, r), owner = this.owner(s), key = r.access.key;
    const options = { expiresAt: r.access.expiresAt };
    const playable = r.playback.hls || r.playback.mp4;
    // Keep existing playable metadata while updating files, unless live finalization failed to publish it.
    const publishProgress = allowMeetingShare || !playable || retryLiveMetadata;
    if (publishProgress) {
      await this.uploadMeta({ ...r, transcriptStatus: "pending" }, playable && !allowMeetingShare ? "ready" : "processing", storage, owner);
    }
    if (copyLink && !playable && !allowMeetingShare && s.isCurrent?.() !== false) this.ui.copy(C.shareURL(r, this.cfg));
    await this.firestore(s).ensureRoom(C.recordingRoom(r), r.createdAt, r.access.expiresAt, 0, r.recordingNonce).catch(() => {});

    // HLS copy (open recordings only; protected ones are served as MP4).
    const row = (await store.getRow(id)) || {};
    const log = row.log;
    if (!key && log && log.hasInit && log.segments.length) {
      const p = row.progress || {};
      const done = p.uploadedFinalPlaylist && (p.uploadedLocation ?? null) === null && p.uploadedInit &&
        log.segments.every((x) => (p.uploaded || []).includes(x.index));
      if (!done) {
        const up = new SegmentUploader({ storage, shareID: r.shareID, key: null, expiresAt: r.access.expiresAt, cfg: this.cfg,
          files: (f) => store.getBytes(id, f), progress: row.progress, persist: (pp) => store.updateRow(id, { progress: pp }) });
        await up.finish(log);
      }
      // Restore the flag if an older client saved completed upload progress without it.
      r = this.library.get(id);
      if (!done || !r.playback.hls) {
        r.playback.hls = true;
        await this.library.update(r);
        if (publishProgress) await this.uploadMeta({ ...r, transcriptStatus: "pending" }, "ready", storage, owner);
      }
    }

    // Progressive MP4 (downloads + transcript API consumers), always for protected recordings.
    const wantsMP4 = this.settings().uploadMP4 || !!key || !r.playback.hls;
    if (wantsMP4 && !r.playback.mp4) {
      const video = await store.getFile(id, C.File.video);
      if (!video) throw new CloudError("video.mp4 is missing locally");
      await storage.uploadLarge(r.shareID, C.File.video, video, {
        key, options: { ...options, contentDisposition: C.attachmentDisposition(r.title) },
        onProgress: (p) => this.library.setProgress(id, p),
      });
      r = this.library.get(id); r.playback.mp4 = true; await this.library.update(r);
    }
    r = this.library.get(id);
    const thumb = r.hasThumbnail ? await store.getFile(id, C.File.thumbnail) : null;
    if (thumb) await storage.upload(r.shareID, C.File.thumbnail, new Uint8Array(await thumb.arrayBuffer()), { key, options });
    await this.uploadTrimmedIfNeeded(id, storage);
    // Local inference and video uploads run concurrently. This snapshot and its files
    // must agree before final metadata can advertise a completed transcript.
    r = this.library.get(id);
    // The entry guard above still requires explicit sharing for every meeting.
    if (["ready", "none"].includes(r.transcriptStatus)) {
      for (const file of [C.File.transcriptJSON, C.File.transcriptText]) {
        const transcript = await store.getFile(id, file);
        if (!transcript) {
          if (r.transcriptStatus === "ready") throw new CloudError(`${file} is missing locally`);
          continue; // A capture with no audio track does not need transcript files.
        }
        await storage.upload(r.shareID, file, new Uint8Array(await transcript.arrayBuffer()), { key, options });
      }
    }
    await this.uploadMeta(r, "ready", storage, owner);
    await this.firestore(s).upsertLibraryEntry(r);
  }

  /** Local transcription may finish after video publishing. Refresh that existing share
   * only, using the account that started processing; never create a new automatic share. */
  async refreshTranscript(id, expectedOwnerUID) {
    if (!expectedOwnerUID || this.deletions.has(id)) return false;
    // An access change reserves its whole operation before its first await. Recheck
    // after authentication/ownership I/O, then start publish synchronously so a later
    // access change will see and await that upload before moving/deleting objects.
    while (true) {
      await this.accessChanges.get(id)?.catch(() => {});
      await this.uploads.get(id);
      if (this.deletions.has(id)) return false;
      const r = this.library.get(id);
      if (!r || !C.automaticCloudAllowed(r) || r.upload !== "uploaded" || !["ready", "none", "failed"].includes(r.transcriptStatus)) return false;
      const s = await this.session();
      if (this.deletions.has(id)) return false;
      if (this.accessChanges.has(id)) continue;
      if (s?.uid !== expectedOwnerUID || !await this.firestore(s).ownsRoom(C.recordingRoom(r))) return false;
      if (this.deletions.has(id)) return false;
      if (this.accessChanges.has(id)) continue;
      const result = await this.publish(r, { expectedOwnerUID });
      return result !== false && this.library.get(id)?.upload === "uploaded";
    }
  }

  async uploadTrimmedIfNeeded(id, storage) {
    let r = this.library.get(id);
    if (!r.trim || r.trimmedUploaded || !(r.playback.mp4 || r.playback.hls)) return;
    const blob = await this.trimmedCopy(r);
    const trim = r.trim;
    await storage.uploadLarge(r.shareID, C.File.trimmed, blob, {
      key: r.access.key, options: { expiresAt: r.access.expiresAt, contentDisposition: C.attachmentDisposition(r.title) },
    });
    r = this.library.get(id);
    if (r.trim && r.trim.start === trim.start && r.trim.end === trim.end) { r.trimmedUploaded = true; await this.library.update(r); }
  }

  /** Keyframe-aligned trimmed copy (starts at the keyframe at or before the trim start). */
  async trimmedCopy(r) {
    const row = await store.getRow(r.id);
    const init = await store.getBytes(r.id, C.File.initSegment);
    const segs = await store.segmentBlobs(r.id, row.log);
    return new Blob([remux(init, segs, row.codecs, r.trim)], { type: "video/mp4" });
  }

  /** meta.json at the recording's location, plus the locked stub for protected recordings. */
  async uploadMeta(r, status, storage, owner) {
    const options = { expiresAt: r.access.expiresAt };
    await storage.upload(r.shareID, C.File.meta, C.encodeJSON(C.remoteMeta(r, status, owner, APP)), { key: r.access.key, options });
    if (r.access.key && r.access.passwordSalt) {
      await storage.upload(r.shareID, C.File.meta, C.encodeJSON(C.lockedStub(r.shareID, r.access.passwordSalt, r.access.expiresAt, status)), { key: null, options });
    }
  }

  // ---------------------------------------------------------------- share settings

  /** password: {keep:true} | {set: "pw"} | {remove: true}. */
  async updateAccess(recording, password, expiresAt, consent = {}) {
    const id = recording.id;
    if (this.deletions.has(id)) throw new Error("This recording is being deleted.");
    const previous = this.accessChanges.get(id);
    const task = Promise.resolve(previous).catch(() => {}).then(() => this.applyAccess(recording, password, expiresAt, consent));
    this.accessChanges.set(id, task);
    try { return await task; }
    finally { if (this.accessChanges.get(id) === task) this.accessChanges.delete(id); }
  }

  async applyAccess(recording, password, expiresAt, { expectedOwnerUID = null, consentIsCurrent = null } = {}) {
    if (this.uploads.has(recording.id)) await this.uploads.get(recording.id);
    let r = this.library.get(recording.id);
    const old = { ...r.access };
    const next = { ...r.access, expiresAt };
    if (password.remove) { next.key = null; next.passwordSalt = null; }
    if (password.set != null) {
      if (password.set.length < C.ACCESS.minimumPasswordLength) throw new Error(`Use at least ${C.ACCESS.minimumPasswordLength} characters.`);
      const salt = C.newSalt();
      const key = await C.deriveKey(password.set, salt);
      if (!key) throw new Error("Couldn't derive a key from that password.");
      next.key = key; next.passwordSalt = salt;
    }
    if (!C.mayHaveRemote(r.upload)) { r.access = next; await this.library.update(r); return; }
    let s = await this.session();
    if (!s) throw new Error("Sign in to change sharing settings.");
    if (C.isMeeting(r)) {
      s = this.meetingSession(s, expectedOwnerUID, consentIsCurrent);
      r = await this.library.bind(r, s.uid, expectedOwnerUID, s.assertCurrent);
      s.assertCurrent();
    }
    const storage = this.storage(s, r);
    if (next.key === old.key) {
      // Expiry only: patch every object's metadata; the rules enforce it.
      r.access = next; await this.library.update(r);
      const files = await this.remoteFiles(r, r.access.key);
      s.assertCurrent?.();
      await concurrently(files, 8, (f) => storage.setExpiry(expiresAt, r.shareID, f, r.access.key));
      if (r.access.key) await storage.setExpiry(expiresAt, r.shareID, C.File.meta, null);
      await this.firestore(s).setExpiry(C.recordingRoom(r), expiresAt);
      await this.uploadMeta(r, "ready", storage, this.owner(s));
      await this.firestore(s).upsertLibraryEntry(r);
      return;
    }
    // Move to the new location: re-upload from the local files, then delete the old copy.
    const oldRoom = C.recordingRoom(r);
    const oldFiles = await this.remoteFiles(r, old.key);
    r.access = next; r.playback = { hls: false, mp4: false }; r.trimmedUploaded = false; r.upload = "pending";
    await this.library.update(r);
    s.assertCurrent?.();
    if (next.key) await this.uploadMeta(r, "processing", storage, this.owner(s));   // stub replaces the open meta right away
    s.assertCurrent?.();
    await this.publish(r, { allowMeetingShare: C.isMeeting(r), expectedOwnerUID: s.uid, consentIsCurrent });
    const after = this.library.get(r.id);
    if (!after || after.upload !== "uploaded") throw new Error("Couldn't upload the recording with its new settings; the old link was left as it was.");
    s.assertCurrent?.();
    const stale = oldFiles.filter((f) => !(old.key == null && f === C.File.meta));
    await storage.delete(r.shareID, stale, old.key);
    if (old.key == null) await store.updateRow(r.id, { progress: null });   // segments deleted with the old copy
    await this.firestore(s).migrate(oldRoom, C.recordingRoom(after), r.createdAt, expiresAt, r.recordingNonce).catch(() => {});
  }

  /** Every object a recording may have at a location (segments only exist for open ones). */
  async remoteFiles(r, key) {
    const files = [...C.FIXED_FILES];
    if (!key) {
      const row = (await store.getRow(r.id)) || {};
      const count = Math.max(row.log ? row.log.segments.length : 0, ...((row.progress && row.progress.uploaded) || [0]));
      for (let i = 1; i <= count; i++) files.push(C.segmentFile(i));
    }
    return files;
  }

  // ---------------------------------------------------------------- trim, views, rename, delete

  async setTrim(recording, start, end) {
    const r = this.library.get(recording.id);
    const trim = C.normalizeTrim(start, end, r.durationSeconds);
    if (JSON.stringify(trim) === JSON.stringify(r.trim)) return;
    r.trim = trim; r.trimmedUploaded = false;
    await this.library.update(r);
    if (r.upload === "uploaded" && C.automaticCloudAllowed(r)) await this.publish(r);
  }

  async refreshViews(r, expectedOwnerUID = null) {
    if (r.upload !== "uploaded" || C.isMeeting(r)) return;
    const s = await this.session();
    if (!s || (expectedOwnerUID && (s.uid !== expectedOwnerUID || s.isCurrent?.() === false))) return;
    const views = await this.firestore(s).views(C.recordingRoom(r)).catch(() => null);
    const cur = this.library.get(r.id);
    if (cur && views != null && cur.viewCount !== views && (!expectedOwnerUID || s.isCurrent?.() !== false)) {
      cur.viewCount = views;
      await this.library.update(cur);
    }
  }

  async rename(recording, title) {
    const r = this.library.get(recording.id);
    const clean = C.cleanTitle(title);
    if (!clean || clean === r.title) return;
    r.title = clean; r.titleIsCustom = true;
    await this.library.update(r);
    if (r.upload !== "uploaded") return;
    try {
      const s = await this.session();
      await this.uploadMeta(r, "ready", this.storage(s, r), this.owner(s));
      await this.firestore(s).upsertLibraryEntry(r);
    } catch (e) { this.ui.toast("Renamed locally; web title not updated: " + e.message, true); }
  }

  /** Deletes the remote copy (both locations, all segments, the comments room) and the local data. */
  async delete(recording) {
    const id = recording.id;
    if (this.deletions.has(id)) return this.deletions.get(id);
    // Reserve deletion synchronously so delayed transcript ownership checks cannot
    // start another upload. Finish existing writers before removing their objects.
    const task = Promise.resolve().then(async () => {
      await this.accessChanges.get(id)?.catch(() => {});
      await this.liveFinish.get(id)?.catch(() => {});
      await this.uploads.get(id)?.catch(() => {});
      return this.deleteRecording(recording);
    });
    this.deletions.set(id, task);
    try { return await task; }
    finally { this.deletions.delete(id); }
  }

  async deleteRecording(recording) {
    const r = this.library.get(recording.id) || recording;
    if (C.mayHaveRemote(r.upload) || r.playback.hls || r.playback.mp4) {
      try {
        const s = await this.session();
        if (!s) throw new Error("sign in to delete the web copy");
        const storage = this.storage(s, r);
        if (r.access.key) await storage.delete(r.shareID, await this.remoteFiles(r, r.access.key), r.access.key);
        await storage.delete(r.shareID, await this.remoteFiles(r, null), null);
        await this.firestore(s).deleteLibraryEntry(r.shareID);
        await this.firestore(s).deleteRoom(C.recordingRoom(r)).catch(() => {});
      } catch (e) {
        this.ui.toast("Couldn't delete the web copy: " + e.message, true);
        return false;
      }
    }
    await this.library.remove(r.id);
    return true;
  }
}

/** True while another tab holds this recording's lock (it is still recording). */
export async function isRecordingElsewhere(id) {
  if (!navigator.locks) return false;
  return navigator.locks.request("reel-recording-" + id, { ifAvailable: true }, (lock) => lock === null);
}

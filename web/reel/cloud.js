// Executes core.js request descriptors with fetch: the browser counterpart of the Mac app's
// StorageClient, FirestoreClient and SegmentUploader (Sources/Reel/Cloud). Same retries, same
// "check existence before PATCH/DELETE" rule (the Storage rules answer 403, not 404, for a
// missing object), same live segment pump.
import * as C from "./core.js?v=20261119-owner2";

export class CloudError extends Error {
  constructor(message, permanent = false) { super(message); this.permanent = permanent; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** session: {getIdToken(): Promise<string>, uid, email, displayName} */
export async function send(req, { timeout = 60000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    return await fetch(req.url, { method: req.method, headers: req.headers, body: req.body ?? undefined, signal: ctrl.signal, cache: "no-store" });
  } catch (e) {
    throw new CloudError(e.name === "AbortError" ? "Request timed out" : "Network error: " + e.message);
  } finally { clearTimeout(timer); }
}

async function check(res, what) {
  if (res.ok) return res;
  const body = (await res.text().catch(() => "")).slice(0, 300);
  if (res.status === 403) throw new CloudError(`Upload not allowed for this account (403). ${body}`, true);
  if (res.status === 400) throw new CloudError(`Upload of ${what} rejected (400) ${body}`, true);
  throw new CloudError(`Upload of ${what} failed (HTTP ${res.status}) ${body}`);
}

/** Runs `body` over `items` with limited concurrency. */
export async function concurrently(items, width, body) {
  let i = 0;
  const workers = Array.from({ length: Math.min(width, items.length) }, async () => {
    while (i < items.length) { const item = items[i++]; await body(item); }
  });
  await Promise.all(workers);
}

export class StorageClient {
  constructor(session, cfg = C.CLOUD, recordingNonce = null) { Object.assign(this, { session, cfg, recordingNonce }); }
  async requests() {
    return new C.StorageRequests({ auth: { firebase: await this.session.getIdToken() }, ownerUID: this.session.uid, recordingNonce: this.recordingNonce, cfg: this.cfg });
  }

  /** Small object (meta, playlist, segment, thumbnail) in one multipart request, with retries. */
  async upload(shareID, file, data, { key = null, options = {}, attempts = 6 } = {}) {
    for (let attempt = 1; ; attempt++) {
      try {
        const req = (await this.requests()).multipartUpload(shareID, file, data, { key, options });
        await check(await send(req), file);
        return;
      } catch (e) {
        if (e.permanent || attempt >= attempts) throw e;
        await sleep(Math.min(8000, 500 * 2 ** attempt));
      }
    }
  }

  /** Large object (video.mp4, trimmed.mp4): resumable upload in 8 MiB chunks with progress. */
  async uploadLarge(shareID, file, blob, { key = null, options = {}, onProgress = () => {} } = {}) {
    const total = blob.size;
    const start = (await this.requests()).resumableStart(shareID, file, total, { key, options });
    const res = await check(await send(start), "start " + file);
    const sessionURL = res.headers.get("X-Goog-Upload-URL");
    if (!sessionURL) throw new CloudError("Upload could not start (no session URL)");
    const ranges = C.chunkRanges(total);
    for (let i = 0; i < ranges.length; i++) {
      const [a, b] = ranges[i];
      const chunk = new Uint8Array(await blob.slice(a, b).arrayBuffer());
      const isFinal = i === ranges.length - 1;
      for (let attempt = 1; ; attempt++) {
        this.session.assertCurrent?.();
        try {
          const r = await check(await send(C.StorageRequests.resumableChunk(sessionURL, a, chunk, isFinal), { timeout: 300000 }), `chunk ${i + 1}/${ranges.length}`);
          const status = r.headers.get("X-Goog-Upload-Status") || "";
          if (isFinal && status && status !== "final") throw new CloudError("Upload not finalized (" + status + ")");
          break;
        } catch (e) {
          if (attempt >= 6) throw e;
          await sleep(attempt * 1500);
        }
      }
      onProgress(b / Math.max(total, 1));
    }
  }

  /** Whether an object exists (as the owner, so expired objects are found too). */
  async exists(shareID, file, key = null) {
    const res = await send((await this.requests()).getMetadata(shareID, file, key), { timeout: 30000 });
    if (res.status === 404) return false;
    if (res.ok) return true;
    throw new CloudError(`Couldn't check ${file} (HTTP ${res.status})`);
  }

  async setExpiry(expiresAt, shareID, file, key = null) {
    if (!(await this.exists(shareID, file, key))) return;
    const res = await send((await this.requests()).updateMetadata(shareID, file, expiresAt, key), { timeout: 30000 });
    if (res.status === 404) return;
    if (!res.ok) throw new CloudError(`Couldn't update ${file} (HTTP ${res.status})`);
  }

  async deleteOne(shareID, file, key = null) {
    if (!(await this.exists(shareID, file, key))) return;
    const res = await send((await this.requests()).delete(shareID, file, key), { timeout: 30000 });
    if (!res.ok && res.status !== 404) throw new CloudError(`Couldn't delete ${file} (HTTP ${res.status})`);
  }
  async delete(shareID, files, key = null) { await concurrently(files, 8, (f) => this.deleteOne(shareID, f, key)); }
}

export class FirestoreClient {
  constructor(session, cfg = C.CLOUD) { this.session = session; this.cfg = cfg; }
  async requests() { return new C.FirestoreRequests({ idToken: await this.session.getIdToken(), cfg: this.cfg }); }
  async call(req) { const res = await send(req, { timeout: 30000 }); return { res, json: await res.json().catch(() => null) }; }

  async libraryRequest(shareID, method, fields) {
    const rq = await this.requests();
    return { url: `${rq.documentsBase}/users/${encodeURIComponent(this.session.uid)}/recordings/${shareID}`,
      method, headers: { Authorization: `Bearer ${await this.session.getIdToken()}`, "Content-Type": "application/json" },
      body: fields ? JSON.stringify({ fields }) : undefined };
  }
  async ownsRoom(roomID) {
    const { res, json } = await this.call((await this.requests()).getRoom(roomID));
    if (res.status === 403 || res.status === 404) return false;
    if (!res.ok) throw new CloudError(`Couldn't check online library ownership (HTTP ${res.status})`);
    return C.documentFields(json).ownerUid === this.session.uid;
  }
  async upsertLibraryEntry(r, status = "ready") {
    const fields = { id: C.FV.string(r.shareID), title: C.FV.string(r.title), createdAt: C.FV.timestamp(r.createdAt),
      durationSeconds: C.FV.double(r.durationSeconds), status: C.FV.string(status) };
    const { res } = await this.call(await this.libraryRequest(r.shareID, "PATCH", fields));
    if (!res.ok) throw new CloudError(`Couldn't update your online library (HTTP ${res.status}). Retry the upload from the recording list.`);
  }
  async deleteLibraryEntry(shareID) {
    const { res } = await this.call(await this.libraryRequest(shareID, "DELETE"));
    if (!res.ok && res.status !== 404) throw new CloudError(`Couldn't remove the online library entry (HTTP ${res.status}). Retry deletion from the recording list.`);
  }

  /** Creates the room if missing; otherwise updates its expiry. */
  async ensureRoom(roomID, createdAt, expiresAt, views = 0, recordingNonce = null) {
    const { res, json } = await this.call((await this.requests()).createRoom(roomID, this.session.uid, createdAt, views, expiresAt, recordingNonce));
    if (res.ok) return;
    if (res.status === 409) return this.setExpiry(roomID, expiresAt);
    throw new CloudError(`Couldn't create the comments room (HTTP ${res.status}) ${JSON.stringify(json).slice(0, 200)}`);
  }
  async setExpiry(roomID, expiresAt) {
    const { res } = await this.call((await this.requests()).setRoomExpiry(roomID, expiresAt));
    if (!res.ok && res.status !== 404) throw new CloudError(`Couldn't update link expiry (HTTP ${res.status})`);
  }
  async views(roomID) {
    const { res, json } = await this.call((await this.requests()).getRoom(roomID));
    if (res.status === 404 || res.status === 403) return null;
    if (!res.ok) throw new CloudError(`Couldn't read views (HTTP ${res.status})`);
    const v = C.documentFields(json).views;
    return Number.isInteger(v) ? v : 0;
  }
  async list(roomID, collection) {
    const out = [];
    let token = null;
    do {
      const { res, json } = await this.call((await this.requests()).list(roomID, collection, token));
      if (res.status === 404 || res.status === 403) return out;
      if (!res.ok) throw new CloudError(`Couldn't list ${collection} (HTTP ${res.status})`);
      for (const d of (json && json.documents) || []) out.push({ name: d.name, fields: d.fields || {} });
      token = json && json.nextPageToken;
    } while (token);
    return out;
  }
  /** Views, reactions and comments move to the new room (password changed); the old one is deleted. */
  async migrate(oldRoom, newRoom, createdAt, expiresAt, recordingNonce = null) {
    const source = await this.call((await this.requests()).getRoom(oldRoom)).catch(() => null);
    const fields = source?.res.ok ? C.documentFields(source.json) : null;
    const views = fields ? (Number.isInteger(fields.views) ? fields.views : 0) : null;
    const title = fields?.ownerUid === this.session.uid && typeof fields.titleOverride === "string" && fields.titleOverride.trim() && fields.titleOverride.length <= 500 ? fields.titleOverride : null;
    await this.ensureRoom(newRoom, createdAt, expiresAt, views ?? 0, recordingNonce);
    if (views == null) return;
    const rq = await this.requests();
    if (title) {
      const { res: updated } = await this.call(rq.setRoomTitle(newRoom, title));
      if (!updated.ok) throw new CloudError(`Couldn't preserve the shared title (HTTP ${updated.status})`);
    }
    for (const d of await this.list(oldRoom, "reactions")) await send(rq.create(newRoom, "reactions", d.fields));
    for (const d of await this.list(oldRoom, "comments")) await send(rq.create(newRoom, "comments", { ...d.fields, migrated: C.FV.bool(true) }));
    await this.deleteRoom(oldRoom);
  }
  async deleteRoom(roomID) {
    for (const collection of ["reactions", "comments"]) {
      for (const d of await this.list(roomID, collection)) await send((await this.requests()).delete(roomID, d.name));
    }
    const { res } = await this.call((await this.requests()).delete(roomID));
    if (!res.ok && res.status !== 404 && res.status !== 403) throw new CloudError(`Couldn't delete comments room (HTTP ${res.status})`);
  }
}

/**
 * Uploads HLS segments while recording (SegmentUploader.swift). `files` reads a stored segment
 * (`init.mp4`, `segNNNNN.m4s`) as bytes; `progress` is the persisted upload state
 * ({uploadedLocation, uploadedInit, uploaded[], uploadedFinalPlaylist}) and `persist` saves it.
 */
export class SegmentUploader {
  constructor({ storage, shareID, key = null, expiresAt = null, files, progress, persist, cfg = C.CLOUD }) {
    Object.assign(this, { storage, shareID, key, files, persist, cfg });
    this.options = { expiresAt };
    this.progress = progress || C.newSegmentLog();
    if ((this.progress.uploadedLocation ?? null) !== key) C.SegmentLog.resetUploads(this.progress, key);
    this.segments = new Map(); this.hasInit = false; this.pumping = null; this.playlistDirty = false;
    this.failures = 0; this.finishing = false; this.lastError = null; this.bytesSent = 0;
  }
  /** Writer callback: a segment (or init, entry null) is stored. */
  segmentWritten(entry, log) {
    this.hasInit = this.hasInit || log.hasInit;
    for (const s of log.segments) this.segments.set(s.index, s);
    if (entry) this.segments.set(entry.index, entry);
    this.playlistDirty = true;
    if (!this.pumping) this.pumping = this.pump().finally(() => { this.pumping = null; });
  }
  async uploadFile(file) {
    const data = await this.files(file);
    await this.storage.upload(this.shareID, file, data, { key: this.key, options: this.options });
    this.bytesSent += data.byteLength;
  }
  save() { this.persist({ ...this.progress, uploaded: [...this.progress.uploaded] }); }
  async pump() {
    for (;;) {
      try {
        if (this.hasInit && !this.progress.uploadedInit) {
          await this.uploadFile(C.File.initSegment); this.progress.uploadedInit = true; this.save(); continue;
        }
        if (!this.progress.uploadedInit) return;
        const next = [...this.segments.values()].filter((s) => !this.progress.uploaded.includes(s.index)).sort((a, b) => a.index - b.index)[0];
        if (next) {
          await this.uploadFile(C.segmentFile(next.index)); this.progress.uploaded.push(next.index); this.save(); this.failures = 0; continue;
        }
        if (this.playlistDirty) { this.playlistDirty = false; await this.uploadPlaylist(false); }
        return;
      } catch (e) {
        this.lastError = e.message; this.failures++;
        if (this.finishing || e.permanent || this.failures > 20) return;
        await sleep(Math.min(10, this.failures) * 1000);
      }
    }
  }
  async uploadPlaylist(ended) {
    const ordered = [...this.segments.values()].filter((s) => this.progress.uploaded.includes(s.index)).sort((a, b) => a.index - b.index);
    const listed = [];
    for (let i = 0; i < ordered.length && ordered[i].index === i + 1; i++) listed.push(ordered[i]);  // contiguous prefix only
    const text = C.hlsPlaylist(listed, ended, (f) => C.downloadURL(this.shareID, f, this.key, this.cfg));
    await this.storage.upload(this.shareID, C.File.playlist, text, { key: this.key, options: this.options });
  }
  /** After capture: whatever is left (4 in parallel) and the final VOD playlist. Throws on failure. */
  async finish(log) {
    this.finishing = true;
    this.hasInit = log.hasInit;
    for (const s of log.segments) this.segments.set(s.index, s);
    if (this.pumping) await this.pumping;
    if (!this.progress.uploadedInit) { await this.uploadFile(C.File.initSegment); this.progress.uploadedInit = true; this.save(); }
    const pending = log.segments.filter((s) => !this.progress.uploaded.includes(s.index));
    await concurrently(pending, 4, async (s) => { await this.uploadFile(C.segmentFile(s.index)); this.progress.uploaded.push(s.index); });
    this.save();
    await this.uploadPlaylist(true);
    this.progress.uploadedFinalPlaylist = true; this.save();
  }
}

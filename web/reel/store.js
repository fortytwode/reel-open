// The browser recorder's library: IndexedDB instead of ~/Movies/Reel. One record per recording
// (recording.json shape, plus the segment log, upload progress and codec settings) and one blob
// per file (init.mp4, segNNNNN.m4s, video.mp4, thumb.jpg, trimmed.mp4). Every segment is stored
// the moment the encoder closes it, so a crashed or closed tab can be recovered on the next visit
// (the Mac app's recording.json + segments/ folder + Recovery).
import * as C from "./core.js?v=20261128-meeting-modes";
import { organizationStorageKey } from "../organization.js?v=20261118-orgstate1";

const DB = organizationStorageKey("reel-recorder"), VERSION = 1;
let dbPromise = null;

function req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
function done(tx) { return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); }); }

export function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB, VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains("recordings")) db.createObjectStore("recordings", { keyPath: "id" });
        if (!db.objectStoreNames.contains("files")) db.createObjectStore("files");
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbPromise;
}

/** Stored row: {id, json (recording.json), log, progress, codecs}. */
export async function saveRecording(r, extra = {}) {
  const db = await open();
  const tx = db.transaction("recordings", "readwrite");
  const store = tx.objectStore("recordings");
  const prev = (await req(store.get(r.id))) || {};
  const json = C.preserveRecordingBinding(C.recordingToJSON(r), prev.json);
  store.put({ ...prev, ...extra, id: r.id, json });
  await done(tx);
  return json;
}
/** Persist the first authenticated publisher without letting another tab replace it. */
export async function bindRecording(id, recordingNonce, uid, meetingShareUID = null, assertCurrent = null) {
  const shareID = recordingNonce ? await C.ownerShareID(uid, recordingNonce) : null;
  const db = await open();
  const tx = db.transaction("recordings", "readwrite");
  const rows = tx.objectStore("recordings");
  const previous = await req(rows.get(id));
  const json = previous?.json;
  if (!json || (json.recordingNonce ?? null) !== (recordingNonce ?? null)) {
    await done(tx);
    throw new Error("This recording is no longer available.");
  }
  if (C.isMeeting(json) && (meetingShareUID !== uid || (json.meeting?.ownerUID && json.meeting.ownerUID !== uid))) {
    await done(tx);
    throw new Error("Confirm sharing while signed in as the meeting owner.");
  }
  if (json.recordingOwnerUID && (json.recordingOwnerUID !== uid || json.shareID !== shareID)) {
    await done(tx);
    throw new Error("Sign in with this recording's original account to share it.");
  }
  assertCurrent?.();
  if (shareID && !json.recordingOwnerUID) {
    Object.assign(json, { recordingOwnerUID: uid, shareID });
    rows.put(previous);
  }
  await done(tx);
  return json;
}
export async function getRow(id) { const db = await open(); return req(db.transaction("recordings").objectStore("recordings").get(id)); }
export async function updateRow(id, extra) {
  const db = await open();
  const tx = db.transaction("recordings", "readwrite");
  const store = tx.objectStore("recordings");
  const prev = await req(store.get(id));
  if (prev) store.put({ ...prev, ...extra });
  await done(tx);
}
/** Save background notes only while the recording still exists. */
export async function updateExistingRecording(recording, extra = {}) {
  const db = await open();
  const tx = db.transaction("recordings", "readwrite"), rows = tx.objectStore("recordings");
  const previous = await req(rows.get(recording.id));
  if (!previous) { await done(tx); return null; }
  let json = C.recordingToJSON(recording);
  if (C.isMeeting(json) || C.isMeeting(previous.json)) {
    json = C.preserveRecordingBinding(json, previous.json);
  } else {
    // Ordinary transcription can race publication, so keep unrelated fields from the current row.
    const { transcriptStatus, summary, summaryEngine } = json;
    json = { ...previous.json, transcriptStatus, summary, summaryEngine };
  }
  rows.put({ ...previous, ...extra, json });
  await done(tx);
  return json;
}
/** Newest first. */
export async function loadRecordings() {
  const db = await open();
  const rows = await req(db.transaction("recordings").objectStore("recordings").getAll());
  return rows.map((row) => C.recordingFromJSON(row.json)).sort((a, b) => b.createdAt - a.createdAt);
}

const fileKey = (id, file) => id + "/" + file;
export async function saveImportedVideo(recording, file, isCurrent) {
  const db = await open();
  if (!isCurrent()) throw new Error("Your account changed. Choose the file again.");
  const tx = db.transaction(["recordings", "files"], "readwrite");
  tx.objectStore("recordings").add({ id: recording.id, json: C.recordingToJSON(recording) });
  tx.objectStore("files").put(file, fileKey(recording.id, C.File.video));
  await done(tx);
}

export async function putFile(id, file, data) {
  const db = await open();
  const tx = db.transaction("files", "readwrite");
  tx.objectStore("files").put(data instanceof Blob ? data : new Blob([data]), fileKey(id, file));
  await done(tx);
}
/** Save both transcript files only while their recording still exists. */
export async function putTranscript(id, json, text) {
  const db = await open(), tx = db.transaction(["recordings", "files"], "readwrite");
  const exists = await req(tx.objectStore("recordings").get(id));
  if (exists) {
    const files = tx.objectStore("files");
    files.put(json, fileKey(id, C.File.transcriptJSON));
    files.put(text, fileKey(id, C.File.transcriptText));
  }
  await done(tx);
  return !!exists;
}
export async function getFile(id, file) { const db = await open(); return req(db.transaction("files").objectStore("files").get(fileKey(id, file))); }
export async function getBytes(id, file) {
  const b = await getFile(id, file);
  if (!b) throw new Error(file + " is missing locally");
  return new Uint8Array(await b.arrayBuffer());
}
export async function listFiles(id) {
  const db = await open();
  const keys = await req(db.transaction("files").objectStore("files").getAllKeys(IDBKeyRange.bound(id + "/", id + "/￿")));
  return keys.map((k) => k.slice(id.length + 1));
}
export async function deleteFiles(id, files) {
  const db = await open();
  const tx = db.transaction("files", "readwrite");
  for (const f of files) tx.objectStore("files").delete(fileKey(id, f));
  await done(tx);
}
export async function deleteRecording(id) {
  const db = await open();
  const tx = db.transaction(["recordings", "files"], "readwrite");
  const cursor = tx.objectStore("files").openCursor(IDBKeyRange.bound(id + "/", id + "/￿"));
  cursor.onsuccess = () => {
    const item = cursor.result;
    if (item) { item.delete(); item.continue(); }
  };
  tx.objectStore("recordings").delete(id);
  await done(tx);
}
/** Segment files of a recording, in order. */
export async function segmentBlobs(id, log) {
  const out = [];
  for (const s of [...log.segments].sort((a, b) => a.index - b.index)) out.push(await getBytes(id, C.segmentFile(s.index)));
  return out;
}

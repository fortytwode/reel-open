// The browser recorder's library: IndexedDB instead of ~/Movies/Reel. One record per recording
// (recording.json shape, plus the segment log, upload progress and codec settings) and one blob
// per file (init.mp4, segNNNNN.m4s, video.mp4, thumb.jpg, trimmed.mp4). Every segment is stored
// the moment the encoder closes it, so a crashed or closed tab can be recovered on the next visit
// (the Mac app's recording.json + segments/ folder + Recovery).
import * as C from "./core.js?v=20261110-delivery1";
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
  store.put({ ...prev, ...extra, id: r.id, json: C.recordingToJSON(r) });
  await done(tx);
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
/** Background work must never restore a recording removed while it was awaiting I/O. */
export async function updateExistingRecording(recording, extra = {}) {
  const db = await open();
  const tx = db.transaction("recordings", "readwrite"), rows = tx.objectStore("recordings");
  const previous = await req(rows.get(recording.id));
  if (previous) rows.put({ ...previous, ...extra, json: C.recordingToJSON(recording) });
  await done(tx);
  return !!previous;
}
/** Newest first. */
export async function loadRecordings() {
  const db = await open();
  const rows = await req(db.transaction("recordings").objectStore("recordings").getAll());
  return rows.map((row) => C.recordingFromJSON(row.json)).sort((a, b) => b.createdAt - a.createdAt);
}

const fileKey = (id, file) => id + "/" + file;
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

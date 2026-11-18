// Reel core for the browser recorder: a line-by-line port of Sources/ReelCore (the request and
// schema logic the Mac app uses), so the web recorder writes the same Storage objects, the same
// meta.json/locked stub and the same Firestore room documents. Pure: no DOM, no network; runs in
// browsers and in Node (tests: firebase/tests/core.test.mjs, cross-checked against the Swift
// output in Tests/CrossClient/cross-client.json).
//
// Swift → JS conventions: Date → Date; RemoteLocation → null (open) or the 32-hex key (keyed);
// RemoteFile → its file name string; URLRequest → {method, url, headers, body} where body is a
// string or Uint8Array.

/** Privacy helpers for calendar-started recordings. Attendee data stays local. */
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** Extract at most 200 syntactically valid, unique email addresses from attendee-like input. */
export function parseAttendees(input) {
  const values = Array.isArray(input) ? input : (typeof input === "string" ? input.split(/[;,\n]/) : []);
  const result = [];
  const seen = new Set();
  for (const value of values) {
    const email = typeof value === "string" ? value.trim().replace(/^mailto:/i, "") : "";
    if (!EMAIL.test(email)) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key); result.push(email);
    if (result.length === 200) break;
  }
  return result;
}

export function parseMeetingDetails(attendeeText) {
  const raw = typeof attendeeText === "string" ? attendeeText.split(/[;,\n]/).map((s) => s.trim()).filter(Boolean) : [];
  if (raw.some((email) => !EMAIL.test(email.replace(/^mailto:/i, "")))) throw new Error("Enter valid attendee email addresses.");
  const all = parseAttendees(raw);
  if (new Set(raw.map((email) => email.replace(/^mailto:/i, "").toLowerCase())).size > 200) throw new Error("A meeting can include at most 200 attendees.");
  const attendees = all;
  return { attendees };
}

/** Per-recording snapshot; caller keeps the user's ordinary preferences untouched. */
export function meetingSettings(normal = {}) {
  return { ...normal, mode: "window", cameraEnabled: false, audio: "micAndSystem", fps: 15,
    autoUpload: false, liveUpload: false, copyLinkOnStop: false };
}

/** The meeting marker is intentionally independent of its contents: malformed markers fail closed. */
export function isMeeting(recording) {
  return !!recording && Object.prototype.hasOwnProperty.call(recording, "meeting");
}

export function automaticCloudAllowed(recording) { return !isMeeting(recording); }

/** Normalize incoming meeting metadata while preserving a marker for malformed non-null values. */
export function decodeMeeting(value) {
  if (value == null) return { attendees: [] };
  const result = { attendees: parseAttendees(value && typeof value === "object" && !Array.isArray(value) ? value.attendees : []) };
  if (typeof value?.ownerUID === "string" && value.ownerUID.length <= 128) result.ownerUID = value.ownerUID;
  if (value && Object.prototype.hasOwnProperty.call(value, "calendar")) result.calendar = value.calendar;
  if (["pending", "failed", "confirmed", "noSpeech"].includes(value?.deliveryStatus)) result.deliveryStatus = value.deliveryStatus;
  if (typeof value?.deliveryPayload === "string") result.deliveryPayload = value.deliveryPayload;
  for (const field of ["deliveryReceipt", "deliveryError", "deliveryRetryAt"]) {
    if (value && Object.prototype.hasOwnProperty.call(value, field)) result[field] = value[field];
  }
  return result;
}

export function meetingDeliveryPayload(recording, transcript) {
  return recording.meeting.deliveryPayload ?? JSON.stringify({
    id: recording.id, title: recording.title, started_at: recording.createdAt.toISOString(),
    attendees: recording.meeting.attendees || [], summary: recording.summary,
    segments: transcript.segments, calendar: recording.meeting.calendar ?? null,
  });
}


// ---------------------------------------------------------------- CloudConfig (ShareLinks.swift)

export const CLOUD = Object.freeze({
  projectID: "", bucket: "", apiKey: "", viewerBase: "", viewerPath: "v", allowedEmailDomain: "", firestoreDatabase: "",
  storageOrigin: "https://firebasestorage.googleapis.com",
  firestoreOrigin: "https://firestore.googleapis.com",
});

// ---------------------------------------------------------------- RemoteFile

export const File = Object.freeze({
  video: "video.mp4",
  trimmed: "trimmed.mp4",
  meta: "meta.json",
  transcriptJSON: "transcript.json",
  transcriptText: "transcript.txt",
  thumbnail: "thumb.jpg",
  playlist: "video.m3u8",
  initSegment: "init.mp4",
});

/** HLS media segment `n` (1-based): seg00001.m4s, … */
export function segmentFile(n) { return "seg" + String(n).padStart(5, "0") + ".m4s"; }

export const FIXED_FILES = Object.freeze([File.meta, File.video, File.trimmed, File.playlist, File.initSegment,
  File.transcriptJSON, File.transcriptText, File.thumbnail]);

export function isSegmentFile(f) { return f.startsWith("seg") && f.endsWith(".m4s"); }

/** Mirrors the storage rules' file-name allow-list. */
export function isAllowedByRules(f) {
  return /^(video\.mp4|trimmed\.mp4|meta\.json|transcript\.json|transcript\.txt|thumb\.jpg|video\.m3u8|init\.mp4|seg[0-9]{5,6}\.m4s)$/.test(f);
}

export function contentType(f) {
  switch (f) {
    case "video.mp4": case "trimmed.mp4": case "init.mp4": return "video/mp4";
    case "meta.json": case "transcript.json": return "application/json";
    case "transcript.txt": return "text/plain; charset=utf-8";
    case "thumb.jpg": return "image/jpeg";
    case "video.m3u8": return "application/vnd.apple.mpegurl";
    default: return isSegmentFile(f) ? "video/iso.segment" : "application/octet-stream";
  }
}

// ---------------------------------------------------------------- RemoteLocation

export function locationPrefix(shareID, key = null) {
  return key ? `reel/v/${shareID}/k/${key}/` : `reel/v/${shareID}/`;
}
/** Firestore room for comments/reactions/views. */
export function room(shareID, key = null) { return key ? `${shareID}-${key}` : shareID; }

// ---------------------------------------------------------------- ShareLinks

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** 20 random lowercase alphanumerics (~103 bits). `random(n)` returns an integer in [0, n). */
export function newShareID(random = cryptoRandomInt) {
  let s = "";
  for (let i = 0; i < 20; i++) s += ID_ALPHABET[random(ID_ALPHABET.length)];
  return s;
}
function cryptoRandomInt(n) {
  // Rejection sampling over a byte, like Int.random(in:using:) does over UInt64.
  const limit = 256 - (256 % n), b = new Uint8Array(1);
  for (;;) { globalThis.crypto.getRandomValues(b); if (b[0] < limit) return b[0] % n; }
}

export function isValidShareID(id) {
  return typeof id === "string" && id.length >= 16 && id.length <= 40 && /^[a-z0-9]+$/.test(id);
}

export function objectPath(shareID, file, key = null) { return locationPrefix(shareID, key) + file; }

/** Storage object names are one path segment in the REST API: escape all but A-Za-z0-9-._~ . */
export function encodedObjectName(path) {
  let out = "";
  for (const byte of new TextEncoder().encode(path)) {
    const c = String.fromCharCode(byte);
    out += /[A-Za-z0-9\-._~]/.test(c) ? c : "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

export function downloadURL(shareID, file, key = null, cfg = CLOUD) {
  return `${cfg.storageOrigin}/v0/b/${cfg.bucket}/o/${encodedObjectName(objectPath(shareID, file, key))}?alt=media`;
}

export function viewerURL(shareID, cfg = CLOUD) { return `${cfg.viewerBase}/${cfg.viewerPath || "v"}/${shareID}`; }

/** Viewer link, Storage download URL or bare ID → share ID (or null). */
export function shareIDFrom(input) {
  const t = String(input || "").trim();
  if (isValidShareID(t)) return t;
  let u;
  try { u = new URL(t); } catch { return null; }
  const parts = decodeURIComponent(u.pathname).split("/").filter(Boolean);
  for (let v = 0; v + 1 < parts.length; v++) {
    if ((parts[v] === "v" || parts[v] === "reel") && isValidShareID(parts[v + 1])) return parts[v + 1];
  }
  return null;
}

// ---------------------------------------------------------------- AccessKey (PBKDF2)

export const ACCESS = Object.freeze({ iterations: 210000, keyBytes: 16, saltBytes: 16, minimumPasswordLength: 4 });

export function hex(bytes) { return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""); }
export function bytesFromHex(s) {
  if (typeof s !== "string" || !s.length || s.length % 2 || !/^[0-9a-fA-F]+$/.test(s)) return null;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}
export function newSalt() { const b = new Uint8Array(ACCESS.saltBytes); globalThis.crypto.getRandomValues(b); return hex(b); }

/** PBKDF2-HMAC-SHA256(password UTF-8, salt bytes) → lowercase hex, or null (empty password / bad salt). */
export async function deriveKey(password, saltHex, iterations = ACCESS.iterations, length = ACCESS.keyBytes) {
  const salt = bytesFromHex(saltHex);
  if (!password || !salt) return null;
  const subtle = globalThis.crypto.subtle;
  const km = await subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, km, length * 8);
  return hex(new Uint8Array(bits));
}
export function isValidKey(k) { return typeof k === "string" && k.length === ACCESS.keyBytes * 2 && /^[0-9a-f]+$/.test(k); }

// ---------------------------------------------------------------- Dates (Swift ReelJSON / ISO8601)

/** Swift JSONEncoder .iso8601: whole seconds, UTC, "Z" (fractions are truncated). */
export function iso8601(d) { return new Date(Math.floor(d.getTime() / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"); }
/** FirestoreRequests.timestamp: ISO8601 with milliseconds. */
export function isoMillis(d) { return d.toISOString(); }
export function parseISO(s) { const d = new Date(s); return isNaN(d) ? null : d; }

/**
 * Serialises like Swift's ReelJSON.encoder (prettyPrinted, sortedKeys, withoutEscapingSlashes):
 * `"key" : value`, two-space indent. Dates must already be strings (use iso8601).
 */
export function swiftJSON(value, indent = "") {
  const inner = indent + "  ";
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) {
    if (!value.length) return "[\n\n" + indent + "]";
    return "[\n" + value.map((v) => inner + swiftJSON(v, inner)).join(",\n") + "\n" + indent + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort(swiftKeyOrder);
    if (!keys.length) return "{\n\n" + indent + "}";
    return "{\n" + keys.map((k) => inner + JSON.stringify(k) + " : " + swiftJSON(value[k], inner)).join(",\n") + "\n" + indent + "}";
  }
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  return JSON.stringify(value);
}
// Swift sorts keys by UTF-16/Unicode scalar order, which for our ASCII keys is plain < ordering.
function swiftKeyOrder(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

// ---------------------------------------------------------------- Recording (Recording.swift)

export const CaptureMode = Object.freeze({ screen: "Full screen", window: "Window", area: "Area", camera: "Camera only" });

export const TRIM_MINIMUM = 0.5;
/** Clamps to [0, duration]; null when too short or (almost) the whole recording. */
export function normalizeTrim(start, end, duration) {
  if (!(duration > 0) || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  const s = Math.min(Math.max(0, start), duration), e = Math.min(Math.max(0, end), duration);
  if (e - s < TRIM_MINIMUM) return null;
  if (s < 0.05 && duration - e < 0.05) return null;
  return { start: Math.round(s * 1000) / 1000, end: Math.round(e * 1000) / 1000 };
}

export const EXPIRY_OPTIONS = Object.freeze({ never: null, hour: 3600, day: 86400, week: 7 * 86400, month: 30 * 86400 });
export function expiryDate(option, now = new Date()) {
  const s = EXPIRY_OPTIONS[option];
  return s == null ? null : new Date(now.getTime() + s * 1000);
}

/** A new library entry (same fields as Swift's Recording; see recordingToJSON). */
export function newRecording({ id, shareID = newShareID(), title, createdAt, mode = "screen", upload = "pending" }) {
  return {
    id: id || (globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID().toUpperCase() : newShareID()),
    shareID, title: title || defaultTitle(createdAt), createdAt, durationSeconds: 0, width: 0, height: 0, mode,
    folderName: folderName(createdAt, shareID), upload, transcriptStatus: "pending", hasThumbnail: false,
    titleIsCustom: false, captureState: "recording", playback: { hls: false, mp4: false },
    access: { key: null, passwordSalt: null, expiresAt: null }, trim: null, trimmedUploaded: false,
    summary: null, chapters: null, summaryEngine: null, viewCount: null,
  };
}

/** "Recording – 21 Oct 2026, 14:03" (en_GB, local time unless timeZone is given). */
export function defaultTitle(date, timeZone = undefined) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone,
  }).formatToParts(date).map((p) => [p.type, p.value]));
  return `Recording – ${parts.day} ${parts.month.replace(".", "")} ${parts.year}, ${parts.hour}:${parts.minute}`;
}

/** "2026-10-21 140322 abcdef": sortable, unique folder / IndexedDB key prefix. */
export function folderName(date, shareID, timeZone = undefined) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZone,
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}${p.minute}${p.second} ${shareID.slice(0, 6)}`;
}

export function cleanTitle(raw) {
  const t = String(raw ?? "").replaceAll("\n", " ").trim();
  if (!t) return null;
  return Array.from(t).slice(0, 200).join("");
}

export function shareURL(r, cfg = CLOUD) { return viewerURL(r.shareID, cfg); }
export function recordingRoom(r) { return room(r.shareID, r.access.key); }

/** File the viewer's Download button should fetch. */
export function downloadFile(r) {
  if (r.trim) return r.trimmedUploaded ? File.trimmed : (r.playback.mp4 ? File.video : null);
  return r.playback.mp4 ? File.video : null;
}

export function uploadStateLabel(u) {
  if (typeof u === "object" && u && u.failed != null) return "Upload failed: " + u.failed;
  return { localOnly: "Local only", pending: "Waiting to upload", uploading: "Uploading…", uploaded: "Uploaded" }[u] || String(u);
}
export function mayHaveRemote(u) { return u === "uploaded" || u === "uploading" || (typeof u === "object" && u && u.failed != null); }

/** recording.json exactly as Swift's Codable Recording writes it (enums with associated values included). */
export function recordingToJSON(r) {
  const upload = typeof r.upload === "object" ? { failed: { _0: r.upload.failed } } : { [r.upload]: {} };
  const access = {
    location: r.access.key ? { keyed: { _0: r.access.key } } : { open: {} },
    passwordSalt: r.access.passwordSalt ?? undefined,
    expiresAt: r.access.expiresAt ? iso8601(r.access.expiresAt) : undefined,
  };
  const json = {
    id: r.id, shareID: r.shareID, title: r.title, createdAt: iso8601(r.createdAt), durationSeconds: r.durationSeconds,
    width: r.width, height: r.height, mode: r.mode, folderName: r.folderName, upload, transcriptStatus: r.transcriptStatus,
    hasThumbnail: r.hasThumbnail, titleIsCustom: r.titleIsCustom, captureState: r.captureState, playback: { ...r.playback },
    access, trim: r.trim ?? undefined, trimmedUploaded: r.trimmedUploaded, summary: r.summary ?? undefined,
    chapters: r.chapters ?? undefined, summaryEngine: r.summaryEngine ?? undefined, viewCount: r.viewCount ?? undefined,
  };
  if (isMeeting(r)) {
    json.meeting = decodeMeeting(r.meeting);
  }
  return json;
}

/** Tolerant decoding (like Recording.init(from:)): missing/unknown fields fall back to defaults. */
export function recordingFromJSON(j) {
  const r = newRecording({ id: j.id, shareID: j.shareID, title: j.title, createdAt: parseISO(j.createdAt) || new Date(0), mode: j.mode || "screen" });
  if (Object.prototype.hasOwnProperty.call(j, "meeting")) r.meeting = decodeMeeting(j.meeting);
  r.folderName = j.folderName;
  r.durationSeconds = typeof j.durationSeconds === "number" ? j.durationSeconds : 0;
  r.width = j.width | 0; r.height = j.height | 0;
  r.mode = ["screen", "window", "area", "camera"].includes(j.mode) ? j.mode : "screen";
  const u = j.upload && typeof j.upload === "object" ? Object.keys(j.upload)[0] : null;
  r.upload = u === "failed" ? { failed: j.upload.failed?._0 ?? "" } : (["localOnly", "pending", "uploading", "uploaded"].includes(u) ? u : "pending");
  r.transcriptStatus = ["pending", "ready", "none", "failed"].includes(j.transcriptStatus) ? j.transcriptStatus : "pending";
  r.hasThumbnail = j.hasThumbnail === true;
  r.titleIsCustom = j.titleIsCustom === true;
  r.captureState = ["recording", "finalizing", "complete", "recovered"].includes(j.captureState) ? j.captureState : "complete";
  r.playback = { hls: j.playback?.hls === true, mp4: j.playback?.mp4 === true };
  const loc = j.access?.location;
  r.access = {
    key: loc && loc.keyed ? loc.keyed._0 : null,
    passwordSalt: j.access?.passwordSalt ?? null,
    expiresAt: j.access?.expiresAt ? parseISO(j.access.expiresAt) : null,
  };
  r.trim = j.trim && typeof j.trim.start === "number" ? { start: j.trim.start, end: j.trim.end } : null;
  r.trimmedUploaded = j.trimmedUploaded === true;
  r.summary = typeof j.summary === "string" ? j.summary : null;
  r.chapters = Array.isArray(j.chapters) ? j.chapters : null;
  r.summaryEngine = typeof j.summaryEngine === "string" ? j.summaryEngine : null;
  r.viewCount = Number.isInteger(j.viewCount) ? j.viewCount : null;
  return r;
}

// ---------------------------------------------------------------- RemoteMeta / LockedStub

/** meta.json (schemaVersion 2) as a plain object with every key present (nulls explicit). */
export function remoteMeta(r, status, ownerName, app) {
  return {
    schemaVersion: 2, id: r.shareID, title: r.title, createdAt: iso8601(r.createdAt), durationSeconds: r.durationSeconds,
    width: r.width, height: r.height, status, transcriptStatus: r.transcriptStatus, hasThumbnail: r.hasThumbnail,
    ownerName: ownerName ?? null, app, playback: { hls: r.playback.hls, mp4: r.playback.mp4 },
    trim: r.trim ? { end: r.trim.end, start: r.trim.start } : null, download: downloadFile(r),
    summary: r.summary ?? null, chapters: r.chapters ? r.chapters.map((c) => ({ start: c.start, title: c.title })) : null,
    expiresAt: r.access.expiresAt ? iso8601(r.access.expiresAt) : null, locked: !!r.access.key, room: recordingRoom(r),
  };
}
export function lockedStub(shareID, salt, expiresAt, status) {
  return {
    schemaVersion: 2, id: shareID, locked: true,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: ACCESS.iterations, salt, keyBytes: ACCESS.keyBytes },
    expiresAt: expiresAt ? iso8601(expiresAt) : null, status,
  };
}
/** The bytes the Mac app uploads for meta.json / the stub (ReelJSON pretty, sorted). */
export function encodeJSON(obj) { return swiftJSON(obj); }

// ---------------------------------------------------------------- StorageRequests

export const CHUNK_QUANTUM = 256 * 1024;
export const DEFAULT_CHUNK_SIZE = 32 * CHUNK_QUANTUM; // 8 MiB

export function cacheControl(file) {
  return [File.meta, File.transcriptJSON, File.transcriptText, File.playlist].includes(file) ? "no-cache" : "public, max-age=3600";
}
/** Epoch milliseconds as the decimal string the rules parse with int(). */
export function expiryString(date) { return String(Math.round(date.getTime())); }

export function attachmentDisposition(title, ext = "mp4") {
  let name = "";
  for (const ch of String(title)) {
    const cp = ch.codePointAt(0);
    name += cp < 128 && (/[A-Za-z0-9]/.test(ch) || " -_.,()".includes(ch)) ? ch : "-";
  }
  name = name.trim();
  while (name.includes("--")) name = name.replaceAll("--", "-");
  if (!name || name === "-") name = "Reel recording";
  return `attachment; filename="${name.slice(0, 100)}.${ext}"`;
}

/** Builds Firebase Storage REST requests (the protocol the Firebase JS SDK uses). */
export class StorageRequests {
  /** auth: {firebase: idToken} | {bearer: accessToken} */
  constructor({ auth, ownerUID, cfg = CLOUD }) { this.auth = auth; this.ownerUID = ownerUID; this.cfg = cfg; }
  get authHeader() { return this.auth.bearer ? "Bearer " + this.auth.bearer : "Firebase " + this.auth.firebase; }
  get base() { return `${this.cfg.storageOrigin}/v0/b/${this.cfg.bucket}/o`; }

  customMetadata({ expiresAt = null } = {}) {
    const m = { ownerUid: this.ownerUID };
    if (expiresAt) m.expiresAt = expiryString(expiresAt);
    return m;
  }
  metadata(path, file, options = {}) {
    const o = { name: path, contentType: contentType(file), cacheControl: cacheControl(file), metadata: this.customMetadata(options) };
    if (options.contentDisposition) o.contentDisposition = options.contentDisposition;
    return o;
  }
  /** One-shot multipart upload (metadata + bytes): small files and segments. */
  multipartUpload(shareID, file, data, { key = null, options = {}, boundary = randomBoundary() } = {}) {
    const path = objectPath(shareID, file, key);
    const enc = new TextEncoder();
    const head = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n` +
      sortedJSON(this.metadata(path, file, options)) + `\r\n--${boundary}\r\nContent-Type: ${contentType(file)}\r\n\r\n`);
    const tail = enc.encode(`\r\n--${boundary}--`);
    const bytes = typeof data === "string" ? enc.encode(data) : data;
    const body = new Uint8Array(head.length + bytes.length + tail.length);
    body.set(head, 0); body.set(bytes, head.length); body.set(tail, head.length + bytes.length);
    return {
      method: "POST", url: `${this.base}?name=${encodedObjectName(path)}`,
      headers: { "Authorization": this.authHeader, "X-Goog-Upload-Protocol": "multipart", "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    };
  }
  /** Starts a resumable upload; the response's X-Goog-Upload-URL header is the session URL. */
  resumableStart(shareID, file, totalBytes, { key = null, options = {} } = {}) {
    const path = objectPath(shareID, file, key);
    return {
      method: "POST", url: `${this.base}?name=${encodedObjectName(path)}`,
      headers: {
        "Authorization": this.authHeader, "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(totalBytes), "X-Goog-Upload-Header-Content-Type": contentType(file),
        "Content-Type": "application/json; charset=utf-8",
      },
      body: sortedJSON(this.metadata(path, file, options)),
    };
  }
  static resumableChunk(sessionURL, offset, chunk, isFinal) {
    return { method: "POST", url: sessionURL, headers: { "X-Goog-Upload-Command": isFinal ? "upload, finalize" : "upload", "X-Goog-Upload-Offset": String(offset) }, body: chunk };
  }
  static resumableQuery(sessionURL) { return { method: "POST", url: sessionURL, headers: { "X-Goog-Upload-Command": "query" }, body: null }; }

  /** Changes custom metadata (expiry); ownerUid is always sent; expiresAt null removes it. */
  updateMetadata(shareID, file, expiresAt, key = null) {
    const path = objectPath(shareID, file, key);
    return {
      method: "PATCH", url: `${this.base}/${encodedObjectName(path)}`,
      headers: { "Authorization": this.authHeader, "Content-Type": "application/json; charset=utf-8" },
      body: sortedJSON({ metadata: { ownerUid: this.ownerUID, expiresAt: expiresAt ? expiryString(expiresAt) : null } }),
    };
  }
  getMetadata(shareID, file, key = null) {
    return { method: "GET", url: `${this.base}/${encodedObjectName(objectPath(shareID, file, key))}`, headers: { "Authorization": this.authHeader }, body: null };
  }
  delete(shareID, file, key = null) {
    return { method: "DELETE", url: `${this.base}/${encodedObjectName(objectPath(shareID, file, key))}`, headers: { "Authorization": this.authHeader }, body: null };
  }
}

/** Chunk boundaries [start, end) for a resumable upload of `total` bytes. */
export function chunkRanges(total, chunkSize = DEFAULT_CHUNK_SIZE) {
  if (!(chunkSize > 0 && chunkSize % CHUNK_QUANTUM === 0)) throw new Error("chunk size must be a multiple of 256 KiB");
  if (total <= 0) return [[0, 0]];
  const out = [];
  for (let o = 0; o < total; o = Math.min(total, o + chunkSize)) out.push([o, Math.min(total, o + chunkSize)]);
  return out;
}

function randomBoundary() { return globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID().toUpperCase() : newShareID(); }

/** JSON with keys sorted (JSONSerialization .sortedKeys), compact. */
export function sortedJSON(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(sortedJSON).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + sortedJSON(v[k])).join(",") + "}";
}

// ---------------------------------------------------------------- FirestoreRequests

/** Value helpers: {string}, {int}, {double}, {bool}, {timestamp: Date}, null. */
export const FV = Object.freeze({
  string: (s) => ({ stringValue: s }),
  int: (i) => ({ integerValue: String(i) }),
  double: (d) => ({ doubleValue: d }),
  bool: (b) => ({ booleanValue: b }),
  timestamp: (d) => ({ timestampValue: isoMillis(d) }),
  null: () => ({ nullValue: null }),
});

/** Firestore REST value → plain JS (integers as numbers, timestamps as Date). */
export function parseValue(o) {
  if (!o || typeof o !== "object") return undefined;
  if ("stringValue" in o) return o.stringValue;
  if ("integerValue" in o) { const i = Number(o.integerValue); return Number.isInteger(i) ? i : undefined; }
  if ("doubleValue" in o) return o.doubleValue;
  if ("booleanValue" in o) return o.booleanValue;
  if ("timestampValue" in o) return parseISO(o.timestampValue) ?? undefined;
  if ("nullValue" in o) return null;
  return undefined;
}
export function documentFields(doc) {
  const out = {};
  for (const [k, v] of Object.entries((doc && doc.fields) || {})) { const p = parseValue(v); if (p !== undefined) out[k] = p; }
  return out;
}

export class FirestoreRequests {
  constructor({ idToken, cfg = CLOUD }) { this.idToken = idToken; this.cfg = cfg; }
  get documentsBase() { return `${this.cfg.firestoreOrigin}/v1/projects/${this.cfg.projectID}/databases/${this.cfg.firestoreDatabase}/documents`; }
  request(url, method, body = null) {
    const headers = { "Authorization": "Bearer " + this.idToken };
    if (body != null) headers["Content-Type"] = "application/json";
    return { method, url, headers, body };
  }
  static body(fields) { return sortedJSON({ fields }); }
  createRoom(roomID, ownerUID, createdAt, views = 0, expiresAt = null) {
    const fields = { ownerUid: FV.string(ownerUID), createdAt: FV.timestamp(createdAt), views: FV.int(views), expiresAt: expiresAt ? FV.timestamp(expiresAt) : FV.null() };
    return this.request(`${this.documentsBase}/videos?documentId=${roomID}`, "POST", FirestoreRequests.body(fields));
  }
  setRoomExpiry(roomID, expiresAt) {
    return this.request(`${this.documentsBase}/videos/${roomID}?updateMask.fieldPaths=expiresAt`, "PATCH",
      FirestoreRequests.body({ expiresAt: expiresAt ? FV.timestamp(expiresAt) : FV.null() }));
  }
  setRoomTitle(roomID, title) {
    return this.request(`${this.documentsBase}/videos/${roomID}?updateMask.fieldPaths=titleOverride`, "PATCH",
      FirestoreRequests.body({ titleOverride: FV.string(title) }));
  }
  getRoom(roomID) { return this.request(`${this.documentsBase}/videos/${roomID}`, "GET"); }
  list(roomID, collection, pageToken = null) {
    let url = `${this.documentsBase}/videos/${roomID}/${collection}?pageSize=300`;
    if (pageToken) url += "&pageToken=" + encodeURIComponent(pageToken);
    return this.request(url, "GET");
  }
  /** `fields` are REST values (as returned by list). */
  create(roomID, collection, fields) { return this.request(`${this.documentsBase}/videos/${roomID}/${collection}`, "POST", FirestoreRequests.body(fields)); }
  delete(roomID, documentName = null) {
    if (documentName) return this.request(`${this.cfg.firestoreOrigin}/v1/${documentName}`, "DELETE");
    return this.request(`${this.documentsBase}/videos/${roomID}`, "DELETE");
  }
}

// ---------------------------------------------------------------- Segments (Segments.swift)

export const SEGMENT_INTERVAL = 4.0;

/** The writer's segment log + upload progress (SegmentLog). Plain JSON-safe object. */
export function newSegmentLog() {
  return { hasInit: false, segments: [], ended: false, uploadedLocation: undefined, uploadedInit: false, uploaded: [], uploadedFinalPlaylist: false };
}
export const SegmentLog = {
  totalDuration: (log) => log.segments.reduce((a, s) => a + s.duration, 0),
  nextIndex: (log) => Math.max(0, ...log.segments.map((s) => s.index)) + 1,
  pendingUploads: (log) => log.segments.filter((s) => !log.uploaded.includes(s.index)),
  allUploaded: (log) => log.hasInit && log.uploadedInit && SegmentLog.pendingUploads(log).length === 0,
  append(log, entry) {
    log.segments = log.segments.filter((s) => s.index !== entry.index);
    log.segments.push(entry);
    log.segments.sort((a, b) => a.index - b.index);
  },
  /** Forget upload progress (the recording moves to another location; null = open). */
  resetUploads(log, key) { log.uploadedLocation = key; log.uploadedInit = false; log.uploaded = []; log.uploadedFinalPlaylist = false; },
  adopt(log, names, fallbackDuration) {
    const known = new Set(log.segments.map((s) => s.index));
    for (const n of names) {
      const i = SegmentLog.segmentIndex(n);
      if (i != null && !known.has(i)) SegmentLog.append(log, { index: i, duration: fallbackDuration, bytes: 0 });
    }
  },
  segmentIndex(name) {
    const m = /^seg(\d+)\.m4s$/.exec(name);
    return m ? parseInt(m[1], 10) : null;
  },
};

/** HLS media playlist for fMP4 segments, with absolute URIs (HLSPlaylist.make). */
export function hlsPlaylist(segments, ended, uri) {
  const target = Math.max(1, Math.ceil(Math.max(...segments.map((s) => s.duration), segments.length ? 0 : 4)));
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7", `#EXT-X-TARGETDURATION:${target}`, "#EXT-X-MEDIA-SEQUENCE:0",
    `#EXT-X-PLAYLIST-TYPE:${ended ? "VOD" : "EVENT"}`, "#EXT-X-INDEPENDENT-SEGMENTS", `#EXT-X-MAP:URI="${uri(File.initSegment)}"`];
  for (const s of [...segments].sort((a, b) => a.index - b.index)) {
    lines.push(`#EXTINF:${s.duration.toFixed(5)},`);
    lines.push(uri(segmentFile(s.index)));
  }
  if (ended) lines.push("#EXT-X-ENDLIST");
  return lines.join("\n") + "\n";
}

/** What to do with a recording found at launch (RecoveryPlan.decide). */
export function recoveryPlan(captureState, hasVideo, hasInitSegment, segmentCount) {
  if (captureState === "complete" || captureState === "recovered") return "none";
  if (hasVideo) return "finishProcessing";
  if (hasInitSegment && segmentCount > 0) return "rebuildFromSegments";
  return "discard";
}

// ---------------------------------------------------------------- PauseClock

/** Capture time → output time with paused intervals removed (seconds). */
export class PauseClock {
  constructor() { this.start = null; this.pausedTotal = 0; this.pausedAt = null; this.stoppedAt = null; }
  get isPaused() { return this.pausedAt != null; }
  get isRunning() { return this.start != null && this.stoppedAt == null; }
  begin(t) { this.start = t; this.pausedTotal = 0; this.pausedAt = null; this.stoppedAt = null; }
  pause(t) { if (this.isRunning && this.pausedAt == null) this.pausedAt = t; }
  resume(t) { if (this.isRunning && this.pausedAt != null) { this.pausedTotal += Math.max(0, t - this.pausedAt); this.pausedAt = null; } }
  stop(t) {
    if (!this.isRunning) return;
    if (this.pausedAt != null) { this.stoppedAt = this.pausedAt; this.pausedAt = null; } else this.stoppedAt = t;
  }
  outputTime(t) {
    if (this.start == null || t < this.start) return null;
    if (this.stoppedAt != null && t > this.stoppedAt) return null;
    if (this.pausedAt != null && t >= this.pausedAt) return null;
    return t - this.start - this.pausedTotal;
  }
  elapsed(now) {
    if (this.start == null) return 0;
    const end = this.stoppedAt ?? now;
    const cur = this.pausedAt != null ? Math.max(0, end - this.pausedAt) : 0;
    return Math.max(0, end - this.start - this.pausedTotal - cur);
  }
}

// ---------------------------------------------------------------- VideoGeometry

export const QUALITY = Object.freeze({ p720: [1280, 720], p1080: [1920, 1080], p1440: [2560, 1440], p2160: [3840, 2160] });
export const QUALITY_LABEL = Object.freeze({ p720: "720p", p1080: "1080p", p1440: "1440p", p2160: "4K" });

/** Fit inside the preset box, keep aspect, never upscale, even dimensions. */
export function outputSize(width, height, preset) {
  const [long, short] = QUALITY[preset];
  const landscape = width >= height;
  const boxW = landscape ? long : short, boxH = landscape ? short : long;
  const sw = Math.max(width, 2), sh = Math.max(height, 2);
  const scale = Math.min(1, Math.min(boxW / sw, boxH / sh));
  const even = (v) => Math.max(2, Math.floor(v / 2) * 2);
  return { width: even(sw * scale), height: even(sh * scale) };
}

/** Loom's pixel-count bitrate tiers, ×1.5 above 30 fps. */
export function bitrate(width, height, fps) {
  const p = width * height;
  const base = p <= 640 * 360 ? 800000 : p <= 854 * 480 ? 1500000 : p <= 1280 * 720 ? 2500000
    : p <= 1920 * 1080 ? 4000000 : p <= 2560 * 1440 ? 6000000 : 10000000;
  return fps > 30 ? base * 3 / 2 : base;
}

/** Bubble for window/tab recordings: bottom-left corner (origin bottom-left, like Core Image). */
export function cornerBubble(width, height, diameterFraction = 0.22, marginFraction = 0.03) {
  const s = Math.min(width, height);
  const d = Math.round(s * diameterFraction), m = Math.round(s * marginFraction);
  return { x: m, y: m, width: d, height: d };
}

// ---------------------------------------------------------------- Settings (subset that applies in a browser)

export const DEFAULT_SETTINGS = Object.freeze({
  mode: "screen", cameraEnabled: true, cameraID: null, microphoneID: null, audio: "micOnly", quality: "p1080", fps: 30,
  countdownSeconds: 3, bubbleSize: "medium", autoUpload: true, copyLinkOnStop: true, cameraBackground: "none",
  liveUpload: true, uploadMP4: true,
});
export const AUDIO_SOURCES = Object.freeze({ micOnly: "Microphone", systemOnly: "System audio only", micAndSystem: "Microphone + system audio", none: "No audio" });
export const usesMic = (a) => a === "micOnly" || a === "micAndSystem";
export const usesSystem = (a) => a === "systemOnly" || a === "micAndSystem";
export const BUBBLE_DIAMETER = Object.freeze({ small: 160, medium: 220, large: 320 });

/** Tolerant decoding like ReelSettings.init(from:). */
export function decodeSettings(j) {
  const d = { ...DEFAULT_SETTINGS };
  if (!j || typeof j !== "object") return d;
  const pick = (k, ok) => { if (ok(j[k])) d[k] = j[k]; };
  pick("mode", (v) => ["screen", "window", "camera"].includes(v));
  pick("cameraEnabled", (v) => typeof v === "boolean");
  pick("cameraID", (v) => typeof v === "string");
  pick("microphoneID", (v) => typeof v === "string");
  pick("audio", (v) => v in AUDIO_SOURCES);
  pick("quality", (v) => v in QUALITY);
  pick("fps", (v) => [24, 30, 60].includes(v));
  if (Number.isInteger(j.countdownSeconds)) d.countdownSeconds = Math.min(Math.max(j.countdownSeconds, 0), 10);
  pick("bubbleSize", (v) => v in BUBBLE_DIAMETER);
  for (const k of ["autoUpload", "copyLinkOnStop", "liveUpload", "uploadMP4"]) pick(k, (v) => typeof v === "boolean");
  pick("cameraBackground", (v) => ["none", "blur", "image"].includes(v));
  return d;
}

// ---------------------------------------------------------------- Transcript (for the viewer's transcriptStatus)

export function transcriptTimestamp(seconds) {
  const t = Math.max(0, Math.floor(seconds)), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

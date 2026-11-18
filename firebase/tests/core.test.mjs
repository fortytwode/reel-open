// Unit tests for web/reel/core.js, the browser recorder's port of Sources/ReelCore.
// 1. Cross-client vectors: Tests/CrossClient/cross-client.json is produced by ReelCore itself
//    (Tests/ReelCoreTests/CrossClientFixtureTests.swift); here the JS port must produce the same
//    bytes (meta.json, stub, recording.json, playlists) and the same requests (URLs, headers,
//    parsed JSON bodies) for the same inputs.
// 2. Ports of the Swift unit tests (same IDs and expected values as Tests/ReelCoreTests).
// Run: node --test firebase/tests/core.test.mjs (no emulators needed).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as C from "../../web/reel/core.js";

const V = JSON.parse(readFileSync(new URL("../../Tests/CrossClient/cross-client.json", import.meta.url), "utf8"));
const cfg = { ...C.CLOUD, ...JSON.parse(readFileSync(new URL("../../organization.example.json", import.meta.url))) };
const id = "abcdefghij0123456789";
const key = "0123456789abcdef0123456789abcdef";
const created = new Date(1792576800 * 1000);
const expiry = new Date(1800000000.5 * 1000);
const dec = new TextDecoder();

function describe(r) { return { method: r.method, url: r.url, headers: r.headers }; }
function body(r) { return r.body == null ? null : JSON.parse(typeof r.body === "string" ? r.body : dec.decode(r.body)); }

function recordingOpen() {
  const r = C.newRecording({ id: "LOCAL-1", shareID: id, title: "Q3 plan – v2", createdAt: created, mode: "screen", upload: "uploaded" });
  Object.assign(r, { durationSeconds: 61.5, width: 1920, height: 1080, folderName: "2026-10-21 100000 abcdef", transcriptStatus: "ready", hasThumbnail: true,
    playback: { hls: true, mp4: true }, trim: { start: 5, end: 20.25 }, trimmedUploaded: true, summary: "A short summary.",
    chapters: [{ start: 0, title: "Intro" }, { start: 30, title: "Demo" }], captureState: "complete", titleIsCustom: true });
  r.access.expiresAt = expiry;
  return r;
}
function recordingStarting() {
  const r = C.newRecording({ id: "LOCAL-2", shareID: id, title: "Recording – 21 Oct 2026, 10:00", createdAt: created, mode: "window", upload: "uploading" });
  Object.assign(r, { width: 1670, height: 1080, folderName: "2026-10-21 100000 abcdef", captureState: "recording" });
  return r;
}
function recordingKeyed() {
  const r = C.newRecording({ id: "LOCAL-3", shareID: id, title: "Secret", createdAt: created, mode: "camera", upload: { failed: "HTTP 503" } });
  Object.assign(r, { durationSeconds: 8.08, width: 1280, height: 720, folderName: "f", transcriptStatus: "failed", hasThumbnail: true,
    playback: { hls: false, mp4: true }, captureState: "recovered" });
  r.access = { key, passwordSalt: "00112233445566778899aabbccddeeff", expiresAt: null };
  return r;
}

// ---------------------------------------------------------------- cross-client vectors

test("meta.json bytes match the Mac app", () => {
  assert.equal(C.encodeJSON(C.remoteMeta(recordingOpen(), "ready", "Sam", "Reel 1.1.0")), V.metaOpenReady);
  assert.equal(C.encodeJSON(C.remoteMeta(recordingStarting(), "recording", null, "Reel 1.1.0")), V.metaStartingRecording);
  assert.equal(C.encodeJSON(C.remoteMeta(recordingKeyed(), "processing", "sam@northwind.example", "Reel 1.1.0")), V.metaKeyedProcessing);
});

test("locked stub bytes match", () => {
  assert.equal(C.encodeJSON(C.lockedStub(id, "00112233445566778899aabbccddeeff", expiry, "ready")), V.lockedStub);
});

test("recording.json bytes match and round-trip", () => {
  for (const [make, k] of [[recordingOpen, "recordingJSONOpen"], [recordingKeyed, "recordingJSONKeyed"], [recordingStarting, "recordingJSONStarting"]]) {
    const r = make();
    assert.equal(C.swiftJSON(C.recordingToJSON(r)), V[k], k);
    const back = C.recordingFromJSON(JSON.parse(V[k]));
    assert.deepEqual(C.recordingToJSON(back), C.recordingToJSON(r), k + " round trip");
  }
});

test("multipart uploads: URL, headers, metadata JSON and payload framing match", () => {
  const s = new C.StorageRequests({ cfg, auth: { firebase: "tok" }, ownerUID: "uid-1" });
  for (const c of V.multipartUploads) {
    const options = {};
    if (c.expiresAt != null) options.expiresAt = new Date(c.expiresAt);
    if (c.contentDisposition != null) options.contentDisposition = c.contentDisposition;
    const r = s.multipartUpload(id, c.file, "BYTES", { key: c.key, options, boundary: "BND" });
    assert.deepEqual(describe(r), { method: c.method, url: c.url, headers: c.headers }, c.file);
    const text = dec.decode(r.body);
    const head = "--BND\r\nContent-Type: application/json; charset=utf-8\r\n\r\n";
    assert.ok(text.startsWith(head));
    const mid = text.indexOf("\r\n--BND\r\nContent-Type: ");
    assert.deepEqual(JSON.parse(text.slice(head.length, mid)), c.metadata, c.file + " metadata");
    assert.equal(text.slice(mid), c.payload, c.file + " payload");
  }
});

test("resumable, metadata, delete requests match", () => {
  const s = new C.StorageRequests({ cfg, auth: { firebase: "tok" }, ownerUID: "uid-1" });
  const start = s.resumableStart(id, C.File.video, 12345678, { key, options: { expiresAt: expiry, contentDisposition: "attachment; filename=\"a.mp4\"" } });
  assert.deepEqual({ ...describe(start), body: body(start) }, V.resumableStart);
  assert.deepEqual(describe(C.StorageRequests.resumableChunk("https://example.com/session", 8388608, new Uint8Array([1]), false)), V.resumableChunkMid);
  assert.deepEqual(describe(C.StorageRequests.resumableChunk("https://example.com/session", 0, new Uint8Array(), true)), V.resumableChunkLast);
  const set = s.updateMetadata(id, C.segmentFile(12), expiry);
  assert.deepEqual({ ...describe(set), body: body(set) }, V.updateMetadataSet);
  const clear = s.updateMetadata(id, C.File.meta, null, key);
  assert.deepEqual({ ...describe(clear), body: body(clear) }, V.updateMetadataClear);
  assert.deepEqual(describe(s.getMetadata(id, C.File.thumbnail, key)), V.getMetadata);
  assert.deepEqual(describe(s.delete(id, C.segmentFile(1))), V.deleteObject);
  assert.deepEqual(C.chunkRanges(C.DEFAULT_CHUNK_SIZE * 2 + 123), V.chunkRanges);
  for (const [f, v] of Object.entries(V.cacheControl)) assert.equal(C.cacheControl(f), v, f);
  for (const [f, v] of Object.entries(V.contentTypes)) assert.equal(C.contentType(f), v, f);
  for (const d of V.dispositions) assert.equal(C.attachmentDisposition(d.title), d.value, d.title);
  for (const e of V.encodedObjectNames) assert.equal(C.encodedObjectName(e.path), e.value, e.path);
  assert.deepEqual([C.downloadURL(id, C.File.meta, null, cfg), C.downloadURL(id, C.File.playlist, key, cfg)], V.downloadURLs);
  assert.equal(C.viewerURL(id, cfg), V.viewerURL);
  assert.deepEqual([C.room(id), C.room(id, key)], V.rooms);
  assert.equal(C.expiryString(expiry), V.expiryString);
});

test("Firestore room requests match", () => {
  const f = new C.FirestoreRequests({ cfg, idToken: "tok" });
  const both = (r) => ({ ...describe(r), body: body(r) });
  assert.deepEqual(both(f.createRoom(id, "uid-1", created)), V.firestoreCreateRoom);
  assert.deepEqual(both(f.createRoom(`${id}-${key}`, "uid-1", new Date(1792576800250), 7, expiry)), V.firestoreCreateRoomKeyed);
  assert.deepEqual(both(f.setRoomExpiry(id, expiry)), V.firestoreSetExpiry);
  assert.deepEqual(both(f.setRoomExpiry(id, null)), V.firestoreClearExpiry);
  assert.deepEqual(describe(f.getRoom(id)), V.firestoreGetRoom);
  assert.deepEqual(describe(f.list(id, "comments", "abc/def+==")), V.firestoreList);
  const fields = { text: C.FV.string("hi"), t: C.FV.double(1.5), migrated: C.FV.bool(true), createdAt: C.FV.timestamp(created), photoURL: C.FV.null() };
  assert.deepEqual(both(f.create(id, "comments", fields)), V.firestoreCreateComment);
  assert.deepEqual(describe(f.delete(id)), V.firestoreDeleteRoom);
  assert.deepEqual(describe(f.delete(id, "projects/p/databases/reel/documents/videos/x/comments/c")), V.firestoreDeleteDoc);
});

test("HLS playlists match byte for byte", () => {
  const segs = [{ index: 2, duration: 4.0, bytes: 1 }, { index: 1, duration: 4.02, bytes: 1 }, { index: 3, duration: 2.5, bytes: 1 }];
  assert.equal(C.hlsPlaylist(segs, true, (f) => C.downloadURL(id, f, null, cfg)), V.playlistVOD);
  assert.equal(C.hlsPlaylist(segs.slice(0, 2), false, (f) => C.downloadURL(id, f, key, cfg)), V.playlistEvent);
});

test("titles, folder names, trims match", () => {
  assert.equal(C.defaultTitle(created, "UTC"), V.defaultTitleUTC);
  assert.equal(C.defaultTitle(created, "Asia/Tokyo"), V.defaultTitleTokyo);
  assert.equal(C.folderName(new Date(1792600202 * 1000), id, "UTC"), V.folderNameUTC);
  for (const t of V.trims) {
    const out = C.normalizeTrim(...t.in);
    assert.deepEqual(out ? [out.start, out.end] : null, t.out, JSON.stringify(t.in));
  }
});

test("PBKDF2 access keys match (incl. the production iteration count)", async () => {
  for (const p of V.pbkdf2) assert.equal(await C.deriveKey(p.password, p.salt, p.iterations), p.key, p.password);
});

test("geometry and bitrate match", () => {
  for (const o of V.outputSizes) { const r = C.outputSize(o.in[0], o.in[1], o.in[2]); assert.deepEqual([r.width, r.height], o.out, JSON.stringify(o.in)); }
  for (const b of V.bitrates) assert.equal(C.bitrate(...b.in), b.out, JSON.stringify(b.in));
  const c = C.cornerBubble(1920, 1080);
  assert.deepEqual([c.x, c.y, c.width, c.height], V.cornerBubble1080);
});

// ---------------------------------------------------------------- ports of Tests/ReelCoreTests

test("ShareLinksTests", () => {
  for (let i = 0; i < 50; i++) { const s = C.newShareID(); assert.equal(s.length, 20); assert.ok(/^[a-z0-9]{20}$/.test(s)); assert.ok(C.isValidShareID(s)); }
  assert.equal(new Set(Array.from({ length: 100 }, () => C.newShareID())).size, 100);
  assert.ok(C.isValidShareID(id));
  assert.ok(C.isValidShareID("a".repeat(16)) && C.isValidShareID("a".repeat(40)));
  assert.ok(!C.isValidShareID("a".repeat(15)) && !C.isValidShareID("a".repeat(41)));
  assert.ok(!C.isValidShareID("ABCDEFGHIJ0123456789") && !C.isValidShareID("abcdefghij012345678-"));
  const base = `https://record.northwind.example/v/${id}`;
  for (const u of [`https://record.northwind.example/v/${id}?x=1#t=12`, base, base + "/", base + "#t=12", base + "?utm=x", "  " + base + "\n", id, ` ${id} `,
    `https://firebasestorage.googleapis.com/v0/b/demo-reel.firebasestorage.app/o/reel%2Fv%2F${id}%2Fmeta.json?alt=media`]) assert.equal(C.shareIDFrom(u), id, u);
  for (const u of ["", "hello world", "https://record.northwind.example/v/short", "https://record.northwind.example/v/ABCDEFGHIJ0123456789",
    "https://record.northwind.example/", `https://example.com/x/${id}`]) assert.equal(C.shareIDFrom(u), null, u);
  assert.equal(C.objectPath(id, C.File.video), `reel/v/${id}/video.mp4`);
  assert.equal(C.encodedObjectName("a-b_c.d~e/f g"), "a-b_c.d~e%2Ff%20g");
});

test("SharingTests: keys, files, meta, trims, expiry", async () => {
  assert.equal(await C.deriveKey("passwd", C.hex(new TextEncoder().encode("salt")), 1, 16), "55ac046e56e3089fec1691c22544b605");
  const s1 = "00112233445566778899aabbccddeeff", s2 = "ffeeddccbbaa99887766554433221100";
  const a = await C.deriveKey("hunter2", s1, 1000);
  assert.equal(a, await C.deriveKey("hunter2", s1, 1000));
  assert.notEqual(a, await C.deriveKey("hunter2", s2, 1000));
  assert.notEqual(a, await C.deriveKey("hunter3", s1, 1000));
  assert.ok(C.isValidKey(a));
  assert.equal(await C.deriveKey("", s1), null);
  assert.equal(await C.deriveKey("x", "zz"), null);
  const salt = C.newSalt();
  assert.equal(salt.length, 32); assert.equal(C.bytesFromHex(salt).length, 16); assert.notEqual(salt, C.newSalt());
  assert.ok(!C.isValidKey(key.toUpperCase()) && !C.isValidKey(key.slice(1)));

  assert.equal(C.objectPath(id, C.File.video, key), `reel/v/${id}/k/${key}/video.mp4`);
  for (const f of [...C.FIXED_FILES, C.segmentFile(1), C.segmentFile(99999), C.segmentFile(123456)]) assert.ok(C.isAllowedByRules(f), f);
  assert.ok(!C.isAllowedByRules("evil.html") && !C.isAllowedByRules("seg1.m4s"));
  assert.equal(C.segmentFile(7), "seg00007.m4s");
  assert.equal(C.contentType(C.segmentFile(1)), "video/iso.segment");

  const r = C.newRecording({ shareID: id, title: "Demo", createdAt: new Date(0), mode: "area" });
  Object.assign(r, { durationSeconds: 61, width: 1920, height: 1080, folderName: "f", playback: { hls: true, mp4: false } });
  r.trim = { start: 1, end: 50 }; r.summary = "S"; r.chapters = [{ start: 0, title: "Intro" }];
  const j = JSON.parse(C.encodeJSON(C.remoteMeta(r, "ready", "Sam", "Reel")));
  assert.equal(j.schemaVersion, 2); assert.equal(j.playback.hls, true); assert.equal(j.trim.end, 50);
  assert.equal(j.download, null); assert.equal(j.expiresAt, null); assert.equal(j.locked, false); assert.equal(j.room, id); assert.equal(j.summary, "S");

  const d = C.newRecording({ shareID: id, createdAt: new Date(0) });
  d.playback = { hls: true, mp4: false };
  assert.equal(C.downloadFile(d), null);
  d.playback.mp4 = true; assert.equal(C.downloadFile(d), "video.mp4");
  d.trim = { start: 1, end: 2 }; assert.equal(C.downloadFile(d), "video.mp4");
  d.trimmedUploaded = true; assert.equal(C.downloadFile(d), "trimmed.mp4");

  const stub = C.lockedStub(id, "00", null, "ready");
  assert.equal(stub.locked, true); assert.equal(stub.title, undefined); assert.equal(stub.kdf.iterations, 210000);

  const legacy = { id: "x", shareID: id, title: "T", createdAt: "2026-10-21T10:00:00Z", durationSeconds: 3, width: 10, height: 10,
    mode: "screen", folderName: "f", upload: { uploaded: {} }, transcriptStatus: "ready", hasThumbnail: true };
  const lr = C.recordingFromJSON(legacy);
  assert.equal(lr.upload, "uploaded"); assert.equal(lr.captureState, "complete"); assert.deepEqual(lr.access, { key: null, passwordSalt: null, expiresAt: null });
  assert.equal(lr.trim, null); assert.equal(lr.titleIsCustom, false);

  assert.deepEqual(C.normalizeTrim(-3, 5, 10), { start: 0, end: 5 });
  assert.equal(C.normalizeTrim(0, 10, 10), null);
  assert.equal(C.normalizeTrim(NaN, 2, 10), null);
  assert.equal(C.expiryDate("never", new Date(0)), null);
  assert.equal(C.expiryDate("day", new Date(0)).getTime(), 86400000);
});

test("LiveUploadTests: playlist, segment log, recovery plan", () => {
  const entries = (ds) => ds.map((d, i) => ({ index: i + 1, duration: d, bytes: 100 }));
  const p = C.hlsPlaylist(entries([4.0, 4.0, 2.5]), true, (f) => "https://x/" + f).split("\n").filter(Boolean);
  assert.equal(p[0], "#EXTM3U");
  assert.ok(p.includes("#EXT-X-TARGETDURATION:4") && p.includes("#EXT-X-PLAYLIST-TYPE:VOD") && p.includes('#EXT-X-MAP:URI="https://x/init.mp4"'));
  assert.deepEqual(p.filter((l) => l.startsWith("#EXTINF")), ["#EXTINF:4.00000,", "#EXTINF:4.00000,", "#EXTINF:2.50000,"]);
  assert.equal(p.at(-1), "#EXT-X-ENDLIST");
  const ev = C.hlsPlaylist(entries([4.02]), false, (f) => f);
  assert.ok(ev.includes("#EXT-X-PLAYLIST-TYPE:EVENT") && ev.includes("#EXT-X-TARGETDURATION:5") && !ev.includes("ENDLIST"));

  const log = C.newSegmentLog();
  log.hasInit = true;
  C.SegmentLog.append(log, { index: 1, duration: 4, bytes: 10 });
  C.SegmentLog.append(log, { index: 2, duration: 3, bytes: 10 });
  C.SegmentLog.append(log, { index: 2, duration: 3.5, bytes: 11 });
  assert.equal(log.segments.length, 2); assert.equal(C.SegmentLog.totalDuration(log), 7.5); assert.equal(C.SegmentLog.nextIndex(log), 3);
  assert.ok(!C.SegmentLog.allUploaded(log));
  log.uploadedInit = true; log.uploaded = [1];
  assert.deepEqual(C.SegmentLog.pendingUploads(log).map((s) => s.index), [2]);
  log.uploaded.push(2); assert.ok(C.SegmentLog.allUploaded(log));
  C.SegmentLog.resetUploads(log, "k"); assert.equal(log.uploadedLocation, "k"); assert.ok(!C.SegmentLog.allUploaded(log));

  const o = C.newSegmentLog();
  C.SegmentLog.append(o, { index: 1, duration: 4, bytes: 1 });
  C.SegmentLog.adopt(o, ["seg00001.m4s", "seg00002.m4s", "seg00003.m4s", "init.mp4", "state.json", "segX.m4s"], 4);
  assert.deepEqual(o.segments.map((s) => s.index), [1, 2, 3]);
  assert.equal(C.SegmentLog.segmentIndex("seg00042.m4s"), 42); assert.equal(C.SegmentLog.segmentIndex("init.mp4"), null);

  assert.equal(C.recoveryPlan("complete", true, true, 3), "none");
  assert.equal(C.recoveryPlan("recording", false, true, 3), "rebuildFromSegments");
  assert.equal(C.recoveryPlan("recording", false, true, 0), "discard");
  assert.equal(C.recoveryPlan("recording", false, false, 2), "discard");
  assert.equal(C.recoveryPlan("finalizing", true, true, 3), "finishProcessing");
  assert.equal(C.recoveryPlan("recovered", true, true, 3), "none");
});

test("PauseClockTests", () => {
  let c = new C.PauseClock();
  assert.equal(c.outputTime(5), null); c.begin(10); assert.equal(c.outputTime(9.9), null);
  assert.equal(new C.PauseClock().elapsed(100), 0);
  c = new C.PauseClock(); c.begin(10); assert.equal(c.outputTime(10), 0); assert.equal(c.outputTime(12.5), 2.5); assert.ok(c.isRunning);
  c = new C.PauseClock(); c.begin(0); c.pause(5); assert.ok(c.isPaused); assert.equal(c.outputTime(5), null); assert.equal(c.outputTime(7), null);
  c.resume(8); assert.ok(!c.isPaused); assert.equal(c.outputTime(9), 6);
  c = new C.PauseClock(); c.begin(0); c.pause(2); c.resume(4); c.pause(6); c.resume(9); assert.equal(c.pausedTotal, 5); assert.equal(c.outputTime(10), 5);
  c = new C.PauseClock(); c.begin(0); c.pause(5); c.stop(20); assert.ok(!c.isRunning); assert.equal(c.elapsed(100), 5);
  assert.equal(c.outputTime(6), null); assert.equal(c.outputTime(20), null); assert.equal(c.outputTime(4), 4);
  c = new C.PauseClock(); c.begin(0); c.stop(10); assert.equal(c.elapsed(99), 10); assert.equal(c.outputTime(10), 10); assert.equal(c.outputTime(10.1), null);
  c = new C.PauseClock(); c.begin(0); c.pause(5); assert.equal(c.elapsed(5), 5); assert.equal(c.elapsed(50), 5); c.resume(50); assert.equal(c.elapsed(52), 7);
  c = new C.PauseClock(); c.pause(1); c.resume(2); assert.ok(!c.isPaused); c.begin(0); c.resume(3); assert.equal(c.pausedTotal, 0);
  c.pause(4); c.pause(6); assert.equal(c.pausedAt, 4);
  c = new C.PauseClock(); c.begin(0); c.pause(1); c.stop(2); c.begin(100); assert.ok(c.isRunning && !c.isPaused); assert.equal(c.outputTime(101), 1);
});

test("RecordingTests", () => {
  assert.equal(C.cleanTitle("  Hello  "), "Hello");
  assert.equal(C.cleanTitle("a\nb"), "a b");
  assert.equal(C.cleanTitle("   \n  "), null);
  assert.equal(C.cleanTitle(""), null);
  assert.equal(C.cleanTitle("x".repeat(500)).length, 200);
  assert.equal(C.uploadStateLabel({ failed: "boom" }), "Upload failed: boom");
  assert.equal(C.uploadStateLabel("uploaded"), "Uploaded");
  const r = C.newRecording({ shareID: id, createdAt: new Date(0) });
  assert.equal(C.shareURL(r, cfg), `https://record.northwind.example/v/${id}`);
  assert.equal(C.CaptureMode.camera, "Camera only");
});

test("SettingsTests (browser subset): tolerant decoding", () => {
  assert.deepEqual(C.decodeSettings(null), { ...C.DEFAULT_SETTINGS });
  const s = C.decodeSettings({ fps: 45, countdownSeconds: 99, audio: "bogus", quality: "p720", mode: "area", liveUpload: false });
  assert.equal(s.fps, 30); assert.equal(s.countdownSeconds, 10); assert.equal(s.audio, "micOnly"); assert.equal(s.quality, "p720");
  assert.equal(s.mode, "screen"); assert.equal(s.liveUpload, false);
});

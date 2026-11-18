import test from "node:test";
import assert from "node:assert/strict";
import * as C from "../../web/reel/core.js";
import { Publisher } from "../../web/reel/publisher.js";

const now = new Date("2026-10-29T10:00:00Z");
function meetingRecording(upload = "pending") {
  const r = C.newRecording({ id: "local-meeting", shareID: "abcdefghij0123456789", title: "Meeting", createdAt: now, mode: "window", upload });
  r.meeting = C.parseMeetingDetails("alice@example.com; bob@example.org");
  return r;
}

test("meeting metadata round-trips locally across every upload state", () => {
  for (const upload of ["localOnly", "pending", "uploading", "uploaded", { failed: "offline" }]) {
    const r = meetingRecording(upload);
    const saved = C.recordingToJSON(r);
    assert.deepEqual(saved.meeting, { attendees: ["alice@example.com", "bob@example.org"] });
    const decoded = C.recordingFromJSON(saved);
    assert.equal(C.isMeeting(decoded), true);
    assert.deepEqual(decoded.meeting, r.meeting);
  }
});

test("capture account persists locally but is absent from public metadata", () => {
  const r = meetingRecording("localOnly");
  r.meeting.ownerUID = "original-capture-account";
  const decoded = C.recordingFromJSON(C.recordingToJSON(r));
  assert.equal(decoded.meeting.ownerUID, "original-capture-account");
  assert.equal(JSON.stringify(C.remoteMeta(decoded, "ready", "Owner", "Reel web")).includes("original-capture-account"), false);
});

test("missing meeting marker stays backward compatible; malformed marker fails closed", () => {
  const ordinary = C.recordingToJSON(C.newRecording({ id: "old", shareID: "abcdefghij0123456789", createdAt: now }));
  assert.equal(Object.hasOwn(ordinary, "meeting"), false);
  assert.equal(C.isMeeting(C.recordingFromJSON(ordinary)), false);
  ordinary.meeting = "malformed";
  const decoded = C.recordingFromJSON(ordinary);
  assert.equal(C.isMeeting(decoded), true);
  assert.deepEqual(decoded.meeting, { attendees: [] });
  ordinary.meeting = null;
  assert.equal(C.isMeeting(C.recordingFromJSON(ordinary)), true);
});

test("attendee details validate and bound email metadata; meeting snapshot keeps ordinary settings", () => {
  assert.deepEqual(C.parseMeetingDetails("alice@example.com; bob@example.org"), { attendees: ["alice@example.com", "bob@example.org"] });
  assert.throws(() => C.parseMeetingDetails("alice@example.com; nope"), /valid attendee/);
  assert.throws(() => C.parseMeetingDetails(Array.from({ length: 201 }, (_, i) => `p${i}@example.com`).join(";")), /200/);
  const normal = { mode: "screen", autoUpload: true, liveUpload: true, copyLinkOnStop: true, uploadMP4: true };
  const snapshot = C.meetingSettings(normal);
  assert.deepEqual(snapshot, { ...normal, mode: "window", cameraEnabled: false, audio: "micAndSystem", fps: 15,
    autoUpload: false, liveUpload: false, copyLinkOnStop: false });
  assert.equal(normal.mode, "screen");
});

test("remote metadata never includes attendees or meeting marker", () => {
  const meta = C.remoteMeta(meetingRecording("uploaded"), "ready", "Owner", "Reel web");
  assert.equal(Object.hasOwn(meta, "meeting"), false);
  assert.equal(JSON.stringify(meta).includes("alice@example.com"), false);
});

test("automatic publishing and default publish reject meeting recordings", async () => {
  const r = meetingRecording("pending");
  assert.equal(C.automaticCloudAllowed(r), false);
  let sessionCalls = 0;
  const library = { get: () => structuredClone(r), list: () => [structuredClone(r)] };
  const publisher = new Publisher({ library, auth: { session: async () => { sessionCalls++; return null; } },
    settings: () => ({ autoUpload: true, liveUpload: true }), ui: { toast() {}, notify() {}, copy() {} } });
  assert.equal(await publisher.publish(r), false);
  assert.equal(await publisher.beginLive(r), null);
  assert.equal(await publisher.finishLive(r.id, {}, {}, Date.now()), false);
  await publisher.syncCloudLibrary();
  assert.equal(sessionCalls, 0);
});

test("meeting share copies only after the complete upload succeeds", async () => {
  const original = meetingRecording("pending");
  let saved = structuredClone(original);
  const copies = [];
  const library = {
    get: () => structuredClone(saved),
    update: async (r) => { saved = structuredClone(r); },
    setProgress() {},
  };
  const publisher = new Publisher({ library, auth: { session: async () => ({ uid: "u", email: "owner@example.com" }) },
    settings: () => ({}), ui: { toast() {}, notify() {}, copy: (url) => copies.push({ url, status: saved.upload }) } });
  publisher.sync = async (_id, _s, copyLink) => {
    assert.equal(copyLink, false); // The meeting URL is held until publish records full success.
    throw new Error("transcript upload failed");
  };
  await publisher.publish(original, { copyLink: true, allowMeetingShare: true });
  assert.equal(copies.length, 0);
  assert.equal(saved.upload.failed, "transcript upload failed");

  saved = structuredClone(original);
  publisher.sync = async (_id, _s, copyLink) => { assert.equal(copyLink, false); };
  await publisher.publish(original, { copyLink: true, allowMeetingShare: true });
  assert.equal(copies.length, 1);
  assert.equal(copies[0].status, "uploaded");
});

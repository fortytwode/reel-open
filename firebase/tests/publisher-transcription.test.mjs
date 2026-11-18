import test from "node:test";
import assert from "node:assert/strict";
import * as C from "../../web/reel/core.js";
import { Publisher } from "../../web/reel/publisher.js";

function fixture() {
  let current = C.newRecording({ id: "local", shareID: "abcdefghij0123456789", createdAt: new Date(), upload: "uploaded" });
  current.captureState = "complete"; current.transcriptStatus = "ready";
  let signedIn = { uid: "owner", email: "owner@rocketshiphq.com" };
  const writes = [];
  const publisher = new Publisher({ library: {
    get: () => current && structuredClone(current), update: async (r) => { current = structuredClone(r); }, setProgress() {},
  }, auth: { session: async () => signedIn }, settings: () => ({ autoUpload: false }), ui: { toast() {} } });
  publisher.firestore = () => ({ ownsRoom: async () => true });
  publisher.publish = async (r, options) => { writes.push({ id: r.id, ...options }); return true; };
  return { publisher, writes, get: () => current, account: (s) => { signedIn = s; } };
}

test("transcript refresh waits for video publishing and updates its original owner without copying links", async () => {
  const f = fixture();
  f.get().upload = "uploading";
  let finish;
  f.publisher.uploads.set("local", new Promise((resolve) => { finish = () => { f.get().upload = "uploaded"; resolve(); }; }));
  const pending = f.publisher.refreshTranscript("local", "owner");
  await Promise.resolve();
  assert.equal(f.writes.length, 0);
  finish();
  assert.equal(await pending, true);
  assert.deepEqual(f.writes, [{ id: "local", expectedOwnerUID: "owner" }]);
});

test("transcription cannot automatically share meetings, local-only recordings, or a different account's room", async () => {
  for (const kind of ["meeting", "malformed-meeting", "localOnly", "pending", "failed", "not-ready", "different-account", "signed-out", "missing-owner", "unowned-room"]) {
    const f = fixture();
    if (kind === "meeting") f.get().meeting = { attendees: [] };
    if (kind === "malformed-meeting") f.get().meeting = null;
    if (["localOnly", "pending"].includes(kind)) f.get().upload = kind;
    if (kind === "failed") f.get().upload = { failed: "offline" };
    if (kind === "not-ready") f.get().transcriptStatus = "pending";
    if (kind === "different-account") f.account({ uid: "other" });
    if (kind === "signed-out") f.account(null);
    if (kind === "unowned-room") f.publisher.firestore = () => ({ ownsRoom: async () => false });
    assert.equal(await f.publisher.refreshTranscript("local", kind === "missing-owner" ? null : "owner"), false, kind);
    assert.equal(f.writes.length, 0, kind);
  }
});

test("account change during the pending video upload prevents automatic transcript publishing", async () => {
  const f = fixture();
  f.publisher.uploads.set("local", Promise.resolve().then(() => f.account({ uid: "new-owner" })));
  assert.equal(await f.publisher.refreshTranscript("local", "owner"), false);
  assert.equal(f.writes.length, 0);
});

test("a bound background publish skips a changed account before any upload or local state change", async () => {
  const f = fixture(); f.account({ uid: "other" });
  let syncCalls = 0;
  f.publisher.sync = async () => { syncCalls++; };
  // Use the real publication entry point, not the refresh observer above.
  const result = await Publisher.prototype.publish.call(f.publisher, f.get(), { expectedOwnerUID: "owner" });
  assert.equal(result, false);
  assert.equal(syncCalls, 0);
  assert.equal(f.get().upload, "uploaded");
});

test("account change during room ownership verification cannot start the background upload", async () => {
  const f = fixture();
  f.publisher.firestore = () => ({ ownsRoom: async () => { f.account({ uid: "other" }); return true; } });
  f.publisher.publish = Publisher.prototype.publish.bind(f.publisher);
  let syncCalls = 0; f.publisher.sync = async () => { syncCalls++; };
  assert.equal(await f.publisher.refreshTranscript("local", "owner"), false);
  assert.equal(syncCalls, 0);
  assert.equal(f.get().upload, "uploaded");
});

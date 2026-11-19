import test from "node:test";
import assert from "node:assert/strict";
import * as C from "../../web/reel/core.js";
import * as store from "../../web/reel/store.js?v=20261119-owner2";
import { Library, Publisher } from "../../web/reel/publisher.js";

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
    bind: async (r, uid, meetingShareUID) => {
      assert.equal(uid, "u");
      assert.equal(meetingShareUID, "u");
      return r;
    },
    setProgress() {},
  };
  const publisher = new Publisher({ library, auth: { session: async () => ({ uid: "u", email: "owner@example.com" }) },
    settings: () => ({}), ui: { toast() {}, notify() {}, copy: (url) => copies.push({ url, status: saved.upload }) } });
  publisher.sync = async (_id, _s, copyLink) => {
    assert.equal(copyLink, false); // The meeting URL is held until publish records full success.
    throw new Error("transcript upload failed");
  };
  await publisher.publish(original, { copyLink: true, allowMeetingShare: true, expectedOwnerUID: "u" });
  assert.equal(copies.length, 0);
  assert.equal(saved.upload.failed, "transcript upload failed");

  saved = structuredClone(original);
  publisher.sync = async (_id, _s, copyLink) => { assert.equal(copyLink, false); };
  await publisher.publish(original, { copyLink: true, allowMeetingShare: true, expectedOwnerUID: "u" });
  assert.equal(copies.length, 1);
  assert.equal(copies[0].status, "uploaded");
});

function meetingRows() {
  // Queue IndexedDB requests as tasks so read/conditional-put uses one active transaction.
  const rows = new Map();
  const db = { transaction() {
    const tx = { objectStore: () => ({
      get(id) {
        const request = {};
        setImmediate(() => {
          request.result = structuredClone(rows.get(id));
          request.onsuccess();
          setImmediate(() => tx.oncomplete?.());
        });
        return request;
      },
      put(row) { rows.set(row.id, structuredClone(row)); },
    }) };
    return tx;
  } };
  return { open() {
    const request = {};
    setImmediate(() => { request.result = db; request.onsuccess(); });
    return request;
  } };
}

const originalIndexedDB = globalThis.indexedDB;
test.before(() => { globalThis.indexedDB = meetingRows(); });
test.after(() => { globalThis.indexedDB = originalIndexedDB; });

test("meeting share uses the confirmed account and checks ownership in the persisted row", async () => {
  const original = meetingRecording("localOnly");
  original.recordingNonce = "41".repeat(16);
  const library = new Library();
  await library.update(original);
  const staleTab = new Library();
  staleTab.items.set(original.id, structuredClone(original));

  const claimed = { ...original, meeting: { ...original.meeting, ownerUID: "processing-account" } };
  assert.equal(await library.updateExisting(claimed), true);
  await staleTab.update({ ...original, title: "Stale title" });
  assert.equal((await store.getRow(original.id)).json.meeting.ownerUID, "processing-account");
  assert.equal(staleTab.get(original.id).meeting.ownerUID, "processing-account");

  // Simulate a tab that has not yet observed the persisted claim.
  staleTab.items.set(original.id, structuredClone(original));
  let account = "share-account", generation = 0, uploads = 0;
  const copies = [];
  const publisher = new Publisher({
    library: staleTab,
    auth: { session: async () => {
      const uid = account, snapshot = generation;
      return { uid, isCurrent: () => account === uid && generation === snapshot, getIdToken: async () => "synthetic-id" };
    } },
    settings: () => ({}), ui: { toast() {}, copy: (url) => copies.push(url) },
  });
  publisher.sync = async () => { uploads++; };
  assert.equal(await publisher.publish(original, { allowMeetingShare: true, expectedOwnerUID: "share-account" }), false);
  assert.equal((await store.getRow(original.id)).json.recordingOwnerUID, undefined);
  assert.equal(uploads, 0);

  let releaseSession;
  const postponed = new Promise(resolve => { releaseSession = resolve; });
  const ordinarySession = publisher.auth.session;
  publisher.auth.session = async () => { await postponed; return ordinarySession(); };
  account = "processing-account";
  const sharing = publisher.publish(original, { allowMeetingShare: true, expectedOwnerUID: account, copyLink: true });
  account = "switched-account";
  generation++;
  releaseSession();
  assert.equal(await sharing, false);
  assert.equal((await store.getRow(original.id)).json.recordingOwnerUID, undefined);
  assert.deepEqual(copies, []);

  account = "processing-account";
  generation++;
  const previousGeneration = generation;
  const bind = staleTab.bind.bind(staleTab);
  staleTab.bind = async (...args) => {
    const result = await bind(...args);
    account = "switched-during-binding";
    generation++;
    return result;
  };
  assert.equal(await publisher.publish(original, { allowMeetingShare: true, expectedOwnerUID: account,
    consentIsCurrent: () => generation === previousGeneration, copyLink: true }), false);
  assert.equal(uploads, 0);
  const persisted = (await store.getRow(original.id)).json;
  assert.equal(persisted.recordingOwnerUID, "processing-account");
  assert.equal(persisted.shareID, await C.ownerShareID("processing-account", original.recordingNonce));

  staleTab.bind = bind;
  account = "processing-account";
  generation++;
  await publisher.publish(original, { allowMeetingShare: true, expectedOwnerUID: account, copyLink: true });
  assert.equal(uploads, 1);
  assert.equal(copies.length, 1);
});

test("a later processing claim cannot override an existing share owner's account", async () => {
  const original = meetingRecording("localOnly");
  original.id = "shared-first";
  original.recordingNonce = "ab".repeat(16);
  await store.saveRecording(original);
  const first = await store.bindRecording(original.id, original.recordingNonce, "first-account", "first-account");
  const stale = { ...original, meeting: { ...original.meeting, ownerUID: "different-account" } };
  await store.updateExistingRecording(stale);
  const row = (await store.getRow(original.id)).json;
  assert.equal(row.shareID, first.shareID);
  assert.equal(row.recordingOwnerUID, "first-account");
  assert.equal(row.meeting.ownerUID, undefined);
});

test("an account switch while fetching a token stops an authorized meeting request", async () => {
  let consentIsCurrent = true;
  const publisher = new Publisher({});
  const session = publisher.meetingSession({
    uid: "meeting-account",
    async getIdToken() {
      consentIsCurrent = false;
      return "synthetic-id";
    },
  }, "meeting-account", () => consentIsCurrent);
  await assert.rejects(session.getIdToken(), /account changed/);
  assert.throws(() => session.assertCurrent(), /account changed/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as C from "../../web/reel/core.js";
import * as store from "../../web/reel/store.js?v=20261126-local-import";
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

function publicationStore() {
  // Queue IndexedDB requests as tasks so read/conditional-put uses one active transaction.
  const rows = new Map();
  const files = new Map();
  const db = { transaction(storeName) {
    const tx = { objectStore: (name) => {
      const values = name === "files" ? files : rows;
      return {
        get(id) {
          const request = {};
          setImmediate(() => {
            request.result = structuredClone(values.get(id));
            request.onsuccess();
            setImmediate(() => tx.oncomplete?.());
          });
          return request;
        },
        put(value, id = value.id) {
          values.set(id, structuredClone(value));
          if (storeName === "files") setImmediate(() => tx.oncomplete?.());
        },
        add(value) {
          assert.ok(!values.has(value.id));
          values.set(value.id, structuredClone(value));
          setImmediate(() => tx.oncomplete?.());
        },
      };
    } };
    return tx;
  } };
  return { open() {
    const request = {};
    setImmediate(() => { request.result = db; request.onsuccess(); });
    return request;
  } };
}

const originalIndexedDB = globalThis.indexedDB;
test.before(() => { globalThis.indexedDB = publicationStore(); });
test.after(() => { globalThis.indexedDB = originalIndexedDB; });

test("an explicitly imported clip can be published separately without changing the legacy original", async (t) => {
  const uid = "synthetic-owner";
  const legacy = C.newRecording({ id: "legacy-local", shareID: "legacyfixture00000001", title: "Synthetic clip",
    createdAt: now, upload: "uploaded" });
  legacy.captureState = "complete";
  legacy.playback.mp4 = true;
  const bytes = new Uint8Array([10, 20, 30]);
  const library = new Library();
  await library.update(legacy);
  await store.putFile(legacy.id, C.File.video, bytes);
  const original = await store.getRow(legacy.id);

  const cfg = { ...C.CLOUD, storageOrigin: "https://storage.invalid", firestoreOrigin: "https://firestore.invalid",
    bucket: "fixture-bucket", projectID: "fixture", firestoreDatabase: "(default)" };
  const requests = [];
  const fetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetch; });
  globalThis.fetch = async (input, request) => {
    const url = new URL(input);
    requests.push({ url, ...request });
    if (request.headers["X-Goog-Upload-Command"] === "start") {
      return new Response(null, { headers: { "X-Goog-Upload-URL": "https://storage.invalid/resume-copy" } });
    }
    return new Response("{}");
  };
  const session = { uid, displayName: "Synthetic publisher", isCurrent: () => true, getIdToken: async () => "synthetic-token" };
  const publisher = new Publisher({ library, cfg, auth: { session: async () => session },
    settings: () => ({ autoUpload: true }), ui: { toast() {} } });
  const chosenFile = new File([bytes], "Owner-selected clip.mp4", { type: "video/mp4" });
  const copy = await library.importLocalVideo(chosenFile, { durationSeconds: 4, width: 320, height: 240 }, session);
  const nonce = copy.recordingNonce;
  assert.match(nonce, /^[0-9a-f]{32}$/);
  const ownerShare = "r2" + createHash("sha256").update(`reel-owner-v2:${uid}:${nonce}`).digest("hex").slice(0, 38);
  assert.notEqual(copy.id, legacy.id);
  assert.notEqual(copy.shareID, legacy.shareID);
  assert.equal(copy.shareID, ownerShare);
  assert.equal(copy.upload, "localOnly");
  assert.deepEqual(copy.playback, { hls: false, mp4: false });
  assert.equal(copy.title, "Owner-selected clip");
  const persistedCopy = C.recordingFromJSON((await store.getRow(copy.id)).json);
  assert.equal(persistedCopy.recordingOwnerUID, uid);
  assert.equal(persistedCopy.localImport, true);
  for (const restrictAccount of [true, false]) {
    assert.equal(C.canViewLocalRecording(persistedCopy, uid, restrictAccount), true);
    assert.equal(C.canViewLocalRecording(persistedCopy, "other-account", restrictAccount), false);
    assert.equal(C.canViewLocalRecording(persistedCopy, null, restrictAccount), false);
  }
  assert.deepEqual(copy.access, { key: null, passwordSalt: null, expiresAt: null });
  assert.equal(copy.durationSeconds, 4);
  assert.deepEqual(new Uint8Array(await (await store.getFile(copy.id, C.File.video)).arrayBuffer()), bytes);
  assert.deepEqual(requests, []);
  await publisher.publish(copy);

  const published = C.recordingFromJSON((await store.getRow(copy.id)).json);
  assert.equal(published.upload, "uploaded");
  assert.equal(published.shareID, ownerShare);
  assert.equal(published.recordingOwnerUID, uid);
  assert.deepEqual(await store.getRow(legacy.id), original);
  assert.deepEqual(new Uint8Array(await (await store.getFile(legacy.id, C.File.video)).arrayBuffer()), bytes);
  assert.ok(requests.every(({ url, method }) => !decodeURIComponent(url.href).includes(legacy.shareID) && method !== "DELETE"));

  const manifestWrites = requests.filter(({ url }) => url.searchParams.get("name") === `reel/v/${ownerShare}/meta.json`);
  assert.equal(manifestWrites.length, 2);
  const manifests = manifestWrites.map(({ headers, body }) => {
    assert.equal(headers.Authorization, "Firebase synthetic-token");
    const boundary = headers["Content-Type"].split("boundary=")[1];
    const [, metadata, manifest] = new TextDecoder().decode(body).split(`--${boundary}`);
    assert.deepEqual(JSON.parse(metadata.split("\r\n\r\n")[1]).metadata, { ownerUid: uid, recordingNonce: nonce });
    return JSON.parse(manifest.split("\r\n\r\n")[1]);
  });
  assert.deepEqual(manifests.map(({ id, status, title }) => [id, status, title]),
    [[ownerShare, "processing", copy.title], [ownerShare, "ready", copy.title]]);
  for (const manifest of manifests) {
    assert.ok(!JSON.stringify(manifest).includes(uid));
    assert.ok(!JSON.stringify(manifest).includes(nonce));
    assert.equal(Object.hasOwn(manifest, "localImport"), false);
  }
  assert.deepEqual(manifests[1].playback, { hls: false, mp4: true });

  const video = requests.find(({ url }) => url.searchParams.get("name") === `reel/v/${ownerShare}/video.mp4`);
  assert.ok(video);
  assert.deepEqual(JSON.parse(video.body).metadata, { ownerUid: uid, recordingNonce: nonce });
  const chunk = requests.find(({ url }) => url.pathname === "/resume-copy");
  assert.ok(chunk);
  assert.deepEqual(chunk.body, bytes);
  assert.equal(chunk.headers["X-Goog-Upload-Command"], "upload, finalize");
  assert.ok(requests.indexOf(chunk) < requests.indexOf(manifestWrites[1]));

  const room = requests.find(({ url }) => url.searchParams.get("documentId") === ownerShare);
  assert.ok(room);
  const roomFields = JSON.parse(room.body).fields;
  assert.equal(roomFields.ownerUid.stringValue, uid);
  assert.equal(roomFields.recordingNonce.stringValue, nonce);
  const entry = requests.find(({ url }) => url.pathname.endsWith(`/users/${uid}/recordings/${ownerShare}`));
  assert.ok(entry);
  assert.equal(JSON.parse(entry.body).fields.id.stringValue, ownerShare);
});

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

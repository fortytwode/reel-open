// Exercise the real publisher with deterministic storage and auth scheduling.
// No browser, emulator, or network writes are involved.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate as nextTurn } from "node:timers/promises";
import * as C from "../../web/reel/core.js";

const publisherURL = new URL("../../web/reel/publisher.js", import.meta.url);
const storeStub = `
export async function getRow() { return {}; }
export async function getFile(_id, file) { return new Blob([file.startsWith("transcript") ? "{}" : "video"]); }
`;
let source = await readFile(publisherURL, "utf8");
source = source.replace(/from "(\.\/[^"\n]+)"/g, (_match, relative) => {
  const target = relative.startsWith("./store.js")
    ? "data:text/javascript;base64," + Buffer.from(storeStub).toString("base64")
    : new URL(relative, publisherURL).href;
  return "from " + JSON.stringify(target);
});
const { Publisher } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const oldKey = "a".repeat(32), oldExpiry = new Date("2030-01-01T00:00:00Z");
  let current = C.newRecording({ id: "local", createdAt: new Date(), upload: "uploaded" });
  current.captureState = "complete"; current.transcriptStatus = "ready"; current.playback.mp4 = true;
  current.access = { key: oldKey, passwordSalt: "b".repeat(32), expiresAt: oldExpiry };
  const sessionEntered = deferred(), sessionContinue = deferred(), oldUploadContinue = deferred();
  const objects = new Map(), writes = [];
  const location = (key, file) => `${key || "open"}/${file}`;
  const files = [C.File.video, C.File.meta, C.File.transcriptJSON, C.File.transcriptText];
  for (const file of files) objects.set(location(oldKey, file), { expiresAt: oldExpiry });
  let sessionCalls = 0, oldUploadPaused = false;
  const account = { uid: "owner", email: "owner@rocketshiphq.com" };
  const publisher = new Publisher({
    library: { get: () => structuredClone(current), update: async (r) => { current = structuredClone(r); }, setProgress() {} },
    auth: { session: async () => {
      if (++sessionCalls === 1) { sessionEntered.resolve(); await sessionContinue.promise; }
      return account;
    } }, settings: () => ({ uploadMP4: true }), ui: { toast() {} },
  });
  async function upload(_shareID, file, _bytes, { key, options }) {
    // The vulnerable implementation starts refreshing the old location while
    // updateAccess is waiting for auth. Hold that upload until access has moved.
    if (!oldUploadPaused && key === oldKey && file === C.File.meta && sessionCalls > 1) {
      oldUploadPaused = true;
      await oldUploadContinue.promise;
    }
    writes.push({ file, key, expiresAt: options?.expiresAt });
    objects.set(location(key, file), { expiresAt: options?.expiresAt });
  }
  publisher.storage = () => ({
    upload, uploadLarge: upload,
    setExpiry: async (expiresAt, _shareID, file, key) => {
      if (objects.has(location(key, file))) objects.set(location(key, file), { expiresAt });
    },
    delete: async (_shareID, deleted, key) => { for (const file of deleted) objects.delete(location(key, file)); },
  });
  publisher.firestore = () => ({ ownsRoom: async () => true, ensureRoom: async () => {}, upsertLibraryEntry: async () => {}, setExpiry: async () => {}, migrate: async () => {} });
  publisher.remoteFiles = async () => files;
  return { publisher, oldKey, objects, writes, location, current: () => current, sessionEntered, sessionContinue, oldUploadContinue };
}

async function overlap(f, password, expiry) {
  const access = f.publisher.updateAccess(f.current(), password, expiry);
  await f.sessionEntered.promise;
  const refresh = f.publisher.refreshTranscript("local", "owner");
  // Let the background refresh reach any unguarded upload before resuming auth.
  await nextTurn();
  f.sessionContinue.resolve();
  // Let access mutate its location/expiry before the old-location upload resumes.
  await nextTurn();
  f.oldUploadContinue.resolve();
  await Promise.all([access, refresh]);
}

test("transcript refresh cannot reuse an old-location upload during password removal", async () => {
  const f = fixture();
  await overlap(f, { remove: true }, null);
  assert.equal(f.current().upload, "uploaded");
  assert.equal(f.current().access.key, null);
  assert.equal(f.current().playback.mp4, true);
  for (const file of [C.File.video, C.File.transcriptJSON, C.File.transcriptText]) {
    assert.ok(f.objects.has(f.location(null, file)), `${file} exists at the new location`);
    assert.equal(f.objects.has(f.location(f.oldKey, file)), false, `${file} removed from old location`);
  }
});

test("transcript refresh cannot restore an older expiry after sharing expiry changes", async () => {
  const f = fixture(), nextExpiry = new Date("2029-01-01T00:00:00Z");
  await overlap(f, { keep: true }, nextExpiry);
  assert.equal(f.current().upload, "uploaded");
  for (const file of [C.File.video, C.File.meta, C.File.transcriptJSON, C.File.transcriptText]) {
    assert.equal(f.objects.get(f.location(f.oldKey, file))?.expiresAt?.toISOString(), nextExpiry.toISOString(), `${file} retains the new expiry`);
  }
});

function deletionFixture() {
  let current = C.newRecording({ id: "local", createdAt: new Date(), upload: "uploaded" });
  current.captureState = "complete"; current.transcriptStatus = "ready"; current.playback.mp4 = true;
  const objects = new Set([C.File.video, C.File.meta, C.File.transcriptJSON, C.File.transcriptText]);
  const account = { uid: "owner", email: "owner@rocketshiphq.com" };
  const publisher = new Publisher({
    library: { get: () => current && structuredClone(current), update: async (r) => { current = structuredClone(r); }, remove: async () => { current = null; }, setProgress() {} },
    auth: { session: async () => account }, settings: () => ({ uploadMP4: true }), ui: { toast() {} },
  });
  const storage = {
    upload: async (_share, file) => { objects.add(file); },
    uploadLarge: async (...args) => storage.upload(...args),
    setExpiry: async () => {},
    delete: async (_share, files) => { for (const file of files) objects.delete(file); },
  };
  const firestore = { ownsRoom: async () => true, ensureRoom: async () => {}, upsertLibraryEntry: async () => {}, deleteLibraryEntry: async () => {}, deleteRoom: async () => {}, setExpiry: async () => {}, migrate: async () => {} };
  publisher.storage = () => storage; publisher.firestore = () => firestore;
  publisher.remoteFiles = async () => [...C.FIXED_FILES];
  return { publisher, storage, firestore, objects, current: () => current };
}

test("deletion waits for an active transcript upload before removing every remote object", async () => {
  const f = deletionFixture(), uploadStarted = deferred(), uploadContinue = deferred();
  const originalUpload = f.storage.upload;
  f.storage.upload = async (...args) => { uploadStarted.resolve(); await uploadContinue.promise; await originalUpload(...args); };
  const refresh = f.publisher.refreshTranscript("local", "owner");
  await uploadStarted.promise;
  const deletion = f.publisher.delete(f.current());
  await nextTurn();
  uploadContinue.resolve();
  const outcomes = await Promise.allSettled([refresh, deletion]);
  assert.deepEqual(outcomes.map((outcome) => outcome.status), ["fulfilled", "fulfilled"]);
  assert.equal(outcomes[1].value, true);
  assert.equal(f.current(), null);
  assert.equal(f.objects.size, 0, "no upload recreates an object after deletion");
});

test("a transcript ownership check completing after deletion cannot recreate the share", async () => {
  const f = deletionFixture(), ownershipStarted = deferred(), ownershipContinue = deferred();
  f.firestore.ownsRoom = async () => { ownershipStarted.resolve(); await ownershipContinue.promise; return true; };
  const refresh = f.publisher.refreshTranscript("local", "owner");
  await ownershipStarted.promise;
  assert.equal(await f.publisher.delete(f.current()), true);
  ownershipContinue.resolve();
  assert.equal(await refresh, false);
  assert.equal(f.current(), null);
  assert.equal(f.objects.size, 0);
});

test("a transcript refresh cannot start while remote deletion is in progress", async () => {
  const f = deletionFixture(), deleteStarted = deferred(), deleteContinue = deferred();
  const originalDelete = f.storage.delete;
  f.storage.delete = async (...args) => { await originalDelete(...args); deleteStarted.resolve(); await deleteContinue.promise; };
  const deletion = f.publisher.delete(f.current());
  await deleteStarted.promise;
  const refresh = f.publisher.refreshTranscript("local", "owner");
  await nextTurn();
  deleteContinue.resolve();
  const [refreshed, deleted] = await Promise.all([refresh, deletion]);
  assert.equal(refreshed, false);
  assert.equal(deleted, true);
  assert.equal(f.current(), null);
  assert.equal(f.objects.size, 0, "the deleted share stays deleted");
});

test("deletion blocks new manual publication and sharing changes", async () => {
  const f = deletionFixture(), deleteStarted = deferred(), deleteContinue = deferred();
  const originalDelete = f.storage.delete;
  f.storage.delete = async (...args) => { await originalDelete(...args); deleteStarted.resolve(); await deleteContinue.promise; };
  const deletion = f.publisher.delete(f.current());
  await deleteStarted.promise;
  assert.equal(await f.publisher.publish(f.current()), false);
  await assert.rejects(f.publisher.updateAccess(f.current(), { keep: true }, null), /being deleted/);
  deleteContinue.resolve();
  assert.equal(await deletion, true);
  assert.equal(f.objects.size, 0);
});

test("deletion lets an existing password migration finish before removing its objects", async () => {
  const f = deletionFixture(), sessionStarted = deferred(), sessionContinue = deferred();
  f.current().access = { key: "a".repeat(32), passwordSalt: "b".repeat(32), expiresAt: null };
  const originalSession = f.publisher.auth.session;
  let calls = 0;
  f.publisher.auth.session = async () => { if (++calls === 1) { sessionStarted.resolve(); await sessionContinue.promise; } return originalSession(); };
  const access = f.publisher.updateAccess(f.current(), { remove: true }, null);
  await sessionStarted.promise;
  const deletion = f.publisher.delete(f.current());
  sessionContinue.resolve();
  await access;
  assert.equal(await deletion, true);
  assert.equal(f.current(), null);
  assert.equal(f.objects.size, 0);
});

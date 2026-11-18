import { test } from "node:test";
import assert from "node:assert/strict";
import { FirestoreClient } from "../../web/reel/cloud.js";
import { Publisher } from "../../web/reel/publisher.js";

const id = "abcdefghij0123456789";
const session = { uid: "owner", getIdToken: async () => "test-token" };
const recording = { id: "local-id", shareID: id, title: "Test recording", createdAt: new Date(0), durationSeconds: 3.5,
  access: { key: "secret-key", passwordSalt: "secret-salt" }, upload: "uploaded" };

test("online library request includes safe metadata and the authenticated owner path", async () => {
  const client = new FirestoreClient(session);
  let request;
  const old = globalThis.fetch;
  globalThis.fetch = async (url, options) => { request = { url, ...options }; return new Response("{}", { status: 200 }); };
  try {
    await client.upsertLibraryEntry(recording);
    assert.match(request.url, new RegExp(`/users/owner/recordings/${id}$`));
    assert.equal(request.method, "PATCH");
    assert.equal(request.headers.Authorization, "Bearer test-token");
    assert.deepEqual(Object.keys(JSON.parse(request.body).fields).sort(), ["createdAt", "durationSeconds", "id", "status", "title"]);
    assert.ok(!request.body.includes("secret-"));
    await client.deleteLibraryEntry(id);
    assert.equal(request.method, "DELETE");
  } finally { globalThis.fetch = old; }
});

test("failed online library writes and deletes throw a retryable visible error", async () => {
  const client = new FirestoreClient(session);
  const old = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}", { status: 503 });
  try {
    await assert.rejects(client.upsertLibraryEntry(recording), /online library.*503.*Retry/);
    await assert.rejects(client.deleteLibraryEntry(id), /online library.*503.*Retry/);
  } finally { globalThis.fetch = old; }
});

test("backfill indexes only uploaded entries owned by the current account and surfaces errors", async () => {
  const entries = [recording, { ...recording, id: "other", shareID: "other0123456789012345" }, { ...recording, id: "local", upload: "localOnly" }];
  const saved = [], errors = [];
  const publisher = new Publisher({ library: { list: () => entries }, auth: { session: async () => session }, settings: () => ({}), ui: { toast: (s) => errors.push(s) } });
  publisher.firestore = () => ({ ownsRoom: async (room) => room.startsWith(id), upsertLibraryEntry: async (r) => saved.push(r.id) });
  await publisher.syncCloudLibrary();
  assert.deepEqual(saved, ["local-id"]);
  publisher.firestore = () => ({ ownsRoom: async () => { throw new Error("offline"); } });
  await publisher.syncCloudLibrary();
  assert.deepEqual(errors, ["Online library sync failed. Reload the recorder to retry. offline"]);
});

// An auth switch while a refresh is pending must never pair the old UID with the new token.
test("session token remains bound to the captured Firebase account", async () => {
  const { sessionSnapshot } = await import("../../web/reel/firebase.js");
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let current = { uid: "owner-a", email: "a@example.com", getIdToken: async () => { await gate; return "token-a"; } };
  const snapshot = sessionSnapshot(current);
  const pending = snapshot.getIdToken();
  current = { uid: "owner-b", getIdToken: async () => "token-b" };
  release();
  assert.equal(snapshot.uid, "owner-a");
  assert.equal(await pending, "token-a");
  assert.equal(sessionSnapshot(current).uid, "owner-b");
});

test("password room migration preserves only a valid owner shared title with a partial patch", async (t) => {
  const client = new FirestoreClient(session);
  const oldRoom = id, newRoom = `${id}-0123456789abcdef0123456789abcdef`;
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, ...options });
    if (options.method === "GET" && url.endsWith(`/videos/${oldRoom}`)) return new Response(JSON.stringify({ fields: { ownerUid: { stringValue: "owner" }, views: { integerValue: "4" }, titleOverride: { stringValue: "Web shared title" }, secret: { stringValue: "do not copy" } } }));
    return new Response("{}");
  });
  await client.migrate(oldRoom, newRoom, new Date(0), null);
  const patch = calls.find((r) => r.url.includes("updateMask.fieldPaths=titleOverride"));
  assert.ok(patch); assert.equal(patch.method, "PATCH");
  assert.deepEqual(JSON.parse(patch.body).fields, { titleOverride: { stringValue: "Web shared title" } });
  assert.ok(calls.findIndex((r) => r === patch) < calls.findIndex((r) => r.method === "DELETE"));
});

test("invalid or nonowned title overrides never migrate", async (t) => {
  const client = new FirestoreClient(session);
  for (const [ownerUid, title] of [["owner", " "], ["owner", "x".repeat(501)], ["different", "Private title"]]) {
    const calls = [];
    t.mock.method(globalThis, "fetch", async (url, options) => {
      calls.push({ url, ...options });
      if (options.method === "GET" && url.endsWith(`/videos/${id}`)) return new Response(JSON.stringify({ fields: { ownerUid: { stringValue: ownerUid }, views: { integerValue: "4" }, titleOverride: { stringValue: title } } }));
      return new Response("{}");
    });
    await client.migrate(id, `${id}-0123456789abcdef0123456789abcdef`, new Date(0), null);
    assert.ok(!calls.some((r) => r.url.includes("updateMask.fieldPaths=titleOverride")));
    t.mock.restoreAll();
  }
});

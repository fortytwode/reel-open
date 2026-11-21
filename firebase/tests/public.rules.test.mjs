import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { assertFails, assertSucceeds, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import { getBytes, ref, uploadString } from "firebase/storage";
import { renderedRules } from "./organization-rules.mjs";

const publicConfig = {
  accountAccess: "public", allowedEmailDomain: "", googleClientID: "", googleDesktopClientId: "",
  deliveryServiceURL: "", speechServiceURL: "",
};
let env;
before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-reel-public",
    firestore: { rules: renderedRules("firestore.rules", publicConfig) },
    storage: { rules: renderedRules("storage.rules", publicConfig) },
  });
});
after(async () => { await env?.cleanup(); });

function user(uid, email, options = {}) {
  return env.authenticatedContext(uid, {
    email, email_verified: options.verified ?? true,
    firebase: { sign_in_provider: options.provider ?? "google.com" },
  });
}

const nonce = "0123456789abcdef0123456789abcdef";
function recording(uid) {
  const hash = createHash("sha256").update(`reel-owner-v2:${uid}:${nonce}`).digest("hex");
  return "r2" + hash.slice(0, 38);
}
const room = (ctx, id) => doc(ctx.firestore(), "videos", id);
const entry = (ctx, uid, id) => doc(ctx.firestore(), "users", uid, "recordings", id);
const file = (ctx, id, name = "meta.json") => ref(ctx.storage(), `reel/v/${id}/${name}`);
const writeRoom = (ctx, id, uid) => setDoc(room(ctx, id), {
  ownerUid: uid, views: 0, createdAt: serverTimestamp(), recordingNonce: nonce,
});
const upload = (ctx, id, uid, name) => uploadString(file(ctx, id, name), "test recording", "raw", {
  customMetadata: { ownerUid: uid, recordingNonce: nonce },
});

test("Google customers own separate libraries and can explicitly share recordings", async () => {
  const alice = user("alice", "alice@gmail.com");
  const bob = user("bob", "bob@outside.example");
  const viewer = env.unauthenticatedContext();
  const aliceRecording = recording("alice");
  const bobRecording = recording("bob");

  await assertSucceeds(writeRoom(alice, aliceRecording, "alice"));
  await assertSucceeds(writeRoom(bob, bobRecording, "bob"));
  await assertSucceeds(upload(alice, aliceRecording, "alice"));
  await assertSucceeds(upload(bob, bobRecording, "bob"));
  await assertSucceeds(setDoc(entry(alice, "alice", aliceRecording), {
    id: aliceRecording, title: "Private library item", createdAt: serverTimestamp(), durationSeconds: 10, status: "ready",
  }));
  await assertSucceeds(getDoc(entry(alice, "alice", aliceRecording)));
  await assertFails(getDoc(entry(bob, "alice", aliceRecording)));
  await assertFails(getDoc(entry(viewer, "alice", aliceRecording)));
  await assertFails(writeRoom(bob, aliceRecording, "bob"));
  await assertFails(upload(bob, aliceRecording, "bob", "video.mp4"));
  assert.ok((await assertSucceeds(getDoc(room(viewer, aliceRecording)))).exists());
  assert.ok((await assertSucceeds(getBytes(file(viewer, aliceRecording)))).byteLength);
});

test("public writes reject non-Google accounts, unverified accounts and legacy IDs", async () => {
  for (const [uid, options] of [["password", { provider: "password" }], ["unverified", { verified: false }]]) {
    const customer = user(uid, `${uid}@outside.example`, options);
    await assertFails(writeRoom(customer, recording(uid), uid));
    await assertFails(upload(customer, recording(uid), uid));
  }
  const customer = user("legacy", "legacy@outside.example");
  const legacyId = "abcdefghij0123456789";
  await assertFails(setDoc(room(customer, legacyId), { ownerUid: "legacy", views: 0, createdAt: serverTimestamp() }));
  await assertFails(uploadString(file(customer, legacyId), "test", "raw", { customMetadata: { ownerUid: "legacy" } }));
});

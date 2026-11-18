// Firestore rules tests (rules for database "reel"; the emulator tests them
// against its default database). Run through `npm test` (see package.json).
import assert from "node:assert/strict";
import { test, before, after, beforeEach, describe } from "node:test";
import { renderedRules } from "./organization-rules.mjs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { setLogLevel, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, collection, serverTimestamp, increment, Timestamp } from "firebase/firestore";

const RULES = renderedRules("firestore.rules");
const ROOM = "abcdefghij0123456789";
const PROT = `${ROOM}-0123456789abcdef0123456789abcdef`;
setLogLevel("silent");
let env;

before(async () => {
  env = await initializeTestEnvironment({ projectId: "demo-reel", firestore: { rules: RULES } });
});
after(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); });

const dbFor = (uid, email = `${uid}@northwind.example`, verified = true) => env.authenticatedContext(uid, { email, email_verified: verified }).firestore();
const owner = () => dbFor("owner");
const member = () => dbFor("bob");
const anon = () => env.unauthenticatedContext().firestore();
const outsider = () => dbFor("eve", "eve@gmail.com");
const unverified = () => dbFor("mal", "mal@northwind.example", false);

const past = () => Timestamp.fromMillis(Date.now() - 60_000);
const future = () => Timestamp.fromMillis(Date.now() + 3_600_000);

async function seedRoom(room = ROOM, extra = {}) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "videos", room), { ownerUid: "owner", createdAt: Timestamp.now(), views: 0, ...extra });
  });
}
async function seedDoc(path, data) {
  await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), path), data); });
}
const newVideo = (over = {}) => ({ ownerUid: "owner", createdAt: serverTimestamp(), views: 0, ...over });

describe("private owner recording library", () => {
  const entry = (over = {}) => ({ id: ROOM, title: "My recording", createdAt: Timestamp.now(), durationSeconds: 5.2, status: "ready", ...over });
  const ref = (db, uid = "owner", id = ROOM) => doc(db, "users", uid, "recordings", id);
  const col = (db, uid = "owner") => collection(db, "users", uid, "recordings");
  test("owner can create, list, rename and delete private entries", async () => {
    await assertSucceeds(setDoc(ref(owner()), entry()));
    await assertSucceeds(getDoc(ref(owner())));
    await assertSucceeds(getDocs(col(owner())));
    await assertSucceeds(updateDoc(ref(owner()), { title: "Renamed" }));
    await assertSucceeds(deleteDoc(ref(owner())));
  });
  test("anonymous, other member, outsider and unverified cannot read or list another user's library", async () => {
    await seedDoc(`users/owner/recordings/${ROOM}`, entry());
    for (const db of [anon(), member(), outsider(), unverified()]) {
      await assertFails(getDoc(ref(db)));
      await assertFails(getDocs(col(db)));
    }
    await assertFails(getDocs(collection(owner(), "users")));
  });
  test("cannot write or delete another user's entries, including with valid metadata", async () => {
    await seedDoc(`users/owner/recordings/${ROOM}`, entry());
    for (const db of [anon(), member(), outsider(), unverified()]) {
      await assertFails(setDoc(ref(db), entry()));
      await assertFails(deleteDoc(ref(db)));
    }
    await assertFails(setDoc(ref(outsider(), "eve"), entry()));
    await assertFails(setDoc(ref(unverified(), "mal"), entry()));
  });
  test("strict schema rejects keys, salts, spoofed IDs and invalid metadata", async () => {
    for (const over of [{ key: "secret" }, { password: "secret" }, { passwordSalt: "secret" },
      { id: "different0123456789" }, { title: "" }, { title: "x".repeat(501) }, { durationSeconds: -1 },
      { durationSeconds: "5" }, { status: "unknown" }, { createdAt: "today" }]) {
      await assertFails(setDoc(ref(owner()), entry(over)));
    }
    await assertFails(setDoc(ref(owner(), "owner", "short"), entry({ id: "short" })));
    const missing = entry(); delete missing.title;
    await assertFails(setDoc(ref(owner()), missing));
  });
});

describe("private library organization", () => {
  const prefs = (db, uid = "owner", id = ROOM) => doc(db, "users", uid, "libraryPreferences", id);
  const folder = (db, uid = "owner", id = "project-folder") => doc(db, "users", uid, "libraryFolders", id);
  const preference = (over = {}) => ({ pinned: false, archived: false, folderId: null, updatedAt: serverTimestamp(), ...over });
  beforeEach(async () => {
    await seedDoc(`users/owner/recordings/${ROOM}`, { id: ROOM, title: "Video", createdAt: Timestamp.now(), durationSeconds: 5, status: "ready" });
  });
  test("owner organizes separately from publisher entries and can clear preferences", async () => {
    await assertSucceeds(setDoc(folder(owner()), { name: "Project", updatedAt: serverTimestamp() }));
    await assertSucceeds(setDoc(prefs(owner()), preference({ pinned: true, folderId: "project-folder" })));
    await assertSucceeds(updateDoc(prefs(owner()), { archived: true, updatedAt: serverTimestamp() }));
    await assertSucceeds(getDocs(collection(owner(), "users", "owner", "libraryFolders")));
    await assertSucceeds(getDocs(collection(owner(), "users", "owner", "libraryPreferences")));
    await assertSucceeds(deleteDoc(prefs(owner())));
  });
  test("organization stays owner-only for reads, lists and writes", async () => {
    await seedDoc(`users/owner/libraryFolders/project-folder`, { name: "Private", updatedAt: Timestamp.now() });
    await seedDoc(`users/owner/libraryPreferences/${ROOM}`, { pinned: true, archived: false, folderId: null, updatedAt: Timestamp.now() });
    for (const db of [anon(), member(), outsider(), unverified()]) {
      await assertFails(getDoc(prefs(db)));
      await assertFails(getDoc(folder(db)));
      await assertFails(getDocs(collection(db, "users", "owner", "libraryPreferences")));
      await assertFails(getDocs(collection(db, "users", "owner", "libraryFolders")));
      await assertFails(setDoc(prefs(db), preference()));
      await assertFails(setDoc(folder(db), { name: "Other", updatedAt: serverTimestamp() }));
      await assertFails(deleteDoc(prefs(db)));
    }
    await assertFails(setDoc(folder(outsider(), "eve"), { name: "No", updatedAt: serverTimestamp() }));
    await assertFails(setDoc(folder(unverified(), "mal"), { name: "No", updatedAt: serverTimestamp() }));
  });
  test("preferences require an owned recording, valid folder and strict schema", async () => {
    for (const over of [{ pinned: 1 }, { archived: "yes" }, { folderId: "missing-folder" }, { folderId: 3 }, { secret: "x" }, { updatedAt: Timestamp.fromMillis(1) }]) {
      await assertFails(setDoc(prefs(owner()), preference(over)));
    }
    await assertFails(setDoc(prefs(owner(), "owner", "short"), preference()));
    await assertFails(setDoc(prefs(owner(), "owner", "missingrecording001"), preference()));
    const missing = preference(); delete missing.archived;
    await assertFails(setDoc(prefs(owner()), missing));
    await seedDoc("users/bob/libraryFolders/other-folder", { name: "Other", updatedAt: Timestamp.now() });
    await assertFails(setDoc(prefs(owner()), preference({ folderId: "other-folder" })));
  });
  test("folders validate names, IDs, timestamps and unknown fields", async () => {
    for (const name of ["", " ", "x".repeat(81), 5]) await assertFails(setDoc(folder(owner()), { name, updatedAt: serverTimestamp() }));
    await assertFails(setDoc(folder(owner()), { name: "Valid", updatedAt: "now" }));
    await assertFails(setDoc(folder(owner()), { name: "Valid", updatedAt: serverTimestamp(), ownerUid: "owner" }));
    await assertFails(setDoc(folder(owner(), "owner", "bad id"), { name: "Valid", updatedAt: serverTimestamp() }));
  });
});

describe("owner shared title overrides", () => {
  test("optional titles are owner-only, bounded and preserve expiry/view behavior", async () => {
    await seedRoom();
    const ref = (db) => doc(db, "videos", ROOM);
    await assertSucceeds(updateDoc(ref(owner()), { titleOverride: "<img onerror=alert(1)> Shared title" }));
    for (const db of [anon(), member(), outsider(), unverified()]) await assertFails(updateDoc(ref(db), { titleOverride: "Other title" }));
    for (const titleOverride of ["", " ", "x".repeat(501), 3, null]) await assertFails(updateDoc(ref(owner()), { titleOverride }));
    await assertSucceeds(updateDoc(ref(anon()), { views: increment(1) }));
    await assertSucceeds(updateDoc(ref(owner()), { expiresAt: future() }));
    assert.equal((await getDoc(ref(owner()))).data().titleOverride, "<img onerror=alert(1)> Shared title");
    await assertSucceeds(updateDoc(ref(owner()), { expiresAt: past() }));
    await assertFails(updateDoc(ref(owner()), { titleOverride: "Expired title" }));
  });
  test("private override survives publisher replacement and organization updates", async () => {
    const recording = doc(owner(), "users", "owner", "recordings", ROOM);
    const pref = doc(owner(), "users", "owner", "libraryPreferences", ROOM);
    const entry = { id: ROOM, title: "Source title", createdAt: Timestamp.now(), durationSeconds: 5, status: "ready" };
    await assertSucceeds(setDoc(recording, entry));
    const data = { pinned: true, archived: false, folderId: null, updatedAt: serverTimestamp(), titleOverride: "Web title" };
    await assertSucceeds(setDoc(pref, data));
    await assertSucceeds(setDoc(recording, { ...entry, title: "Publisher updated source title" }));
    await assertSucceeds(updateDoc(pref, { archived: true, updatedAt: serverTimestamp() }));
    assert.equal((await getDoc(pref)).data().titleOverride, "Web title");
    for (const titleOverride of ["", " ", "x".repeat(501), null, 10]) await assertFails(setDoc(pref, { ...data, titleOverride }));
    for (const db of [anon(), member(), outsider(), unverified()]) await assertFails(updateDoc(doc(db, "users", "owner", "libraryPreferences", ROOM), { titleOverride: "Other" }));
  });
});

describe("videos/{room}", () => {
  test("create by owner with views 0", async () => {
    await assertSucceeds(setDoc(doc(owner(), "videos", ROOM), newVideo()));
    await assertSucceeds(setDoc(doc(owner(), "videos", PROT), newVideo()));
  });
  test("create with expiresAt timestamp or null", async () => {
    await assertSucceeds(setDoc(doc(owner(), "videos", ROOM), newVideo({ expiresAt: future() })));
    await assertSucceeds(setDoc(doc(owner(), "videos", PROT), newVideo({ expiresAt: null })));
  });
  test("create denied: non-domain, unverified, unauth", async () => {
    await assertFails(setDoc(doc(outsider(), "videos", ROOM), newVideo({ ownerUid: "eve" })));
    await assertFails(setDoc(doc(unverified(), "videos", ROOM), newVideo({ ownerUid: "mal" })));
    await assertFails(setDoc(doc(anon(), "videos", ROOM), newVideo()));
  });
  test("create denied: ownerUid spoof, extra fields, bad views", async () => {
    await assertFails(setDoc(doc(member(), "videos", ROOM), newVideo({ ownerUid: "owner" })));
    await assertFails(setDoc(doc(owner(), "videos", ROOM), newVideo({ extra: 1 })));
    await assertFails(setDoc(doc(owner(), "videos", ROOM), newVideo({ views: -1 })));
    await assertFails(setDoc(doc(owner(), "videos", ROOM), newVideo({ views: "0" })));
    await assertFails(setDoc(doc(owner(), "videos", ROOM), newVideo({ expiresAt: "soon" })));
  });
  test("room id validation", async () => {
    for (const bad of ["short", "ABCDEFGHIJ0123456789", `${ROOM}-0123`, `${ROOM}-0123456789ABCDEF0123456789abcdef`, `${ROOM}-`, `${ROOM}-0123456789abcdef0123456789abcdef-x`]) {
      await assertFails(setDoc(doc(owner(), "videos", bad), newVideo()));
    }
  });
  test("get allowed while not expired (anyone), list denied", async () => {
    await seedRoom();
    await assertSucceeds(getDoc(doc(anon(), "videos", ROOM)));
    await assertFails(getDocs(collection(anon(), "videos")));
    await assertFails(getDocs(collection(owner(), "videos")));
  });
  test("get denied after expiresAt, except owner", async () => {
    await seedRoom(ROOM, { expiresAt: past() });
    await assertFails(getDoc(doc(anon(), "videos", ROOM)));
    await assertFails(getDoc(doc(member(), "videos", ROOM)));
    await assertSucceeds(getDoc(doc(owner(), "videos", ROOM)));
  });
  test("get of a missing doc by a stranger is denied (viewer ignores it)", async () => {
    await assertFails(getDoc(doc(anon(), "videos", ROOM)));
  });
  test("anonymous views +1 allowed", async () => {
    await seedRoom();
    await assertSucceeds(updateDoc(doc(anon(), "videos", ROOM), { views: increment(1) }));
  });
  test("anonymous views +2 / -1 / set denied", async () => {
    await seedRoom();
    await assertFails(updateDoc(doc(anon(), "videos", ROOM), { views: increment(2) }));
    await assertFails(updateDoc(doc(anon(), "videos", ROOM), { views: increment(-1) }));
    await assertFails(updateDoc(doc(anon(), "videos", ROOM), { views: 7 }));
  });
  test("anonymous changing other fields denied (even with views +1)", async () => {
    await seedRoom();
    await assertFails(updateDoc(doc(anon(), "videos", ROOM), { ownerUid: "eve" }));
    await assertFails(updateDoc(doc(anon(), "videos", ROOM), { expiresAt: future() }));
    await assertFails(updateDoc(doc(anon(), "videos", ROOM), { views: increment(1), expiresAt: future() }));
    await assertFails(updateDoc(doc(anon(), "videos", ROOM), { views: increment(1), extra: 1 }));
  });
  test("views +1 after expiry denied", async () => {
    await seedRoom(ROOM, { expiresAt: past() });
    await assertFails(updateDoc(doc(anon(), "videos", ROOM), { views: increment(1) }));
  });
  test("owner can set / clear expiresAt", async () => {
    await seedRoom();
    await assertSucceeds(updateDoc(doc(owner(), "videos", ROOM), { expiresAt: future() }));
    await assertSucceeds(updateDoc(doc(owner(), "videos", ROOM), { expiresAt: null }));
  });
  test("other domain user cannot set expiresAt, owner cannot change ownerUid", async () => {
    await seedRoom();
    await assertFails(updateDoc(doc(member(), "videos", ROOM), { expiresAt: future() }));
    await assertFails(updateDoc(doc(owner(), "videos", ROOM), { ownerUid: "bob" }));
  });
  test("delete only by owner", async () => {
    await seedRoom();
    await assertFails(deleteDoc(doc(anon(), "videos", ROOM)));
    await assertFails(deleteDoc(doc(member(), "videos", ROOM)));
    await assertSucceeds(deleteDoc(doc(owner(), "videos", ROOM)));
  });
});

describe("videos/{room}/reactions", () => {
  const col = (db, room = ROOM) => collection(db, "videos", room, "reactions");
  const reaction = (over = {}) => ({ emoji: "🔥", t: 12.3, createdAt: serverTimestamp(), ...over });

  test("anonymous create with valid emoji/t/serverTimestamp", async () => {
    await seedRoom();
    for (const emoji of ["👍", "❤️", "😂", "😮", "🎉", "👏", "🔥", "🙌"]) {
      await assertSucceeds(addDoc(col(anon()), reaction({ emoji })));
    }
    await assertSucceeds(addDoc(col(anon()), reaction({ t: 0 })));
    await assertSucceeds(addDoc(col(anon(), ROOM), reaction({ t: 86400 })));
  });
  test("works on protected room id", async () => {
    await seedRoom(PROT);
    await assertSucceeds(addDoc(col(anon(), PROT), reaction()));
  });
  test("denied: invalid emoji, extra fields, negative/too-large/non-number t", async () => {
    await seedRoom();
    await assertFails(addDoc(col(anon()), reaction({ emoji: "💩" })));
    await assertFails(addDoc(col(anon()), reaction({ emoji: "" })));
    await assertFails(addDoc(col(anon()), reaction({ extra: 1 })));
    await assertFails(addDoc(col(anon()), reaction({ t: -1 })));
    await assertFails(addDoc(col(anon()), reaction({ t: 86401 })));
    await assertFails(addDoc(col(anon()), reaction({ t: "3" })));
  });
  test("denied: client-supplied createdAt", async () => {
    await seedRoom();
    await assertFails(addDoc(col(anon()), reaction({ createdAt: Timestamp.fromMillis(Date.now() - 86_400_000) })));
  });
  test("denied: room does not exist, room expired", async () => {
    await assertFails(addDoc(col(anon()), reaction()));
    await seedRoom(ROOM, { expiresAt: past() });
    await assertFails(addDoc(col(anon()), reaction()));
  });
  test("read ok while open, denied after expiry (owner still reads)", async () => {
    await seedRoom();
    await seedDoc(`videos/${ROOM}/reactions/r1`, { emoji: "🔥", t: 1, createdAt: Timestamp.now() });
    await assertSucceeds(getDocs(col(anon())));
    await assertSucceeds(getDoc(doc(anon(), "videos", ROOM, "reactions", "r1")));
    await seedRoom(ROOM, { expiresAt: past() });
    await assertFails(getDocs(col(anon())));
    await assertFails(getDocs(col(member())));
    await assertSucceeds(getDocs(col(owner())));
  });
  test("update denied for everyone; delete only by owner", async () => {
    await seedRoom();
    await seedDoc(`videos/${ROOM}/reactions/r1`, { emoji: "🔥", t: 1, createdAt: Timestamp.now() });
    const r = (db) => doc(db, "videos", ROOM, "reactions", "r1");
    await assertFails(updateDoc(r(anon()), { t: 2 }));
    await assertFails(updateDoc(r(owner()), { t: 2 }));
    await assertFails(deleteDoc(r(anon())));
    await assertFails(deleteDoc(r(member())));
    await assertSucceeds(deleteDoc(r(owner())));
  });
  test("owner migration create with arbitrary createdAt ok; non-owner denied", async () => {
    await seedRoom();
    const old = Timestamp.fromMillis(Date.now() - 7 * 86_400_000);
    await assertSucceeds(addDoc(col(owner()), { emoji: "🔥", t: 5, createdAt: old }));
    await assertFails(addDoc(col(member()), { emoji: "🔥", t: 5, createdAt: old }));
    await assertFails(addDoc(col(anon()), { emoji: "🔥", t: 5, createdAt: old }));
  });
  test("owner migration still rejects extra fields", async () => {
    await seedRoom();
    await assertFails(addDoc(col(owner()), { emoji: "🔥", t: 5, createdAt: Timestamp.now(), extra: 1 }));
  });
});

describe("videos/{room}/comments", () => {
  const col = (db, room = ROOM) => collection(db, "videos", room, "comments");
  const comment = (uid, over = {}) => ({ text: "Nice!", t: 4.5, uid, name: "Bob", photoURL: null, createdAt: serverTimestamp(), ...over });

  test("unauth create denied", async () => {
    await seedRoom();
    await assertFails(addDoc(col(anon()), comment("x")));
  });
  test("non-domain and unverified create denied", async () => {
    await seedRoom();
    await assertFails(addDoc(col(outsider()), comment("eve")));
    await assertFails(addDoc(col(unverified()), comment("mal")));
  });
  test("domain user with uid == auth.uid ok (t number or null, photoURL string or null)", async () => {
    await seedRoom();
    await assertSucceeds(addDoc(col(member()), comment("bob")));
    await assertSucceeds(addDoc(col(member()), comment("bob", { t: null })));
    await assertSucceeds(addDoc(col(member()), comment("bob", { photoURL: "https://example.com/a.png" })));
  });
  test("works on protected room id", async () => {
    await seedRoom(PROT);
    await assertSucceeds(addDoc(col(member(), PROT), comment("bob")));
  });
  test("uid spoofing denied", async () => {
    await seedRoom();
    await assertFails(addDoc(col(member()), comment("owner")));
  });
  test("text validation: empty, >2000, 2000 ok, non-string", async () => {
    await seedRoom();
    await assertSucceeds(addDoc(col(member()), comment("bob", { text: "a".repeat(2000) })));
    await assertFails(addDoc(col(member()), comment("bob", { text: "a".repeat(2001) })));
    await assertFails(addDoc(col(member()), comment("bob", { text: "" })));
    await assertFails(addDoc(col(member()), comment("bob", { text: 5 })));
  });
  test("other field validation: name > 120, negative t, extra field, client createdAt", async () => {
    await seedRoom();
    await assertFails(addDoc(col(member()), comment("bob", { name: "n".repeat(121) })));
    await assertFails(addDoc(col(member()), comment("bob", { t: -1 })));
    await assertFails(addDoc(col(member()), comment("bob", { extra: 1 })));
    await assertFails(addDoc(col(member()), comment("bob", { createdAt: Timestamp.fromMillis(Date.now() - 86_400_000) })));
  });
  test("denied when room missing or expired", async () => {
    await assertFails(addDoc(col(member()), comment("bob")));
    await seedRoom(ROOM, { expiresAt: past() });
    await assertFails(addDoc(col(member()), comment("bob")));
  });
  test("migrated flag by non-owner denied", async () => {
    await seedRoom();
    const old = Timestamp.fromMillis(Date.now() - 86_400_000);
    await assertFails(addDoc(col(member()), comment("bob", { migrated: true, createdAt: old })));
    await assertFails(addDoc(col(member()), comment("bob", { migrated: true })));
  });
  test("owner migration ok (arbitrary createdAt, any uid, migrated true)", async () => {
    await seedRoom();
    const old = Timestamp.fromMillis(Date.now() - 86_400_000);
    await assertSucceeds(addDoc(col(owner()), comment("bob", { migrated: true, createdAt: old })));
  });
  test("read by anyone while open; denied after expiry except owner", async () => {
    await seedRoom();
    await seedDoc(`videos/${ROOM}/comments/c1`, { text: "hi", t: null, uid: "bob", name: "Bob", photoURL: null, createdAt: Timestamp.now() });
    await assertSucceeds(getDocs(col(anon())));
    await assertSucceeds(getDoc(doc(anon(), "videos", ROOM, "comments", "c1")));
    await seedRoom(ROOM, { expiresAt: past() });
    await assertFails(getDocs(col(anon())));
    await assertFails(getDocs(col(member())));
    await assertSucceeds(getDocs(col(owner())));
  });
  test("delete by author ok, by room owner ok, by others denied; update denied", async () => {
    await seedRoom();
    const data = { text: "hi", t: null, uid: "bob", name: "Bob", photoURL: null, createdAt: Timestamp.now() };
    const c = (db) => doc(db, "videos", ROOM, "comments", "c1");
    await seedDoc(`videos/${ROOM}/comments/c1`, data);
    await assertFails(deleteDoc(c(anon())));
    await assertFails(deleteDoc(c(dbFor("carol"))));
    await assertFails(deleteDoc(c(outsider())));
    await assertSucceeds(deleteDoc(c(member())));
    await seedDoc(`videos/${ROOM}/comments/c1`, data);
    await assertSucceeds(deleteDoc(c(owner())));
    await seedDoc(`videos/${ROOM}/comments/c1`, data);
    await assertFails(updateDoc(c(member()), { text: "edited" }));
    await assertFails(updateDoc(c(owner()), { text: "edited" }));
  });
});

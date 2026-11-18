// Storage rules tests. Run through `npm test` (firebase emulators:exec, project
// demo-reel). Needs Java 21+: JAVA_HOME=/opt/homebrew/opt/openjdk@21.
import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { renderedRules } from "./organization-rules.mjs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { ref, uploadString, getBytes, listAll, updateMetadata, deleteObject } from "firebase/storage";

const RULES = renderedRules("storage.rules");
let ID = "abcdefghij0123456789"; // regenerated per test so tests never see each other's objects
let counter = 0;
const KEY = "0123456789abcdef0123456789abcdef"; // 32 hex
let env;

before(async () => {
  env = await initializeTestEnvironment({ projectId: "demo-reel", storage: { rules: RULES } });
});
after(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearStorage(); ID = "tst" + String(++counter).padStart(6, "0") + "abcdefghijk"; });

const domainUser = (uid = "alice") => env.authenticatedContext(uid, { email: `${uid}@northwind.example`, email_verified: true }).storage();
const unverified = () => env.authenticatedContext("alice", { email: "alice@northwind.example", email_verified: false }).storage();
const otherDomain = () => env.authenticatedContext("alice", { email: "alice@gmail.com", email_verified: true }).storage();
const lookalike = () => env.authenticatedContext("alice", { email: "alice@evilnorthwind.example", email_verified: true }).storage();
const anon = () => env.unauthenticatedContext().storage();
const plainUser = (uid) => env.authenticatedContext(uid).storage();

async function seed(path, customMetadata = { ownerUid: "alice" }) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await uploadString(ref(ctx.storage(), path), "hello", "raw", { customMetadata });
  });
}
const put = (st, path, md) => uploadString(ref(st, path), "hello", "raw", { customMetadata: md });
const get = (st, path) => getBytes(ref(st, path));
const owned = (uid = "alice") => ({ ownerUid: uid });

test("fresh Reel deployments deny unrelated bucket paths", async () => {
  for (const kind of ["photos", "videos", "other"]) {
    await assertFails(put(plainUser("u1"), `users/u1/${kind}/a.bin`));
  }
});

// The same matrix runs for the public path and the password-protected path.
for (const [label, baseOf] of [["public", () => `reel/v/${ID}`], ["protected", () => `reel/v/${ID}/k/${KEY}`]]) {
  describe(`Reel ${label} path`, () => {
    const f = (name) => `${baseOf()}/${name}`;

    test("unauth get of existing object allowed", async () => {
      await seed(f("meta.json"));
      assert.ok((await assertSucceeds(get(anon(), f("meta.json")))).byteLength > 0);
    });
    test("get of a missing object is not-found, not permission-denied", async () => {
      await assert.rejects(get(anon(), f("meta.json")), (e) => e.code === "storage/object-not-found");
    });
    test("list denied", async () => {
      await seed(f("meta.json"));
      await assertFails(listAll(ref(anon(), baseOf())));
      await assertFails(listAll(ref(domainUser(), baseOf())));
    });

    describe("create", () => {
      test("verified @northwind.example user with ownerUid == uid", async () => {
        await assertSucceeds(put(domainUser(), f("meta.json"), owned()));
      });
      test("denied: unverified email", async () => { await assertFails(put(unverified(), f("meta.json"), owned())); });
      test("denied: other domain", async () => { await assertFails(put(otherDomain(), f("meta.json"), owned())); });
      test("denied: lookalike domain", async () => { await assertFails(put(lookalike(), f("meta.json"), owned())); });
      test("denied: unauth", async () => { await assertFails(put(anon(), f("meta.json"), owned())); });
      test("denied: mismatched ownerUid", async () => { await assertFails(put(domainUser(), f("meta.json"), owned("bob"))); });
      test("denied: missing ownerUid", async () => { await assertFails(put(domainUser(), f("meta.json"), {})); });
      test("denied: bad file name", async () => {
        for (const name of ["evil.html", "index.html", "video.mp4.exe", "seg1234.m4s", "seg1234567.m4s", "SEG00001.m4s", "x/video.mp4"]) {
          await assertFails(put(domainUser(), f(name), owned()));
        }
      });
      test("denied: bad id", async () => {
        const bad = ["short", "UPPERCASE0123456789", "abcdefghij0123456789abcdefghij0123456789a", "abcdefghij_123456789"];
        for (const id of bad) {
          const path = label === "public" ? `reel/v/${id}/meta.json` : `reel/v/${id}/k/${KEY}/meta.json`;
          await assertFails(put(domainUser(), path, owned()));
        }
      });
      test("allowed file names", async () => {
        for (const name of ["video.mp4", "trimmed.mp4", "meta.json", "transcript.json", "transcript.txt", "thumb.jpg", "video.m3u8", "init.mp4", "seg00001.m4s", "seg123456.m4s"]) {
          await assertSucceeds(put(domainUser(), f(name), owned()));
        }
      });
    });

    describe("update / delete", () => {
      test("owner can overwrite and update metadata", async () => {
        await seed(f("meta.json"));
        await assertSucceeds(put(domainUser(), f("meta.json"), owned()));
        await assertSucceeds(updateMetadata(ref(domainUser(), f("meta.json")), { customMetadata: { ownerUid: "alice", expiresAt: String(Date.now() + 1e6) } }));
      });
      test("owner can delete", async () => {
        await seed(f("meta.json"));
        await assertSucceeds(deleteObject(ref(domainUser(), f("meta.json"))));
      });
      test("other domain user cannot overwrite, update or delete", async () => {
        await seed(f("meta.json"));
        await assertFails(updateMetadata(ref(domainUser("bob"), f("meta.json")), { customMetadata: { ownerUid: "bob" } }));
        await assertFails(deleteObject(ref(domainUser("bob"), f("meta.json"))));
      });
      // Regression: the Storage emulator evaluates an upload over an existing object as
      // `create`; the create rules therefore require the object to be new or owned by the caller.
      test("other domain user cannot overwrite an existing object via upload", async () => {
        await seed(f("meta.json"));
        await assertFails(put(domainUser("bob"), f("meta.json"), owned("bob")));
      });
      test("unauth cannot delete", async () => {
        await seed(f("meta.json"));
        await assertFails(deleteObject(ref(anon(), f("meta.json"))));
      });
    });

    describe("expiresAt", () => {
      const past = () => String(Date.now() - 60_000);
      const future = () => String(Date.now() + 3_600_000);
      test("past: unauth get denied, owner allowed, other domain user denied", async () => {
        await seed(f("video.mp4"), { ownerUid: "alice", expiresAt: past() });
        await assertFails(get(anon(), f("video.mp4")));
        await assertFails(get(domainUser("bob"), f("video.mp4")));
        await assertSucceeds(get(domainUser("alice"), f("video.mp4")));
      });
      test("future: unauth get allowed", async () => {
        await seed(f("video.mp4"), { ownerUid: "alice", expiresAt: future() });
        await assertSucceeds(get(anon(), f("video.mp4")));
      });
      test("non-numeric expiresAt rejected on write", async () => {
        await assertFails(put(domainUser(), f("video.mp4"), { ownerUid: "alice", expiresAt: "tomorrow" }));
        await assertFails(put(domainUser(), f("video.mp4"), { ownerUid: "alice", expiresAt: "-5" }));
        await assertFails(put(domainUser(), f("video.mp4"), { ownerUid: "alice", expiresAt: "1.5" }));
      });
      test("numeric expiresAt accepted on write", async () => {
        await assertSucceeds(put(domainUser(), f("video.mp4"), { ownerUid: "alice", expiresAt: future() }));
      });
    });
  });
}

describe("Reel protected path key validation", () => {
  const path = (key) => `reel/v/${ID}/k/${key}/meta.json`;
  const bad = {
    "too short": "0123456789abcdef0123456789abcde",
    "too long": "0123456789abcdef0123456789abcdef0",
    "uppercase": "0123456789ABCDEF0123456789abcdef",
    "non-hex": "0123456789abcdeg0123456789abcdef",
  };
  for (const [name, key] of Object.entries(bad)) {
    test(`${name}: create and get denied`, async () => {
      await assertFails(put(domainUser(), path(key), owned()));
      await seed(path(key));
      await assertFails(get(anon(), path(key)));
    });
  }
  test("valid key works", async () => {
    await assertSucceeds(put(domainUser(), path(KEY), owned()));
    await assertSucceeds(get(anon(), path(KEY)));
  });
});

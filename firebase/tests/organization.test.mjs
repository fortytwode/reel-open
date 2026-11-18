import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { internalEmail, organizationConfig } from "../../web/reel/organization.js";

const example = JSON.parse(readFileSync(new URL("../../organization.example.json", import.meta.url)));
test("web loads only its own public settings and fails closed without a deployment", async t => {
  const deployed = { ...example, projectID: "demo-second", allowedEmailDomain: "second.example" };
  const urls = [];
  globalThis.document = { querySelectorAll: () => [] };
  t.after(() => { delete globalThis.document; });
  const fetch = t.mock.method(globalThis, "fetch", async url => {
    urls.push(url.pathname);
    return Response.json(deployed);
  });
  const { organization } = await import("../../web/organization.js?configured");
  assert.equal(organization.projectID, "demo-second");
  assert.deepEqual(urls.map(url => url.split("/").slice(-2).join("/")), ["web/organization.json"]);
  assert.ok(internalEmail("Owner@SECOND.EXAMPLE", organization.allowedEmailDomain));
  assert.equal(internalEmail("guest@second.example.other", organization.allowedEmailDomain), false);
  fetch.mock.mockImplementation(async () => new Response("", {status:404}));
  assert.equal((await import("../../web/organization.js?missing")).organization, null);
  const { loadAuth, isOrganizationEmail } = await import("../../web/reel/firebase.js");
  assert.equal(isOrganizationEmail("owner@second.example"), false);
  await assert.rejects(loadAuth(), /not configured/i);
});

test("configuration accepts provisioned dotless and underscore Storage buckets", () => {
  for (const bucket of ["northwind-recordings", "northwind_recordings", "demo-reel.firebasestorage.app"])
    assert.equal(organizationConfig({...example, bucket})?.bucket, bucket);
  for (const bucket of ["ab", "Bad-Bucket", "bad/bucket", "192.168.0.1", "a".repeat(64)])
    assert.equal(organizationConfig({...example, bucket}), null);
});

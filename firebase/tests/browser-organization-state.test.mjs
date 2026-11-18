import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright";

const web = new URL("../../web/", import.meta.url);
const example = JSON.parse(await readFile(new URL("../../organization.example.json", import.meta.url)));
const origin = "http://localhost:55201";
const uid = "same-test-user-in-every-organization";
const storage = "https://firebasestorage.googleapis.com";
const organization = (projectID, allowedEmailDomain) => ({
  ...example, projectID, allowedEmailDomain, bucket: `${projectID}.firebasestorage.app`,
  deliveryServiceURL: `https://delivery.${projectID}.${allowedEmailDomain}`,
});
const alpha = organization("reel-alpha", "alpha.example");
const beta = organization("reel-beta", "alpha.example");
const otherDomain = organization(alpha.projectID, "other.example");

test("a same-origin organization change isolates browser recordings, resumption and settings", async (t) => {
  const browser = await chromium.launch({
    channel: process.env.REEL_BROWSER_CHANNEL,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const writes = [];
  let deployed;

  // Serve the actual browser modules and use real IndexedDB in one browser context.
  // Substitute only provider responses and capture every upload/delivery at the network boundary.
  await context.route(/^https?:\/\//, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin) {
      if (url.pathname === "/organization.json") return deployed ? route.fulfill({ json: deployed }) : route.fulfill({ status: 404 });
      const file = url.pathname === "/record" ? "record.html" : url.pathname.slice(1);
      const contentType = /\.m?js$/.test(file) ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html";
      const body = await readFile(new URL(file, web)).catch(() => null);
      return body ? route.fulfill({ contentType, body }) : route.fulfill({ status: 404 });
    }
    const headers = { "access-control-allow-origin": origin, "access-control-expose-headers": "X-Goog-Upload-URL" };
    if (url.hostname === "www.gstatic.com" && url.pathname.endsWith("/firebase-app.js")) {
      return route.fulfill({ contentType: "text/javascript", body: "export const initializeApp = config => config;", headers });
    }
    if (url.hostname === "www.gstatic.com" && url.pathname.endsWith("/firebase-auth.js")) {
      const user = { uid, email: `tester@${deployed.allowedEmailDomain}`, emailVerified: true };
      return route.fulfill({ contentType: "text/javascript", headers, body: `
        export const getAuth = app => app;
        export const onAuthStateChanged = (_, callback) => queueMicrotask(() => callback({ ...${JSON.stringify(user)}, getIdToken: async () => "test-token" }));
      ` });
    }
    if (url.origin === storage) {
      const body = request.postData();
      writes.push({ url: url.href, body });
      if (request.headers()["x-goog-upload-command"] === "start") {
        headers["X-Goog-Upload-URL"] = `${storage}/fixture-resumable?object=${encodeURIComponent(url.href)}`;
      }
      return route.fulfill({ json: {}, headers });
    }
    if (url.origin === "https://firestore.googleapis.com") {
      return route.fulfill({ status: request.method() === "GET" ? 404 : 200, json: {}, headers });
    }
    if (url.pathname === "/delivery/complete") {
      writes.push({ url: url.href, body: request.postData() });
      return route.fulfill({ json: {
        verified: true, email_status: "confirmed", page_id: "fixture-page", url: "https://www.notion.so/fixture-page", recipients: [],
      }, headers });
    }
    return route.fulfill({ json: {}, headers });
  });

  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));

  async function open(config) {
    deployed = config;
    await page.goto(`${origin}/record`);
    await page.locator(config ? "#sign-out" : "#auth-msg").waitFor({ state: "visible", timeout: 5000 }).catch(async error => {
      throw new Error(`${errors.join("; ")} ${await page.locator("#auth-msg").textContent()}`, { cause: error });
    });
    if (config) assert.equal(await page.locator("#user").textContent(), `tester@${config.allowedEmailDomain}`);
  }

  async function seed(label, meeting = false) {
    return page.evaluate(async ({ label, meeting, uid }) => {
      const { C, library, store } = window.__reel;
      const row = C.newRecording({ title: label, createdAt: new Date(), upload: meeting ? "localOnly" : "pending" });
      row.captureState = "complete";
      row.transcriptStatus = meeting ? "ready" : "none";
      if (meeting) {
        row.meeting = { ownerUID: uid, deliveryStatus: "pending", attendees: [], calendar: { event_id: "private-calendar-event" } };
        row.summaryEngine = "OpenAI gpt-6.1-sol";
        row.summary = "Private alpha meeting summary";
        const segment = { start: 0, end: 1, text: "Private alpha meeting transcript" };
        await store.putFile(row.id, C.File.transcriptJSON, new Blob([JSON.stringify({ segments: [segment] })]));
      }
      await store.putFile(row.id, C.File.video, new Blob([`${label} video bytes`]));
      await library.update(row);
      return { id: row.id, shareID: row.shareID };
    }, { label, meeting, uid });
  }

  const titles = () => page.locator("#list .rec-title").allTextContents();
  const countdown = () => page.locator("#countdown").inputValue();
  const media = (id) => page.evaluate(async id => {
    const { store, C } = window.__reel;
    return (await store.getFile(id, C.File.video))?.text() ?? null;
  }, id);

  await open(alpha);
  await page.locator(".recording-settings > summary").click();
  await page.selectOption("#countdown", "0");
  const privateVideo = await seed("Private alpha recording");
  const privateMeeting = await seed("Private alpha meeting", true);
  await page.locator(`[data-id="${privateMeeting.id}"]`).waitFor({ timeout: 5000 });
  assert.equal(writes.length, 0, "pending items await the next boot");

  const legacySettings = JSON.stringify({ countdownSeconds: 5 });
  await page.evaluate(async ({ privateVideo, legacySettings }) => {
    const { store, C } = window.__reel;
    const row = await store.getRow(privateVideo.id);
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("reel-recorder", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("recordings", { keyPath: "id" });
        request.result.createObjectStore("files");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction(["recordings", "files"], "readwrite");
    const id = "unassigned-legacy-recording";
    tx.objectStore("recordings").put({ ...row, id, json: { ...row.json, id, title: "Unassigned legacy recording" } });
    tx.objectStore("files").put(new Blob(["unassigned legacy bytes"]), `${id}/${C.File.video}`);
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    db.close();
    localStorage.setItem("reel-settings", legacySettings);
  }, { privateVideo, legacySettings });

  await open(beta);
  const betaVideo = await seed("Beta recording");
  await open(beta);
  await page.waitForFunction(id => window.__reel.library.get(id)?.upload === "uploaded", betaVideo.id, { timeout: 5000 });
  assert.ok(writes.some(write => write.url.includes(beta.bucket) && write.body === "Beta recording video bytes"), "beta's own pending video resumes through the real uploader");
  assert.ok(writes.every(write => !write.body?.includes("Private alpha") && !decodeURIComponent(write.url).includes(privateVideo.shareID)), "beta sends neither alpha media nor pending meeting notes");
  assert.deepEqual(await titles(), ["Beta recording"], "another project must not render private rows from this browser");
  assert.equal(await media(privateVideo.id), null);
  assert.equal(await media(privateMeeting.id), null);
  assert.equal(await countdown(), "3");

  const betaWrites = writes.length;
  await open(otherDomain);
  assert.equal(await page.evaluate(async () => (await window.__reel.store.loadRecordings()).length), 0,
    "a changed domain isolates state even with the same project and Firebase UID");
  assert.equal(await countdown(), "3");
  assert.equal(await media(privateVideo.id), null);
  await open(null);
  assert.equal(await page.evaluate(async () => (await window.__reel.store.loadRecordings()).length), 0);
  assert.equal(await countdown(), "3");
  assert.equal(await media(privateMeeting.id), null);
  assert.equal(writes.length, betaWrites);
  assert.deepEqual(await page.evaluate(async () => {
    const legacy = await new Promise((resolve, reject) => {
      const request = indexedDB.open("reel-recorder");
      request.onupgradeneeded = () => request.transaction.abort();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const data = await new Promise((resolve, reject) => {
      const request = legacy.transaction("files").objectStore("files").get("unassigned-legacy-recording/video.mp4");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    legacy.close();
    return { media: await data.text(), settings: localStorage.getItem("reel-settings") };
  }), { media: "unassigned legacy bytes", settings: legacySettings }, "legacy state remains stored without an assigned organization");

  await open(alpha);
  await page.waitForFunction(({ privateVideo, privateMeeting }) => window.__reel.library.get(privateVideo.id)?.upload === "uploaded"
    && window.__reel.library.get(privateMeeting.id)?.meeting.deliveryStatus === "confirmed", { privateVideo, privateMeeting }, { timeout: 5000 });
  assert.equal(await countdown(), "0");
  assert.equal(await media(privateVideo.id), "Private alpha recording video bytes");
  assert.ok(writes.some(write => write.url.includes(alpha.bucket) && write.body === "Private alpha recording video bytes"));
  assert.ok(writes.some(write => write.url === `${alpha.deliveryServiceURL}/delivery/complete` && write.body.includes("Private alpha meeting transcript")));
  assert.deepEqual(errors, []);
});

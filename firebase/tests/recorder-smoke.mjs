// End-to-end test of the browser recorder (web/record.html) in Google Chrome or Microsoft Edge,
// with fake camera/mic and a browser tab auto-selected as the capture source.
//
//   npm run recorder-smoke                render and run against the demo-reel emulators
//   REEL_BROWSER=msedge npm run recorder-smoke   use Edge
//
// Checks: live segment upload while recording, pause, stop → link playable time, the uploaded
// video.mp4 and HLS copy (ffprobe), meta.json/room documents, the viewer playing it, password +
// expiry, trim, crash recovery of a killed tab, and delete.
import http from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { chromium } from "playwright";
import * as C from "../../web/reel/core.js";
import { boxes } from "../../web/reel/fmp4.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, "../../web");
const PROD = !process.argv.includes("--emulators") && process.env.REEL_PROD === "1";
const ORG_CONFIG = PROD ? path.join(WEB, "organization.json") : path.join(HERE, "../../.reel/test-fixture/web/organization.json");
const organization = JSON.parse(await readFile(ORG_CONFIG, "utf8"));
if (!PROD && organization.projectID !== "demo-reel") throw new Error("Recorder smoke requires the demo-reel fixture.");
const PORT = Number(process.env.REEL_PORT || 5051), ORIGIN = `http://localhost:${PORT}`;
const CHANNEL = process.env.REEL_BROWSER || "chrome";
const HEADED = process.env.REEL_HEADED === "1";
const OUT = process.env.REEL_SMOKE_OUT || path.join(os.tmpdir(), "reel-recorder-smoke");
await mkdir(OUT, { recursive: true });
const STORAGE = PROD ? "https://firebasestorage.googleapis.com" : "http://127.0.0.1:9199";
const FIRESTORE = PROD ? "https://firestore.googleapis.com" : "http://127.0.0.1:8080";
const cloud = { ...C.CLOUD, ...organization, storageOrigin: STORAGE };
const Q = PROD ? "" : "?emulator=1";
// Production: play on the live share page (the bucket's download CORS allows only the hosting origins).
const VIEWER = PROD ? organization.webBase : ORIGIN;
const gone = (st) => st === 404 || (PROD && st === 403);   // prod rules deny (403) reads of missing rooms
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".json": "application/json", ".wasm": "application/wasm", ".tflite": "application/octet-stream" };

// Static server mimicking Firebase Hosting (cleanUrls, /v/** → v.html) plus a capture target page.
const TARGET = `<!doctype html><title>Reel smoke target</title><body style="margin:0;background:#123">
<canvas id=c width=1280 height=720 style="width:100vw;height:100vh"></canvas><script>
const c=document.getElementById('c'),x=c.getContext('2d');let i=0;
(function f(){x.fillStyle='hsl('+(i%360)+',60%,40%)';x.fillRect(0,0,1280,720);x.fillStyle='#fff';x.font='bold 120px sans-serif';
x.fillText('Reel '+(i++),100,400);requestAnimationFrame(f)})();
</script></body>`;
const server = http.createServer(async (req, res) => {
  let p = new URL(req.url, ORIGIN).pathname;
  if (p === "/target") { res.writeHead(200, { "Content-Type": "text/html" }); res.end(TARGET); return; }
  if (p.startsWith("/v/")) p = "/v.html";
  else if (p === "/record") p = "/record.html";
  else if (p === "/library") p = "/library.html";
  try {
    const body = await readFile(p === "/organization.json" ? ORG_CONFIG : path.join(WEB, p === "/" ? "index.html" : p));
    res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] || "application/octet-stream" }); res.end(body);
  } catch { res.writeHead(404); res.end("not found"); }
}).listen(PORT);

let failures = 0, passes = 0;
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail: String(detail).slice(0, 400) });
  if (ok) { passes++; console.log("  ok  ", name, detail ? `(${String(detail).slice(0, 160)})` : ""); }
  else { failures++; console.log("  FAIL", name, String(detail).slice(0, 400)); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 200) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await sleep(step); }
  return false;
}
const objURL = (id, file, key = null) => C.downloadURL(id, file, key, cloud);
async function fetchObj(id, file, key = null) { return fetch(objURL(id, file, key) + "&t=" + Date.now(), { cache: "no-store" }); }
async function meta(id, key = null) { const r = await fetchObj(id, C.File.meta, key); return r.ok ? r.json() : { httpStatus: r.status }; }
async function room(roomID) {
  const headers = PROD ? {} : { Authorization: "Bearer owner" };
  const r = await fetch(`${FIRESTORE}/v1/projects/${cloud.projectID}/databases/${cloud.firestoreDatabase}/documents/videos/${roomID}`, { headers });
  return r.ok ? C.documentFields(await r.json()) : { httpStatus: r.status };
}
function ffprobe(file) {
  const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,codec_type,width,height,channels,sample_rate,duration:format=duration",
    "-of", "json", file], { encoding: "utf8" });
  return JSON.parse(out);
}
/** Saves a PNG of one frame (seconds from the start, or negative from the end) for eyeballing the bubble / blur. */
function frame(file, name, at = 2) {
  const seek = at < 0 ? ["-sseof", String(at)] : ["-ss", String(at)];
  try { execFileSync("ffmpeg", ["-v", "error", "-y", ...seek, "-i", file, "-frames:v", "1", path.join(OUT, name + ".png")]); } catch {}
}
async function download(id, file, key = null) {
  const r = await fetchObj(id, file, key);
  if (!r.ok) return null;
  const p = path.join(OUT, `${id}-${file}`);
  await writeFile(p, Buffer.from(await r.arrayBuffer()));
  return p;
}

const browser = await chromium.launch({
  channel: CHANNEL, headless: !HEADED,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--auto-select-tab-capture-source-by-title=Reel smoke target",
    "--autoplay-policy=no-user-gesture-required", "--enable-features=DocumentPictureInPictureAPI"],
});
const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, permissions: ["camera", "microphone", "clipboard-read", "clipboard-write", "notifications"] });
if (!PROD) {
  const localOrigins = new Set([ORIGIN, STORAGE, FIRESTORE, "http://127.0.0.1:9099"]);
  const services = new Set([organization.meetingServiceURL, organization.deliveryServiceURL, organization.speechServiceURL]);
  // Use the pinned Firebase package's browser bundles and keep all provider traffic local.
  const sdk = path.join(HERE, "node_modules/firebase");
  const { version } = JSON.parse(await readFile(path.join(sdk, "package.json"), "utf8"));
  const sdkOrigin = `https://www.gstatic.com/firebasejs/${version}/`;
  const bundles = new Map(["firebase-app.js", "firebase-auth.js", "firebase-firestore.js"].map(name => [sdkOrigin + name, path.join(sdk, name)]));
  await ctx.route(/^https?:\/\//, (route) => {
    const url = new URL(route.request().url());
    if (localOrigins.has(url.origin)) return route.continue();
    const bundle = bundles.get(url.href);
    if (bundle) return route.fulfill({ path: bundle, contentType: "text/javascript", headers: { "access-control-allow-origin": "*" } });
    if (services.has(url.origin)) return route.fulfill({ status: 503, json: { error: "Service is outside recorder smoke scope" } });
    return route.abort();
  });
}
// Keep this capture/publishing suite deterministic and fast. The dedicated
// recording-transcription-smoke.mjs exercises the real Whisper model with known speech.
await ctx.route("**/reel/meeting-transcription-worker.js", (route) => route.fulfill({ contentType: "text/javascript", body:
  'self.onmessage = () => self.postMessage({type:"result",text:"The recorder integration fixture verifies transcript publishing.",chunks:[{timestamp:[0,2],text:"The recorder integration fixture verifies transcript publishing."}]});' }));
const target = await ctx.newPage();
await target.goto(ORIGIN + "/target");

async function openRecorder() {
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(String(e)));
  page.on("console", (m) => { if (process.env.SMOKE_DEBUG || ["error", "warning"].includes(m.type())) console.log("    [page]", m.type(), m.text().slice(0, 300)); });
  await page.goto(ORIGIN + "/record" + Q);
  return page;
}

async function signIn(page) {
  if (PROD) {
    // Disposable email/password test user (never a real account); same Firebase Auth instance as the page.
    await page.evaluate(async ({ email, password }) => {
      const { loadAuth } = await import("/reel/firebase.js");
      const { auth, am } = await loadAuth();
      await am.signInWithEmailAndPassword(auth, email, password);
    }, { email: process.env.REEL_TEST_EMAIL, password: process.env.REEL_TEST_PASSWORD });
  } else {
    // The emulator accepts a synthetic Google identity without loading Google's popup scripts.
    await page.evaluate(async (email) => {
      const { loadAuth } = await import("/reel/firebase.js");
      const { auth, am } = await loadAuth();
      const credential = am.GoogleAuthProvider.credential(JSON.stringify({ sub: email, email, email_verified: true, name: "Tester" }));
      await am.signInWithCredential(auth, credential);
    }, `tester@${organization.allowedEmailDomain}`);
  }
  return until(() => page.locator("#sign-out").isVisible(), 20000);
}

async function configure(page, { mode = "screen", camera = true, audio = "micAndSystem", background = "none", fps = 30 } = {}) {
  await page.selectOption("#mode", mode);
  await page.selectOption("#audio", audio);
  if (!await page.locator(".recording-settings").getAttribute("open").then((v) => v !== null)) await page.locator(".recording-settings > summary").click();
  await page.selectOption("#quality", "p720");
  await page.selectOption("#fps", String(fps));
  await page.selectOption("#countdown", "0");
  await page.selectOption("#background", background).catch(() => {});
  if ((await page.locator("#camera-on").isChecked()) !== camera) await page.locator("#camera-on").click();
  for (const id of ["#auto-upload", "#copy-on-stop", "#upload-mp4"]) if (!(await page.locator(id).isChecked())) await page.locator(id).click();
}

async function startRecording(page) {
  const cameraOnly = await page.locator("#mode").inputValue() === "camera";
  const pip = cameraOnly ? Promise.resolve(null) : page.context().waitForEvent("page", { timeout: 4000 }).catch(() => null);
  await page.locator("#start").click();
  const ok = await until(() => page.evaluate(() => window.__reel.state().phase === "recording"), 20000, 100);
  if (ok) await page.evaluate(() => {
    const s = window.__reel.state().session;
    if (!s) return;
    const onError = s.events.onError;
    s.events.onError = (error) => {
      window.__reel.lastCaptureError = { message: error.message, phase: window.__reel.state().phase,
        audioPendingFrames: s.audioPendingFrames, info: s.info, fps: s.settings.fps };
      console.error("Capture failure diagnostics", JSON.stringify(window.__reel.lastCaptureError));
      onError?.(error);
    };
  });
  const pipPage = await pip;
  const r = await page.evaluate(() => { const s = window.__reel.state(); return s.recording && { id: s.recording.id, shareID: s.recording.shareID }; });
  return { ok, r, pipPage };
}

let firstShare = null, secondShare = null;
try {
  console.log(`recorder smoke: ${CHANNEL}${HEADED ? " (headed)" : ""}, backend ${PROD ? "PRODUCTION" : "emulators"}`);
  let page = await openRecorder();
  check("page loads without the unsupported notice", await until(async () => (await page.locator("#start").isEnabled()) && !(await page.locator("#unsupported").isVisible())));
  check("signed in", await signIn(page));
  await configure(page);

  await page.locator("#preview-toggle").click();
  check("setup camera preview works before recording", await until(() => page.locator("#preview").evaluate(v => !v.hidden && v.readyState >= 2)));
  await page.evaluate(() => { window.setupPreviewTracks = document.getElementById("preview").srcObject.getTracks(); });

  // A failed audio pump must abort countdown instead of starting a silent recording.
  await page.selectOption("#countdown", "3");
  await page.evaluate(() => {
    const post = Worker.prototype.postMessage;
    window.countdownAudioFault = { phase: null, restore: () => { Worker.prototype.postMessage = post; } };
    Worker.prototype.postMessage = function (message, ...args) {
      const { phase, session } = window.__reel.state();
      if (message.type === "audio" && this === session?.worker) {
        window.countdownAudioFault.phase = phase;
        window.countdownAudioFault.restore();
        throw new Error("Test audio transfer failed");
      }
      return post.call(this, message, ...args);
    };
  });
  await page.locator("#start").click();
  check("Start releases preview devices before capture", await page.evaluate(() => setupPreviewTracks.every(t => t.readyState === "ended")) && await page.locator("#preview").isHidden());
  const countdownResult = () => page.evaluate(() => {
    const { phase, session } = window.__reel.state();
    return { phase, activeSession: !!session, localRecordings: window.__reel.library.list().length,
      faultPhase: window.countdownAudioFault.phase, toast: document.getElementById("toast").textContent };
  });
  const aborted = await until(async () => {
    const result = await countdownResult();
    return result.faultPhase && result.phase === "idle" && !result.activeSession && result.localRecordings === 0 && result;
  }, 12000);
  const result = aborted || await countdownResult();
  await page.evaluate(() => window.countdownAudioFault.restore());
  check("audio failure during countdown aborts before recording", aborted && result.faultPhase === "countdown" &&
    result.toast === "Couldn't start recording: Test audio transfer failed", JSON.stringify(result));
  if (!aborted && result.phase !== "idle") {
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#cancel").click();
    await until(() => page.evaluate(() => window.__reel.state().phase === "idle"), 10000);
  }
  await configure(page);

  // ---- 1. record: screen (tab) + camera bubble + mic + tab audio, live upload, pause
  console.log("recording 1: live upload, pause, stop");
  const startT = Date.now();
  const { ok, r, pipPage } = await startRecording(page);
  check("recording started", ok, ok ? "" : (await page.locator("#toast").innerText().catch(() => "")));
  if (!ok) throw new Error("could not start recording");
  firstShare = r.shareID;
  check("bubble window (Document Picture-in-Picture) opened", !!pipPage, pipPage ? "" : "no PiP page event (headless?)");
  const info = await page.evaluate(() => window.__reel.state().session.info);
  check("WebCodecs encoders", info && /^avc1\./.test(info.video), JSON.stringify(info));
  check("meta.json says recording while capturing", await until(async () => (await meta(r.shareID)).status === "recording", 10000));
  check("room document created", await until(async () => (await room(r.shareID)).ownerUid, 10000), JSON.stringify(await room(r.shareID)));
  check("first live segment uploaded while recording", await until(async () => (await fetchObj(r.shareID, C.segmentFile(1))).ok, 15000));
  check("init.mp4 and live playlist uploaded", (await fetchObj(r.shareID, C.File.initSegment)).ok &&
    await until(async () => (await (await fetchObj(r.shareID, C.File.playlist)).text()).includes("#EXT-X-PLAYLIST-TYPE:EVENT"), 10000));
  await sleep(3000);
  await page.locator("#pause").click();
  // The click changes the controls immediately. Sample once the encoder has paused its clock.
  const pauseConfirmed = await until(() => page.evaluate(() => window.__reel.state().session.pauseConfirmed), 5000);
  const pausedAt = await page.evaluate(() => window.__reel.state().session.elapsed);
  await sleep(2500);
  const stillPaused = await page.evaluate(() => window.__reel.state().session.elapsed);
  check("pause stops the clock", pauseConfirmed && Math.abs(stillPaused - pausedAt) < 0.6,
    pauseConfirmed ? `${pausedAt} → ${stillPaused}` : "encoder did not confirm pause");
  await page.locator("#pause").click();
  // Closing the bubble window switches to drawing the camera into the video (bottom-left).
  if (pipPage) await pipPage.close();
  check("closing the bubble window turns on in-video compositing", await until(() => page.evaluate(() => window.__reel.state().session.composite), 3000));
  await sleep(3000);
  const resumedAt = await page.evaluate(() => window.__reel.state().session.elapsed);
  check("resume restarts the clock", resumedAt > stillPaused + 0.6, `${stillPaused} → ${resumedAt}`);
  const stopT = Date.now();
  await page.locator("#stop").click();
  // Playwright may wait for a busy Windows renderer before delivering the click.
  // Recording continues during that wait, so duration must use the accepted click,
  // not the earlier command invocation used to measure stop-to-playable latency.
  const stopAcceptedT = Date.now();
  const playable = await until(async () => { const m = await meta(r.shareID); return m.status === "ready" && m.playback.hls; }, 30000, 100);
  const stopToPlayable = (Date.now() - stopT) / 1000;
  check("link playable (HLS, meta ready) soon after stop", playable && stopToPlayable < 15, `${stopToPlayable.toFixed(2)} s after stop`);
  const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
  check("link copied to the clipboard on stop", clip.endsWith(`/${PROD ? organization.viewerPath : "v"}/${r.shareID}`), clip);
  const playlist = await (await fetchObj(r.shareID, C.File.playlist)).text();
  check("final playlist is VOD with ENDLIST", playlist.includes("#EXT-X-PLAYLIST-TYPE:VOD") && playlist.includes("#EXT-X-ENDLIST"));
  check("video.mp4 uploaded and meta lists it", await until(async () => { const m = await meta(r.shareID); return m.playback.mp4 && m.download === "video.mp4"; }, 60000), JSON.stringify(await meta(r.shareID)).slice(0, 300));
  check("ordinary transcript and summary finish publishing after local processing", await until(async () => {
    const m = await meta(r.shareID);
    return m.transcriptStatus === "ready" && m.summary?.includes("Extractive summary") &&
      (await fetchObj(r.shareID, C.File.transcriptJSON)).ok && (await fetchObj(r.shareID, C.File.transcriptText)).ok;
  }, 30000));
  const m1 = await meta(r.shareID);
  const { schemaVersion, room: metaRoom, ownerName, app, hasThumbnail, width, transcriptStatus, locked } = m1;
  check("meta.json shape (schema 2, room, owner, app, thumbnail)", schemaVersion === 2 && metaRoom === r.shareID && ownerName && /\(web\)$/.test(app) &&
    hasThumbnail === true && width === 1280 && transcriptStatus === "ready" && locked === false,
    JSON.stringify({ schemaVersion, metaRoom, expectedRoom: r.shareID, ownerName, app, hasThumbnail, width, transcriptStatus, locked }));
  const refresh = await page.evaluate(async (id) => {
    const { publisher, library } = window.__reel;
    await publisher.uploads.get(id);
    const uploadMeta = publisher.uploadMeta, statuses = [];
    publisher.uploadMeta = async function (recording, ...args) {
      await uploadMeta.call(this, recording, ...args);
      if (recording.id === id) statuses.push(recording.transcriptStatus);
    };
    try {
      const refreshed = await publisher.refreshTranscript(id, library.get(id).recordingOwnerUID);
      return { refreshed, statuses };
    } finally {
      publisher.uploadMeta = uploadMeta;
    }
  }, r.id);
  check("re-publishing a ready transcript keeps its metadata ready", refresh.refreshed && refresh.statuses.length > 0 &&
    refresh.statuses.every((status) => status === "ready"), JSON.stringify(refresh));
  check("thumb.jpg uploaded", (await fetchObj(r.shareID, C.File.thumbnail)).ok);
  const mp4 = await download(r.shareID, C.File.video);
  const probe = ffprobe(mp4);
  const v = probe.streams.find((s) => s.codec_type === "video"), a = probe.streams.find((s) => s.codec_type === "audio");
  const dur = parseFloat(probe.format.duration);
  check("video.mp4: H.264 + AAC stereo 48 kHz", v && v.codec_name === "h264" && a && /aac|opus/.test(a.codec_name) && a.channels === 2 && a.sample_rate === "48000", JSON.stringify(probe.streams));
  check("audio duration stays synchronized with video across pause", a && Number.isFinite(Number(a.duration)) && Math.abs(Number(a.duration) - dur) < 0.6,
    `${a?.duration} s audio, ${dur} s video`);
  check("video.mp4 duration = meta, shorter than wall time by the pause", Math.abs(dur - m1.durationSeconds) < 0.5 && dur > 9 && dur < (stopAcceptedT - startT) / 1000 - 2,
    `${dur} s (meta ${m1.durationSeconds}, wall ${(stopAcceptedT - startT) / 1000} s, stop delivery ${(stopAcceptedT - stopT) / 1000} s)`);
  frame(mp4, "screen-bubble", -0.7);
  const top = boxes(new Uint8Array(await readFile(mp4))).map((b) => b.type).join(",");
  check("video.mp4 is progressive with moov first", top.startsWith("ftyp,moov,mdat"), top);
  // HLS copy: concatenate init + segments and probe.
  const segs = [...playlist.matchAll(/seg\d+\.m4s/g)].map((x) => x[0]);
  const parts = [await (await fetchObj(r.shareID, C.File.initSegment)).arrayBuffer()];
  for (const s of segs) parts.push(await (await fetchObj(r.shareID, s)).arrayBuffer());
  const hlsPath = path.join(OUT, r.shareID + "-hls.mp4");
  await writeFile(hlsPath, Buffer.concat(parts.map((p) => Buffer.from(p))));
  const hp = ffprobe(hlsPath);
  check("HLS copy decodes (init + all segments)", hp.streams.some((s) => s.codec_name === "h264") && Math.abs(parseFloat(hp.format.duration) - dur) < 0.6,
    `${segs.length} segments, ${hp.format.duration} s`);

  // Publishing may finish while local remuxing awaits IndexedDB. Its ready state must survive.
  check("local finalization preserves concurrently published HLS state", await page.evaluate(async (id) => {
    const { library, publisher, store } = window.__reel;
    await publisher.uploads.get(id);
    const original = library.get(id), get = library.get.bind(library);
    const log = (await store.getRow(id)).log;
    await library.update({ ...original, playback: { ...original.playback, hls: false } });
    let scheduled = false, published;
    library.get = (key) => {
      const snapshot = get(key);
      if (key === id && !scheduled) {
        scheduled = true;
        published = Promise.resolve().then(() => {
          const current = get(id); current.playback.hls = true;
          return library.update(current);
        });
      }
      return snapshot;
    };
    try {
      await publisher.finalizeLocal(id, log);
      await published;
      return get(id).playback.hls;
    } finally {
      library.get = get;
      await library.update({ ...get(id), playback: original.playback });
    }
  }, r.id));

  // ---- 2. viewer plays it
  const viewer = await ctx.newPage();
  await viewer.goto(`${VIEWER}/v/${r.shareID}${Q}`);
  const plays = await until(async () => viewer.evaluate(async () => {
    const p = document.getElementById("player");
    if (!p || p.hidden) return false;
    p.muted = true; await p.play().catch(() => {});
    return p.readyState >= 2 && p.currentTime > 0.3;
  }), 25000, 300);
  check("viewer plays the recording", plays, await viewer.locator("#status").innerText().catch(() => ""));
  check("viewer title and download", (await viewer.locator("#title").innerText()).startsWith("Recording – ") && await viewer.locator("#download").isVisible());
  if (!PROD) {
    const libraryURL = ORIGIN + "/library";
    const recorderLibrary = await page.getByRole("link", { name: "Online library" }).evaluate((link) => link.href);
    const viewerLibrary = await viewer.getByRole("link", { name: "Reel online library" }).evaluate((link) => link.href);
    check("recorder and viewer link to the library on the signed-in origin", recorderLibrary === libraryURL && viewerLibrary === libraryURL);
    const libraryPage = await ctx.newPage();
    await libraryPage.goto(libraryURL + Q);
    check("online Library reuses the recorder session and shows its uploaded clip",
      await until(async () => (await libraryPage.locator("#account").innerText()) === `tester@${organization.allowedEmailDomain}` &&
        (await libraryPage.locator("#recordings").innerText()).includes(m1.title)), await libraryPage.locator("#status").textContent());
    await libraryPage.close();
  }
  await viewer.close();

  // ---- 3. trim
  console.log("trim + password + expiry");
  await page.evaluate(async (id) => { const r = window.__reel.library.get(id); await window.__reel.publisher.setTrim(r, 1, 5); }, r.id);
  check("trim in meta + trimmed.mp4 for download", await until(async () => { const m = await meta(r.shareID); return m.trim && m.trim.start === 1 && m.download === "trimmed.mp4"; }, 30000));
  const trimmed = await download(r.shareID, C.File.trimmed);
  const td = trimmed ? parseFloat(ffprobe(trimmed).format.duration) : 0;
  check("trimmed.mp4 is keyframe-aligned (starts ≤ 4 s before the trim start)", td >= 4 && td <= 8.6, `${td} s for 1–5 s`);

  // ---- 4. password + expiry (moves the copy to reel/v/<id>/k/<key>/)
  await page.evaluate(async (id) => {
    const r = window.__reel.library.get(id);
    await window.__reel.publisher.updateAccess(r, { set: "hunter22" }, new Date(Date.now() + 3600e3));
  }, r.id);
  const stub = await meta(r.shareID);
  check("open meta.json is the locked stub (no title)", stub.locked === true && !stub.title && stub.kdf && stub.kdf.iterations === 210000, JSON.stringify(stub));
  const key = await C.deriveKey("hunter22", stub.kdf.salt);
  const km = await meta(r.shareID, key);
  check("keyed copy readable with the password-derived key", km.status === "ready" && km.locked === true && km.room === `${r.shareID}-${key}` && km.expiresAt, JSON.stringify(km).slice(0, 200));
  check("old open copy removed", (await fetchObj(r.shareID, C.File.video)).status === 404 && (await fetchObj(r.shareID, C.segmentFile(1))).status === 404);
  check("keyed room created, open room deleted", (await room(`${r.shareID}-${key}`)).ownerUid && gone((await room(r.shareID)).httpStatus));
  const wrong = await C.deriveKey("nope", stub.kdf.salt);
  check("wrong password finds nothing", (await fetchObj(r.shareID, C.File.meta, wrong)).status === 404);
  const v2 = await ctx.newPage();
  await v2.goto(`${VIEWER}/v/${r.shareID}${Q}`);
  await until(() => v2.locator("#gate").isVisible(), 10000);
  await v2.locator("#gate-password").fill("hunter22");
  await v2.locator("#gate-submit").click();
  check("viewer unlocks with the password", await until(() => v2.evaluate(() => { const p = document.getElementById("player"); return p && !p.hidden && !!p.src; }), 20000));
  await v2.close();

  // ---- 5. crash recovery: kill the tab mid-recording, reopen
  console.log("recording 2: crash recovery");
  await configure(page, { camera: false, audio: "micOnly" });
  const second = await startRecording(page);
  check("second recording started", second.ok);
  secondShare = second.r.shareID;
  check("second recording has two live segments before the crash", await until(async () => (await fetchObj(second.r.shareID, C.segmentFile(2))).ok, 25000));
  await page.close({ runBeforeUnload: false });           // tab killed: worker gone, no stop
  if (second.pipPage) await second.pipPage.close().catch(() => {});
  check("meta still says recording after the crash", (await meta(second.r.shareID)).status === "recording");
  page = await openRecorder();
  const recovered = await until(async () => { const m = await meta(second.r.shareID); return m.status === "ready" && m.playback.mp4 && m.playback.hls; }, 60000);
  if (!recovered) console.log("Recovery diagnostics", JSON.stringify(await page.evaluate(async (id) => ({
    locks: navigator.locks ? await navigator.locks.query() : null,
    localState: window.__reel.library.get(id)?.captureState,
    files: await window.__reel.store.listFiles(id),
  }), second.r.id)));
  check("reopening the page recovers it: rebuilt from segments and uploaded", recovered, JSON.stringify(await meta(second.r.shareID)).slice(0, 300));
  const rec = await page.evaluate((id) => window.__reel.library.get(id), second.r.id);
  check("recovered recording marked recovered", rec && rec.captureState === "recovered", rec && rec.captureState);
  const rmp4 = await download(second.r.shareID, C.File.video);
  const rd = rmp4 ? parseFloat(ffprobe(rmp4).format.duration) : 0;
  check("recovered video.mp4 has the finished segments", rd >= 7.5, `${rd} s`);

  // ---- 5b. camera only with background blur (MediaPipe segmentation), restart
  if (!PROD) {
    console.log("recording 3: camera only + blur background, restart");
    // Hosted Windows has software video encoding and segmentation. Exercise the
    // supported 24 fps effects profile here; the screen/audio scenario above
    // separately exercises the normal 30 fps profile. Keep overload guards on.
    await configure(page, { mode: "camera", camera: true, audio: "micOnly", background: "blur", fps: 24 });
    const third = await startRecording(page);
    check("camera-only recording with blur started", third.ok);
    const effectState = await page.evaluate(() => {
      const s = window.__reel.state();
      return { phase: s.phase, effect: !!s.camEffect, toast: document.getElementById("toast").textContent };
    });
    check("background effect running", effectState.effect, JSON.stringify(effectState));
    await sleep(2500);
    const beforeRestart = await page.evaluate(() => ({ phase: window.__reel.state().phase, toast: document.getElementById("toast").textContent,
      error: window.__reel.lastCaptureError }));
    if (beforeRestart.phase !== "recording") throw new Error("Camera recording stopped before Restart: " + JSON.stringify(beforeRestart));
    await page.locator("#restart").click();
    check("restart begins a new recording", await until(() => page.evaluate((old) => {
      const s = window.__reel.state(); return s.phase === "recording" && s.recording.id !== old;
    }, third.r.id), 20000));
    check("restart discarded the first take", (await page.evaluate((id) => window.__reel.library.get(id), third.r.id)) === null);
    const take2 = await page.evaluate(() => ({ id: window.__reel.state().recording.id, shareID: window.__reel.state().recording.shareID }));
    await sleep(5000);
    await page.locator("#stop").click();
    check("camera-only take uploaded", await until(async () => (await meta(take2.shareID)).playback?.mp4, 60000));
    const cm = await download(take2.shareID, C.File.video);
    const cp = cm ? ffprobe(cm) : { streams: [] };
    if (cm) frame(cm, "camera-blur");
    check("camera-only video.mp4 is H.264 1280x720", cp.streams.some((s) => s.codec_name === "h264" && s.width === 1280 && s.height === 720), JSON.stringify(cp.streams));
    await page.evaluate(async (id) => { await window.__reel.publisher.delete(window.__reel.library.get(id)); }, take2.id);
    check("camera-only take deleted", (await fetchObj(take2.shareID, C.File.meta)).status === 404);
  }

  // ---- 6. delete both through the app
  console.log("delete");
  for (const id of [r.id, second.r.id]) {
    await page.evaluate(async (id) => { const r = window.__reel.library.get(id); await window.__reel.publisher.delete(r); }, id);
  }
  const statuses = [];
  for (const f of [C.File.meta, C.File.video, C.File.playlist, C.File.initSegment, C.segmentFile(1), C.File.thumbnail, C.File.trimmed]) {
    statuses.push((await fetchObj(r.shareID, f, key)).status, (await fetchObj(second.r.shareID, f)).status);
  }
  statuses.push((await fetchObj(r.shareID, C.File.meta)).status);
  check("every remote object deleted (404)", statuses.every((s) => s === 404), statuses.join(","));
  check("rooms deleted", gone((await room(`${r.shareID}-${key}`)).httpStatus) && gone((await room(second.r.shareID)).httpStatus));
  check("local library empty", (await page.evaluate(() => window.__reel.library.list().length)) === 0);
  check("no page errors", page.errors.length === 0, page.errors.join(" | "));
  firstShare = secondShare = null;
} catch (e) {
  check("smoke run", false, e.stack || String(e));
} finally {
  await writeFile(path.join(OUT, "results.json"), JSON.stringify({ channel: CHANNEL, prod: PROD, passes, failures, results }, null, 1)).catch(() => {});
  await browser.close();
  server.close();
  if (firstShare || secondShare) console.log("NOTE: leftover share IDs (clean up):", firstShare, secondShare);
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

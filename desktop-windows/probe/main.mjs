import { app, BrowserWindow, desktopCapturer } from "electron";
import http from "node:http";
import { appendFileSync, createReadStream, mkdirSync } from "node:fs";
import { mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { selectOwnedSource } from "./source-selection.mjs";
import { createLocalRecordingStore } from "../src/local-recordings.mjs";

const probeDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(probeDir, "../..");
const outArg = process.argv.find((arg) => arg.startsWith("--out="));
const outDir = path.resolve(outArg ? outArg.slice(6) : path.join(probeDir, "out"));
const invalidSource = process.argv.includes("--invalid-source");
const noCapture = process.argv.includes("--no-capture");
const timeoutMs = 45_000;
const maxPacketBytes = 16 * 1024 * 1024;
mkdirSync(outDir, { recursive: true });
function trace(stage) {
  appendFileSync(path.join(outDir, "startup.log"), `${new Date().toISOString()} ${stage}\n`);
}
trace("main module loaded");
app.on("ready", () => trace("app ready event"));
app.on("browser-window-created", () => trace("browser window created"));
let origin, captureWindow, fixtureWindow, selectedSource, recordingWriter, completedRecording;
let reportResolve;
const reportReady = new Promise((resolve) => { reportResolve = resolve; });
const events = [];

// A synthetic fixture may start its audible tone without a click. Display capture itself is
// initiated from a timer; this switch does not grant any screen/media permission.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

function respond(response, statusCode, body, contentType = "text/plain") {
  response.writeHead(statusCode, { "Content-Type": contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(body);
}

async function bodyBytes(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("Probe request exceeds byte limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function staticFile(urlPath) {
  if (urlPath === "/") return path.join(probeDir, "capture.html");
  if (urlPath === "/capture.mjs" || urlPath === "/fixture.html") return path.join(probeDir, urlPath.slice(1));
  if (!/^\/web\/(reel|vendor)\/[a-zA-Z0-9._/-]+$/.test(urlPath)) return null;
  const target = path.resolve(repoDir, "." + urlPath);
  const root = path.join(repoDir, "web") + path.sep;
  return target.startsWith(root) ? target : null;
}

async function startServer() {
  const server = http.createServer(async (request, response) => {
    try {
      if (request.headers.host !== origin.replace("http://", "")) return respond(response, 403, "Unexpected host");
      const url = new URL(request.url, origin);
      if (request.method === "GET" && url.pathname === "/probe-config") {
        return respond(response, 200, JSON.stringify({ sourceId: selectedSource?.id || null }), "application/json");
      }
      if (request.method === "POST" && url.pathname === "/packet/init") {
        if (request.headers.origin !== origin) return respond(response, 403, "Unexpected origin");
        if (!recordingWriter) return respond(response, 409, "Recording writer unavailable");
        const bytes = await bodyBytes(request, maxPacketBytes);
        await recordingWriter.appendInit(bytes);
        return respond(response, 200, "ok");
      }
      if (request.method === "POST" && url.pathname === "/packet/fragment") {
        if (request.headers.origin !== origin) return respond(response, 403, "Unexpected origin");
        if (!recordingWriter) return respond(response, 409, "Recording writer unavailable");
        const bytes = await bodyBytes(request, maxPacketBytes);
        await recordingWriter.appendFragment({ index: Number(request.headers["x-fragment-index"]),
          duration: Number(request.headers["x-fragment-duration"]), bytes });
        return respond(response, 200, "ok");
      }
      if (request.method === "POST" && url.pathname === "/finish") {
        if (request.headers.origin !== origin) return respond(response, 403, "Unexpected origin");
        if (!recordingWriter || completedRecording) return respond(response, 409, "Recording cannot finish twice");
        const data = JSON.parse((await bodyBytes(request, 4096)).toString("utf8"));
        completedRecording = await recordingWriter.finish({ durationSeconds: data.durationSeconds });
        return respond(response, 200, JSON.stringify({ id: completedRecording.id, playable: completedRecording.playable }), "application/json");
      }
      if (request.method === "POST" && url.pathname === "/report") {
        if (request.headers.origin !== origin) return respond(response, 403, "Unexpected origin");
        const bytes = await bodyBytes(request, 128 * 1024);
        const report = JSON.parse(bytes.toString("utf8"));
        reportResolve(report);
        return respond(response, 200, "ok");
      }
      if (request.method !== "GET") return respond(response, 405, "Method not allowed");
      const file = staticFile(url.pathname);
      if (!file) return respond(response, 404, "Not found");
      await stat(file);
      const type = file.endsWith(".html") ? "text/html" : file.endsWith(".mjs") || file.endsWith(".js") ? "text/javascript" : "application/octet-stream";
      response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      createReadStream(file).pipe(response);
    } catch (error) { respond(response, 500, String(error?.message || error)); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  return server;
}

function fixtureHwnd(window) {
  const handle = window.getNativeWindowHandle();
  if (process.platform !== "win32" || handle.length < 4) throw new Error("Windows HWND is required");
  return handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
}

function setCapturePermissions() {
  const session = captureWindow.webContents.session;
  session.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) =>
    permission === "display-capture" && requestingOrigin === origin && details?.isMainFrame !== false);
  session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const allowed = permission === "display-capture" && details?.requestingUrl === origin + "/";
    events.push({ type: "permission", permission, allowed });
    callback(allowed);
  });
  session.setDisplayMediaRequestHandler((request, callback) => {
    const allowed = request.securityOrigin === origin && request.frame === captureWindow.webContents.mainFrame &&
      request.videoRequested && !!selectedSource;
    events.push({ type: "display-request", allowed, userGesture: request.userGesture, audioRequested: request.audioRequested });
    callback(allowed ? { video: selectedSource, ...(request.audioRequested ? { audio: "loopback" } : {}) } : null);
  });
}

async function run() {
  trace("run entered");
  await mkdir(outDir, { recursive: true });
  if (process.platform !== "win32") throw new Error("This probe must run in a Windows desktop session");
  const server = await startServer();
  try {
    fixtureWindow = new BrowserWindow({ width: 840, height: 560, x: 40, y: 40, show: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    trace("fixture window constructed");
    await fixtureWindow.loadURL(origin + "/fixture.html");
    trace("fixture page loaded");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const hwnd = fixtureHwnd(fixtureWindow);
    const sources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 } });
    trace(`sources enumerated ${sources.length}`);
    if (invalidSource) {
      let rejected = false;
      const withoutOwnedWindow = sources.filter((source) => !source.id.startsWith(`window:${hwnd}:`));
      try { selectOwnedSource(withoutOwnedWindow, hwnd); } catch { rejected = true; }
      if (!rejected) throw new Error("Unknown-HWND mutant was not rejected");
      return { ok: true, negativeControl: true, hwnd: hwnd.toString(), sourceCount: sources.length };
    }
    selectedSource = selectOwnedSource(sources, hwnd);
    if (noCapture) return { ok: false, negativeControl: true,
      error: { name: "NoopControl", message: "No capture was started" }, hwnd: hwnd.toString(), sourceId: selectedSource.id };
    recordingWriter = await createLocalRecordingStore({ root: path.join(outDir, "recordings") }).begin({
      ownerUserID: "synthetic-probe", title: "Fixture", createdAt: new Date().toISOString(),
    });
    captureWindow = new BrowserWindow({ width: 680, height: 480, x: 950, y: 40, show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    setCapturePermissions();
    await captureWindow.loadURL(origin + "/");
    const timeout = new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: { name: "Timeout", message: "Renderer did not report within 45 seconds" } }), timeoutMs));
    const report = await Promise.race([reportReady, timeout]);
    if (report.ok && !completedRecording) throw new Error("Renderer reported success before the local writer completed");
    return { ...report, hwnd: hwnd.toString(), sourceId: selectedSource.id,
      recording: completedRecording, bytes: completedRecording ? (await stat(completedRecording.path)).size : report.bytes,
      captureWindowVisible: captureWindow.isVisible(),
      electron: process.versions.electron, chromium: process.versions.chrome, events };
  } finally {
    if (recordingWriter && !completedRecording) await recordingWriter.abort();
    server.close();
  }
}

let finished = false;
const watchdog = setTimeout(() => {
  void finish({ ok: false, error: { name: "Timeout", message: "Probe did not finish within 75 seconds" }, events });
}, 75_000);

async function finish(result) {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  trace(`finish ${result.ok ? "ok" : "failed"}`);
  try { await writeFile(path.join(outDir, "result.json"), JSON.stringify(result, null, 2)); }
  catch (error) { console.error(error); }
  console.log(JSON.stringify(result));
  app.exit(result.ok ? 0 : 1);
}

// Keep the ESM main module free of a top-level await on app readiness. Electron
// emits ready after this module finishes evaluating.
trace("waiting for app ready");
app.whenReady().then(run).then(finish).catch((error) => finish({
  ok: false, error: { name: error?.name || "Error", message: String(error?.message || error) }, events,
}));

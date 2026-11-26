import { app, BrowserWindow, desktopCapturer, ipcMain } from 'electron';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAssetServer } from '../src/asset-server.mjs';
import { createLocalRecordingStore } from '../src/local-recordings.mjs';
import { createWindowsRecorder } from '../src/recorder.mjs';
import { createNativeBridge } from '../src/native-bridge.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const outArg = process.argv.find(arg => arg.startsWith('--out='));
const outDir = path.resolve(outArg ? outArg.slice(6) : path.join(here, 'adapter-out'));
const abortNegative = process.argv.includes('--abort-negative');
const verifyOutputSwitch = process.argv.includes('--verify-output-switch');
const ownerUserID = 'synthetic-probe';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const failures = [];

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Keep the process alive after the last fixture window closes so finish() can
// persist the result and choose the exit code itself.
app.on('window-all-closed', () => {});

function hwnd(window) {
  const handle = window.getNativeWindowHandle();
  if (process.platform !== 'win32' || handle.length < 4) throw Error('Windows fixture HWND required');
  return (handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0))).toString();
}

async function fixtureServer() {
  const html = await readFile(path.join(here, 'fixture.html'));
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/fixture.html') {
      response.writeHead(404); response.end(); return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(html);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}/fixture.html`,
    close: () => new Promise(resolve => server.close(resolve)) };
}

function fragments(bytes) {
  let count = 0;
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 8 > bytes.length) throw Error('Truncated MP4 box');
    let size = bytes.readUInt32BE(offset), header = 8;
    if (size === 1) { size = Number(bytes.readBigUInt64BE(offset + 8)); header = 16; }
    if (!Number.isSafeInteger(size) || size < header || offset + size > bytes.length) throw Error('Invalid MP4 box');
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'moof') count++;
    offset += size;
  }
  return count;
}

async function run() {
  if (process.platform !== 'win32') throw Error('Windows desktop session required');
  await mkdir(outDir, { recursive: true });
  const assets = await startAssetServer();
  const fixture = await fixtureServer();
  let fixtureWindow, bridge, recorder, activeCapture;
  try {
    fixtureWindow = new BrowserWindow({ width: 840, height: 560, x: 40, y: 40, show: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    await fixtureWindow.loadURL(fixture.url);
    await sleep(1000);
    const id = hwnd(fixtureWindow);
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
    const exact = sources.filter(source => /^window:(\d+):[01]$/.test(source.id) && source.id.split(':')[1] === id);
    if (exact.length !== 1) throw Error('Fixture did not have one exact window source');
    const store = createLocalRecordingStore({ root: path.join(outDir, 'recordings') });
    let originalEndpoint, changedAt;
    if (verifyOutputSwitch) {
      bridge = createNativeBridge({ executable: path.join(here, '../native/ReelNativeJoin.exe') });
      originalEndpoint = await bridge.defaultRenderEndpoint();
      if (!originalEndpoint) throw Error('The fixture needs a default Windows output device');
    }
    async function observeOutput() {
      const current = await bridge.defaultRenderEndpoint();
      if (current && current !== originalEndpoint) changedAt ??= Date.now();
      return current;
    }
    recorder = createWindowsRecorder({ BrowserWindow, desktopCapturer, ipcMain, store, origin: assets.origin,
      defaultRenderEndpoint: verifyOutputSwitch ? observeOutput : undefined,
      onFailure: error => failures.push(error.message) });
    const controller = new AbortController();
    const argumentsForCapture = { hwnd: id, pid: process.pid, meeting: { title: 'Fixture' },
      ownerUserID, systemAudio: true, microphone: false, signal: controller.signal };
    if (abortNegative) {
      const start = recorder.start(argumentsForCapture);
      const startAt = Date.now();
      setTimeout(() => controller.abort(), 300);
      let rejection = null;
      try { await start; } catch (error) { rejection = { name: error?.name ?? 'Error', message: error?.message ?? String(error), elapsedMs: Date.now() - startAt }; }
      await sleep(1000);
      const remainingWindows = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed()).length;
      const completedRecordings = store.list(ownerUserID).length;
      const onlyFixtureRemains = remainingWindows === 1;
      if (rejection?.name !== 'AbortError' || !onlyFixtureRemains || completedRecordings || failures.length) {
        throw Error(`Abort control failed: ${JSON.stringify({ rejection, remainingWindows, completedRecordings, failures })}`);
      }
      return { ok: true, expectedAbort: true, onlyFixtureRemains, completedRecordings: 0,
        hwnd: id, sourceId: exact[0].id, electron: process.versions.electron };
    }
    const beganAt = Date.now();
    activeCapture = await recorder.start(argumentsForCapture);
    const captureWindows = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed() && window !== fixtureWindow);
    if (captureWindows.length !== 1 || captureWindows[0].isVisible()) throw Error('Recorder was not one hidden window');
    if (verifyOutputSwitch) {
      await sleep(5_000);
      if (changedAt) throw Error('Default output changed before the control sample');
      await writeFile(path.join(outDir, 'switch-ready.json'), JSON.stringify({ originalEndpoint }));
      const deadline = Date.now() + 45_000;
      while (!changedAt && Date.now() < deadline) await sleep(200);
      if (!changedAt) throw Error('Windows did not report a different default output device');
      await fixtureWindow.webContents.executeJavaScript('tone.frequency.value = 660');
      await sleep(10_000);
    } else {
      await sleep(Math.max(0, 13_500 - (Date.now() - beganAt)));
    }
    const recording = await recorder.stop(activeCapture);
    activeCapture = null;
    const bytes = await readFile(recording.path);
    const segmentCount = fragments(bytes);
    if (!recording.playable || segmentCount < 3 || bytes.length < 10_000 || bytes.length > 20 * 1024 * 1024
      || store.list(ownerUserID).length !== 1 || failures.length) throw Error('Real adapter did not save a complete local recording');
    return { ok: true, method: 'production-recorder-exact-source', hwnd: id, sourceId: exact[0].id,
      recording, bytes: bytes.length, segmentCount, recorderWindowHidden: true,
      ...(verifyOutputSwitch ? { outputSwitched: true, changeAfterStartSeconds: (changedAt - beganAt) / 1000 } : {}),
      electron: process.versions.electron, chromium: process.versions.chrome };
  } finally {
    if (activeCapture) await recorder.stop(activeCapture).catch(() => {});
    await bridge?.dispose();
    if (fixtureWindow && !fixtureWindow.isDestroyed()) fixtureWindow.destroy();
    await fixture.close(); await assets.close();
  }
}

let finished = false;
const watchdog = setTimeout(() => { void finish({ ok: false, error: 'Adapter probe timed out' }); }, verifyOutputSwitch ? 110_000 : 75_000);
async function finish(result) {
  if (finished) return;
  finished = true; clearTimeout(watchdog);
  await mkdir(outDir, { recursive: true }).catch(() => {});
  await writeFile(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2)).catch(() => {});
  console.log(JSON.stringify(result));
  app.exit(result.ok ? 0 : 1);
}
app.whenReady().then(run).then(finish).catch(error => finish({ ok: false,
  error: { name: error?.name || 'Error', message: String(error?.message || error) }, failures }));

import { app, BrowserWindow } from 'electron';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalRecordingStore } from '../src/local-recordings.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '../..');
const outArg = process.argv.find(arg => arg.startsWith('--out='));
const outDir = path.resolve(outArg ? outArg.slice(6) : path.join(here, 'encoder-out'));
const fixture = path.join(here, 'encoder-fixture.html');
const files = new Map([
  ['/web/reel/capture.js', 'web/reel/capture.js'],
  ['/web/reel/core.js', 'web/reel/core.js'],
  ['/web/reel/audio.js', 'web/reel/audio.js'],
  ['/web/reel/encoder-worker.js', 'web/reel/encoder-worker.js'],
  ['/web/reel/fmp4.js', 'web/reel/fmp4.js'],
  ['/web/vendor/mp4-muxer.mjs', 'web/vendor/mp4-muxer.mjs'],
]);
const chunks = [];
const segments = new Map();
let init = null;
let finishPromise;
let origin;
let window;
let finished = false;
const MAX_PACKET = 16 * 1024 * 1024;

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.on('window-all-closed', () => {});

function send(response, status, body, type = 'text/plain; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; worker-src 'self'; connect-src 'self'; style-src 'self'; media-src 'self' blob:; img-src 'self' blob:; frame-ancestors 'none'" });
  response.end(body);
}

async function requestBytes(request) {
  const parts = [];
  let length = 0;
  for await (const part of request) {
    length += part.length;
    if (!length || length > MAX_PACKET) throw Error('Test packet size is invalid.');
    parts.push(part);
  }
  return Buffer.concat(parts, length);
}

async function finish(result) {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  await mkdir(outDir, { recursive: true }).catch(() => {});
  await writeFile(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2)).catch(() => {});
  console.log(JSON.stringify(result));
  if (window && !window.isDestroyed()) window.destroy();
  app.exit(result.ok ? 0 : 1);
}

const server = createServer(async (request, response) => {
  try {
    if (request.headers.host !== origin?.slice(7)) return send(response, 403, 'Unexpected host');
    const url = new URL(request.url, origin);
    if (url.origin !== origin || url.username || url.password) return send(response, 403, 'Unexpected origin');
    if (request.method === 'GET') {
      if (url.pathname === '/') return send(response, 200, await readFile(fixture), 'text/html; charset=utf-8');
      const relative = files.get(url.pathname);
      if (!relative) return send(response, 404, 'Not found');
      const body = await readFile(path.join(appRoot, relative));
      const type = relative.endsWith('.mjs') || relative.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/octet-stream';
      return send(response, 200, body, type);
    }
    if (request.method !== 'POST') return send(response, 405, 'Method not allowed');
    if (url.pathname === '/init') {
      if (init) return send(response, 409, 'Duplicate init');
      init = await requestBytes(request);
      return send(response, 200, 'ok');
    }
    if (url.pathname === '/segment') {
      const index = Number(request.headers['x-fragment-index']);
      const duration = Number(request.headers['x-fragment-duration']);
      if (!Number.isInteger(index) || index < 1 || !Number.isFinite(duration) || duration < 0 || segments.has(index)) {
        return send(response, 400, 'Invalid fragment metadata');
      }
      segments.set(index, { bytes: await requestBytes(request), duration });
      return send(response, 200, 'ok');
    }
    if (url.pathname === '/finish') {
      if (finishPromise) throw Error('Duplicate finish');
      const body = JSON.parse((await requestBytes(request)).toString('utf8'));
      finishPromise = (async () => {
        if (!init || segments.size < 3 || body.segmentCount !== segments.size) throw Error('Incomplete synthetic encoder output.');
        const ownerUserID = 'synthetic-packaged-encoder';
        const store = createLocalRecordingStore({ root: path.join(outDir, 'recordings') });
        const writer = await store.begin({ ownerUserID, title: 'Synthetic packaged encoder', createdAt: new Date().toISOString() });
        await writer.appendInit(new Uint8Array(init));
        for (let index = 1; index <= segments.size; index++) {
          const fragment = segments.get(index);
          if (!fragment) throw Error('Synthetic encoder fragments are out of order.');
          await writer.appendFragment({ index, duration: fragment.duration, bytes: new Uint8Array(fragment.bytes) });
        }
        const recording = await writer.finish({ durationSeconds: body.duration });
        const result = { ok: true, method: 'packaged-worker-synthetic-video-pcm', recording,
          bytes: (await (await import('node:fs/promises')).stat(recording.path)).size,
          segmentCount: segments.size, codecs: body.codecs, audioFrames: body.audioFrames,
          audioSeconds: body.audioSeconds, electron: process.versions.electron, chromium: process.versions.chrome };
        await finish(result);
        return send(response, 200, JSON.stringify(result), 'application/json');
      })();
      await finishPromise;
      return;
    }
    if (url.pathname === '/failure') {
      const body = JSON.parse((await requestBytes(request)).toString('utf8'));
      await finish({ ok: false, error: { name: 'EncoderSmokeError', message: String(body.message || 'Synthetic worker failed.') }, electron: process.versions.electron });
      return send(response, 200, 'ok');
    }
    return send(response, 404, 'Not found');
  } catch (error) {
    send(response, 500, String(error?.message || error));
    await finish({ ok: false, error: { name: error?.name || 'Error', message: String(error?.message || error) }, electron: process.versions.electron });
  }
});

const watchdog = setTimeout(() => finish({ ok: false, error: { name: 'Timeout', message: 'Encoder smoke timed out.' }, electron: process.versions.electron }), 75_000);

async function run() {
  await mkdir(outDir, { recursive: true });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  window = new BrowserWindow({ width: 1000, height: 760, show: true, webPreferences: { nodeIntegration: false,
    contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  await window.loadURL(origin + '/');
  window.webContents.on('console-message', (_event, details) => {
    if (details?.message) console.log(`fixture: ${details.message}`);
  });
}

app.whenReady().then(run).catch(error => finish({ ok: false,
  error: { name: error?.name || 'Error', message: String(error?.message || error) }, electron: process.versions.electron }));

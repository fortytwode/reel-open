import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';

const web = new URL('../../web/', import.meta.url).pathname;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const launchOptions = existsSync(chrome) ? { headless: true, executablePath: chrome } : { headless: true };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const file = path === '/record' ? '/record.html' : path === '/notetaker' ? '/notetaker.html' : path;
  try { const data = await readFile(join(web, file)); res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/json' }); res.end(data); }
  catch { res.writeHead(404); res.end(); }
});

test('Notetaker launches separately without capture and legacy meeting links remain available', async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch(launchOptions);
  try {
    const page = await browser.newPage();
    page.on("pageerror", error => console.error("PAGE ERROR", error));
    await page.addInitScript(() => {
      window.captureRequests = 0;
      for (const method of ['getUserMedia', 'getDisplayMedia']) navigator.mediaDevices[method] = () => { window.captureRequests++; throw new Error('unexpected capture'); };
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${origin}/notetaker`);
    await page.locator('#meeting-calendar-panel .mc-card').waitFor({ state: 'attached', timeout: 5000 });
    assert.equal(await page.title(), 'Reel Notetaker');
    assert.equal(await page.locator('a[data-library]').getAttribute('href'), '/library#meetings');
    assert.equal(await page.evaluate(() => window.captureRequests), 0);
    const manifest = await (await page.request.get(`${origin}/notetaker.webmanifest`)).json();
    assert.equal(manifest.id, '/notetaker'); assert.equal(manifest.start_url, '/notetaker');
    for (const icon of manifest.icons) {
      const response = await page.request.get(origin + icon.src);
      assert.ok(response.ok(), icon.src);
      const png = await response.body();
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', icon.src);
      assert.equal(png.toString('ascii', 12, 16), 'IHDR', icon.src);
      assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, icon.sizes, icon.src);
    }
    await page.goto(`${origin}/record`);
    await page.locator('#recording-kind-label').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#meeting-calendar-panel .mc-card').count(), 0);
    await page.goto(`${origin}/record#calendar-meeting=event-1`);
    await page.locator('#meeting-calendar-panel .mc-card').waitFor({ timeout: 5000 });
    await page.goto(`${origin}/record?mode=meeting`);
    await page.locator('#meeting-calendar-panel .mc-card').waitFor({ timeout: 5000 });
    assert.equal(await page.locator('#recording-kind').inputValue(), 'meeting');
    await page.goto(`${origin}/record#meeting-request=${encodeURIComponent(JSON.stringify({url:'https://meet.google.com/abc-defg-hij'}))}`);
    await page.locator('#meeting-calendar-panel .mc-card').waitFor({ timeout: 5000 });
    assert.equal(await page.locator('[data-browser]').isVisible(), true);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});

test('the tab handoff asks for a tab first and keeps the saved recording mode', async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch(launchOptions);
  try {
    const page = await browser.newPage();
    await page.route('https://**', route => route.abort());
    await page.addInitScript(() => {
      const key = 'reel-state:local:reel-settings';
      if (!localStorage.getItem(key)) {
        localStorage.setItem(key, JSON.stringify({ mode: 'camera', cameraEnabled: true, audio: 'micAndSystem', countdownSeconds: 0 }));
      }
      window.captureCalls = [];
      window.chosenSurface = 'window';
      Notification.requestPermission = async () => { window.captureCalls.push('notification'); return 'denied'; };
      navigator.mediaDevices.getUserMedia = async () => { window.captureCalls.push('camera/mic'); throw new Error('unexpected device'); };
      if (window.documentPictureInPicture) {
        window.documentPictureInPicture.requestWindow = async () => { window.captureCalls.push('pip'); throw new Error('PiP unavailable'); };
      }
      navigator.mediaDevices.getDisplayMedia = async (options) => {
        window.captureCalls.push({ options, activation: navigator.userActivation.isActive });
        if (window.chosenSurface !== 'browser') {
          const video = { getSettings: () => ({ displaySurface: window.chosenSurface }), stop: () => window.captureCalls.push('stop video') };
          const audio = { stop: () => window.captureCalls.push('stop audio') };
          return { getVideoTracks: () => [video], getTracks: () => [video, audio] };
        }
        const canvas = document.createElement('canvas');
        canvas.width = 320; canvas.height = 180;
        const stream = canvas.captureStream(30);
        const track = stream.getVideoTracks()[0];
        const getSettings = track.getSettings.bind(track);
        track.getSettings = () => ({ ...getSettings(), displaySurface: 'browser' });
        const ctx = canvas.getContext('2d');
        let frame = 0;
        setInterval(() => {
          ctx.fillStyle = frame++ % 2 ? '#435da0' : '#396954';
          ctx.fillRect(0, 0, 320, 180);
        }, 33);
        window.fixtureTabTrack = track;
        return stream;
      };
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${origin}/record?source=tab`);
    const chooseTab = page.getByRole('button', { name: 'Choose a tab' });
    await chooseTab.waitFor();
    assert.equal(await page.locator('#mode-setting').isVisible(), false);
    assert.deepEqual(await page.evaluate(() => window.captureCalls), []);

    await chooseTab.click();
    await page.locator('#toast').filter({ hasText: 'Choose a browser tab' }).waitFor();
    const [picker, ...closedTracks] = await page.evaluate(() => window.captureCalls);
    assert.equal(picker.activation, true);
    assert.equal(picker.options.video.displaySurface, 'browser');
    assert.equal(picker.options.monitorTypeSurfaces, 'exclude');
    assert.equal(picker.options.systemAudio, 'exclude');
    assert.ok(picker.options.audio, 'tab audio remains available when requested');
    assert.deepEqual(closedTracks, ['stop video', 'stop audio']);
    assert.equal(await page.evaluate(() => window.__reel.state().recording), null);

    await page.locator('#audio').selectOption('none');
    await page.locator('#camera-on').uncheck();
    await page.evaluate(() => { window.chosenSurface = 'browser'; window.captureCalls = []; });
    await chooseTab.click();
    await page.waitForFunction(() => window.__reel.state().phase === 'recording');
    assert.equal(await page.evaluate(() => window.__reel.state().recording.mode), 'window');
    assert.equal(await page.evaluate(() => window.captureCalls[0].options.audio), false);
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#cancel').click();
    await chooseTab.waitFor();
    assert.equal(await page.evaluate(() => window.fixtureTabTrack.readyState), 'ended');

    await page.goto(`${origin}/record`);
    await page.getByRole('button', { name: 'Start recording' }).waitFor();
    assert.equal(await page.locator('#mode').inputValue(), 'camera');
    await page.goto(`${origin}/record?source=tab&mode=meeting`);
    await page.getByRole('button', { name: 'Start meeting recording' }).waitFor();
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});


test('signed-in notes use the scoped token and clear on account change', async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch(launchOptions);
  try {
    const page = await browser.newPage();
    const example = JSON.parse(await readFile(new URL('../../organization.example.json', import.meta.url), 'utf8'));
    await page.route('**/organization.json', route => route.fulfill({ json: example }));
    await page.route('https://www.gstatic.com/firebasejs/**/firebase-app.js', route => route.fulfill({ contentType: 'text/javascript', body: 'export function initializeApp() { return {}; }' }));
    await page.route('https://www.gstatic.com/firebasejs/**/firebase-auth.js', route => route.fulfill({ contentType: 'text/javascript', body: `
      const auth = {}; export function getAuth() { return auth; }
      export function onAuthStateChanged(auth, callback) { window.setFakeUser = callback; callback(null); }
      export function signOut() { window.setFakeUser(null); }
      export class GoogleAuthProvider { setCustomParameters() {} }
      export function signInWithPopup() {}` }));
    let release, received, requestCount = 0;
    const requestReceived = new Promise(resolve => { received = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    await page.route('https://delivery.northwind.example/delivery/meetings**', async route => {
      assert.equal(route.request().headers().authorization, 'Bearer token-a');
      requestCount++;
      if (requestCount === 1) { received(); await blocked; }
      await route.fulfill({ json: { meetings: [{ id: 'reel_' + 'a'.repeat(64), title: 'Private meeting', started_at: '2026-11-19T12:00:00Z' }], next_cursor: null }, headers: { 'access-control-allow-origin': '*' } });
    });
    await page.route('https://meetings.northwind.example/**', route => route.fulfill({ json: {}, headers: { 'access-control-allow-origin': '*' } }));
    await page.goto(`http://127.0.0.1:${server.address().port}/notetaker`);
    await page.waitForFunction(() => !!window.setFakeUser);
    await page.evaluate(() => window.setFakeUser({ uid: 'a', email: 'a@northwind.example', emailVerified: true, getIdToken: async () => 'token-a' }));
    await requestReceived;
    await page.evaluate(() => window.setFakeUser(null));
    release();
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#notes-list').textContent(), '');
    assert.match(await page.locator('#notes-status').textContent(), /Sign in/);
    await page.evaluate(() => window.setFakeUser({ uid: 'a', email: 'a@northwind.example', emailVerified: true, getIdToken: async () => 'token-a' }));
    const note = page.locator('#notes-list a');
    await note.waitFor();
    assert.equal(await note.textContent(), 'Private meeting');
    assert.equal(await note.getAttribute('href'), example.notesBaseURL + '#meetings/reel_' + 'a'.repeat(64));
    await page.evaluate(() => window.setFakeUser(null));
    assert.equal(await page.locator('#notes-list').textContent(), '');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});

test('failed cloud recording recovery keeps its failed status and offers private downloads only', async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch(launchOptions);
  try {
    const page = await browser.newPage();
    const example = JSON.parse(await readFile(new URL('../../organization.example.json', import.meta.url), 'utf8'));
    await page.route('**/organization.json', route => route.fulfill({ json: example }));
    const event = { id: 'a'.repeat(64), title: 'Partial capture', start: '2026-11-19T12:00:00Z',
      status: 'failed', capture_provider: 'cloud', failure_category: 'capture_interrupted',
      video_available: true, recovery_available: true };
    let posted = false;
    const download = 'https://storage.googleapis.com/reel-fixture/partial-summary.json';
    await page.context().route(download, route => route.fulfill({ json: { partial: true } }));
    await page.route('https://meetings.northwind.example/calendar/**', async route => {
      const request = route.request();
      const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST' };
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      assert.equal(request.headers().authorization, 'Bearer token-owner');
      const path = new URL(request.url()).pathname;
      if (path.endsWith('/recover')) {
        assert.equal(path, `/calendar/meetings/${event.id}/recover`);
        assert.equal(request.method(), 'POST');
        assert.deepEqual(request.postDataJSON(), {});
        posted = true;
        event.recovery_status = 'processing';
      }
      if (path.endsWith('/artifacts/summary')) {
        assert.equal(path, `/calendar/meetings/${event.id}/artifacts/summary`);
        assert.equal(request.method(), 'GET');
        return route.fulfill({ json: { url: download }, headers });
      }
      await route.fulfill({ json: path === '/calendar/settings'
        ? { events: [event], capabilities: { calendar: true, bot: true } } : { meetings: [] }, headers });
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.goto(origin + '/notetaker');
    await page.evaluate(async () => {
      const { mountMeetingCalendar } = await import('/meeting-calendar.js');
      const container = document.createElement('div');
      container.id = 'test-recovery-calendar';
      document.body.append(container);
      window.testRecoveryCalendar = mountMeetingCalendar({
        container, session: async () => ({ uid: 'owner', getIdToken: async () => 'token-owner' }),
      });
    });
    const calendar = page.locator('#test-recovery-calendar');
    const recover = calendar.getByRole('button', { name: 'Transcribe partial recording' });
    await recover.click();
    await calendar.getByText('Transcribing the partial recording…').waitFor();
    assert.equal(posted, true);
    assert.equal(await recover.count(), 0);
    Object.assign(event, { recovery_available: false, recovery_status: 'recovered', transcript_available: true, recovery_summary_available: true,
      notion_url: 'https://www.notion.so/stale' });
    await page.evaluate(() => window.testRecoveryCalendar.refresh());
    await calendar.getByText('Partial transcript ready. You can download the recovered files below.').waitFor();
    for (const name of ['Download partial video', 'Download partial transcript', 'Download partial notes']) {
      assert.equal(await calendar.getByRole('button', { name }).count(), 1);
    }
    await calendar.getByRole('button', { name: 'Download partial notes' }).click();
    const summaryLink = calendar.getByRole('link', { name: 'Open download' });
    await summaryLink.waitFor();
    assert.equal(await summaryLink.getAttribute('href'), download);
    assert.equal(await calendar.getByText('Failed', { exact: true }).count(), 1);
    assert.equal(await calendar.getByRole('button', { name: 'Send notes to Notion' }).count(), 0);
    assert.equal(await calendar.getByRole('link', { name: 'Open Notion notes' }).count(), 0);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});

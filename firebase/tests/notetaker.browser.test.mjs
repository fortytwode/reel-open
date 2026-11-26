import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const web = fileURLToPath(new URL('../../web/', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const launchOptions = { headless: true };
if (process.env.REEL_BROWSER) launchOptions.channel = process.env.REEL_BROWSER;
else if (existsSync(chrome)) launchOptions.executablePath = chrome;
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const file = path === '/record' ? '/record.html' : path === '/notetaker' ? '/notetaker.html' : path === '/notetaker-meetings' ? '/notetaker-meetings.html' : path;
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
    assert.equal(await page.title(), 'Reel Recorder');
    const recorderManifest = await page.locator('link[rel=manifest]').getAttribute('href');
    const recorder = await (await page.request.get(origin + recorderManifest)).json();
    assert.equal(recorder.id, '/record');
    assert.equal(recorder.start_url, '/record');
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


test('team deployments open the full Notetaker workspace and keep deep links', async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch(launchOptions);
  try {
    const page = await browser.newPage();
    const origin = `http://127.0.0.1:${server.address().port}`;
    const example = JSON.parse(await readFile(new URL('../../organization.example.json', import.meta.url), 'utf8'));
    // Library and Notetaker on one origin: Notetaker is its own page.
    await page.route('**/organization.json', route => route.fulfill({ json: { ...example, webBase: origin, notesBaseURL: origin + '/library' } }));
    await page.route('https://**', route => route.abort());
    await page.goto(`${origin}/notetaker#calendar-meeting=event-1`);
    await page.waitForURL(`${origin}/notetaker-meetings#calendar-meeting=event-1`);
    await page.locator('#nav-meetings').waitFor();
    assert.equal(await page.locator('html').getAttribute('data-product'), 'notetaker');
    assert.equal(await page.locator('#view-title').textContent(), 'Meeting calendar');
    assert.equal(await page.locator('#nav-library').isVisible(), false);
    await page.goto(`${origin}/notetaker`);
    await page.waitForURL(`${origin}/notetaker-meetings`);
    await page.locator('#nav-meetings[aria-current="page"]').waitFor();
    assert.equal(await page.title(), 'Meetings · Reel Notetaker');
    assert.equal(await page.locator('#other-product').getAttribute('href'), origin + '/library');
    // Library proxied on another origin: Notetaker opens there, where people are already signed in.
    await page.unroute('**/organization.json');
    await page.unroute('https://**');
    const hub = 'https://hub.northwind.example/reel';
    await page.route('**/organization.json', route => route.fulfill({ json: { ...example, notesBaseURL: hub } }));
    await page.route(hub, route => route.fulfill({ contentType: 'text/html', body: '<title>proxied</title>' }));
    await page.goto('about:blank');
    await page.goto(`${origin}/notetaker#meetings/reel_${'a'.repeat(64)}`);
    await page.waitForURL(`${hub}#meetings/reel_${'a'.repeat(64)}`);
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
    await page.goto(origin + '/notetaker-meetings');
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

test('public Google signup connects Calendar separately and isolates Recorder data between accounts', async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch(launchOptions);
  try {
    const page = await browser.newPage();
    const origin = `http://127.0.0.1:${server.address().port}`;
    const example = JSON.parse(await readFile(new URL('../../organization.example.json', import.meta.url), 'utf8'));
    await page.addInitScript(() => {
      window.fixtureScheduleMessages = [];
      addEventListener('message', event => {
        if (event.data?.type === 'REEL_MEETING_SCHEDULE') window.fixtureScheduleMessages.push(event.data);
      });
    });
    await page.route('**/organization.json', route => route.fulfill({
      json: { ...example, accountAccess: 'public', allowedEmailDomain: '', webBase: origin },
    }));
    await page.route('https://www.gstatic.com/firebasejs/**/firebase-app.js', route => route.fulfill({
      contentType: 'text/javascript', body: 'export function initializeApp() { return {}; }',
    }));
    await page.route('https://www.gstatic.com/firebasejs/**/firebase-auth.js', route => route.fulfill({
      contentType: 'text/javascript', body: `
        const auth = {};
        export function getAuth() { return auth; }
        export function onAuthStateChanged(_, callback) {
          window.setFakeUser = (uid, provider = 'google.com') => {
            auth.currentUser = uid ? { uid, email: uid + '@gmail.com', emailVerified: true,
              getIdToken: async () => 'token-' + uid, getIdTokenResult: async () => ({signInProvider: provider}) } : null;
            if (uid) sessionStorage.setItem('fixtureUser', uid);
            else sessionStorage.removeItem('fixtureUser');
            callback(auth.currentUser);
          };
          window.setFakeUser(sessionStorage.getItem('fixtureUser'));
        }
        export function signOut() { window.setFakeUser(null); }
        export class GoogleAuthProvider { setCustomParameters(parameters) { window.fixtureGoogleParameters = parameters; } }
        export function signInWithPopup() { window.setFakeUser('outside'); }`,
    }));
    const headers = { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization,content-type',
      'access-control-allow-methods': 'GET,POST' };
    await page.route('https://firestore.googleapis.com/**', route => route.fulfill({ json: {}, headers }));
    const requests = [];
    let authorized = false, selected = false;
    const event = { id: 'a'.repeat(64), title: 'Outside account notes', start: '2026-11-19T12:00:00Z',
      status: 'completed', capture_provider: 'cloud', transcript_available: true, summary_available: true };
    await page.route('https://accounts.google.com/o/oauth2/v2/auth?**', async route => {
      authorized = true;
      await route.fulfill({ status: 302, headers: { location: origin + '/notetaker?calendar_oauth=connected' } });
    });
    await page.route('https://meetings.northwind.example/calendar/**', async route => {
      const request = route.request();
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      assert.equal(request.headers().authorization, 'Bearer token-outside');
      const path = new URL(request.url()).pathname;
      requests.push(path);
      if (path.endsWith('/oauth/start')) {
        assert.equal(request.method(), 'POST');
        assert.deepEqual(request.postDataJSON(), {});
        return route.fulfill({
          json: { authorization_url: 'https://accounts.google.com/o/oauth2/v2/auth?state=fixture' }, headers,
        });
      }
      if (path.endsWith('/sources')) return route.fulfill({
        json: { sources: [{ id: 'primary', title: 'My calendar', primary: true }] }, headers,
      });
      if (path === '/calendar/connect') {
        assert.deepEqual(request.postDataJSON(), { calendar_ids: ['primary'] });
        selected = true;
      }
      if (path === '/calendar/disconnect') { authorized = false; selected = false; }
      return route.fulfill({ json: path === '/calendar/settings' ? {
        capabilities: { calendar: authorized, bot: true, calendar_oauth: true, calendar_authorized: authorized },
        config: selected ? { enabled: true, calendar_ids: ['primary'], consent_mode: 'ask' } : null,
        events: selected ? [event] : [],
      } : { meetings: [] }, headers });
    });
    let legacyDeliveryCalls = 0;
    await page.route('https://delivery.northwind.example/**', route => {
      legacyDeliveryCalls++;
      return route.fulfill({ status: 403, headers });
    });

    await page.goto(origin + '/notetaker');
    const signIn = page.getByRole('button', { name: 'Sign in with Google' });
    await signIn.waitFor();
    await page.evaluate(() => window.setFakeUser('blocked', 'password'));
    await page.waitForFunction(() => !sessionStorage.getItem('fixtureUser'));
    assert.equal(await page.locator('#workspace').isVisible(), false);
    await signIn.click();
    await page.getByRole('button', { name: 'Connect Google Calendar' }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.fixtureGoogleParameters), { prompt: 'select_account' });
    assert.equal(requests.includes('/calendar/sources'), false);
    await page.getByRole('button', { name: 'Connect Google Calendar' }).click();
    await page.getByRole('button', { name: 'Choose Google calendars' }).click();
    assert.equal(requests.filter(path => path === '/calendar/settings').length > 0, true);
    assert.equal(requests.includes('/calendar/connect'), false);
    assert.equal(new URL(page.url()).search, '');
    await page.getByRole('checkbox', { name: 'My calendar (primary)' }).check();
    await page.getByRole('button', { name: 'Save selected calendars' }).click();
    await page.getByRole('button', { name: 'Download notes' }).waitFor();
    await page.getByRole('button', { name: 'Reconnect Google Calendar' }).waitFor();
    assert.equal(await page.locator('[data-field="consent"]').inputValue(), 'ask');
    assert.equal(await page.getByRole('button', { name: 'Send notes to Notion' }).count(), 0);
    assert.deepEqual(await page.evaluate(() => window.fixtureScheduleMessages), []);
    await page.getByRole('button', { name: 'Disconnect calendar' }).click();
    await page.getByRole('button', { name: 'Connect Google Calendar' }).waitFor();

    await page.goto(origin + '/record?mode=meeting');
    await page.getByRole('button', { name: 'Start recording' }).waitFor();
    await page.locator('#sign-out').waitFor();
    await page.evaluate(async () => {
      const { library, C, publisher, store } = window.__reel;
      window.fixtureResumed = [];
      publisher.publish = (row, { expectedOwnerUID } = {}) => {
        window.fixtureResumed.push([row.recordingOwnerUID, expectedOwnerUID]);
        return Promise.resolve(true);
      };
      for (const uid of ['outside', 'other']) {
        const row = C.newRecording({ title: `Video for ${uid}`, createdAt: new Date(), upload: 'localOnly' });
        row.recordingNonce = C.newRecordingNonce();
        row.shareID = await C.ownerShareID(uid, row.recordingNonce);
        row.recordingOwnerUID = uid;
        row.captureState = 'finalizing';
        row.transcriptStatus = 'none';
        await library.update(row);
        await store.putFile(row.id, C.File.video, new Blob(['fixture'], {type: 'video/mp4'}));
        const pending = {...row, id: crypto.randomUUID(), title: `Pending for ${uid}`, captureState: 'complete', upload: 'pending'};
        pending.recordingNonce = C.newRecordingNonce();
        pending.shareID = await C.ownerShareID(uid, pending.recordingNonce);
        await library.update(pending);
      }
    });
    await page.evaluate(() => window.setFakeUser('outside'));
    await page.getByRole('button', { name: 'Video for outside' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Video for other' }).count(), 0);
    await page.waitForFunction(() => window.fixtureResumed.length > 0);
    assert.deepEqual(await page.evaluate(() => window.fixtureResumed), [['outside', 'outside']]);
    const captureStates = () => page.evaluate(() => Object.fromEntries(window.__reel.library.list()
      .filter(row => row.title.startsWith('Video for')).map(row => [row.recordingOwnerUID, row.captureState])));
    assert.deepEqual(await captureStates(), { outside: 'recovered', other: 'finalizing' });
    await page.evaluate(() => window.setFakeUser('other'));
    await page.getByRole('button', { name: 'Video for other' }).waitFor();
    await page.waitForFunction(() => window.fixtureResumed.length > 1);
    assert.deepEqual(await page.evaluate(() => window.fixtureResumed), [['outside', 'outside'], ['other', 'other']]);
    assert.deepEqual(await captureStates(), { outside: 'recovered', other: 'recovered' });
    assert.equal(await page.getByRole('button', { name: 'Video for outside' }).count(), 0);
    await page.locator('#sign-out').click();
    await page.locator('#sign-in').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Video for other' }).count(), 0);
    assert.equal(legacyDeliveryCalls, 0);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});

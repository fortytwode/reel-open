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

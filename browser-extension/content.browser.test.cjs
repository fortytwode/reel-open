const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const extensionDir = __dirname;
const playwrightEntry = process.env.REEL_PLAYWRIGHT_MODULE || pathToFileURL(path.resolve(__dirname, '../firebase/tests/node_modules/playwright/index.mjs')).href;
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
const configuredManifest = { ...manifest, homepage_url: 'https://record.northwind.example' };

async function loadMeetingScripts(page, extensionManifest = configuredManifest) {
  await page.evaluate(value => { window.chrome = { runtime: { getManifest: () => value } }; }, extensionManifest);
  for (const script of manifest.content_scripts[0].js) {
    await page.addScriptTag({ path: path.join(extensionDir, script) });
  }
}

test('classic content scripts prompt only before joining and persist Not now per tab session', async () => {
  const { chromium } = await import(playwrightEntry);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const fixture = '<!doctype html><html><body><main>Meet preview <button>Join now</button></main></body></html>';
    await page.route('https://meet.google.com/**', route => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: fixture,
    }));
    await page.goto('https://meet.google.com/abc-defg-hij');
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await loadMeetingScripts(page);
    const prompt = page.getByRole('dialog', { name: 'Reel meeting prompt' });
    await prompt.waitFor({ state: 'visible' });
    await prompt.getByRole('button', { name: 'Not now' }).click();
    await assert.rejects(() => prompt.waitFor({ state: 'visible', timeout: 600 }), /Timeout/);

    // A real reload keeps sessionStorage for this tab and must honor dismissal.
    await page.reload();
    await loadMeetingScripts(page);
    await assert.rejects(() => prompt.waitFor({ state: 'visible', timeout: 600 }), /Timeout/);
    assert.deepEqual(errors, [], 'classic script sequence must not produce runtime errors');
    await context.close();
  } finally {
    await browser.close();
  }
});

test('an already joined visible meeting hides or suppresses the prompt', async () => {
  const { chromium } = await import(playwrightEntry);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route('https://meet.google.com/**', route => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><body><button aria-label="Leave call">Leave</button></body></html>',
    }));
    await page.goto('https://meet.google.com/abc-defg-hij');
    await loadMeetingScripts(page);
    await assert.rejects(() => page.getByRole('dialog', { name: 'Reel meeting prompt' }).waitFor({ state: 'visible', timeout: 700 }), /Timeout/);

    // Simulate a page transitioning into its active call after the banner appeared.
    await page.locator('button').evaluate(button => button.remove());
    await page.waitForSelector('#reel-meeting-prompt', { state: 'visible', timeout: 1500 });
    await page.locator('body').evaluate(body => body.insertAdjacentHTML('beforeend', '<button aria-label="Leave meeting">Leave</button>'));
    await page.waitForSelector('#reel-meeting-prompt', { state: 'detached', timeout: 1500 });
    await context.close();
  } finally {
    await browser.close();
  }
});

test('current Google Meet /meet/code prompts and sends only the requested link to the configured recorder', async () => {
  const { chromium } = await import(playwrightEntry);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route('https://meet.google.com/meet/**', route => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><body><button>Join now</button></body></html>',
    }));
    await page.goto('https://meet.google.com/meet/jrf-rewx-zea?authuser=2');
    await page.evaluate(() => { window.open = url => { window.openedRecordURL = url; }; });
    await loadMeetingScripts(page);
    const prompt = page.getByRole('dialog', { name: 'Reel meeting prompt' });
    await prompt.getByRole('button', { name: 'Allow' }).click();
    const request = new URL(await page.evaluate(() => window.openedRecordURL));
    assert.equal(request.origin, configuredManifest.homepage_url);
    assert.equal(request.pathname, '/record');
    assert.deepEqual(JSON.parse(new URLSearchParams(request.hash.slice(1)).get('meeting-request')), {
      provider: 'google-meet', url: 'https://meet.google.com/jrf-rewx-zea?authuser=2',
    });
    await context.close();
  } finally {
    await browser.close();
  }
});

test('the generic unpacked extension suppresses cloud prompts without a configured recorder', async () => {
  const { chromium } = await import(playwrightEntry);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://meet.google.com/**', route => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><body><button>Join now</button></body></html>',
    }));
    await page.goto('https://meet.google.com/abc-defg-hij');
    await loadMeetingScripts(page, manifest);
    await assert.rejects(() => page.locator('#reel-meeting-prompt').waitFor({ state: 'visible', timeout: 700 }), /Timeout/);
  } finally {
    await browser.close();
  }
});

test('relay accepts schedule metadata only from the configured origin and recorder path', async () => {
  const { chromium } = await import(playwrightEntry);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://record.northwind.example/**', route => route.fulfill({
      status: 200, contentType: 'text/html', body: '<!doctype html><title>Mock Recorder</title>',
    }));
    for (const [route, expected] of [['/record', 1], ['/notetaker', 1], ['/record-other', 0], ['/notetaker-other', 0]]) {
      await page.goto(`${configuredManifest.homepage_url}${route}`);
      await page.evaluate(value => {
        window.relayed = [];
        window.chrome = { runtime: { getManifest: () => value, sendMessage: message => window.relayed.push(message) } };
      }, configuredManifest);
      await page.addScriptTag({ path: path.join(extensionDir, 'organization.js') });
      await page.addScriptTag({ path: path.join(extensionDir, 'reel-relay.js') });
      const count = await page.evaluate(() => {
        const data = { type: 'REEL_MEETING_SCHEDULE', uid: 'user-a', consent_mode: 'ask', events: [] };
        for (const origin of ['https://elsewhere.example', location.origin]) {
          window.dispatchEvent(new MessageEvent('message', { source: window, origin, data }));
        }
        return window.relayed.length;
      });
      assert.equal(count, expected);
    }
  } finally {
    await browser.close();
  }
});

test('manifest permissions cover each parser-supported provider path and no unrelated origins', () => {
  assert.equal(manifest.homepage_url, undefined);
  assert.equal(manifest.content_scripts.length, 1);
  assert.deepEqual(manifest.host_permissions, manifest.content_scripts[0].matches);
  assert.ok(!manifest.host_permissions.some(pattern => pattern.includes('<all_urls>') || pattern.includes('/*/')));
  for (const pathPattern of ['/j/*', '/wc/*', '/l/meetup-join/*', '/meet/*']) {
    assert.ok(manifest.host_permissions.some(pattern => pattern.endsWith(pathPattern)), `missing ${pathPattern}`);
  }
});

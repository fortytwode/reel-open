// Run with `REEL_BROWSER_CHANNEL=chrome node --test firebase/tests/recorder-meeting-modes.test.mjs`.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright";

const web = new URL("../../web/", import.meta.url);
const origin = "http://localhost:55202";

test("web recorder separates device capture from bot entry and requires consent", async (t) => {
  const browser = await chromium.launch({
    channel: process.env.REEL_BROWSER_CHANNEL,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  });
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: "block" });
  // Load the actual web files in Chromium. Keep organization auth and all remote requests out of this test.
  await context.route(/^https?:\/\//, async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === "/organization.json") return route.fulfill({ status: 404 });
    const file = url.pathname === "/record" ? "record.html" : url.pathname.slice(1);
    const contentType = /\.m?js$/.test(file) ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html";
    const body = await readFile(new URL(file, web)).catch(() => null);
    return body ? route.fulfill({ contentType, body }) : route.fulfill({ status: 404 });
  });

  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.addInitScript(() => {
    window.capturePickerCalls = 0;
    navigator.mediaDevices.getDisplayMedia = async () => {
      window.capturePickerCalls++;
      throw new DOMException("Capture picker simulated by smoke test", "NotAllowedError");
    };
  });
  const kind = page.locator("#recording-kind");
  const methods = page.locator("#meeting-capture-mode");
  const device = page.locator("#meeting-method-device");
  const bot = page.locator("#meeting-method-bot");
  const consent = page.locator("#meeting-recording-consent");
  const notes = page.locator("#meeting-process-notes");
  const setup = page.locator("#meeting-setup");
  const calendar = page.locator("#meeting-calendar-panel");
  const start = page.locator("#start");

  async function open(path) {
    await page.goto(origin + path);
    await page.waitForFunction(() => !!window.__reel);
  }

  await open("/record");
  assert.ok(await methods.isHidden() && await start.isVisible() && await start.isEnabled(), "screen recording remains available");
  await open("/record?mode=meeting");
  assert.ok(await device.isChecked() && await setup.isVisible() && await start.isDisabled(), "direct meeting link opens gated device capture");
  await kind.selectOption("recording");
  assert.ok(await methods.isHidden() && await start.isEnabled(), "switching back to screen recording restores its normal controls");
  await kind.selectOption("meeting");
  assert.match(await methods.innerText(), /Record on this device/);
  assert.ok(await device.isChecked() && await setup.isVisible() && await calendar.isHidden(), "meeting defaults to device capture");
  assert.ok(await consent.isVisible() && !(await consent.isChecked()) && await start.isDisabled(), "local capture starts gated");
  assert.ok(!(await notes.isChecked()), "cloud notes start off");
  await page.keyboard.press("Control+Alt+r");
  assert.equal(await page.evaluate(() => window.capturePickerCalls), 0, "keyboard shortcut cannot bypass the consent gate");
  await consent.check();
  assert.ok(await start.isEnabled(), "affirming consent enables local capture");
  await page.keyboard.press("Control+Alt+r");
  await page.waitForFunction(() => window.capturePickerCalls === 1 && window.__reel.state().phase === "idle");
  await notes.check();
  await start.click();
  assert.match(await page.locator("#toast").innerText(), /Sign in with your organization account/);
  assert.equal(await page.evaluate(() => window.capturePickerCalls), 1, "signed-out cloud processing does not open the picker");

  await bot.check();
  assert.ok(await calendar.isVisible() && await setup.isHidden() && await start.isHidden(), "bot entry displays the calendar with no local Start button");
  await page.keyboard.press("Control+Alt+r");
  assert.equal(await page.evaluate(() => window.capturePickerCalls), 1, "keyboard shortcut does not start local capture in bot mode");
  await device.check();
  assert.ok(await start.isVisible() && await start.isDisabled() && await calendar.isHidden() && !(await notes.isChecked()), "returning to device capture requires fresh choices");

  await open("/record?mode=meeting");
  assert.ok(await device.isChecked() && await setup.isVisible() && await start.isDisabled(), "direct meeting link opens gated device capture");
  const extensionRequest = encodeURIComponent(JSON.stringify({ url: "https://meet.google.com/abc-defg-hij", title: "Planning" }));
  await open(`/record#meeting-request=${extensionRequest}`);
  assert.ok(await bot.isChecked() && await calendar.isVisible() && await start.isHidden(), "extension meeting request defaults to bot entry");

  await device.check();
  const inboundRequest = encodeURIComponent(JSON.stringify({ url: "https://meet.google.com/lmn-opqr-stu", title: "Same-tab follow-up" }));
  await page.evaluate(request => { location.hash = `meeting-request=${request}`; }, inboundRequest);
  await calendar.locator("[data-browser]").getByText("Same-tab follow-up", { exact: false }).waitFor();
  assert.ok(await bot.isChecked() && await start.isHidden(), "a later same-tab request opens bot entry");
  assert.equal(new URL(page.url()).hash, "", "the request fragment is consumed");
});

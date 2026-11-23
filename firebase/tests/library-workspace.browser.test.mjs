import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';

const web = new URL('../../web/', import.meta.url).pathname;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  let path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/reel') {
    const html = (await readFile(join(web, 'library.html'), 'utf8')).replace('<head>', '<head><base href="/reel/assets/">');
    res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(html);
  }
  if (path === '/notetaker') path = '/notetaker.html';
  path = path.replace(/^\/reel\/assets\//, '/');
  if (path === '/organization.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ allowedEmailDomain:'rocketshiphq.com', bucket:'example.test', authDomain:'example.test', projectID:'example-test', apiKey:'test', viewerPath:'v', firestoreDatabase:'reel', viewerBase:'https://example.test', webBase:'https://example.test', speechServiceURL:'https://speech.example.test', deliveryServiceURL:'https://delivery.example.test', meetingServiceURL:'https://meetings.example.test', notesBaseURL:'https://example.test/library' }));
  }
  try { const body = await readFile(join(web, path)); res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
});

test('Mission Control calendar stays in the workspace and clears on sign out', async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless:true, executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  try {
    const page = await browser.newPage();
    await page.route('**/reel/firebase.js*', route => route.fulfill({ contentType:'text/javascript', body:`
      export const FB_CDN='https://sdk.example.test/', CLOUD_CONFIG={firestoreDatabase:'reel'}, EMU=false, googleAccountLabel='a work account';
      const user={uid:'owner',email:'owner@rocketshiphq.com',emailVerified:true,getIdToken:async()=> 'token'};
      const auth={currentUser:user}; const am={signOut:async()=>{auth.currentUser=null; window.reelAuth(null,null)}, signInWithPopup:async()=>{}};
      export const loadAuth=async()=>({auth,am}); export const observeReelAccount=(_am,_auth,cb)=>{window.reelAuth=cb;cb(user,user)};
      export const sessionSnapshot=u=>u&&({uid:u.uid,email:u.email,getIdToken:()=>u.getIdToken()}); export const googleSignInProvider=()=>({});
    ` }));
    await page.route('https://sdk.example.test/firebase-firestore.js', route => route.fulfill({contentType:'text/javascript',body:`
      export const getFirestore=()=>({}); export const collection=(...x)=>x; export const query=x=>x;
      export const orderBy=()=>null; export const onSnapshot=(_q,cb)=>{queueMicrotask(()=>cb({docs:[]}));return ()=>{}};
    `}));
    let syncRequests = 0;
    await page.route('https://meetings.example.test/**', route => {
      if (route.request().url().endsWith('/calendar/sync')) syncRequests++;
      return route.fulfill({json:{events:[],meetings:[],config:{enabled:true,calendar_ids:['primary']},capabilities:{calendar:true,provider:'desktop'}}});
    });
    await page.route('https://delivery.example.test/**', route => route.fulfill({json:{meetings:[],next_cursor:null}}));
    await page.goto(`http://127.0.0.1:${server.address().port}/reel#calendar`);
    await page.locator('#meeting-calendar-panel .mc-card').waitFor();
    assert.equal(new URL(page.url()).pathname, '/reel');
    assert.equal(await page.locator('#view-title').textContent(), 'Meeting calendar');
    assert.equal(await page.locator('#meeting-calendar-panel').isVisible(), true);
    await page.locator('#nav-recent').click();
    await page.locator('#meeting-calendar-panel').waitFor({state:'hidden'});
    assert.equal(await page.locator('#meeting-calendar-panel').isHidden(), true);
    assert.equal(await page.locator('#view-title').textContent(), 'Recently viewed videos');
    await page.locator('#nav-calendar').click();
    await page.locator('#meeting-calendar-panel .mc-card').waitFor();
    const sync = page.locator('[data-action="sync"]');
    await sync.waitFor();
    await sync.click();
    await page.waitForTimeout(100);
    assert.equal(syncRequests, 1);
    assert.equal(await page.locator('[data-extension-note] a').getAttribute('href'), 'https://example.test/downloads/reel-meeting-prompt-0.1.1.zip');
    await page.locator('#sign-out').click();
    assert.equal(await page.locator('#meeting-calendar-panel').isHidden(), true);
    assert.match(await page.locator('#status').textContent(), /Sign in/);
    await page.addInitScript(() => Object.defineProperty(navigator, 'platform', {value:'Win32'}));
    await page.goto(`http://127.0.0.1:${server.address().port}/notetaker#meeting-request=${encodeURIComponent(JSON.stringify({url:'https://meet.google.com/abc-defg-hij'}))}`);
    const manual = page.locator('[data-browser] a').filter({hasText:'Capture manually'});
    await manual.waitFor({state:'attached'});
    assert.equal(await manual.getAttribute('href'), 'https://example.test/record?mode=meeting');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});

test('workspace loads against the existing team Hosting auth modules', async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({headless:true, executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  try {
    const page = await browser.newPage();
    await page.route('**/reel/assets/organization.js*', route => route.fulfill({contentType:'text/javascript',body:`
      export const organization={allowedEmailDomain:'rocketshiphq.com',webBase:'https://example.test',viewerBase:'https://example.test',viewerPath:'v',meetingServiceURL:'https://meetings.example.test',deliveryServiceURL:'https://delivery.example.test'};
      export const organizationStorageKey=key=>'legacy:'+key;
    `}));
    await page.route('**/reel/firebase.js*', route => route.fulfill({contentType:'text/javascript',body:`
      export const FB_CDN='https://sdk.example.test/', CLOUD_CONFIG={firestoreDatabase:'reel'}, EMU=false;
      export const isOrganizationEmail=e=>e.endsWith('@rocketshiphq.com');
      const user={uid:'owner',email:'owner@rocketshiphq.com',emailVerified:true,getIdToken:async()=> 'token'};
      const auth={currentUser:user}; const am={onAuthStateChanged:(_a,cb)=>{window.changeAccount=u=>{auth.currentUser=u;cb(u)};cb(user)}};
      export const loadAuth=async()=>({auth,am}); export const sessionSnapshot=u=>u&&({uid:u.uid,email:u.email,getIdToken:()=>u.getIdToken()});
    `}));
    await page.route('https://sdk.example.test/firebase-firestore.js', route => route.fulfill({contentType:'text/javascript',body:`
      export const getFirestore=()=>({});export const collection=(...x)=>x;export const query=x=>x;export const orderBy=()=>null;
      export const onSnapshot=(_q,cb)=>{queueMicrotask(()=>cb({docs:[]}));return ()=>{}};
    `}));
    await page.route('https://meetings.example.test/**', route => route.fulfill({json:{events:[],meetings:[],capabilities:{calendar:true}}}));
    await page.route('https://delivery.example.test/**', route => route.fulfill({json:{meetings:[],next_cursor:null}}));
    await page.goto(`http://127.0.0.1:${server.address().port}/reel#calendar`);
    await page.locator('#meeting-calendar-panel .mc-card').waitFor();
    assert.equal(await page.locator('#account').textContent(), 'owner@rocketshiphq.com');
    await page.evaluate(() => window.changeAccount({uid:'other',email:'other@example.com',emailVerified:true}));
    assert.equal(await page.locator('#account').textContent(), '');
    assert.equal(await page.locator('#meeting-calendar-panel').isHidden(), true);
    await page.evaluate(() => window.changeAccount({uid:'unverified',email:'owner@rocketshiphq.com',emailVerified:false}));
    assert.equal(await page.locator('#account').textContent(), '');
    assert.equal(await page.locator('#meeting-calendar-panel').isHidden(), true);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});

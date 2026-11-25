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
  if (path === '/recorder' || path === '/notetaker-page') {
    const metas = '<base href="/reel/assets/"><meta name="reel-recorder-url" content="/recorder"><meta name="reel-notetaker-url" content="/notetaker-page">';
    const html = (await readFile(join(web, path === '/recorder' ? 'library.html' : 'notetaker-meetings.html'), 'utf8')).replace('<head>', '<head>' + metas);
    res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(html);
  }
  if (path === '/reel/notetaker') {
    const html = (await readFile(join(web, 'notetaker-meetings.html'), 'utf8')).replace('<head>', '<head><base href="/reel/assets/">');
    res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(html);
  }
  if (path === '/notetaker') path = '/notetaker.html';
  if (path === '/notetaker-meetings') path = '/notetaker-meetings.html';
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
    // Reel Recorder's library holds recordings only: meeting links move to Reel Notetaker.
    await page.route('https://example.test/notetaker-meetings', route => route.fulfill({contentType:'text/html', body:'<title>moved</title>'}));
    await page.goto(`http://127.0.0.1:${server.address().port}/reel#meetings/reel_${'a'.repeat(64)}`);
    await page.waitForURL(`https://example.test/notetaker-meetings#meetings/reel_${'a'.repeat(64)}`);
    await page.goto(`http://127.0.0.1:${server.address().port}/reel`);
    await page.locator('#nav-library').waitFor();
    assert.equal(await page.title(), 'Screen recordings · Reel Recorder');
    assert.equal(await page.locator('#nav-meetings').isVisible(), false);
    assert.equal(await page.locator('#nav-calendar').isVisible(), false);
    assert.equal(await page.locator('#other-product').getAttribute('href'), 'https://example.test/notetaker-meetings');

    // A host that proxies only the library switches to Notetaker in place and keeps its sign-in.
    const hosted = `http://127.0.0.1:${server.address().port}`;
    const organization = await (await page.request.get(`${hosted}/organization.json`)).json();
    await page.route('**/organization.json', route => route.fulfill({ json: { ...organization, notesBaseURL: `${hosted}/reel` } }));
    await page.goto('about:blank');
    await page.goto(`${hosted}/reel#meetings`);
    await page.locator('#nav-meetings[aria-current="page"]').waitFor();
    assert.equal(new URL(page.url()).pathname, '/reel');
    assert.equal(await page.title(), 'Meetings · Reel Notetaker');
    assert.equal(await page.locator('.brand').textContent(), '● Reel Notetaker');
    assert.equal(await page.locator('#nav-library').isVisible(), false);
    assert.equal(await page.locator('#other-product').getAttribute('href'), `${hosted}/reel#library`);
    await page.locator('#other-product').click();
    await page.locator('#nav-library[aria-current="page"]').waitFor();
    assert.equal(await page.title(), 'Screen recordings · Reel Recorder');
    assert.equal(await page.locator('#nav-meetings').isVisible(), false);
    assert.equal(await page.locator('#other-product').getAttribute('href'), `${hosted}/reel#meetings`);
    await page.unroute('**/organization.json');
    await page.goto('about:blank');

    await page.goto(`http://127.0.0.1:${server.address().port}/reel/notetaker#calendar`);
    await page.locator('#meeting-calendar-panel .mc-card').waitFor();
    assert.equal(new URL(page.url()).pathname, '/reel/notetaker');
    assert.equal(await page.locator('#view-title').textContent(), 'Meeting calendar');
    assert.equal(await page.title(), 'Meeting calendar · Reel Notetaker');
    assert.equal(await page.locator('#meeting-calendar-panel').isVisible(), true);
    for (const id of ['#nav-library', '#nav-recent', '#nav-pinned', '#nav-archive', '.record-options']) {
      assert.equal(await page.locator(id).isVisible(), false, id);
    }
    await page.locator('#nav-meetings').click();
    await page.locator('#meeting-calendar-panel').waitFor({state:'hidden'});
    assert.equal(await page.locator('#meeting-calendar-panel').isHidden(), true);
    assert.equal(await page.locator('#view-title').textContent(), 'Meetings');
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

test('a host with one address per product keeps each page on its own address', async () => {
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
    const hosted = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${hosted}/recorder`);
    await page.locator('#nav-library[aria-current="page"]').waitFor();
    assert.equal(await page.title(), 'Screen recordings · Reel Recorder');
    assert.equal(await page.locator('#nav-meetings').isVisible(), false);
    assert.equal(await page.locator('#other-product').getAttribute('href'), `${hosted}/notetaker-page`);
    // Old meeting links that land on the Recorder page move to the Notetaker page.
    await page.goto('about:blank');
    await page.goto(`${hosted}/recorder#meetings`);
    await page.waitForURL(`${hosted}/notetaker-page#meetings`);
    await page.locator('#nav-meetings[aria-current="page"]').waitFor();
    assert.equal(await page.title(), 'Meetings · Reel Notetaker');
    assert.equal(await page.locator('.brand').getAttribute('href'), `${hosted}/notetaker-page`);
    assert.equal(await page.locator('#other-product').getAttribute('href'), `${hosted}/recorder`);
    assert.equal(await page.locator('.workspace').isVisible(), false);
    await page.locator('#nav-calendar').click();
    await page.locator('#meeting-calendar-panel .mc-card').waitFor();
    assert.equal(new URL(page.url()).pathname, '/notetaker-page');
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
    await page.goto(`http://127.0.0.1:${server.address().port}/reel/notetaker#calendar`);
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

test('Notetaker joins an upcoming call on request and answers questions with sources', async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless:true, executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  try {
    const page = await browser.newPage();
    await page.route('**/reel/firebase.js*', route => route.fulfill({ contentType:'text/javascript', body:`
      export const FB_CDN='https://sdk.example.test/', CLOUD_CONFIG={firestoreDatabase:'reel'}, EMU=false, googleAccountLabel='a work account';
      const user={uid:'owner',email:'owner@rocketshiphq.com',emailVerified:true,getIdToken:async()=> 'token'};
      const auth={currentUser:user}; const am={signOut:async()=>{}, signInWithPopup:async()=>{}};
      export const loadAuth=async()=>({auth,am}); export const observeReelAccount=(_am,_auth,cb)=>{cb(user,user)};
      export const sessionSnapshot=u=>u&&({uid:u.uid,email:u.email,getIdToken:()=>u.getIdToken()}); export const googleSignInProvider=()=>({});
    ` }));
    await page.route('https://sdk.example.test/firebase-firestore.js', route => route.fulfill({contentType:'text/javascript',body:`
      export const getFirestore=()=>({}); export const collection=(...x)=>x; export const query=x=>x;
      export const orderBy=()=>null; export const onSnapshot=(_q,cb)=>{queueMicrotask(()=>cb({docs:[]}));return ()=>{}};
    `}));
    const soon = new Date(Date.now() + 5 * 60000), later = new Date(Date.now() + 35 * 60000);
    const eventId = 'e'.repeat(64);
    const joins = [];
    await page.route('https://meetings.example.test/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === `/calendar/meetings/${eventId}/join`) { joins.push(route.request().headers().authorization); return route.fulfill({json:{url:'https://meet.example.test/abc'}}); }
      return route.fulfill({json:{meetings:[{id:eventId,title:'Client sync',start:soon.toISOString(),end:later.toISOString(),status:'scheduled',attendees:['ana@rocketshiphq.com'],response:'tentative'}],
        events:[],config:{enabled:true,calendar_ids:['primary']},capabilities:{calendar:true}}});
    });
    const note = {id:'reel_'+'a'.repeat(64),title:'Peak weekly',started_at:'2026-11-25T10:00:00Z',attendees:['ana@rocketshiphq.com'],summary:'Outcome\nBudgets hold.',duration_seconds:1800};
    const asked = [];
    await page.route('https://delivery.example.test/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/delivery/ask') { asked.push(route.request().postDataJSON()); return route.fulfill({json:{answer:'Budgets hold for December.\n- Revisit in January',citations:[{id:note.id,title:'Peak weekly',started_at:note.started_at}]}}); }
      if (url.pathname === '/delivery/search') return route.fulfill({json:{results:[]}});
      if (url.pathname === '/delivery/folders') return route.fulfill({json:{folders:[]}});
      return route.fulfill({json:{meetings:[note],next_cursor:null}});
    });
    await page.context().route('https://meet.example.test/**', route => route.fulfill({contentType:'text/html', body:'<title>meeting</title>'}));
    await page.goto(`http://127.0.0.1:${server.address().port}/reel/notetaker#meetings`);
    const join = page.getByRole('button', { name: 'Join' });
    await join.waitFor();
    assert.equal(await page.locator('.nt-maybe').first().textContent(), 'Maybe');
    const [tab] = await Promise.all([page.context().waitForEvent('page'), join.click()]);
    await tab.waitForURL('https://meet.example.test/abc');
    assert.deepEqual(joins, ['Bearer token']);
    await page.getByRole('button', { name: 'What did we decide about budgets recently?' }).click();
    await page.locator('.nt-answer li').waitFor();
    assert.deepEqual(asked, [{ question: 'What did we decide about budgets recently?' }]);
    assert.equal(await page.locator('.nt-answer p').first().textContent(), 'Budgets hold for December.');
    assert.equal(await page.locator('.nt-answer li').textContent(), 'Revisit in January');
    assert.equal(await page.locator('.nt-answer a').getAttribute('href'), `http://127.0.0.1:${server.address().port}/reel/notetaker#meetings/${note.id}`);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});

test('Notetaker creates an AI connection key once and shows how to add it', async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless:true, executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  try {
    const page = await browser.newPage();
    await page.route('**/reel/firebase.js*', route => route.fulfill({ contentType:'text/javascript', body:`
      export const FB_CDN='https://sdk.example.test/', CLOUD_CONFIG={firestoreDatabase:'reel'}, EMU=false, googleAccountLabel='a work account';
      const user={uid:'owner',email:'owner@rocketshiphq.com',emailVerified:true,getIdToken:async()=> 'token'};
      const auth={currentUser:user}; const am={signOut:async()=>{}, signInWithPopup:async()=>{}};
      export const loadAuth=async()=>({auth,am}); export const observeReelAccount=(_am,_auth,cb)=>{cb(user,user)};
      export const sessionSnapshot=u=>u&&({uid:u.uid,email:u.email,getIdToken:()=>u.getIdToken()}); export const googleSignInProvider=()=>({});
    ` }));
    await page.route('https://sdk.example.test/firebase-firestore.js', route => route.fulfill({contentType:'text/javascript',body:`
      export const getFirestore=()=>({}); export const collection=(...x)=>x; export const query=x=>x;
      export const orderBy=()=>null; export const onSnapshot=(_q,cb)=>{queueMicrotask(()=>cb({docs:[]}));return ()=>{}};
    `}));
    await page.route('https://meetings.example.test/**', route => route.fulfill({json:{meetings:[],events:[],config:{enabled:true,calendar_ids:['primary']},capabilities:{calendar:true}}}));
    let tokens = [];
    await page.route('https://delivery.example.test/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/delivery/mcp-tokens') {
        const body = route.request().method() === 'POST' ? route.request().postDataJSON() : null;
        if (body?.create) { tokens = [{id:'t1',label:body.create,created:1795600000}];
          return route.fulfill({json:{tokens,endpoint:'https://delivery.example.test/mcp',created:{id:'t1',token:'reel_mcp_secret'}}}); }
        if (body?.revoke) { tokens = []; }
        return route.fulfill({json:{tokens,endpoint:'https://delivery.example.test/mcp'}});
      }
      if (url.pathname === '/delivery/prompts') return route.fulfill({json:{mine:[],team:[]}});
      if (url.pathname.endsWith('folders')) return route.fulfill({json:{folders:[]}});
      return route.fulfill({json:{meetings:[],next_cursor:null}});
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/reel/notetaker#connect`);
    await page.getByText('No connections yet.').waitFor();
    assert.equal(await page.locator('#nav-connect[aria-current="page"]').count(), 1);
    await page.locator('#connect-label').fill('Claude on my laptop');
    await page.getByRole('button', { name: 'Create connection key' }).click();
    await page.getByText("Copy it now. For your security it won't be shown again.").waitFor();
    const blocks = await page.locator('.nt-code pre').allTextContents();
    assert.equal(blocks[0], 'reel_mcp_secret');
    assert.equal(blocks[1], 'claude mcp add --transport http reel-notetaker https://delivery.example.test/mcp --header "Authorization: Bearer reel_mcp_secret"');
    await page.getByRole('button', { name: "I've copied it" }).click();
    assert.equal(await page.locator('.nt-code').count(), 0);
    assert.equal(await page.getByText('Claude on my laptop').count(), 1);
    await page.getByRole('button', { name: 'Revoke' }).click();
    await page.getByText('No connections yet.').waitFor();
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});

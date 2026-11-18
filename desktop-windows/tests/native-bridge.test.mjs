import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createNativeBridge } from '../src/native-bridge.mjs';

function fixture() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new PassThrough(); child.kill = () => { child.killed = true; };
  const sent = [];
  child.stdin.on('data', bytes => sent.push(JSON.parse(bytes.toString())));
  const bridge = createNativeBridge({ executable: '/test/ReelNativeJoin.exe', spawn: () => child, timeoutMs: 50 });
  const reply = (request, fields) => child.stdout.write(JSON.stringify({v:1,id:request.id,...fields})+'\n');
  return { bridge, child, sent, reply };
}
test('join accepts only verified helper ownership, and inspect/close use its opaque session', async () => {
  const f=fixture();
  const joined=f.bridge.join({url:'https://meet.google.com/abc-defg-hij',consentConfirmed:true});
  f.reply(f.sent[0],{ok:true,state:'joined',sessionId:'a'.repeat(32),hwnd:'345',pid:42});
  assert.equal((await joined).hwnd,'345');
  const inspected=f.bridge.inspect('a'.repeat(32));
  assert.equal(f.sent[1].op,'inspect');
  f.reply(f.sent[1],{ok:true,state:'in_call'});
  assert.equal((await inspected).state,'in_call');
  const disposed=f.bridge.dispose();
  assert.equal(f.sent[2].op,'close');
  f.reply(f.sent[2],{ok:true,state:'closed'}); await disposed;
});
test('untrusted or incomplete joined responses fail closed', async () => {
  const f=fixture(); const pending=f.bridge.join({url:'https://meet.google.com/abc-defg-hij',consentConfirmed:true});
  f.reply(f.sent[0],{ok:true,state:'joined',sessionId:'a'.repeat(32),hwnd:'screen:0:0',pid:42});
  await assert.rejects(pending,/invalid response/i); assert.equal(f.child.killed,true);
});
test('abort cancels exactly the pending request and closes a late joined response', async () => {
  const f=fixture(), controller=new AbortController();
  const pending=f.bridge.join({url:'https://meet.google.com/abc-defg-hij',consentConfirmed:true,signal:controller.signal});
  const request=f.sent[0]; controller.abort();
  assert.equal(f.sent[1].op,'cancel'); assert.equal(f.sent[1].joinId,request.id);
  f.reply(f.sent[1],{ok:false,state:'not_pending'});
  f.reply(request,{ok:true,state:'joined',sessionId:'a'.repeat(32),hwnd:'345',pid:42});
  let settled=false; pending.finally(()=>{settled=true;}).catch(()=>{});
  await new Promise(resolve=>setImmediate(resolve)); assert.equal(settled,false);
  assert.equal(f.sent[2].op,'close');
  f.reply(f.sent[2],{ok:true,state:'closed'});
  await assert.rejects(pending,/cancelled/i); await f.bridge.dispose();
});
test('responses are bound to the requested operation', async () => {
  const f=fixture(); const joined=f.bridge.join({url:'https://meet.google.com/abc-defg-hij',consentConfirmed:true});
  f.reply(f.sent[0],{ok:true,state:'joined',sessionId:'a'.repeat(32),hwnd:'345',pid:42}); await joined;
  const inspected=f.bridge.inspect('a'.repeat(32));
  f.reply(f.sent[1],{ok:true,state:'joined',sessionId:'b'.repeat(32),hwnd:'678',pid:43});
  await assert.rejects(inspected,/invalid response/i); assert.equal(f.child.killed,true);
});
test('aborted late join preserves unresolved ownership for the main coordinator', async () => {
  const f=fixture(), controller=new AbortController();
  const pending=f.bridge.join({url:'https://meet.google.com/abc-defg-hij',consentConfirmed:true,signal:controller.signal});
  controller.abort(); f.reply(f.sent[1],{ok:false,state:'not_pending'});
  f.reply(f.sent[0],{ok:true,state:'joined',sessionId:'a'.repeat(32),hwnd:'345',pid:42});
  await new Promise(resolve=>setImmediate(resolve));
  f.reply(f.sent[2],{ok:false,state:'close_pending'});
  await assert.rejects(pending,error=>error.code==='owned_window_close_required' && error.sessionId==='a'.repeat(32));
  const retry=f.bridge.close('a'.repeat(32)); f.reply(f.sent[3],{ok:true,state:'closed'}); await retry;
  await f.bridge.dispose();
});
test('shutdown preserves ownership when close fails and supports a confirmed retry', async () => {
  const f=fixture(); const joined=f.bridge.join({url:'https://meet.google.com/abc-defg-hij',consentConfirmed:true});
  f.reply(f.sent[0],{ok:true,state:'joined',sessionId:'a'.repeat(32),hwnd:'345',pid:42}); await joined;
  const disposed=f.bridge.dispose(); f.reply(f.sent[1],{ok:false,state:'close_failed'});
  await assert.rejects(disposed,/close.*meeting window/i); assert.equal(f.child.killed,undefined);
  const retry=f.bridge.dispose(); f.reply(f.sent[2],{ok:true,state:'closed'}); await retry;
  assert.equal(f.child.killed,true);
});
test('invalid URL, consent or unknown session never reaches the helper', async () => {
  const f=fixture();
  await assert.rejects(f.bridge.join({url:'https://evil.test/abc',consentConfirmed:true}));
  await assert.rejects(f.bridge.join({url:'https://meet.google.com/abc-defg-hij',consentConfirmed:false}));
  await assert.rejects(f.bridge.close('a'.repeat(32)));
  assert.equal(f.sent.length,0); f.bridge.dispose();
});
test('helper failure or timeout rejects pending operations without private diagnostics', async () => {
  const f=fixture(); const pending=f.bridge.join({url:'https://meet.google.com/abc-defg-hij',consentConfirmed:true});
  f.child.stderr.write('private URL should never be surfaced'); f.child.emit('exit',1);
  await assert.rejects(pending,/helper unavailable/i);
  const g=fixture();
  await assert.rejects(g.bridge.join({url:'https://meet.google.com/abc-defg-hij',consentConfirmed:true}),/timed out/i);
  assert.equal(g.child.killed,true);
});

test('Google sign-in reaches the helper only for the exact raw HTTPS OAuth endpoint', async () => {
  const f=fixture();
  for (const url of [
    'https://accounts.google.com/o/oauth2/v2/auth?state=abc&scope=openid+email&redirect_uri=http%3A%2F%2F127.0.0.1%3A1234%2Foauthredirect',
    'https://accounts.google.com:443/o/oauth2/v2/auth',
  ]) {
    const opening=f.bridge.openGoogleSignIn(url);
    const request=f.sent.at(-1);
    assert.deepEqual(Object.keys(request).sort(),['id','op','url','v']);
    assert.equal(request.op,'openGoogleSignIn'); assert.equal(request.url,url);
    f.reply(request,{ok:true,state:'browser_opened'});
    assert.equal((await opening).state,'browser_opened');
  }
  const sent=f.sent.length;
  for (const url of [undefined, '', 'https://accounts.google.com/o/oauth2/v2/auth?x='+'a'.repeat(4096),
    'http://accounts.google.com/o/oauth2/v2/auth', 'https://accounts.google.com.evil.test/o/oauth2/v2/auth',
    'https://accounts.google.com./o/oauth2/v2/auth', 'https://accounts.google.com:8443/o/oauth2/v2/auth',
    'https://user@accounts.google.com/o/oauth2/v2/auth', 'https://accounts.google.com/o/oauth2/v2/auth#',
    'https://accounts.google.com/o/oauth2/v2/auth#fragment', 'https://accounts.google.com/o/oauth2/v2/auth/',
    'https://accounts.google.com/o/oauth2/v2/../v2/auth', 'https://accounts.google.com/o/oauth2/v2/%61uth',
    'https://accounts.google.com/O/oauth2/v2/auth', 'https://accounts.google.com/o/oauth2/v2/auth?x="--guest',
    "https://accounts.google.com/o/oauth2/v2/auth?x='", 'https://accounts.google.com/o/oauth2/v2/auth?x=\\',
    ' https://accounts.google.com/o/oauth2/v2/auth', 'https://accounts.google.com/o/oauth2/v2/auth?x=\n',
    'https://accounts.google.com/o/oauth2/v2/auth?x=\u0085'])
    await assert.rejects(f.bridge.openGoogleSignIn(url),/Invalid Google sign-in/);
  assert.equal(f.sent.length,sent); await f.bridge.dispose();
});

test('Google sign-in accepts only its allowlisted result states without meeting ownership', async () => {
  for (const state of ['chrome_unavailable','browser_failed','busy','cancelled','invalid_request']) {
    const f=fixture(); const opening=f.bridge.openGoogleSignIn('https://accounts.google.com/o/oauth2/v2/auth');
    f.reply(f.sent[0],{ok:false,state}); assert.equal((await opening).state,state); await f.bridge.dispose();
  }
  for (const fields of [{ok:true,state:'joined',sessionId:'a'.repeat(32),hwnd:'345',pid:42},
    {ok:false,state:'browser_opened'}, {ok:true,state:'browser_opened',url:'private'},
    {ok:true,state:'browser_opened',sessionId:'a'.repeat(32)}]) {
    const f=fixture(); const opening=f.bridge.openGoogleSignIn('https://accounts.google.com/o/oauth2/v2/auth');
    f.reply(f.sent[0],fields); await assert.rejects(opening,/invalid response/); assert.equal(f.child.killed,true);
  }
});

test('sign-in abort targets only its pending launch and never closes a late browser window', async () => {
  const f=fixture(), controller=new AbortController();
  const opening=f.bridge.openGoogleSignIn('https://accounts.google.com/o/oauth2/v2/auth',{signal:controller.signal});
  controller.abort();
  assert.equal(f.sent[1].op,'cancel'); assert.equal(f.sent[1].joinId,f.sent[0].id);
  f.reply(f.sent[0],{ok:true,state:'browser_opened'});
  f.reply(f.sent[1],{ok:false,state:'not_pending'});
  await assert.rejects(opening,/cancelled/);
  assert.equal(f.sent.length,2); await f.bridge.dispose();
  const g=fixture(); await assert.rejects(g.bridge.openGoogleSignIn('https://accounts.google.com/o/oauth2/v2/auth',{signal:controller.signal}),/cancelled/);
  assert.equal(g.sent.length,0); await g.bridge.dispose();
});

test('shutdown cancels and awaits a pending auth launch without touching browser windows', async () => {
  const f=fixture(); const opening=f.bridge.openGoogleSignIn('https://accounts.google.com/o/oauth2/v2/auth');
  const disposed=f.bridge.dispose();
  assert.equal(f.sent[1].op,'cancel'); assert.equal(f.sent[1].joinId,f.sent[0].id);
  f.reply(f.sent[0],{ok:false,state:'cancelled'});
  await new Promise(resolve=>setImmediate(resolve)); assert.equal(f.child.killed,undefined);
  f.reply(f.sent[1],{ok:true,state:'cancellation_requested'});
  await opening; await disposed;
  assert.equal(f.sent.length,2); assert.equal(f.child.killed,true);
});

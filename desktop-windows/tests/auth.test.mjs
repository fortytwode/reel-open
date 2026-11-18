import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createWindowsAuth } from '../src/auth.mjs';

const clientId = 'desktop-test.apps.googleusercontent.com';
const clientSecret = 'fake-test-value';
const allowedEmailDomain = 'northwind.example';
const apiKey = 'public-test-key';
const email = 'person@northwind.example';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const jwt = (claims) => [
  Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify(claims)).toString('base64url'),
  'fixture-signature'
].join('.');

const firebaseJWT = (claims = {}) => jwt({ aud: 'demo-reel', iss: 'https://securetoken.google.com/demo-reel',
  sub: 'firebase-1', email, email_verified: true, ...claims });

function fixture(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'reel-auth-test-'));
  const storagePath = join(dir, 'private', 'session.enc');
  const opened = deferred();
  const calls = [];
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: plain => Buffer.from(`encrypted:${Buffer.from(plain).toString('base64')}`, 'utf8'),
    decryptString: bytes => {
      const value = bytes.toString('utf8');
      if (!value.startsWith('encrypted:')) throw Error('decrypt failed');
      return Buffer.from(value.slice('encrypted:'.length), 'base64').toString('utf8');
    },
    ...overrides.safeStorage
  };
  let authURL;
  const fetch = overrides.fetch ?? (async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('oauth2.googleapis.com/token')) {
      const nonce = new URL(authURL).searchParams.get('nonce');
      const calendar = new URL(authURL).searchParams.get('scope').includes('calendar.readonly');
      return response({ id_token: jwt({ iss: 'https://accounts.google.com', aud: clientId, sub: 'google-1', nonce, exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000), email, email_verified: true, hd: 'northwind.example', ...overrides.claims }),
        ...(calendar ? { access_token: 'google-calendar-access', refresh_token: 'google-calendar-refresh', expires_in: 3600,
          scope: `openid email profile https://www.googleapis.com/auth/calendar.readonly` } : {}), ...overrides.token });
    }
    if (String(url).includes('signInWithIdp')) return response({ localId: 'firebase-1', email, displayName: 'Person', idToken: firebaseJWT(), refreshToken: 'firebase-refresh', expiresIn: '3600', ...overrides.firebase });
    if (String(url).includes('securetoken')) return response({ user_id: 'firebase-1', id_token: firebaseJWT({ iat: 2 }), refresh_token: 'firebase-refresh-2', expires_in: '3600', ...overrides.refresh });
    throw Error('Unexpected fixture URL');
  });
  const { openExternal = async () => {}, ...options } = overrides.options ?? {};
  const auth = createWindowsAuth({ clientId, clientSecret, apiKey, allowedEmailDomain, projectID: 'demo-reel', storagePath, safeStorage, fetch, ...options,
    openExternal: async (url, context) => { authURL = url; opened.resolve(url); return openExternal(url, context); } });
  return { auth, calls, storagePath, opened, safeStorage, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function callback(authURL, query = {}, path = '/oauthredirect', host) {
  const authorization = new URL(authURL);
  const redirect = new URL(authorization.searchParams.get('redirect_uri'));
  const url = new URL(path, redirect);
  url.searchParams.set('state', authorization.searchParams.get('state'));
  url.searchParams.set('code', 'fixture-code');
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  if (!host) return fetch(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers: { Host: host } }, res => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); });
    req.on('error', reject); req.end();
  });
}

async function signedIn(f, options) {
  const pending = f.auth.signIn(options);
  pending.catch(() => {});
  const url = await f.opened.promise;
  const received = await callback(url);
  assert.equal(received.status, 200);
  assert.equal(await received.text(), '<!doctype html><title>Reel sign-in</title><p>Google response received. Return to Reel to finish signing in.</p>');
  return pending;
}

test('Desktop client value is required and malformed values fail with fixed configuration guidance', t => {
  const f = fixture(); t.after(f.cleanup);
  for (const value of [undefined, null, '', ' ', 'private\nvalue', 'private/value', 'a'.repeat(257), 123, {}]) {
    assert.throws(() => createWindowsAuth({ clientId, clientSecret: value, apiKey, allowedEmailDomain, projectID: 'demo-reel', storagePath: f.storagePath,
      safeStorage: f.safeStorage, fetch: async () => {}, openExternal: async () => {} }),
    cause => cause.code === 'configuration' && cause.message === 'Windows Google sign-in is not configured.');
  }
});

test('Desktop client value is sent only in Google TLS token and refresh bodies', async t => {
  let current = Date.now();
  const f = fixture({ options: { now: () => current }, token: { expires_in: 1 } }); t.after(f.cleanup);
  const profiles = []; f.auth.onStateChange(profile => profiles.push(profile));
  const profile = await signedIn(f, { connectCalendar: true });
  const authorization = await f.opened.promise;
  assert.equal(new URL(authorization).searchParams.has('client_secret'), false);
  assert.equal(authorization.includes(clientSecret), false);
  assert.equal(JSON.stringify(profile).includes(clientSecret), false);
  current += 1000;
  assert.equal(await f.auth.getCalendarAccessToken(), 'google-calendar-access');
  const google = f.calls.filter(call => call.url === 'https://oauth2.googleapis.com/token');
  assert.equal(google.length, 2);
  assert.deepEqual(google.map(call => new URLSearchParams(call.options.body).get('grant_type')), ['authorization_code', 'refresh_token']);
  for (const call of google) {
    assert.equal(new URLSearchParams(call.options.body).get('client_secret'), clientSecret);
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.url.includes(clientSecret), false);
  }
  const firebase = f.calls.filter(call => call.url.startsWith('https://identitytoolkit.googleapis.com/'));
  assert.equal(firebase.length, 1);
  assert.equal(firebase[0].options.body.includes(clientSecret), false);
  assert.equal(firebase[0].options.body.includes('client_secret'), false);
  assert.equal(JSON.stringify(profiles).includes(clientSecret), false);
  assert.equal(JSON.stringify(f.auth.getProfile()).includes(clientSecret), false);
  assert.equal(f.safeStorage.decryptString(readFileSync(f.storagePath)).includes(clientSecret), false);
});

test('desktop PKCE loopback exchanges Google then Firebase and exposes only profile', async t => {
  const f = fixture(); t.after(f.cleanup);
  const states = []; f.auth.onStateChange(profile => states.push(profile));
  const profile = await signedIn(f);
  assert.deepEqual(profile, { userID: 'firebase-1', email, displayName: 'Person', calendarConnected: false });
  assert.deepEqual(f.auth.getProfile(), profile);
  assert.equal(f.auth.getIdToken instanceof Function, true);
  assert.equal(await f.auth.getIdToken(), firebaseJWT());
  const url = new URL(await f.opened.promise);
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('hd'), allowedEmailDomain);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('scope'), 'openid email profile');
  assert.equal(url.searchParams.has('access_type'), false);
  assert.match(url.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(new URL(url.searchParams.get('redirect_uri')).hostname, '127.0.0.1');
  assert.equal(f.calls.length, 2);
  assert.equal(new URL(f.calls[1].url).searchParams.get('key'), apiKey);
  assert.match(f.calls[1].options.body, /providerId=google.com/);
  assert.deepEqual(states, [profile]);
  const stored = readFileSync(f.storagePath, 'utf8');
  assert.ok(stored.startsWith('encrypted:'));
  assert.ok(!stored.includes('firebase-refresh'));
  const restored = fixture({ options: { storagePath: f.storagePath } }); t.after(restored.cleanup);
  assert.deepEqual(restored.auth.load(), profile);
});

test('Calendar permission is requested only through explicit connect and tokens stay encrypted', async t => {
  const f = fixture(); t.after(f.cleanup);
  const profile = await signedIn(f, { connectCalendar: true });
  assert.equal(profile.calendarConnected, true);
  assert.equal(f.auth.hasCalendarAccess(), true);
  assert.equal(await f.auth.getCalendarAccessToken(), 'google-calendar-access');
  const url = new URL(await f.opened.promise);
  assert.ok(url.searchParams.get('scope').includes('https://www.googleapis.com/auth/calendar.readonly'));
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.ok(!readFileSync(f.storagePath, 'utf8').includes('google-calendar-refresh'));
  f.auth.disconnectCalendar();
  assert.equal(f.auth.hasCalendarAccess(), false);
  assert.equal(f.auth.getProfile().calendarConnected, false);
  await assert.rejects(f.auth.getCalendarAccessToken(), /connect/i);
  assert.ok(!f.safeStorage.decryptString(readFileSync(f.storagePath)).includes('google-calendar-refresh'));
});

test('Calendar consent requires granted scope and a refresh token', async t => {
  for (const token of [{ scope: 'openid email profile' }, { refresh_token: '' }]) {
    const f = fixture({ token }); t.after(f.cleanup);
    await assert.rejects(signedIn(f, { connectCalendar: true }), /connect/i);
    assert.equal(f.auth.getProfile(), null);
  }
});

test('fresh Calendar consent may reuse a refresh token only for the same verified Google and Firebase owner', async t => {
  const first = fixture(); t.after(first.cleanup);
  await signedIn(first, { connectCalendar: true });
  const same = fixture({ options: { storagePath: first.storagePath }, token: { refresh_token: '' } }); t.after(same.cleanup);
  same.auth.load();
  assert.equal((await signedIn(same, { connectCalendar: true })).calendarConnected, true);
  const differentGoogle = fixture({ options: { storagePath: first.storagePath }, token: { refresh_token: '' }, claims: { sub: 'google-other' } }); t.after(differentGoogle.cleanup);
  differentGoogle.auth.load();
  await assert.rejects(signedIn(differentGoogle, { connectCalendar: true }), /connect/i);
  const differentFirebase = fixture({ options: { storagePath: first.storagePath }, token: { refresh_token: '' }, firebase: { localId: 'firebase-other', idToken: firebaseJWT({sub:'firebase-other'}) } }); t.after(differentFirebase.cleanup);
  differentFirebase.auth.load();
  await assert.rejects(signedIn(differentFirebase, { connectCalendar: true }), /connect/i);
});

test('invalid Calendar refresh disconnects Calendar while retaining Firebase sign-in', async t => {
  let current = Date.now();
  const f = fixture({ options: { now: () => current }, fetch: async (url, options) => {
    if (String(url).includes('oauth2.googleapis.com/token') && new URLSearchParams(options.body).get('grant_type') === 'refresh_token')
      return response({ error: 'invalid_grant' }, 400);
    if (String(url).includes('oauth2.googleapis.com/token')) {
      const nonce = new URL(await f.opened.promise).searchParams.get('nonce');
      return response({ id_token: jwt({ iss: 'https://accounts.google.com', aud: clientId, sub: 'google-1', nonce, exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000), email, email_verified: true }), access_token: 'old', refresh_token: 'refresh', expires_in: 1, scope: `openid email profile https://www.googleapis.com/auth/calendar.readonly` });
    }
    return response({ localId: 'firebase-1', email, idToken: firebaseJWT(), refreshToken: 'firebase-refresh', expiresIn: '3600' });
  } }); t.after(f.cleanup);
  await signedIn(f, { connectCalendar: true }); current += 1000;
  await assert.rejects(f.auth.getCalendarAccessToken(), /connect/i);
  assert.equal(f.auth.getProfile().calendarConnected, false);
  assert.equal(await f.auth.getIdToken(), firebaseJWT());
});

test('Calendar refresh result cannot survive disconnect', async t => {
  let current = Date.now(); const gate = deferred();
  const f = fixture({ options: { now: () => current }, token: { expires_in: 1 }, fetch: async (url, options) => {
    if (String(url).includes('oauth2.googleapis.com/token') && new URLSearchParams(options.body).get('grant_type') === 'refresh_token') return gate.promise;
    const authorization = new URL(await f.opened.promise);
    if (String(url).includes('oauth2.googleapis.com/token')) return response({ id_token: jwt({ iss: 'https://accounts.google.com', aud: clientId, sub: 'google-1', nonce: authorization.searchParams.get('nonce'), exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000), email, email_verified: true }), access_token: 'old-access', refresh_token: 'old-refresh', expires_in: 1, scope: `openid email profile https://www.googleapis.com/auth/calendar.readonly` });
    return response({ localId: 'firebase-1', email, idToken: firebaseJWT(), refreshToken: 'firebase-refresh', expiresIn: '3600' });
  } }); t.after(f.cleanup);
  await signedIn(f, { connectCalendar: true }); current += 1000;
  const pending = f.auth.getCalendarAccessToken(); await tick();
  f.auth.disconnectCalendar();
  gate.resolve(response({ access_token: 'late', expires_in: 3600 }));
  await assert.rejects(pending, /cancel|stale|account/i);
  assert.equal(f.auth.hasCalendarAccess(), false);
  assert.ok(!f.safeStorage.decryptString(readFileSync(f.storagePath)).includes('old-refresh'));
});

test('callback rejects wrong host, path, duplicate state and wrong state before accepting valid code', async t => {
  const f = fixture(); t.after(f.cleanup);
  const pending = f.auth.signIn(); const url = await f.opened.promise;
  assert.equal((await callback(url, {}, '/wrong')).status, 400);
  assert.equal((await callback(url, {}, '/oauthredirect', 'localhost:1234')).status, 400);
  assert.equal((await callback(url, { state: 'wrong' })).status, 400);
  const authorization = new URL(url);
  const redirect = new URL(authorization.searchParams.get('redirect_uri'));
  redirect.search = `?state=${authorization.searchParams.get('state')}&state=duplicate&code=x`;
  assert.equal((await fetch(redirect)).status, 400);
  assert.equal((await callback(url)).status, 200);
  await pending;
  assert.equal(f.calls.length, 2);
});

test('Google callback metadata is accepted only with one valid state and trusted issuer', async t => {
  const f=fixture(); t.after(()=>{f.auth.cancelSignIn();f.cleanup();});
  const pending=f.auth.signIn(); const url=await f.opened.promise;
  pending.catch(()=>{});
  assert.equal((await callback(url,{iss:'https://attacker.example'})).status,400);
  assert.equal((await callback(url,{scope:'openid email profile',authuser:'0',hd:'northwind.example',prompt:'consent',
    iss:'https://accounts.google.com'})).status,200);
  assert.equal((await pending).userID,'firebase-1');
});

test('exchange failures expose only fixed stage, bounded HTTP status and allowlisted provider codes', async t => {
  const privateDetail = 'private token=fake-token code=fake-code https://private.example/?account=private-person';
  for (const entry of [
    { stage: 'google_token', status: 400, provider: 'invalid_grant', expected: 'google_token HTTP 400 invalid_grant' },
    { stage: 'google_token', status: 401, provider: 'invalid_client', expected: 'google_token HTTP 401 invalid_client' },
    { stage: 'google_token', status: 503, provider: `invalid_grant\n${privateDetail}`, expected: 'google_token HTTP 503 other' },
    { stage: 'google_token', status: `400 ${privateDetail}`, provider: 'unknown-private-error', expected: 'google_token HTTP unknown other' },
    { stage: 'firebase', status: 400, provider: `INVALID_IDP_RESPONSE : ${privateDetail}`, expected: 'firebase HTTP 400 INVALID_IDP_RESPONSE' },
    { stage: 'firebase', status: 403, provider: 'OPERATION_NOT_ALLOWED', expected: 'firebase HTTP 403 OPERATION_NOT_ALLOWED' },
    { stage: 'firebase', status: 401, provider: `INVALID_IDP_RESPONSE_PRIVATE ${privateDetail}`, expected: 'firebase HTTP 401 other' },
    { stage: 'firebase', status: 700, provider: privateDetail, expected: 'firebase HTTP unknown other' }
  ]) {
    const body = { error: entry.stage === 'google_token' ? entry.provider : { message: entry.provider },
      error_description: privateDetail, error_uri: `https://private.example/?code=${privateDetail}`, id_token: privateDetail };
    const f = fixture({ fetch: async url => {
      if (String(url).includes('oauth2.googleapis.com/token') && entry.stage === 'firebase') {
        const nonce = new URL(await f.opened.promise).searchParams.get('nonce');
        return response({ id_token: jwt({ iss: 'https://accounts.google.com', aud: clientId, sub: 'google-1', nonce,
          exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000), email, email_verified: true }) });
      }
      return response(body, entry.status);
    } }); t.after(f.cleanup);
    await assert.rejects(signedIn(f), cause => {
      const prefix = entry.stage === 'google_token' ? 'Google' : 'Firebase';
      assert.equal(cause.message, `${prefix} sign-in could not be completed. (${entry.expected})`);
      assert.ok(cause.message.length < 160);
      return cause.code === (entry.stage === 'google_token' ? 'exchange' : 'firebase');
    });
    assert.equal(f.auth.getProfile(), null);
    assert.equal(existsSync(f.storagePath), false);
  }
});

test('wrong nonce, Google domain, Firebase domain and Firebase account are rejected before session creation', async t => {
  for (const overrides of [
    { claims: { nonce: 'wrong' } },
    { claims: { email: 'person@evilnorthwind.example' } },
    { firebase: { email: 'person@elsewhere.com' } },
    { firebase: { email: 'other@northwind.example' } }
  ]) {
    const f = fixture(overrides); t.after(f.cleanup);
    await assert.rejects(signedIn(f), /auth|identity|account|domain/i);
    assert.equal(f.auth.getProfile(), null);
    assert.equal(existsSync(f.storagePath), false);
  }
});

test('Google issuer, audience and token times are bound before Firebase exchange', async t => {
  const now = Math.floor(Date.now() / 1000);
  for (const claims of [
    { iss: 'https://accounts.example.com' }, { aud: 'other.apps.googleusercontent.com' },
    { exp: now - 1 }, { iat: now + 120 }
  ]) {
    const f = fixture({ claims }); t.after(f.cleanup);
    await assert.rejects(signedIn(f), /identity/i);
    assert.equal(f.calls.length, 1);
  }
});

test('credential POSTs refuse redirects and cross-origin final responses', async t => {
  for (const stage of ['google', 'firebase']) {
    const seen = [];
    const f = fixture({ fetch: async (url, options) => {
      seen.push({ url: String(url), options });
      const nonce = new URL(await f.opened.promise).searchParams.get('nonce');
      if (String(url).includes('oauth2.googleapis.com/token')) {
        const token = { id_token: jwt({ iss: 'https://accounts.google.com', aud: clientId, sub: 'google-1', nonce,
          exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000), email, email_verified: true }) };
        return stage === 'google' ? { ...response(token), redirected: true, url: 'https://elsewhere.example/token' } : response(token);
      }
      return { ...response({ localId: 'firebase-1', email, idToken: 'id', refreshToken: 'refresh', expiresIn: '3600' }),
        url: 'https://elsewhere.example/account' };
    } }); t.after(f.cleanup);
    await assert.rejects(signedIn(f), cause => cause?.code === 'network');
    assert.equal(f.auth.getProfile(), null);
    assert.ok(seen.every(call => call.options.redirect === 'error'));
  }
});

test('Firebase refresh refuses redirect without discarding a valid signed-in profile', async t => {
  let current = Date.now(); const seen = [];
  const f = fixture({ options: { now: () => current }, fetch: async (url, options) => {
    seen.push(options);
    if (String(url).includes('securetoken')) return { ...response({ user_id: 'firebase-1', id_token: 'late', refresh_token: 'late-refresh', expires_in: '3600' }), redirected: true, url: 'https://elsewhere.example/token' };
    if (String(url).includes('oauth2.googleapis.com/token')) {
      const nonce = new URL(await f.opened.promise).searchParams.get('nonce');
      return response({ id_token: jwt({ iss: 'https://accounts.google.com', aud: clientId, sub: 'google-1', nonce,
        exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000), email, email_verified: true }) });
    }
    return response({ localId: 'firebase-1', email, idToken: firebaseJWT(), refreshToken: 'refresh', expiresIn: '1' });
  } }); t.after(f.cleanup);
  await signedIn(f); current += 1000;
  await assert.rejects(f.auth.getIdToken(), cause => cause?.code === 'network');
  assert.equal(f.auth.getProfile().userID, 'firebase-1');
  assert.ok(seen.every(options => options.redirect === 'error'));
});

test('cancel and timeout close loopback and prevent late results', async t => {
  const f = fixture(); t.after(f.cleanup);
  const pending = f.auth.signIn(); const url = await f.opened.promise;
  f.auth.cancelSignIn();
  await assert.rejects(pending, /cancel/i);
  await assert.rejects(callback(url), /fetch failed|ECONNREFUSED/i);
  const short = fixture({ options: { timeoutMs: 30 } }); t.after(short.cleanup);
  await assert.rejects(short.auth.signIn(), /timed out/i);
});

test('the flow deadline bounds a stalled token exchange', async t => {
  const never = new Promise(() => {});
  const f = fixture({ options: { timeoutMs: 30 }, fetch: async () => never }); t.after(f.cleanup);
  const pending = f.auth.signIn(); const url = await f.opened.promise;
  await callback(url);
  await assert.rejects(pending, /timed out/i);
  assert.equal(f.auth.getProfile(), null);
});

test('a validated callback completes sign-in despite a pending opener that later fails', async t => {
  const opener = deferred(); let signal;
  const f = fixture({ options: { openExternal: (_url, context) => { signal = context.signal; return opener.promise; } } });
  t.after(f.cleanup);
  const pending = f.auth.signIn(); pending.catch(() => {});
  const url = await f.opened.promise;
  assert.equal((await callback(url)).status, 200);
  opener.reject(Object.assign(Error('late window observation failure'), { code: 'browser_failed' }));
  const profile = await pending;
  assert.equal(profile.userID, 'firebase-1');
  assert.deepEqual(f.auth.getProfile(), profile);
  assert.equal(f.calls.length, 2);
  assert.ok(readFileSync(f.storagePath, 'utf8').startsWith('encrypted:'));
  assert.equal(signal.aborted, true);
  await tick(); // A late opener rejection must remain handled.
});

test('Google denial while the opener is pending cannot exchange or save credentials', async t => {
  const opener = deferred(); let signal;
  const f = fixture({ options: { openExternal: (_url, context) => { signal = context.signal; return opener.promise; } } });
  t.after(f.cleanup);
  const pending = f.auth.signIn(); pending.catch(() => {});
  const authorization = new URL(await f.opened.promise);
  const redirect = new URL(authorization.searchParams.get('redirect_uri'));
  redirect.searchParams.set('state', authorization.searchParams.get('state'));
  redirect.searchParams.set('error', 'access_denied');
  assert.equal((await fetch(redirect)).status, 200);
  await assert.rejects(pending, cause => cause.code === 'cancelled');
  assert.equal(signal.aborted, true);
  opener.reject(Error('late opener failure')); await tick();
  assert.equal(f.calls.length, 0);
  assert.equal(f.auth.getProfile(), null);
  assert.equal(existsSync(f.storagePath), false);
});

test('cancel and timeout abort a pending opener and exchange without committing callback credentials', async t => {
  for (const mode of ['cancel','timeout']) {
    const launched=deferred(), gate=deferred(), exchange=deferred(); let exchanges=0;
    const f=fixture({fetch:async()=>{exchanges++;return exchange.promise;},
      options:{timeoutMs:250,openExternal:(url,{signal})=>{launched.resolve({url,signal});return gate.promise;}}});
    t.after(f.cleanup);
    const pending=f.auth.signIn(); pending.catch(()=>{});
    const {url,signal}=await launched.promise;
    assert.equal(signal.aborted,false);
    assert.equal((await callback(url)).status,200);
    assert.equal(exchanges,1);
    if (mode==='cancel') f.auth.cancelSignIn();
    await assert.rejects(pending,mode==='cancel'?/cancel/i:/timed out/i);
    assert.equal(signal.aborted,true);
    gate.resolve(); exchange.resolve(response({id_token:'late-credentials'})); await tick();
    assert.equal(exchanges,1);
    assert.equal(f.auth.getProfile(),null);
    assert.equal(existsSync(f.storagePath),false);
  }
});

test('browser launch failures provide fixed Chrome guidance without private diagnostics', async t => {
  for (const [code,message] of [['chrome_unavailable',/Install Google Chrome/], ['busy',/Finish or cancel/], ['browser_failed',/Could not open.*Chrome/]]) {
    const f=fixture({options:{openExternal:async()=>{throw Object.assign(Error('private browser diagnostic'),{code});}}});
    t.after(f.cleanup);
    await assert.rejects(f.auth.signIn(),cause=>cause.code==='browser' && message.test(cause.message) && !cause.message.includes('private'));
    assert.equal(f.calls.length,0); assert.equal(existsSync(f.storagePath),false);
  }
});

test('sign-out during delayed sign-in prevents resurrection', async t => {
  const gate = deferred();
  const f = fixture({ fetch: async (url, options) => {
    if (String(url).includes('oauth2.googleapis.com/token')) return gate.promise;
    throw Error('Unexpected request');
  } }); t.after(f.cleanup);
  const pending = f.auth.signIn(); const url = await f.opened.promise;
  await callback(url); await tick();
  f.auth.signOut();
  gate.resolve(response({ id_token: 'anything' }));
  await assert.rejects(pending, /cancel|stale/i);
  assert.equal(f.auth.getProfile(), null);
  assert.equal(existsSync(f.storagePath), false);
});

test('unavailable encryption refuses storage; encryption failure leaves no session', async t => {
  assert.throws(() => fixture({ safeStorage: { isEncryptionAvailable: () => false } }), /encrypt|storage/i);
  const f = fixture({ safeStorage: { encryptString: () => { throw Error('secret from provider'); } } }); t.after(f.cleanup);
  await assert.rejects(signedIn(f), /storage|encrypt/i);
  assert.equal(f.auth.getProfile(), null);
  assert.equal(existsSync(f.storagePath), false);
});

test('transient refresh failure preserves session; invalid refresh clears it', async t => {
  let current = Date.now();
  let refreshResponse = response({ error: { message: 'SERVER_ERROR' } }, 503);
  const initial = fixture({ options: { now: () => current }, fetch: async (url, options) => {
    if (String(url).includes('securetoken')) return refreshResponse;
    return initialDefault(url, options);
  } });
  // Reuse the fixture's normal token and Firebase responses without network.
  let initialDefault;
  const base = fixture(); t.after(base.cleanup);
  initialDefault = async (url, options) => {
    if (String(url).includes('oauth2.googleapis.com/token')) {
      const nonce = new URL(await initial.opened.promise).searchParams.get('nonce');
      return response({ id_token: jwt({ iss: 'https://accounts.google.com', aud: clientId, sub: 'google-1', nonce, exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000), email, email_verified: true }) });
    }
    return response({ localId: 'firebase-1', email, idToken: firebaseJWT(), refreshToken: 'refresh', expiresIn: '1' });
  };
  t.after(initial.cleanup);
  await signedIn(initial); current += 1000;
  await assert.rejects(initial.auth.getIdToken(), /network|refresh/i);
  assert.ok(initial.auth.getProfile());
  refreshResponse = response({ error: { message: 'INVALID_REFRESH_TOKEN' } }, 400);
  await assert.rejects(initial.auth.getIdToken(), /sign in|session/i);
  assert.equal(initial.auth.getProfile(), null);
  assert.equal(existsSync(initial.storagePath), false);
});

test('a refresh response for a different Firebase UID clears the session', async t => {
  let current = Date.now();
  const f = fixture({ options: { now: () => current }, refresh: { user_id: 'other-firebase-user' }, firebase: { expiresIn: '1' } }); t.after(f.cleanup);
  await signedIn(f); current += 1000;
  await assert.rejects(f.auth.getIdToken(), /sign in/i);
  assert.equal(f.auth.getProfile(), null);
  assert.equal(existsSync(f.storagePath), false);
});

test('stale refresh cannot restore an account after sign-out', async t => {
  const gate = deferred(); let current = Date.now();
  const f = fixture({ options: { now: () => current }, fetch: async (url) => {
    if (String(url).includes('securetoken')) return gate.promise;
    if (String(url).includes('oauth2.googleapis.com/token')) {
      const nonce = new URL(await f.opened.promise).searchParams.get('nonce');
      return response({ id_token: jwt({ iss: 'https://accounts.google.com', aud: clientId, sub: 'google-1', nonce, exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000), email, email_verified: true }) });
    }
    return response({ localId: 'firebase-1', email, idToken: firebaseJWT(), refreshToken: 'refresh', expiresIn: '1' });
  } }); t.after(f.cleanup);
  await signedIn(f); current += 1000;
  const pending = f.auth.getIdToken(); await tick();
  f.auth.signOut();
  gate.resolve(response({ user_id: 'firebase-1', id_token: 'new', refresh_token: 'new-refresh', expires_in: '3600' }));
  await assert.rejects(pending, /stale|sign in|session|cancel/i);
  assert.equal(f.auth.getProfile(), null);
  assert.equal(existsSync(f.storagePath), false);
});


test('a valid cached session cannot be reused by a different project', async t => {
  const f = fixture(); t.after(f.cleanup); await signedIn(f);
  const other = fixture({options:{storagePath:f.storagePath, projectID:'demo-other'}}); t.after(other.cleanup);
  assert.equal(other.auth.load(), null);
});

test('mismatched Firebase projects and changed verified email are rejected during exchange and refresh', async t => {
  const other = fixture({ firebase:{idToken:firebaseJWT({aud:'demo-other'})} }); t.after(other.cleanup);
  await assert.rejects(signedIn(other), cause => cause.code === 'invalid_account');
  const changed = fixture({ firebase:{expiresIn:'1'}, refresh:{id_token:firebaseJWT({email:'u@external.example'})} });
  t.after(changed.cleanup); await signedIn(changed);
  await assert.rejects(changed.auth.getIdToken(), cause => cause.code === 'session');
});

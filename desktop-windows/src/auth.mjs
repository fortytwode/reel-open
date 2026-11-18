import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { closeSync, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

import { internalEmail, validDomain } from '../../web/reel/organization.js';

const CALLBACK_PATH = '/oauthredirect';
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const REFRESH_LEEWAY_MS = 120_000;
const MAX_CALLBACK_URL = 2048;
// Google's code redirect includes OIDC metadata in addition to code/state.
// These are never trusted as identity or granted-scope evidence; the token exchange is authoritative.
const CALLBACK_FIELDS = new Set(['state','code','error','error_description','error_uri','scope','authuser','hd','prompt','iss']);
const invalidRefreshCodes = new Set(['INVALID_REFRESH_TOKEN', 'TOKEN_EXPIRED', 'USER_NOT_FOUND', 'USER_DISABLED']);
const GOOGLE_EXCHANGE_ERRORS = new Set(['invalid_client', 'invalid_grant', 'unauthorized_client', 'invalid_request',
  'invalid_scope', 'unsupported_grant_type', 'temporarily_unavailable', 'server_error']);
const FIREBASE_EXCHANGE_ERRORS = new Set(['INVALID_IDP_RESPONSE', 'INVALID_OAUTH_CLIENT_ID', 'OPERATION_NOT_ALLOWED',
  'API_KEY_INVALID', 'INVALID_API_KEY', 'USER_DISABLED', 'EMAIL_EXISTS', 'FEDERATED_USER_ID_ALREADY_LINKED',
  'TOO_MANY_ATTEMPTS_TRY_LATER', 'ADMIN_ONLY_OPERATION']);

class AuthError extends Error {
  constructor(code, message) { super(message); this.name = 'AuthError'; this.code = code; }
}
const error = (code, message) => new AuthError(code, message);
const base64url = bytes => Buffer.from(bytes).toString('base64url');
const publicProfile = session => session ? { userID: session.userID, email: session.email, displayName: session.displayName ?? null,
  calendarConnected: Boolean(session.googleCalendar?.refreshToken) } : null;
const validString = value => typeof value === 'string' && value.length > 0 && value.length <= 16_384;

function exchangeDiagnostic(stage, result) {
  const status = Number.isInteger(result.status) && result.status >= 100 && result.status <= 599 ? result.status : 'unknown';
  const raw = stage === 'google_token' ? result.data?.error : result.data?.error?.message;
  const providerCode = typeof raw === 'string' ? (stage === 'google_token' ? raw : raw.match(/^[A-Z_]{1,64}(?=$|[ :])/u)?.[0]) : null;
  const allowed = stage === 'google_token' ? GOOGLE_EXCHANGE_ERRORS : FIREBASE_EXCHANGE_ERRORS;
  return `${stage} HTTP ${status} ${allowed.has(providerCode) ? providerCode : 'other'}`;
}

function googleClaims(token, clientId, nonce, now, domain) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3 || parts.some(part => !part || part.length > 16_384)) throw error('invalid_identity', 'Google identity could not be verified.');
  let header, claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch { throw error('invalid_identity', 'Google identity could not be verified.'); }
  const seconds = now() / 1000;
  const aud = claims?.aud;
  const audienceValid = aud === clientId || (Array.isArray(aud) && aud.includes(clientId) && aud.length > 0);
  if (header?.alg !== 'RS256' || !['accounts.google.com', 'https://accounts.google.com'].includes(claims?.iss)
    || !validString(claims?.sub) || !audienceValid || (Array.isArray(aud) && aud.length > 1 && claims?.azp !== clientId)
    || (claims?.azp !== undefined && claims.azp !== clientId)
    || claims?.nonce !== nonce || !Number.isFinite(claims?.exp) || claims.exp <= seconds
    || !Number.isFinite(claims?.iat) || claims.iat > seconds + 60 || claims.iat < seconds - 86_400
    || claims?.email_verified !== true || !internalEmail(claims?.email, domain)
    || (claims?.hd !== undefined && claims.hd !== domain)) {
    throw error('invalid_identity', 'Google identity could not be verified.');
  }
  return claims;
}

// Responses come directly from Firebase over TLS or from the OS-encrypted session.
function matchesFirebaseAccount(token, projectID, userID, email, domain) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
    return claims.aud === projectID && claims.iss === `https://securetoken.google.com/${projectID}`
      && claims.sub === userID && claims.email_verified === true && internalEmail(claims.email, domain)
      && claims.email.toLowerCase() === email.toLowerCase();
  } catch { return false; }
}

function responseSession(data, expectedEmail, now, domain, projectID) {
  if (!validString(data?.localId) || !validString(data?.idToken) || !validString(data?.refreshToken)
    || !matchesFirebaseAccount(data.idToken, projectID, data.localId, expectedEmail, domain)
    || !internalEmail(data?.email, domain) || data.email.toLowerCase() !== expectedEmail.toLowerCase()) {
    throw error('invalid_account', 'The Firebase account did not match the Google account.');
  }
  const seconds = Number(data.expiresIn);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86_400) throw error('invalid_account', 'The sign-in response was incomplete.');
  return {
    userID: data.localId, email: data.email, displayName: typeof data.displayName === 'string' ? data.displayName : (typeof data.fullName === 'string' ? data.fullName : null),
    idToken: data.idToken, refreshToken: data.refreshToken, expiresAt: now() + seconds * 1000
  };
}

function parseStored(value, domain, projectID) {
  const session = JSON.parse(value);
  if (!validString(session?.userID) || !validString(session?.idToken) || !validString(session?.refreshToken)
    || !internalEmail(session?.email, domain) || !Number.isFinite(session?.expiresAt)) throw Error('Invalid session');
  if (!matchesFirebaseAccount(session.idToken, projectID, session.userID, session.email, domain)) throw Error('Invalid Firebase account');
  if (session.googleCalendar && (!validString(session.googleSub) || !validString(session.googleCalendar.accessToken)
    || !validString(session.googleCalendar.refreshToken) || !Number.isFinite(session.googleCalendar.expiresAt))) throw Error('Invalid calendar session');
  return session;
}

/**
 * Main-process-only auth service. Inject Electron's `safeStorage`, a main-only
 * browser opener `openExternal(url, {signal})`, a path inside app.getPath('userData'), and a
 * Google OAuth Desktop client ID and its non-confidential Desktop client value.
 * Optional `fetch`, `now`, `timeoutMs` support tests.
 * `load`, `getProfile`, `signOut`, `cancelSignIn`, `onStateChange` are synchronous;
 * `signIn({connectCalendar})`, `getIdToken`, `getCalendarAccessToken` are async.
 * Token getters are main-process-only. `connectCalendar` explicitly adds the
 * Google Calendar read-only scope; default sign-in requests identity only.
 */
export function createWindowsAuth({ clientId, clientSecret, apiKey, allowedEmailDomain, projectID, storagePath, safeStorage, fetch: fetcher = globalThis.fetch,
  openExternal, now = Date.now, timeoutMs = 180_000 } = {}) {
  if (typeof clientId !== 'string' || !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId)
    || typeof clientSecret !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(clientSecret)
    || !validString(apiKey) || !validDomain(allowedEmailDomain) || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectID ?? '')
    || typeof storagePath !== 'string' || !isAbsolute(storagePath)
    || typeof fetcher !== 'function' || typeof openExternal !== 'function'
    || typeof now !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180_000) {
    throw error('configuration', 'Windows Google sign-in is not configured.');
  }
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function'
    || !safeStorage.isEncryptionAvailable() || typeof safeStorage.encryptString !== 'function'
    || typeof safeStorage.decryptString !== 'function') {
    throw error('storage', 'Encrypted credential storage is unavailable.');
  }

  let session = null;
  let generation = 0;
  let active = null;
  let refreshPromise = null;
  let calendarRefreshPromise = null;
  const listeners = new Set();
  const emit = () => { for (const listener of listeners) { try { listener(publicProfile(session)); } catch { /* listener isolation */ } } };
  const assertCurrent = value => { if (generation !== value) throw error('stale', 'Sign-in was cancelled.'); };
  const storageDir = dirname(storagePath);

  function privateDirectory() {
    mkdirSync(storageDir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(storageDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw error('storage', 'Credential storage is unavailable.');
  }
  function save(value) {
    let encrypted;
    try {
      if (!safeStorage.isEncryptionAvailable()) throw Error('unavailable');
      encrypted = safeStorage.encryptString(JSON.stringify(value));
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) throw Error('empty');
    } catch { throw error('storage', 'Could not encrypt the session.'); }
    privateDirectory();
    const temp = `${storagePath}.${base64url(randomBytes(12))}.tmp`;
    let fd;
    try {
      fd = openSync(temp, 'wx', 0o600);
      fchmodSync(fd, 0o600);
      writeSync(fd, encrypted);
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      if (existsSync(storagePath) && lstatSync(storagePath).isSymbolicLink()) throw Error('symlink');
      renameSync(temp, storagePath);
    } catch {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(temp)) unlinkSync(temp);
      throw error('storage', 'Could not save the encrypted session.');
    }
  }
  function clear() { if (existsSync(storagePath)) unlinkSync(storagePath); }
  function load() {
    if (!existsSync(storagePath)) return null;
    if (!safeStorage.isEncryptionAvailable()) throw error('storage', 'Encrypted credential storage is unavailable.');
    try {
      if (lstatSync(storagePath).isSymbolicLink()) throw Error('unavailable');
      session = parseStored(safeStorage.decryptString(readFileSync(storagePath)), allowedEmailDomain, projectID);
      generation++;
      emit();
      return publicProfile(session);
    } catch {
      session = null;
      clear();
      emit();
      return null;
    }
  }
  function cancelSignIn() {
    if (!active) return;
    generation++;
    active.controller.abort();
    const cancelled = error('cancelled', 'Sign-in was cancelled.');
    active.cancel?.(cancelled);
    active.reject?.(cancelled);
    active.server?.close();
  }
  function signOut() {
    generation++;
    cancelSignIn();
    session = null;
    clear();
    emit();
  }
  function disconnectCalendar() {
    if (active?.connectCalendar) cancelSignIn();
    if (!session?.googleCalendar) return;
    generation++;
    const next = { ...session };
    delete next.googleCalendar;
    save(next);
    session = next;
    emit();
  }
  function onStateChange(listener) {
    if (typeof listener !== 'function') throw TypeError('listener must be a function');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  async function post(url, body, contentType, signal) {
    let result;
    try {
      result = await fetcher(url, { method: 'POST', headers: { 'Content-Type': contentType, Accept: 'application/json' }, body, signal, redirect: 'error' });
    } catch { throw error('network', 'Could not reach the sign-in service.'); }
    try {
      if (result?.redirected || (result?.url && new URL(result.url).origin !== new URL(url).origin))
        throw Error('redirect');
    } catch { throw error('network', 'Could not reach the sign-in service.'); }
    let data;
    try { data = await result.json(); } catch { data = null; }
    return { status: result.status, ok: result.ok, data };
  }

  function receiveCode(flow, expectedState) {
    return new Promise((resolve, reject) => {
      flow.reject = reject;
      const server = createServer({ maxHeaderSize: 4096 }, (request, response) => {
        const fail = () => { response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); response.end('Invalid sign-in response.'); };
        const raw = request.url;
        if (request.method !== 'GET' || typeof raw !== 'string' || raw.length > MAX_CALLBACK_URL
          || request.headers.host !== `127.0.0.1:${server.address()?.port}`
          || request.headers['transfer-encoding'] || Number(request.headers['content-length'] ?? 0) > 0) { fail(); return; }
        let callback;
        try { callback = new URL(raw, `http://127.0.0.1:${server.address().port}`); } catch { fail(); return; }
        const query = callback.searchParams;
        if (callback.pathname !== CALLBACK_PATH || callback.hash || query.getAll('state').length !== 1
          || query.get('state') !== expectedState || query.getAll('code').length > 1 || query.getAll('error').length > 1
          || [...query.keys()].some(key => !CALLBACK_FIELDS.has(key) || query.getAll(key).length !== 1)
          || (query.has('iss') && query.get('iss') !== 'https://accounts.google.com')) { fail(); return; }
        if (query.has('error')) {
          if (query.has('code')) { fail(); return; }
          response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); response.end('Sign-in was cancelled.');
          reject(error(query.get('error') === 'access_denied' ? 'cancelled' : 'authorization', 'Sign-in was cancelled.'));
          server.close();
          return;
        }
        const code = query.get('code');
        if (!code || code.length > 2048) { fail(); return; }
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end('<!doctype html><title>Reel sign-in</title><p>Google response received. Return to Reel to finish signing in.</p>');
        resolve({ code, port: server.address().port });
        server.close();
      });
      flow.server = server;
      server.once('error', () => {
        const failure = error('listener', 'Could not start Google sign-in.');
        flow.listenError?.(failure);
        reject(failure);
      });
      server.listen(0, '127.0.0.1', () => {
        if (flow.controller.signal.aborted) { server.close(); reject(error('cancelled', 'Sign-in was cancelled.')); return; }
        flow.port = server.address().port;
        flow.listening?.();
      });
    });
  }

  async function signIn({ connectCalendar = false } = {}) {
    if (typeof connectCalendar !== 'boolean') throw error('configuration', 'Invalid sign-in options.');
    if (active) throw error('in_progress', 'Google sign-in is already open.');
    const mine = ++generation;
    const previous = session;
    const flow = { controller: new AbortController(), server: null, reject: null, listening: null, connectCalendar };
    active = flow;
    flow.cancelPromise = new Promise((_, reject) => { flow.cancel = reject; });
    flow.cancelPromise.catch(() => {});
    const timeout = setTimeout(() => { if (active === flow) {
      generation++;
      flow.controller.abort();
      const failure = error('timeout', 'Google sign-in timed out.');
      flow.cancel(failure);
      flow.reject?.(failure);
      flow.server?.close();
    } }, timeoutMs);
    try {
      const verifier = base64url(randomBytes(64));
      const state = base64url(randomBytes(32));
      const nonce = base64url(randomBytes(32));
      const ready = new Promise((resolve, reject) => { flow.listening = resolve; flow.listenError = reject; });
      const codePromise = receiveCode(flow, state);
      // A browser or network failure can end sign-in before the callback is awaited.
      codePromise.catch(() => {});
      await Promise.race([ready, flow.cancelPromise]);
      assertCurrent(mine);
      const redirect = `http://127.0.0.1:${flow.port}${CALLBACK_PATH}`;
      const authorization = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      for (const [key, value] of Object.entries({ client_id: clientId, redirect_uri: redirect, response_type: 'code',
        scope: connectCalendar ? `openid email profile ${CALENDAR_SCOPE}` : 'openid email profile',
        code_challenge: base64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', state, nonce, hd: allowedEmailDomain,
        prompt: connectCalendar ? 'consent select_account' : 'select_account', ...(connectCalendar ? { access_type: 'offline' } : {}) })) {
        authorization.searchParams.set(key, value);
      }
      // A validated callback proves the browser opened, even if window observation is still pending.
      try { await Promise.race([codePromise, openExternal(authorization.toString(), {signal:flow.controller.signal}), flow.cancelPromise]); }
      catch (cause) {
        if (cause instanceof AuthError) throw cause;
        const message=cause?.code === 'chrome_unavailable' ? 'Install Google Chrome, then try signing in again.'
          : cause?.code === 'busy' ? 'Finish or cancel the current meeting operation, then try signing in again.'
          : 'Could not open Google sign-in in Chrome. Please try again.';
        throw error('browser', message);
      }
      assertCurrent(mine);
      const { code } = await Promise.race([codePromise, flow.cancelPromise]);
      assertCurrent(mine);
      const token = await Promise.race([post('https://oauth2.googleapis.com/token', new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, code_verifier: verifier,
        grant_type: 'authorization_code', redirect_uri: redirect }).toString(), 'application/x-www-form-urlencoded', flow.controller.signal), flow.cancelPromise]);
      assertCurrent(mine);
      if (!token.ok || !validString(token.data?.id_token)) throw error('exchange', `Google sign-in could not be completed. (${exchangeDiagnostic('google_token', token)})`);
      const claims = googleClaims(token.data.id_token, clientId, nonce, now, allowedEmailDomain);
      const firebase = await Promise.race([post(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${encodeURIComponent(apiKey)}`,
        JSON.stringify({ postBody: new URLSearchParams({ id_token: token.data.id_token, providerId: 'google.com' }).toString(),
          requestUri: 'http://localhost', returnSecureToken: true }), 'application/json', flow.controller.signal), flow.cancelPromise]);
      assertCurrent(mine);
      if (!firebase.ok) throw error('firebase', `Firebase sign-in could not be completed. (${exchangeDiagnostic('firebase', firebase)})`);
      const next = responseSession(firebase.data, claims.email, now, allowedEmailDomain, projectID);
      next.googleSub = claims.sub;
      if (connectCalendar) {
        const granted = typeof token.data.scope === 'string' && token.data.scope.split(/\s+/).includes(CALENDAR_SCOPE);
        const prior = previous?.googleCalendar && previous.googleSub === claims.sub && previous.userID === next.userID
          ? previous.googleCalendar.refreshToken : null;
        const refresh = validString(token.data.refresh_token) ? token.data.refresh_token : prior;
        const seconds = Number(token.data.expires_in);
        if (!granted || !validString(token.data.access_token) || !validString(refresh)
          || !Number.isFinite(seconds) || seconds <= 0 || seconds > 86_400) {
          throw error('calendar_reconnect', 'Google Calendar needs to be connected again.');
        }
        next.googleCalendar = { accessToken: token.data.access_token, refreshToken: refresh, expiresAt: now() + seconds * 1000 };
      }
      save(next);
      assertCurrent(mine);
      session = next;
      emit();
      return publicProfile(session);
    } finally {
      clearTimeout(timeout);
      flow.controller.abort();
      flow.server?.close();
      if (active === flow) active = null;
    }
  }

  async function getIdToken() {
    const original = session;
    if (!original) throw error('session', 'Please sign in to continue.');
    if (original.expiresAt > now() + REFRESH_LEEWAY_MS) return original.idToken;
    if (refreshPromise) return refreshPromise;
    const mine = generation;
    const promise = (async () => {
      const refreshed = await post(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(apiKey)}`,
        new URLSearchParams({ grant_type: 'refresh_token', refresh_token: original.refreshToken }).toString(),
        'application/x-www-form-urlencoded');
      assertCurrent(mine);
      if (session !== original) throw error('stale', 'The account changed. Please sign in again.');
      if (!refreshed.ok) {
        const code = refreshed.data?.error?.message;
        if (invalidRefreshCodes.has(code) || refreshed.status === 401) {
          signOut();
          throw error('session', 'Please sign in again to resume uploads.');
        }
        throw error('network', 'Could not refresh the session.');
      }
      const data = refreshed.data;
      const seconds = Number(data?.expires_in);
      if (!validString(data?.user_id) || data.user_id !== original.userID || !validString(data?.id_token)
        || !matchesFirebaseAccount(data.id_token, projectID, original.userID, original.email, allowedEmailDomain)
        || !validString(data?.refresh_token) || !Number.isFinite(seconds) || seconds <= 0 || seconds > 86_400) {
        signOut();
        throw error('session', 'Please sign in again to resume uploads.');
      }
      const next = { ...original, idToken: data.id_token, refreshToken: data.refresh_token, expiresAt: now() + seconds * 1000 };
      save(next);
      assertCurrent(mine);
      session = next;
      emit();
      return next.idToken;
    })();
    refreshPromise = promise;
    try { return await promise; } finally { if (refreshPromise === promise) refreshPromise = null; }
  }

  async function getCalendarAccessToken() {
    const original = session;
    const calendar = original?.googleCalendar;
    if (!calendar) throw error('calendar_reconnect', 'Connect Google Calendar to continue.');
    if (calendar.expiresAt > now() + REFRESH_LEEWAY_MS) return calendar.accessToken;
    if (calendarRefreshPromise) return calendarRefreshPromise;
    const mine = generation;
    const promise = (async () => {
      const refreshed = await post('https://oauth2.googleapis.com/token', new URLSearchParams({ client_id: clientId, client_secret: clientSecret,
        grant_type: 'refresh_token', refresh_token: calendar.refreshToken }).toString(), 'application/x-www-form-urlencoded');
      assertCurrent(mine);
      if (session !== original || session.userID !== original.userID || session.googleSub !== original.googleSub)
        throw error('stale', 'The account changed. Please reconnect Google Calendar.');
      if (!refreshed.ok) {
        if (refreshed.status === 400 && ['invalid_grant', 'invalid_token'].includes(refreshed.data?.error)) {
          disconnectCalendar();
          throw error('calendar_reconnect', 'Google Calendar needs to be connected again.');
        }
        throw error('network', 'Could not refresh Google Calendar access.');
      }
      const data = refreshed.data;
      const seconds = Number(data?.expires_in);
      if (!validString(data?.access_token) || !Number.isFinite(seconds) || seconds <= 0 || seconds > 86_400
        || (typeof data.scope === 'string' && !data.scope.split(/\s+/).includes(CALENDAR_SCOPE))) {
        disconnectCalendar();
        throw error('calendar_reconnect', 'Google Calendar needs to be connected again.');
      }
      const next = { ...original, googleCalendar: { accessToken: data.access_token,
        refreshToken: validString(data.refresh_token) ? data.refresh_token : calendar.refreshToken,
        expiresAt: now() + seconds * 1000 } };
      save(next);
      assertCurrent(mine);
      session = next;
      emit();
      return next.googleCalendar.accessToken;
    })();
    calendarRefreshPromise = promise;
    try { return await promise; } finally { if (calendarRefreshPromise === promise) calendarRefreshPromise = null; }
  }

  return { load, getProfile: () => publicProfile(session), signIn, cancelSignIn, signOut, getIdToken,
    hasCalendarAccess: () => Boolean(session?.googleCalendar?.refreshToken), getCalendarAccessToken, disconnectCalendar, onStateChange };
}

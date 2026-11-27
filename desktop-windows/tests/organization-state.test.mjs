import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMeetingProcessor } from '../src/meeting-processing.mjs';

const ownerUserID = 'shared-firebase-uid';
const id = '0123456789abcdef0123456789abcdef';
const createdAt = '2026-11-12T09:00:00Z';
const orgA = {
  projectID: 'demo-alpha', allowedEmailDomain: 'example.com', bucket: 'demo-alpha.appspot.com',
  authDomain: 'demo-alpha.firebaseapp.com', apiKey: 'fixture-key', viewerPath: 'reel', firestoreDatabase: '(default)',
  viewerBase: 'https://viewer.example.com', webBase: 'https://reel.example.com', notesBaseURL: 'https://notes.example.com/reel',
  speechServiceURL: 'https://speech-alpha.example.com', deliveryServiceURL: 'https://delivery-alpha.example.com',
  meetingServiceURL: 'https://meeting.example.com', googleDesktopClientId: 'fixture.apps.googleusercontent.com'
};
const orgB = { ...orgA, projectID: 'demo-beta', speechServiceURL: 'https://speech-beta.example.com',
  deliveryServiceURL: 'https://delivery-beta.example.com' };
const hash = input => createHash('sha256').update(input).digest('hex');
const organizationDirectory = (base, org) => path.join(base, 'organizations', org ? hash(`${org.projectID}\n${org.allowedEmailDomain}`) : 'local');
const sessionPath = base => path.join(base, 'session.encrypted');
const ownerPath = base => path.join(base, 'recordings', hash(ownerUserID));
const settings = { ownerUserID, autoJoin: true, participantConsent: true, systemAudioConsent: true,
  meetingReminders: false, localTranscription:false, selection: { useAll: false, ids: ['private-calendar'] } };

async function seedSession(base, { projectID, allowedEmailDomain }) {
  const email = `person@${allowedEmailDomain}`;
  const claims = Buffer.from(JSON.stringify({ aud: projectID, iss: `https://securetoken.google.com/${projectID}`,
    sub: ownerUserID, email, email_verified: true })).toString('base64url');
  const session = { userID: ownerUserID, email, idToken: `e30.${claims}.signature`, refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3600000 };
  await writeFile(sessionPath(base), JSON.stringify(session));
}

async function seedRecording(base) {
  const directory = ownerPath(base);
  mkdirSync(directory, { recursive: true });
  await writeFile(path.join(directory, 'library.json'), JSON.stringify({ version: 1, ownerUserID, settings, completed: {}, recordings: [{
    id, title: 'Private meeting', createdAt, durationSeconds: 1, processing: { phase: 'pending', createdAt,
      title: 'Private meeting', meeting: { attendees: [] }, audioFrames: 16000 }
  }] }));
  await writeFile(path.join(directory, `${id}.mp4`), 'Saved video fixture');
  await writeFile(path.join(directory, `${id}.pcm`), Buffer.alloc(32000));
}

let launches = 0;
async function startDesktop(base, org) {
  const noop = () => {};
  const paths = { userData: base, sessionData: base };
  const handlers = new Map(), calls = [], decryptions = [];
  const contents = new EventEmitter();
  contents.session = { setPermissionRequestHandler: noop, setPermissionCheckHandler: noop, setDevicePermissionHandler: noop };
  contents.setWindowOpenHandler = contents.send = noop;
  class BrowserWindow extends EventEmitter {
    webContents = contents;
    loadURL(url) { contents.mainFrame = { url }; contents.getURL = () => url; }
    show() {}
    isDestroyed() { return false; }
  }
  let launch, lockedPaths, resume;
  const { promise: quit, resolve: didQuit } = Promise.withResolvers();
  const app = Object.assign(new EventEmitter(), {
    getPath: name => paths[name], setPath(name, value) { assert.equal(existsSync(value), true); paths[name] = value; },
    setName: noop, setAppUserModelId: noop, setToastActivatorCLSID: noop,
    commandLine: { appendSwitch: noop }, requestSingleInstanceLock() { lockedPaths = { ...paths }; return true; },
    whenReady: () => ({ then(callback) { launch = callback; return { catch: noop }; } }), quit: didQuit
  });
  const entry = new URL(`../main.mjs?organization-state-test=${launches++}`, import.meta.url);
  const bindings = {
    electron: { app, BrowserWindow, clipboard: { writeText: noop }, desktopCapturer: { getSources: noop }, dialog: {}, shell: {},
      Notification: class { on() {} show() {} },
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, Menu: { buildFromTemplate: noop, setApplicationMenu: noop },
      safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value),
        decryptString(bytes) { decryptions.push(bytes); return bytes.toString(); } } },
    'node:fs': { existsSync: file => path.basename(file) === 'ReelNativeJoin.exe' || existsSync(file), mkdirSync, readdirSync,
      readFileSync(file, encoding) {
        if (path.basename(file) === 'organization.json' && org) return JSON.stringify(org);
        if (path.basename(file) === 'organization.json') throw Object.assign(Error('No packaged organization'), { code: 'ENOENT' });
        if (path.basename(file) === 'config.json') return JSON.stringify({ googleDesktopClientId: org?.googleDesktopClientId, googleDesktopClientSecret: 'fixture-value' });
        return readFileSync(file, encoding);
      } },
    './src/native-bridge.mjs': { createNativeBridge: () => ({ join: noop, inspect: noop, close: noop, dispose: noop }) },
    './src/meeting-processing.mjs': { createMeetingProcessor(options) {
      const processor = createMeetingProcessor({ ...options, fetch: async url => {
        calls.push(url);
        if (url.endsWith('/transcription')) return Response.json({ text: 'Transcript', engine: 'OpenAI gpt-transcribe' });
        if (url.endsWith('/summary')) return Response.json({ summary: 'Summary', engine: 'OpenAI gpt-6.1-sol' });
        return Response.json({ verified: true, page_id: 'fixture', url: 'https://www.notion.so/fixture', recipients: [`person@${org.allowedEmailDomain}`], email_status: 'confirmed' });
      } });
      return { ...processor, resume: () => (resume = processor.resume()) };
    } }
  };
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const hook = registerHooks({ resolve(specifier, context, nextResolve) {
    if (context.parentURL !== entry.href || !Object.hasOwn(bindings, specifier)) return nextResolve(specifier, context);
    const exports = Object.keys(bindings[specifier]).map(name => `export const ${name} = globalThis.reelStartupTestBindings[${JSON.stringify(specifier)}].${name};`);
    return { url: `data:text/javascript,${encodeURIComponent(exports.join('\n'))}#${entry.search}`, shortCircuit: true };
  } });
  try {
    globalThis.reelStartupTestBindings = bindings;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    await import(entry.href);
    await launch();
    await resume;
    return { paths, lockedPaths, calls, decryptions,
      state: handlers.get('reel-desktop:state')({ sender: contents, senderFrame: contents.mainFrame }) };
  } finally {
    Object.defineProperty(process, 'platform', platform);
    delete globalThis.reelStartupTestBindings;
    hook.deregister();
    if (launch) {
      app.emit('before-quit', { preventDefault: noop });
      await quit;
    }
  }
}

test('startup leaves prior shared data in place and selects a local profile without configuration', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'reel-legacy-profile-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  await seedSession(base, orgA);
  await seedRecording(base);
  const legacySession = await readFile(sessionPath(base));
  const legacyLibrary = await readFile(path.join(ownerPath(base), 'library.json'));
  const configured = await startDesktop(base, orgA);
  assert.equal(configured.state.profile, null);
  assert.deepEqual(configured.decryptions, []);
  assert.deepEqual(configured.calls, []);
  const local = await startDesktop(base, null);
  assert.deepEqual(local.lockedPaths, { userData: organizationDirectory(base, null), sessionData: organizationDirectory(base, null) });
  assert.equal(local.state.configured, false);
  assert.deepEqual(await readFile(sessionPath(base)), legacySession);
  assert.deepEqual(await readFile(path.join(ownerPath(base), 'library.json')), legacyLibrary);
});

test('the same Firebase UID cannot reuse another organization’s session, consent, recordings, or pending audio', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'reel-organization-profiles-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const emptyA = await startDesktop(base, orgA);
  await seedSession(emptyA.paths.userData, orgA);
  await seedRecording(emptyA.paths.userData);
  const alphaSession = await readFile(sessionPath(emptyA.paths.userData));
  const changedDomain = { ...orgA, allowedEmailDomain: 'other.example.com' };
  for (const org of [orgB, changedDomain]) {
    const empty = await startDesktop(base, org);
    assert.equal(empty.state.profile, null);
    await seedSession(empty.paths.userData, org);
    const signedIn = await startDesktop(base, org);
    assert.equal(signedIn.state.profile.userID, ownerUserID);
    assert.deepEqual(signedIn.calls, []);
    assert.deepEqual(signedIn.state.recordings, []);
    assert.deepEqual(signedIn.state.settings, { ownerUserID, autoJoin: false, participantConsent: false,
      systemAudioConsent: false, meetingReminders: false, localTranscription:false, selection: { useAll: true, ids: [] } });
    assert.deepEqual(empty.decryptions, []);
    const expected = organizationDirectory(base, org);
    assert.deepEqual(signedIn.lockedPaths, { userData: expected, sessionData: expected });
    assert.deepEqual(await readFile(sessionPath(emptyA.paths.userData)), alphaSession);
  }

  const alpha = await startDesktop(base, orgA);
  const expected = organizationDirectory(base, orgA);
  assert.deepEqual(alpha.lockedPaths, { userData: expected, sessionData: expected });
  assert.equal(alpha.state.profile.userID, ownerUserID);
  assert.equal(alpha.state.recordings[0].processing.phase, 'completed');
  assert.deepEqual(alpha.state.settings, settings);
  assert.deepEqual(alpha.calls, [orgA.speechServiceURL + '/transcription', orgA.speechServiceURL + '/summary', orgA.deliveryServiceURL + '/delivery/complete']);
});

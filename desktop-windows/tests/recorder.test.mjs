import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createWindowsRecorder } from '../src/recorder.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
const args = signal => ({ hwnd: '123', pid: 42, ownerUserID: 'owner', meeting: { title: 'Meeting', start: '2026-11-06T12:00:00Z' },
  systemAudio: true, microphone: false, signal });

function fixture(options = {}) {
  const windows = [], handlers = new Map(), calls = [], failures = [], sourceEnds = [];
  class BrowserWindow extends EventEmitter {
    constructor(settings) {
      super(); this.settings = settings; this.destroyed = false;
      const contents = this.webContents = new EventEmitter();
      contents.mainFrame = { url: '' }; contents.getURL = () => contents.mainFrame.url;
      contents.session = { setPermissionCheckHandler: fn => { this.checkPermission = fn; },
        setPermissionRequestHandler: fn => { this.requestPermission = fn; },
        setDevicePermissionHandler: fn => { this.devicePermission = fn; },
        setDisplayMediaRequestHandler: fn => { this.displayRequest = fn; } };
      contents.setWindowOpenHandler = fn => { this.openWindow = fn; };
      contents.send = (channel, message) => { calls.push(['command', message.type]); this.command = message; };
      windows.push(this);
    }
    async loadURL(url) { this.webContents.mainFrame.url = url; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const writer = { id: 'writer', appendInit: async () => { calls.push(['init']); await options.initGate?.promise; },
    appendFragment: async packet => { calls.push(['fragment', packet.index]); await options.fragmentGate?.promise; },
    finish: async info => { calls.push(['finish']); return { path: '/private/capture.mp4', playable: true, ...info }; },
    abort: async () => { calls.push(['abort']); } };
  const recorder = createWindowsRecorder({ BrowserWindow,
    desktopCapturer: { getSources: async query => { calls.push(['sources', query]); return options.sources ?? [{ id: 'window:999:0' }, { id: 'window:123:0' }]; } },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    store: { begin: async metadata => { calls.push(['begin', metadata]); return options.beginGate ? options.beginGate.promise : writer; } },
    origin: 'http://127.0.0.1:45123', defaultRenderEndpoint: options.defaultRenderEndpoint, onFailure: error => failures.push(error),
    onSourceEnded: () => { sourceEnds.push('ended'); return options.onSourceEnded?.(); } });
  const controller = new AbortController();
  const requestArgs = options.requestArgs ? options.requestArgs(controller.signal)
    : { ...args(controller.signal), microphone: options.microphone === true };
  const start = recorder.start(requestArgs); start.catch(() => {});
  const invoke = async (channel, message, event) => {
    const window = windows[0];
    return handlers.get(channel)(event ?? { sender: window.webContents, senderFrame: window.webContents.mainFrame },
      { token: window.command.token, ...message });
  };
  const status = (message, event) => invoke('reel-capture:status', message, event);
  const packet = (message, event) => invoke('reel-capture:packet', message, event);
  const ready = () => status({ type: 'ready', info: { video: 'avc1.640028', audio: 'mp4a.40.2' } });
  const init = () => packet({ kind: 'init', bytes: new Uint8Array([1]) });
  const fragment = index => packet({ kind: 'fragment', index, duration: 4, bytes: new Uint8Array([2]) });
  return { recorder, windows, calls, failures, sourceEnds, writer, start, controller, invoke, status, packet, ready, init, fragment };
}
async function running(f) { await settle(); await f.ready(); await f.init(); await f.fragment(1); return f.start; }

test('manual window captures save locally without creating a transcript processing job',async()=>{
  const f=fixture({sources:[{id:'window:123:0',name:'Chrome'}],requestArgs:signal=>({hwnd:'123',manual:true,title:'Chrome',sourceName:'Chrome',meeting:null,ownerUserID:'owner',
    systemAudio:true,microphone:false,signal})});
  await settle();
  const begin=f.calls.find(call=>call[0]==='begin')[1];
  assert.equal(begin.title,'Chrome');assert.equal(begin.meeting,null);
  const handle=await running(f), stop=f.recorder.stop(handle);
  await f.status({type:'done',duration:4,segments:1});
  await stop;
});

test('selects exact HWND and starts only after AAC readiness and a durable first fragment', async () => {
  const fragmentGate = deferred(), f = fixture({ fragmentGate });
  await settle();
  const window = f.windows[0];
  assert.equal(window.command.sourceId, 'window:123:0');
  assert.equal(window.settings.show, false);
  assert.equal(window.settings.webPreferences.sandbox, true);
  assert.equal(window.settings.webPreferences.contextIsolation, true);
  assert.equal(window.settings.webPreferences.nodeIntegration, false);
  assert.equal(window.settings.webPreferences.backgroundThrottling, false);
  assert.equal(window.settings.webPreferences.partition.startsWith('persist:'), false);
  let started = false; f.start.then(() => { started = true; });
  await f.ready(); await f.init();
  const append = f.fragment(1); await settle(); assert.equal(started, false);
  fragmentGate.resolve(); await append;
  const handle = await f.start; assert.equal(started, true);
  let granted;
  window.requestPermission(window.webContents, 'media', allowed => { granted = allowed; }, {});
  assert.equal(granted, false);
  assert.deepEqual(window.openWindow(), { action: 'deny' });
  const stop = f.recorder.stop(handle);
  assert.equal(window.command.type, 'stop');
  assert.equal(f.calls.some(call => call[0] === 'finish'), false);
  await f.status({ type: 'done', duration: 8, segments: 1 });
  const recording = await stop;
  assert.equal(recording.playable, true);
  assert.strictEqual(await f.recorder.stop(handle), recording);
  assert.equal(window.destroyed, true);
  assert.deepEqual(f.failures, []);
});

test('grants display-capture only to the owned main frame and denies camera, microphone and devices', async () => {
  const f = fixture(); await settle();
  const window = f.windows[0], contents = window.webContents;
  const origin = 'http://127.0.0.1:45123', url = origin + '/capture/';
  const details = { requestingUrl:url, isMainFrame:true, securityOrigin:origin };
  const request = (permission, requestDetails = details, requester = contents) => {
    let answer;
    window.requestPermission(requester, permission, value => { answer = value; }, requestDetails);
    return answer;
  };
  assert.equal(request('display-capture'), true, 'Exact desktop getUserMedia needs its display-capture grant');
  assert.equal(window.checkPermission(contents, 'display-capture', origin, details), true);
  const electronDetails = { ...details, securityOrigin:origin + '/' };
  assert.equal(request('display-capture', electronDetails), true, 'Electron 45 serializes securityOrigin with a trailing slash');
  assert.equal(window.checkPermission(contents, 'display-capture', origin + '/', electronDetails), true);
  for (const denied of [
    () => request('display-capture', details, {}),
    () => request('display-capture', { ...details, isMainFrame:false }),
    () => request('display-capture', { ...details, isMainFrame:undefined }),
    () => request('display-capture', { ...details, requestingUrl:origin + '/' }),
    () => request('display-capture', { ...details, requestingUrl:'https://untrusted.example/capture/' }),
    () => request('display-capture', { ...details, securityOrigin:'https://untrusted.example' }),
    () => request('display-capture', { ...details, securityOrigin:origin + '/other' }),
    () => request('display-capture', { ...details, securityOrigin:'http://user@127.0.0.1:45123/' }),
    () => request('media', { ...details, mediaTypes:['video'] }),
    () => request('media', { ...details, mediaTypes:['audio'] }),
    () => request('hid'), () => request('serial'), () => request('usb'),
    () => window.checkPermission(contents, 'display-capture', 'https://untrusted.example', details),
    () => window.checkPermission(contents, 'display-capture', origin + '/other', details),
    () => window.checkPermission(contents, 'display-capture', 'http://user@127.0.0.1:45123/', details),
    () => window.checkPermission(contents, 'display-capture', origin, { ...details, securityOrigin:'https://untrusted.example/' }),
    () => window.checkPermission(contents, 'display-capture', origin, { ...details, isMainFrame:false }),
    () => window.devicePermission({ origin, deviceType:'hid' }),
  ]) assert.equal(denied(), false);
  let grantedDisplayMedia;
  window.displayRequest({ frame:contents.mainFrame, securityOrigin:origin }, value => { grantedDisplayMedia = value; });
  assert.equal(grantedDisplayMedia, null, 'getDisplayMedia remains denied');
  contents.mainFrame.url = origin + '/';
  assert.equal(request('display-capture'), false, 'A different document cannot reuse the grant');
  contents.mainFrame.url = url;
  f.controller.abort(); await assert.rejects(f.start, { name:'AbortError' });
  assert.equal(request('display-capture'), false, 'An aborted capture cannot be granted permission');
});

test('refreshes system audio for a changed Windows output and revokes the temporary grant after acknowledgement', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let endpoint = 'first';
  const f = fixture({ defaultRenderEndpoint: async () => endpoint });
  const handle = await running(f);
  const window = f.windows[0], contents = window.webContents;
  const origin = 'http://127.0.0.1:45123';
  const permitted = () => window.checkPermission(contents, 'display-capture', origin,
    { isMainFrame: true, requestingUrl: origin + '/capture/' });
  assert.equal(permitted(), false);
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(window.command.type, 'start');
  endpoint = 'second';
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(window.command.type, 'refresh-audio');
  assert.equal(permitted(), true);
  await f.status({ type: 'audio_refreshed', ok: true, request: window.command.request - 1 });
  assert.equal(permitted(), true);
  await f.status({ type: 'audio_refreshed', ok: true, request: window.command.request });
  assert.equal(permitted(), false);
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(f.calls.filter(call => call[1] === 'refresh-audio').length, 1);
  await f.status({ type: 'audio_ended' });
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(f.calls.filter(call => call[1] === 'refresh-audio').length, 2);
  const stop = f.recorder.stop(handle);
  await f.status({ type: 'done', duration: 4, segments: 1 });
  await stop;
  assert.equal(permitted(), false);
});

test('rejects missing and ambiguous owned sources without a fallback window', async () => {
  for (const sources of [[{ id: 'screen:123:0' }], [{ id: 'window:123:0' }, { id: 'window:123:1' }]]) {
    const f = fixture({ sources });
    await assert.rejects(f.start, /owned window/i);
    assert.equal(f.windows.length, 0);
    assert.equal(f.calls.filter(call => call[0] === 'abort').length, 1);
  }
});

test('capture startup diagnostics preserve only allowlisted browser error names', async () => {
  const known = fixture(); await settle();
  await known.status({ type:'failed', reason:'capture_failed', errorName:'NotReadableError' });
  await assert.rejects(known.start, error => error.captureErrorName === 'NotReadableError');

  const unknown = fixture(); await settle();
  await unknown.status({ type:'failed', reason:'capture_failed', errorName:'private diagnostic text' });
  await assert.rejects(unknown.start, error => !Object.hasOwn(error, 'captureErrorName'));
});

test('rejects wrong frames, URLs and tokens without disturbing the owned capture', async () => {
  const f = fixture(); await settle();
  const window = f.windows[0];
  const ready = { type: 'ready', info: { video: 'avc1.640028', audio: 'mp4a.40.2' } };
  await assert.rejects(f.status(ready, { sender: window.webContents, senderFrame: { url: window.webContents.getURL() } }), /capture/i);
  await assert.rejects(f.status({ ...ready, token: 'wrong' }), /capture/i);
  const url = window.webContents.mainFrame.url;
  window.webContents.mainFrame.url = 'https://untrusted.example/';
  await assert.rejects(f.status(ready), /capture/i);
  window.webContents.mainFrame.url = url;
  const handle = await running(f);
  const stop = f.recorder.stop(handle); await f.status({ type: 'done', duration: 4, segments: 1 }); await stop;
  assert.deepEqual(f.failures, []);
});

test('abort before writer acquisition and during init immediately releases the capture window', async () => {
  const beginGate = deferred(), first = fixture({ beginGate });
  first.controller.abort(); await assert.rejects(first.start, { name: 'AbortError' });
  beginGate.resolve(first.writer); await settle();
  assert.equal(first.windows.length, 0);
  assert.equal(first.calls.filter(call => call[0] === 'abort').length, 1);
  const initGate = deferred(), second = fixture({ initGate });
  await settle(); await second.ready();
  const init = second.init(); init.catch(() => {}); await settle();
  second.controller.abort();
  assert.equal(second.windows[0].destroyed, true);
  await assert.rejects(second.start, { name: 'AbortError' });
  initGate.resolve(); await assert.rejects(init);
  await assert.rejects(second.fragment(1), /capture/i);
  assert.deepEqual(second.failures, []);
});

test('stop waits for the final packet acknowledgement before finishing the local writer', async () => {
  const f = fixture(), handle = await running(f);
  const gate = deferred(); f.writer.appendFragment = async packet => { f.calls.push(['fragment', packet.index]); await gate.promise; };
  const append = f.fragment(2); await settle();
  const stop = f.recorder.stop(handle);
  await f.status({ type: 'done', duration: 8, segments: 2 });
  await settle(); assert.equal(f.calls.some(call => call[0] === 'finish'), false);
  gate.resolve(); await append; await stop;
  assert.deepEqual(f.calls.filter(call => ['fragment', 'finish'].includes(call[0])).map(call => call[0]), ['fragment', 'fragment', 'finish']);
});

test('source loss after a durable fragment requests normal stop and saves once', async () => {
  let stop;
  const f = fixture({ onSourceEnded: () => { stop = f.recorder.stop(handle); return stop; } });
  const handle = await running(f);
  await f.status({ type: 'source_ended' });
  await f.status({ type: 'source_ended' });
  assert.deepEqual(f.sourceEnds, ['ended']);
  assert.equal(f.windows[0].destroyed, false);
  assert.equal(f.calls.some(call => call[0] === 'abort'), false);
  assert.equal(f.windows[0].command.type, 'stop');
  await f.status({ type: 'done', duration: 4, segments: 1 });
  const recording = await stop;
  assert.equal(recording.playable, true);
  assert.deepEqual(f.failures, []);
  assert.equal(f.calls.some(call => call[0] === 'finish'), true);
});

test('source loss during startup cannot complete an empty recording', async () => {
  const f = fixture(); await settle();
  await f.status({ type: 'source_ended' });
  await assert.rejects(f.start, /source ended before capture started/i);
  assert.equal(f.windows[0].destroyed, true);
  assert.deepEqual(f.sourceEnds, []);
  assert.equal(f.calls.some(call => call[0] === 'finish'), false);
  assert.equal(f.calls.filter(call => call[0] === 'abort').length, 1);
});

test('encoder failure after start still aborts and cannot complete', async () => {
  const f = fixture(), handle = await running(f);
  await f.status({ type: 'failed', reason: 'encoder_failed' });
  assert.equal(f.failures.length, 1);
  assert.equal(f.calls.filter(call => call[0] === 'abort').length, 1);
  await assert.rejects(f.recorder.stop(handle), /encoder/i);
  assert.equal(f.calls.some(call => call[0] === 'finish'), false);
});

test('more than two pending packets fails startup and immediately destroys the window', async () => {
  const initGate = deferred(), f = fixture({ initGate });
  await settle(); await f.ready();
  const results = Promise.allSettled([f.init(), f.fragment(1), f.fragment(2)]);
  await assert.rejects(f.start, /keep up/);
  assert.equal(f.windows[0].destroyed, true);
  initGate.resolve(); assert.ok((await results).every(result => result.status === 'rejected'));
  assert.deepEqual(f.failures, []);
});

test('startup and stop are bounded even if the writer never resolves', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = fixture(); await settle();
  t.mock.timers.tick(45_000);
  await assert.rejects(first.start, /startup timed out/);
  assert.equal(first.windows[0].destroyed, true);
  const second = fixture(), handle = await running(second), finish = deferred();
  second.writer.finish = () => finish.promise;
  const stop = second.recorder.stop(handle); stop.catch(() => {});
  await second.status({ type: 'done', duration: 4, segments: 1 }); await settle();
  t.mock.timers.tick(45_000);
  await assert.rejects(stop, /save timed out/);
  assert.equal(second.windows[0].destroyed, true);
  finish.resolve({ path: '/private/late.mp4', playable: true }); await settle();
});

const rendererSource = readFileSync(new URL('../capture/renderer.mjs', import.meta.url), 'utf8')
  .replace("import { CaptureSession } from '/web/reel/capture.js';", 'const CaptureSession = globalThis.TestCaptureSession;');
function rendererFixture(options = {}) {
  const acquire = deferred(), micAcquire = deferred(), calls = [], events = {}, tracks = [
    { kind: 'video', stopped: 0 }, { kind: 'audio', stopped: 0 },
  ];
  for (const track of tracks) {
    track.stop = () => { track.stopped++; };
    track.addEventListener = (name, callback) => { track[name] = callback; };
  }
  const stream = { getTracks: () => tracks, getVideoTracks: () => [tracks[0]], getAudioTracks: () => [tracks[1]] };
  const micTrack = { stopped: 0, stop() { this.stopped++; }, addEventListener(name, callback) { this[name] = callback; } };
  const micStream = { getTracks: () => [micTrack], getAudioTracks: () => [micTrack] };
  let command, instance;
  class CaptureSession {
    constructor(settings) { instance = this; this.settings = settings; this.events = settings.events; }
    async prepare() { await options.prepareGate?.promise; return { video: 'avc1.640028', audio: 'mp4a.40.2' }; }
    begin() { calls.push(['begin']); }
    async stop() { calls.push(['stop']); await options.stopGate?.promise; this.events.onSegment(1, 4, new Uint8Array([2])); return { duration: 4, segments: 1 }; }
    async cancel() { calls.push(['cancel']); }
  }
  const api = {
    onCommand: callback => { command = callback; }, ready: async () => { calls.push(['ready']); },
    appendInit: async () => { calls.push(['init']); await options.initGate?.promise; calls.push(['init-acked']); },
    appendFragment: async () => { calls.push(['fragment']); },
    appendAudio: async bytes => { calls.push(['audio', Array.from(bytes)]); await options.audioGate?.promise; },
    audioEnded: async () => { calls.push(['audio_ended']); },
    audioFailed: async () => { calls.push(['audio_failed']); },
    done: async () => { calls.push(['done']); }, sourceEnded: async () => { calls.push(['source_ended']); },
    failed: async reason => { calls.push(['failed', reason]); },
  };
  vm.runInNewContext(rendererSource, { TestCaptureSession: CaptureSession, Uint8Array,
    window: { reelCapture: api, addEventListener: (name, callback) => { events[name] = callback; } },
    document: { querySelector: () => ({ textContent: '' }) },
    navigator: { mediaDevices: { getUserMedia: constraints => { calls.push(['acquire', constraints]); return constraints.video === false ? micAcquire.promise : acquire.promise; } } },
  });
  return { acquire, micAcquire, micStream, micTrack, stream, tracks, calls, send: value => command(value), hide: () => events.pagehide(), get instance() { return instance; } };
}

test('microphone permission is restricted to the owned capture window and explicit opt-in', async () => {
  const f = fixture({ microphone: true }); await settle();
  const window = f.windows[0], contents = window.webContents;
  const origin = 'http://127.0.0.1:45123', url = origin + '/capture/';
  const details = { requestingUrl: url, isMainFrame: true, securityOrigin: origin, mediaTypes: ['audio'] };
  const request = (requester, value) => { let result; window.requestPermission(requester, 'media', answer => { result = answer; }, value); return result; };
  assert.equal(window.command.microphone, true);
  assert.equal(request(contents, details), true);
  assert.equal(request(contents, { ...details, mediaTypes: ['audio', 'video'] }), false);
  assert.equal(request(contents, { ...details, mediaTypes: ['video'] }), false);
  assert.equal(request({}, details), false);
  assert.equal(request(contents, { ...details, isMainFrame: false }), false);
  assert.equal(window.checkPermission(contents, 'media', origin, { ...details, mediaType: 'audio' }), true);
  assert.equal(window.checkPermission(contents, 'media', origin, { ...details, mediaType: 'video' }), false);
  f.controller.abort(); await assert.rejects(f.start, { name: 'AbortError' });
});

test('optional microphone joins the audio mix and is released when capture stops', async () => {
  const f = rendererFixture(); f.send({ type: 'start', sourceId: 'window:123:0', microphone: true });
  f.acquire.resolve(f.stream); await settle();
  f.micAcquire.resolve(f.micStream); await settle();
  assert.equal(f.instance.settings.mic, f.micStream);
  assert.equal(f.instance.settings.settings.audio, 'micAndSystem');
  f.send({ type: 'stop' }); await settle();
  assert.ok(f.micTrack.stopped > 0);
  assert.ok(f.tracks.every(track => track.stopped > 0));
});

test('microphone denial stops capture and releases the selected window', async () => {
  const f = rendererFixture(); f.send({ type: 'start', sourceId: 'window:123:0', microphone: true });
  f.acquire.resolve(f.stream); await settle();
  f.micAcquire.reject(new Error('Access denied')); await settle();
  assert.ok(f.tracks.every(track => track.stopped > 0));
  assert.ok(f.calls.some(call => call[0] === 'failed' && call[1] === 'microphone_unavailable'));
  assert.equal(f.instance, undefined);
});

test('a microphone arriving after the capture window closes is immediately released', async () => {
  const f = rendererFixture(); f.send({ type: 'start', sourceId: 'window:123:0', microphone: true });
  f.acquire.resolve(f.stream); await settle();
  f.hide(); f.micAcquire.resolve(f.micStream); await settle();
  assert.ok(f.micTrack.stopped > 0);
  assert.equal(f.instance, undefined);
});

test('renderer releases late acquisition and tracks immediately while prepare is still pending', async () => {
  const late = rendererFixture(); late.send({ type: 'start', sourceId: 'window:123:0' });
  late.hide(); late.acquire.resolve(late.stream); await settle();
  assert.ok(late.tracks.every(track => track.stopped > 0));
  assert.equal(late.instance, undefined);
  const prepareGate = deferred(), preparing = rendererFixture({ prepareGate });
  preparing.send({ type: 'start', sourceId: 'window:123:0' }); preparing.acquire.resolve(preparing.stream); await settle();
  preparing.hide(); assert.ok(preparing.tracks.every(track => track.stopped > 0));
  prepareGate.resolve(); await settle();
  assert.equal(preparing.calls.some(call => call[0] === 'begin'), false);
  const constraints = preparing.calls.find(call => call[0] === 'acquire')[1];
  assert.equal(constraints.video.mandatory.chromeMediaSourceId, 'window:123:0');
  assert.equal(constraints.audio.mandatory.chromeMediaSource, 'desktop');
});

test('renderer stops tracks before encoder flush and reports done only after all fragment ACKs', async () => {
  const initGate = deferred(), stopGate = deferred(), f = rendererFixture({ initGate, stopGate });
  f.send({ type: 'start', sourceId: 'window:123:0' }); f.acquire.resolve(f.stream); await settle();
  f.instance.events.onInit(new Uint8Array([1]));
  f.send({ type: 'stop' });
  assert.ok(f.tracks.every(track => track.stopped > 0));
  stopGate.resolve(); await settle();
  assert.equal(f.calls.some(call => call[0] === 'done'), false);
  initGate.resolve(); await settle();
  assert.ok(f.calls.findIndex(call => call[0] === 'done') > f.calls.findIndex(call => call[0] === 'init-acked'));
});

test('renderer source loss requests save once and releases tracks immediately', async () => {
  const f = rendererFixture(); f.send({ type: 'start', sourceId: 'window:123:0' });
  f.acquire.resolve(f.stream); await settle();
  f.tracks[0].ended(); f.instance.events.onSourceEnded();
  assert.ok(f.tracks.every(track => track.stopped > 0));
  assert.equal(f.calls.filter(call => call[0] === 'source_ended').length, 1);
  assert.equal(f.calls.some(call => call[0] === 'failed' || call[0] === 'cancel'), false);
  f.send({ type: 'stop' }); await settle();
  assert.equal(f.calls.some(call => call[0] === 'done'), true);
});

test('renderer queue overflow still aborts and releases tracks', async () => {
  const f = rendererFixture(); f.send({ type: 'start', sourceId: 'window:123:0' });
  f.acquire.resolve(f.stream); await settle();
  f.instance.events.onInit(new Uint8Array([1]));
  f.instance.events.onSegment(1, 4, new Uint8Array([2]));
  f.instance.events.onSegment(2, 4, new Uint8Array([3]));
  assert.ok(f.tracks.every(track => track.stopped > 0));
  assert.ok(f.calls.some(call => call[0] === 'failed' && call[1] === 'queue_overflow'));
});


test('renderer carries mixed PCM across block boundaries and waits for storage before done', async () => {
  const audioGate = deferred(), f = rendererFixture({ audioGate });
  f.send({ type: 'start', sourceId: 'window:123:0' }); f.acquire.resolve(f.stream); await settle();
  const block = values => ({ sampleRate: 48000, numberOfChannels: 1, numberOfFrames: values.length,
    copyTo: target => target.set(values) });
  f.instance.events.onAudio(block([0.5, 0.5]));
  f.instance.events.onAudio(block([0.5, -0.5, -0.5, -0.5, 0.25]));
  f.send({ type: 'stop' }); await settle();
  assert.equal(f.calls.some(call => call[0] === 'done'), false);
  audioGate.resolve(); await settle();
  assert.deepEqual(f.calls.filter(call => call[0] === 'audio').flatMap(call => call[1]), [0, 64, 0, 192, 0, 32]);
  assert.equal(f.calls.some(call => call[0] === 'done'), true);
});

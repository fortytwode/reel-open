import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DEADLINE_MS = 45_000;
const AUDIO_POLL_MS = 1000;
const AUDIO_REFRESH_TIMEOUT_MS = 5000;
const MAX_PACKET = 16 * 1024 * 1024;
const MAX_PENDING = 32 * 1024 * 1024;
const COMMAND = 'reel-capture:command';
const check = (condition, message) => { if (!condition) throw Error(message); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const abortError = () => Object.assign(Error('Recording startup was cancelled.'), { name: 'AbortError' });

/** Main-process adapter for the exact window returned by the native join helper.
 * The only renderer media path is the Windows Electron 45 probe's exact-source getUserMedia.
 * onFailure fires once for a capture that has already returned its handle.
 */
export function createWindowsRecorder({ BrowserWindow, desktopCapturer, ipcMain, store, origin,
  defaultRenderEndpoint, samplePrimaryClick, onFailure = () => {}, onCompleted = () => {}, onSourceEnded = () => { throw Error('Recording source ended without a save handler.'); } } = {}) {
  const parsed = new URL(origin);
  check(parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && parsed.port
    && parsed.origin === origin, 'A private loopback capture origin is required');
  check(typeof BrowserWindow === 'function' && typeof desktopCapturer?.getSources === 'function'
    && typeof ipcMain?.handle === 'function' && typeof store?.begin === 'function'
    && typeof onFailure === 'function' && typeof onSourceEnded === 'function', 'Invalid recorder dependencies');
  const captureURL = origin + '/capture/';
  const preload = fileURLToPath(new URL('../capture/preload.cjs', import.meta.url));
  const captures = new Map(), handles = new WeakMap();
  let current = null;
  const terminal = capture => ['failed', 'completed'].includes(capture.phase);
  function destroy(capture) {
    if (capture.window && !capture.window.isDestroyed()) capture.window.destroy();
  }
  function clear(capture) {
    clearTimeout(capture.timer);
    clearTimeout(capture.audioTimer);
    capture.pauseChange?.reject(Error('Recording ended during pause control.'));
    capture.signal?.removeEventListener('abort', capture.onAbort);
    captures.delete(capture.token);
    if (current === capture) current = null;
  }
  function fail(capture, error) {
    if (terminal(capture)) return;
    capture.phase = 'failed'; capture.failure = error;
    clear(capture); destroy(capture);
    capture.cleanup = Promise.resolve(capture.writer?.abort()).catch(() => {});
    capture.started.reject(error); capture.done.reject(error); capture.failed.reject(error);
    if (capture.returned) { try { onFailure(error); } catch { /* composition listener isolation */ } }
  }
  function authenticate(event, message) {
    const capture = captures.get(message?.token), contents = capture?.window?.webContents;
    check(capture && !terminal(capture) && event.sender === contents && event.senderFrame === contents.mainFrame
      && event.senderFrame.url === captureURL && contents.getURL() === captureURL, 'Unrecognized capture request');
    return capture;
  }
  async function readAudioEndpoint() {
    try { return await defaultRenderEndpoint?.(); }
    catch { return null; }
  }
  function watchAudioEndpoint(capture) {
    if (!defaultRenderEndpoint || capture.phase !== 'recording') return;
    capture.audioTimer = setTimeout(async () => {
      const endpoint = await readAudioEndpoint();
      if (capture.phase !== 'recording') return;
      const now = Date.now();
      if (capture.audioRefresh && capture.audioRefresh.deadline <= now) capture.audioRefresh = null;
      if (endpoint && endpoint !== capture.audioEndpoint && !capture.audioRefresh) {
        const request = ++capture.audioRequest;
        capture.audioRefresh = { endpoint, request, deadline: now + AUDIO_REFRESH_TIMEOUT_MS };
        capture.window.webContents.send(COMMAND, { type: 'refresh-audio', token: capture.token, request, deadline: capture.audioRefresh.deadline });
      }
      watchAudioEndpoint(capture);
    }, AUDIO_POLL_MS);
    capture.audioTimer.unref?.();
  }
  function maybeStarted(capture) {
    if (capture.phase !== 'starting' || !capture.ready || !capture.init || capture.index < 1) return;
    capture.phase = 'recording'; capture.returned = true;
    clearTimeout(capture.timer);
    capture.signal?.removeEventListener('abort', capture.onAbort);
    capture.started.resolve(capture.handle);
    watchAudioEndpoint(capture);
  }
  ipcMain.handle('reel-capture:status', async (event, message) => {
    const capture = authenticate(event, message);
    try {
      if (message.type === 'ready') {
        check(capture.phase === 'starting' && !capture.ready && /^avc1\./.test(message.info?.video ?? '')
          && message.info?.audio === 'mp4a.40.2', 'Recording requires H.264 and AAC encoders');
        capture.ready = true; maybeStarted(capture);
      } else if (message.type === 'done') {
        check(capture.phase === 'stopping' && Number.isFinite(message.duration) && message.duration > 0
          && Number.isInteger(message.segments) && message.segments > 0, 'Unexpected recording completion');
        check(!capture.doneReceived, 'Duplicate recording completion');
        capture.doneReceived = true; capture.done.resolve({ duration: message.duration, segments: message.segments });
      } else if (message.type === 'pause_changed') {
        check(typeof message.paused === 'boolean', 'Invalid pause acknowledgement');
        const change = capture.pauseChange;
        if (change && change.paused === message.paused && capture.phase === 'recording') {
          capture.paused = message.paused;
          change.resolve();
        }
      } else if (message.type === 'audio_ended') {
        if (capture.phase === 'starting') fail(capture, Error('System audio ended before capture started.'));
        else if (capture.phase === 'recording' && defaultRenderEndpoint) capture.audioEndpoint = null;
      } else if (message.type === 'audio_refreshed') {
        if (capture.phase === 'recording' && capture.audioRefresh && capture.audioRefresh.request === message.request) {
          if (message.ok === true) capture.audioEndpoint = capture.audioRefresh.endpoint;
          capture.audioRefresh = null;
        } else if (capture.phase === 'recording' && message.ok === true &&
          Number.isSafeInteger(message.request) && message.request > 0 && message.request <= capture.audioRequest) {
          // A late acknowledgement may have changed the installed track just before expiry.
          capture.audioEndpoint = null;
        }
      } else if (message.type === 'audio_failed') {
        capture.writer.failAudio?.();
      } else if (message.type === 'source_ended') {
        if (capture.phase === 'starting') fail(capture, Error('The recording source ended before capture started.'));
        else if (capture.phase === 'recording' && !capture.sourceEndRequested) {
          capture.sourceEndRequested = true;
          try { Promise.resolve(onSourceEnded()).catch(error => fail(capture, error)); }
          catch (error) { fail(capture, error); }
        }
      } else if (message.type === 'failed') {
        const reasons = { source_ended: 'The recording source ended.', write_failed: 'The recording could not be saved.',
          queue_overflow: 'Recording storage cannot keep up.', encoder_failed: 'The recording encoder failed.',
          capture_failed: 'The meeting window could not be captured.',
          microphone_unavailable: 'The microphone could not be captured. Check Windows microphone permissions or turn off Include my microphone.' };
        const error = Error(reasons[message.reason] ?? 'The meeting recording failed.');
        if (message.reason === 'microphone_unavailable') error.code = message.reason;
        if (message.reason === 'capture_failed' && ['AbortError', 'NotAllowedError', 'NotFoundError', 'NotReadableError',
          'OverconstrainedError', 'TypeError', 'UnknownError'].includes(message.errorName)) error.captureErrorName = message.errorName;
        fail(capture, error);
      } else throw Error('Unexpected capture status');
      return { ok: true };
    } catch (error) { fail(capture, error); throw error; }
  });
  ipcMain.handle('reel-capture:click', async (event, message) => {
    const capture = authenticate(event, message);
    // Media capture begins as soon as the encoders are ready. Waiting for the
    // first saved fragment here would permanently disable the renderer's poll.
    const acceptingFrames = capture.ready && (capture.phase === 'starting' || capture.phase === 'recording');
    check(capture.manual && capture.clickSamplingEnabled && acceptingFrames && !capture.paused && capture.selectedHwnd,
    'Click indicators are available only during an active manual window recording.');
    try { return await samplePrimaryClick(capture.selectedHwnd); }
    catch {
      capture.clickSamplingEnabled = false;
      if (capture.window && !capture.window.isDestroyed()) capture.window.webContents.send(COMMAND, { type: 'click-sampling', token: capture.token, enabled: false });
      return null;
    }
  });
  ipcMain.handle('reel-capture:packet', async (event, message) => {
    const capture = authenticate(event, message);
    try {
      check(capture.ready && !capture.doneReceived, 'Recording is not accepting packets');
      check(['init', 'fragment'].includes(message.kind) && message.bytes instanceof Uint8Array
        && message.bytes.byteLength > 0 && message.bytes.byteLength <= MAX_PACKET, 'Invalid recording packet');
      check(capture.pendingPackets < 2 && capture.pendingBytes + message.bytes.byteLength <= MAX_PENDING,
        'Recording storage cannot keep up.');
      capture.pendingPackets++; capture.pendingBytes += message.bytes.byteLength;
      const operation = capture.packets.then(async () => {
        if (capture.failure) throw capture.failure;
        if (message.kind === 'init') {
          check(!capture.init, 'Duplicate recording init');
          await capture.writer.appendInit(message.bytes);
          if (capture.failure) throw capture.failure;
          capture.init = true;
        } else {
          check(capture.init && Number.isInteger(message.index) && message.index === capture.index + 1,
            'Recording fragment is out of order');
          await capture.writer.appendFragment({ index: message.index, duration: message.duration, bytes: message.bytes });
          if (capture.failure) throw capture.failure;
          capture.index = message.index;
        }
        maybeStarted(capture);
      });
      capture.packets = operation.catch(() => {});
      try { await operation; }
      finally { capture.pendingPackets--; capture.pendingBytes -= message.bytes.byteLength; }
      return { ok: true };
    } catch (error) { fail(capture, error); throw error; }
  });
  ipcMain.handle('reel-capture:audio', async (event, message) => {
    const capture = authenticate(event, message);
    try {
      check(capture.ready && !capture.doneReceived && message.bytes instanceof Uint8Array && message.bytes.byteLength > 0 && message.bytes.byteLength <= MAX_PACKET, 'Invalid audio packet');
      await capture.writer.appendAudio(message.bytes);
      return { ok: true };
    } catch (error) { capture.writer.failAudio?.(); throw error; }
  });
  async function initialize(capture, args) {
    const title = args.manual === true ? args.title : (args.meeting.title || 'Meeting');
    const writer = await store.begin({ ownerUserID: args.ownerUserID, title,
      createdAt: new Date().toISOString(), meeting: args.manual === true ? { manual: true }
        : { attendees: args.meeting.attendeeEmails ?? [], calendar: args.meeting.calendar ?? null } });
    capture.writer = writer;
    if (terminal(capture)) { await writer.abort(); return; }
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
    if (terminal(capture)) return;
    const matches = sources.filter(source => {
      const match = /^window:(\d+):([01])$/.exec(source?.id ?? '');
      return match && BigInt(match[1]) === BigInt(args.hwnd)
        && (args.manual !== true || String(source.name ?? '') === args.sourceName);
    });
    check(matches.length === 1, 'Expected one exact owned window capture source.');
    const window = capture.window = new BrowserWindow({ width: 400, height: 180, show: false,
      webPreferences: { preload, partition: `reel-capture-${capture.token}`, sandbox: true,
        contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    const contents = window.webContents, session = contents.session;
    const ownedOrigin = value => value === origin || value === origin + '/';
    const ownedCaptureRequest = (requester, details) =>
      (capture.phase === 'starting' || (capture.phase === 'recording' && capture.audioRefresh?.deadline > Date.now()))
      && requester === contents
      && details?.isMainFrame === true && details.requestingUrl === captureURL
      && contents.mainFrame.url === captureURL && contents.getURL() === captureURL
      && (details.securityOrigin === undefined || ownedOrigin(details.securityOrigin));
    const permittedCapture = (requester, permission, details, isCheck = false) => {
      if (!ownedCaptureRequest(requester, details)) return false;
      if (permission === 'display-capture') return true;
      if (permission !== 'media' || capture.phase !== 'starting' || args.microphone !== true) return false;
      if (isCheck) return details?.mediaType === 'audio';
      return Array.isArray(details?.mediaTypes) && details.mediaTypes.length === 1 && details.mediaTypes[0] === 'audio';
    };
    session.setPermissionCheckHandler((requester, permission, requestingOrigin, details) =>
      ownedOrigin(requestingOrigin) && permittedCapture(requester, permission, details, true));
    session.setPermissionRequestHandler((requester, permission, callback, details) =>
      callback(permittedCapture(requester, permission, details)));
    session.setDevicePermissionHandler(() => false);
    // No getDisplayMedia picker/fallback is used. This renderer gets only its selected desktop source.
    session.setDisplayMediaRequestHandler((_request, callback) => callback(null));
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', event => event.preventDefault());
    contents.on('will-redirect', event => event.preventDefault());
    contents.on('render-process-gone', () => fail(capture, Error('The recording renderer stopped.')));
    window.on('unresponsive', () => fail(capture, Error('The recording renderer stopped responding.')));
    window.on('closed', () => { if (!terminal(capture)) fail(capture, Error('The recording window closed.')); });
    await window.loadURL(captureURL);
    capture.audioEndpoint = await readAudioEndpoint();
    if (terminal(capture)) return;
    contents.send(COMMAND, { type: 'start', token: capture.token, sourceId: matches[0].id, canRefreshAudio: Boolean(defaultRenderEndpoint),
      microphone: args.microphone, ...(capture.clickSamplingEnabled ? { selectedHwnd: capture.selectedHwnd } : {}) });
  }
  function start(args = {}) {
    try {
      check(!current, 'A meeting recording is already active.');
      check(typeof args.hwnd === 'string' && /^[1-9]\d{0,19}$/.test(args.hwnd)
        && (args.manual === true ? args.pid === undefined && args.meeting?.manual === true && typeof args.title === 'string'
          && args.title.trim().length > 0 && args.title.length <= 160 && typeof args.sourceName === 'string'
          && args.sourceName.length <= 1024 : Number.isSafeInteger(args.pid) && args.pid > 0
          && args.meeting && typeof args.meeting === 'object')
        && typeof args.ownerUserID === 'string' && args.ownerUserID.length > 0
        && args.systemAudio === true && typeof args.microphone === 'boolean' && args.signal
        && (args.highlightClicks === undefined || typeof args.highlightClicks === 'boolean')
        && typeof args.signal.addEventListener === 'function', 'Invalid meeting capture request');
      if (args.signal.aborted) throw abortError();
      const token = randomBytes(16).toString('hex'), handle = Object.freeze({ id: token });
      const capture = { manual: args.manual === true, selectedHwnd: args.manual === true ? args.hwnd : null,
        clickSamplingEnabled: args.manual === true && args.highlightClicks !== false && typeof samplePrimaryClick === 'function', paused: false,
        ownerUserID: args.ownerUserID, token, handle, phase: 'starting', signal: args.signal, window: null, writer: null,
        started: deferred(), done: deferred(), failed: deferred(), ready: false, init: false, index: 0,
        audioRequest: 0, pendingPackets: 0, pendingBytes: 0, packets: Promise.resolve(), returned: false };
      // done may reject before stop() is called; the start promise remains owned by the caller.
      capture.done.promise.catch(() => {});
      capture.failed.promise.catch(() => {});
      capture.onAbort = () => fail(capture, abortError());
      current = capture; captures.set(token, capture); handles.set(handle, capture);
      args.signal.addEventListener('abort', capture.onAbort, { once: true });
      capture.timer = setTimeout(() => fail(capture, Error('Recording startup timed out.')), DEADLINE_MS);
      capture.timer.unref?.();
      if (args.signal.aborted) capture.onAbort();
      else void initialize(capture, args).catch(error => fail(capture, error));
      return capture.started.promise;
    } catch (error) { return Promise.reject(error); }
  }
  async function setPaused(handle, paused) {
    const capture = handles.get(handle);
    check(capture?.manual && capture.phase === 'recording' && !capture.pauseChange, 'Cannot change pause state.');
    if (paused) capture.paused = true;
    const change = capture.pauseChange = { ...deferred(), paused };
    const timer = setTimeout(() => change.reject(Error('The recorder did not confirm the pause control.')), 5000);
    try {
      capture.window.webContents.send(COMMAND, { type: paused ? 'pause' : 'resume', token: capture.token });
      await change.promise;
    } finally { clearTimeout(timer); capture.pauseChange = null; }
  }
  function stop(handle) {
    const capture = handle && handles.get(handle);
    if (!capture) return Promise.reject(Error('Unknown recording handle.'));
    if (capture.stopPromise) return capture.stopPromise;
    if (capture.failure) return Promise.reject(capture.failure);
    capture.phase = 'stopping';
    capture.pauseChange?.reject(Error('Recording is being saved.'));
    clearTimeout(capture.audioTimer);
    capture.timer = setTimeout(() => fail(capture, Error('Recording save timed out.')), DEADLINE_MS);
    capture.timer.unref?.();
    const finish = (async () => {
      try {
        capture.window.webContents.send(COMMAND, { type: 'stop', token: capture.token });
        const done = await capture.done.promise;
        await capture.packets;
        if (capture.failure) throw capture.failure;
        check(done.segments === capture.index, 'Recording ended before every fragment was saved');
        const recording = await capture.writer.finish({ durationSeconds: done.duration });
        if (capture.failure) throw capture.failure;
        capture.phase = 'completed'; clear(capture); destroy(capture);
        try { onCompleted({ ownerUserID: capture.ownerUserID, recording }); } catch {}
        return recording;
      } catch (error) { fail(capture, error); throw error; }
    })();
    capture.stopPromise = Promise.race([finish, capture.failed.promise]);
    return capture.stopPromise;
  }
  return { start, stop, setPaused };
}

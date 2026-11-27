import { CaptureSession } from '/web/reel/capture.js';

const api = window.reelCapture;
const status = document.querySelector('#status');
const MAX_PACKET = 16 * 1024 * 1024;
const MAX_PENDING = 32 * 1024 * 1024;
let stream = null, microphone = null, capture = null, failed = false, stopping = false, starting = false, sourceEnding = false, stopPromise;
let sourceId, canRefreshAudio, refreshingAudio = false;
let pendingBytes = 0, audioPending = 0, audioFailed = false, audioOffset = 0, audioSum = 0, audioCount = 0;
const audioWrites = new Set();
let audioFailureNotice = Promise.resolve();
function sidecarFailure() { if (!audioFailed) { audioFailed = true; audioFailureNotice = api.audioFailed().catch(() => {}); } }
function sendAudio(bytes) {
  if (audioPending + bytes.length > MAX_PENDING) throw Error('Audio storage cannot keep up');
  audioPending += bytes.length;
  const operation = api.appendAudio(bytes).catch(sidecarFailure).finally(() => { audioPending -= bytes.length; audioWrites.delete(operation); });
  audioWrites.add(operation);
}
function audioBlock(value) {
  if (audioFailed) return;
  try {
    if (value.sampleRate !== 48000 || value.numberOfChannels < 1) throw Error('Unexpected audio format');
    const planes = Array.from({ length: value.numberOfChannels }, (_, planeIndex) => {
      const plane = new Float32Array(value.numberOfFrames);
      value.copyTo(plane, { planeIndex, format: 'f32-planar' }); return plane;
    });
    const output = new Int16Array(Math.ceil(value.numberOfFrames / 3)); let n = 0;
    for (let i = 0; i < value.numberOfFrames; i++) {
      let sample = 0; for (const plane of planes) sample += plane[i] / planes.length;
      audioSum += sample; audioCount++; audioOffset++;
      if (audioOffset === 3) {
        const v = Math.max(-1, Math.min(1, audioSum / audioCount));
        output[n++] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
        audioOffset = 0; audioSum = 0; audioCount = 0;
      }
    }
    if (!n) return;
    const bytes = new Uint8Array(output.buffer, 0, n * 2);
    sendAudio(bytes);
  } catch { sidecarFailure(); }
}
const pending = new Set();
function releaseTracks() { stream?.getTracks().forEach(track => track.stop()); microphone?.getTracks().forEach(track => track.stop()); }
function fail(reason, diagnosticName = null) {
  if (failed) return;
  failed = true; releaseTracks();
  status.textContent = 'The meeting recording stopped.';
  if (capture) void capture.cancel().catch(() => {});
  void api.failed(reason, diagnosticName).catch(() => {});
}
function sourceEnded() {
  if (failed || stopping || sourceEnding) return;
  sourceEnding = true;
  releaseTracks();
  void api.sourceEnded().catch(() => fail('source_ended'));
}
function append(kind, index, duration, bytes) {
  if (failed) return;
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > MAX_PACKET
    || pending.size >= 2 || pendingBytes + bytes.byteLength > MAX_PENDING) { fail('queue_overflow'); return; }
  const size = bytes.byteLength; pendingBytes += size;
  const operation = Promise.resolve().then(() => kind === 'init' ? api.appendInit(bytes) : api.appendFragment(index, duration, bytes))
    .catch(() => { fail('write_failed'); })
    .finally(() => { pending.delete(operation); pendingBytes -= size; });
  pending.add(operation);
}
function watchAudioTrack(track) {
  track.addEventListener('ended', () => {
    if (failed || stopping || sourceEnding || stream?.getAudioTracks()[0] !== track) return;
    if (canRefreshAudio) void api.audioEnded().catch(() => {});
    else sourceEnded();
  });
}
function acquireWindow(id) {
  const mandatory = { chromeMediaSource: 'desktop', chromeMediaSourceId: id };
  return navigator.mediaDevices.getUserMedia({
    video: { mandatory: { ...mandatory, maxWidth: 960, maxHeight: 600, maxFrameRate: 15 } }, audio: { mandatory },
  });
}
async function refreshAudio(request, deadline) {
  if (refreshingAudio || failed || stopping || sourceEnding || !capture || Date.now() >= deadline) return;
  refreshingAudio = true;
  let refreshed, installed = false;
  try {
    // Chromium requires video in the same request for this loopback stream.
    refreshed = await acquireWindow(sourceId);
    if (failed || stopping || sourceEnding || Date.now() >= deadline) return;
    const replacement = refreshed.getAudioTracks()[0];
    if (replacement?.readyState !== 'live' || refreshed.getAudioTracks().length !== 1) throw Error('Desktop audio required');
    const old = stream.getAudioTracks()[0];
    capture.replaceSystemAudio(replacement);
    stream.removeTrack(old);
    stream.addTrack(replacement);
    old.stop();
    watchAudioTrack(replacement);
    installed = true;
  } catch { /* The main process can retry if the default endpoint is still different. */ }
  finally {
    if (installed) refreshed.getVideoTracks().forEach(track => track.stop());
    else refreshed?.getTracks().forEach(track => track.stop());
    refreshingAudio = false;
    if (!failed && !stopping && !sourceEnding) await api.audioRefreshed(request, installed).catch(() => {});
  }
}
async function start({ sourceId: selectedSource, canRefreshAudio: refreshEnabled, microphone: includeMicrophone }) {
  if (starting || failed || stopping) return;
  starting = true;
  try {
    if (!/^window:\d+:[01]$/.test(selectedSource ?? '')) throw Error('Invalid owned source');
    sourceId = selectedSource;
    canRefreshAudio = refreshEnabled === true;
    const acquired = await acquireWindow(sourceId);
    if (failed || stopping) { acquired.getTracks().forEach(track => track.stop()); return; }
    stream = acquired;
    if (stream.getVideoTracks().length !== 1 || stream.getAudioTracks().length !== 1) throw Error('Desktop video and audio required');
    stream.getVideoTracks()[0].addEventListener('ended', sourceEnded);
    watchAudioTrack(stream.getAudioTracks()[0]);
    if (includeMicrophone) {
      try { microphone = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); }
      catch { if (!failed && !stopping) fail('microphone_unavailable'); return; }
      if (failed || stopping) { releaseTracks(); return; }
      if (microphone.getAudioTracks().length !== 1) throw Error('Microphone audio required');
      microphone.getAudioTracks()[0].addEventListener('ended', sourceEnded);
    }
    capture = new CaptureSession({
      settings: { quality: 'p720', fps: 15, audio: includeMicrophone ? 'micAndSystem' : 'systemOnly', bubbleSize: 'medium' },
      display: stream, camera: null, mic: microphone, composite: false,
      events: { onTick: () => {
        if (capture.pauseConfirmed && !stopping) void api.pauseChanged(true).catch(() => {});
      }, onAudio: audioBlock, onInit: bytes => append('init', 0, 0, bytes),
        onSegment: (index, duration, bytes) => append('fragment', index, duration, bytes),
        onError: () => fail('encoder_failed'), onSourceEnded: sourceEnded },
    });
    const info = await capture.prepare();
    if (failed || stopping) { releaseTracks(); return; }
    if (!/^avc1\./.test(info.video ?? '') || info.audio !== 'mp4a.40.2') throw Error('H.264 and AAC required');
    await api.ready(info);
    if (failed || stopping) { releaseTracks(); return; }
    capture.begin(); status.textContent = 'Recording the meeting locally. All computer sound is included.';
  } catch (error) { fail('capture_failed', error?.name); }
}
function stop() {
  if (stopPromise) return stopPromise;
  stopping = true;
  // Release devices before awaiting the encoder, IPC, or filesystem.
  releaseTracks();
  stopPromise = (async () => {
    try {
      if (!capture || failed) throw Error('Recording did not start');
      const done = await capture.stop();
      while (pending.size) await Promise.all([...pending]);
      if (!audioFailed && audioCount) {
        const v = Math.max(-1, Math.min(1, audioSum / audioCount));
        const last = new Int16Array([v < 0 ? Math.round(v * 32768) : Math.round(v * 32767)]);
        try { sendAudio(new Uint8Array(last.buffer)); } catch { sidecarFailure(); }
      }
      while (audioWrites.size) await Promise.all([...audioWrites]);
      await audioFailureNotice;
      if (failed) return;
      await api.done(done); status.textContent = 'Recording saved locally.';
    } catch { fail('encoder_failed'); }
    finally { releaseTracks(); }
  })();
  return stopPromise;
}
window.addEventListener('pagehide', () => { stopping = true; releaseTracks(); });
api.onCommand(command => {
  if (command.type === 'start') void start(command);
  else if (command.type === 'refresh-audio') void refreshAudio(command.request, command.deadline);
  else if (command.type === 'stop') void stop();
  else if (!stopping && !failed && capture) {
    if (command.type === 'pause') {
      if (capture.pauseConfirmed) void api.pauseChanged(true).catch(() => {});
      else capture.pause();
    } else if (command.type === 'resume') {
      capture.resume({ dropScreenFrame: true });
      void api.pauseChanged(false).catch(() => {});
    }
  }
});

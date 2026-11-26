import { bitrate } from '/web/reel/core.js';

const canvas = document.querySelector('#source');
const context = canvas.getContext('2d', { alpha: false });
context.fillStyle = '#ef12c5'; context.fillRect(0, 0, 480, 300);
context.fillStyle = '#12e9a4'; context.fillRect(480, 0, 480, 300);
context.fillStyle = '#12e9a4'; context.fillRect(0, 300, 480, 300);
context.fillStyle = '#ef12c5'; context.fillRect(480, 300, 480, 300);
context.fillStyle = '#111'; context.fillRect(180, 250, 600, 100);
context.fillStyle = '#fff'; context.font = 'bold 36px sans-serif'; context.fillText('SYNTHETIC REEL ENCODER', 210, 315);
const videoTrack = canvas.captureStream(15).getVideoTracks()[0];
const screen = new MediaStreamTrackProcessor({ track: videoTrack }).readable;
const worker = new Worker('/web/reel/encoder-worker.js', { type: 'module', name: 'reel-packaged-encoder-smoke' });
const status = document.querySelector('#status');
const pending = new Set();
let audioFrames = 0, codecs = null, segmentCount = 0, duration = 0, startedAt = 0, stopping = false, failed = false;
let audioTimer = null;
let videoTimer = null;
const send = (url, data, headers = {}) => {
  const operation = fetch(url, { method: 'POST', body: data, headers }).then(async response => {
    if (!response.ok) throw Error(`Local synthetic writer failed: ${response.status} ${await response.text()}`);
  }).finally(() => pending.delete(operation));
  pending.add(operation);
  return operation;
};
async function fail(error) {
  if (failed) return;
  failed = true; clearInterval(audioTimer); clearInterval(videoTimer); videoTrack.stop(); worker.terminate();
  await fetch('/failure', { method: 'POST', body: JSON.stringify({ message: String(error?.stack || error?.message || error) }) }).catch(() => {});
}
function sendAudio() {
  if (failed || stopping || audioFrames >= 14 * 48000) return;
  const numberOfFrames = 3840;
  const pcm = new Float32Array(numberOfFrames * 2);
  for (let i = 0; i < numberOfFrames; i++) {
    const sample = Math.sin(2 * Math.PI * 440 * (audioFrames + i) / 48000) * 0.12;
    pcm[i] = sample; pcm[numberOfFrames + i] = sample;
  }
  const data = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames, numberOfChannels: 2,
    timestamp: Math.round(audioFrames * 1e6 / 48000), data: pcm });
  worker.postMessage({ type: 'audio', data }, [data]);
  audioFrames += numberOfFrames;
}
worker.onmessage = async ({ data }) => {
  try {
    if (data.type === 'ready') {
      codecs = { video: data.video, audio: data.audio };
      if (!/^avc1\./.test(data.video || '') || data.audio !== 'mp4a.40.2') throw Error(`Expected H.264/AAC, got ${JSON.stringify(codecs)}`);
      status.textContent = `Encoding synthetic video + 440 Hz PCM (${data.video}, ${data.audio})`;
      startedAt = performance.now(); worker.postMessage({ type: 'begin' });
      audioTimer = setInterval(sendAudio, 80); sendAudio();
      videoTimer = setInterval(() => {
        context.fillStyle = Math.floor(performance.now() / 100) % 2 ? '#111' : '#fff';
        context.fillRect(465, 333, 30, 8);
      }, 1000 / 15);
      setTimeout(() => { if (!failed && !stopping) { stopping = true; duration = (performance.now() - startedAt) / 1000; clearInterval(audioTimer); worker.postMessage({ type: 'stop' }); } }, 13_500);
    } else if (data.type === 'init') {
      await send('/init', data.bytes);
    } else if (data.type === 'segment') {
      segmentCount++;
      await send('/segment', data.bytes, { 'X-Fragment-Index': String(data.index), 'X-Fragment-Duration': String(data.duration) });
    } else if (data.type === 'error') {
      await fail(Error(data.message));
    } else if (data.type === 'done') {
      stopping = true; clearInterval(audioTimer); clearInterval(videoTimer); videoTrack.stop(); await Promise.all([...pending]);
      const response = await fetch('/finish', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration, segmentCount, codecs, audioFrames, audioSeconds: data.audioSeconds }) });
      if (!response.ok) throw Error(`Local synthetic writer finish failed: ${response.status} ${await response.text()}`);
      worker.terminate(); status.textContent = 'Synthetic capture complete.';
    }
  } catch (error) { await fail(error); }
};
worker.onerror = event => { void fail(Error(event.message || 'Encoder worker failed.')); };
worker.postMessage({ type: 'start', width: 960, height: 600, fps: 15, bitrate: bitrate(960, 600, 15),
  layout: 'screen', composite: false, screen, camera: null, audio: true, audioSampleRate: 48000, audioChannels: 2 }, [screen]);

// Recorder engine (module worker): the browser counterpart of RecordingSession + Compositor +
// SegmentedWriter. Screen/camera frames arrive as ReadableStreams; mixed audio arrives as AudioData
// (MediaStreamTrackProcessor). A fixed-rate clock composites the latest frames (camera bubble
// in the corner when the bubble window itself isn't part of the capture), WebCodecs encodes
// H.264 (keyframe every 4 s) + AAC 48 kHz stereo (Opus if the browser has no AAC encoder), and
// mp4-muxer writes fragmented MP4 that is cut into init.mp4 + 4 s segments for live HLS upload.
// Paused time is removed (PauseClock), like Loom's "time shift on pause".
// Runs in a worker so background-tab timer throttling never stalls the frame clock.
import { AudioBatch } from "./audio.js?v=20261025-audio1";
import { Muxer, StreamTarget } from "../vendor/mp4-muxer.mjs";
import { SegmentSplitter, parseInit, fragmentDuration } from "./fmp4.js";
import { PauseClock, SEGMENT_INTERVAL } from "./core.js";

let S = null;
const post = (m, transfer) => self.postMessage(m, transfer || []);
const now = () => performance.now() / 1000;

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "start") await start(m);
    else if (m.type === "audio") encodeAudio(m.data);
    else if (m.type === "begin") begin();
    else if (m.type === "pause") {
      S.clock.pause(now());
      postTick(m.pauseID);
    }
    else if (m.type === "resume") { S.clock.resume(now()); }
    else if (m.type === "layout") { S.composite = m.composite; S.bubbleScale = m.bubbleScale ?? S.bubbleScale; }
    else if (m.type === "stop") await stop();
    else if (m.type === "cancel") cancel();
  } catch (err) {
    post({ type: "error", message: String(err && err.message || err) });
  }
};

async function pickVideoConfig(width, height, fps, bitrate) {
  const level = width * height > 1920 * 1088 ? "33" : "28";
  const candidates = [`avc1.6400${level}`, `avc1.4d00${level}`, `avc1.4200${level}`];
  for (const hw of ["prefer-hardware", "no-preference"]) {
    for (const codec of candidates) {
      const config = { codec, width, height, bitrate, framerate: fps, latencyMode: "realtime", hardwareAcceleration: hw, avc: { format: "avc" } };
      try { if ((await VideoEncoder.isConfigSupported(config)).supported) return config; } catch {}
    }
  }
  throw new Error("This browser can't encode H.264 video (WebCodecs). Use an up-to-date Chrome or Edge.");
}
async function pickAudioConfig(sampleRate, numberOfChannels) {
  for (const [codec, muxCodec, br] of [["mp4a.40.2", "aac", 128000], ["opus", "opus", 128000]]) {
    const config = { codec, sampleRate, numberOfChannels, bitrate: br };
    try { if ((await AudioEncoder.isConfigSupported(config)).supported) return { config, muxCodec }; } catch {}
  }
  throw new Error("This browser can't encode AAC or Opus audio (WebCodecs).");
}

async function start(m) {
  const { width, height, fps, bitrate } = m;
  S = {
    width, height, fps, layout: m.layout, composite: !!m.composite, bubbleScale: m.bubbleScale || 1,
    clock: new PauseClock(), frames: 0, nextKeyFrame: 0, audioFrames: 0,
    audioChannels: m.audioChannels, audioSampleRate: m.audioSampleRate, audioBatch: m.audio ? new AudioBatch(4096, m.audioChannels) : null, running: false, stopped: false,
    latest: { screen: null, camera: null }, readers: [], segments: 0, tracks: null, codecs: { video: null, audio: null },
    thumbDone: false, initPending: null, timer: null, error: null,
  };
  S.canvas = new OffscreenCanvas(width, height);
  S.ctx = S.canvas.getContext("2d", { alpha: false, desynchronized: true });

  const vconf = await pickVideoConfig(width, height, fps, bitrate);
  let aconf = null;
  if (m.audio) aconf = await pickAudioConfig(m.audioSampleRate, m.audioChannels);

  S.splitter = new SegmentSplitter(onInit, onSegment);
  S.muxer = new Muxer({
    target: new StreamTarget({ onData: (d, p) => S.splitter.write(d, p) }),
    fastStart: "fragmented", minFragmentDuration: SEGMENT_INTERVAL, firstTimestampBehavior: "cross-track-offset",
    video: { codec: "avc", width, height },
    audio: aconf ? { codec: aconf.muxCodec, numberOfChannels: m.audioChannels, sampleRate: m.audioSampleRate } : undefined,
  });
  S.venc = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta && meta.decoderConfig && !S.codecs.video) {
        S.codecs.video = { codec: "avc", codecString: meta.decoderConfig.codec, width, height, description: copyBytes(meta.decoderConfig.description) };
      }
      S.muxer.addVideoChunk(chunk, meta);
      S.splitter.drain();
    },
    error: (e) => fail("Video encoder: " + e.message),
  });
  S.venc.configure(vconf);
  if (aconf) {
    S.aenc = new AudioEncoder({
      output: (chunk, meta) => {
        if (meta && meta.decoderConfig && !S.codecs.audio) {
          S.codecs.audio = { codec: aconf.muxCodec, codecString: meta.decoderConfig.codec, numberOfChannels: m.audioChannels, sampleRate: m.audioSampleRate,
            description: copyBytes(meta.decoderConfig.description) };
        }
        S.muxer.addAudioChunk(chunk, meta);
        S.splitter.drain();
      },
      error: (e) => fail("Audio encoder: " + e.message),
    });
    S.aenc.configure(aconf.config);
  }
  // Older capture pages transfer the audio ReadableStream with the start message.
  // Keep consuming it for already-open tabs while newer pages send AudioData messages.
  if (m.audio && typeof m.audio.getReader === "function") readAudio(m.audio);
  if (m.screen) readFrames(m.screen, "screen");
  if (m.camera) readFrames(m.camera, "camera");
  post({ type: "ready", video: vconf.codec, hardware: vconf.hardwareAcceleration, audio: aconf ? aconf.config.codec : null });
}

function copyBytes(d) {
  if (!d) return null;
  return d instanceof ArrayBuffer ? new Uint8Array(d.slice(0)) : new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
}

function fail(message) {
  if (S.error) return;
  S.error = message;
  post({ type: "error", message });
}

async function readFrames(stream, which) {
  const reader = stream.getReader();
  S.readers.push(reader);
  for (;;) {
    let r;
    try { r = await reader.read(); } catch { break; }
    if (r.done) break;
    const old = S.latest[which];
    S.latest[which] = r.value;
    if (old) old.close();
    if (S.stopped) break;
  }
}

async function readAudio(stream) {
  const reader = stream.getReader();
  S.readers.push(reader);
  for (;;) {
    let r;
    try { r = await reader.read(); } catch { break; }
    if (r.done) break;
    try { encodeAudio(r.value); }
    catch (err) { fail(String(err && err.message || err)); break; }
    if (S.stopped) break;
  }
}

function encodeAudio(data) {
  const frames = data.numberOfFrames;
  try {
    if (S.running && !S.clock.isPaused && !S.stopped && S.aenc && S.aenc.state === "configured") {
      S.audioBatch.add(data, encodeAudioBatch);
    }
  } finally {
    data.close();
    post({ type: "audio-consumed", frames });
  }
}

function encodeAudioBatch(samples, frames) {
  if (S.aenc.encodeQueueSize * 4096 > S.audioSampleRate * 2) {
    throw new Error("Audio encoding cannot keep up. Try a lower video quality.");
  }
  const out = new AudioData({ format: "f32-planar", sampleRate: S.audioSampleRate, numberOfFrames: frames,
    numberOfChannels: S.audioChannels, timestamp: Math.round(S.audioFrames * 1e6 / S.audioSampleRate), data: samples });
  S.audioFrames += frames;
  try { S.aenc.encode(out); } finally { out.close(); }
}

function begin() {
  S.clock.begin(now());
  S.running = true;
  S.timer = setInterval(tick, Math.max(5, 500 / S.fps));
  tick();
}

function tick() {
  if (!S.running || S.stopped) return;
  const t = S.clock.outputTime(now());
  if (t == null) return;
  const target = Math.floor(t * S.fps) + 1;
  let n = 0;
  while (S.frames < target && n++ < 3) emitFrame();
  if (S.frames < target - S.fps) S.frames = target - 1;   // fell far behind (machine asleep): skip ahead
  const wall = now();
  if (wall - (S.lastTick || 0) >= 0.25) {
    S.lastTick = wall;
    postTick();
  }
}

function postTick(pauseID) {
  post({ type: "tick", elapsed: S.frames / S.fps, segments: S.segments, queue: S.venc.encodeQueueSize, pauseID });
}

function draw() {
  const { ctx, width: W, height: H } = S;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  if (S.layout === "camera") {
    const f = S.latest.camera;
    if (f) drawCover(ctx, f, 0, 0, W, H, true);
    return;
  }
  const f = S.latest.screen;
  if (f) {
    const sw = f.displayWidth, sh = f.displayHeight, scale = Math.min(W / sw, H / sh);
    const dw = sw * scale, dh = sh * scale;
    ctx.drawImage(f, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }
  const cam = S.latest.camera;
  if (S.composite && cam) {
    const short = Math.min(W, H);
    const d = Math.round(short * 0.22 * S.bubbleScale), mgn = Math.round(short * 0.03);
    const x = mgn, y = H - mgn - d;                       // bottom-left, like the Mac app's window mode
    ctx.save();
    ctx.beginPath();
    ctx.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    drawCover(ctx, cam, x, y, d, d, true);
    ctx.restore();
    ctx.lineWidth = Math.max(2, d * 0.015);
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.beginPath(); ctx.arc(x + d / 2, y + d / 2, d / 2 - ctx.lineWidth / 2, 0, Math.PI * 2); ctx.stroke();
  }
}

/** Fills (x, y, w, h) with the frame, cropped to cover; mirrored like a selfie view. */
function drawCover(ctx, f, x, y, w, h, mirror) {
  const sw = f.displayWidth, sh = f.displayHeight;
  const scale = Math.max(w / sw, h / sh), cw = w / scale, ch = h / scale;
  const sx = (sw - cw) / 2, sy = (sh - ch) / 2;
  if (mirror) {
    ctx.save(); ctx.translate(x + w, y); ctx.scale(-1, 1);
    ctx.drawImage(f, sx, sy, cw, ch, 0, 0, w, h);
    ctx.restore();
  } else ctx.drawImage(f, sx, sy, cw, ch, x, y, w, h);
}

function emitFrame() {
  draw();
  const i = S.frames++;
  const frame = new VideoFrame(S.canvas, { timestamp: Math.round(i * 1e6 / S.fps), duration: Math.round(1e6 / S.fps) });
  try {
    if (S.venc.state === "configured") {
      const keyFrame = i >= S.nextKeyFrame;
      if (keyFrame) S.nextKeyFrame = i + Math.round(S.fps * SEGMENT_INTERVAL);
      S.venc.encode(frame, { keyFrame });
    }
  } finally { frame.close(); }
  if (!S.thumbDone && i === Math.min(S.fps, 30)) makeThumb();
}

async function makeThumb() {
  if (S.thumbDone) return;
  S.thumbDone = true;
  const w = Math.min(960, S.width), h = Math.round(S.height * w / S.width);
  const c = new OffscreenCanvas(w, h);
  c.getContext("2d").drawImage(S.canvas, 0, 0, w, h);
  const blob = await c.convertToBlob({ type: "image/jpeg", quality: 0.82 });
  post({ type: "thumb", blob });
}

function onInit(bytes) {
  S.tracks = parseInit(bytes);
  post({ type: "init", bytes, codecs: S.codecs }, [bytes.buffer]);
}
function onSegment(bytes) {
  const index = ++S.segments;
  const duration = fragmentDuration(bytes, S.tracks);
  post({ type: "segment", index, duration, bytes }, [bytes.buffer]);
}

async function stop() {
  if (!S || S.stopped) return;
  S.clock.stop(now());
  const t = S.clock.elapsed(now());
  const target = Math.max(1, Math.round(t * S.fps));
  while (S.frames < target) emitFrame();
  S.running = false;
  S.stopped = true;
  clearInterval(S.timer);
  if (!S.thumbDone) await makeThumb();
  await S.venc.flush();
  if (S.aenc) { S.audioBatch.flush(encodeAudioBatch); await S.aenc.flush(); }
  S.muxer.finalize();
  S.splitter.drain();
  for (const r of S.readers) r.cancel().catch(() => {});
  for (const k of ["screen", "camera"]) if (S.latest[k]) { S.latest[k].close(); S.latest[k] = null; }
  S.venc.close();
  if (S.aenc) S.aenc.close();
  post({ type: "done", duration: S.frames / S.fps, segments: S.segments, audioSeconds: S.audioFrames / 48000 });
}

function cancel() {
  if (!S) return;
  S.stopped = true; S.running = false;
  clearInterval(S.timer);
  for (const r of S.readers) r.cancel().catch(() => {});
  for (const k of ["screen", "camera"]) if (S.latest[k]) { S.latest[k].close(); S.latest[k] = null; }
  try { S.venc.close(); } catch {}
  try { S.aenc && S.aenc.close(); } catch {}
  post({ type: "cancelled" });
}

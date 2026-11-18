import { CaptureSession, pickDisplay } from "/web/reel/capture.js";

const status = document.querySelector("#status");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const attempts = [];
const fail = (error) => ({ name: error?.name || "Error", message: String(error?.message || error) });

async function inspectPixels(stream) {
  const video = document.createElement("video");
  video.muted = true;
  video.srcObject = stream;
  await video.play();
  await sleep(700);
  const canvas = document.createElement("canvas");
  canvas.width = 100;
  canvas.height = 100;
  canvas.getContext("2d").drawImage(video, 0, 0, 100, 100);
  const ctx = canvas.getContext("2d");
  const pixel = (x, y) => [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3);
  const samples = [pixel(20, 20), pixel(80, 20), pixel(20, 80), pixel(80, 80)];
  video.pause();
  video.srcObject = null;
  const magenta = ([r, g, b]) => r > 130 && g < 110 && b > 90;
  const green = ([r, g, b]) => r < 110 && g > 130 && b > 80;
  return { samples, matchesFixture: magenta(samples[0]) && green(samples[1]) && green(samples[2]) && magenta(samples[3]) };
}

async function directSourceCapture(sourceId) {
  const mandatory = { chromeMediaSource: "desktop", chromeMediaSourceId: sourceId };
  return navigator.mediaDevices.getUserMedia({
    video: { mandatory: { ...mandatory, maxWidth: 960, maxHeight: 600, maxFrameRate: 15 } },
    audio: { mandatory },
  });
}

async function record(stream) {
  let initSeen = false, codecs = null, segmentCount = 0, packetBytes = 0, workerError = null;
  let uploadError = null, uploads = Promise.resolve();
  function enqueue(url, bytes, headers = {}) {
    const packet = new Uint8Array(bytes);
    packetBytes += packet.byteLength;
    uploads = uploads.then(async () => {
      if (uploadError) return;
      const response = await fetch(url, { method: "POST", headers, body: packet });
      if (!response.ok) throw new Error(`Local packet append failed: ${response.status} ${await response.text()}`);
    }).catch((error) => { uploadError ??= error; });
  }
  const capture = new CaptureSession({
    settings: { quality: "p720", fps: 15, audio: "systemOnly", bubbleSize: "medium" },
    display: stream, camera: null, mic: null, composite: false,
    events: {
      onInit(bytes, info) { initSeen = true; codecs = info; enqueue("/packet/init", bytes); },
      onSegment(index, duration, bytes) {
        segmentCount++;
        enqueue("/packet/fragment", bytes, { "X-Fragment-Index": String(index), "X-Fragment-Duration": String(duration) });
      },
      onError(error) { workerError = error; },
    },
  });
  const encoders = await capture.prepare();
  capture.begin();
  await sleep(13_500);
  const completed = await capture.stop();
  await uploads;
  if (uploadError) throw uploadError;
  if (workerError) throw workerError;
  if (!initSeen || segmentCount < 3 || !codecs?.video || !codecs?.audio) {
    throw new Error(`Existing encoder produced incomplete media: init=${initSeen}, segments=${segmentCount}, codecs=${JSON.stringify(codecs)}`);
  }
  const response = await fetch("/finish", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ durationSeconds: completed.duration }) });
  if (!response.ok) throw new Error(`Local writer finish failed: ${response.status} ${await response.text()}`);
  const recording = await response.json();
  if (!recording.playable || !recording.id) throw new Error("Local writer did not return a playable recording");
  return { recordingID: recording.id, encoders, completed, segmentCount, packetBytes };
}

async function main() {
  const config = await (await fetch("/probe-config", { cache: "no-store" })).json();
  const sourceId = config.sourceId;
  if (!/^window:\d+:[01]$/.test(sourceId)) throw new Error("Main process did not supply one exact window source");
  await sleep(1200); // Deliberately no click or transient activation.
  let stream = null, method = null;
  try {
    status.textContent = "Timer: getDisplayMedia with Electron's exact-source handler";
    const candidate = await pickDisplay({ fps: 15, audio: "systemOnly" });
    const tracks = candidate.getTracks().map((track) => ({ kind: track.kind, state: track.readyState }));
    attempts.push({ method: "getDisplayMedia-handler", ok: true, tracks, userActivation: navigator.userActivation?.isActive || false });
    if (candidate.getVideoTracks().length && candidate.getAudioTracks().length) {
      stream = candidate; method = "getDisplayMedia-handler";
    } else candidate.getTracks().forEach((track) => track.stop());
  } catch (error) {
    attempts.push({ method: "getDisplayMedia-handler", ok: false, error: fail(error), userActivation: navigator.userActivation?.isActive || false });
  }
  if (!stream) {
    try {
      status.textContent = "Timer: getUserMedia with exact chromeMediaSourceId";
      const candidate = await directSourceCapture(sourceId);
      const tracks = candidate.getTracks().map((track) => ({ kind: track.kind, state: track.readyState }));
      attempts.push({ method: "getUserMedia-exact-source", ok: true, tracks, userActivation: navigator.userActivation?.isActive || false });
      if (candidate.getVideoTracks().length && candidate.getAudioTracks().length) {
        stream = candidate; method = "getUserMedia-exact-source";
      } else candidate.getTracks().forEach((track) => track.stop());
    } catch (error) {
      attempts.push({ method: "getUserMedia-exact-source", ok: false, error: fail(error), userActivation: navigator.userActivation?.isActive || false });
    }
  }
  if (!stream) throw new Error("Neither unattended source path returned video plus audio");
  try {
    const pixels = await inspectPixels(stream);
    if (!pixels.matchesFixture) throw new Error(`Captured pixels do not match the owned checkerboard: ${JSON.stringify(pixels.samples)}`);
    status.textContent = `Recording with existing Reel CaptureSession: ${method}`;
    const result = await record(stream);
    return { ok: true, method, attempts, pixels, encoders: result.encoders,
      duration: result.completed?.duration, segmentCount: result.segmentCount,
      recordingID: result.recordingID, packetBytes: result.packetBytes };
  } finally { stream.getTracks().forEach((track) => track.stop()); }
}

try {
  const report = await main();
  status.textContent = "Probe completed";
  await fetch("/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(report) });
} catch (error) {
  status.textContent = `Probe failed: ${error?.message || error}`;
  await fetch("/report", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: false, error: fail(error), attempts }) }).catch(() => {});
}

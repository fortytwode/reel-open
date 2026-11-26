// Capture session (main thread): screen/window/tab via getDisplayMedia (with system or tab
// audio where the browser offers it), camera, microphone, a Web Audio mix of mic + system audio
// into one stereo 48 kHz track (as the Mac app and Loom mix them), and the encoder worker.
import * as C from "./core.js?v=20261126-capture-region";

export function captureSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) && typeof VideoEncoder === "function" &&
    typeof AudioEncoder === "function" && typeof MediaStreamTrackProcessor === "function" && typeof Worker === "function";
}

/** Screen, window or tab chosen in the browser's picker. */
export async function pickDisplay(settings, { tabOnly = false } = {}) {
  const wantsSystem = C.usesSystem(settings.audio);
  const [w, h] = C.QUALITY.p2160;
  const video = { width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: settings.fps, max: settings.fps }, cursor: settings.showCursor === false ? "never" : "always" };
  if (tabOnly) video.displaySurface = "browser";
  let controller;
  if (settings.mode === "area" && typeof CaptureController === "function") {
    const candidate = new CaptureController();
    try {
      // Keep the picker preview reachable when the chosen source is another tab or window.
      candidate.setFocusBehavior("focus-capturing-application");
      controller = candidate;
    } catch { /* This browser can still show the preview when Reel is brought forward. */ }
  }
  return navigator.mediaDevices.getDisplayMedia({
    ...(controller && { controller }),
    video,
    audio: wantsSystem ? { suppressLocalAudioPlayback: false, echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
    systemAudio: wantsSystem && !tabOnly ? "include" : "exclude",
    selfBrowserSurface: "exclude",
    surfaceSwitching: tabOnly || settings.mode === "area" ? "exclude" : "include",
    monitorTypeSurfaces: tabOnly ? "exclude" : "include",
  });
}

export async function openCamera(deviceId) {
  return navigator.mediaDevices.getUserMedia({
    video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
  });
}
export async function openMic(deviceId) {
  return navigator.mediaDevices.getUserMedia({
    audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
}

/** Saved device if still present, else the system default (first), skipping iPhone/iPad Continuity devices (DeviceDefaults). */
export function pickDevice(devices, savedID) {
  if (savedID) { const d = devices.find((x) => x.deviceId === savedID); if (d) return d; }
  const notPhone = devices.filter((d) => !/iphone|ipad/i.test(d.label));
  return notPhone.find((d) => d.deviceId === "default") || notPhone[0] || devices[0] || null;
}

/** Recorded mode from the picked surface (Swift CaptureMode: screen/window/area/camera). */
export function modeForSurface(surface) { return surface === "monitor" ? "screen" : "window"; }

export class CaptureSession {
  /**
   * display: MediaStream|null, camera: MediaStreamTrack|null (possibly processed), mic: MediaStream|null.
   * composite: draw the camera bubble into the video (window/tab capture or no bubble window).
   */
  constructor({ settings, display, camera, mic, composite, region, events }) {
    Object.assign(this, { settings, display, camera, mic, composite, region, events });
    this.worker = null; this.audioCtx = null; this.size = null; this.phase = "idle"; this.elapsed = 0;
    this.pauseID = 0; this.confirmedPauseID = 0;
    this.doneWaiter = null; this.readyWaiter = null; this.info = null;
    this.audioReader = null; this.audioPump = null; this.audioPendingFrames = 0;
  }

  outputSize() {
    if (this.region) {
      const { sourceWidth, sourceHeight } = this.region;
      const rect = C.frameRegion(this.region, sourceWidth, sourceHeight);
      if (!rect) throw new Error("Select a valid recording area.");
      return C.outputSize(rect.width, rect.height, this.settings.quality);
    }
    if (this.display) {
      const s = this.display.getVideoTracks()[0].getSettings();
      return C.outputSize(s.width || 1920, s.height || 1080, this.settings.quality);
    }
    const s = this.camera.getSettings();
    return C.outputSize(s.width || 1280, s.height || 720, this.settings.quality);
  }

  /** Builds the audio mix and starts the worker's encoders (before the countdown ends). */
  async prepare() {
    this.size = this.outputSize();
    const { width, height } = this.size;
    const fps = this.settings.fps;
    const sources = [];
    if (this.mic && this.mic.getAudioTracks().length) sources.push(this.mic);
    const sys = this.display && this.display.getAudioTracks()[0];
    if (sys && C.usesSystem(this.settings.audio)) sources.push(new MediaStream([sys]));
    let audioTrack = null;
    if (sources.length && this.settings.audio !== "none") {
      this.audioCtx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
      await this.audioCtx.resume().catch(() => {});
      const dest = this.audioCtx.createMediaStreamDestination();
      dest.channelCount = 2;
      this.audioDestination = dest;
      for (const s of sources) {
        const node = this.audioCtx.createMediaStreamSource(s);
        node.connect(dest);
        if (s.getAudioTracks()[0] === sys) this.systemAudioNode = node;
      }
      audioTrack = dest.stream.getAudioTracks()[0];
    }
    const transfer = [];
    const readable = (track) => { const r = new MediaStreamTrackProcessor({ track }).readable; transfer.push(r); return r; };
    const msg = {
      type: "start", width, height, fps, bitrate: C.bitrate(width, height, fps),
      layout: this.display ? "screen" : "camera", composite: this.composite, region: this.region,
      bubbleScale: C.BUBBLE_DIAMETER[this.settings.bubbleSize] / 220,
      screen: this.display ? readable(this.display.getVideoTracks()[0]) : null,
      camera: this.camera ? readable(this.camera) : null,
      audio: !!audioTrack, audioSampleRate: 48000, audioChannels: 2,
    };
    this.worker = new Worker(new URL("./encoder-worker.js?v=20261126-drawing", import.meta.url), { type: "module" });
    this.worker.onmessage = (e) => this.onWorker(e.data);
    this.worker.onerror = (e) => this.onWorker({ type: "error", message: e.message || "Recorder worker failed" });
    const ready = new Promise((resolve, reject) => { this.readyWaiter = { resolve, reject }; });
    this.worker.postMessage(msg, transfer);
    this.info = await ready;
    if (audioTrack) {
      this.audioReader = new MediaStreamTrackProcessor({ track: audioTrack, maxBufferSize: 128 }).readable.getReader();
      this.audioPump = this.pumpAudio(this.audioReader);
    }
    if (this.display) this.display.getVideoTracks()[0].addEventListener("ended", () => this.events.onSourceEnded && this.events.onSourceEnded());
    return this.info;
  }

  /** Keep the existing mixed output and encoder when a desktop audio track is replaced. */
  replaceSystemAudio(track) {
    if (!this.systemAudioNode || !this.audioDestination || this.audioCtx?.state === "closed") {
      throw new Error("No active system audio to replace.");
    }
    const node = this.audioCtx.createMediaStreamSource(new MediaStream([track]));
    node.connect(this.audioDestination);
    this.systemAudioNode.disconnect();
    this.systemAudioNode = node;
  }

  /** Read audio locally: transferring its ReadableStream loses small blocks under Windows load. */
  async pumpAudio(reader) {
    try {
      while (this.audioReader === reader) {
        const { done, value } = await reader.read();
        if (done) break;
        let transferred = false;
        try {
          if (this.audioReader !== reader) break;
          const frames = value.numberOfFrames;
          if (this.phase === "recording" && this.events.onAudio) this.events.onAudio(value);
          if (this.audioPendingFrames + frames > value.sampleRate * 2) {
            throw new Error("Audio processing cannot keep up. Try a lower video quality.");
          }
          this.audioPendingFrames += frames;
          try { this.worker.postMessage({ type: "audio", data: value }, [value]); }
          catch (e) { this.audioPendingFrames -= frames; throw e; }
          transferred = true;
        } finally { if (!transferred) value.close(); }
      }
    } catch (e) {
      if (this.audioReader === reader) this.onWorker({ type: "error", message: e.message });
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      if (this.audioReader === reader) this.audioReader = null;
    }
  }

  async stopAudio() {
    const reader = this.audioReader;
    this.audioReader = null;
    if (reader) await reader.cancel().catch(() => {});
    await this.audioPump;
  }

  onWorker(m) {
    switch (m.type) {
      case "audio-consumed": this.audioPendingFrames = Math.max(0, this.audioPendingFrames - m.frames); break;
      case "ready": this.readyWaiter && this.readyWaiter.resolve(m); this.readyWaiter = null; break;
      case "tick":
        // A busy renderer can receive recording ticks after handling the Pause click.
        if (this.phase === "paused" ? m.pauseID !== this.pauseID : m.pauseID != null) break;
        if (m.pauseID != null) this.confirmedPauseID = m.pauseID;
        this.elapsed = m.elapsed;
        this.events.onTick && this.events.onTick(m);
        break;
      case "init": this.events.onInit(m.bytes, m.codecs); break;
      case "segment": this.events.onSegment(m.index, m.duration, m.bytes); break;
      case "thumb": this.events.onThumb && this.events.onThumb(m.blob); break;
      case "done": this.doneWaiter && this.doneWaiter.resolve(m); break;
      case "cancelled": this.doneWaiter && this.doneWaiter.resolve(m); break;
      case "error":
        if (this.readyWaiter) { this.readyWaiter.reject(new Error(m.message)); this.readyWaiter = null; }
        else if (this.doneWaiter) this.doneWaiter.reject(new Error(m.message));
        else this.events.onError && this.events.onError(new Error(m.message));
        break;
    }
  }

  get pauseConfirmed() { return this.phase === "paused" && this.pauseID === this.confirmedPauseID; }
  begin() { this.phase = "recording"; this.worker.postMessage({ type: "begin" }); }
  pause() {
    if (this.phase !== "recording") return;
    this.phase = "paused";
    this.worker.postMessage({ type: "pause", pauseID: ++this.pauseID });
  }
  resume({ dropScreenFrame = false } = {}) {
    if (this.phase !== "paused") return;
    this.phase = "recording";
    this.worker.postMessage({ type: "resume", dropScreenFrame });
  }
  setAnnotations(strokes) { this.worker?.postMessage({ type: "annotations", strokes }); }
  setComposite(on) { this.composite = on; this.worker && this.worker.postMessage({ type: "layout", composite: on }); }

  /** Finishes encoding; resolves {duration} after the last segment has been delivered. */
  async stop() {
    this.phase = "finishing";
    await this.stopAudio();
    const done = new Promise((resolve, reject) => { this.doneWaiter = { resolve, reject }; });
    this.worker.postMessage({ type: "stop" });
    try { return await done; } finally { this.release(); }
  }
  async cancel() {
    await this.stopAudio();
    if (!this.worker) { this.release(); return; }
    const done = new Promise((resolve) => { this.doneWaiter = { resolve, reject: resolve }; });
    this.worker.postMessage({ type: "cancel" });
    await Promise.race([done, new Promise((r) => setTimeout(r, 2000))]);
    this.release();
  }
  release() {
    this.stopAudio();
    this.phase = "idle";
    for (const s of [this.display, this.mic]) if (s) s.getTracks().forEach((t) => t.stop());
    if (this.audioCtx) this.audioCtx.close().catch(() => {});
    if (this.worker) setTimeout(() => this.worker && this.worker.terminate(), 1000);
  }
}

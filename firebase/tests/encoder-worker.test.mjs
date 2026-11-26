import { test, mock } from "node:test";
import assert from "node:assert/strict";

test("the first video frame after a clock jump still requests the overdue keyframe", async () => {
  const originals = new Map();
  const replace = (name, value) => { originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, writable: true, value }); };
  const frames = [];
  let time = 0, tick;
  replace("self", { postMessage() {} });
  replace("OffscreenCanvas", class { getContext() { return { fillRect() {} }; } });
  replace("VideoFrame", class { constructor(_, options) { this.timestamp = options.timestamp; } close() {} });
  replace("VideoEncoder", class {
    static async isConfigSupported() { return { supported: true }; }
    configure() { this.state = "configured"; this.encodeQueueSize = 0; }
    encode(frame, options) { frames.push({ timestamp: frame.timestamp, key: options.keyFrame }); }
    close() {}
  });
  replace("setInterval", (fn) => { tick = fn; return 1; });
  replace("clearInterval", () => {});
  mock.method(performance, "now", () => time);
  try {
    await import("../../web/reel/encoder-worker.js");
    await self.onmessage({ data: { type: "start", width: 1280, height: 720, fps: 30, bitrate: 1000000, audio: false } });
    await self.onmessage({ data: { type: "begin" } });
    time = 10000; tick(); // the recorder skips stale frame indexes, including 120 and 240
    const before = frames.length;
    time = 10100; tick();
    assert.equal(frames[0].key, true);
    assert.equal(frames[before].key, true, "a skipped exact modulo boundary must not suppress the next keyframe");
    assert.equal(frames[before + 1].key, false);
    await self.onmessage({ data: { type: "cancel" } });
  } finally {
    mock.restoreAll();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  }
});

test("a video encoder with no startup output drains its queued frames once without blocking capture", async () => {
  const originals = new Map();
  const replace = (name, value) => { originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, writable: true, value }); };
  let time = 0, tick, encoder, rejectDrain;
  const drains = [], messages = [];
  replace("self", { postMessage(message) { messages.push(message); } });
  replace("OffscreenCanvas", class { getContext() { return { fillRect() {}, drawImage() {} }; } async convertToBlob() {} });
  replace("VideoFrame", class { close() {} });
  replace("VideoEncoder", class {
    static async isConfigSupported() { return { supported: true }; }
    configure() { this.state = "configured"; this.encodeQueueSize = 0; encoder = this; }
    encode() { this.encodeQueueSize++; }
    flush() {
      drains.push(this.encodeQueueSize);
      return new Promise((_, reject) => { rejectDrain = reject; });
    }
    close() { this.state = "closed"; rejectDrain?.(new DOMException("Encoder closed", "AbortError")); }
  });
  replace("setInterval", (fn) => { tick = fn; return 1; });
  replace("clearInterval", () => {});
  mock.method(performance, "now", () => time);
  try {
    await import("../../web/reel/encoder-worker.js?startup-backlog-test");
    await self.onmessage({ data: { type: "start", width: 1280, height: 720, fps: 30, bitrate: 1000000, audio: false } });
    await self.onmessage({ data: { type: "begin" } });
    const advanceTo = (frame) => { time = frame * 1000 / 30 + 0.1; tick(); };
    for (let frame = 1; frame < 59; frame++) advanceTo(frame);
    assert.deepEqual(drains, []);
    advanceTo(59);
    assert.deepEqual(drains, [60]);
    for (let frame = 60; frame <= 75; frame++) advanceTo(frame);
    assert.equal(encoder.encodeQueueSize, 76);
    assert.deepEqual(drains, [60]);
    await self.onmessage({ data: { type: "cancel" } });
    assert.equal(messages.some((message) => message.type === "error"), false);
  } finally {
    if (self.onmessage) await self.onmessage({ data: { type: "cancel" } });
    mock.restoreAll();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  }
});

test("stopping a paused recording never draws new frames to fill a backlog", async () => {
  const messages = [];
  let time = 0, frames = 0;
  const originals = new Map();
  const replace = (name, value) => { originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, writable: true, value }); };
  replace("self", { postMessage(message) { messages.push(message); } });
  replace("OffscreenCanvas", class {
    getContext() { return { fillRect() {}, drawImage() {} }; }
    async convertToBlob() {}
  });
  replace("VideoFrame", class { close() {} });
  replace("VideoEncoder", class {
    static async isConfigSupported() { return { supported: true }; }
    configure() { this.state = "configured"; this.encodeQueueSize = 0; }
    encode() { frames++; }
    async flush() {}
    close() {}
  });
  mock.method(globalThis, "setInterval", () => 1);
  mock.method(globalThis, "clearInterval", () => {});
  mock.method(performance, "now", () => time);
  try {
    await import("../../web/reel/encoder-worker.js?paused-stop-test");
    await self.onmessage({ data: { type: "start", width: 1280, height: 720, fps: 30, bitrate: 1000000, audio: false } });
    await self.onmessage({ data: { type: "begin" } });
    time = 250; // A stalled timer left several frames due when Pause was pressed.
    await self.onmessage({ data: { type: "pause", pauseID: 1 } });
    time = 2000;
    await self.onmessage({ data: { type: "stop" } });
    assert.equal(frames, 1);
    assert.equal(messages.at(-1).type, "done");
  } finally {
    mock.restoreAll();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  }
});

test("audio timestamp gaps are filled with silence while paused samples stay excluded", async () => {
  const originals = new Map();
  const replace = (name, value) => { originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, writable: true, value }); };
  let time = 0, encodedFrames = 0, encodedSignalFrames = 0, slowDrain = false;
  const messages = [];
  replace("self", { postMessage(message) { messages.push(message); } });
  replace("OffscreenCanvas", class { getContext() { return { fillRect() {}, drawImage() {} }; } async convertToBlob() {} });
  replace("VideoFrame", class { close() {} });
  replace("VideoEncoder", class {
    static async isConfigSupported() { return { supported: true }; }
    configure() { this.state = "configured"; this.encodeQueueSize = 0; }
    encode() {}
    async flush() {}
    close() {}
  });
  replace("AudioData", class {
    constructor(init) { Object.assign(this, init); this.closed = false; }
    copyTo(destination, { planeIndex, frameOffset, frameCount }) {
      if (this.data) destination.set(this.data.subarray(planeIndex * this.numberOfFrames + frameOffset,
        planeIndex * this.numberOfFrames + frameOffset + frameCount));
      else destination.fill(planeIndex + 0.25, 0, frameCount);
    }
    close() { this.closed = true; }
  });
  replace("AudioEncoder", class {
    static async isConfigSupported() { return { supported: true }; }
    configure() { this.state = "configured"; this.encodeQueueSize = 0; }
    encode(data) {
      encodedFrames += data.numberOfFrames;
      if (data.data) encodedSignalFrames += Array.from(data.data).filter(sample => sample !== 0).length / data.numberOfChannels;
      if (slowDrain) {
        this.encodeQueueSize++;
        setTimeout(() => { this.encodeQueueSize = Math.max(0, this.encodeQueueSize - 1); }, 1);
      }
    }
    async flush() {}
    close() {}
  });
  mock.method(globalThis, "setInterval", () => 1);
  mock.method(globalThis, "clearInterval", () => {});
  mock.method(performance, "now", () => time);
  const audio = (timestampSeconds, frames) => new AudioData({ timestamp: Math.round(timestampSeconds * 1e6),
    numberOfFrames: frames, numberOfChannels: 2, sampleRate: 48000, format: "f32-planar" });
  const sendAudio = (timestampSeconds, frames) => self.onmessage({ data: {
    type: "audio", data: audio(timestampSeconds, frames), audioTime: timestampSeconds,
  } });
  try {
    await import(`../../web/reel/encoder-worker.js?audio-gap-pause-${Date.now()}`);
    await self.onmessage({ data: { type: "start", width: 1280, height: 720, fps: 30, bitrate: 1000000,
      audio: true, audioSampleRate: 48000, audioChannels: 2, audioClockTime: 10 } });
    await self.onmessage({ data: { type: "begin", audioTime: 10 } });
    await sendAudio(10, 4800);
    time = 500;
    await self.onmessage({ data: { type: "pause", pauseID: 1, audioTime: 10.5 } });
    // A queued pre-pause block may arrive after the worker handles Pause.
    await sendAudio(10.1, 4800);
    await sendAudio(10.5, 96000);
    time = 2500;
    await self.onmessage({ data: { type: "resume", audioTime: 12.5 } });
    await sendAudio(13.58, 4800);
    time = 3680;
    await self.onmessage({ data: { type: "stop", audioTime: 13.68 } });
    assert.equal(encodedFrames, 80640,
      "0.5s before pause + 1.18s after resume should be encoded; the 1.08s active gap becomes silence and 2s paused samples are excluded");
    assert.equal(encodedSignalFrames, 14400,
      "all three 0.1s signal blocks, including the delayed pre-pause block, must survive; the gap is silence");

    encodedFrames = 0; encodedSignalFrames = 0; time = 0; slowDrain = true;
    await self.onmessage({ data: { type: "start", width: 1280, height: 720, fps: 30, bitrate: 1000000,
      audio: true, audioSampleRate: 48000, audioChannels: 2, audioClockTime: 10 } });
    await self.onmessage({ data: { type: "begin", audioTime: 10 } });
    await sendAudio(10, 4800);
    await sendAudio(12, 4800);
    await self.onmessage({ data: { type: "stop", audioTime: 12.1 } });
    slowDrain = false;
    assert.equal(messages.at(-1).type, "done", `a 1.9s gap should wait for AAC batches to drain instead of overflowing the existing queue limit: ${JSON.stringify(messages.slice(-3))}`);
    assert.equal(encodedFrames, 100800, "0.1s input + 1.9s silence + 0.1s input spans 2.1s");

    await self.onmessage({ data: { type: "start", width: 1280, height: 720, fps: 30, bitrate: 1000000,
      audio: true, audioSampleRate: 48000, audioChannels: 2, audioClockTime: 10 } });
    await self.onmessage({ data: { type: "begin", audioTime: 10 } });
    await sendAudio(10, 4800);
    await sendAudio(13.1, 4800);
    assert.equal(messages.at(-1).type, "error");
    assert.match(messages.at(-1).message, /missed more than two seconds/i,
      "a longer gap should stop capture instead of allocating an unbounded silence buffer");

    encodedFrames = 0; encodedSignalFrames = 0; time = 0;
    await self.onmessage({ data: { type: "start", width: 1280, height: 720, fps: 30, bitrate: 1000000,
      audio: true, audioSampleRate: 48000, audioChannels: 2, audioClockTime: 10 } });
    await self.onmessage({ data: { type: "begin", audioTime: 10 } });
    await sendAudio(10, 4800);
    time = 500;
    await self.onmessage({ data: { type: "stop", audioTime: 10.5 } });
    assert.equal(encodedFrames, 24000,
      "stop must flush 0.4s of active silence after the last 0.1s input block, despite the shifted timestamp origin");
    assert.equal(encodedSignalFrames, 4800, "the input signal remains present before the stop-tail silence");
  } finally {
    slowDrain = false;
    if (self.onmessage) await self.onmessage({ data: { type: "cancel" } });
    mock.restoreAll();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  }
});

test("legacy audio ReadableStream is consumed and its frames are closed", async () => {
  const originals = new Map();
  const replace = (name, value) => { originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, writable: true, value }); };
  const encoded = [];
  let audioController;
  let input;
  let tickId = 0;
  const messages = [];
  replace("self", { postMessage(message) { messages.push(message); } });
  replace("OffscreenCanvas", class { getContext() { return { fillRect() {} }; } });
  replace("VideoFrame", class { constructor() {} close() {} });
  replace("VideoEncoder", class {
    static async isConfigSupported() { return { supported: true }; }
    configure() { this.state = "configured"; this.encodeQueueSize = 0; }
    encode() {}
    close() {}
  });
  replace("AudioData", class {
    constructor(init) { this.numberOfFrames = init.numberOfFrames; this.numberOfChannels = init.numberOfChannels; this.closed = false; }
    copyTo(destination) { destination.fill(0.25); }
    close() { this.closed = true; }
  });
  replace("AudioEncoder", class {
    static async isConfigSupported() { return { supported: true }; }
    configure() { this.state = "configured"; this.encodeQueueSize = 0; }
    encode(data) { encoded.push(data.numberOfFrames); }
    close() {}
  });
  replace("setInterval", () => ++tickId);
  replace("clearInterval", () => {});
  const stream = new ReadableStream({ start(controller) { audioController = controller; } });
  try {
    await import(`../../web/reel/encoder-worker.js?legacy-stream-${Date.now()}`);
    await self.onmessage({ data: { type: "start", width: 1280, height: 720, fps: 30, bitrate: 1000000,
      audio: stream, audioSampleRate: 48000, audioChannels: 2 } });
    await self.onmessage({ data: { type: "begin" } });
    input = new AudioData({ numberOfFrames: 4096, numberOfChannels: 2 });
    audioController.enqueue(input);
    audioController.close();
    // Let the asynchronous reader consume and encode the stream before cancelling the worker.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(encoded, [4096]);
    assert.equal(input.closed, true);
    await self.onmessage({ data: { type: "cancel" } });
  } finally {
    if (audioController) { try { audioController.close(); } catch {} }
    if (input && !input.closed) input.close();
    if (self.onmessage) await self.onmessage({ data: { type: "cancel" } });
    mock.restoreAll();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  }
});

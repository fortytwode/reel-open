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

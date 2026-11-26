import { test } from "node:test";
import assert from "node:assert/strict";
import { CaptureSession, pickDisplay } from "../../web/reel/capture.js";

function session() {
  const errors = [];
  const capture = new CaptureSession({ events: { onError: (e) => errors.push(e.message) } });
  return { capture, errors };
}
function audio(frames = 480) {
  return { numberOfFrames: frames, sampleRate: 48000, closed: 0, close() { this.closed++; } };
}

test("pause discards queued ticks and accepts the matching encoder time", () => {
  const { capture } = session();
  const elapsedUpdates = [];
  let request;
  capture.events.onTick = ({ elapsed }) => elapsedUpdates.push(elapsed);
  capture.worker = { postMessage(message) { request = message; } };
  capture.begin();
  capture.onWorker({ type: "tick", elapsed: 7.2 });
  capture.pause();
  const firstPause = request.pauseID;
  capture.onWorker({ type: "tick", elapsed: 8 });
  assert.deepEqual(elapsedUpdates, [7.2], "a pending recording tick must not update the paused timer");
  assert.equal(capture.pauseConfirmed, false);
  capture.onWorker({ type: "tick", elapsed: 8.4, pauseID: firstPause });
  assert.equal(capture.pauseConfirmed, true);
  assert.equal(capture.elapsed, 8.4);

  capture.resume();
  capture.onWorker({ type: "tick", elapsed: 9 });
  assert.equal(capture.pauseConfirmed, false);
  assert.equal(capture.elapsed, 9);
  capture.pause();
  capture.onWorker({ type: "tick", elapsed: 8.4, pauseID: firstPause });
  assert.equal(capture.pauseConfirmed, false);
  capture.onWorker({ type: "tick", elapsed: 9.1, pauseID: request.pauseID });
  assert.equal(capture.pauseConfirmed, true);
  assert.deepEqual(elapsedUpdates, [7.2, 8.4, 9, 9.1]);
});

test("audio blocks transfer directly without a stream pull round trip", async () => {
  const { capture, errors } = session();
  const blocks = Array.from({ length: 200 }, () => audio());
  const sent = [];
  const stream = new ReadableStream({ start(c) { blocks.forEach((b) => c.enqueue(b)); c.close(); } });
  capture.audioReader = stream.getReader();
  capture.worker = { postMessage(message, transfer) {
    sent.push(message.data);
    assert.deepEqual(transfer, [message.data]);
    assert.equal(message.type, "audio");
    queueMicrotask(() => capture.onWorker({ type: "audio-consumed", frames: message.data.numberOfFrames }));
  } };
  await capture.pumpAudio(capture.audioReader);
  assert.deepEqual(sent, blocks);
  assert.ok(blocks.every((b) => b.closed === 0), "successful transfer gives ownership to the worker");
  assert.equal(capture.audioPendingFrames, 0);
  assert.equal(capture.audioReader, null);
  assert.equal(stream.locked, false);
  assert.deepEqual(errors, []);
});

test("audio transfer failures close the block and report the recording error", async () => {
  const { capture, errors } = session();
  const block = audio();
  let cancelled = false;
  const stream = new ReadableStream({ start(c) { c.enqueue(block); }, cancel() { cancelled = true; } });
  capture.audioReader = stream.getReader();
  capture.worker = { postMessage() { throw new Error("worker unavailable"); } };
  await capture.pumpAudio(capture.audioReader);
  assert.equal(block.closed, 1);
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
  assert.equal(capture.audioPendingFrames, 0);
  assert.deepEqual(errors, ["worker unavailable"]);
});

test("stopping audio cancels a pending read without reporting a failure or sending a late block", async () => {
  const { capture, errors } = session();
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  capture.audioReader = stream.getReader();
  capture.worker = { postMessage() { assert.fail("no late audio message"); } };
  capture.audioPump = capture.pumpAudio(capture.audioReader);
  await capture.stopAudio();
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
  assert.equal(capture.audioReader, null);
  assert.deepEqual(errors, []);
});

test("a stalled encoder stops with a visible error before audio messages grow without bound", async () => {
  const { capture, errors } = session();
  const blocks = Array.from({ length: 210 }, () => audio());
  let sent = 0;
  const stream = new ReadableStream({ start(c) { blocks.forEach((b) => c.enqueue(b)); } });
  capture.audioReader = stream.getReader();
  capture.worker = { postMessage() { sent++; } };
  await capture.pumpAudio(capture.audioReader);
  assert.equal(sent, 200, "at most two seconds at 48 kHz remain in flight");
  assert.equal(blocks[200].closed, 1);
  assert.equal(stream.locked, false);
  assert.match(errors[0], /Audio processing.*keep up/);
});


test("a failed encoder stop still releases capture resources", async () => {
  const { capture } = session();
  let released = false;
  capture.release = () => { released = true; };
  capture.worker = { postMessage() { queueMicrotask(() => capture.onWorker({ type: "error", message: "encoder failed" })); } };
  await assert.rejects(capture.stop(), /encoder failed/);
  assert.equal(released, true);
});

test("area capture preserves the picker and requests the selected cursor behavior", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const options = [];
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: {
    getDisplayMedia: async option => { options.push(option); return {}; },
  }} });
  try {
    await pickDisplay({ mode: "area", fps: 30, audio: "micAndSystem", showCursor: false });
    await pickDisplay({ mode: "screen", fps: 30, audio: "none" });
    assert.equal(options[0].video.cursor, "never");
    assert.equal(options[0].surfaceSwitching, "exclude");
    assert.equal(options[0].systemAudio, "include");
    assert.equal(options[1].video.cursor, "always");
    assert.equal(options[1].surfaceSwitching, "include");
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else delete globalThis.navigator;
  }
});

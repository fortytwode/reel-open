import { test } from "node:test";
import assert from "node:assert/strict";
import { AudioBatch } from "../../web/reel/audio.js";

function block(planes) {
  return { numberOfFrames: planes[0].length, numberOfChannels: planes.length,
    copyTo(dest, { planeIndex, frameOffset, frameCount }) { dest.set(planes[planeIndex].slice(frameOffset, frameOffset + frameCount)); } };
}

test("small microphone blocks retain every sample while batching AAC input", () => {
  const batch = new AudioBatch(4096, 2), output = [];
  const accept = (samples, frames) => output.push({ samples, frames });
  for (let i = 0; i < 100; i++) batch.add(block([Float32Array.from({ length: 480 }, (_, j) => (i * 480 + j) / 48000)]), accept);
  batch.flush(accept);
  batch.flush(accept);
  assert.equal(output.length, 12);
  assert.ok(output.slice(0, -1).every((b) => b.frames === 4096));
  assert.equal(output.at(-1).frames, 2944);
  const left = [], right = [];
  for (const { samples, frames } of output) { left.push(...samples.subarray(0, frames)); right.push(...samples.subarray(frames)); }
  assert.deepEqual(left, Array.from(Float32Array.from({ length: 48000 }, (_, i) => i / 48000)));
  assert.deepEqual(right, left, "mono microphone is duplicated into stereo");
});

test("large stereo blocks split across batches and the partial tail stays planar", () => {
  const batch = new AudioBatch(8, 2), output = [];
  const accept = (samples, frames) => output.push({ samples: Array.from(samples), frames });
  batch.add(block([[0, 1, 2], [100, 101, 102]]), accept);
  batch.add(block([[3, 4, 5, 6, 7, 8, 9, 10, 11, 12], [103, 104, 105, 106, 107, 108, 109, 110, 111, 112]]), accept);
  batch.flush(accept);
  assert.deepEqual(output, [
    { frames: 8, samples: [0, 1, 2, 3, 4, 5, 6, 7, 100, 101, 102, 103, 104, 105, 106, 107] },
    { frames: 5, samples: [8, 9, 10, 11, 12, 108, 109, 110, 111, 112] },
  ]);
});

test("audio batches preserve selected source frames and insert silent gaps as zeros", () => {
  const batch = new AudioBatch(8, 2), output = [];
  batch.add(block([[0, 1, 2, 3, 4], [10, 11, 12, 13, 14]]), (samples, frames) => output.push({ samples: Array.from(samples), frames }), 2, 2);
  batch.addSilence(3, (samples, frames) => output.push({ samples: Array.from(samples), frames }));
  batch.flush((samples, frames) => output.push({ samples: Array.from(samples), frames }));
  assert.deepEqual(output, [{ frames: 5, samples: [2, 3, 0, 0, 0, 12, 13, 0, 0, 0] }]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMeetingSummary, mixToMono, normalizeSegments, resample,
} from "../../web/reel/meeting-transcription.js";

test("mixes audio channels without dropping or duplicating samples", () => {
  const mono = mixToMono({ numberOfChannels: 2, length: 3,
    getChannelData: (channel) => channel === 0 ? Float32Array.of(1, 0, -1) : Float32Array.of(-1, 0.5, 1) });
  assert.deepEqual([...mono], [0, 0.25, 0]);
});

test("resamples linearly and preserves the source when rates already match", () => {
  const source = Float32Array.of(0, 1, 0, -1);
  assert.equal(resample(source, 16000), source);
  assert.deepEqual([...resample(source, 4, 8)], [0, 0.5, 1, 0.5, 0, -0.5, -1, -1]);
});

test("normalizes timestamp chunks and supplies a whole-recording fallback", () => {
  assert.deepEqual(normalizeSegments([
    { timestamp: [1.25, 3.5], text: " Opening point. " },
    { timestamp: [null, null], text: " Closing point." },
  ], "", 12), [
    { start: 1.25, end: 3.5, text: "Opening point." },
    { start: 0, end: 12, text: "Closing point." },
  ]);
  assert.deepEqual(normalizeSegments([], "A complete transcript.", 8), [
    { start: 0, end: 8, text: "A complete transcript." },
  ]);
  assert.deepEqual(normalizeSegments([
    { timestamp: [0, 0], text: "First sentence." },
    { timestamp: [3, 0], text: "Second sentence." },
    { timestamp: [5.8, 0], text: "Third sentence." },
  ], "", 8), [
    { start: 0, end: 3, text: "First sentence." },
    { start: 3, end: 5.8, text: "Second sentence." },
    { start: 5.8, end: 8, text: "Third sentence." },
  ]);
});

test("summary is deterministic, extractive, and labels its non-AI origin", () => {
  const segments = [
    { text: "The team approved the launch plan for the second week of November." },
    { text: "Maya will prepare the final budget and send it by Tuesday." },
    { text: "The next review is scheduled for Friday morning." },
  ];
  const summary = buildMeetingSummary(segments, 2);
  assert.equal(summary, "Extractive summary (not AI-generated): The team approved the launch plan for the second week of November. Maya will prepare the final budget and send it by Tuesday.");
  assert.equal(buildMeetingSummary([]), "No summary available: transcript was too short.");
});

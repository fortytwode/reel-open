import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMeetingSummary, mixToMono, normalizeSegments, resample, transcribePCM,
} from "../../web/reel/meeting-transcription.js";
import * as C from "../../web/reel/core.js";
import { WHISPER_LANGUAGE_CODES, normalizeWhisperLanguage, whisperLanguageOptions } from "../../web/reel/whisper-languages.js";

test("transcription language settings round-trip and reject unsupported persisted values", () => {
  assert.equal(C.decodeSettings({}).transcriptionLanguage, "en");
  const saved = C.decodeSettings({ transcriptionLanguage: "fr" });
  assert.equal(C.decodeSettings(JSON.parse(JSON.stringify(saved))).transcriptionLanguage, "fr");
  assert.equal(C.decodeSettings({ transcriptionLanguage: "yue" }).transcriptionLanguage, "en");
  assert.equal(C.decodeSettings({ transcriptionLanguage: "not-a-language" }).transcriptionLanguage, "en");
  assert.equal(normalizeWhisperLanguage("haw"), "haw");
  assert.equal(WHISPER_LANGUAGE_CODES.length, 99);
  assert.equal(WHISPER_LANGUAGE_CODES.includes("yue"), false);
  const options = whisperLanguageOptions();
  assert.equal(options.length, WHISPER_LANGUAGE_CODES.length);
  assert.equal(options.find(({ code }) => code === "en").label, "English");
  assert.ok(options.find(({ code }) => code === "haw").label.length > 2);
});

test("selected language reaches the local worker and invalid worker requests fall back to English", async (t) => {
  const previousWorker = globalThis.Worker;
  const messages = [];
  globalThis.Worker = class {
    constructor() { this.terminated = false; }
    postMessage(message) {
      messages.push(message);
      queueMicrotask(() => this.onmessage({ data: { type: "result", text: "Bonjour.", chunks: [], language: message.language } }));
    }
    terminate() { this.terminated = true; }
  };
  t.after(() => { globalThis.Worker = previousWorker; });

  const french = await transcribePCM(new Float32Array(16_000), { language: "fr" });
  const hawaiian = await transcribePCM(new Float32Array(16_000), { language: "haw" });
  const invalid = await transcribePCM(new Float32Array(16_000), { language: "yue" });
  assert.deepEqual(messages.map(({ language }) => language), ["fr", "haw", "en"]);
  assert.deepEqual([french.language, hawaiian.language, invalid.language], ["fr", "haw", "en"]);
});

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

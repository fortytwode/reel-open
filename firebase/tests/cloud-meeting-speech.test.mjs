import test from "node:test";
import assert from "node:assert/strict";
import { chunkPCM, encodeWav, summarizeCloudMeeting, transcribeCloudMeeting, CLOUD_SAMPLE_RATE } from "../../web/reel/cloud-meeting-speech.js";

test("PCM chunks cover all frames exactly once and choose the lowest-energy boundary in the search window", () => {
  const rate = 100, pcm = new Float32Array(400 * rate);
  pcm.fill(0.5);
  // Nominal boundary is at 180s; lowest-energy window in its preceding 10s is 175s.
  pcm.fill(0, 175 * rate, 175 * rate + 2);
  const chunks = chunkPCM(pcm, rate);
  assert.equal(chunks[0].end, 175);
  assert.equal(chunks[0].startSample, 0);
  assert.equal(chunks.at(-1).endSample, pcm.length);
  for (let i = 1; i < chunks.length; i++) assert.equal(chunks[i - 1].endSample, chunks[i].startSample);
  assert.equal(chunks.reduce((n, c) => n + c.pcm.length, 0), pcm.length);
});

test("WAV encoder emits mono 16-bit PCM with a valid RIFF header", async () => {
  const wav = encodeWav(new Float32Array([-1, 0, 1]), CLOUD_SAMPLE_RATE);
  const bytes = new DataView(await wav.arrayBuffer());
  assert.equal(wav.type, "audio/wav");
  assert.equal(bytes.getUint32(4, true), 42);
  assert.equal(bytes.getUint16(20, true), 1);
  assert.equal(bytes.getUint16(22, true), 1);
  assert.equal(bytes.getUint32(24, true), 16000);
  assert.equal(bytes.getUint16(34, true), 16);
  assert.equal(bytes.getInt16(44, true), -32768);
  assert.equal(bytes.getInt16(48, true), 32767);
});

test("a quiet boundary just before recording end cannot leave an untranscribable tail", () => {
  const rate = 1000, pcm = new Float32Array(180 * rate + 1);
  pcm.fill(0.5);
  pcm.fill(0, 180 * rate - 20);
  const chunks = chunkPCM(pcm, rate);
  assert.equal(chunks.length, 2);
  assert.ok(chunks.at(-1).pcm.length >= rate);
  assert.equal(chunks[0].endSample, chunks[1].startSample);
  assert.equal(chunks.reduce((n, chunk) => n + chunk.pcm.length, 0), pcm.length);
});

test("summary requests are owner-authorized and serialize only the bounded contract", async () => {
  const calls = [], auths = [];
  const result = await summarizeCloudMeeting({ serviceURL: "https://service.test/", text: "transcript", title: "Planning", attendees: ["a@example.com"],
    authorize: async () => { auths.push(true); return "owner-token"; },
    fetchImpl: async (url, options) => { calls.push({ url, options }); return Response.json({ title: "Plan", summary: "Decided", action_items: [], engine: "OpenAI gpt-6.1-sol" }); } });
  assert.equal(auths.length, 2);
  assert.equal(calls[0].url, "https://service.test/summary");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers.Authorization, "Bearer owner-token");
  assert.deepEqual(JSON.parse(calls[0].options.body), { text: "transcript", title: "Planning", attendees: ["a@example.com"] });
  assert.equal(result.summaryEngine, "OpenAI gpt-6.1-sol");
});

test("cloud transcription fails closed when ownership changes after a request", async () => {
  const old = globalThis.AudioContext;
  globalThis.AudioContext = class {
    async decodeAudioData() { return { duration: 1, sampleRate: 16000, numberOfChannels: 1, length: 16000, getChannelData: () => new Float32Array(16000) }; }
    async close() {}
  };
  try {
    let calls = 0, auths = 0;
    await assert.rejects(transcribeCloudMeeting(new Blob(["video"]), { serviceURL: "https://service.test", title: "Meeting",
      authorize: async () => { if (++auths === 2) throw new Error("owner changed"); return "owner-token"; },
      fetchImpl: async (_url, options) => { calls++; assert.equal(options.redirect, "error"); assert.equal(options.body.get("language"), "en");
        assert.equal(options.body.get("title"), "Meeting"); assert.match(options.body.get("audio").type, /audio\/wav/); return Response.json({ text: "hello", languages: [{ code: "en" }] }); } }), /owner changed/);
    assert.equal(calls, 1);
  } finally { if (old === undefined) delete globalThis.AudioContext; else globalThis.AudioContext = old; }
});

test("full meetings longer than one upload chunk are transcribed without a ten-minute recording cap", async () => {
  const old = globalThis.AudioContext;
  const pcm = new Float32Array(11 * 60 * 16000);
  globalThis.AudioContext = class {
    async decodeAudioData() { return { duration: 660, sampleRate: 16000, numberOfChannels: 1, length: pcm.length, getChannelData: () => pcm }; }
    async close() {}
  };
  try {
    let requests = 0;
    const result = await transcribeCloudMeeting(new Blob(["video"]), { serviceURL: "https://service.test", authorize: async () => "owner-token",
      fetchImpl: async (_url, options) => { requests++; assert.ok(options.body.get("audio").size < 20 * 1024 * 1024);
        return Response.json({ text: `Part ${requests}.`, languages: [{ code: "en" }], engine: "OpenAI gpt-transcribe" }); } });
    assert.ok(requests > 1);
    assert.equal(result.segments[0].start, 0);
    assert.equal(result.segments.at(-1).end, 660);
    for (let i = 1; i < result.segments.length; i++) assert.equal(result.segments[i].start, result.segments[i - 1].end);
  } finally { if (old === undefined) delete globalThis.AudioContext; else globalThis.AudioContext = old; }
});

test("summary never silently truncates a long transcript or accepts a changed owner", async () => {
  let requests = 0;
  await assert.rejects(summarizeCloudMeeting({ serviceURL: "https://service.test", authorize: async () => "owner-token", text: "x".repeat(200001),
    fetchImpl: async () => { requests++; } }), /no partial summary/);
  assert.equal(requests, 0);
  let auths = 0;
  await assert.rejects(summarizeCloudMeeting({ serviceURL: "https://service.test", authorize: async () => ++auths === 1 ? "owner-token" : null,
    text: "Meeting text", fetchImpl: async () => Response.json({ summary: "Notes", engine: "OpenAI gpt-6.1-sol" }) }), /owner changed/);
});

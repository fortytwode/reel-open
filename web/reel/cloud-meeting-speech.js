import { mixToMono, resample, MAX_MEETING_SECONDS } from "./meeting-transcription.js?v=20261029-meetings3";

export const CLOUD_SAMPLE_RATE = 16_000;
export const CLOUD_MAX_BYTES = 20 * 1024 * 1024;
export const CLOUD_MAX_SECONDS = 600;
export const CLOUD_CHUNK_SECONDS = 180;
const BOUNDARY_SEARCH_SECONDS = 10;
const WINDOW_SECONDS = 0.02;

/** Select chunk boundaries on quiet 20 ms windows while keeping every sample exactly once. */
export function chunkPCM(pcm, sampleRate = CLOUD_SAMPLE_RATE) {
  if (!(pcm instanceof Float32Array) || !pcm.length || !Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error("Audio data is empty or invalid.");
  const total = pcm.length, chunkSamples = CLOUD_CHUNK_SECONDS * sampleRate;
  const windowSamples = Math.max(1, Math.round(WINDOW_SECONDS * sampleRate));
  const searchSamples = BOUNDARY_SEARCH_SECONDS * sampleRate;
  const chunks = [];
  let start = 0;
  while (start < total) {
    let end = Math.min(total, start + chunkSamples);
    if (end < total) {
      const low = Math.max(start + 1, end - searchSamples), high = Math.min(end, total - Math.ceil(sampleRate));
      let best = high, bestEnergy = Infinity;
      for (let pos = low; pos < high; pos += windowSamples) {
        const stop = Math.min(high, pos + windowSamples);
        let energy = 0;
        for (let i = pos; i < stop; i++) energy += pcm[i] * pcm[i];
        energy /= stop - pos;
        if (energy < bestEnergy) { bestEnergy = energy; best = pos; }
      }
      end = best;
    }
    if (end <= start) throw new Error("Could not create valid audio chunks.");
    chunks.push({ startSample: start, endSample: end, start: start / sampleRate, end: end / sampleRate, pcm: pcm.subarray(start, end) });
    start = end;
  }
  return chunks;
}

export function encodeWav(pcm, sampleRate = CLOUD_SAMPLE_RATE) {
  if (!(pcm instanceof Float32Array) || !pcm.length || !Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error("Audio data is empty or invalid.");
  const buffer = new ArrayBuffer(44 + pcm.length * 2), view = new DataView(buffer);
  const ascii = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  ascii(0, "RIFF"); view.setUint32(4, 36 + pcm.length * 2, true); ascii(8, "WAVE"); ascii(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, "data"); view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const sample = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(44 + i * 2, sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767), true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

async function decodePCM(blob) {
  if (!(blob instanceof Blob) || !blob.size) throw new Error("Choose a non-empty meeting recording.");
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextClass) throw new Error("This browser does not support audio decoding.");
  const context = new AudioContextClass({ sampleRate: CLOUD_SAMPLE_RATE });
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    if (!Number.isFinite(decoded.duration) || decoded.duration <= 0) throw new Error("The recording contains no decodable audio.");
    if (decoded.duration > MAX_MEETING_SECONDS) throw new Error("Meeting transcription supports recordings up to 3 hours.");
    return resample(mixToMono(decoded), decoded.sampleRate, CLOUD_SAMPLE_RATE);
  } finally { await context.close().catch(() => {}); }
}

async function requestJSON(fetchImpl, url, body, authorize) {
  const token = await authorize();
  if (!token) throw new Error("Sign in as the meeting owner before using cloud meeting notes.");
  const response = await fetchImpl(url, { method: "POST", headers: { Authorization: "Bearer " + token, ...body.headers },
    body: body.body, redirect: "error", signal: AbortSignal.timeout(180_000) });
  if (!await authorize()) throw new Error("The meeting owner changed while processing audio.");
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Meeting service returned HTTP ${response.status}.`);
  }
  return response.json();
}

export async function transcribeCloudMeeting(blob, { serviceURL, authorize, fetchImpl = fetch, title = "", keywords = [], previousText = "", onProgress = () => {} }) {
  if (typeof authorize !== "function") throw new Error("Meeting owner authorization is required.");
  const pcm = await decodePCM(blob), chunks = chunkPCM(pcm);
  const fullText = [], segments = [], languages = [];
  let previous = String(previousText).slice(0, 1000);
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    onProgress({ message: `Sending meeting audio to OpenAI (${index + 1}/${chunks.length})…` });
    const form = new FormData();
    const wav = encodeWav(chunk.pcm);
    if (wav.size > CLOUD_MAX_BYTES) throw new Error("A meeting audio chunk exceeds the 20 MB upload limit.");
    form.set("audio", wav, "meeting.wav");
    form.set("language", "en"); form.set("title", String(title).slice(0, 200));
    if (Array.isArray(keywords) && keywords.length) form.set("keywords", JSON.stringify(keywords.slice(0, 50).map((x) => String(x).slice(0, 80))));
    if (previous) form.set("previous_text", previous.slice(0, 1000));
    const result = await requestJSON(fetchImpl, serviceURL.replace(/\/$/, "") + "/transcription", { headers: {}, body: form }, authorize);
    if (typeof result.text !== "string" || result.engine !== "OpenAI gpt-transcribe") throw new Error("Meeting transcription returned an invalid response.");
    const text = result.text.trim();
    if (text) { fullText.push(text); segments.push({ start: chunk.start, end: chunk.end, text }); previous = text.slice(-1000); }
    if (Array.isArray(result.languages)) languages.push(...result.languages);
  }
  return { text: fullText.join(" "), segments, language: languages[0]?.code || "en", engine: "OpenAI gpt-transcribe",
    durationSeconds: pcm.length / CLOUD_SAMPLE_RATE, timingGranularity: "chunk" };
}

export async function summarizeCloudMeeting({ serviceURL, authorize, fetchImpl = fetch, text, title = "", attendees = [] }) {
  if (typeof authorize !== "function") throw new Error("Meeting owner authorization is required.");
  if (typeof text !== "string" || text.length > 200_000) throw new Error("The full transcript exceeds the supported summary size; no partial summary was sent.");
  const response = await requestJSON(fetchImpl, serviceURL.replace(/\/$/, "") + "/summary", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, title: String(title).slice(0, 200), attendees: attendees.filter((x) => typeof x === "string") }),
  }, authorize);
  if (typeof response.summary !== "string" || !response.summary.trim() || response.engine !== "OpenAI gpt-6.1-sol") throw new Error("Meeting summary returned an invalid response.");
  return { ...response, summaryEngine: response.engine };
}

import { normalizeWhisperLanguage } from "./whisper-languages.js?v=20261126-language";

/** Browser-local meeting transcription for finalized audio/video blobs.
 * Whisper runs in a module worker; media bytes never leave this page. The first run downloads
 * the pinned runtime and model into the browser's normal cache. */

export const MEETING_TRANSCRIPTION_ENGINE = "Whisper large-v3-turbo q8 (onnx-community, Transformers.js 3.0.0, ONNX Runtime WASM/CPU)";
export const MAX_MEETING_SECONDS = 3 * 60 * 60;
const SAMPLE_RATE = 16_000;
const WORKER_URL = new URL("./meeting-transcription-worker.js?v=20261126-language", import.meta.url);

/** Decode audio, resample to Whisper's 16 kHz mono input, and transcribe locally. */
export async function transcribeMeeting(blob, { onProgress = () => {}, signal, language = "en" } = {}) {
  if (!(blob instanceof Blob) || blob.size === 0) throw new Error("Choose a non-empty recording to transcribe.");
  if (signal?.aborted) throw abortError();
  onProgress({ phase: "decode", progress: 0, message: "Reading recording audio locally…" });

  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextClass) throw new Error("This browser does not support local audio decoding. Use current Chrome or Edge.");
  let context;
  try {
    context = new AudioContextClass({ sampleRate: SAMPLE_RATE });
    const encoded = await blob.arrayBuffer();
    if (signal?.aborted) throw abortError();
    let decoded;
    try { decoded = await context.decodeAudioData(encoded); }
    catch (error) {
      throw new Error("This recording's video container could not be decoded as audio by this browser. Extract its audio track to WAV or WebM audio, then retry.", { cause: error });
    }
    if (!Number.isFinite(decoded.duration) || decoded.duration <= 0) throw new Error("The recording contains no decodable audio.");
    if (decoded.duration > MAX_MEETING_SECONDS) throw new Error("Local transcription is limited to recordings of 3 hours or less.");
    const mono = mixToMono(decoded);
    const pcm = resample(mono, decoded.sampleRate, SAMPLE_RATE);
    onProgress({ phase: "decode", progress: 1, message: "Audio ready for local transcription." });
    return await transcribePCM(pcm, { onProgress, signal, language });
  } finally {
    await context?.close().catch(() => {});
  }
}

/** Pure helpers exported for focused tests. */
export function mixToMono(audioBuffer) {
  const channels = audioBuffer.numberOfChannels;
  if (!channels) throw new Error("The recording contains no audio channels.");
  const mono = new Float32Array(audioBuffer.length);
  for (let channel = 0; channel < channels; channel++) {
    const samples = audioBuffer.getChannelData(channel);
    for (let i = 0; i < mono.length; i++) mono[i] += samples[i] / channels;
  }
  return mono;
}

export function resample(samples, inputRate, outputRate = SAMPLE_RATE) {
  if (!(samples instanceof Float32Array) || samples.length === 0) throw new Error("Audio data is empty.");
  if (!Number.isFinite(inputRate) || inputRate <= 0 || !Number.isFinite(outputRate) || outputRate <= 0) throw new Error("Invalid audio sample rate.");
  if (inputRate === outputRate) return samples;
  const length = Math.max(1, Math.round(samples.length * outputRate / inputRate));
  const output = new Float32Array(length);
  const ratio = inputRate / outputRate;
  for (let i = 0; i < length; i++) {
    const position = i * ratio, left = Math.floor(position), right = Math.min(left + 1, samples.length - 1);
    const fraction = position - left;
    output[i] = samples[left] * (1 - fraction) + samples[right] * fraction;
  }
  return output;
}

export function buildMeetingSummary(segments, maxSentences = 3) {
  const sentences = (Array.isArray(segments) ? segments : [])
    .map((segment) => String(segment?.text ?? "").trim())
    .filter(Boolean)
    .flatMap((text) => text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [])
    .map((text) => text.trim())
    .filter((text) => text.length > 20);
  if (!sentences.length) return "No summary available: transcript was too short.";
  // Deterministic lead-in summary. This is extractive, not AI-generated.
  return `Extractive summary (not AI-generated): ${sentences.slice(0, maxSentences).join(" ")}`;
}

export function transcribePCM(pcm, { onProgress = () => {}, signal, language = "en" }) {
  const duration = pcm.length / SAMPLE_RATE;
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL, { type: "module", name: "reel-meeting-transcription" });
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      callback(value);
    };
    const onAbort = () => finish(reject, abortError());
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = ({ data }) => {
      if (data.type === "progress") onProgress(data.progress);
      else if (data.type === "result") {
        const segments = normalizeSegments(data.chunks, data.text, duration);
        finish(resolve, {
          text: data.text.trim(), segments, language: normalizeWhisperLanguage(data.language ?? language), engine: MEETING_TRANSCRIPTION_ENGINE,
          summary: buildMeetingSummary(segments),
        });
      } else if (data.type === "error") finish(reject, new Error(data.message));
    };
    worker.onerror = (event) => finish(reject, new Error(event.message || "Local transcription worker failed."));
    worker.postMessage({ type: "transcribe", pcm, sampleRate: SAMPLE_RATE, language: normalizeWhisperLanguage(language) }, [pcm.buffer]);
  });
}

export function normalizeSegments(chunks, text, duration) {
  const valid = (Array.isArray(chunks) ? chunks : []).map((chunk) => {
    const [rawStart, rawEnd] = chunk.timestamp || [];
    const start = Number.isFinite(rawStart) ? Math.min(duration, Math.max(0, rawStart)) : 0;
    return { start, end: Number.isFinite(rawEnd) && rawEnd > start ? Math.min(duration, rawEnd) : null,
      text: String(chunk.text || "").trim() };
  }).filter((chunk) => chunk.text);
  if (!valid.length) return text?.trim() ? [{ start: 0, end: duration, text: text.trim() }] : [];
  return valid.map((chunk, index) => {
    const nextStart = valid.slice(index + 1).find((next) => next.start > chunk.start)?.start;
    return { ...chunk, end: chunk.end ?? nextStart ?? duration };
  });
}

function abortError() { return new DOMException("Transcription cancelled.", "AbortError"); }

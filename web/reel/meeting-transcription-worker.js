// Pinned Transformers.js browser module; inference defaults to ONNX Runtime's WASM/CPU backend.
import { env, pipeline } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.0";
import { normalizeWhisperLanguage } from "./whisper-languages.js?v=20261126-language";

const MODEL = "onnx-community/whisper-large-v3-turbo";
const MODEL_REVISION = "360ebcde2559d60bb474678be3c1de9ef347d01a";
let transcriber;

self.onmessage = async ({ data }) => {
  if (data.type !== "transcribe") return;
  try {
    const language = normalizeWhisperLanguage(data.language);
    self.postMessage({ type: "progress", progress: { phase: "model", progress: 0,
      message: "Loading Whisper large-v3-turbo (first use downloads about 1.1 GB once; audio stays on this device)…" } });
    env.allowRemoteModels = true;
    env.allowLocalModels = true;
    transcriber ??= await pipeline("automatic-speech-recognition", MODEL, {
      dtype: "q8",
      device: "wasm",
      revision: MODEL_REVISION,
      progress_callback: (event) => {
        if (event.status === "progress" && Number.isFinite(event.progress)) {
          self.postMessage({ type: "progress", progress: { phase: "model", progress: event.progress > 1 ? event.progress / 100 : event.progress,
            message: "Downloading the local Whisper model (about 1.1 GB total)…" } });
        }
      },
    });
    self.postMessage({ type: "progress", progress: { phase: "inference", progress: 0,
      message: "Transcribing locally. CPU processing can take several minutes." } });
    const result = await transcriber(data.pcm, {
      sampling_rate: data.sampleRate,
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
      language,
      task: "transcribe",
    });
    self.postMessage({ type: "result", text: result.text || "", chunks: result.chunks || [], language });
  } catch (error) {
    const detail = error?.message ? ` Details: ${error.message}` : "";
    self.postMessage({ type: "error", message: `Local transcription could not load or run the multilingual Whisper model. Check your connection for the first download, close other memory-heavy tabs or apps, then retry.${detail}` });
  }
};

# Third-party notices

| Component | Use | License |
| --- | --- | --- |
| [hls.js](https://github.com/video-dev/hls.js) | Vendored browser HLS playback | [Apache 2.0 and included notices](web/vendor/hls.js.LICENSE) |
| [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) | Vendored browser MP4 muxing | [MIT](web/vendor/mp4-muxer.LICENSE) |
| [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) | Vendored browser JavaScript and WebAssembly runtime for camera effects | [Apache 2.0](web/vendor/mediapipe/LICENSE) |
| [MediaPipe Selfie Segmenter](https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite) | Optional float16 camera-effects asset fetched by `scripts/fetch-web-model.py` | [Apache 2.0](web/vendor/mediapipe/LICENSE), stated in the [upstream model card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Selfie%20Segmentation.pdf) |
| [Transformers.js 4.3.2](https://github.com/huggingface/transformers.js) | Bundled browser runtime for opt-in local Windows meeting transcription | [Apache 2.0](desktop-windows/local-ai/TRANSFORMERS-LICENSE) |
| [ONNX Runtime Web 1.31.0-dev.20260914-8d85527a0](https://github.com/microsoft/onnxruntime) | WebAssembly CPU inference runtime used by local Whisper | [MIT](desktop-windows/local-ai/ONNX-WASM-LICENSE) |
| [OpenAI Whisper large-v3-turbo ONNX weights](https://huggingface.co/onnx-community/whisper-large-v3-turbo) | Pinned revision `360ebcde2559d60bb474678be3c1de9ef347d01a`, downloaded only after local transcription opt-in | MIT license for the upstream Whisper model and weights ([license](https://github.com/openai/whisper/blob/main/LICENSE)) |

Reel also uses external dependencies resolved by the Swift, Node and Python tooling. Those dependencies retain their upstream licenses. A packaged Windows build preserves Electron's `LICENSE` and `LICENSES.chromium.html`.

MediaPipe Tasks Vision 1.1.0 (npm @mediapipe/tasks-vision, Apache-2.0, https://github.com/google-ai-edge/mediapipe)
- vision_bundle.mjs (source map comment removed) and wasm/vision_wasm_internal.{js,wasm}: the SIMD
  build only (Chrome and Edge always support WebAssembly SIMD).
- selfie_segmenter.tflite: MediaPipe Selfie Segmentation model (float16, Apache-2.0), from
  https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite
Loaded only when the recorder's camera background effect (blur / virtual background) is on.
It runs entirely in the browser; no camera frames leave the device.

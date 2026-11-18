# Third-party notices

| Component | Use | License |
| --- | --- | --- |
| [hls.js](https://github.com/video-dev/hls.js) | Vendored browser HLS playback | [Apache 2.0 and included notices](web/vendor/hls.js.LICENSE) |
| [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) | Vendored browser MP4 muxing | [MIT](web/vendor/mp4-muxer.LICENSE) |
| [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) | Vendored browser JavaScript and WebAssembly runtime for camera effects | [Apache 2.0](web/vendor/mediapipe/LICENSE) |
| [MediaPipe Selfie Segmenter](https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite) | Optional float16 camera-effects asset fetched by `scripts/fetch-web-model.py` | [Apache 2.0](web/vendor/mediapipe/LICENSE), stated in the [upstream model card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Selfie%20Segmentation.pdf) |

Reel also uses external dependencies resolved by the Swift, Node and Python tooling. Those dependencies retain their upstream licenses. A packaged Windows build preserves Electron's `LICENSE` and `LICENSES.chromium.html`.

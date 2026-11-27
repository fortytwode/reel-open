// Browser worker entry point. Bundle this with esbuild so Chromium does not
// need a Node-style bare-specifier resolver for ONNX Runtime dependencies.
export {env,pipeline} from '@huggingface/transformers';

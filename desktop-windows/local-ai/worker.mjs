import {env,pipeline} from './transformers.web.min.js';
import {normalizeWhisperLanguage} from '/whisper-languages.js';

const MODEL='onnx-community/whisper-large-v3-turbo';
const REVISION='360ebcde2559d60bb474678be3c1de9ef347d01a';
let transcriber;
env.allowRemoteModels=true;env.allowLocalModels=false;env.useBrowserCache=true;
env.backends.onnx.wasm.wasmPaths={
  mjs:new URL('./ort-wasm-simd-threaded.mjs',import.meta.url).href,
  wasm:new URL('./ort-wasm-simd-threaded.wasm',import.meta.url).href,
};
self.onmessage=async({data})=>{
  if(data?.type!=='transcribe')return;
  const requestID=data.requestID;
  try{
    const language=normalizeWhisperLanguage(data.language);
    self.postMessage({type:'progress',requestID,progress:0,message:'Downloading or loading the local Whisper model (first use is about 1.1 GB)…'});
    transcriber??=await pipeline('automatic-speech-recognition',MODEL,{dtype:'q8',device:'wasm',revision:REVISION,progress_callback:event=>{
      if(event.status==='progress'&&Number.isFinite(event.progress))self.postMessage({type:'progress',requestID,progress:event.progress>1?event.progress/100:event.progress,message:'Downloading the local Whisper model…'});
    }});
    self.postMessage({type:'progress',requestID,progress:1,message:'Transcribing locally on this computer…'});
    const result=await transcriber(data.pcm,{sampling_rate:data.sampleRate,chunk_length_s:30,stride_length_s:5,return_timestamps:true,language,task:'transcribe'});
    self.postMessage({type:'result',requestID,text:result.text||'',chunks:result.chunks||[],language});
  }catch(error){const detail=error?.message?` ${error.message}`:'';self.postMessage({type:'error',requestID,message:`Local Whisper could not load or run. The first model download requires an internet connection; once cached, retry offline.${detail}`});}
};

import {env,pipeline} from './transformers.bundle.mjs';
import {normalizeWhisperLanguage} from '/whisper-languages.js';
import {withPinnedModelFetch} from '/model-pinning.mjs';

const MODEL='onnx-community/whisper-large-v3-turbo';
const REVISION='360ebcde2559d60bb474678be3c1de9ef347d01a';
let transcriber;
env.allowRemoteModels=true;env.allowLocalModels=false;env.useBrowserCache=true;
env.fetch=withPinnedModelFetch(env.fetch,{cacheName:env.cacheKey});
env.backends.onnx.wasm.wasmPaths={
  mjs:new URL('./ort-wasm-simd-threaded.mjs',import.meta.url).href,
  wasm:new URL('./ort-wasm-simd-threaded.wasm',import.meta.url).href,
};
const report=(requestID,phase,progress,message)=>{
  self.postMessage({type:'progress',requestID,phase,progress,message});
};
self.onmessage=async({data})=>{
  if(data?.type!=='transcribe')return;
  const requestID=data.requestID;
  try{
    const language=normalizeWhisperLanguage(data.language);
    report(requestID,'worker_started',0,'Starting local inference worker…');
    report(requestID,'model_loading',0,'Loading the pinned local Whisper model…');
    transcriber??=await pipeline('automatic-speech-recognition',MODEL,{dtype:'q8',device:'wasm',revision:REVISION,progress_callback:event=>{
      if(event.status==='progress'&&Number.isFinite(event.progress))report(requestID,'model_downloading',event.progress>1?event.progress/100:event.progress,'Downloading or loading local Whisper model…');
    }});
    report(requestID,'model_ready',1,'Local Whisper model is ready.');
    report(requestID,'inference',0,'Transcribing locally on this computer…');
    const result=await transcriber(data.pcm,{sampling_rate:data.sampleRate,chunk_length_s:30,stride_length_s:5,return_timestamps:true,language,task:'transcribe'});
    report(requestID,'inference_complete',1,'Local transcription is complete.');
    self.postMessage({type:'result',requestID,text:result.text||'',chunks:result.chunks||[],language});
  }catch(error){const detail=error?.message?` ${error.message}`:'';self.postMessage({type:'error',requestID,message:`Local Whisper could not load or run. The first model download requires an internet connection; once cached, retry offline.${detail}`});}
};
self.postMessage({type:'ready'});

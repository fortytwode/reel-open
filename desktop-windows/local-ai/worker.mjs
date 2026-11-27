import {env,pipeline} from './transformers.bundle.mjs';
import {normalizeWhisperLanguage} from '/whisper-languages.js';
import {withPinnedModelFetch,SUMMARY_MODEL_ID,SUMMARY_MODEL_REVISION} from '/model-pinning.mjs';

const MODEL='onnx-community/whisper-large-v3-turbo';
const REVISION='360ebcde2559d60bb474678be3c1de9ef347d01a';
let transcriber,summarizer;
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
  if(!['transcribe','summarize'].includes(data?.type))return;
  const requestID=data.requestID;
  try{
    if(data.type==='summarize'){
      if(typeof data.text!=='string'||!data.text.trim()||data.text.length>1_700)throw Error('Invalid local summary input.');
      report(requestID,'worker_started',0,'Starting local summary inference…');
      report(requestID,'model_loading',0,'Loading the pinned local summarization model…');
      summarizer??=await pipeline('summarization',SUMMARY_MODEL_ID,{dtype:'q8',device:'wasm',revision:SUMMARY_MODEL_REVISION,progress_callback:event=>{
        if(event.status==='progress'&&Number.isFinite(event.progress))report(requestID,'model_downloading',event.progress>1?event.progress/100:event.progress,'Downloading or loading the local summary model…');
      }});
      report(requestID,'model_ready',1,'Local summarization model is ready.');
      report(requestID,'inference',0,'Summarizing locally on this computer…');
      const transcript=data.text.replace(/^\[\d{1,4}:\d{2}\]\s*/gmu,' ').replace(/\s+/gu,' ').trim();
      const generated=await summarizer(transcript,{max_new_tokens:120,min_new_tokens:20,num_beams:4,do_sample:false});
      const text=Array.isArray(generated)?generated[0]?.summary_text:generated?.summary_text;
      report(requestID,'inference_complete',1,'On-device summary is complete.');
      self.postMessage({type:'result',requestID,text:typeof text==='string'?text:'',chunks:[],language:'en'});
      return;
    }
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
  }catch(error){const detail=error?.message?` ${error.message}`:'';const message=data.type==='summarize'
    ?`The local summary model could not load or run. Its first use downloads about 270 MB and requires an internet connection; once cached, retry offline.${detail}`
    :`The local model could not load or run. The first download requires an internet connection; once cached, retry offline.${detail}`;
    self.postMessage({type:'error',requestID,message});}
};
self.postMessage({type:'ready'});

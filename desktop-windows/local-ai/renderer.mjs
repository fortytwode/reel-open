const api=window.reelLocalAI,status=document.getElementById('status'),progress=document.getElementById('progress');
if(!api){status.textContent='Local transcription could not start.';throw Error('Local transcription bridge is unavailable.');}
api.progress({phase:'renderer_script_started'});
let worker=null,active=null;
function newWorker(requestID){
  const sendProgress=(phase)=>api.progress({...((typeof requestID==='string')?{requestID}:{}),phase});
  sendProgress('worker_creation_started');
  try{worker=new Worker('/worker.mjs',{type:'module',name:'reel-local-whisper'});}
  catch{worker=null;sendProgress('worker_creation_failed');return false;}
  sendProgress('worker_created');
  worker.onmessage=({data})=>{
  if(data.type==='ready'){api.progress({phase:'worker_script_ready'});return;}
  if(data.type==='progress'){
    if(active&&data.requestID===active.requestID){
      status.textContent=data.message||'Transcribing on this computer…';progress.hidden=false;progress.value=Number.isFinite(data.progress)?data.progress:0;
      if(typeof data.phase==='string')api.progress({requestID:data.requestID,phase:data.phase,progress:data.progress});
    }
    return;
  }
  if(!active||data.requestID!==active.requestID)return;
  if(data.type==='result'){
    const task=active;active=null;progress.hidden=true;
    if(task.type==='summarize'){
      status.textContent='AI summary created on this computer.';
      api.complete({requestID:task.requestID,ok:true,result:{text:data.text,engine:'T5-CNN-25K q8'}});
    }else{
      status.textContent='Transcript saved on this computer.';
      api.complete({requestID:task.requestID,ok:true,result:{text:data.text,chunks:data.chunks,language:data.language,engine:'Whisper large-v3-turbo q8'}});
    }
  }
  else if(data.type==='error'){const task=active;active=null;status.textContent=data.message;progress.hidden=true;api.progress({requestID:task.requestID,phase:'worker_failed'});api.complete({requestID:task.requestID,ok:false,error:data.message});}
};worker.onerror=()=>{const task=active;if(task){active=null;status.textContent='Local AI processing failed. Retry while online if the model has not finished downloading.';api.progress({requestID:task.requestID,phase:'worker_error'});api.complete({requestID:task.requestID,ok:false,error:status.textContent});}else api.progress({phase:'worker_error_before_task'});worker?.terminate();worker=null;};
  return true;
}
api.onTask(task=>{
  if(task?.type==='probe'&&typeof task.requestID==='string'){api.progress({requestID:task.requestID,phase:'renderer_probe_received'});return;}
  if(task?.type==='cancel'){if(active?.requestID===task.requestID){active=null;worker.terminate();newWorker();status.textContent='Local AI task cancelled.';progress.hidden=true;}return;}
  if(!task||!['transcribe','summarize'].includes(task.type)||typeof task.requestID!=='string'||active)return;
  api.progress({requestID:task.requestID,phase:'renderer_task_received'});
  active={requestID:task.requestID,type:task.type};status.textContent=task.type==='summarize'?'Loading the local summarization model…':'Loading the local Whisper model…';progress.hidden=false;progress.value=0;
  try{
    if(task.type==='transcribe'&&(!(task.samples instanceof Float32Array)||!(task.samples.buffer instanceof ArrayBuffer)))throw Error('Invalid audio samples.');
    if(task.type==='summarize'&&(typeof task.text!=='string'||!task.text.trim()||task.text.length>1700))throw Error('Invalid transcript.');
    if(!worker&&!newWorker(task.requestID))throw Error('Worker could not start.');
    if(task.type==='transcribe')worker.postMessage({type:'transcribe',requestID:task.requestID,pcm:task.samples,sampleRate:16000,language:task.language},[task.samples.buffer]);
    else worker.postMessage({type:'summarize',requestID:task.requestID,text:task.text});
    api.progress({requestID:task.requestID,phase:'worker_message_sent',progress:0});
  }catch{
    active=null;
    status.textContent=task.type==='summarize'?'Local summary could not start. Retry the saved recording.':'Local transcription could not start. Retry the saved recording.';
    progress.hidden=true;
    api.progress({requestID:task.requestID,phase:'worker_dispatch_failed'});
    api.complete({requestID:task.requestID,ok:false,error:status.textContent});
  }
});
api.progress({phase:'renderer_script_ready'});
newWorker();

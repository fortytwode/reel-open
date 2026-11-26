const api=window.reelLocalAI,status=document.getElementById('status'),progress=document.getElementById('progress');
let worker=null,active=null;
function newWorker(){worker=new Worker('/worker.mjs',{type:'module',name:'reel-local-whisper'});worker.onmessage=({data})=>{
  if(data.type==='progress'){status.textContent=data.message||'Transcribing on this computer…';progress.hidden=false;progress.value=Number.isFinite(data.progress)?data.progress:0;return;}
  if(!active||data.requestID!==active.requestID)return;
  if(data.type==='result'){const task=active;active=null;status.textContent='Transcript saved on this computer.';progress.hidden=true;api.complete({requestID:task.requestID,ok:true,result:{text:data.text,chunks:data.chunks,language:data.language,engine:'Whisper large-v3-turbo q8'}});}
  else if(data.type==='error'){const task=active;active=null;status.textContent=data.message;progress.hidden=true;api.complete({requestID:task.requestID,ok:false,error:data.message});}
};worker.onerror=event=>{if(active){const task=active;active=null;status.textContent='Local transcription failed. Retry while online if the model has not finished downloading.';api.complete({requestID:task.requestID,ok:false,error:status.textContent});}worker.terminate();newWorker();};}
newWorker();
api.onTask(task=>{
  if(task?.type==='cancel'){if(active?.requestID===task.requestID){active=null;worker.terminate();newWorker();status.textContent='Transcription cancelled.';progress.hidden=true;}return;}
  if(!task||task.type!=='transcribe'||typeof task.requestID!=='string'||active)return;
  active={requestID:task.requestID};status.textContent='Loading the local Whisper model…';progress.hidden=false;progress.value=0;
  try{
    if(!(task.samples instanceof Float32Array)||!(task.samples.buffer instanceof ArrayBuffer))throw Error('Invalid audio samples.');
    worker.postMessage({type:'transcribe',requestID:task.requestID,pcm:task.samples,sampleRate:16000,language:task.language},[task.samples.buffer]);
  }catch{
    active=null;status.textContent='Local transcription could not start. Retry the saved recording.';progress.hidden=true;
    api.complete({requestID:task.requestID,ok:false,error:status.textContent});
  }
});

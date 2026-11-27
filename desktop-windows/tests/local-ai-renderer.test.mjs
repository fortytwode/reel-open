import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {Worker as NodeWorker} from 'node:worker_threads';

const source=await readFile(new URL('../local-ai/renderer.mjs',import.meta.url),'utf8');
const workerSource=`
  const {parentPort}=require('node:worker_threads');
  parentPort.on('message',data=>{
    const valid=data.pcm instanceof Float32Array&&data.pcm.length===3;
    parentPort.postMessage({type:'result',requestID:data.requestID,text:valid?'worker received 3 PCM samples':'invalid PCM',chunks:[],language:data.language});
  });
`;

function createRenderer({throwOnce=false,throwCreateOnce=false}={}){
  const status={textContent:'',progressHidden:true,value:0};
  const progress={hidden:true,value:0};
  const workers=[];
  const completions=[],progressEvents=[];
  let taskHandler,resolveCompletion,shouldThrow=throwOnce,shouldThrowCreate=throwCreateOnce;
  class BrowserWorker{
    constructor(){if(shouldThrowCreate){shouldThrowCreate=false;throw new Error('Worker constructor failure');}this.worker=new NodeWorker(workerSource,{eval:true});workers.push(this);this.worker.on('message',data=>this.onmessage?.({data}));this.worker.on('error',error=>this.onerror?.({message:error.message}));}
    postMessage(data,transfer){
      if(shouldThrow){shouldThrow=false;throw new DOMException('Transfer list contains an invalid object.','DataCloneError');}
      this.worker.postMessage(data,transfer);
    }
    terminate(){void this.worker.terminate();}
  }
  const api={onTask(callback){taskHandler=callback;},progress(value){progressEvents.push(value);},complete(value){completions.push(value);resolveCompletion?.(value);}};
  runInNewContext(source,{
    window:{reelLocalAI:api},
    document:{getElementById(id){return id==='status'?status:progress;}},
    Worker:BrowserWorker,Float32Array,ArrayBuffer,DOMException,
  });
  return{
    status,progress,workers,completions,progressEvents,
    dispatch(task){const done=new Promise(resolve=>{resolveCompletion=resolve;});taskHandler(task);return done;},
    async close(){await Promise.all(workers.map(item=>item.worker.terminate()));},
  };
}

test('renderer transfers PCM ArrayBuffer to a real Worker and completes the job',async t=>{
  const renderer=createRenderer();t.after(()=>renderer.close());
  const samples=new Float32Array([0,.25,-.25]);
  const result=await renderer.dispatch({type:'transcribe',requestID:'request-1',samples,language:'en'});
  assert.deepEqual(structuredClone(result),{requestID:'request-1',ok:true,result:{
    text:'worker received 3 PCM samples',chunks:[],language:'en',engine:'Whisper large-v3-turbo q8',
  }});
  assert.ok(renderer.progressEvents.some(value=>value.phase==='worker_message_sent'));
  assert.equal(samples.buffer.byteLength,0,'Successful transfer detaches the renderer-side sample buffer.');
});

test('synchronous postMessage errors complete the job and leave the renderer ready for retry',async t=>{
  const renderer=createRenderer({throwOnce:true});t.after(()=>renderer.close());
  const failed=await renderer.dispatch({type:'transcribe',requestID:'request-2',samples:new Float32Array([0,.25,-.25]),language:'en'});
  assert.deepEqual(structuredClone(failed),{requestID:'request-2',ok:false,error:'Local transcription could not start. Retry the saved recording.'});
  assert.equal(renderer.progress.hidden,true);
  const retried=await renderer.dispatch({type:'transcribe',requestID:'request-3',samples:new Float32Array([0,.25,-.25]),language:'en'});
  assert.equal(retried.ok,true);
  assert.equal(retried.result.text,'worker received 3 PCM samples');
});

test('renderer reports listener readiness, worker constructor failures and main-to-renderer probe receipt',async t=>{
  const renderer=createRenderer({throwCreateOnce:true});t.after(()=>renderer.close());
  assert.ok(renderer.progressEvents.some(value=>value.phase==='worker_creation_failed'));
  assert.ok(renderer.progressEvents.some(value=>value.phase==='renderer_script_ready'));
  renderer.dispatch({type:'probe',requestID:'probe-1'});
  assert.ok(renderer.progressEvents.some(value=>value.phase==='renderer_probe_received'&&value.requestID==='probe-1'));
});

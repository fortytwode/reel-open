import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createLocalWhisper,localAIRequestAllowed} from '../src/local-whisper.mjs';

class FakeWebContents extends EventEmitter {
  constructor(){super();this.url='';this.messages=[];this.session={setPermissionRequestHandler(){},setPermissionCheckHandler(){},setDevicePermissionHandler(){},webRequest:{onBeforeRequest(){}}};this.mainFrame={get url(){return this.owner.url;},owner:this};}
  getURL(){return this.url;}
  setWindowOpenHandler(){}
  send(channel,value){this.messages.push({channel,value});}
  loadURL(url){this.url=url;return Promise.resolve();}
}
class FakeWindow extends EventEmitter {
  constructor(){super();this.webContents=new FakeWebContents();this.destroyed=false;FakeWindow.last=this;}
  isDestroyed(){return this.destroyed;}
  show(){}
  focus(){}
  hide(){}
  destroy(){this.destroyed=true;this.emit('closed');}
}
function setup(){const ipcMain=new EventEmitter();let owner='owner-a';const bridge=createLocalWhisper({BrowserWindow:FakeWindow,ipcMain,origin:'http://127.0.0.1:4321',ownerID:()=>owner});return{ipcMain,bridge,owner:value=>{owner=value;},complete(value,sender=FakeWindow.last.webContents){ipcMain.emit('reel-local-ai:complete',{sender,senderFrame:sender.mainFrame},value);}};}
const samples=new Float32Array([0,.1,-.1]);

test('local inference network access is restricted to the pinned model and GET requests',()=>{
  const origin='http://127.0.0.1:4321';
  assert.equal(localAIRequestAllowed(`${origin}/local-ai/worker.mjs`,'GET',origin),true);
  assert.equal(localAIRequestAllowed('https://huggingface.co/onnx-community/whisper-large-v3-turbo/resolve/360ebcde2559d60bb474678be3c1de9ef347d01a/config.json','GET',origin),true);
  assert.equal(localAIRequestAllowed('https://huggingface.co/onnx-community/whisper-large-v3-turbo/resolve/main/config.json','GET',origin),false);
  assert.equal(localAIRequestAllowed('https://huggingface.co/api/anything','GET',origin),false);
  assert.equal(localAIRequestAllowed('https://huggingface.co/onnx-community/whisper-large-v3-turbo/resolve/360ebcde2559d60bb474678be3c1de9ef347d01a/config.json','POST',origin),false);
  assert.equal(localAIRequestAllowed('https://example.com/collect','GET',origin),false);
});

test('accepts results only from the isolated window and matches the current request',async()=>{
  const f=setup(),operation=f.bridge.transcribe({ownerUserID:'owner-a',id:'a'.repeat(32),samples});
  await new Promise(resolve=>setImmediate(resolve));
  const view=FakeWindow.last,task=view.webContents.messages[0].value;
  f.complete({requestID:task.requestID,ok:true,result:{text:'stolen'}},new FakeWebContents());
  f.complete({requestID:'stale',ok:true,result:{text:'stale'}});
  f.complete({requestID:task.requestID,ok:true,result:{text:'Local transcript',chunks:[],engine:'Whisper large-v3-turbo q8'}});
  assert.deepEqual(await operation,{text:'Local transcript',chunks:[],engine:'Whisper large-v3-turbo q8'});
  f.bridge.dispose();
});

test('owner changes, invalid audio and aborts cannot start or keep a local job',async()=>{
  const f=setup();
  await assert.rejects(f.bridge.transcribe({ownerUserID:'owner-b',id:'a'.repeat(32),samples}),/owner changed/);
  await assert.rejects(f.bridge.transcribe({ownerUserID:'owner-a',id:'a'.repeat(32),samples:new Float32Array(0)}),/invalid local inference/);
  const controller=new AbortController(),operation=f.bridge.transcribe({ownerUserID:'owner-a',id:'a'.repeat(32),samples,signal:controller.signal});
  await new Promise(resolve=>setImmediate(resolve));
  const task=FakeWindow.last.webContents.messages[0].value;
  controller.abort();
  await assert.rejects(operation,{name:'AbortError'});
  assert.equal(FakeWindow.last.webContents.messages.at(-1).value.type,'cancel');
  f.complete({requestID:task.requestID,ok:true,result:{text:'late'}});
  f.bridge.dispose();
});

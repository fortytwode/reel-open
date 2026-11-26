import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createLocalWhisper,localAIRequestAllowed} from '../src/local-whisper.mjs';

class FakeWebContents extends EventEmitter {
  constructor(){super();this.url='';this.messages=[];this.session={setPermissionRequestHandler(){},setPermissionCheckHandler(){},setDevicePermissionHandler(){},webRequest:{onBeforeRequest(_filter,handler){this.before=handler;},onHeadersReceived(_filter,handler){this.headers=handler;}}};this.mainFrame={get url(){return this.owner.url;},owner:this};}
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
function setup({allowRemoteModelRequest}={}){const ipcMain=new EventEmitter();let owner='owner-a';const bridge=createLocalWhisper({BrowserWindow:FakeWindow,ipcMain,origin:'http://127.0.0.1:4321',ownerID:()=>owner,...(allowRemoteModelRequest?{allowRemoteModelRequest}:{})});return{ipcMain,bridge,owner:value=>{owner=value;},complete(value,sender=FakeWindow.last.webContents){ipcMain.emit('reel-local-ai:complete',{sender,senderFrame:sender.mainFrame},value);}};}
const samples=new Float32Array([0,.1,-.1]);

test('local inference network access is restricted to the pinned model and GET requests',()=>{
  const origin='http://127.0.0.1:4321';
  assert.equal(localAIRequestAllowed(`${origin}/local-ai/worker.mjs`,'GET',origin),true);
  assert.equal(localAIRequestAllowed('https://huggingface.co/onnx-community/whisper-large-v3-turbo/resolve/360ebcde2559d60bb474678be3c1de9ef347d01a/config.json','GET',origin),true);
  const cacheURL='https://huggingface.co/api/resolve-cache/models/onnx-community/whisper-large-v3-turbo/360ebcde2559d60bb474678be3c1de9ef347d01a/config.json?%2Fonnx-community%2Fwhisper-large-v3-turbo%2Fresolve%2F360ebcde2559d60bb474678be3c1de9ef347d01a%2Fconfig.json&etag=%22abcdef0123456789abcdef0123456789abcdef01%22';
  assert.equal(localAIRequestAllowed(cacheURL,'GET',origin),false);
  assert.equal(localAIRequestAllowed(cacheURL,'GET',origin,new Set([cacheURL])),true);
  assert.equal(localAIRequestAllowed(cacheURL.replace('abcdef0123456789abcdef0123456789abcdef01','abcdef0123456789abcdef0123456789abcdef02'),'GET',origin,new Set([cacheURL])),false);
  assert.equal(localAIRequestAllowed('https://huggingface.co/onnx-community/whisper-large-v3-turbo/resolve/main/config.json','GET',origin),false);
  assert.equal(localAIRequestAllowed('https://huggingface.co/onnx-community/whisper-large-v3-turbo/resolve/360ebcde2559d60bb474678be3c1de9ef347d01a/private.wav','GET',origin),false);
  assert.equal(localAIRequestAllowed('https://huggingface.co/api/anything','GET',origin),false);
  assert.equal(localAIRequestAllowed('https://huggingface.co/onnx-community/whisper-large-v3-turbo/resolve/360ebcde2559d60bb474678be3c1de9ef347d01a/config.json','POST',origin),false);
  const signedQuery='Expires=1&Hash-Algorithm=SHA256&Key-Pair-Id=key&Policy=abc&Signature=abc&X-Xet-Cas-Uid=123456&response-content-disposition=attachment&user_id=123456&xip=127.0.0.1';
  const encoderBlob='/xet-bridge-us/66fbc1d373c445b0a3a6acfe/2e276de9ccae304a023b1022703be08500c0eb96b7b999e725eebd0af1572f6c';
  const signedURL=`https://us.aws.cdn.hf.co${encoderBlob}?${signedQuery}`;
  assert.equal(localAIRequestAllowed(signedURL,'GET',origin),false);
  assert.equal(localAIRequestAllowed(signedURL,'GET',origin,new Set([signedURL])),true);
  assert.equal(localAIRequestAllowed(signedURL.replace('https://','https://user@'),'GET',origin,new Set([signedURL.replace('https://','https://user@')])),false);
  assert.equal(localAIRequestAllowed(`https://us.gcp.cdn.hf.co${encoderBlob}?${signedQuery}`,'GET',origin,new Set([`https://us.gcp.cdn.hf.co${encoderBlob}?${signedQuery}`])),true);
  assert.equal(localAIRequestAllowed(`https://us.aws.cdn.hf.co${encoderBlob}?${signedQuery}&audio=encoded`,'GET',origin),false);
  assert.equal(localAIRequestAllowed(`https://us.aws.cdn.hf.co/xet-bridge-us/66fbc1d373c445b0a3a6acfe/arbitrary?${signedQuery}`,'GET',origin),false);
  assert.equal(localAIRequestAllowed(`https://cdn-lfs-us-1.hf.co${encoderBlob}?${signedQuery}`,'GET',origin),false);
  assert.equal(localAIRequestAllowed('https://example.com/collect','GET',origin),false);
});

test('CDN access requires the exact signed URL received from an allowed Hub redirect',async()=>{
  const f=setup(),operation=f.bridge.transcribe({ownerUserID:'owner-a',id:'a'.repeat(32),samples});
  await new Promise(resolve=>setImmediate(resolve));
  const session=FakeWindow.last.webContents.session;
  const signedURL='https://us.aws.cdn.hf.co/xet-bridge-us/66fbc1d373c445b0a3a6acfe/2e276de9ccae304a023b1022703be08500c0eb96b7b999e725eebd0af1572f6c?Expires=1&Hash-Algorithm=SHA256&Key-Pair-Id=key&Policy=abc&Signature=abc&X-Xet-Cas-Uid=123456&response-content-disposition=attachment&user_id=123456&xip=127.0.0.1';
  const cacheURL='https://huggingface.co/api/resolve-cache/models/onnx-community/whisper-large-v3-turbo/360ebcde2559d60bb474678be3c1de9ef347d01a/config.json?%2Fonnx-community%2Fwhisper-large-v3-turbo%2Fresolve%2F360ebcde2559d60bb474678be3c1de9ef347d01a%2Fconfig.json&etag=%22abcdef0123456789abcdef0123456789abcdef01%22';
  let headerResult;
  session.webRequest.headers({url:'https://huggingface.co/onnx-community/whisper-large-v3-turbo/resolve/360ebcde2559d60bb474678be3c1de9ef347d01a/onnx/encoder_model_quantized.onnx',method:'GET',statusCode:302,responseHeaders:{Location:[signedURL]}},value=>{headerResult=value;});
  assert.deepEqual(headerResult,{cancel:false});
  let requestResult;
  session.webRequest.before({url:signedURL,method:'GET'},value=>{requestResult=value;});
  assert.deepEqual(requestResult,{cancel:false});
  session.webRequest.before({url:`${signedURL}&audio=encoded`,method:'GET'},value=>{requestResult=value;});
  assert.deepEqual(requestResult,{cancel:true});
  session.webRequest.headers({url:'https://huggingface.co/onnx-community/whisper-large-v3-turbo/resolve/360ebcde2559d60bb474678be3c1de9ef347d01a/config.json',method:'GET',statusCode:307,responseHeaders:{Location:[cacheURL]}},value=>{headerResult=value;});
  session.webRequest.before({url:cacheURL,method:'GET'},value=>{requestResult=value;});
  assert.deepEqual(requestResult,{cancel:false});
  const changedCacheURL=cacheURL.replace('abcdef0123456789abcdef0123456789abcdef01','abcdef0123456789abcdef0123456789abcdef02');
  session.webRequest.before({url:changedCacheURL,method:'GET'},value=>{requestResult=value;});
  assert.deepEqual(requestResult,{cancel:true});
  f.bridge.dispose();
  await assert.rejects(operation,{name:'AbortError'});
});

test('offline model denial is reinstalled after the isolated window is recreated',async()=>{
  let offline=false,denied=0;
  const f=setup({allowRemoteModelRequest:()=>{if(offline){denied++;return false;}return true;}});
  const first=f.bridge.transcribe({ownerUserID:'owner-a',id:'a'.repeat(32),samples});
  await new Promise(resolve=>setImmediate(resolve));
  const firstWindow=FakeWindow.last;
  f.complete({requestID:firstWindow.webContents.messages[0].value.requestID,ok:true,result:{text:'first',chunks:[]}});
  await first;
  firstWindow.destroy();
  offline=true;
  const second=f.bridge.transcribe({ownerUserID:'owner-a',id:'a'.repeat(32),samples});
  await new Promise(resolve=>setImmediate(resolve));
  let result;
  FakeWindow.last.webContents.session.webRequest.before({
    url:'https://huggingface.co/onnx-community/whisper-large-v3-turbo/resolve/360ebcde2559d60bb474678be3c1de9ef347d01a/config.json',method:'GET',
  },value=>{result=value;});
  assert.deepEqual(result,{cancel:true});
  assert.equal(denied,1);
  const secondWindow=FakeWindow.last;
  f.complete({requestID:secondWindow.webContents.messages[0].value.requestID,ok:true,result:{text:'cached',chunks:[]}});
  await second;
  f.bridge.dispose();
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

import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
import {startAssetServer} from '../src/asset-server.mjs';
import {createLocalWhisper,localAIRequestAllowed,localAIRequestClass} from '../src/local-whisper.mjs';
import {MODEL_ID,MODEL_PATH,MODEL_REVISION,pinModelRequest,withPinnedModelFetch} from '../local-ai/model-pinning.mjs';
import {buildResourcePaths} from '../node_modules/@huggingface/transformers/src/utils/hub.js';

class FakeWebContents extends EventEmitter {
  constructor(){super();this.url='';this.messages=[];this.session={setPermissionRequestHandler(){},setPermissionCheckHandler(){},setDevicePermissionHandler(){},webRequest:{onBeforeRequest(_filter,handler){this.before=handler;},onHeadersReceived(_filter,handler){this.headers=handler;}}};this.mainFrame={get url(){return this.owner.url;},owner:this};}
  getURL(){return this.url;}
  setWindowOpenHandler(){}
  send(channel,value){this.messages.push({channel,value});}
  loadURL(url){this.url=url;setImmediate(()=>FakeWindow.onLoad?.(this));return Promise.resolve();}
}
class FakeWindow extends EventEmitter {
  constructor(){super();this.webContents=new FakeWebContents();this.destroyed=false;FakeWindow.last=this;}
  isDestroyed(){return this.destroyed;}
  show(){}
  focus(){}
  hide(){}
  destroy(){this.destroyed=true;this.emit('closed');}
  destroyDeferred(){this.destroyed=true;setImmediate(()=>this.emit('closed'));}
}
function setup({allowRemoteModelRequest,onDiagnostic,origin='http://127.0.0.1:4321'}={}){const ipcMain=new EventEmitter();let owner='owner-a';FakeWindow.onLoad=contents=>{const event={sender:contents,senderFrame:contents.mainFrame};ipcMain.emit('reel-local-ai:progress',event,{phase:'renderer_script_ready'});ipcMain.emit('reel-local-ai:progress',event,{phase:'worker_script_ready'});};const bridge=createLocalWhisper({BrowserWindow:FakeWindow,ipcMain,origin,ownerID:()=>owner,...(allowRemoteModelRequest?{allowRemoteModelRequest}:{}),...(onDiagnostic?{onDiagnostic}:{})});return{ipcMain,bridge,owner:value=>{owner=value;},complete(value,sender=FakeWindow.last.webContents){ipcMain.emit('reel-local-ai:complete',{sender,senderFrame:sender.mainFrame},value);}};}
const samples=new Float32Array([0,.1,-.1]);

test('local inference network access is restricted to the pinned model and GET requests',()=>{
  const origin='http://127.0.0.1:4321';
  assert.equal(localAIRequestAllowed(`${origin}/worker.mjs`,'GET',origin),true);
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
  assert.equal(localAIRequestClass('https://huggingface.co/onnx-community/whisper-large-v3-turbo/resolve/360ebcde2559d60bb474678be3c1de9ef347d01a/config.json','GET',origin),'hub_model_file');
  assert.equal(localAIRequestClass('https://huggingface.co/onnx-community/whisper-large-v3-turbo/resolve/360ebcde2559d60bb474678be3c1de9ef347d01a/config.json?download=true','GET',origin),'hub_model_file_query');
  assert.equal(localAIRequestClass('https://huggingface.co/onnx-community/whisper-large-v3-turbo/resolve/360ebcde2559d60bb474678be3c1de9ef347d01a/private.wav','GET',origin),'hub_model_other_path');
  assert.equal(localAIRequestClass('https://example.com/collect','OPTIONS',origin),'method_options');
  assert.equal(localAIRequestClass('https://example.com/collect','GET',origin),'other_remote_host');
});

test('known Transformers.js main-revision metadata probe is pinned and preserves Range',async()=>{
  const seen=[];
  const fetch=withPinnedModelFetch(async(input,init)=>{
    const request=new Request(input,init);
    seen.push({url:request.url,method:request.method,range:request.headers.get('range')});
    return new Response('',{status:200});
  });
  const mainURL=`https://huggingface.co/${MODEL_ID}/resolve/main/config.json`;
  assert.equal(buildResourcePaths(MODEL_ID,'config.json').remoteURL,mainURL,
    'The pinned Transformers.js v4 pipeline metadata probe currently defaults to main.');
  await fetch(mainURL,{method:'GET',headers:{Range:'bytes=0-0'}});
  const arbitrary=`https://example.com/collect?meeting=private`;
  await fetch(arbitrary,{method:'GET'});
  const queryURL=`https://huggingface.co/${MODEL_ID}/resolve/main/config.json?meeting=private`;
  await fetch(queryURL,{method:'GET'});
  const expected=`https://huggingface.co${MODEL_PATH}config.json`;
  assert.equal(seen[0].url,expected);
  assert.equal(seen[0].method,'GET');
  assert.equal(seen[0].range,'bytes=0-0');
  assert.equal(seen[1].url,arbitrary);
  assert.equal(seen[2].url,queryURL);
  assert.equal(localAIRequestAllowed(seen[0].url,'GET','http://127.0.0.1:4321'),true);
  assert.equal(localAIRequestAllowed(seen[1].url,'GET','http://127.0.0.1:4321'),false);
  assert.equal(localAIRequestAllowed(seen[2].url,'GET','http://127.0.0.1:4321'),false);
  const privateURL=`${mainURL.slice(0,mainURL.lastIndexOf('/'))}/private.wav`;
  assert.equal(pinModelRequest(privateURL,{method:'GET'}),privateURL);
  assert.equal(MODEL_REVISION,'360ebcde2559d60bb474678be3c1de9ef347d01a');
});

test('network denial smoke diagnostics expose only a fixed request category',async()=>{
  const diagnostics=[];const f=setup({onDiagnostic:value=>diagnostics.push(value)});
  const operation=f.bridge.transcribe({ownerUserID:'owner-a',id:'a'.repeat(32),samples});
  await new Promise(resolve=>setImmediate(resolve));
  let result;
  const blockedURL='https://huggingface.co/onnx-community/whisper-large-v3-turbo/resolve/360ebcde2559d60bb474678be3c1de9ef347d01a/config.json?private-meeting-data=secret';
  FakeWindow.last.webContents.session.webRequest.before({url:blockedURL,method:'GET'},value=>{result=value;});
  assert.deepEqual(result,{cancel:true});
  assert.ok(diagnostics.some(value=>value.phase==='model_network_blocked'&&value.requestClass==='hub_model_file_query'));
  assert.doesNotMatch(JSON.stringify(diagnostics),/private-meeting-data|secret/);
  f.bridge.dispose();
  await assert.rejects(operation,{name:'AbortError'});
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

test('late close from the prior local window cannot invalidate a recreated offline renderer',async()=>{
  let offline=false,denied=0;
  const f=setup({allowRemoteModelRequest:()=>{if(offline){denied++;return false;}return true;}});
  const first=f.bridge.transcribe({ownerUserID:'owner-a',id:'a'.repeat(32),samples});
  await new Promise(resolve=>setImmediate(resolve));
  const firstWindow=FakeWindow.last;
  f.complete({requestID:firstWindow.webContents.messages[0].value.requestID,ok:true,result:{text:'first',chunks:[]}});
  await first;
  firstWindow.destroyDeferred();
  offline=true;
  const second=f.bridge.transcribe({ownerUserID:'owner-a',id:'a'.repeat(32),samples});
  await new Promise(resolve=>setImmediate(resolve));
  const secondWindow=FakeWindow.last;
  assert.notEqual(secondWindow,firstWindow);
  const requestID=secondWindow.webContents.messages[0].value.requestID;
  let result;
  secondWindow.webContents.session.webRequest.before({
    url:'https://huggingface.co/onnx-community/whisper-large-v3-turbo/resolve/360ebcde2559d60bb474678be3c1de9ef347d01a/config.json',method:'GET',
  },value=>{result=value;});
  assert.deepEqual(result,{cancel:true});
  assert.equal(denied,1);
  f.complete({requestID,ok:true,result:{text:'cached offline',chunks:[]}},secondWindow.webContents);
  await second;
  f.bridge.dispose();
});

test('diagnostics accept only the current renderer request and bounded stage fields',async()=>{
  const diagnostics=[];
  const f=setup({onDiagnostic:value=>diagnostics.push(value)});
  const operation=f.bridge.transcribe({ownerUserID:'owner-a',id:'a'.repeat(32),samples});
  await new Promise(resolve=>setImmediate(resolve));
  const window=FakeWindow.last,requestID=window.webContents.messages[0].value.requestID;
  const event={sender:window.webContents,senderFrame:window.webContents.mainFrame};
  f.ipcMain.emit('reel-local-ai:progress',event,{requestID,phase:'model_loading',progress:.4,transcript:'private'});
  f.ipcMain.emit('reel-local-ai:progress',event,{requestID:'stale',phase:'model_loading',progress:.8});
  f.ipcMain.emit('reel-local-ai:progress',event,{requestID,phase:'unknown_stage',progress:1});
  assert.deepEqual(diagnostics.slice(-1),[{phase:'model_loading',progress:.4}]);
  assert.ok(diagnostics.some(value=>value.phase==='renderer_load_started'));
  f.complete({requestID,ok:true,result:{text:'ok',chunks:[]}});
  await operation;
  f.bridge.dispose();
});

test('renderer navigation diagnostics keep only a bounded network error code',async()=>{
  const diagnostics=[];const f=setup({onDiagnostic:value=>diagnostics.push(value)});
  const operation=f.bridge.transcribe({ownerUserID:'owner-a',id:'a'.repeat(32),samples});
  await new Promise(resolve=>setImmediate(resolve));
  const view=FakeWindow.last;
  view.webContents.emit('did-fail-load',{},-105,'private URL data',view.webContents.url,true);
  assert.ok(diagnostics.some(value=>value.phase==='renderer_load_failed'&&value.loadErrorCode===-105));
  assert.doesNotMatch(JSON.stringify(diagnostics),/private URL data/);
  const requestID=view.webContents.messages[0].value.requestID;
  f.complete({requestID,ok:true,result:{text:'ok',chunks:[]}});
  await operation;f.bridge.dispose();
});

test('renderer startup waits for worker module and task channel probe without starting inference',async()=>{
  const diagnostics=[],f=setup({onDiagnostic:value=>diagnostics.push(value)});
  const operation=f.bridge.probeRenderer();
  await new Promise(resolve=>setImmediate(resolve));
  const view=FakeWindow.last,task=view.webContents.messages.at(-1).value;
  f.ipcMain.emit('reel-local-ai:preload-ready',{sender:view.webContents,senderFrame:view.webContents.mainFrame});
  f.ipcMain.emit('reel-local-ai:preload-ready',{sender:new FakeWebContents(),senderFrame:new FakeWebContents().mainFrame});
  assert.deepEqual(task,{type:'probe',requestID:task.requestID});
  f.ipcMain.emit('reel-local-ai:progress',{sender:view.webContents,senderFrame:view.webContents.mainFrame},
    {requestID:task.requestID,phase:'renderer_probe_received'});
  await operation;
  assert.ok(diagnostics.some(value=>value.phase==='renderer_script_ready'));
  assert.ok(diagnostics.some(value=>value.phase==='worker_script_ready'));
  assert.ok(diagnostics.some(value=>value.phase==='renderer_probe_received'));
  assert.equal(diagnostics.filter(value=>value.phase==='preload_ready').length,1);
  f.bridge.dispose();
});

test('isolated renderer page URL serves the real entry HTML and renderer from its dedicated origin',async()=>{
  const assets=await startAssetServer({root:fileURLToPath(new URL('../../',import.meta.url))});
  const f=setup({origin:assets.localAIOrigin});
  try{
    const operation=f.bridge.probeRenderer();
    await new Promise(resolve=>setImmediate(resolve));
    const pageURL=assets.localAIOrigin+'/';
    assert.equal(FakeWindow.last.webContents.url,pageURL);
    const response=await fetch(pageURL);
    assert.equal(response.status,200);
    const html=await response.text();
    assert.match(html,/<script type="module" src="\/renderer\.mjs"><\/script>/u);
    const rendererResponse=await fetch(new URL('/renderer.mjs',assets.localAIOrigin));
    assert.equal(rendererResponse.status,200);
    assert.match(await rendererResponse.text(),/api\.onTask\(task=>/u);
    const task=FakeWindow.last.webContents.messages.at(-1).value;
    f.ipcMain.emit('reel-local-ai:progress',{sender:FakeWindow.last.webContents,senderFrame:FakeWindow.last.webContents.mainFrame},
      {requestID:task.requestID,phase:'renderer_probe_received'});
    await operation;
  }finally{
    f.bridge.dispose();
    await assets.close();
  }
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

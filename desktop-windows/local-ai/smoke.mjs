import assert from 'node:assert/strict';
import {appendFileSync,mkdtempSync,writeFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {app,BrowserWindow,ipcMain} from 'electron';
import {startAssetServer} from '../src/asset-server.mjs';
import {whisperSamples} from '../src/meeting-processing.mjs';
import {createLocalWhisper,localAIRequestAllowed} from '../src/local-whisper.mjs';
import {MODEL_ID,MODEL_PATH,withPinnedModelFetch} from './model-pinning.mjs';
import {withSmokeTimeout} from '../src/smoke-timeout.mjs';

const audioPath=process.env.REEL_WHISPER_SMOKE_AUDIO;
const packagedRoot=process.env.REEL_WHISPER_SMOKE_ROOT;
const expectedArch=process.env.REEL_WHISPER_SMOKE_ARCH;
const logPath=process.env.REEL_WHISPER_SMOKE_LOG;
const startupOnly=process.env.REEL_WHISPER_SMOKE_STARTUP_ONLY==='1';
assert.ok((startupOnly||audioPath)&&packagedRoot&&logPath&&['x64','arm64'].includes(expectedArch),'Supply synthetic PCM16/16kHz/mono speech unless startup-only, extracted resources/app path, log path, and expected architecture.');
assert.equal(process.platform,'win32');
assert.equal(process.arch,expectedArch);
writeFileSync(logPath,'');
let currentRun='startup',currentPhase='bootstrap',onPhase=()=>{};
const safeRequestClasses=new Set(['method_options','method_other','non_https_request','hub_model_file',
  'hub_model_file_query','hub_model_other_path','hub_model_cache_path','hub_other_path','pinned_cdn_blob',
  'cdn_other_path','other_remote_host','invalid_request_url','remote_consent_denied','local_method_options',
  'local_method_other','local_url_extras','local_asset_request']);
const safeLoadErrorTokens=new Set(['ERR_ABORTED','ERR_BLOCKED_BY_CLIENT','ERR_CACHE_MISS','ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_REFUSED','ERR_CONNECTION_RESET','ERR_FAILED','ERR_FILE_NOT_FOUND','ERR_INTERNET_DISCONNECTED',
  'ERR_HTTP_RESPONSE_CODE_FAILURE','ERR_INVALID_URL','ERR_NAME_NOT_RESOLVED','ERR_NETWORK_CHANGED',
  'ERR_TIMED_OUT','ERR_TOO_MANY_REDIRECTS','ERR_UNSAFE_REDIRECT']);
function log(phase,progress,requestClass,loadErrorCode,loadFailureClass,loadErrorToken){
  const item={time:new Date().toISOString(),run:currentRun,phase};
  if(Number.isFinite(progress))item.progress=Math.round(Math.max(0,Math.min(1,progress))*100)/100;
  if(safeRequestClasses.has(requestClass))item.requestClass=requestClass;
  if(Number.isInteger(loadErrorCode)&&loadErrorCode>=-10_000&&loadErrorCode<=0)item.loadErrorCode=loadErrorCode;
  if(['Error','TypeError','AbortError'].includes(loadFailureClass))item.loadFailureClass=loadFailureClass;
  if(safeLoadErrorTokens.has(loadErrorToken))item.loadErrorToken=loadErrorToken;
  const line=JSON.stringify(item);
  appendFileSync(logPath,line+'\n');
  process.stdout.write(line+'\n');
}
const profileRoot=mkdtempSync(path.join(os.tmpdir(),'reel-whisper-cache-'));
app.setPath('userData',profileRoot);app.setPath('sessionData',profileRoot);
// Keep Electron alive while the smoke deliberately destroys and recreates its
// only window. The production app retains its main window during local AI work.
app.on('window-all-closed',()=>{});
const windows=[];
class SmokeWindow extends BrowserWindow{constructor(options){super(options);windows.push(this);
  this.webContents.on('dom-ready',()=>log('renderer_dom_ready'));
  this.webContents.on('did-finish-load',()=>log('renderer_load_complete'));
  this.webContents.on('render-process-gone',(_event,details)=>log('renderer_process_gone'));
}}
let assets,local,exitCode=0,modelNetworkBlocked=false,blockedRemoteRequests=0;
const loggedPhases=new Set(),lastProgressBucket=new Map();
async function bounded(phase,operation,timeoutMs){
  currentPhase=phase;
  log(`${phase}_started`);
  return withSmokeTimeout(operation,timeoutMs,()=>log(`${phase}_timeout`));
}
const phaseLimits={
  window_create_requested:30_000,window_reused:30_000,renderer_load_started:30_000,renderer_dom_ready:30_000,
  renderer_load_complete:30_000,renderer_document_loaded:30_000,renderer_script_started:15_000,
  renderer_load_failed:5_000,renderer_load_rejected:5_000,
  local_request_blocked:5_000,
  renderer_script_ready:15_000,worker_creation_started:15_000,worker_created:15_000,worker_script_ready:15_000,
  renderer_ready:15_000,renderer_startup_timeout:5_000,renderer_probe_sent:5_000,renderer_probe_received:5_000,
  renderer_probe_timeout:5_000,renderer_task_received:10_000,task_sent:15_000,worker_message_sent:15_000,
  worker_started:30_000,model_loading:5*60_000,model_downloading:35*60_000,model_ready:2*60_000,
  inference:10*60_000,inference_complete:2*60_000,worker_dispatch_failed:5_000,worker_failed:5_000,
  worker_error_before_task:5_000,worker_creation_failed:5_000,preload_error:5_000,preload_ready:5_000,
  preload_bridge_present:5_000,preload_bridge_missing:5_000,preload_bridge_probe_failed:5_000,
  renderer_console_error:5_000,renderer_closed_before_ready:5_000,
};
function reportProgress(event){
  const key=`${currentRun}:${event.phase}`;
  if(Number.isFinite(event.progress)){
    const bucket=Math.floor(Math.max(0,Math.min(1,event.progress))*20);
    if(!loggedPhases.has(key)||bucket>(lastProgressBucket.get(key)??-1)){
      log(event.phase,event.progress,event.requestClass,event.loadErrorCode,event.loadFailureClass,event.loadErrorToken);loggedPhases.add(key);lastProgressBucket.set(key,bucket);
    }
  }else if(!loggedPhases.has(key)){
    log(event.phase,undefined,event.requestClass,event.loadErrorCode,event.loadFailureClass,event.loadErrorToken);loggedPhases.add(key);
  }
  if(!phaseLimits[event.phase])return;
  if(event.phase===currentPhase)return;
  currentPhase=event.phase;
  onPhase(event.phase);
}
async function transcribeWithBounds(name,samples,totalTimeoutMs){
  currentRun=name;currentPhase='request_start';
  const controller=new AbortController(),started=Date.now();
  let phaseTimer,totalTimer,rejectTimeout;
  const timeout=new Promise((_,reject)=>{rejectTimeout=reject;});
  function armPhase(phase){
    if(!phaseLimits[phase])return;
    currentPhase=phase;
    clearTimeout(phaseTimer);
    const remaining=Math.max(1,totalTimeoutMs-(Date.now()-started));
    const limit=Math.min(phaseLimits[phase],remaining);
    phaseTimer=setTimeout(()=>{
      log(`phase_timeout_${phase}`);
      controller.abort();
      rejectTimeout(Error('Phase timeout'));
    },limit);
  }
  onPhase=armPhase;
  log('request_start');
  totalTimer=setTimeout(()=>{
    log('overall_timeout');
    controller.abort();
    rejectTimeout(Error('Overall timeout'));
  },totalTimeoutMs);
  try{
    const operation=local.transcribe({ownerUserID:'smoke-owner',id:'a'.repeat(32),samples,language:'en',signal:controller.signal});
    return await Promise.race([operation,timeout]);
  }catch(error){
    log('request_failed');
    throw error;
  }finally{
    clearTimeout(phaseTimer);clearTimeout(totalTimer);onPhase=()=>{};
  }
}
async function probePinnedModelRequest(){
  const contents=windows.at(-1).webContents;
  const seen=await contents.executeJavaScript(`(async()=>{
    const {withPinnedModelFetch}=await import('/model-pinning.mjs');
    const seen=[];
    const intercepted=withPinnedModelFetch(async(input,init)=>{
      const request=new Request(input,init);
      seen.push({url:request.url,method:request.method,range:request.headers.get('range')});
      return new Response('',{status:200});
    });
    await intercepted('https://huggingface.co/${MODEL_ID}/resolve/main/config.json',{method:'GET',headers:{Range:'bytes=0-0'}});
    await intercepted('https://example.com/collect?probe=private',{method:'GET'});
    await intercepted('https://huggingface.co/${MODEL_ID}/resolve/main/config.json?probe=private',{method:'GET'});
    return seen;
  })()`);
  assert.equal(seen.length,3);
  assert.equal(seen[0].url,`https://huggingface.co${MODEL_PATH}config.json`);
  assert.equal(seen[0].method,'GET');assert.equal(seen[0].range,'bytes=0-0');
  assert.equal(seen[1].url,'https://example.com/collect?probe=private');
  assert.equal(seen[2].url,`https://huggingface.co/${MODEL_ID}/resolve/main/config.json?probe=private`);
  assert.equal(localAIRequestAllowed(seen[0].url,'GET',assets.localAIOrigin),true);
  assert.equal(localAIRequestAllowed(seen[1].url,'GET',assets.localAIOrigin),false);
  assert.equal(localAIRequestAllowed(seen[2].url,'GET',assets.localAIOrigin),false);
  log('renderer_model_pin_probe_passed');
}
async function runSmoke(){
  try{
    log('smoke_start');
    if(startupOnly){
      await bounded('electron_startup',()=>app.whenReady(),20_000);
    }else await bounded('electron_startup',()=>app.whenReady(),60_000);
    log('electron_ready');
    assets=await bounded('asset_server_startup',()=>startAssetServer({root:packagedRoot}),15_000);
    log('packaged_asset_server_ready');
    local=createLocalWhisper({BrowserWindow:SmokeWindow,ipcMain,origin:assets.localAIOrigin,ownerID:()=> 'smoke-owner',
      onDiagnostic:reportProgress,
      allowRemoteModelRequest:()=>{if(modelNetworkBlocked){blockedRemoteRequests++;return false;}return true;}});
    if(startupOnly){
      await bounded('renderer_task_handoff_probe',()=>local.probeRenderer(),20_000);
      windows.at(-1).destroy();
      await bounded('renderer_recreation_probe',()=>local.probeRenderer(),20_000);
      log('renderer_recreation_probe_passed');
      await bounded('renderer_model_pin_probe',probePinnedModelRequest,10_000);
      log('smoke_startup_preflight_passed');
      return;
    }
    const samples=await bounded('audio_fixture_load',async()=>whisperSamples(new Blob([await readFile(audioPath)])),30_000);
    log('audio_fixture_ready');
    const first=await transcribeWithBounds('first',samples,45*60_000);
    assert.equal(first.engine,'Whisper large-v3-turbo q8');
    assert.ok(first.text.trim(),'Whisper must decode speech from the synthetic WAV.');
    assert.ok(/local|meeting|privacy|transcription|device/iu.test(first.text),`Unexpected Whisper output: ${first.text.slice(0,180)}`);
    log('first_transcription_complete');
    modelNetworkBlocked=true;
    log('offline_policy_enabled');
    await bounded('offline_window_recreation',()=>{
      windows.at(-1).destroy();
      return new Promise(resolve=>setImmediate(resolve));
    },5_000);
    await bounded('offline_renderer_recreation_probe',()=>local.probeRenderer(),20_000);
    log('offline_renderer_recreation_probe_passed');
    const second=await transcribeWithBounds('offline',samples,12*60_000);
    assert.equal(second.engine,'Whisper large-v3-turbo q8');
    assert.ok(/local|meeting|privacy|transcription|device/iu.test(second.text),`Offline cached inference failed: ${second.text.slice(0,180)}`);
    log('offline_transcription_complete');
    const remoteRequestBlocked=await bounded('offline_network_probe',()=>windows.at(-1).webContents.executeJavaScript(
      `fetch('https://huggingface.co/onnx-community/whisper-large-v3-turbo/resolve/360ebcde2559d60bb474678be3c1de9ef347d01a/config.json',{cache:'no-store'}).then(()=>false,()=>true)`),20_000);
    assert.equal(remoteRequestBlocked,true,'The recreated inference window must block model network requests.');
    assert.equal(blockedRemoteRequests,1,'The production network policy must deny the probe request after window recreation.');
    log('offline_network_denial_verified');
    log('smoke_passed');
  }catch(error){
    exitCode=1;log(`smoke_failed_at_${currentPhase}_${error?.name==='AbortError'?'cancelled':'error'}`);
    process.stderr.write(`Packaged local Whisper smoke failed in ${currentRun}/${currentPhase}.\n`);
  }finally{
    try{if(local)await bounded('local_ai_cleanup',()=>local.dispose(),5_000);}catch{exitCode=1;log('local_ai_cleanup_failed');}
    try{if(assets)await bounded('asset_server_cleanup',()=>assets.close(),10_000);}catch{exitCode=1;log('asset_server_cleanup_failed');}
    app.exit(exitCode);
  }
}
// Keep Electron's ESM entry point synchronous; app.whenReady() must be attached
// without awaiting at module scope for the Windows runtime to become ready.
void runSmoke();

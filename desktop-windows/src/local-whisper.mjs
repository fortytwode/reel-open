import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {MODEL_ID,MODEL_PATH,MODEL_FILES,MODEL_REVISION} from '../local-ai/model-pinning.mjs';

const ID=/^[0-9a-f]{32}$/;
const check=(condition,message)=>{if(!condition)throw Error(message);};
const MODEL_CDN_HOSTS=new Set(['us.aws.cdn.hf.co','us.gcp.cdn.hf.co']);
const MODEL_CDN_PATHS=new Set([
  '/xet-bridge-us/66fbc1d373c445b0a3a6acfe/8a2747c40e92b6856b7aaccfff90d0342d9fbd4aa095c7d1dc637da59662cdce',
  '/xet-bridge-us/66fbc1d373c445b0a3a6acfe/2e276de9ccae304a023b1022703be08500c0eb96b7b999e725eebd0af1572f6c',
]);
const MODEL_CDN_QUERY_KEYS=['Expires','Hash-Algorithm','Key-Pair-Id','Policy','Signature','X-Xet-Cas-Uid',
  'response-content-disposition','user_id','xip'].sort();
const SAFE_REMOTE_REQUEST_CLASSES=new Set(['method_options','method_other','non_https_request','hub_model_file',
  'hub_model_file_query','hub_model_other_path','hub_model_cache_path','hub_other_path','pinned_cdn_blob',
  'cdn_other_path','other_remote_host','invalid_request_url','remote_consent_denied','local_method_options',
  'local_method_other','local_url_extras','local_asset_request']);
const SAFE_LOAD_ERROR_TOKENS=new Set(['ERR_ABORTED','ERR_BLOCKED_BY_CLIENT','ERR_CACHE_MISS','ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_REFUSED','ERR_CONNECTION_RESET','ERR_FAILED','ERR_FILE_NOT_FOUND','ERR_INTERNET_DISCONNECTED',
  'ERR_HTTP_RESPONSE_CODE_FAILURE','ERR_INVALID_URL','ERR_NAME_NOT_RESOLVED','ERR_NETWORK_CHANGED',
  'ERR_TIMED_OUT','ERR_TOO_MANY_REDIRECTS','ERR_UNSAFE_REDIRECT']);

function safeLoadFailure(cause){
  const code=Number.isInteger(cause?.errorCode)&&cause.errorCode>=-10_000&&cause.errorCode<=0?cause.errorCode:undefined;
  const tokenCandidate=typeof cause?.code==='string'?cause.code:
    typeof cause?.message==='string'?cause.message.match(/\bERR_[A-Z0-9_]+\b/u)?.[0]:undefined;
  const tokenMatch=typeof tokenCandidate==='string'?tokenCandidate.match(/\bERR_[A-Z0-9_]+\b/u)?.[0]:undefined;
  const token=SAFE_LOAD_ERROR_TOKENS.has(tokenMatch)?tokenMatch:undefined;
  return {...(code!==undefined?{loadErrorCode:code}:{}),...(token?{loadErrorToken:token}:{}),
    ...(['Error','TypeError','AbortError'].includes(cause?.name)?{loadFailureClass:cause.name}:{})};
}
const SAFE_PROGRESS_PHASES=new Set(['worker_message_sent','worker_started','model_loading','model_downloading',
  'model_ready','inference','inference_complete','worker_failed','worker_dispatch_failed','renderer_task_received',
  'worker_creation_started','worker_created','worker_creation_failed','worker_error']);
const SAFE_RENDERER_PHASES=new Set(['renderer_script_started','renderer_script_ready','worker_creation_started',
  'worker_created','worker_script_ready','worker_error_before_task','worker_creation_failed','renderer_probe_received']);

function isModelFileURLPath(pathname,prefix=MODEL_PATH){
  return pathname.startsWith(prefix)&&MODEL_FILES.has(pathname.slice(prefix.length));
}

function isPinnedHubCacheURL(url){
  const cachePrefix=`/api/resolve-cache/models/${MODEL_ID}/${MODEL_REVISION}/`;
  if(url.hostname!=='huggingface.co'||url.protocol!=='https:'||url.port!==''||url.username||url.password||url.hash
    ||!isModelFileURLPath(url.pathname,cachePrefix))return false;
  const filePath=url.pathname.slice(cachePrefix.length),originalPath=`${MODEL_PATH}${filePath}`;
  const entries=[...url.searchParams];
  return entries.length===2&&entries.some(([key,value])=>key===originalPath&&value==='')
    &&entries.some(([key,value])=>key==='etag'&&/^"?[a-f0-9]{40}"?$/iu.test(value));
}

function modelCDNQueryAllowed(url){
  const params=[...url.searchParams];
  if(params.length!==MODEL_CDN_QUERY_KEYS.length)return false;
  if(params.some(([,value])=>value.length===0||value.length>1024||/[\u0000-\u001f\u007f]/u.test(value)))return false;
  return params.map(([key])=>key).sort().every((key,index)=>key===MODEL_CDN_QUERY_KEYS[index]);
}

function isPinnedModelCDNURL(url){
  return url.protocol==='https:'&&url.port===''&&!url.username&&!url.password&&!url.hash&&MODEL_CDN_HOSTS.has(url.hostname)
    &&MODEL_CDN_PATHS.has(url.pathname)&&url.href.length<=4096&&modelCDNQueryAllowed(url);
}

export function localAIRequestAllowed(requestURL,method,localOrigin,allowedHubRedirects=new Set()){
  if(method!=='GET')return false;
  try{
    const url=new URL(requestURL),origin=new URL(localOrigin);
    if(url.username||url.password||url.hash)return false;
    if(url.origin===origin.origin)return url.search===''&&url.hash===''&&url.username===''&&url.password=='';
    if(url.protocol!=='https:'||url.port!=='')return false;
    if(url.hostname==='huggingface.co'){
      if(isModelFileURLPath(url.pathname))return url.search==='';
      return isPinnedHubCacheURL(url)&&allowedHubRedirects.has(url.href);
    }
    // Permit only the exact signed URL observed in an allowed Hub redirect.
    return isPinnedModelCDNURL(url)&&allowedHubRedirects.has(url.href);
  }catch{return false;}
}

/** Fixed categories for smoke diagnostics; never logs a URL, filename, query value or request header. */
export function localAIRequestClass(requestURL,method,localOrigin){
  try{
    const url=new URL(requestURL),origin=new URL(localOrigin);
    const local=url.origin===origin.origin;
    if(method!=='GET')return local?(method==='OPTIONS'?'local_method_options':'local_method_other'):
      (method==='OPTIONS'?'method_options':'method_other');
    if(local){
      return url.search||url.hash||url.username||url.password?'local_url_extras':'local_asset_request';
    }
    if(url.protocol!=='https:'||url.port!=='')return 'non_https_request';
    if(url.hostname==='huggingface.co'){
      if(url.pathname.startsWith(MODEL_PATH)){
        if(!isModelFileURLPath(url.pathname))return 'hub_model_other_path';
        return url.search?'hub_model_file_query':'hub_model_file';
      }
      if(url.pathname.startsWith(`/api/resolve-cache/models/${MODEL_ID}/`))return 'hub_model_cache_path';
      return 'hub_other_path';
    }
    if(MODEL_CDN_HOSTS.has(url.hostname))return MODEL_CDN_PATHS.has(url.pathname)?'pinned_cdn_blob':'cdn_other_path';
    return 'other_remote_host';
  }catch{return 'invalid_request_url';}
}

/** Isolated renderer for local inference. It has no auth preload or access to meeting services. */
export function createLocalWhisper({BrowserWindow,ipcMain,origin,ownerID,allowRemoteModelRequest=()=>true,onDiagnostic=()=>{}}={}){
  check(typeof BrowserWindow==='function'&&ipcMain&&typeof origin==='string'&&typeof ownerID==='function'
    &&typeof allowRemoteModelRequest==='function'&&typeof onDiagnostic==='function','Invalid local Whisper dependencies.');
  const parsedOrigin=new URL(origin);
  check(parsedOrigin.protocol==='http:'&&parsedOrigin.hostname==='127.0.0.1'&&parsedOrigin.pathname==='/'&&!parsedOrigin.username&&!parsedOrigin.password,
    'Local transcription must use its private loopback origin.');
  let window=null,loading=null,active=null,disposed=false,rendererStartup=null;
  const pendingProbes=new Map();
  const pageURL=origin+'/';
  const diagnostic=(phase,progress,requestClass,loadErrorCode,loadFailureClass,loadErrorToken)=>{
    try{onDiagnostic({phase,...(Number.isFinite(progress)?{progress:Math.max(0,Math.min(1,progress))}:{}),
      ...(SAFE_REMOTE_REQUEST_CLASSES.has(requestClass)?{requestClass}:{}),
      ...(Number.isInteger(loadErrorCode)&&loadErrorCode>=-10_000&&loadErrorCode<=0?{loadErrorCode}:{}),
      ...(['Error','TypeError','AbortError'].includes(loadFailureClass)?{loadFailureClass}:{}),
      ...(SAFE_LOAD_ERROR_TOKENS.has(loadErrorToken)?{loadErrorToken}:{})});}catch{}
  };
  function currentWindow(event){return window&&!window.isDestroyed()&&event.sender===window.webContents&&event.senderFrame===window.webContents.mainFrame&&event.senderFrame?.url===pageURL;}
  function rejectRendererStartup(contents,phase,message){
    if(rendererStartup?.contents!==contents)return;
    clearTimeout(rendererStartup.timer);const startup=rendererStartup;rendererStartup=null;
    diagnostic(phase);startup.reject(Error(message));
  }
  function cancelActive(message='Local transcription was cancelled.'){
    const job=active;if(!job)return;
    active=null;job.signal?.removeEventListener('abort',job.abort);job.reject(Object.assign(Error(message),{name:'AbortError'}));
    if(window&&!window.isDestroyed())window.webContents.send('reel-local-ai:task',{type:'cancel',requestID:job.requestID});
  }
  ipcMain.on('reel-local-ai:complete',(event,value)=>{
    if(!currentWindow(event)||!active||value?.requestID!==active.requestID)return;
    const job=active;active=null;job.signal?.removeEventListener('abort',job.abort);
    if(value.ok===true&&typeof value.result?.text==='string'&&value.result.text.length<=200_000
      &&Array.isArray(value.result.chunks)&&value.result.chunks.length<=10_000)job.resolve(value.result);
    else if(value.ok===true)job.reject(Error('Local transcription returned an invalid response.'));
    else job.reject(Error(typeof value.error==='string'?value.error.slice(0,500):'Local transcription failed.'));
  });
  ipcMain.on('reel-local-ai:progress',(event,value)=>{
    if(!currentWindow(event))return;
    if(SAFE_RENDERER_PHASES.has(value?.phase)&&value?.requestID===undefined){
      diagnostic(value.phase);
      if(rendererStartup?.contents===event.sender){
        if(value.phase==='worker_script_ready'){
          clearTimeout(rendererStartup.timer);const startup=rendererStartup;rendererStartup=null;startup.resolve();
        }else if(value.phase==='worker_error_before_task'||value.phase==='worker_creation_failed'){
          clearTimeout(rendererStartup.timer);const startup=rendererStartup;rendererStartup=null;startup.reject(Error('Local inference worker could not start.'));
        }
      }
      return;
    }
    if(value?.phase==='renderer_probe_received'&&typeof value.requestID==='string'){
      const probe=pendingProbes.get(value.requestID);if(!probe)return;
      pendingProbes.delete(value.requestID);clearTimeout(probe.timer);diagnostic(value.phase);probe.resolve();return;
    }
    if(!active||value?.requestID!==active.requestID||!SAFE_PROGRESS_PHASES.has(value?.phase))return;
    diagnostic(value.phase,value.progress);
  });
  ipcMain.on('reel-local-ai:preload-ready',event=>{
    if(currentWindow(event))diagnostic('preload_ready');
  });
  function createWindow(){
    if(window&&!window.isDestroyed())return Promise.resolve(window);
    if(loading)return loading;
    const createdWindow=new BrowserWindow({width:520,height:300,minWidth:420,minHeight:260,show:false,title:'Local meeting transcription',
      webPreferences:{preload:fileURLToPath(new URL('../local-ai/preload.cjs',import.meta.url)),sandbox:true,contextIsolation:true,nodeIntegration:false,
        partition:'persist:reel-local-ai',backgroundThrottling:false}});
    window=createdWindow;
    const contents=createdWindow.webContents;
    contents.on('dom-ready',()=>diagnostic('renderer_dom_ready'));
    contents.on('did-finish-load',()=>{
      diagnostic('renderer_load_complete');
      void contents.executeJavaScript('typeof window.reelLocalAI').then(value=>{
        if(value==='object')diagnostic('preload_bridge_present');
        else rejectRendererStartup(contents,'preload_bridge_missing','Local transcription preload did not expose its restricted bridge.');
      }).catch(()=>rejectRendererStartup(contents,'preload_bridge_probe_failed','Local transcription preload bridge could not be checked.'));
    });
    contents.on('did-fail-load',(_event,errorCode,_description,_failedURL,isMainFrame)=>{
      if(isMainFrame===true)diagnostic('renderer_load_failed',undefined,undefined,errorCode);
    });
    contents.on('preload-error',()=>diagnostic('preload_error'));
    contents.on('console-message',details=>{if(details?.level==='error')diagnostic('renderer_console_error');});
    contents.on('render-process-gone',()=>diagnostic('renderer_process_gone'));
    const session=contents.session,allowedHubRedirects=new Set();
    session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    session.setPermissionCheckHandler(()=>false);
    session.setDevicePermissionHandler(()=>false);
    session.webRequest.onHeadersReceived({urls:['https://huggingface.co/*']},(details,callback)=>{
      if(details.method==='GET'&&details.statusCode>=300&&details.statusCode<400
        &&localAIRequestAllowed(details.url,details.method,origin,allowedHubRedirects)){
        const locationHeader=Object.entries(details.responseHeaders??{}).find(([name])=>name.toLowerCase()==='location')?.[1];
        const location=Array.isArray(locationHeader)?locationHeader[0]:locationHeader;
        if(location){
          try{
            const target=new URL(location,details.url);
            if(isPinnedModelCDNURL(target)||isPinnedHubCacheURL(target)){
              if(allowedHubRedirects.size>=16)allowedHubRedirects.delete(allowedHubRedirects.values().next().value);
              allowedHubRedirects.add(target.href);
            }
          }catch{}
        }
      }
      callback({cancel:false});
    });
    session.webRequest.onBeforeRequest({urls:['<all_urls>']},(details,callback)=>{
      let allowed=false,remote=false,consentAllowed=true,requestClass='invalid_request_url';
      try{
        remote=new URL(details.url).origin!==parsedOrigin.origin;
        allowed=localAIRequestAllowed(details.url,details.method,origin,allowedHubRedirects);
        if(!allowed)requestClass=localAIRequestClass(details.url,details.method,origin);
        if(allowed&&remote){
          consentAllowed=allowRemoteModelRequest()===true;
          allowed=consentAllowed;
        }
        if(remote)diagnostic(allowed?'model_network_allowed':'model_network_blocked',undefined,
          allowed?undefined:(consentAllowed?requestClass:'remote_consent_denied'));
        else if(!allowed)diagnostic('local_request_blocked',undefined,requestClass);
      }catch{}
      callback({cancel:!allowed});
    });
    contents.setWindowOpenHandler(()=>({action:'deny'}));
    contents.on('will-navigate',event=>{if(contents.getURL()!==pageURL)event.preventDefault();});
    contents.on('will-redirect',event=>event.preventDefault());
    createdWindow.on('closed',()=>{
      if(window===createdWindow){window=null;cancelActive();}
      rejectRendererStartup(contents,'renderer_closed_before_ready','Local transcription window closed before initialization.');
    });
    let startupResolve,startupReject;
    const startupReady=new Promise((resolve,reject)=>{startupResolve=resolve;startupReject=reject;});
    rendererStartup={contents,resolve:startupResolve,reject:startupReject,timer:setTimeout(()=>{
      if(rendererStartup?.contents!==contents)return;
      rejectRendererStartup(contents,'renderer_startup_timeout','Local inference renderer did not become ready.');
    },15_000)};
    diagnostic('renderer_load_started');
    loading=contents.loadURL(pageURL).then(async()=>{
      diagnostic('renderer_document_loaded');
      await startupReady;
      diagnostic('renderer_ready');
      return window;
    }).catch(cause=>{
      if(rendererStartup?.contents===contents){clearTimeout(rendererStartup.timer);rendererStartup=null;}
      const safeFailure=safeLoadFailure(cause);
      diagnostic('renderer_load_rejected',undefined,undefined,safeFailure.loadErrorCode,safeFailure.loadFailureClass,safeFailure.loadErrorToken);
      if(window===createdWindow){createdWindow.destroy();window=null;}
      throw Error(`Local transcription window could not start: ${cause.message}`);
    }).finally(()=>{loading=null;});
    return loading;
  }
  async function transcribe({ownerUserID,id,samples,language='en',signal}={}){
    check(!disposed&&ownerUserID===ownerID()&&ID.test(id??''),'The meeting owner changed.');
    check(samples instanceof Float32Array&&samples.length>0&&samples.length<=180*16_000,'Meeting audio has an invalid local inference format.');
    check(!active,'Local transcription is already running.');
    if(signal?.aborted)throw Object.assign(Error('Local transcription was cancelled.'),{name:'AbortError'});
    diagnostic(window&&!window.isDestroyed()?'window_reused':'window_create_requested');
    const view=await createWindow();
    check(ownerUserID===ownerID()&&!disposed,'The meeting owner changed.');
    view.show();view.focus();
    return new Promise((resolve,reject)=>{
      const requestID=randomUUID();
      const abort=()=>cancelActive();
      const hide=()=>{if(!view.isDestroyed())view.hide();};
      active={requestID,ownerUserID,id,signal,abort,resolve:result=>{hide();resolve(result);},reject:error=>{hide();reject(error);}};
      signal?.addEventListener('abort',abort,{once:true});
      view.webContents.send('reel-local-ai:task',{type:'transcribe',requestID,samples,language});
    diagnostic('task_sent');
    });
  }
  async function probeRenderer(){
    check(!disposed,'Local transcription is unavailable.');
    const view=await createWindow(),requestID=randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pendingProbes.delete(requestID);diagnostic('renderer_probe_timeout');reject(Error('Local renderer handoff probe timed out.'));},5_000);
      pendingProbes.set(requestID,{resolve,reject,timer});
      diagnostic('renderer_probe_sent');
      view.webContents.send('reel-local-ai:task',{type:'probe',requestID});
    });
  }
  function dispose(){
    disposed=true;cancelActive('Local transcription stopped while Reel closed.');
    if(rendererStartup)rejectRendererStartup(rendererStartup.contents,'renderer_shutdown_before_ready','Local transcription stopped while Reel closed.');
    for(const probe of pendingProbes.values()){clearTimeout(probe.timer);probe.reject(Error('Local transcription stopped while Reel closed.'));}
    pendingProbes.clear();if(window&&!window.isDestroyed())window.destroy();window=null;
  }
  return {transcribe,probeRenderer,dispose};
}

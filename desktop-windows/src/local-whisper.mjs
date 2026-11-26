import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ID=/^[0-9a-f]{32}$/;
const check=(condition,message)=>{if(!condition)throw Error(message);};
const MODEL_REVISION='360ebcde2559d60bb474678be3c1de9ef347d01a';
const MODEL_PATH=`/onnx-community/whisper-large-v3-turbo/resolve/${MODEL_REVISION}/`;
const MODEL_CDN_HOSTS=new Set(['cdn-lfs.huggingface.co','cas-bridge.xethub.hf.co']);

export function localAIRequestAllowed(requestURL,method,localOrigin){
  if(method!=='GET')return false;
  try{
    const url=new URL(requestURL),origin=new URL(localOrigin);
    if(url.username||url.password)return false;
    if(url.origin===origin.origin)return true;
    if(url.protocol!=='https:')return false;
    if(url.hostname==='huggingface.co')return url.pathname.startsWith(MODEL_PATH);
    return MODEL_CDN_HOSTS.has(url.hostname);
  }catch{return false;}
}

/** Isolated renderer for local inference. It has no auth preload or access to meeting services. */
export function createLocalWhisper({BrowserWindow,ipcMain,origin,ownerID}={}){
  check(typeof BrowserWindow==='function'&&ipcMain&&typeof origin==='string'&&typeof ownerID==='function','Invalid local Whisper dependencies.');
  const parsedOrigin=new URL(origin);
  check(parsedOrigin.protocol==='http:'&&parsedOrigin.hostname==='127.0.0.1'&&parsedOrigin.pathname==='/'&&!parsedOrigin.username&&!parsedOrigin.password,
    'Local transcription must use its private loopback origin.');
  let window=null,loading=null,active=null,disposed=false;
  const pageURL=origin+'/local-ai/';
  function currentWindow(event){return window&&!window.isDestroyed()&&event.sender===window.webContents&&event.senderFrame===window.webContents.mainFrame&&event.senderFrame?.url===pageURL;}
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
  function createWindow(){
    if(window&&!window.isDestroyed())return Promise.resolve(window);
    if(loading)return loading;
    window=new BrowserWindow({width:520,height:300,minWidth:420,minHeight:260,show:false,title:'Local meeting transcription',
      webPreferences:{preload:fileURLToPath(new URL('../local-ai/preload.cjs',import.meta.url)),sandbox:true,contextIsolation:true,nodeIntegration:false,
        partition:'persist:reel-local-ai',backgroundThrottling:false}});
    const contents=window.webContents;
    contents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    contents.session.setPermissionCheckHandler(()=>false);
    contents.session.setDevicePermissionHandler(()=>false);
    contents.session.webRequest.onBeforeRequest({urls:['<all_urls>']},(details,callback)=>
      callback({cancel:!localAIRequestAllowed(details.url,details.method,origin)}));
    contents.setWindowOpenHandler(()=>({action:'deny'}));
    contents.on('will-navigate',event=>{if(contents.getURL()!==pageURL)event.preventDefault();});
    contents.on('will-redirect',event=>event.preventDefault());
    window.on('closed',()=>{window=null;cancelActive();});
    loading=contents.loadURL(pageURL).then(()=>window).catch(cause=>{window?.destroy();window=null;throw Error(`Local transcription window could not start: ${cause.message}`);}).finally(()=>{loading=null;});
    return loading;
  }
  async function transcribe({ownerUserID,id,samples,language='en',signal}={}){
    check(!disposed&&ownerUserID===ownerID()&&ID.test(id??''),'The meeting owner changed.');
    check(samples instanceof Float32Array&&samples.length>0&&samples.length<=180*16_000,'Meeting audio has an invalid local inference format.');
    check(!active,'Local transcription is already running.');
    if(signal?.aborted)throw Object.assign(Error('Local transcription was cancelled.'),{name:'AbortError'});
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
    });
  }
  function dispose(){disposed=true;cancelActive('Local transcription stopped while Reel closed.');if(window&&!window.isDestroyed())window.destroy();window=null;}
  return {transcribe,dispose};
}

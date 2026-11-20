import {app,BrowserWindow,desktopCapturer,dialog,ipcMain,Menu,safeStorage,shell} from 'electron';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {organizationConfig} from '../web/reel/organization.js';
import {createWindowsAuth} from './src/auth.mjs';
import {discoverGoogleMeetings} from './src/google-calendar.mjs';
import {createMeetingCoordinator} from './src/meeting-coordinator.mjs';
import {createNativeBridge} from './src/native-bridge.mjs';
import {createLocalRecordingStore} from './src/local-recordings.mjs';
import {createWindowsRecorder} from './src/recorder.mjs';
import {createDesktopService} from './src/desktop-service.mjs';
import {createMeetingProcessor} from './src/meeting-processing.mjs';
import {startAssetServer} from './src/asset-server.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
let org=null;
try {
  org=organizationConfig(JSON.parse(readFileSync(path.join(root,'organization.json'),'utf8')));
} catch { /* local setup remains available */ }

let window,service,bridge,assets,poll,quitting=false,shutdown=null;
app.setName('Reel');
// Chromium and Reel must share the deployment scope before the instance lock and app readiness.
const organizationKey=org ? createHash('sha256').update(`${org.projectID}\n${org.allowedEmailDomain}`).digest('hex') : 'local';
const stateRoot=path.join(app.getPath('userData'),'organizations',organizationKey);
mkdirSync(stateRoot,{recursive:true,mode:0o700});
app.setPath('userData',stateRoot);
app.setPath('sessionData',stateRoot);
// Existing WebCodecs audio mixing must run without a synthetic user click.
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
if(!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance',()=>{window?.show();window?.focus();});
  app.on('activate',()=>window?.show());
  app.on('window-all-closed',()=>app.quit());
  app.on('before-quit',event=>{
    if(quitting) return;
    event.preventDefault();
    if(shutdown) return;
    clearInterval(poll);
    shutdown=(async()=>{
      try {
        await service?.dispose();await bridge?.dispose();await assets?.close();
        quitting=true;app.quit();
      } catch(cause) {
        shutdown=null;window?.show();
        const settingsPending=cause?.code==='settings_not_saved';
        await dialog.showMessageBox(window,{type:'warning',title:settingsPending?'Recording settings need saving':'Reel is still closing a meeting',
          message:settingsPending?cause.message:'Close the meeting window Reel opened, then quit Reel again. Your local recording has already been asked to stop.'});
      }
    })();
  });
  // Top-level await app.whenReady() deadlocks Electron's ESM startup on the tested Windows runtime.
  app.whenReady().then(run).catch(async()=>{
    await dialog.showMessageBox({type:'error',title:'Reel could not start',message:'Reel could not load its local desktop components. Reopen Reel or use the browser recorder.'});
    quitting=true;app.quit();
  });
}
async function run() {
  if(process.platform!=='win32') throw Error('This app requires Windows.');
  assets=await startAssetServer();
  const {origin}=assets;
  const storageRoot=path.join(stateRoot,'recordings');
  const store=createLocalRecordingStore({root:storageRoot});
  let credentials = {};
  try {
    credentials = JSON.parse(readFileSync(path.join(root, 'config.json'), 'utf8'));
  } catch { /* local setup remains available */ }
  const helper=path.join(root,'native','ReelNativeJoin.exe');
  let auth=null;
  if(org && /^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(org.googleDesktopClientId)
    && credentials.googleDesktopClientId === org.googleDesktopClientId
    && typeof credentials.googleDesktopClientSecret === 'string'
    && /^[A-Za-z0-9_-]{1,256}$/.test(credentials.googleDesktopClientSecret) && existsSync(helper)) {
    bridge=createNativeBridge({executable:helper});
    auth=createWindowsAuth({clientId:org.googleDesktopClientId,clientSecret:credentials.googleDesktopClientSecret,
      apiKey:org.apiKey, allowedEmailDomain:org.allowedEmailDomain, projectID:org.projectID,
      storagePath:path.join(stateRoot,'session.encrypted'),
      safeStorage,openExternal:async (value,options)=>{
        const result=await bridge.openGoogleSignIn(value,options);
        if(result.state!=='browser_opened') {
          const failure=Error('Could not open Google sign-in in Chrome.');
          failure.code=result.state;throw failure;
        }
      }});
    auth.load();
  }
  const processor=auth ? createMeetingProcessor({auth,store,speechURL:org.speechServiceURL,deliveryURL:org.deliveryServiceURL,allowedEmailDomain:org.allowedEmailDomain}) : null;
  const recorder=createWindowsRecorder({BrowserWindow,desktopCapturer,ipcMain,store,origin,
    defaultRenderEndpoint: bridge?.defaultRenderEndpoint,
    onCompleted:({ownerUserID,recording})=>{ if (!shutdown && auth?.getProfile()?.userID===ownerUserID && store.getProcessing({ownerUserID,id:recording.id})?.phase==='pending') void processor.process({ownerUserID,id:recording.id}).catch(()=>{}); },
    onFailure:()=>{void service?.action('stopRecording').catch(()=>{});},
    onSourceEnded:()=>service?.action('stopRecording')});
  service=createDesktopService({auth,org,store,processor,discover:discoverGoogleMeetings,
    createCoordinator:auth ? options=>createMeetingCoordinator({...options,native:bridge,recorder}) : null,
    openExternal:value=>shell.openExternal(value),
    openRecordings:async owner=>{
      const directory=path.join(storageRoot,createHash('sha256').update(owner).digest('hex'));
      await mkdir(directory,{recursive:true});const error=await shell.openPath(directory);
      if(error) throw Error('The recordings folder could not be opened.');
    },onState:state=>{if(window && !window.isDestroyed()) window.webContents.send('reel-desktop:state',state);}});
  window=new BrowserWindow({width:1100,height:850,minWidth:740,minHeight:560,title:'Reel',show:false,
    webPreferences:{preload:path.join(root,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,
      partition:'reel-setup',backgroundThrottling:false}});
  const contents=window.webContents;
  window.on('close',event=>{if(!quitting){event.preventDefault();app.quit();}});
  contents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  contents.session.setPermissionCheckHandler(()=>false);
  contents.session.setDevicePermissionHandler(()=>false);
  contents.setWindowOpenHandler(()=>({action:'deny'}));
  contents.on('will-navigate',event=>event.preventDefault());
  contents.on('will-redirect',event=>event.preventDefault());
  const authorize=event=>{
    if(event.sender!==contents || event.senderFrame!==contents.mainFrame || event.senderFrame.url!==origin+'/'
      || contents.getURL()!==origin+'/') throw Error('Unrecognized Reel request.');
  };
  ipcMain.handle('reel-desktop:state',event=>{
    authorize(event);
    try{return service.state();}catch{throw Error('Reel could not load its local settings. Check your local disk and reopen Reel.');}
  });
  ipcMain.handle('reel-desktop:action',async(event,name,payload)=>{
    authorize(event);
    try{return await service.action(name,payload);}catch(cause){
      if(cause?.path || cause?.syscall) throw Error('Reel could not read or save its local files. Check available disk space and try again.');
      throw cause;
    }
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {label:'Reel',submenu:[{label:'Meeting setup',click:()=>window.show()},{type:'separator'},{role:'quit'}]},
    {label:'File',submenu:[{label:'Record in browser',click:()=>void service.action('openRecorder')},
      {label:'Web library',click:()=>void service.action('openLibrary')} ]},
    {label:'Edit',submenu:[{role:'copy'},{role:'paste'},{role:'selectAll'}]}
  ]));
  await window.loadURL(origin+'/');window.show();
  poll=setInterval(()=>void service.pulse().catch(()=>{}),20_000);
  void service.pulse().catch(()=>{});
  void processor?.resume().catch(()=>{});
}

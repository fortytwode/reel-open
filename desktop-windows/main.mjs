import {app,BrowserWindow,clipboard,desktopCapturer,dialog,ipcMain,Menu,Notification,safeStorage,shell} from 'electron';
import {execFile,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readdirSync,readFileSync} from 'node:fs';
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
import {createCompanionStartup,createDesktopService,desktopBrowserAppArguments,desktopLaunchAction,desktopProductURL} from './src/desktop-service.mjs';
import {createMeetingProcessor} from './src/meeting-processing.mjs';
import {createLocalWhisper} from './src/local-whisper.mjs';
import {createMeetingShare} from './src/meeting-share.mjs';
import {createMeetingReminders,meetingReminderIDFromActivation} from './src/meeting-reminders.mjs';
import {createEncryptedReminderStore,createWindowsReminderTaskManager} from './src/windows-reminder-tasks.mjs';
import {startAssetServer} from './src/asset-server.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
let org=null;
try {
  org=organizationConfig(JSON.parse(readFileSync(path.join(root,'organization.json'),'utf8')));
} catch { /* local setup remains available */ }

const TOAST_APP_ID='RocketShipHQ.Reel.Companion';
const TOAST_ACTIVATOR_CLSID='{A4E2C27A-6732-45DA-B357-C33516B7901B}';
let window,service,bridge,assets,localWhisper,poll,reminderPoll,quitting=false,shutdown=null,queuedReminderMeetingID=null;
let auth,store,reminders,reminderTasks,reminderTriggerOnly=false,pendingReminderTokens=[];
function reminderTriggerFromArgs(args=[]) {
  const found=args.filter(arg=>typeof arg==='string'&&arg.startsWith('--meeting-reminder-trigger='))
    .map(arg=>arg.slice('--meeting-reminder-trigger='.length));
  return found.length===1&&/^[a-f0-9]{32}$/.test(found[0])?found[0]:null;
}
function reminderOpenFromArgs(args=[]) {
  const found=args.filter(arg=>typeof arg==='string'&&arg.startsWith('--open-reminder-id='))
    .map(arg=>arg.slice('--open-reminder-id='.length));
  if(found.length!==1||!found[0]||found[0].length>12288) return null;
  try { const value=decodeURIComponent(found[0]);return value.length<=4096?value:null; } catch { return null; }
}
function hasReminderTriggerMarker() {
  try { return readdirSync(path.join(stateRoot,'reminder-triggers')).some(name=>/^[a-f0-9]{32}[.]trigger$/.test(name)); }
  catch { return false; }
}
function processReminderTrigger(token) {
  if(!/^[a-f0-9]{32}$/.test(token)||!reminders||!reminderTasks) return false;
  const owner=auth?.getProfile()?.userID??null;
  let enabled=false;
  try { if(owner&&store) enabled=store.getSettings(owner).meetingReminders===true; } catch { enabled=false; }
  const shown=reminders.fire(token,{owner,reminders:enabled,at:new Date()});
  reminderTasks.clearPending(token);
  return shown;
}
function processPendingReminderTriggers() {
  for(const token of [...pendingReminderTokens,...(reminderTasks?.pending()??[])]) processReminderTrigger(token);
  pendingReminderTokens=[];
}
function ensureWindowsToastShortcut() {
  if(process.platform!=='win32') return true;
  if(process.windowsStore===true) return true;
  if(!app.isPackaged) return false;
  try {
    const programs=path.join(app.getPath('appData'),'Microsoft','Windows','Start Menu','Programs');
    mkdirSync(programs,{recursive:true});
    const link=path.join(programs,'Reel Companion.lnk');
    const written=shell.writeShortcutLink(link,'create',{target:process.execPath,cwd:path.dirname(process.execPath),args:[],
      description:'Reel Companion',appUserModelId:TOAST_APP_ID,toastActivatorClsid:TOAST_ACTIVATOR_CLSID});
    const shortcut=written&&shell.readShortcutLink(link);
    return Boolean(shortcut&&shortcut.appUserModelId===TOAST_APP_ID&&shortcut.toastActivatorClsid===TOAST_ACTIVATOR_CLSID);
  } catch { return false; }
}
function focusMeetingReminder(meetingID) {
  if(typeof meetingID!=='string' || !meetingID || meetingID.length>4096) return;
  if(!window || window.isDestroyed() || !assets || window.webContents.getURL()!==assets.origin+'/') {
    queuedReminderMeetingID=meetingID;return;
  }
  queuedReminderMeetingID=null;window.show();window.focus();
  window.webContents.send('reel-desktop:meeting-reminder',meetingID);
}
app.setName('Reel');
if(process.platform==='win32') {
  if(process.windowsStore!==true) app.setAppUserModelId(TOAST_APP_ID);
  app.setToastActivatorCLSID(TOAST_ACTIVATOR_CLSID);
}
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
  app.on('second-instance',(_event,commandLine)=>{
    const reminderToken=reminderTriggerFromArgs(commandLine);
    if(reminderToken) {
      pendingReminderTokens.push(reminderToken);
      processPendingReminderTriggers();
      return;
    }
    if(hasReminderTriggerMarker()) { processPendingReminderTriggers(); return; }
    const reminderID=reminderOpenFromArgs(commandLine);
    if(reminderID) { focusMeetingReminder(reminderID); return; }
    const action=desktopLaunchAction(commandLine);
    if(action) { void openProductEntry(action); return; }
    window?.show();window?.focus();
  });
  app.on('activate',()=>{if(hasReminderTriggerMarker()) processPendingReminderTriggers();else window?.show();});
  app.on('window-all-closed',()=>app.quit());
  app.on('before-quit',event=>{
    if(quitting) return;
    event.preventDefault();
    if(shutdown) return;
    clearInterval(poll);
    clearInterval(reminderPoll);
    shutdown=(async()=>{
      try {
        await service?.dispose();localWhisper?.dispose();await bridge?.dispose();await assets?.close();
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
  app.whenReady().then(async()=>{
    const action=desktopLaunchAction(process.argv);
    if(action && await openProductEntry(action)) { app.quit(); return; }
    const triggerToken=reminderTriggerFromArgs(process.argv),openReminderID=reminderOpenFromArgs(process.argv);
    if(openReminderID) queuedReminderMeetingID=openReminderID;
    await run({triggerOnly:Boolean(triggerToken||hasReminderTriggerMarker()),triggerToken});
  }).catch(async()=>{
    await dialog.showMessageBox({type:'error',title:'Reel could not start',message:'Reel could not load its local desktop components. Reopen Reel or use the browser recorder.'});
    quitting=true;app.quit();
  });
}
async function openProductEntry(action) {
  const product=action==='openRecorder'?'Recorder':'Notetaker';
  try {
    const url=desktopProductURL(action,org);
    for(const executable of installedBrowsers()) {
      try {
        await launchBrowserApp(executable,desktopBrowserAppArguments(action,org));
        return true;
      } catch { /* Try another verified Edge or Chrome install. */ }
    }
    await shell.openExternal(url);
    await showLaunchMessage({type:'info',title:`Opened Reel ${product} in your browser`,
      message:`Edge or Chrome was not found in its standard install location. The default browser opened instead; install Edge or Chrome to open Reel ${product} in its own app window.`});
    return true;
  } catch(cause) {
    const options={type:'error',title:`Could not open Reel ${product}`,
      message:cause?.message || `Reel ${product} could not open. Check its organization URL and your browser installation.`};
    await showLaunchMessage(options);
    return false;
  }
}
async function showLaunchMessage(options) {
  if(window && !window.isDestroyed()) {
    await dialog.showMessageBox(window,options);
    window.show();
  } else await dialog.showMessageBox(options);
}
function installedBrowsers() {
  const programFiles=process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86=process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local=process.env.LOCALAPPDATA || '';
  const candidates=[
    [path.join(programFilesX86,'Microsoft','Edge','Application','msedge.exe'),programFilesX86],
    [path.join(programFiles,'Microsoft','Edge','Application','msedge.exe'),programFiles],
    [local && path.join(local,'Microsoft','Edge','Application','msedge.exe'),local],
    [path.join(programFilesX86,'Google','Chrome','Application','chrome.exe'),programFilesX86],
    [path.join(programFiles,'Google','Chrome','Application','chrome.exe'),programFiles],
    [local && path.join(local,'Google','Chrome','Application','chrome.exe'),local],
  ];
  const found=[];
  for(const [executable,rootPath] of candidates) {
    if(!executable || !rootPath) continue;
    try {
      const resolved=path.resolve(executable).toLowerCase();
      const root=path.resolve(rootPath).toLowerCase()+path.sep;
      if(resolved.startsWith(root) && existsSync(executable)
        && !found.includes(executable)) found.push(executable);
    } catch { /* Ignore missing or non-file browser candidates. */ }
  }
  return found;
}
function launchBrowserApp(executable,args) {
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{detached:true,stdio:'ignore',windowsHide:false});
    child.once('error',reject);
    child.once('spawn',()=>{child.unref();resolve();});
  });
}
function runMediaTrim(executable,args) {
  return new Promise((resolve,reject)=>execFile(executable,args,{windowsHide:true,timeout:15*60*1000,maxBuffer:4096},(error,stdout,stderr)=>{
    if(error) return reject(Error(String(stderr || error.message || 'Windows could not export this recording.').trim().slice(0,500)));
    resolve(stdout.trim());
  }));
}
async function run({triggerOnly=false,triggerToken=null}={}) {
  if(process.platform!=='win32') throw Error('This app requires Windows.');
  const toastReady=ensureWindowsToastShortcut();
  const storageRoot=path.join(stateRoot,'recordings');
  store=createLocalRecordingStore({root:storageRoot});
  let credentials = {};
  try {
    credentials = JSON.parse(readFileSync(path.join(root, 'config.json'), 'utf8'));
  } catch { /* local setup remains available */ }
  const helper=path.join(root,'native','ReelNativeJoin.exe');
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
  let persistentError=null, persistence=null;
  try {
    reminderTasks=createWindowsReminderTaskManager({stateRoot,scope:organizationKey,windowsStore:process.windowsStore===true,executable:process.execPath});
    if(!toastReady) throw Error('Windows notification shortcut is unavailable.');
    const encrypted=createEncryptedReminderStore({safeStorage,filePath:path.join(stateRoot,'meeting-reminders.encrypted')});
    persistence={load:encrypted.load,save:encrypted.save,sync:reminderTasks.sync};
  } catch {
    persistentError='Windows could not securely schedule notifications. Keep Reel Companion open and retry calendar refresh.';
    try { reminderTasks?.sync([]); } catch { /* Fire-time validation still rejects missing encrypted schedule records. */ }
    persistence=null;
  }
  reminders=createMeetingReminders({Notification,activate:focusMeetingReminder,persistence,persistentError});
  if(typeof Notification.handleActivation==='function') Notification.handleActivation(details=>{
    const meetingID=meetingReminderIDFromActivation(details);
    if(!meetingID) return;
    if(reminderTriggerOnly) {
      const args=process.argv.slice(1).filter(arg=>!arg.startsWith('--meeting-reminder-trigger=')&&!arg.startsWith('--open-reminder-id='));
      app.relaunch({args:[...args,`--open-reminder-id=${encodeURIComponent(meetingID)}`]});app.quit();
    } else focusMeetingReminder(meetingID);
  });
  if(triggerOnly) {
    reminderTriggerOnly=true;
    if(triggerToken) pendingReminderTokens.push(triggerToken);
    processPendingReminderTriggers();
    setTimeout(()=>app.quit(),1000);
    return;
  }
  reminderTriggerOnly=false;
  processPendingReminderTriggers();
  assets=await startAssetServer();
  const {origin}=assets;
  localWhisper=auth&&typeof ipcMain.on==='function' ? createLocalWhisper({BrowserWindow,ipcMain,origin:assets.localAIOrigin,ownerID:()=>auth?.getProfile()?.userID??null}) : null;
  const processor=auth ? createMeetingProcessor({auth,store,speechURL:org.speechServiceURL,deliveryURL:org.deliveryServiceURL,allowedEmailDomain:org.allowedEmailDomain,
    localTranscribe:localWhisper?.transcribe,modeForOwner:ownerUserID=>store.getSettings(ownerUserID)?.localTranscription?'local':'cloud'}) : null;
  const meetingShare=auth && org ? createMeetingShare({auth,store,org,copy:value=>clipboard.writeText(value)}) : null;
  const recorder=createWindowsRecorder({BrowserWindow,desktopCapturer,ipcMain,store,origin,
    defaultRenderEndpoint: bridge?.defaultRenderEndpoint,
    onCompleted:({ownerUserID,recording})=>{ if (!shutdown && auth?.getProfile()?.userID===ownerUserID && store.getProcessing({ownerUserID,id:recording.id})?.phase==='pending') void processor.process({ownerUserID,id:recording.id}).catch(()=>{}); },
    onFailure:()=>{void service?.action('stopRecording').catch(()=>{});},
    onSourceEnded:()=>service?.action('stopRecording')});
  service=createDesktopService({auth,org,store,processor,shareMeeting:meetingShare,reminderScheduler:reminders,discover:discoverGoogleMeetings,
    createCoordinator:auth ? options=>createMeetingCoordinator({...options,native:bridge,recorder}) : null,
    openExternal:value=>shell.openExternal(value),openProduct:openProductEntry,
    openRecording:async file=>{ const error=await shell.openPath(file); if(error) throw Error('Could not open the recording.'); },
    revealRecording:file=>shell.showItemInFolder(file),
    exportTrimmedCopy:async({file,title,start,end})=>{
      const safeTitle=String(title || 'Meeting').replace(/[<>:"/\\|?*\u0000-\u001f]/g,' ').replace(/[. ]+$/,'').slice(0,120) || 'Meeting';
      const result=await dialog.showSaveDialog(window,{title:'Export trimmed meeting copy',buttonLabel:'Export copy',
        defaultPath:path.join(path.dirname(file),`${safeTitle} (trimmed).mp4`),filters:[{name:'MP4 video',extensions:['mp4']}]});
      if(result.canceled || !result.filePath) return {canceled:true};
      const destination=path.resolve(result.filePath),source=path.resolve(file);
      if(destination.toLowerCase()===source.toLowerCase()) throw Error('Choose a different file so the original recording stays unchanged.');
      const executable=path.join(root,'native','ReelMediaTrim.exe');
      await runMediaTrim(executable,[source,String(start),String(end),destination]);
      shell.showItemInFolder(destination);
      return {canceled:false};
    },
    copyText:value=>clipboard.writeText(value),
    startup:createCompanionStartup({app,shell,windowsStore:process.windowsStore,executable:process.execPath,organizationKey}),
    openRecordings:async owner=>{
      const directory=path.join(storageRoot,createHash('sha256').update(owner).digest('hex'));
      await mkdir(directory,{recursive:true});const error=await shell.openPath(directory);
      if(error) throw Error('The recordings folder could not be opened.');
    },onState:state=>{if(window && !window.isDestroyed()) window.webContents.send('reel-desktop:state',state);}});
  window=new BrowserWindow({width:1100,height:850,minWidth:740,minHeight:560,title:'Reel',show:false,
    webPreferences:{preload:path.join(root,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,
      partition:'reel-setup',backgroundThrottling:false}});
  const contents=window.webContents;
  window.on('focus',()=>{
    if(contents.getURL()!==origin+'/') return;
    try { contents.send('reel-desktop:state',service.state()); } catch { /* explicit state requests report local errors */ }
  });
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
    {label:'File',submenu:[{label:'Open Reel Recorder',click:()=>void service.action('openRecorder')},
      {label:'Open Reel Notetaker',click:()=>void service.action('openNotetaker')},
      {label:'Web library',click:()=>void service.action('openLibrary')} ]},
    {label:'Edit',submenu:[{role:'copy'},{role:'paste'},{role:'selectAll'}]}
  ]));
  await window.loadURL(origin+'/');window.show();
  if(queuedReminderMeetingID) focusMeetingReminder(queuedReminderMeetingID);
  poll=setInterval(()=>void service.pulse().catch(()=>{}),20_000);
  reminderPoll=setInterval(processPendingReminderTriggers,500);
  void service.pulse().catch(()=>{});
  void processor?.resume().catch(()=>{});
}

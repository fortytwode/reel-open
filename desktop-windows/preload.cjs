const {contextBridge,ipcRenderer}=require('electron');
const allowed=new Set(['signIn','connectCalendar','cancelSignIn','signOut','disconnectCalendar','refresh',
  'saveSettings','stopRecording','retryProcessing','shareRecording','openLibrary','openNotetaker','openRecorder','openRecordings',
  'openStartupSettings','setCompanionStartup']);
contextBridge.exposeInMainWorld('reelDesktop',Object.freeze({
  state:()=>ipcRenderer.invoke('reel-desktop:state'),
  action:(name,payload)=>{
    if(!allowed.has(name)) return Promise.reject(Error('Unknown Reel action.'));
    return ipcRenderer.invoke('reel-desktop:action',name,payload);
  },
  onState(callback){
    if(typeof callback!=='function') throw TypeError('State callback required');
    const listener=(_event,value)=>callback(value);ipcRenderer.on('reel-desktop:state',listener);
    return ()=>ipcRenderer.removeListener('reel-desktop:state',listener);
  }
}));

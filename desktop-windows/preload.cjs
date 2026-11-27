const {contextBridge,ipcRenderer}=require('electron');
const allowed=new Set(['signIn','connectCalendar','cancelSignIn','signOut','disconnectCalendar','refresh',
  'saveSettings','joinMeeting','joinMeetingLink','cancelJoin','stopRecording','retryProcessing','shareRecording','updateMeetingShareAccess','renameRecording','deleteRecording','playRecording','revealRecording','copyTranscript','exportTrimmedCopy',
  'openLibrary','openNotetaker','openRecorder','openRecordings','openStartupSettings','setCompanionStartup','getTranscript']);
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
  },
  onMeetingReminder(callback){
    if(typeof callback!=='function') throw TypeError('Meeting reminder callback required');
    const listener=(_event,id)=>{if(typeof id==='string' && id.length>0 && id.length<=4096) callback(id);};
    ipcRenderer.on('reel-desktop:meeting-reminder',listener);
    return ()=>ipcRenderer.removeListener('reel-desktop:meeting-reminder',listener);
  }
}));

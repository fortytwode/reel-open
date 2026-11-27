const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('reelLocalAI',Object.freeze({
  onTask(callback){if(typeof callback!=='function')throw TypeError('Task callback required');const listener=(_event,value)=>callback(value);ipcRenderer.on('reel-local-ai:task',listener);return()=>ipcRenderer.removeListener('reel-local-ai:task',listener);},
  progress(value){ipcRenderer.send('reel-local-ai:progress',value);},
  complete(value){ipcRenderer.send('reel-local-ai:complete',value);}
}));
ipcRenderer.send('reel-local-ai:preload-ready');

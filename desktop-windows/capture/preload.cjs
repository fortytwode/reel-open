const { contextBridge, ipcRenderer } = require('electron');
let token = null;
let listener = null;
let pending = null;
ipcRenderer.on('reel-capture:command', (_event, message) => {
  if (!message || !['start', 'stop', 'pause', 'resume', 'refresh-audio'].includes(message.type)) return;
  if (message.type === 'start') {
    if (token || !/^[0-9a-f]{32}$/.test(message.token ?? '')) return;
    token = message.token;
  } else if (message.token !== token) return;
  const command = message.type === 'start' ? { type: 'start', sourceId: message.sourceId, canRefreshAudio: message.canRefreshAudio === true, microphone: message.microphone === true } : { type: message.type, request: message.request, deadline: message.deadline };
  if (listener) listener(command); else pending = command;
});
const status = message => ipcRenderer.invoke('reel-capture:status', { token, ...message });
contextBridge.exposeInMainWorld('reelCapture', Object.freeze({
  onCommand(callback) {
    if (listener || typeof callback !== 'function') throw Error('Capture command listener already configured');
    listener = callback;
    if (pending) { const command = pending; pending = null; callback(command); }
  },
  ready: info => status({ type: 'ready', info: { video: info.video, audio: info.audio } }),
  appendAudio: bytes => ipcRenderer.invoke('reel-capture:audio', { token, bytes }),
  pauseChanged: paused => status({ type: 'pause_changed', paused }),
  audioEnded: () => status({ type: 'audio_ended' }),
  audioRefreshed: (request, ok) => status({ type: 'audio_refreshed', request, ok: ok === true }),
  audioFailed: () => status({ type: 'audio_failed' }),
  appendInit: bytes => ipcRenderer.invoke('reel-capture:packet', { token, kind: 'init', bytes }),
  appendFragment: (index, duration, bytes) => ipcRenderer.invoke('reel-capture:packet', { token, kind: 'fragment', index, duration, bytes }),
  done: info => status({ type: 'done', duration: info.duration, segments: info.segments }),
  sourceEnded: () => status({ type: 'source_ended' }),
  failed: (reason, errorName) => status({ type: 'failed', reason,
    ...(reason === 'capture_failed' && typeof errorName === 'string' ? { errorName } : {}) }),
}));

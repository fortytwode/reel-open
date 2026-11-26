import {appendFileSync} from 'node:fs';
import {app} from 'electron';

const logPath=process.env.REEL_WHISPER_SMOKE_LOG;
if(typeof logPath!=='string'||!logPath)throw Error('Packaged readiness smoke log path is required.');
function log(phase){
  const line=JSON.stringify({time:new Date().toISOString(),run:'readiness',phase});
  appendFileSync(logPath,line+'\n');
  process.stdout.write(line+'\n');
}
log('readiness_start');
// Do not use top-level await here: awaiting Electron readiness in the ESM entry
// point prevents the Windows runtime from completing its own readiness event.
app.whenReady().then(()=>{
  log('electron_ready');
  app.exit(0);
},()=>{
  log('electron_ready_failed');
  app.exit(1);
});

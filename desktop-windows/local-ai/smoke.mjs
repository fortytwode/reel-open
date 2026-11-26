import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {app,BrowserWindow,ipcMain} from 'electron';
import {startAssetServer} from '../src/asset-server.mjs';
import {whisperSamples} from '../src/meeting-processing.mjs';
import {createLocalWhisper} from '../src/local-whisper.mjs';

const audioPath=process.argv[2];
assert.ok(audioPath,'Supply a synthetic PCM16/16kHz/mono speech WAV file.');
const profileRoot=mkdtempSync(path.join(os.tmpdir(),'reel-whisper-cache-'));
app.setPath('userData',profileRoot);app.setPath('sessionData',profileRoot);
const windows=[];
class SmokeWindow extends BrowserWindow{constructor(options){super(options);windows.push(this);}}
let assets,local,exitCode=0;
try{
  await app.whenReady();
  assets=await startAssetServer();
  local=createLocalWhisper({BrowserWindow:SmokeWindow,ipcMain,origin:assets.localAIOrigin,ownerID:()=> 'smoke-owner'});
  const samples=await whisperSamples(new Blob([await readFile(audioPath)]));
  const first=await local.transcribe({ownerUserID:'smoke-owner',id:'a'.repeat(32),samples,language:'en'});
  assert.equal(first.engine,'Whisper large-v3-turbo q8');
  assert.ok(first.text.trim(),'Whisper must decode speech from the synthetic WAV.');
  assert.ok(/local|meeting|privacy|transcription|device/iu.test(first.text),`Unexpected Whisper output: ${first.text.slice(0,180)}`);
  const session=windows.at(-1).webContents.session;
  session.webRequest.onBeforeRequest({urls:['https://huggingface.co/*','https://cdn-lfs.huggingface.co/*','https://cas-bridge.xethub.hf.co/*']},(_details,callback)=>callback({cancel:true}));
  windows.at(-1).destroy();
  await new Promise(resolve=>setImmediate(resolve));
  const second=await local.transcribe({ownerUserID:'smoke-owner',id:'a'.repeat(32),samples,language:'en'});
  assert.equal(second.engine,'Whisper large-v3-turbo q8');
  assert.ok(/local|meeting|privacy|transcription|device/iu.test(second.text),`Offline cached inference failed: ${second.text.slice(0,180)}`);
  process.stdout.write('Local Whisper inference and offline cached second run passed.\n');
}catch(error){
  exitCode=1;process.stderr.write(`${error?.stack??error}\n`);
}finally{
  local?.dispose();
  await assets?.close();
  app.exit(exitCode);
}

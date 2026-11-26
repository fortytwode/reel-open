import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {app,BrowserWindow,ipcMain} from 'electron';
import {startAssetServer} from '../src/asset-server.mjs';
import {whisperSamples} from '../src/meeting-processing.mjs';
import {createLocalWhisper} from '../src/local-whisper.mjs';

const audioPath=process.env.REEL_WHISPER_SMOKE_AUDIO;
const packagedRoot=process.env.REEL_WHISPER_SMOKE_ROOT;
const expectedArch=process.env.REEL_WHISPER_SMOKE_ARCH;
assert.ok(audioPath&&packagedRoot&&['x64','arm64'].includes(expectedArch),'Supply synthetic PCM16/16kHz/mono speech, extracted resources/app path, and expected architecture.');
assert.equal(process.platform,'win32');
assert.equal(process.arch,expectedArch);
const profileRoot=mkdtempSync(path.join(os.tmpdir(),'reel-whisper-cache-'));
app.setPath('userData',profileRoot);app.setPath('sessionData',profileRoot);
const windows=[];
class SmokeWindow extends BrowserWindow{constructor(options){super(options);windows.push(this);}}
let assets,local,exitCode=0,modelNetworkBlocked=false,blockedRemoteRequests=0;
try{
  await app.whenReady();
  assets=await startAssetServer({root:packagedRoot});
  local=createLocalWhisper({BrowserWindow:SmokeWindow,ipcMain,origin:assets.localAIOrigin,ownerID:()=> 'smoke-owner',
    allowRemoteModelRequest:()=>{if(modelNetworkBlocked){blockedRemoteRequests++;return false;}return true;}});
  const samples=await whisperSamples(new Blob([await readFile(audioPath)]));
  const first=await local.transcribe({ownerUserID:'smoke-owner',id:'a'.repeat(32),samples,language:'en'});
  assert.equal(first.engine,'Whisper large-v3-turbo q8');
  assert.ok(first.text.trim(),'Whisper must decode speech from the synthetic WAV.');
  assert.ok(/local|meeting|privacy|transcription|device/iu.test(first.text),`Unexpected Whisper output: ${first.text.slice(0,180)}`);
  modelNetworkBlocked=true;
  windows.at(-1).destroy();
  await new Promise(resolve=>setImmediate(resolve));
  const second=await local.transcribe({ownerUserID:'smoke-owner',id:'a'.repeat(32),samples,language:'en'});
  assert.equal(second.engine,'Whisper large-v3-turbo q8');
  assert.ok(/local|meeting|privacy|transcription|device/iu.test(second.text),`Offline cached inference failed: ${second.text.slice(0,180)}`);
  const remoteRequestBlocked=await windows.at(-1).webContents.executeJavaScript(
    `fetch('https://huggingface.co/onnx-community/whisper-large-v3-turbo/resolve/360ebcde2559d60bb474678be3c1de9ef347d01a/config.json',{cache:'no-store'}).then(()=>false,()=>true)`);
  assert.equal(remoteRequestBlocked,true,'The recreated inference window must block model network requests.');
  assert.equal(blockedRemoteRequests,1,'The production network policy must deny the probe request after window recreation.');
  process.stdout.write('Local Whisper inference and offline cached second run passed.\n');
}catch(error){
  exitCode=1;process.stderr.write(`${error?.stack??error}\n`);
}finally{
  local?.dispose();
  await assets?.close();
  app.exit(exitCode);
}

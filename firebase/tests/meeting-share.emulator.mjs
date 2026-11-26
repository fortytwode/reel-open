// Local-only integration check for the Windows explicit meeting-share path.
// Run under Firebase emulators:exec with auth,firestore,storage and the demo-reel fixture.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, GoogleAuthProvider, signInWithCredential } from 'firebase/auth';
import * as C from '../../web/reel/core.js';
import { FirestoreClient } from '../../web/reel/cloud.js';
import { createLocalRecordingStore } from '../../desktop-windows/src/local-recordings.mjs';
import { createMeetingShare } from '../../desktop-windows/src/meeting-share.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const org=JSON.parse(await readFile(path.join(ROOT,'.reel/test-fixture/web/organization.json'),'utf8'));
assert.equal(org.projectID,'demo-reel','Integration smoke needs the synthetic demo-reel organization.');
const temp=await mkdtemp(path.join(os.tmpdir(),'reel-windows-share-'));
const storeRoot=path.join(temp,'recordings'), videoDir=path.join(temp,'web');
await mkdir(videoDir,{recursive:true});
const fixtureMP4=path.join(temp,'fixture.mp4');
execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc=size=640x360:rate=20:duration=3',
  '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=3','-c:v','libx264','-preset','ultrafast',
  '-pix_fmt','yuv420p','-c:a','aac','-b:a','64k','-movflags','+faststart','-shortest','-y',fixtureMP4]);
const id=createHash('sha256').update(String(Date.now())).digest('hex').slice(0,32);
let ownerApp, otherApp, browser, server;
const contentTypes={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json'};
try {
  async function account(label) {
    const app=initializeApp({apiKey:org.apiKey,authDomain:org.authDomain,projectId:'demo-reel'},`meeting-share-${label}-${Date.now()}`);
    const auth=getAuth(app); connectAuthEmulator(auth,'http://127.0.0.1:9099',{disableWarnings:true});
    const email=`share-${label}-${Date.now()}@${org.allowedEmailDomain}`;
    const identity=JSON.stringify({sub:`${label}-${Date.now()}`,email,email_verified:true,name:'Synthetic meeting owner'});
    const result=await signInWithCredential(auth,GoogleAuthProvider.credential(identity));
    return {app,auth,user:result.user,session:{uid:result.user.uid,email:result.user.email,displayName:result.user.displayName,getIdToken:()=>result.user.getIdToken()}};
  }
  ownerApp=await account('owner'); otherApp=await account('other');
  const ownerID=ownerApp.user.uid, recordingPath=path.join(storeRoot,createHash('sha256').update(ownerID).digest('hex'));
  await mkdir(recordingPath,{recursive:true});
  const videoPath=path.join(recordingPath,`${id}.mp4`);
  await writeFile(videoPath,await readFile(fixtureMP4));
  await writeFile(path.join(recordingPath,'library.json'),JSON.stringify({version:1,ownerUserID:ownerID,
    settings:{ownerUserID:ownerID,autoJoin:false,participantConsent:false,systemAudioConsent:false,selection:{useAll:true,ids:[]}},
    completed:{},recordings:[{id,title:'Synthetic local meeting',createdAt:'2026-11-26T10:00:00.000Z',durationSeconds:3,
      width:640,height:360,processing:{phase:'completed',meeting:{attendees:['private-attendee@northwind.example']}}}]}));
  const store=createLocalRecordingStore({root:storeRoot});
const port=Number(process.env.REEL_SHARE_PORT||5052), origin=`http://127.0.0.1:${port}`;
const cfg={...org,storageOrigin:'http://127.0.0.1:9199',firestoreOrigin:'http://127.0.0.1:8080',viewerBase:origin};
  const copied=[];
  const share=createMeetingShare({auth:{getProfile:()=>({userID:ownerID,email:ownerApp.user.email,displayName:'Synthetic meeting owner'}),getIdToken:()=>ownerApp.user.getIdToken()},
    store,org,cfg,copy:url=>copied.push(url)});
  const result=await share.share({ownerUserID:ownerID,id});
  assert.equal(result.uploaded,true); assert.equal(copied[0],result.url);
  const local=await store.getShareRecord({ownerUserID:ownerID,id});
  const shareID=local.share.shareID;
  assert.equal(shareID,await C.ownerShareID(ownerID,local.share.recordingNonce));
  const ownerCloud=new FirestoreClient(ownerApp.session,cfg), otherCloud=new FirestoreClient(otherApp.session,cfg);
  assert.equal(await ownerCloud.ownsRoom(shareID),true);
  assert.equal(await otherCloud.ownsRoom(shareID),false);
  const libraryURL=`http://127.0.0.1:8080/v1/projects/demo-reel/databases/reel/documents/users/${encodeURIComponent(ownerID)}/recordings/${shareID}`;
  const ownerDoc=await fetch(libraryURL,{headers:{Authorization:`Bearer ${await ownerApp.user.getIdToken()}`}});
  assert.equal(ownerDoc.ok,true);
  const otherDoc=await fetch(libraryURL,{headers:{Authorization:`Bearer ${await otherApp.user.getIdToken()}`}});
  assert.equal(otherDoc.status,403,'The private library entry must reject other owners.');
  const mediaURL=C.downloadURL(shareID,C.File.video,null,cfg);
  const downloaded=await fetch(mediaURL); assert.equal(downloaded.ok,true);
  const downloadedPath=path.join(temp,'shared.mp4'); await writeFile(downloadedPath,Buffer.from(await downloaded.arrayBuffer()));
  const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','stream=codec_name,codec_type,width,height','-of','json',downloadedPath],{encoding:'utf8'}));
  assert.ok(probe.streams.some(stream=>stream.codec_type==='video'&&stream.codec_name==='h264'&&stream.width===640&&stream.height===360));
  assert.ok(probe.streams.some(stream=>stream.codec_type==='audio'&&stream.codec_name==='aac'));
  const web=path.join(ROOT,'web');
  server=http.createServer(async(req,res)=>{
    let pathname=new URL(req.url,origin).pathname;
    if(pathname.startsWith('/v/')) pathname='/v.html';
    try { const filename=pathname==='/organization.json'?path.join(ROOT,'.reel/test-fixture/web/organization.json')
      :path.resolve(web,`.${pathname==='/'?'/index.html':pathname}`);
      const bytes=await readFile(filename);res.writeHead(200,{'Content-Type':contentTypes[path.extname(pathname)]||'application/octet-stream'});res.end(bytes);
    } catch { res.writeHead(404);res.end('not found'); }
  }).listen(port,'127.0.0.1');
  const pageURL=`${origin}/v/${shareID}?emulator=1`;
  assert.equal(result.url,`${origin}/v/${shareID}`,'The returned share link must match the local viewer origin.');
  browser=await chromium.launch({channel:process.env.REEL_BROWSER||'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
  const context=await browser.newContext();
  const localOrigins=new Set([origin,'http://127.0.0.1:9199','http://127.0.0.1:8080','http://127.0.0.1:9099']);
  const sdk=`https://www.gstatic.com/firebasejs/12.19.0/`;
  const packageRoot=path.join(path.dirname(fileURLToPath(import.meta.url)),'node_modules/firebase');
  await context.route(/^https?:\/\//,route=>{
    const url=new URL(route.request().url());
    if(localOrigins.has(url.origin)) return route.continue();
    const file=url.href===sdk+'firebase-app.js'?'firebase-app.js':url.href===sdk+'firebase-auth.js'?'firebase-auth.js':url.href===sdk+'firebase-firestore.js'?'firebase-firestore.js':null;
    if(file) return route.fulfill({path:path.join(packageRoot,file),contentType:'text/javascript',headers:{'access-control-allow-origin':'*'}});
    return route.abort();
  });
  const page=await context.newPage(); await page.goto(pageURL);
  const played=await page.waitForFunction(async()=>{
    const video=document.querySelector('#player');
    if(!video||video.hidden) return false;
    video.muted=true; await video.play().catch(()=>{});
    return video.readyState>=2&&video.currentTime>0.5;
  }, undefined, {timeout:25000});
  assert.ok(played,'The generated Windows meeting share should play in the existing viewer.');
  assert.ok(await page.locator('#download').isVisible());
  console.log(JSON.stringify({result:'PASS',ownerBoundRoom:true,otherOwnerDenied:true,privateLibraryDenied:true,
    videoStreams:probe.streams,viewerPlayed:true,shareURL:result.url}));
  await context.close();
} finally {
  await browser?.close().catch(()=>{});
  await new Promise(resolve=>server?.close(resolve) ?? resolve());
  if(ownerApp) await deleteApp(ownerApp.app).catch(()=>{});
  if(otherApp) await deleteApp(otherApp.app).catch(()=>{});
  await rm(temp,{recursive:true,force:true});
}

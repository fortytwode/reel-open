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
import { getFirestore, connectFirestoreEmulator, collection, addDoc, serverTimestamp, getDocs } from 'firebase/firestore';
import * as C from '../../web/reel/core.js';
import { FirestoreClient, StorageClient } from '../../web/reel/cloud.js';
import { createLocalRecordingStore } from '../../desktop-windows/src/local-recordings.mjs';
import { createMeetingShare } from '../../desktop-windows/src/meeting-share.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const org=JSON.parse(await readFile(path.join(ROOT,'.reel/test-fixture/web/organization.json'),'utf8'));
assert.equal(org.projectID,'demo-reel','Integration smoke needs the synthetic demo-reel organization.');
const authPort=Number(process.env.REEL_SHARE_AUTH_PORT||9099),firestorePort=Number(process.env.REEL_SHARE_FIRESTORE_PORT||8080),storagePort=Number(process.env.REEL_SHARE_STORAGE_PORT||9199);
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
    const auth=getAuth(app); connectAuthEmulator(auth,`http://127.0.0.1:${authPort}`,{disableWarnings:true});
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
      width:640,height:360,processing:{phase:'completed', transcriptComplete:true, language:'en', engine:'test',
        text:'Synthetic caption', timingGranularity:'chunk', segments:[{start:0,end:2,text:'Synthetic caption'}], meeting:{attendees:['private-attendee@northwind.example']}}}]}));
  const store=createLocalRecordingStore({root:storeRoot});
const port=Number(process.env.REEL_SHARE_PORT||5052), origin=`http://127.0.0.1:${port}`;
const cfg={...org,storageOrigin:`http://127.0.0.1:${storagePort}`,firestoreOrigin:`http://127.0.0.1:${firestorePort}`,viewerBase:origin};
  const copied=[];
  const shareAuth={getProfile:()=>({userID:ownerID,email:ownerApp.user.email,displayName:'Synthetic meeting owner'}),getIdToken:()=>ownerApp.user.getIdToken()};
  const share=createMeetingShare({auth:shareAuth,
    store,org,cfg,copy:url=>copied.push(url)});
  const protectedPassword='birdhouse123'; // Windows shares now require at least 12 characters.
  const result=await share.share({ownerUserID:ownerID,id,includeTranscript:true,password:protectedPassword,expiry:'week'});
  assert.equal(result.uploaded,true); assert.equal(copied[0],result.url);
  const local=await store.getShareRecord({ownerUserID:ownerID,id});
  const shareID=local.share.shareID;
  const key=local.share.access.key, salt=local.share.access.passwordSalt;
  assert.equal(await C.deriveKey(protectedPassword,salt),key);
  assert.ok(!JSON.stringify(local.share).includes(protectedPassword),'The local share binding must contain only the derived access proof.');
  assert.ok(!(await readFile(path.join(recordingPath,'library.json'),'utf8')).includes(protectedPassword),
    'The local recording store must never persist the plaintext password.');
  assert.equal(shareID,await C.ownerShareID(ownerID,local.share.recordingNonce));
  const publicMetaResponse=await fetch(C.downloadURL(shareID,C.File.meta,null,cfg));
  assert.equal(publicMetaResponse.ok,true);
  const publicStub=await publicMetaResponse.json();
  assert.equal(publicStub.locked,true); assert.equal(publicStub.kdf.salt,salt);
  assert.equal(Object.hasOwn(publicStub,'title'),false); assert.equal(Object.hasOwn(publicStub,'playback'),false);
  assert.ok(publicStub.expiresAt);
  assert.equal((await fetch(C.downloadURL(shareID,C.File.video,null,cfg))).ok,false,'The public video location must reject a protected share.');
  assert.equal((await fetch(C.downloadURL(shareID,C.File.meta,null,cfg))).ok,true);
  const privateMetaResponse=await fetch(C.downloadURL(shareID,C.File.meta,key,cfg));
  assert.equal(privateMetaResponse.ok,true);
  const privateMeta=await privateMetaResponse.json(); assert.equal(privateMeta.title,'Synthetic local meeting');
  assert.equal(privateMeta.locked,true);
  const transcriptResponse = await fetch(C.downloadURL(shareID, C.File.transcriptJSON, key, cfg));
  assert.equal(transcriptResponse.ok,true);
  const transcript = await transcriptResponse.json();
  assert.equal(transcript.id,shareID);
  assert.equal(transcript.text,'Synthetic caption');
  assert.ok(!JSON.stringify(transcript).includes('private-attendee'));
  const ownerCloud=new FirestoreClient(ownerApp.session,cfg), otherCloud=new FirestoreClient(otherApp.session,cfg);
  const roomID=C.room(shareID,key);
  assert.equal(await ownerCloud.ownsRoom(roomID),true);
  assert.equal(await otherCloud.ownsRoom(roomID),false);
  const libraryURL=`http://127.0.0.1:${firestorePort}/v1/projects/demo-reel/databases/reel/documents/users/${encodeURIComponent(ownerID)}/recordings/${shareID}`;
  const ownerDoc=await fetch(libraryURL,{headers:{Authorization:`Bearer ${await ownerApp.user.getIdToken()}`}});
  assert.equal(ownerDoc.ok,true);
  const otherDoc=await fetch(libraryURL,{headers:{Authorization:`Bearer ${await otherApp.user.getIdToken()}`}});
  assert.equal(otherDoc.status,403,'The private library entry must reject other owners.');
  const mediaURL=C.downloadURL(shareID,C.File.video,key,cfg);
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
      let bytes=await readFile(filename);
      if(pathname==='/reel/firebase.js'&&(authPort!==9099||firestorePort!==8080||storagePort!==9199)) {
        bytes=Buffer.from(bytes.toString().replaceAll('http://127.0.0.1:9099',`http://127.0.0.1:${authPort}`)
          .replaceAll('http://127.0.0.1:8080',`http://127.0.0.1:${firestorePort}`)
          .replaceAll('http://127.0.0.1:9199',`http://127.0.0.1:${storagePort}`));
      }
      res.writeHead(200,{'Content-Type':contentTypes[path.extname(pathname)]||'application/octet-stream'});res.end(bytes);
    } catch { res.writeHead(404);res.end('not found'); }
  }).listen(port,'127.0.0.1');
  const pageURL=`${origin}/v/${shareID}?emulator=1`;
  assert.equal(result.url,`${origin}/v/${shareID}`,'The returned share link must match the local viewer origin.');
  browser=await chromium.launch({channel:process.env.REEL_BROWSER||'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
  const context=await browser.newContext();
  const localOrigins=new Set([origin,`http://127.0.0.1:${storagePort}`,`http://127.0.0.1:${firestorePort}`,`http://127.0.0.1:${authPort}`]);
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
  await page.locator('#gate').waitFor({state:'visible',timeout:10000});
  await page.locator('#gate-password').fill('wrong-password'); await page.locator('#gate-submit').click();
  await page.locator('#gate-error').getByText('Wrong password').waitFor();
  assert.equal(await page.locator('#player').isVisible(),false,'A wrong password must not reveal playback.');
  await page.locator('#gate-password').fill(protectedPassword); await page.locator('#gate-submit').click();
  const played=await page.waitForFunction(async()=>{
    const video=document.querySelector('#player');
    if(!video||video.hidden) return false;
    video.muted=true; await video.play().catch(()=>{});
    return video.readyState>=2&&video.currentTime>0.5;
  }, undefined, {timeout:25000});
  assert.ok(played,'The generated Windows meeting share should play in the existing viewer.');
  await page.locator('#download').waitFor({state:'visible',timeout:5000});
  await page.locator('#tab-transcript').click();
  await page.locator('#segments').getByText('Synthetic caption').first().waitFor();

  // Change access on the already-published URL. The former key is expired before
  // a replacement is written; an interrupted migration remains safely retryable.
  const replacementPassword='meeting-access-456';
  let failOnOldRevocation=1,oldRevocationCalls=0;
  const failingOldShare=createMeetingShare({auth:shareAuth,store,org,cfg,
    storageFactory:(session,cloudCfg,nonce)=>{
      const client=new StorageClient(session,cloudCfg,nonce);
      return new Proxy(client,{get(target,keyName){
        if(keyName==='setExpiry') return async(...args)=>{oldRevocationCalls++;if(oldRevocationCalls===failOnOldRevocation)throw Error('injected old-key expiry failure');return target.setExpiry(...args);};
        const value=target[keyName];return typeof value==='function'?value.bind(target):value;
      }});
    },firestoreFactory:(session,cloudCfg)=>new FirestoreClient(session,cloudCfg)});
  await assert.rejects(failingOldShare.updateAccess({ownerUserID:ownerID,id,password:replacementPassword}),/injected old-key expiry failure/);
  assert.equal((await fetch(C.downloadURL(shareID,C.File.video,key,cfg))).ok,true,
    'If the first old-key revocation fails, the previous keyed video remains readable.');
  const interimOldStub=await (await fetch(C.downloadURL(shareID,C.File.meta,null,cfg))).json();
  assert.equal(interimOldStub.locked,true);assert.equal(interimOldStub.kdf.salt,salt,
    'A failed password update retains only the previously published password claim.');
  failOnOldRevocation=2;oldRevocationCalls=0;
  await assert.rejects(failingOldShare.updateAccess({ownerUserID:ownerID,id}),/injected old-key expiry failure/);
  assert.equal((await fetch(C.downloadURL(shareID,C.File.video,key,cfg))).ok,false,
    'A mid-revocation failure leaves the already-expired old video denied.');
  assert.equal((await fetch(C.downloadURL(shareID,C.File.transcriptJSON,key,cfg))).ok,true,
    'A mid-revocation failure can leave a later old-key transcript readable.');
  failOnOldRevocation=0;oldRevocationCalls=0;
  const changed=await failingOldShare.updateAccess({ownerUserID:ownerID,id});
  assert.equal(changed.url,result.url,'Access updates preserve the published viewer URL.');
  let afterChange=await store.getShareRecord({ownerUserID:ownerID,id});
  let replacementKey=afterChange.share.access.key;const replacementSalt=afterChange.share.access.passwordSalt;
  assert.equal(await C.deriveKey(replacementPassword,replacementSalt),replacementKey);
  assert.equal((await fetch(C.downloadURL(shareID,C.File.video,key,cfg))).ok,false,'The prior password location must be revoked.');
  assert.equal((await fetch(C.downloadURL(shareID,C.File.video,replacementKey,cfg))).ok,true,'The replacement password location must play.');
  assert.equal(await ownerCloud.ownsRoom(C.room(shareID,key)),false,'The prior comments room must be retired.');
  assert.equal(await ownerCloud.ownsRoom(C.room(shareID,replacementKey)),true);

  const ownerDB=getFirestore(ownerApp.app,'reel');connectFirestoreEmulator(ownerDB,'127.0.0.1',firestorePort);
  // Persist a pending derived key, fail before uploading new media, and retry from a
  // freshly opened local store to exercise restart recovery without plaintext passwords.
  let injectFailure=true;
  const failingShare=createMeetingShare({auth:shareAuth,store,org,cfg,
    storageFactory:(session,cloudCfg,nonce)=>{
      const client=new StorageClient(session,cloudCfg,nonce);
      return new Proxy(client,{get(target,keyName){
        if(keyName==='uploadLarge') return async(...args)=>{if(injectFailure){injectFailure=false;throw Error('injected access update failure');}return target.uploadLarge(...args);};
        const value=target[keyName];return typeof value==='function'?value.bind(target):value;
      }});
    },firestoreFactory:(session,cloudCfg)=>new FirestoreClient(session,cloudCfg)});
  await assert.rejects(failingShare.updateAccess({ownerUserID:ownerID,id,password:'meeting-access-789',expiry:'day'}),/injected access update failure/);
  const pending=await store.getShareRecord({ownerUserID:ownerID,id});
  assert.ok(pending.share.accessUpdate);assert.equal(pending.share.access.key,replacementKey);
  const pendingKey=pending.share.accessUpdate.to.key;
  assert.equal((await fetch(C.downloadURL(shareID,C.File.video,null,cfg))).ok,false,'A pending protected update must not expose open media.');
  assert.equal((await fetch(C.downloadURL(shareID,C.File.video,replacementKey,cfg))).ok,false,'The old protected media is revoked during the pending update.');
  await assert.rejects(share.share({ownerUserID:ownerID,id}),/link settings update is pending/i,
    'The ordinary share action cannot republish using stale access during retry.');
  const restartedStore=createLocalRecordingStore({root:storeRoot});
  const restartedShare=createMeetingShare({auth:shareAuth,store:restartedStore,org,cfg,
    storageFactory:(session,cloudCfg,nonce)=>new StorageClient(session,cloudCfg,nonce),
    firestoreFactory:(session,cloudCfg)=>new FirestoreClient(session,cloudCfg)});
  const retried=await restartedShare.updateAccess({ownerUserID:ownerID,id});
  assert.equal(retried.url,result.url);
  afterChange=await restartedStore.getShareRecord({ownerUserID:ownerID,id});
  assert.equal(afterChange.share.access.key,pendingKey,'Restart retry must finish with the persisted candidate key.');
  assert.equal((await fetch(C.downloadURL(shareID,C.File.video,pendingKey,cfg))).ok,true);
  assert.equal((await fetch(C.downloadURL(shareID,C.File.video,replacementKey,cfg))).ok,false);

  const comments=collection(ownerDB,'videos',C.room(shareID,pendingKey),'comments');
  const reactions=collection(ownerDB,'videos',C.room(shareID,pendingKey),'reactions');
  await addDoc(comments,{text:'First migration comment',t:1,uid:ownerID,name:'Synthetic owner',photoURL:null,createdAt:serverTimestamp()});
  await addDoc(comments,{text:'Second migration comment',t:2,uid:ownerID,name:'Synthetic owner',photoURL:null,createdAt:serverTimestamp()});
  await addDoc(reactions,{emoji:'👍',t:1,createdAt:serverTimestamp()});
  // Simulate a transport error after Firestore accepted the first copied item.
  // A retry must keep that stable document ID and continue without duplicates.
  const nativeFetch=globalThis.fetch;let threwAfterCopy=false;
  globalThis.fetch=async(input,init)=>{
    const response=await nativeFetch(input,init),url=String(input?.url??input);
    if(!threwAfterCopy&&init?.method==='PATCH'&&/\/videos\/[^/]+\/(comments|reactions)\/[^/]+$/.test(url)&&response.ok) {
      threwAfterCopy=true;throw Error('injected error after partial Firestore copy');
    }
    return response;
  };
  try {
    await assert.rejects(restartedShare.updateAccess({ownerUserID:ownerID,id,password:'meeting-access-999'}),/injected error after partial Firestore copy/);
  } finally { globalThis.fetch=nativeFetch; }
  assert.ok(threwAfterCopy,'The failure must happen after a destination document was created.');
  let partialMigration=await restartedStore.getShareRecord({ownerUserID:ownerID,id});
  assert.ok(partialMigration.share.accessUpdate);
  const partialRoom=C.room(shareID,partialMigration.share.accessUpdate.to.key);
  assert.equal((await getDocs(collection(ownerDB,'videos',partialRoom,'reactions'))).size,1,
    'The injected failure leaves one copied reaction in the destination.');
  assert.equal(await ownerCloud.ownsRoom(C.room(shareID,pendingKey)),true,'The source room remains for retry.');
  await restartedShare.updateAccess({ownerUserID:ownerID,id});
  partialMigration=await restartedStore.getShareRecord({ownerUserID:ownerID,id});
  const migratedRoom=C.room(shareID,partialMigration.share.access.key);
  assert.equal((await getDocs(collection(ownerDB,'videos',migratedRoom,'reactions'))).size,1,
    'Retry reuses the copied reaction document rather than duplicating it.');
  assert.equal((await getDocs(collection(ownerDB,'videos',migratedRoom,'comments'))).size,2,
    'Retry copies the remaining comments exactly once.');
  assert.equal(await ownerCloud.ownsRoom(C.room(shareID,pendingKey)),false);

  let migrationKey=partialMigration.share.access.key;
  const sourceRoom=C.room(shareID,migrationKey);let sourceGets=0,sourceFailureInjected=false;
  globalThis.fetch=async(input,init)=>{
    const url=String(input?.url??input);
    if(init?.method==='GET'&&url.endsWith(`/videos/${sourceRoom}`)&&++sourceGets===2) {
      sourceFailureInjected=true;return new Response('transient source room failure',{status:503});
    }
    return nativeFetch(input,init);
  };
  try {
    await assert.rejects(restartedShare.updateAccess({ownerUserID:ownerID,id,password:'meeting-access-000'}),/source comments room \(HTTP 503\)/);
  } finally { globalThis.fetch=nativeFetch; }
  assert.ok(sourceFailureInjected,'The injected source-room failure must reach the migration read after ownership preflight.');
  let sourceRetry=await restartedStore.getShareRecord({ownerUserID:ownerID,id});
  assert.ok(sourceRetry.share.accessUpdate,'A transient source-room read error keeps the access journal pending.');
  assert.equal(await ownerCloud.ownsRoom(sourceRoom),true,'The source room remains owned and available for retry.');
  assert.equal((await getDocs(collection(ownerDB,'videos',sourceRoom,'comments'))).size,2,'Source discussion survives the transient read error.');
  assert.equal((await getDocs(collection(ownerDB,'videos',sourceRoom,'reactions'))).size,1);
  await restartedShare.updateAccess({ownerUserID:ownerID,id});
  sourceRetry=await restartedStore.getShareRecord({ownerUserID:ownerID,id});migrationKey=sourceRetry.share.access.key;
  let retryRoom=C.room(shareID,migrationKey);
  assert.equal((await getDocs(collection(ownerDB,'videos',retryRoom,'comments'))).size,2,'Retry moves comments after the source read recovers.');
  assert.equal((await getDocs(collection(ownerDB,'videos',retryRoom,'reactions'))).size,1);
  assert.equal(await ownerCloud.ownsRoom(sourceRoom),false);

  const deleteSourceRoom=retryRoom;let deleteFailureInjected=false;
  globalThis.fetch=async(input,init)=>{
    const url=String(input?.url??input);
    if(!deleteFailureInjected&&init?.method==='DELETE'&&url.includes(`/videos/${deleteSourceRoom}/reactions/`)) {
      deleteFailureInjected=true;return new Response('injected child delete failure',{status:500});
    }
    return nativeFetch(input,init);
  };
  try {
    await assert.rejects(restartedShare.updateAccess({ownerUserID:ownerID,id,password:'meeting-access-111'}),/remove migrated reactions \(HTTP 500\)/);
  } finally { globalThis.fetch=nativeFetch; }
  assert.ok(deleteFailureInjected,'The child document delete must be exercised.');
  let deleteRetry=await restartedStore.getShareRecord({ownerUserID:ownerID,id});
  assert.ok(deleteRetry.share.accessUpdate,'A failed child delete keeps the journal pending.');
  assert.equal(await ownerCloud.ownsRoom(deleteSourceRoom),true,'The source room remains until child cleanup succeeds.');
  await restartedShare.updateAccess({ownerUserID:ownerID,id});
  deleteRetry=await restartedStore.getShareRecord({ownerUserID:ownerID,id});migrationKey=deleteRetry.share.access.key;
  retryRoom=C.room(shareID,migrationKey);
  assert.equal((await getDocs(collection(ownerDB,'videos',retryRoom,'comments'))).size,2,'Delete retry does not duplicate comments.');
  assert.equal((await getDocs(collection(ownerDB,'videos',retryRoom,'reactions'))).size,1,'Delete retry does not duplicate reactions.');
  assert.equal(await ownerCloud.ownsRoom(deleteSourceRoom),false,'Successful retry removes the source room only after all children are deleted.');

  const expiryUpdate=await restartedShare.updateAccess({ownerUserID:ownerID,id,expiry:'hour'});
  assert.equal(expiryUpdate.url,result.url);
  afterChange=await restartedStore.getShareRecord({ownerUserID:ownerID,id});
  assert.ok(Math.abs(Date.parse(afterChange.share.access.expiresAt)-Date.now()-3600_000)<10_000,'Expiry-only updates persist the requested hour window.');
  const updatedStub=await (await fetch(C.downloadURL(shareID,C.File.meta,null,cfg))).json();
  assert.equal(Date.parse(updatedStub.expiresAt),Date.parse(afterChange.share.access.expiresAt));

  const removed=await restartedShare.updateAccess({ownerUserID:ownerID,id,removePassword:true,expiry:'keep'});
  assert.equal(removed.url,result.url);
  const openShare=await restartedStore.getShareRecord({ownerUserID:ownerID,id});
  assert.equal(openShare.share.access.key,null);assert.equal(openShare.share.access.passwordSalt,null);
  assert.equal((await fetch(C.downloadURL(shareID,C.File.video,null,cfg))).ok,true,'Removing the password activates the staged public copy.');
  assert.equal((await fetch(C.downloadURL(shareID,C.File.video,migrationKey,cfg))).ok,false,'Removing the current password retires its keyed copy.');
  assert.equal((await fetch(C.downloadURL(shareID,C.File.video,pendingKey,cfg))).ok,false,'Removing a password retires its keyed copy.');
  const openMeta=await (await fetch(C.downloadURL(shareID,C.File.meta,null,cfg))).json();
  assert.equal(openMeta.locked,false,'The stable URL now opens without a password.');

  // Exercise the highest-risk public -> protected transition separately. A forced
  // failure occurs after public objects are revoked and the locked stub is installed,
  // but before protected media is uploaded.
  const openStoreRoot=path.join(temp,'open-recordings'),openOwnerPath=path.join(openStoreRoot,createHash('sha256').update(ownerID).digest('hex'));
  await mkdir(openOwnerPath,{recursive:true});
  const openID=createHash('sha256').update(`${id}:open`).digest('hex').slice(0,32),openVideo=path.join(openOwnerPath,`${openID}.mp4`);
  await writeFile(openVideo,await readFile(fixtureMP4));
  await writeFile(path.join(openOwnerPath,'library.json'),JSON.stringify({version:1,ownerUserID:ownerID,
    settings:{ownerUserID:ownerID,autoJoin:false,participantConsent:false,systemAudioConsent:false,meetingReminders:false,selection:{useAll:true,ids:[]}},
    completed:{},recordings:[{id:openID,title:'Synthetic open meeting',createdAt:'2026-11-26T10:00:00.000Z',durationSeconds:3,width:640,height:360,
      processing:{phase:'completed',meeting:{},transcriptComplete:true,text:'Open transcript test',language:'en',engine:'test',timingGranularity:'chunk',
        segments:[{start:0,end:2,text:'Open transcript test'}]}}]}));
  const openStore=createLocalRecordingStore({root:openStoreRoot});
  const openMeetingShare=createMeetingShare({auth:shareAuth,store:openStore,org,cfg,
    storageFactory:(session,cloudCfg,nonce)=>new StorageClient(session,cloudCfg,nonce),
    firestoreFactory:(session,cloudCfg)=>new FirestoreClient(session,cloudCfg)});
  const publicResult=await openMeetingShare.share({ownerUserID:ownerID,id:openID,includeTranscript:true,expiry:'week'});
  const publicBound=await openStore.getShareRecord({ownerUserID:ownerID,id:openID});
  const publicShareID=publicBound.share.shareID;
  assert.equal((await fetch(C.downloadURL(publicShareID,C.File.video,null,cfg))).ok,true,'The source meeting starts publicly readable.');
  assert.equal((await fetch(C.downloadURL(publicShareID,C.File.transcriptText,null,cfg))).ok,true,'The public source transcript starts readable.');
  let failOnRevocation=1,revocationCalls=0;
  const failingOpenShare=createMeetingShare({auth:shareAuth,store:openStore,org,cfg,
    storageFactory:(session,cloudCfg,nonce)=>{
      const client=new StorageClient(session,cloudCfg,nonce);
      return new Proxy(client,{get(target,keyName){
        if(keyName==='setExpiry') return async(...args)=>{revocationCalls++;if(revocationCalls===failOnRevocation)throw Error('injected public-to-protected expiry failure');return target.setExpiry(...args);};
        const value=target[keyName];return typeof value==='function'?value.bind(target):value;
      }});
    },firestoreFactory:(session,cloudCfg)=>new FirestoreClient(session,cloudCfg)});
  await assert.rejects(failingOpenShare.updateAccess({ownerUserID:ownerID,id:openID,password:'protect-this-meeting-123'}),/injected public-to-protected expiry failure/);
  const publicPending=await openStore.getShareRecord({ownerUserID:ownerID,id:openID});
  assert.ok(publicPending.share.accessUpdate);
  const interimStub=await (await fetch(C.downloadURL(publicShareID,C.File.meta,null,cfg))).json();
  assert.equal(interimStub.locked,false,'A failed revocation must not publish a locked stub for the new password.');
  assert.equal(interimStub.title,'Synthetic open meeting');
  assert.equal((await fetch(C.downloadURL(publicShareID,C.File.video,null,cfg))).ok,true,
    'If the first object revocation fails, the old public video remains directly readable.');
  assert.equal((await fetch(C.downloadURL(publicShareID,C.File.transcriptText,null,cfg))).ok,true,
    'The old public transcript remains directly readable after first-object failure.');
  failOnRevocation=2;revocationCalls=0;
  await assert.rejects(failingOpenShare.updateAccess({ownerUserID:ownerID,id:openID}),/injected public-to-protected expiry failure/);
  assert.equal((await fetch(C.downloadURL(publicShareID,C.File.video,null,cfg))).ok,false,
    'A mid-revocation failure leaves the already-expired video denied.');
  assert.equal((await fetch(C.downloadURL(publicShareID,C.File.transcriptText,null,cfg))).ok,true,
    'A mid-revocation failure can leave a later public transcript object readable.');
  const midRevocationMeta=await (await fetch(C.downloadURL(publicShareID,C.File.meta,null,cfg))).json();
  assert.equal(midRevocationMeta.locked,false,'The link must not claim password protection while any old direct object remains readable.');
  failOnRevocation=0;revocationCalls=0;
  const openRetryStore=createLocalRecordingStore({root:openStoreRoot});
  const openRetry=createMeetingShare({auth:shareAuth,store:openRetryStore,org,cfg,
    storageFactory:(session,cloudCfg,nonce)=>new StorageClient(session,cloudCfg,nonce),
    firestoreFactory:(session,cloudCfg)=>new FirestoreClient(session,cloudCfg)});
  const publicRetry=await openRetry.updateAccess({ownerUserID:ownerID,id:openID});
  assert.equal(publicRetry.url,publicResult.url,'Public-to-protected retry preserves the published URL.');
  const protectedPublicRecord=await openRetryStore.getShareRecord({ownerUserID:ownerID,id:openID});
  const protectedPublicKey=protectedPublicRecord.share.access.key;
  assert.equal((await fetch(C.downloadURL(publicShareID,C.File.video,null,cfg))).ok,false,'The old open media path stays denied after migration.');
  assert.equal((await fetch(C.downloadURL(publicShareID,C.File.video,protectedPublicKey,cfg))).ok,true);
  const protectedStub=await (await fetch(C.downloadURL(publicShareID,C.File.meta,null,cfg))).json();
  assert.equal(protectedStub.locked,true);assert.equal(protectedStub.kdf.salt,protectedPublicRecord.share.access.passwordSalt,
    'The locked stub is published only after every old public object has been revoked.');
  console.log(JSON.stringify({result:'PASS',ownerBoundRoom:true,otherOwnerDenied:true,privateLibraryDenied:true,
    passwordDeniedThenAccepted:true,publicMetadataStubOnly:true,publicMediaDenied:true,expiryPublished:true,
    accessPasswordChanged:true,oldAccessRevoked:true,oldKeyAccessCanPersistDuringFailedRevocation:true,expiryUpdated:true,passwordRemoved:true,failureRetrySurvivesRestart:true,
    partialFirestoreMigrationRetryIsIdempotent:true,sourceReadFailureStaysPending:true,childDeleteFailureStaysPending:true,
    publicToProtected:true,publicAccessRemainsPossibleDuringFailedRevocation:true,videoStreams:probe.streams,viewerPlayed:true,transcriptVisible:true,shareURL:result.url}));
  await context.close();
} finally {
  await browser?.close().catch(()=>{});
  await new Promise(resolve=>server?.close(resolve) ?? resolve());
  if(ownerApp) await deleteApp(ownerApp.app).catch(()=>{});
  if(otherApp) await deleteApp(otherApp.app).catch(()=>{});
  await rm(temp,{recursive:true,force:true});
}

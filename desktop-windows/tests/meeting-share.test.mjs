import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as C from '../../web/reel/core.js';
import { createMeetingShare } from '../src/meeting-share.mjs';

const org = { projectID:'demo-reel', bucket:'demo-reel.firebasestorage.app', apiKey:'test-key',
  viewerBase:'https://record.example', viewerPath:'v', allowedEmailDomain:'example.com', firestoreDatabase:'reel' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, { ensureRoom = async () => {}, uploadLarge = async () => {}, upload = async () => {}, upsert = async () => {} } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'reel-meeting-share-'));
  t.after(() => rm(dir, { recursive:true, force:true }));
  const file = path.join(dir, 'meeting.mp4'); await writeFile(file, Buffer.from('synthetic video bytes'));
  let profile = { userID:'owner-a', email:'owner@example.com', displayName:'Meeting Owner' };
  const statuses = [], copies = [], calls = [];
  let share = null;
  const tails = new Map();
  async function withRecordingLock({ownerUserID,id}, operation) {
    const key=JSON.stringify([ownerUserID,id]), previous=tails.get(key)??Promise.resolve();
    let release; const gate=new Promise(resolve=>{release=resolve;}); const tail=previous.catch(()=>{}).then(()=>gate); tails.set(key,tail);
    try { await previous.catch(()=>{}); return await operation(); }
    finally { release(); if(tails.get(key)===tail) tails.delete(key); }
  }
  const store = {
    withRecordingLock,
    getShareRecord: ({ownerUserID,id}) => ownerUserID === 'owner-a' && id === 'a'.repeat(32)
      ? { id, title:'Weekly meeting', createdAt:'2026-11-06T12:00:00.000Z', durationSeconds:9, width:640, height:360, path:file, meeting:true, share:share && structuredClone(share) } : null,
    getProcessing: () => ({ transcriptComplete:true, language:'en', engine:'test', text:'Ready to share',
      segments:[{start:0,end:3,text:'Ready to share',privateField:'private'}], attendees:['private@example.com'] }),
    async bindShare(value) {
      calls.push(['bind', value]);
      if (!share) share = { ownerUserID:value.ownerUserID, recordingNonce:value.recordingNonce, shareID:value.shareID, includeTranscript:value.includeTranscript, access:value.access, upload:'pending' };
      return structuredClone(share);
    },
    async saveShareState(value) { statuses.push(value.upload); share.upload = structuredClone(value.upload); },
  };
  const auth = { getProfile:() => profile, getIdToken:async()=>{ if (!profile) throw Error('signed out'); return 'synthetic-token'; } };
  const shareAPI = createMeetingShare({ auth, store, org, copy:value=>copies.push(value),
    storageFactory:(session,cfg,nonce) => ({
      async uploadLarge(id,file,blob,options) { calls.push(['video',id,file,blob.size,options,nonce]); await uploadLarge({session,blob,options}); },
      async upload(id,file,data,options) { calls.push(['meta',id,file,data,nonce,options]); await upload({session,data,options}); },
    }),
    firestoreFactory:session => ({
      async ensureRoom(...args) { calls.push(['room',...args]); await ensureRoom({session}); },
      async upsertLibraryEntry(record) { calls.push(['library',record]); await upsert({session,record}); },
    }) });
  return { shareAPI, store, auth, calls, statuses, copies, setProfile:value=>{profile=value;} };
}

test('explicit share binds to the current owner, uploads playable MP4 metadata and copies the view link', async t => {
  const f = await fixture(t);
  const share = await f.shareAPI.share({ ownerUserID:'owner-a', id:'a'.repeat(32) });
  const room = f.calls.find(call => call[0] === 'room');
  const uploaded = f.calls.find(call => call[0] === 'video');
  const metadata = f.calls.find(call => call[0] === 'meta');
  assert.equal(room[1], await C.ownerShareID('owner-a', room[5]));
  assert.equal(room[5].length, 32);
  assert.equal(uploaded[1], room[1]); assert.equal(uploaded[2], 'video.mp4'); assert.equal(uploaded[3], 21);
  assert.equal(metadata[1], room[1]); assert.equal(metadata[2], 'meta.json');
  const remote = JSON.parse(metadata[3]);
  assert.equal(remote.status, 'ready'); assert.deepEqual(remote.playback,{hls:false,mp4:true});
  assert.equal(remote.transcriptStatus,'none');
  assert.deepEqual(f.calls.filter(c=>c[0]==='meta').map(c=>c[2]),['meta.json']);
  assert.equal(remote.width,640); assert.equal(remote.height,360); assert.equal(remote.ownerName,'Meeting Owner');
  assert.equal(f.calls.at(-1)[0], 'library');
  assert.equal(share.url, `https://record.example/v/${room[1]}`); assert.deepEqual(f.copies,[share.url]);
  assert.equal(f.statuses.at(-1),'uploaded');
  const reused = await f.shareAPI.share({ ownerUserID:'owner-a', id:'a'.repeat(32) });
  assert.deepEqual(reused,share); assert.equal(f.calls.filter(call=>call[0]==='video').length,1);
  assert.deepEqual(f.copies,[share.url,share.url]);
});

test('account change after room creation prevents further upload and link copying', async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, { ensureRoom:async({session})=>{ session.assertCurrent(); entered.resolve(); await release.promise; } });
  const pending = f.shareAPI.share({ ownerUserID:'owner-a', id:'a'.repeat(32) });
  await entered.promise; f.setProfile({userID:'owner-b',email:'other@example.com'}); release.resolve();
  await assert.rejects(pending,/meeting owner/i);
  assert.equal(f.calls.some(call=>call[0]==='video'),false); assert.deepEqual(f.copies,[]);
});

test('failed share retries reuse its first owner binding', async t => {
  let attempts=0;
  const f = await fixture(t, { uploadLarge:async()=>{ if(!attempts++) throw Error('temporary upload failure'); } });
  await assert.rejects(f.shareAPI.share({ownerUserID:'owner-a',id:'a'.repeat(32)}),/temporary upload failure/);
  const first = f.calls.find(call=>call[0]==='room');
  const restarted=createMeetingShare({auth:f.auth,store:f.store,org,copy:value=>f.copies.push(value),
    storageFactory:(session,_cfg,nonce)=>({uploadLarge:async()=>{f.calls.push(['retry-video',nonce]);},upload:async()=>{}}),
    firestoreFactory:()=>({ensureRoom:async(...args)=>{f.calls.push(['retry-room',...args]);},upsertLibraryEntry:async()=>{}})});
  const completed = await restarted.share({ownerUserID:'owner-a',id:'a'.repeat(32)});
  const roomCalls=f.calls.filter(call=>call[0]==='room'||call[0]==='retry-room');
  assert.equal(roomCalls.length,2); assert.equal(roomCalls[0][5],roomCalls[1][5]);
  assert.equal(roomCalls[0][1],roomCalls[1][1]); assert.ok(completed.uploaded);
  assert.deepEqual(f.calls.find(call=>call[0]==='retry-video')[1],roomCalls[0][5]);
  assert.equal(f.calls.filter(call=>call[0]==='bind').length,1);
  assert.ok(first);
});

test('same recording requests share one in-flight publication', async t => {
  const gate=deferred(), entered=deferred();
  const f=await fixture(t,{uploadLarge:async()=>{entered.resolve();await gate.promise;}});
  const a=f.shareAPI.share({ownerUserID:'owner-a',id:'a'.repeat(32)}), b=f.shareAPI.share({ownerUserID:'owner-a',id:'a'.repeat(32)});
  await entered.promise; gate.resolve();
  assert.strictEqual(await a,await b); assert.equal(f.calls.filter(call=>call[0]==='video').length,1);
});

test('local deletion waits for in-flight share publication and cannot interrupt its local source', async t => {
  const entered=deferred(), release=deferred(), f=await fixture(t,{uploadLarge:async()=>{entered.resolve();await release.promise;}});
  const args={ownerUserID:'owner-a',id:'a'.repeat(32)};
  const sharing=f.shareAPI.share(args); await entered.promise;
  let deleted=false;
  const deletion=f.store.withRecordingLock(args,async()=>{deleted=true;});
  await new Promise(resolve=>setImmediate(resolve)); assert.equal(deleted,false);
  release.resolve(); await sharing; await deletion; assert.equal(deleted,true);
});

test('transcript choice persists across retry and publishes only viewer fields', async t => {
  let first = true;
  const f = await fixture(t,{uploadLarge:async()=>{ if (first) { first=false; throw Error('interrupted'); } }});
  const args={ownerUserID:'owner-a',id:'a'.repeat(32)};
  await assert.rejects(f.shareAPI.share({...args,includeTranscript:true}),/interrupted/);
  await f.shareAPI.share(args);
  const uploads=f.calls.filter(c=>c[0]==='meta');
  assert.deepEqual(uploads.map(c=>c[2]),['transcript.json','transcript.txt','meta.json']);
  const transcript=JSON.parse(uploads[0][3]);
  assert.equal(transcript.id,uploads[0][1]);
  assert.deepEqual(transcript.segments,[{start:0,end:3,text:'Ready to share'}]);
  assert.ok(!Object.hasOwn(transcript,'attendees'));
  assert.match(uploads[1][3],/\[0:00\] Ready to share/);
  assert.equal(JSON.parse(uploads[2][3]).transcriptStatus,'ready');
});

test('password and expiry protect the final media location and keep public metadata to the viewer stub', async t => {
  const now = new Date('2026-11-26T12:00:00.000Z');
  const f = await fixture(t);
  const protectedShare = createMeetingShare({ auth:f.auth, store:f.store, org, now:()=>new Date(now),
    copy:value=>f.copies.push(value),
    storageFactory:(session,cfg,nonce) => ({
      async uploadLarge(id,file,blob,options) { f.calls.push(['video',id,file,blob.size,options,nonce]); },
      async upload(id,file,data,options) { f.calls.push(['meta',id,file,data,nonce,options]); },
    }),
    firestoreFactory:()=>({
      async ensureRoom(...args) { f.calls.push(['room',...args]); }, async upsertLibraryEntry(record) { f.calls.push(['library',record]); },
    }) });
  await protectedShare.share({ownerUserID:'owner-a',id:'a'.repeat(32),password:'birdhouse123',expiry:'day'});
  const binding = f.calls.find(call=>call[0]==='bind')[1];
  assert.equal(binding.access.key.length,32); assert.equal(binding.access.passwordSalt.length,32);
  assert.ok(!JSON.stringify(binding).includes('birdhouse123'));
  const saved = await f.store.getShareRecord({ownerUserID:'owner-a',id:'a'.repeat(32)});
  const key = saved.share.access.key, salt = saved.share.access.passwordSalt;
  assert.equal(await C.deriveKey('birdhouse123',salt),key);
  const expiresAt = new Date(now.getTime()+86400_000);
  const room = f.calls.find(call=>call[0]==='room'); assert.equal(room[3].toISOString(),expiresAt.toISOString());
  const video = f.calls.find(call=>call[0]==='video');
  assert.equal(video[4].key,key); assert.equal(video[4].options.expiresAt.toISOString(),expiresAt.toISOString());
  const metadata = f.calls.filter(call=>call[0]==='meta');
  assert.deepEqual(metadata.map(call=>call[2]),['meta.json','meta.json','meta.json']);
  const stub = JSON.parse(metadata[0][3]);
  assert.equal(stub.locked,true); assert.equal(stub.kdf.salt,salt);
  assert.equal(stub.expiresAt,expiresAt.toISOString().replace('.000Z','Z'));
  assert.equal(Object.hasOwn(stub,'title'),false); assert.equal(Object.hasOwn(stub,'playback'),false);
  assert.equal(metadata[0][5].key,null);
  const remote = JSON.parse(metadata[1][3]);
  assert.equal(remote.title,'Weekly meeting'); assert.equal(remote.locked,true); assert.equal(metadata[1][5].key,key);
  const readyStub = JSON.parse(metadata[2][3]); assert.equal(readyStub.status,'ready');
  assert.equal(Object.hasOwn(readyStub,'title'),false); assert.equal(metadata[2][5].key,null);
  assert.ok(!f.calls.some(call=>call[0]==='video' && call[4].key===null));
});

test('Windows protected shares reject passwords shorter than 12 characters before binding', async t => {
  const f = await fixture(t);
  const protectedShare = createMeetingShare({ auth:f.auth, store:f.store, org,
    storageFactory:()=>({uploadLarge:async()=>{},upload:async()=>{}}),
    firestoreFactory:()=>({ensureRoom:async()=>{},upsertLibraryEntry:async()=>{}}) });
  await assert.rejects(protectedShare.share({ownerUserID:'owner-a',id:'a'.repeat(32),password:'elevenchars',expiry:'day'}),
    /at least 12 characters/i);
  assert.equal(f.calls.some(call=>call[0]==='bind'),false);
  assert.equal(f.calls.some(call=>call[0]==='video'||call[0]==='meta'||call[0]==='room'),false);
});

test('expired bound shares cannot resume uploads or copy their link', async t => {
  let clock = new Date('2026-11-26T12:00:00.000Z');
  let failures = 0;
  const f = await fixture(t);
  const shareAPI = createMeetingShare({auth:f.auth,store:f.store,org,now:()=>new Date(clock),copy:value=>f.copies.push(value),
    storageFactory:()=>({uploadLarge:async()=>{if(!failures++) throw Error('interrupted');f.calls.push(['retry-video']);},upload:async()=>{}}),
    firestoreFactory:()=>({ensureRoom:async(...args)=>{f.calls.push(['room',...args]);},upsertLibraryEntry:async()=>{}})});
  await assert.rejects(shareAPI.share({ownerUserID:'owner-a',id:'a'.repeat(32),password:'birdhouse123',expiry:'hour'}),/interrupted/);
  const before = f.calls.length;
  clock = new Date('2026-11-26T13:00:01.000Z');
  await assert.rejects(shareAPI.share({ownerUserID:'owner-a',id:'a'.repeat(32)}),/expired/i);
  assert.equal(f.calls.slice(before).some(call=>call[0]==='retry-video'),false);
  assert.deepEqual(f.copies,[]);
});

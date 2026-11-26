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
  const store = {
    getShareRecord: ({ownerUserID,id}) => ownerUserID === 'owner-a' && id === 'a'.repeat(32)
      ? { id, title:'Weekly meeting', createdAt:'2026-11-06T12:00:00.000Z', durationSeconds:9, width:640, height:360, path:file, meeting:true, share:share && structuredClone(share) } : null,
    async bindShare(value) {
      calls.push(['bind', value]);
      if (!share) share = { ownerUserID:value.ownerUserID, recordingNonce:value.recordingNonce, shareID:value.shareID, upload:'pending' };
      return structuredClone(share);
    },
    async saveShareState(value) { statuses.push(value.upload); share.upload = structuredClone(value.upload); },
  };
  const auth = { getProfile:() => profile, getIdToken:async()=>{ if (!profile) throw Error('signed out'); return 'synthetic-token'; } };
  const shareAPI = createMeetingShare({ auth, store, org, copy:value=>copies.push(value),
    storageFactory:(session,cfg,nonce) => ({
      async uploadLarge(id,file,blob,options) { calls.push(['video',id,file,blob.size,options,nonce]); await uploadLarge({session,blob}); },
      async upload(id,file,data) { calls.push(['meta',id,file,data,nonce]); await upload({session,data}); },
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

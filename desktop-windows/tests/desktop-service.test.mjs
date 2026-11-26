import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopService } from '../src/desktop-service.mjs';
import { createMeetingCoordinator } from '../src/meeting-coordinator.mjs';

const org = {meetingServiceURL:'https://meetings.northwind.example', viewerBase:'https://library.northwind.example', viewerPath:'reel', notesBaseURL:'https://library.northwind.example/reel', webBase:'https://record.northwind.example'};
const initial = ownerUserID => ({ ownerUserID, autoJoin: false, participantConsent: false,
  systemAudioConsent: false, selection: { useAll: true, ids: [] } });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture({ realCoordinator = false, discover, shareMeeting } = {}) {
  let profile = { userID: 'owner-a', email: 'a@northwind.example', calendarConnected: true };
  let coordinatorOptions, coordinator, status = { phase: 'idle' }, statusNotify;
  const settings = new Map(), calls = [], writes = [], snapshots = [], listeners = new Set();
  const notify = () => { for (const listener of listeners) listener(); };
  const auth = { getIdToken: async () => "fixture", getProfile: () => profile, onStateChange: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    signOut() { profile = null; notify(); }, disconnectCalendar() { profile = { ...profile, calendarConnected: false }; notify(); },
    signIn: async () => {}, cancelSignIn() {} };
  const store = { getSettings: id => settings.get(id) ?? initial(id), list: () => [], hasCompleted: () => false,
    markCompleted: async () => {}, saveSettings: async value => { writes.push(value); settings.set(value.ownerUserID, value); return value; } };
  const service = createDesktopService({org, auth, store, fetch:async () => Response.json({events:[]}),
    discover: discover ?? (async ({auth}) => ({ ownerUserID: auth.getProfile().userID, calendars: [{id:'cal',title:'Work'}], meetings: [
      { id:'one', title:'QA', start:'2026-11-06T15:00:00Z',end:'2026-11-06T16:00:00Z',platform:'google_meet',joinURL:'https://meet.google.com/aaa-bbbb-ccc',attendeeEmails:['private@example.com'] } ] })),
    createCoordinator(options) { coordinatorOptions = options; coordinator = realCoordinator ? createMeetingCoordinator({ ...options,
      native: { join: async () => { throw Error('Unexpected test join'); }, inspect: async () => {}, close: async () => {} },
      recorder: { start: async () => { throw Error('Unexpected test capture'); }, stop: async () => {} },
      now: () => new Date('2026-11-06T10:00:00Z') }) : {
      getState: () => status, onStateChange: fn => { statusNotify = fn; return () => {}; },
      refresh: async () => { calls.push('refresh'); }, tick: async () => { calls.push('tick'); },
      cancel: async () => { calls.push('cancel'); }, dispose: async () => { calls.push('dispose'); } }; return coordinator; },
    openExternal: async url => calls.push(url), openRecordings: async owner => calls.push(owner), shareMeeting,
    onState: value => snapshots.push(value) });
  return { service, auth, store, coordinator, settings, calls, writes, snapshots, coordinatorOptions: () => coordinatorOptions,
    changeOwner(value) { profile = value; notify(); }, status(value) { status = value; statusNotify(value); } };
}
test('calendar remains visible with auto-join off; renderer snapshot omits private transport data', async () => {
  const f = fixture(); await f.service.pulse();
  const state = f.service.state();
  assert.equal(state.meetings.length, 1); assert.equal(state.settings.autoJoin, false);
  assert.equal(JSON.stringify(state).includes('meet.google.com'), false);
  assert.equal(JSON.stringify(state).includes('private@example.com'), false);
  f.status({ phase:'capturing', ownerUserID:'owner-a', sessionId:'secret', hwnd:'123', reason:null });
  assert.deepEqual(Object.keys(f.service.state().status).sort(), ['message','phase']);
  await f.service.dispose();
});
test('rejects stale owner and unknown settings/action inputs', async () => {
  const f = fixture();
  await assert.rejects(f.service.action('saveSettings', { ...initial('owner-b'), expectedOwnerUserID:'owner-b' }), /account changed/i);
  await assert.rejects(f.service.action('execute', {url:'https://bad.example'}), /Unknown/);
  assert.equal(f.writes.length, 0);
  await assert.rejects(f.service.action('saveSettings', { ...initial('owner-a'), expectedOwnerUserID:'owner-a', url:'bad' }), /Invalid/);
  await f.service.dispose();
});
test('revocation cancels before a settings write completes; new owner defaults off', async () => {
  const f = fixture();
  const enabled = { ...initial('owner-a'), autoJoin:true, participantConsent:true, systemAudioConsent:true };
  f.settings.set('owner-a', enabled);
  await f.service.action('saveSettings', { ...enabled, participantConsent:false, expectedOwnerUserID:'owner-a' });
  assert.equal(f.calls[0], 'cancel'); assert.equal(f.service.state().settings.autoJoin, false);
  f.changeOwner({userID:'owner-b',email:'b@northwind.example',calendarConnected:true});
  assert.equal(f.service.state().settings.participantConsent, false);
  assert.equal(f.service.state().meetings.length, 0);
  await f.service.dispose();
});
test('an account change during discovery never displays the previous owner calendar', async () => {
  const gate=deferred();
  const f=fixture({discover:async({auth})=>{
    const id=auth.getProfile().userID;await gate.promise;
    return {ownerUserID:id,calendars:[{id:'old',title:'Old private calendar'}],meetings:[]};
  }});
  const pending=f.service.pulse();await settle();
  f.changeOwner({userID:'owner-b',email:'b@northwind.example',calendarConnected:true});
  assert.deepEqual(f.service.state().calendars, []);
  gate.resolve();await pending;
  assert.deepEqual(f.service.state().calendars, []);
  assert.equal(f.service.state().error,null);
  await f.service.dispose();
});
test('sign-out stops local capture and only fixed external destinations can be opened', async () => {
  const f = fixture();
  await f.service.action('openLibrary', {url:'https://bad.example'});
  assert.equal(f.calls[0], 'https://library.northwind.example/reel');
  await f.service.action('openRecorder');
  await f.service.action('openNotetaker', {url:'https://bad.example'});
  assert.deepEqual(f.calls.slice(1), ['https://record.northwind.example/record', 'https://record.northwind.example/notetaker']);
  await f.service.action('signOut');
  assert.equal(f.service.state().profile, null); assert.ok(f.calls.includes('cancel'));
  await assert.rejects(f.service.action('openRecordings'), /sign in/i);
  await f.service.dispose();
});

test('sharing is an explicit owner-bound action and never accepts a renderer URL', async () => {
  const shared=[];
  const f=fixture({shareMeeting:{share:async value=>{shared.push(value);return {uploaded:true};}}});
  await assert.rejects(f.service.action('shareRecording',{id:'recording',url:'https://evil.example',expectedOwnerUserID:'owner-b'}),/account changed/i);
  await assert.rejects(f.service.action('shareRecording',{id:'recording'}),/account changed/i);
  assert.deepEqual(shared,[]);
  await f.service.action('shareRecording',{id:'recording',url:'https://evil.example',expectedOwnerUserID:'owner-a'});
  assert.deepEqual(shared,[{ownerUserID:'owner-a',id:'recording'}]);
  f.changeOwner({userID:'owner-b',email:'b@northwind.example',calendarConnected:true});
  await assert.rejects(f.service.action('shareRecording',{id:'recording',expectedOwnerUserID:'owner-a'}),/account changed/i);
  assert.equal(shared.length,1);
  await f.service.dispose();
});

test('a delayed older enable cannot persist after a newer disable that matches the temporary cache', async () => {
  const f = fixture(), cancellation = deferred();
  const enabled = { ...initial('owner-a'), autoJoin:true, participantConsent:true, systemAudioConsent:true };
  f.settings.set('owner-a', enabled);
  f.coordinator.cancel = () => cancellation.promise;
  const next = { ...enabled, selection:{useAll:false,ids:['new']}, expectedOwnerUserID:'owner-a' };
  const older = f.service.action('saveSettings', next);
  const newer = f.service.action('saveSettings', { ...next, autoJoin:false });
  await settle(); assert.equal(f.writes.length, 0);
  cancellation.resolve(); await Promise.all([older, newer]);
  assert.deepEqual(f.writes.map(value => value.autoJoin), [true, false]);
  assert.equal(f.settings.get('owner-a').autoJoin, false);
  assert.equal(f.service.state().settings.autoJoin, false);
  await f.service.dispose();
});

test('shutdown waits for durable consent revocation and refuses new actions while saving', async () => {
  const f = fixture(), disk = deferred();
  const enabled = { ...initial('owner-a'), autoJoin:true, participantConsent:true, systemAudioConsent:true };
  f.settings.set('owner-a', enabled);
  const save = f.store.saveSettings;
  f.store.saveSettings = async value => { await disk.promise; return save(value); };
  const revocation = f.service.action('saveSettings', { ...enabled, autoJoin:false, participantConsent:false, expectedOwnerUserID:'owner-a' });
  await settle();
  let disposed = false;
  const closing = f.service.dispose().then(() => { disposed = true; });
  await settle();
  assert.equal(disposed, false);
  await assert.rejects(f.service.action('refresh'), /shutting down/);
  disk.resolve(); await Promise.all([revocation, closing]);
  assert.equal(f.settings.get('owner-a').participantConsent, false);
  assert.equal(disposed, true);
});

test('an account change never emits the previous owner calendar through a coordinator auth callback', async () => {
  const f = fixture({ realCoordinator:true });
  await f.service.pulse();
  assert.equal(f.service.state().meetings.length, 1);
  f.snapshots.length = 0;
  f.changeOwner({userID:'owner-b',email:'b@northwind.example',calendarConnected:true});
  assert.ok(f.snapshots.length >= 2, 'Both real coordinator and service auth listeners emitted');
  assert.ok(f.snapshots.every(value => value.profile.userID === 'owner-b' && value.meetings.length === 0 && value.calendars.length === 0));
  await f.service.dispose();
});

test('shutdown skips stale queued enables but persists revocations to their original owner', async () => {
  for (const revoking of [false, true]) {
    const f = fixture(), cancellation = deferred();
    const enabled = { ...initial('owner-a'), autoJoin:true, participantConsent:true, systemAudioConsent:true };
    f.settings.set('owner-a', revoking ? enabled : initial('owner-a'));
    f.coordinator.cancel = () => cancellation.promise;
    const saving = f.service.action('saveSettings', { ...enabled, autoJoin:!revoking, participantConsent:!revoking, expectedOwnerUserID:'owner-a' });
    saving.catch(() => {});
    f.changeOwner({userID:'owner-b',email:'b@northwind.example',calendarConnected:true});
    const closing = f.service.dispose();
    cancellation.resolve();
    await assert.rejects(saving, /account changed/i); await closing;
    assert.equal(f.writes.length, revoking ? 1 : 0);
    if (revoking) {
      assert.equal(f.settings.get('owner-a').participantConsent, false);
      assert.equal(f.settings.get('owner-a').autoJoin, false);
    }
    assert.equal(f.settings.has('owner-b'), false);
  }
});

test('failed consent persistence blocks quit without disposing the coordinator; saving can be retried', async()=>{
  const f=fixture();
  const enabled={...initial('owner-a'),autoJoin:true,participantConsent:true,systemAudioConsent:true};
  f.settings.set('owner-a',enabled);
  const save=f.store.saveSettings;
  f.store.saveSettings=async()=>{throw Error('Disk write failed');};
  const off={...enabled,autoJoin:false,participantConsent:false,expectedOwnerUserID:'owner-a'};
  await assert.rejects(f.service.action('saveSettings',off),/Disk/);
  await assert.rejects(f.service.dispose(),cause=>cause.code==='settings_not_saved');
  assert.equal(f.calls.includes('dispose'),false);
  assert.equal(f.service.state().settings.autoJoin,false);
  f.store.saveSettings=save;
  await f.service.action('saveSettings',off);await f.service.dispose();
  assert.equal(f.settings.get('owner-a').participantConsent,false);
  assert.equal(f.calls.includes('dispose'),true);
});

test('local capture checks continue while calendar discovery is stalled',async()=>{
  const gate=deferred();
  const f=fixture({discover:async({auth})=>{
    const ownerUserID=auth.getProfile().userID;await gate.promise;
    return {ownerUserID,calendars:[],meetings:[]};
  }});
  const discovery=f.service.pulse();await settle();
  f.status({phase:'capturing',ownerUserID:'owner-a'});
  const polling=f.service.pulse();await settle();
  const checked=f.calls.includes('tick');
  gate.resolve();await Promise.all([discovery,polling]);await f.service.dispose();
  assert.equal(checked,true,'A pending cloud read must not delay local deadline/call-state checks');
});

test('coordinator refresh rechecks cloud ownership of cached Google discovery before any native Teams join', async () => {
  const profile={userID:'owner-a',email:'a@example.com',calendarConnected:true};
  const settings={...initial('owner-a'),autoJoin:true,participantConsent:true,systemAudioConsent:true};
  const joins=[], requests=[];
  let discoveries=0, unavailable=false;
  const auth={getProfile:()=>profile,getIdToken:async()=> 'firebase-routing-token',
    onStateChange:()=>()=>{},cancelSignIn:()=>{}};
  const service=createDesktopService({org,auth,
    store:{getSettings:()=>settings,list:()=>[],hasCompleted:()=>false,markCompleted:async()=>{}},
    discover:async()=> { discoveries++;return {ownerUserID:'owner-a',calendars:[],meetings:[{
      id:'teams-copy',calendarID:'primary',title:'Teams call',platform:'teams',
      joinURL:'https://teams.microsoft.com/meet/123?context=local',
      start:'2026-11-06T10:00:00Z',end:'2026-11-06T11:00:00Z'
    }]}; },
    fetch:async(url,options)=>{
      requests.push({url,options});
      if(unavailable) throw Error('unavailable');
      // Ownership changes between the UI discovery and the coordinator refresh.
      return {ok:true,redirected:false,json:async()=>requests.length===1 ? {events:[]} : {
        events:[],cloud_providers:[],cloud_events:[{join_url:'https://teams.microsoft.com/meet/123?context=cloud',start:'2026-11-06T10:00:00Z'}]
      }};
    },
    createCoordinator:options=>createMeetingCoordinator({...options,
      native:{join:async args=>{joins.push(args);throw Error('Must not join cloud-owned Teams');},inspect:async()=>{},close:async()=>{}},
      recorder:{start:async()=>{throw Error('Must not record');},stop:async()=>{}},
      now:()=>new Date('2026-11-06T10:00:00Z')})});
  await service.pulse();
  assert.equal(discoveries,1);
  assert.deepEqual(joins,[],'a cloud-owned Teams occurrence must never reach native join');
  assert.equal(requests.length,2,'cached Google discovery still requires a new policy before coordinator tick');
  for(const {url,options} of requests) {
    assert.equal(url,'https://meetings.northwind.example/calendar/desktop');
    assert.equal(options.headers.Authorization,'Bearer firebase-routing-token');
    assert.equal(options.redirect,'error');
  }
  await service.pulse();
  assert.equal(service.state().meetings.length,0,'cached raw Teams is re-filtered on every pulse');
  assert.equal(discoveries,1);
  unavailable=true;
  await service.pulse();
  assert.deepEqual(joins,[]);
  assert.match(service.state().status.message,/Teams.*paused/i);
  assert.match(service.state().error,/Teams.*paused/i);
  assert.equal(JSON.stringify(service.state()).includes('firebase-routing-token'),false);
  await service.dispose();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompanionStartup, createDesktopService, desktopBrowserAppArguments, desktopLaunchAction, desktopProductURL } from '../src/desktop-service.mjs';
import { createMeetingCoordinator } from '../src/meeting-coordinator.mjs';

const org = {meetingServiceURL:'https://meetings.northwind.example', viewerBase:'https://library.northwind.example', viewerPath:'reel', notesBaseURL:'https://library.northwind.example/reel', webBase:'https://record.northwind.example'};
const initial = ownerUserID => ({ ownerUserID, autoJoin: false, participantConsent: false,
  systemAudioConsent: false, meetingReminders: false, localTranscription: false, selection: { useAll: true, ids: [] } });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const settle = () => new Promise(resolve => setImmediate(resolve));

test('portable startup reads and changes only this organization’s per-user login item', () => {
  const executable = 'C:\\User Apps\\Reel.exe';
  const name = 'Reel Companion organization-a';
  let own = null;
  const otherItems = [
    { name, scope:'machine', enabled:true },
    { name:'Reel Companion organization-b', scope:'user', enabled:true },
  ];
  const app = {
    isPackaged:true,
    getLoginItemSettings(options) {
      assert.deepEqual(options,{ path:executable,args:[] });
      return { launchItems:[...otherItems,...(own ? [own] : [])] };
    },
    setLoginItemSettings(options) {
      assert.deepEqual(options,{ path:executable,args:[],name,openAtLogin:options.enabled,enabled:options.enabled });
      own=options.openAtLogin ? { name,scope:'user',enabled:options.enabled } : null;
    },
  };
  const startup=createCompanionStartup({app,executable,organizationKey:'organization-a'});
  assert.deepEqual(startup.state(),{mode:'portable',enabled:false});
  startup.setEnabled(true);
  assert.equal(startup.state().enabled,true);
  own.enabled=false; // Windows Startup Apps was used to turn it off.
  assert.equal(startup.state().enabled,false);
  assert.equal(own.enabled,false);
  startup.setEnabled(false);
  assert.equal(own,null);
});

test('MSIX startup sends the user to Windows Settings without changing registry login items', async () => {
  const urls=[];
  const startup=createCompanionStartup({windowsStore:true,shell:{openExternal:async url=>urls.push(url)}});
  const service=createDesktopService({startup});
  assert.deepEqual(service.state().startup,{mode:'windows-settings'});
  await service.action('openStartupSettings');
  assert.deepEqual(urls,['ms-settings:startupapps']);
  await assert.rejects(service.action('setCompanionStartup',{enabled:true}));
});

test('MSIX product launch arguments select the configured Recorder and Notetaker routes', () => {
  assert.equal(desktopLaunchAction(['Reel.exe', '--open-recorder']), 'openRecorder');
  assert.equal(desktopLaunchAction(['Reel.exe', '--open-notetaker']), 'openNotetaker');
  assert.equal(desktopLaunchAction(['Reel.exe']), null);
  assert.equal(desktopLaunchAction(['Reel.exe', '--open-recorder', '--open-notetaker']), null);
  assert.equal(desktopLaunchAction(['Reel.exe', '--open-recorder', '--open-recorder']), 'openRecorder');
  assert.equal(desktopProductURL('openRecorder', org), 'https://record.northwind.example/record');
  assert.equal(desktopProductURL('openNotetaker', org), 'https://record.northwind.example/notetaker');
  assert.deepEqual(desktopBrowserAppArguments('openRecorder', org), ['--app=https://record.northwind.example/record']);
  assert.deepEqual(desktopBrowserAppArguments('openNotetaker', org), ['--app=https://record.northwind.example/notetaker']);
  assert.throws(() => desktopProductURL('openLibrary', org), /Unknown Reel product launch/);
  assert.throws(() => desktopProductURL('openRecorder', null), /organization has not configured/);
});

function fixture({ realCoordinator = false, discover, discoverOutlook, shareMeeting, reminderScheduler, exportTrimmedCopy } = {}) {
  let profile = { userID: 'owner-a', email: 'a@northwind.example', calendarConnected: true };
  let coordinatorOptions, coordinator, status = { phase: 'idle' }, statusNotify;
  const settings = new Map(), recordings = [], calls = [], writes = [], snapshots = [], listeners = new Set();
  const notify = () => { for (const listener of listeners) listener(); };
  const auth = { getIdToken: async () => "fixture", getProfile: () => profile, onStateChange: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    signOut() { profile = null; notify(); }, disconnectCalendar() { profile = { ...profile, calendarConnected: false }; notify(); },
    signIn: async () => {}, cancelSignIn() {} };
  const store = { getSettings: id => settings.get(id) ?? initial(id), list: id => id===profile?.userID ? recordings : [], hasCompleted: () => false,
    markCompleted: async () => {}, saveSettings: async value => { writes.push(value); settings.set(value.ownerUserID, value); return value; } };
  store.rename=async args=>{if(args.ownerUserID!==profile?.userID||!args.isCurrent())throw Error('account changed');const item=recordings.find(recording=>recording.id===args.id);if(!item)throw Error('unavailable');item.title=args.title.trim();};
  store.deleteRecording=async args=>{if(args.ownerUserID!==profile?.userID||!args.isCurrent())throw Error('account changed');if(args.localOnlyConfirmed!==true)throw Error('confirm local only');const index=recordings.findIndex(recording=>recording.id===args.id);if(index<0)throw Error('unavailable');recordings.splice(index,1);};
  const service = createDesktopService({org, auth, store, discoverOutlook, fetch:async () => Response.json({events:[]}),
    reminderScheduler,
    discover: discover ?? (async ({auth}) => ({ ownerUserID: auth.getProfile().userID, calendars: [{id:'cal',title:'Work'}], meetings: [
      { id:'one', title:'QA', start:'2026-11-06T15:00:00Z',end:'2026-11-06T16:00:00Z',platform:'google_meet',joinURL:'https://meet.google.com/aaa-bbbb-ccc',attendeeEmails:['private@example.com'] } ] })),
    createCoordinator(options) { coordinatorOptions = options; coordinator = realCoordinator ? createMeetingCoordinator({ ...options,
      native: { join: async () => { throw Error('Unexpected test join'); }, inspect: async () => {}, close: async () => {} },
      recorder: { start: async () => { throw Error('Unexpected test capture'); }, stop: async () => {} },
      now: () => new Date('2026-11-06T10:00:00Z') }) : {
      getState: () => status, onStateChange: fn => { statusNotify = fn; return () => {}; },
      refresh: async () => { calls.push('refresh'); }, tick: async () => { calls.push('tick'); },
      cancel: async () => { calls.push('cancel'); }, dispose: async () => { calls.push('dispose'); } }; return coordinator; },
    openExternal: async url => calls.push(url), openProduct: async name => calls.push(name),
    openRecordings: async owner => calls.push(owner), openRecording: async file => calls.push(['play', file]), revealRecording: file => calls.push(['reveal', file]), copyText: text => calls.push(['copy', text]), shareMeeting, exportTrimmedCopy,
    onState: value => snapshots.push(value) });
  return { service, auth, store, coordinator, settings, recordings, calls, writes, snapshots, coordinatorOptions: () => coordinatorOptions,
    changeOwner(value) { profile = value; notify(); }, status(value) { status = value; statusNotify(value); } };
}
test('local playback and transcript copy are restricted to the active recording owner', async () => {
  const f = fixture(), id = 'a'.repeat(32);
  f.store.getRecordingPath = request => request.ownerUserID === 'owner-a' && request.id === id ? '/private/meeting.mp4' : null;
  f.store.getProcessing = request => request.ownerUserID === 'owner-a' && request.id === id ? { transcriptComplete: true, text: 'Meeting transcript' } : null;
  await f.service.action('playRecording', { id, expectedOwnerUserID: 'owner-a' });
  await f.service.action('revealRecording', { id, expectedOwnerUserID: 'owner-a' });
  await f.service.action('copyTranscript', { id, expectedOwnerUserID: 'owner-a' });
  assert.deepEqual(f.calls.filter(value => Array.isArray(value)), [['play', '/private/meeting.mp4'], ['reveal', '/private/meeting.mp4'], ['copy', 'Meeting transcript']]);
  await assert.rejects(f.service.action('playRecording', { id, expectedOwnerUserID: 'another-owner' }));
  await assert.rejects(f.service.action('revealRecording', { id, expectedOwnerUserID: 'another-owner' }));
  await assert.rejects(f.service.action('copyTranscript', { id: '../escape', expectedOwnerUserID: 'owner-a' }));
  await assert.rejects(f.service.action('revealRecording', { id: '../escape', expectedOwnerUserID: 'owner-a' }));
  f.changeOwner({ userID: 'owner-b', email: 'b@northwind.example', calendarConnected: true });
  await assert.rejects(f.service.action('playRecording', { id, expectedOwnerUserID: 'owner-a' }));
  await assert.rejects(f.service.action('revealRecording', { id, expectedOwnerUserID: 'owner-a' }));
  await assert.rejects(f.service.action('copyTranscript', { id, expectedOwnerUserID: 'owner-b' }));
});

test('transcript viewer returns only completed text for the active owner and opaque recording ID', async () => {
  const f=fixture(), id='b'.repeat(32);
  f.recordings.push({id,title:'A meeting'});
  f.store.getProcessing=request=>request.ownerUserID==='owner-a'&&request.id===id
    ? {transcriptComplete:true,text:'Transcript body'}:null;
  assert.deepEqual(await f.service.action('getTranscript',{id,expectedOwnerUserID:'owner-a'}),
    {title:'A meeting',text:'Transcript body'});
  await assert.rejects(f.service.action('getTranscript',{id,expectedOwnerUserID:'owner-b'}),/account changed/i);
  await assert.rejects(f.service.action('getTranscript',{id:'../escape',expectedOwnerUserID:'owner-a'}),/transcript is unavailable/i);
  await assert.rejects(f.service.action('getTranscript',{id,expectedOwnerUserID:'owner-a',path:'/tmp/private.txt'}),/transcript is unavailable/i);
  f.store.getProcessing=()=>({transcriptComplete:false,text:'Partial'});
  await assert.rejects(f.service.action('getTranscript',{id,expectedOwnerUserID:'owner-a'}),/transcript is unavailable/i);
});

test('trim export resolves only owner-bound local files and validates a non-destructive range', async () => {
  const exports=[];
  const f=fixture({exportTrimmedCopy:async value=>exports.push(value)}), id='b'.repeat(32);
  f.store.list=owner=>owner==='owner-a'?[{id,title:'Weekly meeting',durationSeconds:12}]:[];
  f.store.getRecordingPath=request=>request.ownerUserID==='owner-a'&&request.id===id?'/private/meeting.mp4':null;
  await f.service.action('exportTrimmedCopy',{id,expectedOwnerUserID:'owner-a',start:2.125,end:8.5});
  assert.deepEqual(exports,[{ownerUserID:'owner-a',id,file:'/private/meeting.mp4',title:'Weekly meeting',start:2.125,end:8.5}]);
  await assert.rejects(f.service.action('exportTrimmedCopy',{id,expectedOwnerUserID:'owner-b',start:2,end:8}),/account changed/i);
  await assert.rejects(f.service.action('exportTrimmedCopy',{id,expectedOwnerUserID:'owner-a',start:0,end:12}),/valid trim range/i);
  await assert.rejects(f.service.action('exportTrimmedCopy',{id,expectedOwnerUserID:'owner-a',start:11.8,end:12}),/valid trim range/i);
  await assert.rejects(f.service.action('exportTrimmedCopy',{id:'c'.repeat(32),expectedOwnerUserID:'owner-a',start:2,end:8}),/valid trim range/i);
  assert.equal(exports.length,1);
});

test('shutdown waits for in-flight local trim export to finish before process teardown', async () => {
  const exportGate=deferred(); let exportStarted=false,disposed=false;
  const f=fixture({exportTrimmedCopy:async()=>{exportStarted=true;await exportGate.promise;}}), id='d'.repeat(32);
  f.store.list=owner=>owner==='owner-a'?[{id,title:'Weekly meeting',durationSeconds:12}]:[];
  f.store.getRecordingPath=request=>request.ownerUserID==='owner-a'&&request.id===id?'/private/meeting.mp4':null;
  const exporting=f.service.action('exportTrimmedCopy',{id,expectedOwnerUserID:'owner-a',start:2,end:8});
  await settle(); assert.equal(exportStarted,true);
  const closing=f.service.dispose().then(()=>{disposed=true;});
  await settle(); assert.equal(disposed,false);
  await assert.rejects(f.service.action('refresh'),/shutting down/);
  exportGate.resolve(); await Promise.all([exporting,closing]);
  assert.equal(disposed,true);
});

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
test('the reminder preference is owner-bound and calendar refresh hands eligible events to the local scheduler', async () => {
  const updates=[];
  const f=fixture({reminderScheduler:{update:value=>updates.push(value),dispose(){}}});
  await f.service.pulse();
  assert.equal(f.service.state().settings.meetingReminders,false);
  assert.equal(updates.at(-1).reminders,false);
  const settings={...initial('owner-a'),meetingReminders:true,expectedOwnerUserID:'owner-a'};
  await f.service.action('saveSettings',settings);
  assert.equal(f.service.state().settings.meetingReminders,true);
  assert.equal(updates.at(-1).owner,'owner-a');
  assert.equal(updates.at(-1).reminders,true);
  assert.equal(updates.at(-1).meetings[0].id,'one');
  f.changeOwner({userID:'owner-b',email:'b@northwind.example',calendarConnected:true});
  assert.equal(f.service.state().settings.meetingReminders,false);
  assert.equal(updates.at(-1).owner,null);
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
  assert.deepEqual(f.calls.slice(1), ['openRecorder', 'openNotetaker']);
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
  await f.service.action('shareRecording',{id:'recording',url:'https://evil.example',expectedOwnerUserID:'owner-a',password:'birdhouse',expiry:'week'});
  assert.deepEqual(shared,[{ownerUserID:'owner-a',id:'recording',password:'birdhouse',expiry:'week'}]);
  f.changeOwner({userID:'owner-b',email:'b@northwind.example',calendarConnected:true});
  await assert.rejects(f.service.action('shareRecording',{id:'recording',expectedOwnerUserID:'owner-a'}),/account changed/i);
  assert.equal(shared.length,1);
  await f.service.dispose();
});

test('meeting share access updates are owner-bound and accept only settings, never URLs', async () => {
  const updates=[];
  const f=fixture({shareMeeting:{share:async()=>{},updateAccess:async value=>updates.push(value)}});
  await assert.rejects(f.service.action('updateMeetingShareAccess',{id:'a'.repeat(32),expectedOwnerUserID:'owner-b',password:'changed-password'}),/account changed/i);
  await assert.rejects(f.service.action('updateMeetingShareAccess',{id:'a'.repeat(32),expectedOwnerUserID:'owner-a',url:'https://evil.example'}),/invalid meeting link settings/i);
  await f.service.action('updateMeetingShareAccess',{id:'a'.repeat(32),expectedOwnerUserID:'owner-a',password:'changed-password',expiry:'day'});
  assert.deepEqual(updates,[{ownerUserID:'owner-a',id:'a'.repeat(32),password:'changed-password',expiry:'day'}]);
  f.changeOwner({userID:'owner-b',email:'b@northwind.example',calendarConnected:true});
  await assert.rejects(f.service.action('updateMeetingShareAccess',{id:'a'.repeat(32),expectedOwnerUserID:'owner-a'}),/account changed/i);
  assert.equal(updates.length,1);
});

test('rename and delete are owner-bound, reject renderer paths, and confirm local-only removal', async () => {
  const f=fixture(); f.recordings.push({id:'a'.repeat(32),title:'Legacy meeting'});
  const expectedOwnerUserID='owner-a', id='a'.repeat(32);
  await assert.rejects(f.service.action('renameRecording',{id,title:'Changed',expectedOwnerUserID:'owner-b'}),/account changed/i);
  await assert.rejects(f.service.action('renameRecording',{id,title:'Changed',path:'C:\\private.mp4',expectedOwnerUserID}),/invalid recording title/i);
  await assert.rejects(f.service.action('deleteRecording',{id,expectedOwnerUserID}),/local copy/i);
  await f.service.action('renameRecording',{id,title:'  New title  ',expectedOwnerUserID});
  assert.equal(f.service.state().recordings[0].title,'New title');
  await f.service.action('deleteRecording',{id,localOnlyConfirmed:true,expectedOwnerUserID});
  assert.deepEqual(f.service.state().recordings,[]);
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

test('a manual join accepts only an owner and opaque calendar ID and rechecks cloud routing', async () => {
  const joins = [];
  let cloudOwned = false;
  const profile = { userID: 'owner-a', email: 'a@northwind.example', calendarConnected: true };
  const meeting = { id: 'meeting-one', calendarID: 'cal', title: 'QA', start: '2026-11-06T15:00:00Z',
    end: '2026-11-06T16:00:00Z', platform: 'google_meet', joinURL: 'https://meet.google.com/aaa-bbbb-ccc' };
  const settings = { ...initial(profile.userID), participantConsent: true, systemAudioConsent: true };
  const auth = { getProfile: () => profile, getIdToken: async () => 'fixture-token', onStateChange: () => () => {},
    cancelSignIn() {} };
  const service = createDesktopService({ org, auth,
    store: { getSettings: () => settings, list: () => [], hasCompleted: () => false, markCompleted: () => {} },
    discover: async () => ({ ownerUserID: profile.userID, calendars: [], meetings: [meeting] }),
    fetch: async () => Response.json({ events: [], cloud_providers: [], cloud_events: cloudOwned
      ? [{ join_url: meeting.joinURL, start: meeting.start }] : [] }),
    createCoordinator: options => createMeetingCoordinator({ ...options,
      native: { join: async args => { joins.push(args); return { state: 'sign_in_required' }; }, inspect: async () => {}, close: async () => {} },
      recorder: { start: async () => { assert.fail('No verified joined window'); }, stop: async () => {} },
      now: () => new Date('2026-11-06T14:50:00Z') })
  });
  await service.pulse();
  assert.equal(service.state().meetings[0].id, meeting.id);
  const selection = { id: meeting.id, expectedOwnerUserID: profile.userID };
  await assert.rejects(service.action('joinMeeting', { ...selection, url: meeting.joinURL }), /Invalid meeting request/);
  await assert.rejects(service.action('joinMeeting', { id: meeting.id }), /account changed/);
  cloudOwned = true;
  await assert.rejects(service.action('joinMeeting', selection), /no longer available/);
  assert.deepEqual(joins, []);
  cloudOwned = false;
  await service.action('joinMeeting', selection);
  assert.equal(joins.length, 1);
  assert.equal(joins[0].url, meeting.joinURL);
  assert.equal(service.state().status.phase, 'failed');
  await service.dispose();
});

test('pasted meeting links can record without a calendar, recertify cloud routing, and never carry invitees', async () => {
  const joins = [], capture = [], saved = [];
  let profile = { userID: 'owner-a', email: 'a@northwind.example', calendarConnected: false };
  const authListeners = [];
  let cloudOwned = true, routingGate;
  const orgMeet = 'https://meet.google.com/aaa-bbbb-ccc';
  const instant = '2026-11-06T14:50:00Z';
  const auth = { getProfile: () => profile, getIdToken: async () => 'fixture-token',
    onStateChange: fn => { authListeners.push(fn); return () => {}; }, cancelSignIn() {} };
  const service = createDesktopService({ org, auth,
    store: { getSettings: owner => initial(owner), list: () => [], hasCompleted: () => false,
      markCompleted: data => { saved.push(data); } },
    discover: async () => assert.fail('A pasted link needs no local calendar connection'),
    fetch: async (_, options) => {
      assert.equal(options.signal instanceof AbortSignal, true);
      if (routingGate) await routingGate.promise;
      return Response.json({ events: [], cloud_providers: [], cloud_events: cloudOwned
        ? [{ join_url: orgMeet + '?authuser=1', start: '2026-11-06T14:40:00Z', end: '2026-11-06T15:00:00Z' }] : [] });
    },
    createCoordinator: options => createMeetingCoordinator({ ...options,
      native: { join: async args => { joins.push(args); return { ok: true, state: 'joined', sessionId: 'a'.repeat(32), hwnd: '40', pid: 123 }; },
        inspect: async () => ({ ok: true, state: 'in_call' }), close: async () => ({ ok: true, state: 'closed' }) },
      recorder: { start: async args => { capture.push(args); return {}; },
        stop: async () => ({ path: 'local-recording.mp4', playable: true }) },
      now: () => new Date(instant) })
  });
  const request = { url: 'https://meet.google.com/meet/aaa-bbbb-ccc/', expectedOwnerUserID: 'owner-a', participantsConfirmed: true };
  await assert.rejects(service.action('joinMeetingLink', { ...request, participantsConfirmed: false }), /confirm/);
  await assert.rejects(service.action('joinMeetingLink', { ...request, url: 'https://example.com/meet' }), /Use a direct/);
  await assert.rejects(service.action('joinMeetingLink', request), /unavailable/);
  assert.deepEqual(joins, []);

  cloudOwned = false;
  await service.action('joinMeetingLink', { ...request, includeMicrophone: true });
  assert.equal(joins.length, 1);
  assert.equal(capture[0].ownerUserID, 'owner-a');
  assert.equal(capture[0].microphone, true);
  assert.equal(capture[0].meeting.calendar, null);
  assert.deepEqual(capture[0].meeting.attendeeEmails, []);
  assert.equal(JSON.stringify(service.state()).includes(orgMeet), false);
  await service.pulse();
  assert.equal(service.state().status.phase, 'capturing');
  await service.action('stopRecording');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].ownerUserID, 'owner-a');

  routingGate = deferred();
  const joining = service.action('joinMeetingLink', request);
  const rejected = assert.rejects(joining, /account or recording settings changed/);
  await settle();
  profile = { ...profile, userID: 'owner-b', email: 'b@northwind.example' };
  for (const listener of authListeners) listener();
  routingGate.resolve();
  await rejected;
  assert.equal(joins.length, 1);
  await service.dispose();
});

test('switching calendar sources requires fresh consent and holds back old settings writes',async()=>{
  const f=fixture({discoverOutlook:async({auth})=>({ownerUserID:auth.getProfile().userID,
    calendars:[{id:'outlook:default',title:'Outlook'}],meetings:[]})});
  await f.service.action('disconnectCalendar');
  const enabled=await f.service.action('setCalendarSource',{expectedOwnerUserID:'owner-a',source:'outlook'});
  assert.equal(enabled.calendarAvailable,true);
  assert.equal(enabled.profile.calendarConnected,false);
  assert.equal(enabled.settings.autoJoin,false);
  assert.equal(enabled.settings.participantConsent,false);
  assert.equal(enabled.calendars[0].id,'outlook:default');
  await assert.rejects(f.service.action('saveSettings',{...initial('owner-a'),expectedOwnerUserID:'owner-a'}),/source changed/);
  const disabled=await f.service.action('setCalendarSource',{expectedOwnerUserID:'owner-a',source:'google'});
  assert.equal(disabled.calendarAvailable,false);
  assert.deepEqual(disabled.calendars,[]);
});

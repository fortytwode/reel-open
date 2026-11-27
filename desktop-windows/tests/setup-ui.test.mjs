import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('the dashboard can retry a saved recording through the restricted preload', async () => {
  let api;
  const calls = [];
  const electron = {
    contextBridge: { exposeInMainWorld: (_, value) => { api = value; } },
    ipcRenderer: { invoke: async (...args) => { calls.push(args); } },
  };
  const preload = await readFile(new URL('../preload.cjs', import.meta.url), 'utf8');
  vm.runInNewContext(preload, { require: () => electron });
  const recording = { id: 'saved-meeting', expectedOwnerUserID: 'owner-a' };
  await api.action('retryProcessing', recording);
  await api.action('transcribeManualRecording', recording);
  await api.action('shareRecording', recording);
  await api.action('updateMeetingShareAccess', recording);
  await api.action('playRecording', recording);
  await api.action('revealRecording', recording);
  await api.action('copyTranscript', recording);
  await api.action('getTranscript', recording);
  await api.action('renameRecording', recording);
  await api.action('deleteRecording', recording);
  await api.action('exportTrimmedCopy', recording);
  await api.action('listCaptureWindows', recording);
  await api.action('startWindowRecording', recording);
  await api.action('stopWindowRecording', recording);
  await assert.rejects(api.action('unknown', recording), /Unknown Reel action/);
  assert.deepEqual(calls, [['reel-desktop:action', 'retryProcessing', recording], ['reel-desktop:action', 'transcribeManualRecording', recording], ['reel-desktop:action', 'shareRecording', recording],
    ['reel-desktop:action', 'updateMeetingShareAccess', recording], ['reel-desktop:action', 'playRecording', recording], ['reel-desktop:action', 'revealRecording', recording], ['reel-desktop:action', 'copyTranscript', recording], ['reel-desktop:action', 'getTranscript', recording],
    ['reel-desktop:action', 'renameRecording', recording], ['reel-desktop:action', 'deleteRecording', recording],
    ['reel-desktop:action', 'exportTrimmedCopy', recording], ['reel-desktop:action', 'listCaptureWindows', recording],
    ['reel-desktop:action', 'startWindowRecording', recording], ['reel-desktop:action', 'stopWindowRecording', recording]]);
});

test('transcript dialog labels the window without announcing the entire transcript as its description', async () => {
  const html=await readFile(new URL('../ui/index.html',import.meta.url),'utf8');
  assert.match(html,/<dialog[^>]+aria-labelledby="transcriptTitle"/);
  assert.doesNotMatch(html,/aria-describedby="transcriptContent"/);
  assert.match(html,/<button[^>]+data-action="closeTranscript"[^>]*>Close transcript<\/button>/);
});

test('manual transcript asks for an explicit local or cloud choice before processing', async()=>{
  const elements=new Map();const getElement=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  let onClick;const calls=[];
  const snapshot={configured:true,profile:{userID:'owner-a',email:'a@northwind.example',calendarConnected:true},
    settings:{localTranscription:true,participantConsent:false,systemAudioConsent:false,selection:{useAll:true,ids:[]}},
    meetings:[],status:{phase:'idle'},recordings:[{id:'manual-id',title:'Demo',manualRecording:true,
      processing:{phase:'pending',transcriptReady:false}}]};
  const api={onState:()=>{},state:async()=>snapshot,action:(name,payload)=>{calls.push([name,payload]);return Promise.resolve(snapshot);}};
  const document={getElementById:getElement,createElement:tag=>new Element(tag),querySelectorAll:()=>[],querySelector:()=>null,
    addEventListener:(name,fn)=>{if(name==='click')onClick=fn;}};
  vm.runInNewContext(await readFile(new URL('../ui/setup.mjs',import.meta.url),'utf8'),
    {window:{reelDesktop:api},document,setTimeout,clearTimeout,Intl,Date,Number,String,Array,Set,Boolean,Math,Promise});
  await new Promise(resolve=>setImmediate(resolve));
  const transcribe=getElement('recordingsList').children[0].children[0].children.find(item=>item.dataset.action==='transcribeManualRecording');
  onClick({target:{closest:selector=>selector==='[data-action]'?transcribe:null}});
  assert.equal(getElement('manualTranscriptionDialog').open,true);
  assert.equal(getElement('manualTranscriptionLocal').checked,true);
  getElement('manualTranscriptionLocal').checked=false;getElement('manualTranscriptionCloud').checked=true;
  const confirm=getElement('manualTranscriptionConfirm');
  confirm.dataset.action='confirmManualTranscription';
  onClick({target:{closest:selector=>selector==='[data-action]'?confirm:null}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),[['transcribeManualRecording',{
    id:'manual-id',transcriptionConfirmed:true,transcriptionMode:'cloud',expectedOwnerUserID:'owner-a'}]]);
  assert.equal(getElement('manualTranscriptionDialog').open,false);
});

test('the selected window preview stays in the signed-in picker and clears on sign-out', async () => {
  const elements=new Map(); const getElement=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  let onState,onChange;
  const profile={userID:'owner-a',email:'a@example.com',calendarConnected:true};
  const snapshot={configured:true,profile,settings:{participantConsent:true,systemAudioConsent:true,autoJoin:false,selection:{useAll:true,ids:[]}},
    manualCapture:{phase:'idle',ownerUserID:'owner-a',sources:[{id:'opaque-choice',title:'Window',preview:'data:image/png;base64,cHJldmlldw=='}]},
    meetings:[],recordings:[],status:{phase:'idle'}};
  const api={onState:fn=>{onState=fn;},state:async()=>snapshot,action:async()=>snapshot};
  const document={getElementById:getElement,createElement:tag=>new Element(tag),querySelectorAll:()=>[],querySelector:()=>null,
    addEventListener:(name,fn)=>{if(name==='change')onChange=fn;}};
  const context={window:{reelDesktop:api},document,setTimeout,clearTimeout,Intl,Date,Number,String,Array,Set,Boolean,Math,Promise};
  vm.runInNewContext(await readFile(new URL('../ui/setup.mjs',import.meta.url),'utf8'),context);
  await new Promise(resolve=>setImmediate(resolve));
  const select=getElement('captureWindowSelect'),preview=getElement('captureWindowPreview');
  select.value='opaque-choice'; onChange({target:{...select,id:'captureWindowSelect',matches:()=>false}});
  assert.equal(preview.src,'data:image/png;base64,cHJldmlldw==');
  assert.equal(preview.classList.values.has('hidden'),false);
  onState({...snapshot,profile:null,manualCapture:{phase:'idle'}});
  assert.equal(preview.src,'');
  assert.equal(preview.classList.values.has('hidden'),true);
});

class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.dataset = {}; this.disabled = false;
    this.listeners = {}; this.value = ''; this.className = '';
    this.classList = { values: new Set(), add: value => this.classList.values.add(value),
      remove: value => this.classList.values.delete(value),
      toggle: (value, force) => { const enabled = force ?? !this.classList.values.has(value); enabled ? this.classList.values.add(value) : this.classList.values.delete(value); return enabled; } };
  }
  append(...children) { this.children.push(...children); }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.close?.(); }
  focus() { this.focused = true; }
  checkValidity() { return true; }
  reportValidity() { return true; }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); }
  get firstChild() { return this.children[0] ?? null; }
  setAttribute() {}
  scrollIntoView() { this.scrolled = true; }
  focus() { this.focused = true; }
}

test('clicking a reminder scrolls to its meeting and does not join it', async () => {
  const elements = new Map();
  const getElement = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const target = new Element('button'); target.dataset.meetingId = 'meeting-1';
  let onMeetingReminder, actionCount = 0;
  const api = { onMeetingReminder: fn => { onMeetingReminder = fn; }, state: async () => ({ configured: true, settings: {} }),
    action: async () => { actionCount++; } };
  const document = { getElementById: getElement, createElement: tag => new Element(tag),
    querySelectorAll: selector => selector === '[data-meeting-id]' ? [target] : [], querySelector: () => null,
    addEventListener() {} };
  const context = { window: { reelDesktop: api }, document, setTimeout, clearTimeout,
    Intl, Date, Number, String, Array, Set, Boolean, Math, Promise };
  const source = await readFile(new URL('../ui/setup.mjs', import.meta.url), 'utf8');
  vm.runInNewContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  onMeetingReminder('meeting-1');
  assert.equal(target.scrolled, true);
  assert.equal(target.focused, true);
  assert.equal(actionCount, 0);
});

test('action failure remains visible when the next service pulse rerenders setup', async () => {
  const elements = new Map();
  const getElement = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  let onState, onClick, rejectAction;
  const profile = { userID: 'owner-a', email: 'a@example.com', calendarConnected: false };
  const api = { onState: fn => { onState = fn; }, state: async () => ({ profile, settings: {}, configured: true }),
    action: () => new Promise((_, reject) => { rejectAction = reject; }) };
  const document = { getElementById: getElement, createElement: tag => new Element(tag),
    querySelectorAll: () => [], querySelector: () => null,
    addEventListener: (name, fn) => { if (name === 'click') onClick = fn; } };
  const context = { window: { reelDesktop: api }, document, setTimeout, clearTimeout,
    Intl, Date, Number, String, Array, Set, Boolean, Math, Promise };
  const source = await readFile(new URL('../ui/setup.mjs', import.meta.url), 'utf8');
  vm.runInNewContext(source, context);
  await new Promise(resolve => setImmediate(resolve));

  const signIn = new Element('button'); signIn.dataset.action = 'signIn';
  onClick({ target: { closest: selector => selector === '[data-action]' ? signIn : null } });
  rejectAction(new Error('Google sign-in could not start.'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(getElement('banner').textContent, 'Google sign-in could not start.');

  onState({ profile, settings: {}, configured: true, status: { phase: 'idle' } });
  assert.equal(getElement('banner').textContent, 'Google sign-in could not start.');
  assert.equal(getElement('banner').classList.values.has('hidden'), false);

  onClick({ target: { closest: selector => selector === '[data-action]' ? signIn : null } });
  assert.equal(getElement('banner').textContent, '');
  const rejectPreviousOwner = rejectAction;
  onState({ profile: { ...profile, userID: 'owner-b' }, settings: {}, configured: true });
  rejectPreviousOwner(new Error('Previous account failure.'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(getElement('banner').textContent, '');
  assert.equal(getElement('banner').classList.values.has('hidden'), true);
});

test('stale autosave failure cannot clear or report over the new owner state', async () => {
  const elements = new Map();
  const getElement = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  let onState, onChange, oldSaveReject, saveCount = 0, newOwnerPayload;
  const ownerA = { userID: 'owner-a', email: 'a@example.com', calendarConnected: true };
  const ownerB = { userID: 'owner-b', email: 'b@example.com', calendarConnected: true };
  const settings = { participantConsent: true, systemAudioConsent: true, autoJoin: false, selection: { useAll: true, ids: [] } };
  const api = { onState: fn => { onState = fn; }, state: async () => ({ profile: ownerA, settings, configured: true }),
    action: (_name, payload) => {
      saveCount++;
      if (saveCount === 1) return new Promise((_, reject) => { oldSaveReject = reject; });
      newOwnerPayload = payload;
      return Promise.resolve({ profile: ownerB, settings: payload, configured: true });
    } };
  const document = { getElementById: getElement, createElement: tag => new Element(tag),
    querySelectorAll: () => [], querySelector: () => null,
    addEventListener: (name, fn) => { if (name === 'change') onChange = fn; } };
  const context = { window: { reelDesktop: api }, document, setTimeout, clearTimeout,
    Intl, Date, Number, String, Array, Set, Boolean, Math, Promise };
  const source = await readFile(new URL('../ui/setup.mjs', import.meta.url), 'utf8');
  vm.runInNewContext(source, context);
  await new Promise(resolve => setImmediate(resolve));

  onChange({ target: { matches: () => true } });
  await new Promise(resolve => setTimeout(resolve, 275));
  assert.equal(saveCount, 1);

  onState({ profile: ownerB, settings, configured: true });
  onChange({ target: { matches: () => true } });
  oldSaveReject(new Error('Previous account save failed.'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(getElement('banner').textContent, '');
  await new Promise(resolve => setTimeout(resolve, 275));

  assert.equal(saveCount, 2);
  assert.equal(newOwnerPayload.expectedOwnerUserID, 'owner-b');
  assert.equal(newOwnerPayload.participantConsent, true);
  assert.equal(newOwnerPayload.systemAudioConsent, true);
  assert.equal(getElement('banner').textContent, '');
});

test('local playback and transcript controls pass only the selected ID and owner', async () => {
  const elements=new Map(); const getElement=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  let onClick; const calls=[];
  const snapshot={configured:true,profile:{userID:'owner-a',email:'a@example.com',calendarConnected:true},
    settings:{participantConsent:true,systemAudioConsent:true,autoJoin:false,selection:{useAll:true,ids:[]}},
    meetings:[],status:{phase:'idle'},recordings:[
      {id:'old',title:'Old recording',createdAt:'2026-11-06T12:00:00Z',durationSeconds:9},
      {id:'meeting',title:'Meeting',createdAt:'2026-11-06T12:00:00Z',durationSeconds:9,processing:{phase:'completed',transcriptReady:true}}]};
  const api={onState:()=>{},state:async()=>snapshot,action:(name,payload)=>{calls.push([name,payload]);
    return Promise.resolve(name==='getTranscript'?{title:'Meeting',text:'Transcript <b>literal</b> & safe'}:snapshot);}};
  const document={getElementById:getElement,createElement:tag=>new Element(tag),querySelectorAll:()=>[],querySelector:()=>null,
    addEventListener:(name,fn)=>{if(name==='click')onClick=fn;}};
  vm.runInNewContext(await readFile(new URL('../ui/setup.mjs',import.meta.url),'utf8'),
    {window:{reelDesktop:api},document,setTimeout,clearTimeout,Intl,Date,Number,String,Array,Set,Boolean,Math,Promise});
  await new Promise(resolve=>setImmediate(resolve));
  const entries=getElement('recordingsList').children;
  const play=entries[0].children[0].children.find(child=>child.dataset.action==='playRecording');
  const reveal=entries[0].children[0].children.find(child=>child.dataset.action==='revealRecording');
  const openTranscript=entries[1].children[0].children.find(child=>child.dataset.action==='openTranscript');
  const copy=entries[1].children[0].children.find(child=>child.dataset.action==='copyTranscript');
  const trimControls=entries[0].children[0].children.find(child=>child.className==='trim-export-controls');
  const trim=trimControls?.children.at(-1);
  assert.ok(play); assert.ok(reveal); assert.ok(openTranscript); assert.ok(copy);
  onClick({target:{closest:selector=>selector==='[data-action]'?play:null}});
  onClick({target:{closest:selector=>selector==='[data-action]'?reveal:null}});
  onClick({target:{closest:selector=>selector==='[data-action]'?openTranscript:null}});
  onClick({target:{closest:selector=>selector==='[data-action]'?copy:null}});
  trimControls.children[1].children[0].value='2'; trimControls.children[2].children[0].value='7';
  trim.listeners.click();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(getElement('transcriptDialog').open,true);
  assert.equal(getElement('transcriptContent').textContent,'Transcript <b>literal</b> & safe');
  assert.equal(getElement('transcriptContent').innerHTML,undefined);
  assert.equal(getElement('transcriptClose').focused,true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),[
    ['playRecording',{id:'old',expectedOwnerUserID:'owner-a'}],
    ['revealRecording',{id:'old',expectedOwnerUserID:'owner-a'}],
    ['getTranscript',{id:'meeting',expectedOwnerUserID:'owner-a'}],
    ['copyTranscript',{id:'meeting',expectedOwnerUserID:'owner-a'}],
    ['exportTrimmedCopy',{id:'old',expectedOwnerUserID:'owner-a',start:2,end:7}]]);
  const close=getElement('transcriptClose');
  close.dataset.action='closeTranscript';
  onClick({target:{closest:selector=>selector==='[data-action]'?close:null}});
  assert.equal(getElement('transcriptDialog').open,false);
  assert.equal(getElement('transcriptContent').textContent,'');
});

test('local extractive notes render as plain text without replacing the calendar title', async () => {
  const elements=new Map(); const getElement=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const snapshot={configured:true,profile:{userID:'owner-a',email:'a@example.com',calendarConnected:true},
    settings:{participantConsent:true,systemAudioConsent:true,localTranscription:true,autoJoin:false,selection:{useAll:true,ids:[]}},
    meetings:[],status:{phase:'idle'},recordings:[{id:'meeting',title:'Calendar title',createdAt:'2026-11-06T12:00:00Z',durationSeconds:180,
      processing:{phase:'completed',transcriptReady:true,transcriptionMode:'local',localOnly:true,
        localSummary:{suggestedTitle:'Suggested title',summary:'<b>Literal transcript words</b>',chapters:[{start:0,title:'Opening'}]}}}]};
  const api={onState:()=>{},state:async()=>snapshot,action:async()=>snapshot};
  const document={getElementById:getElement,createElement:tag=>new Element(tag),querySelectorAll:()=>[],querySelector:()=>null,addEventListener(){}};
  const source=await readFile(new URL('../ui/setup.mjs',import.meta.url),'utf8');
  vm.runInNewContext(source,{window:{reelDesktop:api},document,setTimeout,clearTimeout,Intl,Date,Number,String,Array,Set,Boolean,Math,Promise});
  await new Promise(resolve=>setImmediate(resolve));
  const children=getElement('recordingsList').children[0].children[0].children;
  assert.ok(children.some(child=>child.textContent==='Calendar title'));
  assert.ok(children.some(child=>String(child.textContent??'').includes('Transcript and local extractive notes saved on this computer')));
  const details=children.find(child=>child.tagName==='details');
  assert.ok(details);
  assert.equal(details.children[0].textContent,'Local extractive notes (not AI-generated)');
  assert.equal(details.children[1].textContent,'Suggested title (not applied): Suggested title');
  assert.equal(details.children[2].textContent,'<b>Literal transcript words</b>');
  assert.equal(details.children[2].innerHTML,undefined);
  assert.deepEqual(details.children[3].children.map(child=>child.textContent),['0:00 Opening']);
  assert.match(source,/deterministic extractive notes.*not with an AI model.*leaves the meeting title unchanged/u);
});

test('a late transcript response from a previous owner is not displayed', async () => {
  const elements=new Map(); const getElement=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  let onState,onClick,finishTranscript;
  const ownerA={userID:'owner-a',email:'a@example.com',calendarConnected:true};
  const ownerB={userID:'owner-b',email:'b@example.com',calendarConnected:true};
  const snapshot={configured:true,profile:ownerA,settings:{participantConsent:true,systemAudioConsent:true,autoJoin:false,selection:{useAll:true,ids:[]}},
    meetings:[],status:{phase:'idle'},recordings:[{id:'meeting',title:'Meeting',createdAt:'2026-11-06T12:00:00Z',durationSeconds:9,
      processing:{phase:'completed',transcriptReady:true}}]};
  const api={onState:fn=>{onState=fn;},state:async()=>snapshot,action:()=>new Promise(resolve=>{finishTranscript=resolve;})};
  const document={getElementById:getElement,createElement:tag=>new Element(tag),querySelectorAll:()=>[],querySelector:()=>null,
    addEventListener:(name,fn)=>{if(name==='click')onClick=fn;}};
  vm.runInNewContext(await readFile(new URL('../ui/setup.mjs',import.meta.url),'utf8'),
    {window:{reelDesktop:api},document,setTimeout,clearTimeout,Intl,Date,Number,String,Array,Set,Boolean,Math,Promise});
  await new Promise(resolve=>setImmediate(resolve));
  const button=getElement('recordingsList').children[0].children[0].children.find(child=>child.dataset.action==='openTranscript');
  onClick({target:{closest:selector=>selector==='[data-action]'?button:null}});
  onState({...snapshot,profile:ownerB});
  finishTranscript({title:'Meeting',text:'owner A private transcript'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.notEqual(getElement('transcriptDialog').open,true);
  assert.notEqual(getElement('transcriptContent').textContent,'owner A private transcript');
});

test('a saved meeting is shared only when its explicit button is selected', async () => {
  const elements=new Map(); const getElement=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  let onClick; const calls=[];
  const snapshot={configured:true,profile:{userID:'owner-a',email:'a@example.com',calendarConnected:true},
    settings:{participantConsent:true,systemAudioConsent:true,autoJoin:false,selection:{useAll:true,ids:[]}},
    meetings:[],status:{phase:'idle'},recordings:[{id:'meeting-id',title:'Weekly meeting',createdAt:'2026-11-06T12:00:00Z',durationSeconds:9,
      processing:{phase:'completed',transcriptReady:true},shareStatus:null}]};
  const api={onState:()=>{},state:async()=>snapshot,action:(name,payload)=>{calls.push([name,payload]);return Promise.resolve(snapshot);}};
  const document={getElementById:getElement,createElement:tag=>new Element(tag),querySelectorAll:()=>[],querySelector:()=>null,
    addEventListener:(name,fn)=>{if(name==='click')onClick=fn;}};
  const context={window:{reelDesktop:api},document,setTimeout,clearTimeout,Intl,Date,Number,String,Array,Set,Boolean,Math,Promise};
  vm.runInNewContext(await readFile(new URL('../ui/setup.mjs',import.meta.url),'utf8'),context);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.length,0,'rendering a saved meeting must not start an upload');
  const button=getElement('recordingsList').children[0].children[0].children.find(child=>child.dataset.action==='shareRecording');
  const transcriptButton=getElement('recordingsList').children[0].children[0].children.find(child=>child.dataset.includeTranscript==='true');
  assert.equal(transcriptButton.textContent,'Share video and transcript');
  assert.ok(button); assert.equal(button.textContent,'Share recording');
  const password = button.sharePasswordInput, expiry = button.shareExpiryInput;
  assert.equal(password.type,'password'); assert.equal(expiry.tagName,'select');
  assert.equal(password.minLength,12);
  const passwordLabel=getElement('recordingsList').children[0].children[0].children.find(child=>child.tagName==='label');
  assert.match(passwordLabel.textContent,/at least 12 characters/i);
  password.value='birdhouse123'; expiry.value='week';
  onClick({target:{closest:selector=>selector==='[data-action]'?button:null}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),[['shareRecording',{id:'meeting-id',expectedOwnerUserID:'owner-a',password:'birdhouse123',expiry:'week'}]]);
  assert.equal(password.value,'','The password field should be cleared after the action.');
  onClick({target:{closest:selector=>selector==='[data-action]'?transcriptButton:null}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))),['shareRecording',{id:'meeting-id',expectedOwnerUserID:'owner-a',includeTranscript:true,expiry:'week'}]);
});

test('saved recordings expose rename and clearly local-only deletion controls', async () => {
  const elements=new Map(); const getElement=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  let onClick; const calls=[], confirmations=[];
  const snapshot={configured:true,profile:{userID:'owner-a',email:'a@example.com',calendarConnected:true},
    settings:{participantConsent:true,systemAudioConsent:true,autoJoin:false,selection:{useAll:true,ids:[]}},
    meetings:[],status:{phase:'idle'},recordings:[{id:'meeting-id',title:'Weekly meeting',createdAt:'2026-11-06T12:00:00Z',durationSeconds:9}]};
  const api={onState:()=>{},state:async()=>snapshot,action:(name,payload)=>{calls.push([name,payload]);return Promise.resolve(snapshot);}};
  const document={getElementById:getElement,createElement:tag=>new Element(tag),querySelectorAll:()=>[],querySelector:()=>null,
    addEventListener:(name,fn)=>{if(name==='click')onClick=fn;}};
  const context={window:{reelDesktop:api,prompt:(_label,value)=>`${value} renamed`,confirm:message=>{confirmations.push(message);return true;}},
    document,setTimeout,clearTimeout,Intl,Date,Number,String,Array,Set,Boolean,Math,Promise};
  vm.runInNewContext(await readFile(new URL('../ui/setup.mjs',import.meta.url),'utf8'),context);
  await new Promise(resolve=>setImmediate(resolve));
  const controls=getElement('recordingsList').children[0].children[0].children;
  const rename=controls.find(child=>child.dataset.action==='renameRecording');
  const remove=controls.find(child=>child.dataset.action==='deleteRecording');
  assert.equal(rename.textContent,'Rename'); assert.equal(remove.textContent,'Delete local copy');
  onClick({target:{closest:selector=>selector==='[data-action]'?rename:null}});
  await new Promise(resolve=>setImmediate(resolve));
  onClick({target:{closest:selector=>selector==='[data-action]'?remove:null}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),[
    ['renameRecording',{id:'meeting-id',title:'Weekly meeting renamed',expectedOwnerUserID:'owner-a'}],
    ['deleteRecording',{id:'meeting-id',localOnlyConfirmed:true,expectedOwnerUserID:'owner-a'}],
  ]);
  assert.match(confirmations[0],/local recording only/i);
  assert.match(confirmations[0],/cloud share link remains/i);
});

test('a persisted uploading share is retryable after app restart', async () => {
  const elements=new Map(); const getElement=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  let onClick; const calls=[];
  const snapshot={configured:true,profile:{userID:'owner-a',email:'a@example.com',calendarConnected:true},
    settings:{participantConsent:true,systemAudioConsent:true,autoJoin:false,selection:{useAll:true,ids:[]}},
    meetings:[],status:{phase:'idle'},recordings:[{id:'meeting-id',title:'Weekly meeting',createdAt:'2026-11-06T12:00:00Z',durationSeconds:9,
      processing:{phase:'completed'},shareStatus:'uploading',sharing:false}]};
  const api={onState:()=>{},state:async()=>snapshot,action:(name,payload)=>{calls.push([name,payload]);return Promise.resolve(snapshot);}};
  const document={getElementById:getElement,createElement:tag=>new Element(tag),querySelectorAll:()=>[],querySelector:()=>null,
    addEventListener:(name,fn)=>{if(name==='click')onClick=fn;}};
  vm.runInNewContext(await readFile(new URL('../ui/setup.mjs',import.meta.url),'utf8'),
    {window:{reelDesktop:api},document,setTimeout,clearTimeout,Intl,Date,Number,String,Array,Set,Boolean,Math,Promise});
  await new Promise(resolve=>setImmediate(resolve));
  const button=getElement('recordingsList').children[0].children[0].children.find(child=>child.dataset.action==='shareRecording');
  assert.equal(button.textContent,'Retry sharing'); assert.equal(button.disabled,false);
  onClick({target:{closest:selector=>selector==='[data-action]'?button:null}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),[['shareRecording',{id:'meeting-id',expectedOwnerUserID:'owner-a'}]]);
});

test('a published meeting can update password and expiry while keeping its link copy action', async () => {
  const elements=new Map();const getElement=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  let onClick;const calls=[];
  const snapshot={configured:true,profile:{userID:'owner-a',email:'a@example.com',calendarConnected:true},
    settings:{participantConsent:true,systemAudioConsent:true,autoJoin:false,selection:{useAll:true,ids:[]}},meetings:[],status:{phase:'idle'},
    recordings:[{id:'meeting-id',title:'Weekly meeting',createdAt:'2026-11-06T12:00:00Z',durationSeconds:9,processing:{phase:'completed'},
      shareStatus:'uploaded',shareAccess:{passwordProtected:true,expiresAt:'2026-11-13T12:00:00Z',updatePending:false}}]};
  const api={onState:()=>{},state:async()=>snapshot,action:(name,payload)=>{calls.push([name,payload]);return Promise.resolve(snapshot);}};
  const document={getElementById:getElement,createElement:tag=>new Element(tag),querySelectorAll:()=>[],querySelector:()=>null,
    addEventListener:(name,fn)=>{if(name==='click')onClick=fn;}};
  vm.runInNewContext(await readFile(new URL('../ui/setup.mjs',import.meta.url),'utf8'),
    {window:{reelDesktop:api},document,setTimeout,clearTimeout,Intl,Date,Number,String,Array,Set,Boolean,Math,Promise});
  await new Promise(resolve=>setImmediate(resolve));
  const controls=getElement('recordingsList').children[0].children[0].children;
  const copy=controls.find(child=>child.dataset.action==='shareRecording');
  const update=controls.find(child=>child.dataset.action==='updateMeetingShareAccess');
  assert.equal(copy.textContent,'Copy share link');assert.equal(update.textContent,'Update link settings');
  assert.equal(controls.find(child=>child.tagName==='div'&&child.textContent?.includes('Password protected'))?.textContent?.includes('expires'),true);
  update.sharePasswordInput.value='changed-password-123';update.shareExpiryInput.value='day';
  onClick({target:{closest:selector=>selector==='[data-action]'?update:null}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),[['updateMeetingShareAccess',{
    id:'meeting-id',expectedOwnerUserID:'owner-a',password:'changed-password-123',expiry:'day'}]]);
  assert.equal(update.sharePasswordInput.value,'');
  onClick({target:{closest:selector=>selector==='[data-action]'?copy:null}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))),['shareRecording',{id:'meeting-id',expectedOwnerUserID:'owner-a'}]);
});

test('a failed access migration offers its safe retry and disables the old share publisher', async () => {
  const elements=new Map();const getElement=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  let onClick;const calls=[];
  const snapshot={configured:true,profile:{userID:'owner-a',email:'a@example.com',calendarConnected:true},
    settings:{participantConsent:true,systemAudioConsent:true,autoJoin:false,selection:{useAll:true,ids:[]}},meetings:[],status:{phase:'idle'},
    recordings:[{id:'meeting-id',title:'Weekly meeting',createdAt:'2026-11-06T12:00:00Z',durationSeconds:9,processing:{phase:'completed'},
      shareStatus:{failed:'update pending'},shareAccess:{passwordProtected:true,expiresAt:null,updatePending:true}}]};
  const api={onState:()=>{},state:async()=>snapshot,action:(name,payload)=>{calls.push([name,payload]);return Promise.resolve(snapshot);}};
  const document={getElementById:getElement,createElement:tag=>new Element(tag),querySelectorAll:()=>[],querySelector:()=>null,
    addEventListener:(name,fn)=>{if(name==='click')onClick=fn;}};
  vm.runInNewContext(await readFile(new URL('../ui/setup.mjs',import.meta.url),'utf8'),
    {window:{reelDesktop:api},document,setTimeout,clearTimeout,Intl,Date,Number,String,Array,Set,Boolean,Math,Promise});
  await new Promise(resolve=>setImmediate(resolve));
  const controls=getElement('recordingsList').children[0].children[0].children;
  const oldShare=controls.find(child=>child.dataset.action==='shareRecording');
  const retry=controls.find(child=>child.dataset.action==='updateMeetingShareAccess');
  assert.equal(oldShare.textContent,'Link update pending');assert.equal(oldShare.disabled,true);
  assert.equal(retry.textContent,'Retry link settings update');
  assert.ok(controls.some(child=>/previous link may remain accessible until this update succeeds/i.test(child.textContent)),
    'The failure state must warn that earlier access can persist until the retry completes.');
  onClick({target:{closest:selector=>selector==='[data-action]'?oldShare:null}});
  assert.equal(calls.length,0,'A pending update cannot fall back to publishing with old access.');
});

test('the dashboard joins a listed meeting with the current owner and can cancel while joining', async () => {
  const elements = new Map();
  const getElement = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  let onState, onClick, finishJoin;
  const calls = [];
  const initial = {
    profile: { userID: 'owner-a', email: 'a@example.com', calendarConnected: true },
    settings: { participantConsent: true, systemAudioConsent: true, autoJoin: false },
    meetings: [{ id: 'calendar-occurrence', title: 'Review', start: '2026-11-26T12:00:00Z' }],
  };
  const api = {
    state: async () => initial,
    onState: callback => { onState = callback; },
    action: (name, payload) => {
      calls.push(JSON.stringify([name, payload]));
      return name === 'joinMeeting' ? new Promise(resolve => { finishJoin = resolve; }) : Promise.resolve();
    },
  };
  const document = { getElementById: getElement, createElement: tag => new Element(tag), querySelectorAll: () => [],
    addEventListener: (name, callback) => { if (name === 'click') onClick = callback; } };
  const source = await readFile(new URL('../ui/setup.mjs', import.meta.url), 'utf8');
  vm.runInNewContext(source, { window: { reelDesktop: api }, document, setTimeout, clearTimeout });
  await new Promise(resolve => setImmediate(resolve));

  const joinButton = () => getElement('meetingsList').children[0].children[1].children.find(child => child.dataset.action === 'joinMeeting');
  const click = element => onClick({ target: { closest: selector => selector === '[data-action]' ? element : null } });
  assert.equal(joinButton().textContent, 'Join & record');
  click(joinButton());
  assert.equal(joinButton().disabled, true);
  assert.deepEqual(calls.map(call => JSON.parse(call)), [
    ['joinMeeting', { id: 'calendar-occurrence', includeMicrophone: false, expectedOwnerUserID: 'owner-a' }],
  ]);

  const cancel = getElement('cancelJoinButton');
  cancel.dataset.action = 'cancelJoin';
  onState({ ...initial, status: { phase: 'joining' } });
  assert.equal(cancel.classList.values.has('hidden'), false);
  click(cancel);
  assert.deepEqual(JSON.parse(calls[1]), ['cancelJoin', { expectedOwnerUserID: 'owner-a' }]);
  finishJoin({ ...initial, status: { phase: 'cancelled' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancel.classList.values.has('hidden'), true);
  assert.equal(joinButton().disabled, false);
});

test('signed-in users can paste a link without Calendar and only after confirming consent', async () => {
  const elements = new Map();
  const getElement = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  let onSubmit;
  const requests = [];
  const snapshot = { profile: { userID: 'owner-a', email: 'a@example.com', calendarConnected: false }, configured: true };
  const api = { state: async () => snapshot, action: async (name, payload) => {
    requests.push(JSON.stringify([name, payload]));
    return { ...snapshot, status: { phase: 'capturing', message: 'Recording' } };
  } };
  const document = { getElementById: getElement, createElement: tag => new Element(tag), querySelectorAll: () => [],
    addEventListener: (name, callback) => { if (name === 'submit') onSubmit = callback; } };
  const source = await readFile(new URL('../ui/setup.mjs', import.meta.url), 'utf8');
  vm.runInNewContext(source, { window: { reelDesktop: api }, document, setTimeout, clearTimeout });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(getElement('manualMeeting').classList.values.has('hidden'), false);
  getElement('meetingLink').value = 'https://meet.google.com/abc-defg-hij';
  const form = { target: { id: 'meetingLinkForm' }, preventDefault() {} };
  onSubmit(form);
  assert.deepEqual(requests, []);
  getElement('meetingLinkConsent').checked = true;
  onSubmit(form);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests.map(request => JSON.parse(request)), [['joinMeetingLink', {
    url: 'https://meet.google.com/abc-defg-hij', participantsConfirmed: true, includeMicrophone: false, expectedOwnerUserID: 'owner-a',
  }]]);
  assert.equal(getElement('meetingLink').value, '');
  assert.equal(getElement('meetingLinkConsent').checked, false);
  assert.equal(getElement('manualStop').classList.values.has('hidden'), false);
});

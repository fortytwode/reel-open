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
  await api.action('shareRecording', recording);
  await assert.rejects(api.action('unknown', recording), /Unknown Reel action/);
  assert.deepEqual(calls, [['reel-desktop:action', 'retryProcessing', recording], ['reel-desktop:action', 'shareRecording', recording]]);
});

class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.dataset = {}; this.disabled = false;
    this.classList = { values: new Set(), add: value => this.classList.values.add(value),
      remove: value => this.classList.values.delete(value),
      toggle: (value, force) => { const enabled = force ?? !this.classList.values.has(value); enabled ? this.classList.values.add(value) : this.classList.values.delete(value); return enabled; } };
  }
  append(...children) { this.children.push(...children); }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); }
  get firstChild() { return this.children[0] ?? null; }
  setAttribute() {}
  scrollIntoView() {}
}

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

test('a saved meeting is shared only when its explicit button is selected', async () => {
  const elements=new Map(); const getElement=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  let onClick; const calls=[];
  const snapshot={configured:true,profile:{userID:'owner-a',email:'a@example.com',calendarConnected:true},
    settings:{participantConsent:true,systemAudioConsent:true,autoJoin:false,selection:{useAll:true,ids:[]}},
    meetings:[],status:{phase:'idle'},recordings:[{id:'meeting-id',title:'Weekly meeting',createdAt:'2026-11-06T12:00:00Z',durationSeconds:9,
      processing:{phase:'completed'},shareStatus:null}]};
  const api={onState:()=>{},state:async()=>snapshot,action:(name,payload)=>{calls.push([name,payload]);return Promise.resolve(snapshot);}};
  const document={getElementById:getElement,createElement:tag=>new Element(tag),querySelectorAll:()=>[],querySelector:()=>null,
    addEventListener:(name,fn)=>{if(name==='click')onClick=fn;}};
  const context={window:{reelDesktop:api},document,setTimeout,clearTimeout,Intl,Date,Number,String,Array,Set,Boolean,Math,Promise};
  vm.runInNewContext(await readFile(new URL('../ui/setup.mjs',import.meta.url),'utf8'),context);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.length,0,'rendering a saved meeting must not start an upload');
  const button=getElement('recordingsList').children[0].children[0].children.find(child=>child.dataset.action==='shareRecording');
  assert.ok(button); assert.equal(button.textContent,'Share recording');
  onClick({target:{closest:selector=>selector==='[data-action]'?button:null}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),[['shareRecording',{id:'meeting-id',expectedOwnerUserID:'owner-a'}]]);
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

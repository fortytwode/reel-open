import test from 'node:test';
import assert from 'node:assert/strict';
import { createManualWindowCapture } from '../src/manual-window-capture.mjs';

function fixture() {
  let profile={userID:'owner-a'}, sources=[{id:'window:101:0',name:'Chrome — Product demo'},
    {id:'screen:0:0',name:'Entire screen'}, {id:'window:202:0',name:'Settings'}];
  const calls=[];
  const desktopCapturer={getSources:async query=>{calls.push(['sources',query]);return sources;}};
  const recorder={start:async args=>{calls.push(['start',args]);return {handle:1};},stop:async handle=>calls.push(['stop',handle])};
  const controller=createManualWindowCapture({desktopCapturer,recorder,getProfile:()=>profile});
  return {controller,calls,setSources:value=>{sources=value;},setProfile:value=>{profile=value;}};
}

test('picker exposes opaque window choices and captures only the revalidated exact HWND',async()=>{
  const f=fixture(), choices=await f.controller.list('owner-a');
  assert.deepEqual(choices.map(choice=>choice.title),['Chrome — Product demo','Settings']);
  assert.ok(choices.every(choice=>/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(choice.id)
    && !choice.id.startsWith('window:')));
  await assert.rejects(f.controller.start({ownerUserID:'owner-a',sourceID:choices[0].id,consentConfirmed:false}),/permission/);
  await f.controller.start({ownerUserID:'owner-a',sourceID:choices[0].id,consentConfirmed:true});
  const start=f.calls.find(call=>call[0]==='start')[1];
  assert.equal(start.hwnd,'101'); assert.equal(start.manual,true); assert.equal(start.ownerUserID,'owner-a');
  assert.equal(start.title,'Chrome — Product demo'); assert.equal(start.sourceName,'Chrome — Product demo'); assert.equal(start.meeting,null);
  assert.equal(start.systemAudio,true); assert.equal(start.microphone,false);
  assert.equal(Object.hasOwn(start,'pid'),false);
  assert.deepEqual(f.controller.state(),{phase:'capturing',ownerUserID:'owner-a',title:'Chrome — Product demo'});
  await f.controller.stop('owner-a');
  assert.deepEqual(f.calls.at(-1),['stop',{handle:1}]);
  assert.equal(f.controller.state().phase,'completed');
});

test('stale choices, changed accounts, non-window sources, and vanished targets fail closed',async()=>{
  const f=fixture(), choices=await f.controller.list('owner-a');
  await assert.rejects(f.controller.start({ownerUserID:'owner-b',sourceID:choices[0].id,consentConfirmed:true}),/sign in/i);
  await assert.rejects(f.controller.start({ownerUserID:'owner-a',sourceID:'window:999:0',consentConfirmed:true}),/refresh/i);
  f.setSources([{id:'window:202:0',name:'Other'}]);
  const [stale]=await f.controller.list('owner-a');
  f.setSources([{id:'window:303:0',name:'Replaced'}]);
  await assert.rejects(f.controller.start({ownerUserID:'owner-a',sourceID:stale.id,consentConfirmed:true}),/no longer available/i);
  f.setSources([{id:'window:101:0',name:'Chrome'}]);
  const current=await f.controller.list('owner-a');
  f.setSources([{id:'window:101:0',name:'Reused window handle'}]);
  await assert.rejects(f.controller.start({ownerUserID:'owner-a',sourceID:current[0].id,consentConfirmed:true}),/no longer available/i);
  f.setSources([{id:'window:101:0',name:'Chrome'}]);
  const latest=await f.controller.list('owner-a');
  f.setProfile({userID:'owner-b'});
  await assert.rejects(f.controller.start({ownerUserID:'owner-a',sourceID:latest[0].id,consentConfirmed:true}),/sign in/i);
});

test('stop during startup aborts and does not later report a stale recording',async()=>{
  const f=fixture(); let release;
  f.calls.length=0;
  const gate=new Promise(resolve=>{release=resolve;});
  const ctrl=createManualWindowCapture({desktopCapturer:f.controller?{getSources:async()=>[{id:'window:303:0',name:'Browser'}]}:null,
    recorder:{start:async()=>gate,stop:async()=>{}},getProfile:()=>({userID:'owner-a'})});
  const [choice]=await ctrl.list('owner-a');
  const starting=ctrl.start({ownerUserID:'owner-a',sourceID:choice.id,consentConfirmed:true});
  await new Promise(resolve=>setImmediate(resolve));
  await ctrl.stop('owner-a');
  release({handle:2});
  await assert.rejects(starting,/account changed/i);
  assert.equal(ctrl.state().phase,'cancelled');
});

test('the picker omits windows owned by the Reel process',async()=>{
  const controller=createManualWindowCapture({desktopCapturer:{getSources:async()=>[
    {id:'window:101:0',name:'Reel Companion'}, {id:'window:202:0',name:'Chrome'}]},
    recorder:{start:async()=>({}),stop:async()=>{}},getProfile:()=>({userID:'owner-a'}),getExcludedWindowHandles:()=>['101']});
  const choices=await controller.list('owner-a');
  assert.deepEqual(choices.map(value=>value.title),['Chrome']);
});

test('dispose aborts startup and waits for an in-flight save',async()=>{
  const sourceGate=deferred(),saveGate=deferred();let calls=0;
  const desktopCapturer={getSources:async()=>++calls===1?[{id:'window:404:0',name:'Browser'}]:sourceGate.promise};
  const recorder={start:async()=>({handle:1}),stop:async()=>saveGate.promise};
  const controller=createManualWindowCapture({desktopCapturer,recorder,getProfile:()=>({userID:'owner-a'})});
  const [choice]=await controller.list('owner-a');
  const starting=controller.start({ownerUserID:'owner-a',sourceID:choice.id,consentConfirmed:true});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(controller.isActive(),true);
  const shutdown=controller.dispose();
  sourceGate.resolve([{id:'window:404:0',name:'Browser'}]);
  await assert.rejects(starting,/account changed/i);
  await shutdown;
  assert.equal(controller.isActive(),false);

  const capture=createManualWindowCapture({desktopCapturer:{getSources:async()=>[{id:'window:405:0',name:'Browser'}]},
    recorder:{start:async()=>({handle:2}),stop:async()=>saveGate.promise},getProfile:()=>({userID:'owner-a'})});
  const [savedChoice]=await capture.list('owner-a');
  await capture.start({ownerUserID:'owner-a',sourceID:savedChoice.id,consentConfirmed:true});
  const stopping=capture.stop('owner-a');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(capture.isActive(),true,'The recorder stays busy until its save settles.');
  await assert.rejects(capture.stop('owner-b'),/another signed-in account/i);
  let disposed=false;const dispose=capture.dispose().then(()=>{disposed=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(disposed,false);
  saveGate.resolve();await Promise.all([stopping,dispose]);
  assert.equal(disposed,true);assert.equal(capture.isActive(),false);
});

function deferred(){let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};}

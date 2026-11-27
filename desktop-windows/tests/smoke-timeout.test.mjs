import test from 'node:test';
import assert from 'node:assert/strict';
import {withSmokeTimeout} from '../src/smoke-timeout.mjs';

test('smoke operation returns its result before the bound',async()=>{
  assert.equal(await withSmokeTimeout(()=>Promise.resolve('ready'),100),'ready');
});

test('smoke operation timeout reports its stage and rejects',async()=>{
  let timedOut=false;
  await assert.rejects(withSmokeTimeout(()=>new Promise(()=>{}),10,()=>{timedOut=true;}),/timed out/u);
  assert.equal(timedOut,true);
});

test('smoke operation preserves failures before timeout',async()=>{
  await assert.rejects(withSmokeTimeout(()=>{throw Error('operation failed');},100),/operation failed/u);
});

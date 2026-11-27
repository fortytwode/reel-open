import test from 'node:test';
import assert from 'node:assert/strict';
import { drawClickRings } from '../../web/reel/core.js';
import { CaptureSession } from '../../web/reel/capture.js';

function context() {
  const arcs=[];
  return { arcs, save(){}, restore(){}, beginPath(){}, arc(x,y,r){arcs.push({x,y,r});}, fill(){}, stroke(){},
    set globalAlpha(value){}, set fillStyle(value){}, set strokeStyle(value){}, set lineWidth(value){} };
}

test('click rings follow the selected window frame through encoder letterboxing and fade', () => {
  const ctx=context(), frame={displayWidth:1000,displayHeight:500};
  assert.equal(drawClickRings(ctx,[{x:0.25,y:0.75,time:4.8}],5,1000,1000,frame),1);
  assert.equal(ctx.arcs.length,2);
  assert.equal(ctx.arcs[0].x,250); assert.equal(ctx.arcs[0].y,625); assert.ok(Math.abs(ctx.arcs[0].r-22.8)<1e-9);
  assert.equal(drawClickRings(ctx,[{x:0.5,y:0.5,time:4.4}],5,1000,1000,frame),0);
  assert.equal(drawClickRings(ctx,[{x:0.5,y:0.5,time:5.1}],5,1000,1000,frame),0);
  assert.equal(drawClickRings(ctx,[{x:2,y:0.5,time:4.9}],5,1000,1000,frame),0);
});

test('click coordinates stay centered when the selected window is letterboxed', () => {
  const ctx=context(), frame={displayWidth:1920,displayHeight:1080};
  assert.equal(drawClickRings(ctx,[{x:0.5,y:0.5,time:9.9}],10,720,1280,frame),1);
  assert.equal(ctx.arcs[0].x,360); assert.equal(ctx.arcs[0].y,640); assert.ok(Math.abs(ctx.arcs[0].r-6.45)<1e-9);
});

test('CaptureSession forwards only normalized clicks while recording', () => {
  const session=new CaptureSession({settings:{},display:null,camera:null,mic:null,composite:false,events:{}}), posted=[];
  session.worker={postMessage:value=>posted.push(value)};
  session.addClick({x:0.5,y:0.5,time:1});
  session.phase='recording';
  session.addClick({x:0.25,y:0.75,time:1.5});
  session.addClick({x:-1,y:0.5,time:2});
  assert.deepEqual(posted,[{type:'click',x:0.25,y:0.75,time:1.5}]);
});

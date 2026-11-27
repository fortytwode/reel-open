import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalizePCM16Wav,measureNonSilentPCM16Samples} from './whisper-fixture.mjs';
import {whisperSamples} from '../src/meeting-processing.mjs';

function chunk(name,payload){
  const header=Buffer.alloc(8);header.write(name,0);header.writeUInt32LE(payload.length,4);
  return Buffer.concat([header,payload,payload.length&1?Buffer.from([0]):Buffer.alloc(0)]);
}
function riff(...chunks){
  const content=Buffer.concat([Buffer.from('WAVE'),...chunks]);
  const header=Buffer.alloc(8);header.write('RIFF',0);header.writeUInt32LE(content.length,4);
  return Buffer.concat([header,content]);
}
function pcmFormat({encoding=1,channels=1,rate=16_000,bits=16}={}){
  const data=Buffer.alloc(16);data.writeUInt16LE(encoding,0);data.writeUInt16LE(channels,2);data.writeUInt32LE(rate,4);
  const align=channels*bits/8;data.writeUInt32LE(rate*align,8);data.writeUInt16LE(align,12);data.writeUInt16LE(bits,14);return data;
}

test('canonicalizes valid PCM while preserving samples across extra RIFF chunks',async()=>{
  const samples=Buffer.alloc(320);
  for(let i=0;i<160;i++)samples.writeInt16LE(i%2?10_000:-10_000,i*2);
  const original=riff(chunk('JUNK',Buffer.from([1,2,3])),chunk('fmt ',pcmFormat()),chunk('LIST',Buffer.from('info')),chunk('data',samples));
  const canonical=canonicalizePCM16Wav(original);
  assert.equal(canonical.toString('ascii',0,4),'RIFF');
  assert.equal(canonical.toString('ascii',36,40),'data');
  assert.deepEqual(canonical.subarray(44),samples);
  const decoded=await whisperSamples(new Blob([canonical]));
  assert.equal(decoded.length,160);
  assert.equal(decoded[0],-10_000/32768);
  assert.equal(decoded[1],10_000/32768);
  assert.ok(measureNonSilentPCM16Samples(decoded).peak>0.3);
});

test('rejects wrong encoding, channels, rate, truncation and silent speech',()=>{
  const audio=chunk('data',Buffer.alloc(320,0x7f));
  for(const options of [{encoding:3},{channels:2},{rate:8_000}]){
    assert.throws(()=>canonicalizePCM16Wav(riff(chunk('fmt ',pcmFormat(options)),audio)));
  }
  const valid=riff(chunk('fmt ',pcmFormat()),audio);
  assert.throws(()=>canonicalizePCM16Wav(valid.subarray(0,-1)));
  assert.throws(()=>measureNonSilentPCM16Samples(new Float32Array(100)));
});

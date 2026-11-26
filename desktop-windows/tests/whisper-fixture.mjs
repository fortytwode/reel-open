import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {whisperSamples} from '../src/meeting-processing.mjs';

const RATE=16_000;

/** Validate a RIFF PCM WAV and rewrite its chunks into the exact header shape used by production. */
export function canonicalizePCM16Wav(input){
  const bytes=Buffer.from(input);
  assert.ok(bytes.length>=12&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WAVE',
    'Synthetic speech must be a RIFF/WAVE file.');
  const riffEnd=8+bytes.readUInt32LE(4);
  assert.equal(riffEnd,bytes.length,'Synthetic WAV must not be truncated or have unaccounted trailing bytes.');
  let format=null,data=null;
  for(let offset=12;offset<riffEnd;){
    assert.ok(offset+8<=riffEnd,'Synthetic WAV has a truncated chunk header.');
    const name=bytes.toString('ascii',offset,offset+4),size=bytes.readUInt32LE(offset+4),start=offset+8,end=start+size;
    assert.ok(end<=riffEnd,'Synthetic WAV has a truncated chunk body.');
    if(name==='fmt '){
      assert.equal(format,null,'Synthetic WAV has duplicate format chunks.');
      assert.ok(size>=16,'Synthetic WAV format chunk is too short.');
      format={encoding:bytes.readUInt16LE(start),channels:bytes.readUInt16LE(start+2),rate:bytes.readUInt32LE(start+4),
        byteRate:bytes.readUInt32LE(start+8),blockAlign:bytes.readUInt16LE(start+12),bits:bytes.readUInt16LE(start+14)};
    }else if(name==='data'){
      assert.equal(data,null,'Synthetic WAV has duplicate data chunks.');
      data=bytes.subarray(start,end);
    }
    offset=end+(size&1);
    assert.ok(offset<=riffEnd,'Synthetic WAV is missing a chunk padding byte.');
  }
  assert.ok(format&&data,'Synthetic WAV must contain format and data chunks.');
  assert.deepEqual(format,{encoding:1,channels:1,rate:RATE,byteRate:RATE*2,blockAlign:2,bits:16},
    'Synthetic speech must be mono 16 kHz PCM16LE.');
  assert.ok(data.length>0&&data.length%2===0,'Synthetic speech data must contain complete PCM16 samples.');
  const header=Buffer.alloc(44);
  header.write('RIFF',0);header.writeUInt32LE(36+data.length,4);header.write('WAVEfmt ',8);
  header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);
  header.writeUInt32LE(RATE,24);header.writeUInt32LE(RATE*2,28);header.writeUInt16LE(2,32);
  header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(data.length,40);
  return Buffer.concat([header,data]);
}

export function measureNonSilentPCM16Samples(samples){
  assert.ok(samples instanceof Float32Array&&samples.length>0,'Canonical speech fixture contains no PCM samples.');
  let peak=0,sumSquares=0;
  for(const value of samples){peak=Math.max(peak,Math.abs(value));sumSquares+=value*value;}
  const rms=Math.sqrt(sumSquares/samples.length);
  assert.ok(peak>=0.01&&rms>=0.001,'Synthetic speech fixture is silent or too quiet.');
  return {peak,rms};
}

async function runCLI(){
  const [source,destination]=process.argv.slice(2);
  assert.ok(source&&destination,'Usage: node whisper-fixture.mjs source.wav canonical.wav');
  const canonical=canonicalizePCM16Wav(await readFile(source));
  const samples=await whisperSamples(new Blob([canonical],{type:'audio/wav'}));
  const signal=measureNonSilentPCM16Samples(samples);
  await writeFile(destination,canonical);
  process.stdout.write(JSON.stringify({phase:'canonical_speech_fixture_ready',sampleCount:samples.length,
    peak:Math.round(signal.peak*10_000)/10_000,rms:Math.round(signal.rms*10_000)/10_000})+'\n');
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  runCLI().catch(error=>{process.stderr.write(`Synthetic WAV fixture rejected: ${error.message}\n`);process.exitCode=1;});
}

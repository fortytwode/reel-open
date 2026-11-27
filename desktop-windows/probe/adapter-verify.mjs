import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outArg = process.argv.find(arg => arg.startsWith('--out='));
const manualPicker = process.argv.includes('--manual-picker');
const outDir = path.resolve(outArg ? outArg.slice(6) : path.join(here, 'adapter-out'));
const result = JSON.parse(await readFile(path.join(outDir, 'result.json'), 'utf8'));
assert.equal(result.ok, true, JSON.stringify(result.error || result));
assert.equal(result.method, manualPicker ? 'production-manual-picker-recorder' : 'production-recorder-exact-source');
assert.equal(result.recorderWindowHidden, true);
if (manualPicker) {
  assert.match(result.pickerChoiceID, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
  assert.match(result.pickerTitle, /REEL CAPTURE FIXTURE 9C41/);
  assert.equal(result.recording.processing?.phase, 'pending', 'Manual captures must wait for an explicit transcription request.');
  assert.equal(result.recording.processing?.meeting?.manual, true);
  assert.equal(result.recording.processing?.transcriptComplete, undefined);
  assert.equal(result.recording.processing?.receipt, undefined, 'Manual captures must not create or deliver a recap.');
  assert.equal(result.recording.processing?.localOnly, undefined, 'Manual captures must remain unprocessed until the user asks.');
  assert.equal(result.recording.share, undefined, 'Manual captures must not be shared automatically.');
  assert.ok(Number.isSafeInteger(result.recording.processing?.audioFrames) && result.recording.processing.audioFrames > 0);
} else {
  assert.match(result.sourceId, /^window:\d+:[01]$/);
  assert.equal(result.sourceId.split(':')[1], result.hwnd);
}
assert.equal(result.recording?.playable, true);
assert.ok(result.recording.durationSeconds >= 12 && result.segmentCount >= 3);
const ownerHash = createHash('sha256').update('synthetic-probe').digest('hex');
const recordingPath = path.resolve(result.recording.path);
const sidecarTones = {};
if (manualPicker) {
  const pcmPath = recordingPath.replace(/\.mp4$/, '.pcm');
  const sidecar = await readFile(pcmPath);
  assert.equal(sidecar.length, result.recording.processing.audioFrames * 2,
    'Manual capture must retain all recovered mono PCM frames locally.');
  assert.equal(sidecar.length, result.pcmBytes);
} else {
  const sidecar = await readFile(recordingPath.replace(/\.mp4$/, '.pcm'));
  assert.ok(sidecar.length >= 12 * 16000 * 2 && sidecar.length <= (result.outputSwitched ? result.recording.durationSeconds + 3 : 20) * 16000 * 2, 'Expected complete 16 kHz mono PCM sidecar');
  let energy = 0; for (let i = 0; i < sidecar.length; i += 2) energy += (sidecar.readInt16LE(i) / 32768) ** 2;
  assert.ok(Math.sqrt(energy / (sidecar.length / 2)) > 0.002, 'Expected audible synthetic sidecar audio');
}
assert.equal(path.dirname(recordingPath), path.join(outDir, 'recordings', ownerHash));
assert.equal(path.basename(recordingPath), result.recording.id + '.mp4');
assert.equal((await stat(recordingPath)).size, result.bytes);
assert.ok(result.bytes >= 10_000 && result.bytes <= 20 * 1024 * 1024);

function run(program, args) {
  const output = spawnSync(program, args, { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
  if (output.error || output.status !== 0) throw Error(`${program}: ${output.error || output.stderr?.toString()}`);
  return output.stdout;
}
const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name:format=duration',
  '-of', 'json', recordingPath]).toString());
assert.ok(probe.streams.some(stream => stream.codec_name === 'h264'));
assert.ok(probe.streams.some(stream => stream.codec_name === 'aac'));
assert.ok(Number(probe.format.duration) >= 12);

function pixels(seconds) {
  const rgb = run('ffmpeg', ['-v', 'error', '-ss', String(seconds), '-i', recordingPath,
    '-frames:v', '1', '-vf', 'scale=100:100', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  assert.equal(rgb.length, 30_000);
  const sample = (x, y) => [...rgb.subarray((y * 100 + x) * 3, (y * 100 + x) * 3 + 3)];
  const [tl, tr, bl, br] = [sample(20, 20), sample(80, 20), sample(20, 80), sample(80, 80)];
  const magenta = ([r, g, b]) => r > 120 && g < 120 && b > 90;
  const green = ([r, g, b]) => r < 120 && g > 120 && b > 70;
  assert.ok(magenta(tl) && green(tr) && green(bl) && magenta(br), `Wrong fixture pixels at ${seconds}s`);
  return [tl, tr, bl, br];
}
function tone(seconds, frequency = 440, input = recordingPath) {
  const rawPCM = input.endsWith('.pcm') ? ['-f', 's16le', '-ar', '16000', '-ac', '1'] : [];
  const pcm = run('ffmpeg', ['-v', 'error', '-ss', String(seconds), ...rawPCM, '-i', input, '-map', '0:a:0',
    '-t', '2', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1']);
  const count = Math.floor(pcm.length / 4);
  let sum = 0, bestSignal = 0, best550 = 0;
  for (let offset = 0; offset + 12_000 < count; offset += 12_000) {
    let sinSignal = 0, cosSignal = 0, sin550 = 0, cos550 = 0;
    for (let i = 0; i < 12_000; i++) {
      const value = pcm.readFloatLE((offset + i) * 4);
      sum += value * value;
      const t = i / 48_000;
      sinSignal += value * Math.sin(2 * Math.PI * frequency * t);
      cosSignal += value * Math.cos(2 * Math.PI * frequency * t);
      sin550 += value * Math.sin(2 * Math.PI * 550 * t);
      cos550 += value * Math.cos(2 * Math.PI * 550 * t);
    }
    bestSignal = Math.max(bestSignal, Math.hypot(sinSignal, cosSignal) / 12_000);
    best550 = Math.max(best550, Math.hypot(sin550, cos550) / 12_000);
  }
  const rms = Math.sqrt(sum / (Math.floor(count / 12_000) * 12_000));
  assert.ok(rms > 0.002 && bestSignal > 0.003 && bestSignal > best550 * 4, `Wrong fixture audio at ${seconds}s`);
  return { rms, frequency, bestSignal, best550, ...(frequency === 440 ? { best440: bestSignal } : {}) };
}
const lateTime = result.outputSwitched ? Number(probe.format.duration) - 3 : 10;
if (manualPicker) {
  const pcmPath = recordingPath.replace(/\.mp4$/, '.pcm');
  // The fixture plays 880 Hz only after the encoder confirms Pause. Check the
  // entire recording in 100 ms windows so a dropped pause cannot hide between probes.
  for (const input of [recordingPath, pcmPath]) {
    const raw = input === pcmPath ? ['-f','s16le','-ar','16000','-ac','1'] : [];
    const audio = run('ffmpeg',['-v','error',...raw,'-i',input,'-map','0:a:0','-ar','8000','-ac','1','-f','f32le','pipe:1']);
    let peak=0;
    for (let start=0; start+800 <= audio.length/4; start+=800) {
      let re=0, im=0;
      for (let frame=0; frame<800; frame++) {
        const sample=audio.readFloatLE((start+frame)*4), angle=2*Math.PI*880*frame/8000;
        re+=sample*Math.cos(angle); im+=sample*Math.sin(angle);
      }
      peak=Math.max(peak,Math.hypot(re,im)/800);
    }
    assert.ok(peak < 0.02,'Paused fixture audio appeared in '+path.extname(input));
  }
  sidecarTones.early = tone(1, 440, pcmPath);
  sidecarTones.late = tone(10, 440, pcmPath);
} else if (result.outputSwitched) {
  assert.ok(Number.isFinite(result.changeAfterStartSeconds) && result.changeAfterStartSeconds >= 5);
  assert.ok(lateTime > result.changeAfterStartSeconds, 'Late sample must follow the Windows output change');
}
if (result.outputSwitched) {
  const pcmPath = recordingPath.replace(/\.mp4$/, '.pcm');
  sidecarTones.early = tone(1, 440, pcmPath);
  sidecarTones.late = tone(lateTime, 660, pcmPath);
}
console.log(JSON.stringify({ ...(manualPicker || result.outputSwitched ? { sidecarTones } : {}), verified: true,
  ...(manualPicker ? { pickerTitle: result.pickerTitle, pickerChoiceID: result.pickerChoiceID } : { sourceId: result.sourceId }), fragments: result.segmentCount,
  bytes: result.bytes, durationSeconds: result.recording.durationSeconds,
  earlyPixels: pixels(2), latePixels: pixels(lateTime + 1), earlyTone: tone(1), lateTone: tone(lateTime, result.outputSwitched ? 660 : 440) }));

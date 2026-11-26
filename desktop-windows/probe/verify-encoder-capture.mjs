import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const outArg = process.argv.find(arg => arg.startsWith('--out='));
assert.ok(outArg, 'Pass --out=<capture directory>');
const outDir = path.resolve(outArg.slice(6));
const result = JSON.parse(await readFile(path.join(outDir, 'result.json'), 'utf8'));
assert.equal(result.ok, true, JSON.stringify(result.error || result));
assert.equal(result.method, 'packaged-worker-synthetic-video-pcm');
assert.equal(result.electron, '45.2.3');
assert.ok(result.segmentCount >= 3);
assert.ok(result.recording?.playable);
assert.ok(result.audioFrames >= 12 * 48_000 && result.audioSeconds >= 12);
assert.ok((await stat(result.recording.path)).size >= 10_000);

function run(program, args) {
  const output = spawnSync(program, args, { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
  if (output.error || output.status !== 0) throw Error(`${program}: ${output.error || output.stderr?.toString()}`);
  return output.stdout;
}
const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name:format=duration', '-of', 'json', result.recording.path]).toString());
assert.ok(probe.streams.some(stream => stream.codec_name === 'h264'));
assert.ok(probe.streams.some(stream => stream.codec_name === 'aac'));
assert.ok(Number(probe.format.duration) >= 12);
run('ffmpeg', ['-v', 'error', '-xerror', '-i', result.recording.path, '-f', 'null', '-']);

const pixels = run('ffmpeg', ['-v', 'error', '-ss', '2', '-i', result.recording.path, '-frames:v', '1',
  '-vf', 'scale=100:100', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
assert.equal(pixels.length, 30_000);
const sample = (x, y) => [...pixels.subarray((y * 100 + x) * 3, (y * 100 + x) * 3 + 3)];
const [tl, tr, bl, br] = [sample(20, 20), sample(80, 20), sample(20, 80), sample(80, 80)];
const magenta = ([r, g, b]) => r > 120 && g < 120 && b > 90;
const green = ([r, g, b]) => r < 120 && g > 120 && b > 70;
assert.ok(magenta(tl) && green(tr) && green(bl) && magenta(br), 'Encoded frame did not preserve the synthetic quadrant pattern.');

const pcm = run('ffmpeg', ['-v', 'error', '-ss', '1', '-i', result.recording.path, '-map', '0:a:0', '-t', '2',
  '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1']);
const count = Math.floor(pcm.length / 4);
let sum = 0, best440 = 0, best550 = 0;
for (let offset = 0; offset + 12_000 <= count; offset += 12_000) {
  let sin440 = 0, cos440 = 0, sin550 = 0, cos550 = 0;
  for (let i = 0; i < 12_000; i++) {
    const value = pcm.readFloatLE((offset + i) * 4);
    sum += value * value;
    const t = i / 48_000;
    sin440 += value * Math.sin(2 * Math.PI * 440 * t); cos440 += value * Math.cos(2 * Math.PI * 440 * t);
    sin550 += value * Math.sin(2 * Math.PI * 550 * t); cos550 += value * Math.cos(2 * Math.PI * 550 * t);
  }
  best440 = Math.max(best440, Math.hypot(sin440, cos440) / 12_000);
  best550 = Math.max(best550, Math.hypot(sin550, cos550) / 12_000);
}
const rms = Math.sqrt(sum / count);
assert.ok(rms > 0.002 && best440 > 0.003 && best440 > best550 * 4, 'Encoded audio did not preserve the synthetic 440 Hz PCM tone.');
console.log(JSON.stringify({ verified: true, audioSource: 'generated AudioData PCM (not Windows loopback)',
  electron: result.electron, codecs: result.codecs, bytes: result.bytes, segments: result.segmentCount,
  durationSeconds: Number(probe.format.duration), videoSamples: [tl, tr, bl, br], audio: { rms, best440, best550 } }));

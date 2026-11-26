import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const [, , out, mode] = process.argv;
assert.ok(['on', 'off'].includes(mode));
const result = JSON.parse(await readFile(path.join(out, 'result.json'), 'utf8'));
const video = result.recording.path;
const audio = video.replace(/\.mp4$/, '.pcm');
assert.ok(result.recording.processing.audioFrames > 16_000 * 10);
function frequencyLevel(samples, frequency) {
  let real = 0, imaginary = 0;
  for (let offset = 0; offset < samples.length; offset += 4) {
    const phase = 2 * Math.PI * frequency * (offset / 4) / 16_000;
    const value = samples.readFloatLE(offset);
    real += value * Math.cos(phase);
    imaginary += value * Math.sin(phase);
  }
  return Math.hypot(real, imaginary) / (samples.length / 4);
}
for (const file of [video, audio]) {
  const raw = file === audio ? ['-f','s16le','-ar','16000','-ac','1'] : [];
  for (const at of ['2','8']) {
    const decoded = spawnSync('ffmpeg',['-v','error', ...raw, '-ss',at,'-i',file,
      '-map','0:a:0','-t','2','-ar','16000','-ac','1','-f','f32le','pipe:1']);
    assert.equal(decoded.status, 0, decoded.stderr?.toString());
    const samples = decoded.stdout;
    assert.equal(samples.length, 128_000);
    const system = frequencyLevel(samples, 440), microphone = frequencyLevel(samples, 880);
    assert.ok(system > 0.02, 'Missing 440 Hz synthetic system tone');
    if (mode === 'on') assert.ok(microphone > 0.02, 'Missing 880 Hz microphone tone with opt-in');
    else assert.ok(microphone < 0.003, 'Unexpected microphone tone without opt-in');
    console.log(JSON.stringify({ mode, file: path.extname(file), at, system, microphone }));
  }
}

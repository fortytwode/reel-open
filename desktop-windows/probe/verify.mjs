import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const probeDir = path.dirname(fileURLToPath(import.meta.url));
const outArg = process.argv.find((arg) => arg.startsWith("--out="));
const outDir = path.resolve(outArg ? outArg.slice(6) : path.join(probeDir, "out"));

function run(program, args, maxBuffer = 8 * 1024 * 1024) {
  const result = spawnSync(program, args, { encoding: "buffer", maxBuffer });
  if (result.error || result.status !== 0) throw new Error(`${program} failed: ${result.error || result.stderr?.toString()}`);
  return result.stdout;
}

function fixturePixels(rgb) {
  const sample = (x, y) => [...rgb.subarray((y * 100 + x) * 3, (y * 100 + x) * 3 + 3)];
  const [tl, tr, bl, br] = [sample(20, 20), sample(80, 20), sample(20, 80), sample(80, 80)];
  const magenta = ([r, g, b]) => r > 120 && g < 120 && b > 90;
  const green = ([r, g, b]) => r < 120 && g > 120 && b > 70;
  assert.ok(magenta(tl) && green(tr) && green(bl) && magenta(br), `MP4 frames are not the exact fixture: ${JSON.stringify([tl, tr, bl, br])}`);
  return [tl, tr, bl, br];
}

function toneStrength(pcm) {
  const count = Math.floor(pcm.length / 4);
  let total = 0, best440 = 0, best550 = 0;
  // Check a few 0.25-second intervals after startup. The synthetic fixture is 440 Hz.
  for (let offset = 0; offset + 12_000 < count; offset += 12_000) {
    let sin440 = 0, cos440 = 0, sin550 = 0, cos550 = 0;
    for (let i = 0; i < 12_000; i++) {
      const value = pcm.readFloatLE((offset + i) * 4);
      total += value * value;
      const t = i / 48_000;
      sin440 += value * Math.sin(2 * Math.PI * 440 * t);
      cos440 += value * Math.cos(2 * Math.PI * 440 * t);
      sin550 += value * Math.sin(2 * Math.PI * 550 * t);
      cos550 += value * Math.cos(2 * Math.PI * 550 * t);
    }
    best440 = Math.max(best440, Math.hypot(sin440, cos440) / 12_000);
    best550 = Math.max(best550, Math.hypot(sin550, cos550) / 12_000);
  }
  const rms = Math.sqrt(total / (Math.floor(count / 12_000) * 12_000));
  assert.ok(rms > 0.002 && best440 > 0.003 && best440 > best550 * 4,
    `MP4 audio lacks the fixture tone: rms=${rms}, 440=${best440}, 550=${best550}`);
  return { rms, best440, best550 };
}

const result = JSON.parse(await readFile(path.join(outDir, "result.json"), "utf8"));
assert.equal(result.ok, true, JSON.stringify(result.error || result));
assert.equal(result.recording?.playable, true, "The local writer did not finish a playable recording");
assert.equal(result.recording?.id, result.recordingID);
assert.equal(result.captureWindowVisible, false, "The recorder window was not hidden");
const videoFile = path.resolve(result.recording.path);
const relative = path.relative(path.join(outDir, "recordings"), videoFile);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "Recording escaped the local probe root");
assert.ok(["getDisplayMedia-handler", "getUserMedia-exact-source"].includes(result.method));
assert.match(result.sourceId, /^window:\d+:[01]$/);
assert.equal(result.sourceId.split(":")[1], result.hwnd, "captured HWND differs from the owned fixture");
assert.equal(result.pixels?.matchesFixture, true);
assert.equal(result.attempts.find((attempt) => attempt.method === result.method)?.userActivation, false,
  "capture was not unattended");
assert.ok(result.duration >= 12 && result.segmentCount >= 3, "The streaming run was too short");
assert.ok(result.bytes >= 10_000 && result.bytes <= 20 * 1024 * 1024);
assert.equal(result.packetBytes, result.bytes, "The writer did not preserve all packet bytes");
assert.equal((await stat(videoFile)).size, result.bytes);

const media = JSON.parse(run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name", "-of", "json", videoFile]).toString());
assert.ok(media.streams.some((stream) => stream.codec_name === "h264"), "MP4 has no H.264 stream");
assert.ok(media.streams.some((stream) => stream.codec_name === "aac"), "MP4 has no AAC stream");
const frame = (seconds) => {
  const rgb = run("ffmpeg", ["-v", "error", "-ss", String(seconds), "-i", videoFile,
    "-frames:v", "1", "-vf", "scale=100:100", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
  assert.equal(rgb.length, 100 * 100 * 3);
  return fixturePixels(rgb);
};
const audio = (seconds) => toneStrength(run("ffmpeg", ["-v", "error", "-ss", String(seconds), "-i", videoFile,
  "-map", "0:a:0", "-t", "2", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"]));
const earlyPixels = frame(2), latePixels = frame(11);
const earlyTone = audio(1), lateTone = audio(10);
console.log(JSON.stringify({ verified: true, method: result.method, electron: result.electron,
  chromium: result.chromium, sourceId: result.sourceId, bytes: result.bytes, fragments: result.segmentCount,
  duration: result.duration, earlyPixels, latePixels, earlyTone, lateTone }));

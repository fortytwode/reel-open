// Unit tests for web/reel/fmp4.js with synthetic encoded chunks (no codec needed): the
// fragmented muxer output is split into init + 4 s segments exactly like the live recorder does,
// parsed back sample for sample, and remuxed into a progressive MP4 (full and trimmed).
// Real H.264/AAC output is checked end to end by recorder-smoke.mjs (Chrome + ffprobe).
// Run: node --test firebase/tests/fmp4.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { Muxer, StreamTarget } from "../../web/vendor/mp4-muxer.mjs";
import { SegmentSplitter, parseInit, parseFragment, fragmentDuration, remux, boxes } from "../../web/reel/fmp4.js";
import { SEGMENT_INTERVAL } from "../../web/reel/core.js";

const avcC = new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 2, 0x68, 0xee]);
const asc = new Uint8Array([0x11, 0x90]);
const codecs = {
  video: { codec: "avc", codecString: "avc1.640028", width: 640, height: 360, description: avcC },
  audio: { codec: "aac", codecString: "mp4a.40.2", numberOfChannels: 2, sampleRate: 48000, description: asc },
};

/** Records `seconds` of 30 fps video (keyframe every 2 s) + AAC-sized audio frames into segments. */
function record(seconds) {
  const out = { init: null, segments: [], video: [], audio: [] };
  const splitter = new SegmentSplitter((b) => { out.init = b; }, (b) => out.segments.push(b));
  const muxer = new Muxer({
    target: new StreamTarget({ onData: (d, p) => splitter.write(d, p) }),
    fastStart: "fragmented", minFragmentDuration: SEGMENT_INTERVAL,
    video: { codec: "avc", width: 640, height: 360 }, audio: { codec: "aac", numberOfChannels: 2, sampleRate: 48000 },
  });
  const frames = Math.round(seconds * 30), aframes = Math.floor(seconds * 48000 / 1024);
  let v = 0, a = 0;
  while (v < frames || a < aframes) {
    const vt = v * 1e6 / 30, at = a * 1024 * 1e6 / 48000;
    if (v < frames && (a >= aframes || vt <= at)) {
      const data = new Uint8Array(50 + (v % 7)).fill(v % 256); data[0] = 0xaa;
      const key = v % 120 === 0;               // keyframes on segment boundaries (every 4 s), as the recorder does
      muxer.addVideoChunkRaw(data, key ? "key" : "delta", Math.round(vt), Math.round(1e6 / 30), v === 0 ? { decoderConfig: { codec: "avc1.640028", codedWidth: 640, codedHeight: 360, description: avcC } } : undefined);
      out.video.push({ t: vt / 1e6, key, data }); v++;
    } else {
      const data = new Uint8Array(20 + (a % 3)).fill(a % 256); data[0] = 0xbb;
      muxer.addAudioChunkRaw(data, "key", Math.round(at), Math.round(1024 * 1e6 / 48000), a === 0 ? { decoderConfig: { codec: "mp4a.40.2", numberOfChannels: 2, sampleRate: 48000, description: asc } } : undefined);
      out.audio.push({ t: at / 1e6, data }); a++;
    }
    splitter.drain();
  }
  muxer.finalize();
  splitter.drain();
  return out;
}

test("splits the fragmented stream into init + ~4 s segments that start on keyframes", () => {
  const r = record(13);
  assert.ok(r.init, "init emitted");
  assert.deepEqual(boxes(r.init).map((b) => b.type), ["ftyp", "moov"]);
  const tracks = parseInit(r.init);
  assert.deepEqual(tracks.map((t) => t.handler), ["vide", "soun"]);
  assert.equal(tracks[1].timescale, 48000);
  assert.equal(r.segments.length, 4);                 // 0-4, 4-8, 8-12, 12-13
  for (const s of r.segments) assert.deepEqual(boxes(s).map((b) => b.type), ["moof", "mdat"]);
  const durs = r.segments.map((s) => fragmentDuration(s, tracks));
  assert.deepEqual(durs.slice(0, 3).map((d) => Math.round(d * 100) / 100), [4, 4, 4]);
  assert.ok(Math.abs(durs.reduce((a, b) => a + b, 0) - 13) < 0.05, String(durs));
  for (const s of r.segments) assert.ok(parseFragment(s)[tracks[0].id].samples[0].key, "segment starts with a keyframe");
});

test("parsed samples equal the input samples (data, order, keyframes, timing)", () => {
  const r = record(9);
  const tracks = parseInit(r.init);
  const vid = [], aud = [];
  for (const s of r.segments) {
    const f = parseFragment(s);
    vid.push(...f[tracks[0].id].samples); aud.push(...f[tracks[1].id].samples);
  }
  assert.equal(vid.length, r.video.length);
  assert.equal(aud.length, r.audio.length);
  vid.forEach((s, i) => {
    assert.deepEqual(Array.from(s.data), Array.from(r.video[i].data), "video " + i);
    assert.equal(s.key, r.video[i].key, "key " + i);
    assert.ok(Math.abs(s.time / tracks[0].timescale - r.video[i].t) < 0.002, "time " + i);
  });
  aud.forEach((s, i) => assert.deepEqual(Array.from(s.data), Array.from(r.audio[i].data), "audio " + i));
});

test("remux builds a progressive MP4 (moov before mdat) with every sample", () => {
  const r = record(9);
  const mp4 = remux(r.init, r.segments, codecs);
  const top = boxes(mp4).map((b) => b.type);
  assert.deepEqual(top, ["ftyp", "moov", "mdat"]);
  const total = r.video.reduce((a, s) => a + s.data.length, 0) + r.audio.reduce((a, s) => a + s.data.length, 0);
  const mdat = boxes(mp4).find((b) => b.type === "mdat");
  assert.equal(mdat.size - mdat.header, total);
});

test("remux with a trim range starts at the keyframe before start and ends at end", () => {
  const r = record(13);
  const mp4 = remux(r.init, r.segments, codecs, { start: 5, end: 9 });
  const mdat = boxes(mp4).find((b) => b.type === "mdat");
  // Keyframes every 4 s: video frames 4.0..9.0 = 150, audio frames in [4, 9).
  const vbytes = r.video.filter((s) => s.t >= 4 - 1e-6 && s.t < 9 - 1e-6).reduce((a, s) => a + s.data.length, 0);
  const abytes = r.audio.filter((s) => s.t >= 4 - 1e-6 && s.t < 9 - 1e-6).reduce((a, s) => a + s.data.length, 0);
  assert.equal(mdat.size - mdat.header, vbytes + abytes);
});

test("splitter rejects rewrites of already emitted bytes", () => {
  const sp = new SegmentSplitter(() => {}, () => {});
  sp.base = 100;
  assert.throws(() => sp.write(new Uint8Array(4), 50));
});

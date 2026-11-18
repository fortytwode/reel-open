// Fragmented-MP4 plumbing for the browser recorder.
// - SegmentSplitter turns mp4-muxer's fragmented output stream into `init.mp4` (ftyp+moov) and
//   one HLS media segment per fragment (moof+mdat), like the Mac app's AVAssetWriter
//   .mpeg4AppleHLS writer produces init.mp4 + segNNNNN.m4s.
// - parseInit / parseFragment read those back (sample tables only: our own files).
// - remux() rebuilds a progressive MP4 (moov first) from init + segments: video.mp4 after stop,
//   crash recovery, and the keyframe-aligned trimmed.mp4.
import { Muxer, ArrayBufferTarget } from "../vendor/mp4-muxer.mjs";

const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u64 = (b, o) => u32(b, o) * 2 ** 32 + u32(b, o + 4);
const i32 = (b, o) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
const type = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

/** Top-level boxes [{type, start, size}] that are complete within `b` (stops at the first partial one). */
export function boxes(b, start = 0, end = b.length) {
  const out = [];
  let o = start;
  while (o + 8 <= end) {
    let size = u32(b, o), header = 8;
    if (size === 1) { if (o + 16 > end) break; size = u64(b, o + 8); header = 16; }
    else if (size === 0) size = end - o;
    if (size < header || o + size > end) break;
    out.push({ type: type(b, o + 4), start: o, size, header });
    o += size;
  }
  return out;
}
function child(b, box, name) { return boxes(b, box.start + box.header, box.start + box.size).find((x) => x.type === name); }
function children(b, box, name) { return boxes(b, box.start + box.header, box.start + box.size).filter((x) => x.type === name); }

/**
 * Receives StreamTarget writes (data, position) and emits complete pieces. The muxer may seek back
 * inside the fragment it is writing (to patch the moof) but never before the last flushed fragment,
 * so bytes before the first incomplete box are final.
 */
export class SegmentSplitter {
  constructor(onInit, onSegment) {
    this.onInit = onInit; this.onSegment = onSegment;
    this.buf = new Uint8Array(1 << 20); this.base = 0; this.len = 0; this.pendingHead = null; this.sawInit = false;
  }
  write(data, position) {
    const at = position - this.base;
    if (at < 0) throw new Error("muxer rewrote bytes that were already emitted");
    const need = at + data.length;
    if (need > this.buf.length) {
      let n = this.buf.length; while (n < need) n *= 2;
      const nb = new Uint8Array(n); nb.set(this.buf.subarray(0, this.len)); this.buf = nb;
    }
    this.buf.set(data, at);
    this.len = Math.max(this.len, need);
  }
  /** Call after each muxer flush (and after finalize). */
  drain() {
    const list = boxes(this.buf, 0, this.len);
    let consumed = 0;
    let i = 0;
    while (i < list.length) {
      const bx = list[i];
      if (!this.sawInit) {
        // ftyp, then moov: init segment.
        const moov = list.findIndex((x, k) => k >= i && x.type === "moov");
        if (moov < 0) break;
        const end = list[moov].start + list[moov].size;
        this.onInit(this.buf.slice(bx.start, end));
        this.sawInit = true; consumed = end; i = moov + 1; continue;
      }
      if (bx.type === "moof") {
        const md = list[i + 1];
        if (!md || md.type !== "mdat") break;
        const end = md.start + md.size;
        this.onSegment(this.buf.slice(bx.start, end));
        consumed = end; i += 2; continue;
      }
      // mfra (written by finalize) or anything else: skip.
      consumed = bx.start + bx.size; i++;
    }
    if (consumed) {
      this.buf.copyWithin(0, consumed, this.len);
      this.len -= consumed; this.base += consumed;
    }
  }
}

/** Track ids, handler types and timescales from init.mp4. */
export function parseInit(init) {
  const moov = boxes(init).find((x) => x.type === "moov");
  if (!moov) throw new Error("init segment has no moov");
  return children(init, moov, "trak").map((trak) => {
    const tkhd = child(init, trak, "tkhd");
    const v = init[tkhd.start + 8];
    const trackID = u32(init, tkhd.start + 8 + 4 + (v === 1 ? 16 : 8));
    const mdia = child(init, trak, "mdia");
    const mdhd = child(init, mdia, "mdhd");
    const mv = init[mdhd.start + 8];
    const timescale = u32(init, mdhd.start + 8 + 4 + (mv === 1 ? 16 : 8));
    const hdlr = child(init, mdia, "hdlr");
    const handler = type(init, hdlr.start + 8 + 4 + 4);
    return { id: trackID, handler, timescale };
  });
}

/**
 * Samples of one media segment (moof+mdat): {[trackID]: {baseTime, samples: [{data, duration, key, cts}]}}.
 * Times are in the track's timescale.
 */
export function parseFragment(seg) {
  const top = boxes(seg);
  const moof = top.find((x) => x.type === "moof");
  if (!moof) throw new Error("segment has no moof");
  const out = {};
  for (const traf of children(seg, moof, "traf")) {
    const tfhd = child(seg, traf, "tfhd");
    const tf = u32(seg, tfhd.start + 8) & 0xffffff;
    let p = tfhd.start + 12;
    const trackID = u32(seg, p); p += 4;
    let base = moof.start;                                   // default-base-is-moof (or moof when unset, for the first traf)
    if (tf & 0x1) { base = u64(seg, p); p += 8; }
    if (tf & 0x2) p += 4;
    let defDur = 0, defSize = 0, defFlags = 0;
    if (tf & 0x8) { defDur = u32(seg, p); p += 4; }
    if (tf & 0x10) { defSize = u32(seg, p); p += 4; }
    if (tf & 0x20) { defFlags = u32(seg, p); p += 4; }
    const tfdt = child(seg, traf, "tfdt");
    const baseTime = tfdt ? (seg[tfdt.start + 8] === 1 ? u64(seg, tfdt.start + 12) : u32(seg, tfdt.start + 12)) : 0;
    const samples = [];
    let t = baseTime;
    for (const trun of children(seg, traf, "trun")) {
      const vf = u32(seg, trun.start + 8), version = vf >>> 24, fl = vf & 0xffffff;
      let q = trun.start + 12;
      const count = u32(seg, q); q += 4;
      let dataOffset = 0;
      if (fl & 0x1) { dataOffset = i32(seg, q); q += 4; }
      let firstFlags = null;
      if (fl & 0x4) { firstFlags = u32(seg, q); q += 4; }
      let pos = base + dataOffset;
      for (let k = 0; k < count; k++) {
        const duration = fl & 0x100 ? u32(seg, (q += 4) - 4) : defDur;
        const size = fl & 0x200 ? u32(seg, (q += 4) - 4) : defSize;
        let flags = fl & 0x400 ? u32(seg, (q += 4) - 4) : defFlags;
        if (k === 0 && firstFlags != null) flags = firstFlags;
        let cts = 0;
        if (fl & 0x800) { cts = version === 0 ? u32(seg, q) : i32(seg, q); q += 4; }
        samples.push({ data: seg.subarray(pos, pos + size), time: t, duration, cts, key: !(flags & 0x00010000) });
        pos += size; t += duration;
      }
    }
    out[trackID] = { baseTime, samples };
  }
  return out;
}

/** Duration (seconds) of a segment's primary track (video if present). */
export function fragmentDuration(seg, tracks) {
  const f = parseFragment(seg);
  const primary = tracks.find((t) => t.handler === "vide") || tracks[0];
  const tr = f[primary.id];
  if (!tr || !tr.samples.length) return 0;
  return tr.samples.reduce((a, s) => a + s.duration, 0) / primary.timescale;
}

/**
 * Progressive MP4 from init + segments. `codecs` = {video: {codec, width, height, description},
 * audio?: {codec, numberOfChannels, sampleRate, description}} as recorded at capture time.
 * `range` (seconds) cuts at the last video keyframe <= start (keyframes every 2 s) up to end and
 * rebases timestamps to 0 (trimmed.mp4).
 */
export function remux(init, segments, codecs, range = null) {
  const tracks = parseInit(init);
  const vt = tracks.find((t) => t.handler === "vide"), at = tracks.find((t) => t.handler === "soun");
  const video = [], audio = [];
  for (const seg of segments) {
    const f = parseFragment(seg);
    if (vt && f[vt.id]) for (const s of f[vt.id].samples) video.push(s);
    if (at && f[at.id]) for (const s of f[at.id].samples) audio.push(s);
  }
  let from = 0, to = Infinity;
  if (range && vt) {
    const start = range.start * vt.timescale;
    let k = 0;
    for (let i = 0; i < video.length; i++) if (video[i].key && video[i].time <= start + 1e-6) k = i;
    from = video.length ? video[k].time / vt.timescale : 0;
    to = range.end;
  }
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target, fastStart: "in-memory", firstTimestampBehavior: "cross-track-offset",
    video: vt ? { codec: codecs.video.codec, width: codecs.video.width, height: codecs.video.height } : undefined,
    audio: at && codecs.audio ? { codec: codecs.audio.codec, numberOfChannels: codecs.audio.numberOfChannels, sampleRate: codecs.audio.sampleRate } : undefined,
  });
  const vmeta = vt ? { decoderConfig: { codec: codecs.video.codecString || "avc1", codedWidth: codecs.video.width, codedHeight: codecs.video.height, description: codecs.video.description } } : null;
  const ameta = at && codecs.audio ? { decoderConfig: { codec: codecs.audio.codecString || "mp4a.40.2", numberOfChannels: codecs.audio.numberOfChannels, sampleRate: codecs.audio.sampleRate, description: codecs.audio.description } } : null;
  // Interleave by time so the in-memory chunking stays sensible.
  let i = 0, j = 0, firstV = true, firstA = true;
  const vs = (s) => s.time / vt.timescale, as = (s) => s.time / at.timescale;
  const inRange = (t, d) => t + 1e-6 >= from && t < to - 1e-6 && (t + d > from);
  while (i < video.length || (ameta && j < audio.length)) {
    const takeVideo = i < video.length && (!ameta || j >= audio.length || vs(video[i]) <= as(audio[j]));
    if (takeVideo) {
      const s = video[i++], t = vs(s), d = s.duration / vt.timescale;
      if (t + 1e-6 < from || t >= to - 1e-6) continue;
      muxer.addVideoChunkRaw(s.data, s.key ? "key" : "delta", Math.round((t - from) * 1e6), Math.round(d * 1e6), firstV ? vmeta : undefined, s.cts ? Math.round(s.cts / vt.timescale * 1e6) : 0);
      firstV = false;
    } else {
      const s = audio[j++], t = as(s), d = s.duration / at.timescale;
      if (!inRange(t, d) || t < from - 1e-6) continue;
      muxer.addAudioChunkRaw(s.data, "key", Math.round((t - from) * 1e6), Math.round(d * 1e6), firstA ? ameta : undefined);
      firstA = false;
    }
  }
  muxer.finalize();
  return new Uint8Array(target.buffer);
}

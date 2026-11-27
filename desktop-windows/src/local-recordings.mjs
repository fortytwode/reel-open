import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import * as fileIO from 'node:fs/promises';
import path from 'node:path';

const MAX_PACKET = 16 * 1024 * 1024;
const MAX_PENDING = 32 * 1024 * 1024;
const text = (value, max = 4096) => typeof value === 'string' && value.length > 0 && value.length <= max;
const check = (condition, message) => { if (!condition) throw new Error(message); };
const defaults = ownerUserID => ({ ownerUserID, autoJoin: false, participantConsent: false,
  systemAudioConsent: false, meetingReminders: false, localTranscription: false, selection: { useAll: true, ids: [] } });
function localSummaryMetadata(recording) {
  const processing=recording.processing;
  if(processing?.localOnly!==true||processing.summaryEngine!=='extractive-local')return null;
  const plainText=(value,max)=>typeof value==='string'?Array.from(value.replace(/\s+/gu,' ').trim()).slice(0,max).join(''):null;
  const titleSuggestion=plainText(processing.suggestedTitle,90);
  const summary=plainText(processing.summary,700);
  const duration=Number.isFinite(recording.durationSeconds)?recording.durationSeconds:Infinity;
  const chapters=(Array.isArray(processing.chapters)?processing.chapters:[]).filter(chapter=>Number.isFinite(chapter?.start)
    &&chapter.start>=0&&chapter.start<duration&&typeof chapter.title==='string')
    .sort((left,right)=>left.start-right.start).filter((chapter,index,values)=>index===0||chapter.start-values[index-1].start>=20)
    .slice(0,8).map(chapter=>({start:Math.round(chapter.start*10)/10,title:plainText(chapter.title,60)}))
    .filter(chapter=>chapter.title);
  if(!titleSuggestion&&!summary&&!chapters.length)return null;
  return {suggestedTitle:titleSuggestion,summary,chapters};
}
const metadata = recording => {
  const localSummary=localSummaryMetadata(recording);
  return ({ id: recording.id, title: recording.title, createdAt: recording.createdAt,
  durationSeconds: recording.durationSeconds, ...(recording.share ? { shareStatus: structuredClone(recording.share.upload), shareIncludesTranscript: recording.share.includeTranscript === true } : {}),
  ...(recording.processing?.meeting?.manual === true ? { manualRecording: true } : {}),
  ...(recording.share?.access ? { shareAccess: { passwordProtected: Boolean(recording.share.access.key), expiresAt: recording.share.access.expiresAt ?? null,
    updatePending: Boolean(recording.share.accessUpdate) } } : {}),
  ...(recording.processing ? { processing: { phase: recording.processing.phase, noSpeech: recording.processing.noSpeech === true,
    transcriptReady: recording.processing.transcriptComplete === true && Boolean(recording.processing.text?.trim()),
    transcriptionMode: recording.processing.transcriptionMode === 'local' ? 'local' : 'cloud', localOnly: recording.processing.localOnly === true,
    ...(localSummary?{localSummary}:{}),
    error: recording.processing.error ?? null, receipt: recording.processing.receipt ? { url: recording.processing.receipt.url } : null } } : {}) });
};

// Only the boxes and sample tables produced by Reel's pinned fragmented muxer are accepted.
// This detects damaged/out-of-order appends; playback still requires the real media probe.
function boxes(bytes, start = 0, end = bytes.length) {
  const result = [];
  for (let offset = start; offset < end;) {
    check(offset + 8 <= end, 'Truncated MP4 box');
    let size = bytes.readUInt32BE(offset), header = 8;
    if (size === 1) {
      check(offset + 16 <= end, 'Truncated large MP4 box');
      const large = bytes.readBigUInt64BE(offset + 8);
      check(large <= BigInt(Number.MAX_SAFE_INTEGER), 'Invalid MP4 box size');
      size = Number(large); header = 16;
    }
    check(size >= header && offset + size <= end, 'Incomplete MP4 box');
    result.push({ type: bytes.toString('ascii', offset + 4, offset + 8), start: offset,
      data: offset + header, end: offset + size });
    offset += size;
  }
  return result;
}
function children(bytes, box) { return boxes(bytes, box.data, box.end); }
function one(list, type) {
  const found = list.filter(box => box.type === type);
  check(found.length === 1, `Expected one ${type} box`);
  return found[0];
}
function uint(bytes, offset, end) {
  check(offset + 4 <= end, 'Truncated MP4 field');
  return bytes.readUInt32BE(offset);
}
function time(bytes, offset, end, version) {
  check(version === 0 || version === 1, 'Unsupported MP4 time version');
  if (!version) return uint(bytes, offset, end);
  check(offset + 8 <= end, 'Truncated MP4 time');
  const value = bytes.readBigUInt64BE(offset);
  check(value <= BigInt(Number.MAX_SAFE_INTEGER), 'Invalid MP4 time');
  return Number(value);
}
function initTracks(bytes) {
  const top = boxes(bytes);
  check(top.length === 2 && top[0].type === 'ftyp' && top[1].type === 'moov', 'Expected complete ftyp + moov init');
  const tracks = new Map();
  const movie = children(bytes, top[1]);
  for (const trak of movie.filter(box => box.type === 'trak')) {
    const list = children(bytes, trak), tkhd = one(list, 'tkhd');
    check(tkhd.end - tkhd.data >= 8, 'Truncated track dimensions');
    const width = bytes.readUInt32BE(tkhd.end - 8) >>> 16;
    const height = bytes.readUInt32BE(tkhd.end - 4) >>> 16;
    const version = bytes[tkhd.data];
    check(version === 0 || version === 1, 'Unsupported track header');
    const id = uint(bytes, tkhd.data + 4 + (version ? 16 : 8), tkhd.end);
    const mdia = children(bytes, one(list, 'mdia'));
    const mdhd = one(mdia, 'mdhd'), mv = bytes[mdhd.data];
    check(mv === 0 || mv === 1, 'Unsupported media header');
    const timescale = uint(bytes, mdhd.data + 4 + (mv ? 16 : 8), mdhd.end);
    const hdlr = one(mdia, 'hdlr');
    check(hdlr.data + 12 <= hdlr.end, 'Truncated media handler');
    const handler = bytes.toString('ascii', hdlr.data + 8, hdlr.data + 12);
    const minf = children(bytes, one(mdia, 'minf'));
    const stbl = children(bytes, one(minf, 'stbl'));
    const stsd = one(stbl, 'stsd');
    check(uint(bytes, stsd.data + 4, stsd.end) === 1, 'Expected one codec entry');
    const entries = boxes(bytes, stsd.data + 8, stsd.end);
    check(entries.length === 1 && ((handler === 'vide' && entries[0].type === 'avc1')
      || (handler === 'soun' && entries[0].type === 'mp4a')), 'Expected AVC video and AAC audio');
    const entry = entries[0];
    const codecBoxes = boxes(bytes, entry.data + (handler === 'vide' ? 78 : 28), entry.end);
    if (handler === 'vide') {
      const config = one(codecBoxes, 'avcC');
      check(config.end - config.data >= 7 && bytes[config.data] === 1, 'Missing AVC decoder configuration');
    } else {
      const config = one(codecBoxes, 'esds');
      // The pinned muxer uses fixed descriptor headers and writes the AudioSpecificConfig here.
      check(config.end - config.data >= 37 && bytes[config.data + 17] === 0x40
        && bytes[config.data + 34] >= 2 && config.data + 35 + bytes[config.data + 34] <= config.end
        && (bytes[config.data + 35] >>> 3) === 2, 'Missing AAC-LC decoder configuration');
    }
    check(id > 0 && timescale > 0 && !tracks.has(id), 'Invalid or duplicate track');
    tracks.set(id, { handler, timescale, width: handler === 'vide' ? width : 0,
      height: handler === 'vide' ? height : 0, end: 0, samples: 0 });
  }
  check(tracks.size === 2 && [...tracks.values()].filter(track => track.handler === 'vide').length === 1
    && [...tracks.values()].filter(track => track.handler === 'soun').length === 1, 'Expected one video and one audio track');
  const extensions = children(bytes, one(movie, 'mvex')).filter(box => box.type === 'trex');
  check(extensions.length === tracks.size && new Set(extensions.map(box => uint(bytes, box.data + 4, box.end))).size === tracks.size
    && extensions.every(box => tracks.has(uint(bytes, box.data + 4, box.end))), 'Missing fragmented track defaults');
  return tracks;
}
async function videoDimensions(filePath) {
  const file = await fileIO.open(filePath, 'r');
  try {
    const stat = await file.stat(), length = Math.min(stat.size, MAX_PACKET), bytes = Buffer.alloc(length);
    for (let offset = 0; offset < length;) {
      const { bytesRead } = await file.read(bytes, offset, length - offset, offset);
      check(bytesRead > 0, 'The saved video init segment is incomplete.'); offset += bytesRead;
    }
    const endOfBox = offset => {
      check(offset + 8 <= bytes.length, 'The saved video init segment is incomplete.');
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      let size = bytes.readUInt32BE(offset), header = 8;
      if (size === 1) {
        check(offset + 16 <= bytes.length, 'The saved video init segment is incomplete.');
        const large = bytes.readBigUInt64BE(offset + 8);
        check(large <= BigInt(MAX_PACKET), 'The saved video init segment is too large.');
        size = Number(large); header = 16;
      }
      check(size >= header && offset + size <= bytes.length, 'The saved video init segment is incomplete.');
      return { type, end: offset + size };
    };
    const ftyp = endOfBox(0);
    check(ftyp.type === 'ftyp', 'The saved video is missing its file type box.');
    const moov = endOfBox(ftyp.end);
    check(moov.type === 'moov', 'The saved video is missing its movie header.');
    const video = [...initTracks(bytes.subarray(0, moov.end)).values()].find(track => track.handler === 'vide');
    check(Number.isInteger(video?.width) && video.width > 0 && Number.isInteger(video?.height) && video.height > 0,
      'The saved video dimensions are invalid.');
    return { width: video.width, height: video.height };
  } finally { await file.close(); }
}
function fragmentTracks(bytes, index, tracks) {
  const top = boxes(bytes);
  check(top.length === 2 && top[0].type === 'moof' && top[1].type === 'mdat', 'Expected complete moof + mdat fragment');
  const [moof, mdat] = top, list = children(bytes, moof), mfhd = one(list, 'mfhd');
  check(uint(bytes, mfhd.data + 4, mfhd.end) === index, 'Fragment sequence differs from append index');
  const updates = new Map(), ranges = [];
  for (const traf of list.filter(box => box.type === 'traf')) {
    const fields = children(bytes, traf), tfhd = one(fields, 'tfhd');
    check(uint(bytes, tfhd.data, tfhd.end) === 0x020038, 'Expected moof-relative sample defaults');
    const id = uint(bytes, tfhd.data + 4, tfhd.end), track = tracks.get(id);
    check(track && !updates.has(id), 'Unknown or duplicate fragment track');
    const defaultDuration = uint(bytes, tfhd.data + 8, tfhd.end);
    const defaultSize = uint(bytes, tfhd.data + 12, tfhd.end);
    const defaultFlags = uint(bytes, tfhd.data + 16, tfhd.end);
    const tfdt = one(fields, 'tfdt');
    const base = time(bytes, tfdt.data + 4, tfdt.end, bytes[tfdt.data]);
    check(base >= track.end, 'Fragment decode time moved backwards');
    let sampleCount = 0, duration = 0;
    for (const trun of fields.filter(box => box.type === 'trun')) {
      const vf = uint(bytes, trun.data, trun.end), flags = vf & 0xffffff;
      check((vf >>> 24) <= 1 && (flags & 1) && !(flags & ~0xf05), 'Unsupported sample table');
      const count = uint(bytes, trun.data + 4, trun.end);
      check(count > 0 && count <= mdat.end - mdat.data, 'Invalid sample count');
      let position = trun.data + 8;
      const offset = uint(bytes, position, trun.end) | 0; position += 4;
      let firstFlags = defaultFlags;
      if (flags & 4) { firstFlags = uint(bytes, position, trun.end); position += 4; }
      const start = moof.start + offset;
      let dataEnd = start;
      for (let i = 0; i < count; i++) {
        const sampleDuration = flags & 0x100 ? uint(bytes, position, trun.end) : defaultDuration;
        if (flags & 0x100) position += 4;
        const size = flags & 0x200 ? uint(bytes, position, trun.end) : defaultSize;
        if (flags & 0x200) position += 4;
        let sampleFlags = i ? defaultFlags : firstFlags;
        if (flags & 0x400) { sampleFlags = uint(bytes, position, trun.end); position += 4; }
        if (flags & 0x800) { uint(bytes, position, trun.end); position += 4; }
        check(sampleDuration > 0 && size > 0, 'Empty MP4 sample');
        if (!sampleCount && !i && track.handler === 'vide') check(!(sampleFlags & 0x10000), 'Video fragment must start with a keyframe');
        dataEnd += size; duration += sampleDuration;
        check(start >= mdat.data && dataEnd <= mdat.end && Number.isSafeInteger(base + duration), 'Sample data escapes mdat');
      }
      check(position === trun.end, 'Unexpected bytes in sample table');
      ranges.push({ start, end: dataEnd }); sampleCount += count;
    }
    check(sampleCount > 0, 'Fragment track has no samples');
    updates.set(id, { ...track, end: base + duration, samples: track.samples + sampleCount });
  }
  check(updates.size > 0, 'Fragment has no known samples');
  let end = mdat.data;
  for (const range of ranges.sort((a, b) => a.start - b.start)) {
    check(range.start === end, 'Overlapping or missing sample data'); end = range.end;
  }
  check(end === mdat.end, 'Unreferenced media bytes');
  return updates;
}

/** Main-process-only local files. No URLs, sharing, or caller-selected output paths.
 * begin/append/finish/abort and settings/completion mutations are asynchronous.
 * list/getSettings/hasCompleted are synchronous owner-bound metadata snapshots.
 * io may override filesystem operations for fault testing; root is trusted app configuration.
 */
export function createLocalRecordingStore({ root, io: overrides } = {}) {
  check(text(root), 'A local recordings root is required');
  const directory = path.resolve(root), io = { ...fileIO, ...overrides }, owners = new Map(), recordingLocks = new Map();
  function withRecordingLock({ ownerUserID, id } = {}, operation) {
    check(text(ownerUserID, 1024) && /^[0-9a-f]{32}$/.test(id ?? '') && typeof operation === 'function', 'Invalid local recording operation.');
    const key = JSON.stringify([ownerUserID, id]), previous = recordingLocks.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    recordingLocks.set(key, tail);
    return previous.catch(() => {}).then(operation).finally(() => {
      release();
      if (recordingLocks.get(key) === tail) recordingLocks.delete(key);
    });
  }
  function owner(ownerUserID) {
    check(text(ownerUserID, 1024), 'Invalid recording owner');
    if (owners.has(ownerUserID)) return owners.get(ownerUserID);
    const dir = path.join(directory, createHash('sha256').update(ownerUserID).digest('hex'));
    let state = { version: 1, ownerUserID, settings: defaults(ownerUserID), recordings: [], completed: {} };
    try {
      const saved = JSON.parse(readFileSync(path.join(dir, 'library.json'), 'utf8'));
      check(saved.version === 1 && saved.ownerUserID === ownerUserID && Array.isArray(saved.recordings)
        && saved.completed && typeof saved.completed === 'object' && !Array.isArray(saved.completed), 'Invalid local recording metadata');
      state = { ...saved, settings: { ...defaults(ownerUserID), ...(saved.settings ?? {}) } };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const value = { dir, state, tail: Promise.resolve() }; owners.set(ownerUserID, value); return value;
  }
  async function writeAll(handle, bytes) {
    for (let offset = 0; offset < bytes.length;) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, null);
      check(Number.isInteger(bytesWritten) && bytesWritten > 0 && bytesWritten <= bytes.length - offset, 'Local recording write made no progress');
      offset += bytesWritten;
    }
  }
  function mutate(value, update) {
    const result = value.tail.then(async () => {
      const state = update(structuredClone(value.state));
      await io.mkdir(value.dir, { recursive: true, mode: 0o700 });
      const temporary = path.join(value.dir, `${randomBytes(16).toString('hex')}.json.tmp`);
      let handle;
      try {
        handle = await io.open(temporary, 'wx', 0o600);
        await writeAll(handle, Buffer.from(JSON.stringify(state)));
        await handle.sync(); await handle.close(); handle = null;
        await io.rename(temporary, path.join(value.dir, 'library.json'));
        value.state = state;
      } finally {
        if (handle) await handle.close().catch(() => {});
        await io.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
      return state;
    });
    value.tail = result.catch(() => {}); return result;
  }
  async function begin({ ownerUserID, title = 'Meeting', createdAt = new Date().toISOString(), meeting = null } = {}) {
    const value = owner(ownerUserID);
    check(text(title) && Number.isFinite(Date.parse(createdAt)), 'Invalid recording metadata');
    createdAt = new Date(createdAt).toISOString();
    await io.mkdir(value.dir, { recursive: true, mode: 0o700 });
    const id = randomBytes(16).toString('hex'), finalPath = path.join(value.dir, `${id}.mp4`);
    const partialPath = finalPath + '.partial';
    const file = await io.open(partialPath, 'wx', 0o600);
    let audioFile = null, audioTail = Promise.resolve(), audioFailure = null, audioFrames = 0;
    const audioPartial = path.join(value.dir, `${id}.pcm.partial`), audioFinal = path.join(value.dir, `${id}.pcm`);
    if (meeting) { try { audioFile = await io.open(audioPartial, 'wx', 0o600); } catch (error) { audioFailure = error; } }
    function appendAudio(bytes) {
      if (!meeting || sealed) return Promise.reject(Error('Audio sidecar is closed'));
      if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length % 2 || bytes.length > MAX_PACKET) return Promise.reject(Error('Invalid audio packet'));
      const copy = Buffer.from(bytes);
      const operation = audioTail.then(async () => {
        if (audioFailure) throw audioFailure;
        await writeAll(audioFile, copy); audioFrames += copy.length / 2;
      }).catch(error => { audioFailure ??= error; throw error; });
      audioTail = operation.catch(() => {}); return operation;
    }
    function failAudio() { audioFailure ??= Error('The audio sidecar could not be saved.'); }
    let tracks = null, lastIndex = 0, tail = Promise.resolve(), failure = null, pending = 0;
    let sealed = false, finishPromise, closePromise, abortPromise;
    const close = () => closePromise ??= file.close();
    function append(bytes, operation) {
      if (sealed) return Promise.reject(Error('Recording writer is closed'));
      try {
        check(bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= MAX_PACKET, 'Invalid or oversized recording packet');
        check(pending + bytes.byteLength <= MAX_PENDING, 'Recording writer cannot keep up');
        bytes = Buffer.from(bytes); pending += bytes.length;
      } catch (error) { failure ??= error; return Promise.reject(error); }
      const result = tail.then(async () => {
        if (failure) throw failure;
        const apply = operation(bytes);
        await writeAll(file, bytes); await file.sync(); apply();
      }).catch(async error => { failure ??= error; await close().catch(() => {}); throw error; })
        .finally(() => { pending -= bytes.length; });
      tail = result.catch(() => {}); return result;
    }
    function appendInit(bytes) {
      return append(bytes, packet => {
        check(!tracks, 'Recording init already appended');
        const parsed = initTracks(packet); return () => { tracks = parsed; };
      });
    }
    function appendFragment({ index, duration, bytes } = {}) {
      return append(bytes, packet => {
        check(tracks && Number.isInteger(index) && index === lastIndex + 1, 'Recording fragment is out of order');
        check(Number.isFinite(duration) && duration >= 0, 'Invalid fragment duration');
        const updates = fragmentTracks(packet, index, tracks);
        return () => { for (const [id, track] of updates) tracks.set(id, track); lastIndex = index; };
      });
    }
    function finish({ durationSeconds } = {}) {
      if (finishPromise) return finishPromise;
      if (sealed) return Promise.reject(Error('Recording writer was aborted'));
      sealed = true;
      finishPromise = (async () => {
        try {
          await tail;
          if (failure) throw failure;
          check(Number.isFinite(durationSeconds) && durationSeconds > 0 && lastIndex > 0
            && [...tracks.values()].every(track => track.samples > 0), 'Recording has no complete video and audio samples');
          await file.sync(); await close(); await io.rename(partialPath, finalPath);
          if (meeting) {
            await audioTail;
            try {
              if (audioFailure || !audioFile || !audioFrames) throw audioFailure ?? Error('No meeting audio was saved.');
              await audioFile.sync(); await audioFile.close(); audioFile = null; await io.rename(audioPartial, audioFinal);
            } catch (error) { audioFailure ??= error; }
            if (audioFile) { await audioFile.close().catch(() => {}); audioFile = null; }
          }
          const videoTrack = [...tracks.values()].find(track => track.handler === 'vide');
          const recording = { id, title, createdAt, durationSeconds, width: videoTrack.width, height: videoTrack.height,
            ...(meeting ? { processing: { title, createdAt, meeting, phase: audioFailure ? 'failed' : 'pending', ...(audioFailure ? { error: 'Meeting audio could not be saved.' } : {}), audioFrames } } : {}) };
          await mutate(value, state => { state.recordings.push(recording); return state; });
          return { ...recording, path: finalPath, playable: true };
        } catch (error) { failure ??= error; await close().catch(() => {}); throw error; }
      })();
      return finishPromise;
    }
    function abort() {
      if (abortPromise) return abortPromise;
      sealed = true;
      // Preserve the synced prefix privately; it never becomes a completed recording.
      abortPromise = finishPromise ? finishPromise.then(() => {}, () => {}) : Promise.all([tail.then(() => close()).catch(() => {}), audioTail.then(() => audioFile?.close()).catch(() => {})]).then(() => {});
      return abortPromise;
    }
    return { id, appendInit, appendFragment, appendAudio, failAudio, finish, abort };
  }
  function list(ownerUserID) { return owner(ownerUserID).state.recordings.slice().reverse().map(metadata); }
  async function rename({ ownerUserID, expectedOwnerUserID, id, title, isCurrent = () => true } = {}) {
    check(ownerUserID === expectedOwnerUserID && text(ownerUserID, 1024), 'The recording owner changed.');
    check(/^[0-9a-f]{32}$/.test(id ?? '') && typeof title === 'string' && title.trim().length > 0 && title.trim().length <= 200,
      'Enter a recording title of 1 to 200 characters.');
    return withRecordingLock({ ownerUserID, id }, async () => {
      const state = await mutate(owner(ownerUserID), state => {
        check(isCurrent(), 'The account changed. Refresh your recordings.');
        const item = state.recordings.find(recording => recording.id === id);
        check(item, 'This saved recording is unavailable.');
        item.title = title.trim();
        if (item.processing) item.processing.title = item.title;
        return state;
      });
      return metadata(state.recordings.find(recording => recording.id === id));
    });
  }
  async function deleteRecording({ ownerUserID, expectedOwnerUserID, id, isCurrent = () => true, localOnlyConfirmed = false } = {}) {
    check(ownerUserID === expectedOwnerUserID && text(ownerUserID, 1024), 'The recording owner changed.');
    check(localOnlyConfirmed === true, 'Confirm that this action deletes only the local copy.');
    check(/^[0-9a-f]{32}$/.test(id ?? ''), 'Invalid local recording.');
    return withRecordingLock({ ownerUserID, id }, async () => {
      check(isCurrent(), 'The account changed. Refresh your recordings.');
      const value = owner(ownerUserID), paths = [path.join(value.dir, `${id}.mp4`), path.join(value.dir, `${id}.pcm`)];
      const staged = [];
      // Move media aside first. If the atomic library update fails, restore the files.
      try {
        for (const file of paths) {
          const temporary = `${file}.${randomBytes(12).toString('hex')}.deleting`;
          try { await io.rename(file, temporary); staged.push([file, temporary]); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        await mutate(value, state => {
          check(isCurrent(), 'The account changed. Refresh your recordings.');
          const index = state.recordings.findIndex(recording => recording.id === id);
          check(index >= 0, 'This saved recording is unavailable.');
          state.recordings.splice(index, 1);
          return state;
        });
      } catch (error) {
        for (const [file, temporary] of staged.reverse()) await io.rename(temporary, file).catch(() => {});
        throw error;
      }
      // A leftover private tombstone is never listed or processed. Surface cleanup
      // failures while keeping the deleted metadata from being resurrected.
      await Promise.all(staged.map(([, temporary]) => io.unlink(temporary)));
      return { deleted: true, localOnly: true };
    });
  }
  function getSettings(ownerUserID) { return structuredClone(owner(ownerUserID).state.settings); }
  async function saveSettings({ ownerUserID, expectedOwnerUserID, autoJoin, participantConsent, systemAudioConsent, meetingReminders, localTranscription, selection, calendarSource } = {}) {
    check(ownerUserID === expectedOwnerUserID && text(ownerUserID, 1024), 'The settings owner changed');
    check([autoJoin, participantConsent, systemAudioConsent, meetingReminders, localTranscription].every(flag => typeof flag === 'boolean')
      && typeof selection?.useAll === 'boolean' && Array.isArray(selection.ids) && selection.ids.length <= 250
      && selection.ids.every(id => text(id, 1024)), 'Invalid recording settings');
    check(!autoJoin || (participantConsent && systemAudioConsent), 'Automatic recording requires both permissions');
    const settings = { ownerUserID, ...(calendarSource==='outlook'?{calendarSource}:{}), autoJoin, participantConsent, systemAudioConsent, meetingReminders, localTranscription,
      selection: { useAll: selection.useAll, ids: [...new Set(selection.ids)] } };
    const state = await mutate(owner(ownerUserID), state => { state.settings = settings; return state; });
    return structuredClone(state.settings);
  }
  function hasCompleted({ ownerUserID, occurrenceKey } = {}) {
    check(text(occurrenceKey), 'Invalid meeting occurrence');
    return Object.hasOwn(owner(ownerUserID).state.completed, occurrenceKey);
  }
  async function markCompleted({ ownerUserID, occurrenceKey, recording } = {}) {
    check(text(occurrenceKey), 'Invalid meeting occurrence');
    const value = owner(ownerUserID);
    check(recording?.playable === true && /^[0-9a-f]{32}$/.test(recording.id ?? '')
      && recording.path === path.join(value.dir, `${recording.id}.mp4`), 'Recording does not belong to this owner');
    await mutate(value, state => {
      check(state.recordings.some(item => item.id === recording.id), 'Recording was not saved by this owner');
      if (!Object.hasOwn(state.completed, occurrenceKey)) Object.defineProperty(state.completed, occurrenceKey,
        { value: recording.id, enumerable: true, configurable: true, writable: true });
      return state;
    });
  }
  function getProcessing({ ownerUserID, id }) {
    const item = owner(ownerUserID).state.recordings.find(recording => recording.id === id);
    return item?.processing && existsSync(path.join(owner(ownerUserID).dir, `${id}.mp4`)) ? structuredClone(item.processing) : null;
  }
  function getRecordingPath({ ownerUserID, id }) {
    check(/^[0-9a-f]{32}$/.test(id ?? ''), 'Invalid recording.');
    const value = owner(ownerUserID);
    const file = path.join(value.dir, `${id}.mp4`);
    return value.state.recordings.some(recording => recording.id === id) && existsSync(file) ? file : null;
  }
  async function getShareRecord({ ownerUserID, id }) {
    check(/^[0-9a-f]{32}$/.test(id ?? ''), 'Invalid recording.');
    const value = owner(ownerUserID), item = value.state.recordings.find(recording => recording.id === id);
    const file = path.join(value.dir, `${id}.mp4`);
    if (!item?.processing?.meeting || !existsSync(file)) return null;
    const dimensions = Number.isInteger(item.width) && item.width > 0 && Number.isInteger(item.height) && item.height > 0
      ? { width: item.width, height: item.height } : await videoDimensions(file);
    return { id, title: item.title, createdAt: item.createdAt, durationSeconds: item.durationSeconds,
      ...dimensions, path: file, meeting: true, share: item.share ? structuredClone(item.share) : null };
  }
  async function bindShare({ ownerUserID, expectedOwnerUserID, id, recordingNonce, shareID, includeTranscript = false,
    access = null } = {}) {
    check(ownerUserID === expectedOwnerUserID && text(ownerUserID, 1024), 'The meeting owner changed.');
    check(/^[0-9a-f]{32}$/.test(id ?? '') && /^[0-9a-f]{32}$/.test(recordingNonce ?? '')
      && /^r2[0-9a-f]{38}$/.test(shareID ?? ''), 'Invalid meeting share binding.');
    check(access === null || (access && typeof access === 'object' && !Array.isArray(access)
      && (access.key === null || /^[0-9a-f]{32}$/.test(access.key ?? ''))
      && (access.passwordSalt === null || /^[0-9a-f]{32}$/.test(access.passwordSalt ?? ''))
      && ((access.key === null && access.passwordSalt === null) || (access.key !== null && access.passwordSalt !== null))
      && (access.expiresAt === null || (typeof access.expiresAt === 'string'
        && Number.isFinite(Date.parse(access.expiresAt))
        && new Date(access.expiresAt).toISOString().replace('.000Z', 'Z') === access.expiresAt))),
    'Invalid meeting share access settings.');
    const value = owner(ownerUserID), file = path.join(value.dir, `${id}.mp4`);
    const state = await mutate(value, state => {
      const item = state.recordings.find(recording => recording.id === id);
      check(item?.processing?.meeting
        && existsSync(file), 'This saved recording is unavailable.');
      if (item.share) {
        check(item.share.ownerUserID === ownerUserID && item.share.recordingNonce === recordingNonce
          && item.share.shareID === shareID, 'This recording is already bound to its original owner.');
      } else {
        if (includeTranscript) check(item.processing.transcriptComplete === true && item.processing.text?.trim()
          && item.processing.segments?.length, 'This recording has no finished transcript to share.');
        item.share = { ownerUserID, recordingNonce, shareID, includeTranscript: includeTranscript === true,
          ...(access ? { access: structuredClone(access) } : {}), upload: 'pending' };
      }
      return state;
    });
    return structuredClone(state.recordings.find(recording => recording.id === id).share);
  }
  async function saveShareState({ ownerUserID, expectedOwnerUserID, id, shareID, upload } = {}) {
    check(ownerUserID === expectedOwnerUserID && text(ownerUserID, 1024), 'The meeting owner changed.');
    check(/^[0-9a-f]{32}$/.test(id ?? '') && /^r2[0-9a-f]{38}$/.test(shareID ?? '')
      && (['pending', 'uploading', 'uploaded'].includes(upload) || (upload && typeof upload.failed === 'string' && upload.failed.length <= 240)),
    'Invalid meeting share state.');
    await mutate(owner(ownerUserID), state => {
      const item = state.recordings.find(recording => recording.id === id);
      check(item?.share?.ownerUserID === ownerUserID && item.share.shareID === shareID,
        'This recording is no longer bound to this account.');
      item.share.upload = structuredClone(upload); return state;
    });
  }
  async function saveShareAccessUpdate({ ownerUserID, expectedOwnerUserID, id, shareID, update } = {}) {
    check(ownerUserID === expectedOwnerUserID && text(ownerUserID, 1024), 'The meeting owner changed.');
    check(/^[0-9a-f]{32}$/.test(id ?? '') && /^r2[0-9a-f]{38}$/.test(shareID ?? ''), 'Invalid meeting share binding.');
    if (update !== null) {
      const validAccess = access => access && typeof access === 'object' && !Array.isArray(access)
        && (access.key === null || /^[0-9a-f]{32}$/.test(access.key ?? ''))
        && (access.passwordSalt === null || /^[0-9a-f]{32}$/.test(access.passwordSalt ?? ''))
        && ((access.key === null && access.passwordSalt === null) || (access.key !== null && access.passwordSalt !== null))
        && (access.expiresAt === null || (typeof access.expiresAt === 'string' && Number.isFinite(Date.parse(access.expiresAt))
          && new Date(access.expiresAt).toISOString().replace('.000Z', 'Z') === access.expiresAt));
      check(update && typeof update === 'object' && !Array.isArray(update) && validAccess(update.from) && validAccess(update.to),
        'Invalid meeting share access update.');
    }
    await mutate(owner(ownerUserID), state => {
      const item = state.recordings.find(recording => recording.id === id);
      check(item?.share?.ownerUserID === ownerUserID && item.share.shareID === shareID
        && (item.share.upload === 'uploaded' || item.share.accessUpdate),
        'This meeting does not have a published link to update.');
      if (update === null) {
        check(item.share.accessUpdate, 'There is no pending meeting access update to complete.');
        item.share.access = structuredClone(item.share.accessUpdate.to);
        delete item.share.accessUpdate;
        item.share.upload = 'uploaded';
      } else {
        item.share.accessUpdate = structuredClone(update);
        item.share.upload = { failed: 'Link settings update is incomplete. Retry to finish safely.' };
      }
      return state;
    });
  }
  function listProcessing(ownerUserID) { return owner(ownerUserID).state.recordings.filter(item => item.processing && existsSync(path.join(owner(ownerUserID).dir, `${item.id}.mp4`))).map(item => ({ id: item.id, processing: structuredClone(item.processing) })); }
  async function saveProcessing({ ownerUserID, id, processing }) {
    await mutate(owner(ownerUserID), state => { const item = state.recordings.find(recording => recording.id === id);
      check(item?.processing && existsSync(path.join(owner(ownerUserID).dir, `${id}.mp4`)), 'Recording no longer exists'); item.processing = structuredClone(processing); return state; });
  }
  function getAudioInfo({ ownerUserID, id }) {
    const value = owner(ownerUserID), item = value.state.recordings.find(recording => recording.id === id);
    check(item?.processing?.audioFrames > 0, 'Meeting audio is unavailable');
    return { path: path.join(value.dir, `${id}.pcm`), sampleRate: 16000, channels: 1, frameCount: item.processing.audioFrames };
  }
  return { begin, list, rename, deleteRecording, withRecordingLock, getRecordingPath, getSettings, saveSettings, hasCompleted, markCompleted, getProcessing, getShareRecord, bindShare, saveShareState, saveShareAccessUpdate, listProcessing, saveProcessing, getAudioInfo };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Muxer, StreamTarget } from '../../web/vendor/mp4-muxer.mjs';
import { SegmentSplitter, boxes } from '../../web/reel/fmp4.js';
import { createLocalRecordingStore } from '../src/local-recordings.mjs';

// These encoded bytes prove container structure and preservation, not decodability.
function media() {
  const out = { init: null, segments: [] };
  const splitter = new SegmentSplitter(bytes => { out.init = bytes; }, bytes => out.segments.push(bytes));
  const muxer = new Muxer({ target: new StreamTarget({ onData: (bytes, position) => splitter.write(bytes, position) }),
    fastStart: 'fragmented', minFragmentDuration: 4,
    video: { codec: 'avc', width: 640, height: 360 }, audio: { codec: 'aac', numberOfChannels: 2, sampleRate: 48000 } });
  const avcC = new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 2, 0x68, 0xee]);
  for (let i = 0; i < 270; i++) {
    const timestamp = Math.round(i * 1e6 / 30);
    muxer.addVideoChunkRaw(new Uint8Array(17).fill(i % 256), i % 120 ? 'delta' : 'key', timestamp, 33333,
      i ? undefined : { decoderConfig: { codec: 'avc1.640028', codedWidth: 640, codedHeight: 360, description: avcC } });
    muxer.addAudioChunkRaw(new Uint8Array(9).fill(i % 256), 'key', timestamp, 33333,
      i ? undefined : { decoderConfig: { codec: 'mp4a.40.2', numberOfChannels: 2, sampleRate: 48000, description: new Uint8Array([0x11, 0x90]) } });
    splitter.drain();
  }
  muxer.finalize(); splitter.drain();
  return out;
}
const encoded = media();

async function fixture(t, io) {
  const root = await mkdtemp(path.join(tmpdir(), 'reel-local-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: createLocalRecordingStore({ root, io }) };
}
async function recorded(store, ownerUserID = 'owner') {
  const writer = await store.begin({ ownerUserID, title: 'Weekly meeting', createdAt: '2026-11-06T12:00:00Z' });
  await writer.appendInit(encoded.init);
  await Promise.all(encoded.segments.map((bytes, i) => writer.appendFragment({ index: i + 1, duration: 4, bytes })));
  return writer;
}
function nestedBox(bytes, names) {
  let region = { start: 0, size: bytes.length, header: 0 };
  for (const name of names) region = boxes(bytes, region.start + region.header, region.start + region.size).find(box => box.type === name);
  return region;
}

test('streams exact fragments to an owner-generated path and persists metadata without exposing paths', async t => {
  const { root, store } = await fixture(t);
  const writer = await recorded(store, '../../owner');
  const result = await writer.finish({ durationSeconds: 9 });
  assert.strictEqual(await writer.finish({ durationSeconds: 9 }), result);
  assert.equal(result.playable, true);
  assert.match(result.id, /^[0-9a-f]{32}$/);
  assert.equal(path.dirname(path.dirname(result.path)), root);
  assert.match(path.basename(path.dirname(result.path)), /^[0-9a-f]{64}$/);
  assert.deepEqual(await readFile(result.path), Buffer.concat([encoded.init, ...encoded.segments]));
  assert.equal((await readdir(path.dirname(result.path))).some(name => name.endsWith('.partial')), false);
  assert.deepEqual(store.list('../../owner'), [{ id: result.id, title: result.title, createdAt: result.createdAt, durationSeconds: 9 }]);
  assert.deepEqual(store.list('other'), []);
  assert.deepEqual(createLocalRecordingStore({ root }).list('../../owner'), store.list('../../owner'));
});

test('rejects fragments before init, duplicated init, missing final media and oversized packets', async t => {
  const { store } = await fixture(t);
  for (const operation of [
    writer => writer.appendFragment({ index: 1, duration: 4, bytes: encoded.segments[0] }),
    async writer => { await writer.appendInit(encoded.init); await writer.appendInit(encoded.init); },
    async writer => { await writer.appendInit(encoded.init); await writer.finish({ durationSeconds: 9 }); },
    writer => writer.appendInit(new Uint8Array(16 * 1024 * 1024 + 1)),
  ]) {
    const writer = await store.begin({ ownerUserID: 'owner', title: 'Bad recording' });
    await assert.rejects(operation(writer));
    await assert.rejects(writer.finish({ durationSeconds: 9 }));
    await writer.abort(); await writer.abort();
  }
  assert.deepEqual(store.list('owner'), []);
});

test('rejects truncated/trailing boxes, sequence corruption, wrong tracks and absolute media offsets', async t => {
  const { store } = await fixture(t);
  const mutations = [
    bytes => bytes.subarray(0, bytes.length - 1),
    bytes => Buffer.concat([bytes, Buffer.from([1])]),
    bytes => { const box = nestedBox(bytes, ['moof', 'mfhd']); bytes[box.start + 15] = 9; return bytes; },
    bytes => { const box = nestedBox(bytes, ['moof', 'traf', 'tfhd']); bytes[box.start + 15] = 99; return bytes; },
    bytes => { const box = nestedBox(bytes, ['moof', 'traf', 'tfhd']); bytes[box.start + 11] |= 1; return bytes; },
    bytes => { const box = nestedBox(bytes, ['moof', 'traf', 'trun']); bytes.fill(0xff, box.start + 16, box.start + 20); return bytes; },
  ];
  for (const mutate of mutations) {
    const writer = await store.begin({ ownerUserID: 'owner', title: 'Bad recording' });
    await writer.appendInit(encoded.init);
    await assert.rejects(writer.appendFragment({ index: 1, duration: 4, bytes: mutate(Buffer.from(encoded.segments[0])) }));
    await assert.rejects(writer.finish({ durationSeconds: 9 }));
    await writer.abort();
  }
  const writer = await store.begin({ ownerUserID: 'owner', title: 'Out of order' });
  await writer.appendInit(encoded.init);
  await assert.rejects(writer.appendFragment({ index: 2, duration: 4, bytes: encoded.segments[0] }));
  await writer.abort();
});

test('requires the pinned AVC/AAC decoder configuration and forward decode times', async t => {
  const { store } = await fixture(t);
  for (const [oldType, newType] of [['avc1', 'hvc1'], ['avcC', 'junk'], ['esds', 'junk'], ['mvex', 'junk']]) {
    const writer = await store.begin({ ownerUserID: 'owner', title: 'Invalid codec' });
    const init = Buffer.from(encoded.init);
    const offset = init.indexOf(Buffer.from(oldType));
    assert.ok(offset > 0); init.write(newType, offset, 'ascii');
    await assert.rejects(writer.appendInit(init)); await writer.abort();
  }
  const writer = await store.begin({ ownerUserID: 'owner', title: 'Backwards time' });
  await writer.appendInit(encoded.init);
  await writer.appendFragment({ index: 1, duration: 4, bytes: encoded.segments[0] });
  const fragment = Buffer.from(encoded.segments[1]);
  const tfdt = nestedBox(fragment, ['moof', 'traf', 'tfdt']);
  fragment.fill(0, tfdt.start + 12, tfdt.start + 20);
  await assert.rejects(writer.appendFragment({ index: 2, duration: 4, bytes: fragment }), /backwards/);
  await writer.abort();
});

test('abort retains only a private partial prefix and queued bytes have a fixed bound', async t => {
  const { root, store } = await fixture(t);
  const writer = await store.begin({ ownerUserID: 'owner', title: 'Cancelled' });
  await writer.appendInit(encoded.init);
  await writer.abort();
  await assert.rejects(writer.finish({ durationSeconds: 9 }), /aborted/);
  await assert.rejects(writer.appendFragment({ index: 1, duration: 4, bytes: encoded.segments[0] }), /closed/);
  const [ownerDirectory] = await readdir(root);
  const partial = path.join(root, ownerDirectory, `${writer.id}.mp4.partial`);
  assert.deepEqual(await readFile(partial), Buffer.from(encoded.init));
  assert.deepEqual(store.list('owner'), []);
  const slow = await store.begin({ ownerUserID: 'owner', title: 'Queue limit' });
  const packet = new Uint8Array(16 * 1024 * 1024);
  const results = await Promise.allSettled([slow.appendInit(packet), slow.appendInit(packet), slow.appendInit(packet)]);
  assert.ok(results.every(result => result.status === 'rejected' && /cannot keep up/.test(result.reason.message)));
  await slow.abort();
});

test('handles partial writes and never completes after a failed sync', async t => {
  let writes = 0, syncs = 0;
  const partialIO = { open: async (...args) => {
    const handle = await open(...args);
    if (!String(args[0]).endsWith('.partial')) return handle;
    return { write: async (bytes, offset, length, position) => { writes++; return handle.write(bytes, offset, Math.min(length, 23), position); },
      sync: async () => { syncs++; return handle.sync(); }, close: () => handle.close() };
  } };
  const good = await fixture(t, partialIO);
  const writer = await recorded(good.store);
  const result = await writer.finish({ durationSeconds: 9 });
  assert.deepEqual(await readFile(result.path), Buffer.concat([encoded.init, ...encoded.segments]));
  assert.ok(writes > encoded.segments.length + 1);
  assert.ok(syncs >= encoded.segments.length + 2);
  const bad = await fixture(t, { open: async (...args) => {
    const handle = await open(...args);
    if (!String(args[0]).endsWith('.partial')) return handle;
    return { write: (...values) => handle.write(...values), sync: async () => { throw Error('Disk sync failed'); }, close: () => handle.close() };
  } });
  const failed = await bad.store.begin({ ownerUserID: 'owner', title: 'Disk failure' });
  await assert.rejects(failed.appendInit(encoded.init), /sync/);
  await assert.rejects(failed.finish({ durationSeconds: 9 }));
  await failed.abort();
  assert.deepEqual(bad.store.list('owner'), []);
});

test('settings and durable completion deduplication remain bound to each owner', async t => {
  const { root, store } = await fixture(t);
  assert.deepEqual(store.getSettings('owner'), { ownerUserID: 'owner', autoJoin: false, participantConsent: false,
    systemAudioConsent: false, selection: { useAll: true, ids: [] } });
  const settings = { expectedOwnerUserID: 'owner', ownerUserID: 'owner', autoJoin: true, participantConsent: true,
    systemAudioConsent: true, selection: { useAll: false, ids: ['calendar-b', 'calendar-a', 'calendar-a'] } };
  await store.saveSettings(settings);
  await assert.rejects(store.saveSettings({ ...settings, expectedOwnerUserID: 'other' }));
  assert.deepEqual(store.getSettings('owner').selection.ids, ['calendar-b', 'calendar-a']);
  assert.equal(store.getSettings('other').participantConsent, false);
  const writer = await recorded(store);
  const recording = await writer.finish({ durationSeconds: 9 });
  const entry = { ownerUserID: 'owner', occurrenceKey: 'occurrence', recording };
  assert.equal(store.hasCompleted(entry), false);
  await Promise.all([store.markCompleted(entry), store.markCompleted(entry)]);
  assert.equal(store.hasCompleted(entry), true);
  assert.equal(store.hasCompleted({ ownerUserID: 'other', occurrenceKey: 'occurrence' }), false);
  await assert.rejects(store.markCompleted({ ...entry, ownerUserID: 'other' }));
  await assert.rejects(store.markCompleted({ ...entry, recording: { ...recording, path: '/arbitrary/file.mp4' } }));
  const restarted = createLocalRecordingStore({ root });
  assert.equal(restarted.hasCompleted(entry), true);
  assert.equal(restarted.getSettings('owner').autoJoin, true);
});

test('new meeting audio and processing checkpoints survive restart with owner isolation', async t => {
  const { root, store } = await fixture(t);
  const writer = await store.begin({ ownerUserID: 'owner', title: 'Meeting', createdAt: '2026-11-06T12:00:00Z',
    meeting: { attendees: ['owner@northwind.example'], calendar: { calendar_id: 'primary', event_id: 'event' } } });
  await writer.appendInit(encoded.init);
  for (let i = 0; i < encoded.segments.length; i++) await writer.appendFragment({ index: i + 1, duration: 4, bytes: encoded.segments[i] });
  await writer.appendAudio(new Uint8Array([1, 2, 3, 4]));
  const recording = await writer.finish({ durationSeconds: 8 });
  const restored = createLocalRecordingStore({ root });
  assert.equal(restored.getAudioInfo({ ownerUserID: 'owner', id: recording.id }).frameCount, 2);
  assert.deepEqual([...await readFile(restored.getAudioInfo({ ownerUserID: 'owner', id: recording.id }).path)], [1, 2, 3, 4]);
  assert.equal(restored.getProcessing({ ownerUserID: 'other', id: recording.id }), null);
  const processing = restored.getProcessing({ ownerUserID: 'owner', id: recording.id });
  assert.equal(processing.phase, 'pending');
  await restored.saveProcessing({ ownerUserID: 'owner', id: recording.id, processing: { ...processing, phase: 'failed', error: 'Try again' } });
  assert.equal(createLocalRecordingStore({ root }).listProcessing('owner')[0].processing.error, 'Try again');
  await rm(recording.path);
  assert.equal(restored.getProcessing({ ownerUserID: 'owner', id: recording.id }), null);
  await assert.rejects(restored.saveProcessing({ ownerUserID: 'owner', id: recording.id, processing }), /no longer exists/);
});

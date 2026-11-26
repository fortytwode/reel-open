import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMeetingProcessor, pcmChunks } from '../src/meeting-processing.mjs';

const id = '0123456789abcdef0123456789abcdef';
const ownerUserID = 'owner';
const initial = () => ({ phase: 'pending', title: 'Planning', createdAt: '2026-11-10T09:00:00Z',
  meeting: { attendees: ['owner@northwind.example', 'guest@example.com'], calendar: {
    calendar_id: 'primary', event_id: 'event-1', ical_uid: 'ical-1', occurrence_start: '2026-11-10T09:00:00Z' } } });
const receipt = () => ({ verified: true, page_id: 'page-1', url: 'https://www.notion.so/page-1',
  recipients: ['owner@northwind.example'], email_status: 'confirmed', route: 'private', suppressed_duplicate: false });
const response = (data, status = 200) => ({ ok: status < 300, status, json: async () => data });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function fixture(t, { frames = 16000, fetcher } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'reel-processing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const audioPath = path.join(root, 'audio.pcm'), samples = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) samples.writeInt16LE((i % 1000) - 500, i * 2);
  await writeFile(audioPath, samples);
  let processing = initial(), profile = { userID: ownerUserID, email: 'owner@northwind.example' }, tokenProvider = async () => 'firebase-token';
  const listeners = new Set(), calls = [], writes = [];
  const auth = { getProfile: () => profile, getIdToken: () => tokenProvider(), onStateChange: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
  const store = {
    getProcessing: args => args.ownerUserID === ownerUserID && args.id === id ? structuredClone(processing) : null,
    listProcessing: owner => owner === ownerUserID && processing ? [{ id, processing: structuredClone(processing) }] : [],
    saveProcessing: async args => { assert.equal(args.ownerUserID, ownerUserID); assert.equal(args.id, id); if (!processing) throw Error('Recording deleted');
      processing = structuredClone(args.processing); writes.push(structuredClone(processing)); },
    getAudioInfo: args => { assert.equal(args.ownerUserID, ownerUserID); return { path: audioPath, sampleRate: 16000, channels: 1, frameCount: frames }; }
  };
  const defaultFetch = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.headers.Authorization, 'Bearer firebase-token');
    assert.equal(options.redirect, 'error');
    if (url.endsWith('/transcription')) return response({ text: 'Full transcript.', languages: [{ code: 'en' }], engine: 'OpenAI gpt-transcribe' });
    if (url.endsWith('/summary')) return response({ summary: 'Notes and explicit follow-ups.\n\nAction items\n- Owner: Send proposal', action_items: [{ task: 'Send proposal', owner: 'Owner', due: '' }], engine: 'OpenAI gpt-6.1-sol' });
    return response(receipt());
  };
  const processor = createMeetingProcessor({ allowedEmailDomain: 'northwind.example', speechURL:'https://speech.northwind.example', deliveryURL:'https://delivery.northwind.example', auth, store, fetch: fetcher ? (url, options) => { calls.push({ url, options }); return fetcher(url, options); } : defaultFetch });
  t.after(() => processor.dispose());
  return { processor, auth, store, calls, writes, samples,
    get: () => structuredClone(processing), set: value => { processing = structuredClone(value); },
    changeOwner: owner => { profile = owner ? { userID: owner } : null; for (const listener of listeners) listener(); },
    token: provider => { tokenProvider = provider; }, remove: () => { processor.cancel({ ownerUserID, id }); processing = null; },
    info: { path: audioPath, sampleRate: 16000, channels: 1, frameCount: frames } };
}

test('streams each PCM16 frame once across quiet boundaries with a bounded final chunk', async t => {
  const f = await fixture(t, { frames: 361 * 16000 + 17 });
  const pieces = [], frames = [];
  for await (const chunk of pcmChunks(f.info)) {
    const bytes = Buffer.from(await chunk.audio.arrayBuffer());
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF'); assert.equal(bytes.readUInt32LE(24), 16000);
    assert.ok(bytes.length <= 180 * 16000 * 2 + 44);
    pieces.push(bytes.subarray(44)); frames.push([chunk.startFrame, chunk.endFrame]);
  }
  assert.deepEqual(Buffer.concat(pieces), f.samples);
  assert.equal(frames[0][0], 0); assert.equal(frames.at(-1)[1], f.info.frameCount);
  for (let i = 1; i < frames.length; i++) assert.equal(frames[i - 1][1], frames[i][0]);
  assert.ok(frames.at(-1)[1] - frames.at(-1)[0] >= 16000);
});

test('persists transcript, summary, verified receipt and authoritative calendar identity in order', async t => {
  const f = await fixture(t);
  const first = f.processor.process({ ownerUserID, id });
  assert.equal(f.processor.process({ ownerUserID, id }), first);
  const result = await first;
  assert.equal(result.phase, 'completed'); assert.deepEqual(result.receipt, receipt());
  assert.equal(result.timingGranularity, 'chunk'); assert.equal(result.transcriptComplete, true);
  assert.equal(f.calls.length, 3);
  const delivered = JSON.parse(f.calls[2].options.body);
  assert.equal(delivered.id, '01234567-89ab-cdef-0123-456789abcdef');
  assert.deepEqual(delivered.calendar, initial().meeting.calendar);
  assert.equal(delivered.summary, 'Notes and explicit follow-ups.\n\nAction items\n- Owner: Send proposal');
  assert.equal(delivered.summary.match(/Send proposal/g).length, 1);
  assert.equal(delivered.segments[0].text, 'Full transcript.');
  assert.ok(f.writes.findIndex(p => p.transcriptComplete) < f.writes.findIndex(p => p.summary));
  await f.processor.process({ ownerUserID, id }); assert.equal(f.calls.length, 3);
});

test('summary failure preserves completed transcript and retry sends no audio again', async t => {
  let fail = true;
  const f = await fixture(t, { fetcher: async url => url.endsWith('/transcription')
    ? response({ text: 'Saved transcript', engine: 'OpenAI gpt-transcribe' })
    : url.endsWith('/summary') ? fail ? response({}, 503) : response({ summary: 'Saved notes', engine: 'OpenAI gpt-6.1-sol' }) : response(receipt()) });
  await assert.rejects(f.processor.process({ ownerUserID, id }), /503/);
  assert.equal(f.get().text, 'Saved transcript'); assert.equal(f.get().transcriptComplete, true);
  assert.equal(f.get().failedPhase, 'summarizing'); assert.equal(f.get().phase, 'failed');
  fail = false;
  await f.processor.resume();
  assert.equal(f.get().phase, 'failed'); // Automatic resume does not loop a known failure.
  await f.processor.process({ ownerUserID, id });
  assert.equal(f.get().phase, 'completed');
  assert.equal(f.calls.filter(call => call.url.endsWith('/transcription')).length, 1);
});

test('delivery uncertainty retries identical identity and content without repeating notes', async t => {
  let first = true;
  const payloads = [];
  const f = await fixture(t, { fetcher: async (url, options) => {
    if (url.endsWith('/transcription')) return response({ text: 'Transcript', engine: 'OpenAI gpt-transcribe' });
    if (url.endsWith('/summary')) return response({ summary: 'Notes', engine: 'OpenAI gpt-6.1-sol' });
    payloads.push(options.body);
    if (first) { first = false; throw Error('Lost receipt'); }
    return response({ ...receipt(), suppressed_duplicate: true });
  } });
  await assert.rejects(f.processor.process({ ownerUserID, id }), /Lost receipt/);
  assert.equal(f.get().summary, 'Notes'); assert.equal(f.get().failedPhase, 'delivering');
  await f.processor.process({ ownerUserID, id });
  assert.equal(f.get().receipt.suppressed_duplicate, true); assert.equal(payloads[0], payloads[1]);
  assert.equal(f.calls.length, 4);
});

test('a changed owner during token refresh cannot send or persist new processing results', async t => {
  const f = await fixture(t), token = deferred(), waiting = deferred();
  f.token(() => { waiting.resolve(); return token.promise; });
  const operation = f.processor.process({ ownerUserID, id });
  await waiting.promise;
  const before = f.writes.length;
  f.changeOwner('other'); token.resolve('stale-owner-token');
  assert.equal(await operation, null);
  assert.equal(f.calls.length, 0); assert.equal(f.writes.length, before);
  await f.processor.resume(); assert.equal(f.calls.length, 0);
});

test('deletion while a service response is pending cannot resurrect a job or send summary/delivery', async t => {
  const reply = deferred(), started = deferred();
  const f = await fixture(t, { fetcher: async () => { started.resolve(); return reply.promise; } });
  const operation = f.processor.process({ ownerUserID, id });
  await started.promise; f.remove();
  reply.resolve(response({ text: 'Late transcript', engine: 'OpenAI gpt-transcribe' }));
  assert.equal(await operation, null); assert.equal(f.get(), null); assert.equal(f.calls.length, 1);
  await f.processor.resume(); assert.equal(f.calls.length, 1);
});

test('restart resumes only explicitly registered owner jobs and preserves completed transcription', async t => {
  const f = await fixture(t);
  f.set({ ...initial(), phase: 'summarizing', transcriptComplete: true, nextFrame: 16000,
    text: 'Durable transcript', segments: [{ start: 0, end: 1, text: 'Durable transcript' }] });
  f.processor.dispose();
  const restarted = createMeetingProcessor({ allowedEmailDomain: 'northwind.example', speechURL:'https://speech.northwind.example', deliveryURL:'https://delivery.northwind.example', auth: f.auth, store: f.store, fetch: async url => url.endsWith('/summary')
    ? response({ summary: 'Notes after restart', engine: 'OpenAI gpt-6.1-sol' }) : response(receipt()) });
  t.after(() => restarted.dispose());
  await restarted.resume();
  assert.equal(f.get().phase, 'completed'); assert.equal(f.get().summary, 'Notes after restart');
  assert.equal(f.get().text, 'Durable transcript');
});

test('unverified delivery remains visible and retryable, and no-speech recordings do not deliver', async t => {
  const f = await fixture(t, { fetcher: async url => url.endsWith('/transcription')
    ? response({ text: 'Transcript', engine: 'OpenAI gpt-transcribe' }) : url.endsWith('/summary')
      ? response({ summary: 'Notes', engine: 'OpenAI gpt-6.1-sol' }) : response({ ...receipt(), email_status: 'pending' }) });
  await assert.rejects(f.processor.process({ ownerUserID, id }), /not confirmed/);
  assert.equal(f.get().phase, 'failed'); assert.equal(f.get().summary, 'Notes'); assert.equal(f.get().receipt, undefined);
  const silent = await fixture(t, { fetcher: async () => response({ text: '', engine: 'OpenAI gpt-transcribe' }) });
  await silent.processor.process({ ownerUserID, id });
  assert.equal(silent.get().noSpeech, true); assert.equal(silent.calls.length, 1);
});

test('interrupted transcription resumes at the durable next frame without resending its saved prefix', async t => {
  let transcription = 0;
  const chunks = [];
  const f = await fixture(t, { frames: 181 * 16000, fetcher: async (url, options) => {
    if (url.endsWith('/transcription')) {
      chunks.push(Buffer.from(await options.body.get('audio').arrayBuffer()).subarray(44));
      transcription++;
      if (transcription === 2) return response({}, 503);
      return response({ text: transcription === 1 ? 'First saved chunk' : 'Remaining audio', engine: 'OpenAI gpt-transcribe' });
    }
    return url.endsWith('/summary') ? response({ summary: 'Complete notes', engine: 'OpenAI gpt-6.1-sol' }) : response(receipt());
  } });
  await assert.rejects(f.processor.process({ ownerUserID, id }), /503/);
  const next = f.get().nextFrame;
  assert.ok(next > 0 && next < f.info.frameCount);
  assert.equal(f.get().segments.length, 1);
  await f.processor.process({ ownerUserID, id });
  assert.deepEqual(chunks[1], chunks[2]);
  assert.deepEqual(Buffer.concat([chunks[0], chunks[2]]), f.samples);
  assert.equal(f.get().text, 'First saved chunk Remaining audio');
});

test('returning owner queues a fresh run while its cancelled request is still settling', async t => {
  const started = deferred(), staleReply = deferred();
  let calls = 0;
  const f = await fixture(t, { fetcher: async url => {
    calls++;
    if (calls === 1) { started.resolve(); return staleReply.promise; }
    if (url.endsWith('/transcription')) return response({ text: 'Fresh owner transcript', engine: 'OpenAI gpt-transcribe' });
    if (url.endsWith('/summary')) return response({ summary: 'Fresh notes', engine: 'OpenAI gpt-6.1-sol' });
    return response(receipt());
  } });
  const cancelledRun = f.processor.process({ ownerUserID, id });
  await started.promise;
  f.changeOwner('other'); f.changeOwner(ownerUserID);
  const resumedRun = f.processor.process({ ownerUserID, id });
  assert.notEqual(resumedRun, cancelledRun);
  staleReply.resolve(response({ text: 'Stale transcript', engine: 'OpenAI gpt-transcribe' }));
  assert.equal(await cancelledRun, null);
  await resumedRun;
  assert.equal(f.get().phase, 'completed'); assert.equal(f.get().text, 'Fresh owner transcript');
  assert.equal(calls, 4);
});

test('long meeting PCM metadata is accepted without a three-hour limit', async t => {
  const f = await fixture(t);
  // Metadata passes duration validation; the intentionally short fixture then
  // fails the exact file-size check before any allocation or network request.
  await assert.rejects(async () => {
    for await (const chunk of pcmChunks({ ...f.info, frameCount: 4 * 60 * 60 * 16000 })) void chunk;
  }, /audio is incomplete/);
});

test('a pasted-link recording reconciles delivery only to the signed-in owner', async t => {
  let deliverToExtraRecipient = true;
  const f = await fixture(t, { fetcher: async (url, options) => {
    if (url.endsWith('/transcription')) return response({ text: 'A transcript', engine: 'OpenAI gpt-transcribe' });
    if (url.endsWith('/summary')) return response({ summary: 'A summary', engine: 'OpenAI gpt-6.1-sol' });
    const body = JSON.parse(options.body);
    assert.equal(body.calendar, null);
    assert.deepEqual(body.attendees, []);
    return response({ ...receipt(), recipients: deliverToExtraRecipient
      ? ['owner@northwind.example', 'other@northwind.example'] : ['owner@northwind.example'] });
  } });
  f.set({ ...initial(), meeting: { calendar: null, attendees: ['ignored@northwind.example'] } });
  await assert.rejects(f.processor.process({ ownerUserID, id }), /delivery was not confirmed/);
  assert.equal(f.get().phase, 'failed');
  deliverToExtraRecipient = false;
  const result = await f.processor.process({ ownerUserID, id });
  assert.equal(result.phase, 'completed');
  assert.deepEqual(result.receipt.recipients, ['owner@northwind.example']);
});

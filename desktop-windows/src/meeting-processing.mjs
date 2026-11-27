import { open } from 'node:fs/promises';

import { internalEmail } from '../../web/reel/organization.js';
import { summarizeLocally } from './local-extractive-summary.mjs';
const RATE = 16_000, CHUNK_FRAMES = 180 * RATE, SEARCH_FRAMES = 10 * RATE, WINDOW = 320;
const ID = /^[0-9a-f]{32}$/;
const check = (value, message) => { if (!value) throw Error(message); };
const cancelled = () => Object.assign(Error('Meeting processing was cancelled.'), { name: 'AbortError' });

function wav(bytes) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + bytes.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36);
  header.writeUInt32LE(bytes.length, 40);
  return new Blob([header, bytes], { type: 'audio/wav' });
}

/** Bounded PCM reader. getAudioInfo supplies the trusted owner-bound path; callers
 * must never pass a renderer-selected path here. Every source frame is sent once.
 * Timings describe approximate chunk boundaries, not word-aligned timestamps. */
export async function* pcmChunks(info, { startFrame = 0, signal } = {}) {
  check(info?.sampleRate === RATE && info.channels === 1 && Number.isSafeInteger(info.frameCount)
    && info.frameCount > 0
    && Number.isSafeInteger(startFrame) && startFrame >= 0 && startFrame <= info.frameCount,
  'Meeting audio has an invalid format or duration.');
  const file = await open(info.path, 'r');
  try {
    const stat = await file.stat();
    check(stat.isFile() && stat.size === info.frameCount * 2, 'Meeting audio is incomplete.');
    for (let start = startFrame; start < info.frameCount;) {
      if (signal?.aborted) throw cancelled();
      const frames = Math.min(CHUNK_FRAMES, info.frameCount - start), bytes = Buffer.alloc(frames * 2);
      // A short filesystem read is not EOF. Fill the entire intended chunk.
      for (let offset = 0; offset < bytes.length;) {
        if (signal?.aborted) throw cancelled();
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, start * 2 + offset);
        check(bytesRead > 0, 'Could not read all meeting audio.'); offset += bytesRead;
      }
      let count = frames;
      if (start + frames < info.frameCount) {
        const high = Math.min(frames, info.frameCount - start - RATE);
        let energy = Infinity, best = high;
        for (let pos = frames - SEARCH_FRAMES; pos + WINDOW <= high; pos += WINDOW) {
          let sum = 0;
          for (let i = pos; i < pos + WINDOW; i++) { const sample = bytes.readInt16LE(i * 2); sum += sample * sample; }
          if (sum < energy) { energy = sum; best = pos + WINDOW / 2; }
        }
        count = best;
      }
      check(count > 0, 'Could not create a meeting audio chunk.');
      yield { startFrame: start, endFrame: start + count, audio: wav(bytes.subarray(0, count * 2)) };
      start += count;
    }
  } finally { await file.close(); }
}

/** Convert only the known PCM16LE WAV chunks produced above into Whisper's 16 kHz float input. */
export async function whisperSamples(blob) {
  const bytes=Buffer.from(await blob.arrayBuffer());
  check(bytes.length>=44&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,16)==='WAVEfmt '
    &&bytes.readUInt16LE(20)===1&&bytes.readUInt16LE(22)===1&&bytes.readUInt32LE(24)===RATE
    &&bytes.readUInt16LE(34)===16&&bytes.toString('ascii',36,40)==='data'&&bytes.readUInt32LE(40)===bytes.length-44,
  'Meeting audio has an invalid local transcription format.');
  const samples=new Float32Array((bytes.length-44)/2);
  for(let i=0;i<samples.length;i++)samples[i]=bytes.readInt16LE(44+i*2)/32768;
  return samples;
}

function deliveryID(id) { return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`; }
function calendarContext(meeting) {
  if (meeting?.calendar) return meeting.calendar;
  if (!meeting?.calendarID || meeting.calendarID === 'manual') return null;
  return { calendar_id: meeting.calendarID, ...(meeting.eventID ? { event_id: meeting.eventID } : {}),
    ...(meeting.iCalUID ? { ical_uid: meeting.iCalUID } : {}), occurrence_start: meeting.start };
}
function receiptOK(value, domain, onlyRecipient = null) {
  if (value?.verified !== true || value.email_status !== 'confirmed' || typeof value.page_id !== 'string'
    || !value.page_id || !Array.isArray(value.recipients) || value.recipients.some(email => !internalEmail(email, domain))) return false;
  if (onlyRecipient && (value.recipients.length !== 1 || value.recipients[0].toLowerCase() !== onlyRecipient)) return false;
  try { const url = new URL(value.url); return url.protocol === 'https:' && ['notion.so', 'www.notion.so', 'app.notion.com'].includes(url.hostname); }
  catch { return false; }
}

/** Main-process only. Store getters are synchronous, owner-bound snapshots:
 * getProcessing({ownerUserID,id}) -> checkpoint|null;
 * listProcessing(ownerUserID) -> [{id,processing}]; getAudioInfo({ownerUserID,id})
 * -> {path,sampleRate:16000,channels:1,frameCount} for finalized PCM16LE only.
 * saveProcessing({ownerUserID,id,processing}) must atomically reject deleted or
 * missing recordings. It must never recreate a recording. Initial checkpoints
 * contain {title,createdAt,meeting:{attendees,calendar},phase:'pending'} and are
 * created only for newly authorized meetings, never by scanning legacy files.
 * Retries preserve transcript/summary and replay the same delivery identity.
 */
export function createMeetingProcessor({ auth, store, fetch: fetcher = globalThis.fetch,
  speechURL, deliveryURL, allowedEmailDomain, requestTimeoutMS = 180_000,
  localTranscribe, modeForOwner = () => 'cloud' } = {}) {
  check(typeof auth?.getProfile === 'function' && typeof auth?.getIdToken === 'function'
    && typeof auth?.onStateChange === 'function' && typeof store?.getProcessing === 'function'
    && typeof store?.saveProcessing === 'function' && typeof store?.listProcessing === 'function'
    && typeof store?.getAudioInfo === 'function' && typeof fetcher === 'function', 'Invalid meeting processor dependencies.');
  for (const url of [speechURL, deliveryURL]) check(new URL(url).protocol === 'https:', 'Meeting services must use HTTPS.');
  check(typeof modeForOwner==='function'&&(localTranscribe===undefined||typeof localTranscribe==='function'),'Invalid local transcription dependencies.');
  const jobs = new Map(), listeners = new Set();
  let queue = Promise.resolve(), disposed = false;
  function snapshot(ownerUserID, id) {
    const value = store.getProcessing({ ownerUserID, id });
    check(!value || typeof value.then !== 'function', 'Processing lookup must be synchronous.');
    return value;
  }
  function requireCurrent(ownerUserID, id, controller) {
    if (disposed || controller.signal.aborted || auth.getProfile()?.userID !== ownerUserID || !snapshot(ownerUserID, id)) throw cancelled();
  }
  function emit(ownerUserID, id, processing) {
    if (auth.getProfile()?.userID !== ownerUserID) return;
    for (const listener of listeners) { try { listener({ ownerUserID, id, processing: structuredClone(processing) }); } catch {} }
  }
  async function save(ownerUserID, id, controller, processing) {
    requireCurrent(ownerUserID, id, controller);
    await store.saveProcessing({ ownerUserID, id, processing: structuredClone(processing) });
    requireCurrent(ownerUserID, id, controller);
    emit(ownerUserID, id, processing);
  }
  async function request(ownerUserID, id, controller, url, body, headers = {}) {
    requireCurrent(ownerUserID, id, controller);
    const token = await auth.getIdToken();
    requireCurrent(ownerUserID, id, controller); // Token refresh may switch or remove the owner.
    check(typeof token === 'string' && token.length > 0, 'Sign in as the meeting owner to continue.');
    const response = await fetcher(url, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${token}`, ...headers },
      body, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(requestTimeoutMS)]) });
    requireCurrent(ownerUserID, id, controller);
    const data = await response.json().catch(() => ({}));
    requireCurrent(ownerUserID, id, controller);
    // Service text can contain provider details; keep the durable error local and bounded.
    check(response.ok, `Meeting service returned HTTP ${response.status}. Retry to reconcile safely.`);
    return data;
  }
  async function run(ownerUserID, id, controller, requestedMode) {
    let processing;
    try {
      requireCurrent(ownerUserID, id, controller);
      processing = structuredClone(snapshot(ownerUserID, id));
      const meeting = processing.meeting ?? {}, title = String(processing.title ?? meeting.title ?? 'Meeting');
      const manualRecording = meeting.manual === true;
      if (requestedMode !== undefined) check(manualRecording && ['local','cloud'].includes(requestedMode), 'Invalid manual transcription mode.');
      if (requestedMode && processing.transcriptionMode && requestedMode !== processing.transcriptionMode)
        throw Error('This recording already has a saved transcription mode. Retry with that mode.');
      const transcriptionMode=processing.transcriptionMode??requestedMode??(processing.phase==='pending'&&!processing.nextFrame?modeForOwner(ownerUserID):'cloud');
      check(transcriptionMode==='cloud'||transcriptionMode==='local','Meeting transcription mode is invalid.');
      if(transcriptionMode==='local')check(typeof localTranscribe==='function','Local transcription is unavailable in this build.');
      const calendar = calendarContext(meeting);
      const onlyRecipient = calendar ? null : auth.getProfile()?.email?.toLowerCase();
      check(calendar || internalEmail(onlyRecipient, allowedEmailDomain), 'Sign in with your team account to deliver your recap.');
      if (receiptOK(processing.receipt, allowedEmailDomain, onlyRecipient)) return processing;
      const attendees = calendar ? [...new Set((meeting.attendees ?? meeting.attendeeEmails ?? []).filter(x => typeof x === 'string'))] : [];
      check(Number.isFinite(Date.parse(processing.createdAt)), 'Meeting start time is missing.');
      if (!processing.transcriptComplete) {
        const info = store.getAudioInfo({ ownerUserID, id });
        const segments = processing.segments ?? [];
        let nextFrame = processing.nextFrame ?? 0;
        check(Array.isArray(segments) && (nextFrame === 0 || segments.length || processing.transcribedFrames === nextFrame), 'Meeting transcript checkpoint is invalid.');
        processing = { ...processing, transcriptionMode, phase: 'transcribing', error: null, segments, nextFrame };
        await save(ownerUserID, id, controller, processing);
        for await (const chunk of pcmChunks(info, { startFrame: nextFrame, signal: controller.signal })) {
          requireCurrent(ownerUserID, id, controller);
          let result,text;
          if(transcriptionMode==='local'){
            result=await localTranscribe({ownerUserID,id,samples:await whisperSamples(chunk.audio),language:processing.language??'en',signal:controller.signal});
            requireCurrent(ownerUserID,id,controller);
            check(typeof result?.text==='string'&&result.engine==='Whisper large-v3-turbo q8','Local meeting transcription returned an invalid response.');
            text=result.text.trim();
            const duration=(chunk.endFrame-chunk.startFrame)/RATE;
            const segments=(Array.isArray(result.chunks)?result.chunks:[]).map(segment=>{
              const [start,end]=segment.timestamp??[];
              return {start:Number.isFinite(start)?Math.max(0,Math.min(duration,start)):0,
                end:Number.isFinite(end)&&end>start?Math.min(duration,end):duration,text:String(segment.text??'').trim()};
            }).filter(segment=>segment.text);
            if(segments.length)processing.segments.push(...segments.map(segment=>({...segment,start:segment.start+chunk.startFrame/RATE,end:segment.end+chunk.startFrame/RATE})));
            else if(text)processing.segments.push({start:chunk.startFrame/RATE,end:chunk.endFrame/RATE,text});
          }else{
            const form = new FormData(); form.set('audio', chunk.audio, 'meeting.wav'); form.set('language', processing.language ?? 'en');
            form.set('title', title.slice(0, 200));
            const keywords = ['Notion', 'Fireflies', 'Sybill', ...attendees.map(email => email.split('@')[0].replace(/[._+-]/g, ' '))];
            form.set('keywords', JSON.stringify([...new Set(keywords)].slice(0, 50).map(word => word.slice(0, 80))));
            if (processing.text) form.set('previous_text', processing.text.slice(-1000));
            result = await request(ownerUserID, id, controller, speechURL + '/transcription', form);
            check(typeof result.text === 'string' && result.engine === 'OpenAI gpt-transcribe', 'Meeting transcription returned an invalid response.');
            text = result.text.trim();
            if (text) processing.segments.push({ start: chunk.startFrame / RATE, end: chunk.endFrame / RATE, text });
          }
          processing = { ...processing, text: processing.segments.map(segment => segment.text).join(' '),
            nextFrame: chunk.endFrame, transcribedFrames: chunk.endFrame, language: result.languages?.[0]?.code ?? result.language ?? processing.language ?? 'en',
            engine: result.engine, timingGranularity: transcriptionMode==='local'?'segment':'chunk' };
          await save(ownerUserID, id, controller, processing);
        }
        processing = { ...processing, transcriptComplete: true };
        await save(ownerUserID, id, controller, processing);
      }
      if (manualRecording) {
        processing = { ...processing, phase: 'completed', transcriptOnly: true,
          ...(transcriptionMode === 'local' ? { localOnly: true } : { localOnly: false }),
          noSpeech: !processing.text?.trim(), error: null };
        await save(ownerUserID, id, controller, processing);
        return processing;
      }
      if(transcriptionMode==='local'){
        const lastSegment=(processing.segments??[]).at(-1);
        const duration=Number.isSafeInteger(processing.transcribedFrames)?processing.transcribedFrames/RATE:
          (Number.isFinite(lastSegment?.end)?Math.max(0,lastSegment.end):0);
        const summary=summarizeLocally(processing.segments??[],duration);
        const hasSummary=Boolean(summary.suggestedTitle||summary.summary||summary.chapters.length);
        processing={...processing,phase:'completed',localOnly:true,summary:summary.summary,
          suggestedTitle:summary.suggestedTitle,chapters:summary.chapters,
          summaryEngine:hasSummary?'extractive-local':null,actionItems:[],noSpeech:!processing.text?.trim(),error:null};
        await save(ownerUserID,id,controller,processing);
        return processing;
      }
      if (!processing.text?.trim()) {
        processing = { ...processing, phase: 'completed', error: null, noSpeech: true, ...(transcriptionMode==='local'?{localOnly:true}:{}) };
        await save(ownerUserID, id, controller, processing); return processing;
      }
      if (!processing.summary) {
        check(processing.text.length <= 200_000, 'The full transcript exceeds the supported summary size.');
        processing = { ...processing, phase: 'summarizing', error: null };
        await save(ownerUserID, id, controller, processing);
        const summary = await request(ownerUserID, id, controller, speechURL + '/summary',
          JSON.stringify({ text: processing.text, title: title.slice(0, 200), attendees }), { 'Content-Type': 'application/json' });
        check(typeof summary.summary === 'string' && summary.summary.trim() && summary.engine === 'OpenAI gpt-6.1-sol', 'Meeting summary returned an invalid response.');
        processing = { ...processing, summary: summary.summary, summaryEngine: summary.engine, actionItems: summary.action_items ?? [] };
        await save(ownerUserID, id, controller, processing);
      }
      processing = { ...processing, phase: 'delivering', error: null };
      await save(ownerUserID, id, controller, processing);
      const receipt = await request(ownerUserID, id, controller, deliveryURL + '/delivery/complete', JSON.stringify({ id: deliveryID(id), title,
        started_at: processing.createdAt, attendees, summary: processing.summary, segments: processing.segments,
        calendar }), { 'Content-Type': 'application/json' });
      check(receiptOK(receipt, allowedEmailDomain, onlyRecipient), 'Meeting delivery was not confirmed. Retry to reconcile safely.');
      processing = { ...processing, phase: 'completed', receipt, error: null };
      await save(ownerUserID, id, controller, processing);
      return processing;
    } catch (cause) {
      if (controller.signal.aborted || disposed || auth.getProfile()?.userID !== ownerUserID || !snapshot(ownerUserID, id)) return null;
      if (processing) {
        const failedPhase = processing.phase;
        processing = { ...processing, phase: 'failed', failedPhase, error: String(cause.message ?? 'Meeting processing failed.').slice(0, 500) };
        await save(ownerUserID, id, controller, processing);
      }
      throw cause;
    }
  }
  function process({ ownerUserID, id, transcriptionMode } = {}) {
    check(ID.test(id ?? '') && typeof ownerUserID === 'string' && ownerUserID.length > 0, 'Invalid meeting processing owner or recording.');
    if (snapshot(ownerUserID,id)?.meeting?.manual)
      check(['local','cloud'].includes(transcriptionMode),'Choose a transcription mode for this recording.');
    const key = JSON.stringify([ownerUserID, id]);
    if (jobs.has(key) && !jobs.get(key).controller.signal.aborted) return jobs.get(key).promise;
    const controller = new AbortController();
    requireCurrent(ownerUserID, id, controller);
    const execute = () => run(ownerUserID, id, controller, transcriptionMode);
    const promise = queue.catch(() => {}).then(() => store.withRecordingLock
      ? store.withRecordingLock({ ownerUserID, id }, execute) : execute()).finally(() => {
      // A cancelled job may have a replacement queued behind it. Its cleanup
      // must not remove that replacement's cancellation or deduplication entry.
      if (jobs.get(key)?.controller === controller) jobs.delete(key);
    });
    jobs.set(key, { ownerUserID, id, controller, promise }); queue = promise;
    return promise;
  }
  function cancel({ ownerUserID, id } = {}) {
    for (const job of jobs.values()) if ((!ownerUserID || job.ownerUserID === ownerUserID) && (!id || job.id === id)) job.controller.abort();
  }
  async function resume() {
    const ownerUserID = auth.getProfile()?.userID;
    if (!ownerUserID || disposed) return [];
    const pending = store.listProcessing(ownerUserID).filter(({ processing }) => processing
      && processing.meeting?.manual !== true
      && !['completed', 'failed'].includes(processing.phase) && !receiptOK(processing.receipt, allowedEmailDomain));
    return Promise.allSettled(pending.map(({ id }) => process({ ownerUserID, id })));
  }
  const unsubscribe = auth.onStateChange(() => {
    const owner = auth.getProfile()?.userID;
    for (const job of jobs.values()) if (job.ownerUserID !== owner) job.controller.abort();
  });
  function dispose() { disposed = true; cancel(); unsubscribe?.(); listeners.clear(); }
  function onStateChange(listener) { check(typeof listener === 'function', 'Invalid processing listener.'); listeners.add(listener); return () => listeners.delete(listener); }
  return { process, resume, cancel, dispose, onStateChange };
}

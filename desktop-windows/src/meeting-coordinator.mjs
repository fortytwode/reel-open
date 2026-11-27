import { createHash, randomUUID } from 'node:crypto';
import { meetingRoomIdentity, parseMeetingURL } from './google-calendar.mjs';

const MAX_LATENESS_MS = 5 * 60_000;
const PASTED_LINK_LIMIT_MS = 3 * 60 * 60_000;
const RETRY_DELAY_MS = 30_000;
const MAX_ATTEMPTS = 3;
const RETRYABLE = new Set(['busy', 'timed_out', 'chrome_unavailable', 'dedicated_window_unavailable']);
const NATIVE_FAILURES = new Set(['busy', 'timed_out', 'chrome_unavailable', 'dedicated_window_unavailable',
  'ambiguous_window', 'manual_required', 'sign_in_required', 'denied', 'awaiting_admission',
  'cancelled', 'invalid_join', 'duplicate_request']);
const SESSION_ID = /^[0-9a-f]{32}$/;
const HWND = /^[1-9][0-9]*$/;

const publicState = state => ({ ...state });
const timeOf = value => Date.parse(value);
const entryKey = (ownerUserID, occurrenceKey) => `${Buffer.byteLength(ownerUserID)}:${ownerUserID}${occurrenceKey}`;

/**
 * Main-process-only, caller-driven coordinator. Call refresh() when calendar
 * data/settings change and tick() about every 20 seconds while the app is awake.
 *
 * Inject:
 * - auth: getProfile(), onStateChange(listener) -> unsubscribe
 * - calendar: discover({auth,selection,now,signal}) -> owner-bound snapshot
 * - native: join({url,consentConfirmed:true,signal}), inspect(sessionId), close(sessionId)
 *   (join bridge must map AbortSignal to the native cancel operation)
 * - recorder: start({hwnd,pid,meeting,ownerUserID,systemAudio:true,microphone,signal})
 *   -> opaque handle; stop(handle) -> {path,playable:true}. The adapter must
 *   release tracks immediately on abort even if start has not resolved.
 * - getSettings() -> {ownerUserID,autoJoin,participantConsent,
 *   systemAudioConsent,selection:{useAll:boolean,ids:string[]}}
 * - hasCompleted({ownerUserID,occurrenceKey}) and
 *   markCompleted({ownerUserID,occurrenceKey,recording}) persistence callbacks.
 *
 * Scheduled joins consume calendar URLs. Pasted links require explicit consent
 * and an owner-bound routing check. Only native join supplies the HWND. The
 * public state omits URLs and HWNDs. `capturing` follows recorder startup and
 * `completed` follows persistence of the saved recording.
 */
export function createMeetingCoordinator({ auth, calendar, native, recorder, getSettings,
  hasCompleted, markCompleted, now = () => new Date() } = {}) {
  if (typeof auth?.getProfile !== 'function' || typeof auth?.onStateChange !== 'function'
    || typeof calendar?.discover !== 'function' || typeof native?.join !== 'function'
    || typeof native?.inspect !== 'function' || typeof native?.close !== 'function'
    || typeof recorder?.start !== 'function' || typeof recorder?.stop !== 'function'
    || typeof getSettings !== 'function' || typeof hasCompleted !== 'function'
    || typeof markCompleted !== 'function' || typeof now !== 'function') throw TypeError('Invalid meeting coordinator dependencies');

  let state = { phase: 'idle', ownerUserID: null, meetingId: null, attempts: 0, reason: null };
  let snapshot = null;
  let refreshController = null;
  let joinController = null;
  let active = null;
  let stopPromise = null;
  let tickPromise = null;
  let manualJoinPromise = null;
  let pastedMeeting = null;
  let generation = 0;
  let refreshSequence = 0;
  let disposed = false;
  const entries = new Map();
  const unresolvedSessions = new Set();
  const listeners = new Set();
  const emit = next => {
    if (unresolvedSessions.size && next.phase !== 'close_required')
      next = { ...next, phase: 'close_required', reason: 'owned_window_close_required' };
    state = { ...state, ...next };
    for (const listener of listeners) { try { listener(publicState(state)); } catch { /* listener isolation */ } }
  };

  function clock() {
    const date = now();
    const value = date instanceof Date ? date.getTime() : new Date(date).getTime();
    if (!Number.isFinite(value)) throw TypeError('Invalid coordinator clock');
    return value;
  }
  function settingsKey(settings) {
    const selection = settings?.selection;
    if (typeof settings?.ownerUserID !== 'string' || typeof settings.autoJoin !== 'boolean'
      || typeof settings.participantConsent !== 'boolean' || typeof settings.systemAudioConsent !== 'boolean'
      || typeof selection?.useAll !== 'boolean' || !Array.isArray(selection.ids)
      || selection.ids.some(id => typeof id !== 'string')) return null;
    return JSON.stringify({ ownerUserID: settings.ownerUserID, calendarSource:settings.calendarSource, autoJoin: settings.autoJoin,
      participantConsent: settings.participantConsent, systemAudioConsent: settings.systemAudioConsent,
      selection: { useAll: selection.useAll, ids: [...new Set(selection.ids)].sort() } });
  }
  function eligibility(pasted = false) {
    let profile, settings;
    try { profile = auth.getProfile(); settings = getSettings(); } catch { return null; }
    const key = settingsKey(settings);
    if (!profile?.userID || !profile.email || !key || settings.ownerUserID !== profile.userID) return null;
    if (!pasted && ((profile.calendarConnected !== true && settings.calendarSource !== 'outlook') || !settings.participantConsent || !settings.systemAudioConsent))
      return null;
    return { ownerUserID: profile.userID, email: profile.email.toLowerCase(), settings, key };
  }
  function occurrence(meeting) {
    const link = parseMeetingURL(meeting?.joinURL);
    const start = timeOf(meeting?.start), end = timeOf(meeting?.end);
    if (!link || !Number.isFinite(start) || !Number.isFinite(end) || end <= start
      || typeof meeting?.id !== 'string' || !meeting.id || typeof meeting?.calendarID !== 'string' || !meeting.calendarID) return null;
    const url = new URL(link.url);
    // Mirrors ReelCore/MeetingJoinCoordinator.swift: duplicate calendar copies
    // of one call share a key; query passcodes remain in the native join URL.
    const key = createHash('sha256').update(`${url.hostname}${url.pathname}:${start / 1000}`).digest('hex');
    return { meeting, link, key, start, end };
  }
  function currentOccurrence(key, pasted) {
    if (pasted) return snapshot?.pasted?.key === key ? snapshot.pasted : null;
    return snapshot?.meetings.map(occurrence).find(item => item?.key === key);
  }
  function stillEligible(owner, key, occurrenceKey, pasted) {
    const current = eligibility(pasted);
    if (!current || current.ownerUserID !== owner || current.key !== key) return false;
    if (!snapshot || snapshot.ownerUserID !== owner || snapshot.ownerEmail !== current.email || snapshot.settingsKey !== key) return false;
    const meeting = currentOccurrence(occurrenceKey, pasted);
    return !!meeting && clock() < meeting.end;
  }
  async function closeNative(sessionId) {
    if (!SESSION_ID.test(sessionId ?? '')) return true;
    let result;
    try { result = await native.close(sessionId); } catch { result = null; }
    // `released` means the helper saw navigation away and relinquished this
    // window without touching unrelated content. Pending/failed stays owned.
    if ((result?.ok === true && ['closed', 'already_closed'].includes(result.state))
      || result?.state === 'released') {
      unresolvedSessions.delete(sessionId);
      return true;
    }
    unresolvedSessions.add(sessionId);
    emit({ phase: 'close_required', reason: 'owned_window_close_required' });
    return false;
  }

  function invalidate(reason = 'cancelled') {
    generation++;
    refreshController?.abort();
    joinController?.abort();
    snapshot = null;
    pastedMeeting = null;
    if (active) return stopActive(reason);
    if (!joinController) emit({ phase: 'idle', ownerUserID: null, meetingId: null, reason });
    return Promise.resolve();
  }

  async function stopActive(reason) {
    if (stopPromise) return stopPromise;
    if (!active) return;
    const capture = active;
    const scopedKey = entryKey(capture.ownerUserID, capture.key);
    const failClosed = reason => {
      const entry = entries.get(scopedKey) ?? { attempts: 0 };
      entry.terminal = true;
      entries.set(scopedKey, entry);
      emit({ phase: 'save_failed', reason });
    };
    emit({ phase: 'saving', ownerUserID: capture.ownerUserID, meetingId: capture.meeting.id, reason });
    stopPromise = (async () => {
      let recording;
      try { recording = await recorder.stop(capture.handle); }
      catch { failClosed('recording_save_failed'); return; }
      finally { await closeNative(capture.sessionId); }
      if (!recording || recording.playable !== true || typeof recording.path !== 'string' || !recording.path) {
        failClosed('recording_save_failed'); return;
      }
      try { await markCompleted({ ownerUserID: capture.ownerUserID, occurrenceKey: capture.key, recording }); }
      catch { failClosed('completion_save_failed'); return; }
      const entry = entries.get(scopedKey) ?? { attempts: 0 };
      entry.completed = true;
      entries.set(scopedKey, entry);
      emit({ phase: 'completed', ownerUserID: capture.ownerUserID, meetingId: capture.meeting.id,
        attempts: entry.attempts, reason });
    })();
    try { await stopPromise; }
    finally {
      active = null;
      stopPromise = null;
      if (capture.pasted) pastedMeeting = null;
    }
  }

  async function refresh({ manual = false } = {}) {
    if (disposed) return;
    let eligible = eligibility(Boolean(pastedMeeting));
    if (!eligible) { await invalidate('not_enabled'); return; }
    if (!eligible.settings.autoJoin && !manual && !active && !joinController && !manualJoinPromise) return;
    if (snapshot && (snapshot.ownerUserID !== eligible.ownerUserID || snapshot.ownerEmail !== eligible.email
      || snapshot.settingsKey !== eligible.key)) {
      await invalidate('settings_changed');
      eligible = eligibility(Boolean(pastedMeeting));
      if (!eligible) return;
    }
    const refreshVersion = ++refreshSequence;
    const cancellationVersion = generation;
    refreshController?.abort();
    const controller = new AbortController();
    refreshController = controller;
    const { ownerUserID, email, settings, key } = eligible;
    const pasted = pastedMeeting;
    let result;
    try { result = await calendar.discover({ auth, selection: settings.selection, now: new Date(clock()),
      signal: controller.signal, ...(pasted ? { pastedLink: pasted.link } : {}) }); }
    catch {
      if (refreshController !== controller || disposed || controller.signal.aborted
        || refreshVersion !== refreshSequence || cancellationVersion !== generation) return;
      await invalidate('calendar_unavailable');
      emit({ phase: active ? 'saving' : 'calendar_unavailable', ownerUserID, reason: 'calendar_unavailable' });
      throw new Error('Could not refresh eligible calendar meetings.');
    }
    if (refreshController !== controller || disposed || controller.signal.aborted
      || refreshVersion !== refreshSequence || cancellationVersion !== generation) return;
    const current = eligibility(Boolean(pasted));
    if (!current || current.ownerUserID !== ownerUserID || current.email !== email || current.key !== key
      || result?.ownerUserID !== ownerUserID || !Array.isArray(result.meetings)) {
      await invalidate('account_changed');
      return;
    }
    const meetings = result.meetings.filter(item => occurrence(item));
    const failedKey = ['failed', 'save_failed'].includes(state.phase) && state.ownerUserID === ownerUserID
      ? occurrence(snapshot?.meetings.find(item => item.id === state.meetingId))?.key : null;
    snapshot = { ownerUserID, ownerEmail: email, settingsKey: key, meetings,
      pasted: pasted && pastedMeeting === pasted && result.pastedLinkAllowed === true ? pasted : null };
    if (active) {
      const current = currentOccurrence(active.key, active.pasted);
      if (!current) await stopActive('calendar_ineligible');
      else {
        active.end = current.end;
        if (clock() >= active.end) await stopActive('meeting_deadline');
      }
    }
    if (joinController && !currentOccurrence(joinController.occurrenceKey, joinController.pasted)) joinController.abort();
    // A refresh must not advertise readiness for an occurrence that already
    // failed and will not be retried. Keep its actionable status until it ends
    // or disappears; tick can still start a different eligible meeting.
    const currentFailure = failedKey && meetings.find(item => occurrence(item)?.key === failedKey && timeOf(item.end) > clock());
    if (!active && !joinController && currentFailure) emit({ ...state, meetingId: currentFailure.id });
    if (!active && !joinController && !currentFailure) emit({ phase: eligible.settings.autoJoin && meetings.length ? 'scheduled' : 'idle', ownerUserID,
      meetingId: null, attempts: 0, reason: null });
  }

  async function attempt(item, eligible, { manual = false, microphone = false } = {}) {
    const { meeting, link, key, pasted, end } = item;
    const scopedKey = entryKey(eligible.ownerUserID, key);
    const entry = entries.get(scopedKey) ?? { attempts: 0, retryAfter: 0, terminal: false, completed: false };
    entry.attempts++;
    entries.set(scopedKey, entry);
    const controller = new AbortController();
    controller.occurrenceKey = key;
    controller.pasted = pasted;
    joinController = controller;
    const version = generation;
    emit({ phase: 'joining', ownerUserID: eligible.ownerUserID, meetingId: meeting.id, attempts: entry.attempts, reason: null });
    let result, captureHandle, nativeSessionId;
    try {
      try { result = await native.join({ url: link.url, consentConfirmed: true, signal: controller.signal }); }
      catch (cause) {
        // The bridge may discover a late joined window while cancelling and
        // fail to close it before returning. Retain only that typed owned ID.
        if (cause?.code === 'owned_window_close_required' && SESSION_ID.test(cause.sessionId ?? ''))
          nativeSessionId = cause.sessionId;
        throw cause;
      }
      const sessionId = result?.sessionId;
      if (SESSION_ID.test(sessionId ?? '')) nativeSessionId = sessionId;
      if (controller.signal.aborted || generation !== version || !stillEligible(eligible.ownerUserID, eligible.key, key, pasted)) {
        await closeNative(nativeSessionId);
        if (state.phase === 'joining' && state.ownerUserID === eligible.ownerUserID)
          emit({ phase: 'cancelled', reason: 'eligibility_changed' });
        return;
      }
      if (result?.ok !== true || result.state !== 'joined' || !nativeSessionId
        || !HWND.test(String(result.hwnd ?? '')) || String(result.hwnd).length > 20
        || !Number.isSafeInteger(result.pid) || result.pid <= 0) {
        await closeNative(nativeSessionId);
        const reason = NATIVE_FAILURES.has(result?.state) ? result.state : 'join_failed';
        if (!manual && RETRYABLE.has(reason) && entry.attempts < MAX_ATTEMPTS) {
          entry.retryAfter = clock() + RETRY_DELAY_MS;
          emit({ phase: 'retry_wait', reason });
        } else { entry.terminal = true; emit({ phase: 'failed', reason }); }
        return;
      }
      const startOperation = Promise.resolve().then(() => recorder.start({ hwnd: String(result.hwnd), pid: result.pid, meeting,
        ownerUserID: eligible.ownerUserID, systemAudio: true, microphone: manual && microphone, signal: controller.signal }));
      let abortListener;
      const aborted = new Promise(resolve => {
        abortListener = () => resolve({ cancelled: true });
        if (controller.signal.aborted) abortListener();
        else controller.signal.addEventListener('abort', abortListener, { once: true });
      });
      const outcome = await Promise.race([
        startOperation.then(handle => ({ handle }), cause => ({ cause })), aborted
      ]);
      controller.signal.removeEventListener('abort', abortListener);
      if (outcome.cancelled) {
        // Cancellation cannot wait on an adapter that never settles. If it
        // returns a handle later, stop and save that owned partial capture.
        void startOperation.then(async handle => {
          if (!handle) return;
          try {
            const recording = await recorder.stop(handle);
            if (recording?.playable === true && typeof recording.path === 'string' && recording.path) {
              await markCompleted({ ownerUserID: eligible.ownerUserID, occurrenceKey: key, recording });
              entry.completed = true;
            }
          } catch { /* no completion claim */ }
          entry.terminal = true;
        }, () => {});
        await closeNative(nativeSessionId);
        if (state.phase === 'joining' && state.ownerUserID === eligible.ownerUserID)
          emit({ phase: 'cancelled', reason: 'eligibility_changed' });
        return;
      }
      if (outcome.cause) throw outcome.cause;
      captureHandle = outcome.handle;
      if (!captureHandle) throw Error('No capture handle');
      if (controller.signal.aborted || generation !== version || !stillEligible(eligible.ownerUserID, eligible.key, key, pasted)) {
        try {
          const recording = await recorder.stop(captureHandle);
          if (recording?.playable === true && typeof recording.path === 'string' && recording.path)
            await markCompleted({ ownerUserID: eligible.ownerUserID, occurrenceKey: key, recording });
        } catch { /* do not claim completion */ }
        entry.terminal = true;
        await closeNative(nativeSessionId);
        if (state.phase === 'joining' && state.ownerUserID === eligible.ownerUserID)
          emit({ phase: 'cancelled', reason: 'eligibility_changed' });
        return;
      }
      active = { handle: captureHandle, sessionId: nativeSessionId, ownerUserID: eligible.ownerUserID, key, meeting, end, pasted };
      emit({ phase: 'capturing', reason: null });
    } catch (error) {
      if (captureHandle) { try { await recorder.stop(captureHandle); } catch { /* no completion claim */ } }
      await closeNative(nativeSessionId);
      if (controller.signal.aborted || generation !== version) {
        if (state.phase === 'joining' && state.ownerUserID === eligible.ownerUserID)
          emit({ phase: 'cancelled', reason: 'eligibility_changed' });
      }
      else {
        entry.terminal = true;
        const reason = error?.code === 'microphone_unavailable' ? error.code : 'join_or_capture_failed';
        emit({ phase: 'failed', reason });
      }
    } finally {
      if (joinController === controller) joinController = null;
    }
  }

  async function tickImpl() {
    if (stopPromise) { await stopPromise; return; }
    if (unresolvedSessions.size) {
      for (const sessionId of [...unresolvedSessions]) await closeNative(sessionId);
      if (!unresolvedSessions.size) {
        const current = eligibility();
        emit({ phase: !disposed && snapshot && current?.settings.autoJoin ? 'scheduled' : 'idle',
          ownerUserID: current?.ownerUserID ?? null, meetingId: null, reason: null });
      }
      return;
    }
    if (disposed) return;
    const eligible = eligibility(Boolean(pastedMeeting));
    if (!eligible || (snapshot && (snapshot.ownerUserID !== eligible.ownerUserID
      || snapshot.ownerEmail !== eligible.email || snapshot.settingsKey !== eligible.key))) {
      await invalidate('eligibility_changed'); return;
    }
    if (active) {
      if (!currentOccurrence(active.key, active.pasted)) {
        await stopActive('calendar_ineligible'); return;
      }
      if (clock() >= active.end) { await stopActive('meeting_deadline'); return; }
      const capture = active;
      let inspected;
      try { inspected = await native.inspect(capture.sessionId); } catch { inspected = null; }
      if (active !== capture || stopPromise) return;
      if (!stillEligible(capture.ownerUserID, snapshot?.settingsKey, capture.key, capture.pasted)
        || inspected?.ok !== true || inspected.state !== 'in_call')
        await stopActive(inspected?.state === 'left' ? 'meeting_left' : 'meeting_uncertain');
      return;
    }
    if (joinController || manualJoinPromise || !snapshot || !eligible.settings.autoJoin) return;
    const instant = clock();
    const candidates = snapshot.meetings.map(occurrence).filter(Boolean)
      .sort((a, b) => a.start - b.start || a.key.localeCompare(b.key));
    for (const item of candidates) {
      if (instant < item.start || instant > item.start + MAX_LATENESS_MS || instant >= item.end) continue;
      const scopedKey = entryKey(eligible.ownerUserID, item.key);
      const entry = entries.get(scopedKey);
      if (entry?.terminal || entry?.completed || entry?.attempts >= MAX_ATTEMPTS || instant < (entry?.retryAfter ?? 0)) continue;
      let persisted;
      try {
        persisted = hasCompleted({ ownerUserID: eligible.ownerUserID, occurrenceKey: item.key });
        if (typeof persisted !== 'boolean') throw TypeError('Completion lookup must be synchronous');
      }
      catch { emit({ phase: 'failed', reason: 'completion_lookup_failed' }); return; }
      if (persisted) { entries.set(scopedKey, { ...entry, completed: true }); continue; }
      await attempt(item, eligible);
      return;
    }
  }
  function tick() {
    if (tickPromise) return tickPromise;
    tickPromise = tickImpl();
    return tickPromise.finally(() => { tickPromise = null; });
  }
  async function joinMeeting({ meetingId, ownerUserID, url, participantsConfirmed, microphone = false }) {
    const isPasted = url !== undefined;
    const eligible = eligibility(isPasted);
    if (!eligible || eligible.ownerUserID !== ownerUserID)
      throw Error(isPasted ? 'Sign in to record a meeting from a link.' : 'Connect your calendar and confirm recording permissions before joining.');
    if (disposed || active || joinController || manualJoinPromise || stopPromise || unresolvedSessions.size)
      throw Error('Finish the current meeting action before joining another meeting.');
    if (isPasted) {
      if (participantsConfirmed !== true) throw Error('Confirm that participants agreed to record this meeting.');
      const link = parseMeetingURL(typeof url === 'string' ? url.trim() : url);
      if (!link) throw Error('Use a direct Google Meet, Zoom or Teams meeting link.');
      const instant = clock();
      pastedMeeting = { ...occurrence({ id: randomUUID(), calendarID: 'manual', title: 'Meeting',
        start: new Date(instant).toISOString(), end: new Date(instant + PASTED_LINK_LIMIT_MS).toISOString(),
        joinURL: link.url, platform: link.platform, attendeeEmails: [], calendar: null }), pasted: true,
        ownerUserID: eligible.ownerUserID, ownerEmail: eligible.email };
    }
    const version = generation;
    const previous = snapshot;
    const operation = (async () => {
      // Recheck the selected calendar and cloud ownership before opening Chrome.
      await refresh({ manual: true });
      if (generation !== version) throw Error('Your account or recording settings changed. Refresh and try again.');
      if (snapshot === previous) throw Error('Could not verify meeting availability. Refresh and try again.');
      let item;
      if (isPasted) {
        item = snapshot?.pasted;
        if (!item) throw Error('This meeting link is unavailable for local recording. Check Reel Notetaker or try again.');
        const room = meetingRoomIdentity(item.link), instant = clock();
        const listed = snapshot.meetings.map(occurrence).filter(candidate => candidate
          && candidate.start <= instant && instant < candidate.end && meetingRoomIdentity(candidate.link) === room);
        if (listed.length === 1) {
          // Both entry points identify one calendar occurrence. A pasted link still delivers only to its owner.
          item = { ...item, key: listed[0].key, end: listed[0].end };
          pastedMeeting = item;
          snapshot.pasted = item;
        }
      } else item = snapshot?.meetings.map(occurrence).find(candidate => candidate?.meeting.id === meetingId);
      if (!item || !stillEligible(ownerUserID, eligible.key, item.key, item.pasted))
        throw Error('This meeting is no longer available for local recording. Refresh your meetings.');
      if (hasCompleted({ ownerUserID, occurrenceKey: item.key }) !== false)
        throw Error('This meeting has already been recorded.');
      await attempt(item, eligible, { manual: true, microphone: microphone === true });
    })();
    manualJoinPromise = operation;
    try { await operation; }
    finally {
      manualJoinPromise = null;
      if (!active?.pasted) pastedMeeting = null;
    }
  }
  async function cancel() {
    await invalidate('cancelled');
    if (tickPromise) await tickPromise;
    if (manualJoinPromise) await manualJoinPromise.catch(() => {});
  }
  async function cancelJoin(ownerUserID) {
    if (state.phase !== 'joining' || state.ownerUserID !== ownerUserID || !joinController) return;
    const entry = entries.get(entryKey(ownerUserID, joinController.occurrenceKey));
    if (entry) entry.terminal = true;
    await cancel();
  }
  function onStateChange(listener) {
    if (typeof listener !== 'function') throw TypeError('listener must be a function');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
  const unsubscribe = auth.onStateChange(() => {
    const eligible = eligibility(Boolean(pastedMeeting));
    if (!eligible || (pastedMeeting && (pastedMeeting.ownerUserID !== eligible.ownerUserID || pastedMeeting.ownerEmail !== eligible.email))
      || (snapshot && (snapshot.ownerUserID !== eligible.ownerUserID
        || snapshot.ownerEmail !== eligible.email || snapshot.settingsKey !== eligible.key))) {
      void invalidate('account_changed');
    }
  });
  async function dispose() {
    disposed = true;
    unsubscribe?.();
    await cancel();
    if (unresolvedSessions.size) throw new Error('The owned meeting window still needs to be closed.');
  }
  return { refresh, tick, joinMeeting, cancelJoin, cancel, dispose, getState: () => publicState(state), onStateChange };
}

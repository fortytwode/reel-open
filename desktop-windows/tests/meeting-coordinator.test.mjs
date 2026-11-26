import test from 'node:test';
import assert from 'node:assert/strict';
import { createMeetingCoordinator } from '../src/meeting-coordinator.mjs';

const start = Date.parse('2026-11-06T12:00:00Z');
const email = 'owner@northwind.example';
const meeting = (extra = {}) => ({ id: 'meeting-1', calendarID: 'calendar-1', title: 'Planning',
  start: new Date(start).toISOString(), end: new Date(start + 30 * 60_000).toISOString(),
  joinURL: 'https://meet.google.com/abc-defg-hij', platform: 'google_meet', attendeeEmails: [email], organizer: email, ...extra });
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tickLoop = () => new Promise(resolve => setImmediate(resolve));

function fixture(overrides = {}) {
  let time = start;
  let profile = { userID: 'firebase-owner', email, calendarConnected: true };
  let settings = { ownerUserID: 'firebase-owner', autoJoin: true, participantConsent: true,
    systemAudioConsent: true, selection: { useAll: true, ids: [] } };
  let meetings = [meeting()];
  const authListeners = new Set();
  const auth = { getProfile: () => profile, onStateChange: listener => { authListeners.add(listener); return () => authListeners.delete(listener); } };
  const calls = { discover: [], join: [], inspect: [], close: [], start: [], stop: [], complete: [] };
  const completed = new Set();
  let inspectState = 'in_call';
  const calendar = { discover: overrides.discover ?? (async args => {
    calls.discover.push(args);
    return { ownerUserID: profile.userID, calendars: [{ id: 'calendar-1', title: 'Calendar', primary: true }], meetings, fetchedAt: new Date(time).toISOString() };
  }) };
  const native = {
    join: overrides.join ?? (async args => { calls.join.push(args); return { ok: true, state: 'joined', sessionId: 'a'.repeat(32), hwnd: '12345', pid: 99 }; }),
    inspect: overrides.inspect ?? (async id => { calls.inspect.push(id); return { ok: true, state: inspectState }; }),
    close: overrides.close ?? (async id => { calls.close.push(id); return { ok: true, state: 'closed' }; })
  };
  const recorder = {
    start: overrides.start ?? (async args => { calls.start.push(args); return { captureId: 1 }; }),
    stop: overrides.stop ?? (async handle => { calls.stop.push(handle); return { path: 'private-recording.mp4', playable: true }; })
  };
  const coordinator = createMeetingCoordinator({ auth, calendar, native, recorder,
    getSettings: () => settings,
    hasCompleted: ({ ownerUserID, occurrenceKey }) => completed.has(`${ownerUserID}:${occurrenceKey}`),
    markCompleted: overrides.markCompleted ?? (({ ownerUserID, occurrenceKey, recording }) => { calls.complete.push({ ownerUserID, occurrenceKey, recording }); completed.add(`${ownerUserID}:${occurrenceKey}`); }),
    now: () => new Date(time) });
  return { coordinator, calls, auth, native, recorder, setTime: next => { time = next; },
    setMeetings: next => { meetings = next; }, setSettings: next => { settings = { ...settings, ...next }; },
    setProfile: next => { profile = next; for (const listener of authListeners) listener(profile); },
    setInspect: next => { inspectState = next; }, completed };
}

test('scheduled join starts exact owned window capture only after native joined result', async () => {
  const f = fixture();
  await f.coordinator.refresh();
  assert.equal(f.coordinator.getState().phase, 'scheduled');
  await f.coordinator.tick();
  assert.equal(f.coordinator.getState().phase, 'capturing');
  assert.equal(f.calls.join.length, 1);
  assert.deepEqual(f.calls.start[0].hwnd, '12345');
  assert.deepEqual(f.calls.start[0].pid, 99);
  assert.equal(f.calls.start[0].systemAudio, true);
  assert.equal(f.calls.start[0].microphone, false);
  assert.ok(f.calls.start[0].signal instanceof AbortSignal);
  assert.equal(f.calls.complete.length, 0);
  assert.equal(JSON.stringify(f.coordinator.getState()).includes('abc-defg-hij'), false);
  assert.equal(JSON.stringify(f.coordinator.getState()).includes('12345'), false);
});

test('stopping at event deadline saves before completion and persists owner-scoped dedup', async () => {
  const gate = deferred();
  const f = fixture({ stop: () => gate.promise });
  await f.coordinator.refresh(); await f.coordinator.tick();
  f.setTime(start + 30 * 60_000);
  const stopping = f.coordinator.tick(); await tickLoop();
  assert.equal(f.coordinator.getState().phase, 'saving');
  assert.equal(f.calls.complete.length, 0);
  gate.resolve({ path: 'private-recording.mp4', playable: true });
  await stopping;
  assert.equal(f.coordinator.getState().phase, 'completed');
  assert.equal(f.calls.complete.length, 1);
  assert.equal(f.calls.complete[0].ownerUserID, 'firebase-owner');
  assert.equal(f.calls.close.length, 1);
  await f.coordinator.tick();
  assert.equal(f.calls.join.length, 1);
});

test('native left state stops and saves; unknown joined shape never starts capture', async () => {
  const f = fixture();
  await f.coordinator.refresh(); await f.coordinator.tick();
  f.setInspect('left'); await f.coordinator.tick();
  assert.equal(f.coordinator.getState().phase, 'completed');
  assert.equal(f.calls.stop.length, 1);
  const malformed = fixture({ join: async () => ({ ok: true, state: 'joined', sessionId: 'invalid', hwnd: '0', pid: 0 }) });
  await malformed.coordinator.refresh(); await malformed.coordinator.tick();
  assert.equal(malformed.calls.start.length, 0);
  assert.notEqual(malformed.coordinator.getState().phase, 'capturing');
});

test('account switch cancels a pending join, closes a late owned session, and never captures', async () => {
  const gate = deferred(); let args;
  const f = fixture({ join: input => { args = input; return gate.promise; } });
  await f.coordinator.refresh();
  const pending = f.coordinator.tick(); await tickLoop();
  f.setProfile({ userID: 'other-owner', email: 'other@northwind.example', calendarConnected: true });
  assert.equal(args.signal.aborted, true);
  gate.resolve({ ok: true, state: 'joined', sessionId: 'b'.repeat(32), hwnd: '456', pid: 100 });
  await pending;
  assert.equal(f.calls.start.length, 0);
  assert.deepEqual(f.calls.close, ['b'.repeat(32)]);
  assert.notEqual(f.coordinator.getState().phase, 'capturing');
});

test('owner change during capture startup saves the partial recording without a joined claim', async () => {
  const gate = deferred();
  const f = fixture({ start: () => gate.promise });
  await f.coordinator.refresh();
  const pending = f.coordinator.tick(); await tickLoop();
  f.setProfile({ userID: 'other-owner', email: 'other@northwind.example', calendarConnected: true });
  gate.resolve({ captureId: 2 });
  await pending;
  assert.notEqual(f.coordinator.getState().phase, 'capturing');
  assert.equal(f.calls.stop.length, 1);
  assert.equal(f.calls.complete.length, 1);
  assert.equal(f.calls.complete[0].ownerUserID, 'firebase-owner');
});

test('cancel and dispose return promptly while recorder start stalls, then save a late handle', async () => {
  for (const method of ['cancel', 'dispose']) {
    const gate = deferred(); let startSignal;
    const f = fixture({ start: args => { startSignal = args.signal; return gate.promise; } });
    await f.coordinator.refresh();
    const pending = f.coordinator.tick(); await tickLoop();
    await Promise.race([f.coordinator[method](), new Promise((_, reject) => setTimeout(() => reject(Error('cancellation stalled')), 100))]);
    await pending;
    assert.equal(startSignal.aborted, true);
    gate.resolve({ captureId: 3 });
    await tickLoop(); await tickLoop();
    assert.equal(f.calls.stop.length, 1);
    assert.equal(f.calls.complete.length, 1);
    assert.notEqual(f.coordinator.getState().phase, 'capturing');
  }
});

test('ordinary calendar polling while native join is pending preserves the valid attempt', async () => {
  const gate = deferred(); let signal;
  const f = fixture({ join: args => { signal = args.signal; return gate.promise; } });
  await f.coordinator.refresh();
  const pending = f.coordinator.tick(); await tickLoop();
  await f.coordinator.refresh();
  assert.equal(signal.aborted, false);
  gate.resolve({ ok: true, state: 'joined', sessionId: 'c'.repeat(32), hwnd: '789', pid: 101 });
  await pending;
  assert.equal(f.coordinator.getState().phase, 'capturing');
  assert.equal(f.calls.start.length, 1);
});

test('a native join that finishes at the current occurrence deadline never starts capture', async () => {
  for (const updatedDeadline of [false, true]) {
    const gate = deferred();
    const f = fixture({ join: () => gate.promise });
    const phases = []; f.coordinator.onStateChange(state => phases.push(state.phase));
    await f.coordinator.refresh();
    const pending = f.coordinator.tick(); await tickLoop();
    const deadline = start + (updatedDeadline ? 60_000 : 30 * 60_000);
    if (updatedDeadline) {
      f.setMeetings([meeting({ end:new Date(deadline).toISOString() })]);
      await f.coordinator.refresh();
    }
    f.setTime(deadline);
    gate.resolve({ ok:true, state:'joined', sessionId:'b'.repeat(32), hwnd:'456', pid:100 });
    await pending;
    assert.equal(f.calls.start.length, 0, 'An expired occurrence must not acquire recording devices');
    assert.deepEqual(f.calls.close, ['b'.repeat(32)]);
    assert.equal(phases.includes('capturing'), false);
  }
});

test('capture startup that finishes at the current deadline saves its partial without becoming active', async () => {
  const gate = deferred(), handle = {captureId:4};
  const f = fixture({ start: () => gate.promise });
  const phases = []; f.coordinator.onStateChange(state => phases.push(state.phase));
  await f.coordinator.refresh();
  const pending = f.coordinator.tick(); await tickLoop();
  f.setTime(start + 30 * 60_000);
  gate.resolve(handle); await pending;
  assert.deepEqual(f.calls.stop, [handle]);
  assert.equal(f.calls.complete.length, 1);
  assert.deepEqual(f.calls.close, ['a'.repeat(32)]);
  assert.equal(phases.includes('capturing'), false);
});

test('account or consent changes during capture stop and save the owned partial recording', async () => {
  const f = fixture();
  await f.coordinator.refresh(); await f.coordinator.tick();
  f.setSettings({ participantConsent: false });
  await f.coordinator.cancel();
  assert.equal(f.calls.stop.length, 1);
  assert.equal(f.calls.complete.length, 1);
  assert.notEqual(f.coordinator.getState().phase, 'capturing');
  const g = fixture(); await g.coordinator.refresh(); await g.coordinator.tick();
  g.setProfile({ userID: 'other-owner', email: 'other@northwind.example', calendarConnected: true });
  await tickLoop(); await tickLoop();
  assert.equal(g.calls.stop.length, 1);
});

test('changing selected calendars stops capture before the next discovery finishes', async () => {
  const gate = deferred(); let calls = 0;
  const f = fixture({ discover: async () => {
    calls++;
    if (calls === 2) return gate.promise;
    return { ownerUserID: 'firebase-owner', meetings: [meeting()] };
  } });
  await f.coordinator.refresh(); await f.coordinator.tick();
  f.setSettings({ selection: { useAll: false, ids: ['calendar-2'] } });
  const pending = f.coordinator.refresh();
  await tickLoop();
  assert.equal(f.calls.stop.length, 1);
  gate.resolve({ ownerUserID: 'firebase-owner', meetings: [] });
  await pending;
  assert.notEqual(f.coordinator.getState().phase, 'capturing');
});

test('refresh tracks a same-occurrence shortened or extended deadline', async () => {
  const f = fixture();
  await f.coordinator.refresh(); await f.coordinator.tick();
  f.setMeetings([meeting({ end: new Date(start + 60 * 60_000).toISOString() })]);
  await f.coordinator.refresh();
  f.setTime(start + 31 * 60_000); await f.coordinator.tick();
  assert.equal(f.coordinator.getState().phase, 'capturing');
  f.setMeetings([meeting({ end: new Date(start + 32 * 60_000).toISOString() })]);
  await f.coordinator.refresh();
  f.setTime(start + 32 * 60_000); await f.coordinator.tick();
  assert.equal(f.coordinator.getState().phase, 'completed');
});

test('calendar refresh preserves manual intervention failure without retrying, until the occurrence ends or disappears', async () => {
  for (const expiry of ['ended', 'removed']) {
    let joins = 0;
    const f = fixture({ join: async () => { joins++; return { ok: false, state: 'manual_required' }; } });
    await f.coordinator.refresh(); await f.coordinator.tick();
    await f.coordinator.refresh(); await f.coordinator.tick();
    assert.equal(f.coordinator.getState().phase, 'failed');
    assert.equal(f.coordinator.getState().reason, 'manual_required');
    assert.equal(joins, 1);
    assert.equal(f.calls.start.length, 0);
    f.setMeetings([meeting({ id: 'duplicate-calendar-copy', calendarID: 'calendar-2' })]);
    await f.coordinator.refresh(); await f.coordinator.refresh(); await f.coordinator.tick();
    assert.equal(f.coordinator.getState().phase, 'failed');
    assert.equal(f.coordinator.getState().reason, 'manual_required');
    assert.equal(joins, 1);
    if (expiry === 'ended') f.setTime(start + 30 * 60_000);
    else f.setMeetings([]);
    await f.coordinator.refresh();
    assert.notEqual(f.coordinator.getState().phase, 'failed');
  }
});

test('attempt history is scoped to the owner, so another account can join its own occurrence', async () => {
  let joins = 0;
  const f = fixture({ join: async () => {
    joins++;
    return joins === 1 ? { ok: false, state: 'manual_required' }
      : { ok: true, state: 'joined', sessionId: 'd'.repeat(32), hwnd: '888', pid: 8 };
  } });
  await f.coordinator.refresh(); await f.coordinator.tick();
  assert.equal(f.coordinator.getState().phase, 'failed');
  f.setProfile({ userID: 'second-owner', email: 'second@northwind.example', calendarConnected: true });
  f.setSettings({ ownerUserID: 'second-owner' });
  await f.coordinator.refresh(); await f.coordinator.tick();
  assert.equal(joins, 2);
  assert.equal(f.coordinator.getState().phase, 'capturing');
});

test('late wake skips, duplicate links join once, and retries wait thirty seconds with at most three attempts', async () => {
  const late = fixture(); late.setTime(start + 5 * 60_000 + 1);
  await late.coordinator.refresh(); await late.coordinator.tick();
  assert.equal(late.calls.join.length, 0);
  let attempts = 0;
  const retry = fixture({ join: async () => { attempts++; return { ok: false, state: 'timed_out' }; } });
  retry.setMeetings([meeting(), meeting({ id: 'duplicate', calendarID: 'another-calendar' })]);
  await retry.coordinator.refresh(); await retry.coordinator.tick();
  assert.equal(attempts, 1);
  retry.setTime(start + 29_000); await retry.coordinator.tick(); assert.equal(attempts, 1);
  retry.setTime(start + 30_000); await retry.coordinator.tick(); assert.equal(attempts, 2);
  retry.setTime(start + 60_000); await retry.coordinator.tick(); assert.equal(attempts, 3);
  retry.setTime(start + 90_000); await retry.coordinator.tick(); assert.equal(attempts, 3);
});

test('ineligible calendar refresh and revoked access stop capture; no stale snapshot is used', async () => {
  const f = fixture(); await f.coordinator.refresh(); await f.coordinator.tick();
  f.setMeetings([]); await f.coordinator.refresh();
  assert.equal(f.calls.stop.length, 1);
  const revoked = fixture({ discover: async () => { throw Error('provider payload private'); } });
  await assert.rejects(revoked.coordinator.refresh(), /calendar|refresh/i);
  await revoked.coordinator.tick();
  assert.equal(revoked.calls.join.length, 0);
});

test('unsafe calendar URL and recorder failure do not claim joined or completed', async () => {
  const unsafe = fixture(); unsafe.setMeetings([meeting({ joinURL: 'https://attacker.example/join' })]);
  await unsafe.coordinator.refresh(); await unsafe.coordinator.tick();
  assert.equal(unsafe.calls.join.length, 0);
  const failed = fixture({ start: async () => { throw Error('private recorder payload'); } });
  await failed.coordinator.refresh(); await failed.coordinator.tick();
  assert.equal(failed.calls.complete.length, 0);
  assert.notEqual(failed.coordinator.getState().phase, 'capturing');
  assert.equal(failed.calls.close.length, 1);
});

test('save or completion persistence failure never claims completion or auto-rejoins', async () => {
  for (const overrides of [
    { stop: async () => { throw Error('private disk detail'); } },
    { markCompleted: async () => { throw Error('private storage detail'); } }
  ]) {
    let joins = 0;
    const f = fixture({ ...overrides, join: async () => { joins++; return { ok: true, state: 'joined', sessionId: 'e'.repeat(32), hwnd: '54321', pid: 54 }; } });
    await f.coordinator.refresh(); await f.coordinator.tick();
    f.setTime(start + 30 * 60_000);
    await f.coordinator.tick();
    assert.equal(f.coordinator.getState().phase, 'save_failed');
    assert.equal(f.calls.complete.length, 0);
    f.setTime(start + 60_000);
    await f.coordinator.tick();
    assert.equal(joins, 1);
  }
});

test('pending native close is reported, blocks joins, and retries on the next tick', async () => {
  let closes = 0;
  const f = fixture({ close: async () => ++closes === 1
    ? { ok: false, state: 'close_pending' } : { ok: true, state: 'closed' } });
  f.setMeetings([meeting(), meeting({ id: 'second', joinURL: 'https://zoom.us/j/123456789' })]);
  await f.coordinator.refresh(); await f.coordinator.tick();
  f.setInspect('left'); await f.coordinator.tick();
  assert.equal(f.coordinator.getState().phase, 'close_required');
  assert.equal(f.calls.join.length, 1);
  await f.coordinator.tick();
  assert.equal(closes, 2);
  assert.equal(f.calls.join.length, 1);
  await f.coordinator.tick();
  assert.equal(f.calls.join.length, 2);
});

test('failed close remains actionable; released means helper safely relinquished the window', async () => {
  const failed = fixture({ close: async () => ({ ok: false, state: 'close_failed' }) });
  await failed.coordinator.refresh(); await failed.coordinator.tick();
  failed.setInspect('left'); await failed.coordinator.tick();
  assert.equal(failed.coordinator.getState().phase, 'close_required');
  await failed.coordinator.tick();
  assert.equal(failed.coordinator.getState().phase, 'close_required');
  assert.equal(failed.calls.join.length, 1);
  const released = fixture({ close: async () => ({ ok: false, state: 'released' }) });
  await released.coordinator.refresh(); await released.coordinator.tick();
  released.setInspect('left'); await released.coordinator.tick();
  assert.equal(released.coordinator.getState().phase, 'completed');
});

test('dispose refuses to forget an owned window whose close remains unresolved', async () => {
  const f = fixture({ close: async () => ({ ok: false, state: 'close_pending' }) });
  await f.coordinator.refresh(); await f.coordinator.tick();
  await assert.rejects(f.coordinator.dispose(), /owned meeting window/i);
  assert.equal(f.coordinator.getState().phase, 'close_required');
  await f.coordinator.tick();
  assert.equal(f.coordinator.getState().phase, 'close_required');
});

test('typed late-join close failure retains ownership until closure is confirmed', async () => {
  const ownedSessionId = 'f'.repeat(32);
  let joins = 0, closes = 0;
  const f = fixture({
    join: async () => {
      joins++;
      if (joins === 1) throw Object.assign(Error('private bridge detail'), { code: 'owned_window_close_required', sessionId: ownedSessionId });
      return { ok: true, state: 'joined', sessionId: 'a'.repeat(32), hwnd: '123', pid: 123 };
    },
    close: async sessionId => {
      assert.equal(sessionId, ownedSessionId);
      return ++closes === 1 ? { ok: false, state: 'close_pending' } : { ok: true, state: 'closed' };
    }
  });
  f.setMeetings([meeting(), meeting({ id: 'second', joinURL: 'https://zoom.us/j/123456789' })]);
  await f.coordinator.refresh(); await f.coordinator.tick();
  assert.equal(f.coordinator.getState().phase, 'close_required');
  assert.equal(joins, 1);
  assert.equal(JSON.stringify(f.coordinator.getState()).includes(ownedSessionId), false);
  await f.coordinator.tick();
  assert.equal(closes, 2);
  assert.equal(joins, 1);
  await f.coordinator.tick();
  assert.equal(joins, 2);
});

test('join errors without the exact typed code and valid session ID cannot register ownership', async () => {
  for (const cause of [
    Object.assign(Error('private detail'), { code: 'other_error', sessionId: 'f'.repeat(32) }),
    Object.assign(Error('private detail'), { code: 'owned_window_close_required', sessionId: 'invalid' })
  ]) {
    let closes = 0;
    const f = fixture({ join: async () => { throw cause; }, close: async () => { closes++; return { ok: true, state: 'closed' }; } });
    await f.coordinator.refresh(); await f.coordinator.tick();
    assert.equal(f.coordinator.getState().phase, 'failed');
    assert.equal(closes, 0);
  }
});

test('manual join opens the selected future meeting with auto-join off, then saves and deduplicates it', async () => {
  const f = fixture();
  f.setSettings({ autoJoin: false });
  f.setTime(start - 10 * 60_000);
  await f.coordinator.refresh();
  await f.coordinator.tick();
  assert.equal(f.calls.join.length, 0);

  await f.coordinator.joinMeeting({ meetingId: 'meeting-1', ownerUserID: 'firebase-owner' });
  assert.equal(f.coordinator.getState().phase, 'capturing');
  assert.equal(f.calls.join[0].consentConfirmed, true);
  assert.equal(f.calls.start[0].hwnd, '12345');
  assert.equal(f.calls.start[0].systemAudio, true);
  assert.equal(f.calls.start[0].microphone, false);

  f.setInspect('left');
  await f.coordinator.tick();
  assert.equal(f.coordinator.getState().phase, 'completed');
  assert.equal(f.calls.complete.length, 1);
  await assert.rejects(f.coordinator.joinMeeting({ meetingId: 'meeting-1', ownerUserID: 'firebase-owner' }), /already been recorded/);
  assert.equal(f.calls.join.length, 1);
});

test('manual join rechecks consent, owner, and fresh calendar membership before opening Chrome', async () => {
  const f = fixture();
  await f.coordinator.refresh();
  const selection = { meetingId: 'meeting-1', ownerUserID: 'firebase-owner' };
  f.setSettings({ participantConsent: false });
  await assert.rejects(f.coordinator.joinMeeting(selection), /confirm recording permissions/);
  f.setSettings({ participantConsent: true });
  await assert.rejects(f.coordinator.joinMeeting({ ...selection, ownerUserID: 'other-owner' }), /confirm recording permissions/);

  f.setMeetings([]);
  await assert.rejects(f.coordinator.joinMeeting(selection), /no longer available/);
  assert.equal(f.calls.join.length, 0);
});

test('canceling an overlapping manual and scheduled join releases the owned window and prevents an automatic retry', async () => {
  const gate = deferred();
  let joinSignal;
  const f = fixture({ join: async args => { joinSignal = args.signal; return gate.promise; } });
  await f.coordinator.refresh();
  const selection = { meetingId: 'meeting-1', ownerUserID: 'firebase-owner' };
  const joining = f.coordinator.joinMeeting(selection);
  await tickLoop();
  await f.coordinator.tick();
  assert.equal(f.coordinator.getState().phase, 'joining');
  await assert.rejects(f.coordinator.joinMeeting(selection), /Finish the current meeting action/);
  await f.coordinator.cancelJoin('other-owner');
  assert.equal(joinSignal.aborted, false);
  const cancelling = f.coordinator.cancelJoin('firebase-owner');
  assert.equal(joinSignal.aborted, true);
  gate.resolve({ ok: true, state: 'joined', sessionId: 'a'.repeat(32), hwnd: '12345', pid: 99 });
  await Promise.all([joining, cancelling]);
  assert.equal(f.coordinator.getState().phase, 'cancelled');
  assert.equal(f.calls.start.length, 0);
  assert.deepEqual(f.calls.close, ['a'.repeat(32)]);
  await f.coordinator.refresh();
  await f.coordinator.tick();
  assert.equal(f.coordinator.getState().phase, 'scheduled');
});

test('each manual join chooses its own microphone and a denied mic never silently starts capture', async () => {
  const inputs = [];
  const f = fixture({ start: async args => {
    inputs.push(args);
    if (args.microphone) throw Object.assign(Error('Permission denied'), { code: 'microphone_unavailable' });
    return {};
  } });
  f.setSettings({ autoJoin: false });
  const selection = { meetingId: 'meeting-1', ownerUserID: 'firebase-owner' };
  await f.coordinator.joinMeeting({ ...selection, microphone: true });
  assert.equal(f.coordinator.getState().reason, 'microphone_unavailable');
  assert.equal(f.calls.close.length, 1);
  await f.coordinator.joinMeeting(selection);
  assert.equal(f.coordinator.getState().phase, 'capturing');
  assert.deepEqual(inputs.map(input => input.microphone), [true, false]);
  await f.coordinator.cancel();
});

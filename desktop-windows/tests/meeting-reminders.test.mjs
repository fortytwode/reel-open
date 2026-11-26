import test from 'node:test';
import assert from 'node:assert/strict';
import { createMeetingReminders, meetingReminderIDFromActivation } from '../src/meeting-reminders.mjs';

const start = Date.parse('2026-11-26T10:00:00Z');
const meeting = (id = 'meeting-1', startAt = start) => ({ id, title: 'Planning',
  start: new Date(startAt).toISOString(), end: new Date(startAt + 30 * 60_000).toISOString() });

function fixture() {
  let time = start - 60_000, nextTimer = 0;
  const timers = new Map(), shown = [], clicks = [];
  class Notification {
    constructor(options) { this.options = options; }
    on(event, callback) { if (event === 'click') this.click = callback; }
    show() { shown.push(this); }
  }
  const scheduler = createMeetingReminders({ Notification, activate: () => clicks.push('focus'), now: () => new Date(time),
    setTimer: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimer: id => timers.delete(id) });
  return { scheduler, shown, clicks, timers, setTime: value => { time = value; }, fire(id) { const item = timers.get(id); timers.delete(id); item.callback(); } };
}

test('reminders are off by default and an opt-in schedules one local toast at meeting start', () => {
  const f = fixture();
  f.scheduler.update({ owner: 'owner-a', reminders: false, meetings: [meeting()] });
  assert.equal(f.timers.size, 0);
  f.scheduler.update({ owner: 'owner-a', reminders: true, meetings: [meeting()] });
  assert.deepEqual([...f.timers.values()].map(item => item.delay), [60_000]);
  f.setTime(start);
  f.fire(1);
  f.scheduler.update({ owner: 'owner-a', reminders: true, meetings: [meeting()], at: new Date(start) });
  assert.equal(f.shown.length, 1);
  assert.equal(f.shown[0].options.title, 'Meeting starts now');
  assert.equal(f.shown[0].options.body, 'Planning');
  assert.match(f.shown[0].options.toastXml, /launch="meetingId=meeting-1"/);
  f.shown[0].click();
  assert.deepEqual(f.clicks, ['focus']);
});

test('turning reminders off or changing account cancels pending notifications', () => {
  const f = fixture();
  f.scheduler.update({ owner: 'owner-a', reminders: true, meetings: [meeting()] });
  assert.equal(f.timers.size, 1);
  f.scheduler.update({ owner: 'owner-a', reminders: false, meetings: [meeting()] });
  assert.equal(f.timers.size, 0);
  f.scheduler.update({ owner: 'owner-a', reminders: true, meetings: [meeting()] });
  f.scheduler.update({ owner: 'owner-b', reminders: true, meetings: [meeting('meeting-b')] });
  assert.equal(f.timers.size, 1);
  assert.deepEqual([...f.timers.values()].map(item => item.delay), [60_000]);
  f.scheduler.dispose();
  assert.equal(f.timers.size, 0);
});

test('already-started meetings notify immediately and duplicate refreshes do not duplicate toasts', () => {
  const f = fixture(); f.setTime(start + 1_000);
  f.scheduler.update({ owner: 'owner-a', reminders: true, meetings: [meeting()] });
  f.scheduler.update({ owner: 'owner-a', reminders: true, meetings: [meeting()] });
  assert.equal(f.shown.length, 1);
});

test('cancelling or moving a meeting cancels its old timer and schedules only the new start', () => {
  const f = fixture();
  f.scheduler.update({ owner: 'owner-a', reminders: true, meetings: [meeting()] });
  const moved = meeting('meeting-1', start + 5 * 60_000);
  f.scheduler.update({ owner: 'owner-a', reminders: true, meetings: [moved] });
  assert.equal(f.timers.size, 1);
  assert.deepEqual([...f.timers.values()].map(item => item.delay), [6 * 60_000]);
  f.scheduler.update({ owner: 'owner-a', reminders: true, meetings: [] });
  assert.equal(f.timers.size, 0);
  f.setTime(start + 6 * 60_000);
  f.scheduler.update({ owner: 'owner-a', reminders: true, meetings: [] });
  assert.equal(f.shown.length, 0);
});

test('toast activation arguments safely carry the meeting ID for cold launch focus', () => {
  const f = fixture(); f.setTime(start + 1_000);
  f.scheduler.update({ owner: 'owner-a', reminders: true, meetings: [meeting('meeting&"1')] });
  assert.match(f.shown[0].options.toastXml, /launch="meetingId=meeting%26%221"/);
  assert.equal(f.shown[0].options.toastXml.includes('meeting&"1'), false);
  assert.equal(meetingReminderIDFromActivation({type:'click',arguments:'meetingId=meeting%26%221'}), 'meeting&"1');
  assert.equal(meetingReminderIDFromActivation({type:'action',arguments:'meetingId=meeting-1'}), null);
  assert.equal(meetingReminderIDFromActivation({type:'click',arguments:'meetingId=a&meetingId=b'}), null);
});

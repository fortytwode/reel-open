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

test('persistent schedules store opaque task tokens and fire only for the opted-in owner', () => {
  const f = fixture();
  let records = [], plans = [];
  const scheduler = createMeetingReminders({ Notification: class extends Object { constructor(options) { super(); this.options=options; } on() {} show() { f.shown.push(this); } },
    now: () => new Date(start - 60_000), persistence: { load: () => records, save: value => { records=structuredClone(value); }, sync: value => plans.push(structuredClone(value)) } });
  scheduler.update({owner:'owner-a',reminders:true,meetings:[meeting('private-event-id')]});
  assert.equal(records.length,1);
  assert.equal(records[0].meetingID,'private-event-id');
  assert.match(records[0].token,/^[a-f0-9]{32}$/);
  assert.deepEqual(plans.at(-1),[{token:records[0].token,start:new Date(start).toISOString()}],
    'Task Scheduler receives only an opaque token and event time, never the meeting ID or title.');
  const token=records[0].token;
  assert.equal(scheduler.fire(token,{owner:'owner-b',reminders:true,at:new Date(start)}),false,
    'A task from a different signed-in account is discarded without a toast.');
  assert.equal(records.length,0);
  assert.equal(f.shown.length,0);
  assert.equal(plans.at(-1).length,0,'Discarding a stale task also removes its OS registration.');
});

test('persistent reminders remain marked fired across refreshes and restarts', () => {
  const f=fixture();let records=[],plan=[];
  const persistence={load:()=>records,save:value=>{records=structuredClone(value);},sync:value=>{plan=structuredClone(value);}};
  const Notification=class { constructor(options){this.options=options;} on(){} show(){f.shown.push(this);} };
  const first=createMeetingReminders({Notification,now:()=>new Date(start-60_000),persistence});
  first.update({owner:'owner-a',reminders:true,meetings:[meeting()]});
  const token=records[0].token;
  assert.equal(first.fire(token,{owner:'owner-a',reminders:true,at:new Date(start)}),true);
  assert.equal(records[0].fired,true);assert.deepEqual(plan,[]);assert.equal(f.shown.length,1);
  first.update({owner:'owner-a',reminders:true,meetings:[meeting()],at:new Date(start+1_000)});
  const restarted=createMeetingReminders({Notification,now:()=>new Date(start+2_000),persistence});
  restarted.update({owner:'owner-a',reminders:true,meetings:[meeting()],at:new Date(start+2_000)});
  assert.equal(restarted.fire(token,{owner:'owner-a',reminders:true,at:new Date(start+3_000)}),false);
  assert.equal(f.shown.length,1,'One OS task cannot create a duplicate reminder after refresh or restart.');
});

test('persistent schedule cancellation revokes stale tasks on opt-out and end time', () => {
  const f = fixture();
  let records = [], plan = [];
  const scheduler = createMeetingReminders({ Notification: class { constructor(options) { this.options=options; } on() {} show() { f.shown.push(this); } },
    now: () => new Date(start - 60_000), persistence: { load: () => records, save: value => { records=structuredClone(value); }, sync: value => { plan=structuredClone(value); } } });
  scheduler.update({owner:'owner-a',reminders:true,meetings:[meeting()]});
  const token=records[0].token;
  scheduler.update({owner:'owner-a',reminders:false,meetings:[meeting()]});
  assert.equal(records.length,0);assert.deepEqual(plan,[]);
  assert.equal(scheduler.fire(token,{owner:'owner-a',reminders:true,at:new Date(start)}),false,'A stale task after opt-out fails closed.');
  scheduler.update({owner:'owner-a',reminders:true,meetings:[meeting()]});
  const expired=records[0].token;
  assert.equal(scheduler.fire(expired,{owner:'owner-a',reminders:true,at:new Date(start+30*60_000)}),false,'A delayed task after meeting end is discarded.');
  assert.equal(f.shown.length,0);
});

test('a fractionally early Windows trigger is re-armed without losing the reminder', () => {
  const f=fixture();let records=[],plan=[];
  const fractionalStart=start+250;
  const persistence={load:()=>records,save:value=>{records=structuredClone(value);},sync:value=>{plan=structuredClone(value);}};
  const Notification=class { constructor(options){this.options=options;} on(){} show(){f.shown.push(this);} };
  const scheduler=createMeetingReminders({Notification,now:()=>new Date(fractionalStart-60_000),persistence});
  scheduler.update({owner:'owner-a',reminders:true,meetings:[meeting('fractional',fractionalStart)]});
  const token=records[0].token;
  assert.equal(records[0].start,'2026-11-26T10:00:00.250Z');
  assert.equal(scheduler.fire(token,{owner:'owner-a',reminders:true,at:new Date(fractionalStart-1)}),false);
  assert.equal(records.length,1);
  assert.deepEqual(plan,[{token,start:new Date(fractionalStart+4_999).toISOString(),retry:true,
    end:new Date(fractionalStart+30*60_000).toISOString()}],
    'An early task is replaced by an explicit retry bounded by its meeting end.');
  assert.equal(scheduler.fire(token,{owner:'owner-a',reminders:true,at:new Date(fractionalStart)}),true);
  assert.equal(f.shown.length,1);
});

test('refreshing an unchanged event ID and start updates title and shortened end time', () => {
  const f=fixture();let records=[],plan=[];
  const persistence={load:()=>records,save:value=>{records=structuredClone(value);},sync:value=>{plan=structuredClone(value);}};
  const Notification=class { constructor(options){this.options=options;} on(){} show(){f.shown.push(this);} };
  const scheduler=createMeetingReminders({Notification,now:()=>new Date(start-60_000),persistence});
  scheduler.update({owner:'owner-a',reminders:true,meetings:[meeting('same-event')]});
  const token=records[0].token;
  scheduler.update({owner:'owner-a',reminders:true,meetings:[{...meeting('same-event'),title:'Updated title',end:new Date(start+10*60_000).toISOString()}]});
  assert.equal(records[0].title,'Updated title');
  assert.equal(records[0].end,new Date(start+10*60_000).toISOString());
  assert.deepEqual(plan,[{token,start:new Date(start).toISOString()}]);
  assert.equal(scheduler.fire(token,{owner:'owner-a',reminders:true,at:new Date(start+11*60_000)}),false,
    'A shortened event cannot notify after its refreshed end.');
  assert.equal(records.length,0);
  assert.equal(f.shown.length,0);
});

test('a refreshed meeting title is used when its persistent reminder fires', () => {
  const f=fixture();let records=[];
  const persistence={load:()=>records,save:value=>{records=structuredClone(value);},sync:()=>{}};
  const Notification=class { constructor(options){this.options=options;} on(){} show(){f.shown.push(this);} };
  const scheduler=createMeetingReminders({Notification,now:()=>new Date(start-60_000),persistence});
  scheduler.update({owner:'owner-a',reminders:true,meetings:[meeting('renamed-event')]});
  const token=records[0].token;
  scheduler.update({owner:'owner-a',reminders:true,meetings:[{...meeting('renamed-event'),title:'New title'}]});
  assert.equal(scheduler.fire(token,{owner:'owner-a',reminders:true,at:new Date(start)}),true);
  assert.equal(f.shown[0].options.body,'New title');
});

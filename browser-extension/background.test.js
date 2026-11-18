const test = require('node:test');
const assert = require('node:assert/strict');
const { createMeetingAlertManager } = require('./background.js');
const { recordPage } = require('./organization.js');

function harness(initialNow = Date.parse('2026-10-30T12:00:00Z')) {
  let now = initialNow;
  let state = {};
  const recordURL = recordPage({ homepage_url: 'https://record.northwind.example' });
  const alarms = new Map();
  const notifications = new Map();
  const openedTabs = [];
  const api = {
    storage: { local: {
      async get(key) { return { [key]: state[key] }; },
      async set(value) { Object.assign(state, value); },
      async remove(key) { delete state[key]; },
    } },
    alarms: {
      async getAll() { return [...alarms.values()]; },
      async create(name, info) { alarms.set(name, { name, scheduledTime: info.when }); },
      async clear(name) { return alarms.delete(name); },
    },
    notifications: {
      async getAll() { return Object.fromEntries([...notifications.keys()].map(id => [id, true])); },
      async create(id, options) { notifications.set(id, options); return id; },
      async clear(id) { return notifications.delete(id); },
    },
    tabs: { async create(info) { openedTabs.push(info); } },
  };
  return { manager: createMeetingAlertManager(api, () => now, recordURL), api, alarms, notifications, openedTabs, state, setNow(value) { now = value; } };
}

const event = (id, start, overrides = {}) => ({
  id, title: 'Private planning meeting', start: new Date(start).toISOString(),
  end: new Date(start + 45 * 60_000).toISOString(), status: 'scheduled', ...overrides,
});
const schedule = (uid, events, consent_mode = 'ask') => ({ type: 'REEL_MEETING_SCHEDULE', uid, events, consent_mode });

test('ask mode schedules start alarm; due alert dedupes and opens only the Reel consent route after click', async () => {
  const h = harness();
  const start = Date.parse('2026-10-30T12:05:00Z');
  const raw = schedule('user-a', [event('event-1', start)]);
  await h.manager.publish(raw);
  assert.equal(h.alarms.size, 1);
  h.setNow(start);
  await h.manager.wake({ name: 'reel-meeting:event-1' });
  assert.equal(h.notifications.size, 1);
  await h.manager.wake({ name: 'reel-meeting:event-1' });
  assert.equal(h.notifications.size, 1, 'one notification per event');
  const noticeId = [...h.notifications.keys()][0];
  assert.match(h.notifications.get(noticeId).title, /Meeting detected/);
  assert.equal(h.openedTabs.length, 0, 'alert alone never opens or approves a meeting');
  await h.manager.notificationAction(noticeId, 0);
  assert.equal(h.openedTabs[0].url, 'https://record.northwind.example/record#calendar-meeting=event-1');
});

test('unconfigured and repointed extensions discard alerts and cached data from a previous deployment', async () => {
  const h = harness();
  const raw = schedule('user-a', [event('active', Date.parse('2026-10-30T11:55:00Z'))]);
  for (const recordURL of [null, recordPage({ homepage_url: 'https://record.contoso.example' })]) {
    await h.manager.publish(raw);
    const noticeId = [...h.notifications.keys()][0];
    assert.ok(noticeId);
    const updated = createMeetingAlertManager(h.api, undefined, recordURL);
    await updated.notificationAction(noticeId, 0);
    assert.equal(h.openedTabs.length, 0);
    await updated.wake();
    assert.deepEqual(h.state, {});
    assert.equal(h.alarms.size, 0);
    assert.equal(h.notifications.size, 0);
    if (!recordURL) assert.equal(await updated.publish(raw), false);
  }
});

test('approved mode creates no alarms or alerts; changing back to ask can alert an active meeting', async () => {
  const h = harness();
  const start = Date.parse('2026-10-30T11:55:00Z');
  const meeting = event('event-2', start);
  await h.manager.publish(schedule('user-a', [meeting], 'approved'));
  assert.equal(h.alarms.size, 0);
  assert.equal(h.notifications.size, 0);
  await h.manager.publish(schedule('user-a', [meeting], 'ask'));
  assert.equal(h.notifications.size, 1);
});

test('UID switch clears prior alarms, notifications, and cached private titles', async () => {
  const h = harness();
  await h.manager.publish(schedule('user-a', [event('old-event', Date.parse('2026-10-30T11:55:00Z'))]));
  assert.equal(h.notifications.size, 1);
  assert.match(JSON.stringify(h.state), /Private planning meeting/);
  await h.manager.publish(schedule('user-b', [event('new-event', Date.parse('2026-10-30T12:20:00Z'), { title: 'New account meeting' })]));
  assert.equal(h.notifications.size, 0);
  assert.deepEqual([...h.alarms.keys()], ['reel-meeting:new-event']);
  assert.doesNotMatch(JSON.stringify(h.state), /Private planning meeting/);
  assert.match(JSON.stringify(h.state), /user-b/);
});

test('moved, cancelled, and removed meetings clear or reschedule alarms', async () => {
  const h = harness();
  const start = Date.parse('2026-10-30T12:10:00Z');
  await h.manager.publish(schedule('user-a', [event('event-3', start)]));
  assert.equal(h.alarms.get('reel-meeting:event-3').scheduledTime, start);
  const moved = start + 30 * 60_000;
  await h.manager.publish(schedule('user-a', [event('event-3', moved)]));
  assert.equal(h.alarms.size, 1);
  assert.equal(h.alarms.get('reel-meeting:event-3').scheduledTime, moved);
  await h.manager.publish(schedule('user-a', [event('event-3', moved, { status: 'cancelled' })]));
  assert.equal(h.alarms.size, 0);
  await h.manager.publish(schedule('user-a', [event('event-3', moved)]));
  assert.equal(h.alarms.size, 1);
  await h.manager.publish(schedule('user-a', []));
  assert.equal(h.alarms.size, 0);
});

test('same-origin organization replacement clears cached private meeting titles', async () => {
  const h = harness();
  let version = '0.1.0 (organization-a)';
  h.api.runtime = { getManifest: () => ({ version_name: version }) };
  const recordURL = recordPage({ homepage_url: 'https://record.northwind.example' });
  const original = createMeetingAlertManager(h.api, () => Date.parse('2026-10-30T12:00:00Z'), recordURL);
  await original.publish(schedule('shared-user', [event('private-event', Date.parse('2026-10-30T11:55:00Z'))]));
  assert.equal(h.notifications.size, 1);
  version = '0.1.0 (organization-b)';
  const replacement = createMeetingAlertManager(h.api, () => Date.parse('2026-10-30T12:00:00Z'), recordURL);
  await replacement.wake();
  assert.equal(h.notifications.size, 0);
  assert.equal(h.alarms.size, 0);
  assert.doesNotMatch(JSON.stringify(h.state), /Private planning meeting/);
});

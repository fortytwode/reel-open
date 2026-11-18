import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMeetingURL, normalizeGoogleEvent, discoverGoogleMeetings, routeGoogleMeetings } from '../src/google-calendar.mjs';

const ownerEmail = 'owner@northwind.example';
const now = new Date('2026-11-06T12:00:00Z');
const end = new Date(now.getTime() + 7 * 86_400_000);
const meeting = (extra = {}) => ({ id: 'event-1', summary: 'Planning', start: { dateTime: '2026-11-07T12:00:00Z' },
  end: { dateTime: '2026-11-07T12:30:00Z' }, description: 'Join https://meet.google.com/abc-defg-hij', ...extra });
const jsonResponse = (value, status = 200, url = '') => ({ ok: status >= 200 && status < 300, status, url, redirected: false, json: async () => value });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

function mockAuth() {
  let profile = { userID: 'firebase-owner', email: ownerEmail, calendarConnected: true };
  return { getProfile: () => profile, getCalendarAccessToken: async () => 'fixture-bearer',
    setProfile: next => { profile = next; } };
}

test('meeting URLs accept only direct provider links and preserve passcodes', () => {
  assert.deepEqual(parseMeetingURL('https://meet.google.com/abc-defg-hij'), { url: 'https://meet.google.com/abc-defg-hij', platform: 'google_meet' });
  assert.equal(parseMeetingURL('https://meet.google.com/meet/abc-defg-hij').platform, 'google_meet');
  assert.deepEqual(parseMeetingURL('https://acme.zoom.us/j/12345678901?pwd=passcode'), { url: 'https://acme.zoom.us/j/12345678901?pwd=passcode', platform: 'zoom' });
  assert.equal(parseMeetingURL('https://zoom.us/wc/123456789/join').platform, 'zoom');
  assert.equal(parseMeetingURL('https://teams.microsoft.com/l/meetup-join/abc/123?context=x').platform, 'teams');
  assert.equal(parseMeetingURL('https://teams.live.com/meet/123').platform, 'teams');
  for (const bad of ['http://meet.google.com/abc-defg-hij', 'https://user:pass@zoom.us/j/123456789',
    'https://zoom.us:8443/j/123456789', 'https://meet.google.com/abc-defg-hij#fragment',
    'https://evilzoom.us/j/123456789', 'https://meet.google.com/abc-defg-hij\n',
    'https://meet.google.com/abc-defg-hij.evil.com']) assert.equal(parseMeetingURL(bad), null, bad);
});

test('event normalization excludes unsafe and unwanted meetings, and leaves descriptions behind', () => {
  const result = normalizeGoogleEvent('calendar-1', meeting({ description: '<a href="https://meet.google.com/abc-defg-hij">Join</a>',
    attendees: [{ email: ownerEmail, self: true, responseStatus: 'accepted' }, { email: 'guest@example.com' }], organizer: { email: 'host@example.com' } }), { ownerEmail, now, horizonEnd: end });
  assert.equal(result.joinURL, 'https://meet.google.com/abc-defg-hij');
  assert.deepEqual(result.attendeeEmails, ['guest@example.com', ownerEmail]);
  assert.equal(result.organizer, 'host@example.com');
  assert.equal(JSON.stringify(result).includes('href'), false);
  const excluded = [
    { start: { date: '2026-11-07' }, end: { date: '2026-11-08' } },
    { status: 'cancelled' }, { visibility: 'private' }, { visibility: 'confidential' },
    { summary: 'Planning [NO-REC]' }, { summary: '[PRIVATE] Planning' },
    { attendees: [{ email: ownerEmail, responseStatus: 'declined' }] },
    { end: { dateTime: '2026-11-07T11:00:00Z' } },
    { start: { dateTime: '2026-11-15T12:00:00Z' } },
    { description: 'https://meet.google.com/abc-defg-hij and https://zoom.us/j/123456789' }
  ];
  for (const change of excluded) assert.equal(normalizeGoogleEvent('calendar-1', meeting(change), { ownerEmail, now, horizonEnd: end }), null, JSON.stringify(change));
});

test('recurrence instance identity remains stable when its start moves', () => {
  const recurring = { recurringEventId: 'series-1', originalStartTime: { dateTime: '2026-11-07T12:00:00Z' } };
  const first = normalizeGoogleEvent('c', meeting(recurring), { ownerEmail, now, horizonEnd: end });
  const moved = normalizeGoogleEvent('c', meeting({ ...recurring, start: { dateTime: '2026-11-08T12:00:00Z' }, end: { dateTime: '2026-11-08T12:30:00Z' } }), { ownerEmail, now, horizonEnd: end });
  assert.equal(first.id, moved.id);
});

test('discovery pages calendars and events, filters selection, deduplicates and exposes minimal data', async () => {
  const auth = mockAuth(); const calls = [];
  const fetch = async (input, options) => {
    const url = new URL(input); calls.push({ url, options });
    if (url.pathname.endsWith('/calendarList')) return jsonResponse(url.searchParams.has('pageToken')
      ? { items: [{ id: 'secondary', summary: 'Secondary', accessRole: 'reader' }] }
      : { items: [{ id: 'primary', summary: 'Main', primary: true, accessRole: 'owner' }], nextPageToken: 'cal-next' });
    if (url.pathname.includes('/primary/events')) return jsonResponse(url.searchParams.has('pageToken')
      ? { items: [meeting()] } : { items: [meeting()], nextPageToken: 'event-next' });
    throw Error('unexpected fixture request');
  };
  const result = await discoverGoogleMeetings({ auth, selection: { useAll: false, ids: ['primary'] }, now, fetch });
  assert.equal(result.ownerUserID, 'firebase-owner');
  assert.deepEqual(result.calendars, [{ id: 'primary', title: 'Main', primary: true }, { id: 'secondary', title: 'Secondary', primary: false }]);
  assert.equal(result.meetings.length, 1);
  assert.equal(calls.length, 4);
  for (const { url, options } of calls) {
    assert.equal(url.origin, 'https://www.googleapis.com');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer fixture-bearer');
  }
  assert.equal(calls[0].url.searchParams.get('minAccessRole'), 'reader');
  assert.equal(calls[2].url.searchParams.get('singleEvents'), 'true');
  assert.equal(calls[2].url.searchParams.get('orderBy'), 'startTime');
  assert.equal(JSON.stringify(result).includes('description'), false);
});

test('empty selection skips events, repeated page tokens fail closed', async () => {
  const auth = mockAuth(); let calls = 0;
  const empty = await discoverGoogleMeetings({ auth, selection: { useAll: false, ids: [] }, now, fetch: async () => { calls++; return jsonResponse({ items: [{ id: 'c', summary: 'C', accessRole: 'reader' }] }); } });
  assert.equal(calls, 1); assert.deepEqual(empty.meetings, []);
  await assert.rejects(discoverGoogleMeetings({ auth, selection: { useAll: true, ids: [] }, now,
    fetch: async () => jsonResponse({ items: [], nextPageToken: 'same' }) }), /calendar|refresh/i);
});

test('owner switches during token, fetch or JSON parsing and no result is returned', async () => {
  for (const stage of ['token', 'fetch', 'json']) {
    const auth = mockAuth(); const gate = deferred();
    if (stage === 'token') auth.getCalendarAccessToken = () => gate.promise;
    const fetch = stage === 'fetch' ? () => gate.promise : async () => jsonResponse({ items: [] });
    const parseFetch = stage === 'json' ? async () => ({ ok: true, status: 200, redirected: false, json: () => gate.promise }) : fetch;
    const pending = discoverGoogleMeetings({ auth, selection: { useAll: true, ids: [] }, now, fetch: parseFetch });
    await new Promise(resolve => setImmediate(resolve));
    auth.setProfile({ userID: 'another-owner', email: 'other@northwind.example', calendarConnected: true });
    gate.resolve(stage === 'token' ? 'fixture-bearer' : stage === 'fetch' ? jsonResponse({ items: [] }) : { items: [] });
    await assert.rejects(pending, /account|calendar|refresh/i);
  }
});

test('disconnect, revocation, redirect, failed page and abort fail without partial success', async () => {
  const auth = mockAuth();
  auth.setProfile({ userID: 'firebase-owner', email: ownerEmail, calendarConnected: false });
  await assert.rejects(discoverGoogleMeetings({ auth, selection: { useAll: true, ids: [] }, now, fetch: async () => { throw Error('should not fetch'); } }), /connect/i);
  auth.setProfile({ userID: 'firebase-owner', email: ownerEmail, calendarConnected: true });
  for (const response of [jsonResponse({ error: 'revoked secret' }, 401), { ...jsonResponse({}), redirected: true }, jsonResponse({ error: 'server secret' }, 503)]) {
    await assert.rejects(discoverGoogleMeetings({ auth, selection: { useAll: true, ids: [] }, now, fetch: async () => response }), /calendar|connect|refresh/i);
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(discoverGoogleMeetings({ auth, selection: { useAll: true, ids: [] }, now, signal: controller.signal, fetch: async () => { throw Error('should not fetch'); } }), /cancel/i);
  const stalled = new AbortController();
  const pending = discoverGoogleMeetings({ auth, selection: { useAll: true, ids: [] }, now, signal: stalled.signal,
    fetch: async () => new Promise(() => {}) });
  await new Promise(resolve => setImmediate(resolve));
  stalled.abort();
  await assert.rejects(pending, /cancel/i);
  let page = 0;
  await assert.rejects(discoverGoogleMeetings({ auth, selection: { useAll: true, ids: [] }, now,
    fetch: async () => ++page === 1
      ? jsonResponse({ items: [{ id: 'primary', summary: 'Main', primary: true, accessRole: 'owner' }], nextPageToken: 'second' })
      : jsonResponse({ error: 'private provider payload' }, 503) }), /refresh/i);
});

test('discovery retains exact provider occurrence identity', () => {
  const result = normalizeGoogleEvent('primary', meeting({ iCalUID: 'series@example.com', recurringEventId: 'series', originalStartTime: { dateTime: '2026-11-07T12:00:00Z' } }), { ownerEmail, now, horizonEnd: end });
  assert.deepEqual(result.calendar, { calendar_id: 'primary', event_id: 'event-1', ical_uid: 'series@example.com', occurrence_start: '2026-11-07T12:00:00.000Z' });
});

// Exercise the real policy request boundary, including provider URLs and owner changes.
const routingURL = 'https://meetings.northwind.example/calendar/desktop';
const teamsURL = 'https://teams.microsoft.com/meet/123?context=local';
const localRoutingSnapshot = () => ({ ownerUserID: 'firebase-owner', calendars: [], meetings: [
  { id: 'cloud-copy', joinURL: teamsURL, start: '2026-11-07T12:00:00Z' },
  { id: 'cloud-copy-trailing-slash', joinURL: 'https://teams.microsoft.com/meet/123/?context=local', start: '2026-11-07T12:00:00Z' },
  { id: 'other-start', joinURL: teamsURL, start: '2026-11-08T12:00:00Z' },
  { id: 'local-teams', joinURL: 'https://teams.live.com/meet/456', start: '2026-11-07T12:00:00Z' },
  { id: 'meet', joinURL: 'https://meet.google.com/abc-defg-hij', start: '2026-11-07T12:00:00Z' },
  { id: 'zoom', joinURL: 'https://zoom.us/j/123456789', start: '2026-11-07T12:00:00Z' }
] });
const routingAuth = () => ({ ...mockAuth(), getIdToken: async () => 'firebase-token' });
const cloudBody = (providers = ['teams']) => ({ events: [], cloud_providers: providers,
  cloud_events: [{ join_url: 'https://teams.microsoft.com/meet/123?context=cloud', start: '2026-11-07T13:00:00+01:00' }] });

test('fresh cloud policy excludes exact occurrence across query/calendar copies, preserving unmatched Teams, Meet and Zoom', async () => {
  for (const providers of [['teams'], []]) {
    const requests = [];
    const result = await routeGoogleMeetings({ routingURL, auth: routingAuth(), snapshot: localRoutingSnapshot(),
      fetch: async (url, options) => { requests.push({url, options}); return jsonResponse(cloudBody(providers)); } });
    assert.deepEqual(result.meetings.map(item => item.id), ['other-start', 'local-teams', 'meet', 'zoom']);
    assert.equal(result.routingUnavailable, false);
    assert.equal(requests[0].url, routingURL);
    assert.equal(requests[0].options.headers.Authorization, 'Bearer firebase-token');
    assert.equal(requests[0].options.redirect, 'error');
    assert.equal(requests[0].options.method, 'GET');
    assert.ok(requests[0].options.signal instanceof AbortSignal);
  }
});

test('legacy policy retains Teams; missing, malformed, redirect and unavailable policy suppress Meet and Teams only', async () => {
  const legacy = await routeGoogleMeetings({ routingURL, auth: routingAuth(), snapshot: localRoutingSnapshot(),
    fetch: async () => jsonResponse({ events: [] }) });
  assert.equal(legacy.meetings.length, 6);
  for (const response of [null, jsonResponse({ events: [], cloud_providers: ['teams'] }),
    jsonResponse({ ...cloudBody(), cloud_events: [{ join_url: teamsURL, start: 'bad' }] }),
    jsonResponse({ events: [], cloud_events: [], cloud_providers: null }),
    { ...jsonResponse(cloudBody()), redirected: true }, jsonResponse({}, 503)]) {
    const result = await routeGoogleMeetings({ routingURL, auth: routingAuth(), snapshot: localRoutingSnapshot(),
      fetch: async () => { if (!response) throw Error('network failed'); return response; } });
    assert.deepEqual(result.meetings.map(item => item.id), ['zoom']);
    assert.equal(result.routingUnavailable, true);
  }
});

test('routing never returns prior-owner policy after token, network or JSON await; caller abort is bounded', async () => {
  for (const stage of ['token', 'fetch', 'json']) {
    const auth = routingAuth(), gate = deferred();
    if (stage === 'token') auth.getIdToken = () => gate.promise;
    const pending = routeGoogleMeetings({ routingURL, auth, snapshot: localRoutingSnapshot(), fetch: async () => {
      if (stage === 'fetch') return gate.promise;
      return { ...jsonResponse(cloudBody()), json: stage === 'json' ? () => gate.promise : async () => cloudBody() };
    } });
    await new Promise(resolve => setImmediate(resolve));
    auth.setProfile({ userID: 'other', email: 'other@example.com', calendarConnected: true });
    gate.resolve(stage === 'token' ? 'firebase-token' : stage === 'fetch' ? jsonResponse(cloudBody()) : cloudBody());
    await assert.rejects(pending, /account changed/i);
  }
  const controller = new AbortController();
  const pending = routeGoogleMeetings({ routingURL, auth: routingAuth(), snapshot: localRoutingSnapshot(), signal: controller.signal,
    fetch: async () => new Promise(() => {}) });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, /cancelled/i);
});

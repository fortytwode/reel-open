const GOOGLE_ORIGIN = 'https://www.googleapis.com';
const API_ROOT = `${GOOGLE_ORIGIN}/calendar/v3`;
const HORIZON_MS = 7 * 24 * 60 * 60 * 1000;
// A limit is a failure, never a truncated "successful" discovery result.
const MAX_PAGES = 20;
const MAX_CALENDARS = 250;
const MAX_EVENTS = 5_000;
const MAX_TEXT = 100_000;
const READ_ROLES = new Set(['reader', 'writer', 'writerWithoutPrivateAccess', 'owner']);

class CalendarError extends Error {
  constructor(code, message) { super(message); this.name = 'CalendarError'; this.code = code; }
}
const failure = (code, message) => new CalendarError(code, message);
const cancelled = () => failure('cancelled', 'Calendar refresh was cancelled.');
const unavailable = () => failure('unavailable', 'Could not refresh Google Calendar. Please try again.');
const validText = (value, limit = MAX_TEXT) => typeof value === 'string' && value.length > 0 && value.length <= limit;

/** Direct HTTPS provider URL only. Returns {url, platform} or null. */
export function parseMeetingURL(value) {
  if (!validText(value, 8_192) || /[\u0000-\u001f\u007f\s]/u.test(value)) return null;
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (parsed.protocol.toLowerCase() !== 'https:' || parsed.username || parsed.password || parsed.hash
    || (parsed.port && parsed.port !== '443') || !parsed.hostname || parsed.hostname.endsWith('.')) return null;
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;
  let platform;
  if (host === 'meet.google.com' && /^\/(?:meet\/)?[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/.test(path)) platform = 'google_meet';
  else if ((host === 'zoom.us' || host.endsWith('.zoom.us'))
    && (/^\/j\/[0-9]{9,11}\/?$/.test(path) || /^\/wc\/[0-9]{9,11}\/join\/?$/.test(path))) platform = 'zoom';
  else if (host === 'teams.microsoft.com'
    && (/^\/l\/meetup-join\/[^/]+\/[0-9]+\/?$/.test(path) || /^\/meet\/[0-9]+\/?$/.test(path))) platform = 'teams';
  else if (host === 'teams.live.com' && /^\/meet\/[0-9]+\/?$/.test(path)) platform = 'teams';
  else return null;
  parsed.protocol = 'https:';
  parsed.hostname = host;
  parsed.port = '';
  return { url: parsed.toString(), platform };
}

// Owner-bound policy is deliberately refreshed independently of cached Google data.
const routingKey = (url, start) => {
  const link = parseMeetingURL(url);
  const time = typeof start === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(start) ? Date.parse(start) : NaN;
  if (!link || !Number.isFinite(time)) return null;
  const parsed = new URL(link.url);
  // Same host/path/start identity as the meeting coordinator; ignore query passcodes.
  return `${parsed.hostname}${parsed.pathname.replace(/\/$/, '')}:${time / 1000}`;
};

/** Main-process only: never let an unavailable cloud policy fall back to local Meet or Teams. */
export async function routeGoogleMeetings({ auth, snapshot, routingURL, fetch: fetcher = globalThis.fetch, signal } = {}) {
  const owner = auth.getProfile();
  const controller = new AbortController();
  const guard = () => {
    if (signal?.aborted) throw cancelled();
    const current = auth.getProfile();
    if (!owner?.userID || snapshot.ownerUserID !== owner.userID || current?.userID !== owner.userID
      || current?.email !== owner.email || current?.calendarConnected !== true)
      throw failure('owner', 'The signed-in account changed. Refresh Google Calendar again.');
  };
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 10_000);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(unavailable());
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const wait = promise => Promise.race([promise, aborted]);
  try {
    guard();
    const token = await wait(auth.getIdToken());
    guard();
    if (!routingURL || !validText(token, 16_384)) throw unavailable();
    const response = await wait(fetcher(routingURL, { method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'error', signal: controller.signal }));
    guard();
    if (!response?.ok || response.redirected || (response.url && response.url !== routingURL)) throw unavailable();
    const body = await wait(response.json());
    guard();
    if (!body || typeof body !== 'object' || !Array.isArray(body.events) || body.events.length > MAX_EVENTS) throw unavailable();
    const legacy = !Object.hasOwn(body, 'cloud_events') && !Object.hasOwn(body, 'cloud_providers');
    if (!legacy && (!Array.isArray(body.cloud_events) || body.cloud_events.length > MAX_EVENTS
      || !Array.isArray(body.cloud_providers) || body.cloud_providers.length > 20
      || body.cloud_providers.some(provider => !validText(provider, 100)))) throw unavailable();
    const owned = new Set();
    for (const event of legacy ? [] : body.cloud_events) {
      const key = routingKey(event?.join_url, event?.start);
      if (!key) throw unavailable();
      owned.add(key);
    }
    return { ...snapshot, meetings: snapshot.meetings.filter(meeting => !owned.has(routingKey(meeting.joinURL, meeting.start))),
      routingUnavailable: false };
  } catch {
    guard();
    return { ...snapshot, meetings: snapshot.meetings.filter(meeting => !['google_meet', 'teams'].includes(parseMeetingURL(meeting.joinURL)?.platform)),
      routingUnavailable: true };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', onAbort);
  }
}

function uniqueMeetingLink(event) {
  const texts = [event.hangoutLink, event.location, event.description];
  if (Array.isArray(event.conferenceData?.entryPoints)) {
    for (const point of event.conferenceData.entryPoints) if (point?.entryPointType === 'video') texts.push(point.uri);
  }
  const links = new Map();
  for (const text of texts) {
    if (!validText(text)) continue;
    // Calendar descriptions may be HTML; URLs are inspected only in memory.
    for (const match of text.matchAll(/https:\/\/[^\s<>"']+/gi)) {
      const candidate = match[0].replace(/&amp;/gi, '&').replace(/[.,;!?)\]}]+$/u, '');
      const link = parseMeetingURL(candidate);
      if (link) links.set(link.url, link);
    }
  }
  return links.size === 1 ? links.values().next().value : null;
}

function eventTime(value) {
  if (typeof value?.dateTime !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value.dateTime)) return null;
  const time = Date.parse(value.dateTime);
  return Number.isFinite(time) ? time : null;
}

function normalizedEmail(value) {
  if (!validText(value, 320) || /[\s<>]/u.test(value) || !/^[^@]+@[^@]+\.[^@]+$/u.test(value)) return null;
  return value.toLowerCase();
}

/** Normalize one Google event to the minimal meeting shape, or return null. */
export function normalizeGoogleEvent(calendarID, event, { ownerEmail, now, horizonEnd } = {}) {
  if (!validText(calendarID, 1024) || !event || typeof event !== 'object'
    || !validText(event.id, 1024) || event.status === 'cancelled'
    || ['private', 'confidential'].includes(event.visibility) || event.start?.date || event.end?.date
    || event.endTimeUnspecified === true) return null;
  const from = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const until = horizonEnd instanceof Date ? horizonEnd.getTime() : new Date(horizonEnd).getTime();
  const start = eventTime(event.start);
  const end = eventTime(event.end);
  if (![from, until, start, end].every(Number.isFinite) || start >= until || end <= from
    || end <= start || end - start > 24 * 60 * 60 * 1000) return null;
  const title = validText(event.summary, 4096) ? event.summary : 'Meeting';
  if (/\[(?:NO-REC|PRIVATE)\]/i.test(title)) return null;
  const owner = normalizedEmail(ownerEmail);
  const attendees = Array.isArray(event.attendees) ? event.attendees : [];
  if (attendees.some(person => person?.responseStatus === 'declined'
    && (person.self === true || (owner && normalizedEmail(person.email) === owner)))) return null;
  const link = uniqueMeetingLink(event);
  if (!link) return null;
  const attendeeEmails = [...new Set(attendees.map(person => normalizedEmail(person?.email)).filter(Boolean))].sort();
  const organizer = normalizedEmail(event.organizer?.email);
  const original = event.recurringEventId && event.originalStartTime?.dateTime;
  const externalID = validText(original, 128) ? `${event.recurringEventId}@${original}` : event.id;
  // Length prefixes keep IDs distinct when calendar or event IDs contain delimiters.
  const id = `${Buffer.byteLength(calendarID)}:${calendarID}${Buffer.byteLength(externalID)}:${externalID}`;
  return { id, calendarID, title, start: new Date(start).toISOString(), end: new Date(end).toISOString(),
    joinURL: link.url, platform: link.platform, attendeeEmails, organizer,
    calendar: { calendar_id: calendarID, event_id: event.id,
      ...(validText(event.iCalUID, 1024) ? { ical_uid: event.iCalUID } : {}),
      occurrence_start: new Date(eventTime(event.originalStartTime) ?? start).toISOString() } };
}

/**
 * Read-only seven-day discovery. `auth` supplies main-process getProfile() and
 * getCalendarAccessToken(); `selection` is {useAll:boolean, ids:string[]}.
 * Returns one complete owner-bound snapshot or throws a fixed, non-sensitive
 * CalendarError. Hard limits: 20 pages per list, 250 calendars, 5,000 events.
 */
export async function discoverGoogleMeetings({ auth, selection = { useAll: true, ids: [] }, now = new Date(),
  fetch: fetcher = globalThis.fetch, signal } = {}) {
  if (!auth || typeof auth.getProfile !== 'function' || typeof auth.getCalendarAccessToken !== 'function'
    || !selection || typeof selection.useAll !== 'boolean' || !Array.isArray(selection.ids)
    || selection.ids.length > MAX_CALENDARS || selection.ids.some(id => !validText(id, 1024)) || typeof fetcher !== 'function') {
    throw failure('configuration', 'Google Calendar is not configured.');
  }
  const start = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (!Number.isFinite(start.getTime())) throw failure('configuration', 'Invalid calendar refresh time.');
  const horizonEnd = new Date(start.getTime() + HORIZON_MS);
  const owner = auth.getProfile();
  if (!validText(owner?.userID) || !normalizedEmail(owner?.email) || owner.calendarConnected !== true)
    throw failure('connect', 'Connect Google Calendar to see meetings.');
  const ownerUserID = owner.userID;
  const ownerEmail = owner.email.toLowerCase();
  function guard() {
    if (signal?.aborted) throw cancelled();
    const current = auth.getProfile();
    if (current?.userID !== ownerUserID || current?.email?.toLowerCase() !== ownerEmail || current.calendarConnected !== true)
      throw failure('owner', 'The signed-in account changed. Refresh Google Calendar again.');
  }
  function awaitWithAbort(promise) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(cancelled());
    return new Promise((resolve, reject) => {
      const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(cancelled()); };
      signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }
  guard();
  let token;
  try { token = await awaitWithAbort(auth.getCalendarAccessToken()); }
  catch { guard(); throw failure('connect', 'Connect Google Calendar again to see meetings.'); }
  guard();
  if (!validText(token, 16_384)) throw failure('connect', 'Connect Google Calendar again to see meetings.');

  async function getJSON(url) {
    guard();
    let response;
    try { response = await awaitWithAbort(fetcher(url.toString(), { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, redirect: 'error', signal })); }
    catch { guard(); throw unavailable(); }
    guard();
    try { if (response?.redirected || (response?.url && new URL(response.url).origin !== GOOGLE_ORIGIN)) throw unavailable(); }
    catch { throw unavailable(); }
    if (!response?.ok) {
      if (response?.status === 401 || response?.status === 403) throw failure('connect', 'Connect Google Calendar again to see meetings.');
      throw unavailable();
    }
    let body;
    try { body = await awaitWithAbort(response.json()); }
    catch { guard(); throw unavailable(); }
    guard();
    if (!body || typeof body !== 'object' || !Array.isArray(body.items)) throw unavailable();
    return body;
  }

  async function listPages(path, params, maxItems) {
    const items = [];
    const seenTokens = new Set();
    let pageToken = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(path, API_ROOT + '/');
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const body = await getJSON(url);
      guard();
      if (body.items.length > 250 || items.length + body.items.length > maxItems) throw unavailable();
      items.push(...body.items);
      const next = body.nextPageToken;
      if (next === undefined || next === null || next === '') return items;
      if (!validText(next, 2048) || seenTokens.has(next)) throw unavailable();
      seenTokens.add(next);
      pageToken = next;
    }
    throw unavailable();
  }

  const entries = await listPages('users/me/calendarList', { minAccessRole: 'reader', maxResults: '250' }, MAX_CALENDARS);
  guard();
  const calendarMap = new Map();
  for (const entry of entries) {
    if (!validText(entry?.id, 1024) || !READ_ROLES.has(entry.accessRole) || entry.deleted || entry.hidden) continue;
    if (!calendarMap.has(entry.id)) calendarMap.set(entry.id, { id: entry.id, title: validText(entry.summary, 4096) ? entry.summary : entry.id, primary: entry.primary === true });
  }
  const calendars = [...calendarMap.values()].sort((a, b) => Number(b.primary) - Number(a.primary) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  const selected = selection.useAll ? calendars : calendars.filter(calendar => selection.ids.includes(calendar.id));
  const meetingMap = new Map();
  let examined = 0;
  for (const calendar of selected) {
    guard();
    const events = await listPages(`calendars/${encodeURIComponent(calendar.id)}/events`, {
      singleEvents: 'true', orderBy: 'startTime', timeMin: start.toISOString(), timeMax: horizonEnd.toISOString(),
      maxResults: '250', showDeleted: 'false'
    }, MAX_EVENTS - examined);
    guard();
    examined += events.length;
    for (const event of events) {
      const meeting = normalizeGoogleEvent(calendar.id, event, { ownerEmail, now: start, horizonEnd });
      if (meeting) meetingMap.set(meeting.id, meeting);
    }
  }
  guard();
  const meetings = [...meetingMap.values()].sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
  return { ownerUserID, calendars, meetings, fetchedAt: start.toISOString() };
}

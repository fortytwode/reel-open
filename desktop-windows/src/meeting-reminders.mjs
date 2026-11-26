import { randomBytes } from 'node:crypto';

const LIMIT = 32;
const xml = value => String(value).replace(/[&<>"']/gu, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[character]));
const token = () => randomBytes(16).toString('hex');
const recordKey = item => `${item.meetingID}:${Date.parse(item.start)}`;

function validStoredReminder(item) {
  return item && /^[a-f0-9]{32}$/u.test(item.token) && typeof item.owner === 'string' && item.owner.length > 0
    && typeof item.meetingID === 'string' && item.meetingID.length > 0 && item.meetingID.length <= 4096
    && typeof item.title === 'string' && item.title.length <= 500
    && Number.isFinite(Date.parse(item.start)) && Number.isFinite(Date.parse(item.end))
    && Date.parse(item.end) > Date.parse(item.start) && (item.fired === undefined || typeof item.fired === 'boolean');
}

export function meetingReminderIDFromActivation(details) {
  if (details?.type !== 'click' || typeof details.arguments !== 'string') return null;
  const ids = new URLSearchParams(details.arguments).getAll('meetingId');
  return ids.length === 1 && ids[0].length > 0 && ids[0].length <= 4096 ? ids[0] : null;
}

/** Local, opt-in reminders for the currently selected and routed calendar events. */
export function createMeetingReminders({ Notification, activate = () => {}, now = () => new Date(),
  setTimer = setTimeout, clearTimer = clearTimeout, persistence = null, persistentError = null } = {}) {
  if (typeof Notification !== 'function' || typeof activate !== 'function' || typeof now !== 'function'
    || typeof setTimer !== 'function' || typeof clearTimer !== 'function'
    || (persistence !== null && (!persistence || typeof persistence.load !== 'function' || typeof persistence.save !== 'function' || typeof persistence.sync !== 'function')))
    throw TypeError('Invalid meeting reminder dependencies');
  let ownerUserID = null, enabled = false;
  let lastError = typeof persistentError === 'string' ? persistentError : null;
  let needsSync = Boolean(persistence);
  const scheduled = new Map((persistence?.load() ?? []).filter(validStoredReminder).map(item => [recordKey(item), { ...item, timer: null }]));
  const cancel = key => {
    const item = scheduled.get(key);
    if (item?.timer) clearTimer(item.timer);
    scheduled.delete(key);
  };
  function show(item) {
    try {
      const title = 'Meeting starts now', body = item.title || 'Your calendar meeting is starting.';
      const launch = `meetingId=${encodeURIComponent(item.meetingID)}`;
      const toastXml = `<toast launch="${xml(launch)}"><visual><binding template="ToastGeneric"><text>${xml(title)}</text><text>${xml(body)}</text></binding></visual></toast>`;
      const notification = new Notification({ title, body, toastXml });
      notification.on?.('click', () => activate(item.meetingID));
      notification.show();
    } catch { /* Windows notification settings may block local delivery. */ }
  }
  function saveAndSync({ rearmToken = null, rearmStart = null } = {}) {
    if (!persistence) return true;
    const records = [...scheduled.values()].map(({ timer, ...record }) => record);
    try {
      persistence.save(records);
      persistence.sync(records.filter(record => !record.fired).map(({ token, start, end }) => token === rearmToken && typeof rearmStart === 'string'
        ? { token, start: rearmStart, retry: true, end }
        : { token, start }));
      lastError = null;
      needsSync = false;
      return true;
    } catch {
      lastError = 'Windows could not schedule meeting reminders. Keep Reel Companion open and retry calendar refresh.';
      needsSync = true;
      return false;
    }
  }
  function update({ owner, reminders, meetings, at = now() } = {}) {
    const currentOwner = typeof owner === 'string' && owner ? owner : null;
    const currentEnabled = reminders === true;
    const scopeChanged = currentOwner !== ownerUserID || currentEnabled !== enabled;
    const before = persistence ? JSON.stringify([...scheduled.values()].map(({ timer, ...record }) => record)) : '';
    ownerUserID = currentOwner; enabled = currentEnabled;
    const time = at instanceof Date ? at.getTime() : Date.parse(at);
    if (!Number.isFinite(time)) return;
    if (persistence && scopeChanged) for (const item of scheduled.values()) if (item.timer) clearTimer(item.timer);
    const valid = (Array.isArray(meetings) ? meetings : []).map(meeting => {
      const start = Date.parse(meeting?.start), end = Date.parse(meeting?.end);
      if (!enabled || !ownerUserID || typeof meeting?.id !== 'string' || !meeting.id || meeting.id.length > 4096
        || !Number.isFinite(start) || !Number.isFinite(end) || end <= time || end <= start) return null;
      return { meeting, start, end, key: `${meeting.id}:${start}` };
    }).filter(Boolean).sort((a, b) => a.start - b.start).slice(0, LIMIT);
    const wanted = new Set(valid.map(item => item.key));
    for (const key of [...scheduled.keys()]) if (!wanted.has(key)) cancel(key);
    const due = [];
    for (const item of valid) {
      let scheduledItem = scheduled.get(item.key);
      if (scheduledItem && scheduledItem.owner !== ownerUserID) { cancel(item.key); scheduledItem = null; }
      const title=String(item.meeting.title ?? '').slice(0, 500), endAt=new Date(item.end).toISOString();
      if (scheduledItem) {
        scheduledItem.title=title;
        scheduledItem.end=endAt;
        continue;
      }
      scheduledItem = persistence ? { token: token(), key: item.key, owner: ownerUserID, meetingID: item.meeting.id,
        title, start: new Date(item.start).toISOString(), end: endAt, timer: null }
        : { key: item.key, owner: ownerUserID, meetingID: item.meeting.id, title,
          start: new Date(item.start).toISOString(), end: endAt, timer: null };
      scheduled.set(item.key, scheduledItem);
      if (item.start <= time) { scheduledItem.fired=true;scheduled.set(item.key,scheduledItem);due.push(scheduledItem); }
      else if (!persistence) scheduledItem.timer = setTimer(() => {
        const current = now(), currentTime = current instanceof Date ? current.getTime() : Date.parse(current);
        if (!enabled || scheduled.get(item.key) !== scheduledItem || !Number.isFinite(currentTime) || currentTime >= item.end) return;
        scheduledItem.timer = null;scheduledItem.fired = true;show(scheduledItem);
      }, item.start - time);
    }
    if (persistence) {
      const after = JSON.stringify([...scheduled.values()].map(({ timer, ...record }) => record));
      if (needsSync || before !== after || scopeChanged) saveAndSync();
    }
    for (const item of due) show(item);
  }
  function fire(tokenValue, { owner, reminders, at = now() } = {}) {
    if (!persistence || !/^[a-f0-9]{32}$/u.test(tokenValue)) return false;
    const item = [...scheduled.values()].find(record => record.token === tokenValue);
    if (!item) return false;
    if (item.fired) return false;
    const time = at instanceof Date ? at.getTime() : Date.parse(at);
    if (owner === item.owner && reminders === true && Number.isFinite(time) && time < Date.parse(item.start)) {
      // Replace the consumed one-shot task with a near-term retry if Windows wakes it early.
      saveAndSync({ rearmToken: item.token, rearmStart: new Date(time + 5_000).toISOString() });
      return false;
    }
    const authorized = owner === item.owner && reminders === true && Number.isFinite(time)
      && time >= Date.parse(item.start) && time < Date.parse(item.end);
    if (authorized) {
      item.fired=true;
      if (!saveAndSync()) return false;
      show(item);
      return true;
    }
    scheduled.delete(recordKey(item));
    saveAndSync();
    return authorized;
  }
  function dispose() {
    for (const key of scheduled.keys()) cancel(key);
    ownerUserID = null; enabled = false;
  }
  return { update, fire, dispose, get error() { return lastError; } };
}

const LIMIT = 32;
const xml = value => String(value).replace(/[&<>"']/gu, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[character]));

export function meetingReminderIDFromActivation(details) {
  if (details?.type !== 'click' || typeof details.arguments !== 'string') return null;
  const ids = new URLSearchParams(details.arguments).getAll('meetingId');
  return ids.length === 1 && ids[0].length > 0 && ids[0].length <= 4096 ? ids[0] : null;
}

/** Local, opt-in reminders for the currently selected and routed calendar events. */
export function createMeetingReminders({ Notification, activate = () => {}, now = () => new Date(),
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof Notification !== 'function' || typeof activate !== 'function' || typeof now !== 'function'
    || typeof setTimer !== 'function' || typeof clearTimer !== 'function') throw TypeError('Invalid meeting reminder dependencies');
  let ownerUserID = null, enabled = false;
  const scheduled = new Map();
  const cancel = key => {
    const item = scheduled.get(key);
    if (item?.timer) clearTimer(item.timer);
    scheduled.delete(key);
  };
  function update({ owner, reminders, meetings, at = now() } = {}) {
    const currentOwner = typeof owner === 'string' && owner ? owner : null;
    const currentEnabled = reminders === true;
    if (currentOwner !== ownerUserID || currentEnabled !== enabled) {
      for (const key of scheduled.keys()) cancel(key);
      ownerUserID = currentOwner; enabled = currentEnabled;
    }
    const time = at instanceof Date ? at.getTime() : Date.parse(at);
    if (!enabled || !ownerUserID || !Array.isArray(meetings) || !Number.isFinite(time)) return;
    const valid = meetings.map(meeting => {
      const start = Date.parse(meeting?.start), end = Date.parse(meeting?.end);
      if (typeof meeting?.id !== 'string' || !meeting.id || !Number.isFinite(start) || !Number.isFinite(end) || end <= time || end <= start) return null;
      return { meeting, start, end, key: `${meeting.id}:${start}` };
    }).filter(Boolean).sort((a, b) => a.start - b.start).slice(0, LIMIT);
    const wanted = new Set(valid.map(item => item.key));
    for (const key of scheduled.keys()) if (!wanted.has(key)) cancel(key);
    for (const item of valid) {
      if (scheduled.has(item.key)) continue;
      const scheduledItem = { timer: null };
      scheduled.set(item.key, scheduledItem);
      const notify = () => {
        const current = now(), currentTime = current instanceof Date ? current.getTime() : Date.parse(current);
        if (!enabled || scheduled.get(item.key) !== scheduledItem || !Number.isFinite(currentTime) || currentTime >= item.end) return;
        scheduledItem.timer = null;
        try {
          const title = 'Meeting starts now', body = item.meeting.title || 'Your calendar meeting is starting.';
          const launch = `meetingId=${encodeURIComponent(item.meeting.id)}`;
          const toastXml = `<toast launch="${xml(launch)}"><visual><binding template="ToastGeneric"><text>${xml(title)}</text><text>${xml(body)}</text></binding></visual></toast>`;
          const notification = new Notification({ title, body, toastXml });
          notification.on?.('click', () => activate(item.meeting.id));
          notification.show();
        } catch { /* Windows notification settings may block local delivery. */ }
      };
      if (item.start <= time) notify();
      else scheduledItem.timer = setTimer(notify, item.start - time);
    }
  }
  function dispose() {
    for (const key of scheduled.keys()) cancel(key);
    ownerUserID = null; enabled = false;
  }
  return { update, dispose };
}

(() => {
  if (typeof importScripts === 'function') importScripts('organization.js');
  const extension = globalThis.ReelExtension ?? require('./organization.js');
  const STORAGE_KEY = 'reelMeetingAlertState';
  const PREFIX = 'reel-meeting:';
  const MAX_EVENTS = 100;
  const MAX_TITLE = 140;
  const MAX_ID = 160;
  const ALLOWED_STATUSES = new Set(['scheduled', 'awaiting_consent']);
  const ICON = 'icon128.png';

  function cleanEvent(raw, now) {
    if (!raw || typeof raw.id !== 'string' || !raw.id.trim() || raw.id.length > MAX_ID) return null;
    if (!ALLOWED_STATUSES.has(raw.status)) return null;
    const start = Date.parse(raw.start);
    const end = Date.parse(raw.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end <= now) return null;
    const title = typeof raw.title === 'string' ? raw.title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_TITLE) : '';
    return { id: raw.id, title, start, end, status: raw.status, alerted: false };
  }

  function sanitizeSchedule(raw, now) {
    if (!raw || (raw.uid !== null && (typeof raw.uid !== 'string' || !raw.uid.trim() || raw.uid.length > 160))) return null;
    if (!['ask', 'approved'].includes(raw.consent_mode)) return null;
    const events = [];
    const ids = new Set();
    for (const item of (Array.isArray(raw.events) ? raw.events : []).slice(0, MAX_EVENTS)) {
      const event = cleanEvent(item, now);
      if (event && !ids.has(event.id)) { ids.add(event.id); events.push(event); }
    }
    return { uid: raw.uid, consent_mode: raw.consent_mode, events: raw.uid ? events : [] };
  }

  function alarmName(id) { return PREFIX + encodeURIComponent(id); }
  function notificationName(id) { return PREFIX + 'notice:' + encodeURIComponent(id); }

  function createMeetingAlertManager(chromeApi, now = () => Date.now(), recordURL = extension.recordURL) {
    const organization = chromeApi.runtime?.getManifest?.().version_name || "";
    let operationQueue = Promise.resolve();
    const serialize = fn => (...args) => {
      const operation = operationQueue.then(() => fn(...args), () => fn(...args));
      operationQueue = operation.catch(() => {});
      return operation;
    };
    async function read() {
      const value = await chromeApi.storage.local.get(STORAGE_KEY);
      const state = value?.[STORAGE_KEY];
      return recordURL && state?.origin === recordURL.origin && state?.organization === organization ? state : null;
    }
    async function write(state) { await chromeApi.storage.local.set({ [STORAGE_KEY]: { ...state, origin: recordURL.origin, organization } }); }
    async function clearPrivateState() {
      const alarms = await chromeApi.alarms.getAll();
      await Promise.all(alarms.filter(alarm => alarm.name.startsWith(PREFIX)).map(alarm => chromeApi.alarms.clear(alarm.name)));
      const notifications = await chromeApi.notifications.getAll();
      await Promise.all(Object.keys(notifications || {}).filter(id => id.startsWith(PREFIX)).map(id => chromeApi.notifications.clear(id)));
      await chromeApi.storage.local.remove(STORAGE_KEY);
    }
    async function reconcile(state) {
      const currentTime = now();
      const events = state.events.filter(event => event.end > currentTime);
      const mayAlert = state.uid && state.consent_mode === 'ask';
      const due = mayAlert ? events.filter(event => !event.alerted && event.start <= currentTime) : [];
      for (const event of due) event.alerted = true;
      const expiredCount = state.events.length - events.length;
      state.events = events;
      if (due.length || expiredCount) await write(state); // Persist dedupe before invoking the OS notification API and discard expired titles.

      const expected = new Map();
      if (mayAlert) {
        for (const event of events) {
          if (!event.alerted && event.start > currentTime) expected.set(alarmName(event.id), event.start);
        }
      }
      const alarms = await chromeApi.alarms.getAll();
      const existingAlarms = new Map(alarms.map(alarm => [alarm.name, alarm]));
      for (const alarm of alarms) {
        const expectedTime = expected.get(alarm.name);
        if (alarm.name.startsWith(PREFIX) && (expectedTime === undefined || alarm.scheduledTime !== expectedTime)) {
          await chromeApi.alarms.clear(alarm.name);
          existingAlarms.delete(alarm.name);
        }
      }
      for (const [name, time] of expected) if (existingAlarms.get(name)?.scheduledTime !== time) {
        await chromeApi.alarms.create(name, { when: time });
      }
      const allowedNotices = new Set(mayAlert ? events.map(event => notificationName(event.id)) : []);
      const notifications = await chromeApi.notifications.getAll();
      for (const id of Object.keys(notifications || {})) {
        if (id.startsWith(PREFIX + 'notice:') && !allowedNotices.has(id)) await chromeApi.notifications.clear(id);
      }
      if (due.length) {
        for (const event of due) {
          const id = notificationName(event.id);
          await chromeApi.notifications.create(id, {
            type: 'basic', iconUrl: ICON,
            title: 'Meeting detected. Allow Reel to join?',
            message: event.title ? `Starting now: ${event.title}` : 'A scheduled meeting is starting.',
            buttons: [{ title: 'Allow' }, { title: 'Not now' }],
            requireInteraction: true,
          });
        }
      }
      return state;
    }
    async function publish(raw) {
      if (!recordURL) return false;
      const parsed = sanitizeSchedule(raw, now());
      if (!parsed) return false;
      let old = await read();
      if (old?.uid !== parsed.uid || parsed.uid === null) {
        await clearPrivateState();
        old = { uid: parsed.uid, consent_mode: parsed.consent_mode, events: [] };
      }
      const previous = new Map((old.events || []).map(event => [event.id, event]));
      parsed.events = parsed.events.map(event => {
        const prior = previous.get(event.id);
        return prior ? { ...event, alerted: Boolean(prior.alerted) } : event;
      });
      await write(parsed);
      await reconcile(parsed);
      return true;
    }
    async function wake(alarm) {
      if (alarm && !alarm.name.startsWith(PREFIX)) return;
      const state = await read();
      if (state) await reconcile(state);
      else await clearPrivateState();
    }
    async function notificationAction(notificationId, actionIndex) {
      if (!notificationId.startsWith(PREFIX + 'notice:')) return;
      if (actionIndex === 0 || actionIndex === undefined) {
        const encodedId = notificationId.slice((PREFIX + 'notice:').length);
        let eventId;
        try { eventId = decodeURIComponent(encodedId); } catch { return; }
        if (!eventId) return;
        const current = await read();
        if (!current?.uid || current.consent_mode !== 'ask' || !(current.events || []).some(event => event.id === eventId && event.alerted && event.end > now())) {
          await chromeApi.notifications.clear(notificationId);
          return;
        }
        await chromeApi.tabs.create({
          url: `${recordURL.origin}/notetaker#calendar-meeting=${encodeURIComponent(eventId)}`,
          active: true,
        });
      }
      await chromeApi.notifications.clear(notificationId);
    }
    return {
      publish: serialize(publish),
      wake: serialize(wake),
      notificationAction: serialize(notificationAction),
      clearPrivateState: serialize(clearPrivateState),
      reconcile: serialize(reconcile),
    };
  }

  async function runRecorderShortcut(chromeApi, command, recordURL) {
    const actions = {
      'recorder-start-stop': 'stop',
      'recorder-pause-resume': 'pause',
      'recorder-cancel': 'cancel',
    };
    if (!recordURL || !Object.hasOwn(actions, command)) return;
    const action = actions[command];
    const urlPattern = `${recordURL.protocol}//${recordURL.hostname}/record*`;
    const tabs = (await chromeApi.tabs.query({ url: urlPattern }))
      .filter(tab => !tab.discarded && typeof tab.id === 'number' && extension.isRecorderPage(tab.url, recordURL));
    const send = (tab, action) => chromeApi.tabs.sendMessage(
      tab.id, { type: 'REEL_RECORDER_SHORTCUT', action }, { frameId: 0 },
    ).catch(() => false);
    const states = await Promise.all(tabs.map(tab => send(tab, 'active')));
    const recordingTabs = tabs.filter((_, index) => states[index] === true);
    // In the event of multiple captures, use a window's own controls to choose which one to change.
    if (recordingTabs.length > 1) return;
    const [recording] = recordingTabs;
    if (recording) {
      if (action === 'cancel') await activateRecorder(chromeApi, recording);
      await send(recording, action);
    } else if (action === 'stop') {
      const recent = tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
      if (!recent) {
        await chromeApi.tabs.create({ url: recordURL.href, active: true });
      } else {
        await activateRecorder(chromeApi, recent);
        await send(recent, 'open');
      }
    }
  }

  async function activateRecorder(chromeApi, tab) {
    await chromeApi.tabs.update(tab.id, { active: true });
    await chromeApi.windows.update(tab.windowId, { focused: true });
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { createMeetingAlertManager, runRecorderShortcut, sanitizeSchedule };
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    const manager = createMeetingAlertManager(chrome);
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.type !== 'REEL_MEETING_SCHEDULE' || !extension.isRecordPage(sender.url, extension.recordURL)) return false;
      manager.publish(message).then(sendResponse, () => sendResponse(false));
      return true;
    });
    chrome.alarms.onAlarm.addListener(alarm => { manager.wake(alarm); });
    chrome.notifications.onButtonClicked.addListener((id, index) => { manager.notificationAction(id, index); });
    chrome.notifications.onClicked.addListener(id => { manager.notificationAction(id, 0); });
    chrome.runtime.onStartup.addListener(() => { manager.wake(); });
    chrome.runtime.onInstalled.addListener(() => { manager.wake(); });
    chrome.commands?.onCommand.addListener(command => {
      void runRecorderShortcut(chrome, command, extension.recordURL).catch(() => {});
    });
  }
})();

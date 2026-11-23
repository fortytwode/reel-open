// Calendar and browser-extension meeting controls for the recorder page.
// The module deliberately keeps calendar data in memory only; Firebase tokens are
// obtained from the caller's session and are never persisted or logged.
import * as org from "./organization.js?v=20261121-public-signup";
const { organization } = org;
const publicSignup = org.publicSignup ?? false;
const API = organization?.meetingServiceURL;
const WEB_BASE = organization?.webBase || location.origin;
const STATUSES = {
  scheduled: "Scheduled",
  awaiting_consent: "Awaiting your consent",
  dispatching: "Requesting meeting entry",
  requesting_entry: "Requesting meeting entry",
  awaiting_admission: "Waiting for host admission",
  joined: "Joined",
  recording: "Recording",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};
const CLOUD_FAILURES = {
  startup: "Reel could not start cloud capture. If the call is still running, use the recorder to capture it manually.",
  lobby_timeout: "The host did not admit Reel in time. Ask the host to admit Reel when it joins a future call.",
  lobby_denied: "The meeting denied Reel entry. Ask the host whether recording is allowed before trying again.",
  auth: "Reel could not sign in or needed a person to continue. Check the meeting’s sign-in and guest access requirements.",
  capture_interrupted: "Cloud capture stopped unexpectedly. Check for a downloadable recording below.",
};
const RECOVERY_STATUSES = {
  processing: "Transcribing the partial recording…",
  recovered: "Partial transcript ready. You can download the recovered files below.",
  no_speech: "No speech was found in the partial recording.",
  review_required: "Review the partial transcript before using it.",
  transcript_too_long: "The partial transcript is too long to summarize. Download it below if available.",
  audio_unavailable: "Audio from the partial recording could not be transcribed.",
};
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));
const dateText = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time unavailable" : date.toLocaleString();
};
const statusText = (status) => STATUSES[status] || "Status unavailable";

function meetingURLAllowed(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443" || url.hash) return false;
    const host = url.hostname.toLowerCase();
    if (host === "meet.google.com") return /^\/(?:[a-z]{3}-[a-z]{4}-[a-z]{3}|meet\/[A-Za-z0-9_-]{3,})\/?$/i.test(url.pathname);
    if (host === "zoom.us" || host.endsWith(".zoom.us")) return /^\/j\/\d{9,11}\/?$/.test(url.pathname) || /^\/wc\/\d{9,11}\/join\/?$/.test(url.pathname);
    if (host === "teams.microsoft.com") return /^\/l\/meetup-join\/[A-Za-z0-9%._~-]+\/\d+\/?$/.test(url.pathname) || /^\/meet\/\d+\/?$/.test(url.pathname);
    if (host === "teams.live.com") return /^\/meet\/\d+\/?$/.test(url.pathname);
  } catch {}
  return false;
}

function cloudProviderForURL(value, capability) {
  if (!meetingURLAllowed(value) || !Array.isArray(capability?.cloud_providers)) return null;
  const host = new URL(value).hostname;
  const provider = host === "meet.google.com" ? "google_meet"
    : host === "teams.microsoft.com" || host === "teams.live.com" ? "teams" : null;
  return provider && capability.cloud_providers.includes(provider) ? provider : null;
}

function readFragmentRequest() {
  const match = location.hash.match(/(?:^#|&)meeting-request=([^&]*)/);
  if (!match) return null;
  let request = null;
  try {
    const raw = decodeURIComponent(match[1]);
    try { request = JSON.parse(raw); } catch { request = { url: raw }; }
  } catch {}
  // Do not leave a join URL in browser history or the address bar.
  try { history.replaceState(history.state, "", location.pathname + location.search); } catch {}
  if (!request || typeof request.url !== "string" || !meetingURLAllowed(request.url)) return null;
  return { url: request.url, title: typeof request.title === "string" ? request.title.slice(0, 180) : "" };
}

export function mountMeetingCalendar({ container, session, onError, onSelectionChange, calendarResult } = {}) {
  if (!container || typeof session !== "function") throw new TypeError("container and session are required");
  const state = { uid: null, config: null, events: [], history: [], cursor: null, firstHistoryCursor: null, loadedHistory: false, due: [], capabilities: null, busy: false, error: "", download: null, browserRequest: null, disposed: false, picker: null };
  let pollTimer = null;
  let calendarNotice = calendarResult === "connected" ? "Google Calendar connected. Choose which calendars Reel can read."
    : calendarResult === "error" ? "Google Calendar connection did not finish. Try connecting again." : "";

  container.innerHTML = `
    <section class="mc-card" aria-labelledby="mc-heading">
      <div class="mc-heading"><div><h2 id="mc-heading">Meeting calendar</h2><p class="mc-subtitle">Connect Google Calendar to request meeting entry.</p></div><span class="mc-live" data-live></span></div>
      <p class="mc-message" data-message role="status" aria-live="polite"></p>
      <div class="mc-browser-request" data-browser hidden></div>
      <div class="mc-capabilities" data-capabilities></div>
      <div class="mc-connect" data-connect></div>
      <div class="mc-settings" data-settings></div>
      <div class="mc-events" data-events></div>
      <details class="mc-note" data-extension-note><summary>Detect meetings in Chrome or Edge</summary><p><a href="${esc(WEB_BASE)}/downloads/reel-meeting-prompt-0.1.1.zip" download>Download the meeting prompt extension</a>. Unzip it, open chrome://extensions or edge://extensions, turn on Developer mode, choose Load unpacked, and select the unzipped folder. On a meeting preview page, choose Allow, then confirm participant consent in Reel.</p></details>
      <p class="mc-note" data-cloud-note>The cloud note taker can work while this computer is closed after you grant standing consent. Google Calendar is the only server calendar supported here. Outlook and Apple Calendar are available through the existing native connection; automatic server connection is not available.</p>
    </section>`;

  const q = (selector) => container.querySelector(selector);
  const notifyError = (error) => {
    const message = error instanceof Error ? error.message : String(error || "Request failed");
    const changed = state.error !== message;
    state.error = message;
    if (changed && typeof onError === "function") onError(error);
    render();
  };
  async function currentSession(expectedUid) {
    const current = await session();
    if (!current?.uid) {
      if (state.uid) clearForAccountChange(null);
      return null;
    }
    if (expectedUid && current.uid !== expectedUid) {
      if (state.uid !== current.uid) clearForAccountChange(current.uid);
      return null;
    }
    if (state.uid && current.uid !== state.uid) clearForAccountChange(current.uid);
    if (!state.uid) state.uid = current.uid;
    return current;
  }
  function relaySchedule() {
    if (publicSignup) return;
    window.postMessage({type:'REEL_MEETING_SCHEDULE', uid:state.uid,
      consent_mode:state.config?.consent_mode || 'ask',
      events:state.events.map(({id,title,start,end,status}) => ({id,title,start,end,status}))}, location.origin);
  }
  function clearForAccountChange(uid = null) {
    state.uid = uid;
    state.history = [];
    state.cursor = null;
    state.firstHistoryCursor = null;
    state.loadedHistory = false;
    state.config = null; state.events = []; state.due = []; state.capabilities = null;
    state.error = ""; state.busy = false; state.download = null; state.picker = null;
    relaySchedule();
    for (const element of container.querySelectorAll('input[type="checkbox"]')) element.checked = false;
  }
  async function request(path, method = "GET", body, expectedUid) {
    const current = await currentSession(expectedUid);
    if (!current || state.disposed) throw new Error("Sign in to use meeting calendar.");
    const token = await current.getIdToken();
    // Re-check after token retrieval so a pending request never crosses accounts.
    const latest = await session();
    if (state.disposed || !latest?.uid || latest.uid !== current.uid || current.isCurrent?.() === false) {
      throw new Error("Your signed-in account changed. Refreshing calendar data.");
    }
    const response = await fetch(API + path, {
      method, redirect: "error", cache: "no-store",
      headers: { Authorization: "Bearer " + token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(25000),
    });
    let data = {};
    if (response.status !== 204) {
      try { data = await response.json(); } catch {}
    }
    const after = await session();
    if (!after?.uid || after.uid !== current.uid || current.isCurrent?.() === false) {
      throw new Error("Your signed-in account changed. Refreshing calendar data.");
    }
    if (!response.ok) throw new Error(data.error || data.message || `Meeting service returned ${response.status}`);
    return data;
  }

  function render() {
    if (state.disposed) return;
    const consentKey = JSON.stringify([state.uid, state.config?.enabled, state.config?.scope_revision, state.config?.consent_mode]);
    const savedInputs = [...container.querySelectorAll('input[type="checkbox"]:not([data-calendar-choice]),select')]
      .filter(el => consentKey === state.renderedConsentKey || !["consent", "standing-attest"].includes(el.dataset.field))
      .map(el => ({
      selector: el.id ? '#' + CSS.escape(el.id) : el.dataset.attest ? '[data-attest="' + CSS.escape(el.dataset.attest) + '"]' : '[data-field="' + el.dataset.field + '"]',
      checked: el.checked, value: el.value,
    }));
    state.renderedConsentKey = consentKey;
    const capability = state.capabilities || {};
    const calendarAvailable = capability.calendar === true;
    const calendarOAuth = publicSignup && capability.calendar_oauth === true;
    const calendarAuthorized = calendarOAuth && capability.calendar_authorized === true;
    const canSelectCalendars = calendarAvailable && (!publicSignup || calendarAuthorized);
    const botAvailable = capability.bot === true;
    const desktop = capability.provider === "desktop";
    const cloudNames = [["teams", "Teams"], ["google_meet", "Google Meet"]]
      .filter(([provider]) => Array.isArray(capability.cloud_providers) && capability.cloud_providers.includes(provider)).map(([, name]) => name);
    const hybridCloud = cloudNames.length > 0;
    const platform = String(capability.platform || navigator.platform || "").toLowerCase();
    const isMac = /mac|darwin/.test(platform);
    q(".mc-subtitle").textContent = publicSignup ? "Connect Google Calendar to find meetings and access your private notes."
      : "Choose which Google calendars Reel can use for meetings and recaps.";
    q("[data-extension-note]").hidden = publicSignup || desktop;
    q("[data-cloud-note]").hidden = desktop && !hybridCloud;
    q("[data-cloud-note]").textContent = publicSignup
      ? "Connecting Calendar lets Reel read your selected calendars. You choose whether Reel may join and record meetings."
      : desktop && hybridCloud
      ? `${cloudNames.join(" and ")} cloud note taker can join eligible meetings from your connected Google Calendar while this computer is closed, after participant consent. Cloud browser requests must match a connected calendar occurrence. Other providers use the Mac app while it is awake. Outlook and Apple Calendar remain native connections.`
      : "The cloud note taker can work while this computer is closed after you grant standing consent. Google Calendar is the only server calendar supported here. Outlook and Apple Calendar are available through the existing native connection; automatic server connection is not available.";
    q("[data-live]").textContent = document.hidden ? "Paused while page is hidden" : state.busy ? "Working…" : "Live status";
    q("[data-message]").textContent = state.error || (!state.uid ? "Sign in to view or connect a calendar."
      : calendarResult === "connected" && !calendarAuthorized ? "" : calendarNotice);
    q("[data-message]").classList.toggle("is-error", !!state.error);
    if (!state.error && state.download && state.download.expiresAt > Date.now()) {
      const link = document.createElement('a'); link.href = state.download.url; link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'Open download (available for five minutes)';
      q('[data-message]').replaceChildren(link);
    }

    q("[data-capabilities]").innerHTML = [
      !calendarAvailable && !calendarOAuth ? `<p class="mc-unavailable">Google Calendar connection is not available right now.</p>` : "",
      desktop && !publicSignup ? `<p class="mc-note">Configure autojoin in the Mac app; Reel must stay awake. Windows autojoin is not yet available.</p>` : !botAvailable && (!publicSignup || calendarAuthorized) ? `<p class="mc-unavailable">Cloud meeting entry is not available right now.</p>` : "",
    ].join("");

    const connected = !!state.config?.enabled;
    const picker = state.picker;
    const ready = state.uid && !state.busy;
    const count = state.config?.calendar_ids?.length || 0;
    const connectGoogle = `<button type="button" class="mc-primary" data-action="calendar-oauth" ${!ready ? "disabled" : ""}>${connected || calendarAuthorized ? "Reconnect Google Calendar" : "Connect Google Calendar"}</button>`;
    const disconnectGoogle = `<button type="button" data-action="disconnect" ${!ready ? "disabled" : ""}>Disconnect calendar</button>`;
    q("[data-connect]").innerHTML = calendarOAuth && !calendarAuthorized
      ? connectGoogle + (connected ? disconnectGoogle : "") : !canSelectCalendars ? "" : picker ? `
      <fieldset class="mc-calendar-choices" ${state.busy ? "disabled" : ""}>
        <legend>Google calendars</legend>
        ${picker.sources.map(({id, title, primary}) => `<label class="mc-check"><input type="checkbox" data-calendar-choice value="${esc(id)}" ${picker.selected.has(id) ? "checked" : ""}>${esc(title)}${primary ? (publicSignup ? " (primary)" : " (work primary)") : ""}</label>`).join("") || '<p class="mc-note">No Google calendars are available to this account.</p>'}
        ${picker.unavailable ? '<p class="mc-note">Some saved calendars are unavailable. Saving replaces them with your current choices.</p>' : ""}
        <div class="mc-actions"><button type="button" class="mc-primary" data-action="save-calendars" ${!picker.selected.size || picker.selected.size > 25 ? "disabled" : ""}>Save selected calendars</button><button type="button" data-action="cancel-calendars">Cancel</button></div>
      </fieldset>` : `
      ${connected ? `<p class="mc-connected">${count} Google ${count === 1 ? "calendar" : "calendars"} selected</p>` : ""}
      <button type="button" class="mc-primary" data-action="choose-calendars" ${!ready ? "disabled" : ""}>${connected ? "Change calendars" : "Choose Google calendars"}</button>
      ${calendarAuthorized && !connected ? connectGoogle + disconnectGoogle : ""}`;

    const mode = state.config?.consent_mode === "approved" ? "approved" : "ask";
    const cloudCalendar = !desktop || hybridCloud;
    q("[data-settings]").innerHTML = connected && canSelectCalendars ? !cloudCalendar ? `
      <div class="mc-consent-controls"><button type="button" data-action="sync" ${state.busy ? "disabled" : ""}>Sync calendar</button><button type="button" data-action="disconnect" ${state.busy ? "disabled" : ""}>Disconnect calendar</button></div>` : `
      <div class="mc-consent-controls">
        <label class="mc-select-label" for="mc-consent-mode">Calendar consent</label>
        <select id="mc-consent-mode" data-field="consent" ${state.busy ? "disabled" : ""}>
          <option value="ask" ${mode === "ask" ? "selected" : ""}>Ask me for each meeting</option>
          <option value="approved" ${mode === "approved" ? "selected" : ""}>Standing consent for scheduled meetings</option>
        </select>
        <label class="mc-check"><input type="checkbox" data-field="standing-attest" ${state.busy ? "disabled" : ""}> I confirm participants have agreed to recording under this standing consent.</label>
        <button type="button" data-action="save-consent" ${state.busy ? "disabled" : ""}>Save consent setting</button>
        <button type="button" data-action="sync" ${state.busy ? "disabled" : ""}>Sync calendar</button>
        ${calendarAuthorized ? connectGoogle : ""}
        <button type="button" data-action="disconnect" ${state.busy ? "disabled" : ""}>Disconnect calendar</button>
      </div>` : "";

    const events = [...state.events, ...state.history.filter(item => !state.events.some(event => event.id === item.id))];
    const dueById = new Map((state.due || []).map((event) => [event.id, event]));
    const rows = [...events];
    for (const due of state.due || []) if (!rows.some((event) => event.id === due.id)) rows.push(due);
    if (!rows.length) {
      const emptyText = publicSignup && !connected ? "" : "No calendar meetings to show. Sync to refresh.";
      q("[data-events]").innerHTML = emptyText ? `<p class="mc-empty">${emptyText}</p>` : "";
    }
    else q("[data-events]").innerHTML = `<h3>Meetings</h3><ul class="mc-list">${rows.map((event) => {
      const failed = event.status === "failed";
      const recoveryStatus = failed && Object.hasOwn(RECOVERY_STATUSES, event.recovery_status)
        ? RECOVERY_STATUSES[event.recovery_status] : "";
      const recovery = failed && event.recovery_available === true && event.recovery_status !== "processing"
        ? `<button type="button" data-action="recover" data-id="${esc(event.id)}" ${state.busy ? "disabled" : ""}>Transcribe partial recording</button>` : "";
      const downloads = [event.video_available ? 'video' : null, event.transcript_available ? 'transcript' : null,
        (failed && event.recovery_summary_available === true || publicSignup && event.summary_available === true) ? 'summary' : null].filter(Boolean)
        .map(kind => `<button type="button" data-action="download-${kind}" data-id="${esc(event.id)}" ${state.busy ? 'disabled' : ''}>Download ${failed ? "partial " : ""}${kind === "summary" ? "notes" : kind}</button>`).join('');
      const notion = failed || publicSignup ? "" : event.notion_url && /^https:\/\/(?:www\.)?notion\.so\//i.test(event.notion_url)
        ? `<a href="${esc(event.notion_url)}" target="_blank" rel="noopener">Open Notion notes</a>`
        : event.transcript_available ? `<button type="button" data-action="retry-notion" data-id="${esc(event.id)}" ${state.busy ? 'disabled' : ''}>Send notes to Notion</button>` : '';
      const cloudEvent = event.capture_provider === "cloud";
      const eventDesktop = desktop && !cloudEvent;
      const actionable = (!publicSignup || calendarAuthorized) && dueById.has(event.id) && event.status === "awaiting_consent" && (cloudEvent ? (botAvailable || hybridCloud) : (!desktop && botAvailable));
      const desktopJoin = eventDesktop && isMac && /^[a-f0-9]{64}$/i.test(String(event.id || ""))
        ? `<a class="mc-primary" href="reel://join-meeting?id=${encodeURIComponent(event.id)}">Open in Reel</a>`
        : eventDesktop && !isMac ? `<a href="${esc(WEB_BASE)}/record?mode=meeting">Capture manually</a>` : "";
      const failure = failed && Object.hasOwn(CLOUD_FAILURES, event.failure_category)
        ? CLOUD_FAILURES[event.failure_category] : "";
      const detailText = failure || (event.notion_status === "calendar_selection_required" ? event.detail : "");
      const detail = detailText ? `<span class="mc-status">${esc(detailText)}</span>` : "";
      return `<li class="mc-event"><div class="mc-event-copy"><strong>${esc(event.title || "Untitled meeting")}</strong><time>${esc(dateText(event.start))}</time><span class="mc-status mc-status-${esc(event.status || "unknown")}">${esc(statusText(event.status))}</span>${detail}${recoveryStatus ? `<span class="mc-status">${esc(recoveryStatus)}</span>` : ""}<div class="mc-actions">${downloads}${recovery}${notion}${desktopJoin}</div></div>${actionable ? `<div class="mc-event-actions"><label class="mc-check"><input type="checkbox" data-attest="${esc(event.id)}"> I confirm participants agreed to recording</label><button type="button" data-action="approve" data-id="${esc(event.id)}" ${state.busy ? "disabled" : ""}>Approve and join</button><button type="button" data-action="decline" data-id="${esc(event.id)}" ${state.busy ? "disabled" : ""}>Decline</button></div>` : ""}</li>`;
    }).join("")}</ul>${state.cursor ? `<button type="button" data-action="earlier-recordings" ${state.busy ? "disabled" : ""}>Earlier recordings</button>` : ""}`;

    const browserHost = q("[data-browser]");
    if (state.browserRequest) {
      browserHost.hidden = false;
      const cloudRequest = cloudProviderForURL(state.browserRequest.url, capability);
      const cloudRequestName = cloudRequest === "google_meet" ? "Google Meet" : "Teams";
      browserHost.innerHTML = desktop && !cloudRequest ? `<div class="mc-browser-card"><strong>Meeting requested by the browser</strong><p>${esc(state.browserRequest.title || "A supported meeting")}</p><p>${isMac ? "Open this meeting link in Reel to continue." : "Open manual capture in Reel, then choose the meeting from your browser picker."}</p><a href="${isMac ? `reel://meeting-link?url=${encodeURIComponent(state.browserRequest.url)}` : `${esc(WEB_BASE)}/record?mode=meeting`}">${isMac ? "Open in Reel" : "Capture manually"}</a> <button type="button" data-action="browser-dismiss">Dismiss</button></div>` : `<div class="mc-browser-card"><strong>Meeting requested by the browser extension</strong><p>${esc(state.browserRequest.title || "A supported meeting")}</p><p>${cloudRequest ? "This request must match an eligible meeting in your connected Google Calendar. Reel will not open this link." : "Reel will ask the meeting provider to admit its note taker. This page will not open the meeting link."}</p><label class="mc-check"><input type="checkbox" data-field="browser-attest"> I confirm the participants have agreed to recording this meeting.</label><div class="mc-actions"><button type="button" data-action="browser-join" ${!state.uid || state.busy || !(botAvailable || cloudRequest) ? "disabled" : ""}>${cloudRequest ? `Consent and request ${cloudRequestName} entry` : "Consent and request entry"}</button><button type="button" data-action="browser-dismiss" ${state.busy ? "disabled" : ""}>Dismiss</button></div></div>`;
    } else { browserHost.hidden = true; browserHost.innerHTML = ""; }
    for (const input of savedInputs) {
      const element = q(input.selector);
      if (!element) continue;
      if (element.type === 'checkbox') element.checked = input.checked;
      else if (element.tagName === 'SELECT') element.value = input.value;
    }
  }

  async function refresh(force = false) {
    if (state.disposed || document.hidden || (state.busy && !force)) return;
    try {
      const current = await currentSession();
      if (!current) { state.uid = null; state.config = null; state.events = []; state.due = []; state.capabilities = null; render(); return; }
      const uid = current.uid;
      const [settings, due] = await Promise.all([
        request("/calendar/settings", "GET", undefined, uid),
        publicSignup ? null : request("/calendar/meetings", "GET", undefined, uid).catch((error) => ({ _error: error })),
      ]);
      if (state.uid !== uid || current.isCurrent?.() === false || state.disposed) return;
      const previous = state.config;
      state.config = settings.config || null;
      state.events = Array.isArray(settings.events) ? settings.events : [];
      if (publicSignup) {
        const firstCursor = settings.next_history_before || null;
        if (firstCursor !== state.firstHistoryCursor) {
          state.history = [];
          state.loadedHistory = false;
        }
        state.firstHistoryCursor = firstCursor;
        if (!state.loadedHistory) state.cursor = firstCursor;
      }
      state.capabilities = settings.capabilities || { calendar: false, bot: false };
      relaySchedule();
      state.due = publicSignup ? state.events : Array.isArray(due) ? due : Array.isArray(due.meetings) ? due.meetings : Array.isArray(due.events) ? due.events : [];
      if (due?._error) state.error = due._error.message;
      else state.error = "";
      if (previous?.scope_revision !== state.config?.scope_revision || previous?.enabled !== state.config?.enabled) {
        state.picker = null;
        onSelectionChange?.();
      }
      render();
    } catch (error) { if (!state.disposed) notifyError(error); }
  }

  async function act(button) {
    if (state.disposed || state.busy || button.disabled) return;
    const action = button.dataset.action;
    const eventId = button.dataset.id;
    const selectedMode = q('[data-field="consent"]')?.value || "ask";
    const standingAttested = !!q('[data-field="standing-attest"]')?.checked;
    const scopeRevision = state.config?.scope_revision;
    const meetingAttested = eventId ? !!q(`[data-attest="${CSS.escape(eventId)}"]`)?.checked : false;
    const browserAttested = !!q('[data-field="browser-attest"]')?.checked;
    state.busy = true; state.error = ""; calendarNotice = ""; render();
    let syncError;
    try {
      const uid = state.uid;
      if (action.startsWith("download-")) {
        const kind = action.slice("download-".length);
        const result = await request(`/calendar/meetings/${encodeURIComponent(eventId)}/artifacts/${kind}`, "GET", undefined, uid);
        const url = new URL(result.url);
        if (url.protocol !== "https:" || url.hostname !== "storage.googleapis.com") throw new Error("Unexpected download location");
        const link = document.createElement('a'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'Open download';
        state.download = {url:url.href, expiresAt:Date.now()+300000};
        q('[data-message]').replaceChildren(link); link.click();
      } else if (action === "earlier-recordings" && state.cursor) {
        const page = await request(`/calendar/meetings?history_before=${encodeURIComponent(state.cursor)}`, "GET", undefined, uid);
        state.history.push(...page.meetings);
        state.cursor = page.next_history_before || null;
        state.loadedHistory = true;
        return;
      } else if (action === "recover") {
        await request(`/calendar/meetings/${encodeURIComponent(eventId)}/recover`, "POST", {}, uid);
      } else if (action === "retry-notion") {
        await request(`/calendar/meetings/${encodeURIComponent(eventId)}/notion`, "POST", {}, uid);
      } else if (action === "calendar-oauth") {
        const result = await request("/calendar/oauth/start", "POST", {}, uid);
        const url = new URL(result.authorization_url);
        if (url.origin !== "https://accounts.google.com" || url.pathname !== "/o/oauth2/v2/auth" || url.username || url.password || url.hash)
          throw new Error("Google Calendar authorization is unavailable.");
        location.assign(url.href);
        return;
      } else if (action === "choose-calendars") {
        const result = await request("/calendar/sources", "GET", undefined, uid);
        const sources = result.sources;
        if (!Array.isArray(sources)) throw new Error("Google calendar choices are unavailable.");
        const saved = state.config?.enabled ? state.config.calendar_ids || [] : [];
        const selected = new Set(sources.filter(source => saved.includes(source.id)).map(source => source.id));
        state.picker = {sources, selected, unavailable: saved.length > selected.size};
      } else if (action === "cancel-calendars") {
        state.picker = null;
      } else if (action === "save-calendars") {
        const result = await request("/calendar/connect", "POST", { calendar_ids: [...state.picker.selected] }, uid);
        syncError = result.sync_error;
        state.picker = null;
      } else if (action === "save-consent") {
        const mode = selectedMode;
        const payload = { consent_mode: mode };
        if (mode === "approved") {
          if (!standingAttested) throw new Error("Confirm participant consent before enabling standing consent.");
          payload.participant_consent_attested = true;
          payload.scope_revision = scopeRevision;
        }
        await request("/calendar/settings", "POST", payload, uid);
      } else if (action === "disconnect") {
        await request("/calendar/disconnect", "POST", {}, uid);
        state.picker = null;
      } else if (action === "sync") {
        await request("/calendar/sync", "POST", {}, uid);
      } else if (action === "approve") {
        if (!meetingAttested) throw new Error("Confirm participant consent before approving this meeting.");
        await request(`/calendar/meetings/${encodeURIComponent(eventId)}/approve`, "POST", { participant_consent_attested: true }, uid);
      } else if (action === "decline") {
        await request(`/calendar/meetings/${encodeURIComponent(eventId)}/decline`, "POST", {}, uid);
      } else if (action === "browser-join") {
        if (!browserAttested) throw new Error("Confirm participant consent before requesting meeting entry.");
        const meeting = state.browserRequest;
        if (!meeting || !meetingURLAllowed(meeting.url)) throw new Error("This meeting link is not supported.");
        const desktop = state.capabilities?.provider === "desktop";
        if (desktop && !cloudProviderForURL(meeting.url, state.capabilities)) throw new Error("Cloud entry is not available for this meeting.");
        await request("/calendar/browser", "POST", { meeting_url: meeting.url, ...(meeting.title ? { title: meeting.title } : {}), participant_consent_attested: true }, uid);
        state.browserRequest = null;
      } else if (action === "browser-dismiss") {
        state.browserRequest = null;
      }
      if (state.uid === uid) {
        await refresh(true);
        if (syncError && state.uid === uid) state.error = syncError;
      }
    } catch (error) { if (!state.disposed) notifyError(error); }
    finally { state.busy = false; render(); }
  }

  const onClick = (event) => {
    const button = event.target.closest("button[data-action]");
    if (button && container.contains(button)) act(button);
  };
  const onChange = (event) => {
    const checkbox = event.target.closest("input[data-calendar-choice]");
    if (!checkbox || !state.picker) return;
    const selected = state.picker.selected;
    if (checkbox.checked) selected.add(checkbox.value);
    else selected.delete(checkbox.value);
    q('[data-action="save-calendars"]').disabled = !selected.size || selected.size > 25;
  };
  container.addEventListener("click", onClick);
  container.addEventListener("change", onChange);
  const onVisibility = () => {
    clearInterval(pollTimer);
    pollTimer = null;
    if (!document.hidden && !state.disposed) { refresh(); pollTimer = setInterval(refresh, 5000); }
  };
  document.addEventListener("visibilitychange", onVisibility);
  const fragmentRequest = readFragmentRequest();
  state.browserRequest = publicSignup ? null : fragmentRequest;
  refresh();
  if (!document.hidden) pollTimer = setInterval(refresh, 5000);

  return {
    refresh,
    resetAccount() {
      clearForAccountChange();
      render();
    },
    dispose() {
      state.disposed = true;
      clearInterval(pollTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      container.removeEventListener("click", onClick);
      container.removeEventListener("change", onChange);
      container.replaceChildren();
    },
  };
}

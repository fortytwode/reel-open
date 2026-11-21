import { googleAccountLabel, googleSignInProvider, loadAuth, observeReelAccount, FB_CDN, CLOUD_CONFIG, EMU } from "./reel/firebase.js?v=20261121-public-signup";
import { organization, organizationStorageKey, publicSignup } from "./organization.js?v=20261121-public-signup";
import { downloadURL, File, viewerURL } from "./reel/core.js?v=20261105-parity2";

import { displayedSharedTitle, resolveTitleRoom, saveSharedTitle, editSharedTitle, closeSharedTitleEditor } from "./reel/shared-title.js?v=20261105-parity2";

const el = (id) => document.getElementById(id);
const status = el("status");
let auth, am, fs, db, currentUser, entries = [], meetings = [], meetingShareIDs = new Set(), recent = [], loading = true, meetingLoading = false, loadError = "", meetingError = "", loadNumber = 0, meetingLoadNumber = 0, stopListening = () => {};
let preferences = new Map(), folders = [], organizationReady = false, organizationError = "", organizationMessage = "", creatingFolder = false, accountNumber = 0;
const pendingOrganization = new Set();
const openManagement = new Set();
let participantMeetings = [], participantLoading = false, participantError = "", participantLoadNumber = 0;
let note = null, noteLoading = false, noteError = "", noteLoadNumber = 0;
const DELIVERY_API = organization?.deliveryServiceURL + "/delivery/meetings";
const MEETINGS_API = organization?.meetingServiceURL + "/meetings";
const validUser = (u) => !!u;
const shareURL = (id) => viewerURL(id, organization);
function message(text, error = false) { status.textContent = text; status.classList.toggle("error", error); status.hidden = !text; }
function duration(seconds) { const value = Number(seconds); const t = Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0; return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; }
function createdMillis(r) {
  try {
    const value = r.createdAt?.toMillis?.();
    return Number.isFinite(value) ? value : 0;
  } catch { return 0; }
}
function ownerInitials(name) {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] || "?").slice(0, 2)).toLocaleUpperCase();
}
// Recent contains only IDs/times, scoped to this organization and account and intersected with its
// authenticated index before rendering. Never restore private metadata pre-auth.
const recentStorageKey = uid => organizationStorageKey(`reel-recent:${uid}`);
function readRecent(uid) {
  try {
    const value = JSON.parse(localStorage.getItem(recentStorageKey(uid)) || "[]");
    return Array.isArray(value) ? value.filter((v) => v && /^[a-z0-9]{16,40}$/.test(v.id) && Number.isFinite(v.openedAt) && v.openedAt > 0).slice(0, 50) : [];
  } catch { return []; }
}
function rememberRecording(id) {
  if (!validUser(currentUser)) return;
  recent = [{ id, openedAt: Date.now() }, ...recent.filter((v) => v.id !== id)].slice(0, 50);
  try { localStorage.setItem(recentStorageKey(currentUser.uid), JSON.stringify(recent)); }
  catch { /* Storage may be disabled; keep Recent working for this visit. */ }
}
const isRecent = () => location.hash === "#recent";
const selectedNote = () => /^#meetings\/(reel_[a-f0-9]{64})$/.exec(location.hash)?.[1] || null;
const isMeetings = () => location.hash === "#meetings" || !!selectedNote();
const isArchived = () => location.hash === "#archive";
const isPinned = () => location.hash === "#pinned";
const selectedFolder = () => /^#folder=([a-zA-Z0-9_-]{1,80})$/.exec(location.hash)?.[1] || null;
const preferenceFor = (id) => preferences.get(id) || { pinned: false, archived: false, folderId: null };
function libraryURL(hash) { const url = new URL(location.href); url.hash = hash; return url.href; }
function organizationStatus() {
  const text = organizationError || organizationMessage;
  el("organization-status").textContent = text;
  el("organization-status").hidden = !text || isMeetings();
  el("organization-status").classList.toggle("error", !!organizationError);
}
function renderFolders() {
  const nav = el("folder-nav"); nav.replaceChildren();
  for (const folder of folders) {
    const link = document.createElement("a"); link.className = "nav-link folder-link";
    link.href = libraryURL(`folder=${folder.id}`); link.textContent = folder.name;
    if (selectedFolder() === folder.id) { link.classList.add("active"); link.setAttribute("aria-current", "page"); }
    nav.append(link);
  }
  el("folder-section").hidden = !validUser(currentUser);
  el("new-folder").disabled = !organizationReady || creatingFolder;
}
async function savePreference(id, patch) {
  if (!validUser(currentUser) || !organizationReady || pendingOrganization.has(id)) return;
  const uid = currentUser.uid, generation = accountNumber;
  pendingOrganization.add(id); organizationError = ""; organizationMessage = "Saving library organization…"; render();
  try {
    const ref = fs.doc(db, "users", uid, "libraryPreferences", id);
    await fs.runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(ref);
      transaction.set(ref, { pinned: false, archived: false, folderId: null, ...(snapshot.exists() ? snapshot.data() : {}), ...patch, updatedAt: fs.serverTimestamp() });
    });
    if (currentUser?.uid !== uid || generation !== accountNumber) return;
    organizationMessage = patch.archived === true ? "Archived in your library. Existing share links still work." : "Library organization saved.";
  } catch {
    if (currentUser?.uid !== uid || generation !== accountNumber) return;
    organizationError = "Couldn't save library organization. Check your connection and try again.";
  } finally {
    if (currentUser?.uid === uid && generation === accountNumber) { pendingOrganization.delete(id); render(); }
  }
}
function setLoading(value) {
  loading = value;
  el("loading-grid").hidden = !value;
  el("recordings").setAttribute("aria-busy", String(value));
}
function updateView() {
  openManagement.clear();
  const recentView = isRecent();
  const meetingsView = isMeetings();
  if (publicSignup && meetingsView) {
    location.replace(organization.webBase + "/notetaker");
    return;
  }
  const folder = folders.find((f) => f.id === selectedFolder());
  const title = meetingsView ? "Meetings" : recentView ? "Recently viewed" : isArchived() ? "Archive" : isPinned() ? "Pinned recordings" : selectedFolder() ? folder?.name || "Folder" : "Screen recordings";
  el("view-title").textContent = title;
  el("view-description").hidden = !recentView && !isArchived();
  el("view-description").textContent = isArchived() ? "Archived recordings are hidden from your other library views. Existing share links still work." : "Videos opened from this library on this browser.";
  el("meeting-description").hidden = !meetingsView;
  el("recordings").setAttribute("aria-label", meetingsView ? "Meetings" : "Screen recordings");
  document.querySelector(".record-options").hidden = meetingsView;
  el("record-meeting").hidden = !meetingsView;
  el("library-footnote").hidden = meetingsView;
  el("search").placeholder = meetingsView ? "Search meetings" : "Search recordings";
  document.title = `${title} · Reel`;
  for (const [id, selected] of [["nav-library", !recentView && !meetingsView && !isPinned() && !isArchived() && !selectedFolder()], ["nav-recent", recentView], ["nav-meetings", meetingsView], ["nav-pinned", isPinned()], ["nav-archive", isArchived()]]) {
    const url = new URL(location.href); url.hash = id.slice(4) === "library" ? "library" : id.slice(4);
    el(id).href = publicSignup && id === "nav-meetings" ? organization.webBase + "/notetaker" : url.href;
    el(id).classList.toggle("active", selected);
    if (selected) el(id).setAttribute("aria-current", "page"); else el(id).removeAttribute("aria-current");
  }
  el("video-tab").textContent = title;
  const tabURL = new URL(location.href);
  el("video-tab").href = tabURL.href;
  el("recent-sort").hidden = !recentView;
  el("sort").value = recentView ? "recent" : "newest";
  ++noteLoadNumber; note = null; noteLoading = false; noteError = "";
  renderFolders();
  render();
  if (meetingsView && validUser(currentUser)) {
    if (selectedNote()) loadNote();
    else { loadMeetings(); loadParticipantMeetings(); }
  }
}
function relativeDate(millis) {
  if (!millis) return "Date unavailable";
  const seconds = Math.max(0, (Date.now() - millis) / 1000);
  if (seconds < 60) return "Just now";
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]]) {
    if (seconds >= size) return formatter.format(-Math.floor(seconds / size), unit);
  }
}
const dialog = el("player-dialog");
let activeRecording = null, activeTrigger = null, playerOrigin = null;
function closePlayer() { if (dialog.open) dialog.close(); }
function playRecording(r, trigger) {
  rememberRecording(r.id);
  activeRecording = r.id; activeTrigger = trigger;
  el("player-title").textContent = r.title;
  el("player-open").href = shareURL(r.id);
  const url = new URL(`/v/${r.id}`, EMU ? location.origin : organization.webBase);
  url.searchParams.set("embed", "1"); url.searchParams.set("autoplay", "1");
  if (EMU) url.searchParams.set("emulator", "1");
  playerOrigin = url.origin;
  const frame = document.createElement("iframe");
  frame.title = `Play ${r.title}`; frame.src = url.href;
  frame.allow = "autoplay; fullscreen; picture-in-picture"; frame.allowFullscreen = true;
  el("inline-player").replaceChildren(frame);
  dialog.showModal();
}
el("close-player").addEventListener("click", closePlayer);
dialog.addEventListener("close", () => {
  // Removing the browsing context stops playback and releases media/network resources.
  el("inline-player").replaceChildren();
  if (isRecent() && validUser(currentUser)) render();
  const trigger = activeTrigger?.isConnected ? activeTrigger
    : Array.from(document.querySelectorAll(".recording")).find((card) => card.dataset.recordingId === activeRecording)?.querySelector(".thumbnail-button");
  (trigger || el("search")).focus();
  activeRecording = null; activeTrigger = null; playerOrigin = null;
});
window.addEventListener("message", (event) => {
  const frame = el("inline-player").querySelector("iframe");
  if (dialog.open && event.source === frame?.contentWindow && event.origin === playerOrigin && event.data?.type === "reel-close-player") closePlayer();
});

function render() {
  organizationStatus();
  if (isMeetings()) return renderMeetings();
  const list = el("recordings");
  list.replaceChildren();
  const term = el("search").value.trim().toLocaleLowerCase();
  const visits = new Map(recent.map((v) => [v.id, v.openedAt]));
  const folderID = selectedFolder();
  if (folderID) {
    const title = folders.find((f) => f.id === folderID)?.name || "Folder";
    el("view-title").textContent = title; el("video-tab").textContent = title; document.title = `${title} · Reel`;
  }
  const screenEntries = organizationReady ? entries.map((r) => ({ ...r, title: displayedSharedTitle(preferenceFor(r.id).titleOverride, r.title) })).filter((r) => !meetingShareIDs.has(r.id) && preferenceFor(r.id).archived === isArchived()) : [];
  const available = screenEntries.filter((r) => (!isRecent() || visits.has(r.id)) && (!isPinned() || preferenceFor(r.id).pinned) && (!folderID || preferenceFor(r.id).folderId === folderID));
  const filtered = available.filter((r) => r.title.toLocaleLowerCase().includes(term));
  const sort = el("sort").value;
  const ordered = [...filtered].sort((a, b) => {
    let order = 0;
    if (sort === "recent") order = (visits.get(b.id) || 0) - (visits.get(a.id) || 0);
    else if (sort === "title") order = a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
    else order = sort === "oldest" ? createdMillis(a) - createdMillis(b) : createdMillis(b) - createdMillis(a);
    return order || String(a.id).localeCompare(String(b.id));
  });
  const count = el("result-count");
  const label = available.length === 1 ? "video" : "videos";
  count.textContent = loading || (!organizationReady && !organizationError) ? "Loading…" : term ? `${ordered.length} of ${available.length} ${label}` : `${available.length} ${label}`;
  for (const r of ordered) {
    const row = document.createElement("article"); row.className = "recording"; row.dataset.recordingId = r.id;
    const thumbnail = document.createElement("button"); thumbnail.className = "thumbnail-button"; thumbnail.type = "button";
    thumbnail.setAttribute("aria-label", `Play ${r.title}`);
    const placeholder = document.createElement("span"); placeholder.className = "thumbnail-placeholder";
    const placeholderIcon = document.createElement("span"); placeholderIcon.className = "placeholder-icon"; placeholderIcon.textContent = "▣"; placeholderIcon.setAttribute("aria-hidden", "true");
    const placeholderText = document.createElement("span"); placeholderText.textContent = "Preview unavailable";
    placeholder.append(placeholderIcon, placeholderText);
    const image = document.createElement("img"); image.className = "thumbnail-image";
    image.alt = ""; image.loading = "lazy"; image.decoding = "async";
    // Only the public thumbnail location is used. Protected files stay behind their
    // password-derived path; a missing/expired public preview simply falls back.
    image.addEventListener("load", () => { thumbnail.classList.add("has-preview"); });
    image.addEventListener("error", () => { image.remove(); thumbnail.classList.remove("has-preview"); });
    image.src = downloadURL(r.id, File.thumbnail, null, CLOUD_CONFIG);
    const play = document.createElement("span"); play.className = "play-badge"; play.textContent = "▶"; play.setAttribute("aria-hidden", "true");
    const length = document.createElement("span"); length.className = "duration"; length.textContent = duration(r.durationSeconds);
    thumbnail.append(placeholder, image, play, length);
    thumbnail.addEventListener("click", () => playRecording(r, thumbnail));
    const info = document.createElement("div"); info.className = "recording-info";
    const h = document.createElement("h2"); const title = document.createElement("button");
    title.type = "button"; title.className = "title-button"; title.textContent = r.title;
    title.addEventListener("click", () => playRecording(r, title)); h.append(title);
    const details = document.createElement("p"); details.className = "recording-state";
    const millis = createdMillis(r);
    const date = millis ? new Date(millis) : null;
    details.textContent = r.status !== "ready" ? r.status : "";
    details.hidden = !details.textContent;
    const owner = String(currentUser?.displayName || currentUser?.email || "Reel user").trim();
    const ownerRow = document.createElement("p"); ownerRow.className = "recording-owner";
    const initials = document.createElement("span"); initials.className = "owner-initials"; initials.setAttribute("aria-hidden", "true"); initials.textContent = ownerInitials(owner);
    const ownerName = document.createElement("span"); ownerName.textContent = owner;
    const ownerDetails = document.createElement("span"); ownerDetails.className = "owner-details";
    const age = document.createElement("time"); age.textContent = relativeDate(millis);
    if (date && !Number.isNaN(date.getTime())) { age.dateTime = date.toISOString(); age.title = date.toLocaleString(); }
    ownerDetails.append(ownerName, age);
    ownerRow.append(initials, ownerDetails);
    info.append(ownerRow, h, details);
    const preference = preferenceFor(r.id);
    if (preference.pinned) { const badge = document.createElement("p"); badge.className = "pinned-label"; badge.textContent = "Pinned"; info.append(badge); }
    const actions = document.createElement("div"); actions.className = "recording-actions";
    const open = document.createElement("a"); open.href = shareURL(r.id); open.className = "button secondary"; open.textContent = "Open full page";
    const opened = () => { rememberRecording(r.id); if (isRecent()) setTimeout(render, 0); };
    open.addEventListener("click", opened);
    open.addEventListener("auxclick", (event) => { if (event.button === 1) opened(); });
    const copy = document.createElement("button"); copy.textContent = "Copy link"; copy.type = "button";
    copy.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(shareURL(r.id)); copy.textContent = "Copied"; setTimeout(() => { copy.textContent = "Copy link"; }, 1800); }
      catch { message("Couldn't copy the link. Open the recording and copy its address from your browser.", true); }
    });
    actions.append(open, copy);
    const manage = document.createElement("details"); manage.className = "recording-manage";
    const manageSummary = document.createElement("summary"); manageSummary.textContent = "⋯";
    manageSummary.setAttribute("aria-label", `Manage recording: ${r.title}`); manageSummary.title = "Manage recording";
    manage.open = openManagement.has(r.id);
    manage.addEventListener("toggle", () => manage.open ? openManagement.add(r.id) : openManagement.delete(r.id));
    const pin = document.createElement("button"); pin.type = "button"; pin.textContent = preference.pinned ? "Unpin" : "Pin";
    pin.setAttribute("aria-pressed", String(preference.pinned)); pin.disabled = pendingOrganization.has(r.id);
    pin.addEventListener("click", () => savePreference(r.id, { pinned: !preference.pinned }));
    const archive = document.createElement("button"); archive.type = "button"; archive.textContent = preference.archived ? "Restore" : "Archive";
    archive.title = preference.archived ? "Restore to your library" : "Hide from library views; existing share links still work";
    archive.disabled = pendingOrganization.has(r.id); archive.addEventListener("click", () => savePreference(r.id, { archived: !preference.archived }));
    const archiveHint = document.createElement("p"); archiveHint.className = "archive-hint";
    archiveHint.textContent = "Archiving hides this recording from library views. Existing share links still work.";
    const folderLabel = document.createElement("label"); folderLabel.className = "move-folder";
    const labelText = document.createElement("span"); labelText.className = "visually-hidden"; labelText.textContent = `Folder for ${r.title}`;
    const move = document.createElement("select"); const unfiled = document.createElement("option"); unfiled.value = ""; unfiled.textContent = "No folder"; move.append(unfiled);
    for (const folder of folders) { const option = document.createElement("option"); option.value = folder.id; option.textContent = folder.name; move.append(option); }
    move.value = preference.folderId || ""; move.disabled = pendingOrganization.has(r.id);
    move.addEventListener("change", () => savePreference(r.id, { folderId: move.value || null }));
    folderLabel.append(labelText, move);
    const organize = document.createElement("div"); organize.className = "recording-organization";
    const rename = document.createElement("button"); rename.type = "button"; rename.textContent = "Rename shared title"; rename.disabled = pendingOrganization.has(r.id);
    rename.addEventListener("click", () => {
      const uid = currentUser?.uid, generation = accountNumber;
      const isCurrent = () => validUser(currentUser) && currentUser.uid === uid && generation === accountNumber && auth.currentUser?.uid === uid;
      if (!isCurrent()) return;
      editSharedTitle({ title: r.title, askPassword: true, save: async (title, password) => {
        const room = await resolveTitleRoom(r.id, password, CLOUD_CONFIG);
        if (!isCurrent()) throw new Error("Your account changed. Reopen Rename shared title to try again.");
        await saveSharedTitle({ fs, db, id: r.id, room, uid, title, isCurrent });
        organizationMessage = "Shared title saved. The original recording’s title stays on its device."; organizationStatus();
      } });
    });
    organize.append(rename, pin, archive, archiveHint, folderLabel);
    manage.append(manageSummary, organize); actions.append(manage);
    row.append(thumbnail, info, actions); list.append(row);
  }
  if (loadError) message(loadError, true);
  else if (validUser(currentUser) && !organizationReady) message(organizationError ? "Library organization is unavailable. Click Refresh to try again." : "Loading library organization…", !!organizationError);
  else if (validUser(currentUser) && !loading) message(!entries.length ? "No uploaded recordings yet. Choose New video to start recording." : !available.length && isRecent() ? "Videos you open from this library appear here, most recent first. Recent is saved in this browser for your account." : !available.length && isArchived() ? "No archived recordings. Archiving organizes your library and does not revoke share links." : !available.length && isPinned() ? "Pin a recording to find it here." : !available.length && folderID ? "No recordings in this folder. Move a recording here from its folder menu." : !filtered.length ? "No recordings match your search." : "");
}
function renderMeetings() {
  const list = el("recordings"); list.replaceChildren();
  if (selectedNote()) return renderNote();
  const ownIDs = new Set(participantMeetings.flatMap((m) => Array.isArray(m.local_recording_ids) ? m.local_recording_ids : []));
  const combined = [...participantMeetings, ...meetings.filter((m) => !ownIDs.has(m.id))];
  const term = el("search").value.trim().toLocaleLowerCase();
  const filtered = combined.filter((m) => m.title.toLocaleLowerCase().includes(term));
  const sort = el("sort").value;
  const ordered = [...filtered].sort((a, b) => {
    if (sort === "title") return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
    return sort === "oldest" ? Date.parse(a.started_at) - Date.parse(b.started_at) : Date.parse(b.started_at) - Date.parse(a.started_at);
  });
  el("result-count").textContent = (meetingLoading || participantLoading) ? "Loading…" : term ? `${ordered.length} of ${combined.length} meetings` : `${combined.length} meetings`;
  for (const m of ordered) {
    const row = document.createElement("article"); row.className = "recording meeting-card";
    const visual = document.createElement("div"); visual.className = "meeting-visual"; visual.setAttribute("aria-hidden", "true"); visual.textContent = "◷";
    const info = document.createElement("div"); info.className = "recording-info meeting-info";
    const heading = document.createElement("h2"); heading.textContent = m.title;
    const date = document.createElement("p"); date.className = "meeting-date";
    const started = new Date(m.started_at);
    date.textContent = Number.isNaN(started.getTime()) ? "Date unavailable" : started.toLocaleString();
    const durationLine = document.createElement("p"); durationLine.textContent = `Duration ${duration(m.duration_seconds)}`;
    const transcript = document.createElement("p"); transcript.className = "meeting-transcript"; transcript.textContent = `Transcript: ${m.transcript_status || "unknown"}`;
    const local = document.createElement("p"); local.className = "meeting-local-note"; local.textContent = "The original video stays on the recording device. It may also have been explicitly shared.";
    info.append(heading, date, durationLine, transcript, local);
    const actions = document.createElement("div"); actions.className = "recording-actions meeting-actions";
    if (m.participantNote) {
      const read = document.createElement("a"); read.className = "button"; read.href = libraryURL(`meetings/${m.id}`); read.textContent = "Read notes";
      actions.append(read); row.append(visual, info, actions); list.append(row); continue;
    }
    const open = document.createElement("a"); open.className = "button"; open.href = m.recording_source === "mac" ? "reel://local-library" : organization.webBase + "/record?mode=meeting"; open.textContent = "Open Reel";
    actions.append(open);
    const notionURL = validNotionURL(m.notion_url);
    if (m.notion_verified === true && notionURL) {
      const notion = document.createElement("a"); notion.className = "button secondary"; notion.href = notionURL.href; notion.target = "_blank"; notion.rel = "noopener noreferrer"; notion.textContent = "Open Notion"; actions.append(notion);
    }
    row.append(visual, info, actions); list.append(row);
  }
  if (meetingError || participantError) message([meetingError, participantError].filter(Boolean).join(" "), true);
  else if ((meetingLoading || participantLoading) && validUser(currentUser)) message("Loading meetings…");
  else if (validUser(currentUser)) message(!combined.length ? "No meetings yet. Record a meeting in Reel while signed in to see its private details here. Meetings recorded while signed out stay on that device and won't sync to this portal." : !filtered.length ? "No meetings match your search." : "");
}
function renderNote() {
  const list = el("recordings");
  el("result-count").textContent = "";
  if (!validUser(currentUser)) { message(`Sign in with ${googleAccountLabel} to see meeting notes.`); return; }
  if (noteLoading) { message("Loading meeting notes…"); return; }
  if (noteError) { message(noteError, true); return; }
  if (!note) return;
  message("");
  const article = document.createElement("article"); article.className = "meeting-note";
  const back = document.createElement("a"); back.href = libraryURL("meetings"); back.textContent = "← All meetings";
  const title = document.createElement("h2"); title.textContent = note.title;
  const date = document.createElement("p"); date.className = "meeting-date";
  const started = new Date(note.started_at); date.textContent = Number.isNaN(started.getTime()) ? "Date unavailable" : started.toLocaleString();
  const summaryHeading = document.createElement("h3"); summaryHeading.textContent = "Summary and action items";
  const summary = document.createElement("div"); summary.className = "meeting-note-text";
  summary.textContent = typeof note.summary === "string" ? note.summary : JSON.stringify(note.summary ?? "", null, 2);
  const transcriptHeading = document.createElement("h3"); transcriptHeading.textContent = "Transcript";
  const transcript = document.createElement("div"); transcript.className = "meeting-note-text";
  transcript.textContent = typeof note.transcript_text === "string" && note.transcript_text ? note.transcript_text : (Array.isArray(note.segments) ? note.segments.map((s) => s.text || "").join("\n") : "Transcript unavailable.");
  article.append(back, title, date, summaryHeading, summary, transcriptHeading, transcript); list.append(article);
}
async function loadNote() {
  const id = selectedNote(); if (publicSignup || !id || !validUser(currentUser)) return;
  const user = currentUser, uid = user.uid, number = ++noteLoadNumber;
  note = null; noteError = ""; noteLoading = true; render();
  const current = () => number === noteLoadNumber && currentUser?.uid === uid && auth.currentUser?.uid === uid && selectedNote() === id;
  try {
    const token = await user.getIdToken(); if (!current()) return;
    const response = await fetch(`${DELIVERY_API}/${id}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    if (response.status === 404 || response.status === 403) { if (current()) { noteLoading = false; noteError = "Meeting notes not found or you don't have access."; render(); } return; }
    if (!response.ok) throw new Error();
    const data = await response.json(); if (!current()) return;
    if (!data.meeting || data.meeting.id !== id || typeof data.meeting.title !== "string") throw new Error();
    note = data.meeting; noteLoading = false; render();
  } catch { if (current()) { noteLoading = false; noteError = "Couldn't load meeting notes. Check your connection and click Refresh."; render(); } }
}
async function loadParticipantMeetings() {
  if (publicSignup || !validUser(currentUser)) return;
  const user = currentUser, uid = user.uid, number = ++participantLoadNumber;
  participantLoading = true; participantError = ""; participantMeetings = []; render();
  const current = () => number === participantLoadNumber && currentUser?.uid === uid && auth.currentUser?.uid === uid;
  try {
    const token = await user.getIdToken(); if (!current()) return;
    let cursor = null; const seen = new Set(), results = new Map();
    do {
      const url = new URL(DELIVERY_API); url.searchParams.set("limit", "50"); if (cursor !== null) url.searchParams.set("cursor", cursor);
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      if (!response.ok) throw new Error();
      const data = await response.json(); if (!current()) return;
      if (!Array.isArray(data.meetings)) throw new Error();
      for (const m of data.meetings) if (m && /^reel_[a-f0-9]{64}$/.test(m.id) && typeof m.title === "string" && typeof m.started_at === "string") results.set(m.id, { ...m, participantNote: true });
      cursor = data.next_cursor;
      if (cursor !== null && (typeof cursor !== "string" || seen.has(cursor))) throw new Error();
      if (cursor !== null) seen.add(cursor);
    } while (cursor !== null);
    participantMeetings = [...results.values()]; participantLoading = false; render();
  } catch { if (current()) { participantLoading = false; participantError = "Couldn't load participant notes. Check your connection and click Refresh."; render(); } }
}
function validNotionURL(value) {
  try {
    if (typeof value !== "string" || !value.startsWith("https://")) return null;
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && /^(?:notion\.so|www\.notion\.so|app\.notion\.com)$/i.test(url.hostname) ? url : null;
  } catch { return null; }
}
async function loadMeetings() {
  if (publicSignup || !validUser(currentUser)) return;
  const user = currentUser, uid = user.uid, number = ++meetingLoadNumber;
  meetingError = ""; meetingLoading = true;
  if (isMeetings()) renderMeetings();
  try {
    const token = await user.getIdToken();
    if (number !== meetingLoadNumber || currentUser?.uid !== uid) return;
    const response = await fetch(MEETINGS_API, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    const data = await response.json();
    if (number !== meetingLoadNumber || currentUser?.uid !== uid) return;
    meetings = Array.isArray(data.meetings) ? data.meetings.filter((m) => m && typeof m.id === "string" && typeof m.title === "string" && typeof m.started_at === "string") : [];
    meetingShareIDs = new Set(meetings.map((m) => m.share_id).filter((id) => typeof id === "string" && /^[a-z0-9]{16,40}$/.test(id)));
    meetingLoading = false; render();
  } catch (error) {
    if (number !== meetingLoadNumber || currentUser?.uid !== uid) return;
    meetingLoading = false; meetings = []; meetingShareIDs = new Set();
    meetingError = `Couldn't load meetings. Check your connection and click Refresh. ${error.message}`;
    render();
  }
}
async function refresh() {
  if (!validUser(currentUser)) return;
  stopListening();
  const number = ++loadNumber, uid = currentUser.uid;
  loadError = ""; organizationError = ""; organizationMessage = ""; organizationReady = false;
  let preferencesLoaded = false, foldersLoaded = false, organizationReadFailed = false;
  const listeners = [];
  stopListening = () => { listeners.forEach((stop) => stop()); };
  function organizationLoaded() { organizationReady = preferencesLoaded && foldersLoaded && !organizationReadFailed; renderFolders(); render(); }
  function organizationFailed() {
    if (number !== loadNumber || currentUser?.uid !== uid) return;
    organizationReadFailed = true; organizationReady = false; organizationError = "Couldn't load library organization. Check your connection and click Refresh.";
    renderFolders(); render();
  }
  el("refresh").disabled = true;
  if (!entries.length) setLoading(true);
  message("Loading your library…");
  renderFolders(); render();
  listeners.push(fs.onSnapshot(fs.collection(db, "users", uid, "recordings"), (snapshot) => {
    if (number !== loadNumber || currentUser?.uid !== uid) return;
    entries = snapshot.docs.map((d) => d.data()).filter((r) => /^[a-z0-9]{16,40}$/.test(r.id) && typeof r.title === "string" && !meetingShareIDs.has(r.id))
      .sort((a, b) => createdMillis(b) - createdMillis(a));
    el("refresh").disabled = false;
    setLoading(false);
    render();
  }, (e) => {
    if (number !== loadNumber || currentUser?.uid !== uid) return;
    el("refresh").disabled = false;
    setLoading(false);
    el("result-count").textContent = entries.length ? `${entries.length} videos` : "Unavailable";
    loadError = "Couldn't load your recordings. Check your connection and click Refresh. " + e.message;
    message(loadError, true);
  }));
  listeners.push(fs.onSnapshot(fs.collection(db, "users", uid, "libraryPreferences"), (snapshot) => {
    if (number !== loadNumber || currentUser?.uid !== uid) return;
    preferences = new Map(snapshot.docs.map((d) => [d.id, d.data()]));
    preferencesLoaded = true; organizationLoaded();
  }, organizationFailed));
  listeners.push(fs.onSnapshot(fs.collection(db, "users", uid, "libraryFolders"), (snapshot) => {
    if (number !== loadNumber || currentUser?.uid !== uid) return;
    folders = snapshot.docs.map((d) => ({ id: d.id, ...d.data() })).filter((f) => typeof f.name === "string").sort((a, b) => a.name.localeCompare(b.name));
    foldersLoaded = true; organizationLoaded();
  }, organizationFailed));
}
window.addEventListener("hashchange", updateView);
updateView();
el("search").addEventListener("input", render);
el("sort").addEventListener("change", render);
el("new-folder").addEventListener("click", () => { el("folder-form").hidden = false; el("folder-name").focus(); });
el("cancel-folder").addEventListener("click", () => { el("folder-form").hidden = true; el("folder-name").value = ""; el("new-folder").focus(); });
el("folder-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!validUser(currentUser) || !organizationReady || creatingFolder) return;
  const name = el("folder-name").value.trim();
  if (!name || name.length > 80) { organizationError = "Enter a folder name between 1 and 80 characters."; organizationStatus(); return; }
  const uid = currentUser.uid, generation = accountNumber;
  creatingFolder = true; organizationError = ""; organizationMessage = "Creating folder…"; renderFolders(); organizationStatus();
  el("folder-form").querySelector('button[type="submit"]').disabled = true;
  try {
    await fs.addDoc(fs.collection(db, "users", uid, "libraryFolders"), { name, updatedAt: fs.serverTimestamp() });
    if (currentUser?.uid !== uid || generation !== accountNumber) return;
    el("folder-form").hidden = true; el("folder-name").value = ""; organizationMessage = "Folder created.";
  } catch {
    if (currentUser?.uid !== uid || generation !== accountNumber) return;
    organizationError = "Couldn't create the folder. Check your connection and try again.";
  } finally {
    if (currentUser?.uid === uid && generation === accountNumber) {
      creatingFolder = false; el("folder-form").querySelector('button[type="submit"]').disabled = false; renderFolders(); organizationStatus();
    }
  }
});
el("refresh").addEventListener("click", () => {
  if (selectedNote()) loadNote();
  else if (isMeetings()) { loadMeetings(); loadParticipantMeetings(); }
  else refresh();
});
el("sign-in").addEventListener("click", async () => {
  el("sign-in").disabled = true;
  try {
    await am.signInWithPopup(auth, googleSignInProvider(am));
  } catch (e) { message("Sign-in didn't finish. " + e.message, true); }
  finally { el("sign-in").disabled = false; }
});
el("sign-out").addEventListener("click", () => am.signOut(auth).catch((e) => message(e.message, true)));
try {
  // Auth and Firestore are independent downloads. Start both immediately.
  const [session, firestore] = await Promise.all([loadAuth(), import(FB_CDN + "firebase-firestore.js")]);
  ({ auth, am } = session); fs = firestore;
  db = fs.getFirestore(auth.app, CLOUD_CONFIG.firestoreDatabase);
  if (EMU) fs.connectFirestoreEmulator(db, "127.0.0.1", 8080);
  observeReelAccount(am, auth, (user, candidate) => {
    ++accountNumber;
    closeSharedTitleEditor();
    openManagement.clear();
    stopListening();
    closePlayer();
    currentUser = user; ++loadNumber; ++meetingLoadNumber; ++participantLoadNumber; ++noteLoadNumber; participantMeetings = []; participantLoading = false; participantError = ""; note = null; noteLoading = false; noteError = ""; loadError = ""; meetingError = ""; entries = []; meetings = []; meetingShareIDs = new Set(); meetingLoading = false; recent = validUser(user) ? readRecent(user.uid) : []; el("recordings").replaceChildren();
    preferences = new Map(); folders = []; organizationReady = false; organizationError = ""; organizationMessage = ""; pendingOrganization.clear(); creatingFolder = false;
    el("folder-form").hidden = true; el("folder-name").value = ""; el("folder-form").querySelector('button[type="submit"]').disabled = false; renderFolders(); organizationStatus();
    if (selectedFolder()) { el("view-title").textContent = "Folder"; el("video-tab").textContent = "Folder"; document.title = "Folder · Reel"; }
    setLoading(validUser(user));
    el("result-count").textContent = isMeetings() ? "0 meetings" : "0 videos"; el("search").value = "";
    const allowed = validUser(user);
    el("sign-in").hidden = !!candidate; el("sign-out").hidden = !candidate; el("refresh").hidden = !allowed; el("refresh").disabled = false;
    el("search").disabled = !allowed; el("sort").disabled = !allowed; el("account").textContent = user?.email || "";
    if (allowed) { refresh(); loadMeetings(); if (selectedNote()) loadNote(); else loadParticipantMeetings(); }
    else message(candidate ? `Use ${googleAccountLabel} to view your library. Sign out to choose another account.` : isMeetings() ? `Sign in with ${googleAccountLabel} to see meeting details. Meetings recorded while signed out stay on that device and won't sync to this portal.` : `Sign in with ${googleAccountLabel} to see your recordings.`);
  });
} catch (e) { setLoading(false); el("result-count").textContent = "Unavailable"; message("Couldn't connect to Reel. Reload this page to try again. " + e.message, true); }

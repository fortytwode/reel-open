import * as firebase from "./reel/firebase.js?v=20261121-public-signup";
import { mountMeetingCalendar } from "./meeting-calendar.js?v=20261123-workspace1";
import * as org from "./organization.js?v=20261121-public-signup";
import { downloadURL, File, viewerURL } from "./reel/core.js?v=20261105-parity2";

import { displayedSharedTitle, resolveTitleRoom, saveSharedTitle, editSharedTitle, closeSharedTitleEditor } from "./reel/shared-title.js?v=20261105-parity2";

// Older team Hosting deployments expose the same verified Google identity but
// predate the public-signup helpers. Keep the library compatible during rollout.
const { loadAuth, sessionSnapshot, FB_CDN, CLOUD_CONFIG, EMU } = firebase;
const { organization, organizationStorageKey } = org;
const publicSignup = org.publicSignup ?? false;
const googleAccountLabel = firebase.googleAccountLabel ?? `your ${organization?.allowedEmailDomain || "work"} Google account`;
const googleSignInProvider = firebase.googleSignInProvider ?? (am => {
  const provider = new am.GoogleAuthProvider();
  provider.setCustomParameters({ hd: organization.allowedEmailDomain, prompt: "select_account" });
  return provider;
});
const observeReelAccount = firebase.observeReelAccount ?? ((am, auth, receive) => am.onAuthStateChanged(auth, candidate =>
  receive(candidate?.emailVerified && firebase.isOrganizationEmail(candidate.email) ? candidate : null, candidate)));

const el = (id) => document.getElementById(id);
const status = el("status");
let auth, am, fs, db, currentUser, entries = [], meetings = [], meetingShareIDs = new Set(), recent = [], loading = true, meetingLoading = false, loadError = "", meetingError = "", loadNumber = 0, meetingLoadNumber = 0, stopListening = () => {};
let preferences = new Map(), folders = [], organizationReady = false, organizationError = "", organizationMessage = "", creatingFolder = false, accountNumber = 0;
let rejectedAccount = false;
const pendingOrganization = new Set();
const openManagement = new Set();
let participantMeetings = [], participantLoading = false, participantError = "", participantLoadNumber = 0;
let note = null, noteLoading = false, noteError = "", noteLoadNumber = 0;
let calendar = null;
let upcomingEvents = [], upcomingLoading = false, upcomingLoadNumber = 0, showAllUpcoming = false, noteTab = "Summary";
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
// One shell serves two products. Reel Recorder holds screen recordings; Reel
// Notetaker holds meetings, notes and the meeting calendar. Each shows only its
// own navigation. notetaker-meetings.html is always Notetaker. Where a host
// proxies only the library page (Mission Control), meeting links switch this
// page to Notetaker in place, so the existing sign-in keeps working.
const fixedNotetaker = document.documentElement.dataset.product === "notetaker";
const sameOrigin = (a, b) => { try { return new URL(a).origin === new URL(b).origin; } catch { return false; } };
// A host that serves each product at its own address names both in the page:
// <meta name="reel-recorder-url" content="/recorder"> and reel-notetaker-url.
const hostPage = name => {
  const path = document.querySelector(`meta[name="${name}"]`)?.content || "";
  return /^\/[A-Za-z0-9][A-Za-z0-9/_-]*$/.test(path) ? location.origin + path : null;
};
const hostRecorder = hostPage("reel-recorder-url"), hostNotetaker = hostPage("reel-notetaker-url");
const hostPages = !!(hostRecorder && hostNotetaker);
const proxied = !hostPages && !fixedNotetaker && !!organization && sameOrigin(location.href, organization.notesBaseURL) && !sameOrigin(location.href, organization.webBase);
const meetingHash = () => /^#(?:meetings(?:\/.*)?|calendar|calendar-meeting=.*|meeting-request=.*)$/.test(location.hash);
let notetaker = fixedNotetaker || (proxied && meetingHash());
// Where the library is served from another origin, open Notetaker there too so
// people sign in once for both products.
if (fixedNotetaker && !hostPages && organization?.notesBaseURL && organization.webBase && !publicSignup
    && sameOrigin(organization.notesBaseURL, organization.notesBaseURL)
    && !sameOrigin(organization.webBase, organization.notesBaseURL) && !sameOrigin(location.href, organization.notesBaseURL)) {
  location.replace(organization.notesBaseURL + (location.hash || "#meetings"));
}
const productName = () => notetaker ? "Reel Notetaker" : "Reel Recorder";
const notetakerURL = (hash = "") => hostPages ? hostNotetaker + hash
  : !organization ? "/notetaker-meetings" + hash
  : publicSignup ? organization.webBase + "/notetaker"
  : proxied ? organization.notesBaseURL + (hash || "#meetings") : organization.webBase + "/notetaker-meetings" + hash;
const recorderURL = () => hostPages ? hostRecorder : !organization ? "/library" : organization.notesBaseURL + (proxied ? "#library" : "");
function showProduct() {
  notetaker = fixedNotetaker || (proxied && meetingHash());
  document.documentElement.dataset.product = notetaker ? "notetaker" : "recorder";
  const brand = document.querySelector(".brand");
  brand.lastChild.textContent = " " + productName();
  brand.href = notetaker ? notetakerURL() : recorderURL();
  document.querySelector(".library-label").textContent = notetaker ? "MEETINGS" : "LIBRARY";
  document.querySelector(".workspace small").textContent = notetaker ? "Meeting notes" : "Personal library";
  document.querySelector(".breadcrumb").firstChild.textContent = notetaker ? "Notetaker " : "Library ";
  document.querySelector(".personal-library strong").textContent = notetaker ? "Your meetings" : "Personal library";
  document.querySelector(".personal-library small").textContent = notetaker ? "Private to you and attendees" : "Private to you";
  const other = el("other-product");
  other.href = notetaker ? recorderURL() : notetakerURL();
  other.firstChild.textContent = notetaker ? "Reel Recorder " : "Reel Notetaker ";
  other.querySelector("small").textContent = notetaker ? "Screen recordings and share links" : "Meetings, notes and calendar";
}
const isRecent = () => !notetaker && location.hash === "#recent";
const isCalendar = () => location.hash === "#calendar" || (notetaker && /^#(?:calendar-meeting|meeting-request)=/.test(location.hash));
const selectedNote = () => /^#meetings\/(reel_[a-f0-9]{64})$/.exec(location.hash)?.[1] || null;
const isMeetings = () => location.hash === "#meetings" || !!selectedNote() || (notetaker && !isCalendar());
const isArchived = () => location.hash === "#archive";
const isPinned = () => location.hash === "#pinned";
const selectedFolder = () => /^#folder=([a-zA-Z0-9_-]{1,80})$/.exec(location.hash)?.[1] || null;
const preferenceFor = (id) => preferences.get(id) || { pinned: false, archived: false, folderId: null };
function libraryURL(hash) { const url = new URL(location.href); url.hash = hash; return url.href; }
function organizationStatus() {
  const text = organizationError || organizationMessage;
  el("organization-status").textContent = text;
  el("organization-status").hidden = !text || isMeetings() || isCalendar();
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
  el("loading-grid").hidden = !value || isCalendar();
  el("recordings").setAttribute("aria-busy", String(value));
}
function updateView() {
  showProduct();
  openManagement.clear();
  const recentView = isRecent();
  const meetingsView = isMeetings();
  const calendarView = isCalendar();
  if (notetaker ? publicSignup : meetingsView || calendarView) {
    // Meetings live in Reel Notetaker. Old links into the Recorder library keep working.
    location.replace(notetakerURL(publicSignup ? "" : location.hash));
    return;
  }
  const folder = folders.find((f) => f.id === selectedFolder());
  const title = calendarView ? "Meeting calendar" : meetingsView ? "Meetings" : recentView ? "Recently viewed videos" : isArchived() ? "Archive" : isPinned() ? "Pinned recordings" : selectedFolder() ? folder?.name || "Folder" : "Screen recordings";
  el("view-title").textContent = title;
  el("view-description").hidden = !recentView && !isArchived();
  el("view-description").textContent = isArchived() ? "Archived recordings are hidden from your other library views. Existing share links still work." : "Videos opened from this library on this browser.";
  el("meeting-description").hidden = !meetingsView;
  el("recordings").setAttribute("aria-label", meetingsView ? "Meetings" : "Screen recordings");
  document.querySelector(".record-options").hidden = meetingsView || calendarView;
  el("meeting-actions").hidden = !meetingsView;
  el("library-footnote").hidden = meetingsView || calendarView;
  el("meeting-calendar-panel").hidden = !calendarView || !validUser(currentUser);
  el("loading-grid").hidden = !loading || calendarView;
  el("recordings").hidden = calendarView;
  document.querySelector(".toolbar").hidden = calendarView;
  document.querySelector(".search").hidden = calendarView;
  if (!calendarView && calendar) { calendar.dispose(); calendar = null; }
  if (calendarView && validUser(currentUser) && !calendar) {
    calendar = mountMeetingCalendar({ container: el("meeting-calendar-panel"), session: async () => {
      const user = currentUser, generation = accountNumber, snapshot = sessionSnapshot(user);
      return snapshot && { ...snapshot, isCurrent: () => currentUser?.uid === snapshot.uid && accountNumber === generation && auth.currentUser?.uid === snapshot.uid };
    }});
  }
  el("search").placeholder = meetingsView ? "Search meetings" : "Search recordings";
  document.title = `${title} · ${productName()}`;
  for (const [id, selected] of [["nav-library", !recentView && !meetingsView && !calendarView && !isPinned() && !isArchived() && !selectedFolder()], ["nav-recent", recentView], ["nav-meetings", meetingsView], ["nav-calendar", calendarView], ["nav-pinned", isPinned()], ["nav-archive", isArchived()]]) {
    const url = new URL(location.href); url.hash = id.slice(4) === "library" ? "library" : id.slice(4);
    el(id).href = url.href;
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
    else { loadMeetings(); loadParticipantMeetings(); loadUpcoming(); }
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
  if (isCalendar() && validUser(currentUser)) { message(""); return; }
  if (!loading && !validUser(currentUser)) {
    const subject = isMeetings() || isCalendar() ? "meeting notes" : "uploaded recordings";
    const accessMessage = rejectedAccount
      ? `Use ${googleAccountLabel} to see your ${subject}. Sign out to choose another account.`
      : isMeetings() || isCalendar()
        ? "Sign in to see your meeting notes. Meetings recorded while signed out stay on that device."
        : "Sign in to see your uploaded recordings. Recordings saved on this device are available where you recorded them.";
    message(loadError || accessMessage, !!loadError);
    return;
  }
  if (isMeetings()) return renderMeetings();
  const list = el("recordings");
  list.classList.remove("nt-home");
  list.replaceChildren();
  const term = el("search").value.trim().toLocaleLowerCase();
  const visits = new Map(recent.map((v) => [v.id, v.openedAt]));
  const folderID = selectedFolder();
  if (folderID) {
    const title = folders.find((f) => f.id === folderID)?.name || "Folder";
    el("view-title").textContent = title; el("video-tab").textContent = title; document.title = `${title} · ${productName()}`;
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
// ---- Reel Notetaker: coming up, past meetings by day, and the note reader ----
const node = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; };
const timeOf = (date) => date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
function dayLabel(date) {
  const today = new Date(), other = new Date(today);
  if (sameDay(date, today)) return "Today";
  other.setDate(today.getDate() - 1); if (sameDay(date, other)) return "Yesterday";
  other.setDate(today.getDate() + 1); if (sameDay(date, other)) return "Tomorrow";
  return date.toLocaleDateString([], { weekday: "long", day: "numeric", month: "short", ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }) });
}
function lengthLabel(seconds) {
  const minutes = Math.round((Number(seconds) || 0) / 60);
  return minutes < 1 ? "under a minute" : minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
const personName = (value) => String(value || "").split("@")[0].split(/[._-]+/).filter(Boolean).map((part) => part[0].toLocaleUpperCase() + part.slice(1)).join(" ") || "Guest";
function peopleChips(list, limit = 4) {
  const people = [...new Set((Array.isArray(list) ? list : []).filter((value) => typeof value === "string" && value))];
  const group = node("div", "nt-people");
  for (const person of people.slice(0, limit)) { const chip = node("span", "nt-avatar", ownerInitials(personName(person))); chip.title = person; group.append(chip); }
  if (people.length > limit) group.append(node("span", "nt-avatar nt-more", `+${people.length - limit}`));
  return group;
}
// Summaries are plain text in two shapes: section headings on their own line
// ("Outcome", "Key points", "Action items") with "•" bullets, or "Topic: what
// was said" paragraphs followed by an "Action items" list.
function summaryBlocks(text) {
  const blocks = []; let todo = false;
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim(); if (!line) continue;
    const bullet = /^[-•*]\s+(.*)$/.exec(line);
    if (!bullet && line.length <= 48 && !/[.!?:]$/.test(line.replace(/:$/, "")) && !/:\s/.test(line)) {
      const heading = line.replace(/:$/, ""); todo = /^(action items|next steps|follow[- ]ups?)$/i.test(heading);
      blocks.push({ type: "heading", text: heading }); continue;
    }
    const body = bullet ? bullet[1] : line;
    const labelled = /^([^:.]{2,60}):\s+(.+)$/.exec(body);
    if (bullet || todo) blocks.push({ type: todo ? "todo" : "bullet", label: labelled && !todo ? labelled[1] : "", text: labelled && !todo ? labelled[2] : body });
    else if (labelled) blocks.push({ type: "heading", text: labelled[1] }, { type: "para", text: labelled[2] });
    else blocks.push({ type: "para", text: body });
  }
  return blocks;
}
function summaryPreview(text) {
  const first = summaryBlocks(text).find((block) => block.type !== "heading");
  return first ? (first.label ? `${first.label}: ${first.text}` : first.text) : "";
}
const captureStates = {
  scheduled: ["Notetaker will join", "nt-chip-on"], joined: ["Recording now", "nt-chip-live"], recording: ["Recording now", "nt-chip-live"],
  requesting_entry: ["Asking to join", "nt-chip-live"], awaiting_admission: ["Waiting to be let in", "nt-chip-live"],
  cancelled: ["Not recording", "nt-chip-off"], declined: ["Not recording", "nt-chip-off"], failed: ["Not recorded", "nt-chip-off"],
};
function eventRow(event, now) {
  const start = new Date(event.start), end = new Date(event.end);
  const live = start <= now && end > now;
  const row = node("a", "nt-row nt-upcoming" + (live ? " nt-live" : ""));
  row.href = libraryURL("calendar");
  row.append(node("span", "nt-time", `${timeOf(start)} – ${timeOf(end)}`));
  const main = node("span", "nt-main"); main.append(node("strong", "", event.title));
  const [label, tone] = captureStates[event.status] || [event.status, "nt-chip-off"];
  row.append(main, peopleChips(event.attendees), node("span", `nt-chip ${tone}`, live && event.status === "scheduled" ? "Starting" : label));
  return row;
}
function renderMeetings() {
  const list = el("recordings"); list.replaceChildren();
  if (selectedNote()) return renderNote();
  list.classList.add("nt-home");
  const ownIDs = new Set(participantMeetings.flatMap((m) => Array.isArray(m.local_recording_ids) ? m.local_recording_ids : []));
  const combined = [...participantMeetings, ...meetings.filter((m) => !ownIDs.has(m.id))];
  const term = el("search").value.trim().toLocaleLowerCase();
  const matches = (m) => !term || [m.title, m.summary, ...(Array.isArray(m.attendees) ? m.attendees : [])].some((value) => typeof value === "string" && value.toLocaleLowerCase().includes(term));
  const filtered = combined.filter(matches).sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
  const busy = meetingLoading || participantLoading;
  el("result-count").textContent = busy ? "Loading…" : term ? `${filtered.length} of ${combined.length} meetings` : `${combined.length} meetings`;

  const now = new Date();
  const upcoming = upcomingEvents.filter((e) => new Date(e.end) > now && e.status !== "completed" && matches(e)).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  if (upcoming.length || upcomingLoading) {
    const section = node("section", "nt-section"); section.setAttribute("aria-label", "Coming up");
    const heading = node("div", "nt-section-head"); heading.append(node("h2", "", "Coming up"));
    const manage = node("a", "nt-link", "Calendar and joining"); manage.href = libraryURL("calendar"); heading.append(manage);
    section.append(heading);
    if (!upcoming.length) section.append(node("p", "nt-empty", "Loading your calendar…"));
    const shown = showAllUpcoming || term ? upcoming : upcoming.slice(0, 5);
    let day = "";
    for (const event of shown) {
      const label = dayLabel(new Date(event.start));
      if (label !== day) { day = label; section.append(node("h3", "nt-day", label)); }
      section.append(eventRow(event, now));
    }
    if (shown.length < upcoming.length) {
      const more = node("button", "nt-more-button secondary", `Show all ${upcoming.length} upcoming`); more.type = "button";
      more.addEventListener("click", () => { showAllUpcoming = true; render(); }); section.append(more);
    }
    list.append(section);
  }

  const past = node("section", "nt-section"); past.setAttribute("aria-label", "Past meetings");
  const pastHead = node("div", "nt-section-head"); pastHead.append(node("h2", "", "Past meetings")); past.append(pastHead);
  let pastDay = "";
  for (const m of filtered) {
    const started = new Date(m.started_at);
    const label = Number.isNaN(started.getTime()) ? "Earlier" : dayLabel(started);
    if (label !== pastDay) { pastDay = label; past.append(node("h3", "nt-day", label)); }
    const row = node("a", "nt-row nt-past");
    row.href = m.participantNote ? libraryURL(`meetings/${m.id}`) : m.recording_source === "mac" ? "reel-notetaker://home" : organization.webBase + "/record?mode=meeting";
    row.append(node("span", "nt-time", Number.isNaN(started.getTime()) ? "" : timeOf(started)));
    const main = node("span", "nt-main"); main.append(node("strong", "", m.title));
    const preview = m.participantNote ? summaryPreview(m.summary) : "Recorded on this Mac. Open Reel Notetaker to read it.";
    if (preview) main.append(node("span", "nt-preview", preview));
    const ready = m.participantNote && String(m.summary || "").trim();
    row.append(main, peopleChips(m.attendees), node("span", "nt-length", lengthLabel(m.duration_seconds)));
    if (!ready) row.append(node("span", "nt-chip nt-chip-off", m.participantNote ? "No notes" : "On this Mac"));
    past.append(row);
  }
  if (!filtered.length && !busy) past.append(node("p", "nt-empty", term ? "No meetings match your search." : "No meeting notes yet. Notes appear here after Reel Notetaker records a call you were invited to."));
  list.append(past);
  if (meetingError || participantError) message([meetingError, participantError].filter(Boolean).join(" "), true);
  else message(busy && !combined.length ? "Loading meetings…" : "");
}
function transcriptBlocks() {
  if (!Array.isArray(note.segments) || !note.segments.length) return null;
  const wrap = node("div", "nt-transcript"); let last = null, block = null;
  for (const segment of note.segments) {
    const speaker = typeof segment.speaker_attribution === "string" && segment.speaker_attribution.trim() ? segment.speaker_attribution.trim() : "Speaker";
    if (speaker !== last) {
      last = speaker; block = node("div", "nt-turn");
      const head = node("div", "nt-turn-head"); head.append(node("strong", "", speaker));
      if (Number.isFinite(segment.start)) head.append(node("span", "nt-stamp", duration(segment.start)));
      block.append(head); wrap.append(block);
    }
    block.append(node("p", "", segment.text || ""));
  }
  return wrap;
}
async function copyText(button, text) {
  const label = button.textContent;
  try { await navigator.clipboard.writeText(text); button.textContent = "Copied"; }
  catch { button.textContent = "Couldn't copy"; }
  setTimeout(() => { button.textContent = label; }, 1600);
}
function renderNote() {
  const list = el("recordings"); list.classList.add("nt-home");
  el("result-count").textContent = "";
  if (!validUser(currentUser)) return;
  if (noteLoading) { message("Loading meeting notes…"); return; }
  if (noteError) { message(noteError, true); return; }
  if (!note) return;
  message("");
  const article = node("article", "nt-note");
  const back = node("a", "nt-link", "← All meetings"); back.href = libraryURL("meetings");
  const started = new Date(note.started_at);
  const meta = Number.isNaN(started.getTime()) ? "Date unavailable" : `${dayLabel(started)}, ${started.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })} · ${timeOf(started)} · ${lengthLabel(note.duration_seconds)}`;
  const head = node("header", "nt-note-head"); head.append(node("h2", "", note.title), node("p", "nt-meta", meta));
  const people = [...new Set((Array.isArray(note.attendees) ? note.attendees : []).filter((value) => typeof value === "string" && value))];
  if (people.length) {
    const chips = node("div", "nt-attendees");
    for (const person of people) { const chip = node("span", "nt-person", personName(person)); chip.title = person; chips.append(chip); }
    head.append(chips);
  }
  const transcriptText = typeof note.transcript_text === "string" && note.transcript_text ? note.transcript_text
    : Array.isArray(note.segments) ? note.segments.map((s) => s.text || "").join("\n") : "";
  const summaryText = typeof note.summary === "string" ? note.summary : "";
  const actions = node("div", "nt-actions");
  const action = (label, run) => { const button = node("button", "secondary", label); button.type = "button"; button.addEventListener("click", () => run(button)); actions.append(button); };
  if (summaryText) action("Copy summary", (button) => copyText(button, `${note.title}\n\n${summaryText}`));
  if (transcriptText) action("Copy transcript", (button) => copyText(button, transcriptText));
  action("Copy link", (button) => copyText(button, location.href));
  const notion = validNotionURL(note.notes_url) || validNotionURL(note.notion_url);
  if (notion) { const link = node("a", "button secondary", "Open in Notion"); link.href = notion.href; link.target = "_blank"; link.rel = "noopener noreferrer"; actions.append(link); }

  const tabs = node("div", "nt-tabs"); tabs.setAttribute("role", "tablist");
  const panels = {};
  const summary = node("section", "nt-panel"); panels.Summary = summary;
  const blocks = summaryBlocks(summaryText);
  if (!blocks.length) summary.append(node("p", "nt-empty", "No summary for this meeting. There may have been no speech to summarise."));
  let listNode = null;
  for (const block of blocks) {
    if (block.type === "bullet" || block.type === "todo") {
      const kind = block.type === "todo" ? "nt-todo" : "nt-points";
      if (!listNode || listNode.className !== kind) { listNode = node("ul", kind); summary.append(listNode); }
      const item = node("li"); if (block.label) item.append(node("strong", "", block.label + ": ")); item.append(block.text); listNode.append(item);
      continue;
    }
    listNode = null;
    summary.append(node(block.type === "heading" ? "h3" : "p", "", block.text));
  }
  const transcript = node("section", "nt-panel"); panels.Transcript = transcript;
  transcript.append(transcriptBlocks() || node("p", transcriptText ? "nt-plain" : "nt-empty", transcriptText || "Transcript unavailable."));
  const show = (name) => {
    noteTab = name;
    for (const [key, panel] of Object.entries(panels)) panel.hidden = key !== name;
    for (const tab of tabs.children) { const on = tab.textContent === name; tab.classList.toggle("active", on); tab.setAttribute("aria-selected", String(on)); }
  };
  for (const name of Object.keys(panels)) { const tab = node("button", "nt-tab", name); tab.type = "button"; tab.setAttribute("role", "tab"); tab.addEventListener("click", () => show(name)); tabs.append(tab); }
  article.append(back, head, actions, tabs, summary, transcript); list.append(article);
  show(panels[noteTab] ? noteTab : "Summary");
}
async function loadUpcoming() {
  if (publicSignup || !validUser(currentUser) || !organization?.meetingServiceURL) return;
  const user = currentUser, uid = user.uid, number = ++upcomingLoadNumber;
  upcomingLoading = !upcomingEvents.length;
  try {
    const token = await user.getIdToken();
    const response = await fetch(organization.meetingServiceURL + "/calendar/meetings", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    if (!response.ok) throw new Error();
    const data = await response.json();
    if (number !== upcomingLoadNumber || currentUser?.uid !== uid) return;
    upcomingEvents = (Array.isArray(data.meetings) ? data.meetings : []).filter((e) => e && typeof e.title === "string"
      && !Number.isNaN(Date.parse(e.start)) && !Number.isNaN(Date.parse(e.end)) && typeof e.status === "string");
  } catch { if (number === upcomingLoadNumber && currentUser?.uid === uid) upcomingEvents = []; }
  if (number === upcomingLoadNumber && currentUser?.uid === uid) { upcomingLoading = false; if (isMeetings() && !selectedNote()) render(); }
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
  else if (isMeetings()) { loadMeetings(); loadParticipantMeetings(); loadUpcoming(); }
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
    if (calendar) { calendar.dispose(); calendar = null; }
    el("meeting-calendar-panel").hidden = true;
    closeSharedTitleEditor();
    openManagement.clear();
    stopListening();
    closePlayer();
    currentUser = user; ++loadNumber; ++meetingLoadNumber; ++upcomingLoadNumber; upcomingEvents = []; upcomingLoading = false; showAllUpcoming = false; ++participantLoadNumber; ++noteLoadNumber; participantMeetings = []; participantLoading = false; participantError = ""; note = null; noteLoading = false; noteError = ""; loadError = ""; meetingError = ""; entries = []; meetings = []; meetingShareIDs = new Set(); meetingLoading = false; recent = validUser(user) ? readRecent(user.uid) : []; el("recordings").replaceChildren();
    preferences = new Map(); folders = []; organizationReady = false; organizationError = ""; organizationMessage = ""; pendingOrganization.clear(); creatingFolder = false;
    el("folder-form").hidden = true; el("folder-name").value = ""; el("folder-form").querySelector('button[type="submit"]').disabled = false; renderFolders(); organizationStatus();
    if (selectedFolder()) { el("view-title").textContent = "Folder"; el("video-tab").textContent = "Folder"; document.title = `Folder · ${productName()}`; }
    const allowed = validUser(user);
    rejectedAccount = !!candidate && !allowed;
    setLoading(allowed);
    el("result-count").parentElement.hidden = !allowed;
    el("result-count").textContent = allowed ? "Loading…" : ""; el("search").value = "";
    el("sign-in").hidden = !!candidate; el("sign-out").hidden = !candidate; el("refresh").hidden = !allowed; el("refresh").disabled = false;
    el("search").disabled = !allowed; el("sort").disabled = !allowed; el("account").textContent = user?.email || "";
    if (allowed) { refresh(); loadMeetings(); if (selectedNote()) loadNote(); else loadParticipantMeetings(); if (isCalendar()) updateView(); }
    else render();
  });
} catch (e) {
  setLoading(false);
  el("result-count").parentElement.hidden = true;
  loadError = "Couldn't connect to Reel. Reload this page to try again. " + e.message;
  render();
}

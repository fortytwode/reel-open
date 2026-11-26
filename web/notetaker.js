import { organization, publicSignup } from "./organization.js?v=20261121-public-signup";
import { mountMeetingCalendar } from "./meeting-calendar.js?v=20261126-local-history";
import { googleAccountLabel, googleSignInProvider, loadAuth, observeReelAccount, sessionSnapshot } from "./reel/firebase.js?v=20261121-public-signup";

// Team deployments read meetings, notes and the calendar in the full Notetaker
// workspace. Public sign-up keeps this lighter calendar page.
if (organization && !publicSignup) location.replace("/notetaker-meetings" + location.hash);

const el = id => document.getElementById(id);
function showSection() {
  const calendarOpen = publicSignup || location.hash === "#calendar" || location.hash.startsWith("#calendar-meeting=");
  el("page-title").textContent = publicSignup ? "Meetings and notes" : calendarOpen ? "Meeting calendar" : "Meeting notes";
  el("notes").hidden = calendarOpen;
  el("meeting-calendar-panel").hidden = !calendarOpen;
  for (const [id, current] of [["notes-tab", !calendarOpen], ["calendar-tab", calendarOpen]]) {
    if (current) el(id).setAttribute("aria-current", "page");
    else el(id).removeAttribute("aria-current");
  }
}
window.addEventListener("hashchange", showSection);
showSection();
el("mac-helper").hidden = publicSignup || !navigator.platform.startsWith("Mac");
const query = new URL(location.href);
const calendarResult = publicSignup ? query.searchParams.get("calendar_oauth") : null;
if (publicSignup) {
  el("notes-tab").closest("nav").hidden = true;
  const recorder = document.querySelector("[data-recorder]");
  recorder.href = organization.webBase + "/record";
  recorder.textContent = "Record manually";
  if (calendarResult !== null) {
    query.searchParams.delete("calendar_oauth");
    history.replaceState(history.state, "", query);
  }
}
let user = null, generation = 0, resolveAuth;
const notesList = el("notes-list"), notesStatus = el("notes-status");
async function loadNotes(selected, expectedGeneration) {
  if (publicSignup) return;
  notesList.replaceChildren();
  if (!selected) { notesStatus.textContent = "Sign in to see your notes."; return; }
  notesStatus.textContent = "Loading notes…";
  const current = () => user?.uid === selected.uid && generation === expectedGeneration;
  try {
    const token = await selected.getIdToken();
    if (!current()) return;
    const url = new URL(organization.deliveryServiceURL + "/delivery/meetings");
    url.searchParams.set("limit", "50");
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    if (!response.ok) throw new Error("Notes unavailable");
    const data = await response.json();
    if (!current()) return;
    if (!Array.isArray(data.meetings)) throw new Error("Invalid notes response");
    const meetings = data.meetings.filter(m => m && /^reel_[a-f0-9]{64}$/.test(m.id) && typeof m.title === "string" && typeof m.started_at === "string");
    meetings.sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
    for (const meeting of meetings) {
      const row = document.createElement("article"); row.className = "note-row";
      const link = document.createElement("a"); link.textContent = meeting.title;
      link.href = organization.notesBaseURL + "#meetings/" + meeting.id;
      const date = document.createElement("time"); const parsed = new Date(meeting.started_at);
      date.textContent = Number.isNaN(parsed.getTime()) ? "Date unavailable" : parsed.toLocaleString();
      row.append(link, date); notesList.append(row);
    }
    notesStatus.textContent = meetings.length ? "" : "No meeting notes yet.";
  } catch { if (current()) notesStatus.textContent = "Couldn't load meeting notes. Refresh this page to try again."; }
}
const authReady = new Promise(resolve => { resolveAuth = resolve; });
const calendar = mountMeetingCalendar({
  container: el("meeting-calendar-panel"),
  calendarResult,
  session: async () => {
    await authReady;
    const snapshot = sessionSnapshot(user), currentGeneration = generation;
    return snapshot && { ...snapshot, isCurrent: () => user?.uid === snapshot.uid && generation === currentGeneration };
  },
});
try {
  const { auth, am } = await loadAuth();
  observeReelAccount(am, auth, (u, candidate) => {
    if (!u && candidate) {
      el("auth-status").textContent = `Sign in with ${googleAccountLabel}.`;
      am.signOut(auth).catch(() => {});
    } else el("auth-status").textContent = u ? "" : "Sign in to connect your calendar and view your notes.";
    if (user?.uid !== u?.uid) {
      generation++;
      if (publicSignup) calendar.resetAccount();
    }
    user = u;
    el("workspace").hidden = !u;
    el("user").textContent = u ? (u.displayName || u.email) : "";
    el("sign-in").hidden = !!u;
    el("sign-out").hidden = !u;
    loadNotes(u, generation);
    resolveAuth();
    calendar.refresh();
  });
  el("sign-in").addEventListener("click", async () => {
    try { await am.signInWithPopup(auth, googleSignInProvider(am)); }
    catch (e) { if (!["auth/popup-closed-by-user", "auth/cancelled-popup-request"].includes(e?.code)) el("auth-status").textContent = "Sign-in failed. Try again."; }
  });
  el("sign-out").addEventListener("click", () => am.signOut(auth).catch(() => {}));
} catch {
  el("auth-status").textContent = "Couldn't load sign-in. Check your connection and try again.";
  resolveAuth();
}

let installPrompt;
const standalone = matchMedia("(display-mode: standalone)");
function updateInstall() {
  el("install").hidden = !installPrompt || standalone.matches;
  el("install-help").hidden = standalone.matches;
}
window.addEventListener("beforeinstallprompt", event => { event.preventDefault(); installPrompt = event; updateInstall(); });
window.addEventListener("appinstalled", () => { installPrompt = null; el("install-status").textContent = "Reel Notetaker installed."; updateInstall(); });
standalone.addEventListener("change", updateInstall);
el("install").addEventListener("click", async () => {
  if (!installPrompt) return;
  const prompt = installPrompt; installPrompt = null; updateInstall();
  try { await prompt.prompt(); } catch { el("install-help").open = true; }
});
updateInstall();

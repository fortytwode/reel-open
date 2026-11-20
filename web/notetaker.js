import { organization } from "./organization.js?v=20261118-orgstate1";
import { mountMeetingCalendar } from "./meeting-calendar.js?v=20261120-cloud-status";
import { isOrganizationEmail, loadAuth, DOMAIN, sessionSnapshot } from "./reel/firebase.js?v=20261118-orgstate1";

const el = id => document.getElementById(id);
function showSection() {
  const calendarOpen = location.hash === "#calendar" || location.hash.startsWith("#calendar-meeting=");
  el("page-title").textContent = calendarOpen ? "Meeting calendar" : "Meeting notes";
  el("notes").hidden = calendarOpen;
  el("meeting-calendar-panel").hidden = !calendarOpen;
  for (const [id, current] of [["notes-tab", !calendarOpen], ["calendar-tab", calendarOpen]]) {
    if (current) el(id).setAttribute("aria-current", "page");
    else el(id).removeAttribute("aria-current");
  }
}
window.addEventListener("hashchange", showSection);
showSection();
el("mac-helper").hidden = !navigator.platform.startsWith("Mac");
let user = null, generation = 0, resolveAuth;
const notesList = el("notes-list"), notesStatus = el("notes-status");
async function loadNotes(selected, expectedGeneration) {
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
  session: async () => {
    await authReady;
    const snapshot = sessionSnapshot(user), currentGeneration = generation;
    return snapshot && { ...snapshot, isCurrent: () => user?.uid === snapshot.uid && generation === currentGeneration };
  },
});
try {
  const { auth, am } = await loadAuth();
  am.onAuthStateChanged(auth, u => {
    if (u && (!u.emailVerified || !isOrganizationEmail(u.email))) {
      el("auth-status").textContent = `Sign in with your ${DOMAIN.slice(1)} Google account.`;
      am.signOut(auth).catch(() => {});
      u = null;
    } else el("auth-status").textContent = u ? "" : "Sign in to connect your calendar and view your notes.";
    if (user?.uid !== u?.uid) generation++;
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
    const provider = new am.GoogleAuthProvider();
    provider.setCustomParameters({ hd: DOMAIN.slice(1), prompt: "select_account" });
    try { await am.signInWithPopup(auth, provider); }
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

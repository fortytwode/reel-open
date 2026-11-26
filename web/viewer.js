// Reel viewer: /v/<id>. Reads meta.json and media from Firebase Storage (public
// GET, no listing) and, when the recording has a room, reactions/comments/views
// from Firestore (database "reel"). Keep the URL scheme in sync with
// Sources/ReelCore/ShareLinks.swift and the "Remote layout" in README.md.
// All remote data is rendered with textContent only.

import { isOrganizationEmail, BUCKET, FB_CDN, FIREBASE_CONFIG, EMU, STORAGE_ORIGIN, CLOUD_CONFIG } from "./reel/firebase.js?v=20261118-orgstate1";
import { organizationStorageKey } from "./organization.js?v=20261118-orgstate1";
import { viewerURL } from "./reel/core.js?v=20261105-parity2";
import { displayedSharedTitle, saveSharedTitle, editSharedTitle, closeSharedTitleEditor } from "./reel/shared-title.js?v=20261105-parity2";
const viewOptions = new URLSearchParams(location.search);
const MAX_LINK_TIME = 86400;
const embedded = viewOptions.get("embed") === "1";
let autoplayPending = embedded && viewOptions.get("autoplay") === "1";
if (embedded) {
  document.body.classList.add("embed-mode");
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && window.parent !== window) {
      // The parent validates this frame's origin and window before closing it.
      window.parent.postMessage({ type: "reel-close-player" }, "*");
    }
  });
}
const EMOJI = ["👍", "❤️", "😂", "😮", "🎉", "👏", "🔥", "🙌"];

const $ = (id) => document.getElementById(id);
const player = $("player"), statusEl = $("status");

function objectURL(path) {
  return STORAGE_ORIGIN + "/v0/b/" + BUCKET + "/o/" + encodeURIComponent(path) + "?alt=media";
}
function store(kind, key, value) {
  const scopedKey = organizationStorageKey(key);
  try {
    const s = kind === "get" ? sessionStorage.getItem(scopedKey) : null;
    if (kind === "set") sessionStorage.setItem(scopedKey, value);
    if (kind === "del") sessionStorage.removeItem(scopedKey);
    return s;
  } catch (e) { return null; }
}
function fmtTime(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(sec).padStart(2, "0");
}
function fmtDate(d) {
  if (!(d instanceof Date)) d = new Date(d);
  if (isNaN(d)) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) +
    " · " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
function relTime(d) {
  const diff = (d.getTime() - Date.now()) / 1000, abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (abs < 45) return diff < 0 ? "just now" : "in a moment";
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), "day");
  return rtf.format(Math.round(diff / (86400 * 30)), "month");
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const match = location.pathname.match(/^\/v\/([a-z0-9]{16,40})\/?$/);
const id = match && match[1];

const S = {
  base: null, keyed: false, meta: null, sourceSet: false, hlsOnly: false,
  segments: [], chapters: [], transcriptLoaded: false, timingGranularity: null, captionTrackURL: null, captionCueCount: 0, pollTimer: null, pendingPolls: 0,
  views: null, socialStarted: false, lastT: 0, reactions: [], fb: null, user: null,
  roomData: null, titleOverride: null, authGeneration: 0, titleAuth: null, stopTitle: null,
  comments: [], authMsg: "", findMatches: [], findIndex: -1, transcriptDownloadURLs: [],
};

// ---------- generic UI ----------
function showStatus(text) { statusEl.textContent = text; statusEl.hidden = false; player.hidden = true; $("play-cover").hidden = true; $("playback-error").hidden = true; }
function setSegmentsMessage(text) {
  const list = $("segments"); list.textContent = "";
  const li = el("li", "muted", text); li.style.display = "block"; list.appendChild(li);
}
function fatal(title, msg) {
  clearTimeout(S.pollTimer);
  $("title").textContent = title; document.title = title + " · Reel";
  showStatus(msg); setSegmentsMessage("No transcript.");
}

$("copy-link").addEventListener("click", function () {
  const btn = this;
  navigator.clipboard.writeText(shareURLAtCurrentTime()).then(function () {
    $("share-message").hidden = true;
    btn.textContent = "Copied"; setTimeout(function () { btn.textContent = "Copy link"; }, 1500);
  }, function () {
    $("share-message").textContent = "Couldn't copy the link. Copy the recording address from your browser instead.";
    $("share-message").hidden = false;
  });
});
const speed = $("speed"), speedToggle = $("speed-toggle");
const speedOptions = Array.from(speed.querySelectorAll("button"));
for (const option of speedOptions) {
  option.addEventListener("click", () => {
    player.playbackRate = Number(option.value);
    speed.open = false;
    speedToggle.focus({ preventScroll: true });
  });
}
player.addEventListener("ratechange", () => {
  const label = player.playbackRate + "×";
  $("speed-rate").textContent = label;
  speedToggle.setAttribute("aria-label", "Playback speed: " + label);
  for (const option of speedOptions) {
    option.setAttribute("aria-pressed", String(Number(option.value) === player.playbackRate));
  }
});
speed.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !speed.open) return;
  event.preventDefault();
  speed.open = false;
  speedToggle.focus({ preventScroll: true });
});
document.addEventListener("click", (event) => {
  if (!speed.contains(event.target)) speed.open = false;
});
$("captions-toggle").addEventListener("click", function () {
  const track = $("captions-track").track;
  if (!track || !S.captionCueCount) return;
  track.mode = track.mode === "showing" ? "hidden" : "showing";
  syncCaptionsButton();
});
player.textTracks.addEventListener("change", syncCaptionsButton);

// ---------- range (trim) ----------
function range() {
  const tr = S.meta && S.meta.trim;
  const dur = isFinite(player.duration) && player.duration > 0 ? player.duration : (S.meta && S.meta.durationSeconds) || 0;
  if (tr && typeof tr.start === "number" && typeof tr.end === "number" && tr.end > tr.start) return [tr.start, tr.end, true];
  return [0, dur, false];
}
function clampTime(t) {
  const r = range();
  t = Math.max(t, r[0]);
  return r[1] > 0 ? Math.min(t, r[1]) : t;
}
function seekTo(t) { try { player.currentTime = clampTime(t); } catch (e) {} }
function parseLinkedTime(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,4})(?:\.\d{1,3})?$/.test(value)) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= MAX_LINK_TIME ? seconds : null;
}
function linkedTime() {
  const queryTime = parseLinkedTime(viewOptions.get("t"));
  if (queryTime !== null) return queryTime;
  const hash = /^#t=(.+)$/.exec(location.hash);
  return hash ? parseLinkedTime(hash[1]) : null;
}
function shareURLAtCurrentTime() {
  const url = new URL(viewerURL(id, CLOUD_CONFIG));
  const seconds = clampTime(player.currentTime);
  if (Number.isFinite(seconds) && seconds > 0) url.searchParams.set("t", String(Math.round(seconds * 1000) / 1000));
  return url.href;
}

// ---------- header ----------
function renderSubtitle() {
  const m = S.meta; if (!m) return;
  const bits = [];
  if (m.ownerName) bits.push(m.ownerName);
  if (m.createdAt) bits.push(fmtDate(m.createdAt));
  const r = range();
  const dur = r[2] ? r[1] - r[0] : m.durationSeconds;
  if (dur) bits.push(fmtTime(dur));
  if (S.views != null) bits.push(S.views + (S.views === 1 ? " view" : " views"));
  $("subtitle").textContent = bits.filter(Boolean).join(" · ");
}
function renderHead(meta) {
  const title = displayedSharedTitle(S.titleOverride, meta.title || "Untitled recording");
  $("title").textContent = title; document.title = title + " · Reel";
  renderSubtitle();
  const ex = $("expiry"), at = meta.expiresAt ? new Date(meta.expiresAt) : null;
  if (at && !isNaN(at) && at.getTime() > Date.now()) {
    ex.textContent = "Link expires " + fmtDate(at) + " (" + relTime(at) + ")"; ex.hidden = false;
  } else { ex.hidden = true; }
  const dl = $("download");
  if (meta.download === "video.mp4" || meta.download === "trimmed.mp4") {
    dl.href = objectURL(S.base + meta.download); dl.hidden = false;
  } else { dl.hidden = true; }
}

// ---------- summary + chapters ----------
function renderSummary(meta) {
  const card = $("summary-card"), list = $("chapters");
  const summary = typeof meta.summary === "string" ? meta.summary.trim() : "";
  const chapters = Array.isArray(meta.chapters) ? meta.chapters.filter((c) => c && typeof c.start === "number" && typeof c.title === "string") : [];
  S.chapters = chapters;
  card.hidden = !summary && !chapters.length;
  $("overview-empty").hidden = !card.hidden;
  $("chapters-heading").hidden = !chapters.length;
  $("summary-text").textContent = summary; $("summary-text").hidden = !summary;
  list.textContent = ""; list.hidden = !chapters.length;
  chapters.forEach(function (c) {
    const li = el("li"), b = el("button"); b.type = "button";
    b.appendChild(el("time", null, fmtTime(c.start))); b.appendChild(el("span", null, c.title));
    b.addEventListener("click", function () { seekTo(c.start); player.play().catch(function () {}); });
    li.appendChild(b); c._el = li; list.appendChild(li);
  });
  applyDimming();
}

// ---------- transcript ----------
const speakerAttributionStatuses = {
  unavailable: "Speaker identification unavailable for this recording.",
  partial: "Speaker identification is partial. Names are platform display labels. Timings are approximate.",
  platform_captions: "Speaker identification uses platform captions. Names are platform display labels. Timings are approximate.",
};
function speakerAttribution(segment) {
  const { speaker_attribution: attribution, speaker_coverage: coverage } = segment || {};
  return typeof attribution === "string" && Object.hasOwn(speakerAttributionStatuses, attribution) &&
    typeof coverage === "number" && coverage >= 0 && coverage <= 1 ? attribution : "";
}
function captionSpeakerName(segment) {
  const name = segment.speaker_name;
  if ((segment.speaker_source === "google_meet_caption" || segment.speaker_source === "teams_caption") &&
      segment.speaker_match === "caption_text_match" && typeof name === "string" &&
      Array.from(name).length <= 120 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) {
    return name.trim();
  }
  return "";
}
function transcriptLine(segment, escapeLabel) {
  const label = segment._speakerLabel;
  return label ? (escapeLabel ? escapeCueMarkup(label) : label) + ": " + segment.text.trim() : segment.text;
}
function renderTranscript(t) {
  const list = $("segments"); list.textContent = "";
  S.timingGranularity = t && t.timingGranularity === "chunk" ? "chunk" : null;
  const segments = Array.isArray(t && t.segments) ? t.segments : [];
  const attribution = speakerAttribution(segments[0]);
  const speakerStatus = speakerAttributionStatuses[attribution] || "";
  let timingNote = $("transcript-timing-note");
  if (!timingNote) {
    timingNote = el("p", "muted small");
    timingNote.id = "transcript-timing-note";
    $("pane-transcript").insertBefore(timingNote, $("pane-transcript").firstChild);
  }
  const chunkNote = S.timingGranularity && (!attribution || attribution === "unavailable")
    ? "Cloud transcript times are approximate chunk ranges." : "";
  timingNote.textContent = [speakerStatus, chunkNote].filter(Boolean).join(" ");
  timingNote.hidden = !timingNote.textContent;
  S.segments = segments
    .filter((seg) => seg && Number.isFinite(seg.start) && seg.start >= 0 && Number.isFinite(seg.end) && seg.end > seg.start && typeof seg.text === "string" && seg.text.trim())
    .sort((a, b) => a.start - b.start);
  const labels = attribution === "unavailable" ? [] : S.segments.map(captionSpeakerName);
  const showSpeakerLabels = !!attribution || labels.some(Boolean);
  S.segments.forEach((seg, i) => { seg._speakerLabel = showSpeakerLabels ? labels[i] || "Speaker unknown" : ""; });
  if (S.timingGranularity) clearCaptionTrack(); else buildCaptionTrack();
  $("transcript-find").hidden = S.segments.length === 0;
  if (!S.segments.length) setSegmentsMessage(t && t.text ? t.text : "No speech was detected.");
  S.segments.forEach(function (seg) {
    const li = el("li"); li.tabIndex = 0;
    li.appendChild(el("time", null, fmtTime(seg.start))); li.appendChild(el("span", null, transcriptLine(seg)));
    const go = function () { seekTo(seg.start); player.play().catch(function () {}); };
    li.addEventListener("click", go);
    li.addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
    seg._el = li; list.appendChild(li);
  });
  const body = showSpeakerLabels && S.segments.length ? S.segments.map((seg) => transcriptLine(seg)).join("\n")
    : (t && t.text) || S.segments.map((s) => s.text).join(" ");
  const full = speakerStatus ? [speakerStatus, body].filter(Boolean).join("\n\n") : body;
  const btn = $("copy-transcript"); btn.disabled = !full;
  btn.onclick = function () {
    navigator.clipboard.writeText(full).then(function () { btn.textContent = "Copied"; setTimeout(function () { btn.textContent = "Copy"; }, 1500); }, function () {});
  };
  const json = $("transcript-json"); json.href = objectURL(S.base + "transcript.json"); json.hidden = false;
  renderTranscriptFind();
  buildTranscriptDownloads(speakerStatus);
  applyDimming();
}
function vttTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(ms / 3600000), minutes = Math.floor((ms % 3600000) / 60000);
  const secs = Math.floor((ms % 60000) / 1000), millis = ms % 1000;
  return String(hours).padStart(2, "0") + ":" + String(minutes).padStart(2, "0") + ":" +
    String(secs).padStart(2, "0") + "." + String(millis).padStart(3, "0");
}
function escapeCueMarkup(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function normalizeTranscriptText(text) {
  return text.replace(/\r\n?/g, "\n").replace(/[\t ]+/g, " ").replace(/\n+/g, " ").trim();
}
function clippedTranscriptCues() {
  const bounds = range();
  return S.segments.map((segment) => ({
    start: Math.max(segment.start, bounds[0]),
    end: Math.min(segment.end, bounds[1]),
    text: segment.text,
    _speakerLabel: segment._speakerLabel,
  })).filter((cue) => cue.end > cue.start);
}
function buildTranscriptDownloads(speakerStatus) {
  for (const url of S.transcriptDownloadURLs) URL.revokeObjectURL(url);
  S.transcriptDownloadURLs = [];
  const cues = clippedTranscriptCues();
  const txt = $("download-transcript-txt"), srt = $("download-transcript-srt");
  txt.hidden = cues.length === 0;
  srt.hidden = cues.length === 0 || S.timingGranularity === "chunk";
  if (!cues.length) return;
  const txtBody = (speakerStatus ? speakerStatus + "\n\n" : "") + cues.map((cue) => vttTime(cue.start) + " --> " + vttTime(cue.end) + "\n" +
    normalizeTranscriptText(transcriptLine(cue))).join("\n\n") + "\n";
  const srtBody = cues.map((cue, i) => (i + 1) + "\n" +
    vttTime(cue.start).replace(".", ",") + " --> " + vttTime(cue.end).replace(".", ",") + "\n" +
    normalizeTranscriptText(transcriptLine(cue, true))).join("\n\n") + "\n";
  for (const [link, body, type] of [[txt, txtBody, "text/plain"], [srt, srtBody, "application/x-subrip"]]) {
    const url = URL.createObjectURL(new Blob([body], { type: type + ";charset=utf-8" }));
    S.transcriptDownloadURLs.push(url); link.href = url;
  }
}
function renderTranscriptFind() {
  const input = $("transcript-search"), query = input.value.trim().toLocaleLowerCase();
  S.findMatches = query ? S.segments.filter((segment) => transcriptLine(segment).toLocaleLowerCase().includes(query)) : [];
  S.findIndex = -1;
  for (const segment of S.segments) {
    if (segment._el) segment._el.classList.remove("search-match", "search-current");
  }
  S.findMatches.forEach((segment) => segment._el && segment._el.classList.add("search-match"));
  $("transcript-match-count").textContent = query ? S.findMatches.length + (S.findMatches.length === 1 ? " match" : " matches") : "Search transcript";
  $("transcript-previous").disabled = $("transcript-next").disabled = S.findMatches.length === 0;
}
function navigateTranscriptFind(delta) {
  if (!S.findMatches.length) return;
  S.findIndex = S.findIndex < 0 ? (delta > 0 ? 0 : S.findMatches.length - 1)
    : (S.findIndex + delta + S.findMatches.length) % S.findMatches.length;
  for (const segment of S.findMatches) segment._el && segment._el.classList.remove("search-current");
  const segment = S.findMatches[S.findIndex];
  segment._el.classList.add("search-current");
  segment._el.scrollIntoView({ block: "nearest" });
  seekTo(segment.start);
}
$("transcript-search").addEventListener("input", renderTranscriptFind);
$("transcript-next").addEventListener("click", () => navigateTranscriptFind(1));
$("transcript-previous").addEventListener("click", () => navigateTranscriptFind(-1));
$("transcript-search").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  navigateTranscriptFind(event.shiftKey ? -1 : 1);
});
function syncCaptionsButton() {
  const button = $("captions-toggle"), track = $("captions-track").track;
  const available = S.captionCueCount > 0 && !!track;
  button.hidden = !available;
  button.setAttribute("aria-pressed", String(available && track.mode === "showing"));
}
function clearCaptionTrack() {
  const element = $("captions-track");
  if (element.track) element.track.mode = "disabled";
  element.removeAttribute("src");
  if (S.captionTrackURL) URL.revokeObjectURL(S.captionTrackURL);
  S.captionTrackURL = null; S.captionCueCount = 0;
  syncCaptionsButton();
}
function buildCaptionTrack() {
  if (S.timingGranularity === "chunk") { clearCaptionTrack(); return; }
  const cues = clippedTranscriptCues().map((cue) => {
    let end = cue.end;
    // Some media engines keep a cue active when currentTime is exactly its
    // end (most often at duration after a seek). Leave a short clear interval
    // at the playable boundary so captions never survive trim/end clamping.
    const playableEnd = range()[1];
    if (end === playableEnd) end = Math.max(cue.start, end - 0.05);
    return { ...cue, end };
  }).filter((cue) => cue.end > cue.start);
  clearCaptionTrack();
  if (!cues.length) return;
  const body = cues.map((cue, i) => (i + 1) + "\n" + vttTime(cue.start) + " --> " + vttTime(cue.end) +
    "\n" + escapeCueMarkup(normalizeTranscriptText(transcriptLine(cue)))).join("\n\n");
  S.captionTrackURL = URL.createObjectURL(new Blob(["WEBVTT\n\n" + body + "\n"], { type: "text/vtt" }));
  const element = $("captions-track");
  element.addEventListener("error", () => { clearCaptionTrack(); }, { once: true });
  element.addEventListener("load", () => {
    if (element.track) element.track.mode = "hidden";
    syncCaptionsButton();
  }, { once: true });
  element.src = S.captionTrackURL;
  if (element.track) element.track.mode = "hidden";
  S.captionCueCount = cues.length;
  syncCaptionsButton();
}
function applyDimming() {
  const r = range(); if (!r[2]) {
    S.segments.forEach((s) => s._el && s._el.classList.remove("out"));
    S.chapters.forEach((c) => c._el && c._el.classList.remove("out"));
    return;
  }
  S.segments.forEach((s) => { if (s._el) s._el.classList.toggle("out", (s.end != null ? s.end : s.start) <= r[0] || s.start >= r[1]); });
  S.chapters.forEach((c) => { if (c._el) c._el.classList.toggle("out", c.start >= r[1]); });
}
async function loadTranscript(meta) {
  if (S.transcriptLoaded) return;
  try {
    const r = await fetchJSON(S.base + "transcript.json");
    if (r.status === 200) { S.transcriptLoaded = true; renderTranscript(r.data); return; }
  } catch (e) { setSegmentsMessage("Transcript unavailable."); return; }
  const st = meta && meta.transcriptStatus;
  if (st === "none") { S.transcriptLoaded = true; setSegmentsMessage("No speech was detected in this recording."); }
  else if (st === "failed") { S.transcriptLoaded = true; setSegmentsMessage("Transcript unavailable for this recording."); }
  else setSegmentsMessage("Transcript is being prepared…");
}

// ---------- playback tick ----------
let tickTimer = null;
function tick() {
  const t = player.currentTime, r = range();
  if (r[2] && !player.paused && r[1] && t >= r[1] - 0.02) { player.pause(); player.currentTime = r[1]; }
  let cur = null;
  for (const s of S.segments) { if (s.start <= t + 0.05) cur = s; else break; }
  S.segments.forEach((s) => { if (s._el) s._el.classList.toggle("active", s === cur); });
  let ch = null;
  for (const c of S.chapters) { if (c.start <= t + 0.05) ch = c; }
  S.chapters.forEach((c) => { if (c._el) c._el.classList.toggle("active", c === ch); });
  const span = r[1] - r[0];
  if (span > 0) $("playhead").style.left = Math.min(100, Math.max(0, ((t - r[0]) / span) * 100)) + "%";
  const d = t - S.lastT;
  if (!player.paused && d > 0 && d < 1.5) {
    S.reactions.forEach((x) => { if (x.t > S.lastT && x.t <= t) floatEmoji(x.emoji); });
  }
  S.lastT = t;
  $("comment-at-time").textContent = fmtTime(t);
}
player.addEventListener("timeupdate", tick);
player.addEventListener("seeked", tick);
player.addEventListener("playing", function () { $("play-cover").hidden = true; $("playback-error").hidden = true; clearInterval(tickTimer); tickTimer = setInterval(tick, 100); });
player.addEventListener("pause", function () { clearInterval(tickTimer); tick(); });
player.addEventListener("ended", function () { clearInterval(tickTimer); tick(); });
player.addEventListener("play", function () {
  const r = range(); if (r[2] && r[1] && player.currentTime >= r[1] - 0.05) player.currentTime = r[0];
});
player.addEventListener("seeking", function () {
  const r = range(), t = player.currentTime;
  if (t < r[0] - 0.01) player.currentTime = r[0];
  else if (r[2] && r[1] && t > r[1] + 0.01) player.currentTime = r[1];
  S.lastT = player.currentTime;
});
player.addEventListener("loadedmetadata", function () {
  applyDimming(); renderSubtitle(); renderMarkers();
  let start = range()[0];
  const linkedStart = linkedTime();
  if (linkedStart !== null) start = linkedStart;
  start = clampTime(start);
  if (start > 0) { try { player.currentTime = start; } catch (e) {} }
  S.lastT = start;
  if (autoplayPending) {
    autoplayPending = false;
    // The gallery click requested playback. If the browser blocks autoplay,
    // native controls remain visible so one more click starts the video.
    player.play().catch(function () {});
  }
});
window.addEventListener("hashchange", function () {
  const hash = /^#t=(.+)$/.exec(location.hash);
  const hashTime = hash ? parseLinkedTime(hash[1]) : null;
  if (hashTime !== null) seekTo(hashTime);
});

// The cover is independent of the browser poster layout: HLS can otherwise
// display the native150px fallback height before the first decoded frame.
async function startPlayback() {
  $("playback-error").hidden = true;
  try {
    if (player.error) player.load();
    await player.play();
  } catch (error) {
    $("playback-error").textContent = "Playback couldn't start. Try Play again, or refresh this page.";
    $("playback-error").hidden = false;
  }
}
$("play-cover").addEventListener("click", startPlayback);
$("poster").addEventListener("error", function () { this.hidden = true; });
player.addEventListener("error", function () {
  $("playback-error").textContent = "The video couldn't load. Try Play again, or use Download if available.";
  $("playback-error").hidden = false;
  if (S.sourceSet) $("play-cover").hidden = false;
});

// ---------- data fetching ----------
async function fetchJSON(path) {
  const r = await fetch(objectURL(path) + "&t=" + Date.now(), { cache: "no-store" });
  if (!r.ok) return { status: r.status };
  return { status: 200, data: await r.json() };
}

// ---------- boot / password ----------
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
async function deriveKey(password, kdf) {
  const km = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: hexToBytes(kdf.salt), iterations: kdf.iterations }, km, 128);
  return Array.from(new Uint8Array(bits)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function tryKey(key) {
  const base = "reel/v/" + id + "/k/" + key + "/";
  const r = await fetchJSON(base + "meta.json");
  if (r.status === 403 || r.status === 404) return false;
  if (r.status !== 200) throw new Error("HTTP " + r.status);
  store("set", "reel-key-" + id, key);
  S.base = base; S.keyed = true;
  $("gate").hidden = true; $("layout").hidden = false;
  applyMeta(r.data);
  return true;
}
function showGate(errorText) {
  clearTimeout(S.pollTimer);
  $("title").textContent = "This recording is password protected";
  document.title = "Password required · Reel"; $("subtitle").textContent = ""; $("expiry").hidden = true;
  $("layout").hidden = true; $("gate").hidden = false;
  const err = $("gate-error"); err.textContent = errorText || ""; err.hidden = !errorText;
  $("gate-submit").disabled = false;
  $("gate-password").focus();
}
$("gate-form").addEventListener("submit", async function (e) {
  e.preventDefault();
  const btn = $("gate-submit"), err = $("gate-error"); btn.disabled = true; err.hidden = true;
  try {
    const key = await deriveKey($("gate-password").value, S.stub.kdf);
    if (!(await tryKey(key))) { showGate("Wrong password"); $("gate-password").select(); }
  } catch (ex) { showGate("Couldn't check the password. Check your connection and try again."); }
});
function relock() {
  store("del", "reel-key-" + id);
  player.pause(); player.removeAttribute("src"); player.load();
  S.stopTitle?.(); S.stopTitle = null; S.roomData = null; S.titleOverride = null; closeSharedTitleEditor(); $("rename-shared-title").hidden = true;
  S.sourceSet = false; S.keyed = false; S.base = null; S.meta = null; S.transcriptLoaded = false;
  showGate("Wrong password");
}

async function boot() {
  if (!CLOUD_CONFIG.allowedEmailDomain) { fatal("Cloud sharing is not configured", "Ask your organization for its recording link."); return; }
  if (!id) { fatal("Video not found", "This link is not a valid Reel link."); return; }
  $("layout").hidden = false;
  let r;
  try { r = await fetchJSON("reel/v/" + id + "/meta.json"); }
  catch (e) { showStatus("Couldn't load this recording. Check your connection and refresh."); setTimeout(boot, 5000); return; }
  if (r.status === 404) return fatal("Video not found", "This recording doesn't exist or was deleted.");
  if (r.status === 403) return fatal("Link unavailable", "This link has expired or is no longer available.");
  if (r.status !== 200) { showStatus("Couldn't load this recording. Check your connection and refresh."); setTimeout(boot, 5000); return; }
  if (r.data && r.data.locked) {
    S.stub = r.data;
    const k = store("get", "reel-key-" + id);
    if (k) { try { if (await tryKey(k)) return; } catch (e) {} store("del", "reel-key-" + id); }
    showGate();
    return;
  }
  S.base = "reel/v/" + id + "/";
  applyMeta(r.data);
}

// ---------- meta state machine ----------
function schedule(ms) { clearTimeout(S.pollTimer); S.pollTimer = setTimeout(refresh, ms); }
async function refresh() {
  try {
    const r = await fetchJSON(S.base + "meta.json");
    if (r.status === 200) return applyMeta(r.data);
    if (r.status === 403 || r.status === 404) {
      if (S.keyed) return relock();
      if (!S.sourceSet) return fatal("Link unavailable", "This recording is no longer available.");
      return;
    }
  } catch (e) {}
  schedule(5000);
}
function applyMeta(meta) {
  const firstMeta = !S.meta;
  S.meta = meta;
  renderHead(meta); renderSummary(meta);
  if (firstMeta && !$("summary-card").hidden) setTab("overview");
  const st = meta.status === "uploading" ? "processing" : meta.status;
  if (st === "recording") { showStatus("This recording is still in progress. It will play here as soon as it ends."); setSegmentsMessage("No transcript yet."); return schedule(3000); }
  if (st === "processing") { showStatus("Finishing upload…"); setSegmentsMessage("No transcript yet."); return schedule(3000); }
  if (st !== "ready") { showStatus("This recording isn't available."); return schedule(10000); }
  if (!ensurePlayback(meta)) return schedule(3000);
  loadTranscript(meta);
  startSocial(meta);
  const pending = meta.transcriptStatus === "pending" && S.pendingPolls++ < 150;
  if (S.hlsOnly || pending) schedule(S.hlsOnly ? 10000 : 5000);
}

function loadHlsJs() {
  if (window.Hls) return Promise.resolve(window.Hls);
  return new Promise(function (resolve, reject) {
    const s = document.createElement("script");
    s.src = "/vendor/hls.min.js"; s.onload = () => resolve(window.Hls); s.onerror = reject;
    document.head.appendChild(s);
  });
}
function ensurePlayback(meta) {
  if (S.sourceSet) return true;
  const pb = meta.playback || { mp4: true };
  if (!pb.mp4 && !pb.hls) { showStatus("Preparing video…"); return false; }
  statusEl.hidden = true; player.hidden = false; $("controls-row").hidden = false;
  $("play-cover").hidden = false;
  const poster = $("poster");
  if (meta.hasThumbnail) {
    const preview = objectURL(S.base + "thumb.jpg");
    player.poster = preview; poster.hidden = false; poster.src = preview;
  } else { poster.hidden = true; poster.removeAttribute("src"); }
  S.sourceSet = true;
  if (pb.mp4) { player.src = objectURL(S.base + "video.mp4"); return true; }
  S.hlsOnly = true;
  const playlist = objectURL(S.base + "video.m3u8");
  if (player.canPlayType("application/vnd.apple.mpegurl")) { player.src = playlist; return true; }
  loadHlsJs().then(function (Hls) {
    if (!Hls || !Hls.isSupported()) throw new Error("no MSE");
    const hls = new Hls(); hls.loadSource(playlist); hls.attachMedia(player);
  }).catch(function () { S.sourceSet = false; S.hlsOnly = false; showStatus("This browser can't play this recording yet. Try the Download button or another browser."); });
  return true;
}

// ---------- social (Firestore + Auth), isolated from playback ----------
async function startSocial(meta) {
  if (S.socialStarted || !meta.room) return;
  S.socialStarted = true;
  const room = meta.room;
  let fs, app;
  try {
    const appM = await import(FB_CDN + "firebase-app.js");
    fs = await import(FB_CDN + "firebase-firestore.js");
    app = appM.initializeApp(EMU ? { ...FIREBASE_CONFIG, projectId: "demo-reel" } : FIREBASE_CONFIG); // emulators run as project demo-reel
    const db = fs.getFirestore(app, CLOUD_CONFIG.firestoreDatabase);
    if (EMU) fs.connectFirestoreEmulator(db, "127.0.0.1", 8080);
    S.fb = { db, fs, room };
  } catch (e) { return; }
  S.stopTitle = fs.onSnapshot(fs.doc(S.fb.db, "videos", room), (snapshot) => {
    S.roomData = snapshot.exists() ? snapshot.data() : null;
    S.titleOverride = S.roomData?.titleOverride || null;
    if (S.meta) renderHead(S.meta);
    renderTitleAction();
  }, () => { S.roomData = null; S.titleOverride = null; if (S.meta) renderHead(S.meta); renderTitleAction(); });
  trackViews().catch(function () {});
  try { initReactions(); } catch (e) {}
  try { initComments(); } catch (e) {}
  initAuth(app).catch(function () {
    $("comment-auth").textContent = "Sign-in is unavailable right now.";
  });
}
function canRenameTitle() {
  const user = S.user;
  return !!S.meta && !$("layout").hidden && !!user?.emailVerified && isOrganizationEmail(user.email) && S.roomData?.ownerUid === user.uid;
}
function renderTitleAction() { $("rename-shared-title").hidden = embedded || !canRenameTitle(); }
$("rename-shared-title").addEventListener("click", () => {
  if (!canRenameTitle()) return;
  const uid = S.user.uid, generation = S.authGeneration, room = S.fb.room;
  const isCurrent = () => generation === S.authGeneration && S.titleAuth?.currentUser?.uid === uid && S.fb?.room === room && canRenameTitle();
  editSharedTitle({ title: displayedSharedTitle(S.titleOverride, S.meta.title || "Untitled recording"), save: async (title) => {
    await saveSharedTitle({ ...S.fb, id, uid, title, isCurrent });
    S.titleOverride = title; renderHead(S.meta);
  } });
});
async function trackViews() {
  const { db, fs, room } = S.fb;
  const ref = fs.doc(db, "videos", room);
  let snap;
  try { snap = await fs.getDoc(ref); } catch (e) { return; }
  if (!snap.exists()) return;
  S.views = Number(snap.data().views) || 0; renderSubtitle();
  const flag = "reel-viewed-" + room;
  if (store("get", flag)) return;
  store("set", flag, "1");
  try { await fs.updateDoc(ref, { views: fs.increment(1) }); S.views += 1; renderSubtitle(); } catch (e) {}
}

// Reactions
function floatEmoji(emoji) {
  const f = el("span", "floater", emoji);
  f.style.left = (10 + Math.random() * 80) + "%";
  f.addEventListener("animationend", () => f.remove());
  $("floaters").appendChild(f);
  setTimeout(() => f.remove(), 2500);
}
function renderMarkers() {
  const strip = $("strip");
  strip.querySelectorAll(".marker").forEach((n) => n.remove());
  const r = range(), span = r[1] - r[0];
  if (!S.fb || span <= 0) return;
  S.reactions.slice(0, 400).forEach(function (x) {
    if (x.t < r[0] || x.t > r[1]) return;
    const b = el("button", "marker", x.emoji); b.type = "button";
    b.style.left = (((x.t - r[0]) / span) * 100) + "%";
    b.title = fmtTime(x.t); b.setAttribute("aria-label", x.emoji + " at " + fmtTime(x.t));
    b.addEventListener("click", function (e) { e.stopPropagation(); seekTo(x.t); });
    strip.appendChild(b);
  });
}
function initReactions() {
  const { db, fs, room } = S.fb;
  const bar = $("reactbar"), counts = {};
  EMOJI.forEach(function (em) {
    const b = el("button"); b.type = "button"; b.setAttribute("aria-label", "React " + em);
    b.appendChild(document.createTextNode(em));
    const c = el("span", null, ""); b.appendChild(c); counts[em] = c;
    b.addEventListener("click", function () {
      const t = Math.round(player.currentTime * 10) / 10;
      floatEmoji(em);
      fs.addDoc(fs.collection(db, "videos", room, "reactions"), { emoji: em, t: t, createdAt: fs.serverTimestamp() }).catch(function () {});
    });
    bar.appendChild(b);
  });
  bar.hidden = false; $("strip").hidden = false;
  $("strip").addEventListener("click", function (e) {
    const r = range(), box = this.getBoundingClientRect();
    if (r[1] > r[0] && box.width) seekTo(r[0] + ((e.clientX - box.left) / box.width) * (r[1] - r[0]));
  });
  fs.onSnapshot(fs.collection(db, "videos", room, "reactions"), function (snap) {
    const list = [];
    snap.forEach(function (d) {
      const x = d.data();
      if (EMOJI.indexOf(x.emoji) >= 0 && typeof x.t === "number") list.push({ emoji: x.emoji, t: x.t });
    });
    list.sort((a, b) => a.t - b.t);
    S.reactions = list;
    EMOJI.forEach(function (em) { const n = list.filter((x) => x.emoji === em).length; counts[em].textContent = n ? String(n) : ""; });
    renderMarkers();
  }, function (err) { console.warn("reel: reactions unavailable", err && err.code); bar.hidden = true; $("strip").hidden = true; });
}

// Comments
function setTab(name) {
  const selected = $("tab-" + name);
  if (!selected || selected.hidden) return;
  for (const key of ["overview", "transcript", "comments"]) {
    const active = key === name;
    $("tab-" + key).setAttribute("aria-selected", String(active));
    $("tab-" + key).tabIndex = active ? 0 : -1;
    $("pane-" + key).hidden = !active;
  }
}
for (const name of ["overview", "transcript", "comments"]) {
  $("tab-" + name).addEventListener("click", () => setTab(name));
}
document.querySelector(".tabs").addEventListener("keydown", function (event) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = Array.from(this.querySelectorAll('[role="tab"]')).filter((tab) => !tab.hidden);
  const current = tabs.indexOf(document.activeElement);
  if (current < 0) return;
  const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
    : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault(); setTab(tabs[next].id.slice(4)); tabs[next].focus();
});
$("comment-shortcut").addEventListener("click", function () {
  setTab("comments");
  if (!$("comment-form").hidden) $("comment-text").focus();
  else $("tab-comments").focus();
});

function commentDate(c) { return c.createdAt && c.createdAt.toDate ? c.createdAt.toDate() : null; }
function renderComments() {
  const list = $("comments"); list.textContent = "";
  $("comment-count").textContent = S.comments.length ? "(" + S.comments.length + ")" : "";
  if (!S.comments.length) list.appendChild(el("li", "muted small", "No comments yet."));
  S.comments.forEach(function (c) {
    const li = el("li"), head = el("div", "c-head");
    head.appendChild(el("strong", null, c.name || "Someone"));
    const d = commentDate(c); if (d) head.appendChild(el("span", "muted", relTime(d)));
    if (typeof c.t === "number") {
      const chip = el("button", "chip", fmtTime(c.t)); chip.type = "button";
      chip.addEventListener("click", function () { seekTo(c.t); });
      head.appendChild(chip);
    }
    if (S.user && c.uid === S.user.uid) {
      const del = el("button", "link", "Delete"); del.type = "button";
      del.addEventListener("click", function () {
        S.fb.fs.deleteDoc(S.fb.fs.doc(S.fb.db, "videos", S.fb.room, "comments", c.id)).catch(function () { showCommentMsg("Couldn't delete that comment."); });
      });
      head.appendChild(del);
    }
    li.appendChild(head); li.appendChild(el("p", "c-text", c.text || ""));
    list.appendChild(li);
  });
}
function showCommentMsg(text) { const m = $("comment-msg"); m.textContent = text || ""; m.hidden = !text; }
function initComments() {
  const { db, fs, room } = S.fb;
  $("tab-comments").hidden = false; $("comment-shortcut").hidden = false;
  const q = fs.query(fs.collection(db, "videos", room, "comments"), fs.orderBy("createdAt"));
  fs.onSnapshot(q, { includeMetadataChanges: false }, function (snap) {
    S.comments = snap.docs.map(function (d) {
      const x = d.data({ serverTimestamps: "estimate" });
      return { id: d.id, text: x.text, t: x.t, uid: x.uid, name: x.name, createdAt: x.createdAt };
    });
    renderComments();
  }, function (err) {
    console.warn("reel: comments unavailable", err && err.code);
    const tab = $("tab-comments");
    tab.hidden = true; $("comment-shortcut").hidden = true;
    if (tab.getAttribute("aria-selected") === "true") setTab("transcript");
  });
  setInterval(renderComments, 60000);
  $("comment-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    const text = $("comment-text").value.trim(), user = S.user;
    if (!text || !user) return;
    const btn = $("comment-submit"); btn.disabled = true; showCommentMsg("");
    const at = $("comment-at").checked;
    try {
      await fs.addDoc(fs.collection(db, "videos", room, "comments"), {
        text: text.slice(0, 2000),
        t: at ? Math.round(player.currentTime * 10) / 10 : null,
        uid: user.uid,
        name: (user.displayName || user.email || "Someone").slice(0, 120),
        photoURL: user.photoURL || null,
        createdAt: fs.serverTimestamp(),
      });
      $("comment-text").value = "";
    } catch (ex) { showCommentMsg("Couldn't post your comment. Try again."); }
    btn.disabled = false;
  });
}

async function initAuth(app) {
  const am = await import(FB_CDN + "firebase-auth.js");
  const auth = am.getAuth(app);
  if (EMU) am.connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  S.titleAuth = auth;
  const box = $("comment-auth");
  function renderAuth() {
    box.textContent = "";
    const form = $("comment-form");
    form.hidden = !S.user;
    if (S.user) {
      box.appendChild(el("span", "small muted", "Commenting as " + (S.user.displayName || S.user.email)));
      const out = el("button", "link", "Sign out"); out.type = "button";
      out.addEventListener("click", () => am.signOut(auth).catch(function () {}));
      box.appendChild(out);
    } else {
      const b = el("button", null, "Sign in with Google to comment"); b.type = "button";
      b.addEventListener("click", async function () {
        showCommentMsg(""); S.authMsg = "";
        const provider = new am.GoogleAuthProvider();
        provider.setCustomParameters({ hd: CLOUD_CONFIG.allowedEmailDomain });
        try { await am.signInWithPopup(auth, provider); }
        catch (ex) { if (ex && ex.code !== "auth/popup-closed-by-user" && ex.code !== "auth/cancelled-popup-request") showCommentMsg("Sign-in failed. Try again."); }
      });
      box.appendChild(b);
    }
    renderComments();
  }
  am.onAuthStateChanged(auth, function (user) {
    ++S.authGeneration; closeSharedTitleEditor(); S.user = null; renderTitleAction();
    if (user && (!isOrganizationEmail(user.email) || !user.emailVerified)) {
      showCommentMsg("Only verified organization accounts can comment.");
      am.signOut(auth).catch(function () {});
      return;
    }
    S.user = user; renderAuth(); renderTitleAction();
  });
}

boot();

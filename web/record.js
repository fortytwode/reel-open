// Reel browser recorder (/record): Chrome and Edge on Windows (and macOS). Flow ported from
// Sources/Reel/RecorderController.swift: start → pick screen/window/tab → countdown (capture
// warms up, live upload starts) → record with live segment upload → pause/resume → stop
// (link copied immediately, plays within seconds) / cancel / restart → video.mp4 assembled
// locally → background upload. Recordings live in IndexedDB; an interrupted one is rebuilt on
// the next visit.
import { mountMeetingCalendar } from "./meeting-calendar.js?v=20261120-partial-recovery";
import { organizationStorageKey } from "./organization.js?v=20261118-orgstate1";
import * as C from "./reel/core.js?v=20261126-serving-import";
import * as store from "./reel/store.js?v=20261126-serving-import";
import { transcribeMeeting } from "./reel/meeting-transcription.js?v=20261029-meetings3";
import { deliverMeeting, listDeliveryCalendar } from "./reel/meeting-delivery.js?v=20261119-choice1";
import { transcribeCloudMeeting, summarizeCloudMeeting } from "./reel/cloud-meeting-speech.js?v=20261110-cloudmeeting1";
import { isOrganizationEmail, loadAuth, CLOUD_CONFIG, DOMAIN, EMU, sessionSnapshot } from "./reel/firebase.js?v=20261118-orgstate1";
import { Library, Publisher, APP } from "./reel/publisher.js?v=20261126-serving-import";
import { CaptureSession, captureSupported, pickDisplay, openCamera, openMic, pickDevice, modeForSurface } from "./reel/capture.js?v=20261126-pause";
import { createPreview } from "./reel/preview.js?v=20261029-windows1";
import { openBubble, pipSupported } from "./reel/pip.js";
import { createCameraEffect, effectsSupported, preloadEffects } from "./reel/effects.js";

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const query = new URLSearchParams(location.search);
const tabEntry = query.get("source") === "tab";
const isMeeting = () => $("recording-kind").value === "meeting";
const isTabCapture = () => tabEntry && !isMeeting();

// ---------------------------------------------------------------- settings (localStorage, ReelSettings subset)

const SETTINGS_KEY = organizationStorageKey("reel-settings");
let settings = C.decodeSettings((() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)); } catch { return null; } })());
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {} }
function captureMode() { return isTabCapture() ? "screen" : settings.mode; }

// ---------------------------------------------------------------- UI helpers

let toastTimer = null;
function toast(text, isError = false) {
  const t = $("toast");
  t.textContent = text; t.className = "toast" + (isError ? " error" : ""); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 7000 : 3500);
}
function notify(title, body, url) {
  if (!document.hidden || !("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, { body: url ? body + "\n" + url : body, icon: "/favicon.svg" });
    n.onclick = () => { window.focus(); n.close(); };
  } catch {}
}
async function copyText(text, nav = navigator) {
  showLastLink(text);
  try { await nav.clipboard.writeText(text); toast("Link copied"); return true; }
  catch {
    try { await navigator.clipboard.writeText(text); toast("Link copied"); return true; }
    catch { toast("Link ready. Use Copy link (the browser blocked automatic copying)."); return false; }
  }
}
function showLastLink(url) { $("last").hidden = false; $("last-link").href = url; $("last-link").textContent = url; }
$("last-copy").addEventListener("click", () => copyText($("last-link").href));

// ---------------------------------------------------------------- auth (Firebase Auth, same project and rules as the Mac app)

let auth = null, am = null, user = null;
let authGeneration = 0;
function visibleToCurrentAccount(recording) {
  return C.canViewLocalRecording(recording, user?.uid, false);
}
function clearImportedAccountDetails() {
  $("list").replaceChildren();
  $("last").hidden = true;
  $("last-link").removeAttribute("href");
  $("last-link").textContent = "";
  $("toast").hidden = true;
  for (const id of ["share-dialog", "trim-dialog", "meeting-notes-dialog"]) {
    if ($(id).open) $(id).close("account-changed");
  }
  for (const url of thumbURLs.values()) if (url) URL.revokeObjectURL(url);
  thumbURLs.clear();
}
let authReady;
let libraryReady;
const authReadyPromise = new Promise((r) => { authReady = r; });
const session = {
  async session() {
    await authReadyPromise;
    const snapshot = sessionSnapshot(user), generation = authGeneration;
    return snapshot && { ...snapshot, isCurrent: () => user?.uid === snapshot.uid && authGeneration === generation };
  },
};
async function initAuth() {
  try {
    ({ auth, am } = await loadAuth());
  } catch (e) {
    $("sign-in").hidden = true;
    $("auth-msg").textContent = "Couldn't load sign-in. Recordings are kept in this browser until you can sign in."; $("auth-msg").hidden = false;
    authReady(); return;
  }
  am.onAuthStateChanged(auth, (u) => {
    if (u && (!isOrganizationEmail(u.email) || !u.emailVerified)) {
      $("auth-msg").textContent = `Sign in with your ${DOMAIN.slice(1)} Google account to upload and share.`; $("auth-msg").hidden = false;
      am.signOut(auth).catch(() => {});
      u = null;
    } else if (u) $("auth-msg").hidden = true;
    if (user?.uid !== u?.uid) {
      authGeneration++;
      if (library.list().some(r => r.localImport)) clearImportedAccountDetails();
    }
    user = u;
    $("user").textContent = u ? (u.displayName || u.email) : "Not signed in: recordings stay in this browser";
    $("sign-in").hidden = !!u; $("sign-out").hidden = !u;
    authReady();
    renderList();
    if (u) libraryReady.then(async () => { await publisher.syncCloudLibrary(); resumeMeetingDelivery(); }).catch((e) => toast(e.message, true));
    if ($("recording-kind").value === "meeting") loadDeliveryInvites();
  });
  $("sign-in").addEventListener("click", async () => {
    const provider = new am.GoogleAuthProvider();
    provider.setCustomParameters({ hd: DOMAIN.slice(1), prompt: "select_account" });
    try { await am.signInWithPopup(auth, provider); }
    catch (e) { if (e && e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") toast("Sign-in failed. Try again.", true); }
  });
  $("sign-out").addEventListener("click", () => am.signOut(auth).catch(() => {}));
}

// ---------------------------------------------------------------- library + publisher

const library = new Library();
const publisher = new Publisher({
  library, auth: session, settings: () => settings, cfg: CLOUD_CONFIG,
  ui: { toast, notify, copy: (text, nav) => copyText(text, nav) },
});
window.__reel = { library, publisher, store, C, processRecording, state: () => R };   // for tests and debugging

// ---------------------------------------------------------------- recorder state (RecorderController)

const R = { phase: "idle", session: null, recording: null, log: null, uploader: null, writes: Promise.resolve(),
  bubble: null, camStream: null, camEffect: null, display: null, mic: null, unlock: null, stoppedAt: 0, liveUpload: false, cancelCountdown: false, countdownError: null };

function setPhase(p) {
  if (p !== "idle") preview.stop();
  R.phase = p;
  const live = p === "countdown" || p === "recording" || p === "paused" || p === "finishing" || p === "preparing";
  $("setup").hidden = live; $("live").hidden = !live;
  $("live").classList.toggle("paused", p === "paused");
  $("live-state").textContent = { preparing: "Starting…", countdown: "Get ready", recording: "Recording", paused: "Paused", finishing: "Saving…" }[p] || "";
  $("pause").textContent = p === "paused" ? "Resume" : "Pause";
  for (const id of ["pause", "restart", "stop"]) $(id).disabled = !(p === "recording" || p === "paused");
  $("cancel").disabled = !(p === "recording" || p === "paused" || p === "countdown");
  if (R.bubble) R.bubble.setState({ phase: p, elapsed: R.session ? R.session.elapsed : 0 });
}

function fmt(s) { return C.transcriptTimestamp(s); }

async function cameraTrackFor(s) {
  if (!(s.mode === "camera" || s.cameraEnabled)) return null;
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
  const pick = pickDevice(cams, s.cameraID);
  R.camStream = await openCamera(pick && pick.deviceId && pick.deviceId !== "default" ? pick.deviceId : undefined);
  let track = R.camStream.getVideoTracks()[0];
  if (s.cameraBackground !== "none" && effectsSupported()) {
    try {
      const cs = track.getSettings();
      const size = s.mode === "camera" ? C.outputSize(cs.width || 1280, cs.height || 720, "p720") : { width: 640, height: 360 };
      R.camEffect = await createCameraEffect(track, s.cameraBackground, await backgroundImage(), size);
      track = R.camEffect.track;
    } catch (e) { console.warn("Camera effect unavailable", e); toast("Camera background effect isn't available in this browser.", true); }
  }
  return track;
}

let bgImageCache;
async function backgroundImage() {
  if (bgImageCache !== undefined) return bgImageCache;
  const blob = await store.getFile("settings", "background").catch(() => null);
  bgImageCache = blob ? await createImageBitmap(blob).catch(() => null) : null;
  return bgImageCache;
}

function releaseDevices() {
  if (R.camEffect) { R.camEffect.stop(); R.camEffect = null; }
  if (R.camStream) { R.camStream.getTracks().forEach((t) => t.stop()); R.camStream = null; }
  if (R.display) { R.display.getTracks().forEach((t) => t.stop()); R.display = null; }
  if (R.mic) { R.mic.getTracks().forEach((t) => t.stop()); R.mic = null; }
  if (R.bubble) { R.bubble.close(); R.bubble = null; }
}

async function start({ reuse = false } = {}) {
  if (R.phase !== "idle") return;
  const meetingMode = isMeeting();
  const tabOnly = isTabCapture();
  let meetingDetails = null;
  const captureOwnerUID = user?.uid;
  if (meetingMode) {
    try { meetingDetails = C.parseMeetingDetails($("meeting-attendees").value); }
    catch (e) { toast(e.message, true); return; }
  }
  const s = meetingMode ? C.meetingSettings(settings) : { ...settings, mode: captureMode() };
  const meetingTitle = $("meeting-title").value.trim();
  setPhase("preparing");
  const bail = (msg) => {
    if (msg) toast(msg, true);
    releaseDevices();
    setPhase("idle");
  };
  const persist = () => navigator.storage?.persist?.().catch(() => {});
  if (!tabOnly) {
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
    persist();
  }
  let camTrack = null;
  const prepareCameraAndBubble = async () => {
    camTrack = await cameraTrackFor(s);
    // PiP may need a fresh gesture once the browser's sharing picker closes.
    if (!pipSupported() || s.mode === "camera" || (tabOnly && !navigator.userActivation?.isActive)) return;
    try {
      R.bubble = await openBubble({
        stream: camTrack ? new MediaStream([camTrack]) : null, size: C.BUBBLE_DIAMETER[s.bubbleSize],
        handlers: {
          onPause: () => pauseResume(), onStop: (nav) => stop(nav), onCancel: () => cancel(),
          onKey: (e, nav) => onShortcut(e, nav), onClose: () => onBubbleClosed(),
        },
      });
    } catch (e) { console.warn("Bubble window unavailable", e); R.bubble = null; }
  };
  try {
    if (!reuse) {
      if (!tabOnly) await prepareCameraAndBubble();
      if (s.mode !== "camera") {
        try { R.display = await pickDisplay(s, { tabOnly }); }
        catch (e) { return bail(e && e.name === "NotAllowedError" ? null : "Couldn't start screen capture: " + e.message); }
      }
      if (tabOnly) {
        if (R.display?.getVideoTracks()[0]?.getSettings().displaySurface !== "browser") {
          return bail("Choose a browser tab in the share picker to record it.");
        }
        persist();
        await prepareCameraAndBubble();
      }
      if (meetingMode && !R.display?.getAudioTracks().length) return bail("Computer sound was not shared. Choose the meeting tab with tab audio, or your screen with system audio, then try again.");
      if (C.usesMic(s.audio)) {
        const mics = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
        const pick = pickDevice(mics, s.microphoneID);
        try { R.mic = await openMic(pick && pick.deviceId !== "default" ? pick.deviceId : undefined); }
        catch (e) { if (meetingMode) return bail("Microphone permission is needed to capture your side of the meeting."); toast("Microphone unavailable: recording without it.", true); R.mic = null; }
      }
    } else {
      camTrack = R.camEffect ? R.camEffect.track : (R.camStream ? R.camStream.getVideoTracks()[0] : null);
    }
  } catch (e) {
    return bail(e && e.name === "NotAllowedError" ? "Camera permission was denied." : e.message);
  }
  if (s.mode === "camera" && !camTrack) return bail("No camera found.");

  const surface = R.display ? R.display.getVideoTracks()[0].getSettings().displaySurface : null;
  // Whole-screen capture shows the bubble window itself; otherwise draw the camera into the video.
  const composite = !!camTrack && (surface !== "monitor" || !R.bubble);

  const now = new Date();
  let r;
  try {
    const recordingNonce = C.newRecordingNonce();
    const shareID = captureOwnerUID ? await C.ownerShareID(captureOwnerUID, recordingNonce) : C.newShareID();
    r = C.newRecording({ shareID, createdAt: now, mode: s.mode === "camera" ? "camera" : modeForSurface(surface),
      upload: s.autoUpload && captureOwnerUID ? "pending" : "localOnly" });
    r.recordingNonce = recordingNonce;
    if (captureOwnerUID) r.recordingOwnerUID = captureOwnerUID;
  } catch (e) {
    return bail(e.message);
  }
  if (meetingDetails) {
    r.meeting = meetingDetails;
    if (captureOwnerUID) r.meeting.ownerUID = captureOwnerUID;
    r.meeting.calendar = deliveryCalendarEvents.get($("meeting-calendar-invite").value)?.calendar ?? null;
    r.meeting.deliveryStatus = "pending";
    r.title = meetingTitle || "Meeting " + now.toLocaleString();
    r.titleIsCustom = true;
  }
  r.transcriptStatus = s.audio === "none" ? "none" : "pending";
  r.captureState = "recording";

  R.recording = r; R.log = C.newSegmentLog(); R.writes = Promise.resolve(); R.uploader = null; R.cancelCountdown = false; R.countdownError = null;
  await library.update(r, { log: R.log, progress: null, codecs: null });
  // Held while recording, so another tab's recovery leaves this recording alone.
  if (navigator.locks) {
    await new Promise((locked) => navigator.locks.request("reel-recording-" + r.id, () => { locked(); return new Promise((res) => { R.unlock = res; }); }));
  }

  const sessionObj = new CaptureSession({
    settings: s, display: R.display, camera: camTrack, mic: R.mic, composite,
    events: {
      onInit: (bytes, codecs) => queueWrite(async () => {
        await store.putFile(r.id, C.File.initSegment, bytes);
        R.log.hasInit = true;
        await store.updateRow(r.id, { log: R.log, codecs });
        R.uploader && R.uploader.segmentWritten(null, R.log);
      }),
      onSegment: (index, duration, bytes) => queueWrite(async () => {
        await store.putFile(r.id, C.segmentFile(index), bytes);
        const entry = { index, duration, bytes: bytes.byteLength };
        C.SegmentLog.append(R.log, entry);
        await store.updateRow(r.id, { log: R.log });
        R.uploader && R.uploader.segmentWritten(entry, R.log);
      }),
      onThumb: (blob) => queueWrite(async () => {
        await store.putFile(r.id, C.File.thumbnail, blob);
        const cur = library.get(r.id); cur.hasThumbnail = true; await library.update(cur);
      }),
      onTick: (m) => {
        $("live-time").textContent = fmt(m.elapsed);
        if (R.bubble) R.bubble.setState({ phase: R.phase, elapsed: m.elapsed });
        if (R.uploader) $("live-upload").textContent = `${R.uploader.progress.uploaded.length}/${m.segments} parts uploaded`;
      },
      onSourceEnded: () => { if (R.phase === "recording" || R.phase === "paused") stop(); },
      onError: (e) => {
        if (R.phase === "countdown") { R.cancelCountdown = true; R.countdownError = e.message; return; }
        toast("Recording stopped: " + e.message, true); stop();
      },
    },
  });
  R.session = sessionObj;

  const prepare = sessionObj.prepare();
  const live = publisher.beginLive(r);
  setPhase("countdown");
  for (let n = s.countdownSeconds; n >= 1 && !R.cancelCountdown; n--) {
    $("countdown-big").hidden = false; $("countdown-big").textContent = String(n);
    if (R.bubble) R.bubble.countdown(n);
    await sleep(1000);
  }
  $("countdown-big").hidden = true;
  if (R.bubble) R.bubble.countdown(0);
  R.uploader = await live;
  R.liveUpload = !!R.uploader;
  try { await prepare; }
  catch (e) {
    await sessionObj.cancel();
    await discard(r);
    return bail("Couldn't start recording: " + e.message);
  }
  const cur = library.get(r.id);
  cur.width = sessionObj.size.width; cur.height = sessionObj.size.height; cur.captureState = "recording";
  if (!sessionObj.info.audio) cur.transcriptStatus = "none";
  await library.update(cur);
  if (R.cancelCountdown) {
    await sessionObj.cancel();
    await discard(r);
    R.session = null;
    return bail(R.countdownError ? "Couldn't start recording: " + R.countdownError : null);
  }
  sessionObj.begin();
  setPhase("recording");
  $("live-hint").textContent = R.bubble ? "Use the floating bubble to pause or stop while you work in other apps." : "";
  console.info("Recording started", sessionObj.info, `${cur.width}x${cur.height}`, "live", R.liveUpload);
}

function queueWrite(fn) { R.writes = R.writes.then(fn).catch((e) => console.error("Saving segment failed", e)); return R.writes; }

function pauseResume() {
  if (!R.session) return;
  if (R.phase === "recording") { R.session.pause(); setPhase("paused"); }
  else if (R.phase === "paused") { R.session.resume(); setPhase("recording"); }
}

function onBubbleClosed() {
  R.bubble = null;
  // The bubble is no longer on screen: draw the camera into the video from now on.
  if (R.session && (R.phase === "recording" || R.phase === "paused" || R.phase === "countdown") && (R.camStream || R.camEffect)) R.session.setComposite(true);
}

/** Stop: copy the link first (still inside the click), then finish the capture. */
async function stop(nav) {
  if (!R.session || !(R.phase === "recording" || R.phase === "paused")) return;
  const r = library.get(R.recording.id);
  const uploader = R.uploader;
  if (C.automaticCloudAllowed(r) && uploader && settings.copyLinkOnStop) copyText(C.shareURL(r, CLOUD_CONFIG), nav);
  R.stoppedAt = Date.now();
  setPhase("finishing");
  const sessionObj = R.session;
  if (R.bubble) { R.bubble.close(); R.bubble = null; }
  try {
    await sessionObj.stop();
    await R.writes;
    releaseDevices();
    const log = R.log;
    log.ended = true;
    let cur = library.get(r.id);
    cur.captureState = "finalizing"; cur.durationSeconds = Math.round(C.SegmentLog.totalDuration(log) * 1000) / 1000;
    await library.update(cur, { log });
    if (uploader) publisher.finishLive(r.id, uploader, log, R.stoppedAt);
    await publisher.finalizeLocal(r.id, log);
    R.session = null; R.uploader = null;
    if (R.unlock) { R.unlock(); R.unlock = null; }
    setPhase("idle");
    cur = library.get(r.id);
    if (C.isMeeting(cur)) {
      toast("Meeting video saved locally. Sending audio securely for transcription…");
      syncMeetingMetadata(cur);
      processRecording(cur);
    } else {
      if (cur.transcriptStatus === "pending") processRecording(cur);
      if (settings.autoUpload) await publisher.publish(cur, { copyLink: !uploader && settings.copyLinkOnStop });
      else toast("Recording saved in this browser");
    }
  } catch (e) {
    console.error(e);
    R.session = null;
    if (R.unlock) { R.unlock(); R.unlock = null; }
    releaseDevices();
    setPhase("idle");
    toast("Couldn't save recording: " + e.message + " It will be recovered when you reload this page.", true);
  }
}

async function discard(r) {
  const cur = library.get(r.id) || r;
  if (C.mayHaveRemote(cur.upload)) await publisher.delete(cur);
  else await library.remove(cur.id);
}

async function cancel({ confirmFirst = true, keepDevices = false } = {}) {
  if (R.phase === "countdown") { R.cancelCountdown = true; return; }
  if (!R.session || !(R.phase === "recording" || R.phase === "paused")) return;
  if (confirmFirst && R.session.elapsed > 3 && !window.confirm(`Discard this recording? The ${fmt(R.session.elapsed)} you've recorded will be deleted.`)) return;
  setPhase("finishing");
  const sessionObj = R.session, r = R.recording;
  if (!keepDevices && R.bubble) { R.bubble.close(); R.bubble = null; }
  if (keepDevices) { sessionObj.display = null; sessionObj.mic = null; }   // keep streams for the restart
  await sessionObj.cancel();
  await R.writes;
  R.session = null; R.uploader = null;
  if (R.unlock) { R.unlock(); R.unlock = null; }
  await discard(r);
  if (!keepDevices) releaseDevices();
  setPhase("idle");
  toast("Recording discarded");
}

/** Restart: discard and record again with the same screen, camera and mic (no new picker). */
async function restart() {
  if (!R.session) return;
  await cancel({ confirmFirst: false, keepDevices: true });
  await start({ reuse: true });
}

// ---------------------------------------------------------------- shortcuts (page and bubble focus only)

function onShortcut(e, nav) {
  if (!(e.ctrlKey && e.altKey) || e.metaKey) return;
  if (e.code === "KeyR") { e.preventDefault(); if (R.phase === "idle") start(); else if (R.phase === "recording" || R.phase === "paused") stop(nav); else if (R.phase === "countdown") cancel(); }
  else if (e.code === "KeyP") { e.preventDefault(); pauseResume(); }
  else if (e.code === "Backspace") { e.preventDefault(); cancel(); }
}
document.addEventListener("keydown", (e) => onShortcut(e));

// ---------------------------------------------------------------- setup form

async function fillDevices() {
  let devices = [];
  try { devices = await navigator.mediaDevices.enumerateDevices(); } catch {}
  const fill = (sel, kind, saved) => {
    const list = devices.filter((d) => d.kind === kind);
    sel.textContent = "";
    if (!list.length || !list[0].label) {
      const o = document.createElement("option"); o.value = ""; o.textContent = list.length ? "Default (allow access to choose)" : "None found"; sel.appendChild(o);
      return;
    }
    for (const d of list) { const o = document.createElement("option"); o.value = d.deviceId; o.textContent = d.label || d.deviceId; sel.appendChild(o); }
    const pick = pickDevice(list, saved);
    if (pick) sel.value = pick.deviceId;
  };
  fill($("camera"), "videoinput", settings.cameraID);
  fill($("mic"), "audioinput", settings.microphoneID);
}

function bindSettings() {
  const sel = { mode: "mode", background: "cameraBackground", bubble: "bubbleSize", audio: "audio", quality: "quality" };
  for (const [id, key] of Object.entries(sel)) {
    $(id).value = settings[key];
    $(id).addEventListener("change", () => { settings[key] = $(id).value; saveSettings(); refreshForm(); });
  }
  $("fps").value = String(settings.fps);
  $("fps").addEventListener("change", () => { settings.fps = parseInt($("fps").value, 10); saveSettings(); });
  $("countdown").value = String([0, 3, 5].includes(settings.countdownSeconds) ? settings.countdownSeconds : 3);
  $("countdown").addEventListener("change", () => { settings.countdownSeconds = parseInt($("countdown").value, 10); saveSettings(); });
  const checks = { "camera-on": "cameraEnabled", "auto-upload": "autoUpload", "copy-on-stop": "copyLinkOnStop", "upload-mp4": "uploadMP4" };
  for (const [id, key] of Object.entries(checks)) {
    $(id).checked = settings[key];
    $(id).addEventListener("change", () => { settings[key] = $(id).checked; saveSettings(); refreshForm(); });
  }
  $("camera").addEventListener("change", () => { settings.cameraID = $("camera").value || null; saveSettings(); });
  $("mic").addEventListener("change", () => { settings.microphoneID = $("mic").value || null; saveSettings(); });
  $("bg-image").addEventListener("change", async () => {
    const f = $("bg-image").files[0];
    if (!f) return;
    await store.putFile("settings", "background", f);
    bgImageCache = undefined;
    toast("Background image saved");
  });
  $("start").addEventListener("click", () => start());
  $("pause").addEventListener("click", () => pauseResume());
  $("stop").addEventListener("click", () => stop());
  $("cancel").addEventListener("click", () => cancel());
  $("restart").addEventListener("click", () => restart());
  navigator.mediaDevices && navigator.mediaDevices.addEventListener && navigator.mediaDevices.addEventListener("devicechange", fillDevices);
  refreshForm();
}
function refreshForm() {
  const mode = captureMode();
  const camOn = mode === "camera" || settings.cameraEnabled;
  $("camera").disabled = !camOn; $("background").disabled = !camOn || !effectsSupported(); $("bubble").disabled = mode === "camera" || !settings.cameraEnabled;
  $("bg-image-row").hidden = settings.cameraBackground !== "image";
  $("mic").disabled = !C.usesMic(settings.audio);
  $("copy-on-stop").disabled = $("upload-mp4").disabled = !settings.autoUpload;
  if (camOn && settings.cameraBackground !== "none" && effectsSupported()) preloadEffects();
}

// ---------------------------------------------------------------- library list

const thumbURLs = new Map();
async function thumbURL(r) {
  if (thumbURLs.has(r.id)) return thumbURLs.get(r.id);
  const b = r.hasThumbnail ? await store.getFile(r.id, C.File.thumbnail).catch(() => null) : null;
  const u = b ? URL.createObjectURL(b) : null;
  thumbURLs.set(r.id, u);
  return u;
}
function statusText(r) {
  if (r.captureState === "recording" && R.recording && R.recording.id === r.id && R.phase !== "idle") return "Recording…";
  if (r.captureState === "recording" || r.captureState === "finalizing") return "Interrupted · will be recovered";
  if (r.upload === "uploaded") return "Shared" + (r.access.key ? " · password" : "") + (r.access.expiresAt ? " · expires " + r.access.expiresAt.toLocaleString() : "");
  if (r.upload === "localOnly") return user ? "In this browser only" : "In this browser only · sign in to share";
  return C.uploadStateLabel(r.upload);
}

let renderPending = false;
function renderList() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(async () => {
    renderPending = false;
    const generation = authGeneration;
    const list = $("list"), items = library.list().filter(visibleToCurrentAccount);
    $("empty").hidden = items.length > 0;
    const frag = document.createDocumentFragment();
    for (const r of items) frag.appendChild(await renderItem(r));
    if (generation !== authGeneration) return;
    list.textContent = "";
    list.appendChild(frag);
  });
}
async function renderItem(r) {
  const li = document.createElement("li"); li.className = "rec-item"; li.dataset.id = r.id;
  const u = await thumbURL(r);
  if (u) { const img = document.createElement("img"); img.src = u; img.alt = ""; li.appendChild(img); }
  else { const d = document.createElement("div"); d.className = "noimg"; li.appendChild(d); }
  const body = document.createElement("div");
  const title = document.createElement("button"); title.className = "rec-title"; title.textContent = r.title; title.title = "Rename";
  title.addEventListener("click", async () => {
    if (!visibleToCurrentAccount(r)) return;
    const t = window.prompt("Rename recording", r.title);
    if (t != null) await publisher.rename(r, t);
  });
  const meta = document.createElement("div"); meta.className = "rec-meta";
  const bits = [r.createdAt.toLocaleString(), fmt(r.durationSeconds), statusText(r)];
  if (r.viewCount != null) bits.push(r.viewCount + (r.viewCount === 1 ? " view" : " views"));
  if (r.trim) bits.push(`trimmed ${fmt(r.trim.start)}–${fmt(r.trim.end)}`);
  meta.textContent = bits.join(" · ");
  if (typeof r.upload === "object") meta.classList.add("status-failed");
  body.append(title, meta);
  const p = library.progress.get(r.id);
  if (p != null) { const bar = document.createElement("div"); bar.className = "progress"; const f = document.createElement("div"); f.style.width = Math.round(p * 100) + "%"; bar.appendChild(f); body.appendChild(bar); }
  const actions = document.createElement("div"); actions.className = "rec-actions";
  const btn = (label, fn, cls) => { const b = document.createElement("button"); b.type = "button"; b.textContent = label; if (cls) b.className = cls; b.addEventListener("click", () => { if (visibleToCurrentAccount(r)) fn(); }); actions.appendChild(b); return b; };
  const remote = C.isMeeting(r) ? r.upload === "uploaded" : r.upload === "uploaded" || r.playback.hls || r.playback.mp4;
  const busy = r.captureState === "recording" || r.captureState === "finalizing";
  if (remote) {
    btn("Copy link", () => copyText(C.shareURL(r, CLOUD_CONFIG)), "primary");
    btn("Open", () => window.open(C.shareURL(r, CLOUD_CONFIG), "_blank", "noopener"));
  }
  if (!busy && C.isMeeting(r)) {
    bits.push("Transcript: " + r.transcriptStatus);
    meta.textContent = bits.join(" · ");
    btn("Meeting notes", () => openMeetingNotes(r));
  }
  if (!busy && !C.isMeeting(r) && !r.localImport) {
    bits.push(transcriptionProgress.get(r.id) || "Transcript: " + r.transcriptStatus);
    meta.textContent = bits.join(" · ");
    if (r.transcriptStatus === "ready") btn("Transcript", () => downloadTranscript(r.id));
    if (!transcriptionJobs.has(r.id)) btn(r.transcriptStatus === "ready" ? "Transcribe again" : "Transcribe", () => processRecording(r));
  }
  if (!busy) btn("Download", () => download(r));
  if (!busy && r.upload !== "uploaded" && !publisher.uploads.has(r.id)) {
    btn(C.isMeeting(r) ? "Share video…" : r.upload === "localOnly" ? "Upload" : "Retry upload", () => {
      const expectedOwnerUID = user?.uid, generation = authGeneration, meeting = C.isMeeting(r);
      if (!expectedOwnerUID) { toast("Sign in with Google to upload.", true); return; }
      const consentIsCurrent = () => user?.uid === expectedOwnerUID && authGeneration === generation;
      if (meeting && !window.confirm("Upload this meeting video and transcript to Reel sharing? This creates a share link. Sending notes to Notion is separate.")) return;
      if (meeting && !consentIsCurrent()) { toast("The account changed. Confirm sharing again.", true); return; }
      publisher.publish(r, { copyLink: true, allowMeetingShare: meeting,
        expectedOwnerUID: meeting ? expectedOwnerUID : null, consentIsCurrent: meeting ? consentIsCurrent : null });
    });
  }
  if (!busy && r.upload === "uploaded") btn("Sharing…", () => openShare(r));
  if (!busy && !r.localImport) btn("Trim…", () => openTrim(r));
  if (!transcriptionJobs.has(r.id) && !publisher.uploads.has(r.id) && !notionJobs.has(r.id) && !(R.recording && R.recording.id === r.id && R.phase !== "idle")) btn("Delete", async () => {
    if (!window.confirm(`Delete “${r.title}”?${C.isMeeting(r) ? " Local video and its portal entry will be removed; Notion notes remain." : ""}${remote ? " The link will stop working." : ""}`)) return;
    if (await publisher.delete(r)) {
      if (C.isMeeting(r) && r.meeting.ownerUID === user?.uid) removeMeetingMetadata(r).catch(() => toast("Local recording deleted. The portal entry could not be removed yet.", true));
      toast("Deleted");
    }
  });
  body.appendChild(actions);
  li.appendChild(body);
  return li;
}

async function download(r) {
  const b = await store.getFile(r.id, C.File.video);
  if (!visibleToCurrentAccount(r)) return;
  if (!b) { toast("video.mp4 isn't in this browser.", true); return; }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(b);
  a.download = C.attachmentDisposition(r.title).match(/filename="(.*)"/)[1];
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

let importAccount = null;
const importButton = $("import-video"), localVideoFile = $("local-video-file");
importButton.addEventListener("click", () => {
  if (!user) { toast("Sign in to import an MP4.", true); return; }
  importAccount = { uid: user.uid, generation: authGeneration };
  localVideoFile.click();
});
localVideoFile.addEventListener("change", async () => {
  const file = localVideoFile.files[0], account = importAccount;
  localVideoFile.value = "";
  importAccount = null;
  if (!file) return;
  importButton.disabled = true;
  const video = document.createElement("video");
  let url;
  try {
    const current = await session.session();
    if (!current || current.uid !== account?.uid || authGeneration !== account.generation) {
      throw new Error("Your account changed. Choose the file again.");
    }
    if (!file.size || !/\.mp4$/i.test(file.name)) throw new Error("Choose a playable MP4 video.");
    url = URL.createObjectURL(file);
    video.preload = "metadata";
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error("This browser couldn't read that MP4."));
      video.src = url;
    });
    await library.importLocalVideo(file, { durationSeconds: video.duration, width: video.videoWidth, height: video.videoHeight }, current);
    if (current.isCurrent()) toast("Saved in this browser. Use Upload to create a new share.");
  } catch (err) {
    toast(err.message, true);
  } finally {
    video.onloadedmetadata = video.onerror = null;
    video.removeAttribute("src");
    video.load();
    if (url) URL.revokeObjectURL(url);
    importButton.disabled = false;
  }
});


// ---------------------------------------------------------------- local transcription + authenticated meeting Notion delivery
const transcriptionJobs = new Map();
const transcriptionProgress = new Map();
const notionJobs = new Set();
let transcriptionQueue = Promise.resolve();
let notesRecordingID = null;
const MEETING_SERVICE = CLOUD_CONFIG.meetingServiceURL;
const SPEECH_SERVICE = CLOUD_CONFIG.speechServiceURL;
const DELIVERY_SERVICE = CLOUD_CONFIG.deliveryServiceURL;
const deliveryCalendarEvents = new Map();
let deliveryInvitesRequest = 0;

const portalJobs = new Map();
function syncMeetingMetadata(recording) {
  const id = recording.id;
  const task = (portalJobs.get(id) || Promise.resolve()).catch(() => {}).then(async () => {
    const r = library.get(id);
    if (!r || !C.isMeeting(r) || !r.meeting.ownerUID || r.meeting.ownerUID !== user?.uid) return;
    const current = await session.session();
    if (!current || current.uid !== r.meeting.ownerUID) return;
    try {
      const token = await current.getIdToken();
      if (user?.uid !== r.meeting.ownerUID) return;
      const response = await fetch(MEETING_SERVICE + "/meetings", { method: "POST", headers: {
        "Authorization": "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ id: r.id, title: r.title, started_at: r.createdAt.toISOString(), duration_seconds: r.durationSeconds,
          transcript_status: r.transcriptStatus, recording_source: "browser",
          ...(!r.recordingNonce || r.recordingOwnerUID ? { share_id: r.shareID } : {}) }), signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error("Portal sync failed");
      await store.updateRow(id, { portalSynced: true });
    } catch { await store.updateRow(id, { portalSynced: false }); }
  });
  portalJobs.set(id, task);
  task.finally(() => { if (portalJobs.get(id) === task) portalJobs.delete(id); });
  return task;
}
async function removeMeetingMetadata(r) {
  await portalJobs.get(r.id);
  const current = await session.session();
  if (!current || current.uid !== r.meeting.ownerUID) return;
  const response = await fetch(MEETING_SERVICE + "/meetings/" + encodeURIComponent(r.id), {
    method: "DELETE", headers: { "Authorization": "Bearer " + await current.getIdToken() }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error("Portal sync failed");
}
function processRecording(recording, { resumeNotes = false } = {}) {
  if (!recording || recording.localImport || !["complete", "recovered"].includes(recording.captureState)) return Promise.resolve();
  if (transcriptionJobs.has(recording.id)) return transcriptionJobs.get(recording.id);
  const id = recording.id;
  const expectedOwnerUID = user?.uid ?? null, expectedGeneration = authGeneration;
  transcriptionProgress.set(id, C.isMeeting(recording) ? "Waiting to send meeting audio securely to OpenAI…" : "Waiting for local transcription…");
  const task = transcriptionQueue.catch(() => {}).then(async () => {
    const run = async () => {
    let r = library.get(id);
    if (!r) { transcriptionJobs.delete(id); transcriptionProgress.delete(id); return; }
    const meeting = C.isMeeting(r);
    r.transcriptStatus = "pending";
    try {
      if (!await library.updateExisting(r)) return;
      if (meeting && (!expectedOwnerUID || r.meeting?.ownerUID !== expectedOwnerUID)) {
        throw new Error("Sign in as the meeting owner to send audio to OpenAI.");
      }
      if (meeting && r.meeting.deliveryStatus) {
        r.meeting.deliveryRetryAt = new Date(Date.now()+300000).toISOString();
        if (!await library.updateExisting(r)) return;
      }
      const blob = resumeNotes ? null : await store.getFile(id, C.File.video);
      const authorize = async () => {
        const currentRow = library.get(id), current = await session.session();
        if (!expectedOwnerUID || publisher.deletions.has(id) || authGeneration !== expectedGeneration || user?.uid !== expectedOwnerUID || !currentRow || !C.isMeeting(currentRow) || currentRow.meeting.ownerUID !== expectedOwnerUID || current?.uid !== expectedOwnerUID || !await store.getRow(id)) {
          throw new Error("Sign in as the meeting owner to send audio to OpenAI.");
        }
        const token = await current.getIdToken();
        const latestRow = library.get(id);
        if (publisher.deletions.has(id) || authGeneration !== expectedGeneration || user?.uid !== expectedOwnerUID || !latestRow || !C.isMeeting(latestRow) || latestRow.meeting.ownerUID !== expectedOwnerUID || !await store.getRow(id)) {
          throw new Error("Sign in as the meeting owner to send audio to OpenAI.");
        }
        return token;
      };
      const result = resumeNotes
        ? JSON.parse(await (await store.getFile(id, C.File.transcriptJSON)).text())
        : meeting ? await transcribeCloudMeeting(blob, { serviceURL: SPEECH_SERVICE, authorize, title: r.title,
          keywords: ["Notion", "Fireflies", "Sybill", ...(r.meeting?.attendees || []).map((email) => email.split("@")[0].replace(/[._+-]/g, " "))], onProgress: (p) => {
          transcriptionProgress.set(id, p.message || "Sending meeting audio securely to OpenAI…");
          if (notesRecordingID === id) $("meeting-notes-status").textContent = transcriptionProgress.get(id);
          renderList();
        } })
        : await transcribeMeeting(blob, { onProgress: (p) => {
        transcriptionProgress.set(id, p.message || "Transcribing locally…");
        if (notesRecordingID === id) $("meeting-notes-status").textContent = transcriptionProgress.get(id);
        renderList();
      } });
      r = library.get(id);
      if (!r) return;
      const transcript = { schemaVersion: 1, id, title: r.title, language: result.language, engine: result.engine,
        createdAt: r.createdAt.toISOString(), durationSeconds: r.durationSeconds, text: result.text, segments: result.segments,
        ...(result.timingGranularity ? { timingGranularity: result.timingGranularity } : {}) };
      if (publisher.deletions.has(id) || (meeting && authGeneration !== expectedGeneration)) return;
      if (!await store.putTranscript(id, new Blob([JSON.stringify(transcript)], { type: "application/json" }),
        new Blob([transcriptText(transcript)], { type: "text/plain" }))) return;
      // Uploading continues during local inference/file writes. Preserve its latest state.
      r = library.get(id);
      if (!r) return;
      r.transcriptStatus = result.segments.length ? "ready" : "none";
      if (meeting && !result.segments.length && r.meeting.deliveryStatus) r.meeting.deliveryStatus = "noSpeech";
      r.summary = meeting ? null : (result.segments.length ? result.summary : null);
      r.summaryEngine = meeting ? null : "extractive";
      if (!await library.updateExisting(r)) return;
      await store.updateRow(id, { [meeting ? "meetingError" : "transcriptionError"]: null });
      if (meeting) {
        syncMeetingMetadata(r);
        let notesReady = false;
        if (result.text) {
          try {
            transcriptionProgress.set(id, "Creating AI meeting notes…");
            if (notesRecordingID === id) $("meeting-notes-status").textContent = transcriptionProgress.get(id);
            const notes = await summarizeCloudMeeting({ serviceURL: SPEECH_SERVICE, authorize, text: result.text, title: r.title, attendees: r.meeting?.attendees || [] });
            r = library.get(id);
            if (r) {
              r.summary = notes.summary || ""; r.summaryEngine = notes.summaryEngine;
              r.actionItems = notes.action_items || [];
              if (!await library.updateExisting(r)) return;
              notesReady = true;
            }
          } catch (summaryError) {
            await store.updateRow(id, { meetingError: "Transcript saved; AI meeting notes failed: " + (summaryError.message || "request failed") });
          }
        }
        toast(!result.segments.length ? "No speech was detected. Meeting video stays local."
          : notesReady ? "Meeting transcript and AI notes are ready. Video stays local."
            : "Meeting transcript is ready; AI notes failed. Video stays local.", !notesReady);
        if (notesReady && r?.meeting.deliveryStatus && r.meeting.deliveryStatus !== "confirmed" && r.meeting.ownerUID === user?.uid) await sendMeetingDelivery(r, {lockHeld:true});
      } else {
        toast(result.segments.length ? "Transcript saved in this browser." : "No speech was detected.");
        await publisher.refreshTranscript(id, expectedOwnerUID);
      }
    } catch (e) {
      r = library.get(id);
      // Delivery errors must not turn a successfully saved local transcript into a failure.
      if (r && r.transcriptStatus === "pending") { r.transcriptStatus = "failed"; if (!await library.updateExisting(r)) return; }
      if (r && meeting) syncMeetingMetadata(r);
      const message = e.message || (meeting ? "Cloud meeting transcription failed. Your video is saved; choose Transcribe to retry." : "Local transcription failed. Your video is saved; choose Transcribe to retry.");
      await store.updateRow(id, { [meeting ? "meetingError" : "transcriptionError"]: message });
      if (r && !meeting && r.transcriptStatus === "failed") {
        await publisher.refreshTranscript(id, expectedOwnerUID).catch(() => {});
      }
      toast(message, true);
    } finally {
      transcriptionJobs.delete(id); transcriptionProgress.delete(id); renderList();
      if (notesRecordingID === id && $("meeting-notes-dialog").open) await refreshMeetingNotes();
    }
    };
    if (!C.isMeeting(recording)) return run();
    return withMeetingLock(id, async () => {
      const latest = await library.refresh(id);
      if (!latest || authGeneration !== expectedGeneration || user?.uid !== expectedOwnerUID) return;
      if (recording.transcriptStatus !== "ready" && latest.transcriptStatus === "ready" && latest.summaryEngine === "OpenAI gpt-6.1-sol" && latest.summary) {
        if (["pending","failed"].includes(latest.meeting?.deliveryStatus)) await sendMeetingDelivery(latest, {lockHeld:true});
        return;
      }
      return run();
    });
  }).finally(() => { transcriptionJobs.delete(id); transcriptionProgress.delete(id); renderList(); });
  transcriptionJobs.set(id, task); transcriptionQueue = task;
  return task;
}
function transcriptText(t) {
  const timingNotice = t.timingGranularity === "chunk" ? "Times are approximate audio-chunk boundaries, not word timestamps.\n\n" : "";
  return t.title + "\n\n" + timingNotice + t.segments.map((s) => `[${fmt(s.start)}] ${s.text}`).join("\n") + "\n";
}
async function downloadTranscript(id) {
  const blob = await store.getFile(id, C.File.transcriptText);
  if (!blob) return;
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "transcript.txt"; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
function meetingAuthorization(id, owner, generation) {
  return async () => {
    const valid = () => {
      const row = library.get(id);
      return authGeneration === generation && user?.uid === owner && !publisher.deletions.has(id) && row?.meeting?.ownerUID === owner;
    };
    if (!valid()) throw new Error("Sign in as the meeting owner to deliver notes.");
    if (!await store.getRow(id)) throw new Error("The recording was deleted.");
    const current = await session.session();
    if (!valid() || current?.uid !== owner) throw new Error("The meeting owner changed.");
    const token = await current.getIdToken();
    if (!valid() || !await store.getRow(id)) throw new Error("The recording or account changed.");
    return token;
  };
}
function withMeetingLock(id, run) {
  if (!navigator.locks) return Promise.reject(new Error("Use a current browser to process meeting notes safely."));
  return navigator.locks.request("reel-meeting-processing:" + id, run);
}
async function sendMeetingDelivery(recording, {lockHeld=false}={}) {
  if (!lockHeld && recording) {
    const generation=authGeneration, owner=recording.meeting?.ownerUID;
    return withMeetingLock(recording.id, async () => {
      const latest=await library.refresh(recording.id);
      if (!latest || generation!==authGeneration || user?.uid!==owner) throw new Error("The recording or account changed.");
      return sendMeetingDelivery(latest,{lockHeld:true});
    });
  }
  let r = recording && library.get(recording.id);
  if (!r || !C.isMeeting(r) || r.transcriptStatus !== "ready" || !r.summary) throw new Error("Finish the transcript and AI meeting notes before delivery.");
  if (!r.meeting.deliveryStatus) throw new Error("Automatic delivery applies to new Reel meetings. Older notes keep their original delivery history.");
  if (notionJobs.has(r.id)) return;
  const owner = r.meeting.ownerUID, generation = authGeneration;
  const authorize = meetingAuthorization(r.id, owner, generation);
  notionJobs.add(r.id);
  try {
    await authorize();
    const blob = await store.getFile(r.id, C.File.transcriptJSON);
    const transcript = JSON.parse(await blob.text());
    r = library.get(r.id);
    if (!r) return;
    r.meeting.deliveryStatus = "pending"; r.meeting.deliveryError = null;
    r.meeting.deliveryRetryAt = new Date(Date.now() + 300000).toISOString();
    r.meeting.deliveryPayload = C.meetingDeliveryPayload(r, transcript);
    if (!await library.updateExisting(r)) return;
    const result = await deliverMeeting({allowedEmailDomain: CLOUD_CONFIG.allowedEmailDomain, serviceURL: DELIVERY_SERVICE, authorize,
      payload: JSON.parse(r.meeting.deliveryPayload)});
    r = library.get(r.id);
    if (!r || authGeneration !== generation || user?.uid !== owner) return;
    r.meeting.deliveryReceipt = result; r.meeting.deliveryStatus = "confirmed";
    r.meeting.deliveryError = null; r.meeting.deliveryRetryAt = null;
    if (!await library.updateExisting(r, {meetingError:null})) return;
    toast("Notes verified in Notion; recap delivered to " + result.recipients.length + " internal invitees.");
    return result;
  } catch (error) {
    r = recording && library.get(recording.id);
    if (r && authGeneration === generation && r.meeting.ownerUID === owner) {
      const needsCalendar = error.code === "calendar_selection_required";
      r.meeting.deliveryStatus = needsCalendar ? "calendarSelectionRequired" : "failed";
      r.meeting.deliveryError = error.message;
      r.meeting.deliveryRetryAt = needsCalendar ? null : new Date(Date.now() + 300000).toISOString();
      await library.updateExisting(r);
    }
    throw error;
  } finally {
    notionJobs.delete(recording.id);
    if (notesRecordingID === recording.id && $("meeting-notes-dialog").open) await refreshMeetingNotes();
  }
}
function resumeMeetingDelivery() {
  if (!user) return;
  for (const r of library.list()) {
    if (!C.isMeeting(r) || r.meeting.ownerUID !== user.uid || !["pending","failed"].includes(r.meeting.deliveryStatus) ||
        !["complete","recovered"].includes(r.captureState) || transcriptionJobs.has(r.id) || notionJobs.has(r.id) ||
        (r.meeting.deliveryRetryAt && new Date(r.meeting.deliveryRetryAt).getTime() > Date.now())) continue;
    if (r.transcriptStatus === "ready" && r.summaryEngine === "OpenAI gpt-6.1-sol" && r.summary) {
      sendMeetingDelivery(r).catch(error => toast(error.message,true));
    } else processRecording(r, {resumeNotes:r.transcriptStatus === "ready"});
  }
}
async function loadDeliveryInvites() {
  const owner = user?.uid, generation = authGeneration;
  const request = ++deliveryInvitesRequest;
  const select = $("meeting-calendar-invite"), status = $("meeting-calendar-status");
  select.replaceChildren(new Option("Manual meeting — private Calls and recap to you", ""));
  deliveryCalendarEvents.clear();
  if (!owner) {status.textContent = "Sign in to choose the calendar invitation for team recaps."; return;}
  const authorize = async () => {
    if (user?.uid !== owner || authGeneration !== generation) throw new Error("Calendar account changed.");
    const current = await session.session();
    if (current?.uid !== owner) throw new Error("Calendar account changed.");
    const token = await current.getIdToken();
    if (user?.uid !== owner || authGeneration !== generation) throw new Error("Calendar account changed.");
    return token;
  };
  try {
    const events = await listDeliveryCalendar({serviceURL:DELIVERY_SERVICE,authorize});
    if (user?.uid !== owner || authGeneration !== generation || deliveryInvitesRequest !== request) return;
    for (const event of events) {
      deliveryCalendarEvents.set(event.id,event);
      select.add(new Option(event.title + " — " + new Date(event.start).toLocaleString(),event.id));
    }
    status.textContent = events.length ? "Choose the invitation to send recaps to its internal invitees." : "No eligible invitations from your selected Google calendars. Manual meetings send a recap only to you.";
  } catch {
    if (user?.uid === owner && authGeneration === generation && deliveryInvitesRequest === request) {
      status.textContent = "Calendar invitations are unavailable. Team delivery requires a verified invitation; manual meetings send a recap only to you.";
    }
  }
}
$("meeting-calendar-invite").onchange = () => {
  const event = deliveryCalendarEvents.get($("meeting-calendar-invite").value);
  if (event) {$("meeting-title").value=event.title;$("meeting-attendees").value=(event.attendees || []).join(", ");}
};
setInterval(resumeMeetingDelivery,60000);
async function openMeetingNotes(r) {
  notesRecordingID = r.id;
  await refreshMeetingNotes();
  $("meeting-notes-dialog").showModal();
}
async function refreshMeetingNotes() {
  const r = library.get(notesRecordingID);
  if (!r) return;
  const row = await store.getRow(r.id);
  const blob = await store.getFile(r.id, C.File.transcriptText);
  $("meeting-notes-title").textContent = r.title;
  $("meeting-notes-status").textContent = transcriptionProgress.get(r.id) || row?.meetingError || ("Transcript: " + r.transcriptStatus);
  $("meeting-summary").textContent = r.summary || "Summary appears after transcription.";
  $("meeting-transcript").textContent = blob ? await blob.text() : "No transcript yet. The video is saved locally; choose Transcribe to retry.";
  const receipt = r.meeting?.deliveryReceipt;
  $("meeting-notion-status").textContent = receipt?.verified ? "Verified in Notion; recap delivered to " + receipt.recipients.join(", ")
    : !r.meeting?.deliveryStatus ? "Older recordings keep their original delivery history. Automatic delivery applies to new meetings."
    : r.meeting.deliveryStatus === "noSpeech" ? "No speech was detected. The video is saved; notes were not sent."
    : r.meeting?.deliveryError || "Meeting delivery has not been confirmed yet.";
  const notionLink = $("meeting-notion-link");
  const safeNotionURL = receipt?.verified && /^https:\/\/(?:www\.notion\.so|notion\.so|app\.notion\.com)\//.test(receipt.url || "");
  notionLink.hidden = !safeNotionURL;
  if (safeNotionURL) notionLink.href = receipt.url;
  $("meeting-retranscribe").disabled = transcriptionJobs.has(r.id);
  $("meeting-send-notion").textContent = "Deliver notes / retry";
  $("meeting-send-notion").disabled = !r.meeting?.deliveryStatus || r.transcriptStatus !== "ready" || !r.summary || notionJobs.has(r.id);
  $("meeting-download-transcript").disabled = !blob;
}
$("meeting-notes-close").onclick = () => $("meeting-notes-dialog").close();
$("meeting-retranscribe").textContent = "Transcribe with OpenAI";
$("meeting-retranscribe").onclick = async () => {
  let r = library.get(notesRecordingID);
  if (!r) return;
  try {
    if (!r.meeting?.ownerUID) {
      const current = await session.session();
      if (!current || current.uid !== user?.uid) throw new Error("Sign in to Reel to transcribe this meeting with OpenAI.");
      await current.getIdToken();
      const latest = library.get(r.id);
      if (!latest || !C.isMeeting(latest) || latest.meeting.ownerUID || current.uid !== user?.uid) throw new Error("The meeting owner changed. Open the meeting again.");
      latest.meeting.ownerUID = current.uid;
      if (!await library.updateExisting(latest)) throw new Error("The meeting is no longer available.");
      r = library.get(latest.id);
      if (!current.isCurrent() || r?.meeting?.ownerUID !== current.uid) throw new Error("The meeting owner changed. Open the meeting again.");
    }
    processRecording(r);
    refreshMeetingNotes();
  } catch (error) { toast(error.message, true); }
};
$("meeting-send-notion").onclick = async () => {
  try { await sendMeetingDelivery(library.get(notesRecordingID)); }
  catch (e) { $("meeting-notion-status").textContent = e.message; toast(e.message, true); }
};
$("meeting-download-transcript").onclick = async () => {
  const blob = await store.getFile(notesRecordingID, C.File.transcriptText);
  if (!blob) return;
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "meeting-transcript.txt"; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
};

// ---------------------------------------------------------------- dialogs

function openShare(r) {
  const d = $("share-dialog");
  $("share-title").textContent = r.title + (r.access.key ? " · password protected" : " · anyone with the link") +
    (r.access.expiresAt ? " · expires " + r.access.expiresAt.toLocaleString() : "");
  $("share-password").value = ""; $("share-remove").checked = false; $("share-remove").disabled = !r.access.key;
  $("share-expiry").value = "keep"; $("share-error").hidden = true;
  d.onclose = async () => {
    if (d.returnValue !== "save" || !visibleToCurrentAccount(r)) return;
    const pw = $("share-password").value;
    const password = $("share-remove").checked ? { remove: true } : pw ? { set: pw } : { keep: true };
    const choice = $("share-expiry").value;
    const expiresAt = choice === "keep" ? r.access.expiresAt : C.expiryDate(choice);
    toast("Updating sharing…");
    const expectedOwnerUID = user?.uid, generation = authGeneration;
    const consentIsCurrent = () => user?.uid === expectedOwnerUID && authGeneration === generation;
    try { await publisher.updateAccess(r, password, expiresAt, { expectedOwnerUID, consentIsCurrent }); toast("Sharing updated"); }
    catch (e) { toast(e.message, true); }
  };
  d.showModal();
}

async function openTrim(r) {
  const d = $("trim-dialog"), v = $("trim-video");
  const b = await store.getFile(r.id, C.File.video);
  if (!b) { toast("video.mp4 isn't in this browser.", true); return; }
  const url = URL.createObjectURL(b);
  v.src = url;
  $("trim-start").value = r.trim ? r.trim.start : 0;
  $("trim-end").value = r.trim ? r.trim.end : r.durationSeconds;
  $("trim-set-start").onclick = () => { $("trim-start").value = v.currentTime.toFixed(1); };
  $("trim-set-end").onclick = () => { $("trim-end").value = v.currentTime.toFixed(1); };
  d.onclose = async () => {
    v.pause(); v.removeAttribute("src"); v.load(); URL.revokeObjectURL(url);
    if (d.returnValue === "save") await publisher.setTrim(r, parseFloat($("trim-start").value), parseFloat($("trim-end").value));
    else if (d.returnValue === "clear") await publisher.setTrim(r, 0, r.durationSeconds);
    else return;
    toast(library.get(r.id).trim ? "Trim saved" : "Trim removed");
  };
  d.showModal();
}

// Preview owns separate short-lived streams; never keep them during capture.
const preview = createPreview({ video: $("preview"), meter: $("mic-meter"), button: $("preview-toggle"), status: $("preview-status"), getSettings: () => ({ ...settings, mode: captureMode() }), onDevices: fillDevices });
for (const id of ["mode", "camera", "mic", "audio", "camera-on"]) $(id).addEventListener("change", () => preview.stop());
window.addEventListener("pagehide", () => preview.stop());
document.addEventListener("visibilitychange", () => { if (document.hidden) preview.stop(); });

// ---------------------------------------------------------------- boot

async function boot() {
  if (!captureSupported()) { $("unsupported").hidden = false; $("start").disabled = true; }
  bindSettings();
  library.addEventListener("change", renderList);
  libraryReady = library.load();
  initAuth();
  await libraryReady;
  fillDevices();
  await authReadyPromise;
  await publisher.recover();
  // Resume uploads a closed tab left unfinished.
  const resumable = library.list().filter(r => !r.localImport);
  for (const r of resumable) {
    if ((r.upload === "uploading" || r.upload === "pending") && (r.captureState === "complete" || r.captureState === "recovered") && settings.autoUpload && user && C.automaticCloudAllowed(r)) publisher.publish(r);
  }
  for (const r of resumable) if (r.transcriptStatus === "pending" && ["complete", "recovered"].includes(r.captureState)) processRecording(r);
  resumeMeetingDelivery();
  for (const r of resumable.slice(0, 20)) publisher.refreshViews(r).catch(() => {});
}
function updateRecordingKind() {
  const meeting = isMeeting();
  const tab = isTabCapture();
  $("ordinary-settings").hidden = meeting;
  $("meeting-setup").hidden = !meeting;
  $("mode-setting").hidden = tab;
  $("recording-intro").hidden = tab;
  $("tab-intro").hidden = !tab;
  $("recording-heading").textContent = meeting ? "Record a meeting" : tab ? "Record a browser tab" : "New recording";
  $("start").textContent = meeting ? "Start meeting recording" : tab ? "Choose a tab" : "Start recording";
  $("last").hidden = meeting || !$("last-link").textContent;
  if (meeting) loadDeliveryInvites();
}
$("recording-kind").addEventListener("change", () => {
  preview.stop();
  updateRecordingKind();
  refreshForm();
});
window.addEventListener("beforeunload", (e) => {
  if (R.phase === "recording" || R.phase === "paused" || R.phase === "finishing" || publisher.uploads.size || transcriptionJobs.size) { e.preventDefault(); e.returnValue = ""; }
});
if (query.get("mode") === "meeting") $("recording-kind").value = "meeting";
updateRecordingKind();
boot();
console.info(APP, EMU ? "(emulators)" : "");

let meetingCalendar;
function openMeetingEntry() {
  const fragmentRequest = /(?:^#|&)(?:meeting-request|calendar-meeting)=/.test(location.hash);
  if (!fragmentRequest && query.get("mode") !== "meeting") return;
  if (meetingCalendar) return;
  $("recording-kind-label").hidden = false;
  meetingCalendar = mountMeetingCalendar({
    container: $("meeting-calendar-panel"), session: () => session.session(),
    onSelectionChange: () => { if ($("recording-kind").value === "meeting") loadDeliveryInvites(); },
  });
}
window.addEventListener("hashchange", openMeetingEntry);
openMeetingEntry();

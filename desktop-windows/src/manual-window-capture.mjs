import { randomUUID } from 'node:crypto';
import { captureWindowPreview } from './capture-window-preview.mjs';

const check = (condition, message) => { if (!condition) throw Error(message); };
const WINDOW_SOURCE = /^window:([1-9][0-9]{0,19}):[01]$/;

/** Main-process-only picker and capture controller for a user-selected window. */
export function createManualWindowCapture({ desktopCapturer, recorder, getProfile, getExcludedWindowHandles = () => [], onState = () => {} } = {}) {
  check(typeof desktopCapturer?.getSources === 'function' && typeof recorder?.start === 'function'
    && typeof recorder?.stop === 'function' && typeof getProfile === 'function', 'Manual window capture is unavailable.');
  let choices = new Map(), catalogOwner = null, active = null, pendingStart = null, pendingStop = null,
    pendingStopOwner = null, state = { phase: 'idle' };
  const publish = value => { state = value; try { onState(state); } catch {} };
  function owner(expected) {
    check(typeof expected === 'string' && expected && getProfile()?.userID === expected,
      'Sign in to Reel to capture a window.');
  }
  function current(capture) { return getProfile()?.userID === capture.ownerUserID; }
  async function list(ownerUserID) {
    owner(ownerUserID);
    check(!isActive(), 'Stop the current recording before choosing another window.');
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 192, height: 120 } });
    owner(ownerUserID);
    choices = new Map(); catalogOwner = ownerUserID;
    const excluded = new Set(getExcludedWindowHandles().map(String));
    const options = [];
    for (const source of sources) {
      const match = WINDOW_SOURCE.exec(source?.id ?? '');
      if (!match || excluded.has(match[1])) continue;
      const id = randomUUID();
      const title = String(source.name ?? '').trim().slice(0, 160) || 'Untitled window';
      const preview = captureWindowPreview(source);
      choices.set(id, { sourceID: source.id, title, sourceName: String(source.name ?? ''), ownerUserID });
      options.push({ id, title, ...(preview ? { preview } : {}) });
    }
    publish({ phase: state.phase, ownerUserID, sources: options });
    return options;
  }
  async function runStart({ ownerUserID, sourceID, consentConfirmed, includeMicrophone = false, highlightClicks = true } = {}) {
    owner(ownerUserID);
    check(consentConfirmed === true, 'Confirm that you have permission to record this window.');
    check(!isActive(), 'A window recording is already active.');
    check(typeof includeMicrophone === 'boolean', 'Choose whether to include the microphone.');
    check(typeof highlightClicks === 'boolean', 'Choose whether to highlight clicks.');
    const selected = choices.get(sourceID);
    choices.clear();
    publish({ phase: state.phase, ownerUserID, sources: [] });
    check(selected && selected.ownerUserID === ownerUserID && catalogOwner === ownerUserID, 'Refresh the window list and choose a window.');
    const capture = { ownerUserID, controller: new AbortController(), handle: null, title: selected.title };
    active = capture;
    publish({ phase: 'starting', ownerUserID, title: capture.title });
    try {
      const matches = (await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } }))
        .filter(source => source?.id === selected.sourceID && String(source.name ?? '') === selected.sourceName);
      check(active === capture && current(capture), 'The account changed while the window was being selected.');
      check(matches.length === 1, 'That window is no longer available. Refresh the window list.');
      const match = WINDOW_SOURCE.exec(matches[0].id);
      check(match, 'That window cannot be captured.');
      const handle = await recorder.start({
        ownerUserID, hwnd: match[1], manual: true, title: capture.title, sourceName: selected.sourceName, meeting: { manual: true },
        systemAudio: true, microphone: includeMicrophone, highlightClicks, signal: capture.controller.signal,
      });
      if (active !== capture || !current(capture)) {
        try { await recorder.stop(handle); } catch {}
        throw Error('The account changed while the recording was starting.');
      }
      capture.handle = handle;
      publish({ phase: 'capturing', ownerUserID, title: capture.title });
      return true;
    } catch (error) {
      if (active === capture) {
        active = null;
        publish({ phase: 'failed', ownerUserID, message: 'The window recording could not start.' });
      }
      throw error;
    }
  }
  function start(args) {
    const operation = runStart(args);
    const tracked = operation.finally(() => { if (pendingStart === tracked) pendingStart = null; });
    pendingStart = tracked;
    return tracked;
  }
  async function setPaused(ownerUserID, paused) {
    owner(ownerUserID);
    const capture = active;
    check(capture?.handle && capture.ownerUserID === ownerUserID && !capture.changingPause &&
      state.phase === (paused ? 'capturing' : 'paused'), 'The recording state changed.');
    capture.changingPause = true;
    try {
      await recorder.setPaused(capture.handle, paused);
      if (capture === active && current(capture))
        publish({ phase: paused ? 'paused' : 'capturing', ownerUserID, title: capture.title });
    } finally { capture.changingPause = false; }
  }
  async function stop(ownerUserID) {
    if (pendingStop) {
      check(ownerUserID === pendingStopOwner, 'The recording belongs to another signed-in account.');
      return pendingStop;
    }
    const capture = active;
    if (!capture) return false;
    check(ownerUserID === capture.ownerUserID, 'The recording belongs to another signed-in account.');
    if (!capture.handle) {
      capture.controller.abort();
      active = null;
      publish({ phase: 'cancelled', ownerUserID: capture.ownerUserID });
      return true;
    }
    active = null;
    publish({ phase: 'saving', ownerUserID, title: capture.title });
    const operation = (async()=>{
      try {
        await recorder.stop(capture.handle);
        capture.controller.abort();
        publish({ phase: 'completed', ownerUserID, title: capture.title });
        return true;
      } catch (error) {
        capture.controller.abort();
        publish({ phase: 'failed', ownerUserID, message: 'The window recording could not be saved.' });
        throw error;
      }
    })();
    const tracked = operation.finally(() => { if (pendingStop === tracked) { pendingStop = null; pendingStopOwner = null; } });
    pendingStop = tracked; pendingStopOwner = ownerUserID;
    return tracked;
  }
  function clearCatalog() { choices.clear(); catalogOwner = null; publish({ phase: state.phase }); }
  async function dispose() {
    if (active) await stop(active.ownerUserID).catch(()=>{});
    await Promise.allSettled([pendingStart,pendingStop].filter(Boolean));
  }
  function isActive() { return !!(active || pendingStart || pendingStop); }
  return { list, start, stop, setPaused, dispose, clearCatalog, state: () => structuredClone(state), isActive };
}

(() => {
  const { isRecordPage, isRecorderPage, recordURL } = globalThis.ReelExtension;
  const recorderActions = new Set(['active', 'open', 'stop', 'pause', 'cancel']);
  chrome.runtime.onMessage?.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'REEL_RECORDER_SHORTCUT' ||
        !recorderActions.has(message.action) || !isRecorderPage(location.href, recordURL)) return false;
    const command = new CustomEvent('reel-recorder-shortcut', { detail: message.action, cancelable: true });
    sendResponse(!document.dispatchEvent(command));
    return false;
  });
  window.addEventListener('message', event => {
    if (!recordURL || event.source !== window || event.origin !== recordURL.origin) return;
    if (!isRecordPage(location.href, recordURL)) return;
    const data = event.data;
    if (!data || data.type !== 'REEL_MEETING_SCHEDULE' || !Array.isArray(data.events)) return;
    const events = data.events.slice(0, 100).map(event => ({
      id: event?.id,
      title: event?.title,
      start: event?.start,
      end: event?.end,
      status: event?.status,
    }));
    chrome.runtime.sendMessage({
      type: 'REEL_MEETING_SCHEDULE',
      uid: typeof data.uid === 'string' ? data.uid : null,
      consent_mode: data.consent_mode,
      events,
    });
  });
})();

(() => {
  const { isRecordPage, recordURL } = globalThis.ReelExtension;
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

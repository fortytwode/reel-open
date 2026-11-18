(() => {
  const { recordURL } = globalThis.ReelExtension;
  if (!recordURL) return;
  const { parseMeetingURL, shouldPrompt } = globalThis.MeetingParser;
  let meeting = parseMeetingURL(location.href);
  if (!meeting) return;

  let dismissedKey = '';
  function updateOccurrence(url) {
    meeting = parseMeetingURL(url);
    const parsed = new URL(url);
    dismissedKey = `reel-meeting-seen:${parsed.origin}${parsed.pathname}${parsed.search}`;
  }
  updateOccurrence(location.href);
  const promptId = 'reel-meeting-prompt';
  let timer = 0;

  // These controls only indicate an active call. Join/preview screens do not match.
  function activelyJoined() {
    const labels = [...document.querySelectorAll('button,[role="button"],[aria-label]')]
      .filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')
      .map(el => `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.textContent || ''}`)
      .join(' ').toLowerCase();
    return /\b(leave call|leave meeting|end call|hang up)\b/.test(labels);
  }

  function addPrompt() {
    if (!shouldPrompt(meeting, { activelyJoined: activelyJoined() })) { document.getElementById(promptId)?.remove(); return; }
    if (!meeting || sessionStorage.getItem(dismissedKey) || document.getElementById(promptId)) return;
    const banner = document.createElement('aside');
    banner.id = promptId;
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Reel meeting prompt');
    banner.style.cssText = 'position:fixed;z-index:2147483647;right:20px;bottom:20px;max-width:360px;padding:14px 16px;background:#202124;color:#fff;border:1px solid #5f6368;border-radius:12px;box-shadow:0 4px 18px #0005;font:14px/1.4 system-ui,sans-serif;';
    const text = document.createElement('span');
    text.textContent = 'Meeting detected. Allow Reel to join?';
    text.style.cssText = 'display:block;margin-bottom:10px;';
    const buttonStyle = 'border:0;border-radius:7px;padding:7px 12px;margin-right:8px;cursor:pointer;font:inherit;';
    const allow = document.createElement('button');
    allow.textContent = 'Allow';
    allow.style.cssText = `${buttonStyle}background:#8ab4f8;color:#202124;`;
    allow.addEventListener('click', () => {
      // Pass the exact accepted URL, including a provider's valid query/passcode.
      sessionStorage.setItem(dismissedKey, '1');
      const request = encodeURIComponent(JSON.stringify({ provider: meeting.provider, url: meeting.url }));
      window.open(`${recordURL.href}#meeting-request=${request}`, '_blank', 'noopener');
      banner.remove();
    });
    const later = document.createElement('button');
    later.textContent = 'Not now';
    later.style.cssText = `${buttonStyle}background:#3c4043;color:#fff;`;
    later.addEventListener('click', () => {
      sessionStorage.setItem(dismissedKey, '1');
      banner.remove();
    });
    banner.append(text, allow, later);
    document.documentElement.append(banner);
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => { timer = 0; addPrompt(); }, 400);
  }
  schedule();
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label', 'title'] });
  // SPA navigation: only re-evaluate on this tab and only for supported meeting URLs.
  let lastURL = location.href;
  setInterval(() => {
    if (location.href === lastURL) return;
    lastURL = location.href;
    updateOccurrence(lastURL);
    if (!meeting) { document.getElementById(promptId)?.remove(); return; }
    schedule();
  }, 1000);
})();

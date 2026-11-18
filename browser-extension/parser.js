(() => {
// Pure URL parsing so provider allowlisting can be tested without a browser.
function parseMeetingURL(input) {
  let url;
  try { url = new URL(input); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hash) return null;
  const host = url.hostname.toLowerCase();

  if (host === 'meet.google.com') {
    const match = url.pathname.match(/^(?:\/meet)?\/([a-z]{3}-[a-z]{4}-[a-z]{3})\/?$/i);
    if (!match) return null;
    // Meet's current UI route aliases the canonical direct meeting URL.
    url.pathname = `/${match[1]}`;
    return { provider: 'google-meet', url: url.href };
  }
  if (host === 'zoom.us' || host.endsWith('.zoom.us')) {
    const zoomJoin = /^\/j\/\d{9,11}\/?$/;
    const zoomWebJoin = /^\/wc\/\d{9,11}\/join\/?$/;
    return zoomJoin.test(url.pathname) || zoomWebJoin.test(url.pathname)
      ? { provider: 'zoom', url: url.href } : null;
  }
  if (host === 'teams.microsoft.com') {
    return /^\/l\/meetup-join\/[A-Za-z0-9%._~-]+\/\d+\/?$/.test(url.pathname) ||
      /^\/meet\/\d+\/?$/.test(url.pathname)
      ? { provider: 'teams', url: url.href } : null;
  }
  if (host === 'teams.live.com') {
    return /^\/meet\/\d+\/?$/.test(url.pathname)
      ? { provider: 'teams', url: url.href } : null;
  }
  return null;
}

function shouldPrompt(meeting, evidence) {
  return Boolean(meeting && !evidence?.activelyJoined);
}

const api = { parseMeetingURL, shouldPrompt };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.MeetingParser = api;

})();

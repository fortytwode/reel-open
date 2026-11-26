(() => {
  function recordPage(manifest) {
    let webBase;
    try { webBase = new URL(manifest?.homepage_url); } catch { return null; }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(webBase.hostname);
    if (webBase.protocol !== 'https:' && !(loopback && webBase.protocol === 'http:')) return null;
    if (webBase.username || webBase.password || webBase.pathname !== '/' || webBase.search || webBase.hash) return null;
    return new URL('/record', webBase);
  }

  function isRecordPage(value, recordURL) {
    if (!recordURL) return false;
    let url;
    try { url = new URL(value); } catch { return false; }
    return url.origin === recordURL.origin && ['/record', '/record.html', '/notetaker', '/notetaker.html'].includes(url.pathname);
  }

  function isRecorderPage(value, recordURL) {
    if (!isRecordPage(value, recordURL)) return false;
    const url = new URL(value);
    return ['/record', '/record.html'].includes(url.pathname);
  }

  const api = { recordPage, isRecordPage, isRecorderPage };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.ReelExtension = { ...api, recordURL: recordPage(globalThis.chrome?.runtime?.getManifest?.()) };
})();

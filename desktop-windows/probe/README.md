# Windows desktop capture bridge probe

This disposable test checks whether Electron can capture one known Windows
window and synthetic system sound through Reel's exact-source capture path. It
creates a magenta/green fixture with a 440 Hz tone and a sandboxed recorder. It
opens no account, calendar, meeting or production URL, and it never requests a
microphone or camera.

The main process matches `desktopCapturer`'s `window:<HWND>:<suffix>` source ID
to the exact fixture HWND. A missing or duplicate match fails closed. The
standalone probe receipt at `docs/evidence/windows-capture-20261106.json` records
13.53 seconds of capture with Electron `getUserMedia()` and the exact
`chromeMediaSourceId`, across four H.264/AAC fragments. Independent decode
checks found checkerboard frames at 2 and 11 seconds and the 440 Hz tone at 1
and 10 seconds. The unknown-HWND and no-capture controls passed.

The probe also attempted `getDisplayMedia()`, which failed with
`AbortError: Invalid capture constraints`; the display-media request handler
did not grant it. The proven capture path is only exact-source `getUserMedia()`;
do not describe the failed `getDisplayMedia()` attempt as a successful capture
or permission grant. The fixture recording was saved locally under a
SHA-256 synthetic-owner directory and was not uploaded.

On a Windows desktop with Node 22, ffmpeg and a working audio output:

```powershell
cd desktop-windows/probe
npm ci
npm test
npm run probe -- --invalid-source
npm run probe -- --no-capture # expected nonzero exit
npm run probe
npm run verify
```

The standalone probe writes a private owner-scoped MP4 (capped at 20 MiB) and
`out/result.json`, which records its generated path. `verify.mjs` checks the
MP4's H.264 and AAC streams, fixture pixels in a decoded frame, and the 440 Hz
tone in decoded audio. The production adapter in
`desktop-windows/src/recorder.mjs` also passed the full interactive local CI
run: it saved a hidden, exact-window 13.333-second recording across four
fragments (258,204 bytes), passed startup-abort/unknown-window/no-capture
controls, and passed decoded early/late video/audio checks plus full-file
ffmpeg decode. See `docs/evidence/windows-adapter-ci-20261106.json`. This uses a
synthetic fixture; real meeting-provider entry, consent, authentication and
Calendar behavior remain unverified.

This probe does not test joining Google Meet, Zoom or Teams, consent, owner
identity, production sign-in, Calendar discovery, or release packaging. Windows
system loopback may include other audible system sound and is not confined to
the selected window. No production release or real-meeting capture claim follows
from this synthetic fixture.

API basis: [Electron session media handler](https://www.electronjs.org/docs/latest/api/session),
[desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer),
[source ID format](https://www.electronjs.org/docs/latest/api/structures/desktop-capturer-source),
and [Electron 45 window-source change](https://www.electronjs.org/blog/electron-45-0).

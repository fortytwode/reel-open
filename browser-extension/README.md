# Reel Meeting Prompt (unpacked extension)

This small Manifest V3 extension adds a prompt on supported Google Meet, Zoom web, and Microsoft Teams meeting URLs. It does not join, capture, record, or inspect other tabs. Choosing **Allow** opens Reel's record page in a new tab and passes the meeting URL in the URL fragment; Reel is responsible for authentication and participant-consent confirmation before any bot launch.

When signed in to Reel in the browser, the record page can relay a bounded list of calendar event metadata to the extension. In **ask before each meeting** mode, the extension schedules a desktop notification for scheduled or awaiting-consent events. Choosing **Allow** opens Reel's participant-consent screen for that event; the notification never approves or launches a bot. **Not now** dismisses the notification. If the browser is asleep at the meeting start, an alert can appear after it wakes while the event is still in progress. The extension does not claim an immediate alert while the computer is asleep. Calendar metadata is held locally for the signed-in account and cleared when the account changes or signs out.

## Install for manual testing

1. From the repository root, run `python3 scripts/configure-organization.py organization.local.json`. The generated extension is in `.reel/browser-extension` and uses the configured `webBase` for the record page.
2. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
3. Turn on **Developer mode**.
4. Choose **Load unpacked** and select `.reel/browser-extension`.
5. Open a supported meeting URL. The prompt can appear before joining and disappears if the page exposes an active-call control.
6. Remove the extension from the browser's extensions page when finished.

Loading the source `browser-extension` folder also works for development. Until you load a configured copy, the extension suppresses meeting prompts and calendar alerts.

This is an unpacked development extension. It is not installed automatically and has not been published to a browser store. Browser/provider page changes may affect the active-call heuristic. Meeting formats outside the explicit URL allowlist are ignored. A user can dismiss the prompt for that meeting URL for the current tab session.

Run parser, alert-manager, and mocked browser checks with `npm test` from this directory. If Playwright is not available at the adjacent repository path, set `REEL_PLAYWRIGHT_MODULE` to its `index.mjs` file.

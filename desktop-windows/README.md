# Windows meeting companion

The experimental Windows companion uses Electron for account setup, calendar discovery and recording. A native Windows helper identifies the exact meeting window in Chrome. Recordings stay on the signed-in owner’s computer until they choose **Share recording**. Sharing uploads the video and copies a link that anyone with the link can open. Once the transcript is ready, **Share video and transcript** includes it in the same viewer.

The Windows installer adds three entries to Start. **Reel Recorder** opens your organization’s screen recorder in its own browser app window. Use it to record a walkthrough and share the link. **Reel Notetaker** opens calendar preferences and meeting notes. **Reel Companion** connects Reel to your Google calendar, captures scheduled meetings and lists locally saved recordings. Recorder and Notetaker also support installation from Chrome or Edge.

## Build for Windows

Render your [organization configuration](../docs/organization-configuration.md) from the repository root. Configure a Google Desktop OAuth client for the same organization and enable the Google Calendar API. Build on Windows using the official Electron distribution, the .NET Framework compiler and the parameters in [Packaging](PACKAGING.md). Keep the downloaded Google installed-app credential file outside the repository.

The app performs the account flow in external Chrome and stores user tokens with Electron's Windows credential encryption. Use the Chrome profile with access to the meeting. Google sign-in and Calendar authorization are separate steps from joining a provider meeting. In Reel Companion, choose **Join & record** next to a meeting on the selected calendars to start it yourself, even with automatic joining off. **Cancel join** closes Reel’s dedicated window while it connects. Once capture starts, use **Stop and save recording** to finish early. **Use a meeting link** accepts a direct Google Meet, Zoom or Teams link after you sign in, even without Google Calendar connected. Confirm participant consent for that meeting. Reel sends the recap to your signed-in account only. Turn on **Include my microphone** for a meeting you start yourself to record your voice as well as system sound. The portable builder creates an unsigned ZIP for testing. For distribution, build the MSIX for each architecture, sign it with your trusted Windows publisher identity and publish its App Installer feed. See [Packaging](PACKAGING.md).

To use the default work calendar in **classic Outlook**, open Outlook with the same email account you use for Reel. In Companion, choose **Use work calendar from classic Outlook**, then review your recording permissions. Reel reads upcoming meetings from that calendar while Outlook is open. Recaps for locally captured Outlook meetings go to your signed-in account. Choose **Use Google Calendar** to switch back.

## Run tests

From the repository root:

```sh
npm --prefix desktop-windows test
```

With Java 21 on `PATH`, verify the explicit share path against local Auth,
Firestore and Storage emulators with:

```sh
npm --prefix firebase/tests run meeting-share-emulator
```

The check uses synthetic identities and generated video; it verifies owner
binding, private library access and playback in the local viewer.

For interactive capture checks, install the pinned dependencies with `npm --prefix desktop-windows/probe ci`. On a logged-in Windows desktop with Node, ffmpeg and ffprobe on `PATH`, run:

```powershell
powershell -File desktop-windows/test-local.ps1
```

The runner checks native window selection and captures a known test window. `native/build.cmd` compiles the production helper and runs its policy checks. `native/build-fixture.cmd` builds the localhost variant for tests. Package only the production `ReelNativeJoin.exe`. System loopback can include other audio playing on the Windows machine.

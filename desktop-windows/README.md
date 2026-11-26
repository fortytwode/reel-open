# Windows meeting companion

The experimental Windows companion uses Electron for account setup, calendar discovery and recording. A native Windows helper identifies the exact meeting window in Chrome. Recordings stay on the signed-in owner’s computer until they choose **Share recording**. Sharing uploads the video and copies a link that anyone with the link can open.

The companion opens **Reel Recorder** and **Reel Notetaker** from your organization’s deployment. You can install them separately from Chrome or Edge. Use Recorder for a walkthrough and a share link. Use Notetaker to choose calendars and review meeting notes.

## Build a portable package

Render your [organization configuration](../docs/organization-configuration.md) from the repository root. Configure a Google Desktop OAuth client for the same organization and enable the Google Calendar API. Build on Windows using the official Electron distribution, the .NET Framework compiler and the parameters in [Packaging](PACKAGING.md). Keep the downloaded Google installed-app credential file outside the repository.

The app performs the account flow in external Chrome and stores user tokens with Electron's Windows credential encryption. Use the Chrome profile with access to the meeting. Google sign-in and Calendar authorization are separate steps from joining a provider meeting. Verify your intended provider and architecture on a logged-in Windows desktop before distributing a package. The builder creates an unsigned portable ZIP.

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

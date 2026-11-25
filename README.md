# Reel

Reel contains two products that can be used independently.

- **Reel Recorder** opens a capture toolbar on macOS or in the browser at `/record`. Record a window, screen or camera and share the video link. On the Mac, you can also save clips locally.
- **Reel Notetaker** opens at `/notetaker`. Choose calendars, manage upcoming calls and read participant meeting notes. The web app can be added to the Mac Dock. Configured Google Meet and Teams meetings can run in the cloud while your Mac is closed. Local meeting capture remains available from the Mac companion.

For online features, both products can share a self-hosted deployment and account. Local screen recording is available without an account. A screen recording can be shared by link under its access settings. Meeting notes use the participant access checks in the delivery service.

## Install Reel Recorder for Mac

[Download the signed Mac installer](https://github.com/rocketshiphq/reel-open/releases/latest). Open the disk image and drag **Reel Recorder** to **Applications**. The same download supports Apple silicon and Intel Macs running macOS 15 or later.

The installer saves recordings on your Mac without an account. For share links or online Notetaker features, follow the [self-hosting guide](docs/self-hosting.md). The browser-based Notetaker is available at `/notetaker` on your deployment.

## Run locally

**macOS.** Build with Xcode 26 or newer. Reel runs on macOS 15 or later as a menu bar app. Grant screen recording, camera and microphone permissions when macOS prompts for them.

```sh
./scripts/build-app.sh
open dist/Reel.app
```

**Browser.** After starting the local server, open `http://localhost:8000/record.html` for Recorder or `http://localhost:8000/notetaker.html` for Notetaker. This serves the pages directly. Use the Firebase Hosting configuration for navigation on clean paths such as `/record` and `/notetaker`, or to test installation. Calendar and recap access require a configured organization deployment. For camera blur and virtual backgrounds, first run `python3 scripts/fetch-web-model.py`.

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory web
```

**Windows.** Use the browser recorder, or build the experimental [Windows meeting companion](desktop-windows/README.md) from source.

## Deploy to your organization

Reel Recorder and Reel Notetaker are both open source and can be self-hosted. Each deployment supplies its own email domain, Firebase project, service credentials and desktop app settings.

Use the [self-hosting guide](docs/self-hosting.md) to set up hosting, Google sign-in, recording storage and optional meeting services. Enter your own Firebase and Google Workspace settings in a local copy of [organization.example.json](organization.example.json).

Cloud auto-join supports Google Meet and Teams links on Google Calendar. The deployment’s Google Workspace administrator grants the calendar service account delegated read access. Each verified member then signs in, selects calendars and sets recording consent.

For a self-hosted browser deployment that accepts verified Google accounts across domains, use the isolated [public signup deployment](docs/public-signup.md). The web products support verified Google accounts and Notetaker requests each account's Calendar permission separately.

## Run checks

```sh
swift test
npm --prefix firebase/tests ci
npm --prefix firebase/tests run unit
npm --prefix desktop-windows test
```

The [CI workflow](.github/workflows/open-source-ci.yml) also tests Firebase rules, the browser extension and the Python services with synthetic data. Service-specific instructions are in the [meeting API](meeting-service/README.md), [meeting delivery](delivery-service/README.md) and [cloud worker](meeting-bot/README.md) directories.

## License

Reel source is licensed under the [MIT License](LICENSE). See [Third-party notices](THIRD_PARTY_NOTICES.md) for the browser runtime and its optional model.

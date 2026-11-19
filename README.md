# Reel

Reel contains two products that can be used independently.

- **Reel Recorder** opens a capture toolbar on macOS or in the browser at `/record`. Record a window, screen or camera and share the video link. On the Mac, you can also save clips locally.
- **Reel Notetaker** opens at `/notetaker`. Choose calendars, manage upcoming calls and read participant meeting notes. The web app can be added to the Mac Dock. Configured Google Meet and Teams meetings can run in the cloud while your Mac is closed. Local meeting capture remains available from the Mac companion.

Both products use the same organization deployment and account. A screen recording can be shared by link under its access settings. Meeting notes use the participant access checks in the delivery service.

## Run locally

**macOS.** Build with Xcode 26 or newer. Reel runs on macOS 15 or later as a menu bar app. Grant screen recording, camera and microphone permissions when macOS prompts for them.

```sh
./scripts/build-app.sh
open dist/Reel.app
```

**Browser.** After starting the local server, open `http://localhost:8000/record.html` for Recorder or `http://localhost:8000/notetaker.html` for Notetaker. Calendar and recap access require a configured organization deployment. For camera blur and virtual backgrounds, first run `python3 scripts/fetch-web-model.py`.

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory web
```

**Windows.** Use the browser recorder, or build the experimental [Windows meeting companion](desktop-windows/README.md) from source.

## Deploy to your organization

Anyone can self-host the same Reel code with their own organization domain, accounts, infrastructure and private credentials. No Rocketship account or infrastructure is required. Shared features and fixes belong in this public repository; each deployment supplies its own configuration and chooses when to upgrade.

Use the [self-hosting guide](docs/self-hosting.md) to set up hosting, Google sign-in, recording storage and optional meeting services. Enter your own Firebase and Google Workspace settings in a local copy of [organization.example.json](organization.example.json).

Teams and Google Meet cloud joining can serve every verified account in your configured organization domain. Each person signs in, connects their Google Calendar and chooses their recording consent setting. Downloading the source or desktop app does not provision cloud services or connect a calendar automatically.

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

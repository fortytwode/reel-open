# Reel

Reel records your screen, camera and microphone on macOS and in the browser. Save a recording locally or connect a Firebase deployment to keep an authenticated library and share links. Optional meeting services add calendar discovery, recordings and participant notes.

## Run locally

**macOS.** Build with Xcode 26 or newer. Reel runs on macOS 15 or later as a menu bar app. Grant screen recording, camera and microphone permissions when macOS prompts for them.

```sh
./scripts/build-app.sh
open dist/Reel.app
```

**Browser.** Open `http://localhost:8000/record.html` in Chrome or Edge after starting the local server. For camera blur and virtual backgrounds, first run `python3 scripts/fetch-web-model.py`.

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory web
```

**Windows.** Use the browser recorder, or build the experimental [Windows meeting companion](desktop-windows/README.md) from source.

## Deploy to your organization

Use the [self-hosting guide](docs/self-hosting.md) to set up hosting, Google sign-in, recording storage and optional meeting services. Enter your own Firebase and Google Workspace settings in a local copy of [organization.example.json](organization.example.json).

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

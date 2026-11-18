# Reel cloud meeting worker

A Cloud Run Job task opens a visible browser, requests entry and records the admitted meeting's browser display and received system audio. The meeting API processes the saved audio after the worker reports completion. Keep the calendar route scoped to authorized owners and providers. Verify your meeting policies and host admission with an authorized test account before enabling automatic capture.

## Build and deploy

Build from the `meeting-bot` directory. The worker uses a pinned Playwright image, ffmpeg, PulseAudio and Xvfb.

```sh
docker build -t reel-meeting-bot meeting-bot
```

Deploy a Cloud Run Job with task count 1, parallelism 1, retries 0 and an initial 4 CPU, 8 GiB memory and 14,400-second timeout. Recording artifacts use the job's in-memory filesystem before upload. Set `BOT_CALLBACK_ORIGIN` to the exact HTTPS origin of the meeting API. Give the job identity access only to the private GCS payload and artifact paths it needs. Use uniform bucket-level access and set appropriate retention for the deployment.

The API launches a task by setting `BOT_PAYLOAD_GCS_URI` to a private JSON object of up to 64 KiB. Meeting URLs, passcodes and callback tokens stay in the private payload. An example request is:

```json
{
  "execution_id": "618e8480-0ba5-49f4-a949-941a69fb6b98",
  "owner_id": "Firebase UID",
  "provider": "meet",
  "meeting_url": "https://meet.google.com/abc-defg-hij",
  "display_name": "Reel recorder",
  "consent": {"confirmed": true},
  "callback_url": "https://meetings.example.com/internal/bot/status",
  "callback_token": "A_SERVER_GENERATED_RANDOM_TOKEN_OF_AT_LEAST_32_CHARACTERS",
  "output_bucket": "private-example-bucket",
  "output_prefix": "reel-meetings/bot/FULL_SHA256_OF_UID/EXECUTION_UUID/",
  "max_duration_seconds": 3600,
  "admission_timeout_seconds": 300
}
```

Recording and admission limits are 1–10,800 and 1–900 seconds, respectively. The API supplies explicit consent and observes authenticated status callbacks with execution identity and sequence number. A create-only GCS execution lock prevents duplicate joining. Recording starts after the worker observes admission and stops on provider removal, call end, connection loss, duration limit or termination. The job uploads the fragmented MP4 and mono 16 kHz audio to the private execution prefix. The API processes and delivers notes with the [meeting service](../meeting-service/README.md).

Guest restrictions, provider UI changes, lobby policies and CAPTCHA can prevent entry. The supported cloud pilot scopes in the calendar API are Google Meet and Microsoft Teams. `BOT_DIAGNOSTICS=1` saves viewport snapshots and body text under the private execution's `debug/` prefix for authorized tests. Those files can contain visible meeting information.

The worker attempts to enable native live captions after admission and saves bounded speaker/text observations to `captions.json` under the same private execution prefix. Captions follow the platform's availability and meeting policy. Missing controls, missing names, provider changes or capture limits produce an explicit unavailable or partial result while audio recording continues. Caption names are kept as displayed, including presentation labels; participant tiles and calendar order are never used to guess a speaker. Only ordinary media notices with known text can be dismissed automatically. Admission, security and consent gates remain in force.

## Dedicated Google Meet account

Set the worker's `BOT_GOOGLE_AUTH_STATE_URI` to a private `gs://BUCKET/reel-bot-auth/google/…` JSON object and set `BOT_GOOGLE_ACCOUNT_EMAIL` to the matching, dedicated Workspace account. The object contains `schema_version: 1`, `account_email` and a Playwright `storage_state` with cookies and origins. The worker reads a fixed object generation, restores state and checks a visible matching Google account indicator before requesting entry. Missing, expired or mismatched state stops the run. Protect this state as a credential.

`Dockerfile.google-session` builds a temporary setup service with official Google Chrome and a noVNC viewer. Build it for `linux/amd64` with `BASE_IMAGE` set to the worker image you just built or published. Set `BOT_GOOGLE_SETUP_CONFIG_URI` to a private config object in the same `reel-bot-auth/google/` prefix. The config fields are `account_email`, `output_uri` (a separate `.json` object in that bucket and prefix), `expected_generation` (`0` for creation or the current generation for replacement), and `expires_at` (timezone-aware ISO timestamp no more than 15 minutes ahead).

Run the temporary setup service with IAM authentication required, one instance, instance-based CPU and a 900-second timeout. Access its viewer through `gcloud run services proxy`. Sign in to the dedicated account in the normal Chrome window and quit Chrome to trigger collection. The setup process reopens the isolated profile via Playwright, verifies the expected account and exports only Google state to the private destination with a generation precondition. Delete the temporary setup service and config once the export is complete. Give its identity access only to the config object and the intended output object.

## Local tests

```sh
cd meeting-bot
python3 -m unittest discover -s tests -v
```

With Playwright and Chromium installed, run the caption tests including the browser fixtures with:

```sh
REEL_BROWSER_CAPTION_FIXTURES=1 python3 -m unittest discover -s tests -p test_captions.py -v
```

Run `PYTHONPATH=. python3 tests/browser_meet_controls.py` for the isolated Meet control fixtures.

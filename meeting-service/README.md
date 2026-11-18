# Reel meeting API

The Flask service provides Firebase-authenticated meeting metadata, Calendar discovery and meeting capture scheduling. It also provides transcription and summarization endpoints and can process recordings from a Cloud Run Job.

## Build and configure

From the repository root, stage a committed revision in an empty directory and build its Docker context.

```sh
context=$(mktemp -d)
./meeting-service/build-context.sh HEAD "$context"
docker build -f "$context/meeting-service/Dockerfile" "$context"
```

The image uses the hash-locked dependency file in `delivery-service/requirements.txt`. Load the organization settings from `.reel/backend.env`. `GET /health` is the service health check. The generated `REEL_MEETING_ALLOWED_DOMAIN` grants meeting access to verified Firebase accounts whose exact email domain matches `REEL_ORGANIZATION_DOMAIN`. For a restricted pilot, omit `REEL_MEETING_ALLOWED_DOMAIN` and configure `REEL_ALLOWED_EMAILS` with the allowed comma-separated account addresses. Neither setting accepts a Firebase token from another project. Set `RECEIPT_BUCKET` to a private GCS bucket and `RECEIPT_PREFIX` to its meeting-state prefix. The runtime needs object read, create and replacement on that prefix. `GET /meetings` reads the caller's index, `POST /meetings` updates metadata, and `DELETE /meetings/<id>` removes that user's index entry. Recording media stays in its own storage. The optional `/notion/preview` and `/notion/deliver` routes also use `NOTION_TOKEN` and `NOTION_DEFAULT_DATA_SOURCE_ID` for their configured private Notion destination.

## Calendar and cloud capture

- Set `GOOGLE_CALENDAR_CREDENTIALS` to the path to a secret-mounted Workspace service-account JSON with domain-wide delegation for `calendar.readonly`.
- Set `MEETING_SERVICE_URL`, `INTERNAL_SERVICE_ACCOUNT` and `CALENDAR_TASK_QUEUE`. Schedule authenticated calls to `POST /internal/calendar/sync` using that service account and the service URL as audience. The service uses Cloud Tasks to dispatch due occurrences.
- `MEETING_CAPTURE_PROVIDER=desktop` keeps desktop capture as the default. Configure `BOT_JOB_NAME`, `BOT_BUCKET` and `MEETING_CLOUD_PROVIDERS=google_meet,teams` to enable cloud joining for both providers. Leave `MEETING_CLOUD_OWNER_EMAILS` and `MEETING_GOOGLE_CLOUD_OWNER_EMAILS` unset for organization-wide availability. Those optional lists narrow a pilot to specific accounts. See the [worker instructions](../meeting-bot/README.md).
- Each member signs in, opens the browser recorder's Calendar panel, connects their Google Calendar and selects per-meeting or standing consent. These connections are required even when the desktop app is installed. Cloud calendar discovery currently uses Google Calendar, including Teams links in its invitations; Outlook and Apple Calendar are native desktop connections. The scheduler cycles through all connected owners in bounded pages. It does not enroll accounts or grant consent on their behalf.
- Organization-wide access enforces the configured provider and owner restrictions and requires a current occurrence on a connected calendar in every capture mode. Direct `/transcription` and `/summary` access remains separately controlled by `REEL_SPEECH_ALLOWED_DOMAIN` matching the organization domain or by `REEL_ALLOWED_EMAILS`; cloud processing uses its internal authorized path.
- For cloud post-processing, set `PROCESSING_TASK_QUEUE` to a dedicated queue and supply the [standalone delivery settings](../delivery-service/README.md) and speech provider configuration. Give the service access to the private bot artifact prefix and the delivery receipt prefix. Use a 600-second Cloud Run timeout, concurrency 1 and a processing queue with at least 100 attempts, a 24-hour retry duration and a maximum 300-second backoff to accommodate the 660-second processing lease.

The bot callback binds the audio to its GCS generation before processing. Transcription proceeds in five-minute chunks. Transcripts become available before summarization and delivery. Exact digital silence is skipped. Captures with no usable meeting content or an overlong transcript stay available for review and are held from automatic delivery. Recorded participant consent and provider admission are required before cloud recording.

## Speech endpoints

`POST /transcription` accepts mono PCM16 16 kHz WAV via multipart upload (up to 600 seconds and 20 MiB) and a language code. `POST /summary` accepts up to 200,000 characters of transcript and optional title and attendee data. Audio is held in memory for the request. These routes send meeting content to OpenAI and require `OPENAI_API_KEY` on the server. The client expects `OPENAI_TRANSCRIPTION_MODEL=gpt-transcribe` and `OPENAI_SUMMARY_MODEL=gpt-6.1-sol`.

For a separate speech deployment, set `REEL_SPEECH_ALLOWED_DOMAIN` to the configured organization's domain to allow verified users in that domain on the speech routes. Scope its runtime to the speech API secret. A separate pool with concurrency 1 and a 240-second request timeout keeps speech requests from blocking Calendar operations.

## Local tests

From the root, in a Python environment with the locked dependencies and pytest:

```sh
PYTHONPATH=. python -m pytest meeting-service
```

# Host Reel with public signup

Public signup supports Reel Recorder and Reel Notetaker in the browser. Each person signs in to their own account. Recorder keeps each account's library private and shares individual recordings through share links. Notetaker stores recordings, transcripts and summaries in the recording owner's account. Public mode uses private in-app notes in place of organization delivery integrations.

## Provision a separate deployment

Create a dedicated Firebase project, web origin, Firestore database, recording bucket, private meeting-state bucket, worker artifact bucket and queues. Enable Google sign-in in Firebase Auth and authorize the web origin. The public and organization deployments should have separate databases, credentials and service identities. Use [the general hosting and worker setup](self-hosting.md) for the common resource setup.

Copy `organization.example.json` to a private deployment file, fill in the new project's values and set `"accountAccess": "public"`. You can omit `allowedEmailDomain`. Leave `googleClientID`, `googleDesktopClientId`, `deliveryServiceURL` and `speechServiceURL` empty or omit them. Set `meetingServiceURL` to the public deployment's meeting API origin and include only your HTTPS web origin in `allowedOrigins`. Render the configuration and deploy the generated Firebase rules with the web client. These rules allow verified Google accounts to create UID-bound recordings and access only their own library.

## Set up the Notetaker backend

Build the [meeting API](../meeting-service/README.md#build-and-configure) and [cloud worker](../meeting-bot/README.md#build-and-deploy) from this repository. Load `.reel/backend.env` on the API. In public mode, each user's Calendar OAuth grant supplies Calendar access. Workspace domain-wide delegation and the standalone delivery service are optional for organization deployments and are unnecessary here. Public mode uses private in-app notes, and the cloud processing job handles transcription.

| API setting | Value |
| --- | --- |
| `RECEIPT_BUCKET`, `RECEIPT_PREFIX` | Private meeting-state bucket and prefix. The API runtime needs object read, create and replacement access. |
| `CALENDAR_TASK_QUEUE`, `PROCESSING_TASK_QUEUE` | Full Cloud Tasks queue names of the form `projects/PROJECT/locations/REGION/queues/NAME`. Use separate queues for scheduling and processing. |
| `INTERNAL_SERVICE_ACCOUNT` | Service account email used for authenticated queue and scheduler requests, and private download signatures. |
| `BOT_JOB_NAME`, `BOT_BUCKET` | Fully qualified Cloud Run Job name and private bucket for worker payloads and artifacts. |
| `MEETING_CLOUD_PROVIDERS` | Enable the providers you test with `google_meet`, `teams`, or `google_meet,teams`. |
| `OPENAI_API_KEY` | Server-side key for transcription and summarization. Store it as a runtime secret. Configure `OPENAI_TRANSCRIPTION_MODEL` and `OPENAI_SUMMARY_MODEL` if your account uses models other than the [API defaults](../meeting-service/README.md#speech-endpoints). |

Give the API runtime permission to enqueue tasks as the internal service account, run the worker job with overrides, and read and write its private payloads and artifacts. Give the internal service account read access to the private artifact objects it signs. Enable the IAM Service Account Credentials API and allow the API runtime to sign blobs as that account. See the [worker guide](../meeting-bot/README.md#dedicated-google-meet-account) for configuring a separate Google Meet bot account. Confirm that the host can admit the bot and that participants have given consent.

Run the Cloud Scheduler request to `POST /internal/calendar/sync` regularly with an OIDC token for the internal service account. Use the exact HTTPS meeting API origin as the token audience. For processing, use a 600-second API timeout, concurrency 1 and a retry window of at least 24 hours with at least 100 attempts and a maximum backoff of 300 seconds.

## Authorize Google Calendar

In the public Google Cloud project, enable Google Calendar API and create a Web application OAuth client. Choose an External audience and add the full HTTPS callback URL, `https://YOUR_MEETING_API/calendar/oauth/callback`, under Authorized redirect URIs. Configure the app's branding, privacy policy and verified domains, then submit the Calendar access for Google's required verification before general signup. The requested Calendar permissions are read-only calendar-list and event access. [Google OAuth verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)

Set these values on the meeting API.

| Setting | Value |
| --- | --- |
| `MEETING_SERVICE_URL` | Exact HTTPS origin of the public meeting API |
| `REEL_CALENDAR_OAUTH_CLIENT_ID` | Public deployment's Calendar OAuth Web client ID |
| `REEL_CALENDAR_OAUTH_CLIENT_SECRET` | Calendar OAuth client secret, loaded from Secret Manager |
| `REEL_CALENDAR_OAUTH_REDIRECT_URI` | Exact callback URL registered above |
| `REEL_CALENDAR_OAUTH_ENCRYPTION_KEY` | A Fernet key stored in Secret Manager, kept stable across service revisions |

Generate the key with `python3 -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'` in a private setup environment. Keep the key and the OAuth client secret on the server. Configure lifecycle cleanup for expired transaction objects under the state store's `calendar-oauth/states/` prefix. Keep the current grant objects under `calendar-oauth/grants/` available while users remain connected and limit retention of obsolete object generations.

## Verify before opening signup

Start with Google's OAuth test audience and two unrelated Google accounts. Sign in with each account, connect its Calendar, then choose calendars and explicitly consent to a private test meeting. Verify that only its owner can read the meeting's video, transcript or summary. Switch accounts in the same browser and check that the Recorder library changes to the new account. Test a share link in a signed-out window and disconnect Calendar to confirm that scheduled capture stops and reconnecting requires a new grant. Disconnecting removes Reel's stored grant. Account holders can remove the app from their Google Account's third-party connections to revoke Google-side consent.

Set queue concurrency and service quotas to match the launch budget before the deployment accepts general signup.

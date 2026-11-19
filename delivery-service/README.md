# Reel meeting delivery

`POST /delivery/complete` verifies the caller's Firebase token, binds a recording to its content hash and resolves any supplied calendar occurrence using delegated read-only Google Calendar access. Recaps go to the authoritative internal invitees and organizer. A manual recording goes only to its owner. The standalone provider files transcripts in a private Notion data source and emails the authenticated Reel notes link.

`GET /delivery/calendar` lists exact primary-calendar references from the previous 24 hours through the next seven days. `GET /delivery/meetings` and `GET /delivery/meetings/<id>` read the caller's private note index and check membership against the original verified recipient list.

## Build and configure

From the repository root, stage a committed revision in an empty directory and build its Docker context.

```sh
context=$(mktemp -d)
./delivery-service/build-context.sh HEAD "$context"
docker build -f "$context/delivery-service/Dockerfile" "$context"
```

The image installs dependencies from the hash-locked `delivery-service/requirements.txt`. Set the organization environment values from `.reel/backend.env`, then configure these settings on the runtime:

| Setting | Value |
| --- | --- |
| `REEL_DELIVERY_PROVIDER` | `standalone` (the default). |
| `REEL_NOTION_DATA_SOURCE_ID` | Notion data source UUID. Create a private data source with a title property and a `Meeting ID` rich-text property. Share it with the authorized integration. |
| `NOTION_TOKEN` | Secret token for that integration, with permission to read and insert content in the data source. |
| `REEL_RECAP_SENDER` | An email address in `REEL_ORGANIZATION_DOMAIN`. |
| `GOOGLE_CALENDAR_CREDENTIALS` | Path to the secret-mounted Workspace domain-wide delegated service-account JSON. Enable the Calendar and Gmail APIs and grant `calendar.readonly`, `gmail.compose` and `gmail.readonly` scopes. The service reads the verified caller's calendar and sends as the recap sender. |
| `DELIVERY_RECEIPTS_BUCKET` | Private GCS bucket. Grant the runtime identity read, create and replacement access to its `delivery/` objects. |
| `CALENDAR_SELECTION_BUCKET`, `CALENDAR_SELECTION_PREFIX` | Use the meeting service’s `RECEIPT_BUCKET` and `RECEIPT_PREFIX`. Grant the delivery identity `storage.objects.get` on objects under `<prefix>/calendar/`. It uses the signed-in owner’s saved Google calendar choices to list meetings and verify recap recipients. |
| `REEL_SLACK_BOT_TOKEN` | Optional Slack bot token, injected as a runtime secret. Leave unset to disable Slack delivery. |

Keep the Cloud Run request timeout at 600 seconds and concurrency at 1. The image runs a synchronous one-thread Gunicorn worker with a 600-second timeout. Occurrence claims last 660 seconds. Provider calls use a bounded transport timeout and an active claim check.

After an ambiguous provider result, retry with the same immutable recording payload. The service looks up the previously attempted Notion page or Gmail draft before doing further work. A confirmed receipt is reused. An unresolved create or send remains pending for reconciliation. Review the Notion data source's sharing settings before delivering notes. Recipients receive the authenticated Reel notes link.

## Slack recap DMs

Install a Slack bot in your workspace with `users:read.email`, `im:write`, `chat:write`, and `im:history` bot scopes and set its token as `REEL_SLACK_BOT_TOKEN`. Reel matches internal invitees and the organizer to active workspace members by exact email. A manually recorded meeting is shared only with its owner. Each matching recipient gets a private message with the outcome, action items, and authenticated notes link. Reel skips guests, unmatched addresses, and external accounts. Link previews are disabled.

Slack DMs start with new recaps. Email and meeting notes remain available if Slack cannot deliver a DM. Reel records successful sends per meeting and recipient. If Slack's response is ambiguous, Reel checks the DM history and avoids sending the same recap again.

## Local tests

From the root, in a Python environment with the locked dependencies and pytest:

```sh
PYTHONPATH=. python -m pytest delivery-service
```

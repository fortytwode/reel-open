# Calendar meeting contract

The Mac adapter reads EventKit, including Google, Outlook/Exchange, iCloud and subscribed calendars already configured on that Mac. Connect explicitly requests full event access; refresh never requests permissions. Users must select calendar IDs before any events are read. Discovery covers ongoing meetings and starts within the next seven days and does not join or record anything.

`CalendarSource` contains `id`, `title`, `accountName`. `CalendarEventCandidate` is transient adapter input; notes and location supply links and are discarded after parsing. `CalendarMeeting` is the shared Codable/Sendable value. Encode/decode with `ReelJSON` (ISO 8601 UTC dates), rather than Foundation's default numeric Date representation:

```json
{
  "id": "8:calendar6:series:1800000600.0",
  "calendarID": "calendar",
  "title": "Client call",
  "start": "2027-01-15T08:10:00Z",
  "end": "2027-01-15T08:40:00Z",
  "joinURL": "https://meet.google.com/abc-defg-hij",
  "platform": "google_meet",
  "attendeeEmails": ["anna@example.com"],
  "cancelled": false,
  "isPrivate": false,
  "ownerDeclined": false
}
```

`organizer` is an optional email string (absent when unavailable). Platform values are `google_meet`, `zoom`, `teams`. The occurrence ID concatenates UTF-8 byte length + calendar ID, byte length + external event ID, `:` + Swift's decimal Unix timestamp in seconds. Preserve this opaque ID downstream; never deduplicate by title. EventKit's server external identifier plus start distinguishes recurring occurrences; a local item identifier is the fallback. Calendar IDs and identifiers are scoped to the adapter/account; do not assume EventKit IDs equal Google/Graph IDs across devices.

Accepted direct HTTPS links: `meet.google.com/abc-defg-hij`, `zoom.us/j/<9–11 digits>` (including Zoom subdomains), `teams.microsoft.com/l/meetup-join/<token>/<number>`, `teams.microsoft.com/meet/<digits>`, and `teams.live.com/meet/<digits>`. Preserve query parameters, including passcodes. Reject credentials in URLs, fragments and custom ports. Identical links repeated in an event collapse; two different accepted URLs omit that event, including different passcodes for the same meeting. No redirect traversal. The additional `meet.teams.microsoft.com` host is intentionally unsupported pending an official provider contract.

All-day, cancelled, declined-by-current-user, explicitly private, invalid-duration and out-of-window events are excluded. Case-insensitive `[NO-REC]` and `[PRIVATE]` title markers also exclude events. EventKit exposes no reliable provider private-classification flag here; the adapter cannot detect a provider's private flag and does not infer it from notes or availability. No calendar notes, full events, attendee addresses or URL passcodes are logged. The returned title/attendees/organizer/URL are sensitive local metadata: keep them out of public recording metadata and sharing payloads. Existing meeting capture is local by default; sharing requires its own explicit action.

A Windows implementation can produce the same candidate/value using Google Calendar OAuth + events instances, Microsoft Graph delegated calendar access + calendarView, or an explicitly supplied ICS feed with recurrence expansion. Each adapter must expose selectable calendars, enforce the same exclusions/window, normalize attendee RSVP/current-user decline, preserve stable external occurrence identity, and retain only selected-calendar data. Use documented OAuth scopes and an OS credential store; an ICS feed URL can itself be a secret. This contract does not implement or claim Windows support, OAuth account connection, ICS expansion, or cross-device identifier reconciliation.

An unattended bot is a separate always-on service: scheduling, provider joining, lobby admission, recording, transcription and Notion delivery are not EventKit discovery. A sleeping Mac cannot run the local adapter or record. The remote queue must receive only deliberately enabled meetings, preserve occurrence IDs for idempotence, and handle cancellations/privacy changes; calendar access alone does not authorize sending a bot.

"""Calendar tasks and one consent-authorized, private bot execution per occurrence."""
import base64
import hashlib
import hmac
import json
import os
import secrets
import time
import uuid
from datetime import UTC, datetime, timedelta
from urllib.parse import urlsplit

from flask import jsonify, redirect, request

from calendar_meetings import (DISPATCH_LEAD_SECONDS, ENTRY_LEAD_SECONDS, CalendarMeetingError, CalendarMeetings,
                               CalendarProviderError, CalendarSelectionChanged, GoogleCalendarFactory,
                               canonical_join_url, cloud_capture_enabled, cloud_requires_calendar,
                               effective_cloud_providers)
from reel_organization import is_internal_email, meeting_domain_enabled, organization_domain, public_account_access, trusted_origins


PROCESSING_TERMINAL_STATES = {"delivered", "private_notes_ready", "no_speech", "transcript_too_long", "review_required",
                              "calendar_selection_required", "recovered", "audio_unavailable"}
RECOVERY_ASSETS = {"system-audio.wav", "recording.mp4"}
DESKTOP_RESERVATION_SECONDS = 180
CLOUD_FAILURE_CODES = {
    "startup": {"media_start_failed", "media_start_timeout", "display_unavailable", "browser_launch_failed",
                "browser_launch_timeout", "context_create_failed", "context_create_timeout",
                "driver_start_failed", "driver_start_timeout", "capture_deadline_expired"},
    "lobby_timeout": {"admission_timeout", "admission_unconfirmed"},
    "lobby_denied": {"denied"},
    "auth": {"google_auth_profile_invalid", "google_auth_profile_unavailable", "google_auth_account_mismatch",
             "google_auth_failed", "google_auth_timeout", "human_action_required"},
    "capture_interrupted": {"media_stalled", "meeting_access_lost", "meeting_connection_lost", "recorder_exited",
                            "recorder_start_failed", "recording_start_failed", "recording_start_timeout",
                            "recording_monitor_failed", "recording_monitor_timeout", "execution_stopped"},
}

# How long a cloud recording may follow a meeting past its scheduled end.
OVERRUN_ALLOWANCE = timedelta(hours=2)


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def organization_desktop(email):
    return (not public_account_access() and meeting_domain_enabled() and is_internal_email(email)
            and os.getenv("MEETING_CAPTURE_PROVIDER") == "desktop")


def desktop_claims_enabled(email):
    return (organization_desktop(email) and os.getenv("REEL_DESKTOP_CLAIMS") == "1"
            and not os.getenv("MEETING_CLOUD_PROVIDERS", "").strip())


def shared_cloud_capture_key(event):
    if not all(event.get(key) for key in ("ical_uid", "organizer_email", "participant_roster", "join_url")):
        return ""
    url = urlsplit(event["join_url"])
    occurrence = datetime.fromisoformat(event["start"].replace("Z", "+00:00")).astimezone(UTC).isoformat()
    return "sharedcapture/" + digest(json.dumps([event["ical_uid"], event["organizer_email"],
        url.hostname, url.path.rstrip("/"), occurrence, event["participant_roster"]], separators=(",", ":")))


class DesktopClaimConflict(CalendarMeetingError):
    status = 409

    def __init__(self, message, *, retryable=False):
        super().__init__(message)
        self.retryable = retryable


def update_desktop_claim(store, key, binding, action, end):
    """Only a live reservation may start, and only its owner can release it."""
    for _ in range(3):
        existing, generation = store.load(key, timeout=2)
        current = existing or {}
        own = bool(current and all(current.get(name) == value for name, value in binding.items()))
        now = datetime.now(UTC).timestamp()
        begun = current.get("status") == "begun"
        reserved = current.get("status") == "reserved" and current["expires_at"] > now
        if action == "reserve":
            if own and (begun or reserved):
                return current["status"]
            if own or begun or reserved:
                raise DesktopClaimConflict("This meeting already has a recorder" if begun or reserved else
                                           "The recording reservation is no longer valid", retryable=reserved)
            expiry = min(now + DESKTOP_RESERVATION_SECONDS, end.timestamp())
            if expiry <= now:
                raise DesktopClaimConflict("This meeting is no longer available for recording")
            updated = {**binding, "status": "reserved", "expires_at": expiry}
        elif action == "begin":
            if own and begun:
                return "begun"
            if not own or not reserved:
                raise DesktopClaimConflict("The recording reservation is no longer valid", retryable=reserved)
            updated = {**binding, "status": "begun"}
        else:
            if own and current.get("status") == "released":
                return "released"
            if current and not own:
                raise DesktopClaimConflict("The recording reservation belongs to another attempt")
            # An aborted request can be released before its reserve reaches the store.
            updated = {**binding, "status": "released"}
        try:
            store.cas(key, updated, generation, timeout=2)
        except Exception:
            # A racing writer or lost response is resolved from the same key.
            continue
        return updated["status"]
    raise CalendarProviderError("Could not confirm the recording reservation. Try again.")


def cloud_session(*, refresh_timeout=None):
    import google.auth
    from google.auth.transport.requests import AuthorizedSession
    credentials, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    return AuthorizedSession(credentials, refresh_timeout=refresh_timeout,
                             max_refresh_attempts=0 if refresh_timeout else 2)


class CloudTasks:
    def for_sweep(self, credentials):
        from google.auth.transport.requests import AuthorizedSession
        result = CloudTasks()
        result.sweep_session = AuthorizedSession(credentials, refresh_timeout=1, max_refresh_attempts=0)
        return result

    def schedule(self, owner_hash, event_id, occurrence_start, task_generation=None):
        queue = os.environ["CALENDAR_TASK_QUEUE"]
        lead = DISPATCH_LEAD_SECONDS
        name = queue + "/tasks/reel-" + digest(owner_hash + event_id + occurrence_start + (task_generation or "")
                                               + ":lead" + str(lead))
        dispatch_at = datetime.fromisoformat(occurrence_start.replace("Z", "+00:00")) - timedelta(seconds=lead)
        body = {"owner_hash": owner_hash, "event_id": event_id, "start": occurrence_start}
        if task_generation:
            body["task_generation"] = task_generation
        task = {"name": name, "scheduleTime": dispatch_at.astimezone(UTC).isoformat().replace("+00:00", "Z"),
                "httpRequest": {
            "url": os.environ["MEETING_SERVICE_URL"] + "/internal/calendar/due",
            "httpMethod": "POST", "headers": {"Content-Type": "application/json"},
            "body": base64.b64encode(json.dumps(body).encode()).decode(),
            "oidcToken": {"serviceAccountEmail": os.environ["INTERNAL_SERVICE_ACCOUNT"],
                          "audience": os.environ["MEETING_SERVICE_URL"]}}}
        response = cloud_session().post("https://cloudtasks.googleapis.com/v2/" + queue + "/tasks",
                                       json={"task": task}, timeout=20)
        if response.status_code != 409:
            response.raise_for_status()
        return name

    def schedule_processing(self, execution, *, timeout=10, delay_seconds=0):
        queue = os.environ["PROCESSING_TASK_QUEUE"]
        task = {"dispatchDeadline": "600s", "httpRequest": {
            "url": os.environ["MEETING_SERVICE_URL"] + "/internal/bot/process",
            "httpMethod": "POST", "headers": {"Content-Type": "application/json"},
            "body": base64.b64encode(json.dumps({"execution_id": execution}).encode()).decode(),
            "oidcToken": {"serviceAccountEmail": os.environ["INTERNAL_SERVICE_ACCOUNT"],
                          "audience": os.environ["MEETING_SERVICE_URL"]}}}
        if delay_seconds:
            task["scheduleTime"] = (datetime.now(UTC) + timedelta(seconds=delay_seconds)).isoformat().replace('+00:00', 'Z')
        session = self.sweep_session if timeout == 1 else cloud_session()
        response = session.post("https://cloudtasks.googleapis.com/v2/" + queue + "/tasks",
                                json={"task": task}, timeout=timeout)
        response.raise_for_status()
        return response.json().get("name", "")


def has_recovery_media(record):
    return any(record.get("artifacts", {}).get(name) is True for name in RECOVERY_ASSETS)


def processing_allowed(record):
    return bool(record and (record.get("status") == "completed"
                           or (record.get("status") == "failed" and record.get("recover_partial") is True)))


def enqueue_processing(store, execution, scheduler, *, bounded=False):
    key = "executions/" + execution
    options = {"timeout": 1} if bounded else {}
    record, generation = store.load(key, **options)
    slack_retry = bool(record and record.get("processing_status") == "delivered" and record.get("slack_retry_pending"))
    if (not processing_allowed(record) or not record.get("processing_enqueue_needed")
            or (record.get("processing_status") in PROCESSING_TERMINAL_STATES and not slack_retry)):
        return False
    step = record.get("processing_step", 0)
    schedule_options = {"timeout": 1} if bounded else {}
    if slack_retry:
        schedule_options["delay_seconds"] = 60
    scheduler.schedule_processing(execution, **schedule_options)
    # Do not clear a later stage's outbox when its task ran concurrently.
    current, generation = store.load(key, **options)
    if (current and current.get("processing_enqueue_needed")
            and current.get("processing_step", 0) == step
            and current.get("recovery_audio_name") == record.get("recovery_audio_name")
            and current.get("slack_retry_attempts", 0) == record.get("slack_retry_attempts", 0)):
        current["processing_enqueue_needed"] = False
        try:
            store.cas(key, current, generation, **options)
        except Exception:
            # A duplicate task is safe; a missing task is not.
            pass
    return True


def reconcile_processing(store, scheduler, *, clock=time.monotonic):
    """Advance a bounded, cyclic cursor; failures are revisited after wraparound."""
    deadline = clock() + 35
    store = store.for_sweep()
    if isinstance(scheduler, CloudTasks):
        scheduler = scheduler.for_sweep(store.bucket.client._credentials)
    prefix = store.prefix + "/executions/" if store.prefix else "executions/"
    cursor_key = "processing-sweep/cursor"
    cursor, generation = store.load(cursor_key, timeout=1)
    start = (cursor or {}).get("after", "")
    if not isinstance(start, str) or (start and not start.startswith(prefix)):
        start = ""
    iterator = store.bucket.list_blobs(prefix=prefix, start_offset=start + "\0" if start else prefix,
                                      max_results=50, page_size=50, timeout=1, retry=None)
    queued, failed, scanned, last = 0, 0, 0, start
    exhausted = True
    for blob in iterator:
        # Reserve time for one enqueue's bounded calls and the cursor write.
        if clock() + 20 >= deadline:
            exhausted = False
            break
        last = blob.name
        scanned += 1
        execution = blob.name.rsplit("/", 1)[-1].removesuffix(".json")
        try:
            if str(uuid.UUID(execution)) != execution:
                continue
            if enqueue_processing(store, execution, scheduler, bounded=True):
                queued += 1
        except Exception:
            failed += 1
    if scanned == 50:
        exhausted = False
    # CAS prevents overlapping sweeps from moving a newer cursor backwards.
    try:
        store.cas(cursor_key, {"after": "" if exhausted else last}, generation, timeout=1)
    except Exception:
        pass
    return queued, failed


def bind_audio_generation(record):
    from google.cloud import storage
    blob = storage.Client().bucket(record["output_bucket"]).blob(record["output_prefix"] + "system-audio.wav")
    blob.reload(timeout=10)
    if not blob.generation or not blob.size:
        raise CalendarMeetingError("Recording audio is unavailable")
    return int(blob.generation)


def bind_captions_generation(record):
    """Optional private sidecar; pin absence too so retries cannot adopt new names."""
    from google.cloud import storage
    try:
        blob = storage.Client().bucket(record["output_bucket"]).blob(record["output_prefix"] + "captions.json")
        blob.reload(timeout=10)
        if blob.generation and 0 < blob.size <= 2 * 1024 * 1024:
            return int(blob.generation)
    except Exception:
        pass
    return 0


def public_grant_id(store, owner, uid):
    from public_calendar_oauth import PublicCalendarOAuth
    return PublicCalendarOAuth(store).grant_id(owner, uid) if PublicCalendarOAuth.configured() else None


class BotDispatcher:
    def __init__(self, store, clock=None):
        self.store = store
        self.clock = clock or (lambda: datetime.now(UTC))

    def __call__(self, owner, event):
        if not cloud_capture_enabled(owner, event.get("join_url")):
            raise CalendarMeetingError("Open Reel on your computer to join and capture this meeting")
        state, _ = self.store.load("calendar/" + digest(owner))
        config = (state or {}).get("config") or {}
        saved = (state or {}).get("events", {}).get(event.get("id"))
        if not saved or saved.get("join_url") != event.get("join_url"):
            raise CalendarMeetingError("Cloud capture requires an approved calendar occurrence")
        calendar_backed = saved.get("calendar_id") != "browser"

        def entry_allowed(current, selection):
            if (not current or current.get("status") != "dispatching" or current.get("attempted") is not True
                    or any(current.get(key) != saved.get(key) for key in
                           ("calendar_id", "join_url", "ical_uid", "organizer_email", "participant_roster"))):
                return False
            if public_account_access():
                expected = current.get("reservation_grant")
                if (not expected or selection.get("grant_id") != expected
                        or selection.get("scope_revision") != current.get("reservation_scope")
                        or public_grant_id(self.store, owner, selection.get("owner_uid")) != expected):
                    return False
            if calendar_backed:
                return selection.get("enabled") is True and current.get("calendar_id") in selection.get("calendar_ids", [])
            return not cloud_requires_calendar()

        if not entry_allowed(saved, config):
            raise CalendarMeetingError("Cloud capture requires an approved calendar occurrence")
        shared = bool(not public_account_access() and calendar_backed and saved.get("ical_uid")
                      and saved.get("organizer_email") and saved.get("participant_roster"))
        identity = (state or {}).get("identity") or (state or {}).get("config") or {}
        owner_uid = identity.get("owner_uid")
        if not owner_uid:
            raise CalendarMeetingError("Calendar owner identity is unavailable")
        execution = str(uuid.uuid4())
        meeting_id = str(uuid.uuid5(uuid.NAMESPACE_URL, owner_uid + ":" + event["id"]))
        prefix = "reel-meetings/bot/" + digest(owner_uid) + "/" + execution + "/"
        token = secrets.token_urlsafe(48)
        now = self.clock()
        end = datetime.fromisoformat(event["end"].replace("Z", "+00:00"))
        start = datetime.fromisoformat(event["start"].replace("Z", "+00:00"))
        # Other recorders may take over this occurrence shortly after its end.
        claim_deadline = min(end + timedelta(minutes=5), now + timedelta(hours=3))
        # The recorder itself may follow an overrunning meeting; it leaves on
        # its own once the room is empty or quiet.
        capture_deadline = min(end + OVERRUN_ALLOWANCE, now + timedelta(hours=3))
        max_duration = max(60, min(10800, int((end - now + OVERRUN_ALLOWANCE).total_seconds())))
        url = canonical_join_url(event["join_url"])[0]
        parsed = urlsplit(url)
        host = parsed.hostname
        provider = "meet" if host == "meet.google.com" else "teams" if host in {"teams.microsoft.com", "teams.live.com"} else "zoom"
        shared_key, leader = "", True
        if shared:
            shared_key = shared_cloud_capture_key(saved)
            claim = {"execution_id": execution, "owner_hash": digest(owner), "event_id": event["id"],
                     "capture_deadline": claim_deadline.isoformat()}
            try:
                # This permanent occurrence claim consumes the sole cloud attempt,
                # including a lost Cloud Run response or an interrupted dispatcher.
                self.store.cas(shared_key, claim, 0)
            except Exception:
                existing, _ = self.store.load(shared_key)
                if not existing:
                    raise
                leader = existing.get("execution_id") == execution
        for _ in range(3):
            state, generation = self.store.load("calendar/" + digest(owner))
            current = (state or {}).get("events", {}).get(event["id"])
            latest_config = (state or {}).get("config") or {}
            if not entry_allowed(current, latest_config):
                raise CalendarMeetingError("Meeting approval was revoked")
            if shared_key:
                current["shared_claim"] = shared_key
            if leader:
                current["execution_id"] = execution
            try:
                self.store.cas("calendar/" + digest(owner), state, generation)
                break
            except Exception:
                if _ == 2:
                    raise
        if not leader:
            return {"status": "requesting_entry"}
        payload = {"execution_id": execution, "owner_id": owner_uid, "provider": provider,
                   "meeting_url": url, "display_name": "Reel Notetaker - recording",
                   "consent": {"confirmed": True}, "callback_url": os.environ["MEETING_SERVICE_URL"] + "/internal/bot/status",
                   "callback_token": token, "output_bucket": os.environ["BOT_BUCKET"], "output_prefix": prefix,
                   "max_duration_seconds": max_duration, "admission_timeout_seconds": 900,
                   "capture_deadline": capture_deadline.isoformat(), "scheduled_end": end.isoformat(),
                   "join_not_before": (start - timedelta(seconds=ENTRY_LEAD_SECONDS)).isoformat()}
        attendees = saved["participant_roster"] if shared else event["attendees"]
        record = {"execution_id": execution, "owner_id": owner_uid, "owner_email": owner,
                  "provider": provider,
                  "event_id": event["id"], "meeting_id": meeting_id, "title": event["title"],
                  "started_at": event["start"], "attendees": attendees, "status": "requesting_entry",
                  "callback_hash": digest(token), "output_prefix": prefix, "output_bucket": os.environ["BOT_BUCKET"],
                  "created_at": now.isoformat(), "notion_status": "pending"}
        attendee_names = current.get("attendee_names", {})
        if attendee_names:
            attendee_emails = {email.strip().lower() for email in attendees}
            record["attendee_names"] = {email: name for email, name in attendee_names.items() if email in attendee_emails}
        self.store.cas("executions/" + execution, record, 0)
        from google.cloud import storage
        blob = storage.Client().bucket(os.environ["BOT_BUCKET"]).blob(prefix + "payload.json")
        blob.upload_from_string(json.dumps(payload), content_type="application/json", if_generation_match=0)
        latest, _ = self.store.load("calendar/" + digest(owner))
        latest = latest or {}
        if not entry_allowed(latest.get("events", {}).get(event["id"]), latest.get("config") or {}):
            raise CalendarMeetingError("Meeting approval was revoked")
        job = os.environ["BOT_JOB_NAME"]
        try:
            response = cloud_session().post("https://run.googleapis.com/v2/" + job + ":run", json={
                "overrides": {"containerOverrides": [{"env": [{"name": "BOT_PAYLOAD_GCS_URI",
                    "value": "gs://" + os.environ["BOT_BUCKET"] + "/" + prefix + "payload.json"}]}]}}, timeout=30)
        except Exception:
            # Transport failure does not prove that Cloud Run rejected the job.
            return {"status": "requesting_entry"}
        # A failed/uncertain request consumes the occurrence's sole attempt. Never
        # submit another execution just because a response was lost.
        if response.status_code >= 500:
            return {"status": "requesting_entry"}
        response.raise_for_status()
        try:
            operation = response.json()
        except (ValueError, TypeError):
            return {"status": "requesting_entry"}
        for _ in range(3):
            try:
                record, generation = self.store.load("executions/" + execution)
                record["operation_name"] = operation.get("name", "")
                self.store.cas("executions/" + execution, record, generation)
                break
            except Exception:
                # Once accepted, a receipt race must never make a retry eligible.
                continue
        return {"status": "requesting_entry"}


def install_calendar_routes(app, claims_for_request, store_for_request, deliver_notes,
                            *, calendar_factory=None, scheduler=None, dispatcher_factory=None):
    def public_oauth():
        from public_calendar_oauth import PublicCalendarOAuth
        return PublicCalendarOAuth(store_for_request())

    def service():
        store = store_for_request()
        factory = calendar_factory or (
            (lambda owner, ids, uid: public_oauth().factory(owner, ids, uid))
            if public_account_access() else GoogleCalendarFactory()
        )
        return CalendarMeetings(store, factory, scheduler or CloudTasks(),
                                dispatcher_factory(store) if dispatcher_factory else BotDispatcher(store),
                                grant_reader=lambda owner, uid: public_grant_id(store, owner, uid))

    def capabilities(claims):
        providers = effective_cloud_providers(claims["email"].lower())
        result = {"calendar": bool(os.getenv("CALENDAR_TASK_QUEUE") and
                                  (calendar_factory or os.path.isfile(os.getenv("GOOGLE_CALENDAR_CREDENTIALS", "")))),
                "bot": (not cloud_requires_calendar() or bool(providers)) and bool(os.getenv("BOT_JOB_NAME") and os.getenv("BOT_BUCKET")),
                "provider": os.getenv("MEETING_CAPTURE_PROVIDER", "independent"),
                "cloud_providers": providers if os.getenv("BOT_JOB_NAME") and os.getenv("BOT_BUCKET") else []}
        if public_account_access():
            from public_calendar_oauth import PublicCalendarOAuth
            result["calendar_oauth"] = bool(os.getenv("CALENDAR_TASK_QUEUE") and PublicCalendarOAuth.configured())
            result["calendar_authorized"] = result["calendar_oauth"] and public_oauth().connected(claims)
            result["calendar"] = result["calendar_authorized"]
            result["bot"] = result["bot"] and result["calendar"]
        return result

    def owner_state(claims):
        return store_for_request().load("calendar/" + digest(claims["email"].lower()))

    def calendar_claims():
        claims = claims_for_request()
        state, _ = owner_state(claims)
        CalendarMeetings._verify_binding(state or {}, claims)
        return claims

    def public_events(claims, settings, history_before=None):
        state, _ = owner_state(claims)
        state = state or {}
        config = state.get("config") or {}
        selected = set(config.get("calendar_ids", [])) if settings and settings.get("enabled") else set()
        events = (event for event in state.get("events", {}).values() if event.get("attempted")
                  or event.get("execution_id") or event.get("status") == "completed"
                  or (not event.get("calendar_excluded") and event.get("calendar_id") in selected))
        next_history_before = None
        if public_account_access():
            def order(event):
                return event.get("start", ""), event["id"]

            visible = sorted(events, key=order)
            now = datetime.now(UTC).isoformat()
            def current(event):
                return event.get("end", "").replace("Z", "+00:00") >= now

            upcoming = [e for e in visible if current(e)]
            history = [e for e in reversed(visible) if e.get("execution_id") and not current(e)]
            if history_before is not None:
                cursor = state.get("events", {}).get(history_before)
                if not cursor or not cursor.get("execution_id"):
                    raise CalendarMeetingError("Invalid recording history cursor")
                history = [e for e in history if order(e) < order(cursor)]
                upcoming = []
            if len(history) > 25:
                next_history_before = history[24]["id"]
            visible = upcoming[:50] + history[:25]
        else:
            visible = sorted(events, key=lambda e: e.get("start", ""))[-100:]
        result = []
        for event in visible:
            public = CalendarMeetings._public(event, claims["email"].lower())
            if event.get("launch_uncertain"):
                public["detail"] = "Entry request outcome is unconfirmed; a duplicate request is blocked."
            if event.get("execution_id"):
                record, _ = store_for_request().load("executions/" + event["execution_id"])
                if record and record.get("owner_id") == claims["sub"]:
                    public["notion_status"] = record.get("notion_status", "pending")
                    public["notion_url"] = "" if public_account_access() else record.get("notion_url", "")
                    public["video_available"] = bool(record.get("artifacts", {}).get("recording.mp4"))
                    public["transcript_available"] = bool(record.get("artifacts", {}).get("transcript.txt"))
                    if public_account_access():
                        public["summary_available"] = bool(record.get("artifacts", {}).get("summary.json"))
                    if record.get("status") == "failed" and record.get("failure_category") in CLOUD_FAILURE_CODES:
                        public["status"] = "failed"
                        public["failure_category"] = record["failure_category"]
                    if record.get("status") == "failed":
                        public["status"] = "failed"
                        if record.get("recover_partial") is True:
                            public["recovery_status"] = record.get("processing_status", "processing")
                            public["recovery_summary_available"] = bool(record.get("artifacts", {}).get("summary.json"))
                        elif has_recovery_media(record):
                            public["recovery_available"] = True
                    if record.get("processing_status") == "review_required":
                        public["detail"] = "Review the transcript; notes were not delivered."
                    elif record.get("processing_status") == "transcript_too_long":
                        public["detail"] = "Transcript exceeds the summary limit; download the full transcript."
                    elif record.get("processing_status") == "calendar_selection_required":
                        public["detail"] = "Select the meeting calendar and retry to send notes. The recording and transcript are available."
            elif event.get("shared_claim") and not public_account_access():
                claim, _ = store_for_request().load(event["shared_claim"])
                record, _ = store_for_request().load("executions/" + claim["execution_id"]) if claim else (None, 0)
                if record:
                    public["status"] = record.get("status", public["status"])
                    public["notion_status"] = record.get("notion_status", "pending")
                if claim and claim.get("event_id") and (not record or record.get("status") == "requesting_entry"):
                    # Pre-launch errors can leave the execution absent or pending.
                    # Only a known leader failure changes the shared projection;
                    # missing receipts and uncertain Cloud Run responses stay pending.
                    leader_state, _ = store_for_request().load("calendar/" + claim["owner_hash"])
                    leader_event = (leader_state or {}).get("events", {}).get(claim["event_id"], {})
                    if leader_event.get("status") == "failed":
                        public["status"] = "failed"
                public["detail"] = {
                    "recording": "Meeting is being recorded for this invitation. Notes appear in Mission Control.",
                    "joined": "Meeting capture has joined this invitation.",
                    "awaiting_admission": "Meeting capture is awaiting admission for this invitation.",
                    "failed": "Meeting capture could not be completed for this invitation.",
                }.get(public["status"], "Meeting capture is pending for this invitation.")
                if public["status"] == "completed":
                    public["detail"] = {
                        "no_speech": "No meeting speech was captured for this invitation.",
                        "review_required": "Meeting notes for this invitation require review.",
                        "transcript_too_long": "Meeting transcript for this invitation exceeds the summary limit.",
                        "calendar_selection_required": "Meeting notes are waiting for calendar access.",
                        "delivered": "Meeting notes for this invitation are available in Mission Control.",
                    }.get((record or {}).get("processing_status"),
                          "Meeting capture is complete for this invitation. Notes are being prepared.")
            result.append(public)
        return result, next_history_before

    def event_execution(claims, event_id):
        state, _ = owner_state(claims)
        event = (state or {}).get("events", {}).get(event_id)
        if not event or not event.get("execution_id"):
            raise CalendarMeetingError("No capture is available for this meeting")
        record, _ = store_for_request().load("executions/" + event["execution_id"])
        if not record or record.get("owner_id") != claims["sub"]:
            raise CalendarMeetingError("Meeting capture is unavailable")
        if public_account_access():
            expected_prefix = "reel-meetings/bot/" + digest(claims["sub"]) + "/" + event["execution_id"] + "/"
            if (record.get("event_id") != event_id or record.get("output_bucket") != os.getenv("BOT_BUCKET")
                    or record.get("output_prefix") != expected_prefix):
                raise CalendarMeetingError("Meeting capture is unavailable")
        return record

    def payload():
        value = request.get_json(silent=True)
        if not isinstance(value, dict):
            raise CalendarMeetingError("JSON object required")
        return value

    def internal_identity():
        from google.auth.transport.requests import Request
        from google.oauth2 import id_token
        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return False
        try:
            claims = id_token.verify_oauth2_token(auth[7:], Request(), audience=os.environ["MEETING_SERVICE_URL"])
            return claims.get("email") == os.environ["INTERNAL_SERVICE_ACCOUNT"] and claims.get("email_verified") is True
        except Exception:
            return False

    def stored_claims(owner_hash):
        if not isinstance(owner_hash, str) or len(owner_hash) != 64 or any(x not in "0123456789abcdef" for x in owner_hash):
            raise CalendarMeetingError("Invalid owner")
        state, _ = store_for_request().load("calendar/" + owner_hash)
        identity = (state or {}).get("identity") or (state or {}).get("config") or {}
        email, uid = identity.get("owner_email"), identity.get("owner_uid")
        if not email or not uid or digest(email) != owner_hash:
            raise CalendarMeetingError("Unknown calendar owner")
        claims = {"sub": uid, "email": email, "email_verified": True}
        CalendarMeetings._verify_binding(state or {}, claims)
        return claims

    @app.errorhandler(CalendarMeetingError)
    def calendar_error(exc):
        if isinstance(exc, DesktopClaimConflict):
            return jsonify(error=str(exc), retryable=exc.retryable), exc.status
        return jsonify(error=str(exc)), exc.status

    @app.after_request
    def private_calendar_response(response):
        if request.path.startswith(("/calendar", "/internal")):
            response.headers["Cache-Control"] = "no-store"
        if request.path.startswith("/calendar/oauth/"):
            response.headers["Referrer-Policy"] = "no-referrer"
        return response

    @app.route("/calendar/oauth/start", methods=["POST", "OPTIONS"])
    def start_calendar_oauth():
        if not public_account_access():
            return jsonify(error="Calendar authorization is unavailable"), 404
        if request.method == "OPTIONS":
            return "", 204
        origin = request.headers.get("Origin", "")
        if not origin.startswith("https://") or origin not in trusted_origins():
            return jsonify(error="Origin not allowed"), 403
        claims = calendar_claims()
        return jsonify(authorization_url=public_oauth().begin(claims, origin))

    @app.post("/calendar/oauth/callback")
    def complete_calendar_oauth():
        if not public_account_access():
            return jsonify(error="Calendar authorization is unavailable"), 404
        fields = ("state", "code", "error", "iss")
        if any(len(request.form.getlist(field)) > 1 for field in fields):
            raise CalendarMeetingError("Invalid Calendar authorization response")
        if request.form.get("iss", "https://accounts.google.com") != "https://accounts.google.com":
            raise CalendarMeetingError("Invalid Calendar authorization response")
        origin, success = public_oauth().complete(request.form.get("state"), request.form.get("code"), request.form.get("error"))
        if not origin.startswith("https://") or origin not in trusted_origins():
            raise CalendarMeetingError("Invalid Calendar authorization response")
        return redirect(origin + "/notetaker?calendar_oauth=" + ("connected" if success else "error"), code=303)

    @app.route("/calendar/settings", methods=["GET", "POST", "OPTIONS"])
    @app.route("/calendar/sources", methods=["GET", "OPTIONS"])
    @app.route("/calendar/connect", methods=["POST", "OPTIONS"])
    @app.route("/calendar/disconnect", methods=["POST", "OPTIONS"])
    @app.route("/calendar/sync", methods=["POST", "OPTIONS"])
    @app.route("/calendar/meetings", methods=["GET", "OPTIONS"])
    def calendar_settings():
        if request.method == "OPTIONS":
            return "", 204
        claims = calendar_claims()
        core = service()
        if request.path.endswith("/sources"):
            if not capabilities(claims)["calendar"]:
                return jsonify(error="Google Calendar is not configured"), 503
            return jsonify(sources=core.sources(claims))
        sync_error = None
        if request.method == "POST":
            data = payload()
            if request.path.endswith("/disconnect"):
                core.disconnect(claims)
                if public_account_access():
                    from public_calendar_oauth import PublicCalendarOAuth
                    if PublicCalendarOAuth.configured():
                        public_oauth().disconnect(claims)
            elif request.path.endswith("/connect"):
                if not capabilities(claims)["calendar"]:
                    return jsonify(error="Calendar scheduling is not configured"), 503
                ids = data.get("calendar_ids")
                if not isinstance(ids, list) or not 1 <= len(ids) <= 25 or any(not isinstance(item, str) for item in ids):
                    raise CalendarMeetingError("Explicitly select one or more Google calendars")
                grant_id = (public_grant_id(store_for_request(), claims["email"].lower(), claims["sub"])
                            if public_account_access() else None)
                available = {source["id"] for source in core.sources(claims)}
                if any(item not in available for item in ids):
                    raise CalendarMeetingError("Select calendars available to your Google account")
                core.connect(claims, ids, grant_id=grant_id)
                try:
                    core.sync(claims)
                except CalendarProviderError:
                    sync_error = "Calendar choices saved. Sync calendar to retry loading meetings."
            elif request.path.endswith("sync"):
                core.sync(claims)
            else:
                core.set_consent_mode(claims, data.get("consent_mode"), data.get("participant_consent_attested") is True,
                                      data.get("scope_revision"))
        settings = core.settings(claims)
        if request.path.endswith("/meetings"):
            events, cursor = public_events(claims, settings, request.args.get("history_before"))
            return jsonify(meetings=events, next_history_before=cursor) if public_account_access() else jsonify(meetings=events)
        events, cursor = public_events(claims, settings)
        result = {"config": settings, "events": events, "capabilities": capabilities(claims)}
        if public_account_access():
            result["next_history_before"] = cursor
        if sync_error:
            result["sync_error"] = sync_error
        return jsonify(result)

    @app.route("/calendar/desktop", methods=["GET", "OPTIONS"])
    def desktop_calendar():
        if request.method == "OPTIONS":
            return "", 204
        claims = calendar_claims()
        state, _ = owner_state(claims)
        config = (state or {}).get("config") or {}
        events, cloud_events = [], []
        now = datetime.now(UTC)
        for event in (state or {}).get("events", {}).values():
            if event.get("status") == "cancelled" or not event.get("join_url"):
                continue
            end = datetime.fromisoformat(event["end"].replace("Z", "+00:00"))
            item = CalendarMeetings._public(event, claims["email"].lower())
            # Calendar settings stop new joins, but cannot revoke an accepted
            # or uncertain attempt. Preserve its ownership through the worker's
            # bounded end + five-minute deadline, including retained failed URLs.
            owns_cloud = (item["capture_provider"] == "cloud" and event.get("attempted")
                         and event.get("status") in {"dispatching", "requesting_entry", "awaiting_admission", "joined", "recording", "failed"}
                         and end + timedelta(minutes=5) > now)
            if not owns_cloud and (not config.get("enabled")
                    or event.get("calendar_id") not in config.get("calendar_ids", []) or end <= now):
                continue
            if owns_cloud:
                # The desktop routing consumer expires ownership using this
                # projection. Keep the authoritative occurrence end unchanged.
                item["end"] = (end + timedelta(minutes=5)).isoformat()
            item["join_url"] = event["join_url"]
            (cloud_events if item["capture_provider"] == "cloud" else events).append(item)
        result = {"events": events, "cloud_events": cloud_events, "cloud_providers": capabilities(claims)["cloud_providers"]}
        if organization_desktop(claims["email"]):
            result["desktop_claims"] = desktop_claims_enabled(claims["email"])
        return jsonify(result)

    @app.route("/calendar/desktop/<event_id>/claim", methods=["POST", "OPTIONS"])
    def desktop_calendar_claim(event_id):
        if request.method == "OPTIONS":
            return "", 204
        claims = claims_for_request()
        owner = claims["email"].lower()
        if not desktop_claims_enabled(owner):
            return jsonify(error="Desktop recording reservations are unavailable"), 404
        data = payload()
        action, claim_id = data.get("action"), data.get("claim_id")
        if (set(data) != {"action", "claim_id", "participant_consent_attested"}
                or action not in ("reserve", "begin", "release")
                or data.get("participant_consent_attested") is not True):
            raise CalendarMeetingError("Invalid desktop recording action or missing participant consent")
        try:
            if not isinstance(claim_id, str) or len(claim_id) != 36 or str(uuid.UUID(claim_id)) != claim_id:
                raise ValueError
        except ValueError:
            raise CalendarMeetingError("Invalid desktop recording reservation") from None

        def selected_occurrence():
            state, _ = owner_state(claims)
            state = state or {}
            CalendarMeetings._verify_binding(state, claims)
            config = state.get("config") or {}
            event = state.get("events", {}).get(event_id) or {}
            if not all(event.get(field) for field in ("ical_uid", "organizer_email", "desktop_occurrence_start")):
                raise DesktopClaimConflict("A verified calendar occurrence is required for automatic recording")
            if owner != event["organizer_email"] and owner not in {email.lower() for email in event["attendees"]}:
                raise DesktopClaimConflict("This account is not on the meeting invitation")
            return event, config

        event, config = selected_occurrence()
        now = datetime.now(UTC)
        store = store_for_request()
        if action == "release":
            if event.get("capture_source") == "desktop" and event.get("status") in {"joined", "recording", "completed"}:
                raise DesktopClaimConflict("This meeting has already started recording")
        else:
            def verify_available(event, config):
                now = datetime.now(UTC)
                start = datetime.fromisoformat(event["start"].replace("Z", "+00:00"))
                if (config.get("enabled") is not True or event.get("calendar_id") not in config.get("calendar_ids", [])
                        or not canonical_join_url(event.get("join_url")) or event.get("execution_id")
                        or (event.get("attempted") and event.get("capture_source") != "desktop")
                        or event.get("status") in {"cancelled", "completed"}
                        or start > now + timedelta(seconds=30)
                        or datetime.fromisoformat(event["end"].replace("Z", "+00:00")) <= now):
                    raise DesktopClaimConflict("This meeting is unavailable for desktop recording")

            verify_available(event, config)
            current = service()._event_current(owner, config, event, now, verify_desktop_occurrence=True)
            if current is None:
                raise CalendarProviderError("Could not verify the meeting on its selected calendar")
            latest, selection = selected_occurrence()
            verify_available(latest, selection)
            if (not current or selection.get("scope_revision") != config.get("scope_revision")
                    or any(latest.get(k) != event.get(k) for k in
                           ("join_url", "ical_uid", "organizer_email", "desktop_occurrence_start"))):
                raise CalendarSelectionChanged("Calendar occurrence changed before recording")
            event = latest
            cloud_key = shared_cloud_capture_key(event)
            if cloud_key:
                cloud_claim, _ = store.load(cloud_key, timeout=2)
                deadline = (cloud_claim or {}).get("capture_deadline")
                if deadline and datetime.fromisoformat(deadline) > datetime.now(UTC):
                    raise DesktopClaimConflict("This meeting is still assigned to a cloud recorder")

        key = "desktopcapture/" + digest(json.dumps([organization_domain(), event["ical_uid"],
            event["organizer_email"], event["desktop_occurrence_start"]], separators=(",", ":")))
        binding = {"owner": digest(claims["sub"]), "event_id": event_id, "claim_id": claim_id}
        end = datetime.fromisoformat(event["end"].replace("Z", "+00:00"))
        return jsonify(status=update_desktop_claim(store, key, binding, action, end))

    @app.route("/calendar/desktop/<event_id>/state", methods=["POST", "OPTIONS"])
    def desktop_calendar_state(event_id):
        if request.method == "OPTIONS":
            return "", 204
        claims = calendar_claims()
        data = payload()
        status = data.get("state")
        if data.get("participant_consent_attested") is not True:
            raise CalendarMeetingError("Participant consent must be confirmed")
        if status not in {"requesting_entry", "awaiting_admission", "joined", "recording", "completed", "failed"}:
            raise CalendarMeetingError("Unsupported desktop state")
        def update(state):
            event = state.get("events", {}).get(event_id)
            config = state.get("config") or {}
            if (not event or not config.get("enabled")
                    or event.get("calendar_id") not in config.get("calendar_ids", [])
                    or event.get("status") == "cancelled" or event.get("execution_id")
                    or cloud_capture_enabled(claims["email"].lower(), event.get("join_url"))
                    or datetime.fromisoformat(event["end"].replace("Z", "+00:00")) <= datetime.now(UTC)):
                raise CalendarMeetingError("Calendar occurrence is unavailable for desktop capture")
            event.update(status=status, capture_source="desktop", attempted=True)
            return True, {"id": event_id, "status": status}
        return jsonify(service()._mutate(claims["email"].lower(), update))

    @app.route("/calendar/meetings/<event_id>/<action>", methods=["POST", "OPTIONS"])
    def calendar_action(event_id, action):
        if request.method == "OPTIONS":
            return "", 204
        claims = calendar_claims()
        data = payload()
        if action == "recover":
            original = event_execution(claims, event_id)
            execution = original["execution_id"]
            store = store_for_request()
            key = "executions/" + execution
            current, generation = store.load(key)
            if (not current or current.get("owner_id") != claims["sub"]
                    or current.get("event_id") != event_id or current.get("status") != "failed"
                    or not has_recovery_media(current)):
                raise CalendarMeetingError("No partial recording is available for recovery")
            if current.get("recover_partial") is not True:
                current.update(recover_partial=True, processing_status="processing", processing_enqueue_needed=True)
                from google.api_core.exceptions import PreconditionFailed
                try:
                    store.cas(key, current, generation)
                except PreconditionFailed:
                    current, _ = store.load(key)
                    if not current or current.get("recover_partial") is not True:
                        raise
            enqueue_processing(store, execution, CloudTasks())
            return jsonify(status=current.get("processing_status", "processing")), 202
        if action == "notion":
            if public_account_access():
                return jsonify(error="Organization delivery is unavailable"), 404
            record = event_execution(claims, event_id)
            if record.get("status") != "completed" or not record.get("audio_generation"):
                raise CalendarMeetingError("Recording audio is not ready")
            if record.get("processing_status") == "calendar_selection_required":
                state, _ = owner_state(claims)
                config = (state or {}).get("config") or {}
                event = (state or {}).get("events", {}).get(event_id) or {}
                selected = config.get("calendar_ids", []) if config.get("enabled") is True else []
                if not selected or (event.get("calendar_id") and event["calendar_id"] not in selected):
                    raise CalendarMeetingError("Select the meeting calendar before retrying notes")
                execution = record["execution_id"]
                store = store_for_request()
                key = "executions/" + execution
                current, generation = store.load(key)
                if current.get("processing_status") == "calendar_selection_required":
                    current.update(processing_status="processing", notion_status="pending", processing_enqueue_needed=True)
                    store.cas(key, current, generation)
                    enqueue_processing(store, execution, CloudTasks())
                record = current
            elif record.get("processing_status") not in PROCESSING_TERMINAL_STATES:
                CloudTasks().schedule_processing(record["execution_id"])
            return jsonify(status=record.get("processing_status", "pending"), url=record.get("notion_url", ""))
        if action == "approve":
            if data.get("participant_consent_attested") is not True:
                raise CalendarMeetingError("Participant consent must be confirmed before joining")
            if not capabilities(claims)["bot"]:
                return jsonify(error="Meeting entry is not configured"), 503
            return jsonify(service().approve(claims, event_id))
        if action == "decline":
            return jsonify(service().decline(claims, event_id))
        return jsonify(error="Unknown meeting action"), 404

    @app.route("/calendar/meetings/<event_id>/artifacts/<kind>", methods=["GET", "OPTIONS"])
    def download_artifact(event_id, kind):
        if request.method == "OPTIONS":
            return "", 204
        claims = calendar_claims()
        record = event_execution(claims, event_id)
        name = {"video": "recording.mp4", "transcript": "transcript.txt", "summary": "summary.json"}.get(kind)
        if (not name or not record.get("artifacts", {}).get(name)
                or (kind == "summary" and not public_account_access() and record.get("recover_partial") is not True)):
            return jsonify(error="Artifact is not available"), 404
        import google.auth
        from google.auth.transport.requests import Request
        from google.cloud import storage
        credentials, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
        credentials.refresh(Request())
        blob = storage.Client().bucket(record["output_bucket"]).blob(record["output_prefix"] + name)
        blob.reload()
        filename = "reel-partial-meeting" if record.get("status") == "failed" else "reel-meeting"
        extension = {"video": "mp4", "transcript": "txt", "summary": "json"}[kind]
        url = blob.generate_signed_url(version="v4", expiration=timedelta(minutes=5), method="GET",
            service_account_email=os.environ["INTERNAL_SERVICE_ACCOUNT"], access_token=credentials.token,
            response_disposition=f'attachment; filename="{filename}.{extension}"')
        return jsonify(url=url, expires_in=300)

    @app.route("/calendar/browser", methods=["POST", "OPTIONS"])
    def browser_meeting():
        if request.method == "OPTIONS":
            return "", 204
        claims = calendar_claims()
        data = payload()
        if data.get("participant_consent_attested") is not True:
            raise CalendarMeetingError("Participant consent must be confirmed before joining")
        if not capabilities(claims)["bot"]:
            return jsonify(error="Meeting entry is not configured"), 503
        link = canonical_join_url(data.get("meeting_url"))
        if not link:
            raise CalendarMeetingError("Supported meeting URL required")
        core = service()
        owner = claims["email"].lower()
        now = datetime.now(UTC)
        if not cloud_capture_enabled(owner, link[0]):
            raise CalendarMeetingError("Open Reel on your computer for desktop capture")
        if cloud_requires_calendar():
            state, _ = owner_state(claims)
            config = (state or {}).get("config") or {}
            matches = [event for event in (state or {}).get("events", {}).values()
                       if config.get("enabled") and event.get("calendar_id") in config.get("calendar_ids", [])
                       and event.get("calendar_id") != "browser" and event.get("join_url") == link[0]
                       and event.get("status") != "cancelled"
                       and datetime.fromisoformat(event["start"].replace("Z", "+00:00")) <= now + timedelta(seconds=30)
                       and datetime.fromisoformat(event["end"].replace("Z", "+00:00")) > now]
            if len(matches) > 1:
                matching_fields = ("ical_uid", "organizer_email", "participant_roster", "start", "occurrence_start")
                candidate = matches[0]
                if all(candidate.get(field) for field in matching_fields) and all(
                        all(other.get(field) == candidate[field] for field in matching_fields) for other in matches[1:]):
                    matches = [min(matches, key=lambda item: (not item.get("attempted"),
                               config["calendar_ids"].index(item["calendar_id"]), item["id"]))]
            if len(matches) != 1:
                raise CalendarMeetingError("A current connected Google Calendar occurrence is required")
            event = matches[0]
            status = core.dispatch_callback(claims, event["id"], event["occurrence_start"], event.get("task_generation"))
            if status == "awaiting_consent":
                return jsonify(core.approve(claims, event["id"]))
            if status not in {"requesting_entry", "awaiting_admission", "joined", "recording", "completed", "failed"}:
                raise CalendarMeetingError("This calendar meeting is unavailable for cloud capture")
            return jsonify(id=event["id"], status=status)
        # Same provider link cannot launch a second concurrent bot for this owner.
        event_id = digest(link[0] + "\0" + str(uuid.uuid4()))
        event = {"id": event_id, "title": str(data.get("title") or "Browser meeting")[:200],
                 "start": now.isoformat(), "end": (now + timedelta(hours=3)).isoformat(),
                 "join_url": link[0], "passcode": link[1], "attendees": [owner],
                 "calendar_id": "browser", "status": "dispatching", "attempted": True}
        def reserve(state):
            core._verify_binding(state, claims)
            for previous in state.setdefault("events", {}).values():
                if (previous.get("join_url") == link[0]
                        and previous.get("status") not in {"completed", "failed", "cancelled"}):
                    return False, previous
            state["identity"] = {"owner_email": owner, "owner_uid": claims["sub"]}
            state["events"][event_id] = event
            return True, event
        current = core._mutate(owner, reserve)
        if current is event:
            try:
                core.bot_dispatcher(owner, event)
                status = "requesting_entry"
            except Exception:
                # The adapter may have failed after submitting the job. Until a
                # worker confirms departure, this link must suppress another bot.
                status = "requesting_entry"
                event["launch_uncertain"] = True
            def finish(state):
                saved = state.get("events", {}).get(event_id)
                if not saved or saved.get("status") != "dispatching":
                    return False, None
                saved["status"] = status
                if event.get("launch_uncertain"):
                    saved["launch_uncertain"] = True
                return True, None
            core._mutate(owner, finish)
        return jsonify(id=current["id"], status=core._current_status(owner, current["id"]))

    @app.post("/internal/bot/process")
    def process_bot():
        if not internal_identity():
            return jsonify(error="Internal identity required"), 403
        data = payload()
        if set(data) != {"execution_id"}:
            return jsonify(error="Invalid execution"), 400
        try:
            execution = str(uuid.UUID(data["execution_id"]))
            if execution != data["execution_id"]:
                raise ValueError()
            from cloud_processing import process_step
            return jsonify(status=process_step(store_for_request(), execution, CloudTasks()))
        except ValueError:
            return jsonify(error="Execution is unavailable"), 400
        except Exception:
            app.logger.error("Cloud processing failed; retry will reconcile")
            return jsonify(error="Cloud processing is pending"), 503

    @app.post("/internal/calendar/due")
    def due_task():
        if not internal_identity():
            return jsonify(error="Internal identity required"), 403
        data = payload()
        claims = stored_claims(data.get("owner_hash"))
        return jsonify(status=service().dispatch_callback(claims, data.get("event_id"), data.get("start"), data.get("task_generation")))

    @app.post("/internal/calendar/sync")
    def sync_calendars():
        if not internal_identity():
            return jsonify(error="Internal identity required"), 403
        store = store_for_request()
        try:
            queued, queue_failures = reconcile_processing(store, CloudTasks())
        except Exception:
            app.logger.error("Processing reconciliation failed")
            queued, queue_failures = 0, 1
        prefix = store.prefix + "/calendar/" if store.prefix else "calendar/"
        cursor_key = "calendar-sweep/cursor"
        cursor, generation = store.load(cursor_key, timeout=1)
        start = (cursor or {}).get("after", "")
        if not isinstance(start, str) or (start and not start.startswith(prefix)):
            start = ""
        limit = 25
        # Look one item ahead to wrap immediately when the last page is full.
        blobs = list(store.bucket.list_blobs(prefix=prefix, start_offset=start + "\0" if start else prefix,
                                             max_results=limit + 1, page_size=limit + 1, timeout=1, retry=None))
        count, failures = 0, 0
        for blob in blobs[:limit]:
            # Checkpoint before slow owner I/O so a terminated worker cannot pin the sweep.
            try:
                generation = store.cas(cursor_key, {"after": blob.name}, generation, timeout=1)
            except Exception:
                app.logger.warning("Calendar sync cursor update could not be confirmed")
                return jsonify(error="Calendar sync progress is unavailable; retry pending"), 503
            try:
                claims = stored_claims(blob.name.rsplit("/", 1)[-1].removesuffix(".json"))
                config = service().settings(claims)
                if config and config.get("enabled"):
                    service().sync(claims)
                    count += 1
            except Exception:
                failures += 1
        if len(blobs) <= limit:
            try:
                store.cas(cursor_key, {"after": ""}, generation, timeout=1)
            except Exception:
                app.logger.warning("Calendar sync cursor wrap could not be confirmed")
        return jsonify(synced=count, failed=failures, processing_queued=queued, processing_failed=queue_failures)

    @app.post("/internal/bot/status")
    def bot_status():
        data = payload()
        try:
            execution = str(uuid.UUID(data.get("execution_id", "")))
        except (ValueError, AttributeError, TypeError):
            return jsonify(error="Invalid execution"), 400
        store = store_for_request()
        key = "executions/" + execution
        record, generation = store.load(key)
        token = request.headers.get("Authorization", "").removeprefix("Bearer ")
        if (not record or not token or not hmac.compare_digest(digest(token), record.get("callback_hash", ""))
                or data.get("owner_id") != record["owner_id"]):
            return jsonify(error="Invalid execution identity"), 403
        if datetime.now(UTC) - datetime.fromisoformat(record["created_at"]) > timedelta(hours=5):
            return jsonify(error="Execution callback expired"), 403
        sequence = data.get("sequence")
        if not isinstance(sequence, int) or isinstance(sequence, bool) or sequence < 1:
            return jsonify(error="Invalid callback sequence"), 400
        previous_sequence = record.get("sequence", 0)
        if sequence < previous_sequence or (sequence == previous_sequence and data.get("status") != record["status"]):
            return jsonify(status=record["status"])
        status = data.get("status")
        ordered = ["requesting_entry", "awaiting_admission", "joined", "recording", "completed"]
        if status not in {*ordered, "failed"}:
            return jsonify(error="Invalid execution status"), 400
        old = record["status"]
        if old == "failed" or (old == "completed" and status != "completed"):
            return jsonify(status=old)
        if status != "failed" and old in ordered and ordered.index(status) < ordered.index(old):
            return jsonify(status=old)
        if status == "completed":
            expected_audio = "gs://" + record.get("output_bucket", "") + "/" + record.get("output_prefix", "") + "system-audio.wav"
            artifact = (data.get("artifacts") or {}).get("system-audio.wav")
            if not isinstance(artifact, dict) or artifact.get("gcs_uri") != expected_audio:
                return jsonify(error="Recording audio is unavailable"), 400
            if not record.get("audio_generation"):
                record["audio_generation"] = bind_audio_generation(record)
            if "captions_generation" not in record:
                expected_captions = expected_audio.removesuffix("system-audio.wav") + "captions.json"
                captions = (data.get("artifacts") or {}).get("captions.json")
                record["captions_generation"] = (bind_captions_generation(record)
                    if isinstance(captions, dict) and captions.get("gcs_uri") == expected_captions else 0)
        if status == "completed" and record.get("processing_status") not in PROCESSING_TERMINAL_STATES:
            record["processing_enqueue_needed"] = True
        record["status"] = status
        record["sequence"] = sequence
        if isinstance(data.get("artifacts"), dict):
            expected = "gs://" + record.get("output_bucket", "") + "/" + record.get("output_prefix", "")
            artifacts = record.setdefault("artifacts", {})
            artifacts.update({name: True for name, item in data["artifacts"].items()
                if name in {"recording.mp4", "system-audio.wav"}
                and isinstance(item, dict) and item.get("gcs_uri") == expected + name})
        if status == "failed":
            record["failure"] = "Meeting entry or capture could not be confirmed"
            detail = data.get("detail")
            if isinstance(detail, str):
                for category, codes in CLOUD_FAILURE_CODES.items():
                    if detail in codes:
                        record["failure_category"] = category
                        break
        store.cas(key, record, generation)
        owner_key = "calendar/" + digest(record["owner_email"])
        for _ in range(3):
            state, gen = store.load(owner_key)
            event = (state or {}).get("events", {}).get(record["event_id"])
            if not event:
                break
            event["status"] = status
            event["execution_id"] = execution
            event.pop("launch_uncertain", None)
            try:
                store.cas(owner_key, state, gen)
                break
            except Exception:
                continue
        if status == "completed":
            enqueue_processing(store, execution, CloudTasks())
            return jsonify(status=status, notion_status=record.get("notion_status", "pending"))
        return jsonify(status=status)

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

from flask import jsonify, request

from calendar_meetings import (CalendarMeetingError, CalendarMeetings, GoogleCalendarFactory,
                               canonical_join_url, cloud_capture_enabled, cloud_requires_calendar, effective_cloud_providers)


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


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

    def schedule(self, owner_hash, event_id, occurrence_start):
        queue = os.environ["CALENDAR_TASK_QUEUE"]
        name = queue + "/tasks/reel-" + digest(owner_hash + event_id + occurrence_start)
        body = {"owner_hash": owner_hash, "event_id": event_id, "start": occurrence_start}
        task = {"name": name, "scheduleTime": occurrence_start, "httpRequest": {
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

    def schedule_processing(self, execution, *, timeout=10):
        queue = os.environ["PROCESSING_TASK_QUEUE"]
        task = {"dispatchDeadline": "600s", "httpRequest": {
            "url": os.environ["MEETING_SERVICE_URL"] + "/internal/bot/process",
            "httpMethod": "POST", "headers": {"Content-Type": "application/json"},
            "body": base64.b64encode(json.dumps({"execution_id": execution}).encode()).decode(),
            "oidcToken": {"serviceAccountEmail": os.environ["INTERNAL_SERVICE_ACCOUNT"],
                          "audience": os.environ["MEETING_SERVICE_URL"]}}}
        session = self.sweep_session if timeout == 1 else cloud_session()
        response = session.post("https://cloudtasks.googleapis.com/v2/" + queue + "/tasks",
                                json={"task": task}, timeout=timeout)
        response.raise_for_status()
        return response.json().get("name", "")


def enqueue_processing(store, execution, scheduler, *, bounded=False):
    key = "executions/" + execution
    options = {"timeout": 1} if bounded else {}
    record, generation = store.load(key, **options)
    if (not record or record.get("status") != "completed" or not record.get("processing_enqueue_needed")
            or record.get("processing_status") in ("delivered", "no_speech", "transcript_too_long", "review_required")):
        return False
    step = record.get("processing_step", 0)
    if bounded:
        scheduler.schedule_processing(execution, timeout=1)
    else:
        scheduler.schedule_processing(execution)
    # Do not clear a later stage's outbox when its task ran concurrently.
    current, generation = store.load(key, **options)
    if (current and current.get("processing_enqueue_needed")
            and current.get("processing_step", 0) == step):
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
        shared = bool(saved and saved.get("ical_uid") and saved.get("organizer_email")
                      and saved.get("participant_roster") and saved.get("calendar_id") != "browser")
        if os.getenv("MEETING_CAPTURE_PROVIDER") == "desktop" or shared:
            if (not saved or saved.get("join_url") != event.get("join_url")
                    or saved.get("calendar_id") == "browser"
                    or saved.get("calendar_id") not in config.get("calendar_ids", [])
                    or not config.get("enabled") or saved.get("status") != "dispatching"
                    or saved.get("attempted") is not True):
                raise CalendarMeetingError("Cloud capture requires an approved calendar occurrence")
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
        capture_deadline = min(end + timedelta(minutes=5), now + timedelta(hours=3))
        max_duration = max(60, min(10800, int((end - now).total_seconds()) + 300))
        url = canonical_join_url(event["join_url"])[0]
        parsed = urlsplit(url)
        host = parsed.hostname
        provider = "meet" if host == "meet.google.com" else "teams" if host in {"teams.microsoft.com", "teams.live.com"} else "zoom"
        shared_key, leader = "", True
        if shared:
            occurrence = datetime.fromisoformat(saved["start"].replace("Z", "+00:00")).astimezone(UTC).isoformat()
            shared_key = "sharedcapture/" + digest(json.dumps([saved["ical_uid"], saved["organizer_email"],
                parsed.hostname, parsed.path.rstrip("/"), occurrence, saved["participant_roster"]], separators=(",", ":")))
            claim = {"execution_id": execution, "owner_hash": digest(owner), "event_id": event["id"],
                     "capture_deadline": capture_deadline.isoformat()}
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
            if (not current or current.get("status") != "dispatching"
                    or (shared and (not latest_config.get("enabled") or
                        current.get("calendar_id") not in latest_config.get("calendar_ids", []) or
                        any(current.get(key) != saved.get(key) for key in
                            ("join_url", "ical_uid", "organizer_email", "participant_roster"))))):
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
                   "capture_deadline": capture_deadline.isoformat()}
        record = {"execution_id": execution, "owner_id": owner_uid, "owner_email": owner,
                  "event_id": event["id"], "meeting_id": meeting_id, "title": event["title"],
                  "started_at": event["start"], "attendees": saved["participant_roster"] if shared else event["attendees"], "status": "requesting_entry",
                  "callback_hash": digest(token), "output_prefix": prefix, "output_bucket": os.environ["BOT_BUCKET"],
                  "created_at": now.isoformat(), "notion_status": "pending"}
        self.store.cas("executions/" + execution, record, 0)
        from google.cloud import storage
        blob = storage.Client().bucket(os.environ["BOT_BUCKET"]).blob(prefix + "payload.json")
        blob.upload_from_string(json.dumps(payload), content_type="application/json", if_generation_match=0)
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
    def service():
        store = store_for_request()
        return CalendarMeetings(store, calendar_factory or GoogleCalendarFactory(), scheduler or CloudTasks(),
                                dispatcher_factory(store) if dispatcher_factory else BotDispatcher(store))

    def capabilities(claims):
        providers = effective_cloud_providers(claims["email"].lower())
        return {"calendar": bool(os.getenv("CALENDAR_TASK_QUEUE") and
                                  (calendar_factory or os.path.isfile(os.getenv("GOOGLE_CALENDAR_CREDENTIALS", "")))),
                "bot": (not cloud_requires_calendar() or bool(providers)) and bool(os.getenv("BOT_JOB_NAME") and os.getenv("BOT_BUCKET")),
                "provider": os.getenv("MEETING_CAPTURE_PROVIDER", "independent"),
                "cloud_providers": providers if os.getenv("BOT_JOB_NAME") and os.getenv("BOT_BUCKET") else []}

    def owner_state(claims):
        return store_for_request().load("calendar/" + digest(claims["email"].lower()))

    def calendar_claims():
        claims = claims_for_request()
        state, _ = owner_state(claims)
        bound = ((state or {}).get("identity") or (state or {}).get("config") or {}).get("owner_uid")
        if bound and bound != claims["sub"]:
            raise CalendarMeetingError("Calendar connection belongs to a different account identity")
        return claims

    def public_events(claims):
        state, _ = owner_state(claims)
        events = sorted((state or {}).get("events", {}).values(), key=lambda e: e.get("start", ""))[-100:]
        result = []
        for event in events:
            public = CalendarMeetings._public(event, claims["email"].lower())
            if event.get("launch_uncertain"):
                public["detail"] = "Entry request outcome is unconfirmed; a duplicate request is blocked."
            if event.get("execution_id"):
                record, _ = store_for_request().load("executions/" + event["execution_id"])
                if record and record.get("owner_id") == claims["sub"]:
                    public["notion_status"] = record.get("notion_status", "pending")
                    public["notion_url"] = record.get("notion_url", "")
                    public["video_available"] = bool(record.get("artifacts", {}).get("recording.mp4"))
                    public["transcript_available"] = bool(record.get("artifacts", {}).get("transcript.txt"))
                    if record.get("processing_status") == "review_required":
                        public["detail"] = "Review the transcript; notes were not delivered."
                    elif record.get("processing_status") == "transcript_too_long":
                        public["detail"] = "Transcript exceeds the summary limit; download the full transcript."
            elif event.get("shared_claim"):
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
                        "delivered": "Meeting notes for this invitation are available in Mission Control.",
                    }.get((record or {}).get("processing_status"),
                          "Meeting capture is complete for this invitation. Notes are being prepared.")
            result.append(public)
        return result

    def event_execution(claims, event_id):
        state, _ = owner_state(claims)
        event = (state or {}).get("events", {}).get(event_id)
        if not event or not event.get("execution_id"):
            raise CalendarMeetingError("No capture is available for this meeting")
        record, _ = store_for_request().load("executions/" + event["execution_id"])
        if not record or record.get("owner_id") != claims["sub"]:
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
        return {"sub": uid, "email": email, "email_verified": True}

    @app.errorhandler(CalendarMeetingError)
    def calendar_error(exc):
        return jsonify(error=str(exc)), 400

    @app.after_request
    def private_calendar_response(response):
        if request.path.startswith(("/calendar", "/internal")):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.route("/calendar/settings", methods=["GET", "POST", "OPTIONS"])
    @app.route("/calendar/connect", methods=["POST", "OPTIONS"])
    @app.route("/calendar/disconnect", methods=["POST", "OPTIONS"])
    @app.route("/calendar/sync", methods=["POST", "OPTIONS"])
    @app.route("/calendar/meetings", methods=["GET", "OPTIONS"])
    def calendar_settings():
        if request.method == "OPTIONS":
            return "", 204
        claims = calendar_claims()
        core = service()
        if request.method == "POST":
            data = payload()
            if request.path.endswith("/disconnect"):
                core.disconnect(claims)
            elif request.path.endswith("/connect"):
                if not capabilities(claims)["calendar"]:
                    return jsonify(error="Calendar scheduling is not configured"), 503
                core.connect(claims, data.get("calendar_ids"))
                def bind_owner(state):
                    state["identity"] = {"owner_email": claims["email"].lower(), "owner_uid": claims["sub"]}
                    return True, None
                core._mutate(claims["email"].lower(), bind_owner)
                core.sync(claims)
            elif request.path.endswith("sync"):
                core.sync(claims)
            else:
                core.set_consent_mode(claims, data.get("consent_mode"), data.get("participant_consent_attested") is True)
        if request.path.endswith("/meetings"):
            return jsonify(meetings=public_events(claims))
        return jsonify(config=core.settings(claims), events=public_events(claims), capabilities=capabilities(claims))

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
        return jsonify(events=events, cloud_events=cloud_events, cloud_providers=capabilities(claims)["cloud_providers"])

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
        if action == "notion":
            record = event_execution(claims, event_id)
            if record.get("status") != "completed" or not record.get("audio_generation"):
                raise CalendarMeetingError("Recording audio is not ready")
            if record.get("processing_status") not in ("delivered", "no_speech", "transcript_too_long", "review_required"):
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
        name = {"video": "recording.mp4", "transcript": "transcript.txt"}.get(kind)
        if not name or not record.get("artifacts", {}).get(name):
            return jsonify(error="Artifact is not available"), 404
        import google.auth
        from google.auth.transport.requests import Request
        from google.cloud import storage
        credentials, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
        credentials.refresh(Request())
        blob = storage.Client().bucket(record["output_bucket"]).blob(record["output_prefix"] + name)
        blob.reload()
        url = blob.generate_signed_url(version="v4", expiration=timedelta(minutes=5), method="GET",
            service_account_email=os.environ["INTERNAL_SERVICE_ACCOUNT"], access_token=credentials.token,
            response_disposition='attachment; filename="reel-meeting.' + ("mp4" if kind == "video" else "txt") + '"')
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
            if len(matches) != 1:
                raise CalendarMeetingError("A current connected Google Calendar occurrence is required")
            event = matches[0]
            status = core.dispatch_callback(claims, event["id"], event["occurrence_start"])
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
        return jsonify(status=service().dispatch_callback(claims, data.get("event_id"), data.get("start")))

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
        if status == "completed" and record.get("processing_status") not in ("delivered", "no_speech", "transcript_too_long", "review_required"):
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
            # Provider details are fixed worker error codes, never page text or URL.
            record["failure"] = "Meeting entry or capture could not be confirmed"
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

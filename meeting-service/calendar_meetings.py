"""Owner-scoped, consent-gated Google Calendar meeting dispatch."""
import hashlib
import html
import json
import os
import re
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlsplit, urlunsplit

from reel_organization import meeting_domain_enabled, meeting_owner_allowed


class CalendarMeetingError(Exception):
    pass


def owner_identity(claims):
    """Accept only a server-verified identity authorized by deployment policy."""
    email = claims.get("email", "").strip().lower() if isinstance(claims, dict) else ""
    if (not claims or claims.get("email_verified") is not True or not claims.get("sub")
            or not meeting_owner_allowed(email)):
        raise CalendarMeetingError("Owner identity is not authorized")
    return email


def _now(value=None):
    value = value or datetime.now(UTC)
    return value.astimezone(UTC) if value.tzinfo else value.replace(tzinfo=UTC)


def _parse_time(value):
    if not isinstance(value, dict) or "dateTime" not in value:
        return None
    raw = value["dateTime"]
    try:
        result = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if result.tzinfo is None:
            return None
        return result.astimezone(UTC)
    except (ValueError, AttributeError, TypeError):
        return None


def canonical_join_url(value):
    if not isinstance(value, str) or len(value) > 2048:
        return None
    try:
        parsed = urlsplit(value.strip())
        host = (parsed.hostname or "").lower()
        path = parsed.path or "/"
        if (parsed.scheme.lower() != "https" or parsed.username or parsed.password
                or parsed.fragment or host.endswith(".")):
            return None
        meet = host == "meet.google.com" and re.fullmatch(r"/[a-z]{3}-[a-z]{4}-[a-z]{3}/?", path)
        zoom = ((host == "zoom.us" or host.endswith(".zoom.us")) and
                (re.fullmatch(r"/j/[0-9]{9,11}/?", path)
                 or re.fullmatch(r"/wc/[0-9]{9,12}/join/?", path)))
        teams = ((host == "teams.microsoft.com" and
                  (re.fullmatch(r"/l/meetup-join/[^/]+/[0-9]+/?", path)
                   or re.fullmatch(r"/meet/[0-9]+/?", path)))
                 or (host == "teams.live.com" and re.fullmatch(r"/meet/[0-9]+/?", path)))
        if not (meet or zoom or teams) or parsed.port not in (None, 443):
            return None
        passcode = ""
        for key in ("pwd", "passcode", "password"):
            values = parse_qs(parsed.query).get(key)
            if values:
                passcode = values[0][:256]
                break
        clean = urlunsplit(("https", host, path, parsed.query, ""))
        return clean, passcode
    except ValueError:
        return None


def effective_cloud_providers(owner):
    """Configured cloud providers, scoped to an authenticated calendar owner."""
    owners = {item.strip().lower() for item in os.getenv("MEETING_CLOUD_OWNER_EMAILS", "").split(",") if item.strip()}
    if owners and owner.lower() not in owners:
        return []
    configured = {item.strip() for item in os.getenv("MEETING_CLOUD_PROVIDERS", "").split(",")}
    google_owners = {item.strip().lower() for item in os.getenv("MEETING_GOOGLE_CLOUD_OWNER_EMAILS", "").split(",") if item.strip()}
    return [provider for provider in ("teams", "google_meet") if provider in configured
            and (provider != "google_meet" or not google_owners or owner.lower() in google_owners)]


def cloud_requires_calendar():
    return os.getenv("MEETING_CAPTURE_PROVIDER") == "desktop" or meeting_domain_enabled()


def cloud_capture_enabled(owner, join_url):
    """Choose a capture route only for a canonical, supported meeting URL."""
    safe = canonical_join_url(join_url)
    if not safe:
        return False
    if not cloud_requires_calendar():
        return True
    host = urlsplit(safe[0]).hostname
    provider = {"teams.microsoft.com": "teams", "teams.live.com": "teams",
                "meet.google.com": "google_meet"}.get(host)
    return provider is not None and provider in effective_cloud_providers(owner)


_URL_RE = re.compile(r"https://[^\s<>\"']+", re.I)


def _text_join_links(value):
    """Extract only bounded HTTPS candidates; canonical_join_url enforces provider paths."""
    if not isinstance(value, str) or len(value) > 20_000:
        return []
    decoded = html.unescape(value)
    found = set()
    for match in _URL_RE.findall(decoded):
        candidate = match.rstrip(".,;:!?)]}")
        canonical = canonical_join_url(candidate)
        if canonical:
            found.add(canonical[0])
    return sorted(found)


def normalize_event(calendar_id, event, owner_email, now=None):
    """Return a safe occurrence record; meeting URL/passcode stay private in GCS."""
    if not isinstance(event, dict) or event.get("status") == "cancelled":
        return None
    provider_event_id = event.get("id")
    if (not isinstance(calendar_id, str) or not calendar_id or len(calendar_id) > 320
            or not isinstance(provider_event_id, str) or not provider_event_id or len(provider_event_id) > 1024
            or any(ord(char) < 32 for char in provider_event_id)):
        return None
    if event.get("visibility") == "private":
        return None
    title = str(event.get("summary", "")).strip()
    if not title or len(title) > 200 or re.search(r"\[(?:PRIVATE|NO[- ]?REC)\]", title, re.I):
        return None
    start = _parse_time(event.get("start"))
    end = _parse_time(event.get("end"))
    now = _now(now)
    if (not start or not end or end <= start or end - start > timedelta(hours=12)
            or start > now + timedelta(hours=48) or end < now - timedelta(minutes=10)):
        return None
    owner = owner_email.lower()
    attendees = event.get("attendees", [])
    owner_attendee = next((x for x in attendees if str(x.get("email", "")).lower() == owner), None)
    organizer = str(event.get("organizer", {}).get("email", "")).lower() == owner
    creator = str(event.get("creator", {}).get("email", "")).lower() == owner
    if not (organizer or creator or owner_attendee is not None):
        return None
    if owner_attendee and owner_attendee.get("responseStatus") == "declined":
        return None
    explicit = []
    if event.get("hangoutLink"):
        explicit.append(event["hangoutLink"])
    conference = event.get("conferenceData", {})
    if isinstance(conference, dict):
        for entry in conference.get("entryPoints", []):
            if isinstance(entry, dict) and entry.get("entryPointType") == "video" and entry.get("uri"):
                explicit.append(entry["uri"])
    explicit_links = {safe[0]: safe for raw in explicit if (safe := canonical_join_url(raw))}
    if len(explicit_links) > 1:
        return None
    text_links = set(_text_join_links(event.get("location")))
    text_links.update(_text_join_links(event.get("description")))
    all_links = explicit_links.keys() | text_links
    if len(all_links) != 1:
        return None
    # When all sources agree, retain the explicit provider value (including its query).
    safe_link = next(iter(explicit_links.values())) if explicit_links else canonical_join_url(next(iter(all_links)))
    if not safe_link:
        return None
    url, passcode = safe_link
    occurrence = start.isoformat().replace("+00:00", "Z")
    identity = hashlib.sha256(f"{calendar_id}\0{provider_event_id}\0{occurrence}".encode()).hexdigest()
    normalized = {"id": identity, "calendar_id": calendar_id, "provider_event_id": provider_event_id,
            "occurrence_start": occurrence, "start": occurrence,
            "end": end.isoformat().replace("+00:00", "Z"), "title": title,
            "attendees": [str(x.get("email", ""))[:320] for x in attendees[:100] if x.get("email")],
            "join_url": url, "passcode": passcode, "status": "scheduled",
            "attempted": False, "task_name": ""}
    uid = event.get("iCalUID")
    organizer_email = str(event.get("organizer", {}).get("email", "")).strip().lower()
    roster = {owner.strip(), organizer_email, *(str(x.get("email", "")).strip().lower() for x in attendees)}
    if (isinstance(uid, str) and 0 < len(uid) <= 1024 and uid.strip() == uid
            and not any(ord(c) < 32 or ord(c) == 127 for c in uid)
            and event.get("attendeesOmitted") is not True and len(attendees) <= 100 and len(roster) <= 100
            and all(0 < len(email) <= 320 and
                re.fullmatch(r"[^@\s<>]+@[^@\s<>]+", email) for email in roster)):
        normalized.update(ical_uid=uid, organizer_email=organizer_email, participant_roster=sorted(roster))
    return normalized


class GoogleCalendarFactory:
    """Read-only delegated Calendar API client; credentials stay server-side."""
    def __call__(self, owner_email, calendar_ids):
        credentials_path = os.getenv("GOOGLE_CALENDAR_CREDENTIALS", "/secrets/google-sa/credentials.json")
        if not os.path.isfile(credentials_path):
            raise CalendarMeetingError("Google Calendar credentials are unavailable")
        from google.oauth2 import service_account
        from google.auth.transport.requests import AuthorizedSession
        credentials = service_account.Credentials.from_service_account_file(
            credentials_path, scopes=["https://www.googleapis.com/auth/calendar.readonly"])
        delegated = credentials.with_subject(owner_email)
        return _GoogleCalendar(AuthorizedSession(delegated))


class _GoogleCalendar:
    def __init__(self, session):
        self.session = session

    def list_events(self, calendar_id, time_min, time_max):
        page = None
        while True:
            params = {"timeMin": time_min, "timeMax": time_max, "singleEvents": "true",
                      "orderBy": "startTime", "maxResults": 2500}
            if page:
                params["pageToken"] = page
            from urllib.parse import quote
            response = self.session.get("https://www.googleapis.com/calendar/v3/calendars/" +
                quote(calendar_id, safe="") + "/events", params=params, timeout=20)
            response.raise_for_status()
            result = response.json()
            yield from result.get("items", [])
            page = result.get("nextPageToken")
            if not page:
                break


class CalendarMeetings:
    STATUSES = {"scheduled", "awaiting_consent", "dispatching", "requesting_entry",
                "awaiting_admission", "joined", "recording", "completed", "failed", "cancelled"}

    def __init__(self, store, calendar_factory, task_scheduler, bot_dispatcher, clock=None):
        self.store, self.calendar_factory = store, calendar_factory
        self.task_scheduler, self.bot_dispatcher = task_scheduler, bot_dispatcher
        self.clock = clock or (lambda: datetime.now(UTC))

    def _key(self, owner):
        return "calendar/" + hashlib.sha256(owner.lower().encode()).hexdigest()

    def _load(self, owner):
        state, generation = self.store.load(self._key(owner))
        return (state or {"config": None, "events": {}}), generation

    def _save(self, owner, state, generation):
        return self.store.cas(self._key(owner), state, generation)

    def _mutate(self, owner, callback):
        for _ in range(5):
            state, generation = self._load(owner)
            changed, result = callback(state)
            if not changed:
                return result
            try:
                self._save(owner, state, generation)
                return result
            except Exception:
                if _ == 4:
                    raise

    def connect(self, claims, calendar_ids):
        owner = owner_identity(claims)
        if not isinstance(calendar_ids, list) or not calendar_ids or len(calendar_ids) > 25:
            raise CalendarMeetingError("Explicitly select one or more calendars")
        if any(not isinstance(x, str) or not x.strip() or len(x) > 320 for x in calendar_ids):
            raise CalendarMeetingError("Invalid calendar selection")
        ids = list(dict.fromkeys(x.strip() for x in calendar_ids))
        # Settings are explicitly connected before any Calendar read.
        def save(state):
            old = state.get("config") or {}
            state["config"] = {"enabled": True, "calendar_ids": ids, "owner_uid": claims["sub"],
                "consent_mode": old.get("consent_mode", "ask") if old.get("calendar_ids") == ids else "ask"}
            return True, {k: v for k, v in state["config"].items() if k != "owner_uid"}
        return self._mutate(owner, save)

    def set_consent_mode(self, claims, mode, participant_consent_attested=False):
        owner = owner_identity(claims)
        if mode not in {"ask", "approved"}:
            raise CalendarMeetingError("Consent mode must be ask or approved")
        if mode == "approved" and participant_consent_attested is not True:
            raise CalendarMeetingError("Standing consent requires explicit participant-consent attestation")
        def save(state):
            config = state.get("config")
            if not config:
                raise CalendarMeetingError("Connect calendars before changing consent settings")
            config["consent_mode"] = mode
            return True, dict(config)
        return self._mutate(owner, save)

    def settings(self, claims):
        state, _ = self._load(owner_identity(claims))
        config = state.get("config")
        return {k: v for k, v in config.items() if k != "owner_uid"} if config else None

    def disconnect(self, claims):
        owner = owner_identity(claims)
        def stop(state):
            config = state.get("config")
            if not config:
                return False, {"enabled": False}
            config["enabled"] = False
            for event in state.get("events", {}).values():
                if event.get("status") in {"scheduled", "awaiting_consent"}:
                    event.update(status="cancelled", join_url="", passcode="")
            return True, {"enabled": False}
        return self._mutate(owner, stop)

    def sync(self, claims):
        owner = owner_identity(claims)
        state, _ = self._load(owner)
        config = state.get("config")
        if not config or not config.get("enabled") or not config.get("calendar_ids"):
            raise CalendarMeetingError("Connect and select calendars before syncing")
        client = self.calendar_factory(owner, list(config["calendar_ids"]))
        now = _now(self.clock())
        horizon = now + timedelta(hours=48)
        fetched = {}
        for calendar_id in config["calendar_ids"]:
            events = client.list_events(calendar_id, now.isoformat(), horizon.isoformat())
            for raw in events:
                event = normalize_event(calendar_id, raw, owner, now)
                if event and _parse_time({"dateTime": event["start"]}) <= horizon:
                    fetched[event["id"]] = event
        scheduled = []
        def update(current):
            current.setdefault("events", {})
            existing = current["events"]
            prune_before = now - timedelta(days=30)
            for identity, old in list(existing.items()):
                end = _parse_time({"dateTime": old.get("end", "")})
                if end and end < prune_before:
                    del existing[identity]
            for identity, old in list(existing.items()):
                if old.get("calendar_id") in config["calendar_ids"] and _parse_time({"dateTime": old["start"]}) <= horizon:
                    if identity not in fetched and old["status"] in {"scheduled", "awaiting_consent"}:
                        old.update(status="cancelled", join_url="", passcode="")
            for identity, new in fetched.items():
                old = existing.get(identity)
                if old and old.get("status") == "cancelled":
                    continue
                if old and old.get("status") in {"dispatching", "requesting_entry", "awaiting_admission", "joined", "recording", "completed", "failed"}:
                    continue
                changed = not old or any(old.get(key) != new.get(key) for key in
                    ("start", "end", "join_url", "attendees", "ical_uid", "organizer_email", "participant_roster"))
                if changed:
                    new["status"] = "scheduled"
                    existing[identity] = new
                current_event = existing.get(identity)
                if current_event and current_event.get("status") == "scheduled" and not current_event.get("task_name"):
                    scheduled.append((identity, current_event["start"]))
            return True, len(fetched)
        count = self._mutate(owner, update)
        owner_hash = hashlib.sha256(owner.lower().encode()).hexdigest()
        for identity, start in scheduled:
            try:
                result = self.task_scheduler.schedule(owner_hash, identity, start)
                task_name = result if isinstance(result, str) else getattr(result, "name", "")
            except Exception:
                # A later sync retries only events whose idempotent task is still missing.
                continue
            if task_name:
                self._mutate(owner, lambda current: self._set_task(current, identity, task_name))
        return count

    @staticmethod
    def _set_task(state, identity, name):
        event = state.get("events", {}).get(identity)
        if not event or event.get("status") != "scheduled":
            return False, None
        event["task_name"] = name
        return True, None

    def list_due(self, claims):
        owner = owner_identity(claims)
        state, _ = self._load(owner)
        now = _now(self.clock())
        return [self._public(event, owner) for event in state.get("events", {}).values()
                if cloud_capture_enabled(owner, event.get("join_url")) and event.get("status") == "awaiting_consent" and _parse_time({"dateTime": event["start"]}) <= now]

    def list_events(self, claims):
        owner = owner_identity(claims)
        state, _ = self._load(owner)
        return [self._public(event, owner) for event in state.get("events", {}).values()]

    def update_provider_status(self, claims, event_id, status, provider_confirmed=False):
        owner = owner_identity(claims)
        allowed = {"requesting_entry", "awaiting_admission", "joined", "recording", "completed", "failed"}
        if status not in allowed or (status in {"joined", "recording"} and provider_confirmed is not True):
            raise CalendarMeetingError("Invalid or unconfirmed provider status")
        def update(state):
            event = state.get("events", {}).get(event_id)
            if not event or event.get("status") not in {"dispatching", "requesting_entry", "awaiting_admission", "joined", "recording"}:
                raise CalendarMeetingError("Meeting is not active")
            event["status"] = status
            if status in {"completed", "failed"}:
                event["join_url"] = event["passcode"] = ""
            return True, self._public(event, owner)
        return self._mutate(owner, update)

    @staticmethod
    def _public(event, owner=""):
        public = {k: event[k] for k in ("id", "title", "start", "end", "attendees", "status", "calendar_id") if k in event}
        public["capture_provider"] = ("desktop" if event.get("capture_source") == "desktop" else
                                      "cloud" if event.get("execution_id") or event.get("attempted")
                                      or cloud_capture_enabled(owner, event.get("join_url")) else "desktop")
        return public

    def approve(self, claims, event_id):
        owner = owner_identity(claims)
        config, state, _ = self._get_config_state(owner)
        if not config.get("enabled"):
            raise CalendarMeetingError("Calendar connection is disabled")
        now = _now(self.clock())
        current_state, _ = self._load(owner)
        target = current_state.get("events", {}).get(event_id)
        if target and not cloud_capture_enabled(owner, target.get("join_url")):
            raise CalendarMeetingError("Open Reel on your computer for desktop capture")
        if target and not self._event_current(owner, config, target, now):
            self._mutate(owner, lambda current: self._cancel_event(current, event_id, target["occurrence_start"]))
            raise CalendarMeetingError("This calendar meeting changed or was cancelled")
        def reserve(current):
            latest_config = current.get("config") or {}
            event = current.get("events", {}).get(event_id)
            if not event or event.get("status") != "awaiting_consent":
                raise CalendarMeetingError("This meeting is no longer awaiting consent")
            if (not latest_config.get("enabled") or event.get("calendar_id") not in latest_config.get("calendar_ids", [])
                    or latest_config.get("consent_mode") != "ask"):
                raise CalendarMeetingError("Calendar settings changed before approval")
            if not cloud_capture_enabled(owner, event.get("join_url")):
                raise CalendarMeetingError("Open Reel on your computer for desktop capture")
            if not target or any(event.get(key) != target.get(key) for key in
                    ("join_url", "ical_uid", "organizer_email", "participant_roster")):
                raise CalendarMeetingError("Calendar invitation changed; refresh and try again")
            if event.get("attempted"):
                raise CalendarMeetingError("This meeting has already been dispatched")
            if _parse_time({"dateTime": event["start"]}) > now:
                raise CalendarMeetingError("Early approval is not supported")
            return True, self._reserve_occurrence(current, event)
        event = self._mutate(owner, reserve)
        if event:
            self._dispatch(owner, event)
        return {"id": event_id, "status": self._current_status(owner, event_id)}

    def decline(self, claims, event_id):
        owner = owner_identity(claims)
        def decline_one(state):
            event = state.get("events", {}).get(event_id)
            if not event or event.get("status") != "awaiting_consent":
                raise CalendarMeetingError("This meeting is no longer awaiting consent")
            event.update(status="cancelled", join_url="", passcode="")
            return True, {"id": event_id, "status": "cancelled"}
        return self._mutate(owner, decline_one)

    def dispatch_callback(self, claims, event_id, occurrence_start):
        owner = owner_identity(claims)
        config, _, _ = self._get_config_state(owner)
        now = _now(self.clock())
        # Re-read the selected calendars at dispatch time so a stale task cannot join a
        # meeting that was cancelled or moved since the last sync.
        state, _ = self._load(owner)
        target = state.get("events", {}).get(event_id)
        if not target or target.get("occurrence_start") != occurrence_start:
            return None
        current = bool(target and target.get("occurrence_start") == occurrence_start
                       and self._event_current(owner, config, target, now))
        if not current:
            self._mutate(owner, lambda current_state: self._cancel_event(current_state, event_id, occurrence_start))
            return self._current_status(owner, event_id)
        def reserve(state):
            latest_config = state.get("config") or {}
            event = state.get("events", {}).get(event_id)
            if not event or event.get("occurrence_start") != occurrence_start:
                return False, None
            if (event.get("status") != "scheduled" or event.get("attempted")
                    or not latest_config.get("enabled")
                    or event.get("calendar_id") not in latest_config.get("calendar_ids", [])
                    or _parse_time({"dateTime": event["start"]}) > now + timedelta(seconds=30)):
                if (event.get("status") == "scheduled" and
                        (not latest_config.get("enabled") or event.get("calendar_id") not in latest_config.get("calendar_ids", []))):
                    event.update(status="cancelled", join_url="", passcode="")
                    return True, None
                return False, None
            if not cloud_capture_enabled(owner, event.get("join_url")):
                return False, None
            if any(event.get(key) != target.get(key) for key in
                    ("join_url", "ical_uid", "organizer_email", "participant_roster")):
                raise CalendarMeetingError("Calendar invitation changed; retry the current occurrence")
            return True, self._reserve_occurrence(
                state, event, awaiting_consent=latest_config.get("consent_mode") == "ask")
        event = self._mutate(owner, reserve)
        if event:
            self._dispatch(owner, event)
        return self._current_status(owner, event_id)

    @staticmethod
    def _reserve_occurrence(state, event, *, awaiting_consent=False):
        # Calendar copies have different IDs. Reserve their actual meeting URL
        # and start together in this owner's existing CAS, without sharing any
        # execution receipt or attendee list between copies.
        def identity(item):
            safe = canonical_join_url(item.get("join_url"))
            start = _parse_time({"dateTime": item.get("start")})
            if not safe or not start or item.get("capture_source") == "desktop":
                return None
            url = urlsplit(safe[0])
            complete = ((item["ical_uid"], item["organizer_email"], tuple(item["participant_roster"]))
                        if item.get("ical_uid") and item.get("organizer_email") and item.get("participant_roster") else None)
            return url.hostname, url.path.rstrip("/"), start, complete

        key = identity(event)
        def same_invitation(other):
            other_key = identity(other)
            return bool(key and other_key and key[:3] == other_key[:3]
                        and (key[3] is None or other_key[3] is None or key[3] == other_key[3]))
        siblings = [other for other in state.get("events", {}).values()
                    if other.get("id") != event["id"] and same_invitation(other)]
        if any(other.get("attempted") for other in siblings):
            event.update(status="cancelled", join_url="", passcode="")
            return None
        if awaiting_consent:
            event["status"] = "awaiting_consent"
            return None
        event.update(status="dispatching", attempted=True)
        for other in siblings:
            if other.get("status") in {"scheduled", "awaiting_consent"}:
                other.update(status="cancelled", join_url="", passcode="")
        return dict(event)

    def _get_config_state(self, owner):
        state, generation = self._load(owner)
        if not state.get("config"):
            raise CalendarMeetingError("No calendar connection")
        return state["config"], state, generation

    def _event_current(self, owner, config, target, now):
        if not config.get("enabled"):
            return False
        client = self.calendar_factory(owner, list(config["calendar_ids"]))
        horizon = now + timedelta(hours=48)
        time_min = now - timedelta(minutes=10)
        for calendar_id in config["calendar_ids"]:
            if calendar_id != target.get("calendar_id"):
                continue
            for raw in client.list_events(calendar_id, time_min.isoformat(), horizon.isoformat()):
                normalized = normalize_event(calendar_id, raw, owner, now)
                if (normalized and normalized["id"] == target.get("id")
                        and all(normalized.get(key) == target.get(key) for key in
                            ("join_url", "ical_uid", "organizer_email", "participant_roster"))):
                    return True
        return False

    @staticmethod
    def _cancel_event(state, event_id, occurrence_start):
        event = state.get("events", {}).get(event_id)
        if (event and event.get("occurrence_start") == occurrence_start
                and event.get("status") in {"scheduled", "awaiting_consent"}):
            event.update(status="cancelled", join_url="", passcode="")
            return True, None
        return False, None

    def _current_status(self, owner, event_id):
        state, _ = self._load(owner)
        event = state.get("events", {}).get(event_id)
        return event.get("status") if event else None

    def _dispatch(self, owner, event):
        # CAS has already consumed the sole dispatch attempt. Any uncertain result stays failed.
        state, _ = self._load(owner)
        current = state.get("events", {}).get(event["id"])
        config = state.get("config") or {}
        if (not current or current.get("status") != "dispatching" or current.get("attempted") is not True
                or not config.get("enabled") or current.get("calendar_id") not in config.get("calendar_ids", [])
                or not cloud_capture_enabled(owner, current.get("join_url"))):
            if current and current.get("status") == "dispatching" and (not config.get("enabled") or
                    current.get("calendar_id") not in config.get("calendar_ids", [])):
                self._mutate(owner, lambda latest: self._cancel_event(latest, event["id"], event["occurrence_start"]))
            return
        try:
            result = self.bot_dispatcher(owner, {k: event[k] for k in ("id", "title", "start", "end", "attendees", "join_url", "passcode")})
            if isinstance(result, dict):
                requested = result.get("status")
                if requested in {"joined", "recording"} and result.get("provider_confirmed") is not True:
                    requested = "awaiting_admission"
            else:
                requested = result
            status = requested if requested in {"requesting_entry", "awaiting_admission"} else "requesting_entry"
            if isinstance(result, dict) and requested in {"joined", "recording"} and result.get("provider_confirmed") is True:
                status = requested
        except Exception:
            status = "failed"
        def finish(state):
            current = state.get("events", {}).get(event["id"])
            if not current or current.get("status") != "dispatching":
                return False, None
            current["status"] = status
            if status == "failed":
                current["join_url"] = current["passcode"] = ""
            return True, None
        self._mutate(owner, finish)


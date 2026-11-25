"""Owner-scoped, consent-gated Google Calendar meeting dispatch."""
import hashlib
import html
import json
import os
import re
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, quote, urlsplit, urlunsplit
from uuid import uuid4

from reel_organization import meeting_domain_enabled, meeting_owner_allowed, public_account_access


class CalendarMeetingError(Exception):
    status = 400


class CalendarUnavailable(CalendarMeetingError):
    pass


class CalendarProviderError(CalendarMeetingError):
    status = 503


class CalendarSelectionChanged(CalendarMeetingError):
    status = 409


# The cloud recorder takes one to two minutes to start. Dispatch it this far
# ahead and let it wait at the entry page until just before the start.
DISPATCH_LEAD_SECONDS = 180
ENTRY_LEAD_SECONDS = 20


def owner_identity(claims):
    """Accept only a server-verified identity authorized by deployment policy."""
    email = claims.get("email", "").strip().lower() if isinstance(claims, dict) else ""
    allowed = re.fullmatch(r"[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+", email) if public_account_access() else meeting_owner_allowed(email)
    if (not claims or claims.get("email_verified") is not True or not claims.get("sub") or not allowed):
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
    return public_account_access() or os.getenv("MEETING_CAPTURE_PROVIDER") == "desktop" or meeting_domain_enabled()


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
    organizer = event.get("organizer", {})
    creator = str(event.get("creator", {}).get("email", "")).lower() == owner
    if not (str(organizer.get("email", "")).lower() == owner or creator or owner_attendee is not None):
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
    if owner_attendee and owner_attendee.get("responseStatus") in ("accepted", "tentative", "needsAction"):
        # The owner's own reply, so the page can show "Maybe" beside the meeting.
        normalized["response"] = owner_attendee["responseStatus"]
    uid = event.get("iCalUID")
    organizer_email = str(organizer.get("email", "")).strip().lower()
    roster = {owner.strip(), organizer_email, *(str(x.get("email", "")).strip().lower() for x in attendees)}
    if (isinstance(uid, str) and 0 < len(uid) <= 1024 and uid.strip() == uid
            and not any(ord(c) < 32 or ord(c) == 127 for c in uid)
            and event.get("attendeesOmitted") is not True and len(attendees) <= 100 and len(roster) <= 100
            and all(0 < len(email) <= 320 and
                re.fullmatch(r"[^@\s<>]+@[^@\s<>]+", email) for email in roster)):
        normalized.update(ical_uid=uid, organizer_email=organizer_email, participant_roster=sorted(roster))
        original = _parse_time(event.get("originalStartTime")) or start
        normalized["desktop_occurrence_start"] = original.isoformat()
    roster_emails = {email.strip().lower() for email in normalized.get("participant_roster", normalized["attendees"])}
    attendee_names = {}
    for participant in (*attendees[:100], organizer):
        email = str(participant.get("email", "")).strip().lower()
        name = participant.get("displayName")
        if not isinstance(name, str) or re.search(r"[\x00-\x1f\x7f-\x9f<>\u2028\u2029]", name):
            continue
        name = name.strip()
        if 0 < len(name) <= 80 and email in roster_emails and re.fullmatch(r"[^@\s<>]+@[^@\s<>]+", email):
            attendee_names.setdefault(email, name)
    if attendee_names:
        normalized["attendee_names"] = attendee_names
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
        return _GoogleCalendar(AuthorizedSession(delegated), calendar_ids)


class _GoogleCalendar:
    def __init__(self, session, calendar_ids):
        self.session = session
        self.calendar_ids = frozenset(calendar_ids)

    def list_events(self, calendar_id, time_min, time_max):
        if calendar_id not in self.calendar_ids:
            raise CalendarMeetingError("Select this calendar before reading events")
        path = "calendars/" + quote(calendar_id, safe="") + "/events"
        yield from self._items(path, {"timeMin": time_min, "timeMax": time_max, "singleEvents": "true",
                                      "orderBy": "startTime", "maxResults": 2500})

    def list_calendars(self):
        return self._items("users/me/calendarList", {"minAccessRole": "reader", "showHidden": "true",
            "fields": "nextPageToken,items(id,summary,summaryOverride,primary)"})

    def _items(self, path, params):
        seen = set()
        while True:
            try:
                response = self.session.get("https://www.googleapis.com/calendar/v3/" + path, params=params, timeout=20)
                if response.status_code in (401, 403, 404, 410):
                    transient = {"quotaExceeded", "rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded"}
                    errors = response.json().get("error", {}).get("errors", []) if response.status_code == 403 else []
                    if not any(error.get("reason") in transient for error in errors):
                        raise CalendarUnavailable("Google Calendar access is unavailable")
                response.raise_for_status()
                result = response.json()
            except CalendarUnavailable:
                raise
            except Exception:
                raise CalendarProviderError("Could not read Google Calendar; try again") from None
            yield from result.get("items", [])
            page = result.get("nextPageToken")
            if not page:
                break
            if page in seen:
                raise CalendarMeetingError("Invalid Google Calendar pagination")
            seen.add(page)
            params = {**params, "pageToken": page}


class CalendarMeetings:
    STATUSES = {"scheduled", "awaiting_consent", "dispatching", "requesting_entry",
                "awaiting_admission", "joined", "recording", "completed", "failed", "cancelled"}

    def __init__(self, store, calendar_factory, task_scheduler, bot_dispatcher, clock=None, *, grant_reader=None):
        self.store, self.calendar_factory = store, calendar_factory
        self.task_scheduler, self.bot_dispatcher = task_scheduler, bot_dispatcher
        self.clock = clock or (lambda: datetime.now(UTC))
        self.grant_reader = grant_reader

    def _key(self, owner):
        return "calendar/" + hashlib.sha256(owner.lower().encode()).hexdigest()

    def _load(self, owner):
        state, generation = self.store.load(self._key(owner))
        return (state or {"config": None, "events": {}}), generation

    def _save(self, owner, state, generation):
        return self.store.cas(self._key(owner), state, generation)

    def _calendar_client(self, owner, calendar_ids, owner_uid):
        if public_account_access():
            return self.calendar_factory(owner, calendar_ids, owner_uid)
        return self.calendar_factory(owner, calendar_ids)

    def grant_active(self, owner, config):
        if not public_account_access():
            return True
        expected = config.get("grant_id")
        return bool(expected and self.grant_reader and self.grant_reader(owner, config.get("owner_uid")) == expected)

    @staticmethod
    def _public_settings(config):
        return {k: v for k, v in config.items() if k not in {"owner_uid", "grant_id"}}

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

    def connect(self, claims, calendar_ids, *, grant_id=None):
        owner = owner_identity(claims)
        if not isinstance(calendar_ids, list) or not calendar_ids or len(calendar_ids) > 25:
            raise CalendarMeetingError("Explicitly select one or more calendars")
        if any(not isinstance(x, str) or not x.strip() or len(x) > 320 for x in calendar_ids):
            raise CalendarMeetingError("Invalid calendar selection")
        ids = list(dict.fromkeys(x.strip() for x in calendar_ids))
        def save(state):
            old = state.get("config") or {}
            self._verify_binding(state, claims)
            same_scope = old.get("enabled") is True and set(old.get("calendar_ids", [])) == set(ids)
            if public_account_access():
                selection = {"owner_uid": claims["sub"], "grant_id": grant_id}
                if not self.grant_active(owner, selection):
                    raise CalendarSelectionChanged("Calendar authorization changed. Connect again.")
                same_scope = same_scope and old.get("grant_id") == grant_id
            state["config"] = {"enabled": True, "calendar_ids": ids, "owner_uid": claims["sub"],
                "consent_mode": old.get("consent_mode", "ask") if same_scope else "ask",
                "scope_revision": old.get("scope_revision", "legacy") if same_scope else uuid4().hex}
            if public_account_access():
                state["config"]["grant_id"] = grant_id
                if not same_scope:
                    self._cancel_excluded(state, ())
            state["identity"] = {"owner_email": owner, "owner_uid": claims["sub"]}
            self._cancel_excluded(state, ids)
            return True, self._public_settings(state["config"])
        return self._mutate(owner, save)

    @staticmethod
    def _verify_binding(state, claims):
        for key in ("identity", "config"):
            bound = (state.get(key) or {}).get("owner_uid")
            if bound and bound != claims["sub"]:
                raise CalendarMeetingError("Calendar connection belongs to a different account identity")

    def sources(self, claims):
        owner = owner_identity(claims)
        state, _ = self._load(owner)
        self._verify_binding(state, claims)
        existing = (state.get("config") or {}).get("calendar_ids", [])
        client = self._calendar_client(owner, [], claims["sub"])
        sources = {}
        for raw in client.list_calendars():
            identifier = raw.get("id")
            if not isinstance(identifier, str) or not identifier or len(identifier) > 320:
                continue
            primary = raw.get("primary") is True
            if primary and ("primary" in existing or identifier not in existing):
                identifier = "primary"
            title = raw.get("summaryOverride") or raw.get("summary") or ("Work calendar" if primary else "Calendar")
            if not isinstance(title, str):
                continue
            sources[identifier] = {"id": identifier, "title": title, "primary": primary}
        return sorted(sources.values(), key=lambda item: (not item["primary"], item["title"].casefold()))

    @staticmethod
    def _cancel_excluded(state, calendar_ids):
        for event in state.get("events", {}).values():
            if event.get("calendar_id") not in calendar_ids and event.get("status") in {"scheduled", "awaiting_consent"}:
                event.update(status="cancelled", join_url="", passcode="", calendar_excluded=True)

    def set_consent_mode(self, claims, mode, participant_consent_attested=False, scope_revision=None):
        owner = owner_identity(claims)
        if mode not in {"ask", "approved"}:
            raise CalendarMeetingError("Consent mode must be ask or approved")
        if mode == "approved" and participant_consent_attested is not True:
            raise CalendarMeetingError("Standing consent requires explicit participant-consent attestation")
        def save(state):
            self._verify_binding(state, claims)
            config = state.get("config")
            if not config or config.get("enabled") is not True or not self.grant_active(owner, config):
                raise CalendarMeetingError("Connect calendars before changing consent settings")
            if mode == "approved" and scope_revision != config.get("scope_revision", "legacy"):
                raise CalendarSelectionChanged("Refresh calendar settings and confirm consent for the current selection")
            config["consent_mode"] = mode
            return True, None
        return self._mutate(owner, save)

    def settings(self, claims):
        owner = owner_identity(claims)
        state, _ = self._load(owner)
        self._verify_binding(state, claims)
        config = state.get("config")
        if not config:
            return None
        settings = {"scope_revision": "legacy", **self._public_settings(config)}
        if not self.grant_active(owner, config):
            settings.update(enabled=False, consent_mode="ask")
        return settings

    def disconnect(self, claims):
        owner = owner_identity(claims)
        def stop(state):
            self._verify_binding(state, claims)
            config = state.get("config")
            if not config:
                return False, {"enabled": False}
            config["enabled"] = False
            self._cancel_excluded(state, ())
            return True, {"enabled": False}
        return self._mutate(owner, stop)

    def sync(self, claims):
        owner = owner_identity(claims)
        state, _ = self._load(owner)
        self._verify_binding(state, claims)
        config = state.get("config")
        if not config or not config.get("enabled") or not config.get("calendar_ids") or not self.grant_active(owner, config):
            raise CalendarMeetingError("Connect and select calendars before syncing")
        client = self._calendar_client(owner, list(config["calendar_ids"]), claims["sub"])
        now = _now(self.clock())
        horizon = now + timedelta(hours=48)
        fetched, inaccessible = {}, set()
        for calendar_id in config["calendar_ids"]:
            current_events = {}
            try:
                for raw in client.list_events(calendar_id, now.isoformat(), horizon.isoformat()):
                    event = normalize_event(calendar_id, raw, owner, now)
                    if event and _parse_time({"dateTime": event["start"]}) <= horizon:
                        current_events[event["id"]] = event
            except CalendarUnavailable:
                inaccessible.add(calendar_id)
                continue
            fetched.update(current_events)
        def update(current):
            latest_config = current.get("config") or {}
            if (latest_config.get("enabled") is not True or latest_config.get("scope_revision") != config.get("scope_revision")
                    or latest_config.get("calendar_ids") != config["calendar_ids"]
                    or latest_config.get("owner_uid") != config.get("owner_uid")
                    or not self.grant_active(owner, latest_config)):
                raise CalendarSelectionChanged("Calendar selection changed during sync")
            self._cancel_excluded(current, set(config["calendar_ids"]) - inaccessible)
            scheduled = []
            current.setdefault("events", {})
            existing = current["events"]
            prune_before = now - timedelta(days=30)
            for identity, old in list(existing.items()):
                end = _parse_time({"dateTime": old.get("end", "")})
                if end and end < prune_before and not (public_account_access() and old.get("execution_id")):
                    del existing[identity]
            for identity, old in list(existing.items()):
                if old.get("calendar_id") in config["calendar_ids"] and _parse_time({"dateTime": old["start"]}) <= horizon:
                    if identity not in fetched and old["status"] in {"scheduled", "awaiting_consent"}:
                        old.update(status="cancelled", join_url="", passcode="")
            for identity, new in fetched.items():
                old = existing.get(identity)
                if old and old.get("status") == "cancelled" and not old.get("calendar_excluded"):
                    continue
                if old:
                    # The reply can change without the meeting itself changing.
                    if "response" in new: old["response"] = new["response"]
                    else: old.pop("response", None)
                if old and "desktop_occurrence_start" in new:
                    # Backfill calendars saved before desktop capture was coordinated.
                    old["desktop_occurrence_start"] = new["desktop_occurrence_start"]
                if old and old.get("status") in {"dispatching", "requesting_entry", "awaiting_admission", "joined", "recording", "completed", "failed"}:
                    continue
                changed = not old or old.get("calendar_excluded") or any(old.get(key) != new.get(key) for key in
                    ("start", "end", "join_url", "attendees", "ical_uid", "organizer_email", "participant_roster"))
                if changed:
                    new["status"] = "scheduled"
                    if old and old.get("calendar_excluded"):
                        # An ACKed task can retain its old name during the de-duplication window.
                        new["task_generation"] = uuid4().hex
                    elif old and old.get("task_generation"):
                        new["task_generation"] = old["task_generation"]
                    existing[identity] = new
                elif "attendee_names" in new:
                    old["attendee_names"] = new["attendee_names"]
                else:
                    old.pop("attendee_names", None)
                current_event = existing.get(identity)
                # Occurrences queued before early dispatch existed get one earlier
                # task; the original is ignored once the occurrence is attempted.
                if current_event and current_event.get("status") == "scheduled" and (
                        not current_event.get("task_name")
                        or current_event.get("task_lead") != DISPATCH_LEAD_SECONDS):
                    scheduled.append((identity, current_event["start"], current_event.get("task_generation")))
            return True, scheduled
        scheduled = self._mutate(owner, update)
        owner_hash = hashlib.sha256(owner.lower().encode()).hexdigest()
        for identity, start, task_generation in scheduled:
            try:
                result = self.task_scheduler.schedule(owner_hash, identity, start, task_generation)
                task_name = result if isinstance(result, str) else getattr(result, "name", "")
            except Exception:
                # A later sync retries only events whose idempotent task is still missing.
                continue
            if task_name:
                self._mutate(owner, lambda current: self._set_task(current, identity, task_name, task_generation))
        return len(fetched)

    @staticmethod
    def _set_task(state, identity, name, task_generation):
        event = state.get("events", {}).get(identity)
        if not event or event.get("status") != "scheduled" or event.get("task_generation") != task_generation:
            return False, None
        event["task_name"] = name
        event["task_lead"] = DISPATCH_LEAD_SECONDS
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
        # The meeting link itself stays on the server: this projection never carries it.
        if event.get("response"): public["response"] = event["response"]
        public["capture_provider"] = ("desktop" if event.get("capture_source") == "desktop" else
                                      "cloud" if event.get("execution_id") or event.get("attempted")
                                      or cloud_capture_enabled(owner, event.get("join_url")) else "desktop")
        return public

    def approve(self, claims, event_id):
        owner = owner_identity(claims)
        config, state, _ = self._get_config_state(owner)
        self._verify_binding(state, claims)
        if not config.get("enabled"):
            raise CalendarMeetingError("Calendar connection is disabled")
        now = _now(self.clock())
        current_state, _ = self._load(owner)
        target = current_state.get("events", {}).get(event_id)
        if target and not cloud_capture_enabled(owner, target.get("join_url")):
            raise CalendarMeetingError("Open Reel on your computer for desktop capture")
        if target:
            current = self._event_current(owner, config, target, now)
            if not current:
                self._mutate(owner, lambda state: self._cancel_event(state, event_id, target["occurrence_start"],
                             target.get("task_generation"), calendar_excluded=current is None))
                raise CalendarMeetingError("This calendar meeting changed or was cancelled")
        def reserve(current):
            latest_config = current.get("config") or {}
            event = current.get("events", {}).get(event_id)
            if not event or event.get("status") != "awaiting_consent":
                raise CalendarMeetingError("This meeting is no longer awaiting consent")
            if (not latest_config.get("enabled") or event.get("calendar_id") not in latest_config.get("calendar_ids", [])
                    or latest_config.get("consent_mode") != "ask"
                    or latest_config.get("scope_revision") != config.get("scope_revision")
                    or not self.grant_active(owner, latest_config)):
                raise CalendarMeetingError("Calendar settings changed before approval")
            if not cloud_capture_enabled(owner, event.get("join_url")):
                raise CalendarMeetingError("Open Reel on your computer for desktop capture")
            if not target or any(event.get(key) != target.get(key) for key in
                    ("join_url", "ical_uid", "organizer_email", "participant_roster", "task_generation")):
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

    def dispatch_callback(self, claims, event_id, occurrence_start, task_generation=None):
        owner = owner_identity(claims)
        config, state, _ = self._get_config_state(owner)
        self._verify_binding(state, claims)
        now = _now(self.clock())
        # Re-read the selected calendars at dispatch time so a stale task cannot join a
        # meeting that was cancelled or moved since the last sync.
        state, _ = self._load(owner)
        target = state.get("events", {}).get(event_id)
        if not target or target.get("occurrence_start") != occurrence_start or target.get("task_generation") != task_generation:
            return None
        current = self._event_current(owner, config, target, now)
        if not current:
            self._mutate(owner, lambda current_state: self._cancel_event(current_state, event_id, occurrence_start,
                         task_generation, calendar_excluded=current is None))
            return self._current_status(owner, event_id)
        def reserve(state):
            latest_config = state.get("config") or {}
            event = state.get("events", {}).get(event_id)
            if not event or event.get("occurrence_start") != occurrence_start or event.get("task_generation") != task_generation:
                return False, None
            if (event.get("status") != "scheduled" or event.get("attempted")
                    or not latest_config.get("enabled")
                    or event.get("calendar_id") not in latest_config.get("calendar_ids", [])
                    or _parse_time({"dateTime": event["start"]}) > now + timedelta(seconds=DISPATCH_LEAD_SECONDS + 30)):
                if (event.get("status") == "scheduled" and
                        (not latest_config.get("enabled") or event.get("calendar_id") not in latest_config.get("calendar_ids", []))):
                    event.update(status="cancelled", join_url="", passcode="")
                    return True, None
                return False, None
            if (latest_config.get("scope_revision") != config.get("scope_revision")
                    or not self.grant_active(owner, latest_config)):
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
        if public_account_access():
            config = state["config"]
            event.update(reservation_grant=config["grant_id"], reservation_scope=config["scope_revision"])
        for other in siblings:
            if other.get("status") in {"scheduled", "awaiting_consent"}:
                other.update(status="cancelled", join_url="", passcode="")
        return dict(event)

    def _get_config_state(self, owner):
        state, generation = self._load(owner)
        if not state.get("config"):
            raise CalendarMeetingError("No calendar connection")
        return state["config"], state, generation

    def _event_current(self, owner, config, target, now, *, verify_desktop_occurrence=False):
        calendar_id = target.get("calendar_id")
        if not config.get("enabled") or calendar_id not in config.get("calendar_ids", []):
            return False
        if not self.grant_active(owner, config):
            return None
        horizon = now + timedelta(hours=48)
        time_min = now - timedelta(minutes=10)
        try:
            client = self._calendar_client(owner, list(config["calendar_ids"]), config.get("owner_uid"))
            for raw in client.list_events(calendar_id, time_min.isoformat(), horizon.isoformat()):
                normalized = normalize_event(calendar_id, raw, owner, now)
                if (normalized and normalized["id"] == target.get("id")
                        and (not verify_desktop_occurrence or normalized.get("desktop_occurrence_start")
                             == target.get("desktop_occurrence_start"))
                        and all(normalized.get(key) == target.get(key) for key in
                            ("join_url", "ical_uid", "organizer_email", "participant_roster"))):
                    return True
        except CalendarUnavailable:
            return None
        return False

    @staticmethod
    def _cancel_event(state, event_id, occurrence_start, task_generation, *, calendar_excluded=False):
        event = state.get("events", {}).get(event_id)
        if (event and event.get("occurrence_start") == occurrence_start and event.get("task_generation") == task_generation
                and event.get("status") in {"scheduled", "awaiting_consent"}):
            event.update(status="cancelled", join_url="", passcode="")
            if calendar_excluded:
                event["calendar_excluded"] = True
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
                self._mutate(owner, lambda latest: self._cancel_event(latest, event["id"], event["occurrence_start"], event.get("task_generation")))
            return
        try:
            if public_account_access() and (current.get("reservation_scope") != config.get("scope_revision")
                    or current.get("reservation_grant") != config.get("grant_id")
                    or not self.grant_active(owner, config)):
                raise CalendarMeetingError("Meeting approval was revoked")
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


import json
import os
import sys
from datetime import UTC, datetime, timedelta

import pytest

sys.path.insert(0, os.path.dirname(__file__))
from calendar_meetings import CalendarMeetingError, CalendarMeetings, canonical_join_url, normalize_event, effective_cloud_providers


class FakeStore:
    def __init__(self):
        self.data = {}

    def load(self, key):
        row = self.data.get(key)
        return (None, 0) if row is None else (json.loads(json.dumps(row[0])), row[1])

    def cas(self, key, state, generation):
        actual = self.data.get(key, (None, 0))[1]
        if actual != generation:
            raise RuntimeError("CAS conflict")
        self.data[key] = (json.loads(json.dumps(state)), generation + 1)
        return generation + 1


class FakeCalendar:
    def __init__(self, items):
        self.items = items
        self.reads = []
        self.on_list = None

    def list_events(self, calendar_id, time_min, time_max):
        self.reads.append((calendar_id, time_min, time_max))
        if self.on_list:
            callback, self.on_list = self.on_list, None
            callback()
        yield from self.items.get(calendar_id, [])


class FakeScheduler:
    def __init__(self):
        self.tasks = []

    def schedule(self, owner_hash, event_id, occurrence_start):
        task = {"owner": owner_hash, "event": event_id, "start": occurrence_start}
        self.tasks.append(task)
        return f"task-{event_id[:8]}"


OWNER = "owner@example.com"
CLAIMS = {"sub": "uid-1", "email": OWNER, "email_verified": True}
NOW = datetime(2026, 10, 30, 10, tzinfo=UTC)


def event(start=None, **changes):
    start = start or NOW + timedelta(minutes=10)
    end = start + timedelta(minutes=30)
    item = {"id": "evt-1", "summary": "Planning", "status": "confirmed",
            "start": {"dateTime": start.isoformat()}, "end": {"dateTime": end.isoformat()},
            "organizer": {"email": OWNER}, "attendees": [{"email": OWNER, "responseStatus": "accepted"},
                {"email": "guest@example.com", "responseStatus": "accepted"}],
            "hangoutLink": "https://meet.google.com/abc-defg-hij"}
    item.update(changes)
    return item


@pytest.fixture
def setup(monkeypatch):
    monkeypatch.setenv("REEL_ALLOWED_EMAILS", OWNER)
    store, calendar, scheduler, joined = FakeStore(), FakeCalendar({"primary": [event()]}), FakeScheduler(), []
    clock = {"now": NOW}
    def factory(owner, calendar_ids):
        assert owner == OWNER
        assert calendar_ids == ["primary"]
        return calendar
    service = CalendarMeetings(store, factory, scheduler, lambda owner, data: joined.append((owner, data)) or "requesting_entry",
                               clock=lambda: clock["now"])
    return service, store, calendar, scheduler, joined, clock


def connect(service):
    return service.connect(CLAIMS, ["primary"])


def test_shared_invitation_metadata_is_private_and_keeps_complete_roster():
    normalized = normalize_event("primary", event(iCalUID="invitation@example.com",
        organizer={"email": "Organizer@Example.com"}), OWNER, NOW)
    assert normalized["ical_uid"] == "invitation@example.com"
    assert normalized["organizer_email"] == "organizer@example.com"
    assert normalized["participant_roster"] == sorted([OWNER, "guest@example.com", "organizer@example.com"])
    public = CalendarMeetings._public(normalized, OWNER)
    assert all(key not in public for key in ("ical_uid", "organizer_email", "participant_roster"))


@pytest.mark.parametrize("changes", [{"iCalUID": ""}, {"iCalUID": "x" * 1025},
    {"iCalUID": "bad\x7fuid"}, {"attendeesOmitted": True},
    {"attendees": [{"email": f"guest{i}@example.com"} for i in range(100)]},
    {"attendees": [{"email": "bad address@example.com"}]}])
def test_incomplete_or_invalid_invitation_identity_stays_owner_scoped(changes):
    raw = event(iCalUID="invitation@example.com")
    raw.update(changes)
    normalized = normalize_event("primary", raw, OWNER, NOW)
    assert normalized and "ical_uid" not in normalized


def test_connect_is_explicit_before_calendar_reads_and_sync_dedupes(setup):
    service, _, calendar, scheduler, _, _ = setup
    assert calendar.reads == []
    connect(service)
    assert service.sync(CLAIMS) == 1
    assert service.sync(CLAIMS) == 1
    assert len(calendar.reads) == 2 and len(scheduler.tasks) == 1
    assert scheduler.tasks[0]["start"] == (NOW + timedelta(minutes=10)).isoformat().replace("+00:00", "Z")


def test_due_callback_prompts_immediately_and_approval_dispatches_once(setup):
    service, _, _, scheduler, joined, clock = setup
    connect(service); service.sync(CLAIMS)
    item = scheduler.tasks[0]
    clock["now"] = NOW + timedelta(minutes=10)
    assert service.dispatch_callback(CLAIMS, item["event"], item["start"]) == "awaiting_consent"
    assert service.list_due(CLAIMS)[0]["status"] == "awaiting_consent"
    assert joined == []
    result = service.approve(CLAIMS, item["event"])
    assert result["status"] == "requesting_entry"
    with pytest.raises(CalendarMeetingError):
        service.approve(CLAIMS, item["event"])
    assert len(joined) == 1 and joined[0][1]["join_url"].startswith("https://meet.google.com/")


def test_early_approval_decline_and_wrong_occurrence_never_join(setup):
    service, _, _, scheduler, joined, clock = setup
    connect(service); service.sync(CLAIMS)
    task = scheduler.tasks[0]
    assert service.dispatch_callback(CLAIMS, task["event"], "wrong-occurrence") is None
    with pytest.raises(CalendarMeetingError):
        service.approve(CLAIMS, task["event"])
    clock["now"] += timedelta(minutes=10)
    service.dispatch_callback(CLAIMS, task["event"], task["start"])
    assert service.decline(CLAIMS, task["event"])["status"] == "cancelled"
    assert joined == []


def test_approved_mode_requires_attestation_and_dispatches_at_due_time(setup):
    service, _, _, scheduler, joined, clock = setup
    connect(service)
    with pytest.raises(CalendarMeetingError):
        service.set_consent_mode(CLAIMS, "approved")
    service.set_consent_mode(CLAIMS, "approved", participant_consent_attested=True)
    service.sync(CLAIMS)
    task = scheduler.tasks[0]
    assert service.dispatch_callback(CLAIMS, task["event"], task["start"]) == "scheduled"
    assert joined == []
    clock["now"] += timedelta(minutes=10)
    assert service.dispatch_callback(CLAIMS, task["event"], task["start"]) == "requesting_entry"
    assert len(joined) == 1


@pytest.mark.parametrize("rsvp", ["needsAction", "tentative", None])
def test_unanswered_or_tentative_invitation_schedules_and_joins_without_rsvp(setup, rsvp):
    service, _, calendar, scheduler, joined, clock = setup
    invitee = {"email": OWNER}
    if rsvp is not None:
        invitee["responseStatus"] = rsvp
    calendar.items["primary"] = [event(organizer={"email": "organizer@example.com"},
        attendees=[invitee, {"email": "guest@example.com", "responseStatus": "accepted"}])]
    connect(service)
    service.set_consent_mode(CLAIMS, "approved", participant_consent_attested=True)

    assert service.sync(CLAIMS) == 1
    assert len(scheduler.tasks) == 1
    task = scheduler.tasks[0]
    clock["now"] += timedelta(minutes=10)
    assert service.dispatch_callback(CLAIMS, task["event"], task["start"]) == "requesting_entry"
    assert len(joined) == 1


def test_declining_unanswered_invitation_after_scheduling_prevents_join(setup):
    service, _, calendar, scheduler, joined, clock = setup
    raw = event(organizer={"email": "organizer@example.com"},
        attendees=[{"email": OWNER, "responseStatus": "needsAction"}])
    calendar.items["primary"] = [raw]
    connect(service)
    service.set_consent_mode(CLAIMS, "approved", participant_consent_attested=True)
    assert service.sync(CLAIMS) == 1
    task = scheduler.tasks[0]

    raw["attendees"][0]["responseStatus"] = "declined"
    clock["now"] += timedelta(minutes=10)
    assert service.dispatch_callback(CLAIMS, task["event"], task["start"]) == "cancelled"
    assert joined == []


def test_desktop_provider_keeps_approved_occurrence_for_desktop_capture(setup, monkeypatch):
    import calendar_runtime

    service, store, _, scheduler, joined, clock = setup
    connect(service)
    service.set_consent_mode(CLAIMS, "approved", participant_consent_attested=True)
    service.sync(CLAIMS)
    task = scheduler.tasks[0]
    clock["now"] += timedelta(minutes=10)
    monkeypatch.setenv("MEETING_CAPTURE_PROVIDER", "desktop")
    service.bot_dispatcher = calendar_runtime.BotDispatcher(store)

    assert service.dispatch_callback(CLAIMS, task["event"], task["start"]) == "scheduled"
    assert service.dispatch_callback(CLAIMS, task["event"], task["start"]) == "scheduled"
    state, _ = store.load(service._key(OWNER))
    saved = state["events"][task["event"]]
    assert saved["attempted"] is False
    assert saved["join_url"] == "https://meet.google.com/abc-defg-hij"
    assert saved["passcode"] == ""
    assert joined == []


def test_private_cancelled_declined_all_day_and_unsupported_events_excluded(setup):
    service, _, calendar, scheduler, _, _ = setup
    declined = event(id="declined", attendees=[{"email": OWNER, "responseStatus": "declined"}])
    calendar.items["primary"] = [
        event(id="private", visibility="private"), event(id="cancelled", status="cancelled"),
        declined, event(id="all-day", start=NOW),
        event(id="unsafe", hangoutLink="http://meet.google.com/abc"),
        event(id="label", summary="[NO-REC] Private call"),
    ]
    calendar.items["primary"][-3]["start"] = {"date": "2026-10-30"}
    calendar.items["primary"].append(event(id="not-invited", organizer={"email": "organizer@example.com"},
        attendees=[{"email": "guest@example.com", "responseStatus": "accepted"}]))
    connect(service)
    assert service.sync(CLAIMS) == 0
    assert scheduler.tasks == []


def test_changed_and_cancelled_events_prevent_stale_callback(setup):
    service, store, calendar, scheduler, joined, clock = setup
    connect(service); service.sync(CLAIMS)
    first = scheduler.tasks[0]
    moved_start = NOW + timedelta(minutes=20)
    calendar.items["primary"] = [event(start=moved_start)]
    service.sync(CLAIMS)
    assert len(scheduler.tasks) == 2
    assert service.dispatch_callback(CLAIMS, first["event"], first["start"]) == "cancelled"
    moved = scheduler.tasks[1]
    clock["now"] = moved_start
    assert service.dispatch_callback(CLAIMS, moved["event"], moved["start"]) == "awaiting_consent"
    state, _ = store.load(service._key(OWNER))
    assert state["events"][moved["event"]]["status"] == "awaiting_consent"
    assert joined == []


def test_uncertain_dispatch_is_not_retried(setup):
    service, _, _, scheduler, _, clock = setup
    service.bot_dispatcher = lambda *_: (_ for _ in ()).throw(TimeoutError())
    connect(service); service.sync(CLAIMS)
    task = scheduler.tasks[0]
    clock["now"] += timedelta(minutes=10)
    assert service.dispatch_callback(CLAIMS, task["event"], task["start"]) == "awaiting_consent"
    assert service.approve(CLAIMS, task["event"])["status"] == "failed"
    with pytest.raises(CalendarMeetingError):
        service.approve(CLAIMS, task["event"])


@pytest.mark.parametrize("url", [
    "https://meet.google.com/profile", "https://meet.google.com.evil.test/abc-defg-hij",
    "https://zoom.com/j/123456789", "https://zoom.us/profile", "https://zoom.us/j/not-a-number",
    "https://foo.teams.microsoft.com/meet/123", "https://teams.microsoft.com/_#/calendar",
    "https://teams.live.com/other/123", "https://zoom.us./j/123456789",
    "https://meet.google.com/abc-defg-hij#redirect", "http://meet.google.com/abc-defg-hij",
])
def test_only_supported_provider_join_routes_are_accepted(url):
    assert canonical_join_url(url) is None


@pytest.mark.parametrize("url", [
    "https://meet.google.com/abc-defg-hij",
    "https://acme.zoom.us/j/12345678901?pwd=test-passcode",
    "https://app.zoom.us/wc/12345678901/join?pwd=x",
    "https://teams.microsoft.com/l/meetup-join/19%3ameeting_test%40thread.v2/0?context=%7B%7D",
    "https://teams.microsoft.com/meet/123456789?p=test-passcode",
    "https://teams.live.com/meet/123456789",
])
def test_supported_provider_urls_keep_the_original_query(url):
    result = canonical_join_url(url)
    assert result and result[0] == url


@pytest.mark.parametrize(("field", "value", "expected"), [
    ("location", "Join: https://meet.google.com/abc-defg-hij", "https://meet.google.com/abc-defg-hij"),
    ("description", '<a href="https://acme.zoom.us/j/12345678901?pwd=x&amp;src=invite">Join</a>',
     "https://acme.zoom.us/j/12345678901?pwd=x&src=invite"),
    ("description", "Teams: https://teams.microsoft.com/l/meetup-join/19%3ameeting_test%40thread.v2/0?context=%7B%7D",
     "https://teams.microsoft.com/l/meetup-join/19%3ameeting_test%40thread.v2/0?context=%7B%7D"),
])
def test_meeting_link_can_be_discovered_in_location_or_description(field, value, expected):
    candidate = event()
    candidate.pop("hangoutLink")
    candidate[field] = value
    normalized = normalize_event("primary", candidate, OWNER, NOW)
    assert normalized and normalized["join_url"] == expected


@pytest.mark.parametrize("description", [
    "Join https://meet.google.com.evil.test/abc-defg-hij",
    "Join https://meet.google.com/profile",
    "Join https://evil.test/redirect?next=https://meet.google.com/abc-defg-hij",
    "https://meet.google.com/abc-defg-hij and https://acme.zoom.us/j/123456789?pwd=second",
])
def test_text_link_discovery_rejects_deceptive_or_ambiguous_candidates(description):
    candidate = event()
    candidate.pop("hangoutLink")
    candidate["description"] = description
    assert normalize_event("primary", candidate, OWNER, NOW) is None


def test_explicit_conference_link_is_kept_when_text_sources_agree():
    candidate = event(location="Also https://meet.google.com/abc-defg-hij")
    normalized = normalize_event("primary", candidate, OWNER, NOW)
    assert normalized and normalized["join_url"] == "https://meet.google.com/abc-defg-hij"


def test_explicit_and_text_links_that_disagree_are_ambiguous():
    candidate = event(location="Also https://acme.zoom.us/j/123456789")
    assert normalize_event("primary", candidate, OWNER, NOW) is None


@pytest.mark.parametrize("provider_id", [None, "", "x" * 1025, "bad\nid"])
def test_provider_event_id_is_required_and_bounded(provider_id):
    candidate = event(id=provider_id)
    assert normalize_event("primary", candidate, OWNER, NOW) is None


def test_ongoing_meetings_remain_eligible_through_end_grace(setup):
    service, _, calendar, scheduler, joined, clock = setup
    ongoing_start = NOW - timedelta(minutes=20)
    calendar.items["primary"] = [event(start=ongoing_start)]
    connect(service); service.sync(CLAIMS)
    task = scheduler.tasks[0]
    clock["now"] = ongoing_start + timedelta(minutes=30)
    assert service.dispatch_callback(CLAIMS, task["event"], task["start"]) == "awaiting_consent"
    clock["now"] = ongoing_start + timedelta(minutes=40)
    assert service.approve(CLAIMS, task["event"])["status"] == "requesting_entry"
    assert len(joined) == 1


def test_cancelled_occurrence_is_a_tombstone_and_cannot_be_rescheduled(setup):
    service, store, calendar, scheduler, _, _ = setup
    connect(service); service.sync(CLAIMS)
    task = scheduler.tasks[0]
    calendar.items["primary"] = []
    service.sync(CLAIMS)
    calendar.items["primary"] = [event()]
    service.sync(CLAIMS)
    state, _ = store.load(service._key(OWNER))
    assert state["events"][task["event"]]["status"] == "cancelled"
    assert len(scheduler.tasks) == 1


def test_scheduler_failure_retries_only_the_missing_idempotent_task(setup):
    service, _, _, scheduler, _, _ = setup
    connect(service)
    real_schedule = scheduler.schedule
    calls = {"count": 0}
    def flaky(*args):
        calls["count"] += 1
        if calls["count"] == 1:
            raise RuntimeError("temporary task API failure")
        return real_schedule(*args)
    scheduler.schedule = flaky
    service.sync(CLAIMS)
    service.sync(CLAIMS)
    assert calls["count"] == 2 and len(scheduler.tasks) == 1


def test_disconnect_cancels_pending_events_and_status_confirmation_is_required(setup):
    service, _, _, scheduler, _, _ = setup
    connect(service); service.sync(CLAIMS)
    task = scheduler.tasks[0]
    assert service.disconnect(CLAIMS) == {"enabled": False}
    assert service.dispatch_callback(CLAIMS, task["event"], task["start"]) == "cancelled"
    with pytest.raises(CalendarMeetingError):
        service.update_provider_status(CLAIMS, task["event"], "joined")


@pytest.mark.parametrize("action", ["callback", "approval"])
def test_disconnect_during_freshness_read_wins_before_dispatch(setup, action):
    service, _, calendar, scheduler, joined, clock = setup
    connect(service); service.sync(CLAIMS)
    task = scheduler.tasks[0]
    clock["now"] += timedelta(minutes=10)
    if action == "approval":
        assert service.dispatch_callback(CLAIMS, task["event"], task["start"]) == "awaiting_consent"
    calendar.on_list = lambda: service.disconnect(CLAIMS)
    if action == "approval":
        with pytest.raises(CalendarMeetingError):
            service.approve(CLAIMS, task["event"])
    else:
        assert service.dispatch_callback(CLAIMS, task["event"], task["start"]) == "cancelled"
    assert joined == []



TEAMS_URL = "https://teams.microsoft.com/meet/123456789?p=private"


@pytest.mark.parametrize("mode", ["ask", "approved"])
@pytest.mark.parametrize("pilot,cloud_url", [("teams", TEAMS_URL), ("google_meet", "https://meet.google.com/abc-defg-hij")])
def test_hybrid_cloud_dispatches_once_and_other_providers_stay_unattempted(setup, monkeypatch, mode, pilot, cloud_url):
    service, store, calendar, scheduler, joined, clock = setup
    monkeypatch.setenv("MEETING_CAPTURE_PROVIDER", "desktop")
    monkeypatch.setenv("MEETING_CLOUD_PROVIDERS", pilot)
    calendar.items["primary"] = [event(id="teams", hangoutLink=cloud_url), event(id="meet", hangoutLink="https://teams.live.com/meet/999" if pilot == "google_meet" else "https://meet.google.com/abc-defg-hij"),
                                  event(id="zoom", hangoutLink="https://acme.zoom.us/j/123456789")]
    connect(service)
    service.set_consent_mode(CLAIMS, mode, participant_consent_attested=True)
    service.sync(CLAIMS)
    clock["now"] += timedelta(minutes=10)
    for task in scheduler.tasks:
        service.dispatch_callback(CLAIMS, task["event"], task["start"])
    state, _ = store.load(service._key(OWNER))
    teams = next(e for e in state["events"].values() if e["join_url"] == cloud_url)
    if mode == "ask":
        assert teams["status"] == "awaiting_consent"
        assert [e["id"] for e in service.list_due(CLAIMS)] == [teams["id"]]
        assert service.approve(CLAIMS, teams["id"])["status"] == "requesting_entry"
    for task in scheduler.tasks:
        service.dispatch_callback(CLAIMS, task["event"], task["start"])
    state, _ = store.load(service._key(OWNER))
    assert len(joined) == 1 and joined[0][1]["join_url"] == cloud_url
    for saved in state["events"].values():
        if saved["join_url"] != cloud_url:
            assert saved["status"] == "scheduled" and saved["attempted"] is False
            with pytest.raises(CalendarMeetingError, match="desktop"):
                service.approve(CLAIMS, saved["id"])
    assert {e["capture_provider"] for e in service.list_events(CLAIMS)} == {"cloud", "desktop"}


@pytest.mark.parametrize("providers,owners", [("unknown", ""), ("Teams", ""), ("teams:cloud", ""),
                                               ("teams", "someone@example.com"), ("meet", ""),
                                               ("Google_Meet", ""), ("google_meet", "someone@example.com")])
@pytest.mark.parametrize("cloud_url", [TEAMS_URL, "https://meet.google.com/abc-defg-hij"])
def test_hybrid_ineligible_provider_or_owner_never_prompts_or_reserves(setup, monkeypatch, providers, owners, cloud_url):
    service, store, calendar, scheduler, joined, clock = setup
    monkeypatch.setenv("MEETING_CAPTURE_PROVIDER", "desktop")
    monkeypatch.setenv("MEETING_CLOUD_PROVIDERS", providers)
    monkeypatch.setenv("MEETING_CLOUD_OWNER_EMAILS", owners)
    calendar.items["primary"] = [event(hangoutLink=cloud_url)]
    connect(service); service.sync(CLAIMS)
    clock["now"] += timedelta(minutes=10)
    task = scheduler.tasks[0]
    assert service.dispatch_callback(CLAIMS, task["event"], task["start"]) == "scheduled"
    state, _ = store.load(service._key(OWNER))
    assert state["events"][task["event"]]["attempted"] is False
    assert service.list_due(CLAIMS) == [] and joined == []


@pytest.mark.parametrize("change", ["cancel", "disconnect", "consent"])
@pytest.mark.parametrize("pilot,cloud_url", [("teams", TEAMS_URL), ("google_meet", "https://meet.google.com/abc-defg-hij")])
def test_hybrid_freshness_and_revoked_consent_win_before_dispatch(setup, monkeypatch, change, pilot, cloud_url):
    service, _, calendar, scheduler, joined, clock = setup
    monkeypatch.setenv("MEETING_CAPTURE_PROVIDER", "desktop")
    monkeypatch.setenv("MEETING_CLOUD_PROVIDERS", pilot)
    calendar.items["primary"] = [event(hangoutLink=cloud_url)]
    connect(service); service.sync(CLAIMS)
    task = scheduler.tasks[0]
    clock["now"] += timedelta(minutes=10)
    assert service.dispatch_callback(CLAIMS, task["event"], task["start"]) == "awaiting_consent"
    if change == "cancel":
        calendar.items["primary"] = []
    elif change == "disconnect":
        calendar.on_list = lambda: service.disconnect(CLAIMS)
    else:
        calendar.on_list = lambda: service.set_consent_mode(CLAIMS, "approved", True)
    with pytest.raises(CalendarMeetingError):
        service.approve(CLAIMS, task["event"])
    assert joined == []


@pytest.mark.parametrize("pilot,cloud_url", [("teams", TEAMS_URL), ("google_meet", "https://meet.google.com/abc-defg-hij")])
def test_hybrid_changed_provider_link_cannot_dispatch_stale_occurrence(setup, monkeypatch, pilot, cloud_url):
    service, _, calendar, scheduler, joined, clock = setup
    monkeypatch.setenv("MEETING_CAPTURE_PROVIDER", "desktop")
    monkeypatch.setenv("MEETING_CLOUD_PROVIDERS", pilot)
    calendar.items["primary"] = [event(hangoutLink=cloud_url)]
    connect(service); service.sync(CLAIMS)
    clock["now"] += timedelta(minutes=10)
    calendar.items["primary"] = [event(hangoutLink=TEAMS_URL if pilot == "google_meet" else "https://meet.google.com/abc-defg-hij")]
    task = scheduler.tasks[0]
    assert service.dispatch_callback(CLAIMS, task["event"], task["start"]) == "cancelled"
    assert joined == []


@pytest.mark.parametrize("mode", ["ask", "approved"])
@pytest.mark.parametrize("pilot,cloud_url", [("teams", TEAMS_URL), ("google_meet", "https://meet.google.com/abc-defg-hij")])
def test_selected_calendar_copies_share_one_cas_dispatch_attempt(setup, monkeypatch, mode, pilot, cloud_url):
    service, store, calendar, scheduler, joined, clock = setup
    monkeypatch.setenv("MEETING_CAPTURE_PROVIDER", "desktop")
    monkeypatch.setenv("MEETING_CLOUD_PROVIDERS", pilot)
    calendar.items = {
        "primary": [event(id="original", hangoutLink=cloud_url)],
        "shared": [event(id="copy", hangoutLink=cloud_url + ("&" if "?" in cloud_url else "?") + "source=shared",
                         attendees=[{"email": "copy-only@example.com"}])],
    }
    service.calendar_factory = lambda *_: calendar
    service.connect(CLAIMS, ["primary", "shared"])
    service.set_consent_mode(CLAIMS, mode, True)
    service.sync(CLAIMS)
    first, second = scheduler.tasks
    clock["now"] += timedelta(minutes=10)
    if mode == "ask":
        for task in (first, second):
            assert service.dispatch_callback(CLAIMS, task["event"], task["start"]) == "awaiting_consent"

    def dispatch(task):
        if mode == "ask":
            return service.approve(CLAIMS, task["event"])
        return service.dispatch_callback(CLAIMS, task["event"], task["start"])

    # The second copy reserves and dispatches after the first has read state but
    # before it can commit its reservation, forcing the first through CAS retry.
    real_cas = store.cas
    raced = []
    def racing_cas(key, state, generation):
        if not raced and state["events"][first["event"]].get("attempted"):
            raced.append(True)
            dispatch(second)
        return real_cas(key, state, generation)
    store.cas = racing_cas
    try:
        dispatch(first)
    except CalendarMeetingError as exc:
        assert mode == "ask" and "no longer awaiting consent" in str(exc)
    assert raced and len(joined) == 1
    assert joined[0][1]["id"] == second["event"]
    assert joined[0][1]["attendees"] == ["copy-only@example.com"]
    saved, _ = service._load(OWNER)
    suppressed = saved["events"][first["event"]]
    assert suppressed["status"] == "cancelled" and suppressed["attempted"] is False
    assert suppressed["join_url"] == suppressed["passcode"] == ""
    for task in (first, second):
        service.dispatch_callback(CLAIMS, task["event"], task["start"])
    assert len(joined) == 1

    # A copy discovered after reservation is suppressed by the due CAS, even
    # in ask mode; it must not linger as another consent prompt.
    calendar.items["shared"].append(event(id="late-copy", hangoutLink=cloud_url))
    service.sync(CLAIMS)
    late_copy = scheduler.tasks[-1]
    assert service.dispatch_callback(CLAIMS, late_copy["event"], late_copy["start"]) == "cancelled"
    assert len(joined) == 1 and service.list_due(CLAIMS) == []

    # The same provider link in a later occurrence keeps its own attempt.
    later = NOW + timedelta(hours=1)
    calendar.items["primary"].append(event(start=later, id="original", hangoutLink=cloud_url))
    service.sync(CLAIMS)
    next_task = scheduler.tasks[-1]
    assert next_task["start"] != first["start"]
    clock["now"] = later
    service.dispatch_callback(CLAIMS, next_task["event"], next_task["start"])
    if mode == "ask":
        service.approve(CLAIMS, next_task["event"])
    assert len(joined) == 2


@pytest.mark.parametrize("change", ["uid", "organizer", "roster"])
def test_distinct_complete_invitations_keep_separate_owner_attempts(setup, change):
    service, _, calendar, scheduler, joined, clock = setup
    first = event(id="first", iCalUID="first@example.com")
    second = event(id="second", iCalUID="first@example.com")
    if change == "uid":
        second["iCalUID"] = "second@example.com"
    elif change == "organizer":
        second["organizer"] = {"email": "other-organizer@example.com"}
    else:
        second["attendees"].append({"email": "another-person@example.com"})
    calendar.items = {"primary": [first], "shared": [second]}
    service.calendar_factory = lambda *_: calendar
    service.connect(CLAIMS, ["primary", "shared"])
    service.set_consent_mode(CLAIMS, "approved", True)
    service.sync(CLAIMS)
    clock["now"] += timedelta(minutes=10)
    for task in scheduler.tasks:
        service.dispatch_callback(CLAIMS, task["event"], task["start"])
    assert len(joined) == 2


def test_existing_legacy_attempt_still_suppresses_new_complete_copy(setup):
    service, _, calendar, scheduler, joined, clock = setup
    calendar.items = {"primary": [event(id="legacy")],
                      "shared": [event(id="complete", iCalUID="invitation@example.com")]}
    service.calendar_factory = lambda *_: calendar
    service.connect(CLAIMS, ["primary", "shared"])
    service.set_consent_mode(CLAIMS, "approved", True)
    service.sync(CLAIMS)
    clock["now"] += timedelta(minutes=10)
    for task in scheduler.tasks:
        service.dispatch_callback(CLAIMS, task["event"], task["start"])
    assert len(joined) == 1


@pytest.mark.parametrize("mode", ["ask", "approved"])
def test_reservation_rejects_roster_replaced_after_freshness_check(setup, mode):
    service, store, calendar, scheduler, joined, clock = setup
    calendar.items["primary"] = [event(iCalUID="invitation@example.com")]
    connect(service)
    service.set_consent_mode(CLAIMS, mode, True)
    service.sync(CLAIMS)
    clock["now"] += timedelta(minutes=10)
    task = scheduler.tasks[0]
    if mode == "ask":
        service.dispatch_callback(CLAIMS, task["event"], task["start"])
    original = service._event_current
    def replace_after_verification(owner, config, target, now):
        verified = original(owner, config, target, now)
        state, generation = service._load(owner)
        replacement = state["events"][target["id"]]
        replacement["participant_roster"] = sorted([OWNER, "unverified@example.com"])
        replacement["attendees"] = [OWNER, "unverified@example.com"]
        store.cas(service._key(owner), state, generation)
        return verified
    service._event_current = replace_after_verification
    with pytest.raises(CalendarMeetingError, match="changed"):
        if mode == "ask":
            service.approve(CLAIMS, task["event"])
        else:
            service.dispatch_callback(CLAIMS, task["event"], task["start"])
    assert joined == []
    service._event_current = original
    calendar.items["primary"][0]["attendees"] = [
        {"email": OWNER, "responseStatus": "accepted"}, {"email": "unverified@example.com"}]
    if mode == "ask":
        service.approve(CLAIMS, task["event"])
    else:
        service.dispatch_callback(CLAIMS, task["event"], task["start"])
    assert len(joined) == 1 and joined[0][1]["attendees"] == [OWNER, "unverified@example.com"]


def test_google_owner_filter_preserves_existing_teams_rollout(monkeypatch):
    monkeypatch.setenv("MEETING_CLOUD_PROVIDERS", "teams,google_meet")
    monkeypatch.setenv("MEETING_CLOUD_OWNER_EMAILS",
                       "shamanth@rocketshiphq.com,yakub@rocketshiphq.com,kartik@rocketshiphq.com")
    monkeypatch.setenv("MEETING_GOOGLE_CLOUD_OWNER_EMAILS", " SHAMANTH@rocketshiphq.com ")
    assert effective_cloud_providers("Shamanth@rocketshiphq.com") == ["teams", "google_meet"]
    for owner in ["yakub@rocketshiphq.com", "kartik@rocketshiphq.com"]:
        assert effective_cloud_providers(owner) == ["teams"]
    assert effective_cloud_providers("outsider@rocketshiphq.com") == []
    monkeypatch.delenv("MEETING_GOOGLE_CLOUD_OWNER_EMAILS")
    assert effective_cloud_providers("yakub@rocketshiphq.com") == ["teams", "google_meet"]

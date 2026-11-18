"""Regressions for organization policy across legacy cloud and speech routes."""
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from test_organization_access import AUTH, organization_service
from test_calendar_runtime import post, setup


@pytest.mark.parametrize("mode", [None, "independent"])
def test_domain_browser_join_requires_a_connected_calendar_in_every_mode(organization_service, monkeypatch, mode):
    import calendar_runtime as runtime
    client, _ = organization_service
    if mode is None:
        monkeypatch.delenv("MEETING_CAPTURE_PROVIDER", raising=False)
    else:
        monkeypatch.setenv("MEETING_CAPTURE_PROVIDER", mode)
    monkeypatch.setattr(runtime, "BotDispatcher", lambda _store: lambda *_args: {"status": "requesting_entry"})
    response = client.post("/calendar/browser", headers=AUTH, json={
        "meeting_url": "https://meet.google.com/abc-defg-hij", "participant_consent_attested": True})
    assert response.status_code == 400
    assert "connected Google Calendar" in response.json["error"]


@pytest.mark.parametrize("policy", ["provider", "owner", "google_owner"])
def test_default_cloud_mode_honors_provider_and_owner_restrictions(organization_service, monkeypatch, policy):
    from calendar_meetings import cloud_capture_enabled
    _, claims = organization_service
    monkeypatch.delenv("MEETING_CAPTURE_PROVIDER", raising=False)
    key, value = {
        "provider": ("MEETING_CLOUD_PROVIDERS", "teams"),
        "owner": ("MEETING_CLOUD_OWNER_EMAILS", "pilot@cedar.example"),
        "google_owner": ("MEETING_GOOGLE_CLOUD_OWNER_EMAILS", "pilot@cedar.example"),
    }[policy]
    monkeypatch.setenv(key, value)
    assert not cloud_capture_enabled(claims["email"], "https://meet.google.com/abc-defg-hij")


@pytest.mark.parametrize("meeting_url", ["https://meet.google.com/abc-defg-hij", "https://teams.microsoft.com/meet/123456789"])
def test_default_cloud_mode_joins_the_connected_occurrence_after_consent(organization_service, monkeypatch, meeting_url):
    import calendar_runtime as runtime
    client, claims = organization_service
    monkeypatch.delenv("MEETING_CAPTURE_PROVIDER", raising=False)
    now = datetime.now(UTC)
    event = {"id": "current-invitation", "iCalUID": "invitation@calendar.example", "summary": "Planning",
             "organizer": {"email": claims["email"]}, "location": meeting_url,
             "start": {"dateTime": (now - timedelta(seconds=1)).isoformat()},
             "end": {"dateTime": (now + timedelta(minutes=30)).isoformat()}}
    monkeypatch.setattr(runtime, "GoogleCalendarFactory", lambda: lambda *a: SimpleNamespace(list_events=lambda *a: [event]))
    monkeypatch.setattr(runtime, "CloudTasks", lambda: SimpleNamespace(schedule=lambda *a: "task"))
    dispatched = []
    monkeypatch.setattr(runtime, "BotDispatcher", lambda store: lambda owner, occurrence:
                        dispatched.append(occurrence) or "requesting_entry")
    connected = client.post("/calendar/connect", json={"calendar_ids": ["primary"]}, headers=AUTH)
    assert connected.status_code == 200 and dispatched == []
    response = client.post("/calendar/browser", json={"meeting_url": meeting_url,
        "participant_consent_attested": True}, headers=AUTH)
    assert response.status_code == 200
    assert response.json["status"] == "requesting_entry"
    assert len(dispatched) == 1
    assert response.json["id"] == connected.json["events"][0]["id"]


@pytest.mark.parametrize("speech_domain", [None, "elsewhere.example"])
def test_meeting_domain_does_not_grant_independent_speech_access(organization_service, monkeypatch, speech_domain):
    client, _ = organization_service
    if speech_domain is None:
        monkeypatch.delenv("REEL_SPEECH_ALLOWED_DOMAIN", raising=False)
    else:
        monkeypatch.setenv("REEL_SPEECH_ALLOWED_DOMAIN", speech_domain)
    assert client.post("/summary", json={}, headers=AUTH).status_code == 403
    assert client.post("/transcription", json={}, headers=AUTH).status_code == 403
    monkeypatch.setenv("REEL_SPEECH_ALLOWED_DOMAIN", "cedar.example")
    # Empty requests reach payload validation only after speech authorization.
    assert client.post("/summary", json={}, headers=AUTH).status_code == 400
    assert client.post("/transcription", json={}, headers=AUTH).status_code == 400


def test_calendar_sweep_resumes_after_an_owner_terminates_the_request(setup, monkeypatch):
    import calendar_runtime as runtime
    from google.oauth2 import id_token

    client, store, _, _, _ = setup
    owners = sorted((f"member-{i}@example.com" for i in range(3)), key=runtime.digest)
    monkeypatch.setenv("REEL_ALLOWED_EMAILS", ",".join(owners))
    account = "scheduler@example.iam.gserviceaccount.com"
    monkeypatch.setenv("INTERNAL_SERVICE_ACCOUNT", account)
    monkeypatch.setenv("MEETING_SERVICE_URL", "https://meetings.example.com")
    monkeypatch.setattr(id_token, "verify_oauth2_token", lambda *a, **k: {"email": account, "email_verified": True})
    monkeypatch.setattr(runtime, "reconcile_processing", lambda *a: (0, 0))
    store.prefix = "organization"
    for owner in owners:
        store.cas("calendar/" + runtime.digest(owner), {
            "identity": {"owner_email": owner, "owner_uid": owner + "-uid"},
            "config": {"enabled": True, "calendar_ids": ["primary"], "consent_mode": "ask"}}, 0)
    def list_blobs(prefix, start_offset="", max_results=None, **kwargs):
        names = sorted(f"{store.prefix}/{key}.json" for key in store.data)
        return [SimpleNamespace(name=name) for name in names if name.startswith(prefix)
                and name >= start_offset][:max_results]
    store.bucket = SimpleNamespace(list_blobs=list_blobs)
    attempts = []
    class WorkerTerminated(BaseException):
        pass
    def calendar_for_owner(owner, _ids):
        attempts.append(owner)
        if owner == owners[0]:
            raise WorkerTerminated()
        return SimpleNamespace(list_events=lambda *a: [])
    monkeypatch.setattr(runtime, "GoogleCalendarFactory", lambda: calendar_for_owner)
    with pytest.raises(WorkerTerminated):
        post(client, "/internal/calendar/sync", {})
    response = post(client, "/internal/calendar/sync", {})
    assert response.status_code == 200
    assert response.json["synced"] == 2
    assert attempts == owners

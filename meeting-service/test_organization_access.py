"""Organization-wide meeting access keeps account and consent boundaries."""
import pytest

from app import create_app
from test_app import FakeStore


@pytest.fixture
def organization_service(monkeypatch, tmp_path):
    import calendar_runtime
    from google.oauth2 import id_token

    for name, value in {
        "REEL_ORGANIZATION_DOMAIN": "cedar.example",
        "REEL_MEETING_ALLOWED_DOMAIN": "cedar.example",
        "REEL_FIREBASE_PROJECT": "demo-cedar",
        "REEL_ALLOWED_EMAILS": "pilot@cedar.example",
        "MEETING_CAPTURE_PROVIDER": "desktop",
        "MEETING_CLOUD_PROVIDERS": "teams,google_meet",
        "BOT_JOB_NAME": "projects/demo/locations/us-central1/jobs/reel",
        "BOT_BUCKET": "demo-private-recordings",
        "CALENDAR_TASK_QUEUE": "projects/demo/locations/us-central1/queues/start",
    }.items():
        monkeypatch.setenv(name, value)
    for name in ("MEETING_CLOUD_OWNER_EMAILS", "MEETING_GOOGLE_CLOUD_OWNER_EMAILS"):
        monkeypatch.delenv(name, raising=False)
    credentials = tmp_path / "calendar.json"
    credentials.write_text("{}")
    monkeypatch.setenv("GOOGLE_CALENDAR_CREDENTIALS", str(credentials))
    claims = {"sub": "new-member-uid", "email": "new-member@cedar.example", "email_verified": True,
              "iss": "https://securetoken.google.com/demo-cedar", "aud": "demo-cedar"}
    monkeypatch.setattr(id_token, "verify_firebase_token", lambda *args, **kwargs: dict(claims))

    class Calendar:
        def list_calendars(self):
            return [{"id": claims["email"], "primary": True}]

        def list_events(self, *args):
            return []

    monkeypatch.setattr(calendar_runtime, "GoogleCalendarFactory", lambda: lambda *args: Calendar())
    store = FakeStore()
    app = create_app(store=store)
    app.config["TEST_CALENDAR_STORE"] = store
    return app.test_client(), claims


AUTH = {"Authorization": "Bearer firebase"}


@pytest.mark.parametrize("domain", ["cedar.example", "north.example"])
def test_new_domain_member_can_connect_both_providers_without_a_pilot_entry(organization_service, monkeypatch, domain):
    client, claims = organization_service
    monkeypatch.setenv("REEL_ORGANIZATION_DOMAIN", domain)
    monkeypatch.setenv("REEL_MEETING_ALLOWED_DOMAIN", domain)
    claims["email"] = "new-member@" + domain
    response = client.get("/calendar/settings", headers=AUTH)
    assert response.status_code == 200
    assert response.json["config"] is None
    assert response.json["capabilities"]["calendar"] is True
    assert response.json["capabilities"]["cloud_providers"] == ["teams", "google_meet"]
    connected = client.post("/calendar/connect", json={"calendar_ids": ["primary"]}, headers=AUTH)
    assert connected.status_code == 200
    assert connected.json["config"]["enabled"] is True
    assert connected.json["config"]["consent_mode"] == "ask"
    assert client.post("/calendar/settings", json={"consent_mode": "approved"}, headers=AUTH).status_code == 400
    assert client.post("/calendar/settings", json={"consent_mode": "approved",
        "participant_consent_attested": True, "scope_revision": connected.json["config"]["scope_revision"]}, headers=AUTH).status_code == 200


@pytest.mark.parametrize("change, status", [
    ({"email": "outsider@elsewhere.example"}, 403),
    ({"email": "member@cedar.example.evil"}, 403),
    ({"email": "member@sub.cedar.example"}, 403),
    ({"email_verified": False}, 401),
    ({"sub": ""}, 401),
    ({"aud": "wrong-project"}, 401),
    ({"iss": "https://securetoken.google.com/wrong-project"}, 401),
])
def test_domain_access_still_requires_the_verified_deployment_identity(organization_service, change, status):
    client, claims = organization_service
    claims.update(change)
    response = client.get("/calendar/settings", headers=AUTH)
    assert response.status_code == status
    assert "config" not in response.json


@pytest.mark.parametrize("allowed_domain", ["", "elsewhere.example", "*.cedar.example"])
def test_domain_access_requires_an_exact_deployment_opt_in(organization_service, monkeypatch, allowed_domain):
    client, _ = organization_service
    monkeypatch.setenv("REEL_MEETING_ALLOWED_DOMAIN", allowed_domain)
    assert client.get("/calendar/settings", headers=AUTH).status_code == 403


def test_organization_access_does_not_share_one_members_index_with_another(organization_service):
    client, claims = organization_service
    entry = {"id": "b608b79b-f48c-42db-97bf-2dd8f9215058", "title": "Private call",
             "started_at": "2026-11-18T08:00:00Z", "duration_seconds": 60, "transcript_status": "pending"}
    assert client.post("/meetings", json=entry, headers=AUTH).status_code == 200
    assert len(client.get("/meetings", headers=AUTH).json["meetings"]) == 1
    claims.update(sub="another-member-uid", email="another-member@cedar.example")
    response = client.get("/meetings", headers=AUTH)
    assert response.status_code == 200
    assert response.json["meetings"] == []


@pytest.mark.parametrize("email", ["customer@gmail.com", "customer@outside.example"])
def test_public_verified_google_accounts_can_sign_up_without_org_delivery(organization_service, monkeypatch, email):
    client, claims = organization_service
    monkeypatch.setenv("REEL_ACCOUNT_ACCESS", "public")
    claims.update(email=email, firebase={
        "sign_in_provider": "google.com", "identities": {"google.com": ["123456"]},
    })
    assert client.get("/calendar/settings", headers=AUTH).json["capabilities"]["calendar_authorized"] is False
    assert client.get("/meetings", headers=AUTH).json["meetings"] == []
    assert client.post("/notion/deliver", json={}, headers=AUTH).status_code == 404
    assert client.post("/summary", json={}, headers=AUTH).status_code == 403
    claims["firebase"]["sign_in_provider"] = "password"
    assert client.get("/calendar/settings", headers=AUTH).status_code == 403


def test_public_calendar_start_and_callback_validate_origins_and_never_echo_codes(organization_service, monkeypatch):
    import public_calendar_oauth

    client, claims = organization_service
    monkeypatch.setenv("REEL_ACCOUNT_ACCESS", "public")
    monkeypatch.setenv("REEL_ALLOWED_ORIGINS", "https://public.example")
    claims.update(email="customer@gmail.com", firebase={
        "sign_in_provider": "google.com", "identities": {"google.com": ["123456"]},
    })
    calls = []

    class OAuth:
        def begin(self, owner, origin):
            calls.append((owner["sub"], origin))
            return "https://accounts.google.com/o/oauth2/v2/auth?state=temporary"

        def complete(self, state, code, error):
            calls.append((state, code, error))
            return "https://public.example", True

    monkeypatch.setattr(public_calendar_oauth, "PublicCalendarOAuth", lambda store: OAuth())
    start = "/calendar/oauth/start"
    callback = "/calendar/oauth/callback"
    assert client.post(start, json={}, headers={**AUTH, "Origin": "https://other.example"}).status_code == 403
    assert calls == []
    response = client.post(start, json={}, headers={**AUTH, "Origin": "https://public.example"})
    assert response.json["authorization_url"].startswith("https://accounts.google.com/")
    assert response.headers["Cache-Control"] == "no-store"
    assert client.get(callback).status_code == 405
    assert client.post(callback, data={"state": ["one", "two"]}).status_code == 400
    completed = client.post(callback, data={"state": "temporary", "code": "private-code"})
    assert completed.status_code == 303
    assert completed.headers["Location"] == "https://public.example/notetaker?calendar_oauth=connected"
    assert completed.headers["Referrer-Policy"] == "no-referrer"
    assert calls == [(claims["sub"], "https://public.example"), ("temporary", "private-code", None)]



def test_public_history_is_paginated_and_remains_private_after_disconnect(organization_service, monkeypatch):
    from calendar_runtime import digest

    client, claims = organization_service
    monkeypatch.setenv("REEL_ACCOUNT_ACCESS", "public")
    claims.update(email="customer@gmail.com", firebase={
        "sign_in_provider": "google.com", "identities": {"google.com": ["123456"]},
    })
    state = {"identity": {"owner_uid": claims["sub"]}, "config": {"enabled": False}, "events": {}}
    for day in range(1, 31):
        day_id = f"2026-01-{day:02}"
        state["events"][day_id] = {
            "id": day_id, "execution_id": day_id, "status": "completed",
            "start": day_id + "T15:00:00+00:00", "end": day_id + "T16:00:00+00:00",
        }
    client.application.config["TEST_CALENDAR_STORE"].cas("calendar/" + digest(claims["email"]), state, 0)
    first = client.get("/calendar/settings", headers=AUTH).json
    assert len(first["events"]) == 25
    assert first["events"][0]["id"] == "2026-01-30"
    page_url = "/calendar/meetings?history_before=" + first["next_history_before"]
    older = client.get(page_url, headers=AUTH).json
    assert [item["id"] for item in older["meetings"]] == [f"2026-01-{day:02}" for day in range(5, 0, -1)]
    assert older["next_history_before"] is None
    claims.update(email="other@gmail.com", sub="different-uid")
    assert client.get(page_url, headers=AUTH).status_code == 400
    assert client.get("/calendar/settings", headers=AUTH).json["events"] == []

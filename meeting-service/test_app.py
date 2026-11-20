import json
import uuid
from types import SimpleNamespace

import pytest
from google.api_core.exceptions import NotFound, PreconditionFailed

from app import BridgeError, GCSStateStore, NotionError, RejectedDelivery, create_app, verify_firebase


@pytest.mark.parametrize(("racing_error", "replacement_generation"), [
    (NotFound, 8),
    (PreconditionFailed, 8),
    (NotFound, None),
])
def test_gcs_load_reloads_a_fresh_blob_if_the_media_generation_changes(racing_error, replacement_generation):
    class Blob:
        generation = None

        def __init__(self, generation):
            self.version = generation

        def reload(self, **options):
            assert self.generation is None
            if self.version is None:
                raise NotFound("Object deleted")
            self.generation = self.version

        def download_as_bytes(self, *, if_generation_match, **options):
            assert if_generation_match == self.version
            if self.version == 7:
                raise racing_error("Generation replaced")
            return b'{"current": true}'

    pending = iter([Blob(7), Blob(replacement_generation)])
    store = object.__new__(GCSStateStore)
    store.prefix = "unit"
    store.bucket = SimpleNamespace(blob=lambda name: next(pending))

    expected = (None, 0) if replacement_generation is None else ({"current": True}, 8)
    assert store.load("calendar/fixture") == expected
    assert next(pending, None) is None


@pytest.mark.parametrize(("clock", "expected_options"), [
    (None, [{}, {}, {}, {}]),
    ([0, .75, 1.25, 2], [{"timeout": 1, "retry": None}, {"timeout": .75, "retry": None}]),
])
def test_gcs_load_bounds_generation_retries_and_keeps_existing_sweep_budget(monkeypatch, clock, expected_options):
    import app

    calls = []

    class StaleBlob:
        generation = 7

        def reload(self, **options):
            calls.append(options)

        def download_as_bytes(self, *, if_generation_match, **options):
            calls.append(options)
            raise NotFound("Generation replaced")

    store = object.__new__(GCSStateStore)
    store.prefix = ""
    store.bucket = SimpleNamespace(blob=lambda name: StaleBlob())
    if clock is not None:
        values = iter(clock)
        monkeypatch.setattr(app, "time", SimpleNamespace(monotonic=lambda: next(values)))

    with pytest.raises(BridgeError) as error:
        store.load("calendar/fixture", timeout=1 if clock else None)
    assert error.value.status == 503
    assert calls == expected_options


@pytest.fixture(autouse=True)
def organization_config(monkeypatch):
    monkeypatch.setenv("REEL_FIREBASE_PROJECT", "advisr-485ac")
    monkeypatch.setenv("REEL_ALLOWED_ORIGINS", "https://reel-rocketship.web.app,"
                       "https://reel-rocketship.firebaseapp.com,https://missioncontrol.rocketshiphq.com")


class FakeStore:
    def __init__(self):
        self.data = {}

    def for_sweep(self):
        return self

    def load(self, key, **kwargs):
        value = self.data.get(key)
        return (None, 0) if value is None else (json.loads(json.dumps(value[0])), value[1])

    def cas(self, key, state, generation, **kwargs):
        current = self.data.get(key)
        actual = current[1] if current else 0
        if actual != generation:
            raise RuntimeError("generation precondition failed")
        new_generation = generation + 1
        self.data[key] = (json.loads(json.dumps(state)), new_generation)
        return new_generation


class FakeSink:
    next_result = "ok"
    preflight_fails = False

    def __init__(self, token):
        self.calls = []
        self.token = token
        self.result = self.next_result

    def close(self):
        pass

    def preflight(self, payload, target):
        if self.preflight_fails:
            raise NotionError("schema unavailable")
        return ["prepared"]

    def deliver(self, payload, target, identity, attempted, prepared=None):
        self.calls.append((identity, target, attempted))
        if self.result == "rejected":
            raise RejectedDelivery("test")
        if self.result == "uncertain":
            from app import UncertainDelivery
            raise UncertainDelivery("test")
        return {"page_id": "page-1", "url": "https://notion.test/page-1"}


@pytest.fixture
def setup(monkeypatch):
    monkeypatch.setenv("REEL_ALLOWED_EMAILS", "owner@example.com")
    monkeypatch.setenv("NOTION_TOKEN", "test-token")
    monkeypatch.setenv("NOTION_DEFAULT_DATA_SOURCE_ID", "private-target")
    store = FakeStore()
    instances = []

    def factory(token):
        sink = FakeSink(token)
        instances.append(sink)
        return sink

    claims = {"sub": "firebase-uid", "email": "owner@example.com", "email_verified": True,
              "iss": "https://securetoken.google.com/advisr-485ac", "aud": "advisr-485ac"}
    app = create_app(auth_verifier=lambda _token: claims, store=store, sink_factory=factory)
    app.testing = True
    return app.test_client(), store, instances, claims


def meeting(**changes):
    result = {"id": str(uuid.uuid4()), "title": "Weekly planning", "started_at": "2026-10-29T10:00:00Z",
              "attendees": ["owner@example.com"], "summary": "Plan next week.",
              "segments": [{"start": 0, "end": 1.25, "text": "Let's begin."}]}
    result.update(changes)
    return result


def post(client, path, payload, token="valid"):
    return client.post(path, data=json.dumps(payload), content_type="application/json",
                       headers={"Authorization": f"Bearer {token}"})


def index_entry(**changes):
    result = {"id": str(uuid.uuid4()), "title": "Recorded call", "started_at": "2026-10-29T10:00:00Z",
              "duration_seconds": 75, "transcript_status": "pending"}
    result.update(changes)
    return result


def test_health_and_preview(setup):
    client, _, _, _ = setup
    assert client.get("/health").json == {"status": "ok"}
    assert post(client, "/notion/preview", meeting()).json == {"name": "Private calls", "kind": "private"}


def test_auth_required_and_allowlist(setup):
    client, _, _, claims = setup
    assert client.post("/notion/preview", json=meeting()).status_code == 401
    claims["email"] = "intruder@example.com"
    assert post(client, "/notion/preview", meeting()).status_code == 403


@pytest.mark.parametrize("claims", [
    {"iss": "https://securetoken.google.com/wrong", "aud": "advisr-485ac", "sub": "u", "email_verified": True},
    {"iss": "https://securetoken.google.com/advisr-485ac", "aud": "wrong", "sub": "u", "email_verified": True},
    {"iss": "https://securetoken.google.com/advisr-485ac", "aud": "advisr-485ac", "sub": "u", "email_verified": False, "email": "owner@example.com"},
])
def test_firebase_claim_validation(monkeypatch, claims):
    from google.oauth2 import id_token
    monkeypatch.setattr(id_token, "verify_firebase_token", lambda *args, **kwargs: claims)
    monkeypatch.setenv("REEL_ALLOWED_EMAILS", "owner@example.com")
    with pytest.raises(BridgeError):
        verify_firebase("token")


def test_firebase_verifier_receives_google_auth_transport(monkeypatch):
    from google.auth.transport.requests import Request as GoogleAuthRequest
    from google.oauth2 import id_token
    claims = {"iss": "https://securetoken.google.com/advisr-485ac", "aud": "advisr-485ac",
              "sub": "uid", "email_verified": True, "email": "owner@example.com"}
    observed = {}

    def verifier(token, auth_request, audience):
        observed.update(token=token, request=auth_request, audience=audience)
        return claims

    monkeypatch.setattr(id_token, "verify_firebase_token", verifier)
    monkeypatch.setenv("REEL_ALLOWED_EMAILS", "owner@example.com")
    assert verify_firebase("firebase-token") == claims
    assert isinstance(observed["request"], GoogleAuthRequest)
    assert callable(observed["request"])
    assert observed["audience"] == "advisr-485ac"


def test_second_organization_uses_configured_firebase_project_and_origins(monkeypatch):
    from google.oauth2 import id_token

    project = "cedar-meetings"
    origin = "https://meetings.cedar.example"
    owner = "owner@cedar.example"
    monkeypatch.setenv("REEL_ORGANIZATION_DOMAIN", "cedar.example")
    monkeypatch.setenv("REEL_FIREBASE_PROJECT", project)
    monkeypatch.setenv("REEL_ALLOWED_ORIGINS", origin)
    monkeypatch.setenv("REEL_ALLOWED_EMAILS", owner)
    claims = {"sub": "owner-uid", "email": owner, "email_verified": True,
              "iss": f"https://securetoken.google.com/{project}", "aud": project}
    audiences = []

    def verifier(token, auth_request, audience):
        audiences.append(audience)
        return claims

    monkeypatch.setattr(id_token, "verify_firebase_token", verifier)
    client = create_app(store=FakeStore()).test_client()
    assert client.get("/meetings", headers={"Authorization": "Bearer token"}).json == {"meetings": []}
    assert post(client, "/notion/preview", meeting()).status_code == 200
    assert audiences == [project, project]

    preflight = client.options("/meetings", headers={"Origin": origin})
    assert preflight.status_code == 204
    assert preflight.headers["Access-Control-Allow-Origin"] == origin
    for untrusted in (origin + ".evil", "https://reel-rocketship.web.app"):
        assert client.options("/meetings", headers={"Origin": untrusted}).status_code == 403

    claims["aud"] = "advisr-485ac"
    assert post(client, "/notion/preview", meeting()).status_code == 401
    claims["aud"] = project
    claims["iss"] = "https://securetoken.google.com/advisr-485ac"
    assert post(client, "/notion/preview", meeting()).status_code == 401

    monkeypatch.delenv("REEL_FIREBASE_PROJECT")
    monkeypatch.delenv("REEL_ALLOWED_ORIGINS")
    assert post(client, "/notion/preview", meeting()).status_code == 401
    assert client.options("/meetings", headers={"Origin": origin}).status_code == 403


def test_payload_limits_and_client_cannot_select_destination(setup):
    client, _, _, _ = setup
    assert post(client, "/notion/preview", meeting(target="attacker", token="x")).status_code == 400
    assert post(client, "/notion/preview", meeting(segments=[{"start": float("inf"), "end": 2, "text": "x"}])).status_code == 400
    assert post(client, "/notion/preview", meeting(id="not-a-uuid-00000000000000000000000")).status_code == 400
    big = meeting(summary="x" * (301 * 1024))
    assert post(client, "/notion/preview", big).status_code == 413


def test_delivery_duplicate_reconciles_without_second_create(setup):
    client, _, sinks, _ = setup
    payload = meeting()
    first = post(client, "/notion/deliver", payload)
    second = post(client, "/notion/deliver", payload)
    assert first.status_code == second.status_code == 200
    assert first.json["verified"] is True
    assert sinks[0].calls[0][1] == "private-target"
    assert sinks[1].calls[0][2] is True
    indexed = client.get("/meetings", headers={"Authorization": "Bearer valid"})
    record = indexed.json["meetings"][0]
    assert indexed.headers["Cache-Control"] == "no-store"
    assert record["id"] == payload["id"] and record["notion_verified"] is True
    updated = post(client, "/meetings", {"id": payload["id"], "title": "Renamed call",
        "started_at": payload["started_at"], "duration_seconds": 1.25, "transcript_status": "ready",
        "share_id": "a1b2c3d4e5f60789", "recording_source": "browser"})
    assert updated.status_code == 200
    updated_record = updated.json["meetings"][0]
    assert (updated_record["title"] == "Renamed call" and updated_record["notion_page_id"] == "page-1"
            and updated_record["share_id"] == "a1b2c3d4e5f60789"
            and updated_record["recording_source"] == "browser")
    assert post(client, "/notion/deliver", payload).status_code == 200
    reread = client.get("/meetings", headers={"Authorization": "Bearer valid"}).json["meetings"][0]
    assert reread["share_id"] == "a1b2c3d4e5f60789" and reread["recording_source"] == "browser"


def test_meeting_index_is_auth_scoped_and_delete_only_hides_metadata(setup):
    client, _, _, claims = setup
    entry = index_entry()
    assert client.get("/meetings").status_code == 401
    assert post(client, "/meetings", entry).status_code == 200
    assert client.get("/meetings", headers={"Authorization": "Bearer valid"}).json["meetings"][0]["id"] == entry["id"]
    claims["sub"] = "different-firebase-uid"
    assert client.get("/meetings", headers={"Authorization": "Bearer valid"}).json == {"meetings": []}
    assert client.delete(f"/meetings/{entry['id']}", headers={"Authorization": "Bearer valid"}).status_code == 404
    claims["sub"] = "firebase-uid"
    assert client.delete(f"/meetings/{entry['id']}", headers={"Authorization": "Bearer valid"}).status_code == 200
    assert client.get("/meetings", headers={"Authorization": "Bearer valid"}).json == {"meetings": []}


def test_meeting_index_rejects_receipt_fields_and_retries_index_cas(setup):
    client, store, _, _ = setup
    assert post(client, "/meetings", index_entry(notion_url="https://attacker.example")).status_code == 400
    assert post(client, "/meetings", index_entry(share_id="INVALID_share_id")).status_code == 400
    assert post(client, "/meetings", index_entry(recording_source="server")).status_code == 400
    valid_share = index_entry(share_id="0123456789abcdef")
    assert post(client, "/meetings", valid_share).status_code == 200
    original_cas = store.cas
    attempts = {"count": 0}

    def flaky_cas(key, state, generation):
        if key.startswith("index/") and attempts["count"] < 2:
            attempts["count"] += 1
            raise RuntimeError("index CAS race")
        return original_cas(key, state, generation)

    store.cas = flaky_cas
    response = post(client, "/meetings", index_entry())
    assert response.status_code == 200 and attempts["count"] == 2


def test_uncertain_retry_never_blind_creates(setup):
    client, _, sinks, _ = setup
    payload = meeting()
    FakeSink.next_result = "uncertain"
    first = post(client, "/notion/deliver", payload)
    second = post(client, "/notion/deliver", payload)
    FakeSink.next_result = "ok"
    assert first.status_code == second.status_code == 503
    assert sinks[1].calls[0][2] is True


def test_gcs_generation_race_fails_closed(setup):
    client, store, sinks, _ = setup
    store.cas = lambda *_args: (_ for _ in ()).throw(RuntimeError("race"))
    assert post(client, "/notion/deliver", meeting()).status_code == 503
    assert sinks[0].calls == []


def test_preflight_failure_does_not_reserve_and_rejected_same_body_can_retry(setup):
    client, store, _, _ = setup
    payload = meeting()
    FakeSink.preflight_fails = True
    response = post(client, "/notion/deliver", payload)
    FakeSink.preflight_fails = False
    assert response.status_code == 503
    assert store.data == {}

    FakeSink.next_result = "rejected"
    assert post(client, "/notion/deliver", payload).status_code == 422
    FakeSink.next_result = "ok"
    assert post(client, "/notion/deliver", payload).status_code == 200


def test_cors_origins_are_exact(setup, monkeypatch):
    client, _, _, _ = setup
    good = client.options("/notion/preview", headers={"Origin": "https://reel-rocketship.web.app"})
    bad = client.options("/notion/preview", headers={"Origin": "https://evil.example"})
    assert good.status_code == 204 and good.headers["Access-Control-Allow-Origin"] == "https://reel-rocketship.web.app"
    assert bad.status_code == 403
    local = client.options("/notion/preview", headers={"Origin": "http://localhost:3000"})
    assert local.status_code == 403
    mission_control = client.options("/meetings", headers={"Origin": "https://missioncontrol.rocketshiphq.com"})
    assert mission_control.status_code == 204
    monkeypatch.setenv("REEL_ALLOWED_ORIGINS", "http://localhost:3000")
    local = client.options("/notion/preview", headers={"Origin": "http://localhost:3000"})
    assert local.status_code == 204

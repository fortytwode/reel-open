import hashlib
import json
import uuid
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from app import create_app
from test_app import FakeStore
from calendar_runtime import BotDispatcher as RealBotDispatcher


@pytest.fixture
def setup(monkeypatch, tmp_path):
    import calendar_runtime as runtime
    claims = {"sub": "owner-uid", "email": "owner@example.com", "email_verified": True,
              "iss": "https://securetoken.google.com/advisr-485ac", "aud": "advisr-485ac"}
    monkeypatch.setenv("REEL_FIREBASE_PROJECT", "advisr-485ac")
    monkeypatch.setenv("REEL_ALLOWED_EMAILS", "owner@example.com,other@example.com")
    monkeypatch.setenv("BOT_JOB_NAME", "projects/test/locations/us-central1/jobs/bot")
    monkeypatch.setenv("BOT_BUCKET", "private-test-bucket")
    monkeypatch.setenv("CALENDAR_TASK_QUEUE", "projects/test/locations/us-central1/queues/start")
    credentials = tmp_path / "credentials.json"
    credentials.write_text("{}")
    monkeypatch.setenv("GOOGLE_CALENDAR_CREDENTIALS", str(credentials))
    calls, tasks = [], []
    now = datetime.now(UTC)
    event = {"id": "calendar-event", "summary": "QA meeting", "organizer": {"email": claims["email"]},
             "start": {"dateTime": (now - timedelta(seconds=1)).isoformat()},
             "end": {"dateTime": (now + timedelta(minutes=30)).isoformat()},
             "hangoutLink": "https://meet.google.com/abc-defg-hij"}

    class Calendar:
        def list_events(self, *args):
            return [event]

    class Scheduler:
        def schedule(self, *args):
            tasks.append(args)
            return "task"

    monkeypatch.setattr(runtime, "GoogleCalendarFactory", lambda: lambda *args: Calendar())
    monkeypatch.setattr(runtime, "CloudTasks", Scheduler)
    monkeypatch.setattr(runtime, "BotDispatcher", lambda store: lambda owner, event: calls.append((owner, event)) or "requesting_entry")
    store = FakeStore()
    client = create_app(auth_verifier=lambda _: dict(claims), store=store).test_client()
    return client, store, claims, calls, tasks


def post(client, path, body):
    return client.post(path, json=body, headers={"Authorization": "Bearer firebase"})


def test_explicit_connect_and_private_event_projection(setup):
    client, store, claims, calls, tasks = setup
    assert client.get("/calendar/settings").status_code == 401
    response = post(client, "/calendar/connect", {"calendar_ids": ["primary"]})
    assert response.status_code == 200
    assert len(tasks) == 1 and calls == []
    assert response.json["config"]["consent_mode"] == "ask"
    assert "join_url" not in json.dumps(response.json) and "abc-defg-hij" not in json.dumps(response.json)
    assert response.headers["Cache-Control"] == "no-store"
    key = "calendar/" + hashlib.sha256(claims["email"].encode()).hexdigest()
    assert store.load(key)[0]["identity"]["owner_uid"] == claims["sub"]


def test_new_uid_cannot_read_previous_calendar_for_same_email(setup):
    client, _, claims, _, _ = setup
    assert post(client, "/calendar/connect", {"calendar_ids": ["primary"]}).status_code == 200
    claims["sub"] = "replacement-account"
    response = client.get("/calendar/settings", headers={"Authorization": "Bearer firebase"})
    assert response.status_code == 400 and "events" not in response.json


def test_browser_request_requires_consent_and_duplicate_does_not_join_again(setup):
    client, _, claims, calls, _ = setup
    body = {"meeting_url": "https://meet.google.com/abc-defg-hij"}
    assert post(client, "/calendar/browser", body).status_code == 400
    body["participant_consent_attested"] = True
    first = post(client, "/calendar/browser", body)
    assert first.status_code == 200 and first.json["status"] == "requesting_entry"
    assert post(client, "/calendar/browser", body).json == first.json
    assert len(calls) == 1
    claims["email"], claims["sub"] = "other@example.com", "other-uid"
    assert post(client, "/calendar/browser", body).status_code == 200
    assert len(calls) == 2


def test_browser_bad_urls_and_standing_consent_rejected(setup):
    client, _, _, calls, _ = setup
    for url in ["https://meet.google.com.evil.test/abc-defg-hij", "https://secret@meet.google.com/abc-defg-hij",
                "http://meet.google.com/abc-defg-hij", "https://meet.google.com/other"]:
        assert post(client, "/calendar/browser", {"meeting_url": url, "participant_consent_attested": True}).status_code == 400
    post(client, "/calendar/connect", {"calendar_ids": ["primary"]})
    assert post(client, "/calendar/settings", {"consent_mode": "approved"}).status_code == 400
    assert calls == []


def test_uncertain_launch_cannot_start_second_browser_bot(setup, monkeypatch):
    import calendar_runtime as runtime
    client, _, _, calls, _ = setup
    def uncertain(owner, event):
        calls.append((owner, event))
        raise TimeoutError("response lost after job submission")
    monkeypatch.setattr(runtime, "BotDispatcher", lambda store: uncertain)
    body = {"meeting_url": "https://meet.google.com/abc-defg-hij", "participant_consent_attested": True}
    first = post(client, "/calendar/browser", body)
    assert first.status_code == 200 and first.json["status"] == "requesting_entry"
    assert post(client, "/calendar/browser", body).json == first.json
    assert len(calls) == 1


def test_artifact_and_notion_requests_never_cross_owner_boundaries(setup):
    client, store, claims, _, _ = setup
    first = post(client, "/calendar/browser", {"meeting_url": "https://meet.google.com/abc-defg-hij",
                                             "participant_consent_attested": True}).json
    path = "/calendar/meetings/" + first["id"]
    assert client.get(path + "/artifacts/video").status_code == 401
    execution = str(uuid.uuid4())
    key = "calendar/" + hashlib.sha256(claims["email"].encode()).hexdigest()
    state, generation = store.load(key)
    state["events"][first["id"]]["execution_id"] = execution
    store.cas(key, state, generation)
    store.cas("executions/" + execution, {"owner_id": "different-owner", "artifacts": {"recording.mp4": True}}, 0)
    assert client.get(path + "/artifacts/video", headers={"Authorization": "Bearer firebase"}).status_code == 400
    assert post(client, path + "/notion", {}).status_code == 400


def test_internal_routes_reject_firebase_identity(setup):
    client, _, _, calls, _ = setup
    for path in ["/internal/calendar/due", "/internal/calendar/sync"]:
        assert post(client, path, {}).status_code == 403
    assert calls == []


def test_calendar_sync_reaches_every_connected_owner_and_wraps(setup, monkeypatch):
    import calendar_runtime as runtime
    from google.oauth2 import id_token

    client, store, _, dispatches, tasks = setup
    owners = sorted((f"owner-{i}@example.com" for i in range(30)), key=runtime.digest)
    disabled, failing, *healthy = owners
    monkeypatch.setenv("REEL_ALLOWED_EMAILS", ",".join(owners))
    account = "scheduler@example.iam.gserviceaccount.com"
    monkeypatch.setenv("INTERNAL_SERVICE_ACCOUNT", account)
    monkeypatch.setenv("MEETING_SERVICE_URL", "https://meeting-service.example.com")
    monkeypatch.setattr(id_token, "verify_oauth2_token",
                        lambda *args, **kwargs: {"email": account, "email_verified": True})
    monkeypatch.setattr(runtime, "reconcile_processing", lambda *args: (2, 1))
    store.prefix = "organization"
    for owner in owners:
        store.cas("calendar/" + runtime.digest(owner), {
            "identity": {"owner_email": owner, "owner_uid": owner + "-uid"},
            "config": {"enabled": owner != disabled, "calendar_ids": ["primary"], "consent_mode": "ask"},
        }, 0)

    def list_blobs(prefix, start_offset="", max_results=None, **kwargs):
        names = sorted(f"{store.prefix}/{key}.json" for key in store.data)
        return [SimpleNamespace(name=name) for name in names if name.startswith(prefix)
                and name >= start_offset][:max_results]

    attempts = []
    start = datetime.now(UTC) + timedelta(minutes=5)

    def calendar_for_owner(owner, _calendar_ids):
        attempts.append(owner)
        if owner == failing:
            raise RuntimeError("Calendar unavailable for this owner")
        return SimpleNamespace(list_events=lambda *args: [{
            "id": "meeting", "summary": "Planning", "organizer": {"email": owner},
            "start": {"dateTime": start.isoformat()},
            "end": {"dateTime": (start + timedelta(minutes=30)).isoformat()},
            "hangoutLink": "https://meet.google.com/abc-defg-hij",
        }])

    store.bucket = SimpleNamespace(list_blobs=list_blobs)
    monkeypatch.setattr(runtime, "GoogleCalendarFactory", lambda: calendar_for_owner)
    first = post(client, "/internal/calendar/sync", {})
    second = post(client, "/internal/calendar/sync", {})
    assert first.status_code == second.status_code == 200
    assert attempts == [failing, *healthy]
    assert first.json == {"synced": 23, "failed": 1, "processing_queued": 2, "processing_failed": 1}
    assert second.json == {"synced": 5, "failed": 0, "processing_queued": 2, "processing_failed": 1}
    assert {owner_hash for owner_hash, *_ in tasks} == {runtime.digest(owner) for owner in healthy}
    assert dispatches == []

    attempts.clear()
    third = post(client, "/internal/calendar/sync", {})
    assert third.json == first.json
    assert attempts == [failing, *healthy[:23]]


def test_execution_callback_checks_token_owner_sequence_and_terminal_state(setup):
    client, store, claims, _, _ = setup
    execution, token = str(uuid.uuid4()), "x" * 64
    key = "executions/" + execution
    store.cas(key, {"execution_id": execution, "owner_id": claims["sub"], "owner_email": claims["email"],
        "event_id": "missing", "callback_hash": hashlib.sha256(token.encode()).hexdigest(),
        "created_at": datetime.now(UTC).isoformat(), "status": "requesting_entry"}, 0)
    body = {"execution_id": execution, "owner_id": claims["sub"], "status": "joined", "sequence": 2}
    def callback(body, auth=token):
        return client.post("/internal/bot/status", json=body, headers={"Authorization": "Bearer " + auth})
    assert callback(body, "wrong").status_code == 403
    assert callback({**body, "owner_id": "other"}).status_code == 403
    assert callback(body).json["status"] == "joined"
    assert callback({**body, "status": "awaiting_admission", "sequence": 1}).json["status"] == "joined"
    assert callback({**body, "status": "failed", "sequence": 3}).json["status"] == "failed"
    assert callback({**body, "status": "recording", "sequence": 4}).json["status"] == "failed"


def test_desktop_feed_is_owner_only_and_private(setup, monkeypatch):
    monkeypatch.setenv("MEETING_CAPTURE_PROVIDER", "desktop")
    client, _, claims, _, _ = setup
    post(client, "/calendar/connect", {"calendar_ids": ["primary"]})
    assert client.get("/calendar/desktop").status_code == 401
    response = client.get("/calendar/desktop", headers={"Authorization": "Bearer firebase"})
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    assert response.json["events"][0]["join_url"] == "https://meet.google.com/abc-defg-hij"
    claims["sub"] = "new-identity"
    assert client.get("/calendar/desktop", headers={"Authorization": "Bearer firebase"}).status_code == 400


def test_desktop_state_requires_consent_owner_and_available_occurrence(setup, monkeypatch):
    monkeypatch.setenv("MEETING_CAPTURE_PROVIDER", "desktop")
    client, store, claims, calls, _ = setup
    connected = post(client, "/calendar/connect", {"calendar_ids": ["primary"]}).json
    event_id = connected["events"][0]["id"]
    path = "/calendar/desktop/" + event_id + "/state"
    assert post(client, path, {"state": "joined"}).status_code == 400
    body = {"state": "joined", "participant_consent_attested": True}
    assert post(client, path, body).json["status"] == "joined"
    assert calls == []
    claims["sub"] = "new-identity"
    assert post(client, path, body).status_code == 400
    claims["sub"] = "owner-uid"
    key = "calendar/" + hashlib.sha256(claims["email"].encode()).hexdigest()
    for field, value in [("status", "cancelled"), ("execution_id", str(uuid.uuid4()))]:
        state, generation = store.load(key)
        state["events"][event_id]["status"] = "scheduled"
        state["events"][event_id][field] = value
        store.cas(key, state, generation)
        assert post(client, path, body).status_code == 400


def test_desktop_provider_disables_cloud_dispatch(setup, monkeypatch):
    client, _, _, calls, _ = setup
    monkeypatch.setenv("MEETING_CAPTURE_PROVIDER", "desktop")
    connected = post(client, "/calendar/connect", {"calendar_ids": ["primary"]})
    assert connected.json["capabilities"]["provider"] == "desktop"
    assert connected.json["capabilities"]["bot"] is False
    assert post(client, "/calendar/browser", {"meeting_url": "https://meet.google.com/abc-defg-hij",
        "participant_consent_attested": True}).status_code == 503
    assert calls == []


@pytest.mark.parametrize("hybrid", [False, True])
@pytest.mark.parametrize("event_minutes", [1.5, 240])
def test_dispatcher_emits_teams_compatible_display_name(monkeypatch, hybrid, event_minutes):
    import re
    import calendar_runtime as runtime
    from google.cloud import storage
    from test_app import FakeStore

    monkeypatch.delenv("MEETING_CAPTURE_PROVIDER", raising=False)
    if hybrid:
        monkeypatch.setenv("MEETING_CAPTURE_PROVIDER", "desktop")
        monkeypatch.setenv("MEETING_CLOUD_PROVIDERS", "teams")
    monkeypatch.setenv("BOT_JOB_NAME", "projects/test/locations/us-central1/jobs/bot")
    monkeypatch.setenv("BOT_BUCKET", "private-test-bucket")
    monkeypatch.setenv("MEETING_SERVICE_URL", "https://meeting.example")
    owner, owner_uid = "owner@example.com", "owner-uid"
    dispatch_now = datetime(2026, 11, 17, 14, 2, 51, tzinfo=UTC)
    store = FakeStore()
    event = {"id": "qa-event", "title": "QA meeting", "start": dispatch_now.isoformat(),
             "end": (dispatch_now + timedelta(minutes=event_minutes)).isoformat(),
             "join_url": "https://teams.microsoft.com/l/meetup-join/qa/0", "attendees": [owner], "calendar_id": "primary", "attempted": True, "status": "dispatching"}
    store.cas("calendar/" + runtime.digest(owner), {
        "identity": {"owner_uid": owner_uid}, "config": {"enabled": True, "calendar_ids": ["primary"]}, "events": {event["id"]: event}}, 0)
    uploaded = []

    class Blob:
        def upload_from_string(self, value, **kwargs):
            uploaded.append(json.loads(value))

    class Bucket:
        def blob(self, path):
            return Blob()

    class StorageClient:
        def bucket(self, name):
            return Bucket()

    monkeypatch.setattr(storage, "Client", StorageClient)

    class Response:
        status_code = 200
        def raise_for_status(self): pass
        def json(self): return {"name": "operation"}

    class Session:
        def post(self, *args, **kwargs): return Response()

    monkeypatch.setattr(runtime, "cloud_session", lambda: Session())
    runtime.BotDispatcher(store, clock=lambda: dispatch_now)(owner, event)

    assert uploaded[0]["capture_deadline"] == (dispatch_now + timedelta(minutes=min(event_minutes + 5, 180))).isoformat()
    assert uploaded[0]["max_duration_seconds"] == min((event_minutes + 5) * 60, 10800)
    display_name = uploaded[0]["display_name"]
    assert display_name == "Reel Notetaker - recording"
    assert re.fullmatch(r"[A-Za-z0-9 '._@-]+", display_name)


def test_completed_callback_requires_exact_audio_and_queues_before_ack(setup, monkeypatch):
    import calendar_runtime as runtime
    client, store, claims, _, _ = setup
    execution, token = str(uuid.uuid4()), 'x' * 64
    key = 'executions/' + execution
    store.cas(key, {'execution_id': execution, 'owner_id': claims['sub'], 'owner_email': claims['email'],
        'event_id': 'event', 'callback_hash': hashlib.sha256(token.encode()).hexdigest(),
        'created_at': datetime.now(UTC).isoformat(), 'status': 'recording',
        'output_bucket': 'private-test-bucket', 'output_prefix': 'private/' + execution + '/'}, 0)
    calls = []
    monkeypatch.setattr(runtime, 'bind_audio_generation', lambda record: 123, raising=False)
    monkeypatch.setattr(runtime.CloudTasks, 'schedule_processing', lambda self, identity: calls.append(identity), raising=False)
    body = {'execution_id': execution, 'owner_id': claims['sub'], 'status': 'completed', 'sequence': 3,
            'artifacts': {'system-audio.wav': {'gcs_uri': 'gs://private-test-bucket/private/' + execution + '/system-audio.wav'}}}
    response = client.post('/internal/bot/status', json=body, headers={'Authorization': 'Bearer ' + token})
    assert response.status_code == 200
    assert calls == [execution]
    record, _ = store.load(key)
    assert record['audio_generation'] == 123


def test_completed_callback_rejects_other_artifact_and_replay_keeps_generation(setup, monkeypatch):
    import calendar_runtime as runtime
    client, store, claims, _, _ = setup
    execution, token = str(uuid.uuid4()), 'x' * 64
    prefix = 'private/' + execution + '/'
    key = 'executions/' + execution
    store.cas(key, {'execution_id': execution, 'owner_id': claims['sub'], 'owner_email': claims['email'],
        'event_id': 'event', 'callback_hash': hashlib.sha256(token.encode()).hexdigest(),
        'created_at': datetime.now(UTC).isoformat(), 'status': 'recording',
        'output_bucket': 'private-test-bucket', 'output_prefix': prefix}, 0)
    bindings, scheduled = [], []
    monkeypatch.setattr(runtime, 'bind_audio_generation', lambda record: bindings.append(1) or 17)
    monkeypatch.setattr(runtime.CloudTasks, 'schedule_processing', lambda self, identity: scheduled.append(identity), raising=False)
    body = {'execution_id': execution, 'owner_id': claims['sub'], 'status': 'completed', 'sequence': 3,
            'artifacts': {'system-audio.wav': {'gcs_uri': 'gs://private-test-bucket/other/system-audio.wav'}}}
    def callback():
        return client.post('/internal/bot/status', json=body, headers={'Authorization': 'Bearer ' + token})
    assert callback().status_code == 400
    assert bindings == [] and scheduled == []
    body['artifacts']['system-audio.wav']['gcs_uri'] = 'gs://private-test-bucket/' + prefix + 'system-audio.wav'
    assert callback().status_code == 200
    assert callback().status_code == 200
    assert bindings == [1] and scheduled == [execution, execution]
    assert store.load(key)[0]['audio_generation'] == 17


def test_processing_endpoint_rejects_untrusted_and_extra_identity(setup, monkeypatch):
    client, _, _, _, _ = setup
    assert post(client, '/internal/bot/process', {'execution_id': str(uuid.uuid4())}).status_code == 403


def test_callback_replay_cannot_erase_or_invent_transcript_artifacts(setup, monkeypatch):
    import calendar_runtime as runtime
    client, store, claims, _, _ = setup
    execution, token = str(uuid.uuid4()), 'x' * 64
    prefix = 'private/' + execution + '/'
    key = 'executions/' + execution
    store.cas(key, {'execution_id': execution, 'owner_id': claims['sub'], 'owner_email': claims['email'],
        'event_id': 'event', 'callback_hash': hashlib.sha256(token.encode()).hexdigest(),
        'created_at': datetime.now(UTC).isoformat(), 'status': 'completed', 'sequence': 3,
        'audio_generation': 17, 'artifacts': {'transcript.txt': True},
        'output_bucket': 'private-test-bucket', 'output_prefix': prefix}, 0)
    monkeypatch.setattr(runtime.CloudTasks, 'schedule_processing', lambda self, identity: None, raising=False)
    uri = 'gs://private-test-bucket/' + prefix
    body = {'execution_id': execution, 'owner_id': claims['sub'], 'status': 'completed', 'sequence': 3,
            'artifacts': {'system-audio.wav': {'gcs_uri': uri + 'system-audio.wav'},
                          'summary.json': {'gcs_uri': uri + 'summary.json'}}}
    assert client.post('/internal/bot/status', json=body, headers={'Authorization': 'Bearer ' + token}).status_code == 200
    assert store.load(key)[0]['artifacts'] == {'transcript.txt': True, 'system-audio.wav': True}


def test_processing_uses_separate_retry_queue(monkeypatch):
    import calendar_runtime as runtime
    monkeypatch.setenv('CALENDAR_TASK_QUEUE', 'projects/test/locations/us-central1/queues/three-attempt-joins')
    monkeypatch.setenv('PROCESSING_TASK_QUEUE', 'projects/test/locations/us-central1/queues/durable-processing')
    monkeypatch.setenv('MEETING_SERVICE_URL', 'https://meeting.example')
    monkeypatch.setenv('INTERNAL_SERVICE_ACCOUNT', 'task@example.iam.gserviceaccount.com')
    class Response:
        def raise_for_status(self): pass
        def json(self): return {'name': 'created'}
    calls = []
    class Session:
        def post(self, url, **kwargs):
            calls.append((url, kwargs['json']['task']))
            return Response()
    monkeypatch.setattr(runtime, 'cloud_session', lambda: Session())
    runtime.CloudTasks().schedule_processing(str(uuid.uuid4()))
    assert '/queues/durable-processing/tasks' in calls[0][0]
    assert 'name' not in calls[0][1]
    assert calls[0][1]['dispatchDeadline'] == '600s'


def test_callback_outage_is_reconciled_from_persisted_outbox(setup, monkeypatch):
    import calendar_runtime as runtime
    import types
    client, store, claims, _, _ = setup
    execution, token = str(uuid.uuid4()), 'x' * 64
    key = 'executions/' + execution
    store.cas(key, {'execution_id': execution, 'owner_id': claims['sub'], 'owner_email': claims['email'],
        'event_id': 'event', 'callback_hash': hashlib.sha256(token.encode()).hexdigest(),
        'created_at': datetime.now(UTC).isoformat(), 'status': 'recording',
        'output_bucket': 'private-test-bucket', 'output_prefix': 'private/' + execution + '/'}, 0)
    monkeypatch.setattr(runtime, 'bind_audio_generation', lambda record: 5)
    monkeypatch.setattr(runtime.CloudTasks, 'schedule_processing', lambda *args: (_ for _ in ()).throw(RuntimeError('unavailable')), raising=False)
    body = {'execution_id': execution, 'owner_id': claims['sub'], 'status': 'completed', 'sequence': 3,
            'artifacts': {'system-audio.wav': {'gcs_uri': 'gs://private-test-bucket/private/' + execution + '/system-audio.wav'}}}
    for _ in range(3):
        assert client.post('/internal/bot/status', json=body, headers={'Authorization': 'Bearer ' + token}).status_code == 500
    assert store.load(key)[0]['processing_enqueue_needed'] is True
    store.prefix = ''
    store.bucket = types.SimpleNamespace(list_blobs=lambda prefix, **kwargs: [types.SimpleNamespace(name=key + '.json')])
    queued = []
    scheduler = types.SimpleNamespace(schedule_processing=lambda value, **kwargs: queued.append(value))
    assert runtime.reconcile_processing(store, scheduler) == (1, 0)
    assert queued == [execution] and store.load(key)[0]['processing_enqueue_needed'] is False


def test_terminal_callback_replay_keeps_artifacts_and_never_enqueues(setup, monkeypatch):
    import calendar_runtime as runtime
    client, store, claims, _, _ = setup
    for terminal in ('delivered', 'no_speech', 'transcript_too_long', 'review_required'):
        execution, token = str(uuid.uuid4()), 'x' * 64
        key, prefix = 'executions/' + execution, 'private/' + execution + '/'
        store.cas(key, {'execution_id': execution, 'owner_id': claims['sub'], 'owner_email': claims['email'],
            'event_id': 'event', 'callback_hash': hashlib.sha256(token.encode()).hexdigest(),
            'created_at': datetime.now(UTC).isoformat(), 'status': 'completed', 'sequence': 3,
            'processing_status': terminal, 'notion_status': terminal, 'audio_generation': 17,
            'artifacts': {'transcript.txt': True}, 'output_bucket': 'private-test-bucket', 'output_prefix': prefix}, 0)
        monkeypatch.setattr(runtime.CloudTasks, 'schedule_processing', lambda *args: pytest.fail('terminal replay queued'), raising=False)
        body = {'execution_id': execution, 'owner_id': claims['sub'], 'status': 'completed', 'sequence': 3,
                'artifacts': {'system-audio.wav': {'gcs_uri': 'gs://private-test-bucket/' + prefix + 'system-audio.wav'}}}
        response = client.post('/internal/bot/status', json=body, headers={'Authorization': 'Bearer ' + token})
        assert response.status_code == 200 and response.json['notion_status'] == terminal
        saved, _ = store.load(key)
        assert saved['processing_status'] == terminal and saved['artifacts']['transcript.txt']


def test_enqueue_ack_never_clears_newer_stage_outbox(setup):
    import calendar_runtime as runtime
    import types
    _, store, _, _, _ = setup
    execution = str(uuid.uuid4())
    key = 'executions/' + execution
    store.cas(key, {'status': 'completed', 'processing_step': 0, 'processing_enqueue_needed': True}, 0)
    def advance(_):
        saved, gen = store.load(key)
        saved.update(processing_step=1, processing_enqueue_needed=True)
        store.cas(key, saved, gen)
    assert runtime.enqueue_processing(store, execution, types.SimpleNamespace(schedule_processing=advance))
    assert store.load(key)[0]['processing_enqueue_needed'] is True


def test_reconciliation_cursor_progresses_past_history_and_permanent_failures(setup):
    import calendar_runtime as runtime
    import types
    _, store, _, _, _ = setup
    store.prefix = ''
    ids = [str(uuid.UUID(int=i)) for i in range(1, 76)]
    for i, execution in enumerate(ids):
        store.cas('executions/' + execution, {'status': 'completed', 'processing_step': 0,
            'processing_enqueue_needed': i >= 60}, 0)
    calls = []
    class Scheduler:
        def schedule_processing(self, execution, **kwargs):
            assert kwargs == {'timeout': 1}
            calls.append(execution)
            if execution in ids[60:67]:
                raise RuntimeError('permanent')
    class Bucket:
        def list_blobs(self, prefix, **kwargs):
            assert kwargs['max_results'] == 50 and kwargs['timeout'] == 1 and kwargs['retry'] is None
            names = sorted('executions/' + x + '.json' for x in ids)
            return [types.SimpleNamespace(name=n) for n in names if n >= kwargs['start_offset']][:50]
    store.bucket = Bucket()
    for _ in range(3):
        runtime.reconcile_processing(store, Scheduler(), clock=lambda: 0)
    assert ids[-1] in calls
    assert all(x in calls for x in ids[60:67])
    assert store.load('executions/' + ids[-1])[0]['processing_enqueue_needed'] is False
    assert store.load('executions/' + ids[60])[0]['processing_enqueue_needed'] is True


def test_reconciliation_cursor_cas_race_revisits_instead_of_losing_work(setup):
    import calendar_runtime as runtime
    import types
    _, store, _, _, _ = setup
    store.prefix = ''
    identity = str(uuid.uuid4())
    key = 'executions/' + identity
    store.cas(key, {'status': 'completed', 'processing_enqueue_needed': True}, 0)
    store.bucket = types.SimpleNamespace(list_blobs=lambda prefix, **kwargs: [types.SimpleNamespace(name=key + '.json')])
    calls = []
    scheduler = types.SimpleNamespace(schedule_processing=lambda value, **kwargs: calls.append(value))
    real_cas = store.cas
    def race(key, value, generation, **kwargs):
        if key == 'processing-sweep/cursor':
            raise RuntimeError('another sweep won')
        return real_cas(key, value, generation, **kwargs)
    store.cas = race
    assert runtime.reconcile_processing(store, scheduler, clock=lambda: 0) == (1, 0)
    store.cas = real_cas
    assert runtime.reconcile_processing(store, scheduler, clock=lambda: 0) == (0, 0)
    assert calls == [identity]


def test_reconciliation_stops_before_budget_and_persists_last_examined(setup):
    import calendar_runtime as runtime
    import types
    _, store, _, _, _ = setup
    store.prefix = ''
    ids = [str(uuid.UUID(int=i)) for i in range(1, 5)]
    for identity in ids:
        store.cas('executions/' + identity, {'status': 'completed', 'processing_enqueue_needed': False}, 0)
    store.bucket = types.SimpleNamespace(list_blobs=lambda prefix, **kw: [types.SimpleNamespace(name='executions/' + x + '.json') for x in ids])
    ticks = iter([0, 1, 20])
    assert runtime.reconcile_processing(store, types.SimpleNamespace(), clock=lambda: next(ticks)) == (0, 0)
    assert store.load('processing-sweep/cursor')[0]['after'] == 'executions/' + ids[0] + '.json'


def test_review_required_status_is_visible_and_notion_action_does_not_enqueue(setup, monkeypatch):
    import calendar_runtime as runtime
    client, store, claims, _, _ = setup
    assert post(client, '/calendar/connect', {'calendar_ids': ['primary']}).status_code == 200
    key = 'calendar/' + runtime.digest(claims['email'])
    state, generation = store.load(key)
    event_id = next(iter(state['events']))
    execution = str(uuid.uuid4())
    state['events'][event_id]['execution_id'] = execution
    store.cas(key, state, generation)
    store.cas('executions/' + execution, {'execution_id': execution, 'owner_id': claims['sub'],
        'status': 'completed', 'audio_generation': 1, 'processing_status': 'review_required',
        'notion_status': 'review_required', 'artifacts': {'transcript.txt': True}}, 0)
    monkeypatch.setattr(runtime.CloudTasks, 'schedule_processing', lambda *args: pytest.fail('review queued'), raising=False)
    response = client.get('/calendar/settings', headers={'Authorization': 'Bearer firebase'})
    item = next(x for x in response.json['events'] if x['id'] == event_id)
    assert item['notion_status'] == 'review_required' and item['transcript_available']
    assert 'Review the transcript' in item['detail']
    response = post(client, '/calendar/meetings/' + event_id + '/notion', {})
    assert response.status_code == 200 and response.json['status'] == 'review_required'


def hybrid_calendar(setup, monkeypatch, pilot="teams"):
    import calendar_runtime as runtime
    client, store, claims, calls, tasks = setup
    monkeypatch.setenv("MEETING_CAPTURE_PROVIDER", "desktop")
    monkeypatch.setenv("MEETING_CLOUD_PROVIDERS", pilot)
    monkeypatch.setenv("MEETING_CLOUD_OWNER_EMAILS", " OWNER@example.com ")
    now = datetime.now(UTC)
    items = [{"id": provider, "summary": provider, "organizer": {"email": claims["email"]},
              "start": {"dateTime": (now - timedelta(seconds=1)).isoformat()},
              "end": {"dateTime": (now + timedelta(minutes=30)).isoformat()}, "hangoutLink": url}
             for provider, url in [("teams", "https://teams.microsoft.com/meet/123456789?p=private"),
                                   ("meet", "https://meet.google.com/abc-defg-hij"),
                                   ("zoom", "https://acme.zoom.us/j/123456789")]]
    class Calendar:
        def list_events(self, *args):
            return items
    monkeypatch.setattr(runtime, "GoogleCalendarFactory", lambda: lambda *args: Calendar())
    return post(client, "/calendar/connect", {"calendar_ids": ["primary"]}), items


def shared_calendar(setup, monkeypatch, *, difference=None, uncertain=False, pilot="teams"):
    import calendar_runtime as runtime
    from google.cloud import storage
    client, store, claims, _, _ = setup
    owners = ["owner@example.com", "other@example.com", "absent@example.com"]
    monkeypatch.setenv("REEL_ALLOWED_EMAILS", ",".join(owners))
    monkeypatch.setenv("MEETING_CAPTURE_PROVIDER", "desktop")
    monkeypatch.setenv("MEETING_CLOUD_PROVIDERS", pilot)
    monkeypatch.setenv("MEETING_CLOUD_OWNER_EMAILS", ",".join(owners))
    monkeypatch.setenv("MEETING_SERVICE_URL", "https://meeting.example")
    monkeypatch.setattr(runtime, "BotDispatcher", RealBotDispatcher)
    now = datetime.now(UTC)
    items = {}
    for index, owner in enumerate(owners):
        item = {"id": "copy-" + str(index), "iCalUID": "invitation@example.com", "summary": "Shared meeting",
                "organizer": {"email": owners[0]},
                "attendees": [{"email": email, "responseStatus": "accepted"} for email in owners],
                "start": {"dateTime": (now - timedelta(seconds=1)).isoformat()},
                "end": {"dateTime": (now + timedelta(minutes=30)).isoformat()},
                "hangoutLink": ("https://meet.google.com/abc-defg-hij" if pilot == "google_meet"
                                 else "https://teams.microsoft.com/meet/123456789")
                                 + ("/?p=second" if index else "?p=first")}
        if index == 1:
            if difference == "uid": item["iCalUID"] = "private-invitation@example.com"
            if difference == "organizer": item["organizer"] = {"email": owners[2]}
            if difference == "roster": item["attendees"].append({"email": "private@example.com"})
            if difference == "missing_uid": item.pop("iCalUID")
        items[owner] = item
    class Calendar:
        def __init__(self, owner): self.owner = owner
        def list_events(self, *args): return [items[self.owner]]
    monkeypatch.setattr(runtime, "GoogleCalendarFactory", lambda: lambda owner, *_: Calendar(owner))
    launches = []
    class Blob:
        def upload_from_string(self, *args, **kwargs): pass
    class Bucket:
        def blob(self, path): return Blob()
    class StorageClient:
        def bucket(self, name): return Bucket()
    class Response:
        status_code = 200
        def raise_for_status(self): pass
        def json(self): return {"name": "operation"}
    class Session:
        def post(self, *args, **kwargs):
            launches.append(kwargs)
            if uncertain: raise TimeoutError("Cloud Run response lost")
            return Response()
    monkeypatch.setattr(storage, "Client", StorageClient)
    monkeypatch.setattr(runtime, "cloud_session", lambda: Session())
    events = {}
    def select(owner):
        claims.update(email=owner, sub=owner.split("@")[0] + "-uid")
    for owner in owners:
        select(owner)
        connected = post(client, "/calendar/connect", {"calendar_ids": ["primary"]})
        assert connected.status_code == 200
        events[owner] = connected.json["events"][0]["id"]
        assert post(client, "/calendar/settings", {"consent_mode": "approved", "participant_consent_attested": True}).status_code == 200
    def dispatch(owner):
        select(owner)
        core = runtime.CalendarMeetings(store, runtime.GoogleCalendarFactory(), runtime.CloudTasks(), RealBotDispatcher(store))
        state, _ = core._load(owner)
        saved = state["events"][events[owner]]
        return core.dispatch_callback(dict(claims), saved["id"], saved["occurrence_start"])
    return owners, events, select, dispatch, launches


@pytest.mark.parametrize("uncertain", [False, True])
@pytest.mark.parametrize("pilot", ["teams", "google_meet"])
def test_shared_invitation_three_owners_launch_once_with_absent_attendee(setup, monkeypatch, uncertain, pilot):
    owners, events, _, dispatch, launches = shared_calendar(setup, monkeypatch, uncertain=uncertain, pilot=pilot)
    _, store, _, _, _ = setup
    for owner in owners:
        assert dispatch(owner) == "requesting_entry"
        assert dispatch(owner) == "requesting_entry"
    assert len(launches) == 1
    records = [value[0] for key, value in store.data.items() if key.startswith("executions/")]
    assert len(records) == 1 and set(records[0]["attendees"]) == set(owners)
    claims = [value[0] for key, value in store.data.items() if key.startswith("sharedcapture/")]
    assert len(claims) == 1 and claims[0]["capture_deadline"]
    for owner in owners:
        saved = store.load("calendar/" + hashlib.sha256(owner.encode()).hexdigest())[0]["events"][events[owner]]
        assert saved["attempted"] is True
        assert bool(saved.get("execution_id")) == (owner == owners[0])


@pytest.mark.parametrize("difference", ["uid", "organizer", "roster", "missing_uid"])
def test_shared_capture_keeps_distinct_or_unidentified_invitations_separate(setup, monkeypatch, difference):
    owners, _, _, dispatch, launches = shared_calendar(setup, monkeypatch, difference=difference)
    for owner in owners[:2]: dispatch(owner)
    assert len(launches) == 2


def test_shared_capture_follower_sees_status_without_leader_private_receipts(setup, monkeypatch):
    owners, events, select, dispatch, _ = shared_calendar(setup, monkeypatch)
    client, store, _, _, _ = setup
    for owner in owners[:2]: dispatch(owner)
    key = next(key for key in store.data if key.startswith("executions/"))
    record, generation = store.load(key)
    record.update(status="recording", notion_status="delivered", notion_url="https://notion.so/private-leader",
                  artifacts={"recording.mp4": {"gcs_uri": "gs://private/video"}})
    store.cas(key, record, generation)
    select(owners[1])
    response = client.get("/calendar/settings", headers={"Authorization": "Bearer firebase"})
    public = response.json["events"][0]
    assert public["status"] == "recording" and public["notion_status"] == "delivered"
    assert public["detail"] == "Meeting is being recorded for this invitation. Notes appear in Mission Control."
    assert all(field not in public for field in ["notion_url", "video_available", "transcript_available", "shared_claim", "execution_id"])
    path = "/calendar/meetings/" + events[owners[1]]
    assert client.get(path + "/artifacts/video", headers={"Authorization": "Bearer firebase"}).status_code == 400
    assert post(client, path + "/notion", {}).status_code == 400


@pytest.mark.parametrize("failure", ["record_creation", "payload_upload", "cloud_run_403"])
def test_shared_capture_follower_sees_known_launch_failure(setup, monkeypatch, failure):
    import calendar_runtime as runtime
    from google.cloud import storage
    from types import SimpleNamespace
    owners, _, select, dispatch, launches = shared_calendar(setup, monkeypatch)
    client, store, _, _, _ = setup
    original_cas = store.cas
    if failure == "record_creation":
        def reject_record(key, value, generation, **kwargs):
            if key.startswith("executions/"):
                raise RuntimeError("Private execution storage rejection")
            return original_cas(key, value, generation, **kwargs)
        monkeypatch.setattr(store, "cas", reject_record)
    elif failure == "payload_upload":
        def reject_upload(*args, **kwargs):
            raise RuntimeError("Private payload upload rejection")
        monkeypatch.setattr(storage, "Client", lambda: SimpleNamespace(bucket=lambda _: SimpleNamespace(
            blob=lambda _: SimpleNamespace(upload_from_string=reject_upload))))
    else:
        def reject_run(*args, **kwargs):
            launches.append(kwargs)
            def raise_for_status():
                raise RuntimeError("Private Cloud Run rejection")
            return SimpleNamespace(status_code=403, raise_for_status=raise_for_status)
        monkeypatch.setattr(runtime, "cloud_session", lambda: SimpleNamespace(post=reject_run))
    assert dispatch(owners[0]) == "failed"
    assert dispatch(owners[1]) == "requesting_entry"
    select(owners[1])
    public = client.get("/calendar/settings", headers={"Authorization": "Bearer firebase"}).json["events"][0]
    assert public["status"] == "failed"
    assert public["detail"] == "Meeting capture could not be completed for this invitation."
    assert all(field not in public for field in ["notion_url", "video_available", "transcript_available", "shared_claim", "execution_id"])
    assert "Private" not in json.dumps(public) and "owner_hash" not in public
    for owner in owners:
        dispatch(owner)
    assert len(launches) == (1 if failure == "cloud_run_403" else 0)
    assert len([key for key in store.data if key.startswith("sharedcapture/")]) == 1


@pytest.mark.parametrize("failure", ["transport", "cloud_run_503"])
@pytest.mark.parametrize("missing_record", [False, True])
def test_shared_capture_follower_keeps_uncertain_launch_pending(setup, monkeypatch, failure, missing_record):
    import calendar_runtime as runtime
    from types import SimpleNamespace
    owners, _, select, dispatch, launches = shared_calendar(setup, monkeypatch, uncertain=True)
    client, store, _, _, _ = setup
    if failure == "cloud_run_503":
        def unavailable(*args, **kwargs):
            launches.append(kwargs)
            return SimpleNamespace(status_code=503)
        monkeypatch.setattr(runtime, "cloud_session", lambda: SimpleNamespace(post=unavailable))
    assert dispatch(owners[0]) == "requesting_entry"
    if missing_record:
        key = next(key for key in store.data if key.startswith("executions/"))
        store.data.pop(key)
    for owner in owners:
        assert dispatch(owner) == "requesting_entry"
        assert dispatch(owner) == "requesting_entry"
    select(owners[1])
    public = client.get("/calendar/settings", headers={"Authorization": "Bearer firebase"}).json["events"][0]
    assert public["status"] == "requesting_entry"
    assert public["detail"] == "Meeting capture is pending for this invitation."
    assert len(launches) == 1


def test_shared_capture_cas_race_cannot_submit_two_jobs(setup, monkeypatch):
    owners, _, _, dispatch, launches = shared_calendar(setup, monkeypatch)
    _, store, _, _, _ = setup
    original = store.cas
    raced = []
    def race(key, value, generation, **kwargs):
        if key.startswith("sharedcapture/") and not raced:
            raced.append(True)
            dispatch(owners[1])
        return original(key, value, generation, **kwargs)
    monkeypatch.setattr(store, "cas", race)
    dispatch(owners[0])
    assert raced and len(launches) == 1


def test_shared_capture_claim_committed_before_timeout_still_launches_once(setup, monkeypatch):
    owners, _, _, dispatch, launches = shared_calendar(setup, monkeypatch)
    _, store, _, _, _ = setup
    original = store.cas
    timed_out = []
    def committed_timeout(key, value, generation, **kwargs):
        result = original(key, value, generation, **kwargs)
        if key.startswith("sharedcapture/") and not timed_out:
            timed_out.append(True)
            raise TimeoutError("Claim committed, response lost")
        return result
    monkeypatch.setattr(store, "cas", committed_timeout)
    for owner in owners: dispatch(owner)
    assert timed_out and len(launches) == 1


@pytest.mark.parametrize("status,processing,notion,detail", [
    ("requesting_entry", "", "pending", "Meeting capture is pending for this invitation."),
    ("awaiting_admission", "", "pending", "Meeting capture is awaiting admission for this invitation."),
    ("completed", "processing", "pending", "Meeting capture is complete for this invitation. Notes are being prepared."),
    ("completed", "no_speech", "no_speech", "No meeting speech was captured for this invitation."),
    ("completed", "review_required", "review_required", "Meeting notes for this invitation require review."),
    ("completed", "transcript_too_long", "transcript_too_long", "Meeting transcript for this invitation exceeds the summary limit."),
    ("completed", "delivered", "delivered", "Meeting notes for this invitation are available in Mission Control."),
])
def test_shared_capture_follower_detail_matches_capture_and_notes_state(setup, monkeypatch, status, processing, notion, detail):
    owners, _, select, dispatch, _ = shared_calendar(setup, monkeypatch)
    client, store, _, _, _ = setup
    for owner in owners[:2]: dispatch(owner)
    key = next(key for key in store.data if key.startswith("executions/"))
    record, generation = store.load(key)
    record.update(status=status, processing_status=processing, notion_status=notion)
    store.cas(key, record, generation)
    select(owners[1])
    public = client.get("/calendar/settings", headers={"Authorization": "Bearer firebase"}).json["events"][0]
    assert public["status"] == status and public["notion_status"] == notion
    assert public["detail"] == detail and "processing_status" not in public


@pytest.mark.parametrize("change", ["revoked", "unapproved", "roster_changed", "uid_changed"])
def test_shared_capture_requires_fresh_approved_calendar_before_claim(setup, monkeypatch, change):
    owners, events, select, dispatch, launches = shared_calendar(setup, monkeypatch)
    client, store, _, _, _ = setup
    select(owners[0])
    if change == "revoked":
        assert post(client, "/calendar/disconnect", {}).status_code == 200
    elif change == "unapproved":
        assert post(client, "/calendar/settings", {"consent_mode": "ask"}).status_code == 200
    else:
        key = "calendar/" + hashlib.sha256(owners[0].encode()).hexdigest()
        state, generation = store.load(key)
        saved = state["events"][events[owners[0]]]
        if change == "roster_changed": saved["participant_roster"] = ["stale@example.com"]
        else: saved["ical_uid"] = "stale@example.com"
        store.cas(key, state, generation)
    dispatch(owners[0])
    assert not launches and not any(key.startswith("sharedcapture/") for key in store.data)


@pytest.mark.parametrize("pilot,title,url", [("teams", "teams", "https://teams.microsoft.com/meet/123456789?p=private"),
    ("google_meet", "meet", "https://meet.google.com/abc-defg-hij")])
def test_hybrid_desktop_feed_splits_exact_occurrences_and_rejects_cloud_state_before_mutation(setup, monkeypatch, pilot, title, url):
    client, store, claims, calls, _ = setup
    connected, _ = hybrid_calendar(setup, monkeypatch, pilot)
    assert connected.json["capabilities"]["cloud_providers"] == [pilot]
    assert connected.json["capabilities"]["bot"] is True
    assert {e["title"]: e["capture_provider"] for e in connected.json["events"]} == {
        name: "cloud" if name == title else "desktop" for name in ("teams", "meet", "zoom")}
    response = client.get("/calendar/desktop", headers={"Authorization": "Bearer firebase"})
    assert {e["title"] for e in response.json["events"]} == ({"teams", "meet", "zoom"} - {title})
    assert response.json["cloud_providers"] == [pilot]
    cloud = response.json["cloud_events"]
    assert len(cloud) == 1 and cloud[0]["join_url"] == url
    key = "calendar/" + hashlib.sha256(claims["email"].encode()).hexdigest()
    before = store.load(key)
    for item in response.json["events"] + cloud:
        assert item["end"] == before[0]["events"][item["id"]]["end"]
    assert post(client, f"/calendar/desktop/{cloud[0]['id']}/state", {
        "state": "joined", "participant_consent_attested": True}).status_code == 400
    assert store.load(key) == before and calls == []
    monkeypatch.setenv("MEETING_CLOUD_OWNER_EMAILS", "other@example.com")
    response = client.get("/calendar/desktop", headers={"Authorization": "Bearer firebase"})
    assert response.json["cloud_providers"] == [] and response.json["cloud_events"] == []
    assert len(response.json["events"]) == 3


def test_hybrid_browser_reuses_calendar_occurrence_and_does_not_create_second_attempt(setup, monkeypatch):
    client, store, claims, calls, _ = setup
    connected, _ = hybrid_calendar(setup, monkeypatch)
    teams = next(e for e in connected.json["events"] if e["title"] == "teams")
    body = {"meeting_url": "https://teams.microsoft.com/meet/123456789?p=private", "participant_consent_attested": True}
    first = post(client, "/calendar/browser", body)
    assert first.status_code == 200 and first.json == {"id": teams["id"], "status": "requesting_entry"}
    assert post(client, "/calendar/browser", body).json == first.json
    assert len(calls) == 1 and calls[0][1]["attendees"] == []
    key = "calendar/" + hashlib.sha256(claims["email"].encode()).hexdigest()
    assert len(store.load(key)[0]["events"]) == 3


@pytest.mark.parametrize("url", ["https://teams.microsoft.com/meet/999999999", "https://meet.google.com/abc-defg-hij",
                                  "https://teams.microsoft.com.evil.test/meet/123456789",
                                  "https://teams.microsoft.com/meet/not-a-meeting"])
def test_hybrid_browser_unknown_or_desktop_route_never_reserves(setup, monkeypatch, url):
    client, store, claims, calls, _ = setup
    hybrid_calendar(setup, monkeypatch)
    key = "calendar/" + hashlib.sha256(claims["email"].encode()).hexdigest()
    before = store.load(key)
    assert post(client, "/calendar/browser", {"meeting_url": url, "participant_consent_attested": True}).status_code == 400
    assert store.load(key) == before and calls == []


def test_hybrid_browser_cancellation_wins_and_revoked_owner_capability_does_not_mutate(setup, monkeypatch):
    client, store, claims, calls, _ = setup
    _, items = hybrid_calendar(setup, monkeypatch)
    teams = items.pop(0)
    body = {"meeting_url": teams["hangoutLink"], "participant_consent_attested": True}
    assert post(client, "/calendar/browser", body).status_code == 400
    assert calls == []
    key = "calendar/" + hashlib.sha256(claims["email"].encode()).hexdigest()
    before = store.load(key)
    monkeypatch.setenv("MEETING_CLOUD_OWNER_EMAILS", "other@example.com")
    assert post(client, "/calendar/browser", body).status_code == 503
    assert store.load(key) == before


@pytest.mark.parametrize("url", ["https://teams.microsoft.com/meet/123456789", "https://evil.test/teams.microsoft.com/meet/123456789"])
def test_hybrid_dispatcher_requires_valid_server_known_occurrence_before_writes(monkeypatch, url):
    import calendar_runtime as runtime
    monkeypatch.setenv("MEETING_CAPTURE_PROVIDER", "desktop")
    monkeypatch.setenv("MEETING_CLOUD_PROVIDERS", "teams")
    store = FakeStore()
    event = {"id": "unrecognized", "title": "Unknown", "join_url": url}
    before = dict(store.data)
    with pytest.raises(runtime.CalendarMeetingError):
        runtime.BotDispatcher(store)("owner@example.com", event)
    assert store.data == before



@pytest.mark.parametrize("mode", ["ask", "approved"])
@pytest.mark.parametrize("calendar_copies", [False, True])
@pytest.mark.parametrize("pilot,title,url,worker_provider", [("teams", "teams", "https://teams.microsoft.com/meet/123456789?p=private", "teams"),
    ("google_meet", "meet", "https://meet.google.com/abc-defg-hij", "meet")])
def test_hybrid_browser_launches_real_dispatcher_once_for_known_occurrence(setup, monkeypatch, mode, calendar_copies, pilot, title, url, worker_provider):
    import calendar_runtime as runtime
    from google.cloud import storage
    client, store, claims, _, _ = setup
    hybrid_calendar(setup, monkeypatch, pilot)
    if calendar_copies:
        assert post(client, "/calendar/connect", {"calendar_ids": ["primary", "shared"]}).status_code == 200
    if mode == "approved":
        assert post(client, "/calendar/settings", {"consent_mode": mode, "participant_consent_attested": True}).status_code == 200
    monkeypatch.setattr(runtime, "BotDispatcher", RealBotDispatcher)
    monkeypatch.setenv("MEETING_SERVICE_URL", "https://meeting.example")
    uploads, launches = [], []
    class Blob:
        def upload_from_string(self, value, **kwargs):
            uploads.append(json.loads(value))
    class Bucket:
        def blob(self, path): return Blob()
    class StorageClient:
        def bucket(self, name): return Bucket()
    class Response:
        status_code = 200
        def raise_for_status(self): pass
        def json(self): return {"name": "operation"}
    class Session:
        def post(self, url, **kwargs):
            launches.append((url, kwargs))
            return Response()
    monkeypatch.setattr(storage, "Client", StorageClient)
    monkeypatch.setattr(runtime, "cloud_session", lambda: Session())
    body = {"meeting_url": url, "participant_consent_attested": True}
    assert post(client, "/calendar/browser", {"meeting_url": url}).status_code == 400
    assert uploads == launches == []
    if calendar_copies:
        core = runtime.CalendarMeetings(store, runtime.GoogleCalendarFactory(), runtime.CloudTasks(), RealBotDispatcher(store))
        state, _ = core._load(claims["email"])
        copies = [event for event in state["events"].values() if event["title"] == title]
        assert len(copies) == 2
        for event in copies:
            status = core.dispatch_callback(claims, event["id"], event["occurrence_start"])
            if status == "awaiting_consent":
                core.approve(claims, event["id"])
        assert core._current_status(claims["email"], copies[1]["id"]) == "cancelled"
    first = post(client, "/calendar/browser", body)
    assert first.status_code == 200 and first.json["status"] == "requesting_entry"
    assert post(client, "/calendar/browser", body).json == first.json
    assert len(uploads) == len(launches) == 1
    assert uploads[0]["provider"] == worker_provider and uploads[0]["meeting_url"] == body["meeting_url"]
    assert uploads[0]["owner_id"] == claims["sub"]
    assert launches[0][0].endswith("/jobs/bot:run")
    state, _ = store.load("calendar/" + runtime.digest(claims["email"]))
    assert state["events"][first.json["id"]]["attempted"] is True
    assert len([key for key in store.data if key.startswith("executions/")]) == 1
    monkeypatch.setenv("MEETING_CLOUD_OWNER_EMAILS", "other@example.com")
    feed = client.get("/calendar/desktop", headers={"Authorization": "Bearer firebase"}).json
    assert feed["cloud_events"][0]["id"] == first.json["id"]
    assert {item["title"] for item in feed["events"]} == ({"teams", "meet", "zoom"} - {title})



def test_non_desktop_cloud_occurrence_rejects_desktop_state_before_mutation(setup):
    client, store, claims, calls, _ = setup
    connected = post(client, "/calendar/connect", {"calendar_ids": ["primary"]}).json
    event_id = connected["events"][0]["id"]
    key = "calendar/" + hashlib.sha256(claims["email"].encode()).hexdigest()
    before = store.load(key)
    assert post(client, f"/calendar/desktop/{event_id}/state", {
        "state": "joined", "participant_consent_attested": True}).status_code == 400
    assert store.load(key) == before and calls == []


@pytest.mark.parametrize("change", ["disconnect", "deselect"])
@pytest.mark.parametrize("status", ["dispatching", "requesting_entry", "recording", "failed"])
def test_live_cloud_ownership_survives_calendar_settings_changes(setup, monkeypatch, change, status):
    import calendar_runtime as runtime
    client, store, claims, calls, _ = setup
    connected, _ = hybrid_calendar(setup, monkeypatch)
    teams = next(e for e in connected.json["events"] if e["title"] == "teams")
    body = {"meeting_url": "https://teams.microsoft.com/meet/123456789?p=private",
            "participant_consent_attested": True}
    assert post(client, "/calendar/browser", body).status_code == 200
    key = "calendar/" + runtime.digest(claims["email"])
    state, generation = store.load(key)
    saved = state["events"][teams["id"]]
    saved["status"] = status
    # Capture can continue until the worker's end + five-minute deadline.
    saved["end"] = (datetime.now(UTC) - timedelta(minutes=2)).isoformat()
    if status != "dispatching":
        saved["execution_id"] = "private-owner-execution"
    local = next(e for e in state["events"].values() if e["title"] == "meet")
    local.update(status="recording", attempted=True, capture_source="desktop")
    if change == "deselect":
        state["config"]["calendar_ids"] = ["other-calendar"]
    store.cas(key, state, generation)
    if change == "disconnect":
        assert post(client, "/calendar/disconnect", {}).status_code == 200
    response = client.get("/calendar/desktop", headers={"Authorization": "Bearer firebase"})
    assert response.status_code == 200 and response.json["events"] == []
    assert [e["id"] for e in response.json["cloud_events"]] == [teams["id"]]
    projected = response.json["cloud_events"][0]
    assert projected["join_url"] == body["meeting_url"]
    authoritative_end = datetime.fromisoformat(saved["end"])
    assert datetime.fromisoformat(projected["end"]) == authoritative_end + timedelta(minutes=5)
    assert datetime.fromisoformat(projected["end"]) > datetime.now(UTC)
    assert store.load(key)[0]["events"][teams["id"]]["end"] == saved["end"]
    assert post(client, "/calendar/browser", body).status_code == 400
    assert len(calls) == 1
    assert post(client, f"/calendar/desktop/{teams['id']}/state", {
        "state": "joined", "participant_consent_attested": True}).status_code == 400

    # Retained ownership is bounded even if no final worker callback arrives.
    state, generation = store.load(key)
    state["events"][teams["id"]]["end"] = (datetime.now(UTC) - timedelta(minutes=6)).isoformat()
    store.cas(key, state, generation)
    assert client.get("/calendar/desktop", headers={"Authorization": "Bearer firebase"}).json["cloud_events"] == []


def test_google_pilot_revoked_owner_cannot_reserve_browser_attempt(setup, monkeypatch):
    client, store, claims, calls, _ = setup
    hybrid_calendar(setup, monkeypatch, "google_meet")
    key = "calendar/" + hashlib.sha256(claims["email"].encode()).hexdigest()
    before = store.load(key)
    monkeypatch.setenv("MEETING_CLOUD_OWNER_EMAILS", "other@example.com")
    assert post(client, "/calendar/browser", {"meeting_url": "https://meet.google.com/abc-defg-hij",
        "participant_consent_attested": True}).status_code == 503
    assert store.load(key) == before and calls == []

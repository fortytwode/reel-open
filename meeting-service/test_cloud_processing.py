import io
import json
import sys
import types
import uuid
import wave

import pytest
from google.api_core.exceptions import NotFound, PreconditionFailed

import cloud_processing as processing
from calendar_runtime import digest
from test_app import FakeStore


class Bucket:
    def __init__(self):
        self.objects = {}

    def blob(self, name):
        return Blob(self, name)


class Blob:
    def __init__(self, bucket, name):
        self.bucket, self.name = bucket, name

    def reload(self, **kwargs):
        if self.name not in self.bucket.objects:
            raise NotFound('missing')
        self.data, self.generation = self.bucket.objects[self.name]
        self.size = len(self.data)

    def download_as_bytes(self, start=None, end=None, if_generation_match=None, **kwargs):
        self.reload()
        if int(self.generation) != if_generation_match:
            raise PreconditionFailed('changed')
        return self.data[slice(start, None if end is None else end + 1)]

    def upload_from_string(self, data, if_generation_match=None, **kwargs):
        if if_generation_match == 0 and self.name in self.bucket.objects:
            raise PreconditionFailed('exists')
        self.bucket.objects[self.name] = (data.encode() if isinstance(data, str) else data, 1)


@pytest.fixture
def setup(monkeypatch):
    import google.cloud.storage
    import speech
    bucket, store, tasks, deliveries = Bucket(), FakeStore(), [], []
    monkeypatch.setattr(google.cloud.storage, 'Client', lambda: types.SimpleNamespace(bucket=lambda _: bucket))
    monkeypatch.setattr(speech, 'transcribe_audio', lambda *args: {'text': 'A clear decision'})
    monkeypatch.setattr(speech, 'summarize_text', lambda *args, **kwargs: {'summary': 'The decision', 'has_meeting_content': True})
    package = types.ModuleType('canonical_delivery')
    package.__path__ = []
    app = types.ModuleType('canonical_delivery.app')
    app.GCSStateStore = lambda _: object()
    app.calendar_service = object()
    app.deliver = lambda payload, owner, *args, **kw: deliveries.append((payload, owner)) or {'url': 'https://notes'}
    providers = types.ModuleType('canonical_delivery.providers')
    providers.configured_providers = lambda **kwargs: object()
    for name, module in [('canonical_delivery', package), ('canonical_delivery.app', app), ('canonical_delivery.providers', providers)]:
        monkeypatch.setitem(sys.modules, name, module)
    monkeypatch.setenv('DELIVERY_RECEIPTS_BUCKET', 'receipts')
    monkeypatch.setenv('BOT_BUCKET', 'bucket')
    execution, owner, event = str(uuid.uuid4()), 'owner@rocketshiphq.com', 'a' * 64
    record = {'execution_id': execution, 'status': 'completed', 'owner_email': owner, 'owner_id': 'uid',
              'event_id': event, 'started_at': '2026-11-16T10:00:00Z', 'title': 'Meeting', 'attendees': [owner],
              'meeting_id': str(uuid.uuid4()), 'output_bucket': 'bucket', 'output_prefix': 'reel-meetings/bot/' + digest('uid') + '/' + execution + '/',
              'audio_generation': 1}
    store.cas('executions/' + execution, record, 0)
    store.cas('calendar/' + digest(owner), {'identity': {'owner_uid': 'uid', 'owner_email': owner}, 'events': {
        event: {'execution_id': execution, 'occurrence_start': record['started_at']}}}, 0)
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b'\1\0' * 160)
    bucket.objects[record['output_prefix'] + 'system-audio.wav'] = (buf.getvalue(), 1)
    scheduler = types.SimpleNamespace(schedule_processing=lambda *args, **kwargs: tasks.append(args))
    return store, bucket, record, scheduler, tasks, deliveries


def run(setup):
    store, _, record, scheduler, _, _ = setup
    return processing.process_step(store, record['execution_id'], scheduler, clock=lambda: 100)


def test_completed_execution_uses_immutable_transcript_summary_and_calendar_reference(setup):
    store, bucket, record, _, tasks, deliveries = setup
    assert run(setup) == 'processing'
    assert run(setup) == 'processing'
    assert run(setup) == 'processing'
    assert run(setup) == 'delivered'
    assert len(deliveries) == 1
    payload, owner = deliveries[0]
    assert owner == record['owner_email']
    assert payload['summary'] == 'The decision'
    assert payload['segments'][0]['text'] == 'A clear decision'
    assert payload['calendar'] == {'legacy_occurrence_id': record['event_id'], 'occurrence_start': record['started_at']}
    assert run(setup) == 'delivered' and len(deliveries) == 1
    assert len(tasks) == 3


def test_caption_labels_survive_saved_transcript_summary_and_delivery(setup, monkeypatch):
    import speech
    store, bucket, record, _, _, deliveries = setup
    key = 'executions/' + record['execution_id']
    saved, gen = store.load(key)
    saved.update(provider='meet', captions_generation=4)
    store.cas(key, saved, gen)
    name = record['output_prefix'] + 'captions.json'
    artifact = {'schema_version': 1, 'execution_id': record['execution_id'], 'provider': 'meet',
                'status': 'captured', 'turns': [{'start': 0, 'end': .009, 'text': 'A clear decision',
                'speaker_name': 'Ana', 'source': 'google_meet_caption'}]}
    bucket.objects[name] = (json.dumps(artifact).encode(), 4)
    summary_turns = []
    def summarize(text, *args, **kwargs):
        assert text == 'A clear decision'
        summary_turns.extend(kwargs['speaker_turns'])
        return {'summary': 'The decision', 'has_meeting_content': True}
    monkeypatch.setattr(speech, 'summarize_text', summarize)
    assert run(setup) == 'processing'
    assert run(setup) == 'processing'
    transcript = json.loads(bucket.objects[record['output_prefix'] + 'transcript.json'][0])
    assert transcript['segments'][0]['speaker_name'] == 'Ana'
    assert bucket.objects[record['output_prefix'] + 'transcript.txt'][0].endswith(b'\n\nAna: A clear decision')
    # Later revisions or a caption upload cannot rewrite an immutable transcript.
    bucket.objects[name] = (b'{}', 5)
    assert run(setup) == 'processing'
    assert run(setup) == 'delivered'
    assert summary_turns == transcript['segments'] == deliveries[0][0]['segments']


@pytest.mark.parametrize('failure', ['missing', 'changed', 'wrong_execution', 'wrong_provider', 'oversize'])
def test_unusable_captions_preserve_audio_and_unnamed_delivery(setup, failure):
    store, bucket, record, _, _, deliveries = setup
    key = 'executions/' + record['execution_id']
    saved, gen = store.load(key)
    saved.update(provider='meet', captions_generation=4)
    store.cas(key, saved, gen)
    artifact = {'schema_version': 1, 'execution_id': record['execution_id'], 'provider': 'meet',
                'status': 'captured', 'turns': [{'start': 0, 'end': .009, 'text': 'A clear decision',
                'speaker_name': 'Ana', 'source': 'google_meet_caption'}]}
    if failure == 'wrong_execution': artifact['execution_id'] = str(uuid.uuid4())
    if failure == 'wrong_provider': artifact['provider'] = 'teams'
    if failure != 'missing':
        bucket.objects[record['output_prefix'] + 'captions.json'] = (
            b' ' * (2 * 1024 * 1024 + 1) if failure == 'oversize' else json.dumps(artifact).encode(),
            5 if failure == 'changed' else 4)
    for _ in range(3): assert run(setup) == 'processing'
    assert run(setup) == 'delivered'
    assert deliveries[0][0]['segments'] == [{'start': 0, 'end': .01, 'text': 'A clear decision',
                                           'speaker_attribution': 'unavailable', 'speaker_coverage': 0.0}]
    assert bucket.objects[record['output_prefix'] + 'transcript.txt'][0].startswith(
        b'Speaker identification unavailable for this recording.\n\nSpeaker unknown:')


@pytest.mark.parametrize('source, expected_name', [
    ('record', 'Recorded Name'), ('event', 'Calendar Name'), ('legacy', None),
])
def test_attendee_hints_use_execution_snapshot_or_legacy_calendar_context(setup, monkeypatch, source, expected_name):
    import speech

    store, _, record, _, _, deliveries = setup
    owner = record['owner_email']
    if source != 'legacy':
        key = 'calendar/' + digest(owner)
        state, generation = store.load(key)
        state['events'][record['event_id']]['attendee_names'] = {owner: 'Calendar Name'}
        store.cas(key, state, generation)
    if source == 'record':
        key = 'executions/' + record['execution_id']
        saved, generation = store.load(key)
        saved['attendee_names'] = {owner: 'Recorded Name'}
        store.cas(key, saved, generation)
    keywords, summary_calls = [], []

    def transcribe(wav, language, title, hints, previous):
        keywords.extend(hints)
        return {'text': 'A clear decision'}

    def summarize(text, title, attendees, *, attendee_names):
        summary_calls.append((attendees, attendee_names))
        return {'summary': 'The decision', 'has_meeting_content': True}

    monkeypatch.setattr(speech, 'transcribe_audio', transcribe)
    monkeypatch.setattr(speech, 'summarize_text', summarize)
    assert run(setup) == 'processing'
    assert run(setup) == 'processing'
    assert run(setup) == 'processing'
    assert run(setup) == 'delivered'
    expected = {owner: expected_name} if expected_name else None
    assert summary_calls == [([owner], expected)]
    assert keywords == speech.attendee_keywords([owner], expected)
    assert keywords
    assert 'attendee_names' not in deliveries[0][0]


def test_empty_speech_never_summarizes_or_delivers(setup, monkeypatch):
    import speech
    monkeypatch.setattr(speech, 'transcribe_audio', lambda *args: {'text': ''})
    monkeypatch.setattr(speech, 'summarize_text', lambda *args, **kwargs: pytest.fail('must not summarize silence'))
    assert run(setup) == 'processing'
    assert run(setup) == 'no_speech'
    assert setup[-1] == []


def test_changed_audio_and_wrong_owner_fail_before_inference(setup, monkeypatch):
    import speech
    monkeypatch.setattr(speech, 'transcribe_audio', lambda *args: pytest.fail('must not transcribe'))
    store, bucket, record, _, _, _ = setup
    name = record['output_prefix'] + 'system-audio.wav'
    bucket.objects[name] = (bucket.objects[name][0], 2)
    with pytest.raises(ValueError, match='changed'):
        run(setup)
    saved, gen = store.load('executions/' + record['execution_id'])
    saved['processing_lease_until'] = 0
    store.cas('executions/' + record['execution_id'], saved, gen)
    state, gen = store.load('calendar/' + digest(record['owner_email']))
    state['identity']['owner_uid'] = 'other'
    store.cas('calendar/' + digest(record['owner_email']), state, gen)
    with pytest.raises(ValueError, match='owner'):
        run(setup)


def test_active_lease_prevents_concurrent_work(setup):
    store, _, record, _, _, _ = setup
    key = 'executions/' + record['execution_id']
    saved, gen = store.load(key)
    saved['processing_lease_until'] = 200
    store.cas(key, saved, gen)
    with pytest.raises(RuntimeError, match='already'):
        run(setup)
    assert setup[-1] == []


def test_delivery_retry_reuses_identical_summary(setup, monkeypatch):
    import canonical_delivery.app as delivery_app
    import speech
    assert run(setup) == 'processing'
    assert run(setup) == 'processing'
    assert run(setup) == 'processing'
    calls = []
    def failing(payload, *args, **kwargs):
        calls.append(payload)
        raise RuntimeError('uncertain provider response')
    monkeypatch.setattr(delivery_app, 'deliver', failing)
    with pytest.raises(RuntimeError):
        run(setup)
    monkeypatch.setattr(speech, 'summarize_text', lambda *args, **kwargs: pytest.fail('summary must not be regenerated'))
    monkeypatch.setattr(delivery_app, 'deliver', lambda payload, *a, **k: calls.append(payload) or {'url': 'https://notes'})
    store, _, record, scheduler, _, _ = setup
    assert processing.process_step(store, record['execution_id'], scheduler, clock=lambda: 1000) == 'delivered'
    assert calls[0] == calls[1]


def test_stale_execution_never_processes(setup):
    store, _, record, _, _, _ = setup
    key = 'executions/' + record['execution_id']
    saved, gen = store.load(key)
    saved['status'] = 'recording'
    store.cas(key, saved, gen)
    with pytest.raises(ValueError, match='Completed'):
        run(setup)


def test_exact_digital_silence_skips_speech_provider(setup, monkeypatch):
    import speech
    store, bucket, record, _, _, deliveries = setup
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000); wav.writeframes(b'\0\0' * 160)
    bucket.objects[record['output_prefix'] + 'system-audio.wav'] = (buf.getvalue(), 1)
    monkeypatch.setattr(speech, 'transcribe_audio', lambda *args: pytest.fail('digital silence must skip ASR'))
    assert run(setup) == 'processing'
    assert run(setup) == 'no_speech'
    assert deliveries == []


def test_malformed_artifact_prefix_is_rejected(setup):
    store, _, record, _, _, _ = setup
    key = 'executions/' + record['execution_id']
    saved, gen = store.load(key)
    saved['output_prefix'] = 'other/'
    store.cas(key, saved, gen)
    with pytest.raises(ValueError, match='artifact'):
        run(setup)


def test_enqueue_failure_after_commit_retries_next_stage(setup):
    store, _, record, _, _, deliveries = setup
    scheduler = types.SimpleNamespace(schedule_processing=lambda *args: (_ for _ in ()).throw(RuntimeError('queue unavailable')))
    with pytest.raises(RuntimeError, match='queue unavailable'):
        processing.process_step(store, record['execution_id'], scheduler, clock=lambda: 100)
    assert store.load('executions/' + record['execution_id'])[0]['processing_step'] == 1
    assert run(setup) == 'processing'
    assert run(setup) == 'processing'
    assert run(setup) == 'delivered'
    assert len(deliveries) == 1



def test_three_short_retries_cannot_outlive_processing_lease(setup):
    store, _, record, scheduler, _, _ = setup
    key = 'executions/' + record['execution_id']
    saved, gen = store.load(key)
    saved['processing_lease_until'] = 760
    store.cas(key, saved, gen)
    for retry_time in (105, 135, 165):
        with pytest.raises(RuntimeError, match='already'):
            processing.process_step(store, record['execution_id'], scheduler, clock=lambda: retry_time)
    assert processing.process_step(store, record['execution_id'], scheduler, clock=lambda: 761) == 'processing'


def test_oversized_transcript_is_downloadable_without_summary_or_delivery(setup, monkeypatch):
    import speech
    store, bucket, record, _, _, deliveries = setup
    monkeypatch.setattr(speech, 'transcribe_audio', lambda *args: {'text': 'x' * 200001})
    monkeypatch.setattr(speech, 'summarize_text', lambda *args, **kwargs: pytest.fail('oversized transcript must not summarize'))
    assert run(setup) == 'processing'
    assert run(setup) == 'transcript_too_long'
    saved, _ = store.load('executions/' + record['execution_id'])
    assert saved['notion_status'] == 'transcript_too_long'
    assert saved['artifacts']['transcript.txt'] and saved['artifacts']['transcript.json']
    assert bucket.objects[record['output_prefix'] + 'transcript.txt'][0].endswith(b'x' * 200001)
    assert deliveries == []


def test_duration_limit_includes_three_minute_shutdown_allowance():
    import struct
    class Audio:
        generation = 1
        def __init__(self, seconds):
            self.size = seconds * 32000 + 44
        def reload(self, **kwargs): pass
        def download_as_bytes(self, **kwargs):
            return b'RIFF' + struct.pack('<I', self.size - 8) + b'WAVEfmt ' + struct.pack('<IHHIIHH', 16, 1, 1, 16000, 32000, 2, 16) + b'data' + struct.pack('<I', self.size - 44)
    assert processing.audio_layout(Audio(10980), 1)[1] == 10980 * 32000
    with pytest.raises(ValueError, match='Invalid'):
        processing.audio_layout(Audio(10981), 1)


def test_explicit_browser_capture_delivers_owner_only(setup):
    store, _, record, _, _, deliveries = setup
    key = 'calendar/' + digest(record['owner_email'])
    state, gen = store.load(key)
    event = state['events'][record['event_id']]
    event.pop('occurrence_start')
    event.update(calendar_id='browser', start=record['started_at'])
    store.cas(key, state, gen)
    for _ in range(3): assert run(setup) == 'processing'
    assert run(setup) == 'delivered'
    assert deliveries[0][0]['calendar'] is None
    assert deliveries[0][1] == record['owner_email']


def test_calendar_occurrence_cannot_fall_back_to_manual(setup):
    store, _, record, _, _, _ = setup
    key = 'calendar/' + digest(record['owner_email'])
    state, gen = store.load(key)
    event = state['events'][record['event_id']]
    event.pop('occurrence_start')
    event['start'] = record['started_at']
    store.cas(key, state, gen)
    with pytest.raises(ValueError, match='occurrence'):
        run(setup)


def test_sweep_recovers_stage_enqueue_after_committed_progress(setup):
    from calendar_runtime import reconcile_processing
    store, _, record, scheduler, tasks, _ = setup
    failed_scheduler = types.SimpleNamespace(schedule_processing=lambda *args: (_ for _ in ()).throw(RuntimeError('queue unavailable')))
    with pytest.raises(RuntimeError):
        processing.process_step(store, record['execution_id'], failed_scheduler, clock=lambda: 100)
    key = 'executions/' + record['execution_id']
    assert store.load(key)[0]['processing_enqueue_needed'] is True
    store.prefix = ''
    store.bucket = types.SimpleNamespace(list_blobs=lambda prefix, **kwargs: [types.SimpleNamespace(name=key + '.json')])
    assert reconcile_processing(store, scheduler) == (1, 0)
    saved, _ = store.load(key)
    assert saved['processing_step'] == 1 and saved['processing_enqueue_needed'] is False
    assert tasks == [(record['execution_id'],)]


def test_browser_calendar_name_does_not_convert_calendar_event_to_manual(setup):
    store, _, record, _, _, _ = setup
    key = 'calendar/' + digest(record['owner_email'])
    state, gen = store.load(key)
    event = state['events'][record['event_id']]
    event.pop('occurrence_start')
    event.update(calendar_id='browser', provider_event_id='calendar-instance', start=record['started_at'])
    store.cas(key, state, gen)
    with pytest.raises(ValueError, match='occurrence'):
        run(setup)


def test_review_required_preserves_transcript_and_never_delivers_or_requeues(setup, monkeypatch):
    import speech
    from calendar_runtime import enqueue_processing
    store, bucket, record, scheduler, tasks, deliveries = setup
    calls = []
    monkeypatch.setattr(speech, 'summarize_text', lambda *args, **kwargs: calls.append(1) or {'summary': '', 'has_meeting_content': False})
    assert run(setup) == 'processing'
    assert run(setup) == 'processing'
    assert run(setup) == 'review_required'
    saved, gen = store.load('executions/' + record['execution_id'])
    assert saved['notion_status'] == 'review_required' and saved['has_meeting_content'] is False
    assert saved['artifacts']['transcript.txt'] and saved['artifacts']['transcript.json']
    assert bucket.objects[record['output_prefix'] + 'transcript.txt'][0].endswith(b'Speaker unknown: A clear decision')
    assert json.loads(bucket.objects[record['output_prefix'] + 'processing/summary.json'][0])['has_meeting_content'] is False
    assert not saved['processing_enqueue_needed'] and deliveries == [] and len(calls) == 1
    saved['processing_enqueue_needed'] = True
    store.cas('executions/' + record['execution_id'], saved, gen)
    task_count = len(tasks)
    assert not enqueue_processing(store, record['execution_id'], scheduler)
    assert run(setup) == 'review_required' and len(tasks) == task_count and deliveries == [] and len(calls) == 1


def test_legacy_cached_summary_never_bypasses_review(setup):
    store, bucket, record, _, _, deliveries = setup
    assert run(setup) == 'processing'
    assert run(setup) == 'processing'
    name = record['output_prefix'] + 'processing/summary.json'
    bucket.objects[name] = (json.dumps({'summary': 'Old summary'}).encode(), 1)
    assert run(setup) == 'review_required'
    assert deliveries == []


def test_legacy_cached_summary_cannot_deliver_from_later_step(setup):
    store, bucket, record, _, _, deliveries = setup
    assert run(setup) == 'processing'
    assert run(setup) == 'processing'
    assert run(setup) == 'processing'
    name = record['output_prefix'] + 'processing/summary.json'
    bucket.objects[name] = (json.dumps({'summary': 'Old summary'}).encode(), 1)
    assert run(setup) == 'review_required'
    assert deliveries == []


def test_cached_acknowledgement_summary_is_held_for_review(setup, monkeypatch):
    import speech
    store, bucket, record, _, _, deliveries = setup
    monkeypatch.setattr(speech, 'transcribe_audio', lambda *args: {'text': 'Okay.'})
    monkeypatch.setattr(speech, 'summarize_text', lambda *args, **kwargs: {'summary': 'Acknowledged.', 'has_meeting_content': True})
    assert run(setup) == 'processing'
    assert run(setup) == 'processing'
    assert run(setup) == 'review_required'
    saved, _ = store.load('executions/' + record['execution_id'])
    assert saved['has_meeting_content'] is False and saved['notion_status'] == 'review_required'
    assert saved['artifacts']['transcript.txt'] and not saved['artifacts'].get('summary.json')
    assert bucket.objects[record['output_prefix'] + 'transcript.txt'][0].endswith(b'Speaker unknown: Okay.')
    assert json.loads(bucket.objects[record['output_prefix'] + 'processing/summary.json'][0])['has_meeting_content'] is True
    assert deliveries == []


def test_cached_acknowledgement_cannot_deliver_from_later_step(setup, monkeypatch):
    import speech
    store, bucket, record, _, _, deliveries = setup
    monkeypatch.setattr(speech, 'transcribe_audio', lambda *args: {'text': 'Okay.'})
    monkeypatch.setattr(speech, 'summarize_text', lambda *args, **kwargs: {'summary': 'Acknowledged.', 'has_meeting_content': True})
    assert run(setup) == 'processing'
    assert run(setup) == 'processing'
    name = record['output_prefix'] + 'processing/summary.json'
    bucket.objects[name] = (json.dumps({'summary': 'Acknowledged.', 'has_meeting_content': True}).encode(), 1)
    assert run(setup) == 'review_required'
    saved, _ = store.load('executions/' + record['execution_id'])
    assert saved['notion_status'] == 'review_required' and deliveries == []

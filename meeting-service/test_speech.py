import io
import json
import wave

import httpx
import pytest

from app import BridgeError, create_app, verify_firebase
from speech import SpeechError, summarize_text, transcribe_audio


def provider_notes(**fields):
    return {'title': 'Planning', 'summary': 'Decision: proceed.', 'key_points': [],
            'decisions': [], 'open_questions': [], 'has_meeting_content': True,
            'action_items': [], **fields}


@pytest.fixture(autouse=True)
def organization_config(monkeypatch):
    monkeypatch.setenv('REEL_FIREBASE_PROJECT', 'advisr-485ac')
    monkeypatch.setenv('REEL_ORGANIZATION_DOMAIN', 'rocketshiphq.com')
    monkeypatch.delenv('REEL_SPEECH_ALLOWED_DOMAIN', raising=False)


def wav(channels=1, width=2, rate=16000):
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as f:
        f.setnchannels(channels)
        f.setsampwidth(width)
        f.setframerate(rate)
        f.writeframes(b'\0' * (rate * channels * width))
    return buf.getvalue()


@pytest.fixture
def setup(monkeypatch):
    monkeypatch.setenv('REEL_ALLOWED_EMAILS', 'owner@example.com')
    monkeypatch.setenv('OPENAI_API_KEY', 'secret-test')
    requests = []
    claims = {'sub': 'uid', 'email': 'owner@example.com', 'email_verified': True,
              'iss': 'https://securetoken.google.com/advisr-485ac', 'aud': 'advisr-485ac'}
    def handler(req):
        requests.append(req)
        if req.url.path.endswith('/responses'):
            return httpx.Response(200, json={'status': 'completed', 'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': json.dumps(provider_notes(action_items=[{'owner': '', 'task': 'Follow up', 'due': '', 'evidence': ''}]))}]}]})
        return httpx.Response(200, json={'text': 'Hello', 'languages': [{'code': 'en'}]})
    app = create_app(auth_verifier=lambda _: claims, speech_transport=httpx.MockTransport(handler))
    app.testing = True
    return app.test_client(), claims, requests


def transcribe(client, audio=None, **fields):
    return client.post('/transcription', headers={'Authorization': 'Bearer token'}, data={
        'audio': (io.BytesIO(wav() if audio is None else audio), 'meeting.wav'),
        'language': 'en', **fields}, content_type='multipart/form-data')


def test_transcription_protocol_and_auth(setup):
    client, claims, requests = setup
    assert client.post('/transcription').status_code == 401
    claims['email'] = 'other@example.com'
    assert transcribe(client).status_code == 403
    claims['email'] = 'owner@example.com'
    response = transcribe(client, title='Planning', previous_text='Earlier discussion', keywords='["Reel", "Alice"]')
    assert response.json == {'text': 'Hello', 'languages': [{'code': 'en'}], 'engine': 'OpenAI gpt-transcribe', 'duration_seconds': 1.0}
    body = requests[0].content
    assert b'name="languages[]"' in body and b'name="keywords[]"' in body
    assert b'Earlier discussion' in body and b'name="language"' not in body
    assert requests[0].headers['authorization'] == 'Bearer secret-test'
    assert response.headers['Cache-Control'] == 'no-store'


@pytest.mark.parametrize('audio', [b'bad', wav(channels=2), wav(width=1), wav(rate=8000), wav()[:-10]])
def test_invalid_audio(setup, audio):
    assert transcribe(setup[0], audio).status_code == 400


def test_bounds_and_fields(setup):
    client = setup[0]
    assert transcribe(client, language='xx').status_code == 400
    assert transcribe(client, keywords='["bad\\nterm"]').status_code == 400
    assert transcribe(client, previous_text='x' * 1001).status_code == 400
    assert transcribe(client, audio=b'x' * (20 * 1024 * 1024 + 1)).status_code == 413
    assert client.post('/summary', json={'text': 'x' * 200001}, headers={'Authorization': 'Bearer token'}).status_code == 400
    assert client.post('/meetings', data=b'x' * (301 * 1024), headers={'Authorization': 'Bearer token'}).status_code == 413


def test_summary_full_input_and_structured_output(setup):
    client, _, requests = setup
    transcript = 'Beginning ' + 'x' * 190000 + ' final decision'
    response = client.post('/summary', json={'text': transcript, 'title': 'Planning', 'attendees': ['a@example.com']}, headers={'Authorization': 'Bearer token'})
    assert response.status_code == 200
    assert response.json['summary'] == 'Outcome\nDecision: proceed.\n\nAction items\n• Owner unconfirmed: Follow up'
    body = json.loads(requests[0].content)
    assert json.loads(body['input'])['transcript'] == transcript
    assert body['store'] is False and body['reasoning']['effort'] == 'medium'
    assert body['text']['format']['strict'] is True
    schema = body['text']['format']['schema']
    assert 'has_meeting_content' in schema['required']
    assert schema['properties']['has_meeting_content'] == {'type': 'boolean'}
    assert 'Approved' in body['instructions'] and 'Move it to Friday' in body['instructions']
    assert 'regardless of length or language' in body['instructions']


def test_provider_errors_are_safe(monkeypatch):
    monkeypatch.setenv('REEL_ALLOWED_EMAILS', 'owner@example.com')
    monkeypatch.setenv('OPENAI_API_KEY', 'secret-test')
    claims = {'sub': 'uid', 'email': 'owner@example.com', 'email_verified': True, 'iss': 'https://securetoken.google.com/advisr-485ac', 'aud': 'advisr-485ac'}
    app = create_app(auth_verifier=lambda _: claims, speech_transport=httpx.MockTransport(lambda _: httpx.Response(500, text='private provider secret-test')))
    response = transcribe(app.test_client())
    assert response.status_code == 502
    assert b'private' not in response.data and b'secret-test' not in response.data


def test_duration_and_absolute_request_limit(setup):
    client = setup[0]
    stream = io.BytesIO()
    with wave.open(stream, 'wb') as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(16000)
        f.writeframes(b'\0' * (600 * 32000 + 2))
    assert transcribe(client, stream.getvalue()).status_code == 400
    assert client.post('/transcription', data=b'x' * (21 * 1024 * 1024 + 1),
                       content_type='multipart/form-data; boundary=a',
                       headers={'Authorization': 'Bearer token'}).status_code == 413


@pytest.mark.parametrize(('domain', 'project'), [
    ('rocketshiphq.com', 'advisr-485ac'),
    ('cedar.example', 'cedar-meetings'),
])
def test_speech_domain_does_not_expand_calendar_or_notion_access(setup, monkeypatch, domain, project):
    client, claims, _ = setup
    monkeypatch.setenv('REEL_ORGANIZATION_DOMAIN', domain)
    monkeypatch.setenv('REEL_FIREBASE_PROJECT', project)
    claims.update(email=f'newmember@{domain}', aud=project, iss=f'https://securetoken.google.com/{project}')
    assert transcribe(client).status_code == 403
    monkeypatch.setenv('REEL_SPEECH_ALLOWED_DOMAIN', 'other.example')
    assert transcribe(client).status_code == 403
    claims['email'] = 'newmember@other.example'
    assert transcribe(client).status_code == 403
    monkeypatch.setenv('REEL_SPEECH_ALLOWED_DOMAIN', domain)
    claims['email'] = f'newmember@{domain}'
    assert transcribe(client).status_code == 200
    assert client.get('/calendar/settings', headers={'Authorization': 'Bearer token'}).status_code == 403
    assert client.post('/notion/preview', json={}, headers={'Authorization': 'Bearer token'}).status_code == 403
    claims['email'] = f'newmember@{domain}.evil'
    assert transcribe(client).status_code == 403
    claims['email'] = f'newmember@{domain}'
    claims['email_verified'] = False
    assert transcribe(client).status_code == 403


def test_default_firebase_verifier_applies_domain_only_for_speech(monkeypatch):
    monkeypatch.setenv('REEL_SPEECH_ALLOWED_DOMAIN', 'rocketshiphq.com')
    monkeypatch.setenv('REEL_ALLOWED_EMAILS', 'beta@rocketshiphq.com')
    claims = {'sub': 'new-user', 'email': 'newmember@rocketshiphq.com', 'email_verified': True,
              'iss': 'https://securetoken.google.com/advisr-485ac', 'aud': 'advisr-485ac'}
    monkeypatch.setattr('google.oauth2.id_token.verify_firebase_token', lambda *a, **k: claims)
    assert verify_firebase('token', speech=True) == claims
    with pytest.raises(BridgeError):
        verify_firebase('token')


def test_in_process_transcription_function(monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'secret-test')
    requests = []
    def handler(req):
        requests.append(req)
        return httpx.Response(200, json={'text': 'Hello', 'languages': [{'code': 'en'}]})
    result = transcribe_audio(wav(), 'en', 'Planning', ['Reel'], 'Earlier', httpx.MockTransport(handler))
    assert result == {'text': 'Hello', 'languages': [{'code': 'en'}], 'engine': 'OpenAI gpt-transcribe', 'duration_seconds': 1.0}
    assert b'Earlier' in requests[0].content and b'name="keywords[]"' in requests[0].content
    with pytest.raises(SpeechError, match='Invalid transcription context'):
        transcribe_audio(wav(), 'xx')


def test_in_process_summary_function(monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'secret-test')
    requests = []
    notes = provider_notes(action_items=[{'owner': 'Alice', 'task': 'Follow up', 'due': 'Friday', 'evidence': 'Alice will follow up on Friday.'}])
    def handler(req):
        requests.append(req)
        return httpx.Response(200, json={'status': 'completed', 'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': json.dumps(notes)}]}]})
    text = 'Alice will follow up on Friday.'
    result = summarize_text(text, 'Planning', ['alice@example.com'], httpx.MockTransport(handler))
    assert result['summary'] == 'Outcome\nDecision: proceed.\n\nAction items\n• Alice: Follow up (due: Friday)'
    assert json.loads(json.loads(requests[0].content)['input'])['transcript'] == text
    with pytest.raises(SpeechError, match='Invalid summary content'):
        summarize_text('Discussion', attendees=['not-an-email'])


@pytest.mark.parametrize('classification', [False, True, 'false', 0, None])
def test_summary_classification_contract(monkeypatch, classification):
    monkeypatch.setenv('REEL_ALLOWED_EMAILS', 'owner@example.com')
    monkeypatch.setenv('OPENAI_API_KEY', 'secret-test')
    claims = {'sub': 'uid', 'email': 'owner@example.com', 'email_verified': True,
              'iss': 'https://securetoken.google.com/advisr-485ac', 'aud': 'advisr-485ac'}
    notes = provider_notes(title='Meeting', summary='A decision', has_meeting_content=classification)
    def handler(req):
        return httpx.Response(200, json={'status': 'completed', 'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': json.dumps(notes)}]}]})
    client = create_app(auth_verifier=lambda _: claims, speech_transport=httpx.MockTransport(handler)).test_client()
    response = client.post('/summary', json={'text': 'Approved'}, headers={'Authorization': 'Bearer token'})
    if classification is False:
        assert response.status_code == 422 and response.json['code'] == 'meeting_review_required'
        assert 'summary' not in response.json and response.headers['Cache-Control'] == 'no-store'
    elif classification is True:
        assert response.status_code == 200 and response.json['summary'] == 'Outcome\nA decision'
    else:
        assert response.status_code == 502


def test_summary_missing_classification_fails_closed(monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'secret-test')
    notes = {'title': 'Meeting', 'summary': 'A decision', 'action_items': []}
    transport = httpx.MockTransport(lambda req: httpx.Response(200, json={'status': 'completed', 'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': json.dumps(notes)}]}]}))
    with pytest.raises(SpeechError, match='invalid response'):
        summarize_text('Approved', transport=transport)


@pytest.mark.parametrize('text', ['OK', 'ok.', 'Okay.', ' OKAY!? ', 'okay…'])
def test_acknowledgement_only_is_reviewed_even_when_model_says_content(monkeypatch, text):
    monkeypatch.setenv('REEL_ALLOWED_EMAILS', 'owner@example.com')
    monkeypatch.setenv('OPENAI_API_KEY', 'secret-test')
    claims = {'sub': 'uid', 'email': 'owner@example.com', 'email_verified': True,
              'iss': 'https://securetoken.google.com/advisr-485ac', 'aud': 'advisr-485ac'}
    notes = provider_notes(title='Meeting', summary='Acknowledged.')
    transport = httpx.MockTransport(lambda req: httpx.Response(200, json={'status': 'completed', 'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': json.dumps(notes)}]}]}))
    client = create_app(auth_verifier=lambda _: claims, speech_transport=transport).test_client()
    response = client.post('/summary', json={'text': text}, headers={'Authorization': 'Bearer token'})
    assert response.status_code == 422 and response.json['code'] == 'meeting_review_required'
    assert 'summary' not in response.json and response.headers['Cache-Control'] == 'no-store'


@pytest.mark.parametrize('text', ['Approved.', 'Move it to Friday.'])
def test_short_decisions_remain_deliverable(monkeypatch, text):
    monkeypatch.setenv('REEL_ALLOWED_EMAILS', 'owner@example.com')
    monkeypatch.setenv('OPENAI_API_KEY', 'secret-test')
    claims = {'sub': 'uid', 'email': 'owner@example.com', 'email_verified': True,
              'iss': 'https://securetoken.google.com/advisr-485ac', 'aud': 'advisr-485ac'}
    notes = provider_notes(title='Meeting', summary=text)
    transport = httpx.MockTransport(lambda req: httpx.Response(200, json={'status': 'completed', 'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': json.dumps(notes)}]}]}))
    client = create_app(auth_verifier=lambda _: claims, speech_transport=transport).test_client()
    response = client.post('/summary', json={'text': text}, headers={'Authorization': 'Bearer token'})
    assert response.status_code == 200 and response.json['summary'] == 'Outcome\n' + text


@pytest.mark.parametrize(('owner', 'evidence'), [
    ('Vaibhav', 'Thank you, Vaibhav. I will share the build tomorrow.'),
    ('Wahid', 'Thank you, Vaibhav. I will share the build tomorrow.'),
    ('Wahid', 'Wahid will share the build tomorrow.'),
])
def test_misheard_or_unsupported_owner_remains_unconfirmed(monkeypatch, owner, evidence):
    monkeypatch.setenv('OPENAI_API_KEY', 'secret-test')
    notes = provider_notes(action_items=[{'owner': owner, 'task': 'Share the build', 'due': 'Tomorrow', 'evidence': evidence}])
    transport = httpx.MockTransport(lambda req: httpx.Response(200, json={'status': 'completed', 'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': json.dumps(notes)}]}]}))
    result = summarize_text('Thank you, Vaibhav. I will share the build tomorrow.', attendees=['wahid@example.com'], transport=transport)
    assert result['action_items'] == [{'owner': '', 'task': 'Share the build', 'due': 'Tomorrow'}]
    assert 'Vaibhav' not in result['summary']
    assert 'Owner unconfirmed: Share the build' in result['summary']


def test_roster_names_and_compact_sections_preserve_decisions_and_uncertainty(monkeypatch):
    from speech import attendee_keywords
    monkeypatch.setenv('OPENAI_API_KEY', 'secret-test')
    requests = []
    notes = provider_notes(summary='Release approved; attribution still needs checking.',
        key_points=[{'topic': 'Revenue', 'detail': 'SDK and server reporting may overlap.'}],
        decisions=['Do not scale until reporting is verified.'], open_questions=['India or Philippines remains undecided.'],
        action_items=[{'owner': 'Wahid', 'task': 'Share the build', 'due': 'Tomorrow', 'evidence': 'Wahid, share the build tomorrow.'}])
    def handler(req):
        requests.append(req)
        return httpx.Response(200, json={'status': 'completed', 'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': json.dumps(notes)}]}]})
    names = {'wahid@example.com': 'Wahid Khan'}
    result = summarize_text('Wahid, share the build tomorrow.', attendees=['wahid@example.com'], attendee_names=names, transport=httpx.MockTransport(handler))
    assert result['action_items'][0]['owner'] == 'Wahid Khan'
    assert result['summary'] == ('Outcome\nRelease approved; attribution still needs checking.'
        '\n\nKey points\n• Revenue: SDK and server reporting may overlap.'
        '\n\nDecisions\n• Do not scale until reporting is verified.'
        '\n\nAction items\n• Wahid Khan: Share the build (due: Tomorrow)'
        '\n\nOpen questions\n• India or Philippines remains undecided.')
    context = json.loads(json.loads(requests[0].content)['input'])
    assert context['attendee_context'] == [{'email': 'wahid@example.com', 'name_hint': 'Wahid Khan'}]
    assert context['speaker_attribution'] == 'unavailable'
    assert attendee_keywords(['wahid@example.com', 'ana.smith@example.com'], names) == ['Wahid Khan', 'wahid', 'ana smith']


@pytest.mark.parametrize('evidence', [
    'Thanks, Wahid. I will share the build tomorrow.',
    'I spoke to Wahid. I will share the build tomorrow.',
    'Wahid will not share the build tomorrow.',
])
def test_an_attendee_mention_alone_does_not_assign_an_action(evidence):
    from speech import _grounded_owner, attendee_context
    context = attendee_context(['wahid@example.com'])
    assert _grounded_owner('Wahid', evidence, evidence, context, 'Share the build') == ''


def test_owner_excerpt_must_name_one_person_and_match_whole_words():
    from speech import _grounded_owner, attendee_context
    context = attendee_context(['alice.jones@example.com', 'alice.smith@example.com'])
    assert _grounded_owner('Alice Jones', 'Alice will send it.', 'Alice will send it.', context, 'Send it') == ''
    context = attendee_context(['alice@example.com'])
    assert _grounded_owner('Alice', 'alice will send it.', 'Malice will send it.', context, 'Send it') == ''
    assert _grounded_owner('Alice', 'Alice will send it.', 'Alice will send it.', context, 'Send it') == 'Alice'
    assert _grounded_owner('Alice', 'Alice, please send it.', 'Alice, please send it.', context, 'Send it') == 'Alice'
    quote = 'Alice will review it. I will send the build.'
    assert _grounded_owner('Alice', quote, quote, context, 'Send the build') == ''
    quote = 'Alice will send the contract. I will send the build.'
    assert _grounded_owner('Alice', quote, quote, context, 'Send the build') == ''
    quote = 'Alice will send the contract, and I will send the build.'
    assert _grounded_owner('Alice', quote, quote, context, 'Send the build') == ''
    quote = 'We will not delay. Alice will send it.'
    assert _grounded_owner('Alice', quote, quote, context, 'Send it') == 'Alice'
    context = attendee_context(['bo@example.com'], {'bo@example.com': 'Bo'})
    assert _grounded_owner('Bo', 'Bo will send it.', 'Bo will send it.', context, 'Send it') == 'Bo'


def test_duplicate_email_casing_and_unusable_spelling_hints_do_not_block_recognition():
    from speech import _grounded_owner, attendee_context, attendee_keywords
    context = attendee_context(['Alice@example.com', 'alice@example.com'])
    assert _grounded_owner('Alice', 'Alice will send it.', 'Alice will send it.', context, 'Send it') == 'Alice'
    assert attendee_keywords(['bad', 'alice@example.com'], {'other@example.com': 'Other', 'alice@example.com': 'Bad\nName'}) == ['alice']


def speaker_turn(text, speaker=None, start=0, **fields):
    turn = {'start': start, 'end': start + 10, 'text': text}
    if speaker is not None:
        turn.update(speaker_name=speaker, speaker_source='google_meet_caption', speaker_match='caption_text_match')
    return {**turn, **fields}


@pytest.fixture
def speaker_notes(monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'secret-test')

    def summarize(text, turns, *, owner='Ana', task='Send the build', evidence='', names=None):
        names = {'ana@example.com': 'Ana Skopelja', 'bo@example.com': 'Bo Novak'} if names is None else names
        notes = provider_notes(action_items=[{'owner': owner, 'task': task, 'due': '', 'evidence': evidence}])
        requests = []

        def handler(req):
            requests.append(json.loads(req.content))
            return httpx.Response(200, json={'status': 'completed', 'output': [{'type': 'message', 'content': [
                {'type': 'output_text', 'text': json.dumps(notes)}]}]})

        result = summarize_text(text, attendees=list(names), attendee_names=names,
                                speaker_turns=turns, transport=httpx.MockTransport(handler))
        return result['action_items'][0]['owner'], json.loads(requests[0]['input']), requests[0]['instructions']

    return summarize


def test_matched_speaker_dialogue_is_sent_to_provider(speaker_notes):
    commitment = 'I will send the build tomorrow.'
    turns = [speaker_turn('Agreed. ', 'Bo Novak', speaker_source='teams_caption', speaker_id='platform-private-id'),
             speaker_turn(commitment, 'Ana Skopelja', 10), speaker_turn('Thanks.', start=20)]
    owner, context, instructions = speaker_notes('Agreed. ' + commitment + '\nThanks.', turns, evidence=commitment)
    assert owner == 'Ana Skopelja'
    assert context['speaker_attribution'] == 'caption_text_match'
    assert context['dialogue'] == [
        {'text': 'Agreed. ', 'speaker_name': 'Bo Novak', 'speaker_source': 'teams_caption', 'speaker_match': 'caption_text_match'},
        {'text': commitment, 'speaker_name': 'Ana Skopelja', 'speaker_source': 'google_meet_caption', 'speaker_match': 'caption_text_match'},
        {'text': 'Thanks.', 'speaker_name': None},
    ]
    assert 'caption_text_match' in instructions and 'roster order' in instructions
    assert 'null speaker_name' in instructions and 'not proof of an email identity' in instructions


@pytest.mark.parametrize('unsafe_metadata', [
    {'speaker_source': 'calendar_roster'}, {'speaker_source': {}}, {'speaker_match': 'speaker_guess'},
    {'speaker_name': 'Ana\nSkopelja'}, {'speaker_name': 'Ana\u200fSkopelja'}, {'speaker_name': 'A' * 121},
])
def test_invalid_speaker_labels_are_unknown(speaker_notes, unsafe_metadata):
    commitment = 'I can send the build.'
    turns = [speaker_turn('Approved.', 'Bo Novak'), speaker_turn(commitment, 'Ana Skopelja', 10, **unsafe_metadata)]
    owner, context, _ = speaker_notes('Approved.\n' + commitment, turns, evidence=commitment)
    assert owner == ''
    assert context['dialogue'][1] == {'text': commitment, 'speaker_name': None}


@pytest.mark.parametrize('turns', [
    None, {}, [None], [speaker_turn('I will send the build.', start=0)],
    [speaker_turn('Changed transcript.', 'Ana Skopelja')],
    [speaker_turn('I will send', 'Ana Skopelja')],
    [speaker_turn('the build.', 'Ana Skopelja'), speaker_turn('I will send', 'Ana Skopelja', 10)],
    [speaker_turn('I will send', 'Ana Skopelja'), speaker_turn('the build.', 'Ana Skopelja', 5)],
    [speaker_turn('I will send the build.', 'Ana Skopelja', end=float('inf'))],
    [None] * 5001,
])
def test_incomplete_or_invalid_dialogue_uses_the_legacy_summary_input(speaker_notes, turns):
    text = 'I will send the build.'
    assert speaker_notes(text, turns, evidence=text) == speaker_notes(text, None, evidence=text)
    owner, context, _ = speaker_notes(text, turns, evidence=text)
    assert owner == '' and context['speaker_attribution'] == 'unavailable' and context['transcript'] == text
    assert 'dialogue' not in context


@pytest.mark.parametrize(('text', 'evidence', 'task', 'expected'), [
    ('I can send the build.', 'I can send the build.', 'Send the build', 'Ana Skopelja'),
    ('I’ll send the build tomorrow.', 'I’ll send the build', 'Send the build', 'Ana Skopelja'),
    ('I will not send the build.', 'I will not send the build.', 'Send the build', ''),
    ('If approved, I will send the build.', 'I will send the build', 'Send the build', ''),
    ('I will send the build if approved.', 'I will send the build', 'Send the build', ''),
    ('I will send the build?', 'I will send the build', 'Send the build', ''),
    ('Bo said I will send the build.', 'I will send the build', 'Send the build', ''),
    ('I will send the build.', 'I will send the build.', 'Send the build and invite Bo', ''),
    ('I will send the new build.', 'I will send the new build.', 'Send the build', ''),
])
def test_first_person_ownership_requires_a_whole_unconditional_commitment(speaker_notes, text, evidence, task, expected):
    owner, _, _ = speaker_notes(text, [speaker_turn(text, 'Ana Skopelja')], evidence=evidence, task=task)
    assert owner == expected


@pytest.mark.parametrize(('turns', 'evidence', 'names'), [
    ([speaker_turn('I will send the build.', 'Bo Novak')], 'I will send the build.', None),
    ([speaker_turn('I will send the build.', 'Ana Skopelja')], 'I will send the build.',
     {'ana@example.com': 'Ana Skopelja', 'another@example.com': 'Ana Skopelja'}),
    ([speaker_turn('I will send the build.', 'Ana Skopelja'), speaker_turn('Thanks.', 'Ana', 10)], 'I will send the build.',
     {'ana@example.com': 'Ana Skopelja', 'ana.smith@example.com': 'Ana Smith'}),
    ([speaker_turn('Ana, can you check the release?', 'Bo Novak'), speaker_turn('I will send the build.', start=10)],
     'I will send the build.', None),
    ([speaker_turn('I will send', 'Ana Skopelja'), speaker_turn('the build.', 'Bo Novak', 10)], 'I will send the build.', None),
    ([speaker_turn('I will send the build.', 'Ana Skopelja'), speaker_turn('I will send the build.', 'Bo Novak', 10)],
     'I will send the build.', None),
    ([speaker_turn('I will send the build.', 'Ana Skopelja', speaker_id='first'),
      speaker_turn('Thanks.', 'Ana Skopelja', 10, speaker_id='second')], 'I will send the build.', None),
])
def test_first_person_ownership_requires_a_unique_speaker_and_roster_match(speaker_notes, turns, evidence, names):
    owner, context, _ = speaker_notes(' '.join(turn['text'] for turn in turns), turns, evidence=evidence, names=names)
    assert context['speaker_attribution'] == 'caption_text_match' and owner == ''


def test_public_summary_endpoint_rejects_supplied_speaker_context(setup):
    client, _, requests = setup
    result = client.post('/summary', json={'text': 'Approved.', 'speaker_turns': [speaker_turn('Approved.', 'Ana Skopelja')]},
                         headers={'Authorization': 'Bearer token'})
    assert result.status_code == 400 and not requests

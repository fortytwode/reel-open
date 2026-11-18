"""Exercise the public delivery adapter through Notion HTTP and the durable outbox."""
from copy import deepcopy
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
import hashlib
import json
from unittest.mock import Mock
from urllib.parse import parse_qs, urlsplit

import pytest
import requests

from app import Conflict, ProviderPending, ProviderRejected, deliver, digest_key
from test_gmail_recovery import Gmail
from test_orchestration import Store
from standalone_providers import StandaloneProviders, _gmail_service


SOURCE = '5733992a-5c4a-4e19-817c-e8cc8e9accc3'
DATABASE = 'abe6a90b-5e71-460a-8874-261b13c8e026'
PAGE = '84748288-6e22-4355-8f4a-d9328b1e34ee'
MEETING = 'reel_' + 'f' * 64
OWNER = 'owner@north.example'
SENDER = 'recaps@north.example'
PAYLOAD = {'id': 'ee5ecec6-e403-4163-8f95-b503e3648c40', 'title': 'Design review',
           'started_at': '2026-11-17T12:00:00Z', 'attendees': [], 'summary': 'Next steps',
           'segments': [{'text': 'Full transcript'}], 'calendar': None}


def result_page(items, next_cursor=None):
    return {'object': 'list', 'results': items, 'has_more': next_cursor is not None, 'next_cursor': next_cursor}


def notion_page(page_id, properties):
    return {'object': 'page', 'id': page_id, 'archived': False, 'in_trash': False,
            'url': f'https://www.notion.so/{page_id}', 'public_url': None, 'properties': properties,
            'parent': {'type': 'data_source_id', 'data_source_id': SOURCE}}


class Notion:
    def __init__(self):
        self.calls = []
        self.page = None
        self.blocks = []
        self.query_result = None
        self.block_result = None
        self.create_status = 200
        self.rejection = None
        self.unrelated = notion_page('0176bb01-2fb4-473d-ab7c-8f2750d8766e', {
            'Meeting ID': {'type': 'rich_text', 'rich_text': [{'text': {'content': 'another-meeting'}}]}})
        self.public_url = None

    def send(self, request, **kwargs):
        url = urlsplit(request.url)
        assert url.scheme == 'https' and url.netloc == 'api.notion.com'
        assert kwargs['timeout'] == 30 and kwargs['allow_redirects'] is False
        assert request.headers['Notion-Version'] == '2025-09-03'
        assert request.headers['Authorization'] == 'Bearer test-notion'
        body = json.loads(request.body) if request.body else {}
        self.calls.append((request.method, url.path, body))
        status = 200
        if url.path == f'/v1/data_sources/{SOURCE}/query':
            wanted = body['filter']['rich_text']['equals']
            assert body['filter'] == {'property': 'Meeting ID', 'rich_text': {'equals': wanted}}
            candidates = [page for page in (self.unrelated, self.page) if page is not None]
            matches = [page for page in candidates if
                       page['properties']['Meeting ID']['rich_text'][0]['text']['content'] == wanted]
            data = self.query_result if self.query_result is not None else result_page(matches)
        elif url.path == f'/v1/data_sources/{SOURCE}':
            data = {'object': 'data_source', 'id': SOURCE,
                    'parent': {'type': 'database_id', 'database_id': DATABASE}}
        elif url.path == f'/v1/databases/{DATABASE}':
            data = {'object': 'database', 'id': DATABASE, 'public_url': self.public_url}
        elif (request.method, url.path) == ('POST', '/v1/pages') and self.rejection:
            status, code, _ = self.rejection
            data = {'object': 'error', 'status': status, 'code': code}
        elif (request.method, url.path) == ('POST', '/v1/pages'):
            assert body['parent'] == {'type': 'data_source_id', 'data_source_id': SOURCE}
            assert len(request.body) <= 500_000 and len(body['children']) <= 100
            assert body['properties']['title']['title'][0]['text']['content'] == PAYLOAD['title']
            self.blocks = deepcopy(body['children'])
            for block in self.blocks:
                block['in_trash'] = False
                block['has_children'] = False
                rich = block[block['type']]['rich_text']
                assert len(rich) <= 100
                assert all(len(part['text']['content'].encode('utf-16-le')) <= 4000 for part in rich)
            props = deepcopy(body['properties'])
            props['Meeting ID']['type'] = 'rich_text'
            self.page = notion_page(PAGE, props)
            data, status = self.page, self.create_status
        elif url.path == f'/v1/pages/{PAGE}':
            data = self.page
        elif url.path == f'/v1/blocks/{PAGE}/children':
            cursor = parse_qs(url.query).get('start_cursor')
            if self.block_result is not None:
                data = self.block_result
            else:
                data = result_page(self.blocks[1:]) if cursor else result_page(self.blocks[:1], 'second')
        else:
            raise AssertionError(request.url)
        response = requests.Response()
        response.status_code = status
        if self.rejection and status == self.rejection[0]:
            response.headers['Retry-After'] = self.rejection[2]
        response._content = json.dumps(data).encode()
        return response


@pytest.fixture
def runtime(monkeypatch):
    for key, value in {'REEL_ORGANIZATION_DOMAIN': 'north.example', 'REEL_RECAP_SENDER': SENDER,
                       'NOTION_TOKEN': 'test-notion', 'REEL_NOTION_DATA_SOURCE_ID': SOURCE,
                       'GOOGLE_CALENDAR_CREDENTIALS': 'test-delegation.json',
                       'REEL_NOTES_BASE_URL': 'https://notes.north.example/reel'}.items():
        monkeypatch.setenv(key, value)
    notion, gmail, store = Notion(), Gmail(), Store()
    send = requests.Session.send

    def dispatch(session, request, **kwargs):
        if urlsplit(request.url).hostname == 'api.notion.com':
            return notion.send(request, **kwargs)
        return send(session, request, **kwargs)

    monkeypatch.setattr(requests.Session, 'send', dispatch)

    def gmail_service(path, sender):
        assert (path, sender) == ('test-delegation.json', SENDER)
        return gmail

    monkeypatch.setattr('standalone_providers._gmail_service', gmail_service)
    return StandaloneProviders(store=store), notion, gmail, store


def test_inline_full_readback_and_private_route(runtime):
    provider, notion, _, store = runtime
    transcript = ('Δ🌲\n' * 40_000) + 'end'
    fences = []
    with provider.context(lambda: fences.append(len(notion.calls))):
        assert provider.find_notion(MEETING) is None
        receipt = provider.create_notion(MEETING, PAYLOAD, [OWNER], transcript)
        assert provider.find_notion(MEETING) == receipt
        provider.verify_notion(receipt, MEETING, transcript)
        route = provider.choose_route('A customer', [OWNER, 'client@elsewhere.example'], False)
        assert route == {'kind': 'private'}
        provider.apply_route(receipt, route, MEETING, PAYLOAD, [OWNER])
    assert set(fences) == set(range(len(notion.calls) + 1))
    assert not store.items
    with pytest.raises(ProviderPending):
        provider.verify_notion(receipt, MEETING, transcript[:-1])
    notion.page['properties']['Meeting ID']['rich_text'][0]['text']['content'] = 'different'
    with pytest.raises(ProviderPending):
        provider.verify_notion(receipt, MEETING, transcript)
    assert provider.find_notion(MEETING) is None
    notion.query_result = result_page([notion.page])
    with pytest.raises(ProviderPending):
        provider.find_notion(MEETING)


@pytest.mark.parametrize('variable,value', [('NOTION_TOKEN', ''), ('REEL_NOTION_DATA_SOURCE_ID', ''),
    ('REEL_NOTION_DATA_SOURCE_ID', '../pages'), ('REEL_RECAP_SENDER', 'wrong@outside.example'),
    ('GOOGLE_CALENDAR_CREDENTIALS', ''), ('REEL_NOTES_BASE_URL', '')])
def test_missing_configuration_before_mutation(runtime, monkeypatch, variable, value):
    _, notion, gmail, store = runtime
    monkeypatch.setenv(variable, value)
    with pytest.raises(ProviderPending, match=variable):
        StandaloneProviders(store=store)
    assert not notion.calls and not gmail.creates and not store.items


@pytest.mark.parametrize('result', [{}, {'results': [], 'has_more': False}, result_page([{}]),
    {**result_page([]), 'has_more': True}, result_page([], 'cycle'),
    {**result_page([]), 'request_status': {'type': 'incomplete'}}])
def test_unresolved_query_is_never_absence(runtime, result):
    provider, notion, _, _ = runtime
    notion.query_result = result
    with pytest.raises(ProviderPending):
        provider.find_notion(MEETING)


def test_unexpected_parent_and_incomplete_children_fail_readback(runtime):
    provider, notion, _, _ = runtime
    receipt = provider.create_notion(MEETING, PAYLOAD, [OWNER], 'text')
    notion.block_result = {**result_page(notion.blocks), 'has_more': True}
    with pytest.raises(ProviderPending):
        provider.verify_notion(receipt, MEETING, 'text')
    notion.page['parent']['data_source_id'] = PAGE
    with pytest.raises(ProviderPending):
        provider.apply_route(receipt, {'kind': 'private'}, MEETING, PAYLOAD, [OWNER])


def test_oversize_has_verified_immutable_private_archive(runtime):
    provider, notion, _, store = runtime
    transcript = '🌲' * 140_000
    receipt = provider.create_notion(MEETING, PAYLOAD, [OWNER], transcript)
    digest = hashlib.sha256(transcript.encode()).hexdigest()
    key = f'transcript-archive/{MEETING}/{digest}'
    state, generation = store.load(key)
    assert state['transcript'] == transcript and generation == 1
    assert list(store.items) == [key]
    marker = notion.blocks[-1]['paragraph']['rich_text'][0]['text']
    link = 'https://notes.north.example/reel#meetings/' + MEETING
    assert marker['link']['url'] == link
    assert 'storage.googleapis.com' not in json.dumps(notion.blocks)
    provider.verify_notion(receipt, MEETING, transcript)
    marker['link']['url'] += 'wrong'
    with pytest.raises(ProviderPending):
        provider.verify_notion(receipt, MEETING, transcript)
    marker['link']['url'] = link
    store.items[key] = ({'transcript': transcript[:-1]}, generation)
    with pytest.raises(ProviderPending):
        provider.verify_notion(receipt, MEETING, transcript)
    creates = sum(path == '/v1/pages' for _, path, _ in notion.calls)
    with pytest.raises(ProviderRejected):
        provider.create_notion(MEETING, PAYLOAD, [OWNER], transcript)
    assert creates == sum(path == '/v1/pages' for _, path, _ in notion.calls)


def test_uncertain_create_and_mail_recover_once(runtime):
    provider, notion, gmail, store = runtime
    now = 1000
    def attempt():
        return deliver(PAYLOAD, OWNER, store, provider, None, lambda: now)
    notion.create_status = 503
    with pytest.raises(ProviderPending) as exc:
        attempt()
    assert not isinstance(exc.value, ProviderRejected)
    wanted = 'reel_' + digest_key('manual', OWNER, PAYLOAD['id'])
    assert notion.calls[0][2]['filter'] == {'property': 'Meeting ID', 'rich_text': {'equals': wanted}}
    assert gmail.creates == 0
    notion.query_result = result_page([])
    now += 61
    with pytest.raises(Conflict):
        attempt()
    notion.query_result = None
    gmail.fail_create = True
    with pytest.raises(TimeoutError):
        attempt()
    gmail.fail_send = True
    now += 61
    with pytest.raises(TimeoutError):
        attempt()
    now += 61
    receipt = attempt()
    assert receipt['recipients'] == [OWNER] and receipt['route'] == 'private'
    assert sum(path == '/v1/pages' for _, path, _ in notion.calls) == 1
    assert (gmail.creates, gmail.sends) == (1, 1)
    assert all(f'from:{SENDER}' in query for query in gmail.queries)
    headers = gmail.records['sent-message-1']['payload']['headers']
    assert {'name': 'From', 'value': SENDER} in headers
    marker = next(header['value'] for header in headers if header['name'].lower() == 'x-reel-delivery-id')
    assert marker.strip() == receipt['notes_url'].split('/')[-1]


def test_published_destination_is_rejected_before_upload(runtime):
    provider, notion, _, store = runtime
    notion.public_url = 'https://example.notion.site/public-meetings'
    with pytest.raises(ProviderRejected):
        provider.create_notion(MEETING, PAYLOAD, [OWNER], 'private' * 100_000)
    assert not store.items and not notion.page
    assert all(method == 'GET' for method, _, _ in notion.calls)


def occurrence(store):
    return next(value[0] for key, value in store.items.items() if key.startswith('occurrence/'))


@pytest.mark.parametrize('legacy', [False, True])
def test_published_url_survives_restart(runtime, monkeypatch, legacy):
    provider, _, gmail, store = runtime
    gmail.fail_create = True
    with pytest.raises(TimeoutError):
        deliver(PAYLOAD, OWNER, store, provider, None, lambda: 1000)
    note = next(value[0] for key, value in store.items.items() if key.startswith('notes/'))
    if legacy:
        occurrence(store).pop('notes_url', None)
    monkeypatch.setenv('REEL_NOTES_BASE_URL', 'https://new.north.example/reel')
    receipt = deliver(PAYLOAD, OWNER, store, StandaloneProviders(store=store), None, lambda: 1061)
    assert receipt['notes_url'] == note['notes_url'] == occurrence(store)['notes_url']
    assert (gmail.creates, gmail.sends) == (1, 1)


@pytest.mark.parametrize('legacy', [False, True])
def test_archived_url_survives_restart_before_publication(runtime, monkeypatch, legacy):
    provider, notion, gmail, store = runtime
    payload = {**PAYLOAD, 'segments': [{'text': 'a' * 510_000}]}
    notion.create_status = 503
    expected = 'https://notes.north.example/reel#meetings/reel_' + digest_key('manual', OWNER, PAYLOAD['id'])
    write = store.cas

    def verify_archive_boundary(key, value, generation):
        if key.startswith('transcript-archive/'):
            assert occurrence(store)['notes_url'] == expected
            assert not occurrence(store).get('notion_create_uncertain')
        return write(key, value, generation)

    monkeypatch.setattr(store, 'cas', verify_archive_boundary)
    with pytest.raises(ProviderPending):
        deliver(payload, OWNER, store, provider, None, lambda: 1000)
    marker = notion.blocks[-1]['paragraph']['rich_text'][0]['text']['link']
    original = marker['url']
    monkeypatch.setenv('REEL_NOTES_BASE_URL', 'https://new.north.example/library')
    if legacy:
        occurrence(store).pop('notes_url', None)
        monkeypatch.setenv('REEL_ALLOWED_ORIGINS', 'https://notes.north.example')
    provider = StandaloneProviders(store=store)
    marker['url'] = original.replace('notes.north.example', 'untrusted.example')
    with pytest.raises(ProviderPending):
        deliver(payload, OWNER, store, provider, None, lambda: 1061)
    assert not gmail.creates and not any(key.startswith('notes/') for key in store.items)
    marker['url'] = original
    provider.create_draft = Mock(wraps=provider.create_draft)
    receipt = deliver(payload, OWNER, store, provider, None, lambda: 1062)
    assert receipt['notes_url'] == original == occurrence(store)['notes_url'] == expected
    message = provider.create_draft.call_args.args[1]
    assert all(original in part.get_payload(decode=True).decode() for part in message.get_payload())
    assert sum(path == '/v1/pages' for _, path, _ in notion.calls) == 1
    assert (gmail.creates, gmail.sends) == (1, 1)


def test_destination_read_outlives_deadline_before_create(runtime, monkeypatch):
    provider, notion, gmail, store = runtime
    original = notion.send
    now = 1000

    def delay(request, **kwargs):
        nonlocal now
        response = original(request, **kwargs)
        if request.url.endswith('/databases/' + DATABASE):
            now += 40
        return response

    monkeypatch.setattr(notion, 'send', delay)
    with pytest.raises(Conflict):
        deliver(PAYLOAD, OWNER, store, provider, None, lambda: now, deadline=1060)
    assert not notion.page and not gmail.creates
    assert not occurrence(store).get('notion_create_uncertain')
    assert deliver(PAYLOAD, OWNER, store, provider, None, lambda: now)['verified']
    assert sum(path == '/v1/pages' for _, path, _ in notion.calls) == 1


@pytest.mark.parametrize('status,code', [(409, 'conflict_error'), (529, 'service_overload'), (429, 'rate_limited')])
def test_documented_rejection_honors_durable_retry_after(runtime, status, code):
    provider, notion, gmail, store = runtime
    notion.rejection = (status, code, '90')
    with pytest.raises(ProviderRejected):
        deliver(PAYLOAD, OWNER, store, provider, None, lambda: 1000)
    assert not notion.page and not gmail.creates
    retry_provider = StandaloneProviders(store=store)
    previous = len(notion.calls)
    with pytest.raises(Conflict):
        deliver(PAYLOAD, OWNER, store, retry_provider, None, lambda: 1089)
    assert len(notion.calls) == previous
    notion.rejection = None
    assert deliver(PAYLOAD, OWNER, store, retry_provider, None, lambda: 1090)['verified']
    assert sum(path == '/v1/pages' for _, path, _ in notion.calls) == 2
    assert (gmail.creates, gmail.sends) == (1, 1)


@pytest.mark.parametrize('status', [409, 529])
def test_unrecognized_write_failure_remains_uncertain(runtime, status):
    provider, notion, gmail, store = runtime
    notion.rejection = (status, 'unknown', '0')
    with pytest.raises(ProviderPending) as failure:
        deliver(PAYLOAD, OWNER, store, provider, None, lambda: 1000)
    assert not isinstance(failure.value, ProviderRejected)
    notion.rejection = None
    with pytest.raises(Conflict):
        deliver(PAYLOAD, OWNER, store, provider, None, lambda: 1061)
    assert sum(path == '/v1/pages' for _, path, _ in notion.calls) == 1
    assert not notion.page and not gmail.creates


@pytest.mark.parametrize('adapter,mutation,fault', [
    ('standalone', 'create', 'disconnect'), ('canonical', 'create', 'disconnect'),
    ('standalone', 'create', 'redirect'), ('standalone', 'send', 'disconnect'),
    ('canonical', 'send', 'redirect'), ('standalone', 'create', 'unauthorized'),
    ('canonical', 'send', 'unauthorized')])
def test_gmail_wire_mutation_reconciles_once(runtime, monkeypatch, adapter, mutation, fault):
    from google.auth.credentials import AnonymousCredentials
    from google.oauth2 import service_account
    from google_auth_httplib2 import AuthorizedHttp
    from googleapiclient import discovery
    from googleapiclient.errors import HttpError

    provider, _, gmail, store = runtime

    class Credentials(AnonymousCredentials):
        refreshes = 0

        def with_subject(self, sender):
            return self

        def before_request(self, request, method, url, headers):
            headers['Authorization'] = f'Bearer offline-{self.refreshes}'

        def refresh(self, request):
            self.refreshes += 1

    credentials = Credentials()
    posts = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, data):
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(data).encode())

        def do_GET(self):
            if self.headers['Authorization'] == 'Bearer offline-0':
                self.send_response(401)
                self.end_headers()
                return
            url = urlsplit(self.path)
            method = url.path.split('/me/')[1]
            if method == 'messages':
                self.reply(gmail.messages().list(q=parse_qs(url.query)['q'][0]).execute())
            elif method == 'drafts':
                self.reply(gmail.drafts().list().execute())
            else:
                self.reply(gmail.messages().get(id=method.split('/')[-1]).execute())

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            sending = '/drafts/send?' in self.path
            action = 'send' if sending else 'create'
            posts.append(action)
            assert self.headers['Authorization'] != 'Bearer offline-0'
            if fault == 'unauthorized' and action == mutation and posts.count(action) == 1:
                self.send_response(401)
                self.end_headers()
                return
            if sending:
                result = gmail.drafts().send(body=body).execute()
            else:
                result = gmail.drafts().create(body=body).execute()
            if fault != 'unauthorized' and action == mutation and posts.count(action) == 1:
                if fault == 'redirect':
                    self.send_response(307)
                    self.send_header('Location', endpoint + 'redirected')
                    self.end_headers()
                self.close_connection = True
                return
            self.reply(result)

    with ThreadingHTTPServer(('127.0.0.1', 0), Handler) as server:
        endpoint = f'http://127.0.0.1:{server.server_port}/'
        monkeypatch.setenv('NO_PROXY', '127.0.0.1')
        monkeypatch.setattr(service_account.Credentials, 'from_service_account_file', lambda *a, **kw: credentials)
        monkeypatch.setattr(discovery, 'build', partial(discovery.build, client_options={'api_endpoint': endpoint}))
        if adapter == 'canonical':
            provider.gmail = None
            provider.canonical.get_gmail_service = lambda: discovery.build(
                'gmail', 'v1', http=AuthorizedHttp(credentials), static_discovery=True)
        else:
            provider.gmail = _gmail_service('offline', SENDER)
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            errors = (requests.ConnectionError, HttpError, ConnectionError)
            if fault == 'unauthorized' and mutation == 'create':
                errors = (ProviderRejected,)
            with pytest.raises(errors):
                deliver(PAYLOAD, OWNER, store, provider, None, lambda: 1000)
            assert credentials.refreshes == 1
            assert posts.count(mutation) == 1
            assert gmail.creates == (0 if (mutation, fault) == ('create', 'unauthorized') else 1)
            assert gmail.sends == int(mutation == 'send' and fault != 'unauthorized')
            if mutation == 'create':
                assert occurrence(store)['email_create_uncertain'] == (fault != 'unauthorized')
            else:
                assert occurrence(store)['email']['provider_draft_id'] == 'draft-1'
            assert deliver(PAYLOAD, OWNER, store, provider, None, lambda: 1061)['verified']
            assert posts.count(mutation) == (2 if fault == 'unauthorized' else 1)
            assert (gmail.creates, gmail.sends) == (1, 1)
        finally:
            server.shutdown()
            thread.join()

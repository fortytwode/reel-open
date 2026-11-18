"""Organization-configured, private Notion filing and delegated Gmail delivery."""
from functools import partial
import hashlib
import json
import os
from types import SimpleNamespace
from urllib.parse import urlsplit
from uuid import UUID

import requests
from google.api_core.exceptions import PreconditionFailed

from reel_organization import is_internal_email, notes_base_url, trusted_origins

if __package__:
    from .app import GCSStateStore, ProviderPending, ProviderRejected, validated_notes_url, verify_notion_page_identity
    from .providers import CanonicalProviders, DEFINITIVE_REJECTIONS, GmailHttp, _check
else:
    from app import GCSStateStore, ProviderPending, ProviderRejected, validated_notes_url, verify_notion_page_identity
    from providers import CanonicalProviders, DEFINITIVE_REJECTIONS, GmailHttp, _check


MAX_REQUEST_BYTES = 500_000


def _required(name):
    value = os.getenv(name, '').strip()
    if not value:
        raise ProviderPending(f'{name} is required for meeting delivery')
    return value


def _gmail_service(path, sender):
    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    try:
        credentials = service_account.Credentials.from_service_account_file(path, scopes=[
            'https://www.googleapis.com/auth/gmail.compose',
            'https://www.googleapis.com/auth/gmail.readonly',
        ]).with_subject(sender)
    except (OSError, ValueError) as exc:
        raise ProviderPending('GOOGLE_CALENDAR_CREDENTIALS could not supply delegated Gmail credentials') from exc
    http = GmailHttp(credentials)
    return build('gmail', 'v1', http=http, cache_discovery=False, static_discovery=True)


def _json_bytes(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()


def _rich(text):
    # A thousand Unicode code points also fits Notion's 2,000 UTF-16 unit cap.
    return [{'type': 'text', 'text': {'content': text[i:i + 1000]}} for i in range(0, len(text), 1000)]


def _block(kind, rich):
    return {'object': 'block', 'type': kind, kind: {'rich_text': rich}}


def _paragraphs(text):
    parts = _rich(text)
    return [_block('paragraph', parts[i:i + 100]) for i in range(0, len(parts), 100)]


def _encode_page(body):
    if len(body['children']) <= 100 and len(body['properties']['title']['title']) <= 100:
        encoded = _json_bytes(body)
        if len(encoded) <= MAX_REQUEST_BYTES:
            return encoded
    return None


def _notion_uuid(value):
    try:
        return str(UUID(value))
    except (ValueError, TypeError, AttributeError):
        return None


class StandaloneProviders(CanonicalProviders):
    def __init__(self, *, store=None):
        sender = _required('REEL_RECAP_SENDER').lower()
        if not is_internal_email(sender):
            raise ProviderPending('REEL_RECAP_SENDER must be an internal email address')
        self.source = _notion_uuid(_required('REEL_NOTION_DATA_SOURCE_ID'))
        if not self.source:
            raise ProviderPending('REEL_NOTION_DATA_SOURCE_ID must be a Notion UUID')
        token = _required('NOTION_TOKEN')
        self.notes_base = notes_base_url()
        if not self.notes_base:
            raise ProviderPending('REEL_NOTES_BASE_URL must identify the authenticated notes portal')
        path = _required('GOOGLE_CALENDAR_CREDENTIALS')
        self.store = store if store is not None else GCSStateStore(_required('DELIVERY_RECEIPTS_BUCKET'))
        # The shared Gmail outbox methods read their sender from this field.
        self.canonical = SimpleNamespace(CALENDAR_EMAIL=sender)
        self.gmail = _gmail_service(path, sender)
        self.notion = requests.Session()
        self.notion.headers.update({'Authorization': 'Bearer ' + token, 'Notion-Version': '2025-09-03',
                                    'Content-Type': 'application/json'})

    def message_id(self, key):
        digest = hashlib.sha256(key.encode()).hexdigest()
        return 'meeting-notes-' + digest + '@' + self.canonical.CALENDAR_EMAIL.rsplit('@', 1)[1]

    def _request(self, method, path, **kwargs):
        _check()
        try:
            response = self.notion.request(method, 'https://api.notion.com/v1/' + path,
                                           timeout=30, allow_redirects=False, **kwargs)
        except requests.RequestException as exc:
            raise ProviderPending('Notion response unavailable; retry to reconcile') from exc
        _check()
        if not 200 <= response.status_code < 300:
            if method == 'POST' and path == 'pages':
                status = response.status_code
                rejected = status in DEFINITIVE_REJECTIONS
                if status in (409, 529):
                    try:
                        error = response.json()
                    except ValueError:
                        error = None
                    rejected = isinstance(error, dict) and error.get('code') == {
                        409: 'conflict_error', 529: 'service_overload'}[status]
                if rejected:
                    delay = response.headers.get('Retry-After', '').strip()
                    seconds = int(delay) if delay.isascii() and delay.isdecimal() else 0
                    raise ProviderRejected(f'Notion rejected page creation (HTTP {status})', retry_after=seconds)
            raise ProviderPending(f'Notion returned HTTP {response.status_code}; retry to reconcile')
        try:
            result = response.json()
        except ValueError as exc:
            raise ProviderPending('Notion returned an unreadable response') from exc
        if not isinstance(result, dict):
            raise ProviderPending('Notion returned an incomplete response')
        return result

    def _results(self, method, path, **parameters):
        params = {'page_size': 100, **parameters}
        seen = set()
        while True:
            args = {'json': params} if method == 'POST' else {'params': params}
            data = self._request(method, path, **args)
            more = data.get('has_more')
            cursor = data.get('next_cursor')
            status = data.get('request_status')
            if (data.get('object') != 'list' or not isinstance(data.get('results'), list)
                    or not isinstance(more, bool) or 'next_cursor' not in data
                    or (status is not None and (not isinstance(status, dict) or status.get('type') != 'complete'))
                    or (not more and cursor is not None)):
                raise ProviderPending('Notion returned an incomplete result page')
            yield from data['results']
            if not more:
                return
            if not isinstance(cursor, str) or not cursor or cursor in seen:
                raise ProviderPending('Notion returned an invalid pagination cursor')
            seen.add(cursor)
            params['start_cursor'] = cursor

    def _receipt(self, page, meeting_id, expected_id=None):
        if not isinstance(page, dict) or page.get('object') != 'page':
            raise ProviderPending('Notion page identity is missing')
        page_id = _notion_uuid(page.get('id'))
        parent = page.get('parent')
        if (not page_id or (expected_id and page_id != _notion_uuid(expected_id))
                or page.get('in_trash') is not False or page.get('is_archived')
                or 'public_url' not in page or page['public_url'] is not None
                or not isinstance(parent, dict) or parent.get('type') != 'data_source_id'
                or _notion_uuid(parent.get('data_source_id')) != self.source
                or not isinstance(page.get('url'), str) or not page['url']):
            raise ProviderPending('Notion page is unavailable in the configured private data source')
        try:
            verify_notion_page_identity(page, page['id'], meeting_id)
        except (AttributeError, TypeError) as exc:
            raise ProviderPending('Notion Meeting ID is incomplete') from exc
        return {'page_id': page_id, 'url': page['url']}

    def find_notion(self, meeting_id):
        result = None
        for page in self._results('POST', f'data_sources/{self.source}/query',
                                  filter={'property': 'Meeting ID', 'rich_text': {'equals': meeting_id}}):
            if result is not None:
                raise ProviderPending('Multiple Notion pages match this meeting')
            result = self._receipt(page, meeting_id)
        return result

    def _archive_ref(self, meeting_id, transcript, link):
        digest = hashlib.sha256(transcript.encode()).hexdigest()
        part = {'type': 'text', 'text': {'content': f'Full transcript ({digest})', 'link': {'url': link}}}
        return f'transcript-archive/{meeting_id}/{digest}', part

    def _verify_archive(self, key, transcript):
        _check()
        state, _ = self.store.load(key)
        _check()
        if state != {'transcript': transcript}:
            raise ProviderPending('Private transcript archive failed full readback')

    def _check_destination(self):
        # Database sharing applies to all of its data sources. Verify web
        # publication before sending any meeting content to that database.
        source = self._request('GET', f'data_sources/{self.source}')
        parent = source.get('parent')
        database_id = _notion_uuid(parent.get('database_id')) if isinstance(parent, dict) else None
        if source.get('object') != 'data_source' or _notion_uuid(source.get('id')) != self.source or not database_id:
            raise ProviderPending('Notion data source parent is unavailable')
        database = self._request('GET', f'databases/{database_id}')
        if (database.get('object') != 'database' or _notion_uuid(database.get('id')) != database_id
                or 'public_url' not in database or database['public_url'] is not None):
            raise ProviderPending('Notion database must be unpublished')

    def prepare_notion(self, meeting_id, payload, attendees, transcript):
        try:
            self._check_destination()
        except ProviderPending as exc:
            raise ProviderRejected(str(exc)) from exc
        body = {'parent': {'type': 'data_source_id', 'data_source_id': self.source},
                'properties': {'title': {'title': _rich(payload['title'])},
                               'Meeting ID': {'rich_text': _rich(meeting_id)}}}
        intro = [_block('heading_2', _rich('Summary')), *_paragraphs(payload['summary']),
                 *_paragraphs(payload['started_at']), *_paragraphs(', '.join(attendees)),
                 _block('heading_2', _rich('Transcript'))]
        encoded = None
        if len(transcript) <= MAX_REQUEST_BYTES:
            body['children'] = intro + _paragraphs(transcript)
            encoded = _encode_page(body)
        if encoded is None:
            url = payload.get('notes_url', f'{self.notes_base}#meetings/{meeting_id}')
            key, marker = self._archive_ref(meeting_id, transcript, validated_notes_url(url, meeting_id))
            body['children'] = intro + [_block('paragraph', [marker])]
            encoded = _encode_page(body)
            if encoded is None or len(marker['text']['link']['url']) > 2000:
                raise ProviderRejected('Meeting metadata exceeds Notion page limits')
            # At this point no Notion create has been issued. Even an ambiguous
            # archive CAS can be retried safely at the same immutable key.
            try:
                _check()
                try:
                    self.store.cas(key, {'transcript': transcript}, 0)
                except PreconditionFailed:
                    pass
                self._verify_archive(key, transcript)
            except Exception as exc:
                raise ProviderRejected('Private transcript archive could not be verified before Notion creation') from exc
        return partial(self._submit_notion, meeting_id, encoded)

    def create_notion(self, meeting_id, payload, attendees, transcript):
        return self.prepare_notion(meeting_id, payload, attendees, transcript)()

    def _submit_notion(self, meeting_id, encoded):
        result = self._request('POST', 'pages', data=encoded)
        return self._receipt(result, meeting_id)

    def _check_page(self, page, meeting_id):
        page_id = _notion_uuid(page.get('page_id'))
        if not page_id:
            raise ProviderPending('Notion page identity is missing')
        self._receipt(self._request('GET', f'pages/{page_id}'), meeting_id, page_id)
        return page_id

    def verify_notion(self, page, meeting_id, transcript):
        self.verify_notion_with_notes_url(page, meeting_id, transcript, f'{self.notes_base}#meetings/{meeting_id}')

    def verify_notion_with_notes_url(self, page, meeting_id, transcript, notes_url):
        page_id = self._check_page(page, meeting_id)
        found = False
        text, linked = [], []
        for block in self._results('GET', f'blocks/{page_id}/children'):
            kind = block.get('type') if isinstance(block, dict) else None
            if (kind not in ('heading_2', 'paragraph') or block.get('object') != 'block'
                    or block.get('in_trash') is not False or block.get('has_children') is not False):
                raise ProviderPending('Notion returned an incomplete transcript block')
            details = block.get(kind)
            rich = details.get('rich_text') if isinstance(details, dict) else None
            if not isinstance(rich, list):
                raise ProviderPending('Notion returned incomplete rich text')
            content = []
            for part in rich:
                value = part.get('text') if isinstance(part, dict) and part.get('type') == 'text' else None
                if not isinstance(value, dict) or not isinstance(value.get('content'), str):
                    raise ProviderPending('Notion returned incomplete transcript text')
                content.append(value['content'])
                if found and value.get('link') is not None:
                    linked.append(value)
            if not found:
                found = kind == 'heading_2' and ''.join(content) == 'Transcript'
            elif kind == 'paragraph':
                text.extend(content)
            else:
                raise ProviderPending('Notion transcript section is ambiguous')
        if found and not linked and ''.join(text) == transcript:
            return
        if found and len(linked) == 1 and isinstance(linked[0].get('link'), dict):
            url = validated_notes_url(linked[0]['link'].get('url'), meeting_id)
            if notes_url is None:
                # Before URL checkpoints, only the editable Notion page held the
                # link. Require an operator-trusted origin before adopting it.
                parsed = urlsplit(url)
                current = urlsplit(self.notes_base)
                if (parsed.scheme, parsed.netloc) != (current.scheme, current.netloc) and (
                        f'{parsed.scheme}://{parsed.netloc}' not in trusted_origins()):
                    raise ProviderPending('Legacy transcript link origin is unverified')
            elif url != notes_url:
                raise ProviderPending('Notion transcript archive link changed')
            key, marker = self._archive_ref(meeting_id, transcript, url)
            if linked == [marker['text']] and text == [marker['text']['content']]:
                self._verify_archive(key, transcript)
                return url
        raise ProviderPending('Notion transcript failed full readback')

    def choose_route(self, title, attendees, manual):
        return {'kind': 'private'}

    def apply_route(self, page, route, meeting_id, payload, attendees):
        if route.get('kind') != 'private':
            raise ProviderPending('Meeting route differs from the configured private data source')
        self._check_page(page, meeting_id)

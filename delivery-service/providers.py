"""Reel adapter over the pinned, committed team-operations provider code."""
import base64
import os
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime
from urllib.parse import urlsplit

from reel_organization import is_internal_email

if __package__:
    from .app import DeliveryError, ProviderPending, ProviderRejected, verify_notion_transcript, verify_notion_page_identity
else:
    from app import DeliveryError, ProviderPending, ProviderRejected, verify_notion_transcript, verify_notion_page_identity

_guard = ContextVar('delivery_provider_guard', default=None)
_checking = ContextVar('delivery_checking_guard', default=False)
_installed = False
_notion_create_response = ContextVar('notion_create_response', default=None)
DEFINITIVE_REJECTIONS = {400, 401, 403, 404, 422, 429}
DELIVERY_MARKER_HEADER = 'X-Reel-Delivery-ID'


def _check():
    guard = _guard.get()
    if guard and not _checking.get():
        token = _checking.set(True)
        try:
            guard()
        finally:
            _checking.reset(token)


class _GmailTransport:
    """Fence each wire request, including delegated credential refreshes."""

    def __init__(self):
        import requests
        self.session = requests.Session()  # Default HTTP adapters have zero retries.

    def request(self, uri, method='GET', body=None, headers=None, **kwargs):
        from httplib2 import Response
        _check()
        response = self.session.request(method, uri, data=body, headers=headers,
                                        timeout=30, allow_redirects=False)
        _check()
        result = Response({**response.headers, 'status': str(response.status_code)})
        result.reason = response.reason
        return result, response.content

    def close(self):
        self.session.close()


class GmailHttp:
    """Allow auth refresh on reconciliation reads, never replay a Gmail mutation."""

    def __init__(self, credentials):
        from google_auth_httplib2 import AuthorizedHttp
        self.transport = _GmailTransport()
        self.reads = AuthorizedHttp(credentials, http=self.transport)
        self.writes = AuthorizedHttp(credentials, http=self.transport, max_refresh_attempts=0)

    def request(self, uri, method='GET', **kwargs):
        client = self.reads if method.upper() in ('GET', 'HEAD') else self.writes
        return client.request(uri, method, **kwargs)

    def close(self):
        self.transport.close()


def install_bounded_transports():
    """Fence every canonical HTTP call, including calls inside legacy helpers.

    This process runs only the Reel adapter, with one synchronous request per
    worker. Context-local guards never affect an unrelated Calendar request.
    """
    global _installed
    if _installed:
        return
    import requests
    import httplib2
    from googleapiclient.http import HttpRequest
    request = requests.Session.request
    execute = HttpRequest.execute
    http_request = httplib2.Http.request

    def bounded_request(session, method, url, **kwargs):
        # Receipt reads/writes implement the fence itself; do not recursively
        # fence their HTTP transport. They retain GCS generation preconditions.
        if urlsplit(url).hostname == 'storage.googleapis.com':
            kwargs['timeout'] = 30
            return request(session, method, url, **kwargs)
        _check()
        kwargs['timeout'] = 30
        response = request(session, method, url, **kwargs)
        _check()
        outcome = _notion_create_response.get()
        if outcome is not None and method.upper() == 'POST' and urlsplit(url).hostname == 'api.notion.com' and urlsplit(url).path == '/v1/pages':
            outcome['status'] = response.status_code
        return response

    def bounded_http_request(transport, *args, **kwargs):
        # Covers resumable uploads and MediaIoBaseDownload.next_chunk as well
        # as discovery calls; those can bypass HttpRequest.execute entirely.
        _check()
        transport.timeout = 30
        response = http_request(transport, *args, **kwargs)
        _check()
        return response

    def bounded_execute(request, http=None, num_retries=0):
        transport = http or request.http
        underlying = getattr(transport, 'http', transport)
        if hasattr(underlying, 'timeout'):
            underlying.timeout = 30
        return execute(request, http=http, num_retries=0)

    requests.Session.request = bounded_request
    HttpRequest.execute = bounded_execute
    httplib2.Http.request = bounded_http_request
    httplib2.RETRIES = 1  # Bound the legacy non-Gmail transport.
    _installed = True


def load_company_pages(canonical):
    """Read every Company page before resolving identity; never use partial data."""
    pages, cursor, seen = [], None, set()
    while True:
        payload = {'page_size':100}
        if cursor:
            payload['start_cursor'] = cursor
        response = canonical.requests.post(
            f'{canonical.NOTION_API_BASE}/databases/{canonical.NOTION_COMPANY_DB_ID}/query',
            headers=canonical._notion_headers(), json=payload, timeout=30)
        if response.status_code != 200:
            raise ProviderPending('Company identity source could not be read completely')
        data = response.json()
        if not isinstance(data, dict) or not isinstance(data.get('results'), list) or not isinstance(data.get('has_more'), bool):
            raise ProviderPending('Company identity source returned a malformed page')
        for page in data['results']:
            if not isinstance(page, dict) or not page.get('id') or not isinstance(page.get('properties'), dict):
                raise ProviderPending('Company identity source returned a malformed company')
            if not page.get('archived') and not page.get('in_trash'):
                pages.append(page)
        if not data['has_more']:
            return pages
        cursor = data.get('next_cursor')
        if not isinstance(cursor, str) or not cursor or cursor in seen:
            raise ProviderPending('Company identity source returned an invalid cursor')
        seen.add(cursor)


def resolve_company(pages, name, org_id):
    """Exact org ID first, then exact name; multiple distinct pages stay private."""
    def text(prop, kind):
        return ''.join(str(part.get('plain_text') or part.get('text', {}).get('content') or '') for part in prop.get(kind, [])).strip()
    for by_org in (True, False):
        if by_org and org_id in (None, ''):
            continue
        matches = {}
        for page in pages:
            props = page['properties']
            page_name = text(props.get('Name', {}), 'title')
            value = text(props.get('Pipedrive Org ID', {}), 'rich_text') if by_org else page_name.casefold()
            wanted = str(org_id).strip() if by_org else name.strip().casefold()
            if value == wanted:
                matches[page['id'].replace('-', '').lower()] = {'company_id':page['id'], 'company_name':page_name}
        if matches:
            return next(iter(matches.values())) if len(matches) == 1 else None
    return None


def choose_route(canonical, title, attendees, manual, clients=None, company_pages=None):
    """Reuse canonical identities, with no fuzzy or first-match ambiguity."""
    if manual:
        return {'kind':'private'}
    people = set(email.lower() for email in attendees if not email.endswith('@resource.calendar.google.com'))
    # Two internal invitees always use the private review archive, regardless
    # of title or which teammate initiated capture.
    if len(people) == 2 and all(is_internal_email(email) for email in people):
        return {'kind':'private'}

    if clients is None:
        # Unlike the legacy cache loader, a failed source read must propagate.
        from team_ops.client_metadata import load_profiles, coverage_for_call_followups
        profiles = load_profiles(use_cache=False)
        coverage = coverage_for_call_followups(profiles)
        clients = [{'name':item.profile.name, 'slug':item.profile.slug,
                    'toggl_name':item.profile.toggl_project_name,
                    'notion_page_id':item.profile.notion_page_id,
                    'email_domains':canonical._normalize_email_domains(item.profile.raw.get('email_domains')),
                    'planning_aliases':list(item.profile.raw.get('planning_aliases') or [])}
                   for item in coverage.included + coverage.degraded_missing_setup]
    external = sorted(email for email in people if not is_internal_email(email))
    business_domains = {e.split('@',1)[1] for e in external if '@' in e and e.split('@',1)[1] not in canonical._GENERIC_EMAIL_DOMAINS}

    def company_for_email(email, domain_fallback=True):
        nonlocal company_pages
        domain = email.split('@',1)[1]
        modes = (False, True) if domain_fallback and domain not in canonical._GENERIC_EMAIL_DOMAINS else (False,)
        for domain_mode in modes:
            term = domain if domain_mode else email
            companies = {}
            for person in canonical._pipedrive_search_person(term) or []:
                matched = canonical._person_has_domain(person, term) if domain_mode else canonical._person_has_email(person, term)
                if not matched or not person.get('org_name'):
                    continue
                if company_pages is None:
                    company_pages = load_company_pages(canonical)
                company = resolve_company(company_pages, person['org_name'], person.get('org_id'))
                if company is None:
                    return None
                companies[company['company_id']] = company
            if companies:
                return next(iter(companies.values())) if len(companies) == 1 else None
        return None

    candidates = [c for c in clients if business_domains & set(c.get('email_domains') or [])]
    if len(candidates) > 1:
        match = canonical._tiebreak_clients_by_title(title, candidates)
        if match is None:
            return {'kind':'private'}
    elif candidates:
        match = candidates[0]
    elif business_domains:
        match = None
    else:
        # Exact normalized company head/alias only; legacy fuzzy fallbacks are
        # inappropriate for deciding who can see a private transcript.
        head = canonical._extract_title_company_part(title).strip().casefold()
        candidates = [c for c in clients if head in {str(value or '').strip().casefold() for value in [c.get('name'), c.get('toggl_name'), *c.get('planning_aliases', [])]}]
        if len(candidates) > 1:
            return {'kind':'private'}
        match = candidates[0] if candidates else None
    if match:
        if business_domains - set(match.get('email_domains') or []):
            return {'kind':'private'}
        if not match.get('notion_page_id'):
            return {'kind':'private'}
        for email in external:
            if email.split('@',1)[1] in canonical._GENERIC_EMAIL_DOMAINS:
                company = company_for_email(email, domain_fallback=False)
                if company is None or not canonical._same_notion_id(company['company_id'], match['notion_page_id']):
                    return {'kind':'private'}
        return {'kind':'client', 'company_id':match['notion_page_id'], 'data_source_id':canonical.NOTION_COMPANY_CALLS_DATA_SOURCE_ID}

    companies = {}
    for email in external:
        company = company_for_email(email)
        if company is None:
            return {'kind':'private'}
        companies[company['company_id']] = company
    if len(companies) == 1:
        company = next(iter(companies.values()))
        return {'kind':'sales', 'company_id':company['company_id'], 'data_source_id':canonical.NOTION_COMPANY_CALLS_DATA_SOURCE_ID}
    return {'kind':'private'}


def gmail_pages(method, field, **kwargs):
    cursor, seen = None, set()
    while True:
        parameters = dict(kwargs)
        if cursor:
            parameters['pageToken'] = cursor
        page = method(**parameters).execute()
        if not isinstance(page, dict) or not isinstance(page.get(field, []), list):
            raise ProviderPending('Gmail returned a malformed result page')
        for item in page.get(field, []):
            if not isinstance(item, dict):
                raise ProviderPending('Gmail returned a malformed result')
            yield item
        cursor = page.get('nextPageToken')
        if not cursor:
            return
        if not isinstance(cursor, str) or cursor in seen:
            raise ProviderPending('Gmail returned an invalid result cursor')
        seen.add(cursor)


class CanonicalProviders:
    def __init__(self):
        import distribution
        self.canonical = distribution
        self.gmail = None
        install_bounded_transports()

    @contextmanager
    def context(self, guard):
        token = _guard.set(guard)
        try:
            yield
        finally:
            _guard.reset(token)

    def find_notion(self, meeting_id):
        return self.canonical._find_existing_notion_call(meeting_id)

    def one_on_one_route(self, title, attendees):
        """The teammate's own 1:1 database, using the same rules as the Fireflies flow, or None."""
        canonical = self.canonical
        if not canonical._get_active_team_members(raise_on_error=True):
            raise ProviderPending('Team members could not be read to classify a 1:1')
        member = canonical._detect_1on1_member(title, attendees)
        if not member:
            return None
        try:
            _, source_id = canonical._resolve_one_on_one_db(member)
        except RuntimeError:
            return None  # No 1:1 database recorded for this person; the private Call database is used.
        return {'kind': 'one_on_one', 'data_source_id': source_id}

    def one_on_one_filed(self, route, title, started_at):
        """Whether that 1:1 database already holds a page for this meeting (same title, same day)."""
        from datetime import timedelta
        canonical = self.canonical
        day = datetime.fromisoformat(started_at.replace('Z', '+00:00')).date()
        body = {'page_size': 25, 'filter': {'and': [
            {'property': 'Call Date', 'date': {'on_or_after': (day - timedelta(days=1)).isoformat()}},
            {'property': 'Call Date', 'date': {'on_or_before': (day + timedelta(days=1)).isoformat()}}]}}
        response = canonical.requests.post(
            f"{canonical.NOTION_API_BASE}/data_sources/{route['data_source_id']}/query",
            headers=canonical._notion_headers(canonical.NOTION_MOVE_API_VERSION), json=body,
            timeout=canonical.NOTION_REQUEST_TIMEOUT_SECONDS)
        if response.status_code != 200:
            raise ProviderPending('The 1:1 database could not be read')
        wanted = ' '.join(title.split()).casefold()
        for page in response.json().get('results') or []:
            name = ''.join(part.get('plain_text', '') for part in
                           ((page.get('properties') or {}).get('Name') or {}).get('title') or [])
            if ' '.join(name.split()).casefold() == wanted and not page.get('in_trash') and not page.get('archived'):
                return True
        return False

    def create_notion(self, meeting_id, payload, attendees, transcript):
        outcome = {}
        token = _notion_create_response.set(outcome)
        try:
            result = self.canonical.create_notion_call_page(
                meeting_title=payload['title'], meeting_id=meeting_id,
                meeting_date=datetime.fromisoformat(payload['started_at'].replace('Z','+00:00')),
                transcript_text=transcript, summary=payload['summary'], attendee_emails=attendees)
            if not result and outcome.get('status') in DEFINITIVE_REJECTIONS:
                raise ProviderRejected('Notion rejected page creation; retry after correcting the provider error')
            return result
        finally:
            _notion_create_response.reset(token)

    def verify_notion(self, page, meeting_id, transcript):
        canonical = self.canonical
        if len(transcript) <= canonical.NOTION_TRANSCRIPT_CHUNK_SIZE * canonical.NOTION_TRANSCRIPT_MAX_BLOCKS:
            return verify_notion_transcript(canonical.notion_client, page['page_id'], transcript, meeting_id=meeting_id)
        # Recover the durable Drive identity from the same page if the create
        # response was lost. This is the canonical Fireflies full-readback rule.
        notion_page = canonical.notion_client.get_page(page['page_id'])
        verify_notion_page_identity(notion_page, page['page_id'], meeting_id)
        found, links = False, []
        for block in canonical.notion_client.iter_blocks(page['page_id'], max_pages=10):
            kind = block.get('type','')
            rich = block.get(kind, {}).get('rich_text') or []
            text = ''.join(part.get('plain_text') or part.get('text',{}).get('content','') for part in rich)
            if kind == 'heading_2' and text.strip() == 'Transcript':
                found = True
            links.extend(canonical._notion_rich_text_links(block))
        if not found:
            raise ProviderPending('Notion transcript section is missing')
        candidates = set()
        for link in links:
            url = urlsplit(link)
            if url.scheme == 'https' and url.netloc == 'drive.google.com' and url.path.startswith('/file/d/') and url.path.endswith('/view'):
                candidates.add((url.path.split('/')[3], link))
        if len(candidates) != 1:
            raise ProviderPending('Notion transcript archive is ambiguous or missing')
        file_id, file_url = next(iter(candidates))
        canonical._verify_oversized_transcript_drive_readback(meeting_id=meeting_id, transcript_text=transcript, file_id=file_id, file_url=file_url)

    def choose_route(self, title, attendees, manual):
        return choose_route(self.canonical, title, attendees, manual)

    def choose_calendar_route(self, title, attendees, context):
        resolve = getattr(self.canonical, 'resolve_reel_calendar_route', None)
        route = resolve(title, attendees, context) if resolve else None
        return self.choose_route(title, attendees, False) if route is None else route

    def submit_followups(self, **kwargs):
        """Return None when unavailable, or whether the queue accepted durably."""
        queue = getattr(self.canonical, 'queue_reel_followups', None)
        return queue(**kwargs) is True if queue else None

    def apply_route(self, page, route, meeting_id, payload, attendees):
        canonical = self.canonical
        page_id = page['page_id']
        if route['kind'] == 'private':
            expected_parent = canonical._get_database_data_source_id(canonical.NOTION_CALLS_DB_ID)
        else:
            expected_parent = route['data_source_id']
        current, parent = canonical._read_page_parent_data_source(page_id)
        verify_notion_page_identity(current, page_id, meeting_id)
        if route['kind'] == 'one_on_one':
            if not canonical._same_notion_id(parent, expected_parent):
                # Same move the Fireflies flow uses: native move, then restore the 1:1 page's name and date.
                canonical.try_one_on_one_sync(payload['title'], attendees, page_id, raise_on_error=True)
        elif route['kind'] == 'private':
            if not canonical._same_notion_id(parent, expected_parent):
                canonical._move_page_to_data_source(page_id, expected_parent)
        elif route['kind'] in ('client','sales'):
            # Replaying updates is safe: native move preserves the same page,
            # and the helper first reads its parent before moving it again.
            canonical._move_page_to_company_calls(
                page_id, payload['title'], payload['started_at'][:10], ', '.join(attendees),
                meeting_id, route['company_id'], route['kind'].title(), canonical._notion_headers())
        current, parent = canonical._read_page_parent_data_source(page_id)
        verify_notion_page_identity(current, page_id, meeting_id)
        if not canonical._same_notion_id(parent, expected_parent):
            raise ProviderPending('Notion route readback failed')
        if route['kind'] in ('client','sales'):
            props = current.get('properties') or {}
            company_ids = [item.get('id') for item in props.get('Company',{}).get('relation',[])]
            if props.get('Call Type',{}).get('select',{}).get('name') != route['kind'].title() or not any(canonical._same_notion_id(value,route['company_id']) for value in company_ids):
                raise ProviderPending('Notion company route properties failed readback')

    def _gmail(self):
        if self.gmail is None:
            service = self.canonical.get_gmail_service()
            service._http = GmailHttp(service._http.credentials)
            self.gmail = service
        return self.gmail

    def message_id(self, key):
        return self.canonical._delivery_message_id(key)

    def find_email(self, key, *, since):
        """Gmail rewrites RFC IDs; reconcile exact preserved delivery headers.

        Candidate queries use the durable first-attempt time, never a rolling
        window. Read every candidate page before claiming a unique outcome.
        The request's transport fences bound the scan; incomplete scans raise.
        """
        service = self._gmail()
        query = f'in:anywhere from:{self.canonical.CALENDAR_EMAIL} subject:"Meeting recap"'
        if since:
            query += f' after:{max(0, int(since) - 120)}'
        matches = {}
        for reference in gmail_pages(service.users().messages().list, 'messages', userId='me', q=query, includeSpamTrash=True, maxResults=500):
            message_id = reference.get('id')
            if not message_id:
                raise ProviderPending('Gmail candidate identity is missing')
            try:
                message = service.users().messages().get(userId='me', id=message_id, format='metadata', metadataHeaders=[DELIVERY_MARKER_HEADER, 'Message-ID']).execute()
            except Exception as exc:
                # A draft can disappear during send. Only an authoritative
                # absence is skippable; failed reads cannot yield a receipt.
                if getattr(getattr(exc, 'resp', None), 'status', None) in (404, 410):
                    continue
                raise
            if not isinstance(message, dict) or message.get('id') != message_id or not isinstance(message.get('labelIds'), list) or any(not isinstance(label, str) for label in message['labelIds']):
                raise ProviderPending('Gmail candidate metadata is incomplete')
            labels = set(message['labelIds'])
            if not labels & {'SENT', 'DRAFT'}:
                continue
            if {'SENT', 'DRAFT'} <= labels:
                raise ProviderPending('Gmail candidate delivery state is ambiguous')
            payload = message.get('payload')
            if not isinstance(payload, dict) or not isinstance(payload.get('headers'), list):
                raise ProviderPending('Gmail candidate headers are incomplete')
            headers = payload['headers']
            if any(not isinstance(header, dict) or not isinstance(header.get('name'), str) or not isinstance(header.get('value'), str) for header in headers):
                raise ProviderPending('Gmail candidate headers are malformed')
            markers = [str(header.get('value') or '').strip() for header in headers if str(header.get('name') or '').lower() == DELIVERY_MARKER_HEADER.lower()]
            if key not in markers:
                continue
            if markers != [key]:
                raise ProviderPending('Gmail delivery marker is ambiguous')
            rfc_ids = [str(header.get('value') or '').strip() for header in headers if str(header.get('name') or '').lower() == 'message-id']
            matches[message_id] = {'state':'sent' if 'SENT' in labels else 'draft',
                'provider_message_id':message_id, 'provider_thread_id':message.get('threadId'),
                'rfc_message_id':rfc_ids[0] if len(rfc_ids) == 1 else None, 'reconciled':True}
        if not matches:
            return None
        if len(matches) != 1:
            raise ProviderPending('Multiple Gmail messages have this delivery marker')
        result = next(iter(matches.values()))
        if result['state'] == 'sent':
            return result
        draft_ids = set()
        for draft in gmail_pages(service.users().drafts().list, 'drafts', userId='me', maxResults=500):
            if not draft.get('id') or not (draft.get('message') or {}).get('id'):
                raise ProviderPending('Gmail draft identity is incomplete')
            if draft['message']['id'] == result['provider_message_id']:
                draft_ids.add(draft['id'])
        if len(draft_ids) != 1:
            raise ProviderPending('Gmail draft handle is missing or ambiguous; retry reconciliation')
        return {**result, 'provider_draft_id':next(iter(draft_ids))}

    def create_draft(self, key, message):
        if message.get(DELIVERY_MARKER_HEADER) is not None:
            del message[DELIVERY_MARKER_HEADER]
        message[DELIVERY_MARKER_HEADER] = key
        message['From'] = self.canonical.CALENDAR_EMAIL
        try:
            result = self._gmail().users().drafts().create(userId='me', body={'message':{'raw':base64.urlsafe_b64encode(message.as_bytes()).decode()}}).execute()
        except Exception as exc:
            if getattr(getattr(exc, 'resp', None), 'status', None) in DEFINITIVE_REJECTIONS:
                raise ProviderRejected('Gmail rejected draft creation; retry after correcting the provider error') from exc
            raise
        return result.get('id')

    def send_draft(self, key, draft_id):
        result = self._gmail().users().drafts().send(userId='me',body={'id':draft_id}).execute()
        if not result.get('id'):
            raise ProviderPending('Gmail send response has no message identity')
        return {'state':'sent','provider_draft_id':draft_id,'provider_message_id':result['id'],'provider_thread_id':result.get('threadId')}


def configured_providers(*, store=None):
    provider = os.getenv('REEL_DELIVERY_PROVIDER', 'standalone').strip()
    if provider == 'canonical':
        return CanonicalProviders()
    if provider == 'standalone':
        if __package__:
            from .standalone_providers import StandaloneProviders
        else:
            from standalone_providers import StandaloneProviders
        return StandaloneProviders(store=store)
    raise ProviderPending('Meeting delivery provider is not configured')

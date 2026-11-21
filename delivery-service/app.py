"""Calendar identity and recipient rules for Reel delivery."""
from collections import Counter
from datetime import datetime, timedelta, timezone
from functools import partial
import hashlib
from html import escape
import logging
import os
import re
import time
from unicodedata import category
from uuid import NAMESPACE_URL, uuid5

from reel_organization import _safe_url, firebase_project, is_internal_email, notes_base_url, public_account_access, trusted_origins

if __package__:
    from .slack_recaps import SlackError, SlackRecaps
else:
    from slack_recaps import SlackError, SlackRecaps

logger = logging.getLogger(__name__)


class DeliveryError(Exception):
    status = 422


def timestamp(value):
    if not isinstance(value, str):
        raise DeliveryError('Missing occurrence time')
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            raise ValueError()
        return parsed.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')
    except ValueError as exc:
        raise DeliveryError('Invalid occurrence time') from exc


def canonical_occurrence(event):
    uid = event.get('iCalUID')
    start = (event.get('originalStartTime') or event.get('start') or {}).get('dateTime')
    if not isinstance(uid, str) or not uid.strip():
        raise DeliveryError('Calendar occurrence has no iCalUID')
    return uid, timestamp(start)


def participant_emails(event):
    participants = list(event.get('attendees') or []) + [event.get('organizer') or {}]
    return {str(person.get('email') or '').strip().lower() for person in participants} - {''}


def internal_recipients(event):
    return sorted(email for email in participant_emails(event) if is_internal_email(email))


def _all_pages(method, **kwargs):
    result, token, seen = [], None, set()
    while True:
        args = dict(kwargs)
        if token:
            args['pageToken'] = token
        page = method(**args).execute()
        result.extend(page.get('items') or [])
        token = page.get('nextPageToken')
        if not token:
            return result
        if token in seen:
            raise DeliveryError('Invalid calendar pagination')
        seen.add(token)


LEGACY_OCCURRENCE_FIELD = 'legacy_occurrence_id'


def validate_calendar_reference(reference):
    if not isinstance(reference, dict):
        raise DeliveryError('Invalid calendar reference')
    allowed = {'calendar_id', 'event_id', 'ical_uid', 'occurrence_start', LEGACY_OCCURRENCE_FIELD}
    if set(reference) - allowed or any(value is not None and not isinstance(value, str) for value in reference.values()):
        raise DeliveryError('Invalid calendar reference')
    legacy = reference.get(LEGACY_OCCURRENCE_FIELD)
    if legacy is not None and (not re.fullmatch(r'[0-9a-f]{64}', legacy) or reference.get('event_id') or reference.get('ical_uid')):
        raise DeliveryError('Invalid legacy calendar identity')
    if not (reference.get('event_id') or reference.get('ical_uid') or legacy):
        raise DeliveryError('Calendar occurrence identity is incomplete')
    timestamp(reference.get('occurrence_start'))


def selected_calendar_ids(store, owner_email, owner_uid):
    key = 'calendar/' + hashlib.sha256(owner_email.encode()).hexdigest()
    state, _ = store.load(key)
    state = state or {}
    identity, config = state.get('identity') or {}, state.get('config') or {}
    bindings = {uid for uid in (identity.get('owner_uid'), config.get('owner_uid')) if uid}
    if not owner_uid or bindings != {owner_uid} or identity.get('owner_email', owner_email) != owner_email:
        return ()
    ids = config.get('calendar_ids')
    if config.get('enabled') is not True or not isinstance(ids, list) or not 1 <= len(ids) <= 25:
        return ()
    if any(not isinstance(value, str) or not value or len(value) > 320 for value in ids):
        return ()
    return tuple(dict.fromkeys(ids))


def _calendar_unavailable(exc):
    status = getattr(getattr(exc, 'resp', None), 'status', None)
    if status != 403:
        return status in (401, 404, 410)
    transient = {'quotaExceeded', 'rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded'}
    return not any(isinstance(detail, dict) and detail.get('reason') in transient
                   for detail in (getattr(exc, 'error_details', None) or []))


def _calendar_candidates(service, calendar_id, event_id, uid, legacy, wanted):
    events = service.events()
    if legacy:
        anchor = datetime.fromisoformat(wanted.replace('Z', '+00:00'))
        return _all_pages(events.list, calendarId=calendar_id, singleEvents=True,
                          timeMin=timestamp((anchor - timedelta(hours=24)).isoformat()),
                          timeMax=timestamp((anchor + timedelta(hours=24)).isoformat()))
    candidates = []
    if event_id:
        try:
            candidates.append(events.get(calendarId=calendar_id, eventId=event_id).execute())
        except Exception as exc:
            if getattr(getattr(exc, 'resp', None), 'status', None) not in (404, 410):
                raise
    if uid:
        for event in _all_pages(events.list, calendarId=calendar_id, iCalUID=uid, singleEvents=False):
            if event.get('recurrence'):
                candidates.extend(_all_pages(events.instances, calendarId=calendar_id,
                                             eventId=event['id'], originalStart=wanted))
            else:
                candidates.append(event)
    return candidates


def resolve_occurrence(service, reference, calendar_ids, owner_email=None):
    """Resolve only an exact accessible event, never a title/time search."""
    validate_calendar_reference(reference)
    event_id, uid = reference.get('event_id'), reference.get('ical_uid')
    legacy = reference.get(LEGACY_OCCURRENCE_FIELD)
    if legacy and not owner_email:
        raise DeliveryError('Legacy calendar resolution requires the verified caller')
    wanted = timestamp(reference.get('occurrence_start'))
    primary_aliases = {'primary', owner_email}
    preferred = reference.get('calendar_id')
    calendars = [calendar_id for calendar_id in calendar_ids if not preferred or preferred == calendar_id
                 or {preferred, calendar_id} == primary_aliases]
    if not calendars:
        raise CalendarSelectionRequired('Select the meeting calendar before delivering notes')
    matches = {}
    readable = False
    for calendar_id in calendars:
        try:
            candidates = _calendar_candidates(service, calendar_id, event_id, uid, legacy, wanted)
        except Exception as exc:
            if _calendar_unavailable(exc):
                continue
            raise
        readable = True
        for event in candidates:
            if event.get('status') == 'cancelled' or event.get('attendeesOmitted'):
                continue
            if event_id and event.get('id') != event_id:
                continue
            try:
                identity = canonical_occurrence(event)
            except DeliveryError:
                continue
            if legacy:
                try:
                    actual_start = timestamp((event.get('start') or {}).get('dateTime'))
                except DeliveryError:
                    continue
                if actual_start != wanted or not event.get('id'):
                    continue
                aliases = primary_aliases if calendar_id in primary_aliases else {calendar_id}
                hashes = {hashlib.sha256(f'{alias}\0{event["id"]}\0{actual_start}'.encode()).hexdigest() for alias in aliases}
                if legacy not in hashes:
                    continue
            elif identity[1] != wanted or (uid and identity[0] != uid):
                continue
            # Different selected calendars can hold copies of the invitation.
            previous = matches.get(identity)
            if previous and participant_emails(previous) != participant_emails(event):
                raise DeliveryError('Calendar copies disagree on invitees')
            matches.setdefault(identity, event)
    if not readable:
        raise CalendarSelectionRequired('Restore access to the meeting calendar before delivering notes')
    if len(matches) != 1:
        raise DeliveryError('Calendar occurrence is unknown or ambiguous')
    return next(iter(matches.values()))


def calendar_service(owner_email):
    """Use the configured delegated service account as the verified caller."""
    import os
    from pathlib import Path
    from google.oauth2 import service_account
    from googleapiclient.discovery import build
    configured = os.getenv('GOOGLE_CALENDAR_CREDENTIALS', '').strip()
    if configured:
        paths = [Path(configured)]
    elif os.getenv('REEL_DELIVERY_PROVIDER', 'standalone').strip().lower() == 'canonical':
        from config import SERVICE_ACCOUNT_PATHS
        paths = SERVICE_ACCOUNT_PATHS
    else:
        paths = []
    for path in paths:
        if path.exists():
            credentials = service_account.Credentials.from_service_account_file(
                str(path), scopes=['https://www.googleapis.com/auth/calendar.readonly']
            ).with_subject(owner_email)
            from google_auth_httplib2 import AuthorizedHttp
            import httplib2
            return build('calendar', 'v3', http=AuthorizedHttp(credentials, http=httplib2.Http(timeout=30)), cache_discovery=False)
    raise DeliveryError('Calendar credentials are unavailable')


def verify_notion_page_identity(page, page_id, meeting_id=None):
    if page.get('archived') or page.get('in_trash') or str(page.get('id', '')).replace('-', '') != page_id.replace('-', ''):
        raise ProviderPending('Notion page readback failed; retry to verify')
    if meeting_id is not None:
        parts = ((page.get('properties') or {}).get('Meeting ID') or {}).get('rich_text') or []
        stored_id = ''.join(str(part.get('plain_text') or (part.get('text') or {}).get('content') or '') for part in parts)
        if stored_id != meeting_id:
            raise ProviderPending('Notion Meeting ID readback failed; retry to verify')


def verify_notion_transcript(notion, page_id, transcript, meeting_id=None):
    """Verify the complete inline transcript on the original, live page."""
    page = notion.get_page(page_id)
    verify_notion_page_identity(page, page_id, meeting_id)
    found = False
    chunks = []
    for block in notion.iter_blocks(page_id, max_pages=10):
        kind = block.get('type') or ''
        parts = (block.get(kind) or {}).get('rich_text') or []
        content = ''.join(str(part.get('plain_text') or (part.get('text') or {}).get('content') or '') for part in parts)
        if not found:
            found = kind == 'heading_2' and content.strip() == 'Transcript'
        elif kind.startswith('heading_'):
            break
        elif kind == 'paragraph':
            chunks.append(content)
    if not found or ''.join(chunks) != transcript:
        raise ProviderPending('Notion transcript readback failed; retry to verify')


_NOTE_HEADINGS = {
    'outcome', 'summary', 'overview', 'meeting summary', 'key points', 'highlights',
    'key takeaways', 'discussion points', 'decisions', 'decisions made', 'open questions',
    'questions', 'unresolved questions', 'action items', 'action item', 'actions',
    'next steps', 'follow-ups',
}
_NOTE_INLINE = re.compile(
    r'(?P<escaped>\\[\\`*_])|(?<!`)(?P<code>`+)(?P<literal>[^`]+)(?P=code)(?!`)'
    r'|(?<![\\\w*_])(?P<emphasis>\*\*|__|\*|_)(?![\s*_])'
    r'(?P<words>[^`*_]*?[^\s`*_])(?P=emphasis)(?![\w*_])'
)
_NOTE_BULLET = re.compile(r'([•*+–◦▪-]|[0-9]{1,9}[.)])[ \t]+(.+)')


def _recap_inline(text):
    plain, html = [], []
    offset = 0
    for match in _NOTE_INLINE.finditer(text):
        prefix = text[offset:match.start()]
        plain.append(prefix)
        html.append(escape(prefix))
        if match['escaped']:
            literal = match['escaped'][1:]
            plain.append(literal)
            html.append(escape(literal))
        else:
            literal = match['literal'] if match['code'] else match['words']
            if match['code']:
                tag = 'code'
            else:
                tag = 'strong' if len(match['emphasis']) == 2 else 'em'
            plain.append(literal)
            html.append(f'<{tag}>{escape(literal)}</{tag}>')
        offset = match.end()
    return ''.join(plain) + text[offset:], ''.join(html) + escape(text[offset:])


def _recap_summary(summary):
    """Render Reel's note sections and a limited subset of older Markdown."""
    plain, html, block = [], [], []
    block_type = None
    fence = None

    def flush():
        if block_type == 'code':
            html.append('<pre><code>' + escape('\n'.join(block)) + '</code></pre>')
        elif block_type == 'p':
            html.append('<p>' + '<br>'.join(block) + '</p>')
        elif block_type:
            html.append(f'<{block_type}>' + ''.join(block) + f'</{block_type}>')
        block.clear()

    for raw in summary.splitlines():
        line = raw.strip()
        marker = re.fullmatch(r'(`{3,}|~{3,})[^`~]*', line)
        if fence:
            if marker and set(line) == {fence[0]} and len(line) >= len(fence):
                flush()
                fence, block_type = None, None
            else:
                plain.append(raw)
                block.append(raw)
            continue
        heading = re.fullmatch(r'#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?', line)
        bold_heading = re.fullmatch(r'(?:\*\*(.+?)\*\*|__(.+?)__):?', line)
        bullet = _NOTE_BULLET.fullmatch(line)
        if marker or not line or heading or bold_heading or line.rstrip(':').casefold() in _NOTE_HEADINGS:
            flush()
            block_type = None
            if marker:
                fence, block_type = marker[1], 'code'
            elif not line:
                plain.append('')
            else:
                label = line
                if heading:
                    label = heading[1]
                elif bold_heading:
                    label = bold_heading[1] or bold_heading[2]
                text, markup = _recap_inline(label.rstrip(':'))
                plain.append(text)
                html.append(f'<h2>{markup}</h2>')
            continue
        if bullet:
            list_type = 'ol' if bullet[1][0].isdigit() else 'ul'
            if block_type != list_type:
                flush()
                block_type = list_type
            text, markup = _recap_inline(bullet[2])
            plain.append(raw[:len(raw) - len(raw.lstrip())] + (bullet[1] if list_type == 'ol' else '•') + ' ' + text)
            block.append(f'<li>{markup}</li>')
        else:
            if block_type != 'p':
                flush()
                block_type = 'p'
            text, markup = _recap_inline(raw)
            plain.append(text)
            block.append(markup)
    flush()
    return '\n'.join(plain), ''.join(html)


def recap_message(recipients, title, summary, notion_url, message_id):
    """Build the internal recap with escaped supplied text and a stable ID."""
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText
    if not recipients or any(not is_internal_email(address) for address in recipients):
        raise DeliveryError('Invalid recap recipients')
    if len(recipients) <= 3:
        names = [re.split(r'[._+\-]', address.split('@', 1)[0])[0].capitalize() for address in recipients]
        greeting = 'Hi ' + ' and '.join(names)
    else:
        greeting = 'Hi all'
    message = MIMEMultipart('alternative')
    message['To'] = ', '.join(recipients)
    message['Subject'] = 'Meeting recap: ' + title
    message['Message-ID'] = '<' + message_id + '>'
    plain_summary, html_summary = _recap_summary(summary)
    message.attach(MIMEText(f'{greeting},\n\n{plain_summary}\n\nMeeting notes: {notion_url}', 'plain', 'utf-8'))
    message.attach(MIMEText(f'<p>{escape(greeting)},</p>{html_summary}<p><a href="{escape(notion_url, quote=True)}">Meeting notes</a></p>', 'html', 'utf-8'))
    return message


def slack_recap_message(title, summary, notes_url):
    plain, _ = _recap_summary(summary)
    sections = {'outcome': [], 'actions': []}
    section = 'outcome'
    for line in plain.splitlines():
        line = line.strip()
        label = line.rstrip(':').casefold()
        if label in _NOTE_HEADINGS:
            if label in {'outcome', 'summary', 'overview', 'meeting summary'}:
                section = 'outcome'
            elif label in {'action items', 'action item', 'actions', 'next steps', 'follow-ups'}:
                section = 'actions'
            else:
                section = None
        elif line and section:
            sections[section].append(line)
    heading = ' '.join(title.split())[:150] or 'Meeting notes'
    blocks = [{'type': 'header', 'text': {'type': 'plain_text', 'text': heading}}]
    for key, label, limit, lines in (
        ('outcome', 'Outcome', 760, 4), ('actions', 'Action items', 720, 4),
    ):
        preview = '\n'.join(sections[key][:lines])
        if preview:
            if len(preview) > limit:
                preview = preview[:limit - 1].rstrip() + '…'
            blocks.append({'type': 'section', 'text': {'type': 'plain_text', 'text': f'{label}\n{preview}'}})
    blocks.append({'type': 'section', 'text': {
        'type': 'mrkdwn', 'verbatim': True, 'text': f'<{escape(notes_url, quote=False)}|Open in Reel>',
    }})
    return {'text': f'Reel meeting notes are ready: {heading}\n{notes_url}', 'blocks': blocks}


def _supported_link(value):
    from urllib.parse import urlsplit
    try:
        url = urlsplit(value)
        host = (url.hostname or '').lower()
        if url.scheme != 'https' or url.username or url.password or url.fragment or url.port not in (None, 443):
            return False
        return bool((host == 'meet.google.com' and re.fullmatch(r'/[a-z]{3}-[a-z]{4}-[a-z]{3}/?', url.path))
                    or ((host == 'zoom.us' or host.endswith('.zoom.us')) and (re.fullmatch(r'/j/[0-9]{9,11}/?', url.path) or re.fullmatch(r'/wc/[0-9]{9,12}/join/?', url.path)))
                    or (host == 'teams.microsoft.com' and (re.fullmatch(r'/l/meetup-join/[^/]+/[0-9]+/?', url.path) or re.fullmatch(r'/meet/[0-9]+/?', url.path)))
                    or (host == 'teams.live.com' and re.fullmatch(r'/meet/[0-9]+/?', url.path)))
    except (ValueError, TypeError):
        return False


def list_calendar_events(service, owner_email, calendar_ids, now=None):
    now = now or datetime.now(timezone.utc)
    time_min = (now - timedelta(hours=24)).astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')
    time_max = (now + timedelta(days=7)).astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')
    result = []
    for calendar_id in calendar_ids:
        try:
            events = _all_pages(service.events().list, calendarId=calendar_id, timeMin=time_min, timeMax=time_max,
                                singleEvents=True, orderBy='startTime')
        except Exception as exc:
            if _calendar_unavailable(exc):
                continue
            raise
        # Preserve the public primary-calendar identifier used by existing recordings.
        source_id = owner_email if calendar_id == 'primary' else calendar_id
        result.extend(_project_calendar_events(events, source_id))
    return sorted(result, key=lambda item: timestamp(item['start']))


def _project_calendar_events(events, calendar_id):
    import html
    for event in events:
        title = str(event.get('summary') or '').strip()
        start = (event.get('start') or {}).get('dateTime')
        if event.get('status') == 'cancelled' or event.get('visibility') == 'private' or not title or re.search(r'\[(?:PRIVATE|NO[- ]?REC)\]', title, re.I) or not start:
            continue
        raw = [event.get('hangoutLink') or '']
        raw.extend(entry.get('uri', '') for entry in (event.get('conferenceData') or {}).get('entryPoints', []) if entry.get('entryPointType') == 'video')
        for field in ('location', 'description'):
            raw.extend(re.findall(r'https://[^\s<>"\']+', html.unescape(event.get(field) or ''), re.I))
        if not any(_supported_link(link.rstrip('.,;:!?)]}')) for link in raw):
            continue
        try:
            uid, occurrence = canonical_occurrence(event)
            start = timestamp(start)
        except DeliveryError:
            continue
        event_id = event.get('id')
        if not event_id:
            continue
        identifier = hashlib.sha256(f'{calendar_id}\0{event_id}\0{start}'.encode()).hexdigest()
        yield {'id': identifier, 'title': title, 'start': start, 'attendees': sorted(participant_emails(event)),
               'calendar': {'calendar_id': calendar_id, 'event_id': event_id, 'ical_uid': uid, 'occurrence_start': occurrence}}


def verify_firebase(token):
    from google.auth.transport.requests import Request
    from google.oauth2 import id_token
    project = firebase_project()
    if not project:
        raise DeliveryError('Authentication required')
    return id_token.verify_firebase_token(token, Request(), audience=project)


def configured_slack_recaps():
    token = os.getenv('REEL_SLACK_BOT_TOKEN', '').strip()
    return SlackRecaps(token) if token else None


def create_app(auth_verifier=verify_firebase, calendar_factory=calendar_service, *, store=None, calendar_store=None,
               providers=None, clock=None, slack=None):
    from flask import Flask, jsonify, request, g
    app = Flask(__name__)
    app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024
    clock = clock or time.time
    dependencies = {}
    if slack is None:
        slack = configured_slack_recaps()

    @app.after_request
    def cors(response):
        origin = request.headers.get('Origin', '')
        if origin in trusted_origins():
            response.headers['Access-Control-Allow-Origin'] = origin
            response.headers['Vary'] = 'Origin'
            response.headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type'
            response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
        if request.path.startswith(('/delivery/meetings', '/delivery/calendar')):
            response.headers['Cache-Control'] = 'no-store'
        return response

    def owner():
        if public_account_access():
            raise DeliveryError('Organization delivery is unavailable')
        authorization = request.headers.get('Authorization', '')
        project = firebase_project()
        if not project or not authorization.startswith('Bearer '):
            raise DeliveryError('Authentication required')
        claims = auth_verifier(authorization[7:])
        email = str(claims.get('email') or '').lower()
        if (claims.get('iss') != f'https://securetoken.google.com/{project}' or claims.get('aud') != project
                or not claims.get('sub') or claims.get('email_verified') is not True or not is_internal_email(email)):
            raise DeliveryError('Authentication required')
        g.delivery_owner_uid = claims['sub']
        g.delivery_deadline = min(clock() + 570, float(claims.get('exp', clock() + 570)))
        return email

    def calendar_selection(email):
        if 'calendar_store' not in dependencies:
            if calendar_store is not None:
                dependencies['calendar_store'] = calendar_store
            elif bucket := os.getenv('CALENDAR_SELECTION_BUCKET'):
                dependencies['calendar_store'] = GCSStateStore(bucket, os.getenv('CALENDAR_SELECTION_PREFIX', ''), read_only=True)
            else:
                return ()
        return selected_calendar_ids(dependencies['calendar_store'], email, g.delivery_owner_uid)

    @app.get('/delivery/calendar')
    def calendar():
        try:
            email = owner()
        except Exception:
            return jsonify(error='Authentication required'), 401
        try:
            ids = calendar_selection(email)
            events = list_calendar_events(calendar_factory(email), email, ids) if ids else []
            if ids and calendar_selection(email) != ids:
                return jsonify(error='Calendar selection changed; refresh invitations'), 409
            return jsonify(events=events)
        except Exception:
            return jsonify(error='Calendar unavailable; try again'), 503

    def note_store():
        if 'store' not in dependencies:
            import os
            dependencies['store'] = store if store is not None else GCSStateStore(os.environ['DELIVERY_RECEIPTS_BUCKET'])
        return dependencies['store']

    @app.get('/delivery/meetings')
    def meetings():
        try:
            email = owner()
        except Exception:
            return jsonify(error='Authentication required'), 401
        try:
            cursor, limit = request.args.get('cursor', '0'), request.args.get('limit', '50')
            if not re.fullmatch(r'[0-9]{1,9}', cursor) or not re.fullmatch(r'[0-9]{1,3}', limit) or not 1 <= int(limit) <= 100:
                return jsonify(error='Invalid pagination'), 400
            entries = list_shared_notes(note_store(), email)
            start, count = int(cursor), int(limit)
            return jsonify(meetings=entries[start:start + count], next_cursor=str(start + count) if start + count < len(entries) else None)
        except Exception:
            app.logger.error('Meeting index unavailable')
            return jsonify(error='Meeting notes unavailable'), 503

    @app.get('/delivery/meetings/<meeting_id>')
    def meeting_detail(meeting_id):
        try:
            email = owner()
        except Exception:
            return jsonify(error='Authentication required'), 401
        if not re.fullmatch(r'reel_[0-9a-f]{64}', meeting_id):
            return jsonify(error='Not found'), 404
        try:
            note = read_shared_note(note_store(), meeting_id, email)
            return (jsonify(meeting=note), 200) if note else (jsonify(error='Not found'), 404)
        except Exception:
            app.logger.error('Meeting note unavailable')
            return jsonify(error='Meeting notes unavailable'), 503

    @app.post('/delivery/complete')
    def complete():
        try:
            email = owner()
        except Exception:
            return jsonify(error='Authentication required'), 401
        try:
            payload = request.get_json(silent=True)
            validate_payload(payload)
            if 'providers' not in dependencies:
                if __package__:
                    from .providers import configured_providers
                else:
                    from providers import configured_providers
                dependencies['providers'] = providers if providers is not None else configured_providers(store=note_store())
            note_store()
            receipt = deliver(payload, email, dependencies['store'], dependencies['providers'], calendar_factory, clock,
                              deadline=g.delivery_deadline, slack=slack,
                              calendar_selection=partial(calendar_selection, email))
            return jsonify(receipt)
        except DeliveryError as exc:
            data = {'error': str(exc), 'retryable': exc.status in (409, 503)}
            if isinstance(exc, CalendarSelectionRequired):
                data['code'] = 'calendar_selection_required'
            return jsonify(data), exc.status
        except Exception:
            app.logger.error('Meeting delivery failed; provider result remains retryable')
            return jsonify(error='Delivery could not be verified; retry this recording', retryable=True), 503

    return app


def validate_payload(payload):
    import hashlib
    import json
    import uuid
    if not isinstance(payload, dict) or set(payload) != {'id', 'title', 'started_at', 'attendees', 'summary', 'segments', 'calendar'}:
        raise DeliveryError('Invalid meeting payload')
    try:
        recording_id = str(uuid.UUID(payload['id']))
    except (ValueError, TypeError, AttributeError) as exc:
        raise DeliveryError('Invalid recording identity') from exc
    if not isinstance(payload['title'], str) or not payload['title'].strip() or not isinstance(payload['summary'], str) or not payload['summary'].strip():
        raise DeliveryError('Invalid meeting text')
    timestamp(payload['started_at'])
    if not isinstance(payload['attendees'], list) or any(not isinstance(item, str) for item in payload['attendees']):
        raise DeliveryError('Invalid attendees')
    if not isinstance(payload['segments'], list) or not payload['segments'] or any(not isinstance(item, dict) or not isinstance(item.get('text'), str) for item in payload['segments']):
        raise DeliveryError('Invalid transcript')
    if not any(item['text'].strip() for item in payload['segments']):
        raise DeliveryError('Empty transcript cannot be delivered')
    if payload['calendar'] is not None:
        validate_calendar_reference(payload['calendar'])
    # The hash binds the complete original supplied content, including summary
    # and transcript, to the recording identity; no content is stored here.
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
    return recording_id, hashlib.sha256(encoded).hexdigest()


def format_transcript(segments):
    statuses = {
        'unavailable': 'Speaker identification unavailable for this recording.',
        'partial': 'Speaker identification is partial. Names are platform display labels. Timings are approximate.',
        'platform_captions': 'Speaker identification uses platform captions. Names are platform display labels. Timings are approximate.',
    }
    first = segments[0] if segments else {}
    attribution, coverage = first.get('speaker_attribution'), first.get('speaker_coverage')
    status = ''
    if (isinstance(attribution, str) and isinstance(coverage, (int, float))
            and not isinstance(coverage, bool) and 0 <= coverage <= 1):
        status = statuses.get(attribution, '')
    labels = []
    for segment in segments:
        name = segment.get('speaker_name')
        if (not (status and attribution == 'unavailable')
                and segment.get('speaker_source') in ('google_meet_caption', 'teams_caption')
                and segment.get('speaker_match') == 'caption_text_match'
                and isinstance(name, str) and len(name) <= 120
                and not any(category(char) in ('Cc', 'Cf', 'Zl', 'Zp') for char in name)):
            labels.append(name.strip())
        else:
            labels.append('')
    if not status and not any(labels):
        return '\n'.join(segment['text'] for segment in segments)
    transcript = '\n'.join(f"{label or 'Speaker unknown'}: {segment['text'].strip()}" for label, segment in zip(labels, segments))
    return f'{status}\n\n{transcript}' if status else transcript


class GCSStateStore:
    """GCS JSON API receipts, guarded by object generation preconditions."""
    def __init__(self, bucket, prefix='delivery', *, read_only=False):
        import google.auth
        from google.auth.transport.requests import AuthorizedSession
        scope = 'https://www.googleapis.com/auth/devstorage.read_only' if read_only else 'https://www.googleapis.com/auth/devstorage.read_write'
        credentials, _ = google.auth.default(scopes=[scope])
        self.session = AuthorizedSession(credentials)
        self.bucket = bucket
        self.prefix = prefix.strip('/')

    def _name(self, key):
        return f'{self.prefix}/{key}.json' if self.prefix else f'{key}.json'

    def load(self, key):
        from urllib.parse import quote
        url = f'https://storage.googleapis.com/storage/v1/b/{quote(self.bucket, safe="")}/o/{quote(self._name(key), safe="")}'
        response = self.session.get(url, timeout=30)
        if response.status_code == 404:
            return None, 0
        response.raise_for_status()
        generation = int(response.json()['generation'])
        response = self.session.get(url, params={'alt':'media', 'ifGenerationMatch':generation}, timeout=30)
        response.raise_for_status()
        state = response.json()
        if not isinstance(state, dict):
            raise DeliveryError('Invalid receipt state')
        return state, generation

    def cas(self, key, state, generation):
        import json
        from urllib.parse import quote
        from google.api_core.exceptions import PreconditionFailed
        url = f'https://storage.googleapis.com/upload/storage/v1/b/{quote(self.bucket, safe="")}/o'
        response = self.session.post(url, params={'uploadType':'media', 'name':self._name(key), 'ifGenerationMatch':generation}, data=json.dumps(state, separators=(',', ':')).encode(), headers={'Content-Type':'application/json'}, timeout=30)
        if response.status_code == 412:
            raise PreconditionFailed('Receipt generation changed')
        response.raise_for_status()
        return int(response.json()['generation'])


def digest_key(*parts):
    import hashlib
    import json
    return hashlib.sha256(json.dumps(parts, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def _index_key(email):
    return 'notes-index/' + digest_key(email)


def _validate_note(note, meeting_id):
    if (not isinstance(note, dict) or note.get('id') != meeting_id
            or not isinstance(note.get('recipients'), list) or not note['recipients']
            or any(not is_internal_email(email) for email in note['recipients'])
            or not isinstance(note.get('segments'), list) or not isinstance(note.get('transcript_text'), str)):
        raise DeliveryError('Invalid shared note state')
    return note


def validated_notes_url(url, meeting_id):
    suffix = '#meetings/' + meeting_id
    if isinstance(url, str) and url.endswith(suffix):
        base = url[:-len(suffix)]
        if base and _safe_url(base, origin_only=False) == base and '\\' not in base:
            return url
    raise ProviderPending('Meeting notes URL is invalid for this occurrence')


def configured_notes_url(meeting_id):
    base = notes_base_url()
    if not base:
        raise ProviderPending('Meeting notes URL is unavailable')
    return validated_notes_url(f'{base}#meetings/{meeting_id}', meeting_id)


def read_shared_note(store, meeting_id, email):
    note, _ = store.load('notes/' + meeting_id)
    if note is None:
        return None
    _validate_note(note, meeting_id)
    if email not in note['recipients']:
        return None
    index, _ = store.load(_index_key(email))
    if not isinstance(index, dict) or not isinstance(index.get('meetings'), dict):
        raise DeliveryError('Invalid meeting index')
    ids = index['meetings'].get(meeting_id)
    if not isinstance(ids, list) or any(not isinstance(value, str) for value in ids):
        raise DeliveryError('Invalid meeting index entry')
    return {**note, 'local_recording_ids':ids}


def list_shared_notes(store, email):
    index, _ = store.load(_index_key(email))
    if index is None:
        return []
    if not isinstance(index.get('meetings'), dict):
        raise DeliveryError('Invalid meeting index')
    result = []
    for meeting_id in index['meetings']:
        if not re.fullmatch(r'reel_[0-9a-f]{64}', meeting_id):
            raise DeliveryError('Invalid meeting index entry')
        ids = index['meetings'][meeting_id]
        if not isinstance(ids, list) or any(not isinstance(value, str) for value in ids):
            raise DeliveryError('Invalid meeting index entry')
        note, _ = store.load('notes/' + meeting_id)
        if note is None or email not in _validate_note(note, meeting_id)['recipients']:
            raise DeliveryError('Invalid meeting index entry')
        result.append({**{k:v for k,v in note.items() if k not in ('segments', 'transcript_text')}, 'local_recording_ids':ids})
    return sorted(result, key=lambda item:(item['started_at'], item['id']), reverse=True)


def publish_shared_note(store, note, owner, recording_id, fence):
    from google.api_core.exceptions import PreconditionFailed
    meeting_id = note['id']
    _validate_note(note, meeting_id)
    key = 'notes/' + meeting_id
    fence()
    existing, generation = store.load(key)
    fence()
    if existing is None:
        try:
            fence()
            store.cas(key, note, generation)
            fence()
            existing = note
        except PreconditionFailed:
            fence()
            existing, _ = store.load(key)
            fence()
    if existing != note:
        raise Conflict('Canonical meeting note changed')
    for email in note['recipients']:
        update_note_index(store, meeting_id, email, recording_id if email == owner else None, fence)


def update_note_index(store, meeting_id, email, recording_id, fence):
    from google.api_core.exceptions import PreconditionFailed
    key = _index_key(email)
    for _ in range(20):
        fence()
        index, generation = store.load(key)
        fence()
        if index is None:
            index = {'meetings':{}}
        if not isinstance(index.get('meetings'), dict):
            raise DeliveryError('Invalid meeting index')
        entries = index['meetings']
        ids = entries.get(meeting_id, [])
        if not isinstance(ids, list) or any(not isinstance(value, str) for value in ids):
            raise DeliveryError('Invalid meeting index entry')
        ids = list(ids)
        if recording_id and recording_id not in ids:
            ids.append(recording_id)
        if entries.get(meeting_id) == ids:
            return
        entries[meeting_id] = ids
        try:
            fence()
            store.cas(key, index, generation)
            fence()
            return
        except PreconditionFailed:
            continue
    raise Conflict('Meeting index changed repeatedly')


def bind_recording(store, owner, recording_id, content_hash, occurrence_key):
    """Durably bind one owner's recording to its original content and occurrence."""
    key = 'recording/' + digest_key(owner, recording_id)
    state, generation = store.load(key)
    expected = {'content_hash':content_hash, 'occurrence_key':occurrence_key}
    if state is None:
        try:
            store.cas(key, expected, generation)
            return
        except Exception as exc:
            from google.api_core.exceptions import PreconditionFailed
            if not isinstance(exc, PreconditionFailed):
                raise
            state, _ = store.load(key)
    if state != expected:
        raise Conflict('Recording content or identity changed')


def reserve_occurrence(store, identity, recording_key, now, lease_seconds=660):
    """Reserve one occurrence; a completed receipt is reused across recordings."""
    import uuid
    key = 'occurrence/' + digest_key(*identity)
    state, generation = store.load(key)
    if state and state.get('receipt'):
        return key, None, state['receipt']
    if state and state.get('lease_until', 0) > now:
        raise Conflict('Delivery is already in progress')
    token = uuid.uuid4().hex
    state = dict(state or {})
    state.update({'lease_token':token, 'lease_until':now + lease_seconds, 'recording_key':state.get('recording_key', recording_key)})
    # The first recording owns a pending occurrence. Another capture may only
    # reuse its confirmed result; it cannot replace an unfinished transcript.
    if state['recording_key'] != recording_key:
        raise Conflict('Another recording owns this occurrence')
    try:
        store.cas(key, state, generation)
    except Exception as exc:
        from google.api_core.exceptions import PreconditionFailed
        if isinstance(exc, PreconditionFailed):
            raise Conflict('Delivery is already in progress') from exc
        raise
    return key, token, None


def checkpoint(store, key, token, now, updates):
    state, generation = store.load(key)
    if not state or state.get('lease_token') != token or state.get('lease_until', 0) <= now:
        raise DeliveryError('Delivery claim expired')
    state.update(updates)
    store.cas(key, state, generation)
    return state


class Conflict(DeliveryError):
    status = 409


class Forbidden(DeliveryError):
    status = 403


class CalendarSelectionRequired(Forbidden):
    pass


class ProviderPending(DeliveryError):
    status = 503


class ProviderRejected(ProviderPending):
    """An explicit provider rejection proves no object was created."""

    def __init__(self, message, *, retry_after=0):
        super().__init__(message)
        self.retry_after = retry_after


def deliver(payload, owner, store, providers, calendar_factory, clock, deadline=None, *, slack=None,
            followup_items=None, calendar_selection=None, retry_slack=False, defer_slack=False):
    """File and share verified notes, then deliver the recap."""
    recording_id, content_hash = validate_payload(payload)
    deadline = deadline or clock() + 570  # Gunicorn kills the synchronous worker at 600s.
    calendar_context = None
    if payload['calendar'] is None:
        identity = ('manual', owner, recording_id)
        attendees, recipients = [owner], [owner]
        title = payload['title']
    else:
        ids = calendar_selection() if calendar_selection else ()
        if not ids:
            raise CalendarSelectionRequired('Select the meeting calendar before delivering notes')
        event = resolve_occurrence(calendar_factory(owner), payload['calendar'], ids, owner_email=owner)
        if calendar_selection() != ids:
            raise Conflict('Calendar selection changed before notes could be verified')
        attendees = sorted(participant_emails(event))
        if owner not in attendees:
            raise Forbidden('Only an invited participant or organizer can deliver this meeting')
        ical_uid, original_start = canonical_occurrence(event)
        identity = ('calendar', ical_uid, original_start)
        calendar_context = {'event_id': event.get('id') or '', 'series_id': event.get('recurringEventId') or '',
                            'ical_uid': ical_uid, 'original_start': original_start}
        recipients = internal_recipients(event)
        title = str(event.get('summary') or payload['title'])
    occurrence_key = 'occurrence/' + digest_key(*identity)
    recording_key = digest_key(owner, recording_id)
    bind_recording(store, owner, recording_id, content_hash, occurrence_key)
    key, token, receipt = reserve_occurrence(store, identity, recording_key, clock())
    if receipt:
        original_recipients = receipt.get('recipients') if isinstance(receipt, dict) else None
        if (not isinstance(original_recipients, list) or not original_recipients
                or any(not is_internal_email(email) for email in original_recipients)
                or owner not in original_recipients):
            raise Forbidden('Meeting is unavailable')
        state, _ = store.load(key)
        # Old receipts cannot authorize creating a note from a later capture.
        if receipt.get('notes_url'):
            def duplicate_fence():
                if clock() + 30 >= deadline:
                    raise Conflict('Delivery deadline expired; retry this recording')
            meeting_id = 'reel_' + digest_key(*identity)
            duplicate_fence()
            note, _ = store.load('notes/' + meeting_id)
            duplicate_fence()
            if note is None:
                raise ProviderPending('Canonical meeting note is unavailable')
            _validate_note(note, meeting_id)
            if owner in note['recipients']:
                update_note_index(store, meeting_id, owner, recording_id, duplicate_fence)
        duplicate = state['recording_key'] != recording_key
        if (retry_slack and slack is not None and not duplicate and receipt.get('slack_retry_pending') is True
                and receipt.get('notes_url')):
            receipt = retry_saved_slack(store, key, recording_key, receipt, note, slack, clock, deadline)
        return {**receipt, 'suppressed_duplicate':duplicate}

    def fence():
        state, _ = store.load(key)
        if clock() + 30 >= deadline or not state or state.get('lease_token') != token or state.get('lease_until', 0) <= clock() + 30:
            raise Conflict('Delivery claim expired; retry this recording')
        return state

    def save(**updates):
        fence()
        state = checkpoint(store, key, token, clock(), updates)
        fence()
        return state

    attempted = set()
    try:
        with providers.context(fence):
            state = fence()
            email_ledger = ('email_started_at', 'email', 'email_create_uncertain', 'email_retry_after')
            if (retry_slack and slack is not None and 'slack_retry_eligible' not in state
                    and not any(field in state for field in email_ledger)):
                state = save(slack_retry_eligible=True)
            # Recipient/title/route inputs belong to the first authoritative
            # snapshot, not a later invite edit during provider recovery.
            if 'recipients' not in state:
                state = save(recipients=recipients, attendees=attendees, title=title, calendar_context=calendar_context)
            recipients, attendees, title = state['recipients'], state['attendees'], state['title']
            calendar_context = state.get('calendar_context')
            delivery_payload = {**payload, 'title':title}
            transcript = format_transcript(payload['segments'])
            meeting_id = 'reel_' + digest_key(*identity)
            notes_url = state.get('notes_url')
            if 'notes_url' in state:
                validated_notes_url(notes_url, meeting_id)
            else:
                # Older workers could publish the immutable note before their
                # next occurrence checkpoint. Recover only its original URL.
                existing, _ = store.load('notes/' + meeting_id)
                fence()
                if existing is not None:
                    _validate_note(existing, meeting_id)
                    if (existing['recipients'] != recipients or existing.get('attendees') != attendees
                            or existing['segments'] != payload['segments'] or existing['transcript_text'] != transcript
                            or existing.get('title') != title or existing.get('summary') != payload['summary']
                            or existing.get('started_at') != payload['started_at']):
                        raise Conflict('Canonical meeting note changed')
                    notes_url = validated_notes_url(existing.get('notes_url'), meeting_id)
                    state = save(notes_url=notes_url)
                elif state.get('notes_published'):
                    raise ProviderPending('Canonical meeting note is unavailable')
            page = state.get('notion')
            if not page:
                if state.get('notion_create_uncertain') is False and state.get('notion_retry_after', 0) > clock():
                    raise Conflict('Notion requested a later retry')
                page = providers.find_notion(meeting_id)
                fence()
                if not page:
                    if state.get('notion_create_uncertain', bool(state.get('notion_retry_after'))):
                        raise Conflict('Notion create result remains uncertain; retry to reconcile the original page')
                    if notes_url is None:
                        notes_url = configured_notes_url(meeting_id)
                        state = save(notes_url=notes_url)
                    args = (meeting_id, {**delivery_payload, 'notes_url': notes_url}, attendees, transcript)
                    prepare = getattr(providers, 'prepare_notion', None)
                    submit = prepare(*args) if prepare else partial(providers.create_notion, *args)
                    # Private destination checks and immutable archive preparation
                    # have completed. A lost response from submission is ambiguous.
                    save(notion_retry_after=clock() + 60, notion_create_uncertain=True)
                    attempted.add('notion_retry_after')
                    try:
                        page = submit()
                    except ProviderRejected as exc:
                        save(notion_create_uncertain=False, notion_retry_after=clock() + exc.retry_after)
                        attempted.discard('notion_retry_after')
                        raise
                    fence()
                    if not page or not page.get('page_id') or not page.get('url'):
                        raise ProviderPending('Notion result is uncertain; retry to reconcile')
                state = save(notion=page, notion_create_uncertain=False)

            def verify_page():
                verify_link = getattr(providers, 'verify_notion_with_notes_url', None)
                if verify_link:
                    return verify_link(page, meeting_id, transcript, notes_url)
                providers.verify_notion(page, meeting_id, transcript)

            legacy_email = not state.get('notes_published') and any(
                field in state for field in ('email_started_at', 'email', 'email_create_uncertain', 'email_retry_after'))
            archived_url = verify_page()
            fence()
            if notes_url is None and not legacy_email:
                notes_url = archived_url or configured_notes_url(meeting_id)
                state = save(notes_url=notes_url)
            route = state.get('route')
            people = [email for email in attendees if not email.endswith('@resource.calendar.google.com')]
            if len(people) == 2 and all(is_internal_email(email) for email in people):
                if not route or route.get('kind') != 'private':
                    route = {'kind':'private'}
                    state = save(route=route, route_verified=False, route_retry_after=0)
            if route is None:
                choose_calendar_route = getattr(providers, 'choose_calendar_route', None)
                if calendar_context and choose_calendar_route:
                    route = choose_calendar_route(title, attendees, calendar_context)
                if route is None:
                    route = providers.choose_route(title, attendees, payload['calendar'] is None)
                state = save(route=route)
            if not state.get('route_verified'):
                if state.get('route_retry_after', 0) > clock():
                    raise Conflict('Notion routing is still settling; retry shortly')
                save(route_retry_after=clock() + 60)
                attempted.add('route_retry_after')
                providers.apply_route(page, route, meeting_id, delivery_payload, attendees)
                fence()
                verify_page()
                state = save(route_verified=True)
            # A draft or send attempt from the old service may contain a Notion
            # link. Reconcile a proven send, but never send or replace its draft.
            if legacy_email:
                existing = providers.find_email(meeting_id, since=state.get('email_started_at', 0))
                fence()
                if not existing or existing.get('state') != 'sent' or not existing.get('provider_message_id'):
                    raise ProviderPending('Legacy email attempt requires reconciliation before delivery')
                receipt = {'verified':True, 'page_id':page['page_id'], 'url':page['url'], 'recipients':recipients, 'email_status':'confirmed', 'route':route['kind'], 'suppressed_duplicate':False}
                save(email=existing, email_create_uncertain=False, receipt=receipt)
                return receipt
            ends = [item.get('end') for item in payload['segments'] if isinstance(item.get('end'), (int, float)) and not isinstance(item.get('end'), bool)]
            import math
            duration = max((value for value in ends if math.isfinite(value) and value >= 0), default=0)
            note = {'id':meeting_id, 'title':title, 'started_at':payload['started_at'],
                    'attendees':attendees, 'recipients':recipients, 'duration_seconds':duration,
                    'summary':payload['summary'], 'transcript_status':'complete', 'notes_url':notes_url,
                    'route':route['kind'], 'segments':payload['segments'], 'transcript_text':transcript}
            fence()
            publish_shared_note(store, note, owner, recording_id, fence)
            fence()
            if not state.get('notes_published'):
                state = save(notes_published=True)
            submit_followups = getattr(providers, 'submit_followups', None)
            if calendar_context and route['kind'] == 'client' and submit_followups and 'followup_actions' not in state:
                tasks = [item['task'].strip() for item in followup_items or []
                         if isinstance(item, dict) and isinstance(item.get('task'), str) and item['task'].strip()]
                if tasks:
                    state = save(followup_actions=tasks)
            email = state.get('email') or {}
            if email.get('state') != 'sent':
                if 'email_started_at' not in state:
                    # A fixed lower bound survives arbitrarily late recovery.
                    # Older unresolved receipts lack it, so scan all dates.
                    first_attempt = 0 if email or state.get('email_create_uncertain') or state.get('email_retry_after') else clock()
                    state = save(email_started_at=first_attempt)
                existing = providers.find_email(meeting_id, since=state['email_started_at'])
                fence()
                if existing and existing.get('state') == 'sent':
                    email = existing
                else:
                    draft_id = (existing or {}).get('provider_draft_id') or email.get('provider_draft_id')
                    if not draft_id:
                        if state.get('email_create_uncertain', bool(state.get('email_retry_after'))):
                            raise Conflict('Gmail draft result remains uncertain; retry to reconcile the original draft')
                        save(email_retry_after=clock() + 60, email_create_uncertain=True)
                        attempted.add('email_retry_after')
                        message = recap_message(recipients, title, payload['summary'], notes_url, providers.message_id(meeting_id))
                        try:
                            draft_id = providers.create_draft(meeting_id, message)
                        except ProviderRejected:
                            save(email_create_uncertain=False, email_retry_after=0)
                            attempted.discard('email_retry_after')
                            raise
                        if not draft_id:
                            raise ProviderPending('Gmail draft result is uncertain; retry to reconcile')
                        state = save(email={'state':'draft', 'provider_draft_id':draft_id}, email_create_uncertain=False)
                    if (state.get('email') or {}).get('provider_draft_id') != draft_id:
                        state = save(email={'state':'draft', 'provider_draft_id':draft_id}, email_create_uncertain=False)
                    fence()
                    # Never replace this draft after a send ambiguity. Its stable
                    # ID either sends once or is gone; reconcile the sent mail.
                    email = providers.send_draft(meeting_id, draft_id)
                    fence()
                    if not email or email.get('state') != 'sent' or not email.get('provider_message_id'):
                        raise ProviderPending('Gmail send result is uncertain; retry to reconcile')
                state = save(email=email, email_create_uncertain=False)
            if submit_followups and route['kind'] == 'client' and calendar_context and state.get('followup_actions') and not state.get('followups_accepted'):
                if not email.get('provider_message_id'):
                    raise ProviderPending('Gmail send result is uncertain; retry to reconcile')
                fence()
                accepted = submit_followups(owner=owner, calendar_context=calendar_context, meeting_id=meeting_id,
                                            notion_page_id=page['page_id'], notion_url=page['url'],
                                            action_items=state['followup_actions'], transcript=transcript)
                fence()
                if accepted is True:
                    state = save(followups_accepted=True)
                elif accepted is not None:
                    raise ProviderPending('Follow-up handoff is unconfirmed; retry to reconcile')
            receipt = {'verified':True, 'page_id':page['page_id'], 'url':page['url'], 'recipients':recipients, 'email_status':'confirmed', 'route':route['kind'], 'suppressed_duplicate':False, 'notes_url':notes_url}
            if state.get('slack_retry_eligible') and slack is not None and notes_url:
                receipt['slack_retry_pending'] = True
            save(receipt=receipt)
            if slack is not None and notes_url and not defer_slack and (not retry_slack or state.get('slack_retry_eligible')):
                try:
                    outcome = send_slack_recaps(slack, note, state, save, fence, clock, deadline, retryable=retry_slack)
                    updated = {**receipt, 'slack': outcome}
                    if retry_slack:
                        updated['slack_retry_pending'] = slack_incomplete(outcome)
                    save(receipt=updated)
                    receipt = updated
                except Exception:
                    logger.warning('Reel Slack recap interrupted (%s)', meeting_id)
            return receipt
    finally:
        # A failed request releases only its own lease. A crashed/killed worker
        # retains its 660s lease, longer than the hard process timeout.
        state, generation = store.load(key)
        if state and state.get('lease_token') == token and state.get('lease_until', 0) > clock():
            # A returned ambiguous operation gets two full transport timeouts
            # to become query-visible, measured after its response/failure.
            for field, completed in [('notion_retry_after', bool(state.get('notion'))), ('route_retry_after', state.get('route_verified')), ('email_retry_after', (state.get('email') or {}).get('state') == 'sent')]:
                if field in attempted and not completed:
                    state[field] = max(state[field], clock() + 60)
            state['lease_until'] = clock()
            store.cas(key, state, generation)


def slack_incomplete(outcome):
    return any(outcome.get(key, 0) for key in ('retryable', 'not_attempted', 'unconfirmed'))


def retry_saved_slack(store, key, recording_key, receipt, note, slack, clock, deadline):
    """Claim only the original new delivery; old receipts never acquire a retry."""
    import uuid
    state, generation = store.load(key)
    if (not state or state.get('recording_key') != recording_key
            or state.get('receipt', {}).get('slack_retry_pending') is not True
            or state.get('lease_until', 0) > clock()):
        return receipt
    token = uuid.uuid4().hex
    state.update(lease_token=token, lease_until=clock() + 660)
    try:
        store.cas(key, state, generation)
    except Exception as exc:
        from google.api_core.exceptions import PreconditionFailed
        if isinstance(exc, PreconditionFailed):
            return receipt
        raise
    def fence():
        current, _ = store.load(key)
        if clock() + 30 >= deadline or not current or current.get('lease_token') != token or current.get('lease_until', 0) <= clock() + 30:
            raise Conflict('Delivery claim expired; retry this recording')
        return current
    def save(**updates):
        fence()
        result = checkpoint(store, key, token, clock(), updates)
        fence()
        return result
    try:
        outcome = send_slack_recaps(slack, note, fence(), save, fence, clock, deadline, retryable=True)
        updated = {**receipt, 'slack': outcome, 'slack_retry_pending': slack_incomplete(outcome)}
        save(receipt=updated)
        receipt = updated
    except Exception:
        logger.warning('Reel Slack recap retry interrupted (%s)', note['id'])
    finally:
        current, generation = store.load(key)
        if current and current.get('lease_token') == token and current.get('lease_until', 0) > clock():
            current['lease_until'] = clock()
            store.cas(key, current, generation)
    return receipt


def send_slack_recaps(slack, note, state, save, fence, clock, deadline, *, retryable=False):
    """Use the note's existing access list and checkpoint each optional DM."""
    def request(operation, *args):
        fence()
        try:
            return operation(*args)
        except SlackError as exc:
            if exc.uncertain or exc.code not in {'ratelimited', 'rate_limited'} or not 0 < exc.retry_after <= 2:
                raise
            time.sleep(exc.retry_after)
            fence()
            return operation(*args)

    message = slack_recap_message(note['title'], note['summary'], note['notes_url'])
    results = dict(state.get('slack_dms', {}))
    counts = Counter()
    recipients = note['recipients']
    for index, email in enumerate(recipients):
        if deadline - clock() < 90:
            counts['not_attempted'] += len(recipients) - index
            break
        if not is_internal_email(email):
            counts['unmatched'] += 1
            continue
        fence()
        previous = results.get(email, {})
        status = previous.get('status')
        if retryable and status == 'retryable':
            status = None
        if status and status != 'posting':
            counts[status] += 1
            continue
        client_msg_id = str(uuid5(NAMESPACE_URL, f"reel:slack:{note['id']}:{email}"))
        timestamp = None
        try:
            if not status:
                channel = request(slack.resolve_dm, email)
                if channel:
                    previous = {'status': 'posting', 'channel': channel, 'started_at': clock()}
                    results[email] = previous
                    save(slack_dms=results)
                    status = 'posting'
                    timestamp = request(slack.post_dm, channel, message, client_msg_id)
                else:
                    status = 'unmatched'
        except SlackError as exc:
            logger.warning('Reel Slack recap request failed (%s)', exc.code)
            if status != 'posting' or not exc.uncertain:
                status = ('retryable' if retryable and exc.code in {'transport_failure', 'unexpected_http_status', 'ratelimited', 'rate_limited'} else 'failed')
        if status == 'posting' and not timestamp:
            fence()
            try:
                timestamp = slack.find_dm(previous['channel'], client_msg_id, max(0, previous['started_at'] - 5))
            except SlackError as exc:
                logger.warning('Reel Slack recap readback failed (%s)', exc.code)
        if timestamp:
            status = 'sent'
        elif status == 'posting':
            status = 'unconfirmed'
        results[email] = (previous if retryable and status == 'unconfirmed' else
                          {'status': status, **({'ts': timestamp} if timestamp else {})})
        save(slack_dms=results)
        counts[status] += 1
    if any(counts[name] for name in ('failed', 'not_attempted', 'unconfirmed')):
        logger.warning('Reel Slack recap incomplete (%s): %s', note['id'], dict(counts))
    return dict(counts)

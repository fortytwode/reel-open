"""Pure validation and admission decisions; no cloud/browser dependencies."""
import hashlib
import re
import uuid
from datetime import datetime
from urllib.parse import urlsplit, parse_qs, urlencode

PROVIDERS = {'meet', 'zoom', 'teams'}


def meeting_url(provider, value):
    u = urlsplit(value)
    host = (u.hostname or '').lower()
    if u.scheme != 'https' or u.username or u.password or u.port not in (None, 443):
        raise ValueError('invalid_meeting_url')
    if provider == 'meet' and host == 'meet.google.com':
        match = re.fullmatch(r'/(?:meet/)?([a-z]{3}-[a-z]{4}-[a-z]{3})/?', u.path)
        if match:
            return 'https://meet.google.com/' + match[1]
    if provider == 'zoom' and (host == 'zoom.us' or host.endswith('.zoom.us')):
        match = re.fullmatch(r'/(?:j/|wc/(?:join/)?)(\d{9,11})(?:/join)?/?', u.path)
        if match:
            # Preserve only the encrypted Zoom password token. Never log this URL.
            pwd = parse_qs(u.query).get('pwd', [])
            return 'https://app.zoom.us/wc/' + match[1] + '/join' + ('?' + urlencode({'pwd': pwd[0]}) if pwd else '')
    if provider == 'teams' and host in {'teams.microsoft.com', 'teams.live.com'} and (u.path.startswith('/l/meetup-join/') or re.fullmatch(r'/meet/\d+/?', u.path)):
        return value
    raise ValueError('unsupported_meeting_url')


def validate_payload(p, callback_origin):
    if p.get('consent', {}).get('confirmed') is not True:
        raise ValueError('consent_required')
    if p.get('provider') not in PROVIDERS:
        raise ValueError('unsupported_provider')
    execution = p.get('execution_id', '')
    if str(uuid.UUID(execution)) != execution:
        raise ValueError('invalid_execution_id')
    owner = p.get('owner_id', '')
    if not isinstance(owner, str) or not 1 <= len(owner) <= 128:
        raise ValueError('invalid_owner_id')
    expected = 'reel-meetings/bot/' + hashlib.sha256(owner.encode()).hexdigest() + '/' + execution + '/'
    if p.get('output_prefix') != expected:
        raise ValueError('invalid_output_prefix')
    if not re.fullmatch(r'[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]', p.get('output_bucket', '')):
        raise ValueError('invalid_output_bucket')
    cb = urlsplit(p.get('callback_url', ''))
    origin = urlsplit(callback_origin)
    if cb.scheme != 'https' or (cb.scheme, cb.netloc) != (origin.scheme, origin.netloc) or cb.username or cb.password or cb.fragment:
        raise ValueError('invalid_callback_url')
    if not isinstance(p.get('callback_token'), str) or len(p['callback_token']) < 32:
        raise ValueError('invalid_callback_token')
    if not isinstance(p.get('display_name'), str) or not 1 <= len(p['display_name']) <= 100 or any(ord(c) < 32 for c in p['display_name']):
        raise ValueError('invalid_display_name')
    for key, default, maximum in [('max_duration_seconds', 3600, 10800), ('admission_timeout_seconds', 300, 900)]:
        value = p.setdefault(key, default)
        if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
            raise ValueError('invalid_' + key)
    if 'capture_deadline' in p:
        value = p['capture_deadline']
        if not isinstance(value, str) or not re.fullmatch(
                r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)', value):
            raise ValueError('invalid_capture_deadline')
        try:
            deadline = datetime.fromisoformat(value.replace('Z', '+00:00'))
            if deadline.utcoffset() is None:
                raise ValueError
        except ValueError:
            raise ValueError('invalid_capture_deadline') from None
    p['meeting_url'] = meeting_url(p['provider'], p['meeting_url'])
    return p


def admission_decision(*, denied=False, blocked=False, waiting=False, in_call=False, consent_gate=False, elapsed=0, timeout=300):
    # Failures and waiting room outrank controls that also appear in some lobbies.
    if denied:
        return 'denied'
    if blocked or consent_gate:
        return 'human_action_required'
    if elapsed >= timeout:
        return 'admission_timeout'
    if waiting:
        return 'awaiting_admission'
    if in_call:
        return 'joined'
    return 'requesting_entry'

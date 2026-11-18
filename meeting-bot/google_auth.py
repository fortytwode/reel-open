"""Dedicated bot-session restoration; never reads a personal browser profile."""
import json
import re
from urllib.parse import urlsplit

MAX_STATE_BYTES = 2 * 1024 * 1024


def google_host(host):
    host = (host or '').lower()
    return host == 'google.com' or host.endswith('.google.com')


def valid_account_email(email):
    return isinstance(email, str) and re.fullmatch(
        r'[^@\s<>\x00-\x1f\x7f-\x9f]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+', email) is not None


def load_state(client, uri, expected_email):
    location = urlsplit(uri)
    if (location.scheme != 'gs' or not location.netloc or location.username or location.password
            or location.query or location.fragment
            or not location.path.startswith('/reel-bot-auth/google/')
            or not location.path.endswith('.json') or '..' in location.path.split('/')
            or not valid_account_email(expected_email)):
        raise RuntimeError('google_auth_profile_invalid')
    try:
        blob = client.bucket(location.netloc).blob(location.path.lstrip('/'))
        blob.reload(timeout=30)
        if not blob.generation or not isinstance(blob.size, int) or not 0 < blob.size <= MAX_STATE_BYTES:
            raise RuntimeError('google_auth_profile_invalid')
        raw = blob.download_as_bytes(if_generation_match=blob.generation, timeout=30)
    except RuntimeError:
        raise
    except Exception:
        raise RuntimeError('google_auth_profile_unavailable') from None
    try:
        document = json.loads(raw)
        if (document['schema_version'] != 1
                or document['account_email'].lower() != expected_email.lower()):
            raise ValueError()
        state = document['storage_state']
        cookies, origins = state['cookies'], state['origins']
        if not isinstance(cookies, list) or not cookies or not isinstance(origins, list):
            raise ValueError()
        for cookie in cookies:
            if (not isinstance(cookie, dict) or not google_host(cookie.get('domain', '').lstrip('.'))
                    or not isinstance(cookie.get('name'), str) or not isinstance(cookie.get('value'), str)):
                raise ValueError()
        for origin in origins:
            parsed = urlsplit(origin['origin'])
            if (parsed.scheme != 'https' or not google_host(parsed.hostname)
                    or parsed.port not in (None, 443) or parsed.username or parsed.password
                    or parsed.query or parsed.fragment or parsed.path not in ('', '/')):
                raise ValueError()
        return state
    except (KeyError, TypeError, ValueError, AttributeError):
        raise RuntimeError('google_auth_profile_invalid') from None


async def verify_account(page, expected_email):
    """Require a fresh signed-in Google account indicator before meeting entry."""
    try:
        await page.goto('https://myaccount.google.com/?hl=en', wait_until='domcontentloaded', timeout=15000)
        if urlsplit(page.url).hostname != 'myaccount.google.com':
            raise RuntimeError('human_action_required')
        selector = '[aria-label^="Google Account:"], [aria-label^="Google account:"]'
        await page.wait_for_selector(selector, state='attached', timeout=5000)
        labels = [await node.get_attribute('aria-label') for node in await page.locator(selector).all()
                  if await node.is_visible()]
        pattern = re.compile(r'(?:^|[\s(<])' + re.escape(expected_email) + r'(?:$|[\s)>])', re.I)
        if len(labels) != 1 or not pattern.search(labels[0] or ''):
            raise RuntimeError('google_auth_account_mismatch')
    except RuntimeError:
        raise
    except Exception:
        raise RuntimeError('human_action_required') from None

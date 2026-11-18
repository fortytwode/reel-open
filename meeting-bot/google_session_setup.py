"""Private, short-lived, manual Google bot sign-in. Never accepts a password."""
import asyncio
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit

from google_auth import google_host, valid_account_email, verify_account

MAX_BYTES = 2 * 1024 * 1024


class SetupError(Exception):
    pass


def location(uri):
    p = urlsplit(uri)
    if (p.scheme != 'gs' or not p.netloc or p.username or p.password or p.query or p.fragment
            or not p.path.startswith('/reel-bot-auth/google/') or not p.path.endswith('.json')
            or '..' in p.path.split('/') or '%' in p.path):
        raise SetupError('setup_config_invalid')
    return p.netloc, p.path.lstrip('/')


def validate_config(document, config_uri, now=None):
    now = time.time() if now is None else now
    try:
        if set(document) != {'account_email', 'output_uri', 'expected_generation', 'expires_at'}:
            raise ValueError()
        if not valid_account_email(document['account_email']):
            raise ValueError()
        bucket, key = location(document['output_uri'])
        config_bucket, config_key = location(config_uri)
        if bucket != config_bucket or key == config_key:
            raise ValueError()
        generation = document['expected_generation']
        if type(generation) is not int or generation < 0:
            raise ValueError()
        expiry = datetime.fromisoformat(document['expires_at'].replace('Z', '+00:00'))
        if expiry.tzinfo is None or not now < expiry.timestamp() <= now + 900:
            raise ValueError()
        return {**document, 'deadline': expiry.timestamp()}
    except (ValueError, TypeError, KeyError, AttributeError):
        raise SetupError('setup_config_invalid') from None


def read_config(client, uri):
    bucket, key = location(uri)
    blob = client.bucket(bucket).blob(key)
    blob.reload(timeout=15)
    if not blob.generation or not isinstance(blob.size, int) or not 0 < blob.size <= 4096:
        raise SetupError('setup_config_invalid')
    return validate_config(json.loads(blob.download_as_bytes(
        if_generation_match=blob.generation, timeout=15)), uri)


def filter_state(state):
    cookies = [c for c in state['cookies'] if google_host(c.get('domain', '').lstrip('.'))]
    origins = []
    for origin in state['origins']:
        p = urlsplit(origin['origin'])
        if (p.scheme == 'https' and google_host(p.hostname) and p.port in (None, 443)
                and not p.username and not p.password and not p.query and not p.fragment
                and p.path in ('', '/')):
            origins.append(origin)
    if not cookies:
        raise SetupError('setup_state_empty')
    return {'cookies': cookies, 'origins': origins}


def upload_state(client, config, state):
    if time.time() >= config['deadline']:
        raise SetupError('setup_expired')
    raw = json.dumps({'schema_version': 1, 'account_email': config['account_email'],
                      'storage_state': filter_state(state)})
    if len(raw.encode()) > MAX_BYTES:
        raise SetupError('setup_state_invalid')
    bucket, key = location(config['output_uri'])
    client.bucket(bucket).blob(key).upload_from_string(
        raw, content_type='application/json', if_generation_match=config['expected_generation'],
        timeout=min(15, config['deadline'] - time.time()), retry=None)


async def collect_state(profile, expected_email):
    from playwright.async_api import async_playwright
    async with async_playwright() as playwright:
        context = await playwright.chromium.launch_persistent_context(
            str(profile), channel='chrome', headless=False, chromium_sandbox=True)
        try:
            page = await context.new_page()
            await verify_account(page, expected_email)
            return await context.storage_state(indexed_db=True)
        finally:
            await context.close()


def viewer_html(password):
    # The private IAM-authenticated response carries the ephemeral VNC password.
    return '''<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer">
<title>Dedicated Google bot sign-in</title><style>html,body,#screen{margin:0;width:100%;height:100%;overflow:hidden}</style>
<div id="screen"></div><script type="module">
import RFB from './core/rfb.js';
const url = new URL('websockify', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const rfb = new RFB(document.getElementById('screen'), url.href, {credentials:{password:''' + json.dumps(password) + '''}});
rfb.scaleViewport = true; rfb.resizeSession = false;
</script>'''


class Processes:
    def __init__(self):
        self.items = []

    def start(self, args, **kwargs):
        process = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   start_new_session=True, **kwargs)
        self.items.append(process)
        return process

    def close(self):
        # Kill process groups, including Chrome children, even if their parent exited.
        for process in reversed(self.items):
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        for process in self.items:
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass


async def run_session(client, config, root, processes):
    os.environ['DISPLAY'] = ':99'
    profile = root / 'profile'
    profile.mkdir(mode=0o700)
    web = root / 'web'
    web.mkdir(mode=0o700)
    password = secrets.token_urlsafe(6)[:8]  # VNC protocol supports eight password bytes.
    password_file = root / 'vnc-password'
    password_file.write_text(password + '\n')
    password_file.chmod(0o600)
    (web / 'index.html').write_text(viewer_html(password))
    for name in ('core', 'vendor'):
        (web / name).symlink_to(Path('/usr/share/novnc') / name, target_is_directory=True)
    xvfb = processes.start(['Xvfb', ':99', '-screen', '0', '1280x900x24', '-nolisten', 'tcp'])
    for _ in range(100):
        if xvfb.poll() is not None:
            raise SetupError('setup_display_failed')
        if Path('/tmp/.X11-unix/X99').exists():
            break
        await asyncio.sleep(.05)
    else:
        raise SetupError('setup_display_failed')
    processes.start(['x11vnc', '-display', ':99', '-localhost', '-rfbport', '5900',
                     '-passwdfile', str(password_file), '-forever', '-shared', '-quiet'])
    processes.start(['websockify', '--web', str(web), '8080', '127.0.0.1:5900'])
    chrome = processes.start(['google-chrome-stable', '--user-data-dir=' + str(profile),
                              '--no-first-run', '--window-size=1280,900',
                              'https://accounts.google.com/'])
    print('setup_viewer_ready', flush=True)
    while chrome.poll() is None:
        if any(p.poll() is not None for p in processes.items[:-1]):
            raise SetupError('setup_viewer_failed')
        await asyncio.sleep(.25)
    if chrome.returncode != 0:
        raise SetupError('setup_browser_failed')
    # Isolate the verifier and its browser in an owned group so deadline cleanup
    # does not wait for Playwright's asynchronous browser shutdown.
    state_file = root / 'verified-state.json'
    collector = processes.start([sys.executable, __file__, '--collect', str(profile),
                                 config['account_email'], str(state_file)])
    while collector.poll() is None:
        await asyncio.sleep(.1)
    if collector.returncode != 0 or not state_file.exists() or state_file.stat().st_size > MAX_BYTES:
        raise SetupError('setup_verification_failed')
    upload_state(client, config, json.loads(state_file.read_text()))
    print('setup_state_saved', flush=True)


def main():
    os.umask(0o077)
    processes = Processes()
    root = None
    def stop(_signum, _frame):
        raise SetupError('setup_expired')
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGALRM, stop)
    # Includes configuration access; expiry below tightens this absolute ceiling.
    signal.setitimer(signal.ITIMER_REAL, 900)
    try:
        from google.cloud import storage
        client = storage.Client()
        config = read_config(client, os.environ.get('BOT_GOOGLE_SETUP_CONFIG_URI', ''))
        signal.setitimer(signal.ITIMER_REAL, max(.001, config['deadline'] - time.time()))
        root = Path(tempfile.mkdtemp(prefix='reel-google-setup-'))
        root.chmod(0o700)
        asyncio.run(run_session(client, config, root, processes))
        return 0
    except BaseException:
        # Do not expose exception strings, browser output, URIs, or authentication data.
        print('setup_failed', flush=True)
        return 1
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        processes.close()
        if root is not None:
            shutil.rmtree(root, ignore_errors=True)


if __name__ == '__main__':
    if len(sys.argv) == 5 and sys.argv[1] == '--collect':
        os.umask(0o077)
        try:
            verified = asyncio.run(collect_state(Path(sys.argv[2]), sys.argv[3]))
            Path(sys.argv[4]).write_text(json.dumps(verified))
        except BaseException:
            raise SystemExit(1) from None
    else:
        raise SystemExit(main())

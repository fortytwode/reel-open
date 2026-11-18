"""One private payload, one guest attempt, one owner-scoped artifact set."""
import asyncio
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import traceback
from datetime import datetime, timezone
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from captions import CAPTIONS_FILENAME, CaptionCapture, write_unavailable
from captions import MAX_BYTES as MAX_CAPTION_BYTES, SOURCES as CAPTION_SOURCES
from policy import validate_payload

STOPPED = False
SAFE_DETAILS = {
    'denied', 'human_action_required', 'admission_timeout', 'join_not_available',
    'join_page_unavailable', 'admission_unconfirmed', 'execution_stopped',
    'meeting_access_lost', 'meeting_connection_lost', 'recorder_exited',
    'recorder_start_failed', 'callback_unavailable', 'display_unavailable',
    'transcription_failed', 'transcription_timeout', 'artifact_upload_failed',
    'meeting_ended', 'duration_limit', 'runtime_failure', 'capture_deadline_expired',
    'media_start_failed', 'browser_launch_failed', 'context_create_failed',
    'guest_join_failed', 'recording_start_failed', 'recording_monitor_failed',
    'media_start_timeout', 'browser_launch_timeout', 'context_create_timeout',
    'guest_join_timeout', 'recording_start_timeout', 'recording_monitor_timeout',
    'google_auth_profile_invalid', 'google_auth_profile_unavailable', 'google_auth_account_mismatch',
}


def stop(_sig, _frame):
    global STOPPED
    STOPPED = True


def now():
    return datetime.now(timezone.utc).isoformat()


def failure_metadata(error):
    if os.environ.get('BOT_DIAGNOSTICS') != '1':
        return {}
    result = {'exception_type': type(error).__name__}
    for frame in reversed(traceback.extract_tb(error.__traceback__)):
        source = Path(frame.filename)
        if (source.resolve().parent == Path(__file__).resolve().parent
                and source.name in {'worker.py', 'providers.py', 'policy.py', 'transcribe.py'}):
            result.update(failure_module=source.name, failure_function=frame.name, failure_line=frame.lineno)
            break
    return result


def command(args):
    return subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)


def stop_process(process):
    if process is not None and process.poll() is None:
        process.send_signal(signal.SIGINT)
        try:
            process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


class Run:
    def __init__(self, payload, client):
        self.p = payload
        self.client = client
        self.bucket = client.bucket(payload['output_bucket'])
        self.artifacts = {}
        self.sequence = 0
        self.claimed = False

    def claim(self):
        # Atomic create survives separate Cloud Run executions; duplicates never join.
        from google.api_core.exceptions import PreconditionFailed
        try:
            self.bucket.blob(self.p['output_prefix'] + 'execution.lock').upload_from_string(
                json.dumps({'execution_id': self.p['execution_id'], 'claimed_at': now()}),
                content_type='application/json', if_generation_match=0, timeout=30)
            self.claimed = True
        except PreconditionFailed:
            return False
        return True

    def callback_sync(self, status, **extra):
        self.sequence += 1
        body = {'execution_id': self.p['execution_id'], 'owner_id': self.p['owner_id'],
                'status': status, 'at': now(), 'sequence': self.sequence, **extra}
        encoded = json.dumps(body).encode()
        req = Request(self.p['callback_url'], data=encoded, method='POST', headers={
            'Authorization': 'Bearer ' + self.p['callback_token'], 'Content-Type': 'application/json'})
        # A callback retry repeats the same sequence and does not create a new join.
        for attempt in range(3):
            try:
                with urlopen(req, timeout=15) as response:
                    if not 200 <= response.status < 300:
                        raise RuntimeError('callback_rejected')
                return
            except Exception:
                if attempt == 2:
                    raise RuntimeError('callback_unavailable') from None
                time.sleep(attempt + 1)

    async def callback(self, status, **extra):
        await asyncio.to_thread(self.callback_sync, status, **extra)
        log = {'execution_id': self.p['execution_id'], 'status': status}
        if extra.get('detail') in SAFE_DETAILS:
            log['detail'] = extra['detail']
        print(json.dumps(log), flush=True)

    async def diagnostic(self, page, stage):
        """Opt-in private QA snapshots; never include content in callbacks or logs."""
        if os.environ.get('BOT_DIAGNOSTICS') != '1':
            return
        if stage not in {'navigation', 'waiting', 'failed'}:
            return
        prefix = self.p['output_prefix'] + 'debug/' + stage
        async def upload_debug(suffix, data, mime):
            await asyncio.to_thread(self.bucket.blob(prefix + suffix).upload_from_string,
                                    data, content_type=mime, timeout=10, retry=None)
        try:
            from providers import body_text
            text = ((await body_text(page)) or '[No visible body text available]').encode('utf-8')[:262144]
            # Save text first: screenshot can time out waiting for incomplete page assets.
            await upload_debug('.txt', text, 'text/plain; charset=utf-8')
        except Exception:
            pass
        try:
            screenshot = await page.screenshot(type='png', full_page=False, timeout=4000)
            await upload_debug('.png', screenshot, 'image/png')
        except Exception:
            # Evidence capture failures never alter admission or leak provider details.
            pass

    def upload(self, root):
        types = {'recording.mp4': 'video/mp4', 'system-audio.wav': 'audio/wav',
                 'transcript.json': 'application/json', 'transcript.txt': 'text/plain',
                 'summary.json': 'application/json'}
        for name, mime in types.items():
            file = root / name
            if not file.exists() or not file.stat().st_size:
                continue
            blob = self.bucket.blob(self.p['output_prefix'] + name)
            blob.upload_from_filename(str(file), content_type=mime, if_generation_match=0, timeout=300)
            self.artifacts[name] = {'gcs_uri': 'gs://' + self.p['output_bucket'] + '/' + blob.name,
                                    'size_bytes': file.stat().st_size, 'content_type': mime}
        if self.p.get('provider') in CAPTION_SOURCES:
            try:
                file = root / CAPTIONS_FILENAME
                if file.is_file() and 0 < (size := file.stat().st_size) <= MAX_CAPTION_BYTES:
                    name = self.p['output_prefix'] + CAPTIONS_FILENAME
                    self.bucket.blob(name).upload_from_filename(
                        str(file), content_type='application/json', if_generation_match=0, timeout=5, retry=None)
                    self.artifacts[CAPTIONS_FILENAME] = {
                        'gcs_uri': 'gs://' + self.p['output_bucket'] + '/' + name,
                        'size_bytes': size, 'content_type': 'application/json',
                    }
            except Exception:
                pass
        return self.artifacts


def start_media(root):
    # Silent input is a separate null sink: remote audio is never fed back to the meeting.
    command(['pulseaudio', '--start', '--exit-idle-time=-1', '--log-target=file:/tmp/pulse.log'])
    command(['pactl', 'load-module', 'module-null-sink', 'sink_name=reel_output', 'rate=48000', 'channels=2'])
    command(['pactl', 'load-module', 'module-null-sink', 'sink_name=reel_silent_input', 'rate=48000', 'channels=1'])
    command(['pactl', 'set-default-sink', 'reel_output'])
    command(['pactl', 'set-default-source', 'reel_silent_input.monitor'])
    process = subprocess.Popen(['Xvfb', ':99', '-screen', '0', '1280x720x24', '-nolisten', 'tcp'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        if Path('/tmp/.X11-unix/X99').exists():
            return process
        if process.poll() is not None:
            break
        time.sleep(.1)
    stop_process(process)
    raise RuntimeError('display_unavailable')


def start_recording(root):
    # Fragmented MP4 remains readable if a run is terminated; audio is also retained for transcription.
    return subprocess.Popen([
        'ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-thread_queue_size', '512', '-f', 'x11grab', '-video_size', '1280x720', '-framerate', '15', '-i', ':99.0',
        '-thread_queue_size', '512', '-f', 'pulse', '-i', 'reel_output.monitor',
        '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30',
        '-maxrate', '1500k', '-bufsize', '3M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k',
        '-af', 'aresample=async=1', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', str(root / 'recording.mp4'),
        '-map', '1:a', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', str(root / 'system-audio.wav'),
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def capture_remaining(payload):
    if 'capture_deadline' not in payload:
        return None
    deadline = datetime.fromisoformat(payload['capture_deadline'].replace('Z', '+00:00'))
    remaining = (deadline - datetime.now(timezone.utc)).total_seconds()
    if remaining <= 0:
        raise RuntimeError('capture_deadline_expired')
    return remaining


async def execute(run, root):
    from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeoutError
    from providers import prepare_and_join, monitor
    xvfb = None
    recording = None
    recording_ready = False
    caption_capture = None
    browser = None
    page = None
    reason = None
    failure = None
    stage = 'media_start'

    async def finish_recording():
        nonlocal caption_capture
        ended = time.monotonic()
        stop_process(recording)
        if caption_capture is not None:
            capture, caption_capture = caption_capture, None
            try:
                await capture.finish(root, ended)
            except Exception:
                pass

    try:
        capture_remaining(run.p)
        google_state = None
        google_email = os.environ.get('BOT_GOOGLE_ACCOUNT_EMAIL', '')
        google_uri = os.environ.get('BOT_GOOGLE_AUTH_STATE_URI', '')
        if run.p.get('provider') == 'meet' and (google_uri or google_email):
            from google_auth import load_state
            stage = 'google_auth_profile'
            try:
                async with asyncio.timeout(capture_remaining(run.p)):
                    google_state = await asyncio.to_thread(load_state, run.client, google_uri, google_email)
            except TimeoutError:
                raise RuntimeError('capture_deadline_expired') from None
            capture_remaining(run.p)
        stage = 'media_start'
        xvfb = start_media(root)
        async with async_playwright() as playwright:
            try:
                stage = 'browser_launch'
                browser = await playwright.chromium.launch(headless=False, args=[
                    '--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required',
                    '--lang=en-US', '--kiosk', '--window-size=1280,720', '--window-position=0,0', '--start-maximized',
                ], env={**os.environ, 'DISPLAY': ':99', 'PULSE_SINK': 'reel_output', 'PULSE_SOURCE': 'reel_silent_input.monitor'})
                stage = 'context_create'
                options = dict(locale='en-US', viewport={'width': 1280, 'height': 720},
                               permissions=['microphone', 'camera'], accept_downloads=False)
                if google_state is not None:
                    options['storage_state'] = google_state
                context = await browser.new_context(**options)
                page = await context.new_page()
                page.set_default_timeout(2500)
                if google_state is not None:
                    from google_auth import verify_account
                    stage = 'google_auth'
                    try:
                        async with asyncio.timeout(capture_remaining(run.p)):
                            await verify_account(page, google_email)
                    except TimeoutError:
                        raise RuntimeError('capture_deadline_expired') from None
                stage = 'guest_join'
                remaining = capture_remaining(run.p)
                join_payload = run.p
                if remaining is not None:
                    join_payload = {**run.p, 'admission_timeout_seconds': min(
                        run.p['admission_timeout_seconds'], remaining)}
                # This timer includes admission and callbacks, so a slow status
                # request cannot leave the recorder running beyond server expiry.
                timer = asyncio.timeout(remaining)
                try:
                    async with timer:
                        await prepare_and_join(page, join_payload, run.callback, lambda: STOPPED,
                                               diagnostic=run.diagnostic, authenticated_google=google_state is not None)
                        capture_remaining(run.p)
                        stage = 'recording_start'
                        recording = start_recording(root)
                        recording_started = time.monotonic()
                        if run.p.get('provider') in CAPTION_SOURCES:
                            try:
                                caption_capture = CaptionCapture(page, run.p['provider'], run.p['execution_id'],
                                                                recording_started)
                                caption_capture.start()
                            except Exception:
                                pass
                        await asyncio.sleep(1)
                        if recording.poll() is not None:
                            raise RuntimeError('recorder_start_failed')
                        recording_ready = True
                        capture_remaining(run.p)
                        await run.callback('recording')
                        stage = 'recording_monitor'
                        remaining = capture_remaining(run.p)
                        duration = run.p['max_duration_seconds']
                        if remaining is not None:
                            duration = min(remaining, max(0, duration - (time.monotonic() - recording_started)))
                        reason = await monitor(page, run.p['provider'], duration, lambda: STOPPED, recording)
                        if reason == 'execution_stopped':
                            raise RuntimeError(reason)
                except (TimeoutError, RuntimeError) as error:
                    deadline_expired = ((isinstance(error, TimeoutError) and timer.expired())
                                        or (isinstance(error, RuntimeError)
                                            and str(error) == 'capture_deadline_expired'))
                    if not deadline_expired:
                        raise
                    if not recording_ready:
                        raise RuntimeError('capture_deadline_expired') from None
                    if recording.poll() is not None:
                        raise RuntimeError('recorder_exited') from None
                    # A healthy recording reaching its limit is complete: its
                    # uploaded audio must still enter processing and delivery.
                    reason = 'duration_limit'
                await finish_recording()
                # Closing browser is definitive departure. Never click End meeting for everyone.
                await browser.close()
                browser = None
            except Exception:
                # Stop capture before diagnostic or browser shutdown delays.
                await finish_recording()
                # Capture while Playwright, context and browser are still alive.
                if page is not None:
                    await run.diagnostic(page, 'failed')
                raise
    except Exception as error:
        # Never send third-party exception messages: they can contain meeting URLs or DOM text.
        if isinstance(error, RuntimeError) and str(error) in SAFE_DETAILS:
            failure = str(error)
        else:
            failure = stage + ('_timeout' if isinstance(error, PlaywrightTimeoutError) else '_failed')
        event = {'execution_id': run.p['execution_id'], 'status': 'failure_detected', 'detail': failure}
        event.update(failure_metadata(error))
        print(json.dumps(event), flush=True)
    finally:
        stop_process(recording)
        if browser:
            try:
                await browser.close()
            except Exception:
                pass
        stop_process(xvfb)
    if recording:
        if run.p.get('provider') in CAPTION_SOURCES:
            try:
                if not (root / CAPTIONS_FILENAME).is_file():
                    write_unavailable(root, run.p['execution_id'], run.p['provider'])
            except Exception:
                pass
        try:
            await asyncio.to_thread(run.upload, root)
        except Exception:
            failure = failure or 'artifact_upload_failed'
    await run.callback('failed' if failure else 'completed', detail=failure or reason, artifacts=run.artifacts)
    return 1 if failure else 0


def main():
    from google.cloud import storage
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    run = None
    try:
        uri = urlsplit(os.environ['BOT_PAYLOAD_GCS_URI'])
        if uri.scheme != 'gs' or not uri.netloc or not uri.path.strip('/') or uri.query or uri.fragment:
            raise ValueError('invalid_payload_uri')
        client = storage.Client()
        blob = client.bucket(uri.netloc).blob(uri.path.lstrip('/'))
        blob.reload(timeout=30)
        if not blob.size or blob.size > 65536:
            raise ValueError('invalid_payload_size')
        p = validate_payload(json.loads(blob.download_as_bytes(timeout=30, if_generation_match=blob.generation)),
                             os.environ['BOT_CALLBACK_ORIGIN'])
        run = Run(p, client)
        if not run.claim():
            print('{"status":"duplicate_execution_skipped"}', flush=True)
            return 0
        with tempfile.TemporaryDirectory(prefix='reel-bot-') as directory:
            return asyncio.run(execute(run, Path(directory)))
    except Exception:
        # Only constant error codes reach platform logs.
        print('{"status":"failed","detail":"worker_setup_or_callback_failed"}', flush=True)
        if run and run.claimed:
            try:
                run.callback_sync('failed', detail='worker_setup_or_callback_failed', artifacts=run.artifacts)
            except Exception:
                pass
        return 1


if __name__ == '__main__':
    raise SystemExit(main())

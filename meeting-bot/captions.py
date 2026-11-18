"""Best-effort, recording-relative evidence from native browser captions."""

import asyncio
import json
import math
import re
import time
import unicodedata
import wave

from browser_captions import DRAIN, INSTALL, SELECTORS, caption_frame


CAPTIONS_FILENAME = 'captions.json'
SOURCES = {'meet': 'google_meet_caption', 'teams': 'teams_caption'}
MAX_TURNS = 10_000
MAX_TEXT_CHARS = 250_000
MAX_BYTES = 2 * 1024 * 1024
MAX_BATCH_ROWS = 128
MAX_TURN_CHARS = 12_000
POLL_SECONDS = 0.5
BROWSER_SECONDS = 1
SETUP_SECONDS = 15
GENERIC_NAMES = {
    'you', 'me', 'self', 'unknown', 'unknown speaker', 'speaker unknown', 'unidentified speaker',
    'unidentified', 'anonymous', 'anonymous user', 'participant', 'speaker', 'unknown participant',
    'guest', 'guest user', 'you guest', 'caller', 'phone caller', 'private caller', 'unknown caller',
}


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def caption_document(execution_id, provider, status, reason, turns):
    result = {'schema_version': 1, 'execution_id': execution_id, 'provider': provider,
              'status': status, 'timing': 'caption_observed', 'turns': turns}
    if reason:
        result['reason'] = reason
    return result


def write_unavailable(root, execution_id, provider):
    write_caption_file(root, encode(caption_document(
        execution_id, provider, 'unavailable', 'caption_capture_failed', [])))


def write_caption_file(root, data):
    target = root / CAPTIONS_FILENAME
    temporary = target.with_suffix('.tmp')
    temporary.write_bytes(data)
    temporary.replace(target)


def display_field(value, limit):
    return (isinstance(value, str) and 1 <= len(value) <= limit and value == value.strip()
            and not any(char in '<>' or unicodedata.category(char).startswith('C')
                        or unicodedata.category(char) in {'Zl', 'Zp'} for char in value))


def named_speaker(name):
    if not display_field(name, 120):
        return False
    words = ' '.join(re.findall(r'[^\W_]+', unicodedata.normalize('NFKC', name).casefold()))
    return (bool(words) and words not in GENERIC_NAMES
            and not re.fullmatch(r'(?:speaker|participant|guest|unknown|caller)(?: \d+)+', words)
            and not re.fullmatch(r'(?:\d+ )*\d+', words))


def elapsed_time(value):
    return type(value) in (int, float) and 0 <= value < 24 * 3600 and math.isfinite(value)


class CaptionBuffer:
    def __init__(self, provider):
        self.source = SOURCES[provider]
        self.turns = {}
        self.issue = None
        self.text_chars = 0
        self.turn_bytes = 0

    def mark(self, reason):
        if self.issue is None:
            self.issue = reason

    def ingest(self, batch, generation, cutoff):
        if batch.get('overflow'):
            self.mark('caption_limit_reached')
        if batch.get('ignored'):
            self.mark('invalid_caption_row')
        rows = batch.get('rows')
        if not isinstance(rows, list) or len(rows) > MAX_BATCH_ROWS:
            self.mark('caption_limit_reached')
            return
        for row in rows:
            if not isinstance(row, dict):
                self.mark('invalid_caption_row')
                continue
            start, end, row_id = row.get('start'), row.get('end'), row.get('id')
            if (not elapsed_time(start) or not elapsed_time(end) or end < start
                    or type(row_id) is not int or row_id < 1):
                self.mark('invalid_caption_row')
                continue
            if end > cutoff:
                continue
            text, name = row.get('text'), row.get('name')
            if not isinstance(text, str) or not 0 < len(text) <= MAX_TURN_CHARS or not text.strip():
                self.mark('invalid_caption_row')
                continue
            if not named_speaker(name):
                self.mark('unidentified_caption_speaker')
                continue
            key = generation, row_id
            prior, prior_size = self.turns.get(key, (None, 0))
            if prior and (prior['speaker_name'] != name or prior['end'] > round(end, 3)):
                self.mark('invalid_caption_row')
                continue
            turn = {'start': round(start, 3), 'end': round(end, 3), 'text': text,
                    'speaker_name': name, 'source': self.source}
            speaker_id = row.get('speakerId')
            if display_field(speaker_id, 200):
                turn['speaker_id'] = speaker_id
            try:
                size = len(encode(turn)) + 1
            except UnicodeError:
                self.mark('invalid_caption_row')
                continue
            total_chars = self.text_chars + len(text) - (len(prior['text']) if prior else 0)
            total_bytes = self.turn_bytes + size - prior_size
            if ((prior is None and len(self.turns) >= MAX_TURNS) or total_chars > MAX_TEXT_CHARS
                    or total_bytes > MAX_BYTES - 512):
                self.mark('caption_limit_reached')
                continue
            self.turns[key] = turn, size
            self.text_chars, self.turn_bytes = total_chars, total_bytes

    def document(self, execution_id, provider, duration):
        turns = sorted((turn for turn, _ in self.turns.values()), key=lambda turn: turn['start'])
        # Caption observation can land after the last PCM frame, especially
        # while the recorder is starting or the provider is finalizing a line.
        turns = [{**turn, 'start': min(turn['start'], duration), 'end': min(turn['end'], duration)}
                 for turn in turns]
        if turns:
            status = 'partial' if self.issue else 'captured'
        else:
            status = 'unavailable'
        return caption_document(execution_id, provider, status, self.issue or (None if turns else 'no_caption_rows'), turns)


def recording_duration(root, elapsed):
    try:
        with wave.open(str(root / 'system-audio.wav'), 'rb') as audio:
            return min(elapsed, audio.getnframes() / audio.getframerate())
    except (EOFError, OSError, wave.Error, ZeroDivisionError):
        return elapsed


class CaptionCapture:
    def __init__(self, page, provider, execution_id, recording_started):
        self.page = page
        self.provider = provider
        self.execution_id = execution_id
        self.started = recording_started
        self.buffer = CaptionBuffer(provider)
        self.generation = 0
        self.frame = None
        self.stopping = asyncio.Event()
        self.cutoff = float('inf')
        self.task = None

    def start(self):
        self.task = asyncio.create_task(self._collect())

    async def _wait_for_stop(self):
        try:
            async with asyncio.timeout(POLL_SECONDS):
                await self.stopping.wait()
            return True
        except TimeoutError:
            return False

    async def _install(self, *, restart):
        if self.provider not in SELECTORS:
            return False
        try:
            async with asyncio.timeout(BROWSER_SECONDS if restart else SETUP_SECONDS):
                while not self.stopping.is_set():
                    frame = await caption_frame(self.page, self.provider, enable=not restart)
                    if frame is not None and not self.stopping.is_set():
                        installed = await frame.evaluate(INSTALL, {'selector': SELECTORS[self.provider],
                            'elapsed': max(0, time.monotonic() - self.started), 'skipExisting': restart})
                        if installed is True:
                            self.frame = frame
                            self.generation += 1
                            return True
                    if restart or await self._wait_for_stop():
                        break
        except TimeoutError:
            pass
        return False

    async def _drain(self, *, stop=False):
        if self.frame is None:
            return False
        try:
            async with asyncio.timeout(BROWSER_SECONDS):
                batch = await self.frame.evaluate(DRAIN, stop)
            if not isinstance(batch, dict):
                return False
            self.buffer.ingest(batch, self.generation, self.cutoff)
            return batch.get('alive') is True
        except Exception:
            return False

    async def _collect(self):
        try:
            if not await self._install(restart=False):
                if not self.stopping.is_set():
                    self.buffer.mark('caption_controls_unavailable')
                return
            while not await self._wait_for_stop():
                if not await self._drain():
                    self.buffer.mark('caption_observer_interrupted')
                    if self.generation > 1 or self.stopping.is_set() or not await self._install(restart=True):
                        break
        except Exception:
            self.buffer.mark('caption_capture_failed')
        finally:
            if self.frame is not None and not await self._drain(stop=True):
                self.buffer.mark('caption_observer_interrupted')

    async def finish(self, root, recording_ended):
        self.cutoff = max(0, recording_ended - self.started)
        self.stopping.set()
        if self.task is not None:
            try:
                await asyncio.wait_for(self.task, timeout=2 * BROWSER_SECONDS + 0.25)
            except TimeoutError:
                self.buffer.mark('caption_capture_failed')
        duration = recording_duration(root, self.cutoff)
        data = encode(self.buffer.document(self.execution_id, self.provider, duration))
        if len(data) > MAX_BYTES:
            write_unavailable(root, self.execution_id, self.provider)
            return
        write_caption_file(root, data)

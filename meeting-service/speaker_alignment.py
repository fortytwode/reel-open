"""Attribute ASR words only where platform captions provide unambiguous evidence."""

from bisect import bisect_left, bisect_right
from collections import defaultdict
from itertools import groupby
import math
import re
import unicodedata
import uuid


SOURCES = {'meet': 'google_meet_caption', 'teams': 'teams_caption'}
CAPTION_TOLERANCE = 30
MAX_TRANSCRIPT_CHARS = 200_000
MAX_SEGMENTS = 5_000
ANCHOR_WORDS = 3
WORD = re.compile(r"[^\W_]+(?:['’][^\W_]+)*")
GENERIC_NAMES = {'you', 'me', 'self', 'unknown', 'unknown speaker', 'speaker unknown',
                 'unidentified speaker', 'unidentified', 'anonymous', 'participant', 'speaker',
                 'unknown participant', 'guest'}


def _valid_display_field(value, limit):
    return (isinstance(value, str) and 1 <= len(value) <= limit and value == value.strip()
            and not any(char in '<>' or unicodedata.category(char).startswith('C')
                        or unicodedata.category(char) in {'Zl', 'Zp'} for char in value))


def _valid_time(value, limit):
    if type(value) not in (int, float) or not 0 <= value <= limit:
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def validate_caption_artifact(value, execution_id, provider, duration):
    """Verify the sidecar against the execution and project only supported fields."""
    try:
        uuid.UUID(execution_id)
    except (TypeError, ValueError, AttributeError) as error:
        raise ValueError('Invalid caption execution ID') from error
    if (not isinstance(value, dict) or type(value.get('schema_version')) is not int
            or value['schema_version'] != 1 or value.get('execution_id') != execution_id
            or not isinstance(provider, str) or provider not in SOURCES or value.get('provider') != provider
            or not _valid_time(duration, float('inf'))):
        raise ValueError('Invalid caption artifact metadata')

    status, turns = value.get('status'), value.get('turns')
    if (status not in ('captured', 'partial', 'unavailable') or not isinstance(turns, list)
            or len(turns) > 10_000 or (status == 'unavailable' and turns)):
        raise ValueError('Invalid caption artifact status or turns')

    safe_turns = []
    previous_start = text_length = 0
    time_limit = duration + CAPTION_TOLERANCE
    for turn in turns:
        if not isinstance(turn, dict) or turn.get('source') != SOURCES[provider]:
            raise ValueError('Invalid caption turn source')
        start, end, caption = turn.get('start'), turn.get('end'), turn.get('text')
        if (not _valid_time(start, time_limit) or not _valid_time(end, time_limit)
                or start < previous_start or start > end):
            raise ValueError('Invalid caption timestamps')
        if not isinstance(caption, str) or not caption.strip():
            raise ValueError('Invalid caption text')
        text_length += len(caption)
        if text_length > 250_000:
            raise ValueError('Caption text exceeds limit')
        name = turn.get('speaker_name')
        if not _valid_display_field(name, 120):
            raise ValueError('Invalid caption speaker name')
        generic_name = ' '.join(_word_key(word.group()) for word in WORD.finditer(name))
        if (not generic_name or generic_name in GENERIC_NAMES
                or re.fullmatch(r'(?:speaker|participant|guest|unknown)(?: \d+)+', generic_name)):
            raise ValueError('Unidentified caption speaker')

        safe_turn = {'start': start, 'end': end, 'text': caption, 'speaker_name': name,
                     'source': SOURCES[provider]}
        if 'speaker_id' in turn:
            if not _valid_display_field(turn['speaker_id'], 200):
                raise ValueError('Invalid caption speaker ID')
            safe_turn['speaker_id'] = turn['speaker_id']
        safe_turns.append(safe_turn)
        previous_start = start

    return {'schema_version': 1, 'execution_id': execution_id, 'provider': provider,
            'status': status, 'turns': safe_turns}


def _word_key(word):
    return unicodedata.normalize('NFKC', word).casefold().replace('’', "'")


def _identity(turn):
    return turn['speaker_name'], turn.get('speaker_id')


def _overlapping_turns(turns):
    # Intervals starting before this turn ends, less intervals already ended at
    # its start, gives the overlap count. Compare the total and same-speaker counts.
    positive = [(index, turn) for index, turn in enumerate(turns) if turn['start'] < turn['end']]
    starts = [turn['start'] for _, turn in positive]
    ends = sorted(turn['end'] for _, turn in positive)
    by_identity = defaultdict(lambda: ([], []))
    for _, turn in positive:
        own_starts, own_ends = by_identity[_identity(turn)]
        own_starts.append(turn['start'])
        own_ends.append(turn['end'])
    for _, own_ends in by_identity.values():
        own_ends.sort()

    points = [(index, turn) for index, turn in enumerate(turns) if turn['start'] == turn['end']]
    point_times = [turn['start'] for _, turn in points]
    own_points = defaultdict(list)
    for _, turn in points:
        own_points[_identity(turn)].append(turn['start'])

    conflicts = set()
    for index, turn in positive:
        start, end = turn['start'], turn['end']
        own_starts, own_ends = by_identity[_identity(turn)]
        if bisect_left(starts, end) - bisect_right(ends, start) > (
                bisect_left(own_starts, end) - bisect_right(own_ends, start)):
            conflicts.add(index)
        same_points = own_points[_identity(turn)]
        if bisect_right(point_times, end) - bisect_left(point_times, start) > (
                bisect_right(same_points, end) - bisect_left(same_points, start)):
            conflicts.add(index)
    for index, turn in points:
        point = turn['start']
        own_starts, own_ends = by_identity[_identity(turn)]
        same_points = own_points[_identity(turn)]
        # A single native observation has no duration. Include its boundaries
        # and coincident points rather than claiming simultaneous speakers.
        if (bisect_right(starts, point) - bisect_left(ends, point) >
                bisect_right(own_starts, point) - bisect_left(own_ends, point)
                or bisect_right(point_times, point) - bisect_left(point_times, point) >
                bisect_right(same_points, point) - bisect_left(same_points, point)):
            conflicts.add(index)
    return conflicts


def _index_anchors(groups):
    """Index every point in each token sequence once, discarding repeated anchors."""
    anchors = {}
    for group, words in enumerate(groups):
        keys = [_word_key(word.group()) for word in words]
        for start in range(len(keys) - ANCHOR_WORDS + 1):
            key = tuple(keys[start:start + ANCHOR_WORDS])
            anchors[key] = None if key in anchors else (group, start)
    return anchors


def _discard_reordered_matches(matches, conflict):
    # Word positions that reverse caption order provide no reliable attribution.
    # Check both directions to discard both ends of every inversion.
    last = (-1, -1)
    reordered = []
    for group, positions in enumerate(matches):
        for index, position in enumerate(positions):
            if position is not None and position != conflict:
                if position < last:
                    reordered.append((group, index))
                last = max(last, position)
    following = None
    for group in range(len(matches) - 1, -1, -1):
        positions = matches[group]
        for index in range(len(positions) - 1, -1, -1):
            position = positions[index]
            if position is not None and position != conflict:
                if following is not None and position > following:
                    reordered.append((group, index))
                following = position if following is None else min(following, position)
    for group, index in reordered:
        matches[group][index] = None


def _split_segment(segment, words, labels, turns):
    start, end, text = segment['start'], segment['end'], segment['text']
    last_word = last_char = 0
    last_time = start
    for label, group in groupby(labels):
        count = sum(1 for _ in group)
        next_word = last_word + count
        next_char = words[next_word].start() if next_word < len(words) else len(text)
        next_time = end if next_word == len(words) else start + (end - start) * next_word / len(words)
        part = {**segment, 'start': last_time, 'end': next_time, 'text': text[last_char:next_char]}
        if label is not None:
            caption = turns[label]
            part.update(speaker_name=caption['speaker_name'], speaker_source=caption['source'],
                        speaker_match='caption_text_match')
            if 'speaker_id' in caption:
                part['speaker_id'] = caption['speaker_id']
        yield part
        last_word, last_char, last_time = next_word, next_char, next_time


def align_speakers(segments, caption_artifact):
    """Split ASR chunks at exact caption matches while retaining the plain transcript."""
    result = {'schema_version': 2, 'model': 'OpenAI', 'speaker_attribution': 'unavailable',
              'speaker_timing': 'approximate', 'speaker_coverage': 0.0, 'segments': segments,
              'text': '\n'.join(segment['text'] for segment in segments)}
    if (not caption_artifact or caption_artifact['status'] == 'unavailable'
            or not caption_artifact['turns'] or len(result['text']) > MAX_TRANSCRIPT_CHARS):
        return result

    turns = caption_artifact['turns']
    overlaps = _overlapping_turns(turns)
    asr_words = [list(WORD.finditer(segment['text'])) for segment in segments]
    asr_anchors = _index_anchors(asr_words)
    caption_anchors = _index_anchors(WORD.finditer(turn['text']) for turn in turns)
    matches = [[None] * len(words) for words in asr_words]
    conflict = (-1, -1)
    candidates = []
    for anchor, caption in caption_anchors.items():
        asr = asr_anchors.get(anchor)
        if asr is None or caption is None or caption[0] in overlaps:
            continue
        group, start = asr
        turn_index, caption_start = caption
        segment, turn = segments[group], turns[turn_index]
        if (turn['end'] < segment['start'] - CAPTION_TOLERANCE
                or turn['start'] > segment['end'] + CAPTION_TOLERANCE):
            continue
        candidates.append((group, start, turn_index, caption_start))
        for offset in range(ANCHOR_WORDS):
            position = (turn_index, caption_start + offset)
            existing = matches[group][start + offset]
            matches[group][start + offset] = position if existing in (None, position) else conflict

    _discard_reordered_matches(matches, conflict)
    labels = [[None] * len(words) for words in asr_words]
    for group, start, turn_index, caption_start in candidates:
        if all(matches[group][start + offset] == (turn_index, caption_start + offset)
               for offset in range(ANCHOR_WORDS)):
            labels[group][start:start + ANCHOR_WORDS] = [turn_index] * ANCHOR_WORDS

    parts = []
    named = 0
    for segment, words, word_labels in zip(segments, asr_words, labels):
        attributed = sum(label is not None for label in word_labels)
        if attributed:
            parts.extend(_split_segment(segment, words, word_labels, turns))
            named += attributed
        else:
            parts.append(segment)
        if len(parts) > MAX_SEGMENTS:
            return result

    if named:
        coverage = named / sum(map(len, asr_words))
        result.update(segments=parts, speaker_coverage=coverage,
                      speaker_attribution='platform_captions' if coverage == 1 and caption_artifact['status'] == 'captured'
                      else 'partial')
    return result


def transcript_text(segments):
    """Render speaker labels when available, preserving the legacy unnamed text."""
    first = segments[0] if segments else {}
    status, coverage = first.get('speaker_attribution'), first.get('speaker_coverage')
    if (status not in ('unavailable', 'partial', 'platform_captions')
            or type(coverage) not in (int, float) or not math.isfinite(coverage) or not 0 <= coverage <= 1):
        status = None
    if not status and not any(segment.get('speaker_name') for segment in segments):
        return '\n'.join(segment['text'] for segment in segments)
    body = '\n'.join(f"{segment.get('speaker_name') if status != 'unavailable' and segment.get('speaker_name') else 'Speaker unknown'}: {segment['text'].strip()}"
                     for segment in segments)
    if not status:
        return body
    notice = ('Speaker identification unavailable for this recording.' if status == 'unavailable' else
              ('Speaker identification is partial.' if status == 'partial' else 'Speaker identification uses platform captions.')
              + ' Names are platform display labels. Timings are approximate.')
    return notice + '\n\n' + body

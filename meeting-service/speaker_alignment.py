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


CAPTION_LED_MIN_WORDS = 40
CAPTION_LED_RATIO = 0.8
CAPTION_TURN_GAP = 20
CAPTION_PART_CHARS = 4_000


CAPTION_REPEAT_WINDOW = 600
CAPTION_OVERLAP_WORDS = 6


def _words(text):
    return [word.casefold() for word in WORD.findall(text)]


def _contains(longer, shorter):
    if len(shorter) > len(longer):
        return False
    return any(longer[index:index + len(shorter)] == shorter for index in range(len(longer) - len(shorter) + 1))


CAPTION_REPEAT_WORDS = 10


def _without_repeats(turn, words, said):
    """Remove every stretch of the row covered by a CAPTION_REPEAT_WORDS window already said."""
    if len(words) < CAPTION_REPEAT_WORDS or not said:
        return turn, words
    covered = [False] * len(words)
    for i in range(len(words) - CAPTION_REPEAT_WORDS + 1):
        if tuple(words[i:i + CAPTION_REPEAT_WORDS]) in said:
            covered[i:i + CAPTION_REPEAT_WORDS] = [True] * CAPTION_REPEAT_WORDS
    if not any(covered):
        return turn, words
    matches = list(WORD.finditer(turn['text']))
    pieces, index = [], 0
    while index < len(words):
        if covered[index]:
            index += 1
            continue
        end = index
        while end < len(words) and not covered[end]:
            end += 1
        start_char = matches[index].start() if index else 0
        end_char = matches[end].start() if end < len(words) else len(turn['text'])
        pieces.append(turn['text'][start_char:end_char].strip())
        index = end
    text = ' '.join(piece for piece in pieces if piece)
    return {**turn, 'text': text}, [word for word, gone in zip(words, covered) if not gone]


def _unique_caption_rows(turns):
    """Meet keeps re-showing a caption line while it grows and after it scrolls, so the
    same words arrive several times. Keep each passage once, in its fullest form."""
    kept, heard = [], []
    for turn in sorted(turns, key=lambda turn: (turn['start'], turn['end'])):
        words = _words(turn['text'])
        if not words:
            continue
        # Compare with every row as originally shown, not as trimmed, so a later
        # copy of a row that was itself trimmed is still recognised.
        recent = [(start, raw) for start, speaker, raw in heard
                  if speaker == turn['speaker_name'] and turn['start'] - start <= CAPTION_REPEAT_WINDOW]
        heard.append((turn['start'], turn['speaker_name'], words))
        if any(_contains(raw, words) for _, raw in recent):
            continue
        duplicate = False
        for earlier in reversed(kept):
            if turn['start'] - earlier['row']['start'] > CAPTION_REPEAT_WINDOW:
                break
            if earlier['row']['speaker_name'] != turn['speaker_name']:
                continue
            if _contains(earlier['words'], words):
                # Already said: a repeat or an earlier, shorter view of the same line.
                # A late re-display says nothing about when the words were spoken.
                duplicate = True
                break
            if _contains(words, earlier['words']) or words[:CAPTION_OVERLAP_WORDS * 2] == earlier['words'][:CAPTION_OVERLAP_WORDS * 2]:
                # The same line, grown longer: keep the fuller text where it first appeared.
                grew_live = turn['start'] - earlier['row']['end'] <= CAPTION_TURN_GAP
                earlier['row'] = {**earlier['row'], 'text': turn['text'],
                                  'end': max(earlier['row']['end'], turn['end']) if grew_live else earlier['row']['end']}
                earlier['words'] = words
                duplicate = True
                break
        if duplicate:
            continue
        # Meet also re-shows parts of a long line inside later rows. Drop any run of
        # CAPTION_REPEAT_WORDS or more words this speaker already said recently.
        said = {tuple(raw[i:i + CAPTION_REPEAT_WORDS]) for _, raw in recent for i in range(len(raw) - CAPTION_REPEAT_WORDS + 1)}
        turn, words = _without_repeats(turn, words, said)
        if not words:
            continue
        kept.append({'row': turn, 'words': words})
    return [entry['row'] for entry in kept]


def _caption_led_parts(turns):
    """One part per run of caption rows from the same speaker, in spoken order.

    The platform shows a display name on every caption row, so each part carries
    the name the meeting itself showed for those words. Nothing is inferred.
    """
    parts = []
    for turn in _unique_caption_rows(turns):
        text = ' '.join(turn['text'].split())
        if not text:
            continue
        last = parts[-1] if parts else None
        if (last and last['speaker_name'] == turn['speaker_name'] and last.get('speaker_id') == turn.get('speaker_id')
                and turn['start'] - last['end'] <= CAPTION_TURN_GAP
                and len(last['text']) + len(text) < CAPTION_PART_CHARS):
            last['text'] += ' ' + text
            last['end'] = max(last['end'], turn['end'])
            continue
        # Caption rows keep being revised after the next speaker starts, so a
        # row's end can pass the next start. Parts must not overlap.
        start = max(turn['start'], last['end']) if last else turn['start']
        part = {'start': start, 'end': max(start, turn['end']), 'text': text,
                'speaker_name': turn['speaker_name'], 'speaker_source': turn['source'],
                'speaker_match': 'caption_text_match'}
        if 'speaker_id' in turn:
            part['speaker_id'] = turn['speaker_id']
        parts.append(part)
    return parts


def _caption_led(result, caption_artifact, asr_word_count):
    """Use the platform's own captions as the transcript when they are the fuller record.

    Chunked ASR has no word timings, so names can only be attached where its
    wording happens to match the captions exactly. When the captions hold at
    least as much of the conversation, they are the transcript, each line
    already attributed by the platform.
    """
    turns = caption_artifact['turns']
    # Compare like with like: repeated caption rows would make the captions look fuller than they are.
    caption_words = sum(len(WORD.findall(turn['text'])) for turn in _unique_caption_rows(turns))
    # A caption row is a sentence or two. Anything far longer is not caption evidence.
    if (caption_words < max(CAPTION_LED_MIN_WORDS, CAPTION_LED_RATIO * asr_word_count)
            or any(len(turn['text']) > CAPTION_PART_CHARS for turn in turns)):
        return None
    parts = _caption_led_parts(turns)
    text = '\n'.join(part['text'] for part in parts)
    if not parts or len(parts) > MAX_SEGMENTS or len(text) > MAX_TRANSCRIPT_CHARS:
        return None
    return {**result, 'segments': parts, 'text': text, 'speaker_coverage': 1.0,
            'speaker_attribution': 'platform_captions' if caption_artifact['status'] == 'captured' else 'partial'}


def align_speakers(segments, caption_artifact):
    """Attribute the transcript from platform captions.

    Captions that hold the fuller record become the transcript. Otherwise ASR
    chunks are split at exact caption matches and the plain transcript is kept.
    """
    result = {'schema_version': 2, 'model': 'OpenAI', 'speaker_attribution': 'unavailable',
              'speaker_timing': 'approximate', 'speaker_coverage': 0.0, 'segments': segments,
              'text': '\n'.join(segment['text'] for segment in segments)}
    if (not caption_artifact or caption_artifact['status'] == 'unavailable'
            or not caption_artifact['turns'] or len(result['text']) > MAX_TRANSCRIPT_CHARS):
        return result
    led = _caption_led(result, caption_artifact, sum(len(WORD.findall(segment['text'])) for segment in segments))
    if led:
        return led

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

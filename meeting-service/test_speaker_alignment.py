import uuid

import pytest

from speaker_alignment import align_speakers, transcript_text, validate_caption_artifact


EXECUTION_ID = str(uuid.uuid4())


def caption(start, end, text, name, **fields):
    return {'start': start, 'end': end, 'text': text, 'speaker_name': name,
            'source': 'google_meet_caption', **fields}


def artifact(*turns, status='captured'):
    return {'schema_version': 1, 'execution_id': EXECUTION_ID, 'provider': 'meet',
            'status': status, 'turns': list(turns)}


def align(text, *turns, status='captured', duration=300):
    evidence = validate_caption_artifact(artifact(*turns, status=status), EXECUTION_ID, 'meet', duration)
    return align_speakers([{'start': 0, 'end': duration, 'text': text}], evidence)


def test_alternating_speakers_split_coarse_asr_and_preserve_exact_text():
    text = '  We’ll ship on Tuesday.\n\nThat works for me!  I can send the summary.\n'
    result = align(text, caption(1, 4, "we'll ship on tuesday", 'Ava', speaker_id='platform-id'),
                   caption(4, 7, 'that works for me', 'Ben'),
                   caption(7, 8, 'I can send the summary', 'Ava', speaker_id='platform-id'))
    parts = result['segments']
    assert [part['speaker_name'] for part in parts] == ['Ava', 'Ben', 'Ava']
    assert [part.get('speaker_id') for part in parts] == ['platform-id', None, 'platform-id']
    assert {part['speaker_source'] for part in parts} == {'google_meet_caption'}
    assert {part['speaker_match'] for part in parts} == {'caption_text_match'}
    assert result['speaker_timing'] == 'approximate'
    assert result['speaker_attribution'] == 'platform_captions'
    assert result['speaker_coverage'] == 1.0
    assert result['schema_version'] == 2
    assert result['text'] == text == ''.join(part['text'] for part in parts)
    assert parts[0]['start'] == 0 and parts[-1]['end'] == 300
    assert parts[0]['end'] == parts[1]['start'] < parts[1]['end'] == parts[2]['start']
    assert transcript_text(parts) == 'Ava: We’ll ship on Tuesday.\nBen: That works for me!\nAva: I can send the summary.'


def test_repeated_phrase_does_not_inherit_a_speaker_in_either_transcript():
    text = 'Could you repeat that? Could you repeat that? The delivery is confirmed.'
    repeated_asr = align(text, caption(1, 3, 'Could you repeat that', 'Ava'),
                         caption(8, 9, 'The delivery is confirmed', 'Ben'))
    assert [part.get('speaker_name') for part in repeated_asr['segments']] == [None, 'Ben']
    repeated_caption = align('Could you repeat that?', caption(1, 3, 'Could you repeat that', 'Ava'),
                             caption(8, 9, 'Could you repeat that', 'Ben'))
    assert repeated_caption['speaker_attribution'] == 'unavailable'


def test_cross_speaker_overlap_withholds_attribution_even_for_unique_phrases():
    text = 'Schedule the next meeting. Choose the earlier date. Share the calendar invitation.'
    result = align(text, caption(1, 9, 'Schedule the next meeting', 'Ava'),
                   caption(3, 7, 'Choose the earlier date', 'Ben'),
                   caption(9, 13, 'Share the calendar invitation', 'Ava'))
    assert [part.get('speaker_name') for part in result['segments']] == [None, 'Ava']
    assert result['speaker_coverage'] == pytest.approx(1 / 3)


def test_conflicting_word_and_reordered_anchors_do_not_label_fragments():
    conflict = align('Alpha beta gamma delta epsilon.', caption(1, 2, 'Alpha beta gamma', 'Ava'),
                     caption(2, 3, 'Gamma delta epsilon', 'Ben'))
    reordered = align('The revised budget passed. We will check again.',
                      caption(1, 2, 'We will check again', 'Ava'),
                      caption(2, 3, 'The revised budget passed', 'Ben'))
    assert conflict['speaker_attribution'] == reordered['speaker_attribution'] == 'unavailable'


def test_mismatch_stays_unknown_and_preserves_spaces_and_punctuation():
    text = 'Open the report,  tomorow.\tClose the tab. '
    result = align(text, caption(1, 8, 'Open the report tomorrow. Close the tab.', 'Ava'))
    assert [part.get('speaker_name') for part in result['segments']] == ['Ava', None, 'Ava']
    assert result['segments'][1]['text'] == 'tomorow.\t'
    assert ''.join(part['text'] for part in result['segments']) == text
    assert transcript_text(result['segments']) == 'Ava: Open the report,\nSpeaker unknown: tomorow.\nAva: Close the tab.'
    assert result['speaker_attribution'] == 'partial'
    assert result['speaker_coverage'] == pytest.approx(6 / 7)


@pytest.mark.parametrize('first, second', [( (1, 5), (3, 3)), ((3, 3), (3, 3)),
                                          ((1, 3), (3, 3)), ((3, 3), (3, 6))])
def test_conflicting_point_captions_withhold_both_speakers(first, second):
    result = align('Send the report. Review the build.',
                   caption(*first, 'Send the report', 'Ava'),
                   caption(*second, 'Review the build', 'Ben'))
    assert result['speaker_attribution'] == 'unavailable'
    assert not any(part.get('speaker_name') for part in result['segments'])
    assert result['text'] == 'Send the report. Review the build.'


def test_capture_buffer_point_observation_stays_unknown_when_conflicting():
    import json
    from pathlib import Path
    import subprocess
    import sys
    capture = subprocess.check_output([sys.executable, '-c', '''
import json
from captions import CaptionBuffer
buffer = CaptionBuffer('meet')
buffer.ingest({'rows': [
 {'id': 1, 'start': 1, 'end': 5, 'name': 'Ava', 'text': 'Send the report'},
 {'id': 2, 'start': 3, 'end': 3, 'name': 'Ben', 'text': 'Review the build'}]}, 1, 10)
print(json.dumps(buffer.document('618e8480-0ba5-49f4-a949-941a69fb6b98', 'meet', 10)))
'''], cwd=Path(__file__).resolve().parents[1] / 'meeting-bot', text=True)
    evidence = validate_caption_artifact(json.loads(capture), '618e8480-0ba5-49f4-a949-941a69fb6b98', 'meet', 10)
    result = align_speakers([{'start': 0, 'end': 10, 'text': 'Send the report. Review the build.'}], evidence)
    assert result['speaker_attribution'] == 'unavailable'
    assert result['speaker_coverage'] == 0


def test_isolated_and_same_speaker_points_remain_usable():
    result = align('Send the report. Review the build.',
                   caption(1, 5, 'Send the report', 'Ava'),
                   caption(3, 3, 'Review the build', 'Ava'))
    assert result['speaker_coverage'] == 1
    assert {part.get('speaker_name') for part in result['segments']} == {'Ava'}


def test_original_segments_and_timestamps_survive_across_chunks():
    segments = [{'start': 0, 'end': 300, 'text': 'We shipped the fix. Maybe another.'},
                {'start': 300, 'end': 347, 'text': 'Let us write documentation.\n'}]
    value = artifact(caption(12, 19, 'We shipped the fix', 'Ava'),
                     caption(308, 312, 'Let us write documentation', 'Ben'), status='partial')
    result = align_speakers(segments, validate_caption_artifact(value, EXECUTION_ID, 'meet', 347))
    assert result['speaker_attribution'] == 'partial'
    assert [part.get('speaker_name') for part in result['segments']] == ['Ava', None, 'Ben']
    assert ''.join(part['text'] for part in result['segments'][:2]) == segments[0]['text']
    assert result['segments'][2]['text'] == segments[1]['text']
    assert result['segments'][1]['end'] == result['segments'][2]['start'] == 300
    assert result['segments'][2]['end'] == 347
    assert result['text'] == '\n'.join(segment['text'] for segment in segments)


def test_caption_observed_outside_coarse_asr_time_window_stays_unknown():
    segments = [{'start': 0, 'end': 20, 'text': 'We will review the delivery.'}]
    evidence = validate_caption_artifact(artifact(caption(60, 65, 'We will review the delivery', 'Ava')),
                                         EXECUTION_ID, 'meet', 90)
    assert align_speakers(segments, evidence)['speaker_attribution'] == 'unavailable'


def test_teams_source_is_retained_and_unrecognized_artifact_fields_are_removed():
    text = 'I can review this document.'
    turn = {**caption(1, 4, text, 'Nía'), 'source': 'teams_caption', 'email': 'discard@example.com'}
    value = {**artifact(turn), 'provider': 'teams', 'extra': 'discard'}
    evidence = validate_caption_artifact(value, EXECUTION_ID, 'teams', 60)
    assert 'extra' not in evidence and 'email' not in evidence['turns'][0]
    result = align_speakers([{'start': 0, 'end': 60, 'text': text}], evidence)
    assert result['segments'][0]['speaker_source'] == 'teams_caption'


def test_repeated_speech_near_input_limit_stays_unattributed():
    repeated = 'one two three four ' * 10_000
    result = align(repeated, caption(1, 30, repeated, 'Ava'))
    assert result['speaker_attribution'] == 'unavailable'
    assert result['segments'] == [{'start': 0, 'end': 300, 'text': repeated}]


def test_excessive_alignment_fragments_fall_back_to_plain_asr(monkeypatch):
    monkeypatch.setattr('speaker_alignment.MAX_SEGMENTS', 2)
    text = 'Schedule the next meeting. Choose the earlier date. Share the calendar invitation.'
    result = align(text, caption(1, 3, 'Schedule the next meeting', 'Ava'),
                   caption(3, 7, 'Choose the earlier date', 'Ben'),
                   caption(7, 13, 'Share the calendar invitation', 'Ava'))
    assert result['speaker_attribution'] == 'unavailable'
    assert result['segments'] == [{'start': 0, 'end': 300, 'text': text}]


@pytest.mark.parametrize('field, value', [
    ('start', float('nan')), ('start', -1), ('start', True), ('start', 5),
    ('end', float('inf')), ('end', 331), ('end', 10 ** 600), ('end', '2'),
    ('speaker_name', 'Ava\nBen:'), ('speaker_name', '<script>'),
    ('speaker_name', 'Ava\u202e'), ('speaker_name', 'Ava\u2028Ben'),
    ('speaker_name', 'You'), ('speaker_name', '(You)'), ('speaker_name', 'Speaker 1'),
    ('speaker_name', 'Unknown speaker'), ('speaker_name', 'A' * 121),
    ('speaker_id', 'A' * 201), ('source', 'teams_caption'), ('text', 'a' * 250_001),
])
def test_rejects_invalid_turn_fields(field, value):
    turn = caption(1, 4, 'One two three', 'Ava')
    turn[field] = value
    with pytest.raises(ValueError):
        validate_caption_artifact(artifact(turn), EXECUTION_ID, 'meet', 300)


def test_rejects_invalid_metadata_and_out_of_order_turns():
    first, second = caption(4, 5, 'One two three', 'Ava'), caption(1, 2, 'Four five six', 'Ben')
    for value in [artifact(first, second), artifact(first, status='unavailable'),
                  {**artifact(first), 'schema_version': True},
                  {**artifact(first), 'execution_id': str(uuid.uuid4())},
                  {**artifact(first), 'provider': 'teams'},
                  artifact(*([first] * 10_001))]:
        with pytest.raises(ValueError):
            validate_caption_artifact(value, EXECUTION_ID, 'meet', 300)


def test_unavailable_transcript_preserves_legacy_text_and_segments():
    segments = [{'start': 0, 'end': 20, 'text': '  First line.\n'},
                {'start': 30, 'end': 40, 'text': ' Next line. '}]
    evidence = validate_caption_artifact(artifact(status='unavailable'), EXECUTION_ID, 'meet', 40)
    for sidecar in [None, evidence]:
        result = align_speakers(segments, sidecar)
        assert result['speaker_attribution'] == 'unavailable'
        assert result['speaker_coverage'] == 0.0
        assert result['segments'] == segments
        assert result['text'] == transcript_text(segments) == '  First line.\n\n Next line. '

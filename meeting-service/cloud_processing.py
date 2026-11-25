"""Bounded, retryable processing of captured cloud media."""
import re
import io
import json
import os
import struct
import subprocess
import tempfile
from pathlib import Path
import time
import wave

from google.api_core.exceptions import NotFound, PreconditionFailed

from reel_organization import public_account_access

CHUNK_SECONDS = 300
LEASE_SECONDS = 660


def caption_context(bucket, record, duration):
    """Read only the generation bound by the authenticated worker callback."""
    from speaker_alignment import validate_caption_artifact
    generation = record.get('captions_generation')
    if isinstance(generation, bool) or not isinstance(generation, int) or generation <= 0:
        return None
    try:
        blob = bucket.blob(record['output_prefix'] + 'captions.json')
        blob.reload(timeout=15)
        if int(blob.generation) != generation or not 0 < int(blob.size) <= 2 * 1024 * 1024:
            return None
        value = json.loads(blob.download_as_bytes(if_generation_match=generation, timeout=20))
        return validate_caption_artifact(value, record['execution_id'], record.get('provider'), duration)
    except Exception:
        # Missing, invalid or unavailable captions do not discard the recording.
        return None


def owner_display_name(email, names):
    """The meeting owner's name, used for a task nobody else clearly took."""
    if not isinstance(email, str) or '@' not in email:
        return ''
    named = (names or {}).get(email) if isinstance(names, dict) else None
    if isinstance(named, str) and named.strip():
        return named.strip()
    return ' '.join(part.capitalize() for part in re.split(r'[._+\-]+', email.split('@', 1)[0]) if part)


def speaker_name_hints(attendees, attendee_names, segments):
    """Add the names people showed on the call to invited emails they unambiguously belong to.

    A display label is linked only when its first name equals the first name in
    exactly one invited email and no other label claims that email.
    """
    names = dict(attendee_names) if isinstance(attendee_names, dict) else {}
    emails = [email for email in attendees if isinstance(email, str) and '@' in email]
    first = lambda value: re.split(r'[\s._+\-]+', value.strip().casefold())[0] if value and value.strip() else ''
    labels = {part.get('speaker_name') for part in segments if isinstance(part.get('speaker_name'), str)}
    claims = {}
    for label in labels:
        if not label.strip() or len(label) > 80 or re.search(r'[\x00-\x1f\x7f-\x9f<>\u2028\u2029]', label):
            continue
        owners = [email for email in emails if first(email.split('@', 1)[0]) == first(label)]
        if len(owners) == 1:
            claims.setdefault(owners[0], []).append(label.strip())
    for email, claimed in claims.items():
        if len(claimed) == 1 and not names.get(email):
            names[email] = claimed[0]
    return names


def caption_led(transcript):
    """True when every transcript part is a named caption turn rather than split ASR text."""
    parts = transcript.get('segments') or []
    return (transcript.get('speaker_coverage') == 1.0 and bool(parts)
            and transcript.get('text') == '\n'.join(part.get('text', '') for part in parts)
            and all(part.get('speaker_match') == 'caption_text_match' for part in parts))


def attributed_transcript(segments, captions):
    from speaker_alignment import align_speakers
    transcript = align_speakers(segments, captions)
    if transcript['segments']:
        transcript['segments'] = list(transcript['segments'])
        transcript['segments'][0] = {**transcript['segments'][0],
            'speaker_attribution': transcript['speaker_attribution'], 'speaker_coverage': transcript['speaker_coverage']}
    return transcript


def audio_layout(blob, generation):
    blob.reload(timeout=30)
    if int(blob.generation) != generation:
        raise ValueError('Recording audio changed')
    header = blob.download_as_bytes(start=0, end=min(int(blob.size), 65536) - 1,
                                    if_generation_match=generation, timeout=30)
    if len(header) < 12 or header[:4] != b'RIFF' or header[8:12] != b'WAVE':
        raise ValueError('Invalid recording audio')
    pos, fmt = 12, None
    while pos + 8 <= len(header):
        kind, size = struct.unpack_from('<4sI', header, pos)
        start = pos + 8
        if kind == b'fmt ':
            if size < 16 or start + 16 > len(header):
                raise ValueError('Invalid recording audio')
            fmt = struct.unpack_from('<HHIIHH', header, start)
        if kind == b'data':
            if fmt != (1, 1, 16000, 32000, 2, 16) or not size or size % 2 or size > 10980 * 32000 or start + size > int(blob.size):
                raise ValueError('Invalid recording audio')
            return start, size
        pos = start + size + (size % 2)
    raise ValueError('Recording audio header is unavailable')


def chunk_wav(blob, generation, offset, size, index):
    start = index * CHUNK_SECONDS * 32000
    length = min(CHUNK_SECONDS * 32000, size - start)
    if length <= 0:
        return None
    pcm = blob.download_as_bytes(start=offset + start, end=offset + start + length - 1,
                                 if_generation_match=generation, timeout=60)
    if len(pcm) != length:
        raise ValueError('Recording audio is incomplete')
    out = io.BytesIO()
    with wave.open(out, 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(pcm)
    return out.getvalue()


def immutable_json(bucket, name, create):
    blob = bucket.blob(name)
    try:
        blob.reload(timeout=30)
    except Exception as exc:
        from google.api_core.exceptions import NotFound
        if not isinstance(exc, NotFound):
            raise
        value = create()
        try:
            blob.upload_from_string(json.dumps(value, ensure_ascii=False, separators=(',', ':')),
                                    content_type='application/json', if_generation_match=0, timeout=30)
        except PreconditionFailed:
            pass
        blob.reload(timeout=30)
    return json.loads(blob.download_as_bytes(if_generation_match=int(blob.generation), timeout=30))


RECOVERY_AUDIO = 'processing/recovered-audio.wav'
MAX_RECOVERY_VIDEO = 128 * 1024 * 1024
MAX_VIDEO_AUDIO_SECONDS = 3600


def recover_audio(bucket, record):
    prefix = record['output_prefix']
    artifacts = record.get('artifacts', {})
    if artifacts.get('system-audio.wav'):
        source = bucket.blob(prefix + 'system-audio.wav')
        try:
            source.reload(timeout=30)
            generation = int(source.generation)
            audio_layout(source, generation)
            return 'system-audio.wav', generation
        except (NotFound, ValueError, PreconditionFailed):
            pass
    if not artifacts.get('recording.mp4'):
        return None

    recovered = bucket.blob(prefix + RECOVERY_AUDIO)
    try:
        recovered.reload(timeout=30)
    except NotFound:
        video = bucket.blob(prefix + 'recording.mp4')
        try:
            video.reload(timeout=30)
            if not 0 < int(video.size) <= MAX_RECOVERY_VIDEO:
                return None
            with tempfile.TemporaryDirectory(prefix='reel-recovery-') as folder:
                source, output = Path(folder) / 'source.mp4', Path(folder) / 'audio.wav'
                video.download_to_filename(str(source), if_generation_match=int(video.generation), timeout=90)
                subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-protocol_whitelist', 'file',
                                '-f', 'mov', '-i', str(source), '-map', '0:a:0', '-vn',
                                '-t', str(MAX_VIDEO_AUDIO_SECONDS + 1),
                                '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', str(output)],
                               check=True, timeout=150, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                source.unlink()
                # The Cloud Run scratch filesystem uses memory. Bound extraction,
                # and reject over-limit results instead of silently trimming them.
                with wave.open(str(output), 'rb') as wav:
                    if not 0 < wav.getnframes() <= MAX_VIDEO_AUDIO_SECONDS * 16000:
                        return None
                try:
                    recovered.upload_from_filename(str(output), content_type='audio/wav',
                                                   if_generation_match=0, timeout=120)
                except PreconditionFailed:
                    pass
        except (NotFound, subprocess.CalledProcessError, wave.Error, EOFError):
            return None
        recovered.reload(timeout=30)
    generation = int(recovered.generation)
    try:
        audio_layout(recovered, generation)
    except ValueError:
        return None
    return RECOVERY_AUDIO, generation


def process_step(store, execution, scheduler, *, clock=time.time):
    """Run one bounded stage. All identities and paths come from saved state."""
    from google.cloud import storage
    from speech import attendee_keywords, transcribe_audio, summarize_text
    from canonical_delivery.app import CalendarSelectionRequired, GCSStateStore, calendar_service, configured_slack_recaps, deliver, selected_calendar_ids
    from canonical_delivery.providers import configured_providers

    started = clock()
    key = 'executions/' + execution
    record, generation = store.load(key)
    from calendar_runtime import PROCESSING_TERMINAL_STATES, digest, processing_allowed
    if not processing_allowed(record) or record.get('execution_id') != execution:
        raise ValueError('Execution is unavailable for processing')
    recovery = record.get('status') == 'failed'
    owner, owner_id, event_id = record.get('owner_email'), record.get('owner_id'), record.get('event_id')
    if not isinstance(owner, str) or not owner or not isinstance(owner_id, str) or not owner_id or not event_id:
        raise ValueError('Execution owner is unavailable')
    is_slack_retry = record.get('processing_status') == 'delivered' and record.get('slack_retry_pending') is True
    expected_prefix = 'reel-meetings/bot/' + digest(owner_id) + '/' + execution + '/'
    if (record.get('output_bucket') != os.environ.get('BOT_BUCKET') or record.get('output_prefix') != expected_prefix
            or (not recovery and (type(record.get('audio_generation')) is not int or record['audio_generation'] <= 0))):
        raise ValueError('Execution artifact is invalid')
    state, _ = store.load('calendar/' + digest(owner))
    identity = (state or {}).get('identity') or (state or {}).get('config') or {}
    event = (state or {}).get('events', {}).get(event_id)
    manual = bool(event and event.get('calendar_id') == 'browser'
                  and 'provider_event_id' not in event and 'occurrence_start' not in event)
    occurrence = event.get('start') if manual else (event or {}).get('occurrence_start')
    if (identity.get('owner_uid') != owner_id or identity.get('owner_email') != owner or not event
            or event.get('execution_id') != execution or occurrence != record.get('started_at')):
        if is_slack_retry:
            record.update(slack_retry_pending=False, slack_retry_status='unresolved', processing_enqueue_needed=False)
            store.cas(key, record, generation)
            return 'delivered'
        raise ValueError('Execution owner or occurrence changed')
    if record.get('processing_status') in PROCESSING_TERMINAL_STATES and not is_slack_retry:
        return record['processing_status']
    if is_slack_retry and clock() < record.get('slack_retry_not_before', 0):
        return 'delivered'
    if record.get('processing_lease_until', 0) > clock():
        raise RuntimeError('Processing is already in progress')
    attendee_names = record.get('attendee_names', event.get('attendee_names'))
    record['processing_lease_until'] = clock() + LEASE_SECONDS
    store.cas(key, record, generation)
    try:
        bucket = storage.Client().bucket(record['output_bucket'])
        prefix = record['output_prefix']
        audio_name = 'system-audio.wav'
        if recovery:
            audio_name = record.get('recovery_audio_name')
            if audio_name is None:
                selected = recover_audio(bucket, record)
                current, gen = store.load(key)
                if current.get('processing_lease_until') != record['processing_lease_until']:
                    raise RuntimeError('Processing claim expired')
                if selected:
                    current.update(recovery_audio_name=selected[0], audio_generation=selected[1],
                                   processing_lease_until=0, processing_enqueue_needed=True)
                else:
                    current.update(processing_status='audio_unavailable', processing_lease_until=0,
                                   processing_enqueue_needed=False)
                store.cas(key, current, gen)
                if selected:
                    from calendar_runtime import enqueue_processing
                    enqueue_processing(store, execution, scheduler)
                return current['processing_status']
            if audio_name not in {'system-audio.wav', RECOVERY_AUDIO}:
                raise ValueError('Invalid recovery audio')
        audio = bucket.blob(prefix + audio_name)
        audio_generation = int(record['audio_generation'])
        offset, size = audio_layout(audio, audio_generation)
        count = (size + CHUNK_SECONDS * 32000 - 1) // (CHUNK_SECONDS * 32000)
        index = int(record.get('processing_step', 0))
        if index < count:
            previous, segments = '', []
            if index:
                prior = immutable_json(bucket, prefix + f'processing/chunk-{index - 1:04d}.json', lambda: (_ for _ in ()).throw(ValueError('Previous chunk unavailable')))
                previous, segments = prior['context'], prior['segments']
            def transcribe_chunk():
                wav = chunk_wav(audio, audio_generation, offset, size, index)
                # Match desktop: skip only exact digital silence, never quiet speech.
                with wave.open(io.BytesIO(wav), 'rb') as stream:
                    pcm = stream.readframes(stream.getnframes())
                result = (transcribe_audio(wav, 'en', record['title'][:200],
                          attendee_keywords(record['attendees'], attendee_names), previous) if any(pcm) else {'text': ''})
                text = result.get('text')
                if not isinstance(text, str):
                    raise ValueError('Invalid transcript')
                combined = list(segments)
                if text.strip():
                    combined.append({'start': index * CHUNK_SECONDS, 'end': min((index + 1) * CHUNK_SECONDS, size / 32000), 'text': text.strip()})
                return {'text': text, 'segments': combined, 'context': (text.strip() or previous)[-1000:]}
            result = immutable_json(bucket, prefix + f'processing/chunk-{index:04d}.json', transcribe_chunk)
            if not isinstance(result.get('text'), str) or not isinstance(result.get('segments'), list):
                raise ValueError('Invalid transcript')
            state_name = 'processing'
        else:
            result = immutable_json(bucket, prefix + f'processing/chunk-{count - 1:04d}.json', lambda: (_ for _ in ()).throw(ValueError('Transcript chunk unavailable')))
            segments = result.get('segments')
            if not isinstance(segments, list):
                raise ValueError('Invalid transcript')
            if not segments:
                state_name = 'no_speech'
            elif index == count:
                from speaker_alignment import transcript_text
                transcript = immutable_json(bucket, prefix + 'transcript.json', lambda: attributed_transcript(
                    segments, caption_context(bucket, record, size / 32000)))
                text = transcript_text(transcript['segments'])
                if recovery:
                    text = 'Partial meeting transcript\n\n' + text
                text_blob = bucket.blob(prefix + 'transcript.txt')
                try:
                    text_blob.upload_from_string(text, content_type='text/plain', if_generation_match=0, timeout=30)
                except PreconditionFailed:
                    text_blob.reload(timeout=30)
                    existing = text_blob.download_as_bytes(if_generation_match=int(text_blob.generation), timeout=30)
                    if existing != text.encode('utf-8'):
                        raise ValueError('Saved transcript differs')
                record['transcript_available'] = True
                state_name = 'transcript_too_long' if len(transcript['text']) > 200000 else 'processing'
            elif index == count + 1:
                transcript = immutable_json(bucket, prefix + 'transcript.json', lambda: (_ for _ in ()).throw(ValueError('Transcript unavailable')))
                text = '\n'.join(segment['text'] for segment in segments)
                speaker_context = ({'speaker_turns': transcript['segments']}
                    if transcript.get('speaker_attribution') in ('platform_captions', 'partial') else {})
                summary_names = attendee_names
                if caption_led(transcript):
                    # The transcript is the meeting's own named captions: summarise that text,
                    # so every turn the summariser sees carries its speaker.
                    text = transcript['text']
                    summary_names = speaker_name_hints(record['attendees'], attendee_names, transcript['segments'])
                summary = immutable_json(bucket, prefix + 'processing/summary.json', lambda: summarize_text(
                    text, record['title'][:200], record['attendees'], attendee_names=summary_names,
                    default_owner=owner_display_name(owner, summary_names), **speaker_context))
                # Old immutable summaries lack this decision; hold them for review.
                from speech import acknowledgement_only
                record['has_meeting_content'] = (False if acknowledgement_only(text) else
                    summary.get('has_meeting_content') if isinstance(summary.get('has_meeting_content'), bool) else None)
                if record['has_meeting_content'] is True:
                    immutable_json(bucket, prefix + 'summary.json',
                                   lambda: {**summary, 'partial': True} if recovery else summary)
                    record['summary_available'] = True
                    state_name = 'recovered' if recovery else ('private_notes_ready' if public_account_access() else 'processing')
                else:
                    state_name = 'review_required'
            elif recovery:
                raise ValueError('Invalid recovery processing step')
            elif public_account_access():
                raise ValueError('Organization delivery is unavailable')
            else:
                transcript = immutable_json(bucket, prefix + 'transcript.json', lambda: (_ for _ in ()).throw(ValueError('Transcript unavailable')))
                summary = immutable_json(bucket, prefix + 'processing/summary.json', lambda: (_ for _ in ()).throw(ValueError('Summary unavailable')))
                from speech import acknowledgement_only
                if summary.get('has_meeting_content') is not True or acknowledgement_only('\n'.join(segment['text'] for segment in segments)):
                    record['has_meeting_content'] = (False if acknowledgement_only('\n'.join(segment['text'] for segment in segments)) else
                        summary.get('has_meeting_content') if isinstance(summary.get('has_meeting_content'), bool) else None)
                    state_name = 'review_required'
                else:
                    calendar = None if manual else {'legacy_occurrence_id': event_id, 'occurrence_start': record['started_at']}
                    if calendar is not None and event.get('calendar_id'):
                        calendar['calendar_id'] = event['calendar_id']
                    payload = {'id': record['meeting_id'], 'title': record['title'], 'started_at': record['started_at'],
                               'attendees': record['attendees'], 'summary': summary['summary'], 'segments': transcript['segments'],
                               'calendar': calendar}
                    delivery_store = GCSStateStore(os.environ['DELIVERY_RECEIPTS_BUCKET'])
                    try:
                        receipt = deliver(payload, owner, delivery_store,
                                          configured_providers(store=delivery_store), calendar_service, time.time,
                                          deadline=started + 570, slack=configured_slack_recaps(), retry_slack=True, defer_slack=not is_slack_retry,
                                          followup_items=summary.get('action_items'),
                                          calendar_selection=lambda: selected_calendar_ids(store, owner, owner_id),
                                          invited=record.get('attendees') if isinstance(record.get('attendees'), list) else None)
                    except CalendarSelectionRequired:
                        if is_slack_retry:
                            record['slack_pending_result'] = False
                            record['slack_retry_status'] = 'unresolved'
                            state_name = 'delivered'
                        else:
                            state_name = 'calendar_selection_required'
                    except Exception:
                        if not is_slack_retry:
                            raise
                        record['slack_pending_result'] = True
                        state_name = 'delivered'
                    else:
                        record['slack_pending_result'] = bool(receipt.get('slack_retry_pending') and not receipt.get('suppressed_duplicate'))
                        record['notion_url'] = receipt['url']
                        record['notion_status'] = 'delivered'
                        state_name = 'delivered'
        current, gen = store.load(key)
        if current.get('processing_lease_until') != record['processing_lease_until']:
            raise RuntimeError('Processing claim expired')
        pending = bool(record.get('slack_pending_result')) if state_name == 'delivered' else False
        attempts = int(record.get('slack_retry_attempts', 0)) + (1 if is_slack_retry else 0)
        unresolved = record.get('slack_retry_status') == 'unresolved' or (pending and attempts >= 3)
        pending = pending and not unresolved
        next_step = index if state_name == 'calendar_selection_required' or pending else index + 1
        current.update(processing_status=state_name, processing_step=next_step, processing_lease_until=0,
                       processing_enqueue_needed=(state_name == 'processing' or pending))
        if state_name == 'delivered' and ('slack_pending_result' in record or is_slack_retry):
            current.update(slack_retry_pending=pending, slack_retry_attempts=attempts,
                           slack_retry_not_before=clock() + 60 if pending else 0,
                           slack_retry_status='unresolved' if unresolved else 'pending' if pending else 'complete')
        if 'has_meeting_content' in record:
            current['has_meeting_content'] = record['has_meeting_content']
        if record.get('transcript_available'):
            current.setdefault('artifacts', {}).update({'transcript.json': True, 'transcript.txt': True})
        if record.get('summary_available'):
            current.setdefault('artifacts', {})['summary.json'] = True
        if state_name == 'delivered':
            current.update(notion_url=record.get('notion_url', current.get('notion_url')), notion_status='delivered')
        elif state_name in PROCESSING_TERMINAL_STATES and not recovery:
            current['notion_status'] = state_name
        store.cas(key, current, gen)
        if state_name == 'processing' or pending:
            from calendar_runtime import enqueue_processing
            enqueue_processing(store, execution, scheduler)
        return state_name
    except Exception:
        if is_slack_retry:
            current, gen = store.load(key)
            if current and current.get('processing_lease_until') == record['processing_lease_until']:
                attempts = int(current.get('slack_retry_attempts', 0)) + 1
                pending = attempts < 3
                current.update(slack_retry_attempts=attempts, slack_retry_pending=pending,
                               slack_retry_not_before=clock() + 60 if pending else 0,
                               slack_retry_status='pending' if pending else 'unresolved',
                               processing_lease_until=0, processing_enqueue_needed=pending)
                store.cas(key, current, gen)
                if pending:
                    from calendar_runtime import enqueue_processing
                    enqueue_processing(store, execution, scheduler)
                return 'delivered'
        # A crashed process may continue until the Gunicorn deadline. Keep the lease
        # until then so a retry cannot start a competing provider operation.
        raise

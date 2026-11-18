"""Local CPU-only transcription; no meeting content leaves the job for inference."""
import json
import os
from pathlib import Path
import sys
from faster_whisper import WhisperModel


def main(root):
    model = WhisperModel('/opt/whisper-large-v3-turbo', device='cpu', compute_type='int8', cpu_threads=int(os.environ.get('WHISPER_THREADS', '2')), local_files_only=True)
    stream, info = model.transcribe(
        str(root / 'system-audio.wav'), language='en', beam_size=5,
        vad_filter=True, condition_on_previous_text=True,
    )
    segments = []
    for segment in stream:
        text = segment.text.strip()
        if text:
            segments.append({'start': round(segment.start, 3), 'end': round(segment.end, 3), 'text': text})
    transcript = {'schema_version': 1, 'language': info.language, 'model': 'faster-whisper-large-v3-turbo',
                  'speaker_attribution': 'unavailable', 'segments': segments,
                  'text': '\n'.join(item['text'] for item in segments),
                  'summary': 'Extractive transcript excerpts (not verified decisions or action items):\n' +
                             ('\n'.join(item['text'] for item in segments[:12]) or 'No speech detected.')}
    (root / 'transcript.json').write_text(json.dumps(transcript, ensure_ascii=False), encoding='utf-8')
    (root / 'transcript.txt').write_text(transcript['text'] or '[No speech detected]', encoding='utf-8')
    # Transparent extractive fallback, never invent decisions or action items.
    (root / 'summary.json').write_text(json.dumps({
        'schema_version': 1, 'method': 'extractive_fallback',
        'notice': 'Transcript excerpts; decisions and action items require review.',
        'excerpts': segments[:12], 'speech_segment_count': len(segments),
        'decisions': [], 'action_items': [],
    }, ensure_ascii=False), encoding='utf-8')


if __name__ == '__main__':
    main(Path(sys.argv[1]))

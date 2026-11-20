import io
import json
from contextlib import redirect_stdout
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import MagicMock, patch

import worker


class MediaRecoveryTests(unittest.TestCase):
    def test_transient_failure_reaps_partial_startup_and_retries_once(self):
        first, second = MagicMock(), MagicMock()

        def attempt(processes, _):
            processes.append(first if not processes_created else second)
            processes_created.extend(processes)
            if processes == [first]:
                raise worker.MediaStartupError('output_sink', 'nonzero_exit', 1)

        processes_created = []
        logs = io.StringIO()
        with patch.object(worker, 'start_media_attempt', side_effect=attempt) as start, \
                patch.object(worker, 'stop_process') as stop, redirect_stdout(logs):
            self.assertEqual(worker.start_media({'execution_id': 'synthetic'}), [second])
        self.assertEqual(start.call_count, 2)
        stop.assert_called_once_with(first, timeout=2)
        self.assertEqual(json.loads(logs.getvalue()), {
            'execution_id': 'synthetic', 'status': 'media_start_attempt_failed',
            'attempt': 1, 'step': 'output_sink', 'reason': 'nonzero_exit', 'exit_code': 1,
        })

    def test_retry_stops_at_capture_deadline(self):
        failure = worker.MediaStartupError('pulse_ready', 'timeout')
        with patch.object(worker, 'capture_remaining',
                          side_effect=[1, RuntimeError('capture_deadline_expired')]), \
                patch.object(worker, 'start_media_attempt', side_effect=failure) as start, \
                redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(RuntimeError, '^capture_deadline_expired$'):
                worker.start_media({'execution_id': 'synthetic'})
        start.assert_called_once()

    def test_recording_progress_detects_missing_and_stalled_audio(self):
        with TemporaryDirectory() as directory, patch.object(worker.time, 'monotonic') as clock:
            clock.return_value = 0
            root = Path(directory)
            progress = worker.RecordingProgress(root)
            video, audio = progress.files
            video.write_bytes(bytes(5000))
            self.assertFalse(progress.sample())
            audio.write_bytes(bytes(5000))
            self.assertTrue(progress.sample())  # Encoded silence still advances the audio file.
            clock.return_value = 19
            video.write_bytes(bytes(6000))
            progress.ensure_growing()
            clock.return_value = 20
            with self.assertRaisesRegex(RuntimeError, '^media_stalled$'):
                progress.ensure_growing()

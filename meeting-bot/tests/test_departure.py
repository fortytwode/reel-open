"""The recorder arrives at the start and leaves with the people, not the calendar."""
import array
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import providers
import worker

IDLE = dict(denied=False, blocked=False, consent_gate=False, waiting=False, in_call=False)
IN_CALL = dict(IDLE, in_call=True)


class MonitorDepartureTests(unittest.IsolatedAsyncioTestCase):
    async def watch(self, timeline, *, end=None, duration=7200, provider='meet'):
        """timeline(now) -> (participants, silent_seconds); returns (reason, seconds watched)."""
        self.now = 0
        page = MagicMock()

        async def wait(milliseconds):
            self.now += milliseconds / 1000

        page.wait_for_timeout = AsyncMock(side_effect=wait)
        ffmpeg = MagicMock()
        ffmpeg.poll.return_value = None
        with patch('providers.time.monotonic', side_effect=lambda: self.now), \
             patch('providers.body_text', AsyncMock(return_value='')), \
             patch('providers.observe', AsyncMock(return_value=IN_CALL)), \
             patch('providers.participant_count', AsyncMock(side_effect=lambda *_: timeline(self.now)[0])), \
             patch('builtins.print'):
            reason = await providers.monitor(page, provider, duration, lambda: False, ffmpeg,
                                             silent_seconds=lambda: timeline(self.now)[1], scheduled_end=end)
        return reason, self.now

    async def test_overrunning_conversation_is_recorded_until_the_room_empties(self):
        # Scheduled end at 600s; people talk until 1500s, then leave.
        def timeline(now):
            return (3, 0) if now < 1500 else (1, now - 1500)
        reason, watched = await self.watch(timeline, end=600)
        self.assertEqual(reason, 'room_empty')
        self.assertGreaterEqual(watched, 1560)
        self.assertLess(watched, 1570)

    async def test_no_show_is_left_at_the_scheduled_end(self):
        reason, watched = await self.watch(lambda now: (1, now), end=600)
        self.assertEqual(reason, 'meeting_silent')
        self.assertGreaterEqual(watched, 600)
        self.assertLess(watched, 610)

    async def test_room_that_empties_early_is_left_after_five_quiet_minutes(self):
        def timeline(now):
            return (2, 0) if now < 400 else (1, now - 400)
        reason, watched = await self.watch(timeline, end=3600)
        self.assertEqual(reason, 'room_empty')
        self.assertGreaterEqual(watched, 700)
        self.assertLess(watched, 710)

    async def test_quiet_meeting_with_people_present_is_kept_until_the_end(self):
        reason, watched = await self.watch(lambda now: (4, now), end=3600, duration=3000)
        self.assertEqual((reason, watched >= 3000), ('duration_limit', True))

    async def test_unknown_count_relies_on_silence_after_the_end(self):
        def timeline(now):
            return (None, 0) if now < 900 else (None, now - 900)
        reason, watched = await self.watch(timeline, end=600, provider='teams')
        self.assertEqual(reason, 'meeting_silent')
        self.assertGreaterEqual(watched, 1200)

    async def test_legacy_payload_without_presence_keeps_the_fixed_duration(self):
        page = MagicMock()
        self.now = 0

        async def wait(milliseconds):
            self.now += milliseconds / 1000

        page.wait_for_timeout = AsyncMock(side_effect=wait)
        ffmpeg = MagicMock()
        ffmpeg.poll.return_value = None
        count = AsyncMock(return_value=1)
        with patch('providers.time.monotonic', side_effect=lambda: self.now), \
             patch('providers.body_text', AsyncMock(return_value='')), \
             patch('providers.observe', AsyncMock(return_value=IN_CALL)), \
             patch('providers.participant_count', count):
            self.assertEqual(await providers.monitor(page, 'meet', 900, lambda: False, ffmpeg), 'duration_limit')
        count.assert_not_awaited()


class EntryHoldTests(unittest.IsolatedAsyncioTestCase):
    async def test_early_recorder_waits_at_the_entry_page_until_the_start(self):
        self.now = 0
        page = MagicMock()
        page.url = 'https://meet.google.com/abc-defg-hij'
        page.goto = AsyncMock()

        async def wait(milliseconds):
            self.now += milliseconds / 1000

        page.wait_for_timeout = AsyncMock(side_effect=wait)
        clicked_at = []

        async def click(*_):
            clicked_at.append(self.now)
            return True

        async def observe(*_):
            return IN_CALL if clicked_at else IDLE

        payload = dict(provider='meet', meeting_url=page.url, admission_timeout_seconds=900, display_name='Recorder')
        callback = AsyncMock()
        with patch('providers.time.monotonic', side_effect=lambda: self.now), \
             patch('providers.observe', AsyncMock(side_effect=observe)), \
             patch('providers.click_first', AsyncMock(return_value=False)), \
             patch('providers.fill_first', AsyncMock(return_value=False)), \
             patch('providers.click_named_button', AsyncMock(side_effect=click)):
            await providers.prepare_and_join(page, payload, callback, lambda: False, join_not_before=90)
        self.assertEqual(len(clicked_at), 1)
        self.assertGreaterEqual(clicked_at[0], 90)
        self.assertLess(clicked_at[0], 92)
        self.assertEqual([call.args[0] for call in callback.await_args_list], ['requesting_entry', 'joined'])


class AudioActivityTests(unittest.TestCase):
    def test_silence_is_measured_from_the_last_audible_sample(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            audio = root / 'system-audio.wav'
            now = [100.0]
            with patch('worker.time.monotonic', side_effect=lambda: now[0]):
                activity = worker.AudioActivity(root)
                self.assertEqual(activity.silent_seconds(), 0)  # no file yet is not silence
                audio.write_bytes(bytes(worker.AudioActivity.HEADER_BYTES) + array.array('h', [0, 12, -30] * 4000).tobytes())
                now[0] = 130
                self.assertEqual(activity.silent_seconds(), 30)
                with audio.open('ab') as file:
                    file.write(array.array('h', [0, 2500, -2500] * 4000).tobytes())
                now[0] = 140
                self.assertEqual(activity.silent_seconds(), 0)
                with audio.open('ab') as file:
                    file.write(array.array('h', [5] * 12000).tobytes() + b'\x01')  # odd trailing byte
                now[0] = 200
                self.assertEqual(activity.silent_seconds(), 60)


if __name__ == '__main__':
    unittest.main()

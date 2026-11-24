"""Exercise the worker lifetime: startup, admission and callbacks share one expiry."""
import asyncio
import os
import sys
import types
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch
import worker


class CaptureDeadlineTests(unittest.IsolatedAsyncioTestCase):
    async def execute_case(self, *, initial=0, startup=0, admission=0, callback_delay=0,
                           deadline=100, maximum=389, stall_callback=False, stall_admission=False,
                           stall_monitor=False, stall_startup=False, recorder_exited=False, exit_after_ready=False,
                           google_auth_delay=None, stall_google_auth=False):
        clock = [datetime(2026, 11, 17, 14, 9, 21, tzinfo=timezone.utc) + timedelta(seconds=initial)]
        origin = datetime(2026, 11, 17, 14, 9, 21, tzinfo=timezone.utc)

        class Clock(datetime):
            @classmethod
            def now(cls, tz=None):
                return clock[0]

        page, browser, context, playwright = MagicMock(), MagicMock(), MagicMock(), MagicMock()
        browser.new_context = AsyncMock(return_value=context)
        context.new_page = AsyncMock(return_value=page)
        browser.close = AsyncMock()

        async def launch(**kwargs):
            clock[0] += timedelta(seconds=startup)
            return browser

        playwright.chromium.launch = AsyncMock(side_effect=launch)

        class Manager:
            async def __aenter__(self): return playwright
            async def __aexit__(self, *args): pass

        api = types.ModuleType('playwright.async_api')
        api.async_playwright, api.TimeoutError = Manager, TimeoutError
        package = types.ModuleType('playwright')
        package.async_api = api
        payload = {'execution_id': 'test', 'provider': 'teams', 'max_duration_seconds': maximum,
                   'admission_timeout_seconds': 900}
        if google_auth_delay is not None:
            payload['provider'] = 'meet'
        if deadline is not None:
            payload['capture_deadline'] = (origin + timedelta(seconds=deadline)).isoformat()
        recorder = MagicMock()
        recorder.poll.return_value = 1 if recorder_exited else None
        if exit_after_ready:
            recorder.poll.side_effect = [None, 1]
        joins, durations, stopped = [], [], []

        async def close():
            stopped.append('browser')

        async def diagnostic(page, stage):
            stopped.append(stage + '_diagnostic')

        browser.close.side_effect = close

        async def join(page, p, *args, **kwargs):
            joins.append(p)
            if stall_admission:
                await asyncio.Event().wait()
            clock[0] += timedelta(seconds=admission)

        async def verify_account(page, email):
            if stall_google_auth:
                await asyncio.Event().wait()
            clock[0] += timedelta(seconds=google_auth_delay)

        async def callback(status, **kwargs):
            if status == 'recording':
                if stall_callback:
                    await asyncio.Event().wait()
                clock[0] += timedelta(seconds=callback_delay)

        async def sleep(seconds):
            if stall_startup:
                await asyncio.Event().wait()
            if not (stall_callback or stall_monitor):
                clock[0] += timedelta(seconds=seconds)

        async def monitor(page, provider, duration, *args, **kwargs):
            durations.append(duration)
            if stall_monitor:
                await asyncio.Event().wait()
            return 'duration_limit'

        def stop(process):
            if process is recorder:
                stopped.append('recorder')

        async def wait_for_recording(process, _):
            await sleep(1)
            if process.poll() is not None:
                raise RuntimeError("recorder_start_failed")

        def upload(root):
            stopped.append('upload')
            run.artifacts['system-audio.wav'] = {'size_bytes': 64, 'gcs_uri': 'gs://private/test/system-audio.wav'}

        run = types.SimpleNamespace(p=payload, callback=AsyncMock(side_effect=callback),
                                    diagnostic=AsyncMock(side_effect=diagnostic), artifacts={},
                                    upload=MagicMock(side_effect=upload), client=MagicMock())
        auth_env = {'BOT_GOOGLE_AUTH_STATE_URI': '', 'BOT_GOOGLE_ACCOUNT_EMAIL': ''}
        if google_auth_delay is not None:
            auth_env = {'BOT_GOOGLE_AUTH_STATE_URI': 'gs://private/reel-bot-auth/google/state.json',
                        'BOT_GOOGLE_ACCOUNT_EMAIL': 'reel-notetaker@rocketshiphq.com'}
        with patch.dict(os.environ, auth_env), \
             patch('google_auth.load_state', return_value={'cookies': [], 'origins': []}), \
             patch('google_auth.verify_account', side_effect=verify_account), \
             patch.dict(sys.modules, {'playwright': package, 'playwright.async_api': api}), \
             patch('worker.datetime', Clock), patch('worker.start_media', return_value=None), \
             patch('worker.start_recording', return_value=recorder) as start, \
             patch('worker.stop_process', side_effect=stop), patch('builtins.print'), \
             patch('worker.wait_for_recording', side_effect=wait_for_recording), \
             patch('providers.prepare_and_join', side_effect=join), patch('providers.monitor', side_effect=monitor):
            result = await worker.execute(run, Path('/unused'))
        return result, run, joins, durations, start, stopped, browser

    async def test_expired_startup_never_joins_and_reports_controlled_failure(self):
        for initial, startup in [(101, 0), (0, 101)]:
            with self.subTest(initial=initial, startup=startup):
                result, run, joins, durations, start, stopped, browser = await self.execute_case(initial=initial, startup=startup)
                self.assertEqual(result, 1)
                self.assertEqual(joins, [])
                start.assert_not_called()
                run.callback.assert_awaited_once_with('failed', detail='capture_deadline_expired', artifacts={})

    async def test_expiry_during_admission_does_not_start_recorder(self):
        result, run, joins, durations, start, stopped, browser = await self.execute_case(startup=20, admission=81)
        self.assertEqual(joins[0]['admission_timeout_seconds'], 80)
        start.assert_not_called()
        browser.close.assert_awaited_once()
        self.assertEqual(result, 1)
        run.callback.assert_awaited_once_with('failed', detail='capture_deadline_expired', artifacts={})

    async def test_absolute_timeout_cancels_stalled_admission_without_capture(self):
        result, run, joins, durations, start, stopped, browser = await self.execute_case(deadline=.03, stall_admission=True)
        self.assertEqual(result, 1)
        self.assertEqual(joins[0]['admission_timeout_seconds'], .03)
        start.assert_not_called()
        browser.close.assert_awaited_once()
        run.upload.assert_not_called()
        run.callback.assert_awaited_once_with('failed', detail='capture_deadline_expired', artifacts={})

    async def test_startup_admission_and_callback_do_not_restart_recording_budget(self):
        result, run, joins, durations, start, stopped, browser = await self.execute_case(startup=20, admission=30, callback_delay=7)
        self.assertEqual(result, 0)
        self.assertEqual(joins[0]['admission_timeout_seconds'], 80)
        self.assertEqual(durations, [42])  # 100 - 20 startup - 30 admission - 1 recorder check - 7 callback
        self.assertLess(stopped.index('recorder'), stopped.index('browser'))
        self.assertLess(stopped.index('browser'), stopped.index('upload'))
        browser.close.assert_awaited_once()
        run.upload.assert_called_once()

    async def test_relative_duration_cap_and_legacy_payload_remain_supported(self):
        for deadline in [None, 1000]:
            result, run, joins, durations, start, stopped, browser = await self.execute_case(deadline=deadline, maximum=10)
            self.assertEqual(result, 0)
            self.assertLessEqual(durations[0], 10)
            self.assertEqual(joins[0]['admission_timeout_seconds'], 900)

    async def test_active_absolute_cutoff_completes_with_audio_even_during_callback(self):
        for delays in [dict(deadline=.03, stall_callback=True),
                       dict(deadline=.03, stall_monitor=True),
                       dict(deadline=100, callback_delay=101)]:
            with self.subTest(delays=delays):
                result, run, joins, durations, start, stopped, browser = await self.execute_case(**delays)
                self.assertEqual(result, 0)
                self.assertLess(stopped.index('recorder'), stopped.index('browser'))
                self.assertLess(stopped.index('browser'), stopped.index('upload'))
                self.assertNotIn('failed_diagnostic', stopped)
                browser.close.assert_awaited_once()
                self.assertEqual(run.callback.await_args.args, ('completed',))
                self.assertEqual(run.callback.await_args.kwargs['detail'], 'duration_limit')
                self.assertEqual(run.callback.await_args.kwargs['artifacts']['system-audio.wav']['size_bytes'], 64)
                run.upload.assert_called_once()

    async def test_expiry_before_recorder_ready_and_real_recorder_failure_still_fail(self):
        for settings, detail in [(dict(deadline=.03, stall_startup=True), 'capture_deadline_expired'),
                                 (dict(recorder_exited=True), 'recorder_start_failed'),
                                 (dict(deadline=.03, stall_callback=True, exit_after_ready=True), 'recorder_exited')]:
            with self.subTest(settings=settings):
                result, run, joins, durations, start, stopped, browser = await self.execute_case(**settings)
                self.assertEqual(result, 1)
                self.assertEqual(durations, [])
                self.assertLess(stopped.index('recorder'), stopped.index('failed_diagnostic'))
                browser.close.assert_awaited_once()
                self.assertEqual(run.callback.await_args.args, ('failed',))
                self.assertEqual(run.callback.await_args.kwargs['detail'], detail)

    async def test_google_account_verification_consumes_the_absolute_budget(self):
        result, run, joins, durations, start, stopped, browser = await self.execute_case(
            google_auth_delay=20, admission=30)
        self.assertEqual(result, 0)
        self.assertEqual(joins[0]['admission_timeout_seconds'], 80)
        self.assertEqual(durations, [49])

    async def test_expired_or_stalled_google_verification_never_joins(self):
        for settings in [dict(google_auth_delay=101),
                         dict(google_auth_delay=0, deadline=.03, stall_google_auth=True)]:
            with self.subTest(settings=settings):
                result, run, joins, durations, start, stopped, browser = await self.execute_case(**settings)
                self.assertEqual(result, 1)
                self.assertEqual(joins, [])
                start.assert_not_called()
                browser.close.assert_awaited_once()
                run.callback.assert_awaited_once_with('failed', detail='capture_deadline_expired', artifacts={})

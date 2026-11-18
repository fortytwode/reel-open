"""Entry recovery retries read-only observations, never entry actions."""
import json
import os
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import providers


IDLE = dict(denied=False, blocked=False, consent_gate=False, waiting=False, in_call=False)
JOINED = dict(IDLE, in_call=True)


class EntryObservationRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def run_entry(self, observations, *, timeout=10, provider='teams'):
        self.now = 0
        self.page = MagicMock()
        self.page.url = 'https://teams.microsoft.com/meet/123'
        self.page.goto = AsyncMock()

        async def wait(milliseconds):
            self.now += milliseconds / 1000

        self.page.wait_for_timeout = AsyncMock(side_effect=wait)
        self.callback = AsyncMock()
        self.observer = AsyncMock(side_effect=observations)
        self.click = AsyncMock(side_effect=[False, False, True])
        with patch('providers.time.monotonic', side_effect=lambda: self.now), \
             patch('providers.observe', self.observer), \
             patch('providers.click_first', self.click), \
             patch('providers.fill_first', AsyncMock()):
            await providers.prepare_and_join(self.page, {
                'provider': provider, 'meeting_url': self.page.url,
                'display_name': 'Test Bot', 'admission_timeout_seconds': timeout,
            }, self.callback, lambda: False)

    def transient(self, message='Execution context was destroyed, most likely because of a navigation'):
        # Also exercises pure-unit fallback when Playwright is not installed.
        return providers.PlaywrightError(message)

    async def test_transient_after_join_preserves_single_navigation_and_join(self):
        await self.run_entry([IDLE, self.transient(), JOINED, JOINED])
        self.page.goto.assert_awaited_once()
        self.assertEqual(self.click.await_count, 3)
        self.assertEqual([call.args for call in self.callback.await_args_list],
                         [('requesting_entry',), ('joined',)])

    async def test_transient_before_actions_does_not_click(self):
        await self.run_entry([self.transient(), JOINED, JOINED])
        self.page.goto.assert_awaited_once()
        self.click.assert_not_awaited()

    async def test_confirmation_observation_also_recovers(self):
        await self.run_entry([JOINED, self.transient('Frame was detached'), JOINED])
        self.page.goto.assert_awaited_once()
        self.click.assert_not_awaited()
        self.assertEqual(self.callback.await_args_list[-1].args, ('joined',))

    async def test_other_recognized_context_errors_recover(self):
        for message in ['Cannot find context with specified id',
                        'Execution context is not available in detached frame']:
            with self.subTest(message=message):
                await self.run_entry([self.transient(message), JOINED, JOINED])
            self.click.assert_not_awaited()

    async def test_qa_retry_log_contains_only_fixed_metadata(self):
        with patch.dict(os.environ, {'BOT_DIAGNOSTICS': '1'}), patch('builtins.print') as printed:
            await self.run_entry([self.transient('Execution context was destroyed: private meeting URL'),
                                  JOINED, JOINED])
        printed.assert_called_once()
        self.assertEqual(json.loads(printed.call_args.args[0]), {
            'status': 'join_observation_retry', 'detail': 'navigation_in_progress'})
        self.assertNotIn('private', printed.call_args.args[0])

    async def test_retry_log_is_disabled_outside_qa(self):
        with patch.dict(os.environ, {'BOT_DIAGNOSTICS': '0'}), patch('builtins.print') as printed:
            await self.run_entry([self.transient(), JOINED, JOINED])
        printed.assert_not_called()

    async def test_policy_denial_block_and_consent_remain_terminal(self):
        for flag, outcome in [('denied', 'denied'), ('blocked', 'human_action_required'),
                              ('consent_gate', 'human_action_required')]:
            with self.subTest(flag=flag), self.assertRaisesRegex(RuntimeError, '^' + outcome + '$'):
                await self.run_entry([self.transient(), dict(IDLE, **{flag: True})])
            self.click.assert_not_awaited()
            self.assertEqual(self.callback.await_count, 1)

    async def test_confirmation_denial_block_and_consent_remain_terminal(self):
        for flag, outcome in [('denied', 'denied'), ('blocked', 'human_action_required'),
                              ('consent_gate', 'human_action_required')]:
            with self.subTest(flag=flag), self.assertRaisesRegex(RuntimeError, '^' + outcome + '$'):
                await self.run_entry([JOINED, self.transient(), dict(IDLE, **{flag: True})])
            self.click.assert_not_awaited()
            self.assertEqual(self.callback.await_count, 1)

    async def test_unrelated_playwright_error_propagates(self):
        error = self.transient('Unexpected token while parsing selector')
        with self.assertRaises(type(error)) as caught:
            await self.run_entry([error])
        self.assertIs(caught.exception, error)
        self.page.wait_for_timeout.assert_not_awaited()

    async def test_non_playwright_navigation_error_propagates(self):
        error = RuntimeError('Execution context was destroyed')
        with self.assertRaises(RuntimeError) as caught:
            await self.run_entry([error])
        self.assertIs(caught.exception, error)
        self.page.wait_for_timeout.assert_not_awaited()

    async def test_other_provider_navigation_error_propagates(self):
        error = self.transient()
        with self.assertRaises(type(error)) as caught:
            await self.run_entry([error], provider='zoom')
        self.assertIs(caught.exception, error)
        self.page.wait_for_timeout.assert_not_awaited()

    async def test_persistent_transient_respects_existing_deadline(self):
        with self.assertRaisesRegex(RuntimeError, '^join_not_available$'):
            await self.run_entry(self.transient(), timeout=2.5)
        self.assertEqual(self.now, 2.5)
        self.assertLessEqual(self.observer.await_count, 4)
        self.page.goto.assert_awaited_once()
        self.click.assert_not_awaited()

    async def test_confirmation_retry_cannot_admit_after_deadline(self):
        with self.assertRaisesRegex(RuntimeError, '^join_not_available$'):
            await self.run_entry([JOINED, self.transient(), JOINED], timeout=1.5)
        self.assertEqual(self.now, 1.5)
        self.assertEqual(self.callback.await_count, 1)

    async def test_persistent_error_after_join_preserves_timeout_status(self):
        observations = iter([IDLE, dict(IDLE, waiting=True)])

        async def observe(*args):
            try:
                return next(observations)
            except StopIteration:
                raise self.transient()

        with self.assertRaisesRegex(RuntimeError, '^admission_timeout$'):
            await self.run_entry(observe, timeout=3.5)
        self.assertEqual(self.now, 3.5)
        self.assertEqual(self.click.await_count, 3)
        self.assertEqual([call.args for call in self.callback.await_args_list],
                         [('requesting_entry',), ('awaiting_admission',)])


if __name__ == '__main__':
    unittest.main()

import sys
import types
import unittest
import json
import os
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch
import providers
import worker


class BrowserLifetimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_meet_uses_configured_bot_state_before_joining(self):
        state = {'cookies': [{'name': 'SID', 'value': 'synthetic-test-only', 'domain': '.google.com',
                             'path': '/', 'expires': 2_000_000_000, 'httpOnly': True,
                             'secure': True, 'sameSite': 'None'}], 'origins': []}
        document = {'schema_version': 1, 'account_email': 'reel-notetaker@rocketshiphq.com',
                    'storage_state': state}
        blob = MagicMock(size=len(json.dumps(document)), generation=7)
        blob.download_as_bytes.return_value = json.dumps(document).encode()
        client = MagicMock()
        client.bucket.return_value.blob.return_value = blob
        page, context, browser, playwright = [MagicMock() for _ in range(4)]
        page.url = 'https://myaccount.google.com/'
        page.goto = AsyncMock()
        page.wait_for_selector = AsyncMock()
        account = MagicMock()
        account.get_attribute = AsyncMock(return_value='Google Account: Reel Notetaker (reel-notetaker@rocketshiphq.com)')
        account.is_visible = AsyncMock(return_value=True)
        page.locator.return_value.all = AsyncMock(return_value=[account])
        context.new_page = AsyncMock(return_value=page)
        browser.new_context = AsyncMock(return_value=context)
        browser.close = AsyncMock()
        playwright.chromium.launch = AsyncMock(return_value=browser)

        class Manager:
            async def __aenter__(self): return playwright
            async def __aexit__(self, *args): pass

        api = types.ModuleType('playwright.async_api')
        api.async_playwright, api.TimeoutError = Manager, TimeoutError
        package = types.ModuleType('playwright'); package.async_api = api
        run = types.SimpleNamespace(p={'execution_id': 'test-execution', 'provider': 'meet'},
            client=client, artifacts={}, diagnostic=AsyncMock(), callback=AsyncMock())
        config = {'BOT_GOOGLE_AUTH_STATE_URI': 'gs://private-bucket/reel-bot-auth/google/state.json',
                  'BOT_GOOGLE_ACCOUNT_EMAIL': 'reel-notetaker@rocketshiphq.com'}
        with patch.dict(sys.modules, {'playwright': package, 'playwright.async_api': api}), \
             patch.dict(os.environ, config), patch('worker.start_media', return_value=None), \
             patch('worker.stop_process'), patch('builtins.print'), \
             patch('providers.prepare_and_join', AsyncMock(side_effect=RuntimeError('denied'))) as join:
            await worker.execute(run, Path('/unused'))
        self.assertEqual(browser.new_context.await_args.kwargs.get('storage_state'), state)
        self.assertTrue(join.await_args.kwargs.get('authenticated_google'))
        page.goto.assert_awaited_once()
        blob.download_as_bytes.assert_called_once_with(if_generation_match=7, timeout=30)

    async def test_navigation_timeout_inspects_same_live_page_without_renavigation(self):
        page = MagicMock()
        page.url = 'https://workspace.google.com/products/meet/'
        page.goto = AsyncMock(side_effect=providers.PlaywrightTimeoutError('sensitive provider error'))
        callback, diagnostic = AsyncMock(), AsyncMock()
        with self.assertRaisesRegex(RuntimeError, '^join_page_unavailable$'):
            await providers.prepare_and_join(page, {
                'provider': 'meet', 'meeting_url': 'https://meet.google.com/meet/abc-defg-hij',
                'admission_timeout_seconds': 300}, callback, lambda: False, diagnostic)
        page.goto.assert_awaited_once()
        self.assertEqual(page.goto.await_args.kwargs['wait_until'], 'commit')
        diagnostic.assert_awaited_once_with(page, 'navigation')
        callback.assert_awaited_once_with('requesting_entry')

    async def test_failed_snapshot_precedes_playwright_context_exit(self):
        exited = False
        page = MagicMock()
        browser = MagicMock()
        context = MagicMock()
        context.new_page = AsyncMock(return_value=page)
        browser.new_context = AsyncMock(return_value=context)
        browser.close = AsyncMock()
        playwright = MagicMock()
        playwright.chromium.launch = AsyncMock(return_value=browser)

        class Manager:
            async def __aenter__(self):
                return playwright
            async def __aexit__(self, *args):
                nonlocal exited
                exited = True

        async def diagnostic(actual_page, stage):
            self.assertFalse(exited, 'diagnostic ran after browser lifetime ended')
            self.assertIs(actual_page, page)
            self.assertEqual(stage, 'failed')

        run = types.SimpleNamespace(p={'execution_id': 'test-execution'}, artifacts={},
                                    diagnostic=AsyncMock(side_effect=diagnostic), callback=AsyncMock())
        api = types.ModuleType('playwright.async_api')
        api.async_playwright = Manager
        api.TimeoutError = TimeoutError
        package = types.ModuleType('playwright')
        package.async_api = api
        with patch.dict(sys.modules, {'playwright': package, 'playwright.async_api': api}), \
             patch('worker.start_media', return_value=None), patch('worker.stop_process'), \
             patch.dict(os.environ, {'BOT_DIAGNOSTICS': '1'}), patch('builtins.print') as printed, \
             patch('providers.prepare_and_join', AsyncMock(side_effect=RuntimeError('denied'))):
            result = await worker.execute(run, Path('/unused'))
        self.assertTrue(exited)
        self.assertEqual(result, 1)
        run.diagnostic.assert_awaited_once()
        run.callback.assert_awaited_once_with('failed', detail='denied', artifacts={})
        logged = json.loads(printed.call_args.args[0])
        self.assertEqual(logged['detail'], 'denied')
        self.assertEqual(logged['exception_type'], 'RuntimeError')
        self.assertEqual(logged['failure_module'], 'worker.py')
        self.assertEqual(logged['failure_function'], 'execute')
        self.assertIsInstance(logged['failure_line'], int)


if __name__ == '__main__':
    unittest.main()

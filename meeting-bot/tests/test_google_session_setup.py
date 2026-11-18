import asyncio
from contextlib import redirect_stdout
from datetime import datetime, timezone
import io
import json
from pathlib import Path
import signal
import sys
import tempfile
import types
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import google_session_setup as setup

URI = 'gs://private-bucket/reel-bot-auth/google/setup/config.json'
EMAIL = 'bot@rocketshiphq.com'


def config():
    return {'account_email': EMAIL,
            'output_uri': 'gs://private-bucket/reel-bot-auth/google/state.json',
            'expected_generation': 0,
            'expires_at': datetime.fromtimestamp(1500, timezone.utc).isoformat()}


class SetupTests(unittest.TestCase):
    def test_config_deadline_account_address_and_private_location(self):
        valid = setup.validate_config(config(), URI, now=1000)
        self.assertEqual(valid['deadline'], 1500)
        for change in ({'account_email': 'Bot <bot@cedar.example>'},
                       {'account_email': 'bot\x00@cedar.example'},
                       {'expected_generation': True},
                       {'expected_generation': -1}, {'expires_at': '1970-01-01T01:00:00Z'},
                       {'expires_at': '1970-01-01T00:01:00Z'},
                       {'expires_at': '1970-01-01T00:25:00'},
                       {'output_uri': 'gs://private-bucket/other/state.json'},
                       {'output_uri': 'gs://other-bucket/reel-bot-auth/google/state.json'},
                       {'output_uri': URI}, {'password': 'never-accepted'}):
            with self.subTest(change=change), self.assertRaises(setup.SetupError):
                setup.validate_config({**config(), **change}, URI, now=1000)

    def test_operator_can_configure_a_different_organization_account(self):
        email = 'bot@cedar.example'
        valid = setup.validate_config({**config(), 'account_email': email}, URI, now=1000)
        self.assertEqual(valid['account_email'], email)

    def test_config_read_pins_generation(self):
        raw = json.dumps(config()).encode()
        client = MagicMock()
        blob = client.bucket.return_value.blob.return_value
        blob.generation, blob.size = 4, len(raw)
        blob.download_as_bytes.return_value = raw
        with patch.object(setup.time, 'time', return_value=1000):
            setup.read_config(client, URI)
        blob.download_as_bytes.assert_called_once_with(if_generation_match=4, timeout=15)

    def test_filter_and_upload_generation_precondition(self):
        state = {'cookies': [{'domain': '.google.com', 'value': 'test-only'},
                             {'domain': '.google.com.attacker.org', 'value': 'excluded'}],
                 'origins': [{'origin': 'https://accounts.google.com', 'localStorage': []},
                             {'origin': 'http://google.com'}, {'origin': 'https://other.org'}]}
        client = MagicMock()
        with patch.object(setup.time, 'time', return_value=1000):
            setup.upload_state(client, {**config(), 'deadline': 1500}, state)
        call = client.bucket.return_value.blob.return_value.upload_from_string.call_args
        document = json.loads(call.args[0])
        self.assertEqual(len(document['storage_state']['cookies']), 1)
        self.assertEqual(len(document['storage_state']['origins']), 1)
        self.assertEqual(document['account_email'], EMAIL)
        self.assertEqual(call.kwargs['if_generation_match'], 0)
        self.assertIsNone(call.kwargs['retry'])
        with patch.object(setup.time, 'time', return_value=1500), self.assertRaises(setup.SetupError):
            setup.upload_state(client, {**config(), 'deadline': 1500}, state)
        self.assertEqual(client.bucket.return_value.blob.return_value.upload_from_string.call_count, 1)

    def test_cleanup_kills_process_group_even_after_parent_exit(self):
        processes = setup.Processes()
        process = MagicMock(pid=123)
        processes.items.append(process)
        with patch.object(setup.os, 'killpg') as kill:
            processes.close()
        kill.assert_called_once_with(123, signal.SIGKILL)
        process.wait.assert_called_once_with(timeout=2)

    def test_failure_logs_fixed_status_and_removes_profile(self):
        storage = types.ModuleType('google.cloud.storage')
        storage.Client = MagicMock()
        cloud = types.ModuleType('google.cloud')
        cloud.storage = storage
        created = []
        async def fail(client, document, root, processes):
            created.append(root)
            (root / 'secret').write_text('sensitive')
            raise RuntimeError('sensitive exception must not appear')
        output = io.StringIO()
        with patch.dict(sys.modules, {'google.cloud': cloud, 'google.cloud.storage': storage}), \
                patch.object(setup, 'read_config', return_value={**config(), 'deadline': 2000}), \
                patch.object(setup, 'run_session', side_effect=fail), \
                patch.object(setup.signal, 'signal'), patch.object(setup.signal, 'setitimer'), \
                redirect_stdout(output):
            self.assertEqual(setup.main(), 1)
        self.assertEqual(output.getvalue(), 'setup_failed\n')
        self.assertFalse(created[0].exists())


class VerificationTests(unittest.IsolatedAsyncioTestCase):
    async def test_wrong_account_never_reads_or_exports_state(self):
        context = MagicMock()
        context.new_page = AsyncMock()
        context.close = AsyncMock()
        context.storage_state = AsyncMock()
        playwright = MagicMock()
        playwright.chromium.launch_persistent_context = AsyncMock(return_value=context)
        manager = MagicMock()
        manager.__aenter__ = AsyncMock(return_value=playwright)
        manager.__aexit__ = AsyncMock(return_value=False)
        module = types.ModuleType('playwright.async_api')
        module.async_playwright = MagicMock(return_value=manager)
        with patch.dict(sys.modules, {'playwright.async_api': module}), \
                patch.object(setup, 'verify_account', AsyncMock(side_effect=RuntimeError('wrong account'))):
            with self.assertRaises(RuntimeError):
                await setup.collect_state(Path('/isolated/profile'), EMAIL)
        context.storage_state.assert_not_called()
        context.close.assert_awaited_once()

    async def test_verified_account_exports_indexed_db(self):
        context = MagicMock(new_page=AsyncMock(), close=AsyncMock(),
                            storage_state=AsyncMock(return_value={'cookies': [], 'origins': []}))
        playwright = MagicMock()
        playwright.chromium.launch_persistent_context = AsyncMock(return_value=context)
        manager = MagicMock(__aenter__=AsyncMock(return_value=playwright),
                            __aexit__=AsyncMock(return_value=False))
        module = types.ModuleType('playwright.async_api')
        module.async_playwright = MagicMock(return_value=manager)
        with patch.dict(sys.modules, {'playwright.async_api': module}), \
                patch.object(setup, 'verify_account', AsyncMock()) as verify:
            await setup.collect_state(Path('/isolated/profile'), EMAIL)
        verify.assert_awaited_once_with(context.new_page.return_value, EMAIL)
        context.storage_state.assert_awaited_once_with(indexed_db=True)

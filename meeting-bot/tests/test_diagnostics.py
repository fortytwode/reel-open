import os
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch
import worker
from worker import Run
from providers import observe


class DiagnosticsTests(unittest.IsolatedAsyncioTestCase):
    def test_failure_metadata_is_disabled_by_default(self):
        with patch.dict(os.environ, {'BOT_DIAGNOSTICS': '0'}):
            self.assertEqual(worker.failure_metadata(ValueError('private token')), {})

    def test_failure_metadata_reports_only_owned_location(self):
        namespace = {}
        source = str(Path(worker.__file__).parent / 'providers.py')
        exec(compile("def fail():\n raise ValueError('https://private.invalid/?token=DO_NOT_LOG')\n", source, 'exec'), namespace)
        try:
            namespace['fail']()
        except ValueError as error:
            with patch.dict(os.environ, {'BOT_DIAGNOSTICS': '1'}):
                result = worker.failure_metadata(error)
        self.assertEqual(result, {'exception_type': 'ValueError', 'failure_module': 'providers.py',
                                  'failure_function': 'fail', 'failure_line': 2})
        self.assertNotIn('DO_NOT_LOG', str(result))
        self.assertNotIn('private.invalid', str(result))
        self.assertNotIn(str(Path(worker.__file__).parent), str(result))

    def make_run(self):
        client = MagicMock()
        run = Run({'output_bucket': 'private-test', 'output_prefix': 'owner/execution/'}, client)
        return run, client.bucket.return_value

    async def test_disabled_never_reads_page_or_uploads(self):
        run, bucket = self.make_run()
        page = MagicMock()
        with patch.dict(os.environ, {'BOT_DIAGNOSTICS': '0'}):
            await run.diagnostic(page, 'navigation')
        page.screenshot.assert_not_called()
        bucket.blob.assert_not_called()

    async def test_enabled_uses_exact_private_prefix_and_fixed_stage(self):
        run, bucket = self.make_run()
        page = MagicMock()
        page.screenshot = AsyncMock(return_value=b'private-image')
        with patch.dict(os.environ, {'BOT_DIAGNOSTICS': '1'}), patch('providers.body_text', AsyncMock(return_value='private visible text')):
            await run.diagnostic(page, 'waiting')
        self.assertEqual([call.args[0] for call in bucket.blob.call_args_list],
                         ['owner/execution/debug/waiting.txt', 'owner/execution/debug/waiting.png'])
        self.assertEqual(run.artifacts, {})

    async def test_invalid_stage_never_writes(self):
        run, bucket = self.make_run()
        with patch.dict(os.environ, {'BOT_DIAGNOSTICS': '1'}):
            await run.diagnostic(MagicMock(), '../../other-owner')
        bucket.blob.assert_not_called()

    async def test_failed_diagnostics_do_not_change_join_outcome(self):
        run, _ = self.make_run()
        page = MagicMock()
        page.screenshot = AsyncMock(side_effect=RuntimeError('sensitive provider details'))
        with patch.dict(os.environ, {'BOT_DIAGNOSTICS': '1'}):
            await run.diagnostic(page, 'failed')

    async def test_meet_refusal_is_reported_as_denied(self):
        for refusal in ["You can't join this video call", "You can’t join this video call"]:
            page = MagicMock()
            page.url = 'https://meet.google.com/abc-defg-hij'
            page.frames = []
            with patch('providers.body_text', AsyncMock(return_value=refusal)), patch('providers.visible', AsyncMock(return_value=False)):
                state = await observe(page, 'meet')
            with self.subTest(refusal=refusal):
                self.assertTrue(state['denied'])


if __name__ == '__main__':
    unittest.main()

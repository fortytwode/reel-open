"""Native captions are optional, bounded evidence for the recording."""

import asyncio
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
import wave

import captions
import providers
import test_capture_deadline
from worker import Run


def row(id, name='Jordan Green', text='We approved the budget.', start=1, end=2):
    return {'id': id, 'name': name, 'text': text, 'start': start, 'end': end}


def batch(*rows, alive=True, **flags):
    return {'rows': list(rows), 'alive': alive, **flags}


class CaptionBufferTests(unittest.TestCase):
    def test_final_revisions_replace_partial_text_and_start_times_may_overlap(self):
        buffer = captions.CaptionBuffer('meet')
        buffer.ingest(batch(row(1, text='We approved'), row(2, name="Jordan's Presentation", start=1.8)), 1, 60)
        buffer.ingest(batch(row(1, end=2.2), row(3, text='The second proposal.', start=2.3, end=4)), 1, 60)
        document = buffer.document('execution', 'meet', 3)
        self.assertEqual(document['status'], 'captured')
        self.assertEqual(document['timing'], 'caption_observed')
        turns = document['turns']
        self.assertEqual([turn['text'] for turn in turns],
                         ['We approved the budget.', 'We approved the budget.', 'The second proposal.'])
        self.assertEqual([turn['speaker_name'] for turn in turns],
                         ['Jordan Green', "Jordan's Presentation", 'Jordan Green'])
        self.assertEqual([(turn['start'], turn['end']) for turn in turns], [(1, 2.2), (1.8, 2), (2.3, 3)])
        self.assertEqual(turns[0]['source'], 'google_meet_caption')
        self.assertNotIn('speaker_id', turns[0])

    def test_unidentified_rows_mark_partial_and_leave_other_rows(self):
        buffer = captions.CaptionBuffer('teams')
        labels = ('You', 'Speaker #1', 'Unknown Participant', 'Guest', '+1 (415) 555-0123', '', 'Private caller')
        buffer.ingest(batch(*(row(i, name=label) for i, label in enumerate(labels, 1))), 1, 60)
        unavailable = buffer.document('execution', 'teams', 60)
        self.assertEqual(unavailable['status'], 'unavailable')
        self.assertEqual(unavailable['reason'], 'unidentified_caption_speaker')
        self.assertEqual(unavailable['turns'], [])
        buffer.ingest(batch(row(8, name='Nyasha')), 1, 60)
        partial = buffer.document('execution', 'teams', 60)
        self.assertEqual(partial['status'], 'partial')
        self.assertEqual(partial['turns'][0]['source'], 'teams_caption')
        self.assertEqual([turn['speaker_name'] for turn in partial['turns']], ['Nyasha'])

    def test_cutoff_holds_preceding_revision_when_post_recording_text_arrives(self):
        buffer = captions.CaptionBuffer('meet')
        buffer.ingest(batch(row(1, text='We approved', end=1.49)), 1, 2)
        buffer.ingest(batch(row(1, end=2.3), row(2, start=2.1, end=2.4)), 1, 2)
        self.assertEqual([turn['text'] for turn in buffer.document('exec', 'meet', 2)['turns']], ['We approved'])

    def test_restart_does_not_overwrite_existing_id_or_reset_limits(self):
        buffer = captions.CaptionBuffer('meet')
        with patch.object(captions, 'MAX_TURNS', 2):
            buffer.ingest(batch(row(1)), 1, 60)
            buffer.ingest(batch(row(1, text='Meeting resumed.', start=9, end=10),
                                row(2, text='Extra turn.', start=11, end=12)), 2, 60)
            buffer.ingest(batch(row(1, text='Meeting resumed. Please continue.', start=9, end=10.2)), 2, 60)
        document = buffer.document('execution', 'meet', 60)
        self.assertEqual(document['reason'], 'caption_limit_reached')
        self.assertEqual(document['status'], 'partial')
        self.assertEqual([turn['text'] for turn in document['turns']],
                         ['We approved the budget.', 'Meeting resumed. Please continue.'])

    def test_text_and_utf8_limits_count_current_revisions(self):
        buffer = captions.CaptionBuffer('meet')
        with patch.object(captions, 'MAX_TEXT_CHARS', 25):
            buffer.ingest(batch(row(1, text='A caption in progress')), 1, 60)
            buffer.ingest(batch(row(1, text='Final caption'), row(2, text='Other words')), 1, 60)
            buffer.ingest(batch(row(3, text='Too long')), 1, 60)
        self.assertEqual(buffer.text_chars, 24)
        self.assertEqual(len(buffer.document('execution', 'meet', 60)['turns']), 2)
        buffer = captions.CaptionBuffer('meet')
        with patch.object(captions, 'MAX_BYTES', 1024):
            buffer.ingest(batch(row(1, text='朝' * 150), row(2, text='朝' * 150)), 1, 60)
        data = captions.encode(buffer.document('execution', 'meet', 60))
        self.assertLessEqual(len(data), 1024)
        self.assertIn(b'caption_limit_reached', data)


class CaptionCaptureTests(unittest.IsolatedAsyncioTestCase):
    async def test_finishes_once_while_frame_is_alive_and_clamps_to_recording(self):
        frame = MagicMock()
        calls = []
        installed = asyncio.Event()

        async def evaluate(script, argument):
            calls.append((script, argument))
            if script == captions.INSTALL:
                installed.set()
                return True
            self.assertTrue(argument)
            return batch(row(1, start=0, end=0.9))

        frame.evaluate = AsyncMock(side_effect=evaluate)
        with tempfile.TemporaryDirectory() as temp, patch('captions.caption_frame', AsyncMock(return_value=frame)):
            root = Path(temp)
            with wave.open(str(root / 'system-audio.wav'), 'wb') as audio:
                audio.setparams((1, 2, 16_000, 0, 'NONE', 'not compressed'))
                audio.writeframes(b'\x00\x00' * 8000)
            capture = captions.CaptionCapture(MagicMock(), 'meet', 'execution', time.monotonic() - 1)
            capture.start()
            await installed.wait()
            await capture.finish(root, time.monotonic())
            document = json.loads((root / captions.CAPTIONS_FILENAME).read_bytes())
        self.assertEqual([call[0] for call in calls], [captions.INSTALL, captions.DRAIN])
        self.assertGreaterEqual(calls[0][1]['elapsed'], 1)
        self.assertEqual(document['status'], 'captured')
        self.assertEqual(document['turns'][0]['end'], 0.5)

    async def test_navigation_loss_keeps_prior_rows_and_reinstalls_only_once(self):
        original, restarted = MagicMock(), MagicMock()
        settled = asyncio.Event()
        original.evaluate = AsyncMock(side_effect=(True, batch(row(1)), RuntimeError('private navigation')))

        async def after_restart(script, argument):
            if script == captions.INSTALL:
                self.assertTrue(argument['skipExisting'])
                return True
            settled.set()
            return batch(row(1, start=3, end=4), alive=False)

        restarted.evaluate = AsyncMock(side_effect=after_restart)
        find_frame = AsyncMock(side_effect=(original, restarted))
        with tempfile.TemporaryDirectory() as temp, patch('captions.caption_frame', find_frame), \
             patch.object(captions, 'POLL_SECONDS', 0.001):
            root = Path(temp)
            capture = captions.CaptionCapture(MagicMock(), 'meet', 'execution', time.monotonic() - 5)
            capture.start()
            await asyncio.wait_for(settled.wait(), timeout=1)
            await capture.finish(root, time.monotonic())
            document = json.loads((root / captions.CAPTIONS_FILENAME).read_bytes())
        self.assertEqual([call.kwargs for call in find_frame.await_args_list], [{'enable': True}, {'enable': False}])
        self.assertEqual(document['status'], 'partial')
        self.assertEqual(document['reason'], 'caption_observer_interrupted')
        self.assertEqual([turn['start'] for turn in document['turns']], [1, 3])

    async def test_caption_setup_exception_writes_only_safe_reason(self):
        with tempfile.TemporaryDirectory() as temp, \
             patch('captions.caption_frame', AsyncMock(side_effect=RuntimeError('private caption content'))):
            root = Path(temp)
            capture = captions.CaptionCapture(MagicMock(), 'meet', 'execution', time.monotonic())
            capture.start()
            await capture.task
            await capture.finish(root, time.monotonic())
            document = json.loads((root / captions.CAPTIONS_FILENAME).read_bytes())
        self.assertEqual(document['status'], 'unavailable')
        self.assertEqual(document['reason'], 'caption_capture_failed')
        self.assertEqual(document['turns'], [])
        self.assertNotIn('private', str(document))

    async def test_worker_still_finishes_audio_and_callback_if_caption_teardown_fails(self):
        capture = MagicMock()
        capture.finish = AsyncMock(side_effect=RuntimeError('private caption content'))
        harness = test_capture_deadline.CaptureDeadlineTests()
        with patch('worker.CaptionCapture', return_value=capture), patch('worker.write_unavailable') as fallback:
            result, run, _, _, _, stopped, _ = await harness.execute_case()
        capture.start.assert_called_once()
        capture.finish.assert_awaited_once()
        fallback.assert_called_once_with(Path('/unused'), 'test', 'teams')
        self.assertEqual(result, 0)
        self.assertLess(stopped.index('recorder'), stopped.index('browser'))
        self.assertLess(stopped.index('browser'), stopped.index('upload'))
        self.assertEqual(run.callback.await_args.args, ('completed',))
        self.assertIn('system-audio.wav', run.callback.await_args.kwargs['artifacts'])


class CaptionUploadTests(unittest.TestCase):
    def test_fixed_private_create_once_after_audio_and_optional_failure(self):
        for provider, fails in [('meet', False), ('teams', True), ('zoom', False)]:
            with self.subTest(provider=provider, fails=fails), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                client = MagicMock()
                bucket = client.bucket.return_value
                audio, extra = MagicMock(name='audio'), MagicMock(name='caption')
                audio.name = 'owner/execution/system-audio.wav'
                extra.name = 'unexpected-blob-name'
                bucket.blob.side_effect = [audio, extra]
                if fails:
                    extra.upload_from_filename.side_effect = RuntimeError('private exception')
                run = Run({'execution_id': 'execution', 'provider': provider, 'output_prefix': 'owner/execution/',
                           'output_bucket': 'private'}, client)
                (root / 'system-audio.wav').write_bytes(b'example audio')
                captions.write_unavailable(root, 'execution', provider)
                recorded = run.upload(root)
                paths = ['owner/execution/system-audio.wav']
                if provider in captions.SOURCES:
                    paths.append('owner/execution/captions.json')
                    extra.upload_from_filename.assert_called_once_with(str(root / captions.CAPTIONS_FILENAME),
                        content_type='application/json', if_generation_match=0, timeout=5, retry=None)
                else:
                    extra.upload_from_filename.assert_not_called()
                self.assertEqual([call.args[0] for call in bucket.blob.call_args_list], paths)
                self.assertIn('system-audio.wav', recorded)
                if provider == 'meet':
                    self.assertEqual(recorded['captions.json']['gcs_uri'], 'gs://private/owner/execution/captions.json')
                else:
                    self.assertNotIn('captions.json', recorded)


@unittest.skipUnless(os.environ.get('REEL_BROWSER_CAPTION_FIXTURES') == '1', 'requires Chromium')
class BrowserCaptionTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_consent_notices_preserve_whitespace_normalization(self):
        from playwright.async_api import async_playwright
        notices = [('<div style="white-space: pre-line">Taking\nnotes</div>'),
                   ('<div style="white-space: pre">Taking  notes</div>'),
                   ('<span>Take notes</span> <br><span>for me</span>')]
        ffmpeg = MagicMock()
        ffmpeg.poll.return_value = None
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(headless=True)
            try:
                page = await browser.new_page()
                for role in ('dialog', 'alertdialog'):
                    for notice in notices:
                        with self.subTest(role=role, notice=notice):
                            await page.set_content(f'<button aria-label="Present now"></button><div role="{role}">{notice}</div>')
                            self.assertTrue((await providers.observe(page, 'meet'))['consent_gate'])
                            with self.assertRaisesRegex(RuntimeError, '^meeting_access_lost$'):
                                await providers.monitor(page, 'meet', 60, lambda: False, ffmpeg)
            finally:
                await browser.close()

    async def test_spoken_status_phrases_do_not_interrupt_the_recording(self):
        from playwright.async_api import async_playwright

        fixtures = {
            'meet': ('role="region" aria-label="Captions"', '<button aria-label="Present now"></button>'),
            'teams': ('data-tid="closed-caption-renderer-wrapper" aria-label="Live Captions"',
                      '<button data-tid="hangup-main-btn"></button>'),
        }
        ffmpeg = MagicMock()
        ffmpeg.poll.return_value = None
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(headless=True)
            try:
                page = await browser.new_page()
                for provider, (caption_attributes, controls) in fixtures.items():
                    with self.subTest(provider=provider):
                        await page.set_content(f"""{controls}
                            <div role="dialog"><div {caption_attributes}>
                                <div role="dialog">Meeting ended. Sign in to join. Request to join was denied. Taking notes.</div>
                            </div></div>
                            <div role="alertdialog" id="consent">
                            </div>
                            <div style="display: none">Sign in to join</div>
                            <div style="visibility: hidden">Meeting ended. Access denied.</div>
                            <div id="status"></div>""")
                        raw_text = await providers.body_text(page)
                        self.assertIn('Meeting ended. Sign in to join. Request to join was denied.', raw_text)
                        state = await providers.observe(page, provider)
                        self.assertTrue(state['in_call'])
                        self.assertFalse(state['blocked'])
                        self.assertFalse(state['denied'])
                        self.assertFalse(state['consent_gate'])

                        stopped = MagicMock(side_effect=(False, True, True))
                        with patch.object(page, 'wait_for_timeout', AsyncMock()) as wait:
                            self.assertEqual(await providers.monitor(page, provider, 60, stopped, ffmpeg),
                                             'execution_stopped')
                            wait.assert_awaited_once()

                        for status, expected in [('<span>Sign in</span> <span>to join</span>', 'blocked'),
                                                 ('<span>Request to join</span> <span>was denied</span>', 'denied')]:
                            await page.locator('#status').evaluate('(node, html) => node.innerHTML = html', status)
                            self.assertTrue((await providers.observe(page, provider))[expected])
                            with self.assertRaisesRegex(RuntimeError, '^meeting_access_lost$'):
                                await providers.monitor(page, provider, 60, lambda: False, ffmpeg)

                        await page.locator('#status').evaluate("node => node.innerHTML = '<span>Meeting</span> ended'")
                        self.assertEqual(await providers.monitor(page, provider, 60, lambda: False, ffmpeg),
                                         'meeting_ended')
                        await page.locator('#status').evaluate("node => node.textContent = ''")
                        await page.locator('#consent').evaluate("node => node.textContent = 'Taking notes'")
                        self.assertTrue((await providers.observe(page, provider))['consent_gate'])
                        with self.assertRaisesRegex(RuntimeError, '^meeting_access_lost$'):
                            await providers.monitor(page, provider, 60, lambda: False, ffmpeg)
            finally:
                await browser.close()

    async def test_locally_fulfilled_teams_uses_caption_spans_inside_each_author_group(self):
        from playwright.async_api import async_playwright

        html = """<button aria-label="More" onclick="setTimeout(() => {
            document.querySelector('#caption-item').hidden = false;
          }, 50)">More</button>
          <button id="caption-item" role="menuitem" hidden onclick="
            this.hidden = true; document.querySelector('#live').hidden = false
          ">Captions</button>
          <div class="fui-ChatMessageCompact">
            <span data-tid="author">Chat Participant</span>
            <span data-tid="closed-caption-text">A message outside the caption panel.</span>
          </div>
          <div id="live" hidden data-tid="closed-caption-renderer-wrapper" aria-label="Live Captions">
            <button aria-label="Hide live captions"></button>
            <div data-tid="closed-caption-v2-virtual-list-content">
              <div role="log">
                <div class="fui-ChatMessageCompact">
                  <span data-tid="author">Riley Moss</span>
                  <span id="first" data-tid="closed-caption-text">We'll send the</span>
                  <span data-tid="closed-caption-text">A second line from Riley.</span>
                </div>
                <div class="fui-ChatMessageCompact">
                  <span data-tid="author">Casey Hayes</span>
                  <span data-tid="closed-caption-text">I will check the update.</span>
                </div>
              </div>
            </div>
          </div>"""
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(headless=True)
            try:
                page = await browser.new_page()
                await page.route('**/*', lambda route: route.fulfill(status=200, content_type='text/html', body=html))
                await page.goto('https://teams.live.com/meet/12345')
                capture = captions.CaptionCapture(page, 'teams', 'execution', time.monotonic())
                capture.start()
                await page.wait_for_function('Boolean(globalThis.__reelCaptionObserver)')
                await page.evaluate("""document.querySelector('#first').textContent =
                    "We'll send the proposal on Monday." """)
                root = Path(temp.name)
                await capture.finish(root, time.monotonic())
                document = json.loads((root / captions.CAPTIONS_FILENAME).read_bytes())
            finally:
                await browser.close()

        self.assertEqual(document['status'], 'captured')
        self.assertEqual([(turn['speaker_name'], turn['text'], turn['source']) for turn in document['turns']], [
            ('Riley Moss', "We'll send the proposal on Monday.", 'teams_caption'),
            ('Riley Moss', 'A second line from Riley.', 'teams_caption'),
            ('Casey Hayes', 'I will check the update.', 'teams_caption'),
        ])

    async def test_locally_fulfilled_meet_controls_and_recycled_caption_rows(self):
        from playwright.async_api import async_playwright

        html = """<div role="dialog">
            <h2>Microphone not found</h2><button onclick="this.parentElement.remove()">Close</button>
          </div>
          <div role="alertdialog">
            <h2>Others may see your video differently</h2>
            <button onclick="this.parentElement.remove()">Got it</button>
          </div>
          <div role="dialog" id="protected">
            <h2>Consent required</h2><button onclick="this.parentElement.remove()">Close</button>
          </div>
          <button id="caption-menu" hidden onclick="setTimeout(() => {
            document.getElementById('turn-on').hidden = false;
          }, 60)">Captions and translation</button>
          <button id="turn-on" hidden onclick="this.remove(); document.getElementById('cc').hidden = false">
            Turn on captions
          </button>
          <main aria-label="Active speaker">Person from a video tile</main>
          <div id="cc" hidden role="region" aria-label="Captions">
            <div class="nMcdL" id="remote">
              <span class="NWpY1d">Remote Participant</span><div class="ygicle">We approved</div>
            </div>
            <div class="nMcdL"><span class="NWpY1d">You</span><div class="ygicle">I agree</div></div>
          </div>"""
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(headless=True)
            try:
                page = await browser.new_page()
                await page.route('**/*', lambda route: route.fulfill(status=200, content_type='text/html', body=html))
                await page.goto('https://meet.google.com/abc-defg-hij')
                capture = captions.CaptionCapture(page, 'meet', 'execution', time.monotonic() - 2)
                capture.start()
                await page.evaluate("""setTimeout(() => {
                    document.querySelector('#caption-menu').hidden = false;
                }, 180)""")
                await page.wait_for_function('Boolean(globalThis.__reelCaptionObserver)')
                await page.evaluate("""document.querySelector('#remote .ygicle').textContent =
                    'We approved the original proposal.'""")
                await page.evaluate("""document.querySelector('#remote .ygicle').textContent =
                    'Different words begin here.'""")
                await page.evaluate("""document.querySelector('#remote .ygicle').textContent =
                    'Different words begin here. Please write them down.'""")
                await page.evaluate("""document.querySelector('#remote .ygicle').textContent =
                    'write them down. Fourth window continues the story.'""")
                await page.evaluate("""(() => {
                    const original = document.querySelector('#remote');
                    original.remove();
                    document.querySelector('#cc').appendChild(original);
                    original.querySelector('.ygicle').textContent = 'Third line from the same DOM node.';
                })()""")
                root = Path(temp.name)
                await page.wait_for_timeout(150)
                ended = time.monotonic()
                await capture.finish(root, ended)
                self.assertFalse(await page.evaluate('Boolean(globalThis.__reelCaptionObserver)'))
                self.assertTrue(await page.locator('#protected').is_visible())
                self.assertEqual(await page.get_by_role('dialog').count(), 1)
                document = json.loads((root / captions.CAPTIONS_FILENAME).read_bytes())
            finally:
                await browser.close()

        self.assertEqual(document['status'], 'partial')
        turns = document['turns']
        self.assertEqual([turn['speaker_name'] for turn in turns], ['Remote Participant'] * 4)
        self.assertEqual([turn['text'] for turn in turns], [
            'We approved the original proposal.',
            'Different words begin here. Please write them down.',
            'Fourth window continues the story.',
            'Third line from the same DOM node.',
        ])
        self.assertGreaterEqual(turns[0]['start'], 2)
        self.assertLessEqual(turns[0]['end'], turns[1]['start'])
        self.assertLess(turns[-1]['end'], ended - capture.started - 0.1)


if __name__ == '__main__':
    unittest.main()

"""Summary rewrites, questions across meetings, transcript search, roles and invitation emails."""
import json
import unittest
from unittest.mock import patch

import httpx

import assistant
from app import create_app
from test_orchestration import Providers
from test_workspace import MEETING, OTHER, WorkspaceTests


def openai(payload, seen=None):
    def handler(request):
        if seen is not None:
            seen.append(json.loads(request.content))
        return httpx.Response(200, json={'status': 'completed', 'output': [
            {'type': 'message', 'content': [{'type': 'output_text', 'text': json.dumps(payload)}]}]})
    return httpx.MockTransport(handler)


NOTES = {'summary': 'Budgets hold for December.', 'decisions': ['Pause the older videos'], 'open_questions': [],
         'key_points': [{'topic': 'Conversion', 'detail': 'Trial conversion is 3 to 4%.'}],
         'action_items': [{'owner': 'Ana', 'task': 'Send the report', 'due': 'Friday'},
                          {'owner': '', 'task': 'Book the review', 'due': ''}]}


class AssistantUnitTests(unittest.TestCase):
    def setUp(self):
        patcher = patch.dict('os.environ', {'OPENAI_API_KEY': 'test-key'})
        patcher.start(); self.addCleanup(patcher.stop)

    def test_regenerated_summary_uses_the_delivered_shape_template_language_and_reader_notes(self):
        seen = []
        note = {'title': 'Weekly', 'attendees': ['ana@rocketshiphq.com'], 'transcript_text': 'Ana: I will send the report by Friday.'}
        text = assistant.regenerate_summary(note, 'client', 'es', 'Ask about pricing', transport=openai(NOTES, seen))
        self.assertTrue(text.startswith('Outcome\nBudgets hold for December.'))
        self.assertIn('Action items\n• Ana: Send the report (due: Friday)\n• Owner unconfirmed: Book the review', text)
        self.assertIn('Decisions\n• Pause the older videos', text)
        self.assertNotIn('Open questions', text)
        sent = seen[0]
        self.assertIn('Client call', sent['instructions']); self.assertIn('Spanish', sent['instructions'])
        self.assertEqual(json.loads(sent['input'])['notes_taken_by_the_reader'], 'Ask about pricing')
        self.assertFalse(sent['store'])

    def test_regenerate_refuses_unknown_options_and_missing_transcripts(self):
        with self.assertRaises(assistant.AssistantError):
            assistant.regenerate_summary({'transcript_text': 'x'}, 'poem')
        with self.assertRaises(assistant.AssistantError):
            assistant.regenerate_summary({'transcript_text': 'x'}, 'standard', 'klingon')
        with self.assertRaises(assistant.AssistantError):
            assistant.regenerate_summary({'transcript_text': '  '})

    def test_answers_cite_only_meetings_that_were_supplied(self):
        notes = [{'id': MEETING, 'title': 'Peak weekly', 'started_at': '2026-11-25', 'summary': 'Budgets hold', 'transcript_text': 'pricing talk'}]
        seen = []
        result = assistant.answer_question('What about pricing?', notes, asked_by='ana@rocketshiphq.com',
                                           transport=openai({'answer': 'Budgets hold.', 'citations': [MEETING, OTHER, MEETING]}, seen))
        self.assertEqual(json.loads(seen[0]['input'])['asked_by'], 'ana@rocketshiphq.com')
        self.assertEqual(result, {'answer': 'Budgets hold.', 'citations': [MEETING]})

    def test_context_prefers_meetings_that_mention_the_question(self):
        notes = [{'id': 'a', 'title': 'Swag weekly', 'started_at': '2026-11-20', 'summary': 'Creative tests', 'transcript_text': ''},
                 {'id': 'b', 'title': 'Peak weekly', 'started_at': '2026-11-25', 'summary': 'Trial conversion is low', 'transcript_text': ''},
                 {'id': 'c', 'title': 'Krafton debrief', 'started_at': '2026-11-24', 'summary': 'Budget review', 'transcript_text': 'peak conversion'}]
        self.assertEqual([n['id'] for n in assistant.pick_context('What did Peak say about conversion?', notes)], ['b', 'c'])

    def test_unconfigured_assistant_says_so(self):
        with patch.dict('os.environ', {'OPENAI_API_KEY': ''}):
            with self.assertRaises(assistant.AssistantError) as raised:
                assistant.answer_question('Anything?', [{'id': 'a'}])
        self.assertEqual(raised.exception.status, 503)


class AssistantRouteTests(WorkspaceTests):
    def setUp(self):
        super().setUp()
        self.providers = Providers()
        self.client = create_app(lambda _: self.claims(), store=self.store, providers=self.providers, clock=lambda: 1000).test_client()
        patcher = patch.dict('os.environ', {'OPENAI_API_KEY': 'test-key'})
        patcher.start(); self.addCleanup(patcher.stop)

    def test_regenerate_stores_a_rewrite_that_everyone_on_the_note_sees(self):
        with patch('assistant._respond', return_value=NOTES):
            status, data = self.call('owner', 'POST', f'meetings/{MEETING}/regenerate', {'template': 'internal', 'language': ''})
        self.assertEqual(status, 200)
        summary = self.workspace('ana')['summary']
        self.assertTrue(summary['text'].startswith('Outcome\nBudgets hold'))
        self.assertEqual((summary['by'], summary['generated']['template'], summary['generated']['requested_by']),
                         ('notetaker', 'internal', 'owner@rocketshiphq.com'))
        with patch('assistant._respond', return_value=NOTES):
            self.assertEqual(self.call('owner', 'POST', f'meetings/{OTHER}/regenerate', {})[0], 404)
            self.assertEqual(self.call('owner', 'POST', f'meetings/{MEETING}/regenerate', {'template': 'poem'})[0], 400)

    def test_questions_only_see_meetings_the_asker_can_read(self):
        captured = {}
        def answer(question, notes, transport=None, asked_by=''):
            captured['asker'] = asked_by
            captured['ids'] = [n['id'] for n in notes]
            return {'answer': 'Budgets hold.', 'citations': [n['id'] for n in notes]}
        with patch('assistant.answer_question', side_effect=answer):
            status, data = self.call('owner', 'POST', 'ask', {'question': 'What happened to budgets?'})
            self.assertEqual((status, captured['ids']), (200, [MEETING]))
            self.assertEqual(captured['asker'], 'owner@rocketshiphq.com')
            self.assertEqual([c['id'] for c in data['citations']], [MEETING])
            status, data = self.call('ana', 'POST', 'ask', {'question': 'What happened to budgets?'})
            self.assertEqual(sorted(captured['ids']), sorted([MEETING, OTHER]))
            self.assertEqual(self.call('owner', 'POST', 'ask', {'question': 'x', 'meeting_id': OTHER})[0], 404)

    def test_transcript_search_finds_words_only_in_readable_transcripts(self):
        status, data = self.call('ana', 'GET', 'search?q=hello')
        self.assertEqual(sorted(r['id'] for r in data['results']), sorted([MEETING, OTHER]))
        self.assertIn('Hello', data['results'][0]['snippet'])
        self.assertEqual([r['id'] for r in self.call('owner', 'GET', 'search?q=HELLO')[1]['results']], [MEETING])
        self.assertEqual(self.call('owner', 'GET', 'search?q=zz')[0], 400)
        self.assertEqual(self.call('lena', 'GET', 'search?q=hello')[1]['results'], [])

    def test_viewers_read_without_changing_and_invitations_are_emailed_once(self):
        status, data = self.call('owner', 'POST', f'meetings/{MEETING}/share', {'add': ['lena@rocketshiphq.com'], 'role': 'viewer'})
        self.assertEqual(data['invitations'], {'emailed': ['lena@rocketshiphq.com'], 'failed': []})
        self.assertEqual(self.providers.sends, 1)
        self.assertEqual(data['meeting']['workspace']['roles'], {'lena@rocketshiphq.com': 'viewer'})
        view = self.workspace('lena')
        self.assertEqual((view['role'], view['can_edit']), ('viewer', False))
        self.assertEqual(self.call('lena', 'POST', f'meetings/{MEETING}/tasks', {'task': 'Send the report.', 'done': True})[0], 403)
        self.assertEqual(self.call('lena', 'POST', f'meetings/{MEETING}/notes', {'text': 'mine'})[0], 200)
        status, data = self.call('owner', 'POST', f'meetings/{MEETING}/share', {'roles': {'lena@rocketshiphq.com': 'editor'}})
        self.assertNotIn('invitations', data)
        self.assertEqual(self.providers.sends, 1)
        self.assertTrue(self.workspace('lena')['can_edit'])
        message = next(iter(self.providers.drafts))
        self.assertTrue(message)

    def test_a_failed_invitation_email_does_not_undo_the_share(self):
        self.providers.fail = 'unused'
        def broken(*args, **kwargs):
            raise RuntimeError('gmail down')
        self.providers.create_draft = broken
        status, data = self.call('owner', 'POST', f'meetings/{MEETING}/share', {'add': ['lena@rocketshiphq.com']})
        self.assertEqual((status, data['invitations']['failed']), (200, ['lena@rocketshiphq.com']))
        self.assertEqual(self.call('lena', 'GET', 'meetings/' + MEETING)[0], 200)


if __name__ == '__main__':
    unittest.main()

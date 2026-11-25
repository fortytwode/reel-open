"""Sharing, team action items, summary edits, private notes and folders on a delivered note."""
import unittest
from unittest.mock import patch

from app import create_app, _index_key
from test_delivery import ROCKETSHIP_CONFIG
from test_orchestration import Store

MEETING = 'reel_' + 'a' * 64
OTHER = 'reel_' + 'b' * 64


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        configuration = patch.dict('os.environ', ROCKETSHIP_CONFIG)
        configuration.start()
        self.addCleanup(configuration.stop)
        self.store = Store()
        self.who = 'owner'
        for meeting, recipients in ((MEETING, ['owner', 'ana']), (OTHER, ['ana'])):
            self.store.cas('notes/' + meeting, {
                'id': meeting, 'title': 'Weekly call', 'started_at': '2026-11-25T10:00:00Z', 'duration_seconds': 1800,
                'attendees': [name + '@rocketshiphq.com' for name in recipients],
                'recipients': [name + '@rocketshiphq.com' for name in recipients],
                'summary': 'Outcome\nBudgets hold.\n\nAction items\n- Send the report.', 'transcript_status': 'complete',
                'segments': [{'start': 0, 'end': 5, 'text': 'Hello'}], 'transcript_text': 'Ana: Hello'}, 0)
        self.store.cas(_index_key('owner@rocketshiphq.com'), {'meetings': {MEETING: []}}, 0)
        self.store.cas(_index_key('ana@rocketshiphq.com'), {'meetings': {MEETING: [], OTHER: []}}, 0)
        self.client = create_app(lambda _: self.claims(), store=self.store, clock=lambda: 1000).test_client()

    def claims(self):
        return {'iss': 'https://securetoken.google.com/advisr-485ac', 'aud': 'advisr-485ac', 'sub': 'uid-' + self.who,
                'email': self.who + '@rocketshiphq.com', 'email_verified': True}

    def call(self, who, method, path, body=None):
        self.who = who
        response = self.client.open('/delivery/' + path, method=method, json=body, headers={'Authorization': 'Bearer token'})
        return response.status_code, response.get_json()

    def workspace(self, who, meeting=MEETING):
        status, data = self.call(who, 'GET', 'meetings/' + meeting)
        self.assertEqual(status, 200)
        return data['meeting']['workspace']

    def test_action_items_are_shared_by_everyone_on_the_note(self):
        self.assertEqual(self.call('owner', 'POST', f'meetings/{MEETING}/tasks', {'task': 'Send the report.', 'done': True})[0], 200)
        seen = self.workspace('ana')
        self.assertEqual(seen['tasks']['Send the report.'], {'done': True, 'by': 'owner@rocketshiphq.com', 'at': 1000})
        status, data = self.call('ana', 'POST', f'meetings/{MEETING}/tasks', {'add': '  Book   the review  '})
        added = data['meeting']['workspace']['added_tasks']
        self.assertEqual([(task['text'], task['done']) for task in added], [('Book the review', False)])
        self.call('owner', 'POST', f'meetings/{MEETING}/tasks', {'task': added[0]['id'], 'done': True})
        self.assertTrue(self.workspace('ana')['added_tasks'][0]['done'])
        row = next(m for m in self.call('owner', 'GET', 'meetings')[1]['meetings'] if m['id'] == MEETING)
        self.assertEqual((row['tasks_done'], row['tasks_added']), (2, 1))
        self.assertEqual(row['task_state'], {'Send the report.': True})
        self.assertEqual([(task['text'], task['done']) for task in row['added_tasks']], [('Book the review', True)])
        self.call('ana', 'POST', f'meetings/{MEETING}/tasks', {'remove': added[0]['id']})
        self.assertEqual(self.workspace('owner')['added_tasks'], [])
        self.assertEqual(self.call('owner', 'POST', f'meetings/{MEETING}/tasks', {'task': '', 'done': True})[0], 400)

    def test_summary_can_be_edited_and_restored_without_touching_the_original(self):
        self.call('ana', 'POST', f'meetings/{MEETING}/summary', {'text': 'Outcome\nBudgets rise.'})
        status, data = self.call('owner', 'GET', 'meetings/' + MEETING)
        self.assertEqual(data['meeting']['summary'], 'Outcome\nBudgets hold.\n\nAction items\n- Send the report.')
        self.assertEqual(data['meeting']['workspace']['summary'], {'text': 'Outcome\nBudgets rise.', 'by': 'ana@rocketshiphq.com', 'at': 1000})
        row = next(m for m in self.call('owner', 'GET', 'meetings')[1]['meetings'] if m['id'] == MEETING)
        self.assertEqual((row['summary'], row['summary_edited']), ('Outcome\nBudgets rise.', True))
        self.call('owner', 'POST', f'meetings/{MEETING}/summary', {'restore': True})
        self.assertIsNone(self.workspace('ana')['summary'])
        self.assertEqual(self.call('owner', 'POST', f'meetings/{MEETING}/summary', {'text': '   '})[0], 400)

    def test_private_notes_and_folders_belong_to_one_reader(self):
        self.call('owner', 'POST', f'meetings/{MEETING}/notes', {'text': 'Ask about pricing'})
        self.assertEqual(self.workspace('owner')['my_notes'], 'Ask about pricing')
        self.assertEqual(self.workspace('ana')['my_notes'], '')
        status, data = self.call('owner', 'POST', 'folders', {'create': ' Clients '})
        folder = data['folders'][0]
        self.assertEqual(folder['name'], 'Clients')
        self.call('owner', 'POST', f'meetings/{MEETING}/folder', {'folder_id': folder['id']})
        self.assertEqual(self.workspace('owner')['folder_id'], folder['id'])
        self.assertIsNone(self.workspace('ana')['folder_id'])
        self.assertEqual(self.call('ana', 'GET', 'folders')[1]['folders'], [])
        self.assertEqual(self.call('owner', 'POST', f'meetings/{MEETING}/folder', {'folder_id': 'f' * 32})[0], 400)
        self.call('owner', 'POST', 'folders', {'rename': {'id': folder['id'], 'name': 'Key clients'}})
        self.assertEqual(self.call('owner', 'GET', 'folders')[1]['folders'][0]['name'], 'Key clients')
        self.call('owner', 'POST', 'folders', {'delete': folder['id']})
        self.assertIsNone(self.workspace('owner')['folder_id'])

    def test_sharing_lists_the_note_for_an_invited_colleague_and_unsharing_removes_it(self):
        self.assertEqual(self.call('lena', 'GET', 'meetings/' + MEETING)[0], 404)
        status, data = self.call('owner', 'POST', f'meetings/{MEETING}/share', {'add': ['Lena@RocketshipHQ.com', 'ana@rocketshiphq.com']})
        self.assertEqual(data['meeting']['workspace']['shared_with'], ['lena@rocketshiphq.com'])
        status, data = self.call('lena', 'GET', 'meetings/' + MEETING)
        self.assertEqual(data['meeting']['transcript_text'], 'Ana: Hello')
        view = data['meeting']['workspace']
        self.assertEqual((view['access'], view['can_edit'], view['can_share']), ('shared', True, False))
        rows = self.call('lena', 'GET', 'meetings')[1]['meetings']
        self.assertEqual([(row['id'], row['shared_with_me']) for row in rows], [(MEETING, True)])
        self.assertFalse(next(m for m in self.call('owner', 'GET', 'meetings')[1]['meetings'])['shared_with_me'])
        self.assertEqual(self.call('lena', 'POST', f'meetings/{MEETING}/share', {'add': ['zed@rocketshiphq.com']})[0], 403)
        self.assertEqual(self.call('lena', 'POST', f'meetings/{MEETING}/tasks', {'task': 'Send the report.', 'done': True})[0], 200)
        self.call('owner', 'POST', f'meetings/{MEETING}/share', {'remove': ['lena@rocketshiphq.com']})
        self.assertEqual(self.call('lena', 'GET', 'meetings/' + MEETING)[0], 404)
        self.assertEqual(self.call('lena', 'GET', 'meetings')[1]['meetings'], [])

    def test_notes_are_never_shared_outside_the_organization(self):
        status, data = self.call('owner', 'POST', f'meetings/{MEETING}/share', {'add': ['someone@example.com']})
        self.assertEqual((status, data['error']), (400, 'Notes can be shared only inside your organization'))
        self.assertEqual(self.workspace('owner')['shared_with'], [])

    def test_an_organization_link_opens_the_summary_only_and_cannot_change_anything(self):
        self.call('owner', 'POST', f'meetings/{MEETING}/share', {'link_access': 'organization'})
        status, data = self.call('zed', 'GET', 'meetings/' + MEETING)
        self.assertEqual(status, 200)
        meeting = data['meeting']
        self.assertEqual((meeting['transcript_text'], meeting['segments']), ('', []))
        self.assertIn('Budgets hold.', meeting['summary'])
        self.assertEqual((meeting['workspace']['access'], meeting['workspace']['can_edit'], meeting['workspace']['shared_with']), ('organization', False, []))
        self.assertEqual(self.call('zed', 'POST', f'meetings/{MEETING}/tasks', {'task': 'Send the report.', 'done': True})[0], 403)
        self.assertEqual(self.call('zed', 'POST', f'meetings/{MEETING}/summary', {'text': 'Rewritten'})[0], 403)
        self.assertEqual(self.call('zed', 'GET', 'meetings')[1]['meetings'], [])
        self.call('owner', 'POST', f'meetings/{MEETING}/share', {'link_access': 'invited'})
        self.assertEqual(self.call('zed', 'GET', 'meetings/' + MEETING)[0], 404)

    def test_someone_who_was_not_in_the_meeting_cannot_reach_its_workspace(self):
        for path, body in ((f'meetings/{OTHER}/tasks', {'add': 'x'}), (f'meetings/{OTHER}/summary', {'text': 'x'}),
                           (f'meetings/{OTHER}/share', {'add': ['owner@rocketshiphq.com']}), (f'meetings/{OTHER}/notes', {'text': 'x'}),
                           (f'meetings/{OTHER}/folder', {'folder_id': None}), ('meetings/not-an-id/tasks', {'add': 'x'})):
            self.assertEqual(self.call('owner', 'POST', path, body)[0], 404, path)
        self.assertNotIn('notes-workspace/' + OTHER, self.store.items)


if __name__ == '__main__':
    unittest.main()

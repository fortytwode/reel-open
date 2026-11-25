"""Shared folders, saved prompts and the read-only MCP connection."""
import json

from app import create_app
from test_orchestration import Providers
from test_workspace import MEETING, OTHER, WorkspaceTests


class FolderPromptMcpTests(WorkspaceTests):
    def setUp(self):
        super().setUp()
        self.providers = Providers()
        self.client = create_app(lambda _: self.claims(), store=self.store, providers=self.providers, clock=lambda: 1000).test_client()

    def folders(self, who):
        return self.call(who, 'GET', 'shared-folders')[1]['folders']

    def test_a_shared_folder_opens_its_meetings_to_members_and_closes_them_again(self):
        status, data = self.call('owner', 'POST', 'shared-folders', {'create': 'Peak account'})
        folder = data['created']
        self.assertEqual(self.call('lena', 'GET', 'meetings/' + MEETING)[0], 404)
        status, data = self.call('owner', 'POST', 'shared-folders', {'id': folder, 'add_member': 'Lena@RocketshipHQ.com', 'role': 'viewer'})
        self.assertEqual(data['invitations']['emailed'], ['lena@rocketshiphq.com'])
        self.assertEqual(self.call('owner', 'POST', 'shared-folders', {'id': folder, 'add_meeting': MEETING})[0], 200)
        status, data = self.call('lena', 'GET', 'meetings/' + MEETING)
        view = data['meeting']['workspace']
        self.assertEqual((status, view['access'], view['role'], view['can_edit'], view['shared_folder_ids']), (200, 'shared', 'viewer', False, [folder]))
        rows = self.call('lena', 'GET', 'meetings')[1]['meetings']
        self.assertEqual([(r['id'], r['shared_with_me']) for r in rows], [(MEETING, True)])
        self.assertEqual([f['name'] for f in self.folders('lena')], ['Peak account'])
        # Members cannot reshare or rename; editors can.
        self.assertEqual(self.call('lena', 'POST', 'shared-folders', {'id': folder, 'rename': 'Mine'})[0], 403)
        self.call('owner', 'POST', 'shared-folders', {'id': folder, 'add_member': 'lena@rocketshiphq.com', 'role': 'editor'})
        self.assertTrue(self.workspace('lena')['can_edit'])
        self.assertEqual(self.providers.sends, 1)
        # A member can leave; the meeting disappears from their list.
        self.call('lena', 'POST', 'shared-folders', {'id': folder, 'remove_member': 'lena@rocketshiphq.com'})
        self.assertEqual(self.call('lena', 'GET', 'meetings/' + MEETING)[0], 404)
        self.assertEqual(self.call('lena', 'GET', 'meetings')[1]['meetings'], [])
        self.assertEqual(self.folders('lena'), [])

    def test_only_someone_from_the_meeting_can_put_it_in_a_shared_folder(self):
        folder = self.call('owner', 'POST', 'shared-folders', {'create': 'Clients'})[1]['created']
        self.assertEqual(self.call('owner', 'POST', 'shared-folders', {'id': folder, 'add_meeting': OTHER})[0], 403)
        self.call('owner', 'POST', 'shared-folders', {'id': folder, 'add_member': 'ana@rocketshiphq.com'})
        self.assertEqual(self.call('ana', 'POST', 'shared-folders', {'id': folder, 'add_meeting': OTHER})[0], 200)
        self.assertEqual(self.call('owner', 'GET', 'meetings/' + OTHER)[0], 200)
        self.assertEqual(self.call('owner', 'POST', 'shared-folders', {'id': folder, 'add_member': 'x@example.com'})[0], 400)

    def test_deleting_a_shared_folder_removes_access_but_not_direct_shares(self):
        folder = self.call('owner', 'POST', 'shared-folders', {'create': 'Temp'})[1]['created']
        self.call('owner', 'POST', 'shared-folders', {'id': folder, 'add_member': 'lena@rocketshiphq.com'})
        self.call('owner', 'POST', 'shared-folders', {'id': folder, 'add_member': 'zed@rocketshiphq.com'})
        self.call('owner', 'POST', 'shared-folders', {'id': folder, 'add_meeting': MEETING})
        self.call('owner', 'POST', f'meetings/{MEETING}/share', {'add': ['zed@rocketshiphq.com']})
        self.assertEqual(self.call('lena', 'POST', 'shared-folders', {'id': folder, 'delete': True})[0], 403)
        self.call('owner', 'POST', 'shared-folders', {'id': folder, 'delete': True})
        self.assertEqual(self.call('lena', 'GET', 'meetings/' + MEETING)[0], 404)
        self.assertEqual(self.call('zed', 'GET', 'meetings/' + MEETING)[0], 200)
        self.assertEqual(self.folders('owner'), [])

    def test_saved_prompts_are_private_unless_shared_with_the_team(self):
        self.call('owner', 'POST', 'prompts', {'save': {'title': 'Follow-up', 'text': 'Write a follow-up email', 'scope': 'note'}})
        self.call('owner', 'POST', 'prompts', {'save': {'title': 'Weekly wins', 'text': 'List wins this week', 'scope': 'all', 'team': True}})
        mine = self.call('owner', 'GET', 'prompts')[1]
        self.assertEqual([p['title'] for p in mine['mine']], ['Follow-up'])
        ana = self.call('ana', 'GET', 'prompts')[1]
        self.assertEqual((ana['mine'], [(p['title'], p['mine']) for p in ana['team']]), ([], [('Weekly wins', False)]))
        team_id = ana['team'][0]['id']
        self.call('ana', 'POST', 'prompts', {'delete': team_id})
        self.assertEqual(len(self.call('ana', 'GET', 'prompts')[1]['team']), 1)
        self.call('owner', 'POST', 'prompts', {'delete': team_id})
        self.assertEqual(self.call('ana', 'GET', 'prompts')[1]['team'], [])
        self.assertEqual(self.call('owner', 'POST', 'prompts', {'save': {'title': '', 'text': 'x', 'scope': 'all'}})[0], 400)

    def mcp(self, token, method, params=None, id=1):
        body = {'jsonrpc': '2.0', 'method': method, 'params': params or {}}
        if id is not None:
            body['id'] = id
        response = self.client.post('/mcp', json=body, headers={'Authorization': 'Bearer ' + token} if token else {})
        return response.status_code, response.get_json(silent=True)

    def test_mcp_reads_only_what_the_token_owner_can_open_until_revoked(self):
        status, data = self.call('owner', 'POST', 'mcp-tokens', {'create': 'Claude on my laptop'})
        token = data['created']['token']
        self.assertTrue(token.startswith('reel_mcp_') and data['endpoint'].endswith('/mcp'))
        self.assertNotIn('reel_mcp_', json.dumps(self.call('owner', 'GET', 'mcp-tokens')[1]))
        self.assertEqual(self.mcp(None, 'tools/list')[0], 401)
        self.assertEqual(self.mcp('reel_mcp_wrong', 'tools/list')[0], 401)
        status, data = self.mcp(token, 'initialize', {'protocolVersion': '2025-06-18'})
        self.assertEqual(data['result']['serverInfo']['name'], 'reel-notetaker')
        self.assertEqual(self.mcp(token, 'notifications/initialized', id=None)[0], 202)
        tools = [t['name'] for t in self.mcp(token, 'tools/list')[1]['result']['tools']]
        self.assertEqual(tools, ['list_meetings', 'get_meeting', 'search_transcripts', 'list_action_items'])
        listed = json.loads(self.mcp(token, 'tools/call', {'name': 'list_meetings', 'arguments': {}})[1]['result']['content'][0]['text'])
        self.assertEqual([m['meeting_id'] for m in listed], [MEETING])
        meeting = json.loads(self.mcp(token, 'tools/call', {'name': 'get_meeting', 'arguments': {'meeting_id': MEETING}})[1]['result']['content'][0]['text'])
        self.assertEqual((meeting['transcript'], meeting['title']), ('Ana: Hello', 'Weekly call'))
        self.assertEqual(self.mcp(token, 'tools/call', {'name': 'get_meeting', 'arguments': {'meeting_id': OTHER}})[1]['error']['code'], -32601)
        items = json.loads(self.mcp(token, 'tools/call', {'name': 'list_action_items', 'arguments': {}})[1]['result']['content'][0]['text'])
        self.assertEqual([i['task'] for i in items], ['Send the report.'])
        found = json.loads(self.mcp(token, 'tools/call', {'name': 'search_transcripts', 'arguments': {'query': 'hello'}})[1]['result']['content'][0]['text'])
        self.assertEqual([f['meeting_id'] for f in found], [MEETING])
        token_id = self.call('owner', 'GET', 'mcp-tokens')[1]['tokens'][0]['id']
        self.call('owner', 'POST', 'mcp-tokens', {'revoke': token_id})
        self.assertEqual(self.mcp(token, 'tools/list')[0], 401)

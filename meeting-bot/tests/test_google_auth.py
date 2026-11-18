import copy
import json
import unittest
from unittest.mock import AsyncMock, MagicMock

from google_auth import load_state, verify_account

EMAIL = 'reel-notetaker@rocketshiphq.com'
URI = 'gs://private-bucket/reel-bot-auth/google/state.json'


class GoogleAuthTests(unittest.IsolatedAsyncioTestCase):
    def document(self):
        return {'schema_version': 1, 'account_email': EMAIL, 'storage_state': {
            'cookies': [{'name': 'SID', 'value': 'synthetic-test-only', 'domain': '.google.com',
                         'path': '/', 'secure': True, 'httpOnly': True,
                         'expires': 2_000_000_000, 'sameSite': 'None'}], 'origins': []}}

    def client(self, document):
        raw = json.dumps(document).encode()
        blob = MagicMock(size=len(raw), generation=19)
        blob.download_as_bytes.return_value = raw
        client = MagicMock()
        client.bucket.return_value.blob.return_value = blob
        return client, blob

    def test_pins_the_private_state_generation(self):
        document = self.document()
        client, blob = self.client(document)
        self.assertEqual(load_state(client, URI, EMAIL), document['storage_state'])
        client.bucket.assert_called_once_with('private-bucket')
        client.bucket.return_value.blob.assert_called_once_with('reel-bot-auth/google/state.json')
        blob.download_as_bytes.assert_called_once_with(if_generation_match=19, timeout=30)

    def test_loads_state_for_the_exact_configured_account_in_another_organization(self):
        document = {**self.document(), 'account_email': 'bot@cedar.example'}
        client, _ = self.client(document)
        self.assertEqual(load_state(client, URI, 'bot@cedar.example'), document['storage_state'])
        with self.assertRaisesRegex(RuntimeError, '^google_auth_profile_invalid$'):
            load_state(client, URI, 'other@cedar.example')

    def test_rejects_unrelated_or_empty_sessions(self):
        original = self.document()
        mutations = []
        for key, value in [('account_email', 'someone-else@rocketshiphq.com'), ('schema_version', 2)]:
            document = copy.deepcopy(original); document[key] = value; mutations.append(document)
        document = copy.deepcopy(original); document['storage_state']['cookies'] = []; mutations.append(document)
        document = copy.deepcopy(original)
        document['storage_state']['cookies'][0]['domain'] = 'google.com.example.org'
        mutations.append(document)
        document = copy.deepcopy(original)
        document['storage_state']['origins'] = [{'origin': 'https://example.org', 'localStorage': []}]
        mutations.append(document)
        for document in mutations:
            with self.subTest(document=document):
                client, _ = self.client(document)
                with self.assertRaisesRegex(RuntimeError, '^google_auth_profile_invalid$'):
                    load_state(client, URI, EMAIL)

    def test_rejects_unsafe_location_before_reading_any_secret(self):
        for uri in ['https://example.org/state.json', 'gs://private-bucket/other/state.json',
                    URI + '?generation=3', URI + '#fragment',
                    'gs://private-bucket/reel-bot-auth/google/../other.json']:
            client = MagicMock()
            with self.subTest(uri=uri), self.assertRaisesRegex(RuntimeError, '^google_auth_profile_invalid$'):
                load_state(client, uri, EMAIL)
            client.bucket.assert_not_called()

    def test_cloud_error_never_exposes_exception_details(self):
        client = MagicMock()
        client.bucket.side_effect = ValueError('private object URI and credential must not escape')
        with self.assertRaisesRegex(RuntimeError, '^google_auth_profile_unavailable$'):
            load_state(client, URI, EMAIL)

    async def test_expired_login_stops_before_meeting_entry(self):
        page = MagicMock(url='https://accounts.google.com/v3/signin/identifier')
        page.goto = AsyncMock()
        with self.assertRaisesRegex(RuntimeError, '^human_action_required$'):
            await verify_account(page, EMAIL)
        page.wait_for_selector.assert_not_called()

    async def test_exact_live_account_required(self):
        for labels in [[f'Google Account: Bot ({EMAIL})'],
                       ['Google Account: Different (different@rocketshiphq.com)'],
                       [f'Google Account: Bot (not{EMAIL})'],
                       [f'Google Account: Bot ({EMAIL})'] * 2]:
            page = MagicMock(url='https://myaccount.google.com/')
            page.goto = AsyncMock(); page.wait_for_selector = AsyncMock()
            nodes = []
            for label in labels:
                node = MagicMock(); node.get_attribute = AsyncMock(return_value=label)
                node.is_visible = AsyncMock(return_value=True); nodes.append(node)
            page.locator.return_value.all = AsyncMock(return_value=nodes)
            with self.subTest(labels=labels):
                if len(labels) == 1 and f'({EMAIL})' in labels[0]:
                    await verify_account(page, EMAIL)
                else:
                    with self.assertRaisesRegex(RuntimeError, '^google_auth_account_mismatch$'):
                        await verify_account(page, EMAIL)

    async def test_hidden_expected_indicator_cannot_override_visible_other_account(self):
        page = MagicMock(url='https://myaccount.google.com/')
        page.goto = AsyncMock(); page.wait_for_selector = AsyncMock()
        expected, other = MagicMock(), MagicMock()
        expected.get_attribute = AsyncMock(return_value=f'Google Account: Bot ({EMAIL})')
        expected.is_visible = AsyncMock(return_value=False)
        other.get_attribute = AsyncMock(return_value='Google Account: Other (other@rocketshiphq.com)')
        other.is_visible = AsyncMock(return_value=True)
        page.locator.return_value.all = AsyncMock(return_value=[expected, other])
        with self.assertRaisesRegex(RuntimeError, '^google_auth_account_mismatch$'):
            await verify_account(page, EMAIL)


if __name__ == '__main__':
    unittest.main()

import unittest
from unittest.mock import Mock, patch

import requests

from slack_recaps import SlackError, SlackRecaps


EMAIL = 'person@example.org'
USER = 'U123ABC'
DM = 'D123ABC'
MESSAGE_ID = '3f8cca97-0646-51d5-8597-24552523641a'
TIMESTAMP = '1781000000.000001'


def response(payload=None, *, status=200, retry_after=None):
    result = Mock(status_code=status, headers={})
    result.json.return_value = payload
    if retry_after is not None:
        result.headers['Retry-After'] = retry_after
    return result


class SlackRecapTests(unittest.TestCase):
    def setUp(self):
        self.slack = SlackRecaps('test-token')
        patcher = patch('slack_recaps.requests.request')
        self.request = patcher.start()
        self.addCleanup(patcher.stop)

    def test_resolve_requires_exact_active_user_and_verified_one_to_one_channel(self):
        self.request.side_effect = [
            response({'ok': True, 'user': {'id': USER, 'profile': {'email': EMAIL.upper()}}}),
            response({'ok': True, 'channel': {'id': DM, 'is_im': True, 'user': USER}}),
        ]
        self.assertEqual(self.slack.resolve_dm(EMAIL), DM)
        lookup, opened = self.request.call_args_list
        self.assertEqual(lookup.args, ('GET', 'https://slack.com/api/users.lookupByEmail'))
        self.assertEqual(lookup.kwargs['params'], {'email': EMAIL})
        self.assertEqual(opened.args, ('POST', 'https://slack.com/api/conversations.open'))
        self.assertEqual(opened.kwargs['json'], {'users': USER, 'return_im': True})
        self.assertFalse(opened.kwargs['allow_redirects'])

    def test_missing_mismatched_or_external_user_does_not_open_a_dm(self):
        candidates = [
            {'ok': False, 'error': 'users_not_found'},
            {'ok': True, 'user': {'id': USER, 'profile': {'email': 'different@example.org'}}},
        ] + [
            {'ok': True, 'user': {'id': USER, 'profile': {'email': EMAIL}, flag: True}}
            for flag in ('deleted', 'is_bot', 'is_app_user', 'is_restricted',
                         'is_ultra_restricted', 'is_stranger', 'is_external')
        ]
        for lookup in candidates:
            with self.subTest(lookup=lookup):
                self.request.reset_mock(return_value=True)
                self.request.return_value = response(lookup)
                self.assertIsNone(self.slack.resolve_dm(EMAIL))
                self.request.assert_called_once()

    def test_channel_must_belong_to_resolved_user_and_be_a_private_dm(self):
        channels = [
            {'id': DM, 'is_im': True, 'user': 'UOTHER'},
            {'id': 'C123ABC', 'is_im': False, 'user': USER},
            {'id': DM, 'is_im': True, 'user': USER, 'is_ext_shared': True},
            {'id': DM, 'user': USER},
        ]
        for channel in channels:
            with self.subTest(channel=channel):
                self.request.side_effect = [
                    response({'ok': True, 'user': {'id': USER, 'profile': {'email': EMAIL}}}),
                    response({'ok': True, 'channel': channel}),
                ]
                with self.assertRaisesRegex(SlackError, '^invalid_dm$'):
                    self.slack.resolve_dm(EMAIL)

    def test_post_returns_receipt_without_unfurling_or_parsing_fallback_text(self):
        message = {'text': 'Hi Person, your recap is ready.', 'blocks': [{'type': 'divider'}]}
        self.request.return_value = response({'ok': True, 'channel': DM, 'ts': TIMESTAMP})
        self.assertEqual(self.slack.post_dm(DM, message, MESSAGE_ID), TIMESTAMP)
        request = self.request.call_args
        self.assertEqual(request.args, ('POST', 'https://slack.com/api/chat.postMessage'))
        self.assertEqual(request.kwargs['json'], {
            **message, 'channel': DM, 'client_msg_id': MESSAGE_ID,
            'link_names': False, 'mrkdwn': False, 'parse': 'none',
            'unfurl_links': False, 'unfurl_media': False,
        })
        self.assertFalse(request.kwargs['allow_redirects'])

    def test_post_does_not_allow_public_or_group_destinations(self):
        for channel in ('C123ABC', 'G123ABC'):
            with self.assertRaisesRegex(SlackError, '^invalid_dm$'):
                self.slack.post_dm(channel, {}, MESSAGE_ID)
        self.request.assert_not_called()

    def test_post_distinguishes_definite_rejection_from_ambiguous_result(self):
        malformed = response()
        malformed.json.side_effect = ValueError('sensitive response')
        cases = [
            (response(status=429, retry_after='42'), 'ratelimited', False, 42),
            (response({'ok': False, 'error': 'missing_scope'}), 'missing_scope', False, 0),
            (response({'ok': False, 'error': 'internal_error'}), 'internal_error', True, 0),
            (response({'ok': False, 'error': 'token with private text'}), 'invalid_response', True, 0),
            (response(status=500), 'unexpected_http_status', True, 0),
            (response({'ok': True, 'channel': 'DOTHER', 'ts': TIMESTAMP}), 'invalid_post_receipt', True, 0),
            (malformed, 'invalid_response', True, 0),
            (requests.Timeout('untrusted data'), 'transport_failure', True, 0),
        ]
        for result, code, uncertain, retry_after in cases:
            with self.subTest(code=code):
                self.request.reset_mock()
                self.request.side_effect = [result]
                with self.assertRaises(SlackError) as caught:
                    self.slack.post_dm(DM, {'text': 'Recap', 'blocks': []}, MESSAGE_ID)
                self.assertEqual(str(caught.exception), code)
                self.assertIs(caught.exception.uncertain, uncertain)
                self.assertEqual(caught.exception.retry_after, retry_after)
                self.request.assert_called_once()

    def test_history_paginates_and_returns_only_the_matching_receipt(self):
        self.request.side_effect = [
            response({'ok': True, 'has_more': True, 'messages': [{'client_msg_id': 'other'}],
                      'response_metadata': {'next_cursor': 'next'}}),
            response({'ok': True, 'messages': [{'client_msg_id': MESSAGE_ID, 'ts': TIMESTAMP}]}),
        ]
        self.assertEqual(self.slack.find_dm(DM, MESSAGE_ID, 1781000000), TIMESTAMP)
        first, second = self.request.call_args_list
        self.assertEqual(first.kwargs['params']['oldest'], '1781000000.000000')
        self.assertEqual(second.kwargs['params']['cursor'], 'next')

    def test_history_distinguishes_absence_from_an_incomplete_scan(self):
        self.request.return_value = response({'ok': True, 'messages': [], 'has_more': False})
        self.assertIsNone(self.slack.find_dm(DM, MESSAGE_ID, 1781000000))

        self.request.side_effect = [
            response({'ok': True, 'messages': [], 'response_metadata': {'next_cursor': cursor}})
            for cursor in ('first', 'second', 'third')
        ]
        with self.assertRaisesRegex(SlackError, '^history_limit_reached$'):
            self.slack.find_dm(DM, MESSAGE_ID, 1781000000)

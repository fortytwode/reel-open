"""Slack API transport for private, single-recipient meeting recaps."""

import math
import re

import requests


_USER_ID = re.compile(r'[UW][A-Z0-9]+')
_DM_ID = re.compile(r'D[A-Z0-9]+')
_MESSAGE_TS = re.compile(r'\d+\.\d+')
_EXCLUDED_USERS = (
    'deleted', 'is_bot', 'is_app_user', 'is_restricted',
    'is_ultra_restricted', 'is_stranger', 'is_external',
)
# Errors with a known rejection before message creation. Unknown errors are
# ambiguous, including Slack's internal_error and fatal_error.
_REJECTED_POST_CODES = {
    'account_inactive', 'channel_not_found', 'ekm_access_denied',
    'invalid_arguments', 'invalid_auth', 'invalid_blocks', 'invalid_blocks_format',
    'missing_scope', 'msg_too_long', 'no_text', 'not_authed', 'not_in_channel',
    'ratelimited', 'rate_limited', 'restricted_action', 'token_revoked',
}


class SlackError(RuntimeError):
    """Sanitized Slack failure with delivery certainty and optional backoff."""

    def __init__(self, code, *, uncertain=False, retry_after=0):
        self.code = code if isinstance(code, str) and re.fullmatch(r'[a-z0-9_]{1,64}', code) else 'invalid_response'
        self.uncertain = uncertain
        self.retry_after = retry_after
        super().__init__(self.code)


def _valid_id(value, pattern):
    return isinstance(value, str) and pattern.fullmatch(value) is not None


class SlackRecaps:
    """Use a workspace bot token to deliver and reconcile one-person DMs."""

    def __init__(self, token):
        self._token = token

    def _call(self, method, *, params=None, payload=None):
        sending = method == 'chat.postMessage'
        try:
            response = requests.request(
                'GET' if payload is None else 'POST',
                f'https://slack.com/api/{method}',
                headers={'Authorization': f'Bearer {self._token}'},
                params=params,
                json=payload,
                timeout=5,
                allow_redirects=False,
            )
        except requests.RequestException:
            raise SlackError('transport_failure', uncertain=sending) from None
        retry_header = response.headers.get('Retry-After', '')
        retry_after = int(retry_header) if re.fullmatch(r'[0-9]{1,9}', retry_header) else 0
        if response.status_code == 429:
            raise SlackError('ratelimited', retry_after=retry_after)
        if response.status_code != 200:
            raise SlackError('unexpected_http_status', uncertain=sending)
        try:
            result = response.json()
        except ValueError:
            raise SlackError('invalid_response', uncertain=sending) from None
        if not isinstance(result, dict):
            raise SlackError('invalid_response', uncertain=sending)
        if result.get('ok') is not True:
            code = result.get('error')
            error = SlackError(code, retry_after=retry_after)
            error.uncertain = sending and error.code not in _REJECTED_POST_CODES
            raise error
        return result

    def resolve_dm(self, email):
        """Open or resume a DM for an exact active workspace email match."""
        try:
            result = self._call('users.lookupByEmail', params={'email': email})
        except SlackError as exc:
            if exc.code == 'users_not_found':
                return None
            raise
        user = result.get('user')
        if not isinstance(user, dict):
            raise SlackError('invalid_user')
        profile = user.get('profile')
        actual_email = profile.get('email') if isinstance(profile, dict) else None
        if (not isinstance(actual_email, str) or actual_email.casefold() != email.casefold()
                or any(user.get(flag) for flag in _EXCLUDED_USERS)):
            return None
        user_id = user.get('id')
        if not _valid_id(user_id, _USER_ID):
            raise SlackError('invalid_user')
        result = self._call('conversations.open', payload={'users': user_id, 'return_im': True})
        channel = result.get('channel')
        if (not isinstance(channel, dict) or not _valid_id(channel.get('id'), _DM_ID)
                or channel.get('is_im') is not True or channel.get('user') != user_id
                or any(channel.get(flag) for flag in ('is_shared', 'is_ext_shared', 'is_org_shared'))):
            raise SlackError('invalid_dm')
        return channel['id']

    def post_dm(self, channel, message, client_msg_id):
        if not _valid_id(channel, _DM_ID):
            raise SlackError('invalid_dm')
        result = self._call('chat.postMessage', payload={
            'channel': channel,
            'text': message['text'],
            'blocks': message['blocks'],
            'client_msg_id': client_msg_id,
            'link_names': False,
            'mrkdwn': False,
            'parse': 'none',
            'unfurl_links': False,
            'unfurl_media': False,
        })
        timestamp = result.get('ts')
        if result.get('channel') != channel or not _valid_id(timestamp, _MESSAGE_TS):
            raise SlackError('invalid_post_receipt', uncertain=True)
        return timestamp

    def find_dm(self, channel, client_msg_id, oldest):
        """Check recent history for a previously accepted message."""
        if not _valid_id(channel, _DM_ID):
            raise SlackError('invalid_dm')
        if not isinstance(oldest, (int, float)) or not math.isfinite(oldest) or oldest < 0:
            raise SlackError('invalid_history_timestamp')
        params = {'channel': channel, 'oldest': f'{oldest:.6f}', 'inclusive': 'true', 'limit': 15}
        seen_cursors = set()
        for _ in range(3):
            result = self._call('conversations.history', params=params)
            messages = result.get('messages')
            if not isinstance(messages, list) or any(not isinstance(message, dict) for message in messages):
                raise SlackError('invalid_history')
            for message in messages:
                if message.get('client_msg_id') == client_msg_id:
                    timestamp = message.get('ts')
                    if not _valid_id(timestamp, _MESSAGE_TS):
                        raise SlackError('invalid_history')
                    return timestamp
            metadata = result.get('response_metadata', {})
            if not isinstance(metadata, dict):
                raise SlackError('invalid_history')
            cursor = metadata.get('next_cursor', '')
            if not cursor and not result.get('has_more'):
                return None
            if not isinstance(cursor, str) or not cursor or cursor in seen_cursors:
                raise SlackError('invalid_history')
            seen_cursors.add(cursor)
            params = {**params, 'cursor': cursor}
        raise SlackError('history_limit_reached')

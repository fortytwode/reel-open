"""Focused contract tests for the Resend recap adapter."""

from unittest import TestCase
from unittest.mock import Mock, patch

import pytest
import requests

from app import create_app, ProviderPending, recap_message
from providers import ResendRecaps

import test_orchestration as orchestration


SENDER = "recaps@rocketshiphq.com"
API_KEY = "re_fixture_resend_key"
MEETING_ID = "meeting-fixture-123"
RECIPIENTS = ["alex@rocketshiphq.com", "sam@rocketshiphq.com"]


@pytest.fixture
def message():
    return recap_message(
        RECIPIENTS,
        "Design review",
        "Outcome\nShip the recap sender.",
        "https://missioncontrol.rocketshiphq.com/reel#meetings/meeting-fixture-123",
        MEETING_ID,
    )


def _response(status=200, payload=None):
    response = Mock()
    response.status_code = status
    response.json.return_value = payload
    return response


def _parts(message):
    return {
        part.get_content_type(): part.get_payload(decode=True).decode(part.get_content_charset() or "utf-8")
        for part in message.get_payload()
    }


def test_send_posts_the_mime_recap_as_an_idempotent_https_resend_request(message):
    response = _response(payload={"id": "re_fixture_message_123"})
    with patch("providers.requests.post", return_value=response) as post:
        result = ResendRecaps(SENDER, API_KEY).send(MEETING_ID, RECIPIENTS, message)

    assert result == {"state": "sent", "provider_message_id": "re_fixture_message_123"}
    request_url = post.call_args.args[0]
    request = post.call_args.kwargs
    assert request_url == "https://api.resend.com/emails"
    assert request_url.startswith("https://")
    assert request["headers"]["Authorization"] == f"Bearer {API_KEY}"
    assert request["headers"]["Idempotency-Key"] == f"reel/recap/{MEETING_ID}"
    assert request["json"]["from"] == f"Reel Notetaker <{SENDER}>"
    assert request["json"]["to"] == RECIPIENTS
    assert request["json"]["subject"] == message["Subject"]
    parts = _parts(message)
    assert request["json"]["text"] == parts["text/plain"]
    assert request["json"]["html"] == parts["text/html"]
    assert API_KEY not in repr(result)


@pytest.mark.parametrize(
    "outcome",
    [
        _response(status=429, payload={"message": "rate limited"}),
        requests.Timeout("fixture timeout"),
        _response(status=200, payload={"unexpected": "shape"}),
    ],
)
def test_send_keeps_uncertain_resend_outcomes_pending(message, outcome):
    with patch("providers.requests.post", side_effect=outcome) if isinstance(outcome, Exception) else patch(
        "providers.requests.post", return_value=outcome
    ):
        with pytest.raises(ProviderPending):
            ResendRecaps(SENDER, API_KEY).send(MEETING_ID, RECIPIENTS, message)



class ResendDeliveryTests(TestCase):
    setUp = orchestration.OrchestrationTests.setUp
    post = orchestration.OrchestrationTests.post

    def configure_resend(self):
        self.event['attendees'] = [{'email': 'peer@rocketshiphq.com'}]
        self.providers.resend_recaps = ResendRecaps(SENDER, API_KEY)
        self.providers.find_email = Mock(side_effect=AssertionError('Gmail must not be queried'))
        self.slack = Mock()
        self.slack.resolve_dm.side_effect = {
            'owner@rocketshiphq.com': 'DOWNER', 'peer@rocketshiphq.com': 'DPEER',
        }.__getitem__
        self.slack.post_dm.return_value = '1000.001'
        self.client = create_app(
            lambda token: self.claims, lambda email: orchestration.Service([self.event]),
            store=self.store, calendar_store=self.calendar_store, providers=self.providers,
            clock=lambda: self.now, slack=self.slack).test_client()

    def test_ambiguous_send_retries_with_identical_content_and_notifies_only_peers(self):
        self.configure_resend()
        self.payload['summary'] = 'Outcome\nWe approved the QA plan.\n\nAction items\nReview the checklist.'
        with patch.dict('os.environ', {'NOTION_DELIVERY_OWNERS': 'admin@rocketshiphq.com'}), \
                patch('providers.requests.post', side_effect=[requests.Timeout(), _response(payload={'id': 'sent-id'})]) as post:
            self.assertEqual(self.post().status_code, 503)
            self.now += 61
            result = self.post()
            self.assertEqual(result.status_code, 200, result.json)
            self.assertEqual(self.post().status_code, 200)
        self.assertEqual(post.call_count, 2)
        first, second = (call.kwargs for call in post.call_args_list)
        self.assertEqual(first, second)
        self.assertEqual(first['json']['to'], ['owner@rocketshiphq.com', 'peer@rocketshiphq.com'])
        self.assertIn('We approved the QA plan.', first['json']['text'])
        self.assertIn(result.json['notes_url'], first['json']['text'])
        self.assertNotIn('Full transcript', first['json']['text'])
        self.assertEqual(result.json['route'], 'reel')
        self.assertEqual(self.providers.creates, 0)
        self.assertEqual([call.args[0] for call in self.slack.post_dm.call_args_list], ['DOWNER', 'DPEER'])

    def test_ambiguous_send_is_held_after_resend_retry_window(self):
        self.configure_resend()
        with patch('providers.requests.post', side_effect=requests.Timeout()) as post:
            self.assertEqual(self.post().status_code, 503)
            self.now += 24 * 60 * 60
            self.assertEqual(self.post().status_code, 503)
        self.assertEqual(post.call_count, 1)

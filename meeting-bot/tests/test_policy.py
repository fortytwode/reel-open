import copy
import hashlib
import unittest
from policy import admission_decision, departure_decision, meeting_url, validate_payload


class PolicyTests(unittest.TestCase):
    def payload(self):
        owner = 'firebase-uid'
        execution = '618e8480-0ba5-49f4-a949-941a69fb6b98'
        return dict(owner_id=owner, execution_id=execution, consent={'confirmed': True},
                    provider='meet', meeting_url='https://meet.google.com/abc-defg-hij',
                    display_name='Reel recorder', callback_url='https://service.example/bot/callback',
                    callback_token='x'*48, output_bucket='reel-private',
                    output_prefix='reel-meetings/bot/'+hashlib.sha256(owner.encode()).hexdigest()+'/'+execution+'/')

    def test_valid_payload(self):
        self.assertEqual(validate_payload(self.payload(), 'https://service.example')['max_duration_seconds'], 3600)

    def test_optional_capture_deadline_requires_exact_timezone_timestamp(self):
        for value in ['2026-11-17T14:09:21+00:00', '2026-11-17T15:09:21.123456+01:00',
                      '2026-11-17T14:09:21Z']:
            payload = self.payload()
            payload['capture_deadline'] = value
            self.assertEqual(validate_payload(payload, 'https://service.example')['capture_deadline'], value)
        for value in [None, True, 12, '', '2026-11-17', '2026-11-17T14:09:21',
                      '2026-11-17 14:09:21+00:00', '2026-02-30T14:09:21Z',
                      '2026-11-17T14:09:21+24:00', '2026-11-17T14:09:21+00:99',
                      '2026-11-17T14:09:21Z\n']:
            payload = self.payload()
            payload['capture_deadline'] = value
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, '^invalid_capture_deadline$'):
                validate_payload(payload, 'https://service.example')

    def test_optional_schedule_times_require_exact_timezone_timestamps(self):
        for key in ('scheduled_end', 'join_not_before'):
            payload = self.payload()
            payload[key] = '2026-11-17T14:09:21+00:00'
            self.assertEqual(validate_payload(payload, 'https://service.example')[key], '2026-11-17T14:09:21+00:00')
            for value in [None, 12, '2026-11-17T14:09:21', '2026-11-17']:
                payload = self.payload()
                payload[key] = value
                with self.subTest(key=key, value=value), self.assertRaisesRegex(ValueError, '^invalid_' + key + '$'):
                    validate_payload(payload, 'https://service.example')

    def test_recording_follows_people_not_the_calendar(self):
        cases = [
            # Sound keeps an overrunning meeting recording, however long.
            (dict(others_seen=True, alone_seconds=0, silent_seconds=0, past_end=True), None),
            (dict(others_seen=True, alone_seconds=900, silent_seconds=10, past_end=True), None),
            # After the end, an empty quiet room is left after a minute.
            (dict(others_seen=True, alone_seconds=59, silent_seconds=200, past_end=True), None),
            (dict(others_seen=True, alone_seconds=60, silent_seconds=60, past_end=True), 'room_empty'),
            # A count that never showed anyone is not trusted; silence still ends it.
            (dict(others_seen=False, alone_seconds=600, silent_seconds=299, past_end=True), None),
            (dict(others_seen=False, alone_seconds=0, silent_seconds=300, past_end=True), 'meeting_silent'),
            (dict(others_seen=True, alone_seconds=0, silent_seconds=300, past_end=True), 'meeting_silent'),
            # Before the end, only a room that emptied and stayed quiet is left.
            (dict(others_seen=True, alone_seconds=299, silent_seconds=900, past_end=False), None),
            (dict(others_seen=True, alone_seconds=300, silent_seconds=299, past_end=False), None),
            (dict(others_seen=True, alone_seconds=300, silent_seconds=300, past_end=False), 'room_empty'),
            # Nobody has arrived yet, or people are thinking quietly: stay.
            (dict(others_seen=False, alone_seconds=3000, silent_seconds=3000, past_end=False), None),
            (dict(others_seen=True, alone_seconds=0, silent_seconds=3000, past_end=False), None),
        ]
        for evidence, expected in cases:
            with self.subTest(**evidence):
                self.assertEqual(departure_decision(**evidence), expected)

    def test_owner_isolation_and_required_consent(self):
        for update in [dict(owner_id='other-owner'), dict(consent={'confirmed': False}),
                       dict(consent={'confirmed': 'true'}), dict(output_prefix='arbitrary/'),
                       dict(callback_url='https://attacker.example/callback'),
                       dict(callback_url='http://service.example/callback'), dict(callback_token='short'),
                       dict(max_duration_seconds=10801), dict(max_duration_seconds=True),
                       dict(admission_timeout_seconds=901), dict(display_name='name\n')]:
            p = self.payload()
            p.update(update)
            with self.subTest(update=list(update)), self.assertRaises(ValueError):
                validate_payload(p, 'https://service.example')

    def test_url_hosts_and_providers(self):
        for provider, url in [('meet', 'https://meet.google.com.evil.example/abc-defg-hij'),
                              ('zoom', 'https://zoom.us.evil.example/j/123456789'),
                              ('meet', 'http://meet.google.com/abc-defg-hij'),
                              ('meet', 'https://user:secret@meet.google.com/abc-defg-hij'),
                              ('meet', 'https://meet.google.com:8443/abc-defg-hij'),
                              ('teams', 'https://teams.microsoft.com/evil'),
                              ('zoom', 'https://127.0.0.1/j/123456789')]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                meeting_url(provider, url)

    def test_meet_normalizes_both_input_routes_to_direct_meeting_url(self):
        for value in ['https://meet.google.com/abc-defg-hij',
                      'https://meet.google.com/abc-defg-hij/',
                      'https://meet.google.com/meet/abc-defg-hij']:
            self.assertEqual(meeting_url('meet', value), 'https://meet.google.com/abc-defg-hij')

    def test_zoom_joins_web_client_and_keeps_password(self):
        self.assertEqual(meeting_url('zoom', 'https://us02web.zoom.us/j/123456789?pwd=abc%2Bxyz&tracking=secret'),
                         'https://app.zoom.us/wc/123456789/join?pwd=abc%2Bxyz')
        self.assertEqual(meeting_url('zoom', 'https://app.zoom.us/wc/join/123456789'),
                         'https://app.zoom.us/wc/123456789/join')

    def test_team_modern_and_classic(self):
        for url in ['https://teams.microsoft.com/l/meetup-join/19%3Ameeting?context=private',
                    'https://teams.live.com/meet/123456789?p=secret']:
            self.assertEqual(meeting_url('teams', url), url)

    def test_admission_precedence(self):
        self.assertEqual(admission_decision(waiting=True, in_call=True), 'awaiting_admission')
        self.assertEqual(admission_decision(denied=True, waiting=True, in_call=True), 'denied')
        self.assertEqual(admission_decision(blocked=True, in_call=True), 'human_action_required')
        self.assertEqual(admission_decision(consent_gate=True, in_call=True), 'human_action_required')
        self.assertEqual(admission_decision(in_call=True), 'joined')
        self.assertEqual(admission_decision(), 'requesting_entry')

    def test_timeout_never_becomes_joined(self):
        self.assertEqual(admission_decision(in_call=True, elapsed=300, timeout=300), 'admission_timeout')
        self.assertEqual(admission_decision(waiting=True, elapsed=301, timeout=300), 'admission_timeout')


if __name__ == '__main__':
    unittest.main()

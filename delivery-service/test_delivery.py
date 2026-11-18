import unittest
from unittest.mock import patch

from app import internal_recipients, canonical_occurrence, DeliveryError


ROCKETSHIP_CONFIG = {
    'REEL_ORGANIZATION_DOMAIN': 'rocketshiphq.com',
    'REEL_FIREBASE_PROJECT': 'advisr-485ac',
    'REEL_ALLOWED_ORIGINS': 'https://missioncontrol.rocketshiphq.com',
    'REEL_NOTES_BASE_URL': 'https://missioncontrol.rocketshiphq.com/reel',
}


@patch.dict('os.environ', ROCKETSHIP_CONFIG)
class ContractTests(unittest.TestCase):
    def test_recipients_use_calendar_only_and_exact_domain(self):
        event = {'attendees': [{'email': 'nonattendee@rocketshiphq.com', 'responseStatus': 'declined'}, {'email': 'external@example.com'}, {'email': 'x@rocketshiphq.com.evil'}], 'organizer': {'email': 'owner@rocketshiphq.com'}}
        self.assertEqual(internal_recipients(event), ['nonattendee@rocketshiphq.com', 'owner@rocketshiphq.com'])

    def test_identity_uses_original_occurrence(self):
        self.assertEqual(canonical_occurrence({'iCalUID':'abc', 'originalStartTime': {'dateTime':'2026-11-10T11:00:00+01:00'}}), ('abc', '2026-11-10T10:00:00Z'))


class Request:
    def __init__(self, value): self.value = value
    def execute(self): return self.value

class Events:
    def __init__(self, events): self.events = events
    def list(self, **kwargs): return Request({'items': self.events})
    def get(self, **kwargs): return Request(self.events[0])

class CalendarList:
    def list(self, **kwargs): return Request({'items': []})

class Service:
    def __init__(self, events): self.event_api = Events(events)
    def events(self): return self.event_api
    def calendarList(self): return CalendarList()

@patch.dict('os.environ', ROCKETSHIP_CONFIG)
class ResolutionTests(unittest.TestCase):
    def test_exact_resolution_and_forged_client_list_has_no_role(self):
        from app import resolve_occurrence
        event = {'iCalUID':'uid', 'start': {'dateTime':'2026-11-10T10:00:00Z'}, 'attendees':[{'email':'invited@rocketshiphq.com', 'responseStatus':'needsAction'}], 'organizer': {'email':'owner@rocketshiphq.com'}}
        found = resolve_occurrence(Service([event]), {'ical_uid':'uid', 'occurrence_start':'2026-11-10T10:00:00Z'})
        self.assertEqual(internal_recipients(found), ['invited@rocketshiphq.com', 'owner@rocketshiphq.com'])

    def test_unknown_identity_fails(self):
        from app import resolve_occurrence
        event = {'iCalUID':'different', 'start': {'dateTime':'2026-11-10T10:00:00Z'}}
        with self.assertRaises(DeliveryError):
            resolve_occurrence(Service([event]), {'ical_uid':'uid', 'occurrence_start':'2026-11-10T10:00:00Z'})

    def test_ambiguous_copies_fail_closed(self):
        from app import resolve_occurrence
        base = {'iCalUID':'uid', 'start': {'dateTime':'2026-11-10T10:00:00Z'}}
        events = [{**base, 'attendees':[{'email':'a@rocketshiphq.com'}]}, {**base, 'attendees':[{'email':'b@rocketshiphq.com'}]}]
        with self.assertRaises(DeliveryError):
            resolve_occurrence(Service(events), {'ical_uid':'uid', 'occurrence_start':'2026-11-10T10:00:00Z'})

class ReadbackTests(unittest.TestCase):
    def test_exact_transcript_readback(self):
        from app import verify_notion_transcript
        class Notion:
            def get_page(self, page_id): return {'id':page_id}
            def iter_blocks(self, page_id, max_pages):
                return [{'type':'heading_2', 'heading_2':{'rich_text':[{'plain_text':'Transcript'}]}}, {'type':'paragraph', 'paragraph':{'rich_text':[{'plain_text':'complete'}]}}]
        verify_notion_transcript(Notion(), 'id', 'complete')
        with self.assertRaises(DeliveryError): verify_notion_transcript(Notion(), 'id', 'complete missing words')

@patch.dict('os.environ', ROCKETSHIP_CONFIG)
class MessageTests(unittest.TestCase):
    def test_greeting_and_escape(self):
        from app import recap_message
        message = recap_message(['alex@rocketshiphq.com'], 'Meeting', '<script> & more', 'https://notion.so/x?a=1&b=2', 'x@rocketshiphq.com')
        plain, html = [part.get_payload(decode=True).decode() for part in message.get_payload()]
        self.assertTrue(plain.startswith('Hi Alex,'))
        self.assertIn('&lt;script&gt; &amp; more', html)
        self.assertIn('a=1&amp;b=2', html)

    def test_renders_current_and_legacy_note_markup_in_both_parts(self):
        from app import recap_message

        summary = (
            'Outcome\nAgreed to ship.\n\nKey points\n• Timeline: **Tuesday**\n'
            '• Check *all* platforms.\n\n## Decisions\n1. Keep the existing plan.\n'
            '2) Keep the existing dates.\n\n**Next steps:**\n- Alex: run `echo **` & verify.\n'
            '```shell\necho ** <file>\n```\nRaw <img src=x> and unmatched ** stay.'
        )
        notes_url = 'https://example.com/reel#meetings/abc'
        message = recap_message(['alex@rocketshiphq.com', 'sam@rocketshiphq.com'], 'Meeting',
                                summary, notes_url, 'meeting@rocketshiphq.com')
        plain, html = [part.get_payload(decode=True).decode() for part in message.get_payload()]

        self.assertEqual(message['To'], 'alex@rocketshiphq.com, sam@rocketshiphq.com')
        self.assertEqual(message['Message-ID'], '<meeting@rocketshiphq.com>')
        self.assertEqual(message['Subject'], 'Meeting recap: Meeting')
        self.assertIn('Outcome\nAgreed to ship.\n\nKey points\n• Timeline: Tuesday', plain)
        self.assertIn('Decisions\n1. Keep the existing plan.\n2) Keep the existing dates.', plain)
        self.assertIn('Next steps\n• Alex: run echo ** & verify.', plain)
        self.assertIn('echo ** <file>\nRaw <img src=x> and unmatched ** stay.', plain)
        self.assertIn('Meeting notes: ' + notes_url, plain)
        self.assertIn('<h2>Outcome</h2><p>Agreed to ship.</p>', html)
        self.assertIn('<ul><li>Timeline: <strong>Tuesday</strong></li><li>Check <em>all</em> platforms.</li></ul>', html)
        self.assertIn('<h2>Decisions</h2><ol><li>Keep the existing plan.</li><li>Keep the existing dates.</li></ol>', html)
        self.assertIn('<h2>Next steps</h2><ul><li>Alex: run <code>echo **</code> &amp; verify.</li></ul>', html)
        self.assertIn('<pre><code>echo ** &lt;file&gt;</code></pre>', html)
        self.assertIn('Raw &lt;img src=x&gt; and unmatched ** stay.', html)
        self.assertIn(f'<a href="{notes_url}">Meeting notes</a>', html)

@patch.dict('os.environ', ROCKETSHIP_CONFIG)
class CalendarEndpointTests(unittest.TestCase):
    def test_lists_eligible_without_join_url_or_passcode(self):
        from app import create_app
        event = {'id':'instance', 'iCalUID':'uid', 'summary':'Review', 'start':{'dateTime':'2026-11-10T11:00:00Z'}, 'originalStartTime':{'dateTime':'2026-11-10T10:00:00Z'}, 'hangoutLink':'https://meet.google.com/abc-defg-hij?pwd=secret', 'attendees':[{'email':'person@rocketshiphq.com'}]}
        hidden = {**event, 'id':'hidden', 'summary':'[PRIVATE] hidden'}
        claims = {'iss':'https://securetoken.google.com/advisr-485ac', 'aud':'advisr-485ac', 'sub':'user', 'email_verified':True, 'email':'owner@rocketshiphq.com'}
        app = create_app(lambda token:claims, lambda email:Service([event, hidden]))
        response = app.test_client().get('/delivery/calendar', headers={'Authorization':'Bearer token'})
        self.assertEqual(response.status_code, 200)
        events = response.get_json()['events']
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]['calendar']['occurrence_start'], '2026-11-10T10:00:00Z')
        self.assertEqual(events[0]['calendar']['calendar_id'], 'owner@rocketshiphq.com')
        import hashlib
        self.assertEqual(events[0]['id'], hashlib.sha256('owner@rocketshiphq.com\0instance\0' .encode() + b'2026-11-10T11:00:00Z').hexdigest())
        self.assertNotIn('secret', response.get_data(as_text=True))
        self.assertNotIn('meet.google.com', response.get_data(as_text=True))

    def test_rejects_unverified_and_suffix_domain(self):
        from app import create_app
        for email, verified in [('x@rocketshiphq.com.evil', True), ('x@rocketshiphq.com', False)]:
            claims = {'iss':'https://securetoken.google.com/advisr-485ac', 'aud':'advisr-485ac', 'sub':'user', 'email_verified':verified, 'email':email}
            response = create_app(lambda token:claims).test_client().get('/delivery/calendar', headers={'Authorization':'Bearer token'})
            self.assertEqual(response.status_code, 401)

class PayloadTests(unittest.TestCase):
    def test_changed_content_changes_recording_binding(self):
        from app import validate_payload
        payload = {'id':'ee5ecec6-e403-4163-8f95-b503e3648c40', 'title':'T', 'started_at':'2026-11-10T10:00:00Z', 'attendees':[], 'summary':'A', 'segments':[{'start':0,'end':1,'text':'full'}], 'calendar':None}
        recording, original = validate_payload(payload)
        changed_recording, changed = validate_payload({**payload, 'summary':'B'})
        self.assertEqual(recording, changed_recording)
        self.assertNotEqual(original, changed)


class AdditionalCalendarTests(unittest.TestCase):
    def test_event_identifier_and_occurrence_must_both_match(self):
        from app import resolve_occurrence
        event = {'id':'other', 'iCalUID':'uid', 'start':{'dateTime':'2026-11-10T10:00:00Z'}}
        with self.assertRaises(DeliveryError):
            resolve_occurrence(Service([event]), {'event_id':'expected', 'ical_uid':'uid', 'occurrence_start':'2026-11-10T10:00:00Z'})

    def test_moved_instance_matches_original_start(self):
        from app import resolve_occurrence
        event = {'id':'instance', 'iCalUID':'uid', 'start':{'dateTime':'2026-11-11T10:00:00Z'}, 'originalStartTime':{'dateTime':'2026-11-10T10:00:00Z'}}
        self.assertEqual(resolve_occurrence(Service([event]), {'event_id':'instance', 'ical_uid':'uid', 'occurrence_start':'2026-11-10T10:00:00Z'}), event)

class BindingTests(unittest.TestCase):
    def test_recording_content_and_identity_are_immutable(self):
        from app import bind_recording
        class Store:
            def __init__(self): self.state = {}
            def load(self, key): return self.state.get(key), 1 if key in self.state else 0
            def cas(self, key, value, generation): self.state[key] = value
        store = Store()
        bind_recording(store, 'owner@rocketshiphq.com', 'recording', 'hash1', 'occurrence')
        bind_recording(store, 'owner@rocketshiphq.com', 'recording', 'hash1', 'occurrence')
        with self.assertRaises(DeliveryError): bind_recording(store, 'owner@rocketshiphq.com', 'recording', 'hash2', 'occurrence')

class ClaimTests(unittest.TestCase):
    def test_claim_rejects_stale_checkpoint_and_reuses_confirmed_receipt(self):
        from app import checkpoint, reserve_occurrence
        class Store:
            def __init__(self): self.items = {}
            def load(self, key):
                item = self.items.get(key)
                return (dict(item[0]), item[1]) if item else (None, 0)
            def cas(self, key, state, generation):
                self.assert_generation(key, generation)
                self.items[key] = (dict(state), generation + 1)
            def assert_generation(self, key, generation):
                assert generation == (self.items[key][1] if key in self.items else 0)
        store = Store()
        key, token, _ = reserve_occurrence(store, ('uid','start'), 'first', 100, lease_seconds=10)
        with self.assertRaises(DeliveryError): reserve_occurrence(store, ('uid','start'), 'second', 101)
        _, new_token, _ = reserve_occurrence(store, ('uid','start'), 'first', 111)
        with self.assertRaises(DeliveryError): checkpoint(store, key, token, 112, {'page_id':'stale'})
        checkpoint(store, key, new_token, 112, {'receipt':{'verified':True}})
        _, _, receipt = reserve_occurrence(store, ('uid','start'), 'second', 113)
        self.assertEqual(receipt, {'verified':True})

class LegacyCalendarReferenceTests(unittest.TestCase):
    def setUp(self):
        import hashlib
        self.owner='owner@rocketshiphq.com'
        self.event={'id':'instance','iCalUID':'calendar-uid','summary':'Historical meeting','start':{'dateTime':'2026-10-01T10:00:00Z'},'originalStartTime':{'dateTime':'2026-09-30T10:00:00Z'},'attendees':[{'email':self.owner}]}
        self.reference={'legacy_occurrence_id':hashlib.sha256((self.owner+'\0instance\0'+'2026-10-01T10:00:00Z').encode()).hexdigest(),'occurrence_start':'2026-10-01T10:00:00Z'}
    def service(self,events):
        calls=[]
        class HistoricalEvents:
            def list(inner,**kwargs):
                calls.append(kwargs)
                return Request({'items':events})
        service=Service([]); service.event_api=HistoricalEvents()
        return service,calls
    def test_historical_hash_uses_supplied_date_and_authoritative_original_occurrence(self):
        from app import resolve_occurrence, canonical_occurrence
        service,calls=self.service([self.event])
        found=resolve_occurrence(service,self.reference,owner_email=self.owner)
        self.assertEqual(canonical_occurrence(found),('calendar-uid','2026-09-30T10:00:00Z'))
        self.assertEqual(calls[0]['timeMin'],'2026-09-30T10:00:00Z')
        self.assertEqual(calls[0]['timeMax'],'2026-10-02T10:00:00Z')
    def test_primary_alias_legacy_hash_is_supported(self):
        import hashlib
        from app import resolve_occurrence
        reference={**self.reference,'legacy_occurrence_id':hashlib.sha256(('primary\0instance\0'+'2026-10-01T10:00:00Z').encode()).hexdigest()}
        service,_=self.service([self.event])
        self.assertEqual(resolve_occurrence(service,reference,owner_email=self.owner),self.event)
    def test_unknown_hash_and_wrong_supplied_start_fail_without_fuzzy_matching(self):
        from app import resolve_occurrence
        for reference in [{**self.reference,'legacy_occurrence_id':'0'*64},{**self.reference,'occurrence_start':'2026-10-01T11:00:00Z'},{**self.reference,'occurrence_start':'2026-11-10T10:00:00Z'}]:
            service,_=self.service([self.event])
            with self.assertRaises(DeliveryError): resolve_occurrence(service,reference,owner_email=self.owner)
    def test_conflicting_authoritative_copies_are_ambiguous(self):
        from app import resolve_occurrence
        service,_=self.service([self.event,{**self.event,'iCalUID':'different-calendar-identity'}])
        with self.assertRaises(DeliveryError): resolve_occurrence(service,self.reference,owner_email=self.owner)
    def test_legacy_reference_rejects_malformed_or_mixed_identity(self):
        from app import resolve_occurrence
        for reference in [{**self.reference,'legacy_occurrence_id':'invalid'},{**self.reference,'event_id':'instance'}]:
            service,_=self.service([self.event])
            with self.assertRaises(DeliveryError): resolve_occurrence(service,reference,owner_email=self.owner)

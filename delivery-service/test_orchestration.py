import copy
import os
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from app import create_app, DeliveryError, verify_firebase
from providers import choose_route
from test_delivery import ROCKETSHIP_CONFIG, Service

class Store:
    def __init__(self): self.items = {}
    def load(self, key):
        state, generation = self.items.get(key, (None, 0))
        return copy.deepcopy(state), generation
    def cas(self, key, state, generation):
        from google.api_core.exceptions import PreconditionFailed
        if self.items.get(key, (None, 0))[1] != generation: raise PreconditionFailed('race')
        self.items[key] = (copy.deepcopy(state), generation + 1)
        return generation + 1

class Providers:
    def __init__(self):
        self.pages = {}; self.sent = {}; self.drafts = {}; self.creates = 0; self.sends = 0
        self.fail = None; self.route_value = {'kind':'private'}; self.guard = lambda: None
    def context(self, guard):
        from contextlib import nullcontext
        self.guard = guard
        return nullcontext()
    def find_notion(self, meeting_id): return self.pages.get(meeting_id)
    def create_notion(self, meeting_id, payload, attendees, transcript):
        self.guard(); self.creates += 1
        if self.fail == 'notion': raise RuntimeError('offline')
        self.pages[meeting_id] = {'page_id':'page', 'url':'https://notion.so/page'}
        if self.fail == 'lost_notion': self.fail = None; raise TimeoutError('accepted')
        return self.pages[meeting_id]
    def verify_notion(self, page, meeting_id, transcript):
        if self.fail == 'readback': raise DeliveryError('Transcript mismatch')
    def choose_route(self, title, attendees, manual): return self.route_value
    def apply_route(self, page, route, meeting_id, payload, attendees):
        self.guard()
        if self.fail == 'route': raise RuntimeError('route failed')
    def find_email(self, key, *, since=None): return self.sent.get(key) or self.drafts.get(key)
    def message_id(self, key): return key + '@rocketshiphq.com'
    def create_draft(self, key, message):
        self.guard(); self.drafts[key] = {'state':'draft','provider_draft_id':'draft'}
        return 'draft'
    def send_draft(self, key, draft_id):
        self.guard(); self.sends += 1
        self.sent[key] = {'state':'sent','provider_message_id':'sent'}
        if self.fail == 'lost_email': self.fail = None; raise TimeoutError('accepted')
        return self.sent[key]

class OrchestrationTests(unittest.TestCase):
    def setUp(self):
        configuration = patch.dict('os.environ', ROCKETSHIP_CONFIG)
        configuration.start()
        self.addCleanup(configuration.stop)
        self.store = Store(); self.providers = Providers(); self.now = 1000
        self.event = {'id':'event', 'iCalUID':'uid','start':{'dateTime':'2026-11-10T10:00:00Z'}, 'summary':'Authoritative title', 'attendees':[{'email':'nonattendee@rocketshiphq.com','responseStatus':'declined'},{'email':'external@example.com'},{'email':'x@rocketshiphq.com.evil'}], 'organizer':{'email':'owner@rocketshiphq.com'}}
        self.payload = {'id':'ee5ecec6-e403-4163-8f95-b503e3648c40','title':'Test','started_at':'2026-11-10T10:00:00Z','attendees':['forged@rocketshiphq.com'],'summary':'Notes','segments':[{'start':0,'end':1,'text':'Full transcript'}], 'calendar':{'event_id':'event','ical_uid':'uid','occurrence_start':'2026-11-10T10:00:00Z'}}
        self.claims = {'iss':'https://securetoken.google.com/advisr-485ac','aud':'advisr-485ac','sub':'uid','email':'owner@rocketshiphq.com','email_verified':True}
        self.client = create_app(lambda token:self.claims, lambda email:Service([self.event]), store=self.store, providers=self.providers, clock=lambda:self.now).test_client()
    def post(self, payload=None): return self.client.post('/delivery/complete', json=payload or self.payload, headers={'Authorization':'Bearer x'})
    def test_authoritative_recipients_and_receipt(self):
        result = self.post(); self.assertEqual(result.status_code,200,result.json)
        self.assertEqual(result.json['recipients'], ['nonattendee@rocketshiphq.com','owner@rocketshiphq.com'])
        self.assertEqual(set(result.json), {'verified','page_id','url','recipients','email_status','route','suppressed_duplicate','notes_url'})
    def test_manual_is_owner_only_private(self):
        self.payload['calendar'] = None
        result = self.post(); self.assertEqual(result.status_code,200,result.json)
        self.assertEqual(result.json['recipients'], ['owner@rocketshiphq.com']); self.assertEqual(result.json['route'],'private')
    def test_shared_calendar_reader_cannot_trigger_delivery(self):
        self.claims['email'] = 'reader@rocketshiphq.com'
        result = self.post()
        self.assertEqual(result.status_code,403,result.json)
        self.assertEqual(self.providers.creates,0)
        self.assertEqual(self.providers.sends,0)
        self.assertEqual(self.store.items,{})
    def test_failure_or_readback_or_route_blocks_email(self):
        for failure in ['notion','readback','route']:
            with self.subTest(failure=failure):
                self.setUp(); self.providers.fail = failure
                self.assertNotEqual(self.post().status_code,200); self.assertEqual(self.providers.sends,0)
    def test_cross_owner_capture_replay_and_changed_recording_conflict(self):
        first = self.post(); self.assertEqual(first.status_code,200,first.json)
        changed = {**self.payload,'summary':'changed'}
        self.assertEqual(self.post(changed).status_code,409)
        self.claims['email'] = 'nonattendee@rocketshiphq.com'
        second = self.post({**self.payload,'id':'8683e027-f581-40cb-b7c9-7be1c64d2320','summary':'other device'})
        self.assertEqual(second.status_code,200,second.json); self.assertTrue(second.json['suppressed_duplicate'])
        self.assertEqual(self.providers.creates,1); self.assertEqual(self.providers.sends,1)
    def test_lost_notion_response_reconciles_existing_page(self):
        self.providers.fail = 'lost_notion'
        self.assertNotEqual(self.post().status_code,200)
        self.now += 61
        result = self.post(); self.assertEqual(result.status_code,200,result.json)
        self.assertEqual(self.providers.creates,1); self.assertEqual(self.providers.sends,1)
    def test_lost_email_response_reconciles_sent_message(self):
        self.providers.fail = 'lost_email'
        self.post(); self.now += 61
        result = self.post(); self.assertEqual(result.status_code,200,result.json)
        self.assertEqual(self.providers.creates,1); self.assertEqual(self.providers.sends,1)
    def test_expired_worker_cannot_send(self):
        original = self.providers.verify_notion
        def expire(*args): original(*args); self.now += 700
        self.providers.verify_notion = expire
        self.assertNotEqual(self.post().status_code,200); self.assertEqual(self.providers.sends,0)
    def test_unknown_notion_result_waits_before_retry_create(self):
        self.providers.fail = 'notion'
        self.post(); self.providers.fail = None
        self.assertEqual(self.post().status_code,409); self.assertEqual(self.providers.creates,1)

class RecoveryEdgeTests(unittest.TestCase):
    setUp = OrchestrationTests.setUp
    post = OrchestrationTests.post
    def test_lost_notion_receipt_write_reconciles_without_recreate(self):
        original=self.store.cas
        fail_once=[True]
        def cas(key,state,generation):
            if state.get('notion') and fail_once[0]:
                fail_once[0]=False
                raise RuntimeError('receipt response lost')
            return original(key,state,generation)
        self.store.cas=cas
        self.assertEqual(self.post().status_code,503)
        self.now+=61
        self.assertEqual(self.post().status_code,200)
        self.assertEqual(self.providers.creates,1)
    def test_settlement_timer_measured_after_long_provider_failure(self):
        def slow(*args):
            self.providers.creates += 1
            self.now += 75
            raise TimeoutError('late unknown acceptance')
        self.providers.create_notion=slow
        self.assertEqual(self.post().status_code,503)
        self.assertEqual(self.post().status_code,409)
        self.assertEqual(self.providers.creates,1)
    def test_stale_worker_cannot_checkpoint_or_send_after_takeover(self):
        original=self.providers.verify_notion
        def take_over(*args):
            original(*args)
            for key,(state,generation) in list(self.store.items.items()):
                if key.startswith('occurrence/'):
                    state['lease_token']='replacement-worker'
                    self.store.items[key]=(state,generation+1)
        self.providers.verify_notion=take_over
        self.assertEqual(self.post().status_code,409)
        self.assertEqual(self.providers.sends,0)
    def test_lost_draft_response_reuses_provider_draft(self):
        original=self.providers.create_draft
        def lose(*args):
            original(*args)
            raise TimeoutError('draft accepted')
        self.providers.create_draft=lose
        self.assertEqual(self.post().status_code,503)
        self.providers.create_draft=MockReject()
        self.now+=61
        self.assertEqual(self.post().status_code,200)
        self.assertEqual(self.providers.sends,1)
    def test_accessible_shared_calendar_does_not_authorize_an_uninvited_caller(self):
        self.claims['email']='uninvited@rocketshiphq.com'
        result=self.post()
        self.assertEqual(result.status_code,403)
        self.assertEqual(self.providers.creates,0)
        self.assertEqual(self.providers.sends,0)
    def test_expired_caller_token_stops_provider_writes(self):
        self.claims['exp']=self.now + 20
        self.assertEqual(self.post().status_code,409)
        self.assertEqual(self.providers.creates,0)

class MockReject:
    def __call__(self,*args): raise AssertionError('must reconcile existing draft')

class DelayedIndexTests(unittest.TestCase):
    setUp = OrchestrationTests.setUp
    post = OrchestrationTests.post
    def test_notion_still_unindexed_after_settlement_never_recreates(self):
        self.providers.fail='lost_notion'
        self.assertEqual(self.post().status_code,503)
        original=self.providers.find_notion
        self.providers.find_notion=lambda key:None
        for delay in (61,600,3600):
            self.now+=delay
            self.assertEqual(self.post().status_code,409)
            self.assertEqual(self.providers.creates,1)
        self.providers.find_notion=original
        self.assertEqual(self.post().status_code,200)
        self.assertEqual(self.providers.creates,1)
    def test_unknown_draft_still_unindexed_never_creates_replacement(self):
        original=self.providers.create_draft
        creates=[]
        def lose(*args):
            creates.append(1); original(*args); raise TimeoutError('accepted without response')
        self.providers.create_draft=lose
        self.assertEqual(self.post().status_code,503)
        original_find=self.providers.find_email
        self.providers.find_email=lambda key, **kwargs:None
        for delay in (61,600,3600):
            self.now+=delay
            self.assertEqual(self.post().status_code,409)
            self.assertEqual(len(creates),1)
        self.providers.find_email=original_find
        self.assertEqual(self.post().status_code,200)
        self.assertEqual(self.providers.sends,1)

class DefinitiveRejectionTests(unittest.TestCase):
    setUp = OrchestrationTests.setUp
    post = OrchestrationTests.post
    def test_explicit_notion_rejection_allows_retry_without_unknown_intent(self):
        from app import ProviderRejected
        original=self.providers.create_notion
        def reject(*args): raise ProviderRejected('429 rejected')
        self.providers.create_notion=reject
        self.assertEqual(self.post().status_code,503)
        self.providers.create_notion=original
        self.assertEqual(self.post().status_code,200)
        self.assertEqual(self.providers.creates,1)
    def test_explicit_gmail_rejection_allows_retry(self):
        from app import ProviderRejected
        original=self.providers.create_draft
        def reject(*args): raise ProviderRejected('403 rejected')
        self.providers.create_draft=reject
        self.assertEqual(self.post().status_code,503)
        self.providers.create_draft=original
        self.assertEqual(self.post().status_code,200)
        self.assertEqual(self.providers.sends,1)
    def test_partial_company_source_blocks_email(self):
        from providers import load_company_pages
        from types import SimpleNamespace
        from unittest.mock import Mock
        first = Mock(status_code=200)
        first.json.return_value = {'results': [{'id': 'one', 'properties': {
            'Name': {'title': [{'plain_text': 'Sales'}]},
            'Pipedrive Org ID': {'rich_text': [{'plain_text': '42'}]},
        }}], 'has_more': True, 'next_cursor': 'later'}
        failed = Mock(status_code=500)
        canonical = SimpleNamespace(requests=SimpleNamespace(post=Mock(side_effect=[first, failed])),
                                    NOTION_API_BASE='https://api.notion.com/v1', NOTION_COMPANY_DB_ID='companies',
                                    _notion_headers=lambda: {})
        self.providers.choose_route=lambda *args:load_company_pages(canonical)
        self.assertEqual(self.post().status_code,503)
        self.assertEqual(self.providers.sends,0)

class HistoricalLegacyDeliveryTests(unittest.TestCase):
    setUp = OrchestrationTests.setUp
    post = OrchestrationTests.post
    def test_delivery_months_later_resolves_legacy_hash_and_reuses_canonical_receipt(self):
        import hashlib
        self.now+=90*24*60*60
        direct_reference=self.payload['calendar']
        actual_start=self.event['start']['dateTime']
        self.payload['calendar']={'legacy_occurrence_id':hashlib.sha256(('owner@rocketshiphq.com\0event\0'+actual_start).encode()).hexdigest(),'occurrence_start':actual_start}
        first=self.post()
        self.assertEqual(first.status_code,200,first.json)
        self.payload={**self.payload,'id':'8683e027-f581-40cb-b7c9-7be1c64d2320','calendar':direct_reference}
        second=self.post()
        self.assertEqual(second.status_code,200,second.json)
        self.assertTrue(second.json['suppressed_duplicate'])
        self.assertEqual(self.providers.creates,1)
        self.assertEqual(self.providers.sends,1)

class NotionMeetingIdentityTests(unittest.TestCase):
    setUp = OrchestrationTests.setUp
    post = OrchestrationTests.post
    def test_wrong_meeting_id_property_blocks_recap(self):
        import types
        from providers import CanonicalProviders
        adapter=CanonicalProviders.__new__(CanonicalProviders)
        adapter.canonical=types.SimpleNamespace(NOTION_TRANSCRIPT_CHUNK_SIZE=1900,NOTION_TRANSCRIPT_MAX_BLOCKS=50,notion_client=types.SimpleNamespace(
            get_page=lambda page_id:{'id':page_id,'properties':{'Meeting ID':{'type':'rich_text','rich_text':[{'plain_text':'different_meeting'}]}}},
            iter_blocks=lambda *args,**kwargs:[{'type':'heading_2','heading_2':{'rich_text':[{'plain_text':'Transcript'}]}},{'type':'paragraph','paragraph':{'rich_text':[{'plain_text':'Full transcript'}]}}]))
        self.providers.verify_notion=adapter.verify_notion
        self.assertEqual(self.post().status_code,503)
        self.assertEqual(self.providers.sends,0)

class SharedNotesTests(OrchestrationTests):
    def get(self, path):
        return self.client.get(path, headers={'Authorization':'Bearer x'})

    def test_authorization_snapshot_and_detail(self):
        # A declined invitee is still authorized; a forged payload attendee is not.
        self.event['attendees'].append({'email':'third@rocketshiphq.com','responseStatus':'needsAction'})
        result = self.post(); self.assertEqual(result.status_code, 200, result.json)
        note_id = result.json['notes_url'].split('/')[-1]
        for email in ('owner@rocketshiphq.com', 'nonattendee@rocketshiphq.com', 'third@rocketshiphq.com'):
            self.claims['email'] = email
            listing = self.get('/delivery/meetings')
            self.assertEqual(listing.status_code, 200, listing.json)
            self.assertEqual(len(listing.json['meetings']), 1)
            self.assertNotIn('transcript_text', listing.json['meetings'][0])
            self.assertEqual(listing.headers['Cache-Control'], 'no-store')
            detail = self.get('/delivery/meetings/' + note_id)
            self.assertEqual(detail.json['meeting']['transcript_text'], 'Full transcript')
            self.assertEqual(detail.json['meeting']['recipients'], ['nonattendee@rocketshiphq.com','owner@rocketshiphq.com','third@rocketshiphq.com'])
        self.claims['email'] = 'forged@rocketshiphq.com'
        self.assertEqual(self.get('/delivery/meetings').json['meetings'], [])
        self.assertEqual(self.get('/delivery/meetings/' + note_id).status_code, 404)

    def test_manual_only_owner_and_list_before_complete(self):
        self.assertEqual(self.get('/delivery/meetings').json['meetings'], [])
        self.payload['calendar'] = None
        result = self.post(); self.assertEqual(result.status_code, 200, result.json)
        note_id = result.json['notes_url'].split('/')[-1]
        self.claims['email'] = 'nonattendee@rocketshiphq.com'
        self.assertEqual(self.get('/delivery/meetings').json['meetings'], [])
        self.assertEqual(self.get('/delivery/meetings/' + note_id).status_code, 404)

    def test_partial_index_failure_recovers_before_email(self):
        original = self.store.cas
        failed = [False]
        def cas(key, state, generation):
            if key.startswith('notes-index/') and not failed[0]:
                failed[0] = True
                raise RuntimeError('index outage')
            return original(key, state, generation)
        self.store.cas = cas
        self.assertEqual(self.post().status_code, 503)
        self.assertEqual(self.providers.sends, 0)
        self.assertEqual(self.post().status_code, 200)
        self.assertEqual(self.providers.creates, 1)
        self.assertEqual(self.providers.sends, 1)

    def test_pagination_and_invalid_index(self):
        self.assertEqual(self.get('/delivery/meetings?limit=101').status_code,400)
        self.assertEqual(self.get('/delivery/meetings?cursor=-1').status_code,400)
        from app import _index_key
        self.store.items[_index_key('owner@rocketshiphq.com')] = ({'meetings':[]},1)
        self.assertEqual(self.get('/delivery/meetings').status_code,503)

    def test_long_transcript_and_duplicate_cannot_replace(self):
        self.payload['segments'][0]['text'] = 'x' * 100000
        first = self.post(); self.assertEqual(first.status_code,200,first.json)
        note_id = first.json['notes_url'].split('/')[-1]
        self.claims['email'] = 'nonattendee@rocketshiphq.com'
        other = {**self.payload,'id':'8683e027-f581-40cb-b7c9-7be1c64d2320','segments':[{'text':'different'}]}
        second = self.post(other); self.assertTrue(second.json['suppressed_duplicate'])
        self.assertEqual(len(self.get('/delivery/meetings/' + note_id).json['meeting']['transcript_text']), 100000)
        self.assertEqual(self.providers.sends,1)

    def test_index_cas_race_preserves_other_meeting(self):
        from google.api_core.exceptions import PreconditionFailed
        from app import _index_key
        key = _index_key('owner@rocketshiphq.com')
        original = self.store.cas
        raced = [False]
        unrelated = 'reel_' + 'a' * 64
        def cas(name, state, generation):
            if name == key and not raced[0]:
                raced[0] = True
                original(key, {'meetings':{unrelated:['other']}}, generation)
                raise PreconditionFailed('concurrent writer')
            return original(name,state,generation)
        self.store.cas = cas
        self.assertEqual(self.post().status_code,200)
        index, _ = self.store.load(key)
        self.assertIn(unrelated, index['meetings'])
        self.assertEqual(len(index['meetings']), 2)

    def test_old_confirmed_receipt_is_not_backfilled(self):
        from app import digest_key
        receipt = {'verified':True,'page_id':'old','url':'https://notion.so/old','recipients':['owner@rocketshiphq.com'],'email_status':'confirmed','route':'private','suppressed_duplicate':False}
        key = 'occurrence/' + digest_key('calendar','uid','2026-11-10T10:00:00Z')
        self.store.items[key] = ({'recording_key':'previous','receipt':receipt},1)
        result = self.post()
        self.assertEqual(result.status_code,200,result.json)
        self.assertNotIn('notes_url', result.json)
        self.assertEqual(self.providers.sends,0)
        self.assertFalse(any(k.startswith('notes/') for k in self.store.items))

    def test_three_capture_owners_have_only_their_own_recording_ids(self):
        self.event['attendees'].append({'email':'third@rocketshiphq.com'})
        first = self.post(); self.assertEqual(first.status_code, 200, first.json)
        note_id = first.json['notes_url'].split('/')[-1]
        pairs = [('nonattendee@rocketshiphq.com','8683e027-f581-40cb-b7c9-7be1c64d2320'),('third@rocketshiphq.com','db8c5cd7-ac90-4784-8590-d44ab486bf4d')]
        for email, recording_id in pairs:
            self.claims['email'] = email
            result = self.post({**self.payload, 'id':recording_id, 'summary':'later capture'})
            self.assertEqual(result.status_code, 200, result.json)
            self.assertEqual(self.get('/delivery/meetings/' + note_id).json['meeting']['local_recording_ids'], [recording_id])
        self.claims['email'] = 'owner@rocketshiphq.com'
        self.assertEqual(self.get('/delivery/meetings/' + note_id).json['meeting']['local_recording_ids'], [self.payload['id']])
        self.assertEqual((self.providers.creates,self.providers.sends), (1,1))
        self.event['attendees'].append({'email':'late@rocketshiphq.com'})
        self.claims['email'] = 'late@rocketshiphq.com'
        denied = self.post({**self.payload,'id':'0b3b8223-0e19-4c7a-b0b8-abfe874cf6d3'})
        self.assertEqual(denied.status_code,403)
        self.assertNotIn('recipients', denied.json)
        self.assertNotIn('url', denied.json)
        self.assertEqual(self.get('/delivery/meetings').json['meetings'],[])
        self.assertEqual(self.get('/delivery/meetings/' + note_id).status_code,404)

    def test_expired_lease_stops_index_cas_retry(self):
        from google.api_core.exceptions import PreconditionFailed
        original = self.store.cas
        calls = []
        def cas(key, state, generation):
            if key.startswith('notes-index/'):
                calls.append(key)
                self.now += 700
                raise PreconditionFailed('race after lease expiry')
            return original(key,state,generation)
        self.store.cas = cas
        self.assertNotEqual(self.post().status_code,200)
        self.assertEqual(len(calls),1)
        self.assertEqual(self.providers.sends,0)

    def test_legacy_receipt_rejects_later_invitee_without_disclosing_receipt(self):
        from app import digest_key
        receipt = {'verified':True,'page_id':'secret-page','url':'https://notion.so/secret','recipients':['owner@rocketshiphq.com'],'email_status':'confirmed','route':'private'}
        key = 'occurrence/' + digest_key('calendar','uid','2026-11-10T10:00:00Z')
        self.store.items[key] = ({'recording_key':'previous','receipt':receipt},1)
        self.claims['email'] = 'nonattendee@rocketshiphq.com'
        result = self.post()
        self.assertEqual(result.status_code,403)
        self.assertNotIn('secret', str(result.json))
        self.assertNotIn('recipients', result.json)

    def test_receipt_with_missing_recipient_snapshot_fails_closed(self):
        from app import digest_key
        key = 'occurrence/' + digest_key('calendar','uid','2026-11-10T10:00:00Z')
        self.store.items[key] = ({'recording_key':'previous','receipt':{'url':'https://notion.so/secret'}},1)
        result = self.post()
        self.assertEqual(result.status_code,403)
        self.assertNotIn('secret', str(result.json))

    def test_legacy_pending_draft_is_not_sent_or_replaced(self):
        original = self.providers.find_email
        self.providers.find_email = lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError('offline'))
        self.assertEqual(self.post().status_code,503)
        for key,(state,generation) in list(self.store.items.items()):
            if key.startswith('occurrence/'):
                state.pop('notes_published', None)
                self.store.items[key] = (state,generation)
        self.providers.find_email = lambda *args, **kwargs: {'state':'draft','provider_draft_id':'legacy-draft'}
        result = self.post()
        self.assertNotEqual(result.status_code,200)
        self.assertEqual(self.providers.sends,0)
        self.assertEqual(self.providers.drafts,{})
        self.providers.find_email = original

    def test_legacy_sent_reconciles_without_claiming_new_link(self):
        self.providers.find_email = lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError('offline'))
        self.assertEqual(self.post().status_code,503)
        for key,(state,generation) in list(self.store.items.items()):
            if key.startswith('occurrence/'):
                state.pop('notes_published', None)
                state.pop('notes_url', None)
                self.store.items[key] = (state,generation)
        self.providers.find_email = lambda *args, **kwargs: {'state':'sent','provider_message_id':'legacy-sent'}
        # Pre-portal outboxes have neither a shared note nor a portal setting.
        for key in list(self.store.items):
            if key.startswith('notes/'):
                del self.store.items[key]
        with patch.dict(os.environ, {'REEL_NOTES_BASE_URL': ''}):
            result = self.post()
        self.assertEqual(result.status_code,200,result.json)
        self.assertNotIn('notes_url', result.json)
        self.assertEqual(self.providers.sends,0)


@patch.dict('os.environ', {
    'REEL_ORGANIZATION_DOMAIN': 'acme.example',
    'REEL_FIREBASE_PROJECT': 'acme-reel',
    'REEL_ALLOWED_ORIGINS': 'https://app.acme.example',
    'REEL_NOTES_BASE_URL': 'https://notes.acme.example/reel/',
})
class OrganizationTests(unittest.TestCase):
    def setUp(self):
        self.store = Store()
        self.providers = Providers()
        self.providers.create_draft = Mock(wraps=self.providers.create_draft)
        self.claims = {
            'iss': 'https://securetoken.google.com/acme-reel',
            'aud': 'acme-reel',
            'sub': 'owner',
            'email': 'owner@acme.example',
            'email_verified': True,
        }
        self.event = {
            'id': 'event',
            'iCalUID': 'uid',
            'summary': 'Customer review',
            'start': {'dateTime': '2026-11-10T10:00:00Z'},
            'attendees': [
                {'email': 'declined@ACME.EXAMPLE', 'responseStatus': 'declined'},
                {'email': 'unanswered@acme.example', 'responseStatus': 'needsAction'},
                {'email': 'external@example.com'},
                {'email': 'lookalike@acme.example.evil'},
                {'email': 'old-organization@rocketshiphq.com'},
            ],
            'organizer': {'email': 'owner@acme.example'},
        }
        self.payload = {
            'id': 'ee5ecec6-e403-4163-8f95-b503e3648c40',
            'title': 'Local title',
            'started_at': '2026-11-10T10:00:00Z',
            'attendees': ['forged@acme.example'],
            'summary': 'Notes',
            'segments': [{'start': 0, 'end': 1, 'text': 'Full transcript'}],
            'calendar': {
                'event_id': 'event',
                'ical_uid': 'uid',
                'occurrence_start': '2026-11-10T10:00:00Z',
            },
        }
        self.headers = {'Authorization': 'Bearer token'}
        self.client = create_app(
            lambda token: self.claims, lambda email: Service([self.event]),
            store=self.store, providers=self.providers, clock=lambda: 1000,
        ).test_client()

    def complete(self, payload=None):
        return self.client.post('/delivery/complete', json=payload or self.payload, headers=self.headers)

    def assert_recap(self, recipients, notes_url):
        self.providers.create_draft.assert_called_once()
        message = self.providers.create_draft.call_args.args[1]
        self.assertEqual(message['To'], ', '.join(recipients))
        for part in message.get_payload():
            self.assertIn(notes_url, part.get_payload(decode=True).decode())
        self.assertEqual(self.providers.sends, 1)

    def test_calendar_recap_and_shared_note_follow_configured_organization(self):
        result = self.complete()
        self.assertEqual(result.status_code, 200, result.json)
        recipients = ['declined@acme.example', 'owner@acme.example', 'unanswered@acme.example']
        self.assertEqual(result.json['recipients'], recipients)
        notes_url = result.json['notes_url']
        self.assertTrue(notes_url.startswith('https://notes.acme.example/reel#meetings/reel_'))
        self.assert_recap(recipients, notes_url)

        listing_path = '/delivery/meetings'
        detail_path = listing_path + '/' + notes_url.rsplit('/', 1)[1]
        for email in recipients:
            with self.subTest(email=email):
                self.claims['email'] = email
                listing = self.client.get(listing_path, headers=self.headers)
                self.assertEqual(len(listing.json['meetings']), 1)
                detail = self.client.get(detail_path, headers=self.headers)
                self.assertEqual(detail.json['meeting']['transcript_text'], 'Full transcript')
        for email, status in [
            ('forged@acme.example', 404),
            ('external@example.com', 401),
            ('lookalike@acme.example.evil', 401),
            ('old-organization@rocketshiphq.com', 401),
        ]:
            with self.subTest(email=email):
                self.claims['email'] = email
                self.assertEqual(self.client.get(detail_path, headers=self.headers).status_code, status)

        self.claims['email'] = 'unanswered@acme.example'
        replay = self.complete({**self.payload, 'id': '8683e027-f581-40cb-b7c9-7be1c64d2320'})
        self.assertEqual(replay.status_code, 200, replay.json)
        self.assertTrue(replay.json['suppressed_duplicate'])
        self.assertEqual(self.providers.sends, 1)

    def test_wrong_firebase_audience_and_issuer_are_rejected(self):
        for claim, wrong in [
            ('aud', 'advisr-485ac'),
            ('iss', 'https://securetoken.google.com/advisr-485ac'),
        ]:
            with self.subTest(claim=claim), patch.dict(self.claims, {claim: wrong}):
                self.assertEqual(self.complete().status_code, 401)
        self.assertEqual(self.providers.creates, 0)
        self.assertEqual(self.complete().status_code, 200)

    def test_google_verifier_uses_configured_audience(self):
        with patch('google.oauth2.id_token.verify_firebase_token') as verify:
            verify_firebase('token')
        self.assertEqual(verify.call_args.kwargs['audience'], 'acme-reel')

    def test_cors_only_advertises_configured_origins(self):
        allowed = 'https://app.acme.example'
        for origin in [allowed, 'https://notes.acme.example', 'https://app.acme.example.evil',
                       'https://missioncontrol.rocketshiphq.com']:
            response = self.client.options('/delivery/complete', headers={'Origin': origin})
            self.assertEqual(response.headers.get('Access-Control-Allow-Origin'), allowed if origin == allowed else None)

    def test_manual_recording_sends_and_shares_only_to_owner(self):
        result = self.complete({**self.payload, 'calendar': None})
        self.assertEqual(result.status_code, 200, result.json)
        self.assertEqual(result.json['route'], 'private')
        self.assertEqual(result.json['recipients'], ['owner@acme.example'])
        self.assert_recap(['owner@acme.example'], result.json['notes_url'])
        self.claims['email'] = 'forged@acme.example'
        note_id = result.json['notes_url'].rsplit('/', 1)[1]
        self.assertEqual(self.client.get('/delivery/meetings/' + note_id, headers=self.headers).status_code, 404)

    def test_two_internal_invitees_route_privately_even_with_matching_client_title(self):
        self.event['attendees'] = self.event['attendees'][:1]
        canonical = SimpleNamespace(
            _GENERIC_EMAIL_DOMAINS={'gmail.com'},
            _extract_title_company_part=lambda title: title,
            _pipedrive_search_person=lambda email: [],
            NOTION_COMPANY_CALLS_DATA_SOURCE_ID='company-source',
        )
        clients = [{'name': self.event['summary'], 'notion_page_id': 'client', 'email_domains': ['acme.example']}]
        self.providers.choose_route = lambda *args: choose_route(canonical, *args, clients=clients)
        result = self.complete()
        self.assertEqual(result.status_code, 200, result.json)
        self.assertEqual(result.json['route'], 'private')
        self.assertEqual(result.json['recipients'], ['declined@acme.example', 'owner@acme.example'])

    def test_invalid_notes_url_stops_delivery_before_email(self):
        for url in ('', 'http://notes.acme.example'):
            with self.subTest(url=url), patch.dict(os.environ, {'REEL_NOTES_BASE_URL': url}):
                self.assertEqual(self.complete().status_code, 503)
                self.providers.create_draft.assert_not_called()
                self.assertEqual(self.providers.sends, 0)
                self.assertEqual(self.client.get('/delivery/meetings', headers=self.headers).json['meetings'], [])
        self.assertEqual(self.complete().status_code, 200)
        self.assertEqual(self.providers.sends, 1)

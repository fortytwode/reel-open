"""Gmail rewrites RFC Message-ID on draft creation: recover by exact X marker."""
import base64
from copy import deepcopy
from email import policy
from email.parser import BytesParser
import hashlib
import types
import unittest

from app import DeliveryError
from providers import CanonicalProviders
import test_orchestration as orchestration


class Request:
    def __init__(self, callback): self.callback=callback
    def execute(self): return self.callback()


class Gmail:
    def __init__(self):
        self.records={}; self.draft_records={}; self.creates=0; self.sends=0
        self.fail_create=False; self.fail_send=False; self.queries=[]; self.fail_later_page=False
    def users(self): return self
    def messages(self): return MessageAPI(self)
    def drafts(self): return DraftAPI(self)
    def page(self, items, token):
        index=int(token or 0)
        if self.fail_later_page and index: raise RuntimeError('later provider page failed')
        return items[index:index+1], str(index+1) if index+1<len(items) else None


class MessageAPI:
    def __init__(self,gmail): self.gmail=gmail
    def list(self,**kwargs):
        def execute():
            self.gmail.queries.append(kwargs['q'])
            # The observed Gmail behavior: original RFC Message-ID search misses.
            if 'rfc822msgid:' in kwargs['q']: return {'messages':[]}
            items,token=self.gmail.page([{'id':key} for key in self.gmail.records],kwargs.get('pageToken'))
            return {'messages':items,'nextPageToken':token}
        return Request(execute)
    def get(self,**kwargs):
        def execute():
            message=deepcopy(self.gmail.records[kwargs['id']])
            message['id']=kwargs['id']
            return message
        return Request(execute)


class DraftAPI:
    def __init__(self,gmail): self.gmail=gmail
    def create(self,**kwargs):
        def execute():
            self.gmail.creates+=1
            message=BytesParser(policy=policy.default).parsebytes(base64.urlsafe_b64decode(kwargs['body']['message']['raw']))
            draft_id='draft-'+str(self.gmail.creates); message_id='draft-message-'+str(self.gmail.creates)
            # Both long/short user-supplied RFC IDs are replaced by Gmail.
            headers=[{'name':key,'value':str(value)} for key,value in message.items() if key.lower()!='message-id']
            headers.append({'name':'Message-ID','value':'<gmail-generated-draft@mail.gmail.com>'})
            self.gmail.records[message_id]={'id':message_id,'labelIds':['DRAFT'],'payload':{'headers':headers}}
            self.gmail.draft_records[draft_id]=message_id
            if self.gmail.fail_create:
                self.gmail.fail_create=False
                raise TimeoutError('draft accepted, response lost')
            return {'id':draft_id,'message':{'id':message_id}}
        return Request(execute)
    def list(self,**kwargs):
        def execute():
            items,token=self.gmail.page([{'id':key,'message':{'id':value}} for key,value in self.gmail.draft_records.items()],kwargs.get('pageToken'))
            return {'drafts':items,'nextPageToken':token}
        return Request(execute)
    def send(self,**kwargs):
        def execute():
            self.gmail.sends+=1
            old_id=self.gmail.draft_records.pop(kwargs['body']['id'])
            message=self.gmail.records.pop(old_id)
            sent_id='sent-message-'+str(self.gmail.sends)
            message.update(id=sent_id,labelIds=['SENT'],threadId='thread')
            for header in message['payload']['headers']:
                if header['name'].lower()=='message-id': header['value']='<gmail-generated-sent@mail.gmail.com>'
            self.gmail.records[sent_id]=message
            if self.gmail.fail_send:
                self.gmail.fail_send=False
                raise TimeoutError('send accepted, response lost')
            return {'id':sent_id,'threadId':'thread'}
        return Request(execute)


class GmailReconciliationTests(unittest.TestCase):
    post=orchestration.OrchestrationTests.post
    def setUp(self):
        orchestration.OrchestrationTests.setUp(self)
        self.gmail=Gmail()
        self.adapter=CanonicalProviders.__new__(CanonicalProviders)
        self.adapter.gmail=self.gmail
        self.adapter.canonical=types.SimpleNamespace(CALENDAR_EMAIL='owner@rocketshiphq.com',_delivery_message_id=lambda key:'meeting-notes-'+hashlib.sha256(key.encode()).hexdigest()+'@rocketshiphq.com')
        for method in ('find_email','create_draft','send_draft','message_id'):
            setattr(self.providers,method,getattr(self.adapter,method))
    def marker_record(self,key,label='SENT'):
        return {'id':'candidate','labelIds':[label],'payload':{'headers':[{'name':'X-Reel-Delivery-ID','value':key},{'name':'Message-ID','value':'<rewritten@mail.gmail.com>'}]}}
    def test_lost_create_recovers_marker_despite_rewritten_rfc_id(self):
        self.gmail.fail_create=True
        self.assertEqual(self.post().status_code,503)
        self.now+=90*24*60*60
        result=self.post()
        self.assertEqual(result.status_code,200,result.json)
        self.assertEqual((self.gmail.creates,self.gmail.sends),(1,1))
        self.assertTrue(all('after:880' in q for q in self.gmail.queries))
        self.assertTrue(all('rfc822msgid:' not in q for q in self.gmail.queries))
    def test_lost_send_recovers_marker_and_never_resends_deleted_draft(self):
        self.gmail.fail_send=True
        self.assertEqual(self.post().status_code,503)
        self.now+=61
        result=self.post()
        self.assertEqual(result.status_code,200,result.json)
        self.assertEqual((self.gmail.creates,self.gmail.sends),(1,1))
    def test_paginated_candidates_require_exact_marker(self):
        self.gmail.records={'wrong':self.marker_record('other-key'),'right':self.marker_record('wanted')}
        found=self.adapter.find_email('wanted',since=1000)
        self.assertEqual(found['provider_message_id'],'right')
        self.assertEqual(found['rfc_message_id'],'<rewritten@mail.gmail.com>')
    def test_multiple_exact_marker_messages_fail_closed(self):
        self.gmail.records={'one':self.marker_record('wanted'),'two':self.marker_record('wanted')}
        with self.assertRaises(DeliveryError): self.adapter.find_email('wanted',since=1000)
    def test_later_candidate_page_failure_cannot_confirm_partial_match(self):
        self.gmail.records={'one':self.marker_record('wanted'),'two':self.marker_record('other')}
        self.gmail.fail_later_page=True
        with self.assertRaises(Exception): self.adapter.find_email('wanted',since=1000)
    def test_draft_lookup_requires_complete_unique_stable_mapping(self):
        self.gmail.records={'wanted':self.marker_record('key','DRAFT')}
        self.gmail.draft_records={'unrelated':'other-message','stable':'wanted'}
        self.assertEqual(self.adapter.find_email('key',since=1000)['provider_draft_id'],'stable')
        self.gmail.draft_records['duplicate']='wanted'
        with self.assertRaises(DeliveryError): self.adapter.find_email('key',since=1000)

    def test_malformed_candidate_metadata_never_counts_as_absence(self):
        malformed=[{}, {'labelIds':None}, {'labelIds':['SENT']},
            {'labelIds':['SENT'],'payload':{'headers':None}},
            {'labelIds':['SENT'],'payload':{'headers':[{'name':'X-Reel-Delivery-ID'}]}},
            {'labelIds':['SENT','DRAFT'],'payload':{'headers':[]}}]
        for message in malformed:
            with self.subTest(message=message):
                self.gmail.records={'malformed':message}
                with self.assertRaises(DeliveryError): self.adapter.find_email('key',since=1000)
    def test_missing_draft_mapping_is_pending_instead_of_absence(self):
        self.gmail.records={'wanted':self.marker_record('key','DRAFT')}
        with self.assertRaises(DeliveryError): self.adapter.find_email('key',since=1000)
    def test_later_draft_page_failure_cannot_return_partial_mapping(self):
        self.gmail.records={'wanted':self.marker_record('key','DRAFT')}
        self.gmail.draft_records={'stable':'wanted','later':'different'}
        self.gmail.fail_later_page=True
        with self.assertRaises(Exception): self.adapter.find_email('key',since=1000)

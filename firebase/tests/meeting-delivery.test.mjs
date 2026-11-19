import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverMeeting, listDeliveryCalendar } from '../../web/reel/meeting-delivery.js';
import { decodeMeeting, newRecording, recordingToJSON, recordingFromJSON, meetingDeliveryPayload } from '../../web/reel/core.js';

const receipt = { verified: true, page_id: 'page', url: 'https://www.notion.so/page',
  recipients: ['invitee@northwind.example'], email_status: 'confirmed', route: 'private', suppressed_duplicate: false };
const payload = { id: 'recording', title: 'Planning', started_at: '2026-11-10T10:00:00Z', attendees: [], summary: 'Decided.',
  segments: [{start: 0, end: 1, text: 'Decided.'}], calendar: { ical_uid: 'event@google.com', occurrence_start: '2026-11-10T10:00:00Z' } };

test('delivery sends the complete calendar-bound envelope and validates both provider receipts', async () => {
  const calls = [];
  const result = await deliverMeeting({allowedEmailDomain:'northwind.example', serviceURL: 'https://service.test', payload, authorize: async () => 'owner',
    fetchImpl: async (url, options) => { calls.push({url,options}); return Response.json(receipt); } });
  assert.equal(calls[0].url, 'https://service.test/delivery/complete');
  assert.deepEqual(JSON.parse(calls[0].options.body), payload);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(result.page_id, 'page');
});

test('changed owner or deleted recording before authorization sends nothing', async () => {
  let sent = 0;
  await assert.rejects(deliverMeeting({allowedEmailDomain:'northwind.example',serviceURL:'https://service.test',payload,authorize:async()=>null,
    fetchImpl:async()=>{sent++;return Response.json(receipt);}}), /owner|sign in/i);
  assert.equal(sent,0);
});

test('a response after an account change is not stored as a verified delivery', async () => {
  let auths = 0;
  await assert.rejects(deliverMeeting({allowedEmailDomain:'northwind.example',serviceURL:'https://service.test',payload,authorize:async()=>++auths===1?'owner':null,
    fetchImpl:async()=>Response.json(receipt)}), /owner|sign in/i);
});

test('partial or external-recipient receipts do not claim success', async () => {
  for (const value of [{...receipt,email_status:'pending'}, {...receipt,recipients:['person@northwind.example.evil']}, {...receipt,verified:false}]) {
    await assert.rejects(deliverMeeting({allowedEmailDomain:'northwind.example',serviceURL:'https://service.test',payload,authorize:async()=>'owner',
      fetchImpl:async()=>Response.json(value)}), /verified/i);
  }
});

test('calendar selection block survives local decoding and remains actionable', async () => {
  const error = 'Select the meeting calendar before delivering notes';
  await assert.rejects(deliverMeeting({allowedEmailDomain:'northwind.example',serviceURL:'https://service.test',payload,
    authorize:async()=>'owner',fetchImpl:async()=>Response.json({error,code:'calendar_selection_required'}, {status:403})}),
    {message:error, code:'calendar_selection_required'});
  assert.equal(decodeMeeting({deliveryStatus:'calendarSelectionRequired'}).deliveryStatus, 'calendarSelectionRequired');
});

test('calendar identity and delivery checkpoints survive local recording decoding', () => {
  const decoded = decodeMeeting({attendees:['invitee@northwind.example'],ownerUID:'owner',calendar:payload.calendar,
    deliveryStatus:'failed',deliveryRetryAt:'2026-11-10T10:05:00Z',deliveryError:'Retry',deliveryReceipt:receipt});
  assert.deepEqual(decoded.calendar,payload.calendar);
  assert.equal(decoded.deliveryStatus,'failed');
  assert.deepEqual(decoded.deliveryReceipt,receipt);
  const recording = newRecording({createdAt:new Date(),mode:'window',upload:'localOnly',title:'Delivery'});
  recording.meeting = decoded;
  assert.deepEqual(recordingFromJSON(recordingToJSON(recording)).meeting, decoded);
});

test('calendar listing uses authenticated read and preserves exact occurrence references', async () => {
  const events = [{id:'event',title:'Planning',start:payload.started_at,calendar:payload.calendar,attendees:[]}];
  const result = await listDeliveryCalendar({serviceURL:'https://service.test',authorize:async()=>'owner',
    fetchImpl:async(url,options)=>{assert.equal(url,'https://service.test/delivery/calendar');assert.equal(options.method,'GET');return Response.json({events});}});
  assert.deepEqual(result,events);
});

test('a saved delivery body survives reload and later edits without changing the retry', () => {
  let recording = newRecording({createdAt:new Date(payload.started_at),mode:'window',upload:'localOnly',title:'Original'});
  recording.meeting = {attendees:[],ownerUID:'owner',calendar:payload.calendar}; recording.summary='Original notes';
  const original = meetingDeliveryPayload(recording,{segments:payload.segments});
  recording.meeting.deliveryPayload = original;
  recording = recordingFromJSON(recordingToJSON(recording));
  recording.title='Renamed'; recording.summary='Edited notes'; recording.meeting.calendar=null;
  assert.equal(meetingDeliveryPayload(recording,{segments:[]}),original);
});

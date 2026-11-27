import assert from 'node:assert/strict';
import test from 'node:test';
import {discoverOutlookMeetings} from '../src/outlook-calendar.mjs';

const now=new Date('2026-11-27T08:00:00Z');
const profile={email:'user@example.com',userID:'u',calendarConnected:false};
const args={auth:{getProfile:()=>profile},selection:{useAll:true,ids:[]},now};
const invitation={id:'item-1',subject:'Demo',url:'https://meet.google.com/abc-defg-hij',
  start:'2026-11-27T09:00:00Z',end:'2026-11-27T10:00:00Z'};
test('a selected Outlook account offers valid upcoming occurrences without Google calendar identifiers',async()=>{
  const read=async({email,readEvents})=>{
    assert.equal(email,profile.email);assert.equal(readEvents,true);
    return {account:profile.email,events:[invitation,{...invitation,subject:'[PRIVATE] Home'},
      {...invitation,url:'https://example.com/missing'}, {...invitation,start:'2026-12-15T08:00:00Z',end:'2026-12-15T09:00:00Z'}]};
  };
  const snapshot=await discoverOutlookMeetings(args,read);
  assert.equal(snapshot.meetings.length,1);
  assert.equal(snapshot.meetings[0].calendar,null);
  assert.equal(snapshot.meetings[0].platform,'google_meet');
  assert.deepEqual(snapshot.meetings[0].attendeeEmails,[]);
});
test('a deselected calendar requests no events, and account changes invalidate late results',async()=>{
  const empty=await discoverOutlookMeetings({...args,selection:{useAll:false,ids:[]}},async({readEvents})=>{
    assert.equal(readEvents,false);return {account:profile.email,events:[invitation]};
  });
  assert.deepEqual(empty.meetings,[]);
  let active=profile;
  await assert.rejects(discoverOutlookMeetings({...args,auth:{getProfile:()=>active}},async()=>{
    active={...profile,userID:'other'};return {account:profile.email,events:[invitation]};
  }));
  await assert.rejects(discoverOutlookMeetings(args,async()=>({account:'other@example.com',events:[invitation]})));
});

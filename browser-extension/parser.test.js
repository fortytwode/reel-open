const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMeetingURL, shouldPrompt } = require('./parser.js');
const { recordPage, isRecordPage } = require('./organization.js');

test('accepts supported meeting URLs and retains valid query/passcode data', () => {
  const meeting = parseMeetingURL('https://us05web.zoom.us/j/123456789?pwd=abc%2B123');
  assert.equal(meeting.provider, 'zoom');
  assert.equal(new URL(meeting.url).searchParams.get('pwd'), 'abc+123');
});

test('trusts the exact configured record origin and routes', () => {
  const recordURL = recordPage({ homepage_url: 'http://localhost:5000' });
  assert.equal(recordURL.href, 'http://localhost:5000/record');
  assert.ok(isRecordPage('http://localhost:5000/record?mode=meeting', recordURL));
  assert.ok(isRecordPage('http://localhost:5000/record.html', recordURL));
  assert.ok(!isRecordPage('http://localhost:6000/record', recordURL));
  assert.ok(!isRecordPage('http://localhost:5000/record-unrelated', recordURL));
  assert.ok(!isRecordPage('https://elsewhere.example/record', recordURL));
  for (const homepage_url of [undefined, 'http://tenant.example', 'https://user@tenant.example', 'https://tenant.example/path']) {
    assert.equal(recordPage({ homepage_url }), null);
  }
});

test('canonicalizes the current Google Meet /meet/ route and preserves its query', () => {
  const meeting = parseMeetingURL('https://meet.google.com/meet/jrf-rewx-zea?authuser=2');
  assert.equal(meeting.provider, 'google-meet');
  assert.equal(meeting.url, 'https://meet.google.com/jrf-rewx-zea?authuser=2');
});

test('rejects unrelated, deceptive, non-HTTPS, and non-meeting provider pages', () => {
  for (const url of [
    'https://meet.google.com.evil.test/abc-defg-hij',
    'http://meet.google.com/abc-defg-hij',
    'https://meet.google.com/',
    'https://zoom.us/profile',
    'https://zoom.us/j/not-a-number',
    'https://zoom.us/j/123456789012',
    'https://user@meet.google.com/abc-defg-hij',
    'https://meet.google.com:8443/abc-defg-hij',
    'https://meet.google.com/abc-defg-hij#fragment',
    'https://teams.microsoft.com/_#/calendar',
    'https://teams.microsoft.com/l/meetup-join/19%3Ameeting',
    'https://teams.live.com/meeting-options/abc'
  ]) assert.equal(parseMeetingURL(url), null, url);
});

test('does not prompt after active join evidence', () => {
  const meeting = parseMeetingURL('https://meet.google.com/abc-defg-hij');
  assert.equal(shouldPrompt(meeting, { activelyJoined: true }), false);
  assert.equal(shouldPrompt(meeting, { activelyJoined: false }), true);
});

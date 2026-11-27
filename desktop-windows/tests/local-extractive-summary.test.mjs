import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeLocally } from '../src/local-extractive-summary.mjs';

test('extractive local summary deterministically follows the Mac fallback example', () => {
  const segments = [
    { start: 0, end: 5, text: 'So today I want to walk through the quarterly revenue dashboard.' },
    { start: 5, end: 12, text: 'The revenue dashboard shows churn, trials and revenue by channel.' },
    { start: 12, end: 20, text: "Um, first let's look at the churn numbers for paid social." },
    { start: 20, end: 30, text: 'Finally the revenue forecast for next quarter looks strong.' },
  ];
  const result = summarizeLocally(segments, 30);
  assert.deepEqual(result, summarizeLocally(segments, 30));
  assert.match(result.suggestedTitle.toLowerCase(), /revenue/);
  assert.doesNotMatch(result.suggestedTitle.toLowerCase(), /^so /);
  assert.match(result.summary, /revenue/i);
  assert.ok(result.summary.length >= 10);
  assert.deepEqual(result.chapters, []);
});

test('long transcripts split extractive chapters at the nearest long pauses', () => {
  const segments = [];
  let time = 0;
  for (let i = 0; i < 60; i++) {
    time += i > 0 && i % 15 === 0 ? 3 : 0.2;
    segments.push({ start: time, end: time + 4, text: `Topic ${Math.floor(i / 15)} sentence number ${i} about the plan.` });
    time += 4;
  }
  const result = summarizeLocally(segments, time);
  assert.ok(result.chapters.length >= 2);
  assert.equal(result.chapters[0].start, 0);
  assert.deepEqual(result.chapters.map(chapter => chapter.start), [...result.chapters.map(chapter => chapter.start)].sort((a, b) => a - b));
  assert.ok(result.chapters.every(chapter => chapter.start < time && chapter.title.length <= 60));
});

test('empty, too-short, or oversized input creates no summary', () => {
  assert.deepEqual(summarizeLocally([], 10), { suggestedTitle: null, summary: null, chapters: [] });
  assert.equal(summarizeLocally([{ start: 0, end: 1, text: 'Hi.' }], 1).summary, null);
  assert.throws(() => summarizeLocally([], Infinity), /invalid/u);
  assert.deepEqual(summarizeLocally(Array(50_001).fill({ start: 0, end: 0, text: 'x' }), 1),
    { suggestedTitle: null, summary: null, chapters: [] });
});

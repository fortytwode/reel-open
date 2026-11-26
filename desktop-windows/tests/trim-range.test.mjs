import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTrimRange } from '../src/trim-range.mjs';

test('trim range is rounded to milliseconds and rejects empty, full-length and invalid ranges', () => {
  assert.deepEqual(normalizeTrimRange(1.23456, 5.67891, 10), {start:1.235,end:5.679});
  assert.equal(normalizeTrimRange(0, 10, 10), null);
  assert.equal(normalizeTrimRange(1, 1.499, 10), null);
  assert.equal(normalizeTrimRange(-1, 5, 10), null);
  assert.equal(normalizeTrimRange(1, 11, 10), null);
  assert.equal(normalizeTrimRange(Number.NaN, 5, 10), null);
  assert.equal(normalizeTrimRange(1, 5, 0), null);
});

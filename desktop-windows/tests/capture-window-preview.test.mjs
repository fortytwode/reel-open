import test from 'node:test';
import assert from 'node:assert/strict';
import { captureWindowPreview } from '../src/capture-window-preview.mjs';

const preview = 'data:image/png;base64,aGVsbG8=';
function source({ empty = false, size = { width: 192, height: 120 }, data = preview } = {}) {
  return { thumbnail: { isEmpty: () => empty, getSize: () => size, toDataURL: () => data } };
}

test('returns a valid bounded Electron preview without writing or retaining it', () => {
  assert.equal(captureWindowPreview(source()), preview);
  assert.equal(captureWindowPreview({}), null);
  assert.equal(captureWindowPreview(source({ empty: true })), null);
});

test('rejects invalid dimensions, formats, data URLs, and oversized previews', () => {
  assert.equal(captureWindowPreview(source({ size: { width: 0, height: 120 } })), null);
  assert.equal(captureWindowPreview(source({ size: { width: 1921, height: 120 } })), null);
  assert.equal(captureWindowPreview(source({ size: { width: 192, height: 120.5 } })), null);
  assert.equal(captureWindowPreview(source({ data: 'data:text/html;base64,PGgxPm5vPC9oMT4=' })), null);
  assert.equal(captureWindowPreview(source({ data: 'data:image/png;base64,not-base64!' })), null);
  assert.equal(captureWindowPreview(source({ data: `data:image/png;base64,${'a'.repeat(40)}` }), { maxDataUrlBytes: 32 }), null);
});

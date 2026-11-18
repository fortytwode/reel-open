import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayedSharedTitle, normalizedSharedTitle, resolveTitleRoom, saveSharedTitle } from '../../web/reel/shared-title.js';
const id = 'abcdefghij0123456789';
test('shared titles trim and validate while markup remains literal', () => {
  assert.equal(normalizedSharedTitle('  <img onerror=alert(1)>  '), '<img onerror=alert(1)>');
  for (const value of ['', '  ', '\n', 'x'.repeat(501), null]) assert.throws(() => normalizedSharedTitle(value));
  assert.equal(normalizedSharedTitle('x'.repeat(500)).length, 500);
  assert.equal(displayedSharedTitle('Web title', 'Source'), 'Web title');
  assert.equal(displayedSharedTitle(' ', 'Source'), 'Source');
});
function fakeTransaction({ ownerUid = 'owner', expiresAt, current = () => true, beforeReads = () => {} } = {}) {
  const writes = [];
  const fs = { doc: (_db, ...p) => p.join('/'), serverTimestamp: () => 'now', runTransaction: async (_db, work) => work({
    get: async (ref) => { beforeReads(ref); return { exists: () => true, data: () => ref.startsWith('videos/') ? { ownerUid, expiresAt } : { pinned: true, archived: true, folderId: 'project', updatedAt: 'before' } }; },
    set: (ref, data) => writes.push({ ref, data }), update: (ref, data) => writes.push({ ref, data }),
  }) };
  const save = (title = 'Shared title') => saveSharedTitle({ fs, db: {}, id, room: id, uid: 'owner', title, isCurrent: current });
  return { save, writes };
}
test('one title transaction preserves library organization and changes no source index', async () => {
  const { save, writes } = fakeTransaction(); await save();
  assert.deepEqual(writes, [
    { ref: `users/owner/libraryPreferences/${id}`, data: { pinned: true, archived: true, folderId: 'project', updatedAt: 'now', titleOverride: 'Shared title' } },
    { ref: `videos/${id}`, data: { titleOverride: 'Shared title' } },
  ]);
});
test('nonowner, expired room and account changes cannot enqueue title writes', async () => {
  let current = true;
  for (const options of [{ ownerUid: 'other' }, { expiresAt: { toMillis: () => 1 } }, { current: () => false }, { current: () => current, beforeReads: () => { current = false; } }]) {
    const { save, writes } = fakeTransaction(options); await assert.rejects(save()); assert.equal(writes.length, 0);
  }
});
test('room resolution reads current metadata and fails unavailable or mismatched shares', async (t) => {
  const responses = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => { responses.push({ url, options }); return { ok: true, json: async () => ({ id, room: id }) }; });
  const config = { storageOrigin: 'https://example.com', bucket: 'test' };
  assert.equal(await resolveTitleRoom(id, '', config), id); assert.equal(responses[0].options.cache, 'no-store');
  globalThis.fetch.mock.mockImplementation(async () => ({ ok: false })); await assert.rejects(resolveTitleRoom(id, '', config), /unavailable/);
  globalThis.fetch.mock.mockImplementation(async () => ({ ok: true, json: async () => ({ id, room: 'wrong' }) })); await assert.rejects(resolveTitleRoom(id, '', config), /no available/);
  globalThis.fetch.mock.mockImplementation(async () => ({ ok: true, json: async () => ({ id, locked: true }) })); await assert.rejects(resolveTitleRoom(id, '', config), /password/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  actionErrorMessage,
  addParked,
  applyServer,
  MAX_ROWS,
  prune,
  readCache,
  RECENT_KEY,
  rows,
  updateCached,
  WINDOW_MS,
  writeCache,
} from '../../app/recent.js';

const NOW = Date.parse('2026-11-24T10:00:00Z');
const ago = (min) => NOW - min * 60_000;

test('rows: Items and queued Captures together, newest first', () => {
  const records = [
    { id: 'q', state: 'queued', capturedAt: ago(1) },
    { id: 'f', state: 'failed', capturedAt: ago(30) },
  ];
  const cache = [
    { id: 'i1', text: 'Call the bank', status: 'inbox', at: ago(10) },
    { id: 'i2', text: 'Book the dentist', status: 'processed', at: ago(60) },
  ];
  assert.deepEqual(
    rows(records, cache, NOW).map((r) => [r.id, r.kind, r.status]),
    [['q', 'capture', 'queued'], ['i1', 'item', 'inbox'], ['f', 'capture', 'failed'], ['i2', 'item', 'processed']],
  );
});

test('rows: at most 10, none older than 24 h', () => {
  const cache = Array.from({ length: 14 }, (_, i) => ({ id: `i${i}`, text: 't', status: 'inbox', at: ago(i) }));
  cache.push({ id: 'old', text: 't', status: 'inbox', at: NOW - WINDOW_MS - 1 });
  const r = rows([], cache, NOW);
  assert.equal(r.length, MAX_ROWS);
  assert.equal(r[0].id, 'i0');
  assert.ok(!r.some((x) => x.id === 'old'));
});

test('rows: a Capture already parked shows once, as the Item', () => {
  const r = rows([{ id: 'x', state: 'uploading', capturedAt: ago(1) }], [{ id: 'x', text: 'Hi', status: 'inbox', at: ago(1) }], NOW);
  assert.deepEqual(r.map((x) => [x.id, x.kind]), [['x', 'item']]);
});

test('addParked: newest first, replacing any earlier copy, pruned', () => {
  let cache = [{ id: 'a', text: 'old', status: 'inbox', at: ago(5) }];
  cache = addParked(cache, { id: 'b', text: 'New', status: 'inbox', captured_at: new Date(ago(1)).toISOString() }, NOW);
  cache = addParked(cache, { id: 'a', text: 'again', status: 'inbox', captured_at: new Date(ago(5)).toISOString() }, NOW);
  assert.deepEqual(cache.map((c) => [c.id, c.text]), [['b', 'New'], ['a', 'again']]);
});

test('applyServer and updateCached change only the matching Items', () => {
  const cache = [
    { id: 'a', text: 'one', status: 'inbox', at: 1 },
    { id: 'b', text: 'two', status: 'inbox', at: 2 },
  ];
  assert.deepEqual(applyServer(cache, [{ id: 'b', text: 'TWO', status: 'processed' }]), [
    cache[0],
    { id: 'b', text: 'TWO', status: 'processed', at: 2 },
  ]);
  assert.deepEqual(updateCached(cache, 'a', { status: 'discarded' })[0], { id: 'a', text: 'one', status: 'discarded', at: 1 });
});

test('prune drops old and malformed entries', () => {
  assert.deepEqual(prune([{ id: 'a', text: 't', at: ago(1) }, null, { text: 'no id', at: ago(1) }, { id: 'old', text: 't', at: 0 }], NOW).map((c) => c.id), ['a']);
});

test('the cache survives garbage and blocked storage', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.deepEqual(readCache(storage), []);
  store.set(RECENT_KEY, '{not json');
  assert.deepEqual(readCache(storage), []);
  writeCache(storage, [{ id: 'a', text: 't', status: 'inbox', at: 1 }, { id: 2 }]);
  assert.deepEqual(readCache(storage), [{ id: 'a', text: 't', status: 'inbox', at: 1 }]);
  const blocked = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.deepEqual(readCache(blocked), []);
  writeCache(blocked, []); // no throw
});

test('action errors read as sentences', () => {
  assert.equal(actionErrorMessage({ message: 'wrong_state' }), 'Already processed');
  assert.equal(actionErrorMessage({ message: 'invalid_text' }), 'Text can’t be empty');
  assert.equal(actionErrorMessage({ message: 'not_found' }), 'That one’s gone from the Inbox');
  assert.equal(actionErrorMessage({ message: 'not_allowed' }), 'Sign in first');
  assert.equal(actionErrorMessage({ message: 'TypeError: Failed to fetch' }), 'Needs a connection');
  assert.equal(actionErrorMessage({ message: 'wrong_state' }, false), 'Needs a connection');
  assert.equal(actionErrorMessage({ message: '?' }), 'Couldn’t do that. Try again.');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLEANUP_AFTER_MS,
  cleanText,
  cleanUpV1,
  IMPORT_KEY,
  importedAt,
  importMessage,
  importV1,
  mapTasks,
  MAX_ROWS,
  readTasks,
  stableId,
  TASKS_KEY,
} from '../../app/v1import.js';

const NOW = Date.parse('2026-11-24T10:00:00Z');
const T1 = Date.parse('2026-10-01T09:30:00Z');
const T2 = Date.parse('2026-10-02T18:05:00Z');

function memory(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    map: m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

const blocked = {
  getItem: () => {
    throw new Error('denied');
  },
  setItem: () => {
    throw new Error('denied');
  },
  removeItem: () => {
    throw new Error('denied');
  },
};

test('open, done and deleted tasks', () => {
  const rows = mapTasks(
    [
      { id: 'a1', text: 'Call the bank', createdAt: T1, done: false, doneAt: null },
      { id: 'b2', text: 'Book the dentist', createdAt: T1, done: true, doneAt: T2 },
      { id: 'c3', text: 'Gone', createdAt: T1, done: false, doneAt: null, deletedAt: T2 },
      { id: 'd4', text: 'Done, no time', createdAt: T2, done: true, doneAt: null },
    ],
    NOW,
  );
  assert.deepEqual(rows, [
    { id: 'a1', text: 'Call the bank', created_at: T1, status: 'inbox' },
    { id: 'b2', text: 'Book the dentist', created_at: T1, status: 'processed', status_at: T2 },
    { id: 'd4', text: 'Done, no time', created_at: T2, status: 'processed', status_at: null },
  ]);
});

test('text is cleaned the way v1 did, and blank or non-text tasks are left out', () => {
  assert.equal(cleanText('  call \n the   bank  '), 'call the bank');
  assert.equal(cleanText('x'.repeat(2500)).length, 2000);
  assert.equal(cleanText(`${'x'.repeat(1999)} y`), 'x'.repeat(1999), 'no trailing space at the cut');
  const rows = mapTasks([{ id: 'a', text: '   ', createdAt: T1 }, { id: 'b', text: 42 }, null, 'junk', { id: 'c' }], NOW);
  assert.deepEqual(rows, []);
});

test('a bad id gets a stable replacement, so a retried import can’t duplicate it', () => {
  const bad = [
    { id: 'has space', text: 'One', createdAt: T1 },
    { id: 'x'.repeat(65), text: 'Two', createdAt: T1 },
    { id: 7, text: 'Three', createdAt: T1 },
    { text: 'Four', createdAt: T1 },
    { id: 'ünïcode', text: 'Five', createdAt: T1 },
  ];
  const first = mapTasks(bad, NOW).map((r) => r.id);
  const again = mapTasks(structuredClone(bad), NOW + 1000).map((r) => r.id);
  assert.deepEqual(first, again, 'same task, same id');
  assert.equal(new Set(first).size, 5, 'different tasks, different ids');
  for (const id of first) assert.match(id, /^v1-[0-9a-f]{16}$/);
  assert.notEqual(stableId({ id: 'a', text: 'Same', createdAt: T1 }), stableId({ id: 'a', text: 'Same', createdAt: T2 }));
  assert.equal(mapTasks([{ id: 'ok_ID-1', text: 'x', createdAt: T1 }], NOW)[0].id, 'ok_ID-1', 'good ids kept');
});

test('timestamps carry over in ms; bad ones fall back to the done time, then now', () => {
  const [a, b, c, d] = mapTasks(
    [
      { id: 'a', text: 'a', createdAt: T1 },
      { id: 'b', text: 'b', createdAt: 'yesterday', done: true, doneAt: T2 },
      { id: 'c', text: 'c', createdAt: -5 },
      { id: 'd', text: 'd', createdAt: 1e20, done: true, doneAt: NaN },
    ],
    NOW,
  );
  assert.equal(a.created_at, T1);
  assert.equal(b.created_at, T2);
  assert.equal(c.created_at, NOW);
  assert.equal(d.created_at, NOW);
  assert.equal(d.status_at, null);
});

test('reading v1 storage: missing, empty, garbage, blocked', () => {
  assert.equal(readTasks(memory()), null, 'no v1 list here');
  assert.deepEqual(readTasks(memory({ [TASKS_KEY]: '[]' })), []);
  assert.deepEqual(readTasks(memory({ [TASKS_KEY]: '{not json' })), []);
  assert.deepEqual(readTasks(memory({ [TASKS_KEY]: '{"a":1}' })), []);
  assert.equal(readTasks(blocked), null);
  assert.equal(importedAt(memory({ [IMPORT_KEY]: 'soon' })), null);
  assert.equal(importedAt(memory({ [IMPORT_KEY]: '' })), null);
  assert.equal(importedAt(memory({ [IMPORT_KEY]: String(T1) })), T1);
});

function fakeInbox(answers = []) {
  const calls = [];
  return {
    calls,
    rpc: async (fn, args) => {
      calls.push({ fn, args });
      return answers.shift() ?? { data: { inserted: args.rows.length, skipped: 0 }, error: null };
    },
  };
}

const tasks = (n) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, text: `Task ${i}`, createdAt: T1 + i }));

test('importV1 sends the list once, then sets the flag', async () => {
  const storage = memory({ [TASKS_KEY]: JSON.stringify(tasks(3)) });
  const inbox = fakeInbox();
  assert.deepEqual(await importV1({ inbox, storage, now: NOW }), { result: 'imported', count: 3 });
  assert.equal(inbox.calls.length, 1);
  assert.equal(inbox.calls[0].fn, 'import_v1_items');
  assert.equal(inbox.calls[0].args.rows.length, 3);
  assert.equal(importedAt(storage), NOW);
  assert.deepEqual(await importV1({ inbox, storage, now: NOW + 1 }), { result: 'done' });
  const again = memory({ [TASKS_KEY]: JSON.stringify(tasks(3)) }); // another device, already imported
  const counted = await importV1({ inbox: fakeInbox([{ data: { inserted: 0, skipped: 3 }, error: null }]), storage: again, now: NOW });
  assert.deepEqual(counted, { result: 'imported', count: 0 }, 'counts only new Items');
  assert.equal(inbox.calls.length, 1, 'not again');
  assert.ok(storage.map.has(TASKS_KEY), 'v1 storage stays for now');
});

test('importV1 leaves the flag unset on failure, and the retry sends the same rows', async () => {
  const storage = memory({ [TASKS_KEY]: JSON.stringify([...tasks(2), { id: 'bad id', text: 'Odd', createdAt: T1 }]) });
  const inbox = fakeInbox([{ data: null, error: { message: 'Failed to fetch' } }]);
  const failed = await importV1({ inbox, storage, now: NOW });
  assert.equal(failed.result, 'failed');
  assert.equal(importedAt(storage), null);
  assert.equal((await importV1({ inbox, storage, now: NOW + 5000 })).result, 'imported');
  assert.deepEqual(inbox.calls[0].args.rows, inbox.calls[1].args.rows);
});

test('importV1: nothing to do without a v1 list; an empty one just sets the flag', async () => {
  const inbox = fakeInbox();
  assert.deepEqual(await importV1({ inbox, storage: memory(), now: NOW }), { result: 'none' });
  const storage = memory({ [TASKS_KEY]: '[]' });
  assert.deepEqual(await importV1({ inbox, storage, now: NOW }), { result: 'imported', count: 0 });
  assert.equal(inbox.calls.length, 0);
  assert.equal(importedAt(storage), NOW);
});

test('importV1 splits a huge list into calls of 5000, and stops at the first failure', async () => {
  const storage = memory({ [TASKS_KEY]: JSON.stringify(tasks(MAX_ROWS * 2 + 1)) });
  const inbox = fakeInbox([{ data: {}, error: null }, { data: null, error: { message: 'boom' } }]);
  assert.equal((await importV1({ inbox, storage, now: NOW })).result, 'failed');
  assert.deepEqual(inbox.calls.map((c) => c.args.rows.length), [MAX_ROWS, MAX_ROWS]);
  assert.equal(importedAt(storage), null);
  assert.equal((await importV1({ inbox, storage, now: NOW })).count, MAX_ROWS * 2 + 1);
  assert.deepEqual(inbox.calls.slice(2).map((c) => c.args.rows.length), [MAX_ROWS, MAX_ROWS, 1]);
});

test('v1 storage is removed 30 days after the import, not before', () => {
  const v1 = { [TASKS_KEY]: '[]', 'jot.sync.v1': '{}', 'jot.outbox.v1': '[]', 'jot.other': 'x' };
  assert.equal(cleanUpV1(memory(v1), NOW), false, 'never imported: keep');
  const storage = memory({ ...v1, [IMPORT_KEY]: String(NOW) });
  assert.equal(cleanUpV1(storage, NOW + CLEANUP_AFTER_MS - 1), false);
  assert.equal(storage.map.size, 5);
  assert.equal(cleanUpV1(storage, NOW + CLEANUP_AFTER_MS), true);
  assert.deepEqual([...storage.map.keys()].sort(), [IMPORT_KEY, 'jot.other']);
  assert.equal(cleanUpV1(storage, NOW + CLEANUP_AFTER_MS + 1), false, 'once');
  assert.equal(cleanUpV1(blocked, NOW), false);
});

test('the message counts items', () => {
  assert.equal(importMessage(1), 'Imported 1 item from Jot v1');
  assert.equal(importMessage(12), 'Imported 12 items from Jot v1');
});

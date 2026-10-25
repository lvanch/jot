// Run: npm test (Node 22+, no dependencies). Exercises the Worker's fetch handler against a node:sqlite D1 stand-in.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { D1 } from './d1.js';

const KEYS = {
  phone: 'p'.repeat(40),
  laptop: 'l'.repeat(32),
  claude: 'c'.repeat(64),
  short: 's'.repeat(31), // under 32 chars: must be ignored
};

let env;
let logged;
const consoleFns = ['log', 'info', 'warn', 'error', 'debug'];
const realConsole = {};

beforeEach(() => {
  env = { DB: new D1(), JOT_KEYS: JSON.stringify(KEYS) };
  logged = [];
  for (const fn of consoleFns) {
    realConsole[fn] = console[fn];
    console[fn] = (...args) => logged.push(args.map(String).join(' '));
  }
});

afterEach(() => {
  for (const fn of consoleFns) console[fn] = realConsole[fn];
});

async function call(method, path, { key = KEYS.phone, body, raw, headers = {} } = {}) {
  const h = { ...headers };
  if (key) h.Authorization = `Bearer ${key}`;
  let payload = raw;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    h['Content-Type'] = 'application/json';
  }
  const res = await worker.fetch(new Request('https://jot-api.test' + path, { method, headers: h, body: payload }), env);
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

const put = (id, body, opts) => call('PUT', `/tasks/${id}`, { body, ...opts });
const patch = (id, body, opts) => call('PATCH', `/tasks/${id}`, { body, ...opts });

// ---------- Health, auth, CORS ----------

test('GET /health needs no auth', async () => {
  const r = await call('GET', '/health', { key: null });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
});

test('GET /me names the device for each key', async () => {
  for (const device of ['phone', 'laptop', 'claude']) {
    const r = await call('GET', '/me', { key: KEYS[device] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { device });
  }
});

test('auth failures answer 401', async () => {
  const cases = [
    { key: null },
    { key: 'x'.repeat(40) },
    { key: KEYS.short }, // entry shorter than 32 chars is ignored
    { key: KEYS.phone + 'x' },
    { key: KEYS.phone.slice(1) },
    { key: null, headers: { Authorization: `Basic ${KEYS.phone}` } },
    { key: null, headers: { Authorization: KEYS.phone } },
    { key: null, headers: { Authorization: 'Bearer ' } },
  ];
  for (const c of cases) {
    for (const [method, path] of [['GET', '/me'], ['GET', '/tasks'], ['PUT', '/tasks/a'], ['GET', '/nope']]) {
      const r = await call(method, path, { ...c, body: method === 'PUT' ? { text: 'x' } : undefined });
      assert.equal(r.status, 401, `${method} ${path} ${JSON.stringify(c)}`);
      assert.equal(r.headers.get('access-control-allow-origin'), '*');
      assert.equal(r.headers.get('www-authenticate'), 'Bearer');
    }
  }
});

test('bearer scheme is case-insensitive', async () => {
  const r = await call('GET', '/me', { key: null, headers: { Authorization: `bearer ${KEYS.laptop}` } });
  assert.equal(r.status, 200);
});

test('revoking a device = removing its entry', async () => {
  assert.equal((await call('GET', '/me', { key: KEYS.laptop })).status, 200);
  const { laptop, ...rest } = KEYS;
  env.JOT_KEYS = JSON.stringify(rest);
  assert.equal((await call('GET', '/me', { key: KEYS.laptop })).status, 401);
  assert.equal((await call('GET', '/me', { key: KEYS.phone })).status, 200);
});

test('missing or malformed JOT_KEYS rejects everyone', async () => {
  for (const value of [undefined, '', 'not json', '[]', '"key"', '{"phone":123}']) {
    env.JOT_KEYS = value;
    assert.equal((await call('GET', '/me')).status, 401, String(value));
  }
  assert.ok(logged.every((l) => !l.includes(KEYS.phone)));
});

test('OPTIONS preflight allows Authorization and Content-Type from any origin', async () => {
  for (const path of ['/tasks', '/tasks/abc', '/me', '/health']) {
    const res = await worker.fetch(
      new Request('https://jot-api.test' + path, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://jot.example',
          'Access-Control-Request-Method': 'PATCH',
          'Access-Control-Request-Headers': 'authorization, content-type',
        },
      }),
      env
    );
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.match(res.headers.get('access-control-allow-headers'), /Authorization/);
    assert.match(res.headers.get('access-control-allow-headers'), /Content-Type/);
    for (const m of ['GET', 'PUT', 'PATCH', 'DELETE']) assert.match(res.headers.get('access-control-allow-methods'), new RegExp(m));
    assert.equal(res.headers.get('access-control-allow-credentials'), null);
  }
});

test('every response carries CORS, including errors', async () => {
  const responses = [
    await call('GET', '/tasks'),
    await call('GET', '/tasks/missing'),
    await call('PUT', '/tasks/a', { raw: '{bad' }),
    await call('GET', '/nope'),
    await call('POST', '/tasks'),
  ];
  for (const r of responses) assert.equal(r.headers.get('access-control-allow-origin'), '*');
});

test('unknown routes 404, wrong methods 405', async () => {
  assert.equal((await call('GET', '/nope')).status, 404);
  assert.equal((await call('GET', '/tasks/a/b')).status, 404);
  assert.equal((await call('POST', '/tasks')).status, 405);
  assert.equal((await call('POST', '/tasks/a', { body: {} })).status, 405);
  assert.equal((await call('POST', '/me')).status, 405);
  assert.equal((await call('POST', '/health', { key: null })).status, 405);
});

// ---------- PUT ----------

test('PUT creates a task with defaults and server stamps', async () => {
  const before = Date.now();
  const r = await put('t1', { text: 'Buy milk', createdAt: 1700000000000 });
  assert.equal(r.status, 201);
  assert.equal(r.body.id, 't1');
  assert.equal(r.body.text, 'Buy milk');
  assert.equal(r.body.createdAt, 1700000000000);
  assert.equal(r.body.done, false);
  assert.equal(r.body.doneAt, null);
  assert.equal(r.body.deletedAt, null);
  assert.deepEqual(r.body.fields, {});
  assert.equal(r.body.updatedBy, 'phone');
  assert.ok(r.body.updatedAt >= before && r.body.updatedAt <= Date.now());
  assert.equal(r.body.rev, 1);
});

test('PUT accepts every writable field', async () => {
  const body = { id: 'full', text: 'x', createdAt: 1, done: true, doneAt: 2, deletedAt: 3, fields: { due: '2026-11-01', tags: ['a'] } };
  const r = await put('full', body, { key: KEYS.claude });
  assert.equal(r.status, 201);
  assert.deepEqual({ ...r.body, updatedAt: 0, rev: 0 }, { ...body, updatedAt: 0, updatedBy: 'claude', rev: 0 });
});

test('PUT defaults createdAt to server time', async () => {
  const before = Date.now();
  const r = await put('t1', { text: 'x' });
  assert.ok(r.body.createdAt >= before);
});

test('PUT on an existing id is a no-op returning the stored row', async () => {
  const first = await put('t1', { text: 'Original', createdAt: 1 });
  await patch('t1', { done: true, doneAt: 5 });
  const stored = (await call('GET', '/tasks/t1')).body;
  const again = await put('t1', { text: 'Different', createdAt: 2 }, { key: KEYS.laptop });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, stored);
  assert.equal(stored.text, 'Original');
  assert.ok(first.body.rev < stored.rev);
  // Nothing new to pull.
  const list = await call('GET', `/tasks?since=${stored.rev}`);
  assert.deepEqual(list.body.tasks, []);
});

test('PUT on a tombstone stays a tombstone', async () => {
  await put('t1', { text: 'x' });
  const del = await call('DELETE', '/tasks/t1');
  const again = await put('t1', { text: 'x' });
  assert.equal(again.status, 200);
  assert.equal(again.body.deletedAt, del.body.deletedAt);
});

test('PUT validation', async () => {
  const cases = [
    ['bad id chars', 'a.b', { text: 'x' }, 400],
    ['id with space', 'a%20b', { text: 'x' }, 400],
    ['id too long', 'a'.repeat(65), { text: 'x' }, 400],
    ['missing text', 'a', {}, 400],
    ['empty text', 'a', { text: '' }, 400],
    ['blank text', 'a', { text: '  \n ' }, 400],
    ['text not string', 'a', { text: 5 }, 400],
    ['text too long', 'a', { text: 'x'.repeat(2001) }, 413],
    ['createdAt float', 'a', { text: 'x', createdAt: 1.5 }, 400],
    ['createdAt negative', 'a', { text: 'x', createdAt: -1 }, 400],
    ['createdAt string', 'a', { text: 'x', createdAt: '1' }, 400],
    ['createdAt null', 'a', { text: 'x', createdAt: null }, 400],
    ['done not bool', 'a', { text: 'x', done: 1 }, 400],
    ['doneAt string', 'a', { text: 'x', doneAt: 'now' }, 400],
    ['deletedAt float', 'a', { text: 'x', deletedAt: 0.5 }, 400],
    ['fields array', 'a', { text: 'x', fields: [] }, 400],
    ['fields null', 'a', { text: 'x', fields: null }, 400],
    ['fields string', 'a', { text: 'x', fields: '{}' }, 400],
    ['fields too big', 'a', { text: 'x', fields: { blob: 'x'.repeat(16 * 1024) } }, 413],
    ['unknown key', 'a', { text: 'x', priority: 1 }, 400],
    ['server key rev', 'a', { text: 'x', rev: 9 }, 400],
    ['server key updatedBy', 'a', { text: 'x', updatedBy: 'me' }, 400],
    ['mismatched id', 'a', { id: 'b', text: 'x' }, 400],
  ];
  for (const [name, id, body, status] of cases) {
    const r = await put(id, body);
    assert.equal(r.status, status, name);
    assert.equal(typeof r.body.error, 'string', name);
  }
  assert.deepEqual((await call('GET', '/tasks')).body.tasks, [], 'nothing was written');
});

test('PUT limits are inclusive', async () => {
  const id = 'a'.repeat(64);
  assert.equal((await put(id, { text: 'x'.repeat(2000) })).status, 201);
  const fields = { blob: '' };
  fields.blob = 'x'.repeat(16 * 1024 - JSON.stringify(fields).length);
  assert.equal(JSON.stringify(fields).length, 16 * 1024);
  assert.equal((await put('f', { text: 'x', fields })).status, 201);
  assert.equal((await put('A-z_0-9', { text: 'x' })).status, 201);
});

test('fields size counts UTF-8 bytes', async () => {
  const r = await put('a', { text: 'x', fields: { s: 'é'.repeat(8200) } }); // ~16.4 KB in UTF-8
  assert.equal(r.status, 413);
});

test('bad bodies', async () => {
  assert.equal((await put('a', undefined, { raw: '{not json' })).status, 400);
  assert.equal((await put('a', undefined, { raw: '' })).status, 400);
  assert.equal((await put('a', undefined, { raw: '[1]' })).status, 400);
  assert.equal((await put('a', undefined, { raw: 'null' })).status, 400);
  assert.equal((await put('a', undefined, { raw: '"text"' })).status, 400);
  const huge = JSON.stringify({ text: 'x', fields: { a: 'x'.repeat(70 * 1024) } });
  assert.equal((await put('a', undefined, { raw: huge })).status, 413);
});

// ---------- PATCH ----------

test('PATCH changes only the fields sent', async () => {
  await put('t1', { text: 'Old', createdAt: 10, fields: { a: 1 } });
  const r = await patch('t1', { done: true, doneAt: 20 }, { key: KEYS.laptop });
  assert.equal(r.status, 200);
  assert.equal(r.body.text, 'Old');
  assert.equal(r.body.createdAt, 10);
  assert.equal(r.body.done, true);
  assert.equal(r.body.doneAt, 20);
  assert.deepEqual(r.body.fields, { a: 1 });
  assert.equal(r.body.updatedBy, 'laptop');

  const r2 = await patch('t1', { text: 'New' });
  assert.equal(r2.body.text, 'New');
  assert.equal(r2.body.done, true, 'earlier change kept');
  assert.equal(r2.body.updatedBy, 'phone');
  assert.ok(r2.body.rev > r.body.rev);
});

test('PATCH merges fields shallowly; null removes a key', async () => {
  await put('t1', { text: 'x', fields: { keep: 1, drop: 2, nested: { a: 1, b: 2 } } });
  const r = await patch('t1', { fields: { drop: null, nested: { c: 3 }, added: 'y', absent: null } });
  assert.deepEqual(r.body.fields, { keep: 1, nested: { c: 3 }, added: 'y' });
});

test('PATCH validation', async () => {
  await put('t1', { text: 'x', fields: { big: 'x'.repeat(10 * 1024) } });
  const cases = [
    [{}, 400],
    [{ text: '' }, 400],
    [{ text: 'x'.repeat(2001) }, 413],
    [{ done: 'yes' }, 400],
    [{ doneAt: -5 }, 400],
    [{ createdAt: null }, 400],
    [{ fields: [] }, 400],
    [{ fields: null }, 400],
    [{ rev: 1 }, 400],
    [{ id: 't1' }, 400],
    [{ updatedAt: 1 }, 400],
    [{ fields: { more: 'x'.repeat(7 * 1024) } }, 413], // merged result over 16 KB
  ];
  for (const [body, status] of cases) {
    const r = await patch('t1', body);
    assert.equal(r.status, status, JSON.stringify(body).slice(0, 60));
  }
  assert.equal((await call('GET', '/tasks/t1')).body.rev, 1, 'no failed patch wrote');
  assert.equal((await patch('missing', { text: 'x' })).status, 404);
  assert.equal((await patch('bad.id', { text: 'x' })).status, 400);
});

test('concurrent PATCHes to different fields all survive', async () => {
  await put('t1', { text: 'x' });
  const writes = [];
  for (let i = 0; i < 20; i++) writes.push(patch('t1', { fields: { ['k' + i]: i } }, { key: i % 2 ? KEYS.phone : KEYS.laptop }));
  writes.push(patch('t1', { done: true, doneAt: 1 }));
  writes.push(patch('t1', { text: 'edited' }));
  const results = await Promise.all(writes);
  assert.ok(results.every((r) => r.status === 200));
  const row = (await call('GET', '/tasks/t1')).body;
  assert.equal(Object.keys(row.fields).length, 20);
  assert.equal(row.done, true);
  assert.equal(row.text, 'edited');
  const revs = results.map((r) => r.body.rev);
  assert.equal(new Set(revs).size, revs.length, 'every write got its own rev');
});

test('last write to reach the server wins', async () => {
  await put('t1', { text: 'x' });
  await patch('t1', { text: 'from phone' }, { key: KEYS.phone });
  await patch('t1', { text: 'from laptop' }, { key: KEYS.laptop });
  const row = (await call('GET', '/tasks/t1')).body;
  assert.equal(row.text, 'from laptop');
  assert.equal(row.updatedBy, 'laptop');
});

// ---------- DELETE / restore ----------

test('DELETE tombstones; repeating it changes nothing; PATCH deletedAt:null restores', async () => {
  await put('t1', { text: 'x' });
  const del = await call('DELETE', '/tasks/t1', { key: KEYS.laptop });
  assert.equal(del.status, 200);
  assert.equal(typeof del.body.deletedAt, 'number');
  assert.equal(del.body.updatedBy, 'laptop');
  assert.equal(del.body.text, 'x', 'row is kept');

  const again = await call('DELETE', '/tasks/t1');
  assert.deepEqual(again.body, del.body);

  const restored = await patch('t1', { deletedAt: null });
  assert.equal(restored.body.deletedAt, null);
  assert.ok(restored.body.rev > del.body.rev);

  assert.equal((await call('DELETE', '/tasks/missing')).status, 404);
  assert.equal((await call('DELETE', '/tasks/bad!id')).status, 400);
});

// ---------- GET ----------

test('GET /tasks/:id returns one row', async () => {
  await put('t1', { text: 'x' });
  const r = await call('GET', '/tasks/t1', { key: KEYS.claude });
  assert.equal(r.status, 200);
  assert.equal(r.body.text, 'x');
  assert.equal((await call('GET', '/tasks/nope')).status, 404);
});

test('GET /tasks?since returns changes after the cursor, tombstones included', async () => {
  await put('a', { text: 'a' });
  await put('b', { text: 'b' });
  const all = await call('GET', '/tasks');
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.tasks.map((t) => t.id), ['a', 'b']);
  assert.equal(all.body.cursor, 2);
  assert.equal(all.body.more, false);

  await call('DELETE', '/tasks/a');
  await patch('b', { text: 'b2' });
  await put('c', { text: 'c' });
  const delta = await call('GET', `/tasks?since=${all.body.cursor}`);
  assert.deepEqual(delta.body.tasks.map((t) => t.id), ['a', 'b', 'c']);
  assert.equal(typeof delta.body.tasks[0].deletedAt, 'number');
  assert.equal(delta.body.cursor, 5);

  const none = await call('GET', `/tasks?since=${delta.body.cursor}`);
  assert.deepEqual(none.body, { tasks: [], cursor: 5, more: false });

  assert.equal((await call('GET', '/tasks?since=0')).body.tasks.length, 3);
  assert.equal((await call('GET', '/tasks?since=')).body.tasks.length, 3);
});

test('rev orders writes that land in the same millisecond', async () => {
  const realNow = Date.now;
  Date.now = () => 1_800_000_000_000;
  try {
    await put('a', { text: 'a' });
    const { cursor } = (await call('GET', '/tasks')).body;
    await put('b', { text: 'b' });
    await patch('a', { text: 'a2' });
    const delta = (await call('GET', `/tasks?since=${cursor}`)).body;
    assert.deepEqual(delta.tasks.map((t) => [t.id, t.updatedAt]), [['b', 1_800_000_000_000], ['a', 1_800_000_000_000]]);
  } finally {
    Date.now = realNow;
  }
});

test('GET /tasks pages through large sets', async () => {
  for (let i = 0; i < 1203; i++) await put('t' + i, { text: 'x' });
  let cursor = 0;
  const seen = [];
  for (;;) {
    const r = (await call('GET', `/tasks?since=${cursor}`)).body;
    seen.push(...r.tasks.map((t) => t.id));
    cursor = r.cursor;
    if (!r.more) break;
  }
  assert.equal(seen.length, 1203);
  assert.equal(new Set(seen).size, 1203);
});

test('bad cursors answer 400', async () => {
  for (const since of ['-1', 'abc', '1.5', '1e3', '9'.repeat(20)]) {
    assert.equal((await call('GET', `/tasks?since=${since}`)).status, 400, since);
  }
});

test('table is created on first request', async () => {
  const fresh = new D1();
  env.DB = fresh;
  assert.equal((await call('GET', '/tasks')).status, 200);
  const row = await fresh.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").first();
  assert.equal(row.name, 'tasks');
});

test('server errors answer 500 without leaking details', async () => {
  env.DB = { batch: async () => { throw new Error('boom: Buy milk'); }, prepare: () => ({}) };
  const r = await put('t1', { text: 'Buy milk' });
  assert.equal(r.status, 500);
  assert.deepEqual(r.body, { error: 'internal error' });
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
});

test('never logs keys or task text', async () => {
  await put('t1', { text: 'Secret errand' });
  await patch('t1', { text: 'Secret errand two' });
  await call('GET', '/me', { key: 'wrong-key-'.repeat(4) });
  env.DB = { batch: async () => { throw new Error('Secret errand three'); }, prepare: () => ({}) };
  await put('t2', { text: 'Secret errand three' });
  env.JOT_KEYS = '{not json ' + KEYS.phone;
  await call('GET', '/me');
  const all = logged.join('\n');
  assert.ok(logged.length > 0, 'errors were logged');
  assert.ok(!all.includes('Secret'), all);
  for (const k of Object.values(KEYS)) assert.ok(!all.includes(k));
  assert.ok(!all.includes('wrong-key'));
});

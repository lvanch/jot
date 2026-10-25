// jot-api: the task store Jot syncs to. See ../README.md for the contract.
//
// Never log keys or task text: errors are logged by name and route only.

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TEXT = 2000;
const MAX_FIELDS_BYTES = 16 * 1024;
const MAX_BODY_BYTES = 64 * 1024;
const MIN_KEY_LENGTH = 32;
const PAGE_SIZE = 500;
const MAX_MS = 8.64e15; // largest valid Date
const WRITABLE = ['text', 'createdAt', 'done', 'doneAt', 'deletedAt', 'fields'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
};

const PREFLIGHT = {
  ...CORS,
  'Access-Control-Allow-Methods': 'GET, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (message) => new HttpError(400, message);
const tooLarge = (message) => new HttpError(413, message);

function json(data, status = 200, extra) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extra,
    },
  });
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error('jot-api: unhandled error', request.method, routeName(request), err && err.name);
      return json({ error: 'internal error' }, 500);
    }
  },
};

function routeName(request) {
  const path = new URL(request.url).pathname;
  return path.startsWith('/tasks/') ? '/tasks/:id' : path;
}

// ---------- Routing ----------

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: PREFLIGHT });

  if (path === '/health') {
    if (method !== 'GET') throw new HttpError(405, 'method not allowed');
    return json({ ok: true });
  }

  const device = await authenticate(request, env);
  if (!device) return json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });

  if (path === '/me') {
    if (method !== 'GET') throw new HttpError(405, 'method not allowed');
    return json({ device });
  }

  // '/transcribe' (cloud dictation) will be routed here, behind the same keys.

  if (path === '/tasks') {
    if (method !== 'GET') throw new HttpError(405, 'method not allowed');
    await ensureSchema(env.DB);
    return listTasks(env.DB, url.searchParams.get('since'));
  }

  const m = /^\/tasks\/([^/]+)$/.exec(path);
  if (m) {
    const id = taskId(m[1]);
    await ensureSchema(env.DB);
    switch (method) {
      case 'GET': return getTask(env.DB, id);
      case 'PUT': return createTask(env.DB, id, await readBody(request), device);
      case 'PATCH': return patchTask(env.DB, id, await readBody(request), device);
      case 'DELETE': return deleteTask(env.DB, id, device);
      default: throw new HttpError(405, 'method not allowed');
    }
  }

  throw new HttpError(404, 'not found');
}

// ---------- Auth: per-device keys in the JOT_KEYS secret ----------

const encoder = new TextEncoder();
let keyCache = { raw: undefined, entries: [] };

async function sha256(s) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(s)));
}

// Digests are fixed-length, so this compares without leaking where a key differs or how long it is.
function sameDigest(a, b) {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function deviceKeys(raw) {
  if (keyCache.raw === raw) return keyCache.entries;
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // reported below without echoing the secret
  }
  const entries = [];
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [device, key] of Object.entries(parsed)) {
      if (typeof key === 'string' && key.length >= MIN_KEY_LENGTH) entries.push([device, await sha256(key)]);
    }
  } else {
    console.error('jot-api: JOT_KEYS is missing or not a JSON object');
  }
  keyCache = { raw, entries };
  return entries;
}

async function authenticate(request, env) {
  const m = /^Bearer +(\S+) *$/i.exec(request.headers.get('Authorization') || '');
  if (!m) return null;
  const presented = await sha256(m[1]);
  let device = null;
  // Check every entry, with no early exit, so timing doesn't reveal which (if any) matched.
  for (const [name, digest] of await deviceKeys(env.JOT_KEYS)) {
    if (sameDigest(presented, digest) && device === null) device = name;
  }
  return device;
}

// ---------- Schema ----------

const schemaReady = new WeakMap(); // per D1 binding: created once per isolate

function ensureSchema(db) {
  let ready = schemaReady.get(db);
  if (!ready) {
    ready = db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        doneAt INTEGER,
        deletedAt INTEGER,
        fields TEXT NOT NULL DEFAULT '{}',
        updatedAt INTEGER NOT NULL,
        updatedBy TEXT NOT NULL,
        rev INTEGER NOT NULL
      )`),
      db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS tasks_rev ON tasks (rev)'),
    ]).catch((err) => {
      schemaReady.delete(db);
      throw err;
    });
    schemaReady.set(db, ready);
  }
  return ready;
}

// Every write takes the next rev. D1 runs one statement at a time, so this can't hand out the same rev twice.
const NEXT_REV = '(SELECT COALESCE(MAX(rev), 0) + 1 FROM tasks)';

function toTask(r) {
  return {
    id: r.id,
    text: r.text,
    createdAt: r.createdAt,
    done: !!r.done,
    doneAt: r.doneAt,
    deletedAt: r.deletedAt,
    fields: JSON.parse(r.fields),
    updatedAt: r.updatedAt,
    updatedBy: r.updatedBy,
    rev: r.rev,
  };
}

const selectRow = (db, id) => db.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first();

// ---------- Validation ----------

function taskId(segment) {
  let id;
  try {
    id = decodeURIComponent(segment);
  } catch {
    throw bad('invalid id');
  }
  if (!ID_RE.test(id)) throw bad('id must be 1-64 characters of A-Z a-z 0-9 _ -');
  return id;
}

async function readBody(request) {
  const declared = Number(request.headers.get('Content-Length'));
  if (declared > MAX_BODY_BYTES) throw tooLarge('body too large');
  const raw = await request.text();
  if (encoder.encode(raw).length > MAX_BODY_BYTES) throw tooLarge('body too large');
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw bad('body must be JSON');
  }
  if (!isObject(body)) throw bad('body must be a JSON object');
  return body;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isMs = (v) => Number.isSafeInteger(v) && v >= 0 && v <= MAX_MS;

function checkText(v) {
  if (typeof v !== 'string' || !v.trim()) throw bad('text must be a non-empty string');
  if (v.length > MAX_TEXT) throw tooLarge(`text is over ${MAX_TEXT} characters`);
  return v;
}

function checkFieldsSize(fields) {
  const s = JSON.stringify(fields);
  if (encoder.encode(s).length > MAX_FIELDS_BYTES) throw tooLarge('fields is over 16 KB');
  return s;
}

// Validates the writable keys present in body; rejects anything else.
function checkWritable(body, allowId) {
  for (const k of Object.keys(body)) {
    if (k === 'id' && allowId) continue;
    if (!WRITABLE.includes(k)) throw bad(`unknown or read-only field: ${k}`);
  }
  if ('text' in body) checkText(body.text);
  if ('createdAt' in body && !isMs(body.createdAt)) throw bad('createdAt must be a ms timestamp');
  if ('done' in body && typeof body.done !== 'boolean') throw bad('done must be a boolean');
  for (const k of ['doneAt', 'deletedAt']) {
    if (k in body && body[k] !== null && !isMs(body[k])) throw bad(`${k} must be a ms timestamp or null`);
  }
  if ('fields' in body && !isObject(body.fields)) throw bad('fields must be a JSON object');
}

// ---------- Handlers ----------

async function listTasks(db, since) {
  let after = 0;
  if (since !== null && since !== '') {
    if (!/^\d{1,15}$/.test(since)) throw bad('since must be a cursor from a previous response');
    after = Number(since);
  }
  const { results } = await db
    .prepare('SELECT * FROM tasks WHERE rev > ? ORDER BY rev LIMIT ?')
    .bind(after, PAGE_SIZE + 1)
    .all();
  const more = results.length > PAGE_SIZE;
  const rows = more ? results.slice(0, PAGE_SIZE) : results;
  const cursor = rows.length ? rows[rows.length - 1].rev : after;
  return json({ tasks: rows.map(toTask), cursor, more });
}

async function getTask(db, id) {
  const row = await selectRow(db, id);
  if (!row) throw new HttpError(404, 'no such task');
  return json(toTask(row));
}

async function createTask(db, id, body, device) {
  checkWritable(body, true);
  if ('id' in body && body.id !== id) throw bad('body id does not match the URL');
  if (!('text' in body)) throw bad('text is required');
  const fields = checkFieldsSize(body.fields || {});
  const now = Date.now();
  const inserted = await db
    .prepare(
      `INSERT INTO tasks (id, text, createdAt, done, doneAt, deletedAt, fields, updatedAt, updatedBy, rev)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${NEXT_REV})
       ON CONFLICT (id) DO NOTHING
       RETURNING *`
    )
    .bind(
      id,
      body.text,
      'createdAt' in body ? body.createdAt : now,
      body.done ? 1 : 0,
      body.doneAt ?? null,
      body.deletedAt ?? null,
      fields,
      now,
      device
    )
    .first();
  if (inserted) return json(toTask(inserted), 201);
  // Already exists: a retried create. Return what's stored, untouched.
  return json(toTask(await selectRow(db, id)), 200);
}

async function patchTask(db, id, body, device) {
  checkWritable(body, false);
  if (!Object.keys(body).length) throw bad('nothing to update');

  // Only the columns sent are written, so concurrent patches to different columns can't undo each other.
  const sets = [];
  const values = [];
  for (const k of ['text', 'createdAt', 'done', 'doneAt', 'deletedAt']) {
    if (!(k in body)) continue;
    sets.push(`${k} = ?`);
    values.push(k === 'done' ? (body.done ? 1 : 0) : body[k]);
  }
  const update = (extraSet, extraValues, where, whereValues) =>
    db
      .prepare(
        `UPDATE tasks SET ${[...sets, ...extraSet, 'updatedAt = ?', 'updatedBy = ?', `rev = ${NEXT_REV}`].join(', ')}
         WHERE id = ?${where}
         RETURNING *`
      )
      .bind(...values, ...extraValues, Date.now(), device, id, ...whereValues)
      .first();

  if (!('fields' in body)) {
    const row = await update([], [], '', []);
    if (!row) throw new HttpError(404, 'no such task');
    return json(toTask(row));
  }

  // fields merges with what's stored: read, merge, and write only if no one wrote in between (compare-and-set on rev).
  for (let attempt = 0; attempt < 30; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, Math.random() * 10 * attempt));
    const cur = await selectRow(db, id);
    if (!cur) throw new HttpError(404, 'no such task');
    const fields = JSON.parse(cur.fields);
    for (const [k, v] of Object.entries(body.fields)) {
      if (v === null) delete fields[k];
      else fields[k] = v;
    }
    const row = await update(['fields = ?'], [checkFieldsSize(fields)], ' AND rev = ?', [cur.rev]);
    if (row) return json(toTask(row));
  }
  throw new HttpError(503, 'too many concurrent writes, retry');
}

async function deleteTask(db, id, device) {
  const now = Date.now();
  const row = await db
    .prepare(
      `UPDATE tasks SET deletedAt = ?, updatedAt = ?, updatedBy = ?, rev = ${NEXT_REV}
       WHERE id = ? AND deletedAt IS NULL
       RETURNING *`
    )
    .bind(now, now, device, id)
    .first();
  if (row) return json(toTask(row));
  // Already a tombstone (or missing): deleting again changes nothing.
  const cur = await selectRow(db, id);
  if (!cur) throw new HttpError(404, 'no such task');
  return json(toTask(cur));
}

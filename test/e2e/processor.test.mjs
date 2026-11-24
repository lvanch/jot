// #13: the Inbox contract from a Processor's side (docs/inbox-contract.md), against the local stack over plain
// REST. A fresh processor is added the way the runbook says, lists and processes Items, is refused everything
// else, fetches a Recording, and loses access the moment it's revoked. No browser here.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { API_URL, removeItems } from './harness.mjs';

const PUBLISHABLE_KEY = process.env.PUBLISHABLE_KEY;
const SECRET_KEY = process.env.SECRET_KEY;
const RUN = Date.now().toString(36);
const NAME = `agent-${RUN}`;
const EMAIL = `you+${NAME}@example.com`;
const PASSWORD = randomBytes(32).toString('hex');
const IDS = [`proc-a-${RUN}`, `proc-b-${RUN}`];
const RECORDING = `${IDS[0]}.webm`;
const AUDIO = randomBytes(2048);

const admin = { apikey: SECRET_KEY, 'Content-Type': 'application/json' };
let userId;
let token;

async function call(path, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // not JSON
  }
  return { status: res.status, json };
}

const asAgent = (path, init = {}) =>
  call(path, { ...init, headers: { apikey: PUBLISHABLE_KEY, Authorization: `Bearer ${token}`, ...init.headers } });

async function signIn() {
  const r = await call('/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: PUBLISHABLE_KEY },
    body: { email: EMAIL, password: PASSWORD },
  });
  return r.json?.access_token ?? null;
}

before(async () => {
  // Runbook step 2: the Auth user, through the Admin API with the secret key.
  const user = await call('/auth/v1/admin/users', {
    method: 'POST',
    headers: admin,
    body: { email: EMAIL, password: PASSWORD, email_confirm: true },
  });
  assert.equal(user.status, 200, JSON.stringify(user.json));
  userId = user.json.id;

  // Two Items parked long ago, so they're first in the Inbox; one has a Recording.
  const up = await call(`/storage/v1/object/recordings/${RECORDING}`, {
    method: 'POST',
    headers: { apikey: SECRET_KEY, 'Content-Type': 'audio/webm' },
    body: new Uint8Array(AUDIO),
  });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  const rows = IDS.map((id, i) => ({
    id,
    transcript: `Processor test ${i}`,
    text: `Processor test ${i}`,
    captured_at: `2000-01-0${i + 1}T08:00:00Z`,
    parked_at: `2000-01-0${i + 1}T08:00:05Z`,
    source: 'jot',
    recording_path: i === 0 ? RECORDING : null,
  }));
  const ins = await call('/rest/v1/items', { method: 'POST', headers: admin, body: rows });
  assert.equal(ins.status, 201, JSON.stringify(ins.json));
});

after(async () => {
  if (userId) await call(`/auth/v1/admin/users/${userId}`, { method: 'DELETE', headers: admin });
  await removeItems(IDS).catch(() => {});
});

test('a signed-in user who isn’t a member yet sees nothing', async () => {
  token = await signIn();
  assert.ok(token, 'signed in');
  const list = await asAgent(`/rest/v1/items?id=in.(${IDS.join(',')})&select=id`);
  assert.deepEqual(list.json, [], 'not a member: no rows');
});

test('once a member, a processor lists the Inbox oldest first and processes with an Outcome', async () => {
  // Runbook step 3: the members row.
  const member = await call('/rest/v1/members', {
    method: 'POST',
    headers: admin,
    body: { user_id: userId, role: 'processor', name: NAME },
  });
  assert.equal(member.status, 201, JSON.stringify(member.json));

  const list = await asAgent('/rest/v1/items?status=eq.inbox&order=parked_at.asc&select=id,text,recording_path&limit=2');
  assert.deepEqual(list.json.map((i) => i.id), IDS);

  const done = await asAgent('/rest/v1/rpc/process_item', {
    method: 'POST',
    body: { item_id: IDS[1], outcome: { note: 'Calendar event on Friday' } },
  });
  assert.equal(done.status, 200);
  assert.equal(done.json.status, 'processed');
  assert.equal(done.json.processed_by, NAME, 'attributed to the agent');
  assert.deepEqual(done.json.outcome, { note: 'Calendar event on Friday' });

  const again = await asAgent('/rest/v1/rpc/process_item', { method: 'POST', body: { item_id: IDS[1] } });
  assert.equal(again.status, 200, 'a repeat returns the Item unchanged');
  assert.deepEqual(again.json.outcome, { note: 'Calendar event on Friday' });
});

test('a processor is refused everything else, with the documented codes', async () => {
  const rpc = (fn, body) => asAgent(`/rest/v1/rpc/${fn}`, { method: 'POST', body });
  for (const [fn, body] of [
    ['discard_item', { item_id: IDS[0] }],
    ['restore_item', { item_id: IDS[0] }],
    ['edit_item_text', { item_id: IDS[0], new_text: 'changed' }],
    ['import_v1_items', { rows: [] }],
  ]) {
    const r = await rpc(fn, body);
    assert.equal(r.status, 403, fn);
    assert.equal(r.json.message, 'not_allowed', fn);
  }

  const missing = await rpc('process_item', { item_id: `nope-${RUN}` });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.message, 'not_found');

  const vocab = await asAgent('/rest/v1/vocabulary?select=term');
  assert.deepEqual(vocab.json, [], 'Vocabulary reads return no rows');
  const addVocab = await asAgent('/rest/v1/vocabulary', { method: 'POST', body: { term: `Nope ${RUN}` } });
  assert.equal(addVocab.status, 403);
  const log = await asAgent('/rest/v1/transcription_log?select=id');
  assert.deepEqual(log.json, [], 'no transcription log');
  const patch = await asAgent(`/rest/v1/items?id=eq.${IDS[0]}`, { method: 'PATCH', body: { text: 'hacked' } });
  assert.equal(patch.status, 403, 'no direct updates');
});

test('a processor fetches a Recording through a signed URL', async () => {
  const signed = await asAgent(`/storage/v1/object/sign/recordings/${RECORDING}`, { method: 'POST', body: { expiresIn: 60 } });
  assert.equal(signed.status, 200, JSON.stringify(signed.json));
  const audio = await fetch(`${API_URL}/storage/v1${signed.json.signedURL}`);
  assert.equal(audio.status, 200);
  assert.deepEqual(Buffer.from(await audio.arrayBuffer()), AUDIO);
});

test('revoking ends access at once, even for a token already held; processed_by stays', async () => {
  const del = await call(`/auth/v1/admin/users/${userId}`, { method: 'DELETE', headers: admin });
  assert.equal(del.status, 200);
  userId = null;

  const member = await call(`/rest/v1/members?name=eq.${NAME}&select=user_id`, { headers: admin });
  assert.deepEqual(member.json, [], 'the members row went with the user');
  const list = await asAgent(`/rest/v1/items?id=in.(${IDS.join(',')})&select=id`);
  assert.deepEqual(list.json, [], 'the old token reads nothing');
  const r = await asAgent('/rest/v1/rpc/process_item', { method: 'POST', body: { item_id: IDS[0] } });
  assert.equal(r.status, 403);
  assert.equal(await signIn(), null, 'and can’t sign in');

  const [item] = (await call(`/rest/v1/items?id=eq.${IDS[1]}&select=processed_by`, { headers: admin })).json;
  assert.equal(item.processed_by, NAME);
});

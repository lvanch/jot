// #12: the one-time import of the v1 list. Seed v1's localStorage, sign in, and the Items are in the Inbox with
// source 'jot-v1', the right states and their original times; again on another device adds nothing; a failed
// import is retried on the next foreground; v1's storage goes 30 days later (clock mocked).

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { stableId } from '../../app/v1import.js';
import { clearMail, itemsById, latestCode, openJot, ownerSession, removeItems, serveApp } from './harness.mjs';

const RUN = Date.now().toString(36);
const T1 = Date.parse('2026-09-30T23:15:00Z');
const T2 = Date.parse('2026-10-01T02:40:00Z');
const T3 = Date.parse('2026-10-03T11:00:00Z');

const TASKS = [
  { id: `open-${RUN}`, text: `Call the bank ${RUN}`, createdAt: T1, done: false, doneAt: null },
  { id: `done-${RUN}`, text: `Book the  dentist ${RUN}`, createdAt: T1, done: true, doneAt: T2 },
  { id: `gone-${RUN}`, text: `Deleted ${RUN}`, createdAt: T1, done: false, doneAt: null, deletedAt: T2 },
  { id: `bad id ${RUN}`, text: `Odd id ${RUN}`, createdAt: T3, done: false, doneAt: null },
];
const BAD_ID = stableId(TASKS[3]);
const IDS = [TASKS[0].id, TASKS[1].id, BAD_ID];

let app;
let session;

before(async () => {
  app = await serveApp();
  session = await ownerSession(app.url);
});
after(async () => {
  await removeItems([...IDS, TASKS[2].id]).catch(() => {});
  await app?.close();
});

async function withJot(options, fn) {
  const jot = await openJot(app.url, options);
  try {
    await fn(jot);
    assert.deepEqual(jot.problems, [], 'no CSP violations or console errors');
  } finally {
    await jot.browser.close();
  }
}

const seed = (page, entries) =>
  page.evaluate((e) => {
    for (const [k, v] of Object.entries(e)) localStorage.setItem(k, v);
  }, entries);
const stored = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);
const toastSays = (page, text) =>
  page.waitForFunction((t) => document.getElementById('toast-msg').textContent.startsWith(t), text, { timeout: 15_000 });

async function signIn(page) {
  await new Promise((r) => setTimeout(r, 1100)); // the auth server allows one code a second per address
  await clearMail();
  await page.fill('#email', 'owner@jot.local');
  await page.click('#email-form button[type=submit]');
  await page.waitForSelector('#code-form:not([hidden])');
  await page.fill('#code', await latestCode('owner@jot.local'));
  await page.click('#code-form button[type=submit]');
  await page.waitForSelector('#account:not([hidden])');
}

test('signing in imports the v1 list once, with its states and times', async () => {
  await withJot({}, async ({ page }) => {
    await seed(page, { 'jot.tasks.v1': JSON.stringify(TASKS) });
    await page.reload();
    await signIn(page);
    await toastSays(page, 'Imported 3 items from Jot v1');
    assert.ok(Number(await stored(page, 'jot.import.v1')) > 0, 'remembered');
    assert.ok(await stored(page, 'jot.tasks.v1'), 'v1 storage left alone for now');
  });

  const items = Object.fromEntries((await itemsById([...IDS, TASKS[2].id])).map((i) => [i.id, i]));
  assert.deepEqual(Object.keys(items).sort(), [...IDS].sort(), 'deleted tasks stay behind');
  for (const i of Object.values(items)) {
    assert.equal(i.source, 'jot-v1');
    assert.equal(i.transcript, i.text);
    assert.equal(i.recording_path, null);
  }
  const open = items[TASKS[0].id];
  assert.equal(open.status, 'inbox');
  assert.equal(Date.parse(open.captured_at), T1);

  const done = items[TASKS[1].id];
  assert.equal(done.text, `Book the dentist ${RUN}`, 'cleaned the way v1 did');
  assert.equal(done.status, 'processed');
  assert.equal(done.processed_by, 'jot-v1');
  assert.equal(Date.parse(done.captured_at), T1);
  assert.equal(Date.parse(done.status_at), T2);

  assert.equal(items[BAD_ID].text, `Odd id ${RUN}`);
  assert.equal(Date.parse(items[BAD_ID].captured_at), T3);

  // Another device with the same v1 list: the import runs, and adds nothing.
  await withJot({}, async ({ page }) => {
    await seed(page, { 'jot.tasks.v1': JSON.stringify(TASKS) });
    await page.reload();
    await signIn(page);
    await page.waitForFunction(() => localStorage.getItem('jot.import.v1'));
    assert.doesNotMatch(await page.textContent('#toast-msg'), /Imported/, 'nothing new to announce');
  });
  assert.equal((await itemsById(IDS)).length, 3, 'no duplicates, the odd id included');
});

test('a failed import is tried again on the next foreground', async () => {
  const local = structuredClone(session);
  await withJot({ storageState: local }, async ({ page }) => {
    let refuse = true;
    await page.route('**/rest/v1/rpc/import_v1_items', (route) => (refuse ? route.abort() : route.continue()));
    await seed(page, { 'jot.tasks.v1': JSON.stringify(TASKS) });
    const calls = [];
    page.on('request', (r) => r.url().includes('import_v1_items') && calls.push(r.url()));
    await page.reload();
    await page.waitForFunction(() => !document.getElementById('account').hidden);
    await new Promise((r) => setTimeout(r, 1000));
    assert.ok(calls.length >= 1, 'it tried');
    assert.equal(await stored(page, 'jot.import.v1'), null, 'not remembered after a failure');

    refuse = false;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForFunction(() => localStorage.getItem('jot.import.v1'));
    // Everything was already there from the first test, so nothing new: the point is that it ran and finished.
  });
});

test('v1’s storage is removed 30 days after the import, not before', async () => {
  await withJot({}, async ({ page }) => {
    const importedAt = Date.now();
    await seed(page, {
      'jot.tasks.v1': JSON.stringify(TASKS),
      'jot.sync.v1': '{}',
      'jot.outbox.v1': '[]',
      'jot.import.v1': String(importedAt),
    });

    await page.clock.setFixedTime(importedAt + 29 * 86_400_000);
    await page.reload();
    await page.waitForSelector('#signin:not([hidden])');
    assert.ok(await stored(page, 'jot.tasks.v1'), 'kept at 29 days');

    await page.clock.setFixedTime(importedAt + 30 * 86_400_000 + 60_000);
    await page.reload();
    await page.waitForSelector('#signin:not([hidden])');
    for (const key of ['jot.tasks.v1', 'jot.sync.v1', 'jot.outbox.v1']) assert.equal(await stored(page, key), null, key);
    assert.equal(await stored(page, 'jot.import.v1'), String(importedAt), 'the import is still remembered');
  });
});

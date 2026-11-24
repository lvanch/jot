// #9: the Capture queue. Upload to transcribe, retry, and the status line, against the local stack with the fake
// Transcriber (`supabase functions serve --env-file supabase/tests/functions/test.env`, or serve_local.ts with
// FUNCTIONS_URL). Some tests replace the server's answer with page.route to force an outcome.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { itemsById, logFor, openJot, ownerSession, queued, removeItems, serveApp, SPEECH_WAV } from './harness.mjs';

let app;
let session;
const created = []; // Item ids to clean up

before(async () => {
  app = await serveApp();
  session = await ownerSession(app.url);
});
after(async () => {
  await removeItems(created).catch(() => {});
  await app?.close();
});

async function withJot(options, fn) {
  const jot = await openJot(app.url, { audioFile: SPEECH_WAV, storageState: session, ...options });
  try {
    await fn(jot);
    assert.deepEqual(jot.problems, [], 'no CSP violations or console errors');
  } finally {
    await jot.browser.close();
  }
}

const status = (page) => page.textContent('#status');
const waitStatus = (page, re, timeout = 15_000) =>
  page.waitForFunction((src) => new RegExp(src).test(document.getElementById('status').textContent), re.source, { timeout });

/** Taps the mic and waits for the Capture; returns its id. */
async function capture(page) {
  const before = await page.evaluate(() => window.__captures.length);
  await page.click('#mic');
  await page.waitForFunction((n) => window.__captures.length > n, before, { timeout: 20_000 });
  const id = await page.evaluate(() => window.__captures.at(-1).id);
  created.push(id);
  return id;
}

const parked = (page, id, timeout = 20_000) =>
  page.waitForFunction((x) => window.__parked.some((p) => p.id === x), id, { timeout });

// The server answers that Jot would see, without touching it.
const answer = (status, body) => (route) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

test('a Capture is sent and parked as an Item in the Inbox', async () => {
  await withJot({}, async ({ page }) => {
    const id = await capture(page);
    await parked(page, id);
    const [item] = await itemsById([id]);
    assert.equal(item.status, 'inbox');
    assert.match(item.text, /^fake transcript \d+$/);
    assert.equal(item.source, 'jot');
    assert.equal(item.device, 'desktop');
    assert.ok(item.duration_ms > 1000);
    assert.deepEqual(await queued(page), [], 'nothing left in the queue');
    await waitStatus(page, /^Tap to add another$/);
  });
});

test('offline: two Captures queue, then both park once each when the network returns', async () => {
  await withJot({}, async ({ page, context }) => {
    await context.setOffline(true);
    const a = await capture(page);
    await waitStatus(page, /^Offline · 1 queued$/);
    const b = await capture(page);
    await waitStatus(page, /^Offline · 2 queued$/);
    assert.equal((await queued(page)).length, 2);

    await context.setOffline(false);
    await parked(page, a);
    await parked(page, b);
    assert.equal((await itemsById([a, b])).length, 2);
    for (const id of [a, b]) assert.deepEqual(await logFor(id), [{ outcome: 'parked' }], `${id} transcribed once`);
    assert.deepEqual(await queued(page), []);
  });
});

test('a lost answer never parks the same thought twice', async () => {
  await withJot({}, async ({ page }) => {
    let calls = 0;
    await page.route('**/transcribe', async (route) => {
      calls++;
      if (calls === 1) {
        await route.fetch(); // the server parks it…
        await route.abort('connectionreset'); // …but the answer never arrives
      } else {
        await route.continue();
      }
    });
    const id = await capture(page);
    await parked(page, id, 30_000); // after the 2 s backoff
    assert.ok(calls >= 2);
    assert.equal((await itemsById([id])).length, 1);
    assert.deepEqual(await logFor(id), [{ outcome: 'parked' }], 'the retry did not transcribe again');
  });
});

test('a refused Recording is kept on the phone as failed', async () => {
  await withJot({}, async ({ page }) => {
    await page.route('**/transcribe', answer(422, { error: 'transcriber_refused' }));
    const id = await capture(page);
    await page.waitForFunction(() => document.getElementById('toast-msg').textContent.includes('Couldn’t transcribe'));
    const [record] = await queued(page);
    assert.equal(record.id, id);
    assert.equal(record.state, 'failed');
    assert.equal(record.lastError, 'transcriber_refused');
    assert.ok(record.size > 0, 'the Recording is still there for a retry');
    assert.deepEqual(await itemsById([id]), []);
  });
});

test('a reload while queued keeps the queue, and sends it once the server answers', async () => {
  await withJot({}, async ({ page }) => {
    await page.route('**/transcribe', (route) => route.abort('connectionrefused'));
    await page.route('**/health', (route) => route.abort('connectionrefused'));
    const id = await capture(page);
    await waitStatus(page, /^Inbox asleep · 1 queued$/);

    await page.unroute('**/transcribe');
    await page.unroute('**/health');
    await page.reload();
    await parked(page, id); // the reloaded page sends what the old one queued
    assert.equal((await itemsById([id])).length, 1, 'parked after the reload');
  });
});

test('the daily cap: the Capture waits, and the status says why', async () => {
  await withJot({}, async ({ page }) => {
    const tomorrow = new Date(Date.now() + 6 * 3600_000).toISOString();
    await page.route('**/transcribe', answer(429, { error: 'daily_cap', retry_at: tomorrow }));
    const id = await capture(page);
    await waitStatus(page, /^Daily limit reached · 1 queued$/);
    const [record] = await queued(page);
    assert.deepEqual([record.id, record.state], [id, 'queued']);
  });
});

test('signed out: Captures wait, then go once the Owner signs in', async () => {
  await withJot({ storageState: undefined }, async ({ page }) => {
    await page.waitForSelector('#signin:not([hidden])');
    const id = await capture(page);
    await waitStatus(page, /^Sign in to send · 1 queued$/);

    // Sign in through the card (the harness's Mailpit helpers).
    const { clearMail, latestCode } = await import('./harness.mjs');
    await clearMail();
    await new Promise((r) => setTimeout(r, 1100)); // Auth allows one code per address per second
    await page.fill('#email', 'owner@jot.local');
    await page.click('#email-form button[type=submit]');
    await page.waitForSelector('#code-form:not([hidden])');
    await page.fill('#code', await latestCode('owner@jot.local'));
    await page.click('#code-form button[type=submit]');
    await parked(page, id);
    assert.equal((await itemsById([id])).length, 1);
  });
});

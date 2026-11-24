// #10: the recent-Captures strip. Undo, restore, edit, processed, retry and throw away, against the local stack
// with the fake Transcriber (see queue.test.mjs for how the functions are served).

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { itemsById, openJot, ownerSession, processAsClaude, queued, removeItems, serveApp, SPEECH_WAV } from './harness.mjs';

let app;
let session;
const created = [];

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

async function capture(page) {
  const n = await page.evaluate(() => window.__captures.length);
  await page.click('#mic');
  await page.waitForFunction((k) => window.__captures.length > k, n, { timeout: 20_000 });
  const id = await page.evaluate(() => window.__captures.at(-1).id);
  created.push(id);
  return id;
}

const parked = (page, id) => page.waitForFunction((x) => window.__parked.some((p) => p.id === x), id, { timeout: 20_000 });
const row = (id) => `#recent-list .row[data-id="${id}"]`;
const toastSays = (page, text) =>
  page.waitForFunction((t) => document.getElementById('toast-msg').textContent.startsWith(t), text, { timeout: 10_000 });
const item = async (id) => (await itemsById([id]))[0];

test('a parked Item shows in the strip; Undo discards it, Restore brings it back', async () => {
  await withJot({}, async ({ page }) => {
    const id = await capture(page);
    await parked(page, id);
    await page.waitForSelector(`${row(id)}.is-inbox`);
    assert.match(await page.textContent(`${row(id)} .row-text`), /^fake transcript \d+$/);

    await page.click('#toast-undo');
    await page.waitForSelector(`${row(id)}.is-discarded`);
    assert.equal((await item(id)).status, 'discarded');
    assert.match(await page.textContent(`${row(id)} .row-meta`), /Discarded/);

    await page.click(`${row(id)} .restore`);
    await page.waitForSelector(`${row(id)}.is-inbox`);
    assert.equal((await item(id)).status, 'inbox');
  });
});

test('editing fixes the Text and leaves the Transcript alone', async () => {
  await withJot({}, async ({ page }) => {
    const id = await capture(page);
    await parked(page, id);
    const before = await item(id);

    await page.click(`${row(id)} .row-text`);
    await page.waitForSelector(`${row(id)}.editing`);
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Call Ngaio about the Fremantle lease');
    await page.keyboard.press('Enter');
    await page.waitForFunction((x) => !document.querySelector(`#recent-list .row[data-id="${x}"].editing`), id);
    await page.waitForFunction(
      async (x) => document.querySelector(`#recent-list .row[data-id="${x}"] .row-text`).textContent === 'Call Ngaio about the Fremantle lease',
      id,
    );
    await new Promise((r) => setTimeout(r, 300)); // let the RPC land
    const after = await item(id);
    assert.equal(after.text, 'Call Ngaio about the Fremantle lease');
    assert.equal(after.transcript, before.transcript);

    // Escape cancels.
    await page.click(`${row(id)} .row-text`);
    await page.keyboard.type(' and more');
    await page.keyboard.press('Escape');
    assert.equal(await page.textContent(`${row(id)} .row-text`), 'Call Ngaio about the Fremantle lease');
  });
});

test('an Item a Processor took becomes read-only', async () => {
  await withJot({}, async ({ page }) => {
    const id = await capture(page);
    await parked(page, id);
    await processAsClaude(id);
    await page.reload(); // refreshes the strip, as coming to the foreground does
    await page.waitForSelector(`${row(id)}.is-processed`);
    assert.match(await page.textContent(`${row(id)} .row-meta`), /Processed/);
    await page.click(`${row(id)} .row-text`);
    await toastSays(page, 'Already processed');
    assert.equal(await page.$(`${row(id)}.editing`), null);
  });
});

test('editing an Item processed meanwhile says so and shows it read-only', async () => {
  await withJot({}, async ({ page }) => {
    const id = await capture(page);
    await parked(page, id);
    await processAsClaude(id); // the strip doesn't know yet
    await page.click(`${row(id)} .row-text`);
    await page.keyboard.type(' later');
    await page.keyboard.press('Enter');
    await toastSays(page, 'Already processed');
    await page.waitForSelector(`${row(id)}.is-processed`);
  });
});

test('a failed Capture can be retried, or thrown away with a second tap', async () => {
  await withJot({}, async ({ page }) => {
    await page.route('**/transcribe', (route) =>
      route.fulfill({ status: 422, contentType: 'application/json', body: '{"error":"transcriber_refused"}' }));
    const a = await capture(page);
    await page.waitForSelector(`${row(a)}.is-failed`);
    assert.equal(await page.textContent(`${row(a)} .row-text`), 'Couldn’t transcribe');

    // Retry, with the server back to normal: it parks.
    await page.unroute('**/transcribe');
    await page.click(`${row(a)} .retry`);
    await parked(page, a);
    await page.waitForSelector(`${row(a)}.is-inbox`);

    // Another refusal, thrown away: the first tap only asks.
    await page.route('**/transcribe', (route) =>
      route.fulfill({ status: 422, contentType: 'application/json', body: '{"error":"transcriber_refused"}' }));
    const b = await capture(page);
    await page.waitForSelector(`${row(b)}.is-failed`);
    await page.click(`${row(b)} .throw-away`);
    await page.waitForFunction((sel) => document.querySelector(sel)?.textContent === 'Sure?', `${row(b)} .throw-away`);
    assert.ok((await queued(page)).some((r) => r.id === b), 'the first tap only asks');
    await page.click(`${row(b)} .throw-away`);
    await page.waitForSelector(row(b), { state: 'detached' });
    assert.ok(!(await queued(page)).some((r) => r.id === b), 'the Recording is gone from the phone');
  });
});

test('offline, edits and undo say they need a connection and change nothing', async () => {
  await withJot({}, async ({ page, context }) => {
    const id = await capture(page);
    await parked(page, id);
    const text = await page.textContent(`${row(id)} .row-text`);
    await context.setOffline(true);
    await page.click(`${row(id)} .row-text`);
    await page.keyboard.type(' offline');
    await page.keyboard.press('Enter');
    await toastSays(page, 'Needs a connection');
    assert.equal(await page.textContent(`${row(id)} .row-text`), text);
    await context.setOffline(false);
    assert.equal((await item(id)).text, text);
  });
});

test('the strip shows at most 10 rows, none older than 24 h', async () => {
  await withJot({ audioFile: undefined }, async ({ page }) => {
    await page.evaluate(() => {
      const now = Date.now();
      const rows = Array.from({ length: 12 }, (_, i) => ({ id: `seed-${i}`, text: `Seed ${i}`, status: 'inbox', at: now - i * 60_000 }));
      rows.push({ id: 'seed-old', text: 'Too old', status: 'inbox', at: now - 25 * 3600_000 });
      localStorage.setItem('jot.recent.v2', JSON.stringify(rows));
    });
    await page.reload();
    await page.waitForSelector('#recent:not([hidden])');
    assert.equal(await page.locator('#recent-list .row').count(), 10);
    assert.equal(await page.$(row('seed-old')), null);
    assert.equal(await page.textContent('#recent-list .row:first-child .row-text'), 'Seed 0');
  });
});

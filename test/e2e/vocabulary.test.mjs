// #11: the Vocabulary screen. Add, remove with Undo, duplicates, the 100 cap, reload, back, and a term reaching the
// Transcriber, against the local stack (see queue.test.mjs for how the functions are served). The Vocabulary is
// emptied for these tests and put back afterwards.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addVocabulary,
  itemsById,
  openJot,
  ownerSession,
  removeItems,
  serveApp,
  setVocabulary,
  silentWav,
  SPEECH_WAV,
  vocabularyTerms,
} from './harness.mjs';

let app;
let session;
let saved = [];
const created = [];

before(async () => {
  saved = await vocabularyTerms();
  app = await serveApp();
  session = await ownerSession(app.url);
});
after(async () => {
  await setVocabulary(saved).catch(() => {});
  await removeItems(created).catch(() => {});
  await app?.close();
});

async function withJot(options, fn) {
  const jot = await openJot(app.url, { storageState: session, ...options });
  try {
    await fn(jot);
    assert.deepEqual(jot.problems, [], 'no CSP violations or console errors');
  } finally {
    await jot.browser.close();
  }
}

async function openVocabulary(page, count) {
  await page.click('#vocab-open');
  await page.waitForSelector('#vocabulary:not([hidden])');
  await page.waitForFunction((c) => document.getElementById('vocab-count').textContent === c, count);
}

const shown = (page) => page.$$eval('#vocab-list .vocab-term', (els) => els.map((e) => e.textContent));
const error = (page) => page.textContent('#vocab-error');

async function add(page, term, how = 'enter') {
  const n = (await shown(page)).length;
  await page.fill('#vocab-term', term);
  if (how === 'enter') await page.press('#vocab-term', 'Enter');
  else await page.click('#vocab-add');
  await page.waitForFunction(
    (k) => document.querySelectorAll('#vocab-list .vocab-row').length > k || document.getElementById('vocab-error').textContent,
    n,
  );
}

const toastSays = (page, text) =>
  page.waitForFunction((t) => document.getElementById('toast-msg').textContent.startsWith(t), text, { timeout: 10_000 });

test('add terms, remove one and Undo it, and the list survives a reload', async () => {
  await setVocabulary([]);
  await withJot({}, async ({ page }) => {
    await page.waitForSelector('#vocab-open:not([hidden])');
    await openVocabulary(page, '0/100');
    assert.match(await page.textContent('#vocab-note'), /Nothing yet/);
    assert.ok(!(await page.isVisible('#mic')), 'the mic is out of the way');
    assert.ok(!(await page.isVisible('#fab')), 'and so is the floating mic');

    await add(page, 'Ngaio');
    await add(page, '  Fremantle   Doctors ', 'button');
    assert.deepEqual(await shown(page), ['Fremantle Doctors', 'Ngaio'], 'A–Z, trimmed and collapsed');
    assert.equal(await page.textContent('#vocab-count'), '2/100');
    assert.equal(await page.inputValue('#vocab-term'), '', 'the field clears for the next one');
    assert.deepEqual((await vocabularyTerms()).sort(), ['Fremantle Doctors', 'Ngaio']);

    await page.reload();
    await page.waitForFunction(() => document.getElementById('vocab-count').textContent === '2/100');
    assert.ok(await page.isVisible('#vocabulary'), 'a reload stays on the screen');
    assert.deepEqual(await shown(page), ['Fremantle Doctors', 'Ngaio']);

    await page.click('#vocab-list .vocab-row:has-text("Ngaio") .vocab-delete');
    await toastSays(page, 'Removed “Ngaio”');
    assert.deepEqual(await shown(page), ['Fremantle Doctors']);
    assert.deepEqual(await vocabularyTerms(), ['Fremantle Doctors']);

    await page.click('#toast-undo');
    await page.waitForFunction(() => document.getElementById('vocab-count').textContent === '2/100');
    assert.deepEqual(await shown(page), ['Fremantle Doctors', 'Ngaio']);
    assert.deepEqual((await vocabularyTerms()).sort(), ['Fremantle Doctors', 'Ngaio']);
  });
});

test('duplicates are refused whatever the case, here or by the database', async () => {
  await setVocabulary(['Ngaio']);
  await withJot({}, async ({ page }) => {
    await openVocabulary(page, '1/100');

    await add(page, 'nGAIO');
    assert.equal(await error(page), '“Ngaio” is already in your Vocabulary.');
    await page.type('#vocab-term', 'x');
    assert.equal(await error(page), '', 'typing clears the message');

    await add(page, 'a [b]');
    assert.match(await error(page), /Leave out/);

    // Added on another device while this screen was open: the database refuses it, and the list catches up.
    await addVocabulary(['Kalgoorlie']);
    await add(page, 'kalgoorlie');
    assert.equal(await error(page), '“kalgoorlie” is already in your Vocabulary.');
    await page.waitForFunction(() => document.getElementById('vocab-count').textContent === '2/100');
    assert.deepEqual(await shown(page), ['Kalgoorlie', 'Ngaio']);
    assert.deepEqual((await vocabularyTerms()).sort(), ['Kalgoorlie', 'Ngaio']);
  });
});

test('the cap: adding stops at 100, and the database holds the line too', async () => {
  const terms = (n) => Array.from({ length: n }, (_, i) => `Term ${String(i).padStart(3, '0')}`);
  await setVocabulary(terms(99));
  await withJot({}, async ({ page }) => {
    await openVocabulary(page, '99/100');
    await add(page, 'Last one');
    assert.equal(await page.textContent('#vocab-count'), '100/100');
    assert.ok(await page.isDisabled('#vocab-term'), 'the field is off at the cap');
    assert.ok(await page.isDisabled('#vocab-add'));
  });

  await setVocabulary(terms(98));
  await withJot({}, async ({ page }) => {
    await openVocabulary(page, '98/100');
    await addVocabulary(['Other A', 'Other B']); // full now, behind Jot's back
    await add(page, 'Over');
    assert.match(await error(page), /full \(100\)/);
    await page.waitForFunction(() => document.getElementById('vocab-count').textContent === '100/100');
    assert.ok(await page.isDisabled('#vocab-term'));
    assert.equal((await vocabularyTerms()).length, 100);
  });
});

test('back (button, gesture or Escape) returns to the mic; signing out closes the screen', async () => {
  await setVocabulary([]);
  await withJot({}, async ({ page }) => {
    await openVocabulary(page, '0/100');
    await page.click('#vocab-back');
    await page.waitForSelector('#vocabulary', { state: 'hidden' });
    assert.ok(await page.isVisible('#mic'));

    await openVocabulary(page, '0/100');
    await page.goBack(); // Android's back gesture
    await page.waitForSelector('#vocabulary', { state: 'hidden' });

    await openVocabulary(page, '0/100');
    await page.press('#vocab-term', 'Escape');
    await page.waitForSelector('#vocabulary', { state: 'hidden' });

    await openVocabulary(page, '0/100');
    await page.click('#account');
    await page.click('#sign-out');
    await page.waitForSelector('#signin:not([hidden])');
    assert.ok(!(await page.isVisible('#vocabulary')), 'closed on sign-out');
    assert.ok(!(await page.isVisible('#vocab-open')), 'and only the Owner sees the button');
  });
});

test('on a phone, the Vocabulary screen stops the mic and Jot doesn’t start listening behind it', async () => {
  await setVocabulary([]);
  await withJot({ audioFile: await silentWav(), phone: true }, async ({ page }) => {
    await page.waitForSelector('#mic[aria-pressed="true"]'); // listening on open
    await openVocabulary(page, '0/100');
    await page.waitForSelector('#mic[aria-pressed="false"]', { state: 'attached' });

    const foreground = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await foreground();
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(await page.getAttribute('#mic', 'aria-pressed'), 'false', 'no listening behind the screen');
    assert.equal(await page.evaluate(() => window.__captures.length), 0, 'nothing captured');

    await page.click('#vocab-back');
    await foreground();
    await page.waitForSelector('#mic[aria-pressed="true"]'); // back on the mic, it listens again
  });
});

test('a term added here is sent with the next Capture', async () => {
  await setVocabulary([]);
  await withJot({ audioFile: SPEECH_WAV }, async ({ page }) => {
    await openVocabulary(page, '0/100');
    await add(page, 'Ngaio');
    await page.click('#vocab-back');

    await page.click('#mic');
    await page.waitForFunction(() => window.__parked.length > 0, null, { timeout: 20_000 });
    const id = await page.evaluate(() => window.__parked[0].id);
    created.push(id);
    const [item] = await itemsById([id]);
    assert.deepEqual(item.meta.vocabulary, ['Ngaio'], 'the fake Transcriber got it as a key term');
  });
});

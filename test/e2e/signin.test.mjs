// #7: Jot's v2 shell and email-code sign-in, against the local Supabase stack (see harness.mjs).

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { clearMail, latestCode, openJot, serveApp } from './harness.mjs';

const OWNER = 'owner@jot.local'; // from supabase/seed.sql
// Another seeded user. Auth limits how often one address gets a code, so the wrong-code test uses this one.
const OTHER = 'claude@jot.local';

let app;
before(async () => {
  app = await serveApp();
});
after(async () => {
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

async function signIn(page, email = OWNER) {
  await page.fill('#email', email);
  await page.click('#email-form button[type=submit]');
  await page.waitForSelector('#code-form:not([hidden])');
  await page.fill('#code', await latestCode(email));
  await page.click('#code-form button[type=submit]');
  await page.waitForSelector('#account:not([hidden])');
}

test('first launch: the sign-in card shows above the mic, and nothing from v1 remains', async () => {
  await withJot({}, async ({ page }) => {
    await page.waitForSelector('#signin:not([hidden])');
    assert.equal(await page.isVisible('#mic'), true);
    assert.equal(await page.isVisible('#account'), false);
    for (const gone of ['#share', '#open', '#done', '#sync', '.task']) {
      assert.equal(await page.$(gone), null, `${gone} is gone`);
    }
  });
});

test('an unknown email is refused with a clear message', async () => {
  await withJot({}, async ({ page }) => {
    await page.fill('#email', 'stranger@jot.local');
    await page.click('#email-form button[type=submit]');
    await page.waitForSelector('#signin-error:not(:empty)');
    assert.equal(await page.textContent('#signin-error'), "That email isn't set up for Jot.");
    assert.equal(await page.isVisible('#code-form'), false);
  });
});

test('a malformed email never reaches the server', async () => {
  await withJot({}, async ({ page }) => {
    let calls = 0;
    page.on('request', (r) => r.url().includes('/auth/v1/otp') && calls++);
    await page.fill('#email', 'owner');
    await page.click('#email-form button[type=submit]');
    assert.equal(await page.textContent('#signin-error'), "That doesn't look like an email address.");
    assert.equal(calls, 0);
  });
});

test('the emailed code signs in; a reload stays signed in; sign out returns to the card', async () => {
  await clearMail();
  await withJot({}, async ({ page }) => {
    await page.evaluate(() => localStorage.setItem('jot.tasks.v1', '[{"id":"a","text":"v1 task","createdAt":1}]'));
    await signIn(page);
    assert.equal(await page.isVisible('#signin'), false);

    await page.reload();
    await page.waitForSelector('#account:not([hidden])');
    assert.equal(await page.isVisible('#signin'), false, 'still signed in after a reload');

    await page.click('#account');
    assert.equal(await page.textContent('#account-email'), OWNER);
    await page.click('#sign-out');
    await page.waitForSelector('#signin:not([hidden])');
    assert.equal(await page.isVisible('#account'), false);
    assert.equal(await page.inputValue('#email'), OWNER, 'the email is remembered');

    // v1's list is left alone for the import (#12).
    assert.equal(await page.evaluate(() => localStorage.getItem('jot.tasks.v1')), '[{"id":"a","text":"v1 task","createdAt":1}]');
  });
});

test('a wrong code is refused and the card stays', async () => {
  await clearMail();
  await withJot({}, async ({ page }) => {
    await page.fill('#email', OTHER);
    await page.click('#email-form button[type=submit]');
    await page.waitForSelector('#code-form:not([hidden])');
    const real = await latestCode(OTHER);
    await page.fill('#code', real === '000000' ? '111111' : '000000');
    await page.click('#code-form button[type=submit]');
    await page.waitForSelector('#signin-error:not(:empty)');
    assert.match(await page.textContent('#signin-error'), /wrong or has expired/);
    assert.equal(await page.isVisible('#account'), false);
  });
});

test('the service worker precaches the whole shell', async () => {
  await withJot({ serviceWorkers: 'allow' }, async ({ page }) => {
    await page.evaluate(() => navigator.serviceWorker.ready);
    const cached = await page.evaluate(async () => {
      const keys = await caches.keys();
      const cache = await caches.open(keys.find((k) => k.startsWith('jot-')));
      return (await cache.keys()).map((r) => new URL(r.url).pathname);
    });
    for (const path of ['/', '/main.js', '/inbox.js', '/signin.js', '/auth-errors.js', '/ui.js', '/config.js', '/vendor/supabase.js', '/styles.css']) {
      assert.ok(cached.includes(path), `${path} is precached`);
    }
  });
});

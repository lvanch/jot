// #8: recording with silence detection, using Chromium's fake microphone (see harness.mjs and test/fixtures/).

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { openJot, serveApp, silentWav, SPEECH_WAV } from './harness.mjs';

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

const captures = (page) => page.evaluate(() => window.__captures);

async function nextCapture(page, timeout = 20_000) {
  await page.waitForFunction(() => window.__captures.length > 0, null, { timeout });
  return (await captures(page))[0];
}

test('speech, then silence: one Capture of Opus in WebM, stopped by the silence', async () => {
  await withJot({ audioFile: SPEECH_WAV }, async ({ page }) => {
    await page.click('#mic');
    await page.waitForSelector('#mic[aria-pressed="true"]');
    assert.equal(await page.textContent('#status'), 'Listening…');

    const c = await nextCapture(page);
    assert.equal(c.stop, 'silence');
    assert.match(c.mimeType, /^audio\/webm/);
    assert.ok(c.size > 2000, `size ${c.size}`);
    assert.ok(c.durationMs > 2000 && c.durationMs < 12_000, `duration ${c.durationMs}`);
    assert.equal(c.device, 'desktop');
    assert.match(c.id, /^[0-9a-f-]{36}$/);

    await page.waitForSelector('#mic[aria-pressed="false"]');
    // Signed out here, so the queue holds it (sending is covered in queue.test.mjs).
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Sign in to send · 1 queued');
    assert.equal((await captures(page)).length, 1, 'exactly one Capture');
  });
});

test('silence only: gives up after 8 s and keeps nothing', async () => {
  await withJot({ audioFile: await silentWav() }, async ({ page }) => {
    await page.click('#mic');
    await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Didn’t catch that'), null, {
      timeout: 15_000,
    });
    assert.deepEqual(await captures(page), []);
    assert.equal(await page.getAttribute('#mic', 'aria-pressed'), 'false');
  });
});

test('a tap stops the Capture early and keeps it', async () => {
  await withJot({ audioFile: SPEECH_WAV }, async ({ page }) => {
    await page.click('#mic');
    await page.waitForSelector('#mic[aria-pressed="true"]');
    await page.waitForTimeout(1500);
    await page.click('#mic');
    const c = await nextCapture(page, 5000);
    assert.equal(c.stop, 'tap');
    assert.ok(c.durationMs >= 1000 && c.durationMs < 4000, `duration ${c.durationMs}`);
  });
});

test('on a phone, Jot starts listening as soon as it opens', async () => {
  await withJot({ audioFile: SPEECH_WAV, phone: true }, async ({ page }) => {
    await page.waitForSelector('#mic[aria-pressed="true"]', { timeout: 5000 });
    const c = await nextCapture(page);
    assert.equal(c.device, 'phone');
    assert.equal(c.stop, 'silence');
  });
});

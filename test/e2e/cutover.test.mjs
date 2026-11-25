// #14: rehearse the cut-over on a stand-in for GitHub Pages. Jot v1 is installed at /jot/app/ with its own service
// worker. Then the site switches to v2, the Actions-built site, which serves app/ at /jot/. The old address must hand
// over to the "Jot has moved" page instead of serving v1 from its cache. The new Jot must import v1's list. And once
// v2's own service worker is in charge, the old address must still be the moved page, not a broken copy of v2.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_DIR, clearMail, configJs, itemsById, latestCode, localIndex, openJot, removeItems, TYPES } from './harness.mjs';

const V1_DIR = fileURLToPath(new URL('../fixtures/v1/', import.meta.url));
const RUN = Date.now().toString(36);
const TASKS = [
  { id: `cut-open-${RUN}`, text: `Renew the rego ${RUN}`, createdAt: Date.parse('2026-11-01T01:00:00Z'), done: false, doneAt: null },
  { id: `cut-done-${RUN}`, text: `Pay the water bill ${RUN}`, createdAt: Date.parse('2026-11-02T01:00:00Z'), done: true, doneAt: Date.parse('2026-11-03T01:00:00Z') },
];
const IDS = TASKS.map((t) => t.id);

/** A stand-in for lvanch.github.io: v1 at /jot/app/ (Pages from the branch), or v2's app/ at /jot/ (Pages from Actions). */
async function pages() {
  let phase = 'v1';
  const inside = (dir, file) => file.startsWith(dir.endsWith(sep) ? dir : dir + sep);
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    res.setHeader('Cache-Control', 'no-store');
    let dir;
    let rel;
    if (phase === 'v1' && path.startsWith('/jot/app/')) {
      rel = path.slice('/jot/app/'.length);
      dir = rel.startsWith('icons/') ? APP_DIR : V1_DIR;
    } else if (phase === 'v2' && path.startsWith('/jot/')) {
      rel = path.slice('/jot/'.length);
      dir = APP_DIR;
    } else {
      res.writeHead(404).end('not found');
      return;
    }
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    if (phase === 'v2' && rel === 'config.js') {
      res.writeHead(200, { 'Content-Type': TYPES['.js'] }).end(configJs());
      return;
    }
    const file = normalize(join(dir, rel));
    if (!inside(dir, file)) {
      res.writeHead(403).end();
      return;
    }
    try {
      let body = await readFile(file);
      if (phase === 'v2' && rel === 'index.html') body = localIndex(body.toString('utf8'));
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    switchToV2: () => (phase = 'v2'),
    close: () => new Promise((r) => server.close(r)),
  };
}

let site;
before(async () => {
  site = await pages();
});
after(async () => {
  await removeItems(IDS).catch(() => {});
  await site?.close();
});

const controller = (page) => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null);

test('v1’s address hands over to v2, and v2 imports the v1 list', async () => {
  const jot = await openJot(`${site.origin}/jot/app/`, { serviceWorkers: 'allow' });
  const { page } = jot;
  try {
    // Before: v1 installed, with its worker serving it and its list in storage.
    await page.waitForSelector('#v1');
    await page.waitForFunction(() => navigator.serviceWorker.controller);
    assert.equal(await controller(page), `${site.origin}/jot/app/sw.js`);
    await page.evaluate((tasks) => localStorage.setItem('jot.tasks.v1', tasks), JSON.stringify(TASKS));

    // Cut-over. The old shortcut opens /jot/app/ again, and v1's worker hands over.
    site.switchToV2();
    await page.reload();
    await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Jot has moved', null, { timeout: 20_000 });
    assert.equal(await controller(page), null, 'v1’s worker is gone');
    assert.ok(await page.evaluate(() => localStorage.getItem('jot.tasks.v1')), 'v1’s list is untouched');

    // The new Jot: sign in, and v1's list is imported.
    await page.click('text=Open the new Jot');
    await page.waitForSelector('#signin:not([hidden])');
    assert.equal(new URL(page.url()).pathname, '/jot/');
    await clearMail();
    await page.fill('#email', 'owner@jot.local');
    await page.click('#email-form button[type=submit]');
    await page.waitForSelector('#code-form:not([hidden])');
    await page.fill('#code', await latestCode('owner@jot.local'));
    await page.click('#code-form button[type=submit]');
    await page.waitForFunction(
      () => document.getElementById('toast-msg').textContent.startsWith('Imported 2 items from Jot v1'),
      null,
      { timeout: 15_000 },
    );
    const items = await itemsById(IDS);
    const state = Object.fromEntries(items.map((i) => [i.id, [i.status, i.source]]));
    assert.deepEqual(state, { [IDS[0]]: ['inbox', 'jot-v1'], [IDS[1]]: ['processed', 'jot-v1'] });

    // With v2's worker in charge of /jot/, the old address is still the moved page, not v2's shell in the wrong place.
    await page.waitForFunction(() => navigator.serviceWorker.controller?.scriptURL.endsWith('/jot/sw.js'));
    await page.goto(`${site.origin}/jot/app/`);
    await page.waitForSelector('h1');
    assert.equal(await page.textContent('h1'), 'Jot has moved');
    assert.deepEqual(jot.problems, [], 'no CSP violations or console errors');
  } finally {
    await jot.browser.close();
  }
});

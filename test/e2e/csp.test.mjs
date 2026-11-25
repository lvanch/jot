// #6: the CSP meta tag (ADR-0013) does its job. Jot loads cleanly under it, and it blocks an inline script and a
// connection to anywhere but the Inbox. harness.mjs serves index.html as written, with only connect-src's
// Supabase host swapped for the local stack.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { openJot, serveApp } from './harness.mjs';

let app;
before(async () => {
  app = await serveApp();
});
after(async () => {
  await app?.close();
});

async function withJot(fn) {
  const jot = await openJot(app.url);
  try {
    await fn(jot);
  } finally {
    await jot.browser.close();
  }
}

const violations = (page) =>
  page.evaluate(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.effectiveDirective));
  });

test('smoke: Jot loads under its CSP with no violations or console errors', async () => {
  await withJot(async ({ page, problems }) => {
    await page.waitForSelector('#signin:not([hidden])');
    assert.ok(await page.isVisible('#mic'));
    const csp = await page.getAttribute('meta[http-equiv="Content-Security-Policy"]', 'content');
    assert.match(csp, /script-src 'self'/, 'the meta tag is there');
    assert.deepEqual(problems, []);
  });
});

test('the CSP blocks an inline script', async () => {
  await withJot(async ({ page, problems }) => {
    await page.waitForSelector('#signin:not([hidden])');
    await violations(page);
    await page.evaluate(() => {
      const s = document.createElement('script');
      s.textContent = 'window.__inlineRan = true;';
      document.body.append(s);
    });
    await page.waitForFunction(() => window.__csp.length > 0);
    assert.equal(await page.evaluate(() => window.__inlineRan), undefined, 'the inline script never ran');
    assert.deepEqual(await page.evaluate(() => window.__csp), ['script-src-elem']);
    assert.ok(problems.some((p) => p.startsWith('CSP violation: script-src-elem')));
  });
});

test('the CSP blocks connections to anywhere but the Inbox', async () => {
  await withJot(async ({ page }) => {
    await page.waitForSelector('#signin:not([hidden])');
    await violations(page);
    const result = await page.evaluate(() => fetch('https://example.com/').then(() => 'fetched', (e) => e.name));
    assert.equal(result, 'TypeError');
    assert.deepEqual(await page.evaluate(() => window.__csp), ['connect-src']);
  });
});

// Shared set-up for Jot's end-to-end tests: serve app/ the way production will (same CSP, with the local
// Supabase in connect-src), point config.js at the local stack, read sign-in codes from Mailpit, and fail
// on any CSP violation or console error.
//
// Needs the local stack (`supabase start`) and its values in the environment:
//   set -a; eval "$(supabase status -o env)"; set +a

import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const APP_DIR = fileURLToPath(new URL('../../app/', import.meta.url));
export const API_URL = process.env.API_URL ?? 'http://127.0.0.1:54321';
const PUBLISHABLE_KEY = process.env.PUBLISHABLE_KEY;
const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://127.0.0.1:54324';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.json': 'application/json',
  '.md': 'text/plain; charset=utf-8',
};

/** Production's CSP (spec §6), with the local Supabase in place of the hosted one. */
export function csp(apiUrl = API_URL) {
  const ws = apiUrl.replace(/^http/, 'ws');
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "media-src 'self' blob:",
    `connect-src 'self' ${apiUrl} ${ws}`,
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** Serves app/ on 127.0.0.1 with the CSP header, and a config.js pointing at the local stack. */
export async function serveApp() {
  if (!PUBLISHABLE_KEY) throw new Error('PUBLISHABLE_KEY is not set: run  set -a; eval "$(supabase status -o env)"; set +a');
  const config = `export const SUPABASE_URL = ${JSON.stringify(API_URL)};\n` +
    `export const SUPABASE_PUBLISHABLE_KEY = ${JSON.stringify(PUBLISHABLE_KEY)};\n`;
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const rel = path.endsWith('/') ? path + 'index.html' : path;
    const file = normalize(join(APP_DIR, rel));
    res.setHeader('Content-Security-Policy', csp());
    res.setHeader('Cache-Control', 'no-store');
    if (!file.startsWith(APP_DIR.endsWith(sep) ? APP_DIR : APP_DIR + sep)) {
      res.writeHead(403).end();
      return;
    }
    if (rel === '/config.js') {
      res.writeHead(200, { 'Content-Type': TYPES['.js'] }).end(config);
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((r) => server.close(r)) };
}

/** A browser with a phone-sized page that records CSP violations and console errors. */
export async function openJot(url, { serviceWorkers = 'block', storageState } = {}) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers, storageState });
  const problems = [];
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  const page = await context.newPage();
  page.on('console', (msg) => {
    // A refused request (e.g. a 422 for an unknown email) is the server's answer, not an app error.
    if (msg.type() === 'error' && !/^Failed to load resource: the server responded with a status of/.test(msg.text())) {
      problems.push(msg.text());
    }
  });
  page.on('pageerror', (err) => problems.push(`page error: ${err.message}`));
  await page.goto(url);
  return { browser, context, page, problems };
}

// ---------- Mailpit: the local inbox that receives sign-in codes ----------

export async function clearMail() {
  await fetch(`${MAILPIT_URL}/api/v1/messages`, { method: 'DELETE' });
}

/** The newest sign-in code sent to `email`, waiting up to 10 s for it to arrive. */
export async function latestCode(email) {
  for (let i = 0; i < 50; i++) {
    const search = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
    const { messages = [] } = await search.json();
    if (messages.length) {
      const msg = await (await fetch(`${MAILPIT_URL}/api/v1/message/${messages[0].ID}`)).json();
      const match = /\b(\d{6,10})\b/.exec(msg.Text ?? msg.HTML ?? '');
      if (match) return match[1];
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no sign-in code arrived for ${email}`);
}

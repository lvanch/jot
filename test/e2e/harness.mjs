// Shared set-up for Jot's end-to-end tests: serve app/ the way production will (same CSP, with the local
// Supabase in connect-src), point config.js at the local stack, read sign-in codes from Mailpit, and fail
// on any CSP violation or console error.
//
// Needs the local stack (`supabase start`) and its values in the environment:
//   set -a; eval "$(supabase status -o env)"; set +a

import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const APP_DIR = fileURLToPath(new URL('../../app/', import.meta.url));
export const API_URL = process.env.API_URL ?? 'http://127.0.0.1:54321';
// Where the Edge Functions answer. Through the gateway by default; set it when they're served on the host
// instead (supabase/tests/functions/serve_local.ts).
export const FUNCTIONS_URL = process.env.FUNCTIONS_URL ?? `${API_URL}/functions/v1`;
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
  const functionsOrigin = new URL(FUNCTIONS_URL).origin;
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "media-src 'self' blob:",
    `connect-src 'self' ${apiUrl} ${ws}${functionsOrigin === new URL(apiUrl).origin ? '' : ` ${functionsOrigin}`}`,
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
    `export const SUPABASE_PUBLISHABLE_KEY = ${JSON.stringify(PUBLISHABLE_KEY)};\n` +
    `export const FUNCTIONS_URL = ${JSON.stringify(FUNCTIONS_URL)};\n`;
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

export const SPEECH_WAV = fileURLToPath(new URL('../fixtures/speech.wav', import.meta.url));

/** Writes `seconds` of digital silence as a 16 kHz mono WAV and returns its path. */
export async function silentWav(seconds = 12) {
  const rate = 16000;
  const data = rate * seconds * 2;
  const wav = Buffer.alloc(44 + data);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + data, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); // fmt chunk size
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28); // byte rate
  wav.writeUInt16LE(2, 32); // block align
  wav.writeUInt16LE(16, 34); // bits per sample
  wav.write('data', 36);
  wav.writeUInt32LE(data, 40);
  const path = join(tmpdir(), `jot-silence-${seconds}s.wav`);
  await writeFile(path, wav);
  return path;
}

/**
 * A browser with a phone-sized page that records CSP violations and console errors.
 * `audioFile` plays as the microphone (looped). `phone` emulates a touch phone, where Jot starts listening on
 * its own. Autoplay is allowed, as it is for an installed PWA, so the level meter runs without a tap.
 */
export async function openJot(url, { serviceWorkers = 'block', storageState, audioFile, phone = false } = {}) {
  const args = audioFile
    ? [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${audioFile}`,
      '--autoplay-policy=no-user-gesture-required',
    ]
    : [];
  const browser = await chromium.launch({ args });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    serviceWorkers,
    storageState,
    ...(phone ? { isMobile: true, hasTouch: true } : {}),
    ...(audioFile ? { permissions: ['microphone'] } : {}),
  });
  const problems = [];
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`);
    });
    // Every Capture Jot emits and every Item it parks (see main.js), for tests to inspect.
    window.__captures = [];
    window.__parked = [];
    window.addEventListener('jot:capture', (e) => window.__captures.push(e.detail));
    window.addEventListener('jot:parked', (e) => window.__parked.push(e.detail));
  });
  const page = await context.newPage();
  page.on('console', (msg) => {
    // A refused request (a 422 for an unknown email) or a dropped one (a test cutting the network) is the
    // network's doing, not an app error. CORS refusals and CSP violations still count.
    if (msg.type() === 'error' && !/^Failed to load resource: (the server responded with a status of|net::ERR_)/.test(msg.text())) {
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

// ---------- Signing in once, for tests that only need a signed-in Owner ----------

/** Signs the seeded Owner in through the real UI and returns the browser storage to reuse in later contexts. */
export async function ownerSession(appUrl) {
  await clearMail();
  const jot = await openJot(appUrl);
  try {
    await jot.page.fill('#email', 'owner@jot.local');
    await jot.page.click('#email-form button[type=submit]');
    await jot.page.waitForSelector('#code-form:not([hidden])');
    await jot.page.fill('#code', await latestCode('owner@jot.local'));
    await jot.page.click('#code-form button[type=submit]');
    await jot.page.waitForSelector('#account:not([hidden])');
    return await jot.context.storageState();
  } finally {
    await jot.browser.close();
  }
}

// ---------- Looking at the Inbox directly (secret key: tests only) ----------

const SECRET_KEY = process.env.SECRET_KEY;

async function rest(path, init = {}) {
  if (!SECRET_KEY) throw new Error('SECRET_KEY is not set: run  set -a; eval "$(supabase status -o env)"; set +a');
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { apikey: SECRET_KEY, 'Content-Type': 'application/json', ...init.headers },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

const inList = (ids) => `in.(${ids.map((id) => `"${id}"`).join(',')})`;

export const itemsById = (ids) => rest(`/rest/v1/items?id=${inList(ids)}&select=*`);
export const logFor = (id) => rest(`/rest/v1/transcription_log?item_id=eq.${id}&select=outcome`);

/** Removes Items, their log rows and their Recordings. */
export async function removeItems(ids) {
  if (!ids.length) return;
  const items = await itemsById(ids);
  const paths = items.map((i) => i.recording_path).filter(Boolean);
  if (paths.length) {
    await rest('/storage/v1/object/recordings', { method: 'DELETE', body: JSON.stringify({ prefixes: paths }) });
  }
  await rest(`/rest/v1/items?id=${inList(ids)}`, { method: 'DELETE' });
  await rest(`/rest/v1/transcription_log?item_id=${inList(ids)}`, { method: 'DELETE' });
}

/** The Vocabulary's terms, oldest first. */
export const vocabularyTerms = async () => (await rest('/rest/v1/vocabulary?select=term&order=id')).map((r) => r.term);

/** Replaces the whole Vocabulary. */
export async function setVocabulary(terms) {
  await rest('/rest/v1/vocabulary?id=gt.0', { method: 'DELETE' });
  await addVocabulary(terms);
}

/** Adds terms behind Jot's back, as another device would. */
export async function addVocabulary(terms) {
  if (terms.length) await rest('/rest/v1/vocabulary', { method: 'POST', body: JSON.stringify(terms.map((term) => ({ term }))) });
}

/** What Jot holds in IndexedDB, without the Recordings. */
export function queued(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('jot', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('captures', { keyPath: 'id' });
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const all = req.result.transaction('captures').objectStore('captures').getAll();
          all.onsuccess = () => {
            resolve(all.result.map(({ blob, ...rest }) => ({ ...rest, size: blob.size })));
            req.result.close();
          };
          all.onerror = () => reject(all.error);
        };
      }),
  );
}

/** Processes an Item as the seeded `claude` agent (a processor), the way a future Processor would. */
export async function processAsClaude(id, outcome = { to: 'test' }) {
  const key = process.env.PUBLISHABLE_KEY;
  const auth = await fetch(`${API_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'claude@jot.local', password: 'local-claude-password' }),
  });
  const { access_token: token } = await auth.json();
  const res = await fetch(`${API_URL}/rest/v1/rpc/process_item`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ item_id: id, outcome }),
  });
  if (!res.ok) throw new Error(`process_item: ${res.status} ${await res.text()}`);
  return res.json();
}

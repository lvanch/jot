// End-to-end check of Jot + jot-api: two browser contexts ("phone", "laptop") against a local Worker.
//
//   node --disable-warning=ExperimentalWarning test/e2e.mjs
//
// Needs Node 22+, Playwright with Chromium, openssl, and permission to listen on port 443 (the API is served
// at https://jot-api.test.workers.dev so the production CSP's connect-src applies unchanged). Speech is faked.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import worker from '../api/src/index.js';
import { D1 } from '../api/test/d1.js';
import { nodeHandler } from '../api/test/serve.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APP_DIR = path.join(ROOT, 'app');
const BASELINE = 'f38a1a2'; // last release before sync: what's installed on the phone
const JOT = 'http://localhost:8080';
const API_HOST = 'jot-api.test.workers.dev';
const API = `https://${API_HOST}`;
const KEYS = { phone: 'phone-' + 'a1'.repeat(20), laptop: 'laptop-' + 'b2'.repeat(20), claude: 'claude-' + 'c3'.repeat(20) };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jot-e2e-'));

// ---------- Results ----------

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log('PASS', name);
  } catch (err) {
    results.push({ name, ok: false, why: err.message });
    console.log('FAIL', name, '\n     ', err.message.split('\n')[0]);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}: expected ${e}, got ${a}`);
}

async function until(fn, msg, timeout = 8000) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() > end) throw new Error(`timed out: ${msg}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ---------- Servers ----------

// The pre-sync release, as served from the repo root before this change.
const OLD_DIR = path.join(tmp, 'old');
fs.mkdirSync(path.join(OLD_DIR, 'icons'), { recursive: true });
for (const f of ['index.html', 'app.js', 'styles.css', 'sw.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-512-maskable.png']) {
  fs.writeFileSync(path.join(OLD_DIR, f), execFileSync('git', ['-C', ROOT, 'show', `${BASELINE}:${f}`]));
}

function pagesHeaders(dir) {
  // Cloudflare Pages applies _headers; only the "/*" block is used here.
  const file = path.join(dir, '_headers');
  if (!fs.existsSync(file)) return {};
  const out = {};
  let inAll = false;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) inAll = line.trim() === '/*';
    else if (inAll) {
      const i = line.indexOf(':');
      out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return out;
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
let siteDir = OLD_DIR;
const siteLog = [];

const site = http.createServer((req, res) => {
  const url = new URL(req.url, JOT);
  siteLog.push(url.pathname);
  const headers = { 'Cache-Control': 'public, max-age=0, must-revalidate', ...pagesHeaders(siteDir) };
  // Like Pages: /index.html redirects to /.
  if (url.pathname === '/index.html') {
    res.writeHead(308, { ...headers, Location: '/' });
    return res.end();
  }
  const rel = url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname;
  const file = path.join(siteDir, path.normalize(decodeURIComponent(rel)));
  if (!file.startsWith(siteDir) || path.basename(file) === '_headers' || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, headers);
    return res.end('not found');
  }
  res.writeHead(200, { ...headers, 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => site.listen(8080, '127.0.0.1', r));

const env = { DB: new D1(path.join(tmp, 'jot.sqlite')), JOT_KEYS: JSON.stringify(KEYS) };
const apiControl = { fail: 0, delay: 0, log: [] };
const inner = nodeHandler(env, { origin: API });
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${API_HOST}`, '-addext', `subjectAltName=DNS:${API_HOST}`, '-keyout', path.join(tmp, 'key.pem'), '-out', path.join(tmp, 'cert.pem')], { stdio: 'ignore' });
const apiServer = https.createServer({ key: fs.readFileSync(path.join(tmp, 'key.pem')), cert: fs.readFileSync(path.join(tmp, 'cert.pem')) }, (req, res) => {
  apiControl.log.push(`${req.method} ${req.url}`);
  if (apiControl.fail && req.method !== 'OPTIONS') {
    res.writeHead(apiControl.fail, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
    return res.end('{"error":"injected"}');
  }
  if (apiControl.delay) setTimeout(() => inner(req, res), apiControl.delay);
  else inner(req, res);
});
await new Promise((r) => apiServer.listen(443, '127.0.0.1', r));

// Direct API access, as Claude Code would have it.
async function api(method, p, body, key = KEYS.claude) {
  const res = await worker.fetch(
    new Request(API + p, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }),
    env
  );
  return { status: res.status, body: await res.json() };
}
const serverTasks = async () => (await api('GET', '/tasks')).body.tasks;
const serverTask = async (text) => (await serverTasks()).find((t) => t.text === text);

// ---------- Browser ----------

// The fake workers.dev host is local, so keep Chromium off any outbound proxy from the environment.
const browserEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/proxy/i.test(k)));
const browser = await chromium.launch({ env: browserEnv, args: [`--host-resolver-rules=MAP ${API_HOST} 127.0.0.1`, '--no-proxy-server'] });

// Fake speech: the page's SpeechRecognition is driven by window.__sr.say(text). Also records CSP violations.
const INIT = () => {
  window.__csp = [];
  document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  const sr = { active: null, starts: 0 };
  class FakeRecognition {
    start() {
      if (sr.active) throw new DOMException('already started', 'InvalidStateError');
      sr.active = this;
      sr.starts++;
    }
    stop() {
      if (sr.active === this) setTimeout(() => this.end(), 10);
    }
    abort() {
      if (sr.active !== this) return;
      setTimeout(() => {
        if (this.onerror) this.onerror({ error: 'aborted' });
        this.end();
      }, 0);
    }
    end() {
      if (sr.active === this) sr.active = null;
      if (this.onend) this.onend();
    }
  }
  sr.say = (text) => {
    if (!sr.active || sr.active.used) return false;
    sr.active.used = true;
    const result = [{ transcript: text }];
    result.isFinal = true;
    sr.active.onresult({ results: [result] });
    return true;
  };
  window.__sr = sr;
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
};

const consoleErrors = [];
const apiResponsesFromSW = [];
const PHONE = { viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const LAPTOP = { viewport: { width: 1280, height: 800 } };

async function device(name, opts) {
  const context = await browser.newContext({ ...opts, ignoreHTTPSErrors: true });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: JOT });
  await context.addInitScript(INIT);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push({ device: name, phase: phase, text: m.text() });
  });
  page.on('pageerror', (e) => consoleErrors.push({ device: name, phase, text: 'pageerror: ' + e.message }));
  page.on('response', (r) => {
    if (r.url().startsWith(API) && r.fromServiceWorker()) apiResponsesFromSW.push(r.url());
  });
  const apiRequests = [];
  page.on('request', (r) => {
    if (r.url().startsWith(API)) apiRequests.push(`${r.method()} ${r.url()}`);
  });
  return { name, context, page, apiRequests };
}

let phase = 'setup';

// ---------- Page helpers ----------

const openTexts = (p) => p.evaluate(() => [...document.querySelectorAll('#open .task .text')].map((e) => e.textContent));
const doneTexts = (p) => p.evaluate(() => [...document.querySelectorAll('#done .task .text')].map((e) => e.textContent));
const stored = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('jot.tasks.v1') || '[]'));
const outboxLength = (p) => p.evaluate(() => (JSON.parse(localStorage.getItem('jot.outbox.v1') || '[]') || []).length);
const syncLine = (p) => p.evaluate(() => {
  const el = document.getElementById('sync');
  return el && !el.hidden ? el.textContent : '';
});
const toastText = (p) => p.evaluate(() => (document.getElementById('toast').hidden ? '' : document.getElementById('toast-msg').textContent));

async function say(p, text) {
  // Let a finished recognition run end first.
  await until(() => p.evaluate(() => !window.__sr.active || !window.__sr.active.used), 'previous run ended');
  // Check and tap in one go, so the app's own auto-start can't slip in between.
  await p.evaluate(() => window.__sr.active || document.getElementById('mic').click());
  await until(() => p.evaluate(() => !!window.__sr.active), 'mic listening');
  assert(await p.evaluate((t) => window.__sr.say(t), text), 'spoke');
}

// Return to foreground (what the phone does on power-button launch, or switching back to the tab).
const foreground = (p) => p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

async function settle(p) {
  await until(async () => (await outboxLength(p)) === 0 && !(await syncLine(p)), `${p.__name} outbox flushed`);
}

async function pull(p) {
  await foreground(p);
  await settle(p);
  // a pull with nothing to send still needs a round trip
  await p.waitForTimeout(150);
  await settle(p);
}

const rowOf = (p, text) => p.locator('.task', { has: p.locator('.text', { hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });

async function tick(p, text) {
  const done = await doneTexts(p);
  if (done.includes(text)) await p.evaluate(() => (document.getElementById('done-wrap').open = true));
  await rowOf(p, text).locator('.tick').click();
}

async function edit(p, from, to) {
  if ((await doneTexts(p)).includes(from)) await p.evaluate(() => (document.getElementById('done-wrap').open = true));
  await rowOf(p, from).locator('.text').click();
  await until(() => p.evaluate(() => !!document.querySelector('.task.editing')), 'edit mode');
  await p.keyboard.press('Control+A');
  if (to) await p.keyboard.type(to);
  else await p.keyboard.press('Backspace');
  await p.keyboard.press('Enter');
}

async function swipeDelete(p, text) {
  const box = await rowOf(p, text).boundingBox();
  const y = box.y + box.height / 2;
  await p.mouse.move(box.x + box.width - 10, y);
  await p.mouse.down();
  for (let i = 1; i <= 10; i++) await p.mouse.move(box.x + box.width - 10 - (box.width * 0.8 * i) / 10, y);
  await p.mouse.up();
  await until(async () => !(await openTexts(p)).includes(text) && !(await doneTexts(p)).includes(text), `swiped away ${text}`);
}

async function undo(p) {
  await p.click('#toast-undo');
}

async function noHorizontalScroll(p) {
  const r = await p.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, vw: window.innerWidth }));
  assert(r.doc <= r.vw && r.body <= r.vw, `scrollWidth ${JSON.stringify(r)}`);
}

// ---------- Run ----------

const phone = await device('phone', PHONE);
const laptop = await device('laptop', LAPTOP);
phone.page.__name = 'phone';
laptop.page.__name = 'laptop';
const P = phone.page;
const L = laptop.page;

try {
  // ----- The phone as installed today -----
  phase = 'baseline';
  await P.goto(JOT + '/');
  await P.evaluate(() => navigator.serviceWorker.ready);
  await say(P, 'pick up dry cleaning');
  await until(async () => (await openTexts(P)).includes('Pick up dry cleaning'), 'baseline capture');
  await say(P, 'email landlord');
  await until(async () => (await openTexts(P)).includes('Email landlord'), 'baseline capture 2');
  await tick(P, 'Email landlord');
  const baselineTasks = await stored(P);

  // ----- Deploy: the new service worker takes over and Jot reloads -----
  phase = 'upgrade';
  siteDir = APP_DIR;
  await check('Upgrade: new SW (jot-v3) replaces jot-v2 and keeps jot.tasks.v1', async () => {
    await P.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
    await until(() => P.evaluate(async () => (await caches.keys()).join() === 'jot-v3'), 'cache jot-v3 only');
    await P.reload();
    await until(() => P.evaluate(() => !!document.getElementById('sync')), 'new app loaded');
    eq(await stored(P), baselineTasks, 'stored tasks unchanged');
    eq(await openTexts(P), ['Pick up dry cleaning'], 'open list');
    eq(await doneTexts(P), ['Email landlord'], 'done list');
  });

  await check('SW: precache has ./ and not index.html; navigation works offline from cache', async () => {
    const urls = await P.evaluate(async () => (await (await caches.open('jot-v3')).keys()).map((r) => new URL(r.url).pathname));
    assert(urls.includes('/'), 'has /: ' + urls);
    assert(!urls.some((u) => u.includes('index.html')), 'no index.html: ' + urls);
    assert(!siteLog.includes('/index.html'), 'index.html never requested');
    await phone.context.setOffline(true);
    await P.reload();
    eq(await openTexts(P), ['Pick up dry cleaning'], 'offline reload from cache');
    await phone.context.setOffline(false);
    await P.reload();
  });

  await check('Manifest: id, start_url, scope are ./ and Chrome reports zero installability errors', async () => {
    const m = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'manifest.webmanifest'), 'utf8'));
    eq([m.id, m.start_url, m.scope], ['./', './', './'], 'manifest fields');
    const cdp = await phone.context.newCDPSession(P);
    await until(() => P.evaluate(() => !!navigator.serviceWorker.controller), 'SW controls page');
    const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
    eq(installabilityErrors, [], 'installability errors');
    const { errors } = await cdp.send('Page.getAppManifest');
    eq(errors, [], 'manifest parse errors');
  });

  await check('CSP header is served on every response (incl. SW-cached shell)', async () => {
    const res = await P.request.get(JOT + '/');
    assert((res.headers()['content-security-policy'] || '').includes("connect-src 'self' https://*.workers.dev"), 'CSP header on /');
    const cached = await P.evaluate(async () => (await (await caches.open('jot-v3')).match('./')).headers.get('content-security-policy'));
    assert(cached && cached.includes("script-src 'self'"), 'cached shell carries CSP');
  });

  // ----- No key: today's behaviour -----
  phase = 'local-only';
  await check('No key: auto-listen on touch, capture + Saved·Undo, tick/Done, edit, Escape, empty-edit undo, swipe-delete undo, share/copy; zero API requests', async () => {
    await foreground(P);
    await until(() => P.evaluate(() => !!window.__sr.active), 'auto-listen on phone');
    eq(await P.textContent('#status'), 'Listening…', 'status while listening');
    await P.evaluate(() => window.__sr.say('buy milk'));
    await until(async () => (await openTexts(P))[0] === 'Buy milk', 'captured + capitalised');
    eq(await toastText(P), 'Saved ·', 'saved toast');
    assert(await P.isVisible('#toast-undo'), 'undo visible');
    await undo(P);
    await until(async () => !(await openTexts(P)).includes('Buy milk'), 'Saved·Undo removes');
    const tomb = (await stored(P)).find((t) => t.text === 'Buy milk');
    assert(tomb && tomb.deletedAt, 'Saved·Undo leaves a tombstone');

    await say(P, 'call mum');
    await say(P, 'book dentist');
    await say(P, 'water plants');
    await until(async () => (await openTexts(P)).length === 4, 'four open');
    eq(await openTexts(P), ['Water plants', 'Book dentist', 'Call mum', 'Pick up dry cleaning'], 'newest first');

    await tick(P, 'Call mum');
    await until(async () => (await doneTexts(P)).includes('Call mum'), 'ticked to Done');
    eq(await P.textContent('#done-count'), '· 2', 'done count');
    await tick(P, 'Call mum');
    await until(async () => (await openTexts(P)).includes('Call mum'), 'unticked');

    await edit(P, 'Book dentist', 'Book dentist for Tuesday');
    await until(async () => (await openTexts(P)).includes('Book dentist for Tuesday'), 'edited');

    await rowOf(P, 'Water plants').locator('.text').click();
    await P.keyboard.press('Control+A');
    await P.keyboard.type('nope');
    await P.keyboard.press('Escape');
    await until(async () => (await openTexts(P)).includes('Water plants') && !(await openTexts(P)).includes('nope'), 'Escape cancels');

    await edit(P, 'Water plants', '');
    await until(async () => !(await openTexts(P)).includes('Water plants'), 'empty edit deletes');
    eq(await toastText(P), 'Deleted ·', 'deleted toast');
    await undo(P);
    await until(async () => (await openTexts(P)).includes('Water plants'), 'undo restores');

    await swipeDelete(P, 'Call mum');
    eq(await toastText(P), 'Deleted ·', 'swipe toast');
    await undo(P);
    await until(async () => (await openTexts(P)).includes('Call mum'), 'swipe undo restores');

    await P.click('#share');
    await until(async () => (await toastText(P)).startsWith('Copied'), 'copied toast');
    eq(await toastText(P), 'Copied 4 tasks', 'copy toast');
    const clip = await P.evaluate(() => navigator.clipboard.readText());
    eq(clip, '- Water plants\n- Book dentist for Tuesday\n- Call mum\n- Pick up dry cleaning', 'clipboard');

    eq(phone.apiRequests, [], 'no API requests without a key');
    eq(await syncLine(P), '', 'no sync status');
  });

  // ----- Link the phone: first sync -----
  phase = 'link-phone';
  const phoneLocal = await stored(P);
  await check('One-time link: key stored, hash stripped, /me verified, first sync uploads every existing task', async () => {
    await P.goto(`${JOT}/#api=${encodeURIComponent(API)}&key=${KEYS.phone}`);
    await until(async () => (await toastText(P)) === 'Sync on · phone', 'linked toast');
    eq(P.url(), JOT + '/', 'hash stripped');
    const cfg = await P.evaluate(() => JSON.parse(localStorage.getItem('jot.sync.v1')));
    eq([cfg.api, cfg.key], [API, KEYS.phone], 'stored link');
    await settle(P);
    const server = await serverTasks();
    eq(server.map((t) => t.id).sort(), phoneLocal.map((t) => t.id).sort(), 'every local task (incl. tombstone) on server');
    for (const t of phoneLocal) {
      const s = server.find((x) => x.id === t.id);
      eq([s.text, s.createdAt, s.done, s.doneAt, !!s.deletedAt, s.updatedBy], [t.text, t.createdAt, !!t.done, t.doneAt ?? null, !!t.deletedAt, 'phone'], 'row ' + t.text);
    }
    assert(phone.apiRequests.some((r) => r.startsWith('GET ' + API + '/me')), '/me called');
  });

  await check('Reload after linking does not re-upload (first sync runs once)', async () => {
    const before = apiControl.log.filter((l) => l.startsWith('PUT')).length;
    await P.reload();
    await settle(P);
    await P.waitForTimeout(300);
    eq(apiControl.log.filter((l) => l.startsWith('PUT')).length, before, 'no new PUTs');
  });

  // ----- Laptop -----
  phase = 'link-laptop';
  await check('Laptop: links, pulls the phone tasks, and does not auto-listen', async () => {
    await L.goto(`${JOT}/#api=${API}&key=${KEYS.laptop}`); // the documented, unencoded form
    await until(async () => (await openTexts(L)).length === 4, 'laptop pulled');
    eq(await openTexts(L), await openTexts(P), 'same open list');
    eq(await doneTexts(L), await doneTexts(P), 'same done list');
    await L.waitForTimeout(400);
    eq(await L.evaluate(() => window.__sr.starts), 0, 'no auto-listen');
    eq(await L.textContent('#status'), 'Tap to speak', 'idle status');
    await L.click('#mic');
    await until(() => L.evaluate(() => !!window.__sr.active), 'tap starts mic');
    await L.evaluate(() => window.__sr.say('renew passport'));
    await until(async () => (await openTexts(L)).includes('Renew passport'), 'laptop capture');
    await settle(L);
  });

  phase = 'propagation';
  await check('Propagates both ways: capture', async () => {
    await pull(P);
    assert((await openTexts(P)).includes('Renew passport'), 'laptop → phone');
    await say(P, 'feed the cat');
    await until(async () => (await openTexts(P)).includes('Feed the cat'), 'phone capture');
    await settle(P);
    await pull(L);
    assert((await openTexts(L)).includes('Feed the cat'), 'phone → laptop');
  });

  await check('Propagates both ways: tick / untick', async () => {
    await tick(P, 'Feed the cat');
    await settle(P);
    await pull(L);
    assert((await doneTexts(L)).includes('Feed the cat'), 'phone tick → laptop');
    await tick(L, 'Feed the cat');
    await settle(L);
    await pull(P);
    assert((await openTexts(P)).includes('Feed the cat'), 'laptop untick → phone');
  });

  await check('Propagates both ways: inline edit', async () => {
    await edit(L, 'Renew passport', 'Renew passport before June');
    await settle(L);
    await pull(P);
    assert((await openTexts(P)).includes('Renew passport before June'), 'laptop edit → phone');
    await edit(P, 'Feed the cat', 'Feed the cat at 6');
    await settle(P);
    await pull(L);
    assert((await openTexts(L)).includes('Feed the cat at 6'), 'phone edit → laptop');
  });

  await check('Propagates both ways: swipe-delete and Deleted·Undo (restore)', async () => {
    await swipeDelete(P, 'Feed the cat at 6');
    await settle(P);
    await pull(L);
    assert(!(await openTexts(L)).includes('Feed the cat at 6'), 'phone delete → laptop');
    assert((await serverTask('Feed the cat at 6')).deletedAt, 'server tombstone');
    await undo(P);
    await settle(P);
    await pull(L);
    assert((await openTexts(L)).includes('Feed the cat at 6'), 'phone undo → laptop');
    eq((await serverTask('Feed the cat at 6')).deletedAt, null, 'server restored');

    await swipeDelete(L, 'Water plants');
    await settle(L);
    await pull(P);
    assert(!(await openTexts(P)).includes('Water plants'), 'laptop delete → phone');
    await undo(L);
    await settle(L);
    await pull(P);
    assert((await openTexts(P)).includes('Water plants'), 'laptop undo → phone');
  });

  await check('Propagates both ways: Saved·Undo and edit-to-empty become tombstones (and undo restores)', async () => {
    await say(P, 'oops wrong thing');
    await until(async () => (await openTexts(P)).includes('Oops wrong thing'), 'captured');
    await undo(P);
    await settle(P);
    const oops = await serverTask('Oops wrong thing');
    assert(oops && oops.deletedAt, 'Saved·Undo → server tombstone');
    await pull(L);
    assert(!(await openTexts(L)).includes('Oops wrong thing'), 'not shown on laptop');
    assert((await stored(L)).some((t) => t.text === 'Oops wrong thing' && t.deletedAt), 'laptop holds the tombstone');

    await say(L, 'laptop oops');
    await until(async () => (await openTexts(L)).includes('Laptop oops'), 'captured');
    await undo(L);
    await settle(L);
    await pull(P);
    assert(!(await openTexts(P)).includes('Laptop oops'), 'laptop Saved·Undo → phone');

    await edit(L, 'Book dentist for Tuesday', '');
    await settle(L);
    assert((await serverTask('Book dentist for Tuesday')).deletedAt, 'empty edit → server tombstone');
    await pull(P);
    assert(!(await openTexts(P)).includes('Book dentist for Tuesday'), 'laptop empty edit → phone');
    await undo(L);
    await settle(L);
    await pull(P);
    assert((await openTexts(P)).includes('Book dentist for Tuesday'), 'undo → phone');
  });

  await check('Claude Code (API key) writes reach both devices; fields are preserved untouched', async () => {
    await api('PUT', '/tasks/from-claude', { text: 'Triage inbox', createdAt: Date.now(), fields: { priority: 'high', source: 'claude' } });
    await pull(P);
    await pull(L);
    assert((await openTexts(P)).includes('Triage inbox') && (await openTexts(L)).includes('Triage inbox'), 'shown on both');
    await tick(P, 'Triage inbox');
    await settle(P);
    const row = (await api('GET', '/tasks/from-claude')).body;
    eq([row.done, row.fields], [true, { priority: 'high', source: 'claude' }], 'fields kept after phone tick');
    eq((await stored(P)).find((t) => t.id === 'from-claude').fields, { priority: 'high', source: 'claude' }, 'phone keeps fields');
  });

  // ----- Offline -----
  phase = 'offline';
  await check('Offline: changes queue with "Offline · N not synced", then flush on reconnect', async () => {
    await phone.context.setOffline(true);
    await say(P, 'offline idea');
    await until(async () => (await openTexts(P)).includes('Offline idea'), 'captured offline');
    eq(await toastText(P), 'Saved ·', 'capture unaffected');
    await tick(P, 'Water plants');
    await edit(P, 'Call mum', 'Call mum back');
    await until(async () => (await syncLine(P)) === 'Offline · 3 not synced', 'offline status');
    await noHorizontalScroll(P);
    await pull(L);
    assert(!(await openTexts(L)).includes('Offline idea'), 'nothing reached the laptop yet');
    await phone.context.setOffline(false);
    await settle(P);
    await pull(L);
    assert((await openTexts(L)).includes('Offline idea'), 'capture flushed');
    assert((await doneTexts(L)).includes('Water plants'), 'tick flushed');
    assert((await openTexts(L)).includes('Call mum back'), 'edit flushed');
  });

  await check('Offline on both: edits to different fields of one task both survive', async () => {
    await phone.context.setOffline(true);
    await laptop.context.setOffline(true);
    await tick(P, 'Pick up dry cleaning');
    await edit(L, 'Pick up dry cleaning', 'Pick up dry cleaning Friday');
    await until(async () => (await syncLine(P)).startsWith('Offline'), 'phone offline status');
    await until(async () => (await syncLine(L)).startsWith('Offline'), 'laptop offline status');
    await laptop.context.setOffline(false);
    await phone.context.setOffline(false);
    await settle(L);
    await settle(P);
    await pull(L);
    await pull(P);
    for (const [name, p] of [['phone', P], ['laptop', L]]) {
      assert((await doneTexts(p)).includes('Pick up dry cleaning Friday'), `${name}: done + new text`);
      assert(!(await openTexts(p)).some((t) => t.startsWith('Pick up dry cleaning')), `${name}: not open`);
    }
    const row = await serverTask('Pick up dry cleaning Friday');
    eq(row.done, true, 'server done');
  });

  await check('Same field edited on both while offline: the last to reach the server wins everywhere', async () => {
    await phone.context.setOffline(true);
    await laptop.context.setOffline(true);
    await edit(P, 'Call mum back', 'Call mum back tonight');
    await edit(L, 'Call mum back', 'Call mum back tomorrow');
    await phone.context.setOffline(false);
    await settle(P);
    await laptop.context.setOffline(false);
    await settle(L);
    await pull(P);
    await pull(L);
    assert((await openTexts(P)).includes('Call mum back tomorrow'), 'phone shows laptop edit');
    assert((await openTexts(L)).includes('Call mum back tomorrow'), 'laptop shows its edit');
  });

  await check('A pull never clobbers unsynced local edits', async () => {
    // Another device reopens the task; the phone starts a (slow) pull and edits the same task while it's in flight.
    await api('PATCH', '/tasks/' + (await serverTask('Water plants')).id, { done: false, doneAt: null });
    apiControl.delay = 800;
    const pulls = () => apiControl.log.filter((l) => l.startsWith('GET /tasks?since=')).length;
    const pullsBefore = pulls();
    await foreground(P);
    await until(() => pulls() > pullsBefore, 'pull in flight');
    await edit(P, 'Water plants', 'Water plants and herbs');
    // The pull lands (old text, reopened) while the edit is still unsent.
    await until(async () => (await openTexts(P)).includes('Water plants and herbs'), 'pull merged with the edit on top', 3000);
    assert((await outboxLength(P)) === 1, 'edit still unsent when the pull merged');
    const local = (await stored(P)).find((t) => t.text === 'Water plants and herbs');
    eq([local.done, local.doneAt], [false, null], 'remote reopen merged');
    apiControl.delay = 0;
    await settle(P);
    const row = await serverTask('Water plants and herbs');
    eq([row && row.done], [false], 'server has both changes');
  });

  await check('Capture never waits on sync (slow server)', async () => {
    apiControl.delay = 3000;
    const t0 = Date.now();
    await say(P, 'slow network task');
    await until(async () => (await openTexts(P)).includes('Slow network task'), 'instant', 1000);
    eq(await toastText(P), 'Saved ·', 'toast shown');
    assert(Date.now() - t0 < 1000, 'shown within 1s');
    apiControl.delay = 0;
    await settle(P);
  });

  // ----- Errors -----
  phase = 'server-error';
  await check('Server error shows "Sync error (500) · N not synced", then retries with backoff and recovers', async () => {
    apiControl.fail = 500;
    await say(P, 'during outage');
    await until(async () => (await syncLine(P)) === 'Sync error (500) · 1 not synced', 'server error status');
    apiControl.fail = 0;
    await until(async () => (await outboxLength(P)) === 0 && !(await syncLine(P)), 'retried', 10000);
    assert(await serverTask('During outage'), 'reached the server');
  });

  phase = 'revoke';
  await check('Revoked key: "Sync key rejected", sync pauses, capture keeps working; restoring the key resumes', async () => {
    const { laptop: _, ...rest } = KEYS;
    env.JOT_KEYS = JSON.stringify(rest);
    await say(L, 'captured while revoked');
    await until(async () => (await openTexts(L)).includes('Captured while revoked'), 'capture works');
    await until(async () => (await syncLine(L)) === 'Sync key rejected', 'rejected status');
    const n = apiControl.log.length;
    await say(L, 'second while revoked');
    await until(async () => (await openTexts(L)).includes('Second while revoked'), 'capture 2');
    await L.waitForTimeout(500);
    eq(apiControl.log.length, n, 'no requests while paused');
    eq(await outboxLength(L), 2, 'kept in outbox');
    env.JOT_KEYS = JSON.stringify(KEYS);
    await foreground(L);
    await settle(L);
    assert(await serverTask('Second while revoked'), 'flushed after key restored');
  });

  phase = 'bad-key';
  const rogue = await device('rogue', PHONE);
  rogue.page.__name = 'rogue';
  const R = rogue.page;
  await check('Bad key: "Sync key rejected" and capture keeps working', async () => {
    await R.goto(`${JOT}/#api=${encodeURIComponent(API)}&key=${'wrong'.repeat(8)}`);
    await until(async () => (await syncLine(R)) === 'Sync key rejected', 'rejected');
    await until(() => R.evaluate(() => !!window.__sr.active), 'auto-listen still on');
    await R.evaluate(() => window.__sr.say('rogue capture'));
    await until(async () => (await openTexts(R)).includes('Rogue capture'), 'captured');
    eq(await toastText(R), 'Saved ·', 'saved toast');
    assert(!(await serverTask('Rogue capture')), 'nothing reached the server');
    await noHorizontalScroll(R);
  });

  // ----- Layout & theme -----
  phase = 'layout';
  await check('360px: no horizontal scroll (long task, toast, sync line), light and dark', async () => {
    await say(P, 'a'.repeat(120) + ' ' + 'supercalifragilisticexpialidocious'.repeat(4));
    await until(async () => (await toastText(P)) === 'Saved ·', 'toast');
    for (const scheme of ['light', 'dark']) {
      await P.emulateMedia({ colorScheme: scheme });
      await noHorizontalScroll(P);
      await noHorizontalScroll(R);
    }
    eq(P.viewportSize().width, 360, 'viewport');
  });

  await check('Light/dark themes apply', async () => {
    await P.emulateMedia({ colorScheme: 'light' });
    eq(await P.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(245, 245, 243)', 'light bg');
    await P.emulateMedia({ colorScheme: 'dark' });
    eq(await P.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(14, 14, 14)', 'dark bg');
  });

  await check('SW leaves API requests alone', async () => {
    assert(phone.apiRequests.length > 0, 'phone made API requests');
    eq(apiResponsesFromSW, [], 'API responses served by SW');
  });

  phase = 'final';
  await check('CSP: zero violations', async () => {
    for (const p of [P, L, R]) eq(await p.evaluate(() => window.__csp), [], `${p.__name} violations`);
    eq(consoleErrors.filter((e) => /Content Security Policy/i.test(e.text)), [], 'CSP console errors');
  });

  // Chrome logs every failed request to the console; those are expected only in the deliberate failure phases.
  const deliberate = { offline: /ERR_INTERNET_DISCONNECTED/, 'server-error': /status of 500/, revoke: /status of 401/, 'bad-key': /status of 401/ };
  const unexpected = consoleErrors.filter((e) => !(deliberate[e.phase] && deliberate[e.phase].test(e.text)));
  await check('Console: no errors outside the deliberate offline/500/401 phases (and those are only Chrome network logs)', async () => {
    eq(unexpected, [], 'unexpected console errors');
  });
  console.log(`\n(console: ${consoleErrors.length} network-failure logs from deliberate phases: ${[...new Set(consoleErrors.map((e) => e.phase + ': ' + e.text.replace(/https?:\S+/, '<url>')))].join(' | ') || 'none'})`);
} finally {
  await browser.close();
  site.close();
  apiServer.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log('  FAIL', f.name, '—', f.why);
process.exit(failed.length ? 1 : 0);

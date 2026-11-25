// The CSP meta tag (ADR-0013, spec §6) is the only CSP Jot gets on GitHub Pages. These checks keep it first in
// <head>, strict, and naming the same Supabase host as config.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const html = await read('../../app/index.html');
const config = await read('../../app/config.js');
const spec = await read('../../docs/spec/jot-v2.md');

const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
const policy = meta?.[1] ?? '';
const directives = Object.fromEntries(
  policy.split(';').map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([name, ...values]) => [name, values]),
);
const supabaseUrl = config.match(/SUPABASE_URL = '([^']+)'/)?.[1];

test('there is a CSP meta tag, ahead of every script, stylesheet and link', () => {
  assert.ok(meta, 'index.html has the meta tag');
  const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
  const at = head.indexOf(meta[0]);
  for (const tag of ['<script', '<link', '<style']) {
    const first = head.indexOf(tag);
    if (first !== -1) assert.ok(at < first, `the CSP comes before the first ${tag}`);
  }
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), 'no inline scripts to allow');
});

test('the policy is strict', () => {
  assert.deepEqual(directives['default-src'], ["'self'"]);
  assert.deepEqual(directives['script-src'], ["'self'"]);
  assert.deepEqual(directives['style-src'], ["'self'"]);
  assert.deepEqual(directives['object-src'], ["'none'"]);
  assert.deepEqual(directives['base-uri'], ["'none'"]);
  assert.deepEqual(directives['form-action'], ["'none'"]);
  assert.ok(!policy.includes('unsafe-'), 'nothing unsafe');
  assert.ok(!policy.includes('*'), 'no wildcards');
});

test('connect-src names exactly the Supabase host from config.js, over https and wss', () => {
  assert.match(supabaseUrl, /^https:\/\/[a-z0-9-]+\.supabase\.co$/i, 'config.js has an https Supabase URL');
  const host = new URL(supabaseUrl).host;
  assert.deepEqual(directives['connect-src'], ["'self'", `https://${host}`, `wss://${host}`]);
});

test('the meta tag matches the policy in spec §6', () => {
  const block = spec.slice(spec.indexOf('**CSP meta tag**')).match(/```\n([\s\S]*?)```/)[1];
  const specPolicy = block.replace(/\s+/g, ' ').trim();
  const host = new URL(supabaseUrl).host;
  assert.equal(policy.replaceAll(host, '<ref>.supabase.co'), specPolicy);
});

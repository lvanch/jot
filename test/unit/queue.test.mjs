import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffMs, classify, MAX_BACKOFF_MS, nextDue, nextWake, queueStatus } from '../../app/queue.js';

test('classify: parked, empty, and repeats of a parked Capture', () => {
  const item = { id: 'a', text: 'Call the bank' };
  assert.deepEqual(classify(201, { item }), { action: 'parked', item });
  assert.deepEqual(classify(200, { item }), { action: 'parked', item }, 'a retry after a lost answer');
  assert.deepEqual(classify(200, { item: null, empty: true }), { action: 'empty' });
});

test('classify: the Recording itself is refused → failed, for good', () => {
  for (const [status, error] of [[400, 'bad_request'], [413, 'too_large'], [422, 'transcriber_refused']]) {
    assert.deepEqual(classify(status, { error }), { action: 'failed', error });
  }
  assert.deepEqual(classify(422, null), { action: 'failed', error: 'http_422' });
});

test('classify: sign in again on 401', () => {
  assert.deepEqual(classify(401, { error: 'unauthorized' }), { action: 'signin' });
});

test('classify: the daily cap waits until Perth midnight', () => {
  const retry_at = '2026-11-25T16:00:00.000Z';
  assert.deepEqual(classify(429, { error: 'daily_cap', retry_at }), { action: 'wait', retryAt: Date.parse(retry_at) });
  assert.equal(classify(429, { error: 'daily_cap', retry_at: 'soon' }).action, 'retry', 'an unreadable time just retries');
  assert.equal(classify(429, null).action, 'retry', 'a bare rate limit retries');
});

test('classify: anything else is worth retrying', () => {
  assert.deepEqual(classify(0, null), { action: 'retry', error: 'no_answer' });
  for (const [status, error] of [[502, 'transcriber_unavailable'], [503, 'inbox_unavailable'], [500, 'internal']]) {
    assert.deepEqual(classify(status, { error }), { action: 'retry', error });
  }
  assert.deepEqual(classify(404, null), { action: 'retry', error: 'http_404' }, 'e.g. mid-deploy');
  assert.deepEqual(classify(540, null), { action: 'retry', error: 'http_540' });
});

test('backoff doubles from 2 s to a 5 min cap, with ±25 % jitter', () => {
  const mid = () => 0.5;
  assert.deepEqual([1, 2, 3, 4].map((n) => backoffMs(n, mid)), [2000, 4000, 8000, 16000]);
  assert.equal(backoffMs(20, mid), MAX_BACKOFF_MS);
  assert.equal(backoffMs(1, () => 0), 1500);
  assert.equal(backoffMs(1, () => 1), 2500);
  assert.equal(backoffMs(30, () => 1), MAX_BACKOFF_MS * 1.25);
});

test('nextDue: oldest queued Capture that is due, never failed or in-flight ones', () => {
  const records = [
    { id: 'c', state: 'queued', capturedAt: 3, nextAttemptAt: 0 },
    { id: 'a', state: 'failed', capturedAt: 1 },
    { id: 'b', state: 'queued', capturedAt: 2, nextAttemptAt: 500 },
    { id: 'd', state: 'uploading', capturedAt: 0 },
  ];
  assert.equal(nextDue(records, 100)?.id, 'c', 'b is backing off');
  assert.equal(nextDue(records, 600)?.id, 'b', 'once due, the older one goes first');
  assert.equal(nextDue(records, 600, 1000), null, 'a queue-wide hold blocks everything');
  assert.equal(nextDue([], 0), null);
});

test('nextWake: the soonest moment a queued Capture becomes due', () => {
  const records = [
    { state: 'queued', capturedAt: 1, nextAttemptAt: 5000 },
    { state: 'queued', capturedAt: 2, nextAttemptAt: 3000 },
    { state: 'failed', capturedAt: 0, nextAttemptAt: 10 },
  ];
  assert.equal(nextWake(records, 1000), 3000);
  assert.equal(nextWake(records, 4000), 4000, 'already due means now');
  assert.equal(nextWake(records, 1000, 8000), 8000, 'the hold applies');
  assert.equal(nextWake([{ state: 'failed', capturedAt: 0 }], 0), null);
});

test('queueStatus: what the status line says, most urgent first', () => {
  const base = { queued: 2, uploading: false, online: true, asleep: false, cappedUntil: null, signedIn: true };
  const now = 1000;
  assert.equal(queueStatus({ ...base, uploading: true }, now), 'Transcribing…');
  assert.equal(queueStatus({ ...base, queued: 0 }, now), null);
  assert.equal(queueStatus({ ...base, online: false, asleep: true }, now), 'Offline · 2 queued');
  assert.equal(queueStatus({ ...base, signedIn: false }, now), 'Sign in to send · 2 queued');
  assert.equal(queueStatus({ ...base, cappedUntil: 5000 }, now), 'Daily limit reached · 2 queued');
  assert.equal(queueStatus({ ...base, cappedUntil: 500 }, now), 'Waiting to send · 2 queued', 'the cap has passed');
  assert.equal(queueStatus({ ...base, asleep: true }, now), 'Inbox asleep · 2 queued');
  assert.equal(queueStatus(base, now), 'Waiting to send · 2 queued');
});

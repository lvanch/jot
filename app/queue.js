// The pure rules of the Capture queue (spec §6 "Queue and upload", ADRs 0003 and 0008): what each answer from
// `transcribe` means, how long to back off, what to send next, and what the status line says.
// No browser APIs here, so it's unit-tested (test/unit/queue.test.mjs).

export const BASE_BACKOFF_MS = 2000;
export const MAX_BACKOFF_MS = 5 * 60_000;

/**
 * @typedef {{ action: 'parked', item: object }
 *   | { action: 'empty' }
 *   | { action: 'failed', error: string }
 *   | { action: 'signin' }
 *   | { action: 'wait', retryAt: number }
 *   | { action: 'retry', error: string }} Outcome
 * @param {number} status HTTP status, or 0 when the request never got an answer
 * @param {any} body the parsed JSON body, or null
 * @returns {Outcome}
 */
export function classify(status, body) {
  if (status === 201 || (status === 200 && body?.item)) return { action: 'parked', item: body.item };
  if (status === 200 && body?.empty) return { action: 'empty' };
  if (status === 401) return { action: 'signin' };
  if (status === 429 && body?.error === 'daily_cap') {
    const retryAt = Date.parse(body.retry_at);
    if (Number.isFinite(retryAt)) return { action: 'wait', retryAt };
  }
  // Only these mean the Recording itself will never work. Anything else (no answer, 5xx, 404 while a function
  // is being deployed, a bare 429) is worth trying again later.
  if (status === 400 || status === 413 || status === 422) return { action: 'failed', error: body?.error ?? `http_${status}` };
  return { action: 'retry', error: status === 0 ? 'no_answer' : (body?.error ?? `http_${status}`) };
}

/**
 * Delay before the next try after `attempts` failures in a row: 2 s, 4 s, 8 s… up to 5 min, ±25 % jitter.
 * @param {number} attempts at least 1
 * @param {() => number} random 0…1
 */
export function backoffMs(attempts, random = Math.random) {
  const base = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));
  return Math.round(base * (0.75 + random() / 2));
}

/**
 * The Capture to send next: the oldest queued one that's due. Captures go in the order they were made.
 * @param {Array<{ state: string, capturedAt: number, nextAttemptAt?: number }>} records
 * @param {number} now
 * @param {number} holdUntil nothing is due before this (a backoff that applies to the whole queue)
 */
export function nextDue(records, now, holdUntil = 0) {
  if (now < holdUntil) return null;
  let best = null;
  for (const r of records) {
    if (r.state !== 'queued' || (r.nextAttemptAt ?? 0) > now) continue;
    if (!best || r.capturedAt < best.capturedAt) best = r;
  }
  return best;
}

/** When the queue next needs a look, or null if nothing is waiting. */
export function nextWake(records, now, holdUntil = 0) {
  let at = null;
  for (const r of records) {
    if (r.state !== 'queued') continue;
    const t = Math.max(r.nextAttemptAt ?? 0, holdUntil);
    if (at === null || t < at) at = t;
  }
  return at === null ? null : Math.max(at, now);
}

/**
 * What the status line says about the queue, or null when there's nothing to say.
 * @param {{ queued: number, uploading: boolean, online: boolean, asleep: boolean, cappedUntil: number | null,
 *   signedIn: boolean }} q
 * @param {number} now
 */
export function queueStatus(q, now) {
  if (q.uploading) return 'Transcribing…';
  if (!q.queued) return null;
  const n = `${q.queued} queued`;
  if (!q.online) return `Offline · ${n}`;
  if (!q.signedIn) return `Sign in to send · ${n}`;
  if (q.cappedUntil && q.cappedUntil > now) return `Daily limit reached · ${n}`;
  if (q.asleep) return `Inbox asleep · ${n}`;
  return `Waiting to send · ${n}`;
}

// Sends queued Captures to `transcribe`, one at a time and oldest first, and acts on each answer (spec §6 "Queue
// and upload", ADR-0003). The rules live in queue.js; this file does the I/O.

import { backoffMs, classify, nextDue, nextWake, queueStatus } from './queue.js';
import { allCaptures, deleteCapture, getCapture, putCapture } from './store.js';

const UPLOAD_TIMEOUT_MS = 45_000; // the Transcriber may take 30 s
const HEALTH_TIMEOUT_MS = 10_000;
const EXT = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a' };

/**
 * @param {{
 *   inbox: import('@supabase/supabase-js').SupabaseClient | null,
 *   functionsUrl: string,
 *   publishableKey: string,
 *   onParked?: (item: object) => void,
 *   onEmpty?: () => void,
 *   onFailed?: (error: string) => void,
 *   onStatus?: (text: string | null) => void,
 * }} options
 */
export function createUploader({ inbox, functionsUrl, publishableKey, onParked, onEmpty, onFailed, onStatus }) {
  let running = false;
  let again = false;
  let timer = 0;
  let holdUntil = 0; // after a failed try, nothing goes until this
  const state = { uploading: false, asleep: false, cappedUntil: null, signedIn: false };

  async function report(records) {
    records ??= await allCaptures();
    const queued = records.filter((r) => r.state !== 'failed').length;
    onStatus?.(queueStatus({ ...state, queued, online: navigator.onLine }, Date.now()));
  }

  function schedule(records) {
    clearTimeout(timer);
    const at = nextWake(records, Date.now(), holdUntil);
    if (at !== null) timer = setTimeout(() => kick(), Math.max(0, at - Date.now()) + 50);
  }

  async function send(record, token) {
    const form = new FormData();
    form.append('id', record.id);
    form.append('captured_at', new Date(record.capturedAt).toISOString());
    form.append('duration_ms', String(record.durationMs));
    form.append('device', record.device);
    const ext = EXT[record.mimeType.split(';')[0]] ?? 'bin';
    form.append('audio', record.blob, `recording.${ext}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    try {
      const res = await fetch(`${functionsUrl}/transcribe`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, apikey: publishableKey },
        body: form,
        signal: controller.signal,
      });
      let body = null;
      try {
        body = await res.json();
      } catch {
        // not JSON: classify by status alone
      }
      return { status: res.status, body };
    } catch {
      return { status: 0, body: null };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Is the Supabase project answering at all? Tells "the Inbox is asleep" apart from "the Transcriber is down". */
  async function healthy() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const res = await fetch(`${functionsUrl}/health`, { signal: controller.signal, cache: 'no-store' });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function step() {
    for (;;) {
      const records = await allCaptures();
      const record = nextDue(records, Date.now(), holdUntil);
      if (!record || !navigator.onLine || !inbox) {
        schedule(records);
        return report(records);
      }
      const { data } = await inbox.auth.getSession(); // refreshes an expired token
      const token = data.session?.access_token;
      state.signedIn = !!token;
      if (!token) return report(records); // signing in kicks the queue again

      record.state = 'uploading';
      await putCapture(record);
      state.uploading = true;
      await report(records);
      const { status, body } = await send(record, token);
      state.uploading = false;
      const outcome = classify(status, body);

      // The record may have been thrown away meanwhile (another tab, the strip): then just drop the answer.
      const current = await getCapture(record.id);
      if (!current) continue;

      switch (outcome.action) {
        case 'parked':
          await deleteCapture(record.id);
          Object.assign(state, { asleep: false, cappedUntil: null });
          onParked?.(outcome.item);
          break;
        case 'empty':
          await deleteCapture(record.id);
          state.asleep = false;
          onEmpty?.();
          break;
        case 'failed':
          await putCapture({ ...current, state: 'failed', lastError: outcome.error });
          onFailed?.(outcome.error);
          break;
        case 'signin':
          await putCapture({ ...current, state: 'queued' });
          state.signedIn = false;
          await inbox.auth.signOut({ scope: 'local' }); // shows the sign-in card; signing in sends the queue
          return report();
        case 'wait':
          // The cap is for the whole day, so everything waits until it resets.
          await putCapture({ ...current, state: 'queued' });
          state.cappedUntil = outcome.retryAt;
          holdUntil = outcome.retryAt;
          schedule(await allCaptures());
          return report();
        case 'retry': {
          const attempts = (current.attempts ?? 0) + 1;
          const delay = backoffMs(attempts);
          await putCapture({ ...current, state: 'queued', attempts, lastError: outcome.error, nextAttemptAt: Date.now() + delay });
          holdUntil = Date.now() + delay; // don't hammer a struggling server with the rest of the queue
          state.asleep = (status === 0 || status >= 500) && !(await healthy());
          schedule(await allCaptures());
          return report();
        }
      }
    }
  }

  const exclusive = (fn) => (navigator.locks ? navigator.locks.request('jot-upload', fn) : fn());

  /**
   * Sends whatever is due now.
   * @param {boolean} [now] also skip any backoff: for a new Capture, coming online, foregrounding, or signing in
   */
  async function kick(now = false) {
    if (now && !(state.cappedUntil > Date.now())) {
      holdUntil = 0;
      state.asleep = false;
      for (const r of await allCaptures()) {
        if (r.state === 'queued' && r.nextAttemptAt > Date.now()) {
          await putCapture({ ...r, nextAttemptAt: 0 });
        }
      }
    }
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        await exclusive(step);
      } while (again);
    } catch (err) {
      console.error('jot: queue', err?.name ?? 'error');
    } finally {
      running = false;
    }
  }

  /** Queues a new Capture and sends it straight away. */
  async function add(capture) {
    await putCapture({ ...capture, state: 'queued', attempts: 0, lastError: null, nextAttemptAt: 0 });
    return kick(true);
  }

  /** After a crash or reload mid-upload, put in-flight Captures back in the queue, then send. */
  async function resume() {
    for (const r of await allCaptures()) {
      if (r.state === 'uploading') await putCapture({ ...r, state: 'queued' });
    }
    return kick(true);
  }

  function setSignedIn(on) {
    state.signedIn = on;
    if (on) kick(true);
    else report();
  }

  return { add, kick, resume, setSignedIn };
}

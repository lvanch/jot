// The recent-Captures strip's data, kept pure so it's unit-tested (test/unit/recent.test.mjs). Spec §6
// "Recent-Captures strip": up to 10 Captures from this device in the last 24 h, newest first. Queued and failed
// ones come from the queue (IndexedDB); parked Items from a small cache in localStorage.

export const RECENT_KEY = 'jot.recent.v2';
export const MAX_ROWS = 10;
export const WINDOW_MS = 24 * 3600_000;

/**
 * @typedef {{ id: string, text: string, status: 'inbox' | 'discarded' | 'processed', at: number }} CachedItem
 * @typedef {{ id: string, state: 'queued' | 'uploading' | 'failed', capturedAt: number, lastError?: string | null }}
 *   QueuedCapture
 * @typedef {{ id: string, kind: 'item' | 'capture', status: string, text: string, at: number }} Row
 */

/** Keeps only what the strip can show: recent, at most MAX_ROWS, newest first. */
export function prune(cache, now) {
  return [...cache]
    .filter((c) => c && typeof c.id === 'string' && now - c.at < WINDOW_MS)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_ROWS);
}

/** Adds (or refreshes) a just-parked Item from the server's row. */
export function addParked(cache, item, now) {
  const at = Date.parse(item.captured_at) || now;
  const entry = { id: item.id, text: item.text, status: item.status ?? 'inbox', at };
  return prune([entry, ...cache.filter((c) => c.id !== item.id)], now);
}

/** Applies fresh `{id, text, status}` rows from the server to the cache. */
export function applyServer(cache, rows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return cache.map((c) => {
    const r = byId.get(c.id);
    return r ? { ...c, text: r.text, status: r.status } : c;
  });
}

/** Sets one cached Item's fields, e.g. after an edit or a discard. */
export function updateCached(cache, id, fields) {
  return cache.map((c) => (c.id === id ? { ...c, ...fields } : c));
}

/**
 * The strip's rows: queued and failed Captures plus cached Items, newest first, at most MAX_ROWS from the last 24 h.
 * A Capture that's already in the cache (parked moments ago, record not yet gone) shows once, as the Item.
 * @param {QueuedCapture[]} records
 * @param {CachedItem[]} cache
 * @returns {Row[]}
 */
export function rows(records, cache, now) {
  const cached = new Set(cache.map((c) => c.id));
  const out = [
    ...records
      .filter((r) => !cached.has(r.id))
      .map((r) => ({ id: r.id, kind: 'capture', status: r.state, text: '', at: r.capturedAt })),
    ...cache.map((c) => ({ id: c.id, kind: 'item', status: c.status, text: c.text, at: c.at })),
  ];
  return out
    .filter((r) => now - r.at < WINDOW_MS)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_ROWS);
}

/** Reads the cache, surviving garbage and blocked storage. */
export function readCache(storage) {
  try {
    const v = JSON.parse(storage.getItem(RECENT_KEY));
    return Array.isArray(v) ? v.filter((c) => c && typeof c.id === 'string' && typeof c.text === 'string') : [];
  } catch {
    return [];
  }
}

export function writeCache(storage, cache) {
  try {
    storage.setItem(RECENT_KEY, JSON.stringify(cache));
  } catch {
    // private mode or full: the strip just forgets
  }
}

/** A sentence for an RPC error from the lifecycle functions (spec §4). */
export function actionErrorMessage(error, online = true) {
  const msg = String(error?.message ?? '');
  if (!online || /Failed to fetch|NetworkError|fetch failed/i.test(msg)) return 'Needs a connection';
  if (msg === 'wrong_state') return 'Already processed';
  if (msg === 'invalid_text') return 'Text can’t be empty';
  if (msg === 'not_found') return 'That one’s gone from the Inbox';
  if (msg === 'not_allowed' || error?.code === 'PGRST301' || error?.status === 401) return 'Sign in first';
  return 'Couldn’t do that. Try again.';
}

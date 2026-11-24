// The one-time import of the v1 list into the Inbox (spec §7, ADR-0004). No browser globals: storage and the
// Inbox client are passed in, so all of it is unit-tested (test/unit/v1import.test.mjs).
//
// v1 kept its list in localStorage `jot.tasks.v1` as [{ id, text, createdAt, done, doneAt, deletedAt? }], with
// times in ms. Deleted tasks stayed as tombstones (deletedAt set) for its sync.

export const TASKS_KEY = 'jot.tasks.v1';
export const V1_KEYS = [TASKS_KEY, 'jot.sync.v1', 'jot.outbox.v1'];
export const IMPORT_KEY = 'jot.import.v1';
export const CLEANUP_AFTER_MS = 30 * 86_400_000;
export const MAX_ROWS = 5000; // per import_v1_items call
const MAX_TEXT = 2000;
const MAX_MS = 253402300799999; // 9999-12-31, the server's limit
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Whitespace collapsed, at most 2000 characters: v1's own clean-up. */
export function cleanText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT).trimEnd();
}

const ms = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_MS ? Math.round(v) : null);

// FNV-1a, 32-bit. Two seeds give 64 bits: plenty for one person's list.
function fnv(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * A replacement id for a task whose id the Inbox can't take. It's derived from the task, not random, so an
 * import that's retried (say the answer was lost after the server saved it) skips it instead of duplicating it.
 */
export function stableId(task) {
  const key = JSON.stringify([String(task.id ?? ''), task.createdAt ?? null, String(task.text ?? '')]);
  return `v1-${fnv(key, 0x811c9dc5)}${fnv(key, 0x01000193)}`;
}

/**
 * v1 tasks → rows for `import_v1_items`. Deleted tasks and tasks with no text are left out.
 * @param {unknown[]} tasks
 * @param {number} now used only when a task has no usable creation time
 */
export function mapTasks(tasks, now) {
  const rows = [];
  for (const t of tasks) {
    if (!t || typeof t !== 'object' || typeof t.text !== 'string' || t.deletedAt) continue;
    const text = cleanText(t.text);
    if (!text) continue;
    const id = typeof t.id === 'string' && ID.test(t.id) ? t.id : stableId(t);
    const created_at = ms(t.createdAt) ?? ms(t.doneAt) ?? now;
    rows.push(
      t.done
        ? { id, text, created_at, status: 'processed', status_at: ms(t.doneAt) }
        : { id, text, created_at, status: 'inbox' },
    );
  }
  return rows;
}

const read = (storage, key) => {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
};

/** v1's tasks, or null when there's no v1 list here at all. Garbage reads as an empty list. */
export function readTasks(storage) {
  const raw = read(storage, TASKS_KEY);
  if (raw === null) return null;
  try {
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/** When the import finished (ms), or null if it hasn't. */
export function importedAt(storage) {
  const raw = read(storage, IMPORT_KEY);
  const v = Number(raw);
  return raw !== null && raw.trim() !== '' && Number.isFinite(v) ? v : null;
}

export const importMessage = (n) => `Imported ${n} ${n === 1 ? 'item' : 'items'} from Jot v1`;

/**
 * Imports the v1 list once. Safe to call on every sign-in and foreground: it does nothing once done, or when
 * there's no v1 list. On failure the flag stays unset, so the next call tries again; the server skips ids it
 * already has, so a retry never duplicates.
 * @param {{ inbox: { rpc: (fn: string, args: object) => Promise<{ data: any, error: any }> }, storage: Storage,
 *   now: number }} deps
 * @returns {Promise<{ result: 'none' | 'done' | 'imported' | 'failed', count?: number, error?: unknown }>} `count`
 *   is how many Items the Inbox didn't have yet
 */
export async function importV1({ inbox, storage, now }) {
  if (importedAt(storage) !== null) return { result: 'done' };
  const tasks = readTasks(storage);
  if (tasks === null) return { result: 'none' };
  const rows = mapTasks(tasks, now);
  let inserted = 0;
  for (let i = 0; i < rows.length; i += MAX_ROWS) {
    const { data, error } = await inbox.rpc('import_v1_items', { rows: rows.slice(i, i + MAX_ROWS) });
    if (error) return { result: 'failed', error };
    inserted += Number(data?.inserted) || 0;
  }
  try {
    storage.setItem(IMPORT_KEY, String(now));
  } catch {
    // Can't remember it: the next call imports again, and the server skips every row.
  }
  return { result: 'imported', count: inserted }; // new Items: ones the Inbox already had are skipped
}

/** 30 days after the import, v1's own storage goes. Until then it's there for a rollback (spec §9). */
export function cleanUpV1(storage, now) {
  const at = importedAt(storage);
  if (at === null || now - at < CLEANUP_AFTER_MS) return false;
  let removed = false;
  for (const key of V1_KEYS) {
    if (read(storage, key) === null) continue;
    try {
      storage.removeItem(key);
      removed = true;
    } catch {
      // blocked storage: try again next time
    }
  }
  return removed;
}

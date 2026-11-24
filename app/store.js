// Queued and Failed Captures, Recording and all, in IndexedDB (spec §6 "Queue and upload"). A record leaves only
// when the server has confirmed it, so a Recording survives reloads, crashes and days offline.

const DB_NAME = 'jot';
const STORE = 'captures';
const VERSION = 1;

let opening = null;

function open() {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      opening = null;
      reject(req.error);
    };
  });
  return opening;
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * @typedef {{ id: string, blob: Blob, mimeType: string, capturedAt: number, durationMs: number, device: string,
 *   state: 'queued' | 'uploading' | 'failed', attempts: number, lastError: string | null, nextAttemptAt: number }}
 *   QueuedCapture
 */

/** @param {QueuedCapture} record */
export const putCapture = (record) => run('readwrite', (s) => s.put(record));
/** @returns {Promise<QueuedCapture | undefined>} */
export const getCapture = (id) => run('readonly', (s) => s.get(id));
export const deleteCapture = (id) => run('readwrite', (s) => s.delete(id));
/** @returns {Promise<QueuedCapture[]>} */
export const allCaptures = () => run('readonly', (s) => s.getAll());

import { cacheKey } from './translateCore';

const LS_KEY = 'tr_v3';
const IDB_NAME = 'translator_cache';
const IDB_STORE = 'translations';
const MAX_ENTRIES = 1200;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  if (!globalThis.indexedDB) {
    dbPromise = Promise.resolve(null);
    return dbPromise;
  }
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

const mem = new Map((() => {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; }
})());

function persistLs() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify([...mem.entries()].slice(-900)));
  } catch {}
}

export async function cacheGet(text, from, to) {
  const key = cacheKey(text, from, to);
  if (mem.has(key)) return mem.get(key);

  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => {
        const val = req.result;
        if (val) mem.set(key, val);
        resolve(val || null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function cacheSet(text, from, to, value) {
  const key = cacheKey(text, from, to);
  mem.set(key, value);
  if (mem.size > MAX_ENTRIES) {
    const drop = mem.size - MAX_ENTRIES;
    for (const k of [...mem.keys()].slice(0, drop)) mem.delete(k);
  }
  persistLs();

  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
  } catch {}
}

export function cacheClearMemory() {
  mem.clear();
  try { localStorage.removeItem(LS_KEY); } catch {}
}

// Biblioteca persistente en IndexedDB. Compartida con el service worker (share target).
const DB_NAME = 'lector-md';
const DB_VERSION = 1;
let dbPromise;

export function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('docs')) {
          const s = db.createObjectStore('docs', { keyPath: 'id' });
          s.createIndex('openedAt', 'openedAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction('docs', mode);
    const store = t.objectStore('docs');
    let result;
    Promise.resolve(fn(store)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const wrap = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export const getAll = () => tx('readonly', s => wrap(s.getAll()));
export const getDoc = id => tx('readonly', s => wrap(s.get(id)));
export const putDoc = doc => tx('readwrite', s => wrap(s.put(doc)));
export const deleteDoc = id => tx('readwrite', s => wrap(s.delete(id)));
export const clearDocs = () => tx('readwrite', s => wrap(s.clear()));

export function newId() {
  return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
}

// Clave estable por origen para no duplicar al reimportar.
export function sourceKey(doc) {
  if (doc.source === 'github') return `gh:${doc.meta.repo}@${doc.meta.branch}:${doc.meta.path}`;
  if (doc.source === 'drive') return `drive:${doc.meta.fileId}`;
  if (doc.source === 'local' && doc.meta?.relPath) return `local:${doc.meta.relPath}`;
  return null;
}

// Inserta o actualiza conservando posición de lectura e id si ya existía.
export async function upsertBySource(doc) {
  const key = sourceKey(doc);
  const now = Date.now();
  if (key) {
    const all = await getAll();
    const existing = all.find(d => d.key === key);
    if (existing) {
      const merged = { ...existing, ...doc, id: existing.id, key, pos: existing.pos, createdAt: existing.createdAt, updatedAt: now, dirty: false };
      await putDoc(merged);
      return merged;
    }
  }
  const fresh = { id: newId(), key, createdAt: now, updatedAt: now, openedAt: 0, pos: 0, dirty: false, ...doc };
  await putDoc(fresh);
  return fresh;
}

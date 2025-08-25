import { dlog, derr } from '../types/debug';
const DB_NAME = 'yt-recommender';
const DB_VERSION = 2;

export async function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      dlog('IDB upgrade', db.name, '→ version', db.version);
      if (!db.objectStoreNames.contains('videos')) {
        const os = db.createObjectStore('videos', { keyPath: 'id' });
        os.createIndex('byChannel', 'channelId', { unique: false });
        os.createIndex('byTag', 'tags', { unique: false, multiEntry: true });
        os.createIndex('byLastSeen', 'lastSeenAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('trash')) {
        const t = db.createObjectStore('trash', { keyPath: 'id' });
        t.createIndex('byDeletedAt', 'deletedAt', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function upsertVideo(obj: any) {
  const db = await openDB();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction('videos', 'readwrite');
    const os = tx.objectStore('videos');
    const g = os.get(obj.id);
    g.onsuccess = () => {
      const prev = g.result || {};
      const merged = merge(prev, obj);
      os.put(merged);
    };
    g.onerror = () => rej(g.error);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

function merge(prev: any, incoming: any) {
  const out = { ...prev, ...incoming };
  out.tags = prev.tags || [];
  out.flags = { ...(prev.flags || {}), ...(incoming.flags || {}) };
  out.progress = { ...(prev.progress || {}), ...(incoming.progress || {}) };
  out.sources = mergeSources(prev.sources || [], incoming.sources || []);
  out.lastSeenAt = Date.now();
  return out;
}

function mergeSources(a: any[], b: any[]) {
  const seen = new Set(a.map(k));
  for (const s of b) if (!seen.has(k(s))) a.push(s);
  return a;
  function k(s: any) { return `${s.type}:${s.id ?? ''}:${s.index ?? ''}`; }
}
export async function moveToTrash(ids: string[]) {
  dlog('moveToTrash start', ids.length);
  if (!ids?.length) return;
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['videos', 'trash'], 'readwrite');
    const vs = tx.objectStore('videos');
    const ts = tx.objectStore('trash');

    (async () => {
      for (const id of ids) {
        await new Promise<void>((res, rej) => {
          const g = vs.get(id);
          g.onsuccess = () => {
            const row = g.result;
            if (row) {
              ts.put({ ...row, deletedAt: Date.now() });
              vs.delete(id);
            }
            res();
          };
          g.onerror = () => rej(g.error);
        });
      }
    })().then(() => tx.commit?.());

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function restoreFromTrash(ids: string[]) {
  dlog('restoreFromTrash start', ids.length);
  if (!ids?.length) return;
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['videos', 'trash'], 'readwrite');
    const vs = tx.objectStore('videos');
    const ts = tx.objectStore('trash');

    (async () => {
      for (const id of ids) {
        await new Promise<void>((res, rej) => {
          const g = ts.get(id);
          g.onsuccess = () => {
            const row = g.result;
            if (row) {
              const { deletedAt, ...rest } = row;
              vs.put(rest);
              ts.delete(id);
            }
            res();
          };
          g.onerror = () => rej(g.error);
        });
      }
    })().then(() => tx.commit?.());

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
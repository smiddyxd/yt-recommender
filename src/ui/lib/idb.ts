const DB_NAME = 'yt-recommender';

export function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAll<T=any>(store: 'videos' | 'trash'): Promise<T[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const os = tx.objectStore(store);
    const req = os.getAll();
    req.onsuccess = () => resolve((req.result || []) as T[]);
    req.onerror = () => reject(req.error);
  });
}

export async function getOne<T=any>(store: 'videos' | 'trash' | 'channels', id: string): Promise<T | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const os = tx.objectStore(store);
    const req = os.get(id);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function getVideosByChannel<T=any>(channelId: string): Promise<T[]> {
  if (!channelId) return [] as T[];
  const db = await openDB();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction('videos', 'readonly');
      const os = tx.objectStore('videos');
      const idx = os.index('byChannel');
      const req = (idx as any).getAll ? (idx as any).getAll(channelId) : null;
      if (req) {
        req.onsuccess = () => resolve((req.result || []) as T[]);
        req.onerror = () => reject(req.error);
      } else {
        // Fallback if getAll unavailable: iterate cursor
        const out: T[] = [];
        const cur = idx.openCursor(IDBKeyRange.only(channelId));
        cur.onsuccess = () => {
          const c = cur.result as IDBCursorWithValue | null;
          if (!c) { resolve(out); return; }
          out.push(c.value as T);
          c.continue();
        };
        cur.onerror = () => reject(cur.error);
      }
    } catch (e) {
      resolve([] as T[]);
    }
  });
}

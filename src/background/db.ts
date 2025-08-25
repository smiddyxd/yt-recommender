import { dlog, derr } from '../types/debug';
const DB_NAME = 'yt-recommender';
const DB_VERSION = 3;

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
      if (!db.objectStoreNames.contains('tags')) {
        const t = db.createObjectStore('tags', { keyPath: 'name' });
        t.createIndex('byCreatedAt', 'createdAt', { unique: false });
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

export async function applyTags(ids: string[], addIds: string[] = [], removeIds: string[] = []) {
  if (!ids?.length || (!addIds?.length && !removeIds?.length)) return;
  const add = [...new Set(addIds.map(s => (s ?? '').trim()).filter(Boolean))];
  const rem = new Set(removeIds.map(s => (s ?? '').trim()).filter(Boolean));
  if (add.length === 0 && rem.size === 0) return;

  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['videos', 'trash'], 'readwrite');
    const vs = tx.objectStore('videos');
    const ts = tx.objectStore('trash');

    (async () => {
      for (const id of ids) {
        // Try in 'videos' first
        await new Promise<void>((res, rej) => {
          const g = vs.get(id);
          g.onsuccess = () => {
            const row = g.result;
            if (row) {
              const tags: string[] = Array.isArray(row.tags) ? row.tags.slice() : [];
              for (const t of add) if (!tags.includes(t)) tags.push(t);
              if (rem.size) {
                for (let i = tags.length - 1; i >= 0; i--) {
                  if (rem.has(tags[i])) tags.splice(i, 1);
                }
              }
              row.tags = tags;
              vs.put(row);
              return res();
            }
            // Not in 'videos' → try 'trash'
            const g2 = ts.get(id);
            g2.onsuccess = () => {
              const trow = g2.result;
              if (trow) {
                const tags: string[] = Array.isArray(trow.tags) ? trow.tags.slice() : [];
                for (const t of add) if (!tags.includes(t)) tags.push(t);
                if (rem.size) {
                  for (let i = tags.length - 1; i >= 0; i--) {
                    if (rem.has(tags[i])) tags.splice(i, 1);
                  }
                }
                trow.tags = tags;
                ts.put(trow);
              }
              res();
            };
            g2.onerror = () => rej(g2.error);
          };
          g.onerror = () => rej(g.error);
        });
      }
    })().then(() => tx.commit?.());

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function listTags(): Promise<Array<{name:string;color?:string;createdAt?:number}>> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tags', 'readonly');
    const os = tx.objectStore('tags');
    const req = os.getAll();
    req.onsuccess = () => {
      const rows = (req.result || []) as any[];
      rows.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      resolve(rows);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function createTag(name: string, color?: string) {
  const tag = (name ?? '').trim();
  if (!tag) return;
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('tags', 'readwrite');
    const os = tx.objectStore('tags');
    const g = os.get(tag);
    g.onsuccess = () => {
      if (!g.result) {
        os.put({ name: tag, color, createdAt: Date.now() });
      }
    };
    g.onerror = () => reject(g.error);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

export async function renameTag(oldName: string, newName: string) {
  const from = (oldName ?? '').trim();
  const to   = (newName ?? '').trim();
  if (!from || !to || from === to) return;

  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['tags', 'videos', 'trash'], 'readwrite');
    const ts = tx.objectStore('tags');
    const vs = tx.objectStore('videos');
    const rs = tx.objectStore('trash');

    // move tag record (delete old, put new)
    const g = ts.get(from);
    g.onsuccess = () => {
      const rec = g.result;
      if (rec) {
        const { name: _omit, ...rest } = rec;
        ts.delete(from);
        ts.put({ name: to, ...rest });
      }
    };
    g.onerror = () => reject(g.error);

    // replace in videos
    const cur1 = vs.openCursor();
    cur1.onsuccess = () => {
      const c = cur1.result;
      if (!c) return;
      const row = c.value;
      if (Array.isArray(row.tags) && row.tags.includes(from)) {
        row.tags = row.tags.map((t: string) => (t === from ? to : t));
        c.update(row);
      }
      c.continue();
    };
    cur1.onerror = () => reject(cur1.error);

    // replace in trash
    const cur2 = rs.openCursor();
    cur2.onsuccess = () => {
      const c = cur2.result;
      if (!c) return;
      const row = c.value;
      if (Array.isArray(row.tags) && row.tags.includes(from)) {
        row.tags = row.tags.map((t: string) => (t === from ? to : t));
        c.update(row);
      }
      c.continue();
    };
    cur2.onerror = () => reject(cur2.error);

    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

export async function deleteTag(name: string, cascade: boolean = true) {
  const tag = (name ?? '').trim();
  if (!tag) return;
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const stores = cascade ? ['tags', 'videos', 'trash'] : ['tags'];
    const tx = db.transaction(stores as any, 'readwrite');
    const ts = tx.objectStore('tags');
    ts.delete(tag);

    if (cascade) {
      const clean = (os: IDBObjectStore) => {
        const cur = os.openCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c) return;
          const row = c.value;
          if (Array.isArray(row.tags)) {
            const before = row.tags.length;
            row.tags = row.tags.filter((t: string) => t !== tag);
            if (row.tags.length !== before) c.update(row);
          }
          c.continue();
        };
        cur.onerror = () => reject(cur.error);
      };
      clean((tx as any).objectStore('videos'));
      clean((tx as any).objectStore('trash'));
    }

    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}
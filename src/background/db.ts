import { dlog, derr } from '../types/debug';
import type { Condition, Group } from '../shared/conditions';
const DB_NAME = 'yt-recommender';
const DB_VERSION = 15;

export async function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      dlog('IDB upgrade', db.name, 'version', db.version);
      if (!db.objectStoreNames.contains('videos')) {
        const os = db.createObjectStore('videos', { keyPath: 'id' });
        os.createIndex('byChannel', 'channelId', { unique: false });
        os.createIndex('byTag', 'tags', { unique: false, multiEntry: true });
        try { os.createIndex('byUploadedAt', ['uploadedAt','id'], { unique: false }); } catch {}
      } else {
        try {
          const tx = (req as any).transaction as IDBTransaction;
          const os = tx.objectStore('videos');
          const names: string[] = Array.from((os as any).indexNames || []);
          if (names.includes('byLastSeen')) os.deleteIndex('byLastSeen');
          if (!names.includes('byUploadedAt')) {
            try { os.createIndex('byUploadedAt', ['uploadedAt','id'], { unique: false }); } catch {}
          }
        } catch { /* ignore */ }
      }
      if (!db.objectStoreNames.contains('trash')) {
        const t = db.createObjectStore('trash', { keyPath: 'id' });
        t.createIndex('byDeletedAt', 'deletedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('tags')) {
        const t = db.createObjectStore('tags', { keyPath: 'name' });
        t.createIndex('byCreatedAt', 'createdAt', { unique: false });
      }
      // Tag groups (for organizing tags)
      if (!db.objectStoreNames.contains('tag_groups')) {
        const tg = db.createObjectStore('tag_groups', { keyPath: 'id' });
        tg.createIndex('byName', 'name', { unique: false });
        tg.createIndex('byCreatedAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('groups')) {
        const g = db.createObjectStore('groups', { keyPath: 'id' });
        g.createIndex('byName', 'name', { unique: false });
        g.createIndex('byUpdatedAt', 'updatedAt', { unique: false });
      }
      // Pending channels (discovered by handle/name without id). Key is 'handle:@foo' or 'name:Some Name'
      if (!db.objectStoreNames.contains('channels_pending')) {
        const p = db.createObjectStore('channels_pending', { keyPath: 'key' });
        p.createIndex('byCreatedAt', 'createdAt', { unique: false });
      } else {
        // No index changes; rows may now include `subscribedPending?: boolean` starting v12
        // Keep upgrade resilient: nothing to migrate.
      }
      if (!db.objectStoreNames.contains('rules')) {
        const r = db.createObjectStore('rules', { keyPath: 'id' });
        r.createIndex('byEnabled', 'enabled', { unique: false });
        r.createIndex('byUpdatedAt', 'updatedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('channels')) {
        const c = db.createObjectStore('channels', { keyPath: 'id' });
        c.createIndex('byName', 'name', { unique: false });
        c.createIndex('byFetchedAt', 'fetchedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('channels_trash')) {
        const t = db.createObjectStore('channels_trash', { keyPath: 'id' });
        t.createIndex('byDeletedAt', 'deletedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      // Event history (commits + events)
      if (!db.objectStoreNames.contains('events_commits')) {
        const ec = db.createObjectStore('events_commits', { keyPath: 'commitId' });
        ec.createIndex('byTs', 'ts', { unique: false });
      }
      if (!db.objectStoreNames.contains('events')) {
        const ev = db.createObjectStore('events', { keyPath: 'id' });
        ev.createIndex('byCommit', 'commitId', { unique: false });
      }
      // v14: best-effort data cleanup to reduce stored payload sizes
      try {
        const tx = (req as any).transaction as IDBTransaction;
        // videos: drop raw yt and per-row thumbUrl (derivable from id)
        try {
          const vs = tx.objectStore('videos');
          const cur: IDBRequest = (vs as any).openCursor();
          cur.onsuccess = () => {
            const c = (cur as any).result as IDBCursorWithValue | null;
            if (!c) return;
            const row: any = c.value || {};
            if (row && row.yt) {
              try { applyYouTubeFields(row, row.yt); } catch {}
              delete row.yt;
            }
            if ('thumbUrl' in row) delete row.thumbUrl;
            try { c.update(row); } catch {}
            c.continue();
          };
        } catch { /* ignore */ }
        // channels: project thumbnailID, drop thumbnails/bannerUrl/raw yt
        try {
          const cs = tx.objectStore('channels');
          const cur: IDBRequest = (cs as any).openCursor();
          cur.onsuccess = () => {
            const c = (cur as any).result as IDBCursorWithValue | null;
            if (!c) return;
            const row: any = c.value || {};
            if (row) {
              try {
                if (!row.thumbnailID) {
                  const best = (row?.thumbnails?.high?.url || row?.thumbnails?.medium?.url || row?.thumbnails?.default?.url || null) as (string | null);
                  const id = extractAvatarId(best);
                  if (id) row.thumbnailID = id;
                }
              } catch { /* ignore */ }
              if ('thumbnails' in row) delete row.thumbnails;
              if ('bannerUrl' in row) delete row.bannerUrl;
              if ('yt' in row) delete row.yt;
            }
            try { c.update(row); } catch {}
            c.continue();
          };
        } catch { /* ignore */ }
      } catch { /* best-effort only */ }
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
  const out: any = { ...prev, ...incoming };
  out.tags = Array.isArray(prev.tags) ? prev.tags : [];
  out.flags = { ...(prev.flags || {}), ...(incoming.flags || {}) };
  out.progress = { ...(prev.progress || {}), ...(incoming.progress || {}) };
  out.sources = mergeSources(prev.sources || [], incoming.sources || []);
  // If YouTube payload attached, normalize convenience fields
  if (incoming.yt) applyYouTubeFields(out, incoming.yt);
  return out;
}

function mergeSources(a: any[], b: any[]) {
  // Normalize to objects with only {type, id}; de-dupe by type:id
  const norm = (s: any) => ({ type: s?.type, id: s?.id ?? null });
  const out: any[] = [];
  const seen = new Set<string>();
  const push = (s: any) => {
    const n = norm(s);
    const key = `${n.type}:${n.id ?? ''}`;
    if (!seen.has(key)) { seen.add(key); out.push(n); }
  };
  for (const s of Array.isArray(a) ? a : []) push(s);
  for (const s of Array.isArray(b) ? b : []) push(s);
  return out;
}

// ---- Meta helpers ----
export async function getMetaValue<T = any>(key: string): Promise<T | undefined> {
  const db = await openDB();
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction('meta', 'readonly');
    const os = tx.objectStore('meta');
    const g = os.get(key);
    g.onsuccess = () => {
      const row = g.result as any;
      resolve(row?.value ?? row?.id ?? undefined);
    };
    g.onerror = () => reject(g.error);
  });
}

export async function setMetaValue(key: string, value: any): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('meta', 'readwrite');
    const os = tx.objectStore('meta');
    os.put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export type LatestSource = 'SubscriptionsFeed' | 'WatchHistory';

// Update the per-source "latest" marker: clear flag on previous id, set on new id, and persist meta key
// opts.createIfMissing: when true, create a stub video row if the target id is not present (used for passive Sub Feed)
export async function updateLatestForSource(source: LatestSource, newId: string | null, opts?: { createIfMissing?: boolean }): Promise<{ prevId: string | null; newId: string | null }> {
  const key = source === 'SubscriptionsFeed' ? 'latestBy.SubscriptionsFeed' : 'latestBy.WatchHistory';
  const db = await openDB();
  let prevId: string | null = null;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['meta', 'videos'] as any, 'readwrite');
    const ms = tx.objectStore('meta');
    const vs = tx.objectStore('videos');
    const g = ms.get(key);
    g.onsuccess = () => {
      try { prevId = ((g.result as any)?.value || (g.result as any)?.id || null) ? String(((g.result as any)?.value || (g.result as any)?.id)) : null; } catch { prevId = null; }
      // Clear flag on previous
      if (prevId) {
        const pv = vs.get(prevId);
        pv.onsuccess = () => {
          const row = pv.result as any;
          if (row) {
            if (source === 'SubscriptionsFeed') delete row.latestFromSubFeed; else delete row.latestFromWatchHistory;
            // If this was a Sub Feed sentinel stub (hide + no fetch, unfetched), purge permanently when the flag is removed
            if (source === 'SubscriptionsFeed') {
              const tags: string[] = Array.isArray(row.tags) ? row.tags.map((s:string)=>String(s).toLowerCase()) : [];
              const isSentinel = tags.includes('hide') && tags.includes('no fetch') && !(Number.isFinite(row?.fetchedAt));
              if (isSentinel) { try { vs.delete(prevId!); } catch { /* ignore */ } return; }
            }
            vs.put(row);
          }
        };
      }
      // Set flag on new and update meta
      if (newId) {
        const nv = vs.get(newId);
        nv.onsuccess = () => {
          const exists = !!nv.result;
          if (exists || (opts?.createIfMissing === true)) {
            const row = (nv.result as any) || { id: newId };
            if (source === 'SubscriptionsFeed') row.latestFromSubFeed = true; else row.latestFromWatchHistory = true;
            // For Sub Feed: if creating a new stub, tag it as no fetch + hide so it doesn't get fetched or shown by default
            if (!exists && source === 'SubscriptionsFeed') {
              const tags: string[] = Array.isArray((row as any).tags) ? (row as any).tags.slice() : [];
              const add = (t: string) => { const nm = t.toLowerCase(); if (!tags.map(x=>x.toLowerCase()).includes(nm)) tags.push(t); };
              add('no fetch'); add('hide');
              (row as any).tags = tags;
            }
            vs.put(row);
          }
          // Always record meta to track the id, even if the row wasn't present
          ms.put({ key, value: newId });
        };
      }
    };
    g.onerror = () => reject(g.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return { prevId, newId: newId || null };
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
    })().then(() => (tx as any).commit?.());

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
    })().then(() => (tx as any).commit?.());

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
            // Not in 'videos' â€” try 'trash'
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
    })().then(() => (tx as any).commit?.());

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
    const tx = db.transaction(['tags', 'videos', 'trash', 'channels', 'channels_trash'] as any, 'readwrite');
    const ts = tx.objectStore('tags');
    const vs = tx.objectStore('videos');
    const rs = tx.objectStore('trash');
    const cs = (tx as any).objectStore('channels') as IDBObjectStore;
    const cts = (tx as any).objectStore('channels_trash') as IDBObjectStore;

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

    // replace in trash (videos)
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

    // replace in channels
    const cur3 = cs.openCursor();
    cur3.onsuccess = () => {
      const c = cur3.result as IDBCursorWithValue | null;
      if (!c) return;
      const row = c.value as any;
      if (Array.isArray(row.tags) && row.tags.includes(from)) {
        row.tags = row.tags.map((t: string) => (t === from ? to : t));
        c.update(row);
      }
      c.continue();
    };
    cur3.onerror = () => reject(cur3.error);

    // replace in channels_trash
    const cur4 = cts.openCursor();
    cur4.onsuccess = () => {
      const c = cur4.result as IDBCursorWithValue | null;
      if (!c) return;
      const row = c.value as any;
      if (Array.isArray(row.tags) && row.tags.includes(from)) {
        row.tags = row.tags.map((t: string) => (t === from ? to : t));
        c.update(row);
      }
      c.continue();
    };
    cur4.onerror = () => reject(cur4.error);

    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

export async function deleteTag(name: string, cascade: boolean = true) {
  const tag = (name ?? '').trim();
  if (!tag) return;
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const stores = cascade ? ['tags', 'videos', 'trash', 'channels', 'channels_trash'] : ['tags'];
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
      // also clean channel tags
      clean((tx as any).objectStore('channels'));
      clean((tx as any).objectStore('channels_trash'));
    }

    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

// Assign or clear a tag's group association (groupId nullable)
export async function setTagGroup(name: string, groupId: string | null) {
  const tag = (name ?? '').trim();
  const gid = (groupId ?? null) as (string | null);
  if (!tag) return;
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('tags', 'readwrite');
    const os = tx.objectStore('tags');
    const g = os.get(tag);
    g.onsuccess = () => {
      const row = (g.result as any) || null;
      if (row) {
        row.groupId = gid || undefined;
        os.put(row);
      }
    };
    g.onerror = () => reject(g.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---- Tag Groups CRUD ----
export async function listTagGroups(): Promise<Array<{ id: string; name: string; createdAt?: number }>> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tag_groups', 'readonly');
    const os = tx.objectStore('tag_groups');
    const req = os.getAll();
    req.onsuccess = () => {
      const rows = (req.result || []) as any[];
      rows.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      resolve(rows);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function createTagGroup(name: string): Promise<string> {
  const nm = (name ?? '').trim();
  if (!nm) return '';
  const db = await openDB();
  const id = crypto.randomUUID();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('tag_groups', 'readwrite');
    tx.objectStore('tag_groups').put({ id, name: nm, createdAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return id;
}

export async function renameTagGroup(id: string, newName: string) {
  const gid = (id ?? '').trim();
  const nm = (newName ?? '').trim();
  if (!gid || !nm) return;
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('tag_groups', 'readwrite');
    const os = tx.objectStore('tag_groups');
    const g = os.get(gid);
    g.onsuccess = () => {
      const row = g.result as any;
      if (row) { row.name = nm; os.put(row); }
    };
    g.onerror = () => reject(g.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteTagGroup(id: string) {
  const gid = (id ?? '').trim();
  if (!gid) return;
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['tag_groups', 'tags'], 'readwrite');
    (tx.objectStore('tag_groups') as IDBObjectStore).delete(gid);
    // Clear groupId from any tags referencing this group
    const ts = tx.objectStore('tags');
    const cur = ts.openCursor();
    cur.onsuccess = () => {
      const c = cur.result as IDBCursorWithValue | null;
      if (!c) return;
      const row = c.value as any;
      if (row && row.groupId === gid) {
        delete row.groupId;
        c.update(row);
      }
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function listGroups(): Promise<Group[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('groups', 'readonly');
    const os = tx.objectStore('groups');
    const req = os.getAll();
    req.onsuccess = () => {
      const rows = (req.result || []) as Group[];
      rows.sort((a,b) => a.name.localeCompare(b.name));
      resolve(rows);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function createGroup(name: string, condition: Condition): Promise<string> {
  const db = await openDB();
  const id = crypto.randomUUID();
  const now = Date.now();
  const rec: Group = { id, name, condition, createdAt: now, updatedAt: now, scrape: false };
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('groups', 'readwrite');
    tx.objectStore('groups').put(rec);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return id;
}

export async function updateGroup(id: string, patch: Partial<Group>) {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('groups', 'readwrite');
    const os = tx.objectStore('groups');
    const g = os.get(id);
    g.onsuccess = () => {
      if (!g.result) return resolve();
      const next = { ...g.result, ...patch, id, updatedAt: Date.now() };
      os.put(next);
    };
    g.onerror = () => reject(g.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteGroup(id: string) {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('groups', 'readwrite');
    tx.objectStore('groups').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
export async function listChannels(): Promise<Array<{ id: string; name: string; count: number; fetchedAt?: number | null; thumbnailID?: string | null }>> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('channels', 'readonly');
    const os = tx.objectStore('channels');
    const req = os.getAll();
    req.onsuccess = () => {
      const rows = (req.result || []) as any[];
      rows.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      const items = rows.map(r => {
        const bestId: string | null = r?.thumbnailID ? String(r.thumbnailID) : ((): string | null => {
          try { const u = (r?.thumbnails?.high?.url || r?.thumbnails?.medium?.url || r?.thumbnails?.default?.url || null) as (string | null); return extractAvatarId(u); } catch { return null; }
        })();
        const baseTags: string[] = Array.isArray(r.tags) ? r.tags : [];
        const extra: string[] = [];
        if (r?.subscribed === true) extra.push('subscribed');
        if (r?.unsubscribed === true) extra.push('unsubscribed');
        const mergedTags = Array.from(new Set<string>([...baseTags, ...extra]));
        return {
          id: r.id,
          name: r.name || r.id,
          count: Number(r.videos) || 0,
          fetchedAt: r.fetchedAt || null,
          thumbnailID: bestId,
          tags: mergedTags,
          videoTags: Array.isArray(r.videoTags) ? r.videoTags : [],
          subs: Number(r.subs) || null,
          views: Number(r.views) || null,
          videos: Number(r.videos) || null,
          country: r.country || null,
          publishedAt: ((): number | null => { try { const t = Date.parse(r.publishedAt || ''); return Number.isFinite(t) ? t : (Number.isFinite(r.publishedAt) ? r.publishedAt : null); } catch { return Number.isFinite(r.publishedAt) ? r.publishedAt : null; } })(),
          subsHidden: r.subsHidden === true,
          keywords: (Array.isArray(r.keywords) ? (r.keywords as string[]).filter(Boolean).join(', ') : (r.keywords || null)),
          topics: (Array.isArray((r as any).channelTopics) ? (r as any).channelTopics : (Array.isArray(r.topics) ? r.topics : []))
        };
      });
      resolve(items);
    };
    req.onerror = () => reject(req.error);
  });
}

// List channel ids that are present in the store but have never been fetched from the API
// (fetchedAt is missing/null). Useful to populate stub channels created by local operations.
export async function listChannelIdsNeedingFetch(): Promise<string[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('channels', 'readonly');
    const os = tx.objectStore('channels');
    const cur = os.openCursor();
    const ids: string[] = [];
    cur.onsuccess = () => {
      const c = cur.result as IDBCursorWithValue | null;
      if (!c) { resolve(ids); return; }
      const row: any = c.value;
      if (!row?.fetchedAt) ids.push(row?.id);
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
}

// Maintenance: remove duplicate/legacy entries in sources and strip deprecated fields from all rows
export async function wipeSourcesDuplicates(): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('videos', 'readwrite');
    const os = tx.objectStore('videos');
    const cur = os.openCursor();
    cur.onsuccess = () => {
      const c = cur.result as IDBCursorWithValue | null;
      if (!c) return;
      const row: any = c.value || {};
      row.sources = mergeSources(row.sources || [], []);
      c.update(row);
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Helper to apply normalized fields from a YouTube videos.list item
function applyYouTubeFields(row: any, yt: any) {
  try {
    const sn = yt?.snippet || {};
    const cd = yt?.contentDetails || {};
    const st = yt?.status || {};
    const td = yt?.topicDetails || {};
    const lsd = yt?.liveStreamingDetails || null;
    row.fetchedAt = Date.now();
    row.title = sn.title ?? row.title ?? null;
    row.channelId = sn.channelId ?? row.channelId ?? null;
    row.channelName = sn.channelTitle ?? row.channelName ?? null;
    row.uploadedAt = parseIsoDate(sn.publishedAt) ?? row.uploadedAt ?? null;
    row.durationSec = parseIsoDurationToSec(cd.duration) ?? row.durationSec ?? null;
    row.ytTags = Array.isArray(sn.tags) ? sn.tags.slice() : row.ytTags;
    row.description = typeof sn.description === 'string' ? sn.description : (row.description ?? null);
    row.categoryId = sn.categoryId != null ? Number(sn.categoryId) : (row.categoryId ?? null);
    row.visibility = st.privacyStatus || row.visibility || null;
    row.isLive = !!lsd;
    // language code: defaultLanguage or defaultAudioLanguage, take first segment (before '-')
    const lang = (sn.defaultLanguage || sn.defaultAudioLanguage || '').toString().toLowerCase();
    const lc = lang ? lang.split('-')[0] : '';
    row.languageCode = lc === 'en' || lc === 'de' ? lc : (lc ? 'other' : (row.languageCode ?? null));
    // topics: take last path segment of each URL
    const cats = Array.isArray(td.topicCategories) ? td.topicCategories : [];
    row.videoTopics = cats.map((u: string) => {
      try { const s = u.split('/'); return decodeURIComponent(s[s.length - 1] || ''); } catch { return ''; }
    }).filter(Boolean);
    // New compact top-level projections
    try {
      const live = !!lsd || (String(sn?.liveBroadcastContent || '').toLowerCase() !== 'none' && !!sn?.liveBroadcastContent);
      const dur = Number(row.durationSec || parseIsoDurationToSec(cd.duration) || 0);
      (row as any).type = live ? 'livestream' : (dur > 0 && dur <= 60 ? 'short' : 'video');
    } catch {}
    try {
      const cap = (cd?.caption ?? '').toString();
      if (cap === 'true') (row as any).transcript = '';
      else if (cap === 'false') (row as any).transcript = 'no transcript';
    } catch {}
    try {
      const stats = yt?.statistics || {};
      if (stats?.viewCount != null) (row as any).views = Number(stats.viewCount);
      if (stats?.likeCount != null) (row as any).likes = Number(stats.likeCount);
      if (stats?.commentCount != null) (row as any).commentCount = Number(stats.commentCount);
    } catch {}
    try { const v = yt?.liveStreamingDetails?.concurrentViewers; if (v != null) (row as any).liveViewers = Number(v); } catch {}
    try {
      if (st?.rejectionReason != null) (row as any).rejectionReason = String(st.rejectionReason);
      if (st?.failureReason != null) (row as any).failureReason = String(st.failureReason);
      if (st?.publishAt != null) (row as any).premiereTime = parseIsoDate(st.publishAt);
      if (typeof st?.hasCustomThumbnail === 'boolean') (row as any).customThumbnail = !!st.hasCustomThumbnail;
    } catch {}
    try {
      const cr = (yt?.contentRating?.ytRating) || (cd?.contentRating?.ytRating);
      if (cr) (row as any).contentRating = String(cr);
    } catch {}
    try {
      const rr = cd?.regionRestriction;
      if (rr && (rr.allowed || rr.blocked)) (row as any).regionRestriction = rr;
    } catch {}
    // Ensure heavy fields are not persisted
    if ('yt' in row) delete (row as any).yt;
    if ('thumbUrl' in row) delete (row as any).thumbUrl;
  } catch { /* ignore malformed payloads */ }
}

function parseIsoDate(s?: string | null): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function parseIsoDurationToSec(iso?: string | null): number | null {
  if (!iso) return null;
  // Simple ISO 8601 duration parser for PT#H#M#S
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(iso);
  if (!m) return null;
  const h = parseInt(m[1] || '0', 10);
  const mm = parseInt(m[2] || '0', 10);
  const s = parseInt(m[3] || '0', 10);
  return h * 3600 + mm * 60 + s;
}

// Exported helper (future: when fetch implemented) to apply a full videos.list item
export async function applyYouTubeVideo(yt: any) {
  const id = yt?.id;
  if (!id) return;
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('videos', 'readwrite');
    const os = tx.objectStore('videos');
    const g = os.get(id);
    g.onsuccess = () => {
      const prev = g.result || { id };
      applyYouTubeFields(prev, yt);
      os.put(prev);
    };
    g.onerror = () => reject(g.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Compute set of missing channel ids w.r.t. the channels store
export async function missingChannelIds(ids: string[]): Promise<string[]> {
  const db = await openDB();
  const unique = Array.from(new Set((ids || []).filter(Boolean)));
  const missing: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('channels', 'readonly');
    const os = tx.objectStore('channels');
    let i = 0;
    const step = () => {
      if (i >= unique.length) return resolve();
      const id = unique[i++];
      const g = os.get(id);
      g.onsuccess = () => { if (!g.result) missing.push(id); step(); };
      g.onerror = () => reject(g.error);
    };
    step();
  });
  return missing;
}

// Upsert a channel record from channels.list
export async function applyYouTubeChannel(ch: any): Promise<void> {
  const id = ch?.id;
  if (!id) return;
  const db = await openDB();
  const snippet = ch?.snippet || {};
  const statistics = ch?.statistics || {};
  const branding = ch?.brandingSettings || {};
  const topics = Array.isArray((ch?.topicDetails || {}).topicCategories) ? (ch.topicDetails.topicCategories as any[]) : [];
  const contentDetails = ch?.contentDetails || {};
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('channels', 'readwrite');
    const os = tx.objectStore('channels');
    const g = os.get(id);
    g.onsuccess = () => {
      const prev = (g.result as any) || { id };
      // Start from previous to preserve local fields like tags, videoTags, and scraped* metadata
      const next: any = { ...prev };
      next.name = snippet.title || prev.name || id;
      next.customUrl = snippet.customUrl || prev.customUrl || null;
      // Compact avatar id from thumbnails url
      try {
        const best = (snippet?.thumbnails?.high?.url || snippet?.thumbnails?.medium?.url || snippet?.thumbnails?.default?.url || null) as (string | null);
        const tid = extractAvatarId(best);
        if (tid) next.thumbnailID = tid;
      } catch { /* ignore */ }
      next.country = snippet.country || (branding?.channel?.country) || prev.country || null;
      // Store description for diffing/history
      next.description = typeof snippet.description === 'string' ? snippet.description : (prev.description ?? null);
      // Related playlists projection
      try { const rel = (contentDetails?.relatedPlaylists || null); if (rel) next.playlists = rel; } catch { /* ignore */ }
      try {
        const t = Date.parse(snippet.publishedAt || '');
        next.publishedAt = Number.isFinite(t) ? t : (prev.publishedAt ?? null);
      } catch { next.publishedAt = prev.publishedAt ?? null; }
      next.subs = Number(statistics?.subscriberCount) || null;
      next.videos = Number(statistics?.videoCount) || null;
      next.views = Number(statistics?.viewCount) || null;
      // Keywords: parse quoted phrases and single-word tokens into an array
      try {
        const rawKw = (branding?.channel?.keywords as string) || '';
        next.keywords = parseKeywords(rawKw);
      } catch { next.keywords = Array.isArray(prev.keywords) ? prev.keywords : []; }
      // Channel topics: map topicCategory URLs to readable labels
      try {
        const labels: string[] = [];
        for (const u of (topics as any[])) {
          try {
            const url = new URL(String(u));
            const slug = decodeURIComponent(url.pathname.split('/').pop() || '').replace(/_/g, ' ').trim();
            if (slug) labels.push(slug);
          } catch { /* ignore */ }
        }
        (next as any).channelTopics = Array.from(new Set(labels));
        if ('topics' in next) delete (next as any).topics;
      } catch { /* ignore */ }
      next.subsHidden = statistics?.hiddenSubscriberCount === true;
      next.fetchedAt = Date.now();
      // Ensure heavy/raw fields are not kept
      if ('thumbnails' in next) delete next.thumbnails;
      if ('bannerUrl' in next) delete next.bannerUrl;
      if ('yt' in next) delete next.yt;
      // DO NOT touch next.tags or next.videoTags here; they are local/derived
      os.put(next);
    };
    g.onerror = () => reject(g.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Apply local tags to channel records
export async function applyChannelTags(ids: string[], addIds: string[] = [], removeIds: string[] = []) {
  if (!ids?.length || (!addIds?.length && !removeIds?.length)) return;
  const add = [...new Set(addIds.map(s => (s ?? '').trim()).filter(Boolean))];
  const rem = new Set(removeIds.map(s => (s ?? '').trim()).filter(Boolean));
  if (add.length === 0 && rem.size === 0) return;
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('channels', 'readwrite');
    const os = tx.objectStore('channels');
    (async () => {
      for (const id of ids) {
        await new Promise<void>((res, rej) => {
          const g = os.get(id);
          g.onsuccess = () => {
            const row = g.result || { id, tags: [] };
            const tags: string[] = Array.isArray(row.tags) ? row.tags.slice() : [];
            for (const t of add) if (!tags.includes(t)) tags.push(t);
            if (rem.size) {
              for (let i = tags.length - 1; i >= 0; i--) if (rem.has(tags[i])) tags.splice(i, 1);
            }
            row.tags = tags;
            os.put(row);
            res();
          };
          g.onerror = () => rej(g.error);
        });
      }
    })().then(() => (tx as any).commit?.());
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Recompute videoTags for channels by scanning videos' tags
export async function recomputeVideoTagsForAllChannels() {
  const db = await openDB();
  const map = new Map<string, Set<string>>();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('videos', 'readonly');
    const os = tx.objectStore('videos');
    const cur = os.openCursor();
    cur.onsuccess = () => {
      const c = cur.result as IDBCursorWithValue | null;
      if (!c) return resolve();
      const v: any = c.value;
      const chId: string | null = v?.channelId || null;
      if (chId) {
        const set = map.get(chId) || (map.set(chId, new Set<string>()), map.get(chId)!);
        if (Array.isArray(v?.tags)) for (const t of v.tags) if (t) set.add(String(t));
      }
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('channels', 'readwrite');
    const os = tx.objectStore('channels');
    const cur = os.openCursor();
    cur.onsuccess = () => {
      const c = cur.result as IDBCursorWithValue | null;
      if (!c) return resolve();
      const row: any = c.value;
      const set = map.get(row.id) || new Set<string>();
      row.videoTags = Array.from(set.values()).sort((a,b)=>a.localeCompare(b));
      c.update(row);
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
}

// Aggregate distinct normalized videoTopics across all videos and persist to meta store
export async function recomputeVideoTopicsMeta() {
  const db = await openDB();
  const set = new Set<string>();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('videos', 'readonly');
    const os = tx.objectStore('videos');
    const cur = os.openCursor();
    cur.onsuccess = () => {
      const c = cur.result as IDBCursorWithValue | null;
      if (!c) return resolve();
      const v: any = c.value;
      const list: string[] = Array.isArray(v?.videoTopics) ? v.videoTopics : [];
      for (const t of list) {
        const s = (t || '').toString().trim();
        if (s) set.add(s);
      }
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
  const list = Array.from(set.values()).sort((a,b)=> a.localeCompare(b));
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('meta', 'readwrite');
    const os = tx.objectStore('meta');
    os.put({ key: 'videoTopics', list, updatedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function readVideoTopicsMeta(): Promise<string[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meta', 'readonly');
    const os = tx.objectStore('meta');
    const g = os.get('videoTopics');
    g.onsuccess = () => {
      const row = g.result as any;
      resolve(Array.isArray(row?.list) ? row.list as string[] : []);
    };
    g.onerror = () => reject(g.error);
  });
}

export async function recomputeVideoTagsForChannels(chanIds: string[]) {
  const target = new Set((chanIds || []).filter(Boolean));
  if (target.size === 0) return;
  const db = await openDB();
  const map = new Map<string, Set<string>>();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('videos', 'readonly');
    const os = tx.objectStore('videos');
    const cur = os.openCursor();
    cur.onsuccess = () => {
      const c = cur.result as IDBCursorWithValue | null;
      if (!c) return resolve();
      const v: any = c.value;
      const chId: string | null = v?.channelId || null;
      if (chId && target.has(chId)) {
        const set = map.get(chId) || (map.set(chId, new Set<string>()), map.get(chId)!);
        if (Array.isArray(v?.tags)) for (const t of v.tags) if (t) set.add(String(t));
      }
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('channels', 'readwrite');
    const os = tx.objectStore('channels');
    (async () => {
      for (const id of Array.from(target)) {
        await new Promise<void>((res, rej) => {
          const g = os.get(id);
          g.onsuccess = () => {
            const row = g.result;
            if (row) {
              const set = map.get(id) || new Set<string>();
              row.videoTags = Array.from(set.values()).sort((a,b)=>a.localeCompare(b));
              os.put(row);
            }
            res();
          };
          g.onerror = () => rej(g.error);
        });
      }
    })().then(() => (tx as any).commit?.());
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Upsert a minimal channel stub (id + optional name/handle) without clobbering local fields
export async function upsertChannelStub(id: string, name?: string | null, handle?: string | null) {
  const chId = (id || '').trim();
  if (!chId) return;
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('channels', 'readwrite');
    const os = tx.objectStore('channels');
    const g = os.get(chId);
    g.onsuccess = () => {
      const prev = (g.result as any) || { id: chId };
      const next: any = { ...prev };
      if (name && !next.name) next.name = name;
      if (handle) next.handle = handle;
      os.put(next);
    };
    g.onerror = () => reject(g.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function moveChannelsToTrash(ids: string[]) {
  if (!ids?.length) return;
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['channels', 'channels_trash'], 'readwrite');
    const cs = tx.objectStore('channels');
    const ts = tx.objectStore('channels_trash');
    (async () => {
      for (const id of ids) {
        await new Promise<void>((res, rej) => {
          const g = cs.get(id);
          g.onsuccess = () => {
            const row = g.result;
            if (row) {
              ts.put({ ...row, deletedAt: Date.now() });
              cs.delete(id);
            }
            res();
          };
          g.onerror = () => rej(g.error);
        });
      }
    })().then(() => (tx as any).commit?.());
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function restoreChannelsFromTrash(ids: string[]) {
  if (!ids?.length) return;
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['channels', 'channels_trash'], 'readwrite');
    const cs = tx.objectStore('channels');
    const ts = tx.objectStore('channels_trash');
    (async () => {
      for (const id of ids) {
        await new Promise<void>((res, rej) => {
          const g = ts.get(id);
          g.onsuccess = () => {
            const row = g.result;
            if (row) {
              const { deletedAt, ...rest } = row;
              cs.put(rest);
              ts.delete(id);
            }
            res();
          };
          g.onerror = () => rej(g.error);
        });
      }
    })().then(() => (tx as any).commit?.());
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function listChannelsTrash(): Promise<any[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('channels_trash', 'readonly');
    const os = tx.objectStore('channels_trash');
    const req = os.getAll();
    req.onsuccess = () => {
      const rows = (req.result || []) as any[];
      rows.sort((a,b) => (b.deletedAt || 0) - (a.deletedAt || 0));
      const items = rows.map(r => ({
        id: r.id,
        name: r.name || r.id,
        fetchedAt: r.fetchedAt || null,
        deletedAt: r.deletedAt || null,
        thumbnailID: r?.thumbnailID || extractAvatarId((r?.thumbnails?.high?.url || r?.thumbnails?.medium?.url || r?.thumbnails?.default?.url || null) as (string | null)) || null,
        subs: Number(r.subs) || null,
        views: Number(r.views) || null,
        videos: Number(r.videos) || 0,
        country: r.country || null,
        publishedAt: ((): number | null => { try { const t = Date.parse(r.publishedAt || ''); return Number.isFinite(t) ? t : (Number.isFinite(r.publishedAt) ? r.publishedAt : null); } catch { return Number.isFinite(r.publishedAt) ? r.publishedAt : null; } })(),
        subsHidden: r.subsHidden === true,
        tags: Array.isArray(r.tags) ? r.tags : [],
        videoTags: Array.isArray(r.videoTags) ? r.videoTags : [],
        keywords: (Array.isArray(r.keywords) ? (r.keywords as string[]).filter(Boolean).join(', ') : (r.keywords || null)),
        topics: (Array.isArray((r as any).channelTopics) ? (r as any).channelTopics : (Array.isArray(r.topics) ? r.topics : []))
      }));
      resolve(items);
    };
    req.onerror = () => reject(req.error);
  });
}

// Bulk upsert videos in a single transaction for performance
export async function upsertVideosBulk(objs: any[]) {
  if (!Array.isArray(objs) || objs.length === 0) return;
  const db = await openDB();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction('videos', 'readwrite');
    const os = tx.objectStore('videos');
    (async () => {
      for (const obj of objs) {
        await new Promise<void>((r, j) => {
          const g = os.get(obj.id);
          g.onsuccess = () => {
            try {
              const prev = g.result || {};
              const merged = merge(prev, obj);
              os.put(merged);
              r();
            } catch (e) { j(e); }
          };
          g.onerror = () => j(g.error);
        });
      }
    })().then(() => (tx as any).commit?.());
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

// Update channels subscribed/unsubscribed flags based on the current subscribed set.
// - For ids present in `currentIds`: set subscribed=true and clear unsubscribed.
// - For channels previously marked subscribed but not in `currentIds`: set unsubscribed=true (keep historical truth of having been subscribed).
export async function applySubscribedSet(currentIds: string[]): Promise<{ updated: number; created: number; unsubscribed: number }> {
  const set = new Set((currentIds || []).map(s => String(s || '').trim()).filter(Boolean));
  const db = await openDB();
  let updated = 0, created = 0, unsub = 0;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('channels', 'readwrite');
    const os = tx.objectStore('channels');
    (async () => {
      // First, ensure present ids are marked subscribed
      for (const id of set.values()) {
        await new Promise<void>((res, rej) => {
          const g = os.get(id);
          g.onsuccess = () => {
            const prev = (g.result as any) || null;
            const row: any = prev ? { ...prev } : { id };
            if (!prev) created++;
            row.subscribed = true;
            row.unsubscribed = false;
            os.put(row);
            updated++;
            res();
          };
          g.onerror = () => rej(g.error);
        });
      }
      // Second, mark unsubscribed when previously subscribed and now missing
      await new Promise<void>((res, rej) => {
        const cur = os.openCursor();
        cur.onsuccess = () => {
          const c = cur.result as IDBCursorWithValue | null;
          if (!c) { res(); return; }
          const row: any = c.value || {};
          if (row?.subscribed === true && row?.id && !set.has(String(row.id))) {
            row.unsubscribed = true;
            c.update(row);
            unsub++;
          }
          c.continue();
        };
        cur.onerror = () => rej(cur.error);
      });
    })().then(() => (tx as any).commit?.());
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return { updated, created, unsubscribed: unsub };
}

// Set scrapedAt and optional scrapedVideoCount on a channel record
export async function markChannelScraped(id: string, at: number, opts?: { tab?: 'videos'|'shorts'|'live'; count?: number; totalVideoCountOnScrapeTime?: number | null }) {
  const chId = (id || '').trim();
  if (!chId) return;
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('channels', 'readwrite');
    const os = tx.objectStore('channels');
    const g = os.get(chId);
    g.onsuccess = () => {
      const row = g.result || { id: chId };
      // Global last-scraped timestamp (any tab)
      (row as any).scrapedAt = at;
      if (opts && 'totalVideoCountOnScrapeTime' in opts) {
        (row as any).totalVideoCountOnScrapeTime = opts?.totalVideoCountOnScrapeTime ?? null;
      }
      if (opts?.tab && typeof opts?.count === 'number') {
        const n = Math.max(0, Math.floor(opts.count));
        if (opts.tab === 'videos') (row as any).scrapedVideoCount = n;
        else if (opts.tab === 'shorts') (row as any).scrapedShortsCount = n;
        else if (opts.tab === 'live') (row as any).scrapedLivestreamCount = n;
        // Per-tab scrapedAt fields
        if (opts.tab === 'videos') (row as any).scrapedAtVideos = at;
        else if (opts.tab === 'shorts') (row as any).scrapedAtShorts = at;
        else if (opts.tab === 'live') (row as any).scrapedAtLivestreams = at;
      }
      os.put(row);
    };
    g.onerror = () => reject(g.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---- Pending channels (handle/name without id) ----
export async function upsertPendingChannel(key: string, data: { name?: string | null; handle?: string | null; subscribedPending?: boolean }): Promise<boolean> {
  const k = (key || '').trim(); if (!k) return false;
  // normalize handle to always include leading '@' if present
  const incomingHandle = data?.handle ? (String(data.handle).startsWith('@') ? String(data.handle) : '@' + String(data.handle)) : null;
  const db = await openDB();
  // If this is a handle-based pending and a channel already exists with that handle (or alt handle),
  // do not create/update a pending row. Optionally mark it subscribed immediately when requested.
  try {
    const keyIsHandle = k.toLowerCase().startsWith('handle:');
    const keyHandleRaw = keyIsHandle ? k.slice('handle:'.length) : null;
    const normalizedHandle = (incomingHandle || (keyHandleRaw ? (keyHandleRaw.startsWith('@') ? keyHandleRaw : ('@' + keyHandleRaw)) : null));
    if (normalizedHandle) {
      const wantSubscribed = data?.subscribedPending === true;
      const updatedExisting = await new Promise<boolean>((resolve, reject) => {
        const tx = db.transaction('channels', wantSubscribed ? 'readwrite' : 'readonly');
        const os = tx.objectStore('channels');
        let found = false;
        const cur = os.openCursor();
        cur.onsuccess = () => {
          const c = cur.result as IDBCursorWithValue | null;
          if (!c) { resolve(found); return; }
          const row: any = c.value || {};
          const base = String(row?.handle || '').trim();
          const baseNorm = base ? (base.startsWith('@') ? base.toLowerCase() : ('@' + base.toLowerCase())) : '';
          const alts: string[] = Array.isArray(row?.altHandles) ? row.altHandles : [];
          const hasAlt = alts.some(h => {
            const s = String(h || '').trim();
            if (!s) return false; const sn = s.startsWith('@') ? s.toLowerCase() : ('@' + s.toLowerCase());
            return sn === normalizedHandle.toLowerCase();
          });
          if (baseNorm === normalizedHandle.toLowerCase() || hasAlt) {
            found = true;
            if (wantSubscribed) {
              const next = { ...row, subscribed: true, unsubscribed: false };
              try { c.update(next); } catch { /* ignore */ }
            }
          }
          c.continue();
        };
        cur.onerror = () => reject(cur.error);
      });
      if (updatedExisting) return false; // skip creating/updating pending; channel already exists
    }
  } catch { /* fall through to pending upsert */ }
  return new Promise<boolean>((resolve, reject) => {
    const tx = db.transaction('channels_pending', 'readwrite');
    const os = tx.objectStore('channels_pending');
    const g = os.get(k);
    g.onsuccess = () => {
      const prev = (g.result as any) || null;
      const created = !prev;
      const prevName = prev?.name ?? null;
      const prevHandle = prev?.handle ?? null;
      const next = { key: k, createdAt: prev?.createdAt || Date.now(), name: data?.name ?? prevName ?? null, handle: incomingHandle ?? prevHandle ?? null, updatedAt: Date.now() } as any;
      if (data?.subscribedPending) next.subscribedPending = true; else if (typeof prev?.subscribedPending === 'boolean') next.subscribedPending = !!prev.subscribedPending;
      const changed = created || (String(prevName || '') !== String(next.name || '')) || (String(prevHandle || '') !== String(next.handle || ''));
      if (changed) os.put(next);
      else {
        // Touch updatedAt conservatively to avoid churn
        // Do not rewrite identical rows
      }
      resolve(changed);
    };
    g.onerror = () => reject(g.error);
    tx.oncomplete = () => void 0;
    tx.onerror = () => reject(tx.error);
  });
}

export async function resolvePendingChannel(channelId: string, hint?: { handle?: string | null; name?: string | null; altHandle?: string | null }) {
  const id = (channelId || '').trim(); if (!id) return;
  const db = await openDB();
  // Upsert channel stub with resolved id
  await upsertChannelStub(id, hint?.name || null, hint?.handle || null);
  // Clear any matching pending
  let hadPendingSubscribed = false;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('channels_pending', 'readwrite');
    const os = tx.objectStore('channels_pending');
    const cur = os.openCursor();
    cur.onsuccess = () => {
      const c = cur.result as IDBCursorWithValue | null;
      if (!c) { resolve(); return; }
      const row: any = c.value;
      const matches = (hint?.handle && row?.handle && String(row.handle).toLowerCase() === String(hint!.handle).toLowerCase()) || (hint?.altHandle && row?.handle && String(row.handle).toLowerCase() === String(hint!.altHandle).toLowerCase()) || (hint?.name && row?.name && String(row.name).toLowerCase() === String(hint!.name).toLowerCase());
      if (matches) {
        if (row?.subscribedPending) hadPendingSubscribed = true;
        c.delete();
      }
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
  // If any matching pending entry indicated subscribedPending, mark the channel subscribed now
  if (hadPendingSubscribed || (hint?.altHandle)) {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('channels', 'readwrite');
      const os = tx.objectStore('channels');
      const g = os.get(id);
      g.onsuccess = () => {
        const prev = (g.result as any) || { id };
        (prev as any).subscribed = true;
        (prev as any).unsubscribed = false;
        if (hint?.altHandle) {
          const alt = String(hint.altHandle);
          const norm = alt.startsWith("@") ? alt : ("@" + alt);
          const arr = Array.isArray((prev as any).altHandles) ? ((prev as any).altHandles as string[]) : [];
          if (!arr.find(x => String(x).toLowerCase() === norm.toLowerCase())) arr.push(norm);
          (prev as any).altHandles = arr;
        }
        os.put(prev);
        resolve();
      };
      g.onerror = () => reject(g.error);
    });
  }
}

export async function listPendingChannels(): Promise<Array<{ key: string; name?: string | null; handle?: string | null; subscribedPending?: boolean; createdAt?: number; updatedAt?: number }>> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('channels_pending', 'readonly');
    const os = tx.objectStore('channels_pending');
    const req = (os as any).getAll ? (os as any).getAll() : os.openCursor();
    const out: any[] = [];
    if ('getAll' in os) {
      (req as IDBRequest).onsuccess = () => resolve((((req as any).result as any[]) || []).map((r:any)=>({ key:String(r.key), name:r.name??null, handle:r.handle??null, subscribedPending: !!r.subscribedPending, createdAt:r.createdAt, updatedAt:r.updatedAt })));
      (req as IDBRequest).onerror = () => reject((req as any).error);
    } else {
      (req as IDBRequest).onsuccess = () => {
        const c = (req as any).result as IDBCursorWithValue | null;
        if (!c) { resolve(out); return; }
        const r:any = c.value || {};
        out.push({ key:String(r.key), name:r.name??null, handle:r.handle??null, subscribedPending: !!r.subscribedPending, createdAt:r.createdAt, updatedAt:r.updatedAt });
        c.continue();
      };
      (req as IDBRequest).onerror = () => reject((req as any).error);
    }
  });
}

// Mark the given channel ids as subscribed (idempotent). Ensures rows exist.
export async function markChannelsSubscribed(ids: string[]): Promise<number> {
  const list = Array.from(new Set((ids || []).map(s => String(s || '').trim()).filter(Boolean)));
  if (list.length === 0) return 0;
  const db = await openDB();
  let updated = 0;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('channels', 'readwrite');
    const os = tx.objectStore('channels');
    (async () => {
      for (const id of list) {
        await new Promise<void>((res, rej) => {
          const g = os.get(id);
          g.onsuccess = () => {
            const prev = (g.result as any) || null;
            const row: any = prev ? { ...prev } : { id };
            row.subscribed = true;
            row.unsubscribed = false;
            os.put(row);
            updated++;
            res();
          };
          g.onerror = () => rej(g.error);
        });
      }
    })().then(() => (tx as any).commit?.());
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return updated;
}

// Aggregate and persist per-channel videoTopics lists by scanning videos
export async function recomputeChannelVideoTopicsForAllChannels() {
  const db = await openDB();
  const map = new Map<string, Set<string>>();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('videos', 'readonly');
    const os = tx.objectStore('videos');
    const cur = os.openCursor();
    cur.onsuccess = () => {
      const c = cur.result as IDBCursorWithValue | null;
      if (!c) return resolve();
      const v: any = c.value;
      const chId: string | null = v?.channelId || null;
      if (chId) {
        const list: string[] = Array.isArray(v?.videoTopics) ? v.videoTopics : [];
        const set = map.get(chId) || (map.set(chId, new Set<string>()), map.get(chId)!);
        for (const t of list) { const s = (t || '').toString().trim(); if (s) set.add(s); }
      }
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('channels', 'readwrite');
    const os = tx.objectStore('channels');
    const cur = os.openCursor();
    cur.onsuccess = () => {
      const c = cur.result as IDBCursorWithValue | null;
      if (!c) return resolve();
      const row: any = c.value;
      const set = map.get(row.id) || new Set<string>();
      row.videoTopics = Array.from(set.values()).sort((a,b)=>a.localeCompare(b));
      c.update(row);
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
}

// Delete a single pending channel row by key
export async function deletePendingChannel(key: string): Promise<boolean> {
  const k = (key || '').trim();
  if (!k) return false;
  const db = await openDB();
  return new Promise<boolean>((resolve, reject) => {
    const tx = db.transaction('channels_pending', 'readwrite');
    const os = tx.objectStore('channels_pending');
    const req = os.delete(k);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

// Permanently delete videos from trash
export async function purgeVideosFromTrash(ids: string[]): Promise<number> {
  if (!ids?.length) return 0;
  const db = await openDB();
  return new Promise<number>((resolve, reject) => {
    const tx = db.transaction('trash', 'readwrite');
    const ts = tx.objectStore('trash');
    let n = 0;
    for (const id of ids) { try { ts.delete(id); n++; } catch {} }
    tx.oncomplete = () => resolve(n);
    tx.onerror = () => reject(tx.error);
  });
}

// Permanently delete channels from trash
export async function purgeChannelsFromTrash(ids: string[]): Promise<number> {
  if (!ids?.length) return 0;
  const db = await openDB();
  return new Promise<number>((resolve, reject) => {
    const tx = db.transaction('channels_trash', 'readwrite');
    const ts = tx.objectStore('channels_trash');
    let n = 0;
    for (const id of ids) { try { ts.delete(id); n++; } catch {} }
    tx.oncomplete = () => resolve(n);
    tx.onerror = () => reject(tx.error);
  });
}

// ---- Local helpers ----
function bestThumbSafe(thumbs: any): string | null {
  try { return (thumbs?.high?.url || thumbs?.medium?.url || thumbs?.default?.url || null) as (string | null); } catch { return null; }
}
function extractAvatarId(url?: string | null): string | null {
  try {
    const u = String(url || ''); if (!u) return null;
    const marker = 'yt3.ggpht.com/';
    const i = u.indexOf(marker); if (i === -1) return null;
    const start = i + marker.length;
    // Take everything after domain up to the first '=' (size params), preserving any 'ytc/' prefix
    const eq = u.indexOf('=', start);
    let end = eq !== -1 ? eq : u.length;
    // Trim any trailing query/hash if '=' not found
    const q = u.indexOf('?', start); if (q !== -1 && q < end) end = q;
    const h = u.indexOf('#', start); if (h !== -1 && h < end) end = h;
    const base = u.slice(start, end).replace(/\/+$/,'');
    return base || null;
  } catch { return null; }
}

// Parse YouTube channel keywords string into an array.
// Supports quoted multi-word phrases and single-word tokens separated by whitespace.
function parseKeywords(input?: string | null): string[] {
  const s = (input || '').toString();
  if (!s.trim()) return [];
  const out: string[] = [];
  const re = /"([^"]+)"|(\S+)/g; // quoted phrase or non-space token
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const val = (m[1] || m[2] || '').trim();
    if (val) out.push(val);
  }
  // Dedupe while preserving order
  const seen = new Set<string>();
  const res: string[] = [];
  for (const k of out) { if (!seen.has(k)) { seen.add(k); res.push(k); } }
  return res;
}


import { dlog, derr } from '../types/debug';
import type { Condition, Group } from '../shared/conditions';
const DB_NAME = 'yt-recommender';
const DB_VERSION = 6;

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
      } else {
        try {
          const tx = (req as any).transaction as IDBTransaction;
          const os = tx.objectStore('videos');
          const names: string[] = Array.from((os as any).indexNames || []);
          if (names.includes('byLastSeen')) os.deleteIndex('byLastSeen');
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
      if (!db.objectStoreNames.contains('groups')) {
        const g = db.createObjectStore('groups', { keyPath: 'id' });
        g.createIndex('byName', 'name', { unique: false });
        g.createIndex('byUpdatedAt', 'updatedAt', { unique: false });
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
            // Not in 'videos' — try 'trash'
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
  const rec: Group = { id, name, condition, createdAt: now, updatedAt: now };
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
export async function listChannels(): Promise<Array<{ id: string; name: string; count: number; fetchedAt?: number | null; thumbUrl?: string | null }>> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('channels', 'readonly');
    const os = tx.objectStore('channels');
    const req = os.getAll();
    req.onsuccess = () => {
      const rows = (req.result || []) as any[];
      rows.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      const items = rows.map(r => {
        const thumbs = r?.thumbnails || {};
        const best = thumbs?.high?.url || thumbs?.medium?.url || thumbs?.default?.url || null;
        return {
          id: r.id,
          name: r.name || r.id,
          count: Number(r.videos) || 0,
          fetchedAt: r.fetchedAt || null,
          thumbUrl: best,
          tags: Array.isArray(r.tags) ? r.tags : [],
          videoTags: Array.isArray(r.videoTags) ? r.videoTags : [],
          subs: Number(r.subs) || null,
          keywords: r.keywords || null,
          topics: Array.isArray(r.topics) ? r.topics : []
        };
      });
      resolve(items);
    };
    req.onerror = () => reject(req.error);
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
    row.yt = yt;
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
  const rec = {
    id,
    name: snippet.title || id,
    customUrl: snippet.customUrl || null,
    thumbnails: snippet.thumbnails || null,
    country: snippet.country || branding?.channel?.country || null,
    publishedAt: ((): number | null => { try { const t = Date.parse(snippet.publishedAt || ''); return Number.isFinite(t) ? t : null; } catch { return null; } })(),
    subs: Number(statistics?.subscriberCount) || null,
    videos: Number(statistics?.videoCount) || null,
    views: Number(statistics?.viewCount) || null,
    keywords: (branding?.channel?.keywords as string) || null,
    topics: topics as string[],
    subsHidden: statistics?.hiddenSubscriberCount === true,
    fetchedAt: Date.now(),
    yt: ch,
    tags: [],
    videoTags: []
  } as any;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('channels', 'readwrite');
    tx.objectStore('channels').put(rec);
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

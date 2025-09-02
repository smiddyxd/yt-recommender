import { openDB } from './db';
import type { SettingsSnapshot } from './driveBackup';

export type RestoreMode = 'merge' | 'overwrite';
export type ApplyFlags = { channelTags?: boolean; videoTags?: boolean; sources?: boolean; progress?: boolean };

export type RestoreSummary = {
  ok: true;
  counts: {
    tagsCreated?: number; tagsUpdated?: number; tagsCleared?: number;
    tagGroupsCreated?: number; tagGroupsUpdated?: number; tagGroupsCleared?: number;
    groupsCreated?: number; groupsUpdated?: number; groupsCleared?: number;
    channelsUpserted?: number; channelTagUpdates?: number;
    videosUpserted?: number; videoTagUpdates?: number; sourcesUpdated?: number; progressUpdated?: number;
    pendingUpserted?: number;
  };
};

export type RestoreDryRunResult = RestoreSummary & { message?: string };

function uniq<T>(arr: T[]): T[] { return Array.from(new Set(arr)); }

export async function dryRunRestoreApply(snapshot: SettingsSnapshot, mode: RestoreMode, apply: ApplyFlags): Promise<RestoreDryRunResult> {
  if (!snapshot || snapshot.version !== 1) {
    return { ok: true, counts: {}, message: 'Blocked: unsupported snapshot version' };
  }
  // Read current registries for comparison
  const db = await openDB();
  const [tagsNow, tagGroupsNow, groupsNow] = await Promise.all([
    readAll(db, 'tags'), readAll(db, 'tag_groups'), readAll(db, 'groups'),
  ]);

  const counts: RestoreSummary['counts'] = {};

  // Tags
  if (mode === 'overwrite') {
    counts.tagsCleared = tagsNow.length;
    counts.tagsCreated = (snapshot.tags || []).length;
  } else {
    const setNow = new Set((tagsNow as any[]).map(r => (r?.name || '').toString()));
    let create = 0, update = 0;
    for (const t of snapshot.tags || []) {
      const name = (t?.name || '').toString(); if (!name) continue;
      if (!setNow.has(name)) create++; else update++;
    }
    counts.tagsCreated = create; counts.tagsUpdated = update;
  }

  // Tag Groups
  if (mode === 'overwrite') {
    counts.tagGroupsCleared = tagGroupsNow.length;
    counts.tagGroupsCreated = (snapshot.tagGroups || []).length;
  } else {
    const setNow = new Set((tagGroupsNow as any[]).map(r => (r?.id || '').toString()));
    let create = 0, update = 0;
    for (const g of snapshot.tagGroups || []) {
      const id = (g?.id || '').toString(); if (!id) continue;
      if (!setNow.has(id)) create++; else update++;
    }
    counts.tagGroupsCreated = create; counts.tagGroupsUpdated = update;
  }

  // Groups (presets)
  if (mode === 'overwrite') {
    counts.groupsCleared = groupsNow.length;
    counts.groupsCreated = (snapshot.groups || []).length;
  } else {
    const setNow = new Set((groupsNow as any[]).map(r => (r?.id || '').toString()));
    let create = 0, update = 0;
    for (const g of snapshot.groups || []) {
      const id = (g?.id || '').toString(); if (!id) continue;
      if (!setNow.has(id)) create++; else update++;
    }
    counts.groupsCreated = create; counts.groupsUpdated = update;
  }

  // Channels
  if (apply?.channelTags) {
    const ids = uniq((snapshot.channelIndex || []).map(c => (c?.id || '').toString()).filter(Boolean));
    counts.channelsUpserted = ids.length;
    let tagUpdates = 0;
    for (const c of snapshot.channelIndex || []) { if (Array.isArray(c?.tags) && c.tags.length) tagUpdates++; }
    counts.channelTagUpdates = tagUpdates;
  }

  // Videos
  if (apply?.videoTags || apply?.sources || apply?.progress) {
    const ids = uniq((snapshot.videoIndex || []).map(v => (v?.id || '').toString()).filter(Boolean));
    counts.videosUpserted = ids.length;
    counts.videoTagUpdates = (apply.videoTags ? (snapshot.videoIndex || []).filter(v => Array.isArray(v.tags) && v.tags.length).length : 0);
    counts.sourcesUpdated = (apply.sources ? (snapshot.videoIndex || []).filter(v => Array.isArray(v.sources) && v.sources.length).length : 0);
    counts.progressUpdated = (apply.progress ? (snapshot.videoIndex || []).filter(v => (v as any).progressSec != null).length : 0);
  }

  // Pending channels
  counts.pendingUpserted = (snapshot.pendingChannels || []).length;

  return { ok: true, counts };
}

export async function applyRestore(snapshot: SettingsSnapshot, mode: RestoreMode, apply: ApplyFlags): Promise<RestoreSummary> {
  if (!snapshot || snapshot.version !== 1) throw new Error('Unsupported snapshot version');
  const db = await openDB();
  const counts: RestoreSummary['counts'] = {};

  // Registries: tags, tag_groups, groups
  if (mode === 'overwrite') {
    await clearStores(db, ['tags', 'tag_groups', 'groups']);
    counts.tagsCleared = await countStore(db, 'tags'); // after clear returns 0
    counts.tagGroupsCleared = await countStore(db, 'tag_groups');
    counts.groupsCleared = await countStore(db, 'groups');
  }
  // Upsert tag groups first (ids referenced by tags)
  if (mode === 'overwrite') {
    await putAll(db, 'tag_groups', snapshot.tagGroups || [], (r: any) => (r && r.id));
    counts.tagGroupsCreated = (snapshot.tagGroups || []).length;
  } else {
    // Merge mode: remap incoming group ids to existing groups by name to avoid duplicates by name
    const existingGroups = await readAll(db, 'tag_groups');
    const byName = new Map<string, any>();
    for (const g of existingGroups) { if (g?.name) byName.set(String(g.name), g); }
    const idMap = new Map<string, string>(); // incomingId -> targetId
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('tag_groups', 'readwrite');
      const os = tx.objectStore('tag_groups');
      for (const g of (snapshot.tagGroups || [])) {
        const gid = String((g as any)?.id || '');
        const name = String((g as any)?.name || '');
        if (!name) continue;
        const local = byName.get(name);
        if (local) {
          idMap.set(gid, String(local.id));
        } else {
          os.put({ id: gid, name, createdAt: (g as any)?.createdAt || Date.now() });
          idMap.set(gid, gid);
          byName.set(name, { id: gid, name });
          counts.tagGroupsCreated = (counts.tagGroupsCreated || 0) + 1;
        }
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    if (Array.isArray(snapshot.tags)) {
      for (const t of snapshot.tags) {
        const gid = (t as any).groupId || null;
        if (gid && idMap.has(String(gid))) (t as any).groupId = idMap.get(String(gid));
      }
    }
  }

  // Tags (name is keyPath)
  if (mode === 'overwrite') {
    await putAll(db, 'tags', (snapshot.tags || []).map(t => ({ ...t, createdAt: t.createdAt || Date.now() })), (r: any) => (r && r.name));
    counts.tagsCreated = (snapshot.tags || []).length;
  } else {
    // Merge mode: tag-name dedupe (case/trim) and assign group remap applied above
    const norm = (s: string) => (s || '').trim().toLowerCase();
    const existingTags = await readAll(db, 'tags');
    const byNorm = new Map<string, any>();
    for (const t of existingTags) { if (t?.name) byNorm.set(norm(String(t.name)), t); }
    const nameMap = new Map<string, string>();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('tags', 'readwrite');
      const os = tx.objectStore('tags');
      for (const t of (snapshot.tags || [])) {
        const name = String((t as any)?.name || '');
        if (!name) continue;
        const key = norm(name);
        const local = byNorm.get(key);
        if (local) {
          const row = { ...local } as any;
          if ((t as any)?.color != null) row.color = (t as any).color;
          if ((t as any)?.groupId != null) row.groupId = (t as any).groupId;
          os.put(row);
          nameMap.set(name, String(local.name));
          counts.tagsUpdated = (counts.tagsUpdated || 0) + 1;
        } else {
          const rec = { name, color: (t as any)?.color, createdAt: (t as any)?.createdAt || Date.now(), groupId: (t as any)?.groupId } as any;
          os.put(rec);
          byNorm.set(key, rec);
          nameMap.set(name, name);
          counts.tagsCreated = (counts.tagsCreated || 0) + 1;
        }
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    (snapshot as any).__tagNameMap = nameMap;
  }

  // Groups (presets) by id
  await putAll(db, 'groups', (snapshot.groups || []).map(g => ({ ...g, createdAt: g.createdAt || Date.now(), updatedAt: Date.now() })), (r: any) => (r && r.id));
  counts.groupsCreated = (snapshot.groups || []).length;

  // Pending channels
  if (Array.isArray(snapshot.pendingChannels) && snapshot.pendingChannels.length) {
    await putAll(db, 'channels_pending', snapshot.pendingChannels, (r: any) => (r && r.key));
    counts.pendingUpserted = snapshot.pendingChannels.length;
  }

  // Channel tags
  if (apply?.channelTags) {
    const items = snapshot.channelIndex || [];
    if (items.length) counts.channelsUpserted = items.length;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['channels'], 'readwrite');
      const cs = tx.objectStore('channels');
      for (const it of items) {
        const id = (it?.id || '').toString(); if (!id) continue;
        const g = cs.get(id);
        g.onsuccess = () => {
          const prev = (g.result as any) || { id };
          const next = { ...prev } as any;
          let snapTags: string[] = Array.isArray(it.tags) ? uniq(it.tags.filter(Boolean).map(String)) : [];
          const map: Map<string,string> | undefined = (snapshot as any).__tagNameMap;
          if (map && snapTags.length) snapTags = snapTags.map(t => map.get(t) || t);
          if (mode === 'overwrite') next.tags = snapTags;
          else next.tags = uniq([...(Array.isArray(prev.tags) ? prev.tags : []), ...snapTags]);
          cs.put(next);
        };
        g.onerror = () => reject(g.error);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    counts.channelTagUpdates = (items || []).filter(it => Array.isArray(it.tags) && it.tags.length).length;
  }

  // Video tags/sources/progress
  if (apply?.videoTags || apply?.sources || apply?.progress) {
    const items = snapshot.videoIndex || [];
    if (items.length) counts.videosUpserted = items.length;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['videos'], 'readwrite');
      const vs = tx.objectStore('videos');
      for (const it of items) {
        const id = (it?.id || '').toString(); if (!id) continue;
        const g = vs.get(id);
        g.onsuccess = () => {
          const prev = (g.result as any) || { id };
          const next = { ...prev } as any;
          if (apply.videoTags) {
            let snapTags: string[] = Array.isArray(it.tags) ? uniq(it.tags.filter(Boolean).map(String)) : [];
            const map: Map<string,string> | undefined = (snapshot as any).__tagNameMap;
            if (map && snapTags.length) snapTags = snapTags.map(t => map.get(t) || t);
            if (mode === 'overwrite') next.tags = snapTags;
            else next.tags = uniq([...(Array.isArray(prev.tags) ? prev.tags : []), ...snapTags]);
            counts.videoTagUpdates = (counts.videoTagUpdates || 0) + (snapTags.length ? 1 : 0);
          }
          if (apply.sources) {
            const src = Array.isArray(it.sources) ? it.sources.map(s => ({ type: String(s?.type || ''), id: s?.id ?? null })) : [];
            if (mode === 'overwrite') next.sources = src;
            else {
              const have = Array.isArray(prev.sources) ? prev.sources : [];
              const seen = new Set<string>();
              const out: any[] = [];
              const push = (s: any) => { const key = `${s?.type}:${s?.id ?? ''}`; if (!seen.has(key)) { seen.add(key); out.push({ type: s?.type, id: s?.id ?? null }); } };
              for (const a of have) push(a);
              for (const b of src) push(b);
              next.sources = out;
            }
            counts.sourcesUpdated = (counts.sourcesUpdated || 0) + (src.length ? 1 : 0);
          }
          if (apply.progress) {
            const ps = (it as any).progressSec;
            if (ps != null && Number.isFinite(Number(ps))) {
              next.progress = { ...(prev.progress || {}), sec: Math.max(0, Math.floor(Number(ps))) };
              counts.progressUpdated = (counts.progressUpdated || 0) + 1;
            }
          }
          vs.put(next);
        };
        g.onerror = () => reject(g.error);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  return { ok: true, counts };
}

// ---------- IDB helpers ----------
async function readAll(db: IDBDatabase, store: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const os = tx.objectStore(store);
    const req = (os as any).getAll ? (os as any).getAll() : os.openCursor();
    const out: any[] = [];
    if ('getAll' in os) {
      (req as IDBRequest).onsuccess = () => resolve(((req as any).result as any[]) || []);
      (req as IDBRequest).onerror = () => reject((req as any).error);
    } else {
      (req as IDBRequest).onsuccess = () => {
        const c = (req as any).result as IDBCursorWithValue | null;
        if (!c) { resolve(out); return; }
        out.push(c.value);
        c.continue();
      };
      (req as IDBRequest).onerror = () => reject((req as any).error);
    }
  });
}

async function putAll(db: IDBDatabase, store: string, rows: any[], keyOf: (r: any) => any) {
  if (!rows?.length) return;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    for (const r of rows) { const key = keyOf(r); if (key) os.put(r); }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function clearStores(db: IDBDatabase, stores: string[]) {
  if (!stores?.length) return;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(stores as any, 'readwrite');
    for (const s of stores) (tx.objectStore(s) as IDBObjectStore).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function countStore(db: IDBDatabase, store: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const os = tx.objectStore(store);
    const req = os.count();
    req.onsuccess = () => resolve(Number(req.result || 0));
    req.onerror = () => reject(req.error);
  });
}

import type { Group as GroupRec, Condition } from '../shared/conditions';
import type { TagRec, TagGroupRec, RuleRec, CollectionRec, RecSet, RecEntry, PageRecord } from '../types/messages';

// Chrome storage keys
const KEY = {
  tags: 'settings.tags',
  tagGroups: 'settings.tagGroups',
  groups: 'settings.groups',
  rules: 'settings.rules',
  collections: 'settings.collections',
  recSets: 'settings.recSets',
  recommender: 'settings.recommender', // { respectDontRecommend: boolean }
  channelTagsById: 'settings.channelTagsById',
  rev: 'settings.rev',
  updatedAt: 'settings.updatedAt',
  useLocal: 'settings.useLocal',
  migratedAt: 'settings.migratedAt',
};

type ChannelTagsMap = Record<string, string[]>;

type SettingsBundle = {
  tags: TagRec[];
  tagGroups: TagGroupRec[];
  groups: GroupRec[];
  rules: RuleRec[];
  collections: CollectionRec[];
  recSets: RecSet[];
  recommender: { respectDontRecommend?: boolean } | undefined;
  channelTagsById: ChannelTagsMap;
  rev: number;
  updatedAt: number;
};

let lockPromise: Promise<void> | null = null;
let lockRelease: (() => void) | null = null;
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  // Simple in-memory mutex suitable for the background SW
  while (lockPromise) await lockPromise;
  lockPromise = new Promise<void>((res) => { lockRelease = res; });
  try { return await fn(); }
  finally { const r = lockRelease; lockRelease = null; lockPromise = null; if (r) r(); }
}

async function readAll(): Promise<SettingsBundle> {
  const o = await chrome.storage.local.get([KEY.tags, KEY.tagGroups, KEY.groups, KEY.rules, KEY.collections, KEY.recSets, KEY.recommender, KEY.channelTagsById, KEY.rev, KEY.updatedAt]);
  const tags: TagRec[] = Array.isArray(o[KEY.tags]) ? o[KEY.tags] : [];
  const tagGroups: TagGroupRec[] = Array.isArray(o[KEY.tagGroups]) ? o[KEY.tagGroups] : [];
  const groups: GroupRec[] = Array.isArray(o[KEY.groups]) ? o[KEY.groups] : [];
  const rules: RuleRec[] = Array.isArray(o[KEY.rules]) ? o[KEY.rules] : [];
  const collections: CollectionRec[] = Array.isArray(o[KEY.collections]) ? o[KEY.collections] : [];
  const recSets: RecSet[] = Array.isArray(o[KEY.recSets]) ? o[KEY.recSets] : [];
  const recommender: { respectDontRecommend?: boolean } | undefined = (o[KEY.recommender] && typeof o[KEY.recommender] === 'object') ? o[KEY.recommender] : undefined;
  const channelTagsById: ChannelTagsMap = o[KEY.channelTagsById] && typeof o[KEY.channelTagsById] === 'object' ? (o[KEY.channelTagsById] as ChannelTagsMap) : {};
  const rev: number = Number.isFinite(o[KEY.rev]) ? Number(o[KEY.rev]) : 0;
  const updatedAt: number = Number.isFinite(o[KEY.updatedAt]) ? Number(o[KEY.updatedAt]) : 0;
  return { tags, tagGroups, groups, rules, collections, recSets, recommender, channelTagsById, rev, updatedAt };
}

async function writeAll(next: SettingsBundle): Promise<void> {
  await chrome.storage.local.set({
    [KEY.tags]: next.tags,
    [KEY.tagGroups]: next.tagGroups,
    [KEY.groups]: next.groups,
    [KEY.rules]: next.rules,
    [KEY.collections]: next.collections,
    [KEY.recSets]: next.recSets,
    [KEY.recommender]: next.recommender,
    [KEY.channelTagsById]: next.channelTagsById,
    [KEY.rev]: next.rev,
    [KEY.updatedAt]: next.updatedAt,
  });
}

export async function ensureUseLocalDefault(): Promise<void> {
  const o = await chrome.storage.local.get(KEY.useLocal);
  if (typeof o[KEY.useLocal] !== 'boolean') {
    await chrome.storage.local.set({ [KEY.useLocal]: true });
  }
}

export async function isUseLocalEnabled(): Promise<boolean> {
  const o = await chrome.storage.local.get(KEY.useLocal);
  return !!o[KEY.useLocal];
}

export async function setUseLocalEnabled(next: boolean): Promise<void> {
  await chrome.storage.local.set({ [KEY.useLocal]: !!next });
}

export async function listTagsLocal(): Promise<TagRec[]> {
  const { tags } = await readAll();
  return tags.slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

export async function createTagLocal(name: string, color?: string): Promise<void> {
  const nm = (name || '').trim();
  if (!nm) return;
  await withLock(async () => {
    const cur = await readAll();
    const exists = cur.tags.some(t => String(t.name).toLowerCase() === nm.toLowerCase());
    if (exists) return;
    cur.tags.push({ name: nm, color, createdAt: Date.now() });
    cur.rev += 1; cur.updatedAt = Date.now();
    await writeAll(cur);
  });
}

export async function renameTagLocal(oldName: string, newName: string): Promise<void> {
  const from = (oldName || '').trim();
  const to = (newName || '').trim();
  if (!from || !to || from === to) return;
  await withLock(async () => {
    let cur = await readAll();
    // Update tag list
    const idx = cur.tags.findIndex(t => String(t.name) === from);
    if (idx !== -1) {
      const { name: _omit, ...rest } = cur.tags[idx] as any;
      cur.tags[idx] = { ...rest, name: to } as any;
    }
    // Update channelTagsById occurrences
    const map = cur.channelTagsById || {};
    for (const id of Object.keys(map)) {
      const arr = Array.isArray(map[id]) ? map[id].slice() : [];
      let changed = false;
      for (let i = 0; i < arr.length; i++) if (arr[i] === from) { arr[i] = to; changed = true; }
      if (changed) map[id] = Array.from(new Set(arr));
    }
    cur.channelTagsById = map;
    cur.rev += 1; cur.updatedAt = Date.now();
    await writeAll(cur);
  });
}

export async function deleteTagLocal(name: string): Promise<void> {
  const nm = (name || '').trim();
  if (!nm) return;
  await withLock(async () => {
    const cur = await readAll();
    cur.tags = cur.tags.filter(t => String(t.name) !== nm);
    // Remove from channel tags
    const map = cur.channelTagsById || {};
    for (const id of Object.keys(map)) map[id] = (map[id] || []).filter(t => t !== nm);
    cur.channelTagsById = map;
    cur.rev += 1; cur.updatedAt = Date.now();
    await writeAll(cur);
  });
}

export async function setTagGroupLocal(name: string, groupId: string | null): Promise<void> {
  const nm = (name || '').trim();
  await withLock(async () => {
    const cur = await readAll();
    const idx = cur.tags.findIndex(t => String(t.name) === nm);
    if (idx !== -1) {
      const next = { ...cur.tags[idx] } as any;
      if (groupId) next.groupId = groupId; else delete next.groupId;
      cur.tags[idx] = next;
      cur.rev += 1; cur.updatedAt = Date.now();
      await writeAll(cur);
    }
  });
}

export async function listTagGroupsLocal(): Promise<TagGroupRec[]> {
  const { tagGroups } = await readAll();
  return tagGroups.slice();
}

export async function createTagGroupLocal(name: string): Promise<string> {
  const nm = (name || '').trim();
  if (!nm) return '';
  const id = crypto.randomUUID();
  await withLock(async () => {
    const cur = await readAll();
    cur.tagGroups.push({ id, name: nm, createdAt: Date.now() });
    cur.rev += 1; cur.updatedAt = Date.now();
    await writeAll(cur);
  });
  return id;
}

export async function renameTagGroupLocal(id: string, name: string): Promise<void> {
  const gid = (id || '').trim(); const nm = (name || '').trim();
  if (!gid || !nm) return;
  await withLock(async () => {
    const cur = await readAll();
    const idx = cur.tagGroups.findIndex(g => String(g.id) === gid);
    if (idx !== -1) {
      const g = { ...cur.tagGroups[idx] };
      (g as any).name = nm;
      cur.tagGroups[idx] = g;
      cur.rev += 1; cur.updatedAt = Date.now();
      await writeAll(cur);
    }
  });
}

export async function deleteTagGroupLocal(id: string): Promise<void> {
  const gid = (id || '').trim();
  if (!gid) return;
  await withLock(async () => {
    const cur = await readAll();
    cur.tagGroups = cur.tagGroups.filter(g => String(g.id) !== gid);
    // Clear groupId references from tags
    cur.tags = cur.tags.map(t => {
      const n: any = { ...t };
      if (n.groupId === gid) delete n.groupId;
      return n;
    });
    cur.rev += 1; cur.updatedAt = Date.now();
    await writeAll(cur);
  });
}

export async function updateTagGroupLocal(id: string, patch: Partial<TagGroupRec>): Promise<void> {
  const gid = (id || '').trim();
  if (!gid || !patch || typeof patch !== 'object') return;
  await withLock(async () => {
    const cur = await readAll();
    const idx = cur.tagGroups.findIndex(g => String(g.id) === gid);
    if (idx === -1) return;
    const next = { ...cur.tagGroups[idx], ...patch, id: gid } as TagGroupRec;
    cur.tagGroups[idx] = next;
    cur.rev += 1; cur.updatedAt = Date.now();
    await writeAll(cur);
  });
}

export async function listGroupsLocal(): Promise<GroupRec[]> {
  const { groups } = await readAll();
  return groups.slice().sort((a,b)=> String(a.name).localeCompare(String(b.name)));
}

// ---- Rules (local: chrome.storage.local) ----
export async function listRulesLocal(): Promise<RuleRec[]> {
  const { rules } = await readAll();
  // Keep original order; newest last
  return rules.slice();
}

// ---- Collections (local: chrome.storage.local) ----
export async function listCollectionsLocal(): Promise<CollectionRec[]> {
  const { collections } = await readAll();
  return collections.slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

export async function createCollectionLocal(name: string, parentId?: string | null): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const rec: CollectionRec = { id, name: (name || '').trim() || 'collection', parentId: parentId ?? null, color: null, createdAt: now, updatedAt: now };
  await withLock(async () => {
    const cur = await readAll();
    cur.collections.push(rec);
    cur.rev += 1; cur.updatedAt = Date.now();
    await writeAll(cur);
  });
  return id;
}

export async function updateCollectionLocal(id: string, patch: Partial<CollectionRec>): Promise<void> {
  const cid = (id || '').trim(); if (!cid) return;
  await withLock(async () => {
    const cur = await readAll();
    const idx = cur.collections.findIndex(c => String(c.id) === cid);
    if (idx === -1) return;
    const prev = cur.collections[idx];
    const next: CollectionRec = {
      ...prev,
      ...patch,
      id: prev.id,
      name: (patch.name ?? prev.name) as string,
      parentId: (patch.parentId ?? prev.parentId) as (string | null | undefined),
      updatedAt: Date.now(),
    };
    cur.collections[idx] = next;
    cur.rev += 1; cur.updatedAt = Date.now();
    await writeAll(cur);
  });
}

export async function deleteCollectionLocal(id: string): Promise<void> {
  const cid = (id || '').trim(); if (!cid) return;
  await withLock(async () => {
    const cur = await readAll();
    cur.collections = cur.collections.filter(c => String(c.id) !== cid);
    // Also detach any children referencing this as parent
    cur.collections = cur.collections.map(c => (c.parentId === cid ? { ...c, parentId: null, updatedAt: Date.now() } : c));
    cur.rev += 1; cur.updatedAt = Date.now();
    await writeAll(cur);
  });
}

// Overwrite entire collections registry (preserve incoming ids). Used by restore/apply (overwrite mode) and merge helper.
export async function setCollectionsLocal(list: CollectionRec[]): Promise<void> {
  await withLock(async () => {
    const cur = await readAll();
    cur.collections = Array.isArray(list) ? list.slice() : [];
    cur.rev += 1; cur.updatedAt = Date.now();
    await writeAll(cur);
  });
}

export async function createRuleLocal(input: { name: string; groupId: string; action: RuleRec['action']; channelIds?: string[]; enabled?: boolean }): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const rec: RuleRec = {
    id,
    name: (input.name || '').trim() || 'rule',
    groupId: String(input.groupId || ''),
    action: input.action,
    channelIds: Array.isArray(input.channelIds) ? Array.from(new Set(input.channelIds.map(s => String(s || '').trim()).filter(Boolean))) : undefined,
    enabled: input.enabled !== false,
    createdAt: now,
    updatedAt: now,
  };
  await withLock(async () => {
    const cur = await readAll();
    cur.rules.push(rec);
    cur.rev += 1; cur.updatedAt = Date.now();
    await writeAll(cur);
  });
  return id;
}

export async function updateRuleLocal(id: string, patch: Partial<RuleRec>): Promise<void> {
  const rid = (id || '').trim(); if (!rid) return;
  await withLock(async () => {
    const cur = await readAll();
    const idx = cur.rules.findIndex(r => String(r.id) === rid);
    if (idx === -1) return;
    const prev = cur.rules[idx];
    const next: RuleRec = {
      ...prev,
      ...patch,
      id: prev.id,
      name: (patch.name ?? prev.name),
      groupId: (patch.groupId ?? prev.groupId) as string,
      channelIds: Array.isArray(patch.channelIds) ? Array.from(new Set(patch.channelIds.map(s => String(s || '').trim()).filter(Boolean))) : prev.channelIds,
      action: (patch.action ? patch.action as any : prev.action),
      enabled: (patch.enabled ?? prev.enabled),
      updatedAt: Date.now(),
    };
    cur.rules[idx] = next;
    cur.rev += 1; cur.updatedAt = Date.now();
    await writeAll(cur);
  });
}

export async function deleteRuleLocal(id: string): Promise<void> {
  const rid = (id || '').trim(); if (!rid) return;
  await withLock(async () => {
    const cur = await readAll();
    cur.rules = cur.rules.filter(r => String(r.id) !== rid);
    cur.rev += 1; cur.updatedAt = Date.now();
    await writeAll(cur);
  });
}

export async function createGroupLocal(name: string, condition: Condition): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const rec: GroupRec = { id, name, condition, createdAt: now, updatedAt: now, scrape: false } as any;
  await withLock(async () => {
    const cur = await readAll();
    cur.groups.push(rec);
    cur.rev += 1; cur.updatedAt = Date.now();
    await writeAll(cur);
  });
  return id;
}

export async function updateGroupLocal(id: string, patch: Partial<GroupRec>): Promise<void> {
  const gid = (id || '').trim();
  await withLock(async () => {
    const cur = await readAll();
    const idx = cur.groups.findIndex(g => String(g.id) === gid);
    if (idx === -1) return;
    const next = { ...cur.groups[idx], ...patch, id: gid, updatedAt: Date.now() } as GroupRec;
    cur.groups[idx] = next;
    cur.rev += 1; cur.updatedAt = Date.now();
    await writeAll(cur);
  });
}

export async function deleteGroupLocal(id: string): Promise<void> {
  const gid = (id || '').trim();
  await withLock(async () => {
    const cur = await readAll();
    cur.groups = cur.groups.filter(g => String(g.id) !== gid);
    cur.rev += 1; cur.updatedAt = Date.now();
    await writeAll(cur);
  });
}

export async function getChannelTagsMap(): Promise<ChannelTagsMap> {
  const { channelTagsById } = await readAll();
  return channelTagsById || {};
}

export async function applyChannelTagsLocal(ids: string[], addIds: string[] = [], removeIds: string[] = []): Promise<void> {
  const add = Array.from(new Set(addIds.map(s => (s ?? '').trim()).filter(Boolean)));
  const rem = new Set(removeIds.map(s => (s ?? '').trim()).filter(Boolean));
  if (!ids?.length || (add.length === 0 && rem.size === 0)) return;
  await withLock(async () => {
    const cur = await readAll();
    const map = { ...(cur.channelTagsById || {}) } as ChannelTagsMap;
    for (const idRaw of ids) {
      const id = String(idRaw || '').trim();
      if (!id) continue;
      const prev = Array.isArray(map[id]) ? map[id].slice() : [];
      let next = prev.slice();
      for (const t of add) if (!next.includes(t)) next.push(t);
      if (rem.size) next = next.filter(t => !rem.has(t));
      map[id] = next;
    }
    cur.channelTagsById = map;
    cur.rev += 1; cur.updatedAt = Date.now();
    await writeAll(cur);
  });
}

// Migration helpers
export async function hasLocalSettingsInitialized(): Promise<boolean> {
  const o = await chrome.storage.local.get([KEY.tags, KEY.tagGroups, KEY.groups, KEY.channelTagsById]);
  const tagsOk = Array.isArray(o[KEY.tags]);
  const tgsOk = Array.isArray(o[KEY.tagGroups]);
  const grOk = Array.isArray(o[KEY.groups]);
  const chOk = !!o[KEY.channelTagsById];
  return tagsOk || tgsOk || grOk || chOk;
}

export async function writeInitialLocalSettings(payload: Partial<SettingsBundle>): Promise<void> {
  // Does not bump rev; sets rev=1 to mark initialized
  const tags = Array.isArray(payload.tags) ? payload.tags : [];
  const tagGroups = Array.isArray(payload.tagGroups) ? payload.tagGroups : [];
  const groups = Array.isArray(payload.groups) ? payload.groups : [];
  const rules = Array.isArray(payload.rules) ? payload.rules : [];
  const channelTagsById = (payload.channelTagsById || {}) as ChannelTagsMap;
  const recSets: RecSet[] = Array.isArray((payload as any).recSets) ? ((payload as any).recSets as RecSet[]) : [];
  const recommender = (payload as any).recommender && typeof (payload as any).recommender === 'object' ? (payload as any).recommender : undefined;
  const now = Date.now();
  await chrome.storage.local.set({
    [KEY.tags]: tags,
    [KEY.tagGroups]: tagGroups,
    [KEY.groups]: groups,
    [KEY.rules]: rules,
    [KEY.recSets]: recSets,
    [KEY.recommender]: recommender,
    [KEY.channelTagsById]: channelTagsById,
    [KEY.rev]: 1,
    [KEY.updatedAt]: now,
    [KEY.migratedAt]: now,
  });
}

export async function getSettingsSnapshotForDownload(extra?: Partial<SettingsBundle>): Promise<SettingsBundle> {
  const cur = await readAll();
  return {
    tags: cur.tags,
    tagGroups: cur.tagGroups,
    groups: cur.groups,
    rules: cur.rules,
    collections: cur.collections,
    recSets: cur.recSets,
    recommender: cur.recommender,
    channelTagsById: cur.channelTagsById,
    rev: cur.rev,
    updatedAt: cur.updatedAt,
    ...(extra || {}),
  } as SettingsBundle;
}

// ---- Rec Sets (local: chrome.storage.local) ----
export async function listRecSetsLocal(): Promise<RecSet[]> {
  const { recSets } = await readAll();
  return Array.isArray(recSets) ? recSets.slice() : [];
}

export async function createRecSetLocal(name: string, pageSize: number, entries: RecEntry[] = []): Promise<string> {
  const id = crypto.randomUUID();
  const rec: RecSet = { id, name: String(name || ''), pageSize: Math.max(0, Math.floor(pageSize || 0)), entries: entries.slice(), history: [] };
  await withLock(async () => {
    const cur = await readAll();
    const next = { ...cur, recSets: [...(cur.recSets || []), rec] } as SettingsBundle;
    next.rev += 1; next.updatedAt = Date.now();
    await writeAll(next);
  });
  return id;
}

export async function updateRecSetLocal(id: string, patch: Partial<RecSet>): Promise<void> {
  const rid = String(id || ''); if (!rid) return;
  await withLock(async () => {
    const cur = await readAll();
    const list = (cur.recSets || []).slice();
    const idx = list.findIndex(r => String(r.id) === rid);
    if (idx === -1) return;
    const prev = list[idx];
    const next: RecSet = {
      ...prev,
      ...(patch || {}),
      id: prev.id,
      name: String((patch as any)?.name ?? prev.name),
      pageSize: Math.max(0, Math.floor(((patch as any)?.pageSize ?? prev.pageSize ?? 0))),
      entries: Array.isArray((patch as any)?.entries) ? ((patch as any).entries as RecEntry[]).slice() : prev.entries,
      history: Array.isArray((patch as any)?.history) ? ((patch as any).history as PageRecord[]).slice() : (prev.history || []),
    };
    list[idx] = next;
    const out = { ...cur, recSets: list } as SettingsBundle;
    out.rev += 1; out.updatedAt = Date.now();
    await writeAll(out);
  });
}

export async function deleteRecSetLocal(id: string): Promise<void> {
  const rid = String(id || ''); if (!rid) return;
  await withLock(async () => {
    const cur = await readAll();
    const list = (cur.recSets || []).filter(r => String(r.id) !== rid);
    const out = { ...cur, recSets: list } as SettingsBundle;
    out.rev += 1; out.updatedAt = Date.now();
    await writeAll(out);
  });
}

export async function duplicateRecSetLocal(id: string, name?: string): Promise<string | null> {
  const rid = String(id || ''); if (!rid) return null;
  let newId: string | null = null;
  await withLock(async () => {
    const cur = await readAll();
    const src = (cur.recSets || []).find(r => String(r.id) === rid);
    if (!src) return;
    const copy: RecSet = { id: crypto.randomUUID(), name: String(name || (src.name + ' (copy)')), pageSize: src.pageSize, entries: src.entries.slice(), history: [] };
    newId = copy.id;
    const out = { ...cur, recSets: [...(cur.recSets || []), copy] } as SettingsBundle;
    out.rev += 1; out.updatedAt = Date.now();
    await writeAll(out);
  });
  return newId;
}

export async function listRecSetHistoryLocal(recSetId: string): Promise<PageRecord[]> {
  const rid = String(recSetId || '');
  const { recSets } = await readAll();
  const rec = (recSets || []).find(r => String(r.id) === rid);
  return Array.isArray(rec?.history) ? rec!.history!.slice() : [];
}

export async function appendRecSetHistoryLocal(recSetId: string, record: PageRecord, cap: number = 100): Promise<void> {
  if (!record?.videoIds || record.videoIds.length === 0) return; // skip empty outputs
  const rid = String(recSetId || ''); if (!rid) return;
  await withLock(async () => {
    const cur = await readAll();
    const list = (cur.recSets || []).slice();
    const idx = list.findIndex(r => String(r.id) === rid);
    if (idx === -1) return;
    const prev = list[idx];
    const history = Array.isArray(prev.history) ? prev.history.slice() : [];
    history.unshift(record);
    if (history.length > cap) history.length = cap;
    list[idx] = { ...prev, history } as RecSet;
    const out = { ...cur, recSets: list } as SettingsBundle;
    out.rev += 1; out.updatedAt = Date.now();
    await writeAll(out);
  });
}

export async function deleteRecSetHistoryRecordLocal(recordId: string): Promise<void> {
  const rid = String(recordId || ''); if (!rid) return;
  await withLock(async () => {
    const cur = await readAll();
    const list = (cur.recSets || []).map(r => ({ ...r, history: Array.isArray(r.history) ? r.history.filter(h => String(h.id) !== rid) : r.history }));
    const out = { ...cur, recSets: list } as SettingsBundle;
    out.rev += 1; out.updatedAt = Date.now();
    await writeAll(out);
  });
}

export async function getRecSetHistoryRecordLocal(recordId: string): Promise<PageRecord | null> {
  const rid = String(recordId || ''); if (!rid) return null;
  const { recSets } = await readAll();
  for (const rs of (recSets || [])) {
    const found = (rs.history || []).find(h => String(h.id) === rid);
    if (found) return { ...found };
  }
  return null;
}

// ---- Recommender global settings ----
export async function getRecommenderSettingsLocal(): Promise<{ respectDontRecommend: boolean }> {
  const { recommender } = await readAll();
  return { respectDontRecommend: !!(recommender?.respectDontRecommend ?? true) };
}

export async function setRecommenderSettingsLocal(patch: Partial<{ respectDontRecommend: boolean }>): Promise<void> {
  await withLock(async () => {
    const cur = await readAll();
    const next = { ...(cur.recommender || {}) } as any;
    if (typeof patch?.respectDontRecommend === 'boolean') next.respectDontRecommend = !!patch.respectDontRecommend;
    const out = { ...cur, recommender: next } as SettingsBundle;
    out.rev += 1; out.updatedAt = Date.now();
    await writeAll(out);
  });
}

// Utility: check if a tag exists in settings (by case-insensitive name)
export async function hasTagLocal(name: string): Promise<boolean> {
  const nm = String(name || '').toLowerCase();
  const { tags } = await readAll();
  return (tags || []).some(t => String(t.name || '').toLowerCase() === nm);
}

import { renameTag as renameTagInDB, deleteTag as deleteTagInDB } from './db';
import { upsertVideo, upsertVideosBulk, moveToTrash, restoreFromTrash, applyTags, listChannels, wipeSourcesDuplicates, applyYouTubeVideo, openDB, missingChannelIds, applyYouTubeChannel, recomputeVideoTagsForAllChannels, recomputeVideoTagsForChannels, recomputeVideoTopicsMeta, readVideoTopicsMeta, listChannelIdsNeedingFetch, markChannelScraped, upsertChannelStub, moveChannelsToTrash, restoreChannelsFromTrash, listChannelsTrash, upsertPendingChannel, resolvePendingChannel, listPendingChannels, applySubscribedSet, purgeVideosFromTrash, purgeChannelsFromTrash, deletePendingChannel, updateLatestForSource, getMetaValue, recomputeChannelVideoTopicsForAllChannels, markChannelsSubscribed } from './db';
import type { Msg } from '../types/messages';
import { dlog, derr } from '../types/debug';
import { listTagsLocal as listTags, createTagLocal as createTag, renameTagLocal as renameTag, deleteTagLocal as deleteTag, setTagGroupLocal as setTagGroup, listTagGroupsLocal as listTagGroups, createTagGroupLocal as createTagGroup, renameTagGroupLocal as renameTagGroup, deleteTagGroupLocal as deleteTagGroup, listGroupsLocal as listGroups, createGroupLocal as createGroup, updateGroupLocal as updateGroup, deleteGroupLocal as deleteGroup, getChannelTagsMap, applyChannelTagsLocal, ensureUseLocalDefault, isUseLocalEnabled, hasLocalSettingsInitialized, writeInitialLocalSettings, getSettingsSnapshotForDownload } from './settingsStorage';
import { matches, type Group as GroupRec } from '../shared/conditions';
import { registerSettingsProducer, saveSettingsNow, getClientIdState, setClientId, type SettingsSnapshot, restoreSettings, listAppDataFiles, downloadAppDataFileBase64, downloadAppDataFileRangeBase64, queueSettingsBackup, deleteAppDataFile, upsertAppDataTextFile, downloadSnapshotByName, getCurrentSettingsSnapshot, saveSnapshotWithName } from './driveBackup';
import { recordEvent, finalizeCommitAndFlushIfAny, listCommits as listHistoryCommits, getCommitEvents as getHistoryCommitEvents, getCommit as getHistoryCommit, queueCommitFlush, purgeHistoryUpToTs, replayUnsyncedCommitsToDrive } from './events';
import { applyRestore, dryRunRestoreApply } from './restore';

// ---- Default Tags / Groups ----
const DEFAULT_TAG_GROUP_ID = 'tagGroup.default';
const DEFAULT_TAG_GROUP_NAME = 'default tags';
const DEFAULT_RATING_TAG_GROUP_ID = 'tagGroup.rating';
const DEFAULT_RATING_TAG_GROUP_NAME = 'Rating';
const DEFAULT_TAGS = [
  { name: 'no fetch', manual: true, scope: 'both' as const },
  { name: 'hide', manual: true, scope: 'video' as const },
  { name: 'subscribed', manual: false, scope: 'channel' as const },
  { name: 'unsubscribed', manual: false, scope: 'channel' as const },
  { name: 'tagged', manual: true, scope: 'channel' as const },
  { name: 'scrape', manual: true, scope: 'channel' as const },
  // Rating defaults (manual, both scopes)
  { name: '0', manual: true, scope: 'both' as const, groupId: DEFAULT_RATING_TAG_GROUP_ID },
  { name: '1', manual: true, scope: 'both' as const, groupId: DEFAULT_RATING_TAG_GROUP_ID },
  { name: '2', manual: true, scope: 'both' as const, groupId: DEFAULT_RATING_TAG_GROUP_ID },
  { name: '3', manual: true, scope: 'both' as const, groupId: DEFAULT_RATING_TAG_GROUP_ID },
  { name: '4', manual: true, scope: 'both' as const, groupId: DEFAULT_RATING_TAG_GROUP_ID },
  { name: '5', manual: true, scope: 'both' as const, groupId: DEFAULT_RATING_TAG_GROUP_ID },
  { name: '6', manual: true, scope: 'both' as const, groupId: DEFAULT_RATING_TAG_GROUP_ID },
  { name: '7', manual: true, scope: 'both' as const, groupId: DEFAULT_RATING_TAG_GROUP_ID },
  { name: '8', manual: true, scope: 'both' as const, groupId: DEFAULT_RATING_TAG_GROUP_ID },
  { name: '9', manual: true, scope: 'both' as const, groupId: DEFAULT_RATING_TAG_GROUP_ID },
  { name: '10', manual: true, scope: 'both' as const, groupId: DEFAULT_RATING_TAG_GROUP_ID },
];
const DEFAULT_PRESET_ID = 'group.default.scrapable';
const DEFAULT_PRESET_NAME = 'scrapable channels';

function isDefaultTag(name: string): boolean {
  const nm = String(name || '').toLowerCase();
  return DEFAULT_TAGS.some(t => t.name === nm);
}
function sanitizeVideoTagAdds(names: string[]): string[] {
  const banned = new Set(['scrape', 'tagged', 'subscribed', 'unsubscribed']);
  return Array.from(new Set((names || []).map(s => String(s || '').trim()).filter(Boolean))).filter(n => !banned.has(n));
}
function sanitizeChannelTagAdds(names: string[]): string[] {
  const banned = new Set(['subscribed', 'unsubscribed']);
  return Array.from(new Set((names || []).map(s => String(s || '').trim()).filter(Boolean))).filter(n => !banned.has(n));
}
function sanitizeChannelTagRemoves(names: string[]): string[] {
  const banned = new Set(['subscribed', 'unsubscribed']);
  return Array.from(new Set((names || []).map(s => String(s || '').trim()).filter(Boolean))).filter(n => !banned.has(n));
}
async function channelIdsWithTag(tagName: string): Promise<Set<string>> {
  const needle = String(tagName || '').toLowerCase();
  const map = await getChannelTagsMap();
  const out = new Set<string>();
  for (const [id, tags] of Object.entries(map)) {
    if ((tags || []).some(t => String(t || '').toLowerCase() === needle)) out.add(id);
  }
  return out;
}

// Click the extension icon to trigger scrape in active tab
chrome.action?.onClicked.addListener((tab) => {
  try {
    if (!tab?.id) return;
    chrome.tabs.sendMessage(tab.id, { type: 'scrape/NOW', payload: {} }, () => void 0);
  } catch (e) {
    // ignore
  }
});

// --- Utils ---
// Track pending upserts to surface queue depth in logs/UI
let pendingUpserts = 0;
function utf8ToB64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// ---- Channel lookup helpers (IDB) ----
async function getChannelById(id: string): Promise<any | null> {
  try {
    const db = await openDB();
    return await new Promise<any | null>((resolve, reject) => {
      const tx = db.transaction('channels', 'readonly');
      const os = tx.objectStore('channels');
      const g = os.get(String(id));
      g.onsuccess = () => resolve((g.result as any) || null);
      g.onerror = () => reject(g.error);
    });
  } catch { return null; }
}
async function getChannelByHandle(handle: string): Promise<any | null> {
  const h = (handle || '').trim();
  if (!h) return null;
  const norm = h.startsWith('@') ? h : ('@' + h);
  try {
    const db = await openDB();
    return await new Promise<any | null>((resolve, reject) => {
      const tx = db.transaction('channels', 'readonly');
      const os = tx.objectStore('channels');
      const cur = os.openCursor();
      let found: any = null;
      cur.onsuccess = () => {
        const c = cur.result as IDBCursorWithValue | null;
        if (!c) { resolve(found); return; }
        const row: any = c.value || {};
        const cu = String(row?.customUrl || '').trim().toLowerCase();
        if (cu && (cu === norm.toLowerCase())) { found = row; resolve(found); return; }
        c.continue();
      };
      cur.onerror = () => reject(cur.error);
    });
  } catch { return null; }
}
async function getChannelByNameExact(name: string): Promise<any | null> {
  const nm = (name || '').trim();
  if (!nm) return null;
  try {
    const db = await openDB();
    return await new Promise<any | null>((resolve, reject) => {
      const tx = db.transaction('channels', 'readonly');
      const os = tx.objectStore('channels');
      let idx: IDBIndex | null = null;
      try { idx = os.index('byName'); } catch { idx = null; }
      if (!idx) { resolve(null); return; }
      const req = idx.get(nm);
      req.onsuccess = () => resolve((req.result as any) || null);
      req.onerror = () => reject(req.error);
    });
  } catch { return null; }
}
async function setChannelHandleIfMissing(id: string, handle: string): Promise<void> {
  const norm = (handle || '').trim();
  if (!norm) return;
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('channels', 'readwrite');
      const os = tx.objectStore('channels');
      const g = os.get(String(id));
      g.onsuccess = () => {
        const row = ((g.result as any) || {});
        const cur = String(row?.customUrl || '').trim();
        if (!cur) { row.customUrl = norm.startsWith('@') ? norm : ('@' + norm); os.put(row); }
        (tx as any).commit?.();
      };
      g.onerror = () => reject(g.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* ignore */ }
}

// Track a transient session for resolveBatch to avoid retrying same keys until idle
let pendingResolveSession: { tried: Set<string>; timer?: number | null } | null = null;
function ensureResolveSession(): { tried: Set<string> } {
  if (!pendingResolveSession) pendingResolveSession = { tried: new Set<string>(), timer: null };
  // bump idle-clear timer
  try { if (pendingResolveSession.timer != null) { clearTimeout(pendingResolveSession.timer as any); } } catch {}
  pendingResolveSession.timer = setTimeout(() => { try { pendingResolveSession = null; } catch {} }, 10000) as any;
  return pendingResolveSession;
}

// --- Google Drive backup wiring ---
registerSettingsProducer(async (): Promise<SettingsSnapshot> => {
  const [tags, tagGroups, groups, chTags] = await Promise.all([
    listTags().catch(() => []),
    listTagGroups().catch(() => []),
    listGroups().catch(() => []),
    getChannelTagsMap().catch(() => ({} as Record<string, string[]>)),
  ]);
  const db = await openDB();
  const videoIndex: Array<{ id: string; tags?: string[]; sources?: Array<{ type: string; id?: string | null }>; progressSec?: number | null; channelId?: string | null }> = [];
  const channelIndex: Array<{ id: string; tags?: string[] }> = [];
  const pendingChannels: Array<{ key: string; name?: string | null; handle?: string | null }> = [];
  const seenChannelIds = new Set<string>();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['videos', 'channels', 'channels_pending'] as any, 'readonly');
    // videos
    try {
      const vs = tx.objectStore('videos');
      const curV = vs.openCursor();
      curV.onsuccess = () => {
        const c = curV.result as IDBCursorWithValue | null;
        if (!c) return;
        const r: any = c.value || {};
        const entry: any = { id: r.id };
        if (Array.isArray(r.tags) && r.tags.length) entry.tags = r.tags.slice();
        if (Array.isArray(r.sources) && r.sources.length) entry.sources = r.sources.map((s: any) => ({ type: String(s?.type || ''), id: (s?.id ?? null) }));
        let ps: number | null = null;
        try {
          const sec = Number(r?.progress?.sec);
          if (Number.isFinite(sec) && sec > 0) ps = Math.floor(sec);
          else {
            const pct = Number(r?.progress?.pct);
            const dur = Number(r?.progress?.duration ?? r?.durationSec);
            if (Number.isFinite(pct) && Number.isFinite(dur) && dur > 0) ps = Math.floor(Math.max(0, Math.min(100, pct)) / 100 * dur);
          }
        } catch {}
        if (ps != null) entry.progressSec = ps;
        if (r.channelId) entry.channelId = r.channelId;
        videoIndex.push(entry);
        c.continue();
      };
      curV.onerror = () => reject(curV.error);
    } catch {}
    // channels (ids only; tags will be overlaid from local)
    try {
      const cs = tx.objectStore('channels');
      const curC = cs.openCursor();
      curC.onsuccess = () => {
        const c = curC.result as IDBCursorWithValue | null;
        if (!c) return;
        const r: any = c.value || {};
        const id = String(r.id || '');
        if (id) { seenChannelIds.add(id); channelIndex.push({ id, tags: chTags[id] || [] }); }
        c.continue();
      };
      curC.onerror = () => reject(curC.error);
    } catch {}
    // pending channels
    try {
      const ps = (tx as any).objectStore('channels_pending') as IDBObjectStore;
      const curP = ps.openCursor();
      curP.onsuccess = () => {
        const c = curP.result as IDBCursorWithValue | null;
        if (!c) return;
        const r: any = c.value || {};
        pendingChannels.push({ key: String(r.key || ''), name: r.name ?? null, handle: r.handle ?? null });
        c.continue();
      };
      curP.onerror = () => reject(curP.error);
    } catch {}
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  // Include any channel ids present only in local channelTags map
  for (const id of Object.keys(chTags || {})) {
    if (!seenChannelIds.has(id)) channelIndex.push({ id, tags: chTags[id] || [] });
  }
  return {
    version: 1 as const,
    at: Date.now(),
    tags: (tags as any) || [],
    tagGroups: (tagGroups as any) || [],
    groups: (groups as any) || [],
    videoIndex,
    channelIndex,
    pendingChannels,
  };
});
// Hourly backup alarm initialized below
// Try to ensure a baseline snapshot silently on startup (ignored if Drive not configured yet)
try { void ensureBaselineSnapshot({ interactive: false }); } catch {}
try { void migrateSettingsFromIDBIfNeeded(); } catch {}
try { initHourlyBackupAlarm(); } catch {}

async function scheduleBackup() {
  try { queueCommitFlush(3000); } catch {}
  try { queueSettingsBackup(); } catch {}
  try { void replayUnsyncedCommitsToDrive(); } catch {}
}

// Ensure there is at least one baseline snapshot in Drive appData so reverts are possible soon after setup
async function ensureBaselineSnapshot(opts?: { interactive?: boolean }) {
  try {
    const files = await listAppDataFiles({ interactive: !!opts?.interactive });
    const hasSnapshot = files.some(f => (f.name || '').startsWith('snapshots/'));
    if (hasSnapshot) return;
    // Create baseline from current producer snapshot
    const snap = await getCurrentSettingsSnapshot();
    const ts = new Date().toISOString().replace(/[:.]/g, '').replace('T','-').slice(0, 15);
    await saveSnapshotWithName(`snapshots/settings-${ts}.json`, snap, { interactive: !!opts?.interactive });
    try { chrome.runtime.sendMessage({ type: 'backup/done', payload: { at: Date.now() } }); } catch {}
  } catch (e) {
    // Silent failure is ok (e.g., Drive not configured yet)
  }
}

// --- Settings migration to chrome.storage.local ---
async function migrateSettingsFromIDBIfNeeded() {
  await ensureUseLocalDefault();
  const useLocal = await isUseLocalEnabled();
  if (!useLocal) return;
  const hasInit = await hasLocalSettingsInitialized();
  if (hasInit) return;
  try {
    const db = await openDB();
    const tags: any[] = await new Promise((res, rej) => {
      try {
        const tx = db.transaction('tags', 'readonly');
        const os = tx.objectStore('tags');
        const req = os.getAll();
        req.onsuccess = () => res((req.result || []).map((r: any) => ({ name: r.name, color: r.color, createdAt: r.createdAt, groupId: r.groupId })));
        req.onerror = () => rej(req.error);
      } catch { res([]); }
    });
    const tagGroups: any[] = await new Promise((res, rej) => {
      try {
        const tx = db.transaction('tag_groups', 'readonly');
        const os = tx.objectStore('tag_groups');
        const req = os.getAll();
        req.onsuccess = () => res((req.result || []).map((r: any) => ({ id: r.id, name: r.name, createdAt: r.createdAt })));
        req.onerror = () => rej(req.error);
      } catch { res([]); }
    });
    const groups: any[] = await new Promise((res, rej) => {
      try {
        const tx = db.transaction('groups', 'readonly');
        const os = tx.objectStore('groups');
        const req = os.getAll();
        req.onsuccess = () => res((req.result || []).map((r: any) => ({ id: r.id, name: r.name, condition: r.condition, createdAt: r.createdAt, updatedAt: r.updatedAt, scrape: r.scrape === true })));
        req.onerror = () => rej(req.error);
      } catch { res([]); }
    });
    const channelTagsById: Record<string, string[]> = await new Promise((res, rej) => {
      try {
        const map: Record<string, string[]> = {};
        const tx = db.transaction('channels', 'readonly');
        const os = tx.objectStore('channels');
        const cur = os.openCursor();
        cur.onsuccess = () => {
          const c = cur.result as IDBCursorWithValue | null;
          if (!c) { res(map); return; }
          const row: any = c.value || {};
          const id = String(row.id || '');
          const tagsArr: string[] = Array.isArray(row.tags) ? row.tags.slice() : [];
          if (id && tagsArr.length) map[id] = Array.from(new Set(tagsArr));
          c.continue();
        };
        cur.onerror = () => rej(cur.error);
      } catch { res({}); }
    });
    await writeInitialLocalSettings({ tags, tagGroups, groups, channelTagsById });
  } catch {
    // ignore
  }
}

// --- Hourly backup tick (Drive upload and/or local download) ---
const BACKUP_CFG = {
  driveEnabledKey: 'backup.drive.enabled',
  localEnabledKey: 'backup.local.enabled',
  driveLastKey: 'backup.drive.lastUploadAt',
  localLastKey: 'backup.local.lastDownloadAt',
};

async function runBackupTick(opts?: { interactive?: boolean }) {
  try {
    const cfg = await new Promise<any>((res) => chrome.storage?.local?.get([BACKUP_CFG.driveEnabledKey, BACKUP_CFG.localEnabledKey], (o) => res(o)));
    const driveOn = cfg?.[BACKUP_CFG.driveEnabledKey] !== false; // default true
    const localOn = cfg?.[BACKUP_CFG.localEnabledKey] !== false; // default true
    const snap = await getCurrentSettingsSnapshot();
    if (driveOn) {
      try { await saveSettingsNow(snap, { interactive: !!opts?.interactive }); } catch {}
      try { chrome.storage?.local?.set({ [BACKUP_CFG.driveLastKey]: Date.now(), lastBackupAt: Date.now() }); } catch {}
    }
    if (localOn) {
      try { await triggerLocalDownload(snap); chrome.storage?.local?.set({ [BACKUP_CFG.localLastKey]: Date.now() }); } catch {}
    }
  } catch {}
}

function initHourlyBackupAlarm() {
  try { chrome.alarms.create('backup.hourly', { periodInMinutes: 60 }); } catch {}
  try {
    chrome.alarms.onAlarm.addListener((a) => { if (a?.name === 'backup.hourly') { void runBackupTick({ interactive: false }); } });
  } catch {}
}

async function triggerLocalDownload(snapshot: SettingsSnapshot) {
  // Download to default Downloads folder without prompting
  const name = `settings-${new Date().toISOString().replace(/[:.]/g,'').replace('T','-').slice(0,15)}.json`;
  const text = JSON.stringify(snapshot, null, 2);
  const b64 = utf8ToB64(text);
  const url = `data:application/json;base64,${b64}`;
  try { await chrome.downloads.download({ url, filename: name, saveAs: false }); } catch {}
}

const autoResolveTabIds = new Set<number>();
try {
  chrome.tabs?.onUpdated?.addListener((tabId, changeInfo) => {
    try {
      if (changeInfo?.status === 'complete' && autoResolveTabIds.has(tabId)) {
        chrome.tabs?.sendMessage?.(tabId, { type: 'channel/RESOLVE_ID_NOW', payload: {} } as any, () => void 0);
      }
    } catch { /* ignore */ }
  });
} catch { /* ignore */ }
const autoResolveTabInfo = new Map<number, { origHandle?: string | null }>();

// ---- Scrape session (Subscriptions Feed / Watch History) ----
type ScrapeMode = 'subFeed' | 'history';
type SourceOverride = 'SubscriptionsFeed' | 'WatchHistory';
let currentScrape: {
  id: number;
  mode: ScrapeMode;
  tabIds: Set<number>;
  sourceOverride?: SourceOverride;
  limit?: number;
  seen: Set<string>;
  stopOnKnown?: boolean;
  stopRequested?: boolean;
} | null = null;

async function setLastRun(name: 'resolveIds'|'subFeed'|'subscriptionsManager'|'history'|'any') {
  try {
    const key = `scrape.lastRun.${name}`;
    const at = Date.now();
    chrome.storage?.local?.set({ [key]: at, 'scrape.lastRun.any': at });
  } catch {}
}
async function getLastRuns(): Promise<Record<string, number | null>> {
  return new Promise((resolve) => {
    try {
      const keys = ['scrape.lastRun.any','scrape.lastRun.resolveIds','scrape.lastRun.subFeed','scrape.lastRun.subscriptionsManager','scrape.lastRun.history'];
      chrome.storage?.local?.get(keys, (o) => {
        const out: any = {};
        for (const k of keys) out[k] = Number.isFinite(o?.[k]) ? Number(o[k]) : null;
        resolve(out);
      });
    } catch { resolve({}); }
  });
}

async function getNoStubsFlag(): Promise<boolean> {
  return new Promise((resolve) => {
    try { chrome.storage?.local?.get('debug.noStubs', (o) => resolve(!!o?.['debug.noStubs'])); } catch { resolve(false); }
  });
}

async function getStopAtPrevLatestFlag(kind: 'subFeed' | 'history'): Promise<boolean> {
  const key = kind === 'subFeed' ? 'scrape.stopAtPrevLatest.subFeed' : 'scrape.stopAtPrevLatest.history';
  return new Promise((resolve) => {
    try { chrome.storage?.local?.get(key, (o) => resolve(!!o?.[key])); } catch { resolve(false); }
  });
}

async function handleVideoUpsert(kind: 'SEEN'|'STUB', payload: any, sender?: chrome.runtime.MessageSender) {
  const tabId = sender?.tab?.id;
  const session = currentScrape && tabId && currentScrape.tabIds.has(tabId) ? currentScrape : null;
  const override = (session?.sourceOverride || null) as (SourceOverride | null);
  const now = Date.now();
  const incoming: any = { ...(payload || {}), lastSeenAt: now };
  const base = Array.isArray(incoming.sources) ? incoming.sources.slice() : [];
  if (override) base.push({ type: override, id: null });
  incoming.sources = base;
  if (session?.mode === 'history') incoming.flags = { ...(incoming.flags || {}), started: true };
  try { pendingUpserts++; } catch {}
  await upsertVideo(incoming);
  try { pendingUpserts = Math.max(0, pendingUpserts - 1); } catch {}
  try { if (session && incoming?.id) session.seen.add(String(incoming.id)); } catch {}
}

async function getDefaultMax(kind: 'subFeed'|'history'): Promise<number> {
  return new Promise((resolve) => {
    try {
      const key = kind === 'subFeed' ? 'scrape.max.subFeed' : 'scrape.max.history';
      chrome.storage?.local?.get(key, (o) => {
        const def = kind === 'subFeed' ? 120 : 250;
        const n = Number(o?.[key]);
        resolve(Number.isFinite(n) && n > 0 ? Math.floor(n) : def);
      });
    } catch { resolve(kind === 'subFeed' ? 120 : 250); }
  });
}

async function runScrollingScrape(url: string, override: SourceOverride, max: number, opts?: { stopOnKnown?: boolean; historyHints?: boolean; keepOpen?: boolean }): Promise<{ count: number; stopped: boolean }> {
  try { if (currentScrape) { currentScrape.stopRequested = true; for (const id of Array.from(currentScrape.tabIds.values())) { try { chrome.tabs?.remove?.(id); } catch {} } currentScrape = null; } } catch {}
  const tab = await chrome.tabs?.create?.({ url, active: true });
  const tabId = tab?.id as number | undefined;
  if (typeof tabId !== 'number') return { count: 0, stopped: true };
  currentScrape = { id: Math.floor(Math.random()*1e9), mode: override === 'WatchHistory' ? 'history' : 'subFeed', tabIds: new Set([tabId]), sourceOverride: override, limit: max, seen: new Set<string>(), stopOnKnown: !!opts?.stopOnKnown, stopRequested: false };
  await sleep(1200);
  let lastCum = 0;
  let stall = 0;
  // Determine previously marked latest id for optional early stop
  let stopAtId: string | null = null;
  if (opts?.stopOnKnown) {
    try {
      const key = override === 'WatchHistory' ? 'latestBy.WatchHistory' : 'latestBy.SubscriptionsFeed';
      const val = await getMetaValue<string>(key);
      stopAtId = (typeof val === 'string' && val) ? val : null;
    } catch { stopAtId = null; }
  }
  let firstIdOnRun: string | null = null;
  let lastChannelLinks = 0;
  const needBaselines = (override === 'SubscriptionsFeed');
  const baselineVideos = 100;
  const baselineChannels = 100;
  try {
    for (let i = 0; i < 60; i++) {
      if (!currentScrape || currentScrape.stopRequested) break;
      // Trigger a scrape pass
      await new Promise((resolve) => { try { chrome.tabs?.sendMessage?.(tabId, { type: 'scrape/NOW', payload: {} }, () => resolve(undefined)); } catch { resolve(undefined); } });
      await sleep(350);
      // Ask content for DOM-unique stats (total, regardless of preset gating)
      let cum = lastCum;
      try {
        const resp: any = await new Promise((resolve) => {
          try { chrome.tabs?.sendMessage?.(tabId, { type: 'scrape/LOG', payload: { what: override, seen: currentScrape?.seen?.size || 0, max, stall, pending: pendingUpserts, stopAtId } }, (r: any) => resolve(r)); } catch { resolve(null); }
        });
        const dom = resp?.dom || {};
        const v = Number(dom?.cumulativeUnique || 0);
        if (Number.isFinite(v) && v >= 0) cum = v;
        // Track channel link count (Sub Feed baseline)
        try { lastChannelLinks = Math.max(0, Number(dom?.channelLinks || 0)); } catch { lastChannelLinks = 0; }
        if (!firstIdOnRun) {
          const fid = resp?.dom?.firstId;
          if (typeof fid === 'string' && fid) firstIdOnRun = fid;
        }
        const reachedVideoBaseline = cum >= baselineVideos;
        const reachedChannelBaseline = lastChannelLinks >= baselineChannels;
        const okToShortStop = !needBaselines || (reachedVideoBaseline && reachedChannelBaseline);
        if (opts?.stopOnKnown && resp?.foundStopId === true && stopAtId && okToShortStop) { lastCum = cum; break; }
      } catch {}
      // Stop if DOM-unique count reached the limit
      if (cum >= max) {
        const reachedVideoBaseline = cum >= baselineVideos;
        const reachedChannelBaseline = lastChannelLinks >= baselineChannels;
        if (!needBaselines || (reachedVideoBaseline && reachedChannelBaseline)) { lastCum = cum; break; }
      }
      // Aggressive scrolling: always nudge the infinite loader to the bottom
      try { await new Promise((resolve)=> chrome.tabs?.sendMessage?.(tabId, { type: 'scrape/SCROLL_BOTTOM', payload: { times: 2, delayMs: 600 } }, () => resolve(undefined))); } catch {}
      // Reset stall tracker (no longer used for conditional nudge)
      if (cum <= lastCum) { stall += 1; } else { stall = 0; }
      lastCum = Math.max(lastCum, cum);
      // Safety net: also exit if upserts greatly exceed max (shouldn't happen)
      if ((currentScrape?.seen?.size || 0) >= max * 2) break;
    }
  } catch {}
  // Final highlight/logging and wait for upserts to flush (best-effort)
  try { await new Promise((resolve) => { try { chrome.tabs?.sendMessage?.(tabId, { type: 'scrape/FINAL', payload: { what: override, ids: Array.from(currentScrape?.seen || []), max } }, () => resolve(undefined)); } catch { resolve(undefined); } }); } catch {}
  // Wait until pending upserts drain or seen >= lastCum (whichever first), with timeout
  const waitStart = Date.now();
  for (;;) {
    if (!currentScrape) break;
    const done = (pendingUpserts <= 0) || ((currentScrape.seen.size || 0) >= lastCum) || (Date.now() - waitStart > 4000);
    if (done) break;
    await sleep(120);
  }
  const count = currentScrape ? currentScrape.seen.size : 0;
  const stopped = !!currentScrape?.stopRequested;
  // Update latest marker (flag on video + meta) based on firstId captured at start of run
  try {
    if (firstIdOnRun) {
      const src = (override === 'WatchHistory' ? 'WatchHistory' : 'SubscriptionsFeed');
      await updateLatestForSource(src as any, firstIdOnRun, { createIfMissing: src === 'SubscriptionsFeed' });
      try { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } }); } catch {}
    }
  } catch {}
  if (!(opts?.keepOpen)) { try { chrome.tabs?.remove?.(tabId); } catch {} }
  currentScrape = null;
  return { count, stopped };
}

async function runSubscriptionsManagerOnce(): Promise<{ subscribedCount: number; created: number; unsubscribed: number }> {
  try { if (currentScrape) { currentScrape.stopRequested = true; for (const id of Array.from(currentScrape.tabIds.values())) { try { chrome.tabs?.remove?.(id); } catch {} } currentScrape = null; } } catch {}
  const url = 'https://www.youtube.com/feed/channels';
  const tab = await chrome.tabs?.create?.({ url, active: true });
  const tabId = tab?.id as number | undefined;
  if (typeof tabId !== 'number') return { subscribedCount: 0, created: 0, unsubscribed: 0 };

  // Helper to list current subscriptions (ids + handles) from the page
  async function listSubs(): Promise<{ ids: string[]; handles: string[]; count: number }> {
    try {
      const resp: any = await new Promise((resolve) => {
        try { chrome.tabs?.sendMessage?.(tabId, { type: 'scrape/LIST_SUBSCRIPTIONS', payload: {} }, (r: any) => resolve(r)); } catch { resolve(null); }
      });
      const ids = Array.isArray(resp?.ids) ? (resp.ids as string[]).map(String) : [];
      const handles = Array.isArray(resp?.handles) ? (resp.handles as string[]).map(String) : [];
      return { ids, handles, count: ids.length + handles.length };
    } catch {
      return { ids: [], handles: [], count: 0 };
    }
  }

  // Wait until at least one channel link is present (first appearance)
  let first = { ids: [] as string[], handles: [] as string[], count: 0 };
  const firstDeadline = Date.now() + 60000; // safety cap 60s
  for (;;) {
    first = await listSubs();
    if (first.count > 0) break;
    if (Date.now() > firstDeadline) break;
    await sleep(500);
  }

  // Once first is seen, check every 4s until the count stops changing for 4 intervals
  let prevCount = first.count;
  let stable = 0;
  let last = first;
  if (prevCount > 0) {
    while (stable < 4) {
      await sleep(4000);
      const cur = await listSubs();
      if (cur.count !== prevCount) {
        prevCount = cur.count;
        stable = 0;
        last = cur;
      } else {
        stable += 1;
        last = cur;
      }
    }
  } else {
    // Nothing found within safety cap; take one last snapshot before closing
    last = await listSubs();
  }

  // Close the tab now that we've finished sampling
  try { chrome.tabs?.remove?.(tabId); } catch {}

  // Persist pending handles; ensure leading '@'
  for (const raw of last.handles) {
    const h = typeof raw === 'string' ? raw.trim() : '';
    if (!h) continue;
    const withAt = h.startsWith('@') ? h : ('@' + h);
    const key = `handle:${withAt}`;
    try { await upsertPendingChannel(key, { handle: withAt, subscribedPending: true }); } catch {}
  }
  // Update subscribed/unsubscribed flags for channels with concrete ids
  let created = 0, unsubscribed = 0;
  try {
    const res = await applySubscribedSet(last.ids);
    created = res.created; unsubscribed = res.unsubscribed;
  } catch {}

  return { subscribedCount: last.count, created, unsubscribed };
}

chrome.runtime.onMessage.addListener((raw: Msg, sender, sendResponse) => {
  (async () => {
    dlog('onMessage:', raw?.type, raw?.payload ? Object.keys(raw.payload) : null);
    try {
      if (raw.type === 'cache/VIDEO_SEEN') {
        await handleVideoUpsert('SEEN', raw.payload, sender);
        try { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } }); } catch {}
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if (raw.type === 'cache/VIDEO_SEEN_BATCH') {
        const items = Array.isArray((raw as any)?.payload?.items) ? (raw as any).payload.items : [];
        const tabId = sender?.tab?.id;
        const session = currentScrape && tabId && currentScrape.tabIds.has(tabId) ? currentScrape : null;
        const override = (session?.sourceOverride || null) as SourceOverride | null;
        const now = Date.now();
        const normalized = items.map((p: any) => {
          const base = Array.isArray(p?.sources) ? p.sources.slice() : [];
          if (override) base.push({ type: override, id: null });
          const obj = { ...(p || {}), sources: base, lastSeenAt: now };
          if (session?.mode === 'history') (obj as any).flags = { ...((obj as any).flags || {}), started: true };
          return obj;
        });
        try { pendingUpserts += normalized.length; } catch {}
        await upsertVideosBulk(normalized);
        try { if (session) { for (const it of normalized) if (it?.id) session.seen.add(String(it.id)); } } catch {}
        try { pendingUpserts = Math.max(0, pendingUpserts - normalized.length); } catch {}
        try { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } }); } catch {}
        scheduleBackup();
        sendResponse?.({ ok: true, count: normalized.length });
      } else if (raw.type === 'cache/VIDEO_STUB') {
        const noStubs = await getNoStubsFlag();
        await handleVideoUpsert(noStubs ? 'SEEN' : 'STUB', (raw as any).payload, sender);
        try { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } }); } catch {}
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if (raw.type === 'cache/VIDEO_PROGRESS') {
        const { id, current, duration, started, completed } = raw.payload;
        await upsertVideo({
          id,
          progress: { sec: current, duration },
          flags: { started: !!started, completed: !!completed }
        });
        try { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } }); } catch {}
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if (raw.type === 'cache/VIDEO_PROGRESS_PCT') {
        const { id, pct, started, completed } = raw.payload || {};
        const pctNum = Number(pct);
        if (id && Number.isFinite(pctNum)) {
          await upsertVideo({ id, progress: { pct: Math.max(0, Math.min(100, pctNum)) }, flags: { started: !!started, completed: !!completed } });
          try { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } }); } catch {}
          scheduleBackup();
          sendResponse?.({ ok: true });
        } else {
          sendResponse?.({ ok: false });
        }
      } else if (raw.type === 'groups/list') {
        const items = await listGroups();
        // Overlay default preset built from channels tagged with 'scrape'
        try {
          const db = await openDB();
          const tx = db.transaction('channels', 'readonly');
          const os = tx.objectStore('channels');
          const cur = os.openCursor();
          const set = new Set<string>();
          await new Promise<void>((resolve, reject) => {
            cur.onsuccess = () => {
              const c = cur.result as IDBCursorWithValue | null;
              if (!c) { resolve(); return; }
              const row: any = c.value || {};
              const tags: string[] = Array.isArray(row.tags) ? row.tags : [];
              if (tags.map(t => String(t||'').toLowerCase()).includes('scrape')) {
                try {
                  if (row?.id) set.add(String(row.id));
                  const handle = String(row?.handle || '').trim();
                  if (handle) { set.add(handle); set.add(handle.startsWith('@') ? handle.slice(1) : ('@' + handle)); }
                  const alts: string[] = Array.isArray(row?.altHandles) ? row.altHandles : [];
                  for (const h of alts) { const s = String(h || '').trim(); if (s) { set.add(s); set.add(s.startsWith('@') ? s.slice(1) : ('@' + s)); } }
                } catch {}
              }
              c.continue();
            };
            cur.onerror = () => reject(cur.error);
          });
          const ids = Array.from(set.values());
          const preset = { id: DEFAULT_PRESET_ID, name: DEFAULT_PRESET_NAME, createdAt: 0, updatedAt: Date.now(), scrape: true, condition: { kind: 'channelIdIn', ids } as any };
          items.unshift(preset as any);
        } catch {}
        sendResponse?.({ ok: true, items });
      } else if (raw.type === 'scrape/status') {
        const runs = await getLastRuns();
        const running = !!currentScrape;
        const mode = currentScrape?.mode || null;
        const seen = currentScrape ? currentScrape.seen.size : 0;
        sendResponse?.({ ok: true, running, mode, seen, runs });
      } else if (raw.type === 'scrape/stop') {
        try {
          if (currentScrape) {
            currentScrape.stopRequested = true;
            for (const id of Array.from(currentScrape.tabIds.values())) {
              try { chrome.tabs?.remove?.(id); } catch {}
            }
            currentScrape = null;
          }
        } catch {}
        sendResponse?.({ ok: true });
      } else if (raw.type === 'scrape/resolveIds') {
        try {
          const limit = Math.max(1, Math.min(20, Number(((raw as any)?.payload?.limit) ?? 5)));
          const r: any = await new Promise((res) => {
            try { chrome.runtime.sendMessage({ type: 'channels/pending/resolveBatch', payload: { limit } } as any, (x: any) => res(x)); }
            catch { res({ ok: false }); }
          });
          await setLastRun('resolveIds');
          await setLastRun('any');
          sendResponse?.({ ok: !!r?.ok, opened: r?.opened ?? 0, remaining: r?.remaining ?? 0 });
        } catch (e: any) { sendResponse?.({ ok: false, error: e?.message || String(e) }); }
      } else if (raw.type === 'scrape/subFeed') {
        try {
          const max = Math.max(1, Math.min(2000, Number(((raw as any)?.payload?.max) ?? (await getDefaultMax('subFeed')))));
          const stopOnKnown = await getStopAtPrevLatestFlag('subFeed');
          const r = await runScrollingScrape('https://www.youtube.com/feed/subscriptions', 'SubscriptionsFeed', max, { stopOnKnown, keepOpen: false });
          await setLastRun('subFeed'); await setLastRun('any');
          sendResponse?.({ ok: true, ...r });
        } catch (e: any) { sendResponse?.({ ok: false, error: e?.message || String(e) }); }
      } else if (raw.type === 'scrape/history') {
        try {
          const max = Math.max(1, Math.min(5000, Number(((raw as any)?.payload?.max) ?? (await getDefaultMax('history')))));
          const stopOnKnown = await getStopAtPrevLatestFlag('history');
          const r = await runScrollingScrape('https://www.youtube.com/feed/history', 'WatchHistory', max, { stopOnKnown, historyHints: true, keepOpen: false });
          await setLastRun('history'); await setLastRun('any');
          sendResponse?.({ ok: true, ...r });
        } catch (e: any) { sendResponse?.({ ok: false, error: e?.message || String(e) }); }
      } else if ((raw as any)?.type === 'scrape/subscriptionsManager') {
        try {
          const r = await runSubscriptionsManagerOnce();
          await setLastRun('subscriptionsManager'); await setLastRun('any');
          sendResponse?.({ ok: true, ...r });
        } catch (e: any) { sendResponse?.({ ok: false, error: e?.message || String(e) }); }
      } else if ((raw as any)?.type === 'scrape/runAll') {
        try {
          const out: any = { ok: true };
          try { await setLastRun('resolveIds'); await setLastRun('any'); await new Promise((res) => chrome.runtime.sendMessage({ type: 'channels/pending/resolveBatch', payload: { limit: 5 } } as any, () => res(undefined))); } catch {}
          try { const stopOnKnown = await getStopAtPrevLatestFlag('subFeed'); await runScrollingScrape('https://www.youtube.com/feed/subscriptions', 'SubscriptionsFeed', await getDefaultMax('subFeed'), { stopOnKnown }); await setLastRun('subFeed'); await setLastRun('any'); } catch {}
          try { await runSubscriptionsManagerOnce(); await setLastRun('subscriptionsManager'); await setLastRun('any'); } catch {}
          try { const stopOnKnownH = await getStopAtPrevLatestFlag('history'); await runScrollingScrape('https://www.youtube.com/feed/history', 'WatchHistory', await getDefaultMax('history'), { stopOnKnown: stopOnKnownH, historyHints: true }); await setLastRun('history'); await setLastRun('any'); } catch {}
          sendResponse?.(out);
        } catch (e: any) { sendResponse?.({ ok: false, error: e?.message || String(e) }); }
      } else if (raw.type === 'channels/list') {
        let items = await listChannels();
        try {
          const map = await getChannelTagsMap();
          items = items.map((it: any) => {
            const local = Array.isArray((map as any)[it.id]) ? (map as any)[it.id] : [];
            const base: string[] = Array.isArray(it.tags) ? it.tags : [];
            const sys = new Set<string>();
            if (base.includes('subscribed')) sys.add('subscribed');
            if (base.includes('unsubscribed')) sys.add('unsubscribed');
            return { ...it, tags: Array.from(new Set<string>([...local, ...Array.from(sys.values())])) };
          });
        } catch {}
        sendResponse?.({ ok: true, items });
      } else if (raw.type === 'channels/getTags') {
        try {
          const id = String((raw as any)?.payload?.id || '');
          if (!id) { sendResponse?.({ ok: false, error: 'Missing id' }); return; }
          const map = await getChannelTagsMap();
          const tags = Array.isArray((map as any)[id]) ? (map as any)[id] : [];
          sendResponse?.({ ok: true, tags });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e), tags: [] });
        }
      } else if (raw.type === 'channels/trashList') {
        const items = await listChannelsTrash();
        sendResponse?.({ ok: true, items });
      } else if (raw.type === 'topics/list') {
        try {
          let items = await readVideoTopicsMeta();
          if (!items || items.length === 0) {
            try { await recomputeVideoTopicsMeta(); items = await readVideoTopicsMeta(); } catch {}
          }
          sendResponse?.({ ok: true, items });
        } catch (e) {
          sendResponse?.({ ok: false, items: [] });
        }
      } else if (raw.type === 'groups/create') {
        const { name, condition } = raw.payload || {};
        await createGroup(name, condition);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'groups' } });
        recordEvent('groups/create', { name }, { impact: { groups: 1 } });
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if (raw.type === 'groups/update') {
        const { id, patch } = raw.payload || {};
        await updateGroup(id, patch);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'groups' } });
        recordEvent('groups/update', { id, patch }, { impact: { groups: 1 } });
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if (raw.type === 'groups/delete') {
        const { id } = raw.payload || {};
        if (String(id) === DEFAULT_PRESET_ID) { sendResponse?.({ ok: false, error: 'Default preset cannot be deleted' }); return; }
        await deleteGroup(id);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'groups' } });
        recordEvent('groups/delete', { id }, { impact: { groups: 1 } });
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if (raw.type === 'videos/applyTags') {
        const { ids, addIds = [], removeIds = [] } = raw.payload || {};
        const add = sanitizeVideoTagAdds(addIds);
        const rem = Array.from(new Set((removeIds || []).map((s: any) => String(s || '').trim()).filter(Boolean)));
        dlog('videos/applyTags', { ids: ids?.length || 0, add: add.length, remove: rem.length });
        await applyTags(ids || [], add, rem);
        // Update channel videoTags for affected channels
        try {
          const chs = await channelIdsForVideos(ids || []);
          if (chs.length) await recomputeVideoTagsForChannels(chs);
          chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } });
        } catch {}
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } });
        recordEvent('videos/applyTags', { ids: ids || [], addIds: add, removeIds: rem }, { impact: { videos: (ids || []).length, tags: add.length + rem.length } });
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if (raw.type === 'videos/setType') {
        const ids: string[] = Array.isArray(raw.payload?.ids) ? raw.payload.ids.filter(Boolean) : [];
        const type: string = String(raw.payload?.type || '').toLowerCase();
        if (!ids.length || !['video','short','livestream'].includes(type)) { sendResponse?.({ ok: false, error: 'Invalid args' }); return; }
        const db = await openDB();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('videos', 'readwrite');
          const os = tx.objectStore('videos');
          (async () => {
            for (const id of ids) {
              await new Promise<void>((res, rej) => {
                const g = os.get(id);
                g.onsuccess = () => {
                  const row = (g.result as any) || { id };
                  row.type = type;
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
        try { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } }); } catch {}
        recordEvent('videos/typeSet', { ids, to: type }, { impact: { videos: ids.length } });
        scheduleBackup();
        sendResponse?.({ ok: true, count: ids.length });
      } else if (raw.type === 'tags/list') {
        const items = await listTags();
        const present = new Set(items.map(t => String(t.name || '').toLowerCase()));
        const overlay: any[] = [];
        for (const t of DEFAULT_TAGS) {
          if (!present.has(t.name)) {
            const gid = (t as any).groupId ? (t as any).groupId : (t.manual ? DEFAULT_TAG_GROUP_ID : undefined);
            overlay.push({ name: t.name, createdAt: 0, ...(gid ? { groupId: gid } : {}) });
          }
        }
        sendResponse?.({ ok: true, items: [...overlay, ...items] });
      } else if (raw.type === 'tags/assignGroup') {
        const name = String(raw.payload?.name || '');
        const groupId = (raw.payload?.groupId ?? null) as (string | null);
        if (!isDefaultTag(name)) await setTagGroup(name, groupId);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'tags' } });
        recordEvent('tags/assignGroup', { name, groupId }, { impact: { tags: 1 } });
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if ((raw as any)?.type === 'channels/upsertStub') {
        const { id, name, handle } = (raw as any).payload || {};
        if (!id) { sendResponse?.({ ok: false }); return; }
        try {
          await upsertChannelStub(id, name, handle);
          chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } });
          recordEvent('pending/resolve', { id, name, handle }, { impact: { channels: 1 } });
          scheduleBackup();
          sendResponse?.({ ok: true });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      } else if (raw.type === 'tags/create') {
        const nm = String(raw.payload?.name || '');
        if (!isDefaultTag(nm)) {
          await createTag(nm, raw.payload?.color);
        }
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'tags' } });
        recordEvent('tags/create', { name: raw.payload?.name }, { impact: { tags: 1 } });
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if (raw.type === 'tags/rename') {
        const from = String(raw.payload?.oldName || '');
        const to = String(raw.payload?.newName || '');
        if (isDefaultTag(from) || isDefaultTag(to)) { sendResponse?.({ ok: false, error: 'Default tag cannot be renamed' }); return; }
        await renameTag(from, to); await renameTagInDB(from, to);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'tags' } });
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } }); // videos updated too
        try { await recomputeVideoTagsForAllChannels(); chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } }); } catch{}
        recordEvent('tags/rename', { from: raw.payload?.oldName, to: raw.payload?.newName }, { impact: { tags: 1 } });
        scheduleBackup();
        sendResponse?.({ ok: true });
  } else if (raw.type === 'tags/delete') {
        const nm = String(raw.payload?.name || '');
        const cascade = raw.payload?.cascade ?? true;
        if (!isDefaultTag(nm)) { await deleteTag(nm, cascade); await deleteTagInDB(nm, cascade); }
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'tags' } });
      if (cascade) { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } }); try { await recomputeVideoTagsForAllChannels(); chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } }); } catch{} }
      recordEvent('tags/delete', { name: raw.payload?.name, cascade }, { impact: { tags: 1 } });
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if (raw.type === 'tagGroups/list') {
        const items = await listTagGroups();
        const hasDefault = items.some(g => String(g.id) === DEFAULT_TAG_GROUP_ID) || items.some(g => (g.name || '').toLowerCase() === DEFAULT_TAG_GROUP_NAME);
        const hasRating = items.some(g => String(g.id) === DEFAULT_RATING_TAG_GROUP_ID) || items.some(g => (g.name || '').toLowerCase() === DEFAULT_RATING_TAG_GROUP_NAME.toLowerCase());
        const overlay: any[] = [];
        if (!hasDefault) overlay.push({ id: DEFAULT_TAG_GROUP_ID, name: DEFAULT_TAG_GROUP_NAME, createdAt: 0 });
        if (!hasRating) overlay.push({ id: DEFAULT_RATING_TAG_GROUP_ID, name: DEFAULT_RATING_TAG_GROUP_NAME, createdAt: 0 });
        const out = overlay.length ? [...overlay, ...items] : items;
        sendResponse?.({ ok: true, items: out });
      } else if (raw.type === 'tagGroups/create') {
        const id = await createTagGroup(String(raw.payload?.name || ''));
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'tagGroups' } });
        recordEvent('tagGroups/create', { id, name: String(raw.payload?.name || '') }, { impact: {} });
        scheduleBackup();
        sendResponse?.({ ok: true, id });
      } else if (raw.type === 'tagGroups/rename') {
        const id = String(raw.payload?.id || '');
        if (id === DEFAULT_TAG_GROUP_ID) { sendResponse?.({ ok: false, error: 'Default tag group cannot be renamed' }); return; }
        await renameTagGroup(id, String(raw.payload?.name || ''));
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'tagGroups' } });
        recordEvent('tagGroups/rename', { id: String(raw.payload?.id || ''), name: String(raw.payload?.name || '') }, { impact: {} });
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if (raw.type === 'tagGroups/delete') {
        const id = String(raw.payload?.id || '');
        if (id === DEFAULT_TAG_GROUP_ID) { sendResponse?.({ ok: false, error: 'Default tag group cannot be deleted' }); return; }
        await deleteTagGroup(id);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'tagGroups' } });
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'tags' } });
        recordEvent('tagGroups/delete', { id: String(raw.payload?.id || '') }, { impact: {} });
        scheduleBackup();
        sendResponse?.({ ok: true });
    } else if (raw.type === 'channels/refreshUnfetched') {
      const apiKey = await getApiKey();
      if (!apiKey) { sendResponse?.({ ok: false, error: 'Missing API key' }); return; }
      try {
        const ids = await listChannelIdsNeedingFetch();
        const parts = ['snippet','statistics','brandingSettings','contentDetails','topicDetails'].join(',');
        const chunkSize = 50;
        let applied = 0;
        for (let i = 0; i < ids.length; i += chunkSize) {
          const batch = ids.slice(i, i + chunkSize);
          if (batch.length === 0) continue;
          try {
            const items = await fetchChannelsListWithRetry(parts, batch, apiKey);
            for (const ch of items) { try { await applyYouTubeChannel(ch); applied += 1; } catch {} }
          } catch (e: any) {
            const msg = e?.message || String(e);
            chrome.runtime.sendMessage({ type: 'refresh/error', payload: { scope: 'channels', batchStart: i, batchSize: batch.length, message: msg } });
          }
          await sleep(300);
        }
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } });
        sendResponse?.({ ok: true, count: applied });
      } catch (e: any) {
        sendResponse?.({ ok: false, error: e?.message || String(e) });
      }
      } else if (raw.type === 'channels/refreshByIds') {
      const ids: string[] = Array.isArray(raw.payload?.ids) ? raw.payload.ids.filter(Boolean) : [];
      const apiKey = await getApiKey();
      if (!apiKey) { sendResponse?.({ ok: false, error: 'Missing API key' }); return; }
      if (ids.length === 0) { sendResponse?.({ ok: true, count: 0 }); return; }
      try {
        const parts = ['snippet','statistics','brandingSettings','contentDetails','topicDetails'].join(',');
        const chunkSize = 50;
        let applied = 0;
        for (let i = 0; i < ids.length; i += chunkSize) {
          const batch = ids.slice(i, i + chunkSize);
          try {
            const items = await fetchChannelsListWithRetry(parts, batch, apiKey);
            for (const ch of items) { try { await applyYouTubeChannel(ch); applied += 1; } catch {} }
          } catch (e: any) {
            const msg = e?.message || String(e);
            chrome.runtime.sendMessage({ type: 'refresh/error', payload: { scope: 'channels', batchStart: i, batchSize: batch.length, message: msg } });
          }
          await sleep(300);
        }
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } });
        sendResponse?.({ ok: true, count: applied });
      } catch (e: any) {
        sendResponse?.({ ok: false, error: e?.message || String(e) });
      }
      } else if (raw.type === 'channels/applyTags') {
        const { ids, addIds = [], removeIds = [] } = raw.payload || {};
        const add = sanitizeChannelTagAdds(addIds);
        const rem = sanitizeChannelTagRemoves(removeIds);
        dlog('channels/applyTags', { ids: ids?.length || 0, add: add.length, remove: rem.length });
        await applyChannelTagsLocal(ids || [], add, rem);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } });
        const affectsScrape = (add.includes('scrape') || rem.includes('scrape'));
        if (affectsScrape) { try { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'groups' } }); } catch {} }
        recordEvent('channels/applyTags', { ids: ids || [], addIds: add, removeIds: rem }, { impact: { channels: (ids || []).length, tags: add.length + rem.length } });
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if (raw.type === 'channels/delete') {
        const ids: string[] = raw.payload?.ids || [];
        await moveChannelsToTrash(ids);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } });
        recordEvent('channels/delete', { ids }, { impact: { channels: ids.length } });
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if (raw.type === 'channels/restore') {
        const ids: string[] = raw.payload?.ids || [];
        await restoreChannelsFromTrash(ids);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } });
        recordEvent('channels/restore', { ids }, { impact: { channels: ids.length } });
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if (raw.type === 'channels/purge') {
        const ids: string[] = Array.isArray(raw.payload?.ids) ? raw.payload.ids.filter(Boolean) : [];
        await purgeChannelsFromTrash(ids);
        try { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } }); } catch {}
        recordEvent('channels/purge', { ids }, { impact: { channels: ids.length } });
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if (raw.type === 'channels/markScraped') {
        const { id, at, tab, count, totalVideoCountOnScrapeTime } = raw.payload || {};
        if (!id || !at) { sendResponse?.({ ok: false }); return; }
        try {
          await markChannelScraped(id, Number(at), { tab, count, totalVideoCountOnScrapeTime });
          chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } });
          recordEvent('channels/markScraped', { id, at, tab, count }, { impact: { channels: 1 } });
          sendResponse?.({ ok: true });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      } else if ((raw as any)?.type === 'channels/upsertPending') {
        const { key, name, handle, subscribedPending } = (raw as any).payload || {};
        const handleNorm: string | null = (handle ? (String(handle).startsWith('@') ? String(handle) : '@' + String(handle)) : null);
        try {
          // If a matching channel already exists, avoid creating a pending entry.
          let found: any | null = null;
          if (handleNorm) found = await getChannelByHandle(handleNorm);
          if (!found && name) found = await getChannelByNameExact(String(name));
          if (found && found.id) {
            // Optionally promote subscribed flag
            try { if (subscribedPending) await markChannelsSubscribed([String(found.id)]); } catch {}
            // If we know the handle and the channel lacks it, attach it
            if (handleNorm) { try { await setChannelHandleIfMissing(String(found.id), handleNorm); } catch {} }
            try { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } }); } catch {}
            sendResponse?.({ ok: true, changed: false, skipped: true });
            return;
          }
        } catch {}
        const changed = await upsertPendingChannel(String(key || ''), { name: name ?? null, handle: handleNorm ?? null, subscribedPending: !!subscribedPending });
        if (changed) recordEvent('pending/upsert', { key: String(key || ''), name: name ?? null, handle: handleNorm ?? null }, { impact: {} });
        try { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } }); } catch {}
        sendResponse?.({ ok: true, changed: !!changed });
      } else if ((raw as any)?.type === 'latest/mark') {
        const source = String((raw as any)?.payload?.source || 'SubscriptionsFeed');
        const id = (raw as any)?.payload?.id ? String((raw as any)?.payload?.id) : null;
        const createIfMissing = !!((raw as any)?.payload?.createIfMissing);
        try {
          await updateLatestForSource(source === 'WatchHistory' ? 'WatchHistory' : 'SubscriptionsFeed', id, { createIfMissing });
          try { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } }); } catch {}
          sendResponse?.({ ok: true });
        } catch (e: any) { sendResponse?.({ ok: false, error: e?.message || String(e) }); }
      } else if ((raw as any)?.type === 'channels/markSubscribed') {
        const ids: string[] = Array.isArray((raw as any)?.payload?.ids) ? (raw as any).payload.ids.map(String) : [];
        const count = await markChannelsSubscribed(ids);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } });
        recordEvent('channels/markSubscribed', { count }, { impact: { channels: count } });
        scheduleBackup();
        sendResponse?.({ ok: true, count });
      } else if ((raw as any)?.type === 'channels/resolvePending') {
        const { id, name, handle } = (raw as any).payload || {};
        const idStr = String(id || '');
        const handleNorm: string | null = (handle ? (String(handle).startsWith('@') ? String(handle) : '@' + String(handle)) : null);
        try {
          const row = await getChannelById(idStr);
          if (row && handleNorm) { await setChannelHandleIfMissing(idStr, handleNorm); }
        } catch {}
        await resolvePendingChannel(idStr, { name: name ?? null, handle: handleNorm ?? null });
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } });
        recordEvent('pending/resolve', { id: idStr, name: name ?? null, handle: handleNorm ?? null }, { impact: { channels: 1 } });
        // If this came from a tab we opened to resolve, close it
        try {
          const tabId = sender?.tab?.id;
          if (typeof tabId === 'number' && autoResolveTabIds.has(tabId)) {
            autoResolveTabIds.delete(tabId);
            chrome.tabs?.remove(tabId);
          }
        } catch {}
        sendResponse?.({ ok: true });
      } else if (raw.type === 'videos/delete') {
        const ids = raw.payload.ids || [];
        dlog('videos/delete count=', ids.length);
        await moveToTrash(ids);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } });
        recordEvent('videos/delete', { ids }, { impact: { videos: ids.length } });
        scheduleBackup();
        dlog('videos/delete done');
        sendResponse?.({ ok: true });
      } else if (raw.type === 'videos/restore') {
        const ids = raw.payload.ids || [];
        console.log('[bg] videos/restore', ids.length);
        await restoreFromTrash(ids);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } });
        recordEvent('videos/restore', { ids }, { impact: { videos: ids.length } });
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if (raw.type === 'videos/purge') {
        const ids: string[] = Array.isArray(raw.payload?.ids) ? raw.payload.ids.filter(Boolean) : [];
        await purgeVideosFromTrash(ids);
        try { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } }); } catch {}
        recordEvent('videos/purge', { ids }, { impact: { videos: ids.length } });
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if (raw.type === 'videos/wipeSources') {
        await wipeSourcesDuplicates();
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } });
        recordEvent('videos/wipeSources', {}, { impact: {} });
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if (raw.type === 'videos/applyYTBatch') {
        const items: any[] = raw.payload?.items || [];
        for (const it of items) {
          try { await applyYouTubeVideo(it); } catch { /* ignore individual item errors */ }
        }
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } });
        scheduleBackup();
        sendResponse?.({ ok: true, count: items.length });
      } else if (raw.type === 'videos/refreshAll') {
        const skipFetched = !!raw.payload?.skipFetched;
        const apiKey = await getApiKey();
        if (!apiKey) { sendResponse?.({ ok: false, error: 'Missing API key' }); return; }
        const ids = await listVideoIds({ skipFetched });
        const parts = [
          'snippet', 'contentDetails', 'status', 'statistics',
          'topicDetails', 'recordingDetails', 'liveStreamingDetails', 'localizations'
        ].join(',');
        const chunkSize = 50;
        const total = ids.length;
        let processed = 0; // ids attempted
        let applied = 0;   // items returned
        let failedBatches = 0;
        for (let i = 0; i < ids.length; i += chunkSize) {
          const batch = ids.slice(i, i + chunkSize);
          if (batch.length === 0) continue;
          processed += batch.length;
          try {
            const items = await fetchVideosListWithRetry(parts, batch, apiKey);
            applied += items.length;
            for (const it of items) {
              try {
                // Selective API-change history: title/description diffs
                const id = it?.id;
                if (id) {
                  try {
                    const db = await openDB();
                    await new Promise<void>((resolve, reject) => {
                      const tx = db.transaction('videos', 'readonly');
                      const os = tx.objectStore('videos');
                      const g = os.get(id);
                      g.onsuccess = () => {
                        const prev: any = g.result || null;
                        const prevTitle = prev?.title || null;
                        const prevDesc = typeof prev?.description === 'string' ? prev.description : null;
                        // We no longer track video thumbnail URL changes (derivable from id) to reduce noise/size
                        const sn = it?.snippet || {};
                        const nextTitle: string | null = sn?.title || null;
                        const nextDesc: string | null = (typeof sn?.description === 'string') ? sn.description : null;
                        const changed: any = {};
                        if (prevTitle != null && nextTitle != null && prevTitle !== nextTitle) changed.title = { from: prevTitle, to: nextTitle };
                        if (prevDesc != null && nextDesc != null && prevDesc !== nextDesc) changed.description = { from: trimText(prevDesc), to: trimText(nextDesc) };
                        if (Object.keys(changed).length) {
                          try { recordEvent('videos/attrChanged', { id, changed }, { impact: { videos: 1 } }); } catch {}
                        }
                        resolve();
                      };
                      g.onerror = () => reject(g.error);
                    });
                  } catch {}
                }
                await applyYouTubeVideo(it);
              } catch { /* ignore */ }
            }
          } catch (e: any) {
            failedBatches += 1;
            const msg = e?.message || String(e);
            chrome.runtime.sendMessage({ type: 'refresh/error', payload: { batchStart: i, batchSize: batch.length, message: msg } });
          }
          chrome.runtime.sendMessage({ type: 'refresh/progress', payload: { processed, total, applied, failedBatches } });
          await sleep(300); // longer pause to reduce memory/CPU pressure
        }
        // After video refresh, build/refresh channel directory:
        // 1) fetch missing channels for any channel ids seen in videos
        // 2) also fetch any existing channel rows that have never been fetched (stubs)
        try {
          const chanIds = await listDistinctChannelIds();
          const missing = await missingChannelIds(chanIds);
          const stale = await listChannelIdsNeedingFetch();
          const toFetch = Array.from(new Set<string>([...missing, ...stale]));
          const chanChunk = 50;
          for (let j = 0; j < toFetch.length; j += chanChunk) {
            const batch = toFetch.slice(j, j + chanChunk);
            try {
              const items = await fetchChannelsListWithRetry(['snippet','statistics','brandingSettings','contentDetails','topicDetails'].join(','), batch, apiKey);
              for (const ch of items) {
                try {
                  const id = ch?.id;
                  if (id) {
                    try {
                      const db = await openDB();
                      await new Promise<void>((resolve, reject) => {
                        const tx = db.transaction('channels', 'readonly');
                        const os = tx.objectStore('channels');
                        const g = os.get(id);
                        g.onsuccess = () => {
                          const prev: any = g.result || null;
                          // Compare compact avatar ids instead of URLs; banner no longer stored
                          const prevAvatar = (prev?.thumbnailID || null) as (string | null);
                          const prevDesc = typeof prev?.description === 'string' ? prev.description : null;
                          const sn = ch?.snippet || {};
                          const branding = ch?.brandingSettings || {};
                          const nextAvatar = ((): string | null => {
                            try { return (sn?.thumbnails?.high?.url || sn?.thumbnails?.medium?.url || sn?.thumbnails?.default?.url || null) as (string | null); } catch { return null; }
                          })();
                          const nextAvatarId = ((): string | null => {
                            try {
                              const u = nextAvatar; if (!u) return null;
                              const marker = 'yt3.ggpht.com/';
                              const i = u.indexOf(marker); if (i === -1) return null;
                              const start = i + marker.length;
                              const eq = u.indexOf('=', start);
                              let end = eq !== -1 ? eq : u.length;
                              const q = u.indexOf('?', start); if (q !== -1 && q < end) end = q;
                              const h = u.indexOf('#', start); if (h !== -1 && h < end) end = h;
                              const base = u.slice(start, end).replace(/\/+$/,'');
                              return base || null;
                            } catch { return null; }
                          })();
                          const nextDesc = (typeof sn?.description === 'string') ? sn.description : null;
                          const changed: any = {};
                          if (prevAvatar != null && nextAvatarId != null && prevAvatar !== nextAvatarId) changed.thumbnailID = { from: prevAvatar, to: nextAvatarId };
                          if (prevDesc != null && nextDesc != null && prevDesc !== nextDesc) changed.description = { from: trimText(prevDesc), to: trimText(nextDesc) };
                          if (Object.keys(changed).length) {
                            try { recordEvent('channels/attrChanged', { id, changed }, { impact: { channels: 1 } }); } catch {}
                          }
                          resolve();
                        };
                        g.onerror = () => reject(g.error);
                      });
                    } catch {}
                  }
                  await applyYouTubeChannel(ch);
                } catch { /* ignore */ }
              }
            } catch (e: any) {
              const msg = e?.message || String(e);
              chrome.runtime.sendMessage({ type: 'refresh/error', payload: { scope: 'channels', batchStart: j, batchSize: batch.length, message: msg } });
            }
            await sleep(300);
          }
          chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } });
        } catch { /* ignore */ }
        try {
          // Compute videoTags and per-channel videoTopics now that videos are current
          await recomputeVideoTagsForAllChannels();
          await recomputeChannelVideoTopicsForAllChannels();
          chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } });
        } catch {}
        try {
          await recomputeVideoTopicsMeta();
          chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'topics' } });
        } catch {}
        try { chrome.storage?.local?.set({ lastRefreshAt: Date.now() }); } catch {}
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } });
        chrome.runtime.sendMessage({ type: 'refresh/done', payload: { processed, total, applied, failedBatches, at: Date.now() } });
        scheduleBackup();
        sendResponse?.({ ok: true, processed, total, applied, failedBatches });
      } else if (raw.type === 'videos/stubsCount') {
        try {
          const db = await openDB();
          const tx = db.transaction('videos', 'readonly');
          const os = tx.objectStore('videos');
          const cur = os.openCursor();
          let count = 0;
          await new Promise<void>((resolve, reject) => {
            cur.onsuccess = () => {
              const c = cur.result as IDBCursorWithValue | null;
              if (!c) { resolve(); return; }
              const row: any = c.value;
              const hidden = Array.isArray(row?.tags) && row.tags.some((t: any) => String(t||'').toLowerCase() === 'hide');
              if (!hidden && !Number.isFinite(row?.fetchedAt)) count += 1;
              c.continue();
            };
            cur.onerror = () => reject(cur.error);
          });
          sendResponse?.({ ok: true, count });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e), count: 0 });
        }
      } else if ((raw as any)?.type === 'channels/stubsCount') {
        try {
          const db = await openDB();
          const tx = db.transaction('channels', 'readonly');
          const os = tx.objectStore('channels');
          const cur = os.openCursor();
          let count = 0;
          await new Promise<void>((resolve, reject) => {
            cur.onsuccess = () => {
              const c = cur.result as IDBCursorWithValue | null;
              if (!c) { resolve(); return; }
              const row: any = c.value;
              const hidden = Array.isArray(row?.tags) && row.tags.some((t: any) => String(t||'').toLowerCase() === 'hide');
              if (!hidden && !Number.isFinite(row?.fetchedAt)) count += 1;
              c.continue();
            };
            cur.onerror = () => reject(cur.error);
          });
          sendResponse?.({ ok: true, count });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e), count: 0 });
        }
      } else if ((raw as any)?.type === 'channels/pending/list') {
        try {
          const items = await listPendingChannels();
          sendResponse?.({ ok: true, items });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      } else if ((raw as any)?.type === 'channels/pending/delete') {
        try {
          const key = String(((raw as any)?.payload?.key) || '');
          const ok = await deletePendingChannel(key);
          if (ok) {
            try { recordEvent('pending/delete', { key }, { impact: {} }); } catch {}
          }
          sendResponse?.({ ok });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      } else if ((raw as any)?.type === 'channels/pending/resolveBatch') {
        try {
          const limit = Math.max(1, Math.min(20, Number((raw as any)?.payload?.limit || 5)));
          const all = await listPendingChannels();
          const session = ensureResolveSession();
          const candidates: Array<{ key: string; url: string }> = [];
          for (const it of all) {
            const key = String(it.key || '');
            const handle = String(it.handle || '').trim();
            const name = String(it.name || '').trim();
            // Skip already tried in this session
            if (session.tried.has(key)) continue;
            // If we already have this channel with the same handle, drop pending immediately
            if (handle) {
              const hNorm = handle.startsWith('@') ? handle : ('@' + handle);
              const existing = await getChannelByHandle(hNorm);
              if (existing && String(existing.customUrl || '').trim()) {
                try { await deletePendingChannel(key); } catch {}
                session.tried.add(key);
                continue;
              }
            }
            if (handle) {
              const h = handle.startsWith('@') ? handle : ('@' + handle);
              candidates.push({ key, url: `https://www.youtube.com/${h}` });
            } else if (name) {
              // Try vanity root by stripping spaces
              const vanity = name.replace(/\s+/g, '');
              candidates.push({ key, url: `https://www.youtube.com/${encodeURIComponent(vanity)}` });
            }
          }
          let opened = 0;
          for (const c of candidates) {
            if (opened >= limit) break;
            session.tried.add(c.key);
            const tab = await chrome.tabs?.create?.({ url: c.url, active: false });
            const tabId = tab?.id;
            if (typeof tabId === 'number') {
              autoResolveTabIds.add(tabId);
              opened++;
              setTimeout(() => {
                try {
                  if (autoResolveTabIds.has(tabId)) { autoResolveTabIds.delete(tabId); chrome.tabs?.remove?.(tabId); }
                } catch {}
              }, 25000);
            }
          }
          const remaining = Math.max(0, candidates.length - opened);
          sendResponse?.({ ok: true, opened, remaining });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      }
      // --- Backup routes ---
      else if ((raw as any)?.type === 'backup/saveSettings') {
        // Manually triggered settings backup. Also attempt to flush/replay history backlog.
        try {
          try { chrome.runtime.sendMessage({ type: 'backup/progress', payload: {} }); } catch {}
          try { await finalizeCommitAndFlushIfAny(); } catch {}
          const snapshot = await (async (): Promise<SettingsSnapshot> => {
            const [tags, tagGroups, groups] = await Promise.all([
              listTags().catch(() => []),
              listTagGroups().catch(() => []),
              listGroups().catch(() => []),
            ]);
            // Also include compact indices
            const db = await openDB();
            const videoIndex: any[] = [];
            const channelIndex: any[] = [];
            const pendingChannels: any[] = [];
            await new Promise<void>((resolve, reject) => {
              const tx = db.transaction(['videos','channels','channels_pending'] as any, 'readonly');
              const vs = tx.objectStore('videos');
              const curV = vs.openCursor();
              curV.onsuccess = () => {
                const c = curV.result as IDBCursorWithValue | null;
                if (!c) return;
                const r: any = c.value || {};
                const entry: any = { id: r.id };
                if (Array.isArray(r.tags) && r.tags.length) entry.tags = r.tags.slice();
                if (Array.isArray(r.sources) && r.sources.length) entry.sources = r.sources.map((s: any) => ({ type: String(s?.type || ''), id: (s?.id ?? null) }));
                let ps: number | null = null;
                try {
                  const sec = Number(r?.progress?.sec);
                  if (Number.isFinite(sec) && sec > 0) ps = Math.floor(sec);
                  else {
                    const pct = Number(r?.progress?.pct);
                    const dur = Number(r?.progress?.duration ?? r?.durationSec);
                    if (Number.isFinite(pct) && Number.isFinite(dur) && dur > 0) ps = Math.floor(Math.max(0, Math.min(100, pct)) / 100 * dur);
                  }
                } catch {}
                if (ps != null) entry.progressSec = ps;
                if (r.channelId) entry.channelId = r.channelId;
                videoIndex.push(entry);
                c.continue();
              };
              curV.onerror = () => reject(curV.error);
              const cs = tx.objectStore('channels');
              const curC = cs.openCursor();
              curC.onsuccess = () => {
                const c = curC.result as IDBCursorWithValue | null;
                if (!c) return;
                const r: any = c.value || {};
                const entry: any = { id: r.id };
                if (Array.isArray(r.tags) && r.tags.length) entry.tags = r.tags.slice();
                channelIndex.push(entry);
                c.continue();
              };
              curC.onerror = () => reject(curC.error);
              const ps = (tx as any).objectStore('channels_pending') as IDBObjectStore;
              const curP = ps.openCursor();
              curP.onsuccess = () => {
                const c = curP.result as IDBCursorWithValue | null;
                if (!c) return;
                const r: any = c.value || {};
                pendingChannels.push({ key: String(r.key || ''), name: r.name ?? null, handle: r.handle ?? null });
                c.continue();
              };
              curP.onerror = () => reject(curP.error);
              tx.oncomplete = () => resolve();
              tx.onerror = () => reject(tx.error);
            });
            return { version: 1, at: Date.now(), tags: tags as any, tagGroups: tagGroups as any, groups: groups as any, videoIndex, channelIndex, pendingChannels };
          })();
          await saveSettingsNow(snapshot, { interactive: true });
          try { void replayUnsyncedCommitsToDrive(); } catch {}
          try { const now = Date.now(); chrome.storage?.local?.set({ lastBackupAt: now }); chrome.runtime.sendMessage({ type: 'backup/done', payload: { at: now } }); } catch {}
          sendResponse?.({ ok: true });
        } catch (e: any) {
          try { chrome.runtime.sendMessage({ type: 'backup/error', payload: { message: e?.message || String(e) } }); } catch {}
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      } else if ((raw as any)?.type === 'backup/config/get') {
        try {
          const o = await new Promise<any>((res) => chrome.storage?.local?.get([BACKUP_CFG.driveEnabledKey, BACKUP_CFG.localEnabledKey, BACKUP_CFG.driveLastKey, BACKUP_CFG.localLastKey], (x)=>res(x)));
          const driveEnabled = o?.[BACKUP_CFG.driveEnabledKey] !== false;
          const localEnabled = o?.[BACKUP_CFG.localEnabledKey] !== false;
          const lastDriveUploadAt = Number.isFinite(o?.[BACKUP_CFG.driveLastKey]) ? Number(o[BACKUP_CFG.driveLastKey]) : null;
          const lastLocalDownloadAt = Number.isFinite(o?.[BACKUP_CFG.localLastKey]) ? Number(o[BACKUP_CFG.localLastKey]) : null;
          sendResponse?.({ ok: true, driveEnabled, localEnabled, lastDriveUploadAt, lastLocalDownloadAt });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      } else if ((raw as any)?.type === 'backup/config/set') {
        try {
          const driveEnabled = !!((raw as any)?.payload?.driveEnabled ?? true);
          const localEnabled = !!((raw as any)?.payload?.localEnabled ?? true);
          await chrome.storage?.local?.set?.({ [BACKUP_CFG.driveEnabledKey]: driveEnabled, [BACKUP_CFG.localEnabledKey]: localEnabled });
          sendResponse?.({ ok: true });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      } else if ((raw as any)?.type === 'backup/runNow') {
        try { await runBackupTick({ interactive: true }); sendResponse?.({ ok: true }); }
        catch (e: any) { sendResponse?.({ ok: false, error: e?.message || String(e) }); }
      } else if ((raw as any)?.type === 'backup/local/downloadNow') {
        try { const snap = await getCurrentSettingsSnapshot(); await triggerLocalDownload(snap); chrome.storage?.local?.set?.({ [BACKUP_CFG.localLastKey]: Date.now() }); sendResponse?.({ ok: true }); }
        catch (e: any) { sendResponse?.({ ok: false, error: e?.message || String(e) }); }
      } else if ((raw as any)?.type === 'backup/getClientId') {
        try {
          const id = await getClientIdState();
          sendResponse?.({ ok: true, clientId: id });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      } else if ((raw as any)?.type === 'backup/setClientId') {
        try {
          const id = String((raw as any)?.payload?.clientId || '');
          await setClientId(id);
          // After client id is configured, try to create a baseline snapshot interactively
          try { await ensureBaselineSnapshot({ interactive: true }); } catch {}
          sendResponse?.({ ok: true });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      } else if ((raw as any)?.type === 'backup/restoreSettings') {
        try {
          
          const snap = await restoreSettings();
          sendResponse?.({ ok: true, snapshot: snap });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      } else if ((raw as any)?.type === 'backup/listFiles') {
        try {
          const items = await listAppDataFiles();
          sendResponse?.({ ok: true, items });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e), items: [] });
        }
      } else if ((raw as any)?.type === 'backup/downloadFile') {
        try {
          const id = String((raw as any)?.payload?.id || '');
          if (!id) { sendResponse?.({ ok: false, error: 'Missing id' }); return; }
          const res = await downloadAppDataFileBase64(id);
          sendResponse?.({ ok: true, ...res });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      } else if ((raw as any)?.type === 'backup/downloadFileRange') {
        try {
          const id = String((raw as any)?.payload?.id || '');
          const start = Number((raw as any)?.payload?.start ?? 0);
          const lengthRaw = (raw as any)?.payload?.length;
          const length = (lengthRaw == null) ? undefined : Number(lengthRaw);
          if (!id) { sendResponse?.({ ok: false, error: 'Missing id' }); return; }
          if (!Number.isFinite(start) || start < 0) { sendResponse?.({ ok: false, error: 'Invalid start' }); return; }
          if (length != null && (!Number.isFinite(length) || length <= 0)) { sendResponse?.({ ok: false, error: 'Invalid length' }); return; }
          const r = await downloadAppDataFileRangeBase64(id, start, length, { interactive: true });
          sendResponse?.({ ok: true, contentB64: r.contentB64, nextStart: r.nextStart, total: r.total ?? null, done: !!r.done });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      } else if ((raw as any)?.type === 'backup/wipeAll') {
        try {
          // Delete all Drive appData files
          const items = await listAppDataFiles({ interactive: true });
          let deleted = 0;
          for (const f of items) {
            try { await deleteAppDataFile(f.id, { interactive: true }); deleted++; } catch {}
          }
          // Clear local IndexedDB stores (full reset)
          try {
            const db = await openDB();
            const names: string[] = Array.from(db.objectStoreNames as any);
            if (names.length) {
              await new Promise<void>((resolve, reject) => {
                const tx = db.transaction(names as any, 'readwrite');
                for (const n of names) {
                  try { tx.objectStore(n).clear(); } catch {}
                }
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
              });
            }
          } catch {}
          // Clear local flags related to backup/history queue/state
          try { chrome.storage?.local?.remove?.(['drive.unsyncedCommitIds','eventsWeightSinceSnap','eventsMonthSizeBytes','lastBackupAt']); } catch {}
          // Notify UIs to refresh
          try { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'tags' } }); } catch {}
          try { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'groups' } }); } catch {}
          try { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } }); } catch {}
          try { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } }); } catch {}
          sendResponse?.({ ok: true, deleted });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      } else if ((raw as any)?.type === 'backup/history/list') {
        try {
          const limit = Number((raw as any)?.payload?.limit || 100);
          const commits = await listHistoryCommits(limit);
          sendResponse?.({ ok: true, commits });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e), commits: [] });
        }
      } else if ((raw as any)?.type === 'backup/history/getCommit') {
        try {
          const cid = String((raw as any)?.payload?.commitId || '');
          if (!cid) { sendResponse?.({ ok: false, error: 'Missing commitId' }); return; }
          const events = await getHistoryCommitEvents(cid);
          const text = events.map(ev => JSON.stringify({ ts: ev.ts, kind: ev.kind, payload: ev.payload, impact: ev.impact })).join('\n') + '\n';
          const b64 = utf8ToB64(text);
          sendResponse?.({ ok: true, contentB64: b64, name: `commit-${cid}.jsonl`, mimeType: 'text/plain' });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      } else if ((raw as any)?.type === 'backup/history/usage') {
        try {
          const items = await listAppDataFiles({ interactive: true });
          const total = items.reduce((n, f) => n + (Number(f.size) || 0), 0);
          sendResponse?.({ ok: true, totalBytes: total, files: items.length });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      } else if ((raw as any)?.type === 'backup/history/snapshotNow') {
        try {
          
          const interactive: boolean = !!(raw as any)?.payload?.interactive;
          const customName: string | undefined = (raw as any)?.payload?.name || undefined;
          const snap = await getCurrentSettingsSnapshot();
          const ts = new Date().toISOString().replace(/[:.]/g, '').replace('T','-').slice(0, 15);
          const name = customName && customName.trim() ? customName.trim() : `snapshots/settings-${ts}.json`;
          await saveSnapshotWithName(name, snap, { interactive });
          try { void replayUnsyncedCommitsToDrive(); } catch {}
          try { const now = Date.now(); chrome.storage?.local?.set({ lastBackupAt: now }); chrome.runtime.sendMessage({ type: 'backup/done', payload: { at: now } }); } catch {}
          sendResponse?.({ ok: true, name });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      } else if ((raw as any)?.type === 'backup/history/revertTo') {
        try {
          const cid = String((raw as any)?.payload?.commitId || '');
          const dry = !!(raw as any)?.payload?.dryRun;
          
          if (!cid) { sendResponse?.({ ok: false, error: 'Missing commitId' }); return; }
          const commit = await getHistoryCommit(cid);
          if (!commit) { sendResponse?.({ ok: false, error: 'Unknown commitId' }); return; }
          // Find latest snapshot (snapshots/settings-*.json) with modifiedTime <= commit.ts
          const files = await listAppDataFiles({ interactive: true });
          let chosenSnap: { name: string; modifiedTime?: string | null } | null = null;
          for (const f of files) {
            const n = f.name || '';
            if (n.startsWith('snapshots/')) {
              const t = Date.parse(String(f.modifiedTime || '')) || 0;
              if (t > 0 && t <= commit.ts) {
                if (!chosenSnap || (Date.parse(String(chosenSnap.modifiedTime || '')) || 0) < t) {
                  chosenSnap = { name: n, modifiedTime: f.modifiedTime };
                }
              }
            }
          }
          if (!chosenSnap) { sendResponse?.({ ok: false, error: 'No snapshot found before target commit' }); return; }
          const base = await downloadSnapshotByName(chosenSnap.name, { interactive: true as any });
          if (!base) { sendResponse?.({ ok: false, error: 'Failed to load snapshot' }); return; }
          // Build events up to and including target commit (similar to getUpTo)
          const monthKey = (() => { const d = new Date(commit.ts); const y=d.getUTCFullYear(); const m=String(d.getUTCMonth()+1).padStart(2,'0'); return `${y}-${m}`; })();
          const evLines: string[] = [];
          for (const f of files) {
            const name = f.name || '';
            if (!(name.startsWith('events-') && name.endsWith('.jsonl'))) continue;
            const month = name.substring('events-'.length, 'events-'.length+7);
            if (month < monthKey) {
              const one = await downloadAppDataFileBase64(f.id, { interactive: true });
              evLines.push(atob(one.contentB64));
            } else if (month === monthKey) {
              const one = await downloadAppDataFileBase64(f.id, { interactive: true });
              const text = atob(one.contentB64);
              const lines = text.split('\n');
              const header = lines[0] || '';
              let lastIdx = -1;
              for (let i=1;i<lines.length;i++) {
                const line = lines[i]; if (!line.trim()) continue;
                try { const obj = JSON.parse(line); if (obj?.commitId === cid) lastIdx = i; } catch {}
              }
              const keep: string[] = [header];
              if (lastIdx >= 1) { for (let i=1;i<=lastIdx;i++) { const ln = lines[i]; if ((ln||'').trim()) keep.push(ln); } }
              evLines.push(keep.join('\n'));
            }
          }
          // Parse and replay
          const result: SettingsSnapshot = JSON.parse(JSON.stringify(base));
          const archiveVideos = new Map<string, any>();
          const archiveChannels = new Map<string, any>();
          const tagsSet = new Set((result.tags || []).map(t => t.name));
          const tagByName = new Map<string, any>((result.tags || []).map(t => [t.name, t] as [string, any]));
          const tgById = new Map<string, any>((result.tagGroups || []).map(g => [g.id, g] as [string, any]));
          const groupsById = new Map<string, any>((result.groups || []).map(g => [g.id, g] as [string, any]));
          const vidsById = new Map<string, any>((result.videoIndex || []).map(v => [v.id, v] as [string, any]));
          const chansById = new Map<string, any>((result.channelIndex || []).map(c => [c.id, c] as [string, any]));
          const applyTagAdd = (arr: string[]|undefined, add: string[]) => {
            const set = new Set(arr || []); for (const t of add||[]) if (t) set.add(String(t)); return Array.from(set.values()); };
          const applyTagRem = (arr: string[]|undefined, rem: string[]) => {
            const set = new Set(arr || []); for (const t of rem||[]) set.delete(String(t)); return Array.from(set.values()); };
          const pushUnique = (list: any[], obj: any, key: string) => { const set=new Set(list.map((x:any)=>x[key])); if (!set.has(obj[key])) list.push(obj); };
          const parseAndReplay = (text: string) => {
            const lines = (text || '').split('\n');
            for (let i=1;i<lines.length;i++) {
              const line = lines[i]; if (!line || !line.trim()) continue;
              let ev: any; try { ev = JSON.parse(line); } catch { continue; }
              const k = String(ev?.kind || ''); const p = ev?.payload || {};
              if (k === 'tags/create') { const name = String(p?.name||''); if (name && !tagsSet.has(name)) { const rec:any={ name, createdAt: Date.now() }; (result.tags||(result.tags=[])).push(rec); tagsSet.add(name); tagByName.set(name, rec); } }
              else if (k === 'tags/rename') { const from=String(p?.oldName||''); const to=String(p?.newName||''); if (from && to && from!==to && tagsSet.has(from)) { tagsSet.delete(from); tagsSet.add(to); const t=tagByName.get(from); if (t){ t.name=to; tagByName.delete(from); tagByName.set(to,t);} (result.videoIndex||[]).forEach(v=>{ if(Array.isArray((v as any).tags)) (v as any).tags = (v as any).tags.map((x:string)=> x===from?to:x); }); (result.channelIndex||[]).forEach(c=>{ if(Array.isArray((c as any).tags)) (c as any).tags = (c as any).tags.map((x:string)=> x===from?to:x); }); } }
              else if (k === 'tags/delete') { const name=String(p?.name||''); if (name) { (result.tags||[]).splice((result.tags||[]).findIndex(t=>t.name===name),1); tagsSet.delete(name); tagByName.delete(name); (result.videoIndex||[]).forEach(v=>{ if(Array.isArray((v as any).tags)) (v as any).tags = (v as any).tags.filter((x:string)=> x!==name); }); (result.channelIndex||[]).forEach(c=>{ if(Array.isArray((c as any).tags)) (c as any).tags = (c as any).tags.filter((x:string)=> x!==name); }); } }
              else if (k === 'tags/assignGroup') { const name=String(p?.name||''); const gid = (p?.groupId ?? null) as (string|null); const t = tagByName.get(name); if (t) { t.groupId = gid || undefined; } }
              else if (k === 'tagGroups/create') { const id=String(p?.id||''); const name=String(p?.name||''); if (id && name && !tgById.has(id)) { const rec:any={ id, name, createdAt: Date.now() }; (result.tagGroups||(result.tagGroups=[])).push(rec); tgById.set(id, rec); } }
              else if (k === 'tagGroups/rename') { const id=String(p?.id||''); const name=String(p?.name||''); const g=tgById.get(id); if (g) g.name=name; }
              else if (k === 'tagGroups/delete') { const id=String(p?.id||''); if (id) { (result.tagGroups||[]).splice((result.tagGroups||[]).findIndex(g=>g.id===id),1); tgById.delete(id); (result.tags||[]).forEach(t=>{ if ((t as any).groupId===id) delete (t as any).groupId; }); } }
              else if (k === 'groups/create') { const id=String(p?.id||''); if (id && !groupsById.has(id)) { const rec:any={ id, name: p?.name||id, condition: p?.condition, createdAt: Date.now(), updatedAt: Date.now(), scrape: !!p?.scrape }; (result.groups||(result.groups=[])).push(rec); groupsById.set(id, rec); } }
              else if (k === 'groups/update') { const id=String(p?.id||''); const g=groupsById.get(id); if (g) { const patch=p?.patch||{}; Object.assign(g, patch, { updatedAt: Date.now() }); } }
              else if (k === 'groups/delete') { const id=String(p?.id||''); if (id) { (result.groups||[]).splice((result.groups||[]).findIndex(g=>g.id===id),1); groupsById.delete(id); } }
              else if (k === 'channels/applyTags') { const ids:Array<string>=Array.isArray(p?.ids)?p.ids:[]; const add:Array<string>=Array.isArray(p?.addIds)?p.addIds:[]; const rem:Array<string>=Array.isArray(p?.removeIds)?p.removeIds:[]; for (const id of ids){ const row = chansById.get(id) || { id, tags: [] as string[] }; row.tags = applyTagRem(applyTagAdd(row.tags, add), rem); chansById.set(id, row); pushUnique((result.channelIndex||(result.channelIndex=[])), row, 'id'); } }
              else if (k === 'videos/applyTags') { const ids:Array<string>=Array.isArray(p?.ids)?p.ids:[]; const add:Array<string>=Array.isArray(p?.addIds)?p.addIds:[]; const rem:Array<string>=Array.isArray(p?.removeIds)?p.removeIds:[]; for (const id of ids){ const row = vidsById.get(id) || { id, tags: [] as string[] }; row.tags = applyTagRem(applyTagAdd(row.tags, add), rem); vidsById.set(id, row); pushUnique((result.videoIndex||(result.videoIndex=[])), row, 'id'); } }
              else if (k === 'videos/delete') { const ids:Array<string>=Array.isArray(p?.ids)?p.ids:[]; for (const id of ids){ const i=(result.videoIndex||[]).findIndex(v=>v.id===id); if (i>=0) { archiveVideos.set(id, (result.videoIndex as any)[i]); (result.videoIndex as any).splice(i,1); vidsById.delete(id); } } }
              else if (k === 'videos/restore') { const ids:Array<string>=Array.isArray(p?.ids)?p.ids:[]; for (const id of ids){ const prev = archiveVideos.get(id); if (prev) { pushUnique((result.videoIndex||(result.videoIndex=[])), prev, 'id'); vidsById.set(id, prev); } } }
              else if (k === 'channels/delete') { const ids:Array<string>=Array.isArray(p?.ids)?p.ids:[]; for (const id of ids){ const i=(result.channelIndex||[]).findIndex(c=>c.id===id); if (i>=0) { archiveChannels.set(id, (result.channelIndex as any)[i]); (result.channelIndex as any).splice(i,1); chansById.delete(id); } } }
              else if (k === 'channels/restore') { const ids:Array<string>=Array.isArray(p?.ids)?p.ids:[]; for (const id of ids){ const prev = archiveChannels.get(id); if (prev) { pushUnique((result.channelIndex||(result.channelIndex=[])), prev, 'id'); chansById.set(id, prev); } } }
              else if (k === 'pending/upsert') { const key=String(p?.key||''); const name=p?.name ?? null; const handle=p?.handle ?? null; if (key){ const list=(result.pendingChannels||(result.pendingChannels=[])); const idx=list.findIndex((x:any)=>x.key===key); const row={ key, name, handle }; if (idx>=0) list[idx]=row; else list.push(row); } }
              else if (k === 'pending/resolve') { /* Best-effort: remove matching pending by handle or name */ const id=String(p?.id||''); const name=p?.name ?? null; const handle=p?.handle ?? null; const list=(result.pendingChannels||(result.pendingChannels=[])); (result.pendingChannels as any) = list.filter((x:any)=> !((handle && x.handle===handle) || (name && x.name===name))); }
            }
          };
          for (const chunk of evLines) { if (chunk) parseAndReplay(chunk); }
          const applyFlags = { channelTags: true, videoTags: true, sources: true, progress: true } as const;
          if (dry) {
            const summary = await dryRunRestoreApply(result, 'overwrite', applyFlags);
            sendResponse?.({ ok: true, summary });
          } else {
            const summary = await applyRestore(result, 'overwrite', applyFlags);
            try { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'tags' } }); } catch {}
            try { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'groups' } }); } catch {}
            try { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } }); } catch {}
            try { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } }); } catch {}
            queueCommitFlush(3000);
            queueSettingsBackup();
            sendResponse?.({ ok: true, summary });
          }
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      } else if ((raw as any)?.type === 'backup/history/getUpTo') {
        try {
          const cid = String((raw as any)?.payload?.commitId || '');
          if (!cid) { sendResponse?.({ ok: false, error: 'Missing commitId' }); return; }
          const commit = await getHistoryCommit(cid);
          if (!commit) { sendResponse?.({ ok: false, error: 'Unknown commitId' }); return; }
          const commitMonth = (() => { const d = new Date(commit.ts); const y=d.getUTCFullYear(); const m=String(d.getUTCMonth()+1).padStart(2,'0'); return `${y}-${m}`; })();
          const files = await listAppDataFiles({ interactive: true });
          // Collect earlier full months and partial of commit month
          const out: Array<{ name: string; contentB64: string }> = [];
          for (const f of files) {
            const name = f.name || '';
            if (name.startsWith('events-') && name.endsWith('.jsonl')) {
              const month = name.substring('events-'.length, 'events-'.length+7);
              if (month < commitMonth) {
                // full file
                const one = await downloadAppDataFileBase64(f.id, { interactive: true });
                out.push({ name, contentB64: one.contentB64 });
              } else if (month === commitMonth) {
                const one = await downloadAppDataFileBase64(f.id, { interactive: true });
                const text = atob(one.contentB64);
                const lines = text.split('\n');
                const header = lines[0] || '';
                // Include all lines up to and including the LAST event of this commitId
                let lastIdx = -1;
                for (let i=1;i<lines.length;i++) {
                  const line = lines[i];
                  if (!line.trim()) continue;
                  try { const obj = JSON.parse(line); if (obj?.commitId === cid) lastIdx = i; } catch { /* ignore */ }
                }
                const keep: string[] = [header];
                if (lastIdx >= 1) {
                  for (let i=1;i<=lastIdx;i++) { const ln = lines[i]; if ((ln || '').trim()) keep.push(ln); }
                } else {
                  // Fallback: include sequentially until first match (unlikely if commit exists)
                  for (let i=1;i<lines.length;i++) {
                    const ln = lines[i]; if (!ln || !ln.trim()) continue; keep.push(ln);
                    try { const obj = JSON.parse(ln); if (obj?.commitId === cid) break; } catch {}
                  }
                }
                const partial = keep.join('\n') + '\n';
                const b64 = utf8ToB64(partial);
                out.push({ name: `${name.replace(/\.jsonl$/, '')}-upTo-${cid}.jsonl`, contentB64: b64 });
              }
            } else if (name.startsWith('snapshots/')) {
              // include snapshots older than commit ts
              const t = Date.parse(String(f.modifiedTime || '')) || 0;
              if (t > 0 && t <= commit.ts) {
                const one = await downloadAppDataFileBase64(f.id);
                out.push({ name, contentB64: one.contentB64 });
              }
            }
          }
          sendResponse?.({ ok: true, files: out });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      } else if ((raw as any)?.type === 'backup/history/deleteUpTo') {
        try {
          const cid = String((raw as any)?.payload?.commitId || '');
          if (!cid) { sendResponse?.({ ok: false, error: 'Missing commitId' }); return; }
          const commit = await getHistoryCommit(cid);
          if (!commit) { sendResponse?.({ ok: false, error: 'Unknown commitId' }); return; }
          const commitMonth = (() => { const d = new Date(commit.ts); const y=d.getUTCFullYear(); const m=String(d.getUTCMonth()+1).padStart(2,'0'); return `${y}-${m}`; })();
          const files = await listAppDataFiles({ interactive: true });
          let deleted = 0;
          // Delete full earlier months and older snapshots; rewrite partial month after commit
          for (const f of files) {
            const name = f.name || '';
            if (name.startsWith('events-') && name.endsWith('.jsonl')) {
              const month = name.substring('events-'.length, 'events-'.length+7);
              if (month < commitMonth) {
                await deleteAppDataFile(f.id); deleted++;
              } else if (month === commitMonth) {
                const one = await downloadAppDataFileBase64(f.id, { interactive: true });
                const text = atob(one.contentB64);
                const lines = text.split('\n');
                const header = lines[0] || '';
                // Compute last index where commitId===cid, then keep everything AFTER that
                let lastIdx = -1;
                for (let i=1;i<lines.length;i++) {
                  const line = lines[i];
                  if (!line.trim()) continue;
                  try { const obj = JSON.parse(line); if (obj?.commitId === cid) lastIdx = i; } catch {}
                }
                const keep: string[] = [header];
                for (let i=(lastIdx >= 0 ? lastIdx + 1 : 1); i<lines.length; i++) {
                  const ln = lines[i]; if ((ln || '').trim()) keep.push(ln);
                }
                const remain = keep.join('\n');
                await upsertAppDataTextFile(name, remain);
              }
            } else if (name.startsWith('snapshots/')) {
              const t = Date.parse(String(f.modifiedTime || '')) || 0;
              if (t > 0 && t <= commit.ts) { await deleteAppDataFile(f.id); deleted++; }
            }
          }
          // Remove existing cutoff markers and write a single cutoff.json
          try {
            const all = await listAppDataFiles();
            for (const f of all) { if ((f.name || '').startsWith('cutoff')) { try { await deleteAppDataFile(f.id); } catch {} } }
          } catch {}
          const marker = { cutoffAtCommitId: cid, cutoffAtTs: commit.ts, createdAt: Date.now() };
          await upsertAppDataTextFile(`cutoff.json`, JSON.stringify(marker, null, 2));
          // Purge local history up to this commit so UI reflects deletion
          try { await purgeHistoryUpToTs(commit.ts); } catch {}
          sendResponse?.({ ok: true, deleted });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      } else if ((raw as any)?.type === 'backup/history/import') {
        try {
          const filesIn: Array<{ name: string; contentB64: string }> = Array.isArray((raw as any)?.payload?.files) ? (raw as any).payload.files : [];
          if (!filesIn.length) { sendResponse?.({ ok: false, error: 'No files' }); return; }
          // Find imported cutoff commit from an '-upTo-<cid>' filename or cutoff marker content
          let importedCutoffCid: string | null = null;
          for (const f of filesIn) {
            const m = /^events-\d{4}-\d{2}-upTo-([^.]+)\.jsonl$/.exec(f.name);
            if (m) { importedCutoffCid = m[1]; break; }
          }
          if (!importedCutoffCid) {
            // Try to parse cutoff marker within imported files
            for (const f of filesIn) {
              if (f.name.startsWith('cutoff-') && f.name.endsWith('.json')) {
                try { const text = atob(f.contentB64); const obj = JSON.parse(text); if (obj?.cutoffAtCommitId) { importedCutoffCid = String(obj.cutoffAtCommitId); break; } } catch {}
              }
            }
          }
          // Validate against current Drive cutoff marker (if any)
          try {
            const currentFiles = await listAppDataFiles({ interactive: true });
            // Prefer cutoff.json, otherwise latest cutoff-* marker
            let chosen = currentFiles.find(f => (f.name || '') === 'cutoff.json') || null as any;
            if (!chosen) {
              const cutoffFiles = currentFiles.filter(f => (f.name || '').startsWith('cutoff'));
              if (!cutoffFiles.length) { sendResponse?.({ ok: false, error: 'No cutoff marker present in Drive; delete up to a commit first.' }); return; }
              chosen = cutoffFiles[0];
              for (const c of cutoffFiles) {
                if ((Date.parse(String(c.modifiedTime || '')) || 0) > (Date.parse(String(chosen.modifiedTime || '')) || 0)) chosen = c;
              }
            }
            const marker = await downloadAppDataFileBase64(chosen.id, { interactive: true });
            const markerObj = (()=>{ try { return JSON.parse(atob(marker.contentB64)); } catch { return null; } })();
            const expectedCid = markerObj?.cutoffAtCommitId ? String(markerObj.cutoffAtCommitId) : null;
            if (!importedCutoffCid || !expectedCid || importedCutoffCid !== expectedCid) {
              sendResponse?.({ ok: false, error: 'Imported history does not match Drive cutoff marker.' });
              return;
            }
            // Process files: events and snapshots
            for (const f of filesIn) {
              if (f.name.startsWith('events-') && f.name.endsWith('.jsonl')) {
                const m = /^events-(\d{4}-\d{2})(?:-upTo-[^.]+)?\.jsonl$/.exec(f.name);
                if (!m) continue;
                const month = m[1];
                const baseName = `events-${month}.jsonl`;
                const current = currentFiles.find(x => x.name === baseName);
                const importedText = atob(f.contentB64);
                if (!current) {
                  // Write imported (strip suffix in name)
                  await upsertAppDataTextFile(baseName, importedText, { interactive: true });
                } else {
                  // Merge: imported is earlier part; existing is later part -> remove header from later part and concat
                  const existing = await downloadAppDataFileBase64(current.id, { interactive: true });
                  const exText = atob(existing.contentB64);
                  const exLines = exText.split('\n');
                  const exBody = exLines.slice(1).join('\n');
                  const merged = importedText.replace(/\n*$/, '\n') + exBody;
                  await upsertAppDataTextFile(baseName, merged, { interactive: true });
                }
              } else if (f.name.startsWith('snapshots/')) {
                await upsertAppDataTextFile(f.name, atob(f.contentB64), { interactive: true });
              }
            }
            // Delete cutoff marker after successful import
            await deleteAppDataFile(chosen.id);
            sendResponse?.({ ok: true });
          } catch (e: any) {
            sendResponse?.({ ok: false, error: e?.message || String(e) });
          }
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      } else if ((raw as any)?.type === 'backup/restore/dryRun') {
        try {
          const { name, snapshot, mode, apply } = (raw as any).payload || {};
          let snap: SettingsSnapshot | null = null;
          if (snapshot && typeof snapshot === 'object') snap = snapshot as SettingsSnapshot;
          else if (name && typeof name === 'string') snap = await downloadSnapshotByName(String(name), {});
          else snap = await restoreSettings(); // fallback to settings.json
          if (!snap) { sendResponse?.({ ok: false, error: 'Snapshot not found' }); return; }
          const res = await dryRunRestoreApply(snap, (mode === 'overwrite' ? 'overwrite' : 'merge'), apply || {});
          sendResponse?.({ ok: true, summary: res });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      } else if ((raw as any)?.type === 'backup/restore/apply') {
        try {
          const { name, snapshot, mode, apply } = (raw as any).payload || {};
          let snap: SettingsSnapshot | null = null;
          if (snapshot && typeof snapshot === 'object') snap = snapshot as SettingsSnapshot;
          else if (name && typeof name === 'string') snap = await downloadSnapshotByName(String(name), {});
          else snap = await restoreSettings(); // fallback to settings.json
          if (!snap) { sendResponse?.({ ok: false, error: 'Snapshot not found' }); return; }
          const res = await applyRestore(snap, (mode === 'overwrite' ? 'overwrite' : 'merge'), apply || {});
          // Notify and backup
          try { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'tags' } }); } catch {}
          try { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'groups' } }); } catch {}
          try { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } }); } catch {}
          try { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } }); } catch {}
          queueCommitFlush(3000);
          queueSettingsBackup();
          sendResponse?.({ ok: true, summary: res });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      }
    } catch (e: any) {
      derr('bg handler error:', e?.message || e);
      sendResponse?.({ ok: false, error: e?.message || String(e) });
    }
  })();

  // IMPORTANT: keep the response channel open for async work
  return true;
});
self.addEventListener('unhandledrejection', (ev: any) => derr('unhandledrejection', ev?.reason));
self.addEventListener('error', (ev: any) => derr('error', ev?.message || ev));

async function getApiKey(): Promise<string | null> {
  return new Promise((resolve) => {
    try { chrome.storage?.local?.get('ytApiKey', (o) => resolve((o?.ytApiKey as string) || null)); }
    catch { resolve(null); }
  });
}

async function listVideoIds(opts: { skipFetched: boolean }): Promise<string[]> {
  const db = await openDB();
  const channelNoFetch = await channelIdsWithTag('no fetch');
  return new Promise((resolve, reject) => {
    const tx = db.transaction('videos', 'readonly');
    const os = tx.objectStore('videos');
    const cur = os.openCursor();
    const ids: string[] = [];
    cur.onsuccess = () => {
      const c = cur.result as IDBCursorWithValue | null;
      if (!c) { resolve(ids); return; }
      const row: any = c.value || {};
      const vtags: string[] = Array.isArray(row.tags) ? row.tags : [];
      const hasNoFetch = vtags.map((t: string)=> String(t||'').toLowerCase()).includes('no fetch');
      const chId = String(row.channelId || '');
      const channelBlocked = chId ? channelNoFetch.has(chId) : false;
      if (!hasNoFetch && !channelBlocked && (!opts.skipFetched || !row?.fetchedAt)) ids.push(String(row?.id || ''));
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
}

function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }

function bestThumb(thumbs: any): string | null {
  try {
    return (thumbs?.high?.url || thumbs?.medium?.url || thumbs?.default?.url || null) as (string | null);
  } catch { return null; }
}
function trimText(s: string, max: number = 1000): string { return (s || '').length > max ? (s || '').slice(0, max) + 'â€¦' : (s || ''); }

async function fetchVideosListWithRetry(parts: string, ids: string[], apiKey: string): Promise<any[]> {
  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.searchParams.set('part', parts);
  url.searchParams.set('id', ids.join(','));
  url.searchParams.set('key', apiKey);
  const maxAttempts = 3;
  let attempt = 0;
  let lastErr: any = null;
  while (attempt < maxAttempts) {
    try {
      const resp = await fetch(String(url));
      if (!resp.ok) {
        let detail = '';
        try { detail = await resp.text(); } catch { /* ignore */ }
        throw new Error(`videos.list ${resp.status} ${resp.statusText}${detail ? ' - ' + detail.slice(0, 240) : ''}`);
      }
      const data = await resp.json();
      const items = Array.isArray((data as any)?.items) ? (data as any).items : [];
      return items;
    } catch (e) {
      lastErr = e;
      attempt += 1;
      if (attempt >= maxAttempts) break;
      await sleep(500 * attempt * attempt); // 0.5s, 2s
    }
  }
  throw (lastErr || new Error('videos.list failed after retries'));
}

async function fetchChannelsListWithRetry(parts: string, ids: string[], apiKey: string): Promise<any[]> {
  const url = new URL('https://www.googleapis.com/youtube/v3/channels');
  url.searchParams.set('part', parts);
  url.searchParams.set('id', ids.join(','));
  url.searchParams.set('key', apiKey);
  const maxAttempts = 3;
  let attempt = 0;
  let lastErr: any = null;
  while (attempt < maxAttempts) {
    try {
      const resp = await fetch(String(url));
      if (!resp.ok) {
        let detail = '';
        try { detail = await resp.text(); } catch { /* ignore */ }
        throw new Error(`channels.list ${resp.status} ${resp.statusText}${detail ? ' - ' + detail.slice(0, 240) : ''}`);
      }
      const data = await resp.json();
      const items = Array.isArray((data as any)?.items) ? (data as any).items : [];
      return items;
    } catch (e) {
      lastErr = e;
      attempt += 1;
      if (attempt >= maxAttempts) break;
      await sleep(500 * attempt * attempt);
    }
  }
  throw (lastErr || new Error('channels.list failed after retries'));
}

async function listDistinctChannelIds(): Promise<string[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('videos', 'readonly');
    const os = tx.objectStore('videos');
    const idx = os.index('byChannel');
    const set = new Set<string>();
    const cur = idx.openCursor();
    cur.onsuccess = () => {
      const c = cur.result as IDBCursorWithValue | null;
      if (!c) { resolve(Array.from(set)); return; }
      const row: any = c.value;
      const chId = row?.channelId;
      if (chId) set.add(chId);
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
}

async function channelIdsForVideos(ids: string[]): Promise<string[]> {
  const set = new Set<string>();
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('videos', 'readonly');
    const os = tx.objectStore('videos');
    (async () => {
      for (const id of ids) {
        await new Promise<void>((res, rej) => {
          const g = os.get(id);
          g.onsuccess = () => { const row: any = g.result; if (row?.channelId) set.add(row.channelId); res(); };
          g.onerror = () => rej(g.error);
        });
      }
    })().then(() => (tx as any).commit?.());
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return Array.from(set);
}




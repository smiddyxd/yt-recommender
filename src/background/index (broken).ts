import { upsertVideo, upsertVideosBulk, moveToTrash, restoreFromTrash, applyTags, listChannels, wipeSourcesDuplicates, applyYouTubeVideo, openDB, missingChannelIds, applyYouTubeChannel, applyChannelTags, recomputeVideoTagsForAllChannels, recomputeVideoTagsForChannels, recomputeVideoTopicsMeta, readVideoTopicsMeta, listChannelIdsNeedingFetch, markChannelScraped, upsertChannelStub, moveChannelsToTrash, restoreChannelsFromTrash, listChannelsTrash, listTagGroups, createTagGroup, renameTagGroup, deleteTagGroup, setTagGroup, upsertPendingChannel, resolvePendingChannel, listPendingChannels, applySubscribedSet } from './db';
import type { Msg } from '../types/messages';
import { purgeVideosFromTrash, purgeChannelsFromTrash } from './db';
import { dlog, derr } from '../types/debug';
import { listTags, createTag, renameTag, deleteTag } from './db';
import { listGroups, createGroup, updateGroup, deleteGroup } from './db';
import { matches, type Group as GroupRec } from '../shared/conditions';
import { registerSettingsProducer, saveSettingsNow, initDriveBackupAlarms, getClientIdState, setClientId, type SettingsSnapshot, restoreSettings, listAppDataFiles, downloadAppDataFileBase64, queueSettingsBackup, deleteAppDataFile, upsertAppDataTextFile, downloadSnapshotByName, getCurrentSettingsSnapshot, saveSnapshotWithName } from './driveBackup';
import { recordEvent, finalizeCommitAndFlushIfAny, listCommits as listHistoryCommits, getCommitEvents as getHistoryCommitEvents, getCommit as getHistoryCommit, queueCommitFlush, purgeHistoryUpToTs, replayUnsyncedCommitsToDrive } from './events';
import { applyRestore, dryRunRestoreApply } from './restore';

// Click the extension icon to trigger scrape in active tab
// Track pending upserts to surface queue depth
let pendingUpserts = 0;
// --- Utils ---
function utf8ToB64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// --- Google Drive backup wiring ---
registerSettingsProducer(async (): Promise<SettingsSnapshot> => {
  const [tags, tagGroups, groups] = await Promise.all([
    listTags().catch(() => []),
    listTagGroups().catch(() => []),
    listGroups().catch(() => []),
  ]);
  const db = await openDB();
  const videoIndex: Array<{ id: string; tags?: string[]; sources?: Array<{ type: string; id?: string | null }>; progressSec?: number | null; channelId?: string | null }> = [];
  const channelIndex: Array<{ id: string; tags?: string[] }> = [];
  const pendingChannels: Array<{ key: string; name?: string | null; handle?: string | null }> = [];
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
    // channels
    try {
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
initDriveBackupAlarms();
// Try to ensure a baseline snapshot silently on startup (ignored if Drive not configured yet)
try { void ensureBaselineSnapshot({ interactive: false }); } catch {}

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

const autoResolveTabIds = new Set<number>();
const autoResolveTabInfo = new Map<number, { origHandle?: string | null }>();

// ---- Helpers restored after merge mishaps ----
async function getNoStubsFlag(): Promise<boolean> {
  return new Promise((resolve) => {
    try { chrome.storage?.local?.get('debug.noStubs', (o) => resolve(!!o?.['debug.noStubs'])); } catch { resolve(false); }
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

function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }

async function runScrollingScrape(url: string, override: SourceOverride, max: number, opts?: { stopOnKnown?: boolean; historyHints?: boolean; keepOpen?: boolean }): Promise<{ count: number; stopped: boolean }> {
  try { if (currentScrape) { currentScrape.stopRequested = true; for (const id of Array.from(currentScrape.tabIds.values())) { try { chrome.tabs?.remove?.(id); } catch {} } currentScrape = null; } } catch {}
  const tab = await chrome.tabs?.create?.({ url, active: true });
  const tabId = tab?.id as number | undefined;
  if (typeof tabId !== 'number') return { count: 0, stopped: true };
  currentScrape = { id: Math.floor(Math.random()*1e9), mode: override === 'WatchHistory' ? 'history' : 'subFeed', tabIds: new Set([tabId]), sourceOverride: override, limit: max, seen: new Set<string>(), stopOnKnown: !!opts?.stopOnKnown, stopRequested: false };
  await sleep(1200);
  try {
    for (let i = 0; i < 40; i++) {
      if (!currentScrape || currentScrape.stopRequested) break;
      if ((currentScrape.seen.size || 0) >= max) break;
      await new Promise((resolve) => { try { chrome.tabs?.sendMessage?.(tabId, { type: 'scrape/NOW', payload: {} }, () => resolve(undefined)); } catch { resolve(undefined); } });
      await sleep(350);
      if ((currentScrape.seen.size || 0) >= max) break;
      if (i % 3 === 2) { try { await new Promise((resolve)=> chrome.tabs?.sendMessage?.(tabId, { type: 'scrape/SCROLL_BOTTOM', payload: { times: 1, delayMs: 500 } }, () => resolve(undefined))); } catch {} }
    }
  } catch {}
  const count = currentScrape ? currentScrape.seen.size : 0;
  const stopped = !!currentScrape?.stopRequested;
  if (!(opts?.keepOpen)) { try { chrome.tabs?.remove?.(tabId); } catch {} }
  currentScrape = null;
  return { count, stopped };
}

async function runSubscriptionsManagerOnce(): Promise<{ subscribedCount: number; created: number; unsubscribed: number }> {
  try { if (currentScrape) { currentScrape.stopRequested = true; for (const id of Array.from(currentScrape.tabIds.values())) { try { chrome.tabs?.remove?.(id); } catch {} } currentScrape = null; } } catch {}
  const tab = await chrome.tabs?.create?.({ url: 'https://www.youtube.com/feed/channels', active: true });
  const tabId = tab?.id as number | undefined;
  if (typeof tabId !== 'number') return { subscribedCount: 0, created: 0, unsubscribed: 0 };
  await sleep(1200);
  let handles: string[] = [];
  try {
    const resp: any = await new Promise((resolve) => { try { chrome.tabs?.sendMessage?.(tabId, { type: 'scrape/LIST_SUBSCRIPTIONS', payload: {} }, (r: any) => resolve(r)); } catch { resolve(null); } });
    handles = Array.isArray(resp?.handles) ? resp.handles : [];
  } catch {}
  try { chrome.tabs?.remove?.(tabId); } catch {}
  for (const raw of handles) {
    const h = typeof raw === 'string' ? raw.trim() : '';
    if (!h) continue;
    const withAt = h.startsWith('@') ? h : ('@' + h);
    const key = `handle:${withAt}`;
    try { await upsertPendingChannel(key, { handle: withAt, subscribedPending: true }); } catch {}
  }
  const res = await applySubscribedSet([]);
  return { subscribedCount: handles.length, created: res.created, unsubscribed: res.unsubscribed };
}

async function channelIdsForVideos(ids: string[]): Promise<string[]> {
  if (!ids?.length) return [];
  const db = await openDB();
  const out: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('videos', 'readonly');
    const os = tx.objectStore('videos');
    let idx = 0;
    const next = () => {
      if (idx >= ids.length) { resolve(); return; }
      const id = ids[idx++];
      const g = os.get(id);
      g.onsuccess = () => { const r: any = g.result || null; if (r?.channelId) out.push(String(r.channelId)); next(); };
      g.onerror = () => next();
    };
    next();
  });
  return Array.from(new Set(out));
}

async function getApiKey(): Promise<string | null> {
  return new Promise((resolve) => { try { chrome.storage?.local?.get('ytApiKey', (o) => resolve((o?.ytApiKey ? String(o.ytApiKey) : null))); } catch { resolve(null); } });
}

async function fetchChannelsListWithRetry(parts: string, ids: string[], apiKey: string): Promise<any[]> {
  const url = new URL('https://www.googleapis.com/youtube/v3/channels');
  url.searchParams.set('part', parts);
  url.searchParams.set('id', ids.join(','));
  url.searchParams.set('key', apiKey);
  let attempt = 0; const maxAttempts = 3; let lastErr: any = null;
  while (attempt < maxAttempts) {
    try {
      const resp = await fetch(String(url));
      if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
      const json = await resp.json();
      const items = Array.isArray(json?.items) ? json.items : [];
      return items;
    } catch (e) { lastErr = e; await sleep(500 * (attempt + 1)); attempt++; }
  }
  throw lastErr || new Error('channels.list failed');
}

// ---- Scrape session (for Subscriptions Feed / Watch History) ----
type ScrapeMode = 'subFeed' | 'history' | 'subscriptions' | 'runAll';
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

async function setLastRun(name: 'resolveIds' | 'subFeed' | 'subscriptionsManager' | 'history' | 'any') {
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

chrome.runtime.onMessage.addListener((raw: Msg, sender, sendResponse) => {
  (async () => {
    dlog('onMessage:', raw?.type, raw?.payload ? Object.keys(raw.payload) : null);
    try {
      if (raw.type === 'cache/VIDEO_SEEN') {
        await handleVideoUpsert('SEEN', (raw as any).payload, sender);
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
          // History hints
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
        sendResponse?.({ ok: true, items });
      } else if (raw.type === 'videos/stubsCount') {
        // Count videos that have never been fetched from YouTube API (no fetchedAt)
        try {
          const db = await openDB();
          const count = await new Promise<number>((resolve, reject) => {
            const tx = db.transaction('videos', 'readonly');
            const os = tx.objectStore('videos');
            let n = 0;
            const cur = os.openCursor();
            cur.onsuccess = () => {
              const c = cur.result as IDBCursorWithValue | null;
              if (!c) { resolve(n); return; }
              try { const v: any = c.value || {}; if (!v?.fetchedAt) n++; } catch {}
              c.continue();
            };
            cur.onerror = () => reject(cur.error);
          });
          sendResponse?.({ ok: true, count });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e), count: 0 });
        }
      } else if ((raw as any)?.type === 'channels/stubsCount') {
        // Count channels that were never fetched from API (no fetchedAt)
        try {
          const db = await openDB();
          const count = await new Promise<number>((resolve, reject) => {
            const tx = db.transaction('channels', 'readonly');
            const os = tx.objectStore('channels');
            let n = 0;
            const cur = os.openCursor();
            cur.onsuccess = () => {
              const c = cur.result as IDBCursorWithValue | null;
              if (!c) { resolve(n); return; }
              try { const v: any = c.value || {}; if (!v?.fetchedAt) n++; } catch {}
              c.continue();
            };
            cur.onerror = () => reject(cur.error);
          });
          sendResponse?.({ ok: true, count });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e), count: 0 });
        }
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
        // Delegate to existing pending/resolveBatch; update last run
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
          // Do not stop on already-known items; close tab when finished
          const r = await runScrollingScrape('https://www.youtube.com/feed/subscriptions', 'SubscriptionsFeed', max, { stopOnKnown: false, keepOpen: false });
          await setLastRun('subFeed'); await setLastRun('any');
          sendResponse?.({ ok: true, ...r });
        } catch (e: any) { sendResponse?.({ ok: false, error: e?.message || String(e) }); }
      } else if (raw.type === 'scrape/history') {
        try {
          const max = Math.max(1, Math.min(5000, Number(((raw as any)?.payload?.max) ?? (await getDefaultMax('history')))));
          // Close tab when finished; logs are in the background console
          const r = await runScrollingScrape('https://www.youtube.com/feed/history', 'WatchHistory', max, { stopOnKnown: false, historyHints: true, keepOpen: false });
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
          // resolve ids
          try { await setLastRun('resolveIds'); await setLastRun('any'); await new Promise((res) => chrome.runtime.sendMessage({ type: 'channels/pending/resolveBatch', payload: { limit: 5 } } as any, () => res(undefined))); } catch {}
          // sub feed
          try { await runScrollingScrape('https://www.youtube.com/feed/subscriptions', 'SubscriptionsFeed', await getDefaultMax('subFeed'), { stopOnKnown: false }); await setLastRun('subFeed'); await setLastRun('any'); } catch {}
          // subscriptions manager
          try { await runSubscriptionsManagerOnce(); await setLastRun('subscriptionsManager'); await setLastRun('any'); } catch {}
          // history
          try { await runScrollingScrape('https://www.youtube.com/feed/history', 'WatchHistory', await getDefaultMax('history'), { stopOnKnown: false, historyHints: true }); await setLastRun('history'); await setLastRun('any'); } catch {}
          sendResponse?.(out);
        } catch (e: any) { sendResponse?.({ ok: false, error: e?.message || String(e) }); }
      } else if (raw.type === 'channels/list') {
        const items = await listChannels();
        sendResponse?.({ ok: true, items });
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
        await deleteGroup(id);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'groups' } });
        recordEvent('groups/delete', { id }, { impact: { groups: 1 } });
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if (raw.type === 'videos/delete') {
        const ids: string[] = Array.isArray(raw.payload?.ids) ? raw.payload.ids.filter(Boolean) : [];
        await moveToTrash(ids);
        try { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } }); } catch {}
        recordEvent('videos/delete', { ids }, { impact: { videos: ids.length } });
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if (raw.type === 'videos/restore') {
        const ids: string[] = Array.isArray(raw.payload?.ids) ? raw.payload.ids.filter(Boolean) : [];
        await restoreFromTrash(ids);
        try { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } }); } catch {}
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
      } else if (raw.type === 'videos/applyTags') {
        const { ids, addIds = [], removeIds = [] } = raw.payload || {};
        dlog('videos/applyTags', { ids: ids?.length || 0, add: addIds.length, remove: removeIds.length });
        await applyTags(ids || [], addIds, removeIds);
        // Update channel videoTags for affected channels
        try {
          const chs = await channelIdsForVideos(ids || []);
          if (chs.length) await recomputeVideoTagsForChannels(chs);
          chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } });
        } catch {}
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } });
        recordEvent('videos/applyTags', { ids: ids || [], addIds, removeIds }, { impact: { videos: (ids || []).length, tags: addIds.length + removeIds.length } });
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if (raw.type === 'tags/list') {
        const items = await listTags();
        sendResponse?.({ ok: true, items });
      } else if (raw.type === 'tags/assignGroup') {
        const name = String(raw.payload?.name || '');
        const groupId = (raw.payload?.groupId ?? null) as (string | null);
        await setTagGroup(name, groupId);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'tags' } });
        recordEvent('tags/assignGroup', { name, groupId }, { impact: { tags: 1 } });
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if ((raw as any)?.type === 'channels/upsertStub') {
        const { id, name, handle, altHandle } = (raw as any).payload || {};
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
      } else if ((raw as any)?.type === 'channels/upsertPending') {
        const { key, name, handle } = (raw as any)?.payload || {};
        if (!key) { sendResponse?.({ ok: false, error: 'Missing key' }); return; }
        try {
          await upsertPendingChannel(String(key), { name: name ?? null, handle: handle ?? null });
          recordEvent('pending/upsert', { key, name: name ?? null, handle: handle ?? null }, { impact: {} });
          scheduleBackup();
          sendResponse?.({ ok: true });
        } catch (e: any) { sendResponse?.({ ok: false, error: e?.message || String(e) }); }
      } else if ((raw as any)?.type === 'channels/resolvePending') {
        const { id, name, handle, altHandle } = (raw as any)?.payload || {};
        if (!id && !handle && !name && !altHandle) { sendResponse?.({ ok: false }); return; }
        try {
          await resolvePendingChannel(String(id || ''), { name: name ?? null, handle: handle ?? null, altHandle: altHandle ?? null });
          try { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } }); } catch {}
          recordEvent('pending/resolve', { id, name: name ?? null, handle: handle ?? null, altHandle: altHandle ?? null }, { impact: { channels: 1 } });
          scheduleBackup();
          // If this came from an auto-opened tab, close it
          try {
            const tid = sender?.tab?.id;
            if (typeof tid === 'number' && autoResolveTabIds.has(tid)) {
              autoResolveTabIds.delete(tid);
              try { chrome.tabs?.remove?.(tid); } catch {}
            }
          } catch {}
          sendResponse?.({ ok: true });
        } catch (e: any) { sendResponse?.({ ok: false, error: e?.message || String(e) }); }
      } else if ((raw as any)?.type === 'channels/pending/list') {
        try {
          const items = await listPendingChannels();
          sendResponse?.({ ok: true, items });
        } catch (e: any) { sendResponse?.({ ok: false, error: e?.message || String(e), items: [] }); }
      } else if ((raw as any)?.type === 'channels/pending/resolveBatch') {
        const limit = Math.max(1, Math.min(20, Number(((raw as any)?.payload?.limit) ?? 5)));
        try {
          const pend = await listPendingChannels();
          // Only handles, skip name-only entries; skip ones already opened
          const candidates = pend.filter(p => !!p.handle).map(p => ({ key: p.key, handle: (p.handle as string) })).filter(p => p.handle.trim().length > 0);
          let opened = 0;
          for (const c of candidates) {
            if (opened >= limit) break;
            // Skip if a tab for this handle is already open via our tracker
            let already = false;
            try {
              for (const id of autoResolveTabIds.values()) {
                if (autoResolveTabInfo.get(id)?.origHandle === c.handle) { already = true; break; }
              }
            } catch {}
            if (already) continue;
            const url = `https://www.youtube.com/${c.handle.startsWith('@') ? c.handle : ('@' + c.handle)}`;
            try {
              const tab = await chrome.tabs?.create?.({ url, active: false });
              const tid = tab?.id as number | undefined;
              if (typeof tid === 'number') {
                autoResolveTabIds.add(tid);
                autoResolveTabInfo.set(tid, { origHandle: c.handle });
                opened++;
              }
            } catch {}
          }
          const remaining = Math.max(0, candidates.length - opened);
          sendResponse?.({ ok: true, opened, remaining });
        } catch (e: any) { sendResponse?.({ ok: false, error: e?.message || String(e), opened: 0, remaining: 0 }); }
      } else if (raw.type === 'tags/create') {
        await createTag(raw.payload?.name, raw.payload?.color);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'tags' } });
        recordEvent('tags/create', { name: raw.payload?.name }, { impact: { tags: 1 } });
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if (raw.type === 'tags/rename') {
        await renameTag(raw.payload?.oldName, raw.payload?.newName);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'tags' } });
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } }); // videos updated too
        try { await recomputeVideoTagsForAllChannels(); chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } }); } catch{}
        recordEvent('tags/rename', { from: raw.payload?.oldName, to: raw.payload?.newName }, { impact: { tags: 1 } });
        scheduleBackup();
        sendResponse?.({ ok: true });
  } else if (raw.type === 'tags/delete') {
        const cascade = raw.payload?.cascade ?? true;
        await deleteTag(raw.payload?.name, cascade);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'tags' } });
      if (cascade) { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } }); try { await recomputeVideoTagsForAllChannels(); chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } }); } catch{} }
      recordEvent('tags/delete', { name: raw.payload?.name, cascade }, { impact: { tags: 1 } });
      scheduleBackup();
      sendResponse?.({ ok: true });
      } else if (raw.type === 'tagGroups/list') {
        const items = await listTagGroups();
        sendResponse?.({ ok: true, items });
      } else if (raw.type === 'tagGroups/create') {
        const id = await createTagGroup(String(raw.payload?.name || ''));
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'tagGroups' } });
        recordEvent('tagGroups/create', { id, name: String(raw.payload?.name || '') }, { impact: {} });
        scheduleBackup();
        sendResponse?.({ ok: true, id });
      } else if (raw.type === 'tagGroups/rename') {
        await renameTagGroup(String(raw.payload?.id || ''), String(raw.payload?.name || ''));
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'tagGroups' } });
        recordEvent('tagGroups/rename', { id: String(raw.payload?.id || ''), name: String(raw.payload?.name || '') }, { impact: {} });
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if (raw.type === 'tagGroups/delete') {
        await deleteTagGroup(String(raw.payload?.id || ''));
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
        const parts = ['snippet','statistics','brandingSettings'].join(',');
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
        const parts = ['snippet','statistics','brandingSettings'].join(',');
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
        dlog('channels/applyTags', { ids: ids?.length || 0, add: addIds.length, remove: removeIds.length });
        await applyChannelTags(ids || [], addIds, removeIds);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } });
        recordEvent('channels/applyTags', { ids: ids || [], addIds, removeIds }, { impact: { channels: (ids || []).length, tags: addIds.length + removeIds.length } });
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if (raw.type === 'channels/delete') {
        const ids: string[] = Array.isArray(raw.payload?.ids) ? raw.payload.ids.filter(Boolean) : [];
        await moveChannelsToTrash(ids);
        try { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } }); } catch {}
        recordEvent('channels/delete', { ids }, { impact: { channels: ids.length } });
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if (raw.type === 'channels/restore') {
        const ids: string[] = Array.isArray(raw.payload?.ids) ? raw.payload.ids.filter(Boolean) : [];
        await restoreChannelsFromTrash(ids);
        try { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } }); } catch {}
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
      }
    } catch (e: any) {
      derr('bg handler error:', e?.message || e);
      sendResponse?.({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true;
});
self.addEventListener('unhandledrejection', (ev: any) => derr('unhandledrejection', ev?.reason));
self.addEventListener('error', (ev: any) => derr('error', (ev as any)?.message || ev));

import { useEffect, useMemo, useRef, useState } from 'react';
import { dlog, derr } from '../../types/debug';
import { matches, matchesChannel, type Condition, type Group as GroupRec } from '../../shared/conditions';
import FiltersBar from './components/FiltersBar';
import type { FilterEntry } from './lib/filters';
import { chainToCondition, conditionToChainSimple } from './lib/filters';
import { getAll as idbGetAll } from '../lib/idb';
import { send as sendBg } from '../lib/messaging';
import type { TagRec, TagGroupRec } from '../../types/messages';
import Sidebar from './components/Sidebar';
import { toHex6, darken, textColorBW } from '../lib/colors';
import VideoList from './components/VideoList';
import BackupModal from './components/BackupModal';
import HistoryModal from './components/HistoryModal';
import PendingPanel from './components/PendingPanel';
import { avatarUrlFromThumbId } from '../lib/format';

// ---- Types ----
type Video = {
  id: string;
  title?: string | null;
  channelId?: string | null;
  channelName?: string | null;
  durationSec?: number | null;
  uploadedAt?: number | null;
  fetchedAt?: number | null;
  ytTags?: string[] | null; // from API
  deletedAt?: number; // undefined for non-trash rows
  flags?: { started?: boolean; completed?: boolean };
  tags?: string[];
  sources?: Array<{ type: string; id?: string | null }> | null;
  progressSec?: number | null;
  // Extended fields for filters
  description?: string | null;
  categoryId?: number | null;
  languageCode?: 'en' | 'de' | 'other' | null;
  visibility?: 'public' | 'unlisted' | 'private' | null;
  isLive?: boolean | null;
  videoTopics?: string[] | null;
};


// ---- IndexedDB helpers (read-only here) ----
// Project rows to a slim shape (drop heavy fields like raw `yt` payload)
async function getAll(store: 'videos' | 'trash'): Promise<Video[]> {
  const rows = await idbGetAll<any>(store);
  dlog(`UI getAll(${store}) count=`, rows.length);
  const slim = rows.map((r: any): Video => ({
    id: r.id,
    title: r.title ?? null,
    channelId: r.channelId ?? null,
    channelName: r.channelName ?? null,
    durationSec: Number.isFinite(r.durationSec) ? r.durationSec : null,
    uploadedAt: Number.isFinite(r.uploadedAt) ? r.uploadedAt : null,
    fetchedAt: Number.isFinite(r.fetchedAt) ? r.fetchedAt : null,
    ytTags: Array.isArray(r.ytTags) ? r.ytTags : null,
    deletedAt: r.deletedAt,
    flags: r.flags,
    tags: Array.isArray(r.tags) ? r.tags : [],
    sources: Array.isArray(r.sources) ? r.sources.map((s:any)=> ({ type: String(s?.type || ''), id: (s?.id ?? null) })) : null,
    progressSec: (() => {
      try {
        const ps = Number(r?.progress?.sec);
        if (Number.isFinite(ps) && ps > 0) return Math.floor(ps);
        const pct = Number(r?.progress?.pct);
        const dur = Number(r?.progress?.duration ?? r?.durationSec);
        if (Number.isFinite(pct) && Number.isFinite(dur) && dur > 0) {
          const clamped = Math.max(0, Math.min(100, pct));
          return Math.floor((clamped / 100) * dur);
        }
      } catch {}
      return null;
    })(),
    description: typeof r.description === 'string' ? r.description : null,
    categoryId: Number.isFinite(r.categoryId) ? Number(r.categoryId) : null,
    languageCode: (r.languageCode === 'en' || r.languageCode === 'de' || r.languageCode === 'other') ? r.languageCode : null,
    visibility: (r.visibility === 'public' || r.visibility === 'unlisted' || r.visibility === 'private') ? r.visibility : null,
    isLive: typeof r.isLive === 'boolean' ? r.isLive : null,
    videoTopics: Array.isArray(r.videoTopics) ? r.videoTopics : null,
  }));
  // Sort: trash by deletedAt desc; videos by uploadedAt (or fetchedAt) desc
  if (store === 'trash') slim.sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
  else slim.sort((a, b) => ((b.uploadedAt || b.fetchedAt || 0) - (a.uploadedAt || a.fetchedAt || 0)));
  return slim;
}

// ---- React component ----
export default function App() {
  const [mode, setMode] = useState<'manager' | 'subs' | 'recommender'>('manager');
  const [videos, setVideos] = useState<Video[]>([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [layout, setLayout] = useState<'grid' | 'list'>('list'); // UI-only state
  const isGrid = layout === 'grid';
  const isList = layout === 'list';
  const [view, setView] = useState<'videos' | 'trash' | 'channels' | 'channelsTrash' | 'pending'>('videos');
  const inTrash = view === 'trash';
  const inChannels = view === 'channels';
  const inChannelsTrash = view === 'channelsTrash';
  const viewLabel = (() => {
    if (view === 'pending') return 'Pending (debug)';
    if (inChannelsTrash) return 'Channels Trash';
    if (inChannels) return 'Channels';
    const inTrashLabel = view === 'trash';
    return inTrashLabel ? 'Videos Trash' : 'Videos';
  })();
  // Selection
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selectedCount = selected.size;
  // Pagination
  const [pageSize, setPageSize] = useState<number>(100); // options: 50, 100, 250, 500
  const [page, setPage] = useState<number>(1);
  const [lastDeleted, setLastDeleted] = useState<string[] | null>(null);
  const [showUndo, setShowUndo] = useState(false);

  const [showTagger, setShowTagger] = useState(false);
  // Debounced refresh to reduce churn from frequent db/change events
  const refreshTimerRef = useRef<number | null>(null);

  const [tags, setTags] = useState<TagRec[]>([]);
  const [tagGroups, setTagGroups] = useState<TagGroupRec[]>([]);
  const [tagEditing, setTagEditing] = useState<string | null>(null);
  const [tagEditValue, setTagEditValue] = useState('');
  const [newSidebarTag, setNewSidebarTag] = useState('');

  const [groups, setGroups] = useState<GroupRec[]>([]);
  const [channels, setChannels] = useState<Array<{
    id: string;
    name: string;
    fetchedAt?: number | null;
    thumbnailID?: string | null;
    subs?: number | null;
    views?: number | null;
    videos?: number | null;
    country?: string | null;
    publishedAt?: number | null;
    subsHidden?: boolean | null;
    tags?: string[];
    videoTags?: string[];
    keywords?: string | null;
    topics?: string[];
  }>>([]);

  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [groupName, setGroupName] = useState('');

const [chain, setChain] = useState<FilterEntry[]>([]);

  // Refresh data (YouTube API) state
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null);
  const [refreshTotal, setRefreshTotal] = useState<number>(0);
  const [refreshProcessed, setRefreshProcessed] = useState<number>(0);
  const [refreshApplied, setRefreshApplied] = useState<number>(0);
  const [refreshFailed, setRefreshFailed] = useState<number>(0);
  const [refreshLastError, setRefreshLastError] = useState<string | null>(null);
  const [stubCount, setStubCount] = useState<number>(0);
  const [showStubsOnly, setShowStubsOnly] = useState<boolean>(false);
  const [openChannelDebug, setOpenChannelDebug] = useState<Set<string>>(new Set());
  const [channelFull, setChannelFull] = useState<Record<string, any>>({});
  const [videoSorts, setVideoSorts] = useState<Array<{ field: string; dir: 'asc' | 'desc' }>>([]);
  const [channelSorts, setChannelSorts] = useState<Array<{ field: string; dir: 'asc' | 'desc' }>>([]);
  const [topicOptions, setTopicOptions] = useState<string[]>([]);
  const [driveClientId, setDriveClientId] = useState<string | null>(null);
  const [showBackups, setShowBackups] = useState<boolean>(false);
  const [showHistory, setShowHistory] = useState<boolean>(false);
  const [backupInProgress, setBackupInProgress] = useState<boolean>(false);
  const [lastBackupAt, setLastBackupAt] = useState<number | null>(null);
  const [backupLastError, setBackupLastError] = useState<string | null>(null);
  const [unsyncedCount, setUnsyncedCount] = useState<number>(0);
  const videoSourcesOptionsMemo = useMemo((): Array<{ type: string; id: string | null; count: number }> => {
    // Build condition without source predicates so list reflects other filters
    const pruned = chain.filter(e => !(e.pred.kind === 'v_sources_any'));
    const cond = chainToCondition(pruned);
    let base = videos;
    if (cond) {
      base = base.filter(v => matches(v as any, cond, {
        resolveGroup: (id) => groups.find(g => g.id === id),
        resolveChannel: (id) => channels.find(c => c.id === id) as any
      }));
    }
    const needle = q.trim().toLowerCase();
    if (needle) {
      base = base.filter(v => (v.title || '').toLowerCase().includes(needle) || (v.channelName || v.channelId || '').toLowerCase().includes(needle));
    }
    const counts = new Map<string, { type: string; id: string | null; count: number }>();
    for (const v of base) {
      const list = Array.isArray(v.sources) ? v.sources : [];
      for (const s of list) {
        const type = String(s?.type || '');
        const id = (s?.id ?? null) as string | null;
        if (!type) continue;
        const key = `${type}:${id == null ? 'null' : String(id)}`;
        const prev = counts.get(key);
        if (prev) prev.count++;
        else counts.set(key, { type, id, count: 1 });
      }
    }
    return Array.from(counts.values()).sort((a,b)=> a.type === b.type ? String(a.id||'').localeCompare(String(b.id||'')) : a.type.localeCompare(b.type));
  }, [videos, chain, q, groups, channels]);
  // One-time import state
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);


  function resetGroupEditUI() {
  setEditingGroupId(null);
  setGroupName('');
}

function saveAsGroup() {
  const cond = chainToCondition(chain);
  if (!cond) return;
  sendBg('groups/create', { name: groupName.trim(), condition: cond }).then(() => {
    loadGroups();
    resetGroupEditUI();
  });
}

function saveChangesToGroup() {
  const cond = chainToCondition(chain);
  if (!cond || !editingGroupId) return;
  sendBg('groups/update', { id: editingGroupId, patch: { name: groupName.trim(), condition: cond } }).then(() => {
    loadGroups();
    resetGroupEditUI();
  });
}

function cancelEditing() {
  resetGroupEditUI();
}


// filter chain helpers moved to ./lib/filters

  async function loadGroups() {
    const resp: any = await sendBg('groups/list', {});
    setGroups(resp?.items || []);
  }
  async function loadTopicOptions() {
    try {
      const resp: any = await sendBg('topics/list', {} as any);
      const items: string[] = Array.isArray(resp?.items) ? resp.items : [];
      setTopicOptions(items);
    } catch { setTopicOptions([]); }
  }

  async function toggleGroupScrape(id: string, next: boolean) {
    try {
      await sendBg('groups/update', { id, patch: { scrape: !!next } });
      loadGroups();
    } catch {}
  }

  // Determine if a preset (group) is scrape-checkable (only contains predicates we can evaluate at scrape time)
  const isPresetScrapeCheckable = useMemo(() => {
    const byId = new Map<string, GroupRec>();
    for (const g of groups) byId.set(g.id, g);
    const supported = new Set(['sourceAny','sourcePlaylistAny','channelIdIn','titleRegex','groupRef']);
    function checkNode(node: any, seen: Set<string>): boolean {
      if (!node) return true;
      if ('all' in node) return (Array.isArray(node.all) ? node.all : []).every((n: any) => checkNode(n, seen));
      if ('any' in node) return (Array.isArray(node.any) ? node.any : []).every((n: any) => checkNode(n, seen));
      if ('not' in node) return checkNode(node.not, seen);
      const p = node as any;
      if (p?.kind === 'groupRef') {
        const ids: string[] = Array.isArray(p.ids) ? p.ids : [];
        if (!ids.length) return false;
        return ids.every((gid) => {
          if (!gid || seen.has(gid)) return true;
          seen.add(gid);
          const g = byId.get(gid);
          return !!g && checkNode(g.condition as any, new Set(seen));
        });
      }
      return supported.has(String(p?.kind || ''));
    }
    return (id: string) => {
      const g = byId.get(id);
      if (!g) return false;
      return checkNode(g.condition as any, new Set());
    };
  }, [groups]);
  async function loadChannelsDir() {
    const resp: any = await sendBg(inChannelsTrash ? 'channels/trashList' : 'channels/list', {} as any);
    setChannels(resp?.items || []);
  }
  useEffect(() => {
    // initial load also pulls groups
    refresh();
    loadGroups();
    loadChannelsDir();
    loadTopicOptions();
    // Drive client id
    try { sendBg('backup/getClientId', {} as any).then((r: any) => setDriveClientId((r?.clientId as string) || null)).catch(()=>setDriveClientId(null)); } catch {}
    // load last refresh/backup time from storage
    try {
      chrome.storage?.local?.get('lastRefreshAt', (obj) => {
        const t = obj?.lastRefreshAt as number | undefined;
        if (t && Number.isFinite(t)) setLastRefreshAt(t);
      });
      chrome.storage?.local?.get('lastBackupAt', (obj) => {
        const t = obj?.lastBackupAt as number | undefined;
        if (t && Number.isFinite(t)) setLastBackupAt(t);
      });
      // Load current unsynced commit backlog count
      chrome.storage?.local?.get('drive.unsyncedCommitIds', (obj) => {
        try {
          const arr = Array.isArray((obj as any)?.['drive.unsyncedCommitIds']) ? (obj as any)['drive.unsyncedCommitIds'] : [];
          setUnsyncedCount(arr.length || 0);
        } catch {}
      });
      // Watch storage changes to update indicator and timestamps
      const onStorage = (changes: any, area: string) => {
        if (area !== 'local') return;
        if (changes['drive.unsyncedCommitIds']) {
          try {
            const next = changes['drive.unsyncedCommitIds'].newValue;
            setUnsyncedCount(Array.isArray(next) ? next.length : 0);
          } catch {}
        }
        if (changes['lastBackupAt']) {
          const v = changes['lastBackupAt'].newValue as number | undefined;
          if (v && Number.isFinite(v)) setLastBackupAt(v);
        }
        if (changes['lastRefreshAt']) {
          const v = changes['lastRefreshAt'].newValue as number | undefined;
          if (v && Number.isFinite(v)) setLastRefreshAt(v);
        }
      };
      chrome.storage?.onChanged?.addListener(onStorage);
      // cleanup
      return () => { try { chrome.storage?.onChanged?.removeListener(onStorage); } catch {} };
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);



async function removeGroup(id: string) {
  await sendBg('groups/delete', { id });
  if (editingGroupId === id) resetGroupEditUI();
  await loadGroups();
}

function startEditFromGroup(g: GroupRec) {
  const parsed = conditionToChainSimple(g.condition);
  if (!parsed) {
    alert('This group is too complex for the linear editor (nested parentheses support coming next).');
    return;
  }
  setChain(parsed);
  setGroupName(g.name);
  setEditingGroupId(g.id);
}

// Simple: supports single-level all/any or a single predicate; NOT on a leaf.
// (Weâ€™ll extend this when we add explicit parentheses in the editor.)

  function addTag() {
    const name = newSidebarTag.trim();
    if (!name) return;
    sendBg('tags/create', { name }).then(() => {
      setNewSidebarTag('');
      loadTags();
    });
  }

  function startRename(name: string) {
    setTagEditing(name);
    setTagEditValue(name);
  }

  function cancelRename() {
    setTagEditing(null);
    setTagEditValue('');
  }

  function commitRename() {
    const from = tagEditing;
    const to = tagEditValue.trim();
    if (!from || !to || from === to) { cancelRename(); return; }
    sendBg('tags/rename', { oldName: from, newName: to }).then(() => {
      cancelRename();
      loadTags();
      refresh(); // videos/trash updated
    });
  }

  function removeTag(name: string) {
    sendBg('tags/delete', { name, cascade: true }).then(() => {
      loadTags();
      refresh(); // remove tag from videos/trash too
    });
  }

  async function loadTags() {
    const resp: any = await sendBg('tags/list', {});
    if (resp && resp.items) setTags(resp.items as TagRec[]);
    else setTags([]);
  }

  async function deleteSelected() {
    const ids = Array.from(selectedVisibleSetDisplay);
    if (!ids.length) return;
    if (inChannels || inChannelsTrash) {
      await sendBg('channels/delete', { ids });
      await loadChannelsDir();
      setSelected(prev => { const s = new Set(prev); ids.forEach(id => s.delete(id)); return s; });
      return;
    } else {
      await sendBg('videos/delete', { ids });
    }

    setLastDeleted(ids);
    setShowUndo(true);
    setSelected(prev => { const s = new Set(prev); ids.forEach(id => s.delete(id)); return s; });
    await refresh();

    // auto-hide toast after a bit (optional)
    setTimeout(() => setShowUndo(false), 6000);
  }

  // --- Backup (Google Drive) ---
  async function setDriveClientIdInteractive() {
    try {
      const cur = driveClientId || '';
      const next = window.prompt('Enter Google OAuth Client ID (Web app) with redirect URI https://<your-ext-id>.chromiumapp.org/', cur || '') || '';
      const trimmed = next.trim();
      if (!trimmed) return;
      const r: any = await sendBg('backup/setClientId', { clientId: trimmed } as any);
      if (r?.ok) setDriveClientId(trimmed);
      else alert(`Save failed: ${r?.error || 'unknown error'}`);
    } catch (e: any) { alert(`Save failed: ${e?.message || e}`); }
  }

  async function backupSettingsInteractive() {
    try {
      const r: any = await sendBg('backup/saveSettings', {} as any);
      if (r?.ok) alert('Settings backed up to Google Drive (appDataFolder) as settings.json');
      else alert(`Backup failed: ${r?.error || 'unknown error'}`);
    } catch (e: any) {
      alert(`Backup failed: ${e?.message || e}`);
    }
  }

  async function purgeSelected() {
    const ids = Array.from(selectedVisibleSetDisplay);
    if (!ids.length) return;
    const confirmMsg = (inChannelsTrash || inTrash)
      ? `Permanently delete ${ids.length} item(s) from trash? This cannot be undone.`
      : '';
    if (confirmMsg && !confirm(confirmMsg)) return;
    if (inChannelsTrash) {
      await sendBg('channels/purge', { ids });
      await loadChannelsDir();
      setSelected(prev => { const s = new Set(prev); ids.forEach(id => s.delete(id)); return s; });
      return;
    }
    if (inTrash) {
      await sendBg('videos/purge', { ids });
      setSelected(prev => { const s = new Set(prev); ids.forEach(id => s.delete(id)); return s; });
      await refresh();
    }
  }
  function openBackups() { try { console.log('[UI] openBackups'); } catch {} setShowBackups(true); }
  function closeBackups() { setShowBackups(false); }
  function openHistory() { setShowBackups(true); }
  function closeHistory() { setShowHistory(false); }


  async function undoDelete() {
    if (!lastDeleted?.length) return;
    // Undo only applies to videos (channels use explicit Restore in trash view)
    await sendBg('videos/restore', { ids: lastDeleted });

    setShowUndo(false);
    setLastDeleted(null);
    await refresh();
  }

  function toggleSelect(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllVisible(ids: string[]) {
    setSelected(new Set(ids));
  }

  function selectAllMatching(allIds: string[]) {
    // Union with existing selection; preserve disabled (hidden) selections
    setSelected(prev => {
      const next = new Set(prev);
      for (const id of allIds) next.add(id);
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Set());
  }

  function toggleChannelDebug(id: string) {
    setOpenChannelDebug(prev => {
      const next = new Set(prev);
      const willOpen = !next.has(id);
      if (next.has(id)) next.delete(id); else next.add(id);
      if (willOpen && !channelFull[id]) {
        import('../lib/idb').then(m => m.getOne('channels', id)).then((row) => {
          if (row) setChannelFull(o => ({ ...o, [id]: row }));
        }).catch(() => void 0);
      }
      return next;
    });
  }

  async function refresh() {
    try {
      dlog('UI refresh start');
      setLoading(true);
      setError(null);
      const rows = await getAll(inTrash ? 'trash' as const : 'videos' as const);
      setVideos(rows);
      dlog('UI refresh done, rows=', rows.length);
    } catch (e: any) {
      derr('UI refresh error:', e?.message || e);
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    clearSelection();
    setPage(1);
    setQ('');
    setChain([]);
    refresh(); // reload from the correct store (videos vs trash)
    loadTags();
    loadTagGroups();
    if (inChannels || inChannelsTrash) loadChannelsDir();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, inChannels, inChannelsTrash]);

useEffect(() => {
  function onMsg(msg: any) {
    if (msg?.type === 'db/change') {
      const ent = msg.payload?.entity;
      if (ent === 'videos' || ent == null) {
        if (refreshTimerRef.current == null) {
          refreshTimerRef.current = window.setTimeout(() => {
            refreshTimerRef.current = null;
            refresh();
            loadTopicOptions();
            void refreshStubCount();
          }, 200) as unknown as number;
        }
      }
      if (ent === 'tags')   loadTags();
      if (ent === 'tagGroups') loadTagGroups();
      if (ent === 'groups') loadGroups();
      if (ent === 'channels') { loadChannelsDir(); void refreshStubCount(); }
      if (ent === 'topics') loadTopicOptions();
    } else if (msg?.type === 'refresh/progress') {
      const p = msg.payload || {};
      setRefreshing(true);
      setRefreshTotal(p.total | 0);
      setRefreshProcessed(p.processed | 0);
      setRefreshApplied(p.applied | 0);
      setRefreshFailed(p.failedBatches | 0);
    } else if (msg?.type === 'refresh/error') {
      const e = msg.payload?.message || '';
      if (e) setRefreshLastError(String(e));
    } else if (msg?.type === 'refresh/done') {
      setRefreshing(false);
      const p = msg.payload || {};
      setRefreshTotal(p.total | 0);
      setRefreshProcessed(p.processed | 0);
      setRefreshApplied(p.applied | 0);
      setRefreshFailed(p.failedBatches | 0);
      if (p.at) setLastRefreshAt(p.at);
    } else if (msg?.type === 'backup/progress') {
      setBackupInProgress(true);
      setBackupLastError(null);
    } else if (msg?.type === 'backup/done') {
      setBackupInProgress(false);
      const at = msg?.payload?.at | 0;
      if (at) setLastBackupAt(at);
    } else if (msg?.type === 'backup/error') {
      setBackupInProgress(false);
      const err = msg?.payload?.message || '';
      if (err) setBackupLastError(String(err));
    }
  }
  chrome.runtime.onMessage.addListener(onMsg);
  return () => chrome.runtime.onMessage.removeListener(onMsg);
}, []);


const channelOptions = useMemo(() => {
  const map = new Map<string, string>();
  for (const v of videos) {
    if (v.channelId) {
      const name = (v.channelName && String(v.channelName)) || v.channelId;
      if (!map.has(v.channelId)) map.set(v.channelId, name);
    }
  }
  return Array.from(map, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}, [videos]);


const groupsById = useMemo(() => {
  const m = new Map<string, GroupRec>();
  for (const g of groups) m.set(g.id, g);
  return m;
}, [groups]);
  // (moved) tagCounts is computed after visible/hidden selection is derived
  // AFTER: derive names from the registry we loaded via tags/list
  // All registry tags (for the tag apply UI)
  const availableTags = useMemo(() => tags.map(t => t.name), [tags]);
  const tagsByGroup = useMemo(() => {
    const byId = new Map<string, TagGroupRec>();
    for (const g of tagGroups) byId.set(g.id, g);
    const grouped = new Map<string, string[]>();
    for (const t of tags) {
      const gid = (t.groupId || '') as string;
      const key = gid && byId.has(gid) ? gid : '';
      const list = grouped.get(key) || (grouped.set(key, []), grouped.get(key)!);
      list.push(t.name);
    }
    const numCmp = (a: string, b: string) => {
      const ai = /^\d+$/.test(String(a)) ? parseInt(String(a), 10) : NaN;
      const bi = /^\d+$/.test(String(b)) ? parseInt(String(b), 10) : NaN;
      const aNum = Number.isFinite(ai), bNum = Number.isFinite(bi);
      if (aNum && bNum) return ai - bi;
      if (aNum && !bNum) return -1; if (!aNum && bNum) return 1;
      return String(a).localeCompare(String(b));
    };
    for (const [k, list] of grouped) {
      const grp = byId.get(k);
      const isRating = (k === 'tagGroup.rating') || (String(grp?.name || '').trim().toLowerCase() === 'rating');
      list.sort((a,b) => isRating ? numCmp(a,b) : a.localeCompare(b));
    }
    return { byId, grouped } as { byId: Map<string, TagGroupRec>; grouped: Map<string, string[]> };
  }, [tags, tagGroups]);

  const countryOptions = useMemo(() => {
    const codes = new Set<string>();
    for (const ch of channels) {
      const c = (ch.country || '').toString().trim().toLowerCase();
      if (c) codes.add(c);
    }
    return Array.from(codes.values()).sort((a,b)=> a.localeCompare(b));
  }, [channels]);

  function toggleTag(tag: string) {
    if (inChannels) {
      const countCh = channels.filter(c => selected.has(c.id)).reduce((n, c) => (Array.isArray(c.tags) && c.tags.includes(tag)) ? n + 1 : n, 0);
      const allHaveCh = countCh === selectedCount && selectedCount > 0;
      sendBg('channels/applyTags', {
        ids: Array.from(selected),
        addIds: allHaveCh ? [] : [tag],
        removeIds: allHaveCh ? [tag] : []
      }).then(() => loadChannelsDir());
      return;
    }
    const count = tagCounts.get(tag) || 0;
    const allHave = count === selectedCount && selectedCount > 0;
    // If all have it â†’ remove from all; otherwise add to all
    sendBg('videos/applyTags', {
      ids: Array.from(selected),
      addIds: allHave ? [] : [tag],
      removeIds: allHave ? [tag] : []
    }).then(() => refresh());
  }

const filtered = useMemo(() => {
  let base = videos;
  if (showStubsOnly) base = base.filter(v => !Number.isFinite(v.fetchedAt || undefined));

  const cond = chainToCondition(chain);
  if (cond) {
    base = base.filter(v => matches(v as any, cond, {
      resolveGroup: (id) => groups.find(g => g.id === id),
      resolveChannel: (id) => channels.find(c => c.id === id) as any
    }));
  }

  // Exclude videos tagged 'hide' by default unless the tag filter explicitly includes 'hide'
  try {
    const includesHide = chain.some(e => {
      const p: any = e?.pred || {};
      if (p?.kind === 'v_tags_any' || p?.kind === 'v_tags_all') {
        const csv = String(p.tagsCsv || '').toLowerCase();
        return csv.split(',').map(s=>s.trim()).includes('hide');
      }
      return false;
    });
    if (!includesHide) {
      base = base.filter(v => !(Array.isArray(v.tags) && v.tags.some(t => String(t||'').toLowerCase() === 'hide')));
    }
  } catch {}

  const needle = q.trim().toLowerCase();
  if (!needle) return base;
  return base.filter(v =>
    (v.title || '').toLowerCase().includes(needle) ||
    (v.channelName || v.channelId || '').toLowerCase().includes(needle)
  );
}, [videos, chain, q, groups, showStubsOnly]);

const channelsFiltered = useMemo(() => {
  // Apply boolean filter condition first (channel + video cross-scope), then search filter by text
  const cond = chainToCondition(chain);
  let base = channels;
  if (showStubsOnly) base = base.filter(ch => !Number.isFinite((ch.fetchedAt as any) || undefined));
  if (cond) {
    base = channels.filter(ch => matchesChannel(
      ch as any,
      cond as any,
      { videos, resolveGroup: (id) => groups.find(g => g.id === id) }
    ));
  }
  // Exclude channels tagged 'hide' by default unless the tag filter explicitly includes 'hide'
  try {
    const includesHide = chain.some(e => {
      const p: any = e?.pred || {};
      if (p?.kind === 'c_tags_any' || p?.kind === 'c_tags_all') {
        const csv = String(p.tagsCsv || '').toLowerCase();
        return csv.split(',').map(s=>s.trim()).includes('hide');
      }
      return false;
    });
    if (!includesHide) {
      base = base.filter(ch => !(Array.isArray((ch as any).tags) && (ch as any).tags.some((t: string) => String(t||'').toLowerCase() === 'hide')));
    }
  } catch {}
  const needle = q.trim().toLowerCase();
  if (!needle) return base;
  return base.filter(ch =>
    (ch.name || '').toLowerCase().includes(needle) ||
    ((ch as any).keywords || '' as string).toString().toLowerCase().includes(needle) ||
    (Array.isArray((ch as any).tags) && (ch as any).tags.some((t: string) => (t || '').toLowerCase().includes(needle))) ||
    (Array.isArray((ch as any).videoTags) && (ch as any).videoTags.some((t: string) => (t || '').toLowerCase().includes(needle)))
  );
}, [channels, q, chain, videos, groups, showStubsOnly]);

  // Visible ids under current (normal) filter; selection is temporarily disabled for items not in this set
  const visibleIdsNormal = useMemo(() => {
    const ids = new Set<string>();
    if (inChannels || inChannelsTrash) {
      for (const ch of channelsFiltered) ids.add(ch.id);
    } else {
      for (const v of filtered) ids.add(v.id);
    }
    return ids;
  }, [inChannels, inChannelsTrash, channelsFiltered, filtered]);

  const selectedVisibleSetNormal = useMemo(() => {
    const s = new Set<string>();
    selected.forEach(id => { if (visibleIdsNormal.has(id)) s.add(id); });
    return s;
  }, [selected, visibleIdsNormal]);
  const selectedVisibleCount = selectedVisibleSetNormal.size;
  const selectedHiddenCount = useMemo(() => {
    let n = 0; selected.forEach(id => { if (!visibleIdsNormal.has(id)) n++; }); return n;
  }, [selected, visibleIdsNormal]);
  // Toggle to show disabled (hidden) selected items instead of normal filtered results
  const [showDisabledOnly, setShowDisabledOnly] = useState(false);

  // Display lists depending on mode
  const displayVideos = useMemo(() => {
    if (showDisabledOnly) {
      // show selected items that are hidden by current filters
      return videos.filter(v => selected.has(v.id) && !visibleIdsNormal.has(v.id));
    }
    return filtered;
  }, [showDisabledOnly, videos, selected, filtered, visibleIdsNormal]);
  const displayChannels = useMemo(() => {
    if (showDisabledOnly) {
      return channels.filter(ch => selected.has(ch.id) && !visibleIdsNormal.has(ch.id));
    }
    return channelsFiltered;
  }, [showDisabledOnly, channels, selected, channelsFiltered, visibleIdsNormal]);

  // Visible selection for currently displayed list (normal or disabled view)
  const selectedVisibleSetDisplay = useMemo(() => {
    const s = new Set<string>();
    if (inChannels || inChannelsTrash) {
      for (const ch of displayChannels) if (selected.has(ch.id)) s.add(ch.id);
    } else {
      for (const v of displayVideos) if (selected.has(v.id)) s.add(v.id);
    }
    return s;
  }, [inChannels, inChannelsTrash, displayChannels, displayVideos, selected]);
  const selectedVisibleCountDisplay = selectedVisibleSetDisplay.size;

  // For selected items, how many have each tag (display-visible selection only)?
  const selectedVideosVisible = useMemo(() => videos.filter(v => selectedVisibleSetDisplay.has(v.id)), [videos, selectedVisibleSetDisplay]);
  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const v of selectedVideosVisible) for (const t of v.tags || []) m.set(t, (m.get(t) || 0) + 1);
    return m;
  }, [selectedVideosVisible]);

  // Tag options derived from current results, ignoring the tag predicates themselves
  const videoTagOptions = useMemo((): Array<{ name: string; count: number }> => {
    // Build condition without video tag predicates, so the list reflects current results except for the tag chip
    const pruned = chain.filter(e => !(e.pred.kind === 'v_tags_any' || e.pred.kind === 'v_tags_all' || e.pred.kind === 'v_tags_none'));
    const cond = chainToCondition(pruned);
    let base = videos;
    if (cond) {
      base = base.filter(v => matches(v as any, cond, {
        resolveGroup: (id) => groups.find(g => g.id === id),
        resolveChannel: (id) => channels.find(c => c.id === id) as any
      }));
    }
    const needle = q.trim().toLowerCase();
    if (needle) {
      base = base.filter(v => (v.title || '').toLowerCase().includes(needle) || (v.channelName || v.channelId || '').toLowerCase().includes(needle));
    }
    const counts = new Map<string, number>();
    for (const v of base) {
      const list = Array.isArray(v.tags) ? v.tags : [];
      for (const t of list) {
        if (!t) continue;
        const k = String(t);
        counts.set(k, (counts.get(k) || 0) + 1);
      }
    }
    // Ensure rating tags are visible even if count=0
    try {
      const ratingGid = 'tagGroup.rating';
      const ratingNames = tags.filter(t => (t.groupId === ratingGid) || (String(tagGroups.find(g => g.id === (t.groupId||''))?.name||'').toLowerCase() === 'rating')).map(t => t.name);
      for (const n of ratingNames) if (!counts.has(n)) counts.set(n, 0);
    } catch {}
    const numCmp = (a: string, b: string) => {
      const ai = /^\d+$/.test(String(a)) ? parseInt(String(a), 10) : NaN;
      const bi = /^\d+$/.test(String(b)) ? parseInt(String(b), 10) : NaN;
      const aNum = Number.isFinite(ai), bNum = Number.isFinite(bi);
      if (aNum && bNum) return ai - bi;
      if (aNum && !bNum) return -1; if (!aNum && bNum) return 1;
      return String(a).localeCompare(String(b));
    };
    return Array.from(counts, ([name, count]) => ({ name, count }))
      .sort((a,b)=> numCmp(a.name, b.name));
  }, [videos, chain, q, groups, channels, tags, tagGroups]);

  const channelTagOptions = useMemo((): Array<{ name: string; count: number }> => {
    // Build condition without channel tag predicates and without video tag predicates
    const pruned = chain.filter(e => !(
      e.pred.kind === 'c_tags_any' || e.pred.kind === 'c_tags_all' || e.pred.kind === 'c_tags_none' ||
      e.pred.kind === 'v_tags_any' || e.pred.kind === 'v_tags_all' || e.pred.kind === 'v_tags_none'
    ));
    const cond = chainToCondition(pruned);
    let base = channels;
    if (cond) {
      base = channels.filter(ch => matchesChannel(
        ch as any,
        cond as any,
        { videos, resolveGroup: (id) => groups.find(g => g.id === id) }
      ));
    }
    const needle = q.trim().toLowerCase();
    if (needle) {
      base = base.filter(ch =>
        (ch.name || '').toLowerCase().includes(needle) ||
        ((ch.keywords || '') as string).toLowerCase().includes(needle) ||
        (Array.isArray(ch.tags) && ch.tags.some(t => (t || '').toLowerCase().includes(needle))) ||
        (Array.isArray(ch.videoTags) && ch.videoTags.some(t => (t || '').toLowerCase().includes(needle)))
      );
    }
    const counts = new Map<string, number>();
    for (const ch of base) {
      const list: string[] = Array.isArray((ch as any).tags) ? (ch as any).tags as string[] : [];
      for (const t of list) {
        if (!t) continue;
        const k = String(t);
        counts.set(k, (counts.get(k) || 0) + 1);
      }
    }
    // Ensure rating tags are visible even if count=0
    try {
      const ratingGid = 'tagGroup.rating';
      const ratingNames = tags.filter(t => (t.groupId === ratingGid) || (String(tagGroups.find(g => g.id === (t.groupId||''))?.name||'').toLowerCase() === 'rating')).map(t => t.name);
      for (const n of ratingNames) if (!counts.has(n)) counts.set(n, 0);
    } catch {}
    const numCmp = (a: string, b: string) => {
      const ai = /^\d+$/.test(String(a)) ? parseInt(String(a), 10) : NaN;
      const bi = /^\d+$/.test(String(b)) ? parseInt(String(b), 10) : NaN;
      const aNum = Number.isFinite(ai), bNum = Number.isFinite(bi);
      if (aNum && bNum) return ai - bi;
      if (aNum && !bNum) return -1; if (!aNum && bNum) return 1;
      return String(a).localeCompare(String(b));
    };
    return Array.from(counts, ([name, count]) => ({ name, count }))
      .sort((a,b)=> numCmp(a.name, b.name));
  }, [channels, chain, q, videos, groups, tags, tagGroups]);

  // Apply sorting before pagination
  function applySort<A extends any>(arr: A[], fields: Array<{ field: string; dir: 'asc'|'desc' }>, kind: 'videos'|'channels'): A[] {
    if (!fields.length) return arr;
    const mul = (d: 'asc'|'desc') => (d === 'asc' ? 1 : -1);
    const get = (o: any, f: string) => (o && f in o ? o[f] : undefined);
    const collator = new Intl.Collator(undefined, { sensitivity: 'base' });
    const arrCopy = arr.slice();
    arrCopy.sort((a: any, b: any) => {
      for (const s of fields) {
        const av = get(a, s.field); const bv = get(b, s.field);
        if (av == null && bv == null) continue;
        if (av == null) return 1; if (bv == null) return -1;
        if (typeof av === 'string' || typeof bv === 'string') {
          const r = collator.compare(String(av), String(bv)); if (r !== 0) return r * mul(s.dir);
        } else {
          const na = Number(av), nb = Number(bv);
          if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return (na < nb ? -1 : 1) * mul(s.dir);
        }
      }
      return 0;
    });
    return arrCopy;
  }

  const sortedVideos = useMemo(() => {
    const base = displayVideos;
    if (!videoSorts.length) {
      // default for videos
      return base.slice().sort((a,b) => (b.uploadedAt||0) - (a.uploadedAt||0));
    }
    return applySort(base, videoSorts, 'videos');
  }, [displayVideos, videoSorts]);

  const sortedChannels = useMemo(() => {
    const base = displayChannels;
    if (!channelSorts.length) return base;
    return applySort(base, channelSorts, 'channels');
  }, [displayChannels, channelSorts]);

  const inChannelLike = inChannels || inChannelsTrash;
  const total = inChannelLike ? sortedChannels.length : sortedVideos.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // keep page in range when filter or page size changes
  useEffect(() => {
    setPage(1);
  }, [q, pageSize]);

  

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const start = (page - 1) * pageSize;
  const pageItems = sortedVideos.slice(start, start + pageSize);
  const channelsPageItems = sortedChannels.slice(start, start + pageSize);

  async function ensureApiKey(): Promise<string | null> {
    return new Promise((resolve) => {
      try {
        chrome.storage?.local?.get('ytApiKey', (obj) => {
          let key = (obj?.ytApiKey as string) || '';
          if (!key) {
            key = window.prompt('Enter YouTube API key (stored locally for future refresh)') || '';
            if (key) chrome.storage?.local?.set({ ytApiKey: key });
          }
          resolve(key || null);
        });
      } catch {
        const key = window.prompt('Enter YouTube API key');
        resolve(key || null);
      }
    });
  }

  function chunk<T>(arr: T[], n: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  }

  async function refreshData() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const apiKey = await ensureApiKey();
      if (!apiKey) return;
      const SKIP_FETCHED = true; // flip to false to refetch everything
      await sendBg('videos/refreshAll', { skipFetched: SKIP_FETCHED });

      const now = Date.now();
      setLastRefreshAt(now);
      try { chrome.storage?.local?.set({ lastRefreshAt: now }); } catch {}
      await refresh();
    } catch (e: any) {
      derr('refreshData error:', e?.message || e);
      alert(`Refresh failed: ${e?.message || e}`);
    } finally {
      setRefreshing(false);
    }
  }

  async function refreshStubCount() {
    try {
      const [v, c] = await Promise.all([
        sendBg('videos/stubsCount', {} as any).catch(() => ({ ok: false, count: 0 })),
        sendBg('channels/stubsCount', {} as any).catch(() => ({ ok: false, count: 0 })),
      ]);
      const vCount = (v && v.ok && Number.isFinite((v as any).count)) ? ((v as any).count | 0) : 0;
      const cCount = (c && c.ok && Number.isFinite((c as any).count)) ? ((c as any).count | 0) : 0;
      setStubCount(vCount + cCount);
    } catch {}
  }

  // ---- One-time import: tags => channelIds[] ----
  function normTag(s: string): string {
    return (s || '').toString().trim();
  }
  function normId(s: string): string {
    return (s || '').toString().trim();
  }

  async function importChannelTagsFromText(text: string) {
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch (e: any) {
      throw new Error(`Invalid JSON: ${e?.message || e}`);
    }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('Expected an object: { "tag name": ["UCâ€¦", â€¦], â€¦ }');
    }

    // Build map tag -> unique channel ids
    const entries = Object.entries(parsed) as Array<[string, any]>;
    const tagToIds = new Map<string, string[]>();
    for (const [rawTag, ids] of entries) {
      const tag = normTag(rawTag);
      if (!tag) continue;
      const list: string[] = Array.isArray(ids) ? ids.map(normId).filter(Boolean) : [];
      if (list.length === 0) continue;
      const uniq = Array.from(new Set(list));
      tagToIds.set(tag, uniq);
    }
    if (tagToIds.size === 0) throw new Error('No valid {tag: [channelIds]} entries found.');

    // Create tags first
    const allTags = Array.from(tagToIds.keys());
    setImportMessage(`Creating ${allTags.length} tag${allTags.length === 1 ? '' : 's'}â€¦`);
    for (const t of allTags) {
      try { await sendBg('tags/create', { name: t }); } catch {/* ignore individual failures */}
    }

    // Apply channel tags in chunks per tag
    const allImportedIds = new Set<string>();
    for (const [tag, ids] of tagToIds.entries()) {
      setImportMessage(`Applying tag "${tag}" to ${ids.length} channel${ids.length === 1 ? '' : 's'}â€¦`);
      const groups = chunk(ids, 200); // avoid large messages
      for (const g of groups) {
        await sendBg('channels/applyTags', { ids: g, addIds: [tag] });
      }
      ids.forEach(id => allImportedIds.add(id));
    }

    // Try to fetch metadata for imported channels now
    try {
      const ids = Array.from(allImportedIds.values());
      const chunks = chunk(ids, 400); // message-size safety; BG chunks to 50 for API
      for (const c of chunks) {
        await sendBg('channels/refreshByIds', { ids: c });
      }
    } catch { /* non-fatal */ }

    // Refresh UI lists
    await Promise.all([loadTags(), loadChannelsDir()]);
  }

  async function handleImportFile(file: File) {
    if (!file) return;
    try {
      setImporting(true);
      setImportMessage('Reading fileâ€¦');
      const text = await file.text();
      await importChannelTagsFromText(text);
      setImportMessage('Done');
      setTimeout(() => setImportMessage(null), 1500);
    } catch (e: any) {
      const msg = e?.message || String(e);
      setImportMessage(null);
      alert(`Import failed: ${msg}`);
    } finally {
      setImporting(false);
    }
  }

  function fmtTime(ts?: number | null): string {
    if (!ts) return '';
    try {
      const d = new Date(ts);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch { return ''; }
  }

  useEffect(() => {
    refreshStubCount();
    const h = (msg: any) => { if (msg?.type === 'db/change' && msg?.payload?.entity === 'videos') refreshStubCount(); };
    chrome.runtime.onMessage.addListener(h);
    return () => chrome.runtime.onMessage.removeListener(h);
  }, []);

  function applyTagToSelection(tag: string) {
    if (inChannels) {
      const selectedIds = Array.from(selectedVisibleSetDisplay);
      const haveAll = selectedIds.length > 0 && channels.reduce((n: number, c) => (selectedVisibleSetDisplay.has(c.id) && Array.isArray(c.tags) && c.tags.includes(tag)) ? n + 1 : n, 0) === selectedIds.length;
      sendBg('channels/applyTags', {
        ids: selectedIds,
        addIds: haveAll ? [] : [tag],
        removeIds: haveAll ? [tag] : []
      }).then(() => loadChannelsDir());
      return;
    }
    // Respect the selection visible in the current display mode (filtered or disabled view)
    const haveAllVideos = selectedVisibleCountDisplay > 0 && (tagCounts.get(tag) || 0) === selectedVisibleCountDisplay;
    sendBg('videos/applyTags', {
      ids: Array.from(selectedVisibleSetDisplay),
      addIds: haveAllVideos ? [] : [tag],
      removeIds: haveAllVideos ? [tag] : []
    }).then(() => refresh());
  }

  async function loadTagGroups() {
    try { const r: any = await sendBg('tagGroups/list', {} as any); setTagGroups(r?.items || []); } catch {}
  }

  async function createTagGroup(name: string) {
    await sendBg('tagGroups/create', { name });
    loadTagGroups();
  }
  async function renameTagGroup(id: string, name: string) {
    await sendBg('tagGroups/rename', { id, name });
    loadTagGroups();
  }
  async function deleteTagGroup(id: string) {
    await sendBg('tagGroups/delete', { id });
    loadTagGroups();
    loadTags(); // tags changed group binding
  }
  async function updateTagGroup(id: string, patch: Partial<TagGroupRec>) {
    await sendBg('tagGroups/update', { id, patch } as any);
    loadTagGroups();
  }
  async function assignTagToGroup(tagName: string, groupId: string | null) {
    await sendBg('tags/assignGroup', { name: tagName, groupId });
    loadTags();
  }

  // ---- Mode persistence (storage + URL hash) ----
  function parseHashMode(): 'manager' | 'subs' | 'recommender' | null {
    try {
      const h = String(window.location.hash || '').toLowerCase();
      if (h.includes('mode=subs')) return 'subs';
      if (h.includes('mode=recommender')) return 'recommender';
      if (h.includes('mode=manager')) return 'manager';
    } catch {}
    return null;
  }
  useEffect(() => {
    // Prefer URL hash deep-link; fallback to storage
    const fromHash = parseHashMode();
    if (fromHash) setMode(fromHash);
    else {
      try {
        chrome.storage?.local?.get('options.mode', (obj) => {
          const m = String((obj as any)?.['options.mode'] || '').toLowerCase();
          if (m === 'subs' || m === 'recommender' || m === 'manager') setMode(m as any);
        });
      } catch {}
    }
    // Hash change listener
    const onHash = () => {
      const m = parseHashMode();
      if (m && m !== mode) setMode(m);
    };
    try { window.addEventListener('hashchange', onHash); } catch {}
    return () => { try { window.removeEventListener('hashchange', onHash); } catch {} };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    // Persist to storage and reflect in hash
    try { chrome.storage?.local?.set({ 'options.mode': mode }); } catch {}
    try {
      const next = `#mode=${mode}`;
      if (window.location.hash !== next) window.location.hash = next;
    } catch {}
  }, [mode]);

  return (
    <div className="page" data-mode={mode}>
<Sidebar
  tags={tags}
  newTag={newSidebarTag}
  setNewTag={setNewSidebarTag}
  tagEditing={tagEditing}
  tagEditValue={tagEditValue}
  setTagEditValue={setTagEditValue}
  startRename={startRename}
  cancelRename={cancelRename}
  commitRename={commitRename}
  addTag={addTag}
  removeTag={removeTag}
  importing={importing}
  importMessage={importMessage}
  onImportFile={handleImportFile}
  tagGroups={tagGroups}
  onCreateTagGroup={createTagGroup}
  onRenameTagGroup={renameTagGroup}
  onDeleteTagGroup={deleteTagGroup}
  onUpdateTagGroup={updateTagGroup}
  onAssignTagToGroup={assignTagToGroup}
  groups={groups}
  startEditFromGroup={startEditFromGroup}
  removeGroup={removeGroup}
  isPresetScrapeCheckable={isPresetScrapeCheckable}
  toggleGroupScrape={toggleGroupScrape}
  driveClientId={driveClientId}
  onSetDriveClientId={setDriveClientIdInteractive}
  onBackupNow={backupSettingsInteractive}
  onOpenHistory={openBackups}
  mode={mode}
  onModeChange={setMode}
/>
      <div className="content">
        {/* Non-manager placeholder content */}
        <div className="non-manager-only">
          <header>
            <h1 style={{ margin: 0, fontSize: 18 }}>{mode === 'subs' ? 'Subs' : (mode === 'recommender' ? 'Recommender' : 'Manager')}</h1>
          </header>
          <div className="filters">
            <span className="muted">{mode === 'subs' ? 'Chronological subscriptions feed (filtered) will appear here.' : 'Multi-source recommendations will appear here.'}</span>
          </div>
          <div style={{ padding: 16 }}>
            <div className="card" style={{ padding: 12 }}>
              <div className="muted">This section is scaffolded. Detailed features will be implemented next.</div>
            </div>
          </div>
        </div>
        <div className="manager-only">
          <header>

          <div className="controls">
            {/* View toggle (single button) */}
            <div className="view-toggle" role="group" aria-label="View mode">
              <button
                type="button"
                className="icon-btn"
                aria-pressed={true}
                title={isList ? 'Switch to grid view' : 'Switch to list view'}
                onClick={() => setLayout(isList ? 'grid' : 'list')}
              >
                {isList ? (
                  <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
                    <rect x="5" y="5" width="14" height="14" rx="2" ry="2"></rect>
                  </svg>
                ) : (
                  <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 7h16v2H4zM4 11h16v2H4zM4 15h16v2H4z"></path>
                  </svg>
                )}
              </button>
            </div>

            {/* Trash toggle (single) */}
            <button
              type="button"
              className="icon-btn"
              aria-pressed={inTrash || inChannelsTrash}
              title={(inTrash || inChannelsTrash) ? 'Show non-trash' : 'Show trash'}
              onClick={() => setView((inChannels || inChannelsTrash) ? (inChannelsTrash ? 'channels' : 'channelsTrash') : (inTrash ? 'videos' : 'trash'))}
            >
              <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M9 3h6a1 1 0 0 1 1 1v1h4v2H4V5h4V4a1 1 0 0 1 1-1Zm-3 6h12l-1 10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 9Zm4 2v8h2v-8H10Zm4 0v8h2v-8h-2Z" />
              </svg>
            </button>

            {/* Selection controls */}
            <div className="sel-controls">
              <button
                type="button"
                className="btn-ghost"
                title="Select all (matching filter)"
                onClick={() => selectAllMatching((inChannels || inChannelsTrash) ? displayChannels.map(ch => ch.id) : displayVideos.map(v => v.id))}
              >
                all
              </button>

              <button
                type="button"
                className="btn-ghost"
                title="Clear selection"
                onClick={clearSelection}
                disabled={selectedCount === 0}
              >
                C
              </button>

              <button
                type="button"
                className="btn-ghost"
                title="Invert selection (within current filter)"
                onClick={() => {
                  setSelected(prev => {
                    const next = new Set(prev);
                    if (inChannels || inChannelsTrash) {
                      for (const ch of displayChannels) { if (next.has(ch.id)) next.delete(ch.id); else next.add(ch.id); }
                    } else {
                      for (const v of displayVideos) { if (next.has(v.id)) next.delete(v.id); else next.add(v.id); }
                    }
                    return next;
                  });
                }}
                disabled={(inChannels || inChannelsTrash) ? displayChannels.length === 0 : displayVideos.length === 0}
              >
                Inv
              </button>

              <button
                type="button"
                className="btn-ghost"
                title="Open selected in new tabs"
                onClick={async () => {
                  const ids = Array.from(selectedVisibleSetDisplay);
                  if (!ids.length) return;
                  // Open channels or videos depending on current entity view
                  const mkUrl = (id: string) => (inChannels || inChannelsTrash)
                    ? `https://www.youtube.com/channel/${id}`
                    : `https://www.youtube.com/watch?v=${id}`;
                  for (const id of ids) {
                    try { await chrome.tabs?.create?.({ url: mkUrl(id), active: false }); } catch { /* ignore */ }
                  }
                }}
                disabled={selectedVisibleCountDisplay === 0}
              >
                T
              </button>

              <button
                type="button"
                className="btn-ghost"
                title={showDisabledOnly ? 'Show filtered results' : 'Show disabled selection'}
                onClick={() => setShowDisabledOnly(v => !v)}
              >
                D
              </button>

              <span className="sel-info">{selectedVisibleCount}{selectedHiddenCount > 0 ? ` -${selectedHiddenCount}` : ''}</span>
            </div>

            {/* Delete */}
            <button
              type="button"
              className="btn-danger"
              title={(inTrash || inChannelsTrash) ? 'Delete selected permanently' : 'Delete selected (moves to Trash)'}
              onClick={(inTrash || inChannelsTrash) ? purgeSelected : deleteSelected}
              disabled={selectedVisibleCountDisplay === 0}
            >
              X
            </button>
            {inChannelsTrash && (
              <button
                type="button"
                className="btn-ghost"
                title="Restore selected channels from trash"
                onClick={async () => { const ids = Array.from(selectedVisibleSetDisplay); if (!ids.length) return; await sendBg('channels/restore', { ids }); setSelected(prev => { const s = new Set(prev); ids.forEach(id => s.delete(id)); return s; }); await loadChannelsDir(); }}
                disabled={selectedVisibleCountDisplay === 0}
              >
                Restore
              </button>
            )}
            <button
              type="button"
              className="btn-ghost"
              title="Tag selected"
              onClick={() => setShowTagger(v => !v)}
              disabled={selectedVisibleCountDisplay === 0}
            >
              tags
            </button>
            {/* Search & refresh */}
            <input
              id="q"
              type="search"
              placeholder="Filter by title or channel..."
              value={q}
              onChange={e => setQ(e.target.value)}
            />
            <button id="refresh" onClick={refresh} disabled={loading} title="Reload list from local database">{loading ? 'Loadingâ€¦' : 'Refresh DB'}</button>
            {/* Entity toggle (Videos â†” Channels, aware of trash) */}
            <button
              type="button"
              className="btn-ghost"
              aria-pressed={inChannels || inChannelsTrash}
              title={(inChannels || inChannelsTrash) ? 'Show videos' : 'Show channels'}
              onClick={() => setView((inChannels || inChannelsTrash) ? ((inChannelsTrash || inTrash) ? 'trash' : 'videos') : ((inTrash || inChannelsTrash) ? 'channelsTrash' : 'channels'))}
            >
              {(inChannels || inChannelsTrash) ? 'Videos' : 'Channels'}
            </button>
            <button
              type="button"
              className="btn-ghost"
              aria-pressed={view==='pending'}
              title={view==='pending' ? 'Show videos' : 'Show scraping panel'}
              onClick={() => setView(view==='pending' ? 'videos' : 'pending')}
            >
              Scraping
            </button>
            <button
              type="button"
              className="btn-ghost"
              title="Fetch video metadata via YouTube API for missing/stale videos"
              onClick={refreshData}
              disabled={refreshing}
            >
              {refreshing ? 'Refreshingâ€¦' : 'Fetch video data'}
            </button>
            <label style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2, marginLeft: 8 }} title="Show only items without fetched metadata">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={showStubsOnly} onChange={(e)=> setShowStubsOnly(e.target.checked)} />
                <span className="muted">{stubCount} stubs</span>
              </span>
              <span className="muted" style={{ fontSize: 11, paddingLeft: 27 }}>
                {(inChannels || inChannelsTrash)
                  ? channelsFiltered.filter(ch => {
                      const hidden = Array.isArray((ch as any).tags) && (ch as any).tags.some((t: string) => String(t||'').toLowerCase() === 'hide');
                      return !hidden && !Number.isFinite(((ch as any).fetchedAt as any) || undefined);
                    }).length
                  : filtered.filter(v => {
                      const hidden = Array.isArray(v.tags) && v.tags.some(t => String(t||'').toLowerCase() === 'hide');
                      return !hidden && !Number.isFinite(v.fetchedAt || undefined);
                    }).length}
                in view
              </span>
            </label>
            <button
              type="button"
              className="btn-ghost"
              title="Fetch metadata for channels that were never fetched (stubs)"
              onClick={() => sendBg('channels/refreshUnfetched', {}).then(() => loadChannelsDir())}
            >
              Fetch channels (unfetched)
            </button>
            {refreshing && (
              <span className="muted" aria-live="polite" title={`Applied ${refreshApplied} items`}>
                {refreshProcessed}/{refreshTotal}{refreshFailed ? ` (${refreshFailed} failed)` : ''}
              </span>
            )}
            <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', marginLeft: 8 }}>
              {!refreshing && (
                <span className="muted" aria-live="polite" title="Last fetch time">F: {fmtTime(lastRefreshAt)}</span>
              )}
              {backupInProgress ? (
                <span className="muted" aria-live="polite" title="Backup in progress">Backing upâ€¦</span>
              ) : unsyncedCount > 0 ? (
                <span className="badge" title={`${unsyncedCount} commit(s) pending upload to Drive`}>
                  Drive backlog: {unsyncedCount}
                </span>
              ) : (
                <span className="muted" aria-live="polite" title="Last backup time">B: {fmtTime(lastBackupAt)}</span>
              )}
            </span>
            {backupLastError && (
              <span className="muted" style={{ color: 'salmon' }} title="Backup error">{String(backupLastError).slice(0, 120)}</span>
            )}
            {refreshLastError && (
              <span className="muted" style={{ color: 'salmon' }} title="Last error">{String(refreshLastError).slice(0, 140)}</span>
            )}
            {/* Wipe sources removed per UX */}
          </div>
        </header>
        {showTagger && selectedVisibleCountDisplay > 0 && (
          <div className="tagger" style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {/* Video Type toggles (does not change tags) */}
            {!inChannels && (
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <span>Video Type:</span>
                {(() => {
                  const selectedTypes = new Set<string>();
                  for (const v of selectedVideosVisible) { const t = String((v as any).type || '').toLowerCase(); if (t) selectedTypes.add(t); }
                  const common = selectedTypes.size === 1 ? Array.from(selectedTypes)[0] : '';
                  const setType = async (t: 'video'|'short'|'livestream') => {
                    const ids = Array.from(selectedVisibleSetDisplay);
                    if (!ids.length) return;
                    await sendBg('videos/setType', { ids, type: t } as any);
                  };
                  const btn = (t: 'video'|'short'|'livestream', label: string) => (
                    <button type="button" className="btn-ghost" style={{ background: common === t ? '#203040' : undefined }} onClick={() => setType(t)}>{label}</button>
                  );
                  return <>{btn('video','Video')}{btn('short','Short')}{btn('livestream','Livestream')}</>;
                })()}
              </div>
            )}
            <span style={{ marginRight: 8 }}>Apply tag:</span>
            {/* Grouped by parent and nested tag groups */}
            {(() => {
              // Build parent -> child -> tags structure
              const groupById = new Map<string, TagGroupRec>(tagGroups.map(g => [g.id, g] as [string, TagGroupRec]));
              const parentBuckets = new Map<string, Map<string, string[]>>(); // parentId('' for none) -> childId('' if none) -> tags
              for (const t of tags) {
                const gid = (t.groupId || '') as string;
                if (!gid || !groupById.has(gid)) {
                  const pMap = parentBuckets.get('') || (parentBuckets.set('', new Map()), parentBuckets.get('')!);
                  const cList = pMap.get('') || (pMap.set('', []), pMap.get('')!);
                  cList.push(t.name);
                  continue;
                }
                const g = groupById.get(gid)!;
                const parentId = g.parentId ? String(g.parentId) : String(g.id);
                const childKey = g.parentId ? String(g.id) : '';
                const pMap = parentBuckets.get(parentId) || (parentBuckets.set(parentId, new Map()), parentBuckets.get(parentId)!);
                const list = pMap.get(childKey) || (pMap.set(childKey, []), pMap.get(childKey)!);
                list.push(t.name);
              }
              // Order parents: ungrouped first, then by name
              const parentEntries = Array.from(parentBuckets.entries()).sort((a,b) => {
                if (a[0] === '' && b[0] !== '') return -1; if (a[0] !== '' && b[0] === '') return 1;
                const an = a[0] ? (groupById.get(a[0])?.name || '') : 'Ungrouped';
                const bn = b[0] ? (groupById.get(b[0])?.name || '') : 'Ungrouped';
                return an.localeCompare(bn);
              });
              const numCmp = (a: string, b: string) => {
                const ai = /^\d+$/.test(a) ? parseInt(a, 10) : NaN; const bi = /^\d+$/.test(b) ? parseInt(b, 10) : NaN;
                const aNum = Number.isFinite(ai), bNum = Number.isFinite(bi);
                if (aNum && bNum) return ai - bi; if (aNum && !bNum) return -1; if (!aNum && bNum) return 1; return a.localeCompare(b);
              };
              return parentEntries.map(([parentId, childMap]) => {
                const parent = parentId ? groupById.get(parentId) : null;
                const parentTitle = parent ? parent.name : 'Ungrouped';
                const parentBg = parent?.color ? toHex6(parent.color) : null;
                const parentFg = textColorBW(parentBg || undefined);
                // Sort child buckets: '' first (no nested), then by nested name
                const childEntries = Array.from(childMap.entries()).sort((a,b) => {
                  if (a[0] === '' && b[0] !== '') return -1; if (a[0] !== '' && b[0] === '') return 1;
                  const an = a[0] ? (groupById.get(a[0])?.name || '') : '';
                  const bn = b[0] ? (groupById.get(b[0])?.name || '') : '';
                  return an.localeCompare(bn);
                });
                return (
                  <details key={parentId || 'ungrouped'} className="tag-dropdown">
                    <summary style={{ background: parentBg || undefined, color: parentFg, paddingInline: 6, border: parentBg ? `1px solid ${darken(parentBg, 0.25)}` : undefined }}>
                      {parentTitle}
                    </summary>
                    <div style={{ display: 'flex', gap: 12, paddingTop: 6, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                      {childEntries.map(([childId, names]) => {
                        // Sort names inside child; rating numeric ordering if Rating group or nested under Rating parent
                        const parentIsRating = parentId && ((groupById.get(parentId)?.name || '').trim().toLowerCase() === 'rating' || parentId === 'tagGroup.rating');
                        const childIsRating = childId && ((groupById.get(childId)?.name || '').trim().toLowerCase() === 'rating' || childId === 'tagGroup.rating');
                        const isRating = parentIsRating || childIsRating;
                        names.sort((a,b)=> isRating ? numCmp(a,b) : a.localeCompare(b));
                        const childColor = childId ? (groupById.get(childId)?.color ? toHex6(groupById.get(childId)!.color) : null) : null;
                        return (
                          <div key={childId || 'none'} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            {names.map(tag => {
                              const nm = String(tag || '').toLowerCase();
                              if (nm === 'subscribed' || nm === 'unsubscribed') return null;
                              if (!inChannels && (nm === 'scrape' || nm === 'tagged')) return null;
                              const haveAll = inChannels
                                ? (channels.reduce((n: number, c) => (selectedVisibleSetDisplay.has(c.id) && Array.isArray(c.tags) && c.tags.includes(tag)) ? n + 1 : n, 0) === selectedVisibleCountDisplay && selectedVisibleCountDisplay > 0)
                                : ((tagCounts.get(tag) || 0) === selectedVisibleCountDisplay && selectedVisibleCountDisplay > 0);
                              const bg = childColor || undefined; const fg = textColorBW(bg); const br = bg ? darken(bg, 0.25) : undefined;
                              return (
                                <button
                                  key={tag}
                                  type="button"
                                  className="btn-ghost"
                                  onClick={() => applyTagToSelection(tag)}
                                  style={{
                                    background: bg || (haveAll ? '#203040' : undefined),
                                    color: fg,
                                    border: bg ? `1px solid ${br}` : undefined,
                                  }}
                                  title={haveAll ? 'Remove from all selected' : 'Add to all selected'}
                                >
                                  {tag}
                                </button>
                              );
                            })}
                          </div>
                        );
                      })}
                    </div>
                  </details>
                );
              });
            })()}
            {availableTags.length === 0 && (
              <span className="muted">No tags yet. Add tags in the sidebar.</span>
            )}
          </div>
        )}
    <FiltersBar
    chain={chain}
    setChain={setChain}
    channelOptions={channelOptions}
    videoTagOptions={videoTagOptions}
    videoSourceOptions={videoSourcesOptionsMemo}
    channelTagOptions={channelTagOptions}
    tagsRegistry={tags}
    tagGroups={tagGroups}
    topicOptions={topicOptions}
    countryOptions={countryOptions}
    groups={groups}
  groupName={groupName}
  setGroupName={setGroupName}
  editingGroupId={editingGroupId}
  onSaveAsGroup={saveAsGroup}
  onSaveChanges={saveChangesToGroup}
  onCancelEdit={cancelEditing}
/> 
{/* Sorting + Pagination toolbar */}
<div className="toolbar-2">
  {/* Sorts row */}
  <div className="sorts" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
    <label style={{ marginRight: 4 }}>Sort by:</label>
    {(inChannelLike ? channelSorts : videoSorts).map((s, i) => (
      <span key={i} className="badge" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        <select className="chip-input" value={s.field} onChange={(e)=> (inChannelLike ? setChannelSorts : setVideoSorts)(arr => arr.map((x,idx)=> idx===i ? { ...x, field: e.target.value } : x))}>
          {inChannelLike ? (
            <>
              <option value="name">Name</option>
              <option value="subs">Subscribers</option>
              <option value="views">Views</option>
              <option value="videos">Video count</option>
              <option value="fetchedAt">Fetched time</option>
            </>
          ) : (
            <>
              <option value="uploadedAt">Uploaded time</option>
              <option value="durationSec">Duration</option>
              <option value="title">Title</option>
              <option value="fetchedAt">Fetched time</option>
            </>
          )}
        </select>
        <select className="chip-input" value={s.dir} onChange={(e)=> (inChannelLike ? setChannelSorts : setVideoSorts)(arr => arr.map((x,idx)=> idx===i ? { ...x, dir: e.target.value as 'asc'|'desc' } : x))}>
          <option value="asc">asc</option>
          <option value="desc">desc</option>
        </select>
        <button className="chip-remove" onClick={()=> (inChannelLike ? setChannelSorts : setVideoSorts)(arr => arr.filter((_,idx)=> idx!==i))} title="Remove">A-</button>
      </span>
    ))}
    <select className="add-filter" value="" onChange={(e)=>{ const v=e.target.value as string; if(!v) return; (inChannelLike ? setChannelSorts : setVideoSorts)(arr => [...arr, { field: v, dir: 'desc' }]); (e.target as HTMLSelectElement).value=''; }}>
      <option value="">+ Add sort...</option>
      {inChannelLike ? (
        <>
          <option value="name">Name</option>
          <option value="subs">Subscribers</option>
          <option value="views">Views</option>
          <option value="videos">Video count</option>
          <option value="fetchedAt">Fetched time</option>
        </>
      ) : (
        <>
          <option value="uploadedAt">Uploaded time</option>
          <option value="durationSec">Duration</option>
          <option value="title">Title</option>
          <option value="fetchedAt">Fetched time</option>
        </>
      )}
    </select>
  </div>
  <div className="page-size">
    <label htmlFor="pageSize">Per page:</label>
    <select
      id="pageSize"
      value={pageSize}
      onChange={(e) => setPageSize(Number(e.target.value))}
    >
      <option value={50}>50</option>
      <option value={100}>100</option>
      <option value={250}>250</option>
      <option value={500}>500</option>
    </select>
  </div>

  <div className="pager">
    <button
      type="button"
      className="btn-ghost"
      onClick={() => setPage(p => Math.max(1, p - 1))}
      disabled={page <= 1}
      title="Previous page"
    >
      â† Prev
    </button>
    <span className="page-info">Page {page} / {totalPages}</span>
    <button
      type="button"
      className="btn-ghost"
      onClick={() => setPage(p => Math.min(totalPages, p + 1))}
      disabled={page >= totalPages}
      title="Next page"
    >
      Next â†’
    </button>
  </div>

  <div className="total-info">{total} total</div>
</div>

{/* The list itself */}
{view==='pending' ? (
  <PendingPanel />
) : inChannelLike ? (
  <div style={{ padding: 16 }}>
    {channelsPageItems.map(ch => (
      <>
      <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 8 }}>
        <label className="select">
          <input type="checkbox" checked={selected.has(ch.id)} onChange={() => toggleSelect(ch.id)} aria-label="Select channel" />
        </label>
        <img
          src={avatarUrlFromThumbId((ch as any).thumbnailID || null)}
          alt="avatar"
          style={{ width: 40, height: 40, borderRadius: '50%', background: '#222', cursor: 'pointer' }}
          onClick={() => toggleSelect(ch.id)}
          title={selected.has(ch.id) ? 'Deselect' : 'Select'}
        />
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <strong>
            <a
              href={`https://www.youtube.com/channel/${ch.id}`}
              target="_blank"
              rel="noopener noreferrer"
              title="Open channel on YouTube"
            >
              {ch.name || ch.id}
            </a>
          </strong>
          <span className="muted" style={{ fontSize: 12 }}>{ch.subs ? `${ch.subs.toLocaleString()} subscribers` : ''}</span>
          {Array.isArray((ch as any).tags) && (ch as any).tags.length > 0 && (
            <span className="badges">
              {((ch as any).tags as string[]).map((t) => {
                const rec = tags.find(x => x.name === t);
                const gid = (rec?.groupId || '') as string;
                const grp = gid ? tagGroups.find(g => g.id === gid) : undefined;
                const parent = grp ? (grp.parentId ? tagGroups.find(g => g.id === grp.parentId) || grp : grp) : undefined;
                const bg = parent?.color ? toHex6(parent.color) : null;
                const fg = textColorBW(bg || undefined);
                const br = bg ? darken(bg, 0.25) : undefined;
                return <span key={t} className="badge" style={{ background: bg || undefined, color: fg, border: br ? `1px solid ${br}` : undefined }}>{t}</span>;
              })}
            </span>
          )}
          {Array.isArray((ch as any).videoTags) && (ch as any).videoTags.length > 0 && (
            <span className="badge">Video tags: {(ch as any).videoTags.join(', ')}</span>
          )}
          {(ch as any).keywords && <span className="muted" style={{ fontSize: 12 }}>Keywords: {(ch as any).keywords}</span>}
          {Array.isArray((ch as any).topics) && (ch as any).topics.length > 0 && (
            <span className="muted" style={{ fontSize: 12 }}>Topics: {(ch as any).topics.join(', ')}</span>
          )}
        </div>
        <div style={{ marginLeft: 'auto' }}>
          <button type="button" className="btn-ghost" onClick={() => toggleChannelDebug(ch.id)}>Show info</button>
        </div>
      </div>
      {openChannelDebug.has(ch.id) && (
        <div className="debug-panel" role="region" aria-label="Channel data" style={{ marginTop: -8, marginBottom: 8 }}>
          <div className="debug-panel-head">
            <span>Stored data</span>
            <button className="debug-close" onClick={() => toggleChannelDebug(ch.id)} title="Close">A-</button>
          </div>
          <pre className="debug-pre">{JSON.stringify((channelFull[ch.id] ?? ch) as any, null, 2)}</pre>
        </div>
      )}
      </>
    ))}
    {channels.length === 0 && <div className="muted">No channels yet.</div>}
  </div>
) : (
  <VideoList
    items={pageItems}
    layout={layout}
    loading={loading}
    selected={selected}
    onToggle={toggleSelect}
    tagGroups={tagGroups}
    tagsRegistry={tags}
  />
)}

{/* Undo toast (if you still want it visible here) */}
{showUndo && lastDeleted && (
  <div className="toast">
    Deleted {lastDeleted.length} {lastDeleted.length === 1 ? 'item' : 'items'}
    <button className="btn-link" onClick={undoDelete}>Undo</button>
  </div>
)}
        </div>
      </div>{/* .content */}
      <BackupModal open={showBackups} onClose={closeBackups} />
      <HistoryModal open={showHistory} onClose={closeHistory} />
    </div>
  );
}











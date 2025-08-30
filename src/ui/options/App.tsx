import { useEffect, useMemo, useState } from 'react';
import { dlog, derr } from '../../types/debug';
import { matches, matchesChannel, type Condition, type Group as GroupRec } from '../../shared/conditions';
import FiltersBar from './components/FiltersBar';
import type { FilterEntry } from './lib/filters';
import { chainToCondition, conditionToChainSimple } from './lib/filters';
import { getAll as idbGetAll } from '../lib/idb';
import { send as sendBg } from '../lib/messaging';
import type { TagRec } from '../../types/messages';
import Sidebar from './components/Sidebar';
import VideoList from './components/VideoList';

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
  const [videos, setVideos] = useState<Video[]>([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [layout, setLayout] = useState<'grid' | 'list'>('list'); // UI-only state
  const isGrid = layout === 'grid';
  const isList = layout === 'list';
  const [view, setView] = useState<'videos' | 'trash' | 'channels'>('videos');
  const inTrash = view === 'trash';
  const inChannels = view === 'channels';
  // Selection
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selectedCount = selected.size;
  // Pagination
  const [pageSize, setPageSize] = useState<number>(100); // options: 50, 100, 250, 500
  const [page, setPage] = useState<number>(1);
  const [lastDeleted, setLastDeleted] = useState<string[] | null>(null);
  const [showUndo, setShowUndo] = useState(false);

  const [showTagger, setShowTagger] = useState(false);

  const [tags, setTags] = useState<TagRec[]>([]);
  const [tagEditing, setTagEditing] = useState<string | null>(null);
  const [tagEditValue, setTagEditValue] = useState('');
  const [newSidebarTag, setNewSidebarTag] = useState('');

  const [groups, setGroups] = useState<GroupRec[]>([]);
  const [channels, setChannels] = useState<Array<{
    id: string;
    name: string;
    fetchedAt?: number | null;
    thumbUrl?: string | null;
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
  const [openChannelDebug, setOpenChannelDebug] = useState<Set<string>>(new Set());
  const [channelFull, setChannelFull] = useState<Record<string, any>>({});
  const [videoSorts, setVideoSorts] = useState<Array<{ field: string; dir: 'asc' | 'desc' }>>([]);
  const [channelSorts, setChannelSorts] = useState<Array<{ field: string; dir: 'asc' | 'desc' }>>([]);
  const [topicOptions, setTopicOptions] = useState<string[]>([]);
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
  async function loadChannelsDir() {
    const resp: any = await sendBg('channels/list', {});
    setChannels(resp?.items || []);
  }
  useEffect(() => {
    // initial load also pulls groups
    refresh();
    loadGroups();
    loadChannelsDir();
    loadTopicOptions();
    // load last refresh time from storage
    try {
      chrome.storage?.local?.get('lastRefreshAt', (obj) => {
        const t = obj?.lastRefreshAt as number | undefined;
        if (t && Number.isFinite(t)) setLastRefreshAt(t);
      });
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
// (We’ll extend this when we add explicit parentheses in the editor.)

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
    const ids = Array.from(selected);
    if (!ids.length) return;
    await sendBg('videos/delete', { ids });

    setLastDeleted(ids);
    setShowUndo(true);
    clearSelection();
    await refresh();

    // auto-hide toast after a bit (optional)
    setTimeout(() => setShowUndo(false), 6000);
  }


  async function undoDelete() {
    if (!lastDeleted?.length) return;
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
    setSelected(new Set(allIds));
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
    refresh(); // reload from the correct store
    loadTags();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

useEffect(() => {
  function onMsg(msg: any) {
    if (msg?.type === 'db/change') {
      const ent = msg.payload?.entity;
      if (ent === 'videos' || ent == null) { refresh(); loadTopicOptions(); }
      if (ent === 'tags')   loadTags();
      if (ent === 'groups') loadGroups();
      if (ent === 'channels') loadChannelsDir();
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
  // For selected items, how many have each tag?
  const selectedVideos = useMemo(() => videos.filter(v => selected.has(v.id)), [videos, selected]);
  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const v of selectedVideos) for (const t of v.tags || []) m.set(t, (m.get(t) || 0) + 1);
    return m;
  }, [selectedVideos]);
  // AFTER: derive names from the registry we loaded via tags/list
  // All registry tags (for the tag apply UI)
  const availableTags = useMemo(() => tags.map(t => t.name), [tags]);

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
    // If all have it → remove from all; otherwise add to all
    sendBg('videos/applyTags', {
      ids: Array.from(selected),
      addIds: allHave ? [] : [tag],
      removeIds: allHave ? [tag] : []
    }).then(() => refresh());
  }

const filtered = useMemo(() => {
  let base = videos;

  const cond = chainToCondition(chain);
  if (cond) {
    base = base.filter(v => matches(v as any, cond, {
      resolveGroup: (id) => groups.find(g => g.id === id),
      resolveChannel: (id) => channels.find(c => c.id === id) as any
    }));
  }

  const needle = q.trim().toLowerCase();
  if (!needle) return base;
  return base.filter(v =>
    (v.title || '').toLowerCase().includes(needle) ||
    (v.channelName || v.channelId || '').toLowerCase().includes(needle)
  );
}, [videos, chain, q, groups]);

const channelsFiltered = useMemo(() => {
  // Apply boolean filter condition first (channel + video cross-scope), then search filter by text
  const cond = chainToCondition(chain);
  let base = channels;
  if (cond) {
    base = channels.filter(ch => matchesChannel(
      ch as any,
      cond as any,
      { videos, resolveGroup: (id) => groups.find(g => g.id === id) }
    ));
  }
  const needle = q.trim().toLowerCase();
  if (!needle) return base;
  return base.filter(ch =>
    (ch.name || '').toLowerCase().includes(needle) ||
    ((ch.keywords || '') as string).toLowerCase().includes(needle) ||
    (Array.isArray(ch.tags) && ch.tags.some(t => (t || '').toLowerCase().includes(needle))) ||
    (Array.isArray(ch.videoTags) && ch.videoTags.some(t => (t || '').toLowerCase().includes(needle)))
  );
}, [channels, q, chain, videos, groups]);

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
    return Array.from(counts, ([name, count]) => ({ name, count }))
      .sort((a,b)=> a.name.localeCompare(b.name));
  }, [videos, chain, q, groups, channels]);

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
    return Array.from(counts, ([name, count]) => ({ name, count }))
      .sort((a,b)=> a.name.localeCompare(b.name));
  }, [channels, chain, q, videos, groups]);

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
    if (!videoSorts.length) {
      // default for videos
      return filtered.slice().sort((a,b) => (b.uploadedAt||0) - (a.uploadedAt||0));
    }
    return applySort(filtered, videoSorts, 'videos');
  }, [filtered, videoSorts]);

  const sortedChannels = useMemo(() => {
    if (!channelSorts.length) return channelsFiltered;
    return applySort(channelsFiltered, channelSorts, 'channels');
  }, [channelsFiltered, channelSorts]);

  const total = inChannels ? sortedChannels.length : sortedVideos.length;
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
      throw new Error('Expected an object: { "tag name": ["UC…", …], … }');
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
    setImportMessage(`Creating ${allTags.length} tag${allTags.length === 1 ? '' : 's'}…`);
    for (const t of allTags) {
      try { await sendBg('tags/create', { name: t }); } catch {/* ignore individual failures */}
    }

    // Apply channel tags in chunks per tag
    const allImportedIds = new Set<string>();
    for (const [tag, ids] of tagToIds.entries()) {
      setImportMessage(`Applying tag "${tag}" to ${ids.length} channel${ids.length === 1 ? '' : 's'}…`);
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
      setImportMessage('Reading file…');
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

  function applyTagToSelection(tag: string) {
    if (inChannels) {
      const selectedIds = Array.from(selected);
      const haveAll = selectedIds.length > 0 && channels.reduce((n, c) => (selected.has(c.id) && Array.isArray(c.tags) && c.tags.includes(tag)) ? n + 1 : n, 0) === selectedIds.length;
      sendBg('channels/applyTags', {
        ids: selectedIds,
        addIds: haveAll ? [] : [tag],
        removeIds: haveAll ? [tag] : []
      }).then(() => loadChannelsDir());
      return;
    }
    const haveAllVideos = selectedCount > 0 && (tagCounts.get(tag) || 0) === selectedCount;
    sendBg('videos/applyTags', {
      ids: Array.from(selected),
      addIds: haveAllVideos ? [] : [tag],
      removeIds: haveAllVideos ? [tag] : []
    }).then(() => refresh());
  }

  return (
    <div className="page">
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
  groups={groups}
  startEditFromGroup={startEditFromGroup}
  removeGroup={removeGroup}
/>
      <div className="content">
        <header>
          <h1>{inTrash ? 'Trash' : 'All collected videos'}</h1>

          <div className="controls">
            {/* View toggle */}
            <div className="view-toggle" role="group" aria-label="View mode">
              <button
                type="button"
                className="icon-btn"
                aria-pressed={isList}
                title="List view"
                onClick={() => setLayout('list')}
              >
                <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 7h16v2H4zM4 11h16v2H4zM4 15h16v2H4z"></path>
                </svg>
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-pressed={isGrid}
                title="Grid view"
                onClick={() => setLayout('grid')}
              >
                <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="5" y="5" width="14" height="14" rx="2" ry="2"></rect>
                </svg>
              </button>
            </div>

            {/* Trash toggle */}
            <button
              type="button"
              className="icon-btn"
              aria-pressed={inTrash}
              title={inTrash ? 'Show videos' : 'Show trash'}
              onClick={() => setView(inTrash ? 'videos' : 'trash')}
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
                title="Select page (visible)"
                onClick={() => selectAllVisible(inChannels ? channelsPageItems.map(ch => ch.id) : pageItems.map(v => v.id))}
              >
                Select page
              </button>

              <button
                type="button"
                className="btn-ghost"
                title="Select all (matching filter)"
                onClick={() => selectAllMatching(inChannels ? channelsFiltered.map(ch => ch.id) : filtered.map(v => v.id))}
              >
                Select all (matching)
              </button>

              <button
                type="button"
                className="btn-ghost"
                title="Clear selection"
                onClick={clearSelection}
                disabled={selectedCount === 0}
              >
                Clear
              </button>

              <span className="sel-info">{selectedCount} selected</span>
            </div>

            {/* Delete */}
            <button
              type="button"
              className="btn-danger"
              title={inTrash ? 'Delete is disabled in Trash view' : 'Delete selected (moves to Trash)'}
              onClick={!inTrash ? deleteSelected : undefined}
              disabled={inTrash || selectedCount === 0}
            >
              Delete
            </button>
            <button
              type="button"
              className="btn-ghost"
              title="Tag selected…"
              onClick={() => setShowTagger(v => !v)}
              disabled={selectedCount === 0}
            >
              Tags…
            </button>
            {/* Search & refresh */}
            <input
              id="q"
              type="search"
              placeholder="Filter by title or channel…"
              value={q}
              onChange={e => setQ(e.target.value)}
            />
            <button id="refresh" onClick={refresh} disabled={loading}>
              {loading ? 'Loading…' : 'Refresh'}
            </button>
            <button
              type="button"
              className="btn-ghost"
              aria-pressed={inChannels}
              title={inChannels ? 'Show videos' : 'Show channels directory'}
              onClick={() => setView(inChannels ? 'videos' : 'channels')}
            >
              Channels
            </button>
            <button
              type="button"
              className="btn-ghost"
              title="Fetch metadata for all videos via YouTube API"
              onClick={refreshData}
              disabled={refreshing}
            >
              {refreshing ? 'Refreshing…' : 'Refresh data'}
            </button>
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
            {!refreshing && (
              <span className="muted" aria-live="polite" title="Last refresh time">{fmtTime(lastRefreshAt)}</span>
            )}
            {refreshLastError && (
              <span className="muted" style={{ color: 'salmon' }} title="Last error">{String(refreshLastError).slice(0, 140)}</span>
            )}
            <button
              type="button"
              className="btn-ghost"
              title="Remove duplicate source entries across all videos"
              onClick={() => sendBg('videos/wipeSources', {}).then(() => refresh())}
              disabled={loading}
            >
              Wipe sources
            </button>
          </div>
        </header>
        {showTagger && selectedCount > 0 && (
          <div className="tagger" style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ marginRight: 8 }}>Apply tag:</span>
            {availableTags.map((tag: string) => {
              const haveAll = inChannels
                ? (channels.reduce((n, c) => (selected.has(c.id) && Array.isArray(c.tags) && c.tags.includes(tag)) ? n + 1 : n, 0) === selectedCount && selectedCount > 0)
                : ((tagCounts.get(tag) || 0) === selectedCount && selectedCount > 0);
              return (
                <button
                  key={tag}
                  type="button"
                  className="btn-ghost"
                  onClick={() => applyTagToSelection(tag)}
                  style={{ background: haveAll ? '#203040' : undefined }}
                  title={haveAll ? 'Remove from all selected' : 'Add to all selected'}
                >
                  {tag}
                </button>
              );
            })}
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
    {(inChannels ? channelSorts : videoSorts).map((s, i) => (
      <span key={i} className="badge" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        <select className="chip-input" value={s.field} onChange={(e)=> (inChannels ? setChannelSorts : setVideoSorts)(arr => arr.map((x,idx)=> idx===i ? { ...x, field: e.target.value } : x))}>
          {inChannels ? (
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
        <select className="chip-input" value={s.dir} onChange={(e)=> (inChannels ? setChannelSorts : setVideoSorts)(arr => arr.map((x,idx)=> idx===i ? { ...x, dir: e.target.value as 'asc'|'desc' } : x))}>
          <option value="asc">asc</option>
          <option value="desc">desc</option>
        </select>
        <button className="chip-remove" onClick={()=> (inChannels ? setChannelSorts : setVideoSorts)(arr => arr.filter((_,idx)=> idx!==i))} title="Remove">A-</button>
      </span>
    ))}
    <select className="add-filter" value="" onChange={(e)=>{ const v=e.target.value as string; if(!v) return; (inChannels ? setChannelSorts : setVideoSorts)(arr => [...arr, { field: v, dir: 'desc' }]); (e.target as HTMLSelectElement).value=''; }}>
      <option value="">+ Add sort...</option>
      {inChannels ? (
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
      ← Prev
    </button>
    <span className="page-info">Page {page} / {totalPages}</span>
    <button
      type="button"
      className="btn-ghost"
      onClick={() => setPage(p => Math.min(totalPages, p + 1))}
      disabled={page >= totalPages}
      title="Next page"
    >
      Next →
    </button>
  </div>

  <div className="total-info">{total} total</div>
</div>

{/* The list itself */}
{inChannels ? (
  <div style={{ padding: 16 }}>
    {channelsPageItems.map(ch => (
      <>
      <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 8 }}>
        <label className="select">
          <input type="checkbox" checked={selected.has(ch.id)} onChange={() => toggleSelect(ch.id)} aria-label="Select channel" />
        </label>
        <img
          src={ch.thumbUrl || ''}
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
            <span className="badge">{(ch as any).tags.join(', ')}</span>
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
  />
)}

{/* Undo toast (if you still want it visible here) */}
{showUndo && lastDeleted && (
  <div className="toast">
    Deleted {lastDeleted.length} {lastDeleted.length === 1 ? 'item' : 'items'}
    <button className="btn-link" onClick={undoDelete}>Undo</button>
  </div>
)}
      </div>{/* .content */}
    </div>
  );
}

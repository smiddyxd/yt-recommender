import { useEffect, useMemo, useState } from 'react';
import { dlog, derr } from '../../types/debug';
import { matches, type Condition, type Group as GroupRec } from '../../shared/conditions';
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
    tags: Array.isArray(r.tags) ? r.tags : []
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
  const [view, setView] = useState<'videos' | 'trash'>('videos');
  const inTrash = view === 'trash';
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
  useEffect(() => {
    // initial load also pulls groups
    refresh();
    loadGroups();
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

  async function refresh() {
    try {
      dlog('UI refresh start');
      setLoading(true);
      setError(null);
      const rows = await getAll(view);
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
    refresh(); // reload from the correct store
    loadTags();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

useEffect(() => {
  function onMsg(msg: any) {
    if (msg?.type === 'db/change') {
      const ent = msg.payload?.entity;
      if (ent === 'videos' || ent == null) refresh();
      if (ent === 'tags')   loadTags();
      if (ent === 'groups') loadGroups();
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
  const availableTags = useMemo(() => tags.map(t => t.name), [tags]);

  function toggleTag(tag: string) {
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
      resolveGroup: (id) => groups.find(g => g.id === id)
    }));
  }

  const needle = q.trim().toLowerCase();
  if (!needle) return base;
  return base.filter(v =>
    (v.title || '').toLowerCase().includes(needle) ||
    (v.channelName || v.channelId || '').toLowerCase().includes(needle)
  );
}, [videos, chain, q, groups]);



  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // keep page in range when filter or page size changes
  useEffect(() => {
    setPage(1);
  }, [q, pageSize]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const start = (page - 1) * pageSize;
  const pageItems = filtered.slice(start, start + pageSize);

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

  function fmtTime(ts?: number | null): string {
    if (!ts) return '';
    try {
      const d = new Date(ts);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch { return ''; }
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
                onClick={() => selectAllVisible(pageItems.map(v => v.id))}
              >
                Select page
              </button>

              <button
                type="button"
                className="btn-ghost"
                title="Select all (matching filter)"
                onClick={() => selectAllMatching(filtered.map(v => v.id))}
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
              title="Fetch metadata for all videos via YouTube API"
              onClick={refreshData}
              disabled={refreshing}
            >
              {refreshing ? 'Refreshing…' : 'Refresh data'}
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
           <FiltersBar
  chain={chain}
  setChain={setChain}
  channelOptions={channelOptions}
  groups={groups}
  groupName={groupName}
  setGroupName={setGroupName}
  editingGroupId={editingGroupId}
  onSaveAsGroup={saveAsGroup}
  onSaveChanges={saveChangesToGroup}
  onCancelEdit={cancelEditing}
/> 
{/* Pagination / page size toolbar */}
<div className="toolbar-2">
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
<VideoList
  items={pageItems}
  layout={layout}
  loading={loading}
  selected={selected}
  onToggle={toggleSelect}
/>

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

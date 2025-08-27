import { useEffect, useMemo, useState } from 'react';
import { dlog, derr } from '../../types/debug';
import { matches, type Condition, type Group as GroupRec } from '../../shared/conditions';
import FiltersBar, { type FilterEntry } from './components/FiltersBar';
import Sidebar from './components/Sidebar';
import VideoList from './components/VideoList';

// ---- Types ----
type Video = {
  id: string;
  title?: string | null;
  channelId?: string | null;
  channelName?: string | null;
  durationSec?: number | null;
  lastSeenAt?: number;
  deletedAt?: number; // ← add this, undefined for non-trash rows
  flags?: { started?: boolean; completed?: boolean };
  tags?: string[];
};

type TagRec = { name: string; color?: string; createdAt?: number };
async function send<T = any>(type: string, payload: any): Promise<T | void> {
  return new Promise((resolve) => {
    dlog('UI send →', type, payload && Object.keys(payload));
    chrome.runtime.sendMessage({ type, payload }, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) {
        derr('UI send error:', err.message);
        return resolve();
      }
      dlog('UI recv ←', type, resp);
      resolve(resp);
    });
  });
}

// ---- IndexedDB helpers (read-only here) ----
const DB_NAME = 'yt-recommender';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME); // no version arg
    req.onsuccess = () => {
      const db = req.result;
      dlog('UI IDB open ok, version=', (db as any).version);
      resolve(db);
    };
    req.onerror = () => {
      derr('UI IDB open error:', req.error);
      reject(req.error);
    };
  });
}
async function getAll(store: 'videos' | 'trash'): Promise<Video[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const os = tx.objectStore(store);
    const req = os.getAll();
    req.onsuccess = () => {
const rows: Video[] = (req.result || []) as any[];
      dlog(`UI getAll(${store}) count=`, rows.length);
      // Sort newest first by appropriate timestamp
      rows.sort((a, b) => {
        const ka = store === 'trash' ? (a.deletedAt || 0) : (a.lastSeenAt || 0);
        const kb = store === 'trash' ? (b.deletedAt || 0) : (b.lastSeenAt || 0);
        return kb - ka;
      });
      resolve(rows);
    };
    req.onerror = () => { derr(`UI getAll(${store}) error:`, req.error); reject(req.error); };
  });
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


  function resetGroupEditUI() {
  setEditingGroupId(null);
  setGroupName('');
}

function saveAsGroup() {
  const cond = chainToCondition();
  if (!cond) return;
  send('groups/create', { name: groupName.trim(), condition: cond }).then(() => {
    loadGroups();
    resetGroupEditUI();
  });
}

function saveChangesToGroup() {
  const cond = chainToCondition();
  if (!cond || !editingGroupId) return;
  send('groups/update', { id: editingGroupId, patch: { name: groupName.trim(), condition: cond } }).then(() => {
    loadGroups();
    resetGroupEditUI();
  });
}

function cancelEditing() {
  resetGroupEditUI();
}


function hmsToSec(h: number, m: number, s: number) {
  const clamp = (n: number) => Math.max(0, Number.isFinite(n) ? Math.floor(n) : 0);
  return clamp(h) * 3600 + clamp(m) * 60 + clamp(s);
}

function entryToPred(e: FilterEntry): Condition | null {
  const f = e.pred;
  if (f.kind === 'duration') {
    const min = hmsToSec(f.ui.minH, f.ui.minM, f.ui.minS);
    const max = hmsToSec(f.ui.maxH, f.ui.maxM, f.ui.maxS);
    if (min === 0 && max === 0) return null;
    const node: Condition = { kind: 'durationRange', ...(min?{minSec:min}:{}) , ...(max?{maxSec:max}:{}) } as any;
    return e.not ? ({ not: node } as any) : node;
  }
  if (f.kind === 'channel') {
    if (f.ids.length === 0) return null;
    const node: Condition = { kind: 'channelIdIn', ids: f.ids.slice() } as any;
    return e.not ? ({ not: node } as any) : node;
  }
  if (f.kind === 'title') {
    const pattern = (f.pattern || '').trim();
    if (!pattern) return null;
    const node: Condition = { kind: 'titleRegex', pattern, flags: (f.flags||'').trim() } as any;
    return e.not ? ({ not: node } as any) : node;
  }
  if (f.kind === 'group') {
    if (f.ids.length === 0) return null;
    const node: Condition = { kind: 'groupRef', ids: f.ids.slice() } as any;
    return e.not ? ({ not: node } as any) : node;
  }
  return null;
}

function chainToCondition(): Condition | null {
const items: Array<{ op?: FilterEntry['op']; node: Condition }> = [];
  for (let i = 0; i < chain.length; i++) {
    const node = entryToPred(chain[i]);
    if (node) items.push({ op: chain[i].op, node });
  }
  if (items.length === 0) return null;

  // Split by OR (AND has higher precedence)
  const segments: Condition[][] = [];
  let cur: Condition[] = [];
  for (let i = 0; i < items.length; i++) {
    const { op, node } = items[i];
    if (i > 0 && op === 'OR') {
      segments.push(cur);
      cur = [];
    }
    cur.push(node);
  }
  segments.push(cur);

  const collapsed = segments.map(seg => seg.length === 1 ? seg[0] : ({ all: seg } as Condition));
  return collapsed.length === 1 ? collapsed[0] : ({ any: collapsed } as Condition);
}

  async function loadGroups() {
    const resp: any = await send('groups/list', {});
    setGroups(resp?.items || []);
  }
  useEffect(() => {
    // initial load also pulls groups
    refresh();
    loadGroups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);



async function removeGroup(id: string) {
  await send('groups/delete', { id });
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
function conditionToChainSimple(cond: any): FilterEntry[] | null {
  const toEntry = (c: any): FilterEntry | null => {
    let not = false;
    let leaf = c;
    if (leaf && 'not' in leaf) {
      not = true;
      leaf = leaf.not;
    }
    if (!leaf || typeof leaf !== 'object') return null;

    if (leaf.kind === 'durationRange') {
      const min = leaf.minSec|0, max = leaf.maxSec|0;
      return {
        op: undefined,
        not,
        pred: {
          kind:'duration',
          ui: {
            minH: Math.floor((min||0)/3600), minM: Math.floor(((min||0)%3600)/60), minS: (min||0)%60,
            maxH: Math.floor((max||0)/3600), maxM: Math.floor(((max||0)%3600)/60), maxS: (max||0)%60,
          }
        }
      };
    }
    if (leaf.kind === 'channelIdIn') {
      return { op: undefined, not, pred: { kind:'channel', ids: leaf.ids||[], q: '' } };
    }
    if (leaf.kind === 'titleRegex') {
      return { op: undefined, not, pred: { kind:'title', pattern: leaf.pattern||'', flags: leaf.flags||'' } };
    }
    if (leaf.kind === 'groupRef') {
      return { op: undefined, not, pred: { kind:'group', ids: leaf.ids||[] } };
    }
    return null; // other predicates not yet mapped back
  };

  if (cond.kind) {
    const e = toEntry(cond);
    return e ? [e] : null;
  }

  if ('all' in cond || 'any' in cond) {
    const list: any[] = cond.all || cond.any || [];
    const isAny = 'any' in cond;
    const out: FilterEntry[] = [];
    for (let i = 0; i < list.length; i++) {
      const e = toEntry(list[i]);
      if (!e) return null;
      out.push({ ...e, op: i === 0 ? undefined : (isAny ? 'OR' : 'AND') });
    }
    return out;
  }

  // NOT on a group is not supported in the linear editor yet
  if ('not' in cond) return null;

  return null;
}

  function addTag() {
    const name = newSidebarTag.trim();
    if (!name) return;
    send('tags/create', { name }).then(() => {
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
    send('tags/rename', { oldName: from, newName: to }).then(() => {
      cancelRename();
      loadTags();
      refresh(); // videos/trash updated
    });
  }

  function removeTag(name: string) {
    send('tags/delete', { name, cascade: true }).then(() => {
      loadTags();
      refresh(); // remove tag from videos/trash too
    });
  }

  async function loadTags() {
    const resp: any = await send('tags/list', {});
    if (resp && resp.items) setTags(resp.items as TagRec[]);
    else setTags([]);
  }

  async function deleteSelected() {
    const ids = Array.from(selected);
    if (!ids.length) return;
    await send('videos/delete', { ids });

    setLastDeleted(ids);
    setShowUndo(true);
    clearSelection();
    await refresh();

    // auto-hide toast after a bit (optional)
    setTimeout(() => setShowUndo(false), 6000);
  }


  async function undoDelete() {
    if (!lastDeleted?.length) return;
    await send('videos/restore', { ids: lastDeleted });

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
    }
  }
  chrome.runtime.onMessage.addListener(onMsg);
  return () => chrome.runtime.onMessage.removeListener(onMsg);
}, []);


const channelOptions = useMemo(() => {
  const map = new Map<string, string>();
  for (const v of videos) {
    if (v.channelId) {
      if (!map.has(v.channelId)) map.set(v.channelId, v.channelName || v.channelId);
    }
  }
  return Array.from(map, ([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
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
    send('videos/applyTags', {
      ids: Array.from(selected),
      addIds: allHave ? [] : [tag],
      removeIds: allHave ? [tag] : []
    }).then(() => refresh());
  }

const filtered = useMemo(() => {
  let base = videos;

  const cond = chainToCondition();
  if (cond) {
    base = base.filter(v => matches(v as any, cond, {
      resolveGroup: (id) => groups.find(g => g.id === id)
    }));
  }

  const needle = q.trim().toLowerCase();
  if (!needle) return base;
  return base.filter(v =>
    (v.title || '').toLowerCase().includes(needle) ||
    (v.channelName || '').toLowerCase().includes(needle)
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
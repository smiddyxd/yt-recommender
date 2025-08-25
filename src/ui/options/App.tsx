import { useEffect, useMemo, useState } from 'react';
import { dlog, derr } from '../../types/debug';
import { matches, type Condition, type Group as GroupRec } from '../../shared/conditions';
// ---- Types ----
type Video = {
  id: string;
  title?: string | null;
  channelId?: string | null;        // ← add this
  channelName?: string | null;
  durationSec?: number | null;
  lastSeenAt?: number;
  flags?: { started?: boolean; completed?: boolean };
  tags?: string[];
};
type VideoRow = Video & { deletedAt?: number };
type TagRec = { name: string; color?: string; createdAt?: number };
type DurationUI = { minH: number; minM: number; minS: number; maxH: number; maxM: number; maxS: number };
type FilterNode =
  | { kind: 'duration'; ui: DurationUI }
  | { kind: 'channel'; ids: string[]; q: string }
  | { kind: 'title'; pattern: string; flags: string }
  | { kind: 'group'; ids: string[] };

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

async function getAll(store: 'videos' | 'trash'): Promise<VideoRow[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const os = tx.objectStore(store);
    const req = os.getAll();
    req.onsuccess = () => {
      const rows: VideoRow[] = (req.result || []) as any[];
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

// ---- UI helpers ----
function secToClock(n?: number | null): string {
  if (!n || !Number.isFinite(n)) return '–:–';
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = Math.floor(n % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}
function fmtDate(ts?: number) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleString();
}
function thumbUrl(id: string) {
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}
function watchUrl(id: string) {
  return `https://www.youtube.com/watch?v=${id}`;
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
  const [groupJson, setGroupJson] = useState('{\n  "all": []\n}');
  const [groupErr, setGroupErr] = useState<string | null>(null);

  const [filters, setFilters] = useState<FilterNode[]>([]);

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

  function startEditGroup(g: GroupRec) {
    setEditingGroupId(g.id);
    setGroupName(g.name);
    setGroupJson(JSON.stringify(g.condition, null, 2));
    setGroupErr(null);
  }

  function resetGroupForm() {
    setEditingGroupId(null);
    setGroupName('');
    setGroupJson('{\n  "all": []\n}');
    setGroupErr(null);
  }

  async function saveGroup() {
    setGroupErr(null);
    let condition: Condition;
    try {
      condition = JSON.parse(groupJson);
    } catch {
      setGroupErr('Invalid JSON: fix the condition before saving.');
      return;
    }

    if (editingGroupId) {
      // update existing
      await send('groups/update', { id: editingGroupId, patch: { name: groupName.trim() || '(untitled)', condition } });
    } else {
      // create new
      await send('groups/create', { name: groupName.trim() || '(untitled)', condition });
    }
    await loadGroups();
    resetGroupForm();
  }

  async function removeGroup(id: string) {
    await send('groups/delete', { id });
    // if we were editing this one, reset the form
    if (editingGroupId === id) resetGroupForm();
    await loadGroups();
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

function addFilter(kind: FilterNode['kind']) {
  setFilters(f => {
    if (kind === 'duration') {
      return [...f, { kind: 'duration', ui: { minH:0, minM:0, minS:0, maxH:0, maxM:0, maxS:0 } }];
    }
    if (kind === 'channel') {
      return [...f, { kind: 'channel', ids: [], q: '' }];
    }
    if (kind === 'title') {
      return [...f, { kind: 'title', pattern: '', flags: 'i' }];
    }
    if (kind === 'group') {
      return [...f, { kind: 'group', ids: [] }];
    }
    return f;
  });
}
function removeFilter(idx: number) {
  setFilters(f => f.filter((_, i) => i !== idx));
}

function hmsToSec(h: number, m: number, s: number) {
  const clamp = (n: number) => Math.max(0, Number.isFinite(n) ? Math.floor(n) : 0);
  return clamp(h) * 3600 + clamp(m) * 60 + clamp(s);
}

function filtersToCondition(): Condition | null {
  const preds: any[] = [];

  for (const f of filters) {
    if (f.kind === 'duration') {
      const min = hmsToSec(f.ui.minH, f.ui.minM, f.ui.minS);
      const max = hmsToSec(f.ui.maxH, f.ui.maxM, f.ui.maxS);
      const useMin = min > 0;
      const useMax = max > 0;
      if (useMin || useMax) {
        preds.push({
          kind: 'durationRange',
          ...(useMin ? { minSec: min } : {}),
          ...(useMax ? { maxSec: max } : {}),
        });
      }
    } else if (f.kind === 'channel') {
      if (f.ids.length > 0) {
        preds.push({ kind: 'channelIdIn', ids: f.ids.slice() });
      }
    } else if (f.kind === 'title') {
      const pattern = (f.pattern || '').trim();
      const flags = (f.flags || '').trim();
      if (pattern) preds.push({ kind: 'titleRegex', pattern, flags });
    } else if (f.kind === 'group') {
      if (f.ids.length > 0) preds.push({ kind: 'groupRef', ids: f.ids.slice() });
    }
  }

  if (preds.length === 0) return null;
  return { all: preds };
}

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
  // Step 1: apply structured filters (if any)
  const cond = filtersToCondition();
  let base = videos;
  if (cond) {
    base = base.filter(v => matches(v as any, cond, {
      resolveGroup: (id) => groupsById.get(id)
    }));
  }

  // Step 2: apply simple text search
  const needle = q.trim().toLowerCase();
  if (!needle) return base;
  return base.filter(v =>
    (v.title || '').toLowerCase().includes(needle) ||
    (v.channelName || '').toLowerCase().includes(needle)
  );
}, [videos, filters, q, groupsById]);



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
      <aside className="sidebar">
        <div className="side-section">
          <div className="side-title">Tags</div>

          {/* Create new tag */}
          <div className="side-row">
            <input
              className="side-input"
              type="text"
              placeholder="New tag…"
              value={newSidebarTag}
              onChange={(e) => setNewSidebarTag(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addTag(); }}
            />
            <button className="btn-ghost" onClick={addTag} disabled={!newSidebarTag.trim()}>
              Add
            </button>
          </div>

          {/* List of tags with rename/delete */}
          <div className="tag-list">
            {tags.length === 0 && <div className="muted">No tags yet.</div>}
            {tags.map(t => (
              <div className="tag-row" key={t.name}>
                {tagEditing === t.name ? (
                  <>
                    <input
                      className="side-input"
                      type="text"
                      value={tagEditValue}
                      onChange={(e) => setTagEditValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename();
                        if (e.key === 'Escape') cancelRename();
                      }}
                      autoFocus
                    />
                    <button className="btn-ghost" onClick={commitRename} disabled={!tagEditValue.trim()}>Save</button>
                    <button className="btn-ghost" onClick={cancelRename}>Cancel</button>
                  </>
                ) : (
                  <>
                    <span className="tag-name">{t.name}</span>
                    <button className="btn-ghost" onClick={() => startRename(t.name)}>Rename</button>
                    <button className="btn-ghost" onClick={() => removeTag(t.name)}>Delete</button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
        <div className="side-section">
          <div className="side-title">Groups</div>

          {/* Group form (create or edit) */}
          <div className="group-form">
            <input
              className="side-input"
              type="text"
              placeholder="Group name…"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
            />
            <textarea
              className="side-textarea"
              value={groupJson}
              onChange={(e) => setGroupJson(e.target.value)}
              spellCheck={false}
              rows={6}
              placeholder='Condition JSON, e.g. { "all": [ { "kind":"tagsAny","tags":["work"] } ] }'
            />
            {groupErr && <div className="err">{groupErr}</div>}

            <div className="group-form-actions">
              <button className="btn-ghost" onClick={saveGroup}>
                {editingGroupId ? 'Save' : 'Add Group'}
              </button>
              {editingGroupId && (
                <button className="btn-ghost" onClick={resetGroupForm}>
                  Cancel
                </button>
              )}
            </div>
          </div>

          {/* Group list (click to load into form) */}
          <div className="group-list">
            {groups.length === 0 && <div className="muted">No groups yet.</div>}
            {groups.map((g) => (
              <div className="group-row" key={g.id}>
                <button
                  className="side-btn"
                  onClick={() => startEditGroup(g)}
                  title="Edit group"
                >
                  {g.name}
                </button>
                <button className="btn-ghost" onClick={() => removeGroup(g.id)} title="Delete group">
                  Delete
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="side-section">
          <div className="side-title">Coming up</div>
          <ul className="side-list">
            <li>Tags</li>
            <li>Rules</li>
            <li>Groups</li>
          </ul>
        </div>
      </aside>

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
            {/* Filters panel (top bar) */}
<div className="filters">
  {filters.map((f, idx) => {
    if (f.kind === 'duration') {
      const ui = f.ui;
      const set = (k: keyof DurationUI, val: number) =>
        setFilters(arr =>
          arr.map((x, i) =>
            (i === idx && x.kind === 'duration')
              ? { ...x, ui: { ...x.ui, [k]: Math.max(0, Number(val) || 0) } }
              : x
          )
        );
      return (
        <div className="filter-chip" key={idx}>
          <div className="chip-head">Duration</div>
          <div className="duration-rows">
            <div className="duration-row">
              <span>Min</span>
              <input type="number" min={0} value={ui.minH} onChange={e => set('minH', +e.target.value)} aria-label="Min hours"/>
              <span>h</span>
              <input type="number" min={0} value={ui.minM} onChange={e => set('minM', +e.target.value)} aria-label="Min minutes"/>
              <span>m</span>
              <input type="number" min={0} value={ui.minS} onChange={e => set('minS', +e.target.value)} aria-label="Min seconds"/>
              <span>s</span>
            </div>
            <div className="duration-row">
              <span>Max</span>
              <input type="number" min={0} value={ui.maxH} onChange={e => set('maxH', +e.target.value)} aria-label="Max hours"/>
              <span>h</span>
              <input type="number" min={0} value={ui.maxM} onChange={e => set('maxM', +e.target.value)} aria-label="Max minutes"/>
              <span>m</span>
              <input type="number" min={0} value={ui.maxS} onChange={e => set('maxS', +e.target.value)} aria-label="Max seconds"/>
              <span>s</span>
            </div>
          </div>
          <button className="chip-remove" onClick={() => removeFilter(idx)} title="Remove">×</button>
        </div>
      );
    }

    if (f.kind === 'channel') {
      const options = channelOptions.filter(c =>
        !f.q ? true : c.name.toLowerCase().includes(f.q.toLowerCase()));
      const toggle = (id: string) =>
        setFilters(arr =>
          arr.map((x, i) => {
            if (i !== idx || x.kind !== 'channel') return x;
            const ids = x.ids.includes(id) ? x.ids.filter(y => y !== id) : [...x.ids, id];
            return { ...x, ids };
          })
        );
      return (
        <div className="filter-chip" key={idx}>
          <div className="chip-head">Channel</div>
          <input
            className="chip-input"
            type="search"
            placeholder="Search channels…"
            value={f.q}
            onChange={e =>
              setFilters(arr =>
                arr.map((x,i) =>
                  i === idx && x.kind === 'channel' ? { ...x, q: e.target.value } : x
                )
              )
            }
          />
          <div className="chip-list">
            {options.slice(0, 30).map(opt => (
              <label key={opt.id} className="chip-check">
                <input
                  type="checkbox"
                  checked={f.ids.includes(opt.id)}
                  onChange={() => toggle(opt.id)}
                />
                <span>{opt.name}</span>
              </label>
            ))}
            {options.length > 30 && <div className="muted">…{options.length - 30} more, refine search</div>}
          </div>
          <button className="chip-remove" onClick={() => removeFilter(idx)} title="Remove">×</button>
        </div>
      );
    }

    if (f.kind === 'title') {
      return (
        <div className="filter-chip" key={idx}>
          <div className="chip-head">Title (regex)</div>
          <div className="row">
            <input
              className="chip-input"
              type="text"
              placeholder="pattern e.g. (quick|tip)"
              value={f.pattern}
              onChange={e =>
                setFilters(arr =>
                  arr.map((x,i) =>
                    i === idx && x.kind === 'title' ? { ...x, pattern: e.target.value } : x
                  )
                )
              }
            />
            <input
              className="chip-input flags"
              type="text"
              placeholder="flags (e.g. i)"
              value={f.flags}
              onChange={e =>
                setFilters(arr =>
                  arr.map((x,i) =>
                    i === idx && x.kind === 'title' ? { ...x, flags: e.target.value } : x
                  )
                )
              }
              maxLength={6}
            />
          </div>
          <button className="chip-remove" onClick={() => removeFilter(idx)} title="Remove">×</button>
        </div>
      );
    }

    if (f.kind === 'group') {
      const toggle = (id: string) =>
        setFilters(arr =>
          arr.map((x, i) => {
            if (i !== idx || x.kind !== 'group') return x;     // ✅ correct kind
            const ids = x.ids.includes(id) ? x.ids.filter(y => y !== id) : [...x.ids, id];
            return { ...x, ids };
          })
        );
      return (
        <div className="filter-chip" key={idx}>
          <div className="chip-head">Group</div>
          <div className="chip-list">
            {groups.map(g => (
              <label key={g.id} className="chip-check">
                <input
                  type="checkbox"
                  checked={f.ids.includes(g.id)}
                  onChange={() => toggle(g.id)}
                />
                <span>{g.name}</span>
              </label>
            ))}
            {groups.length === 0 && <div className="muted">No groups yet</div>}
          </div>
          <button className="chip-remove" onClick={() => removeFilter(idx)} title="Remove">×</button>
        </div>
      );
    }

    return null;
  })}

  {/* Add filter selector */}
  <select
    className="add-filter"
    value=""
    onChange={(e) => {
      const k = e.target.value as FilterNode['kind'] | '';
      if (k) addFilter(k);
      (e.target as HTMLSelectElement).value = '';
    }}
  >
    <option value="">+ Add filter…</option>
    <option value="duration">Duration range</option>
    <option value="channel">Channel</option>
    <option value="title">Title (regex)</option>
    <option value="group">Group</option>
  </select>

  {/* Optional: clear all */}
  {filters.length > 0 && (
    <button className="btn-ghost" onClick={() => setFilters([])} title="Clear all filters">Clear</button>
  )}
</div>

        {showTagger && (
          <div className="popover" role="dialog" aria-label="Tag items">
            <div className="popover-row">
              <div style={{ color: 'var(--muted)', fontSize: 12 }}>
                {selectedCount} selected
              </div>
              <button className="btn-ghost" onClick={() => setShowTagger(false)} style={{ marginLeft: 'auto' }}>
                Close
              </button>
            </div>

            <div className="tag-grid">
              {availableTags.length === 0 && <div className="muted">No tags yet. Create tags in the sidebar.</div>}
              {availableTags.map(tag => {
                const count = tagCounts.get(tag) || 0;
                const allHave = count === selectedCount && selectedCount > 0;
                const someHave = count > 0 && count < selectedCount;

                return (
                  <label key={tag} className={`tag-toggle${allHave ? ' on' : ''}${someHave ? ' mixed' : ''}`}>
                    <input
                      type="checkbox"
                      checked={allHave}
                      ref={(el) => { if (el) el.indeterminate = someHave; }}
                      onChange={() => {
                        const all = allHave;
                        send('videos/applyTags', {
                          ids: Array.from(selected),
                          addIds: all ? [] : [tag],
                          removeIds: all ? [tag] : []
                        }).then(() => refresh());
                      }}
                    />
                    <span className="name">{tag}</span>
                    {selectedCount > 0 && <span className="count">{count}/{selectedCount}</span>}
                  </label>
                );
              })}
            </div>
          </div>
        )}
        {/* Pagination toolbar */}
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
            <span className="page-info">
              Page {page} / {totalPages}
            </span>
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

          <div className="total-info">
            {total} total
          </div>
        </div>

        {/* Error + Undo toast */}
        {error && (
          <div style={{ color: '#ff8080', padding: 12 }}>
            Error loading videos: {error}
          </div>
        )}
        {showUndo && lastDeleted && (
          <div className="toast">
            Deleted {lastDeleted.length} {lastDeleted.length === 1 ? 'item' : 'items'}
            <button className="btn-link" onClick={undoDelete}>Undo</button>
          </div>
        )}

        {/* List/Grid */}
        <main id="list" aria-live="polite" data-layout={layout}>
          {pageItems.map(v => {
            const isSelected = selected.has(v.id);
            return (
              <article className={`card${isSelected ? ' selected' : ''}`} key={v.id}>
                <label className="select">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelect(v.id)}
                    aria-label="Select video"
                  />
                </label>

                <img
                  className="thumb toggle-select"
                  loading="lazy"
                  src={thumbUrl(v.id)}
                  alt={v.title || 'thumbnail'}
                  draggable={false}
                  onClick={() => toggleSelect(v.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggleSelect(v.id);
                    }
                  }}
                  tabIndex={0}
                />

                <div>
                  <h3 className="title">
                    <a href={watchUrl(v.id)} target="_blank" rel="noopener noreferrer">
                      {v.title || '(no title)'}
                    </a>
                  </h3>

                  <div className="meta">
                    {[
                      v.channelName || '(unknown channel)',
                      secToClock(v.durationSec),
                      fmtDate(inTrash ? (v as any).deletedAt : v.lastSeenAt),
                    ]
                      .filter(Boolean)
                      .join(' • ')}
                  </div>

                  <div className="badges">
                    {v.flags?.started && <span className="badge">started</span>}
                    {v.flags?.completed && <span className="badge">completed</span>}
                    {v.tags && v.tags.length > 0 && <span className="badge">{v.tags.join(', ')}</span>}
                    {inTrash && <span className="badge">trash</span>}
                  </div>
                </div>
              </article>
            );
          })}

          {!loading && filtered.length === 0 && (
            <div style={{ padding: 16, color: 'var(--muted)' }}>
              No videos match your search.
            </div>
          )}
        </main>

        <footer>
          <small id="count">
            {loading ? 'Loading…' : `${filtered.length} ${filtered.length === 1 ? 'video' : 'videos'}`}
          </small>
        </footer>
      </div>{/* .content */}
    </div>  /* .page */
  );
}

function GroupCreator({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('');
  const [json, setJson] = useState<string>('{\n  "all": []\n}');
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setErr(null);
    let condition: Condition;
    try {
      condition = JSON.parse(json);
    } catch (e: any) {
      setErr('Invalid JSON');
      return;
    }
    await new Promise<void>(res => {
      chrome.runtime.sendMessage({ type: 'groups/create', payload: { name: name.trim() || '(untitled)', condition } }, () => res());
    });
    setName('');
    setJson('{\n  "all": []\n}');
    onCreated();
  }

  return (
    <div className="group-creator">
      <input
        className="side-input"
        type="text"
        placeholder="Group name…"
        value={name}
        onChange={e => setName(e.target.value)}
      />
      <textarea
        className="side-textarea"
        value={json}
        onChange={e => setJson(e.target.value)}
        spellCheck={false}
        rows={6}
      />
      {err && <div className="err">{err}</div>}
      <button className="btn-ghost" onClick={save}>Add Group</button>
    </div>
  );
}
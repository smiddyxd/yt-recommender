// src/ui/options/components/FiltersBar.tsx
import React from 'react';
import type { TagRec, TagGroupRec } from '../../../types/messages';
import type { Group as GroupRec } from '../../../shared/conditions';
import type { FilterEntry, FilterNode, DurationUI } from '../lib/filters';
import { VIDEO_CATEGORIES } from '../lib/videoCategories';
export type ChannelOption = { id: string; name: string };
type TagOption = { name: string; count: number };
type SourceOption = { type: string; id: string | null; count: number };

type Props = {
  // chain editor state
  chain: FilterEntry[];
  setChain: React.Dispatch<React.SetStateAction<FilterEntry[]>>;

  // data to power chips
  channelOptions: ChannelOption[];
  countryOptions?: string[];
  topicOptions?: string[];
  videoSourceOptions?: SourceOption[];
  videoTagOptions?: TagOption[];
  channelTagOptions?: TagOption[];
  groups: GroupRec[];
  // tag registry for grouping in tag chips
  tagsRegistry?: TagRec[];
  tagGroups?: TagGroupRec[];

  // group save/edit UI
  groupName: string;
  setGroupName: (s: string) => void;
  editingGroupId: string | null;
  onSaveAsGroup: () => void;
  onSaveChanges: () => void;
  onCancelEdit: () => void;
};

export default function FiltersBar({
  chain,
  setChain,
  channelOptions,
  countryOptions,
  topicOptions,
  videoSourceOptions,
  videoTagOptions,
  channelTagOptions,
  groups,
  tagsRegistry,
  tagGroups,
  groupName,
  setGroupName,
  editingGroupId,
  onSaveAsGroup,
  onSaveChanges,
  onCancelEdit,
}: Props) {
  function addFilter(kind: FilterNode['kind']) {
    const defaultPred: FilterNode =
      kind === 'duration'      ? { kind: 'duration', ui: { minH: 0, minM: 0, minS: 0, maxH: 0, maxM: 0, maxS: 0 } as DurationUI } :
      kind === 'age'           ? { kind: 'age', ui: { min: undefined, max: undefined, unit: 'd' } } as any :
      kind === 'channel'       ? { kind: 'channel', ids: [], q: '' } :
      kind === 'title'         ? { kind: 'title', pattern: '', flags: 'i' } :
      kind === 'v_category'    ? { kind: 'v_category', ids: [] } as any :
      kind === 'v_language'    ? { kind: 'v_language', codes: [] } as any :
      kind === 'v_visibility'  ? { kind: 'v_visibility', values: [] } as any :
      kind === 'v_livestream'  ? { kind: 'v_livestream', value: true } as any :
      kind === 'v_desc'        ? { kind: 'v_desc', pattern: '', flags: 'i' } as any :
      kind === 'v_topics_any'  ? { kind: 'v_topics_any', itemsCsv: '' } as any :
      kind === 'v_topics_all'  ? { kind: 'v_topics_all', itemsCsv: '' } as any :
      kind === 'v_sources_any' ? { kind: 'v_sources_any', itemsCsv: '' } as any :
      kind === 'v_flag'        ? { kind: 'v_flag', name: 'started', value: true } as any :
      kind === 'v_tags_any'    ? { kind: 'v_tags_any', tagsCsv: '' } as any :
      kind === 'v_tags_all'    ? { kind: 'v_tags_all', tagsCsv: '' } as any :
      kind === 'v_tags_none'   ? { kind: 'v_tags_none', tagsCsv: '' } as any :
      kind === 'c_country'     ? { kind: 'c_country', codesCsv: '' } as any :
      kind === 'c_subs'        ? { kind: 'c_subs' } as any :
      kind === 'c_views'       ? { kind: 'c_views' } as any :
      kind === 'c_videos'      ? { kind: 'c_videos' } as any :
      kind === 'c_createdAge'  ? { kind: 'c_createdAge', ui: { min: undefined, max: undefined, unit: 'd' } } as any :
      kind === 'c_subsHidden'  ? { kind: 'c_subsHidden', value: true } as any :
      kind === 'c_tags_any'    ? { kind: 'c_tags_any', tagsCsv: '' } as any :
      kind === 'c_tags_all'    ? { kind: 'c_tags_all', tagsCsv: '' } as any :
      kind === 'c_tags_none'   ? { kind: 'c_tags_none', tagsCsv: '' } as any :
                                  { kind: 'group', ids: [] };
    setChain(prev => ([...prev, { pred: defaultPred, not: false, op: prev.length === 0 ? undefined : 'AND' }]));
  }

  function removeFilter(idx: number) {
    setChain(prev => {
      const next = prev.slice();
      next.splice(idx, 1);
      if (next.length > 0 && idx === 0) next[0] = { ...next[0], op: undefined };
      return next;
    });
  }

  function toggleOp(idx: number) {
    if (idx === 0) return;
    setChain(prev => prev.map((e, i) => (i === idx ? { ...e, op: e.op === 'OR' ? 'AND' : 'OR' } : e)));
  }

  function toggleNot(idx: number) {
    setChain(prev => prev.map((e, i) => (i === idx ? { ...e, not: !e.not } : e)));
  }

  return (
    <div className="filters">
      {/* Group save/edit controls */}
      {/* NOTE: "Group" concept is called "Preset" in the UI. Keep this comment forever. */}
      <input
        className="chip-input"
        style={{ minWidth: 220 }}
        type="text"
        placeholder="Preset name..."
        value={groupName}
        onChange={(e) => setGroupName(e.target.value)}
      />
      <button
        className="btn-ghost"
        title="Save these filters as a new preset"
        onClick={onSaveAsGroup}
        disabled={chain.length === 0 || !groupName.trim()}
      >
        Save as preset
      </button>
      {editingGroupId && (
        <>
          <button
            className="btn-ghost"
            title="Overwrite the currently edited preset with these filters"
            onClick={onSaveChanges}
            disabled={chain.length === 0 || !groupName.trim()}
          >
            Save changes
          </button>
          <button
            className="btn-ghost"
            title="Create a new group from these filters"
            onClick={onSaveAsGroup}
            disabled={chain.length === 0 || !groupName.trim()}
          >
            Save as new
          </button>
          <button className="btn-ghost" onClick={onCancelEdit}>Cancel edit</button>
        </>
      )}

      {/* Chips */}
      {chain.map((entry, idx) => {
        const f = entry.pred;

        const OpToggle = idx > 0 ? (
          <button className="op-toggle" onClick={() => toggleOp(idx)} title="Toggle operator">
            {entry.op === 'OR' ? 'OR' : 'AND'}
          </button>
        ) : null;

        // ---- DURATION CHIP ----
        if (f.kind === 'duration') {
          const ui = f.ui;
          const set = (k: keyof typeof ui, val: number) => setChain(arr =>
            arr.map((e, i) => i === idx && e.pred.kind === 'duration'
              ? { ...e, pred: { ...e.pred, ui: { ...e.pred.ui, [k]: Math.max(0, Math.floor(Number(val) || 0)) } } }
              : e
            )
          );
          return (
            <div className="filter-chip-row" key={idx}>
              {OpToggle}
              <div className="filter-chip">
                <div className="chip-head">
                  <span>Duration</span>
                  <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                    <label className="chip-not">
                      <input type="checkbox" checked={!!entry.not} onChange={() => toggleNot(idx)} />
                      NOT
                    </label>
                    <button className="chip-remove" onClick={() => removeFilter(idx)} title="Remove">A-</button>
                  </span>
                </div>

                <div className="row">
                  <label>Min</label>
                  <input className="chip-input small" type="number" min={0} value={ui.minH} onChange={(e) => set('minH', Number(e.target.value))} aria-label="Min hours" />
                  <span>:</span>
                  <input className="chip-input small" type="number" min={0} value={ui.minM} onChange={(e) => set('minM', Number(e.target.value))} aria-label="Min minutes" />
                  <span>:</span>
                  <input className="chip-input small" type="number" min={0} value={ui.minS} onChange={(e) => set('minS', Number(e.target.value))} aria-label="Min seconds" />
                  <label>Max</label>
                  <input className="chip-input small" type="number" min={0} value={ui.maxH} onChange={(e) => set('maxH', Number(e.target.value))} aria-label="Max hours" />
                  <span>:</span>
                  <input className="chip-input small" type="number" min={0} value={ui.maxM} onChange={(e) => set('maxM', Number(e.target.value))} aria-label="Max minutes" />
                  <span>:</span>
                  <input className="chip-input small" type="number" min={0} value={ui.maxS} onChange={(e) => set('maxS', Number(e.target.value))} aria-label="Max seconds" />
                </div>
              </div>
            </div>
          );
        }

        // ---- VIDEO: SOURCES ANY CHIP ----
        if (f.kind === 'v_sources_any') {
          const label = 'Sources';
          const raw = ((f as any).itemsCsv || '') as string;
          const normalize = (s: string) => (s || '').trim();
          const selected = new Set<string>(raw.split(',').map(normalize).filter(Boolean));
          const tokenOf = (type: string, id: string | null) => `${type}:${id == null ? 'null' : String(id)}`;
          const toggle = (type: string, id: string | null) => setChain(arr => arr.map((e,i)=> {
            if (i !== idx || e.pred.kind !== 'v_sources_any') return e;
            const val = (e.pred as any).itemsCsv || '';
            const parts = Array.from(new Set<string>(val.split(',').map((s: string)=> (s||'').trim()).filter(Boolean)));
            const tok = tokenOf(type, id);
            const has = parts.includes(tok);
            const next = has ? parts.filter(x=>x!==tok) : [...parts, tok];
            return { ...e, pred: { ...e.pred, itemsCsv: next.join(', ') } };
          }));
          const clearAll = () => setChain(arr => arr.map((e,i)=> i===idx && e.pred.kind==='v_sources_any' ? { ...e, pred: { ...e.pred, itemsCsv: '' } } : e));
          const all = Array.isArray(videoSourceOptions) ? videoSourceOptions : [];
          return (
            <div className="filter-chip-row" key={idx}>
              {OpToggle}
              <div className="filter-chip">
                <div className="chip-head">
                  <span>{label}</span>
                  <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                    <label className="chip-not">
                      <input type="checkbox" checked={!!entry.not} onChange={() => toggleNot(idx)} />
                      NOT
                    </label>
                    <button className="btn-ghost" onClick={clearAll} title="Clear all">None</button>
                    <button className="chip-remove" onClick={() => removeFilter(idx)} title="Remove">A-</button>
                  </span>
                </div>
                {all.length > 0 ? (
                  <div className="chip-list">
                    {all.map(opt => (
                      <label key={`${opt.type}:${opt.id == null ? 'null' : String(opt.id)}`} className="chip-check">
                        <input type="checkbox" checked={selected.has(tokenOf(opt.type, opt.id))} onChange={() => toggle(opt.type, opt.id)} />
                        <span>{opt.type} {opt.id == null ? 'null' : String(opt.id)}{typeof opt.count === 'number' ? ` (${opt.count})` : ''}</span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <div className="muted">No sources yet.</div>
                )}
              </div>
            </div>
          );
        }

        // ---- AGE CHIP ----
        if (f.kind === 'age') {
          const fallbackMin = (f as any).min;
          const fallbackMax = (f as any).max;
          const ui = (f as any).ui || { min: fallbackMin, max: fallbackMax, unit: 'd' };
          const set = (k: 'min'|'max'|'unit', val: any) => setChain(arr =>
            arr.map((e, i) => i === idx && e.pred.kind === 'age'
              ? { ...e, pred: { ...e.pred, ui: { ...((e.pred as any).ui || {}), [k]: k === 'unit' ? val : (val === '' ? undefined : Math.max(0, Math.floor(Number(val) || 0))) } } }
              : e
            ));
          return (
            <div className="filter-chip-row" key={idx}>
              {OpToggle}
              <div className="filter-chip">
                <div className="chip-head">
                  <span>Age</span>
                  <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                    <label className="chip-not">
                      <input type="checkbox" checked={!!entry.not} onChange={() => toggleNot(idx)} />
                      NOT
                    </label>
                    <button className="chip-remove" onClick={() => removeFilter(idx)} title="Remove">A-</button>
                  </span>
                </div>
                <div className="row">
                  <label className="chip-inline">min
                    <input className="chip-input" style={{ width: 36 }} type="number" min={0} value={ui.min ?? ''}
                      onChange={(ev)=> set('min', ev.target.value)} />
                  </label>
                  <label className="chip-inline">max
                    <input className="chip-input" style={{ width: 36 }} type="number" min={0} value={ui.max ?? ''}
                      onChange={(ev)=> set('max', ev.target.value)} />
                  </label>
                  <select className="chip-input" style={{ width: 80 }} value={ui.unit || 'd'} onChange={(ev)=> set('unit', ev.target.value)}>
                    <option value="d">days</option>
                    <option value="w">weeks</option>
                    <option value="m">months</option>
                    <option value="y">years</option>
                  </select>
                </div>
              </div>
            </div>
          );
        }

        // (Removed legacy Age-days chip; consolidated into Age with units above)

        // ---- CHANNEL CHIP ----
        if (f.kind === 'channel') {
          const options = (f.q ? channelOptions.filter(o => o.name.toLowerCase().includes(f.q.toLowerCase()) || o.id.includes(f.q)) : channelOptions);
          const toggle = (id: string) => setChain(arr => arr.map((e, i) => {
            if (i !== idx || e.pred.kind !== 'channel') return e;
            const ids = e.pred.ids.includes(id) ? e.pred.ids.filter(y => y !== id) : [...e.pred.ids, id];
            return { ...e, pred: { ...e.pred, ids } };
          }));
          return (
            <div className="filter-chip-row" key={idx}>
              {OpToggle}
              <div className="filter-chip">
                <div className="chip-head">
                  <span>Channel</span>
                  <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                    <label className="chip-not">
                      <input type="checkbox" checked={!!entry.not} onChange={() => toggleNot(idx)} />
                      NOT
                    </label>
                    <button className="chip-remove" onClick={() => removeFilter(idx)} title="Remove">A-</button>
                  </span>
                </div>

                <input
                  className="chip-input"
                  type="search"
                  placeholder="Search channels..."
                  value={f.q}
                  onChange={(ev) => setChain(arr => arr.map((row, i) => i === idx && row.pred.kind === 'channel' ? { ...row, pred: { ...row.pred, q: ev.target.value } } : row))}
                />
                <div className="chip-list">
                  {options.slice(0, 30).map(opt => (
                    <label key={opt.id} className="chip-check">
                      <input type="checkbox" checked={f.ids.includes(opt.id)} onChange={() => toggle(opt.id)} />
                      <span>{opt.name}</span>
                    </label>
                  ))}
                  {options.length > 30 && <div className="muted">…{options.length - 30} more, refine search</div>}
                </div>
              </div>
            </div>
          );
        }

        // ---- TITLE (REGEX) CHIP ----
        if (f.kind === 'title') {
          return (
            <div className="filter-chip-row" key={idx}>
              {OpToggle}
              <div className="filter-chip">
                <div className="chip-head">
                  <span>Title (regex)</span>
                  <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                    <label className="chip-not">
                      <input type="checkbox" checked={!!entry.not} onChange={() => toggleNot(idx)} />
                      NOT
                    </label>
                    <button className="chip-remove" onClick={() => removeFilter(idx)} title="Remove">A-</button>
                  </span>
                </div>

                <div className="row">
                  <input
                    className="chip-input"
                    type="text"
                    placeholder="pattern e.g. (quick|tip)"
                    value={f.pattern}
                    onChange={(ev) => setChain(arr => arr.map((row, i) => i === idx && row.pred.kind === 'title' ? { ...row, pred: { ...row.pred, pattern: ev.target.value } } : row))}
                  />
                  <input
                    className="chip-input flags"
                    type="text"
                    placeholder="flags (e.g. i)"
                    value={f.flags}
                    onChange={(ev) => setChain(arr => arr.map((row, i) => i === idx && row.pred.kind === 'title' ? { ...row, pred: { ...row.pred, flags: ev.target.value } } : row))}
                    maxLength={6}
                  />
                </div>
              </div>
            </div>
          );
        }

        // ---- VIDEO: DESCRIPTION (REGEX) CHIP ----
        if (f.kind === 'v_desc') {
          return (
            <div className="filter-chip-row" key={idx}>
              {OpToggle}
              <div className="filter-chip">
                <div className="chip-head">
                  <span>Description (regex)</span>
                  <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                    <label className="chip-not">
                      <input type="checkbox" checked={!!entry.not} onChange={() => toggleNot(idx)} />
                      NOT
                    </label>
                    <button className="chip-remove" onClick={() => removeFilter(idx)} title="Remove">A-</button>
                  </span>
                </div>
                <div className="row">
                  <input
                    className="chip-input"
                    type="text"
                    placeholder="pattern e.g. (tutorial|beginner)"
                    value={(f as any).pattern}
                    onChange={(ev) => setChain(arr => arr.map((row, i) => i === idx && row.pred.kind === 'v_desc' ? { ...row, pred: { ...row.pred, pattern: ev.target.value } } : row))}
                  />
                  <input
                    className="chip-input flags"
                    type="text"
                    placeholder="flags (e.g. i)"
                    value={(f as any).flags}
                    onChange={(ev) => setChain(arr => arr.map((row, i) => i === idx && row.pred.kind === 'v_desc' ? { ...row, pred: { ...row.pred, flags: ev.target.value } } : row))}
                    maxLength={6}
                  />
                </div>
              </div>
            </div>
          );
        }

        // ---- GROUP CHIP ----
        if (f.kind === 'group') {
          const toggle = (id: string) => setChain(arr => arr.map((e, i) => {
            if (i !== idx || e.pred.kind !== 'group') return e;
            const ids = e.pred.ids.includes(id) ? e.pred.ids.filter(y => y !== id) : [...e.pred.ids, id];
            return { ...e, pred: { ...e.pred, ids } };
          }));
          return (
            <div className="filter-chip-row" key={idx}>
              {OpToggle}
              <div className="filter-chip">
                <div className="chip-head">
                  <span>Group</span>
                  <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                    <label className="chip-not">
                      <input type="checkbox" checked={!!entry.not} onChange={() => toggleNot(idx)} />
                      NOT
                    </label>
                    <button className="chip-remove" onClick={() => removeFilter(idx)} title="Remove">A-</button>
                  </span>
                </div>

                <div className="chip-list">
                  {groups.map(g => (
                    <label key={g.id} className="chip-check">
                      <input type="checkbox" checked={f.ids.includes(g.id)} onChange={() => toggle(g.id)} />
                      <span>{g.name}</span>
                    </label>
                  ))}
                  {groups.length === 0 && <div className="muted">No groups yet</div>}
                </div>
              </div>
            </div>
          );
        }

        // ---- VIDEO: CATEGORY CHIP ----
        if (f.kind === 'v_category') {
          const selected = new Set<number>((f as any).ids || []);
          const cats = VIDEO_CATEGORIES.slice().sort((a,b)=> a.name.localeCompare(b.name));
          const toggle = (id: number) => setChain(arr => arr.map((e,i)=> {
            if (i !== idx || e.pred.kind !== 'v_category') return e;
            const ids = selected.has(id) ? (e.pred as any).ids.filter((x:number)=> x!==id) : [ ...(e.pred as any).ids, id ];
            return { ...e, pred: { ...e.pred, ids } };
          }));
          const selectAll = () => setChain(arr => arr.map((e,i)=> i===idx && e.pred.kind==='v_category' ? { ...e, pred: { ...e.pred, ids: cats.map(c=>c.id) } } : e));
          const clearAll = () => setChain(arr => arr.map((e,i)=> i===idx && e.pred.kind==='v_category' ? { ...e, pred: { ...e.pred, ids: [] } } : e));
          return (
            <div className="filter-chip-row" key={idx}>
              {OpToggle}
              <div className="filter-chip">
                <div className="chip-head">
                  <span>Category</span>
                  <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                    <label className="chip-not">
                      <input type="checkbox" checked={!!entry.not} onChange={() => toggleNot(idx)} />
                      NOT
                    </label>
                    <button className="btn-ghost" onClick={selectAll} title="Select all">All</button>
                    <button className="btn-ghost" onClick={clearAll} title="Clear all">None</button>
                    <button className="chip-remove" onClick={() => removeFilter(idx)} title="Remove">A-</button>
                  </span>
                </div>
                <div className="chip-list">
                  {cats.map(cat => (
                    <label key={cat.id} className="chip-check">
                      <input type="checkbox" checked={selected.has(cat.id)} onChange={() => toggle(cat.id)} />
                      <span>{cat.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          );
        }

        // ---- VIDEO: LANGUAGE CHIP ----
        if (f.kind === 'v_language') {
          const has = (code: 'en'|'de'|'other') => ((f as any).codes || []).includes(code);
          const toggle = (code: 'en'|'de'|'other') => setChain(arr => arr.map((e,i)=> {
            if (i!==idx || e.pred.kind!=='v_language') return e;
            const codes: Array<'en'|'de'|'other'> = (e.pred as any).codes || [];
            const next = has(code) ? codes.filter(c=>c!==code) : [...codes, code];
            return { ...e, pred: { ...e.pred, codes: next } };
          }));
          return (
            <div className="filter-chip-row" key={idx}>
              {OpToggle}
              <div className="filter-chip">
                <div className="chip-head">
                  <span>Language</span>
                  <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                    <label className="chip-not">
                      <input type="checkbox" checked={!!entry.not} onChange={() => toggleNot(idx)} />
                      NOT
                    </label>
                    <button className="chip-remove" onClick={() => removeFilter(idx)} title="Remove">A-</button>
                  </span>
                </div>
                <div className="chip-list">
                  {(['en','de','other'] as const).map(code => (
                    <label key={code} className="chip-check">
                      <input type="checkbox" checked={has(code)} onChange={() => toggle(code)} />
                      <span>{code}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          );
        }

        // ---- VIDEO: VISIBILITY CHIP ----
        if (f.kind === 'v_visibility') {
          const has = (v: 'public'|'unlisted'|'private') => ((f as any).values || []).includes(v);
          const toggle = (v: 'public'|'unlisted'|'private') => setChain(arr => arr.map((e,i)=> {
            if (i!==idx || e.pred.kind!=='v_visibility') return e;
            const values: Array<'public'|'unlisted'|'private'> = (e.pred as any).values || [];
            const next = has(v) ? values.filter(x=>x!==v) : [...values, v];
            return { ...e, pred: { ...e.pred, values: next } };
          }));
          return (
            <div className="filter-chip-row" key={idx}>
              {OpToggle}
              <div className="filter-chip">
                <div className="chip-head">
                  <span>Visibility</span>
                  <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                    <label className="chip-not">
                      <input type="checkbox" checked={!!entry.not} onChange={() => toggleNot(idx)} />
                      NOT
                    </label>
                    <button className="chip-remove" onClick={() => removeFilter(idx)} title="Remove">A-</button>
                  </span>
                </div>
                <div className="chip-list">
                  {(['public','unlisted','private'] as const).map(v => (
                    <label key={v} className="chip-check">
                      <input type="checkbox" checked={has(v)} onChange={() => toggle(v)} />
                      <span>{v}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          );
        }

        // ---- VIDEO: LIVESTREAM CHIP ----
        if (f.kind === 'v_livestream') {
          const checked = !!(f as any).value;
          return (
            <div className="filter-chip-row" key={idx}>
              {OpToggle}
              <div className="filter-chip">
                <div className="chip-head">
                  <span>Livestream</span>
                  <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                    <label className="chip-not">
                      <input type="checkbox" checked={!!entry.not} onChange={() => toggleNot(idx)} />
                      NOT
                    </label>
                    <button className="chip-remove" onClick={() => removeFilter(idx)} title="Remove">A-</button>
                  </span>
                </div>
                <label className="chip-check">
                  <input type="checkbox" checked={checked} onChange={(ev)=> setChain(arr => arr.map((e,i)=> i===idx && e.pred.kind==='v_livestream' ? { ...e, pred: { ...e.pred, value: ev.target.checked } } : e))} />
                  <span>is live</span>
                </label>
              </div>
            </div>
          );
        }

        // ---- CHANNEL: COUNTRY CHIP ----
        if (f.kind === 'c_country') {
          const normalize = (s: string) => (s || '').trim().toLowerCase();
          const codesCsv = (f as any).codesCsv || '';
          const raw = codesCsv.split(',').map(normalize).filter((x: string) => !!x);
          const parts: string[] = Array.from(new Set<string>(raw));
          const setCsv = (list: string[]) => setChain(arr => arr.map((e,i)=> i===idx && e.pred.kind==='c_country' ? { ...e, pred: { ...e.pred, codesCsv: list.join(', ') } } : e));
          const toggleCode = (code: string) => {
            const c = normalize(code);
            const next = parts.includes(c) ? parts.filter(x=>x!==c) : [...parts, c];
            setCsv(next);
          };
          return (
            <div className="filter-chip-row" key={idx}>
              {OpToggle}
              <div className="filter-chip">
                <div className="chip-head">
                  <span>Channel country</span>
                  <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                    <label className="chip-not">
                      <input type="checkbox" checked={!!entry.not} onChange={() => toggleNot(idx)} />
                      NOT
                    </label>
                    <button className="chip-remove" onClick={() => removeFilter(idx)} title="Remove">A-</button>
                  </span>
                </div>
                <input
                  className="chip-input"
                  type="text"
                  placeholder="Codes, e.g. de, us"
                  value={codesCsv}
                  onChange={(ev)=> setChain(arr => arr.map((e,i)=> i===idx && e.pred.kind==='c_country' ? { ...e, pred: { ...e.pred, codesCsv: ev.target.value } } : e))}
                />
                <div className="muted" style={{ fontSize: 12 }}>Case-insensitive; comma separated</div>
                {Array.isArray(countryOptions) && countryOptions.length > 0 && (
                  <div className="chip-list">
                    {countryOptions.map(code => (
                      <label key={code} className="chip-check">
                        <input type="checkbox" checked={parts.includes(code)} onChange={() => toggleCode(code)} />
                        <span>{code}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        }

        // ---- CHANNEL: SUBS RANGE CHIP ----
        if (f.kind === 'c_subs') {
          const set = (k: 'min'|'max', val: any) => setChain(arr => arr.map((e,i)=> i===idx && e.pred.kind==='c_subs' ? { ...e, pred: { ...e.pred, [k]: (val === '' ? undefined : Math.max(0, Math.floor(Number(val) || 0))) } } : e));
          return (
            <div className="filter-chip-row" key={idx}>
              {OpToggle}
              <div className="filter-chip">
                <div className="chip-head">
                  <span>Channel subs</span>
                  <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                    <label className="chip-not">
                      <input type="checkbox" checked={!!entry.not} onChange={() => toggleNot(idx)} />
                      NOT
                    </label>
                    <button className="chip-remove" onClick={() => removeFilter(idx)} title="Remove">A-</button>
                  </span>
                </div>
                <div className="row">
                  <label className="chip-inline">min
                    <input className="chip-input" style={{ width: 100 }} type="number" min={0} value={(f as any).min ?? ''} onChange={(ev)=> set('min', ev.target.value)} />
                  </label>
                  <label className="chip-inline">max
                    <input className="chip-input" style={{ width: 100 }} type="number" min={0} value={(f as any).max ?? ''} onChange={(ev)=> set('max', ev.target.value)} />
                  </label>
                </div>
              </div>
            </div>
          );
        }

        // ---- CHANNEL: VIEWS RANGE CHIP ----
        if (f.kind === 'c_views') {
          const set = (k: 'min'|'max', val: any) => setChain(arr => arr.map((e,i)=> i===idx && e.pred.kind==='c_views' ? { ...e, pred: { ...e.pred, [k]: (val === '' ? undefined : Math.max(0, Math.floor(Number(val) || 0))) } } : e));
          return (
            <div className="filter-chip-row" key={idx}>
              {OpToggle}
              <div className="filter-chip">
                <div className="chip-head">
                  <span>Channel views</span>
                  <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                    <label className="chip-not">
                      <input type="checkbox" checked={!!entry.not} onChange={() => toggleNot(idx)} />
                      NOT
                    </label>
                    <button className="chip-remove" onClick={() => removeFilter(idx)} title="Remove">A-</button>
                  </span>
                </div>
                <div className="row">
                  <label className="chip-inline">min
                    <input className="chip-input" style={{ width: 120 }} type="number" min={0} value={(f as any).min ?? ''} onChange={(ev)=> set('min', ev.target.value)} />
                  </label>
                  <label className="chip-inline">max
                    <input className="chip-input" style={{ width: 120 }} type="number" min={0} value={(f as any).max ?? ''} onChange={(ev)=> set('max', ev.target.value)} />
                  </label>
                </div>
              </div>
            </div>
          );
        }

        // ---- CHANNEL: TAGS ANY/ALL/NONE CHIPS ----
        if (f.kind === 'c_tags_any' || f.kind === 'c_tags_all' || f.kind === 'c_tags_none') {
          const label = f.kind === 'c_tags_any' ? 'Channel tags (any of)' : f.kind === 'c_tags_all' ? 'Channel tags (all of)' : 'Channel tags (none of)';
          const raw = ((f as any).tagsCsv || '') as string;
          const normalize = (s: string) => (s || '').trim();
          const selected = new Set<string>(raw.split(',').map(normalize).filter(Boolean));
          const toggle = (name: string) => setChain(arr => arr.map((e,i)=> {
            if (i !== idx || (e.pred.kind !== 'c_tags_any' && e.pred.kind !== 'c_tags_all' && e.pred.kind !== 'c_tags_none')) return e;
            const val = (e.pred as any).tagsCsv || '';
            const parts = Array.from(new Set<string>(val.split(',').map((s: string)=> (s||'').trim()).filter(Boolean)));
            const has = parts.includes(name);
            const next = has ? parts.filter(x=>x!==name) : [...parts, name];
            return { ...e, pred: { ...e.pred, tagsCsv: next.join(', ') } };
          }));
          const clearAll = () => setChain(arr => arr.map((e,i)=> i===idx && (e.pred.kind==='c_tags_any' || e.pred.kind==='c_tags_all' || e.pred.kind==='c_tags_none') ? { ...e, pred: { ...e.pred, tagsCsv: '' } } : e));
          const all = Array.isArray(channelTagOptions) ? channelTagOptions : [];
          // Group options by tagGroups using tagsRegistry's groupId
          const tg = Array.isArray(tagGroups) ? tagGroups : [];
          const byId = new Map<string, TagGroupRec>(tg.map(g => [g.id, g] as [string, TagGroupRec]));
          const reg = new Map<string, TagRec>((Array.isArray(tagsRegistry) ? tagsRegistry : []).map(t => [t.name, t] as [string, TagRec]));
          const grouped = new Map<string, TagOption[]>(); // key: groupId or ''
          for (const opt of all) {
            const rec = reg.get(opt.name);
            const key = (rec?.groupId && byId.has(String(rec.groupId))) ? String(rec!.groupId) : '';
            const arr = grouped.get(key) || (grouped.set(key, []), grouped.get(key)!);
            arr.push(opt);
          }
          const entries = Array.from(grouped.entries()).sort((a,b) => {
            if (a[0] === '' && b[0] !== '') return -1;
            if (a[0] !== '' && b[0] === '') return 1;
            const an = a[0] ? (byId.get(a[0])?.name || '') : 'Ungrouped';
            const bn = b[0] ? (byId.get(b[0])?.name || '') : 'Ungrouped';
            return an.localeCompare(bn);
          });
          for (const [, arr] of entries) arr.sort((a,b)=> a.name.localeCompare(b.name));
          return (
            <div className="filter-chip-row" key={idx}>
              {OpToggle}
              <div className="filter-chip">
                <div className="chip-head">
                  <span>{label}</span>
                  <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                    <label className="chip-not">
                      <input type="checkbox" checked={!!entry.not} onChange={() => toggleNot(idx)} />
                      NOT
                    </label>
                    <button className="btn-ghost" onClick={clearAll} title="Clear all">None</button>
                    <button className="chip-remove" onClick={() => removeFilter(idx)} title="Remove">A-</button>
                  </span>
                </div>
                {all.length > 0 ? (
                  <div className="chip-list" style={{ display: 'grid', gap: 6 }}>
                    {entries.map(([gid, list]) => (
                      <details key={gid || 'ungrouped'}>
                        <summary>{gid ? (byId.get(gid)?.name || gid) : 'Ungrouped'}</summary>
                        <div className="chip-list" style={{ paddingTop: 6 }}>
                          {list.map(opt => (
                            <label key={opt.name} className="chip-check">
                              <input type="checkbox" checked={selected.has(opt.name)} onChange={() => toggle(opt.name)} />
                              <span>{opt.name}{typeof opt.count === 'number' ? ` (${opt.count})` : ''}</span>
                            </label>
                          ))}
                        </div>
                      </details>
                    ))}
                  </div>
                ) : (
                  <div className="muted">No tags yet. Add tags in the sidebar.</div>
                )}
              </div>
            </div>
          );
        }

        // ---- CHANNEL: VIDEO COUNT RANGE CHIP ----
        if (f.kind === 'c_videos') {
          const set = (k: 'min'|'max', val: any) => setChain(arr => arr.map((e,i)=> i===idx && e.pred.kind==='c_videos' ? { ...e, pred: { ...e.pred, [k]: (val === '' ? undefined : Math.max(0, Math.floor(Number(val) || 0))) } } : e));
          return (
            <div className="filter-chip-row" key={idx}>
              {OpToggle}
              <div className="filter-chip">
                <div className="chip-head">
                  <span>Channel video count</span>
                  <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                    <label className="chip-not">
                      <input type="checkbox" checked={!!entry.not} onChange={() => toggleNot(idx)} />
                      NOT
                    </label>
                    <button className="chip-remove" onClick={() => removeFilter(idx)} title="Remove">A-</button>
                  </span>
                </div>
                <div className="row">
                  <label className="chip-inline">min
                    <input className="chip-input" style={{ width: 100 }} type="number" min={0} value={(f as any).min ?? ''} onChange={(ev)=> set('min', ev.target.value)} />
                  </label>
                  <label className="chip-inline">max
                    <input className="chip-input" style={{ width: 100 }} type="number" min={0} value={(f as any).max ?? ''} onChange={(ev)=> set('max', ev.target.value)} />
                  </label>
                </div>
              </div>
            </div>
          );
        }

        // ---- CHANNEL: SUBSCRIBERS HIDDEN CHIP ----
        if (f.kind === 'c_subsHidden') {
          const checked = !!(f as any).value;
          return (
            <div className="filter-chip-row" key={idx}>
              {OpToggle}
              <div className="filter-chip">
                <div className="chip-head">
                  <span>Subs hidden</span>
                  <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                    <label className="chip-not">
                      <input type="checkbox" checked={!!entry.not} onChange={() => toggleNot(idx)} />
                      NOT
                    </label>
                    <button className="chip-remove" onClick={() => removeFilter(idx)} title="Remove">A-</button>
                  </span>
                </div>
                <label className="chip-check">
                  <input type="checkbox" checked={checked} onChange={(ev)=> setChain(arr => arr.map((e,i)=> i===idx && e.pred.kind==='c_subsHidden' ? { ...e, pred: { ...e.pred, value: ev.target.checked } } : e))} />
                  <span>subscribers hidden</span>
                </label>
              </div>
            </div>
          );
        }

        // ---- VIDEO: TAGS ANY/ALL/NONE CHIPS ----
        if (f.kind === 'v_tags_any' || f.kind === 'v_tags_all' || f.kind === 'v_tags_none') {
          const label = f.kind === 'v_tags_any' ? 'Tags (any of)' : f.kind === 'v_tags_all' ? 'Tags (all of)' : 'Tags (none of)';
          const raw = ((f as any).tagsCsv || '') as string;
          const normalize = (s: string) => (s || '').trim();
          const selected = new Set<string>(raw.split(',').map(normalize).filter(Boolean));
          const toggle = (name: string) => setChain(arr => arr.map((e,i)=> {
            if (i !== idx || (e.pred.kind !== 'v_tags_any' && e.pred.kind !== 'v_tags_all' && e.pred.kind !== 'v_tags_none')) return e;
            const val = (e.pred as any).tagsCsv || '';
            const parts = Array.from(new Set<string>(val.split(',').map((s: string)=> (s||'').trim()).filter(Boolean)));
            const has = parts.includes(name);
            const next = has ? parts.filter(x=>x!==name) : [...parts, name];
            return { ...e, pred: { ...e.pred, tagsCsv: next.join(', ') } };
          }));
          const clearAll = () => setChain(arr => arr.map((e,i)=> i===idx && (e.pred.kind==='v_tags_any' || e.pred.kind==='v_tags_all' || e.pred.kind==='v_tags_none') ? { ...e, pred: { ...e.pred, tagsCsv: '' } } : e));
          const all = Array.isArray(videoTagOptions) ? videoTagOptions : [];
          // Group options by tagGroups using tagsRegistry's groupId
          const tg = Array.isArray(tagGroups) ? tagGroups : [];
          const byId = new Map<string, TagGroupRec>(tg.map(g => [g.id, g] as [string, TagGroupRec]));
          const reg = new Map<string, TagRec>((Array.isArray(tagsRegistry) ? tagsRegistry : []).map(t => [t.name, t] as [string, TagRec]));
          const grouped = new Map<string, TagOption[]>(); // key: groupId or ''
          for (const opt of all) {
            const rec = reg.get(opt.name);
            const key = (rec?.groupId && byId.has(String(rec.groupId))) ? String(rec!.groupId) : '';
            const arr = grouped.get(key) || (grouped.set(key, []), grouped.get(key)!);
            arr.push(opt);
          }
          const entries = Array.from(grouped.entries()).sort((a,b) => {
            if (a[0] === '' && b[0] !== '') return -1;
            if (a[0] !== '' && b[0] === '') return 1;
            const an = a[0] ? (byId.get(a[0])?.name || '') : 'Ungrouped';
            const bn = b[0] ? (byId.get(b[0])?.name || '') : 'Ungrouped';
            return an.localeCompare(bn);
          });
          for (const [, arr] of entries) arr.sort((a,b)=> a.name.localeCompare(b.name));
          return (
            <div className="filter-chip-row" key={idx}>
              {OpToggle}
              <div className="filter-chip">
                <div className="chip-head">
                  <span>{label}</span>
                  <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                    <label className="chip-not">
                      <input type="checkbox" checked={!!entry.not} onChange={() => toggleNot(idx)} />
                      NOT
                    </label>
                    <button className="btn-ghost" onClick={clearAll} title="Clear all">None</button>
                    <button className="chip-remove" onClick={() => removeFilter(idx)} title="Remove">A-</button>
                  </span>
                </div>
                {all.length > 0 ? (
                  <div className="chip-list" style={{ display: 'grid', gap: 6 }}>
                    {entries.map(([gid, list]) => (
                      <details key={gid || 'ungrouped-v'}>
                        <summary>{gid ? (byId.get(gid)?.name || gid) : 'Ungrouped'}</summary>
                        <div className="chip-list" style={{ paddingTop: 6 }}>
                          {list.map(opt => (
                            <label key={opt.name} className="chip-check">
                              <input type="checkbox" checked={selected.has(opt.name)} onChange={() => toggle(opt.name)} />
                              <span>{opt.name}{typeof opt.count === 'number' ? ` (${opt.count})` : ''}</span>
                            </label>
                          ))}
                        </div>
                      </details>
                    ))}
                  </div>
                ) : (
                  <div className="muted">No tags yet. Add tags in the sidebar.</div>
                )}
              </div>
            </div>
          );
        }

        // ---- VIDEO: FLAG CHIP ----
        if (f.kind === 'v_flag') {
          const name = (f as any).name as 'started'|'completed';
          const value = !!(f as any).value;
          const setName = (nv: 'started'|'completed') => setChain(arr => arr.map((e,i)=> i===idx && e.pred.kind==='v_flag' ? { ...e, pred: { ...e.pred, name: nv } } : e));
          const setVal  = (nv: boolean) => setChain(arr => arr.map((e,i)=> i===idx && e.pred.kind==='v_flag' ? { ...e, pred: { ...e.pred, value: nv } } : e));
          return (
            <div className="filter-chip-row" key={idx}>
              {OpToggle}
              <div className="filter-chip">
                <div className="chip-head">
                  <span>Flag</span>
                  <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                    <label className="chip-not">
                      <input type="checkbox" checked={!!entry.not} onChange={() => toggleNot(idx)} />
                      NOT
                    </label>
                    <button className="chip-remove" onClick={() => removeFilter(idx)} title="Remove">A-</button>
                  </span>
                </div>
                <div className="row">
                  <select className="chip-input" value={name} onChange={(ev)=> setName(ev.target.value as any)}>
                    <option value="started">started</option>
                    <option value="completed">completed</option>
                  </select>
                  <label className="chip-check">
                    <input type="checkbox" checked={value} onChange={(ev)=> setVal(ev.target.checked)} />
                    <span>is true</span>
                  </label>
                </div>
              </div>
            </div>
          );
        }

        // ---- VIDEO: TOPICS ANY/ALL CHIPS ----
        if (f.kind === 'v_topics_any' || f.kind === 'v_topics_all') {
          const label = f.kind === 'v_topics_any' ? 'Topics (any of)' : 'Topics (all of)';
          const raw = ((f as any).itemsCsv || '') as string;
          const normalize = (s: string) => (s || '').trim();
          const selected = new Set<string>(raw.split(',').map(normalize).filter(Boolean));
          const toggle = (name: string) => setChain(arr => arr.map((e,i)=> {
            if (i !== idx || (e.pred.kind !== 'v_topics_any' && e.pred.kind !== 'v_topics_all')) return e;
            const val = (e.pred as any).itemsCsv || '';
            const parts = Array.from(new Set<string>(val.split(',').map((s: string)=> (s||'').trim()).filter(Boolean)));
            const has = parts.includes(name);
            const next = has ? parts.filter(x=>x!==name) : [...parts, name];
            return { ...e, pred: { ...e.pred, itemsCsv: next.join(', ') } };
          }));
          const clearAll = () => setChain(arr => arr.map((e,i)=> i===idx && (e.pred.kind==='v_topics_any' || e.pred.kind==='v_topics_all') ? { ...e, pred: { ...e.pred, itemsCsv: '' } } : e));
          const all = Array.isArray(topicOptions) ? topicOptions : [];
          return (
            <div className="filter-chip-row" key={idx}>
              {OpToggle}
              <div className="filter-chip">
                <div className="chip-head">
                  <span>{label}</span>
                  <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                    <label className="chip-not">
                      <input type="checkbox" checked={!!entry.not} onChange={() => toggleNot(idx)} />
                      NOT
                    </label>
                    <button className="btn-ghost" onClick={clearAll} title="Clear all">None</button>
                    <button className="chip-remove" onClick={() => removeFilter(idx)} title="Remove">A-</button>
                  </span>
                </div>
                {all.length > 0 ? (
                  <div className="chip-list">
                    {all.map(name => (
                      <label key={name} className="chip-check">
                        <input type="checkbox" checked={selected.has(name)} onChange={() => toggle(name)} />
                        <span>{name}</span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <div className="muted">No topics yet. Refresh to compute.</div>
                )}
              </div>
            </div>
          );
        }

        // ---- CHANNEL: CREATED AGE CHIP ----
        if (f.kind === 'c_createdAge') {
          const ui = (f as any).ui || { min: undefined, max: undefined, unit: 'd' };
          const set = (k: 'min'|'max'|'unit', val: any) => setChain(arr => arr.map((e,i)=> i===idx && e.pred.kind==='c_createdAge' ? { ...e, pred: { ...e.pred, ui: { ...((e.pred as any).ui || {}), [k]: k==='unit' ? val : (val === '' ? undefined : Math.max(0, Math.floor(Number(val) || 0))) } } } : e));
          return (
            <div className="filter-chip-row" key={idx}>
              {OpToggle}
              <div className="filter-chip">
                <div className="chip-head">
                  <span>Channel age</span>
                  <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                    <label className="chip-not">
                      <input type="checkbox" checked={!!entry.not} onChange={() => toggleNot(idx)} />
                      NOT
                    </label>
                    <button className="chip-remove" onClick={() => removeFilter(idx)} title="Remove">A-</button>
                  </span>
                </div>
                <div className="row">
                  <label className="chip-inline">min
                    <input className="chip-input" style={{ width: 36 }} type="number" min={0} value={ui.min ?? ''} onChange={(ev)=> set('min', ev.target.value)} />
                  </label>
                  <label className="chip-inline">max
                    <input className="chip-input" style={{ width: 36 }} type="number" min={0} value={ui.max ?? ''} onChange={(ev)=> set('max', ev.target.value)} />
                  </label>
                  <select className="chip-input" style={{ width: 80 }} value={ui.unit || 'd'} onChange={(ev)=> set('unit', ev.target.value)}>
                    <option value="d">days</option>
                    <option value="w">weeks</option>
                    <option value="m">months</option>
                    <option value="y">years</option>
                  </select>
                </div>
              </div>
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
        <option value="">+ Add filter...</option>
        <optgroup label="Video filters">
          <option value="duration">Duration range</option>
          <option value="age">Age</option>
          <option value="title">Title (regex)</option>
          <option value="v_desc">Description (regex)</option>
          <option value="v_category">Category</option>
          <option value="v_livestream">Livestream</option>
          <option value="v_language">Language</option>
          <option value="v_visibility">Visibility</option>
          <option value="v_sources_any">Sources</option>
          <option value="v_tags_any">Tags (any)</option>
          <option value="v_tags_all">Tags (all)</option>
          <option value="v_tags_none">Tags (none)</option>
          <option value="v_flag">Flag (started/completed)</option>
          <option value="v_topics_any">Topics (any)</option>
          <option value="v_topics_all">Topics (all)</option>
        </optgroup>
        <optgroup label="Channel filters">
          <option value="channel">Channel (IDs)</option>
          <option value="c_country">Country</option>
          <option value="c_subs">Subscribers (min/max)</option>
          <option value="c_views">Views (min/max)</option>
          <option value="c_videos">Video count (min/max)</option>
          <option value="c_createdAge">Creation age</option>
          <option value="c_subsHidden">Subscribers hidden</option>
          <option value="c_tags_any">Tags (any)</option>
          <option value="c_tags_all">Tags (all)</option>
          <option value="c_tags_none">Tags (none)</option>
        </optgroup>
        <optgroup label="Other">
          <option value="group">Preset</option>
        </optgroup>
      </select>

      {/* Clear */}
      {chain.length > 0 && (
        <button className="btn-ghost" onClick={() => setChain([])} title="Clear all filters">Clear</button>
      )}
    </div>
  );
}

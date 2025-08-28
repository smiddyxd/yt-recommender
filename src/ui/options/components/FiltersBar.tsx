// src/ui/options/components/FiltersBar.tsx
import React from 'react';
import type { Group as GroupRec } from '../../../shared/conditions';
import type { FilterEntry, FilterNode } from '../lib/filters';
export type ChannelOption = { id: string; name: string };

type Props = {
    // chain editor state
    chain: FilterEntry[];
    setChain: React.Dispatch<React.SetStateAction<FilterEntry[]>>;

    // data to power chips
    channelOptions: ChannelOption[];
    groups: GroupRec[];

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
    groups,
    groupName,
    setGroupName,
    editingGroupId,
    onSaveAsGroup,
    onSaveChanges,
    onCancelEdit,
}: Props) {

    // helpers scoped to this component
    function addFilter(kind: FilterNode['kind']) {
        const defaultPred: FilterNode =
            kind === 'duration' ? { kind: 'duration', ui: { minH: 0, minM: 0, minS: 0, maxH: 0, maxM: 0, maxS: 0 } } :
                kind === 'age' ? { kind: 'age', min: undefined, max: undefined } as any :
                kind === 'channel' ? { kind: 'channel', ids: [], q: '' } :
                    kind === 'title' ? { kind: 'title', pattern: '', flags: 'i' } :
                        { kind: 'group', ids: [] };

        setChain(prev => [
            ...prev,
            { pred: defaultPred, not: false, op: prev.length === 0 ? undefined : 'AND' }
        ]);
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
        setChain(prev => prev.map((e, i) =>
            i === idx ? { ...e, op: e.op === 'OR' ? 'AND' : 'OR' } : e
        ));
    }

    function toggleNot(idx: number) {
        setChain(prev => prev.map((e, i) =>
            i === idx ? { ...e, not: !e.not } : e
        ));
    }

    return (
        <div className="filters">
            {/* Group save/edit controls */}
            <input
                className="chip-input"
                style={{ minWidth: 220 }}
                type="text"
                placeholder="Group name..."
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
            />
            <button
                className="btn-ghost"
                title="Save these filters as a new group"
                onClick={onSaveAsGroup}
                disabled={chain.length === 0 || !groupName.trim()}
            >
                Save as group
            </button>
            {editingGroupId && (
                <>
                    <button
                        className="btn-ghost"
                        title="Overwrite the currently edited group with these filters"
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
                    const set = (k: keyof typeof ui, val: number) =>
                        setChain(arr =>
                            arr.map((e, i) =>
                                i === idx && e.pred.kind === 'duration'
                                    ? { ...e, pred: { ...e.pred, ui: { ...e.pred.ui, [k]: Math.max(0, Number(val) || 0) } } }
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
                                            <input
                                                type="checkbox"
                                                checked={!!entry.not}
                                                onChange={() => toggleNot(idx)}
                                            />
                                            NOT
                                        </label>
                                        <button className="chip-remove" onClick={() => removeFilter(idx)} title="Remove">×</button>
                                    </span>
                                </div>

                                <div className="duration-rows">
                                    <div className="duration-row">
                                        <span>Min</span>
                                        <input type="number" min={0} value={ui.minH} onChange={e => set('minH', +e.target.value)} aria-label="Min hours" />
                                        <span>h</span>
                                        <input type="number" min={0} value={ui.minM} onChange={e => set('minM', +e.target.value)} aria-label="Min minutes" />
                                        <span>m</span>
                                        <input type="number" min={0} value={ui.minS} onChange={e => set('minS', +e.target.value)} aria-label="Min seconds" />
                                        <span>s</span>
                                    </div>
                                    <div className="duration-row">
                                        <span>Max</span>
                                        <input type="number" min={0} value={ui.maxH} onChange={e => set('maxH', +e.target.value)} aria-label="Max hours" />
                                        <span>h</span>
                                        <input type="number" min={0} value={ui.maxM} onChange={e => set('maxM', +e.target.value)} aria-label="Max minutes" />
                                        <span>m</span>
                                        <input type="number" min={0} value={ui.maxS} onChange={e => set('maxS', +e.target.value)} aria-label="Max seconds" />
                                        <span>s</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    );
                }

                // ---- CHANNEL CHIP ----
                if (f.kind === 'channel') {
                    const options = channelOptions.filter(c =>
                        !f.q ? true : c.name.toLowerCase().includes(f.q.toLowerCase())
                    );
                    const toggle = (id: string) =>
                        setChain(arr =>
                            arr.map((e, i) => {
                                if (i !== idx || e.pred.kind !== 'channel') return e;
                                const ids = e.pred.ids.includes(id)
                                    ? e.pred.ids.filter(y => y !== id)
                                    : [...e.pred.ids, id];
                                return { ...e, pred: { ...e.pred, ids } };
                            })
                        );

                    return (
                        <div className="filter-chip-row" key={idx}>
                            {OpToggle}
                            <div className="filter-chip">
                                <div className="chip-head">
                                    <span>Channel</span>
                                    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                                        <label className="chip-not">
                                            <input
                                                type="checkbox"
                                                checked={!!entry.not}
                                                onChange={() => toggleNot(idx)}
                                            />
                                            NOT
                                        </label>
                                        <button className="chip-remove" onClick={() => removeFilter(idx)} title="Remove">×</button>
                                    </span>
                                </div>

                                <input
                                    className="chip-input"
                                    type="search"
                                    placeholder="Search channels..."
                                    value={f.q}
                                    onChange={(ev) =>
                                        setChain((arr) =>
                                            arr.map((row, i) =>
                                                i === idx && row.pred.kind === 'channel'
                                                    ? { ...row, pred: { ...row.pred, q: ev.target.value } }
                                                    : row
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
                            </div>
                        </div>
                    );
                }

                // ---- AGE (DAYS) CHIP ----
                if (f.kind === 'age') {
                    const set = (k: 'min' | 'max', val: number | undefined) =>
                        setChain(arr =>
                            arr.map((e, i) =>
                                i === idx && e.pred.kind === 'age'
                                    ? { ...e, pred: { ...e.pred, [k]: val == null ? undefined : Math.max(0, Math.floor(Number(val) || 0)) } }
                                    : e
                            )
                        );

                    return (
                        <div className="filter-chip-row" key={idx}>
                            {OpToggle}
                            <div className="filter-chip">
                                <div className="chip-head">
                                    <span>Age (days)</span>
                                    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                                        <label className="chip-not">
                                            <input
                                                type="checkbox"
                                                checked={!!entry.not}
                                                onChange={() => toggleNot(idx)}
                                            />
                                            NOT
                                        </label>
                                        <button className="chip-remove" onClick={() => removeFilter(idx)} title="Remove">×</button>
                                    </span>
                                </div>

                                <div className="row">
                                    <label>Min</label>
                                    <input
                                        className="chip-input"
                                        type="number"
                                        min={0}
                                        value={f.min ?? ''}
                                        onChange={(e) => set('min', e.target.value === '' ? undefined : Number(e.target.value))}
                                        aria-label="Min age days"
                                    />
                                    <label>Max</label>
                                    <input
                                        className="chip-input"
                                        type="number"
                                        min={0}
                                        value={f.max ?? ''}
                                        onChange={(e) => set('max', e.target.value === '' ? undefined : Number(e.target.value))}
                                        aria-label="Max age days"
                                    />
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
                                            <input
                                                type="checkbox"
                                                checked={!!entry.not}
                                                onChange={() => toggleNot(idx)}
                                            />
                                            NOT
                                        </label>
                                        <button className="chip-remove" onClick={() => removeFilter(idx)} title="Remove">×</button>
                                    </span>
                                </div>

                                <div className="row">
                                    <input
                                        className="chip-input"
                                        type="text"
                                        placeholder="pattern e.g. (quick|tip)"
                                        value={f.pattern}
                                        onChange={(ev) =>
                                            setChain((arr) =>
                                                arr.map((row, i) =>
                                                    i === idx && row.pred.kind === 'title'
                                                        ? { ...row, pred: { ...row.pred, pattern: ev.target.value } }
                                                        : row
                                                )
                                            )
                                        }
                                    />
                                    <input
                                        className="chip-input flags"
                                        type="text"
                                        placeholder="flags (e.g. i)"
                                        value={f.flags}
                                        onChange={(ev) =>
                                            setChain((arr) =>
                                                arr.map((row, i) =>
                                                    i === idx && row.pred.kind === 'title'
                                                        ? { ...row, pred: { ...row.pred, flags: ev.target.value } }
                                                        : row
                                                )
                                            )
                                        }
                                        maxLength={6}
                                    />

                                </div>
                            </div>
                        </div>
                    );
                }

                // ---- GROUP CHIP ----
                if (f.kind === 'group') {
                    const toggle = (id: string) =>
                        setChain(arr =>
                            arr.map((e, i) => {
                                if (i !== idx || e.pred.kind !== 'group') return e;
                                const ids = e.pred.ids.includes(id)
                                    ? e.pred.ids.filter(y => y !== id)
                                    : [...e.pred.ids, id];
                                return { ...e, pred: { ...e.pred, ids } };
                            })
                        );

                    return (
                        <div className="filter-chip-row" key={idx}>
                            {OpToggle}
                            <div className="filter-chip">
                                <div className="chip-head">
                                    <span>Group</span>
                                    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                                        <label className="chip-not">
                                            <input
                                                type="checkbox"
                                                checked={!!entry.not}
                                                onChange={() => toggleNot(idx)}
                                            />
                                            NOT
                                        </label>
                                        <button className="chip-remove" onClick={() => removeFilter(idx)} title="Remove">×</button>
                                    </span>
                                </div>

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
                <option value="duration">Duration range</option>
                <option value="age">Age (days)</option>
                <option value="channel">Channel</option>
                <option value="title">Title (regex)</option>
                <option value="group">Group</option>
            </select>

            {/* Clear */}
            {chain.length > 0 && (
                <button className="btn-ghost" onClick={() => setChain([])} title="Clear all filters">Clear</button>
            )}
        </div>
    );
}

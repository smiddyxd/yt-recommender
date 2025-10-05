// src/ui/options/components/RecsSidebar.tsx
import React, { useEffect, useMemo, useState } from 'react';
import type { Group as GroupRec } from '../../../shared/conditions';
import type { RecSet, RecEntry } from '../../../types/messages';
import { send as sendBg } from '../../lib/messaging';

type Props = {
  groups: GroupRec[];
};

export default function RecsSidebar({ groups }: Props) {
  const [sets, setSets] = useState<RecSet[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<RecSet | null>(null);
  const [newName, setNewName] = useState('New Rec Set');
  const [newPageSize, setNewPageSize] = useState<number>(20);
  const [history, setHistory] = useState<Array<{ id: string; timestamp: number; videoIds: string[] }>>([]);
  const [historyOpen, setHistoryOpen] = useState<boolean>(false);

  const groupOptions = useMemo(() => groups.map(g => ({ id: g.id, name: g.name })), [groups]);
  const sumW = useMemo(() => (draft?.entries || []).filter(e => e.role === 'weighted' && (e.weight || 0) > 0).reduce((a, e) => a + (e.weight || 0), 0), [draft]);

  useEffect(() => { void loadSets(); }, []);
  useEffect(() => {
    function onMsg(msg: any) {
      if (msg?.type === 'db/change' && msg?.payload?.entity === 'recSets') loadSets();
    }
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);

  async function loadSets() {
    const r: any = await sendBg('recSets/list', {});
    const items: RecSet[] = (r && r.ok && Array.isArray(r.items)) ? r.items : [];
    setSets(items);
    if (editingId) {
      const cur = items.find(s => s.id === editingId) || null;
      if (cur) setDraft(cur);
    }
  }

  async function createSet() {
    const name = (newName || '').trim();
    const ps = Math.max(0, Math.floor(newPageSize || 0));
    if (!name || ps <= 0) return;
    const r: any = await sendBg('recSets/create', { name, pageSize: ps, entries: [] });
    if (r && r.ok && r.id) {
      setNewName('New Rec Set'); setNewPageSize(20);
      setEditingId(String(r.id));
      void loadSets();
    }
  }

  function startEdit(id: string) {
    const cur = sets.find(s => s.id === id) || null;
    setEditingId(id);
    setDraft(cur ? { ...cur } : null);
    void loadHistory(id);
  }

  function updateDraft(patch: Partial<RecSet>) {
    if (!draft) return;
    setDraft({ ...draft, ...patch });
  }

  function updateEntry(idx: number, patch: Partial<RecEntry>) {
    if (!draft) return;
    const entries = draft.entries.slice();
    entries[idx] = { ...entries[idx], ...patch } as RecEntry;
    setDraft({ ...draft, entries });
  }

  function addRow() {
    if (!draft) return;
    const def: RecEntry = {
      presetId: groupOptions[0]?.id || '',
      role: 'weighted',
      weight: 1,
      minPerPage: 0,
      maxPerPage: draft.pageSize,
      prioritizeViewcount: 0,
      prioritizeRecency: 0,
      randomness: 0,
    };
    setDraft({ ...draft, entries: [...draft.entries, def] });
  }

  function removeRow(idx: number) {
    if (!draft) return;
    const entries = draft.entries.slice();
    entries.splice(idx, 1);
    setDraft({ ...draft, entries });
  }

  async function saveDraft() {
    if (!draft) return;
    const patch = { name: draft.name, pageSize: draft.pageSize, entries: draft.entries } as Partial<RecSet>;
    await sendBg('recSets/update', { id: draft.id, patch });
  }

  async function duplicate(id: string) {
    await sendBg('recSets/duplicate', { id });
  }

  async function remove(id: string) {
    if (!confirm('Delete this Rec Set?')) return;
    await sendBg('recSets/delete', { id });
    if (editingId === id) { setEditingId(null); setDraft(null); }
  }

  async function loadHistory(id?: string) {
    const rid = String(id || editingId || '');
    if (!rid) { setHistory([]); return; }
    try {
      const r: any = await sendBg('recSets/history/list', { recSetId: rid });
      const items = (r && r.ok && Array.isArray(r.items)) ? r.items : [];
      setHistory(items as any);
    } catch { setHistory([]); }
  }

  async function openRecord(recordId: string) {
    try {
      const r: any = await sendBg('recSets/history/open', { recordId });
      const rec = (r && r.ok && r.record && Array.isArray(r.record.videoIds)) ? r.record : null;
      if (rec) {
        const ev = new CustomEvent('recs:openHistory', { detail: { videoIds: rec.videoIds } });
        window.dispatchEvent(ev);
      }
    } catch {}
  }

  async function deleteRecord(recordId: string) {
    await sendBg('recSets/history/delete', { recordId });
    await loadHistory();
  }

  async function exportRecord(recordId: string) {
    try {
      const r: any = await sendBg('recSets/history/export', { recordId });
      const rec = (r && r.ok && r.record) ? r.record : null;
      if (!rec) return;
      const blob = new Blob([JSON.stringify(rec, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `recset-${rec.recSetId}-${new Date(rec.timestamp).toISOString().replace(/[:]/g,'-')}.json`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch {}
  }

  const expectedSlots = (e: RecEntry): string => {
    if (!draft) return '';
    if (e.role !== 'weighted' || !e.weight || e.weight <= 0 || sumW <= 0) return '(0)';
    const raw = draft.pageSize * (e.weight / sumW);
    const approx = Math.round(raw);
    const min = Math.max(0, Math.floor(e.minPerPage ?? 0));
    const max = Math.max(0, Math.floor(e.maxPerPage ?? draft.pageSize));
    const clamped = Math.max(min, Math.min(max, approx));
    return `~${clamped} (min ${min}, max ${max})`;
  };

  return (
    <div className="side-section">
      <div className="side-title">Rec Sets</div>
      {/* Create */}
      <div className="side-row" style={{ gap: 6 }}>
        <input className="side-input" type="text" placeholder="Name" value={newName} onChange={(e)=> setNewName(e.target.value)} />
        <input className="side-input" type="number" min={1} max={500} step={1} placeholder="Page Size" value={newPageSize} onChange={(e)=> setNewPageSize(parseInt(e.target.value || '0', 10))} style={{ width: 90 }} />
        <button className="btn-ghost" onClick={createSet} disabled={!newName.trim() || !Number.isFinite(newPageSize as any) || (newPageSize|0) <= 0}>Add</button>
      </div>
      {/* List */}
      <div className="group-list">
        {sets.length === 0 && <div className="muted">No Rec Sets yet.</div>}
        {sets.map(s => (
          <div key={s.id} className="group-row">
            <button className="side-btn" onClick={()=> startEdit(s.id)} aria-pressed={editingId === s.id}>{s.name}</button>
            <button className="btn-ghost" onClick={()=> duplicate(s.id)} title="Duplicate">D</button>
            <button className="btn-ghost" onClick={()=> remove(s.id)} title="Delete">x</button>
          </div>
        ))}
      </div>

      {draft && (
        <div className="side-subsection" style={{ marginTop: 8 }}>
          <div className="side-row" style={{ gap: 6 }}>
            <input className="side-input" type="text" value={draft.name} onChange={(e)=> updateDraft({ name: e.target.value })} placeholder="Rec Set name" />
            <input className="side-input" type="number" min={1} max={500} step={1} value={draft.pageSize} onChange={(e)=> updateDraft({ pageSize: Math.max(0, Math.floor(parseInt(e.target.value || '0', 10))) })} title="Page size" style={{ width: 90 }} />
            <button className="btn-ghost" onClick={saveDraft}>Save</button>
          </div>
          {/* Rows table */}
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>Rows: Preset + Role/Weight/Min/Max + Viewcount/Recency/Randomness + Expected</div>
          {(draft.entries || []).map((e, i) => (
            <div key={i} className="tag-row" style={{ alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <select className="side-input" value={e.presetId} onChange={(ev)=> updateEntry(i, { presetId: (ev.target as HTMLSelectElement).value })} title="Preset">
                {groupOptions.map(g => (<option key={g.id} value={g.id}>{g.name}</option>))}
              </select>
              <select className="side-input" value={e.role} onChange={(ev)=> updateEntry(i, { role: ((ev.target as HTMLSelectElement).value as any) })} title="Role" style={{ width: 98 }}>
                <option value="filter">Filter</option>
                <option value="weighted">Weighted</option>
              </select>
              <input className="side-input" type="number" min={0} max={3} step={1} value={e.weight|0} onChange={(ev)=> updateEntry(i, { weight: Math.max(0, Math.min(3, parseInt(ev.target.value || '0', 10))) })} title="Weight (0..3)" style={{ width: 70 }} disabled={e.role !== 'weighted'} />
              <input className="side-input" type="number" min={0} step={1} value={e.minPerPage || 0} onChange={(ev)=> updateEntry(i, { minPerPage: Math.max(0, parseInt(ev.target.value || '0', 10)) })} title="Min per page" style={{ width: 70 }} />
              <input className="side-input" type="number" min={0} step={1} value={e.maxPerPage ?? draft.pageSize} onChange={(ev)=> updateEntry(i, { maxPerPage: Math.max(0, parseInt(ev.target.value || '0', 10)) })} title="Max per page" style={{ width: 78 }} />
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>V
                <input type="range" min={0} max={1} step={0.05} value={e.prioritizeViewcount || 0} onChange={(ev)=> updateEntry(i, { prioritizeViewcount: parseFloat((ev.target as HTMLInputElement).value) })} title="Prioritize Viewcount" />
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>R
                <input type="range" min={0} max={1} step={0.05} value={e.prioritizeRecency || 0} onChange={(ev)=> updateEntry(i, { prioritizeRecency: parseFloat((ev.target as HTMLInputElement).value) })} title="Prioritize Recency" />
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>Rnd
                <input type="range" min={0} max={1} step={0.05} value={e.randomness || 0} onChange={(ev)=> updateEntry(i, { randomness: parseFloat((ev.target as HTMLInputElement).value) })} title="Randomness" />
              </label>
              <span className="muted" style={{ flex: 1, textAlign: 'right' }}>{expectedSlots(e)}</span>
              <button className="btn-ghost" onClick={()=> removeRow(i)} title="Remove">x</button>
            </div>
          ))}
          <div className="side-row" style={{ justifyContent: 'flex-start' }}>
            <button className="btn-ghost" onClick={addRow}>Add row</button>
          </div>
          {/* History panel */}
          <div className="side-subsection" style={{ marginTop: 8 }}>
            <div className="side-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>History</span>
              <span>
                <button className="btn-ghost" onClick={() => { setHistoryOpen(v => !v); if (!historyOpen) void loadHistory(); }}>{historyOpen ? 'Hide' : 'Show'}</button>
                <button className="btn-ghost" onClick={() => loadHistory()} title="Refresh">R</button>
              </span>
            </div>
            {historyOpen && (
              <div className="group-list">
                {history.length === 0 && <div className="muted">No entries.</div>}
                {history.map(h => (
                  <div className="group-row" key={h.id}>
                    <button className="side-btn" onClick={() => openRecord(h.id)} title={new Date(h.timestamp).toLocaleString()}>
                      {new Date(h.timestamp).toLocaleString()} ({h.videoIds.length})
                    </button>
                    <button className="btn-ghost" onClick={() => exportRecord(h.id)} title="Export">DL</button>
                    <button className="btn-ghost" onClick={() => deleteRecord(h.id)} title="Delete">x</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { send as sendBg } from '../../lib/messaging';

type Pending = { key: string; name?: string | null; handle?: string | null; createdAt?: number; updatedAt?: number };

export default function PendingPanel() {
  const [items, setItems] = useState<Pending[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [batch, setBatch] = useState(5);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const r: any = await sendBg('channels/pending/list', {} as any);
      setItems(Array.isArray(r?.items) ? r.items : []);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally { setLoading(false); }
  }

  async function resolveBatch(n?: number) {
    const limit = Number.isFinite(n) && (n as number) > 0 ? (n as number) : batch;
    try {
      const r: any = await sendBg('channels/pending/resolveBatch', { limit });
      if (!r?.ok) alert(`Failed to open tabs: ${r?.error || 'unknown error'}`);
    } catch (e: any) {
      alert(`Open tabs failed: ${e?.message || e}`);
    } finally {
      // Refresh list after a short delay to allow resolves
      setTimeout(load, 1500);
    }
  }

  useEffect(() => { void load(); }, []);

  const handles = items.filter(it => it.handle).length;
  const namesOnly = items.length - handles;

  return (
    <div style={{ padding: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>Pending Channels (debug)</h3>
        <button className="btn-ghost" onClick={load} disabled={loading}>Refresh</button>
      </div>
      {err && <div className="error">{err}</div>}
      <div className="muted" style={{ marginBottom: 8 }}>
        Total: {items.length} • With handles: {handles} • Name-only: {namesOnly}
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <label className="muted">Batch size</label>
        <input className="side-input" type="number" min={1} max={20} value={batch} onChange={(e)=> setBatch(Math.max(1, Math.min(20, parseInt(e.currentTarget.value || '5', 10))))} style={{ width: 64 }} />
        <button className="btn-ghost" onClick={()=>resolveBatch()} disabled={handles === 0}>Resolve handles (open tabs)</button>
      </div>
      <div style={{ maxHeight: 320, overflow: 'auto', border: '1px solid #333', borderRadius: 6 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>Key</th>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>Handle</th>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>Name</th>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>Updated</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.key}>
                <td style={{ padding: '4px 8px' }}>{it.key}</td>
                <td style={{ padding: '4px 8px' }}>{it.handle || ''}</td>
                <td style={{ padding: '4px 8px' }}>{it.name || ''}</td>
                <td style={{ padding: '4px 8px' }}>{it.updatedAt ? new Date(it.updatedAt).toLocaleString() : ''}</td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr><td colSpan={4} style={{ padding: 12 }} className="muted">No pending channels.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="muted" style={{ marginTop: 8 }}>
        Resolver opens channel pages for handles in background tabs; the content script resolves to channel IDs and the background closes the tabs automatically.
        Name-only entries are skipped (no reliable URL).
      </div>
    </div>
  );
}


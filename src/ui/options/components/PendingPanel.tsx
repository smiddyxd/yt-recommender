import { useEffect, useState } from 'react';
import { send as sendBg } from '../../lib/messaging';

type Pending = { key: string; name?: string | null; handle?: string | null; createdAt?: number; updatedAt?: number };

export default function PendingPanel() {
  const [items, setItems] = useState<Pending[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [batch, setBatch] = useState(5);
  // Scrape panel state
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState<string | null>(null);
  const [seen, setSeen] = useState<number>(0);
  const [lastRun, setLastRun] = useState<Record<string, number | null>>({});
  const [subFeedMax, setSubFeedMax] = useState<number>(120);
  const [historyMax, setHistoryMax] = useState<number>(250);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const r: any = await sendBg('channels/pending/list', {} as any);
      setItems(Array.isArray(r?.items) ? r.items : []);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally { setLoading(false); }
  }

  async function loadScrapeStatus() {
    try {
      const r: any = await sendBg('scrape/status', {} as any);
      setRunning(!!r?.running); setMode(r?.mode || null); setSeen(Number(r?.seen || 0));
      const runs = r?.runs || {};
      setLastRun(runs);
    } catch {}
    try {
      chrome.storage?.local?.get(['scrape.max.subFeed','scrape.max.history'], (o) => {
        const sf = Number(o?.['scrape.max.subFeed']);
        const hi = Number(o?.['scrape.max.history']);
        setSubFeedMax(Number.isFinite(sf) && sf > 0 ? sf : 120);
        setHistoryMax(Number.isFinite(hi) && hi > 0 ? hi : 250);
      });
    } catch {}
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

  useEffect(() => { void load(); void loadScrapeStatus(); }, []);

  function tsLabel(ts?: number | null) { return ts ? new Date(ts).toLocaleString() : '—'; }

  async function runResolveIds() {
    const r: any = await sendBg('scrape/resolveIds', { limit: batch } as any);
    if (!r?.ok) alert(r?.error || 'Failed');
    await loadScrapeStatus();
  }
  async function runSubFeed() {
    try { chrome.storage?.local?.set({ 'scrape.max.subFeed': subFeedMax }); } catch {}
    const r: any = await sendBg('scrape/subFeed', { max: subFeedMax } as any);
    if (!r?.ok) alert(r?.error || 'Failed');
    await loadScrapeStatus();
  }
  async function runSubscriptionsManager() {
    const r: any = await sendBg('scrape/subscriptionsManager', {} as any);
    if (!r?.ok) alert(r?.error || 'Failed');
    await loadScrapeStatus();
  }
  async function runHistory() {
    try { chrome.storage?.local?.set({ 'scrape.max.history': historyMax }); } catch {}
    const r: any = await sendBg('scrape/history', { max: historyMax } as any);
    if (!r?.ok) alert(r?.error || 'Failed');
    await loadScrapeStatus();
  }
  async function runAll() {
    const r: any = await sendBg('scrape/runAll', {} as any);
    if (!r?.ok) alert(r?.error || 'Failed');
    await loadScrapeStatus();
  }
  async function stopAll() {
    await sendBg('scrape/stop', {} as any);
    await loadScrapeStatus();
  }

  const handles = items.filter(it => it.handle).length;
  const namesOnly = items.length - handles;

  return (
    <div style={{ padding: 12 }}>
      {/* Scrape Panel */}
      <div style={{ marginBottom: 14, padding: 12, border: '1px solid #333', borderRadius: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Scrape Panel</h3>
          <button className="btn-ghost" onClick={loadScrapeStatus}>Refresh</button>
          {running ? <span className="muted">Running: {mode || '…'} · Seen: {seen}</span> : <span className="muted">Idle</span>}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
          <button onClick={runAll} disabled={running}>Run all</button>
          <button onClick={runResolveIds} disabled={running}>Resolve ids</button>
          <button onClick={runSubFeed} disabled={running}>Scrape Sub Feed</button>
          <button onClick={runSubscriptionsManager} disabled={running}>Scrape Subscriptions Manager</button>
          <button onClick={runHistory} disabled={running}>Scrape Watch History</button>
          <button className="btn-danger" onClick={stopAll} disabled={!running}>Stop</button>
        </div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 8 }}>
          <label className="muted">Max Sub Feed videos</label>
          <input className="side-input" type="number" min={10} max={5000} value={subFeedMax} onChange={(e)=> setSubFeedMax(Math.max(10, Math.min(5000, parseInt(e.currentTarget.value || '120', 10))))} style={{ width: 90 }} />
          <label className="muted">Max History items</label>
          <input className="side-input" type="number" min={10} max={10000} value={historyMax} onChange={(e)=> setHistoryMax(Math.max(10, Math.min(10000, parseInt(e.currentTarget.value || '250', 10))))} style={{ width: 90 }} />
        </div>
        <div className="muted" style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
          <span>Last run (any): {tsLabel(lastRun['scrape.lastRun.any'])}</span>
          <span>Resolve ids: {tsLabel(lastRun['scrape.lastRun.resolveIds'])}</span>
          <span>Sub Feed: {tsLabel(lastRun['scrape.lastRun.subFeed'])}</span>
          <span>Subscriptions Manager: {tsLabel(lastRun['scrape.lastRun.subscriptionsManager'])}</span>
          <span>History: {tsLabel(lastRun['scrape.lastRun.history'])}</span>
        </div>
      </div>

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
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => {
              const url = it.handle ? `https://www.youtube.com/${it.handle.startsWith('@') ? it.handle : '@'+it.handle}` : null;
              return (
                <tr key={it.key}>
                  <td style={{ padding: '4px 8px' }}>{it.key}</td>
                  <td style={{ padding: '4px 8px' }}>{it.handle || ''}</td>
                  <td style={{ padding: '4px 8px' }}>{it.name || ''}</td>
                  <td style={{ padding: '4px 8px' }}>{it.updatedAt ? new Date(it.updatedAt).toLocaleString() : ''}</td>
                  <td style={{ padding: '4px 8px' }}>{url ? <a href={url} target="_blank" rel="noreferrer">Open</a> : ''}</td>
                </tr>
              );
            })}
            {items.length === 0 && (
              <tr><td colSpan={5} style={{ padding: 12 }} className="muted">No pending channels.</td></tr>
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


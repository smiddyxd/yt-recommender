import { useEffect, useRef, useState } from 'react';
import { send as sendBg } from '../../lib/messaging';

type Pending = { key: string; name?: string | null; handle?: string | null; subscribedPending?: boolean; createdAt?: number; updatedAt?: number };

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
  const [subFeedMaxInput, setSubFeedMaxInput] = useState<string>('120');
  const [historyMaxInput, setHistoryMaxInput] = useState<string>('250');
  const [resolving, setResolving] = useState(false);
  const [noStubs, setNoStubs] = useState<boolean>(false);
  const [stopAtPrevSubFeed, setStopAtPrevSubFeed] = useState<boolean>(false);
  const [stopAtPrevHistory, setStopAtPrevHistory] = useState<boolean>(false);
  const resolvingRef = useRef(false);

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
      chrome.storage?.local?.get(['scrape.max.subFeed','scrape.max.history','debug.noStubs','scrape.stopAtPrevLatest.subFeed','scrape.stopAtPrevLatest.history'], (o) => {
        const sf = Number(o?.['scrape.max.subFeed']);
        const hi = Number(o?.['scrape.max.history']);
        const sfx = (Number.isFinite(sf) && sf > 0 ? sf : 120);
        const hix = (Number.isFinite(hi) && hi > 0 ? hi : 250);
        setSubFeedMax(sfx); setSubFeedMaxInput(String(sfx));
        setHistoryMax(hix); setHistoryMaxInput(String(hix));
        setNoStubs(!!o?.['debug.noStubs']);
        setStopAtPrevSubFeed(!!o?.['scrape.stopAtPrevLatest.subFeed']);
        setStopAtPrevHistory(!!o?.['scrape.stopAtPrevLatest.history']);
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

  async function resolveLoop() {
    setResolving(true); resolvingRef.current = true;
    try {
      for (;;) {
        if (!resolvingRef.current) break;
        const limit = batch;
        const r: any = await sendBg('channels/pending/resolveBatch', { limit });
        const remaining = Number(r?.remaining || 0);
        // Small pause to allow content/background to close tabs
        await new Promise(res => setTimeout(res, 1500));
        await load();
        if (!resolvingRef.current) break;
        if (!r?.ok || remaining <= 0) break; // done or failed once
      }
    } finally {
      setResolving(false); resolvingRef.current = false;
    }
  }

  function toggleResolveLoop() {
    if (resolvingRef.current) { setResolving(false); resolvingRef.current = false; return; }
    void resolveLoop();
  }

  useEffect(() => { void load(); void loadScrapeStatus(); }, []);

  function tsLabel(ts?: number | null) { return ts ? new Date(ts).toLocaleString() : 'N/A'; }
  function toggleNoStubs() { const v = !noStubs; setNoStubs(v); try { chrome.storage?.local?.set({ 'debug.noStubs': v }); } catch {} }
  function toggleStopAtPrevSubFeed() { const v = !stopAtPrevSubFeed; setStopAtPrevSubFeed(v); try { chrome.storage?.local?.set({ 'scrape.stopAtPrevLatest.subFeed': v }); } catch {} }
  function toggleStopAtPrevHistory() { const v = !stopAtPrevHistory; setStopAtPrevHistory(v); try { chrome.storage?.local?.set({ 'scrape.stopAtPrevLatest.history': v }); } catch {} }

  async function runSubFeed() {
    const n = parseInt(subFeedMaxInput, 10);
    const val = Number.isFinite(n) ? n : subFeedMax; // fallback to last known
    setSubFeedMax(val);
    try { chrome.storage?.local?.set({ 'scrape.max.subFeed': val }); } catch {}
    const r: any = await sendBg('scrape/subFeed', { max: val } as any);
    if (!r?.ok) alert(r?.error || 'Failed');
    await loadScrapeStatus();
    await load();
  }
  async function runSubscriptionsManager() {
    const r: any = await sendBg('scrape/subscriptionsManager', {} as any);
    if (!r?.ok) alert(r?.error || 'Failed');
    await loadScrapeStatus();
    await load();
  }
  async function runHistory() {
    const n = parseInt(historyMaxInput, 10);
    const val = Number.isFinite(n) ? n : historyMax;
    setHistoryMax(val);
    try { chrome.storage?.local?.set({ 'scrape.max.history': val }); } catch {}
    const r: any = await sendBg('scrape/history', { max: val } as any);
    if (!r?.ok) alert(r?.error || 'Failed');
    await loadScrapeStatus();
    await load();
  }
  async function runAll() {
    const r: any = await sendBg('scrape/runAll', {} as any);
    if (!r?.ok) alert(r?.error || 'Failed');
    await loadScrapeStatus();
    await load();
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
          {running ? <span className="muted">Running: {mode || '–'} • Seen: {seen}</span> : <span className="muted">Idle</span>}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
          <button onClick={runAll} disabled={running}>Run all</button>
          <button onClick={runSubFeed} disabled={running}>Scrape Sub Feed</button>
          <button onClick={runSubscriptionsManager} disabled={running}>Scrape Subscriptions Manager</button>
          <button onClick={runHistory} disabled={running}>Scrape Watch History</button>
          <button className="btn-danger" onClick={stopAll} disabled={!running}>Stop</button>
        </div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
          <label className="muted">Max Sub Feed videos</label>
          <input className="side-input" type="number" value={subFeedMaxInput} onChange={(e)=> setSubFeedMaxInput(e.currentTarget.value)} style={{ width: '4ch' }} />
          <label className="muted">Max History items</label>
          <input className="side-input" type="number" value={historyMaxInput} onChange={(e)=> setHistoryMaxInput(e.currentTarget.value)} style={{ width: '5ch' }} />
          <label className="muted" title="When enabled, VIDEO_STUB upserts are treated as VIDEO_SEEN (no stub rows)." style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={noStubs} onChange={toggleNoStubs} /> Debug: No stubs
          </label>
          <label className="muted" title="Stop when the previously marked most recent Sub Feed item appears (for incremental scrapes)." style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={stopAtPrevSubFeed} onChange={toggleStopAtPrevSubFeed} /> Sub Feed: stop at previous most recent video
          </label>
          <label className="muted" title="Stop when the previously marked most recent Watch History item appears (for incremental scrapes)." style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={stopAtPrevHistory} onChange={toggleStopAtPrevHistory} /> History: stop at previous most recent video
          </label>
        </div>
        <div className="muted" style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
          <span>Last run (any): {tsLabel(lastRun['scrape.lastRun.any'])}</span>
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
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <label className="muted">Batch size</label>
        <input className="side-input" type="number" min={1} max={20} value={batch} onChange={(e)=> setBatch(Math.max(1, Math.min(20, parseInt(e.currentTarget.value || '5', 10))))} style={{ width: '3ch' }} />
        <button className="btn-ghost" onClick={()=>toggleResolveLoop()} disabled={handles === 0}>{resolving ? 'Stop resolving' : 'Resolve handles (open tabs)'}</button>
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
              <th style={{ textAlign: 'right', padding: '6px 8px', width: 28 }} aria-label="Delete" title="Delete pending entry" />
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
                  <td style={{ padding: '2px 6px', textAlign: 'right' }}>
                    <button
                      type="button"
                      className="btn-ghost"
                      aria-label="Delete pending entry"
                      title="Delete pending entry"
                      onClick={async () => { await sendBg('channels/pending/delete', { key: it.key }); await load(); }}
                      style={{ padding: 0, width: 20, height: 20, lineHeight: '18px', textAlign: 'center' }}
                    >
                      ×
                    </button>
                  </td>
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

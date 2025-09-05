import React from 'react';
import { send as sendBg } from '../../lib/messaging';
import { getOne as idbGetOne } from '../../lib/idb';

type Commit = { commitId: string; ts: number; summary: string; weight: number; size: number; counts: { events: number; videos?: number; channels?: number; tags?: number; groups?: number } };

type Props = { open: boolean; onClose: () => void };

export default function HistoryModal({ open, onClose }: Props) {
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [commits, setCommits] = React.useState<Commit[]>([]);
  const [usage, setUsage] = React.useState<{ totalBytes: number; files: number } | null>(null);
  const [openCommit, setOpenCommit] = React.useState<string | null>(null);
  const [commitEvents, setCommitEvents] = React.useState<Record<string, any[]>>({});
  const [showAllIds, setShowAllIds] = React.useState<Record<string, boolean>>({}); // key: `${commitId}:${idx}`
  const [fullDiffs, setFullDiffs] = React.useState<boolean>(false);

  React.useEffect(() => {
    if (!open) return;
    (async () => {
      setLoading(true); setError(null);
      try {
        const u: any = await sendBg('backup/history/usage', {} as any);
        if (u?.ok) setUsage({ totalBytes: u.totalBytes | 0, files: u.files | 0 });
      } catch {}
      try {
        const r: any = await sendBg('backup/history/list', { limit: 200 } as any);
        const list: Commit[] = Array.isArray(r?.commits) ? r.commits : [];
        setCommits(list);
      } catch (e: any) { setError(e?.message || String(e)); }
      setLoading(false);
    })();
  }, [open]);

  async function downloadCommit(commitId: string) {
    try {
      const r: any = await sendBg('backup/history/getCommit', { commitId } as any);
      if (!r?.ok || !r?.contentB64) { alert(`Download failed: ${r?.error || 'unknown'}`); return; }
      const bin = atob(String(r.contentB64));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: r?.mimeType || 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = r?.name || `commit-${commitId}.jsonl`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 500);
    } catch (e: any) { alert(`Download failed: ${e?.message || e}`); }
  }

  async function downloadUpTo(commitId: string) {
    try {
      const r: any = await sendBg('backup/history/getUpTo', { commitId } as any);
      if (!r?.ok || !Array.isArray(r?.files)) { alert(`Bundle failed: ${r?.error || 'unknown'}`); return; }
      const files = (r.files as Array<{ name: string; contentB64: string }>)
        .map(f => ({ name: f.name, data: b64ToBytes(f.contentB64) }));
      const zip = buildZip(files);
      const a = document.createElement('a');
      // Ensure ArrayBuffer to satisfy BlobPart typing under TS 5.9
      const ab = new ArrayBuffer(zip.byteLength); new Uint8Array(ab).set(zip);
      a.href = URL.createObjectURL(new Blob([ab], { type: 'application/zip' }));
      a.download = `history-up-to-${commitId}.zip`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 500);
    } catch (e: any) { alert(`Bundle failed: ${e?.message || e}`); }
  }

  async function deleteUpToCommit(c: Commit) {
    // Preflight: warn if there is no snapshot with modifiedTime <= this commit ts
    try {
      const filesResp: any = await sendBg('backup/listFiles', {} as any);
      const files = Array.isArray(filesResp?.items) ? filesResp.items as Array<{ name: string; modifiedTime?: string | null }> : [];
      const hasBaseline = files.some(f => (f.name || '').startsWith('snapshots/') && (Date.parse(String(f.modifiedTime || '')) || 0) <= (c.ts || 0));
      const msg = hasBaseline
        ? 'Delete Drive history up to this commit? Make sure you downloaded it first.'
        : 'Warning: No baseline snapshot exists before this commit. Deleting will make it impossible to revert to commits near this cutoff. Proceed to delete?';
      if (!confirm(msg)) return;
    } catch {}
    try {
      const r: any = await sendBg('backup/history/deleteUpTo', { commitId: c.commitId } as any);
      if (!r?.ok) { alert(`Delete failed: ${r?.error || 'unknown'}`); return; }
      // refresh
      try { const u: any = await sendBg('backup/history/usage', {} as any); if (u?.ok) setUsage({ totalBytes: u.totalBytes | 0, files: u.files | 0 }); } catch {}
      try { const rr: any = await sendBg('backup/history/list', { limit: 200 } as any); setCommits(Array.isArray(rr?.commits) ? rr.commits : []); } catch {}
    } catch (e: any) { alert(`Delete failed: ${e?.message || e}`); }
  }

  async function revertTo(commitId: string, mode: 'dryRun' | 'apply') {
    try {
      const r: any = await sendBg('backup/history/revertTo', { commitId, dryRun: mode === 'dryRun' } as any);
      if (!r?.ok) { alert(`Revert failed: ${r?.error || 'unknown'}`); return; }
      const summary = r?.summary || r;
      alert(`Revert ${mode === 'dryRun' ? 'preview' : 'applied'}:\n` + JSON.stringify(summary?.counts || summary, null, 2));
    } catch (e: any) {
      alert(`Revert failed: ${e?.message || e}`);
    }
  }

  async function toggleDetails(commitId: string) {
    setOpenCommit(prev => (prev === commitId ? null : commitId));
    if (commitEvents[commitId]) return;
    try {
      const r: any = await sendBg('backup/history/getCommit', { commitId } as any);
      if (!r?.ok || !r?.contentB64) return;
      const text = atob(String(r.contentB64));
      const lines = text.split('\n').filter(l => l.trim());
      const events: any[] = [];
      for (const line of lines) {
        try { events.push(JSON.parse(line)); } catch {}
      }
      // Resolve some names for display (best effort)
      for (const ev of events) {
        const kind = String(ev?.kind || '');
        const p = ev?.payload || {};
        const ids: string[] = Array.isArray(p?.ids) ? p.ids : (p?.id ? [p.id] : []);
        if (!ids.length) continue;
        const labels: string[] = [];
        for (const id of ids) {
          try {
            const v = await idbGetOne<any>('videos', id);
            if (v && (v.title || v.channelName)) { labels.push(v.title ? `${v.title}` : (v.channelName || id)); continue; }
          } catch {}
          try {
            const c = await idbGetOne<any>('channels', id);
            if (c && c.name) { labels.push(c.name); continue; }
          } catch {}
          labels.push(id);
        }
        (ev as any)._labels = labels;
      }
      setCommitEvents(prev => ({ ...prev, [commitId]: events }));
    } catch {}
  }

  if (!open) return null;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 99999 }}>
      <div style={{ background: '#111', color: '#eee', border: '1px solid #333', borderRadius: 6, width: 1100, maxWidth: '98vw', maxHeight: '85vh', overflow: 'auto', padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Version History</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input id="history-import" type="file" multiple style={{ display: 'none' }} accept=".json,.jsonl" />
            <button className="btn-ghost" onClick={async () => {
              const el = document.getElementById('history-import') as HTMLInputElement | null;
              if (!el) return;
              el.onchange = async (e: any) => {
                try {
                  const files = (e?.target?.files || []) as FileList;
                  if (!files || files.length === 0) return;
                  const list: Array<{ name: string; contentB64: string }> = [];
                  for (let i = 0; i < files.length; i++) { const f = files[i]; const text = await f.text(); list.push({ name: f.name, contentB64: btoa(text) }); }
                  const r: any = await sendBg('backup/history/import', { files: list } as any);
                  if (!r?.ok) { alert(`Import failed: ${r?.error || 'unknown'}`); return; }
                  alert('Import complete. Refreshing…');
                  try { const u: any = await sendBg('backup/history/usage', {} as any); if (u?.ok) setUsage({ totalBytes: u.totalBytes | 0, files: u.files | 0 }); } catch {}
                  try { const rr: any = await sendBg('backup/history/list', { limit: 200 } as any); setCommits(Array.isArray(rr?.commits) ? rr.commits : []); } catch {}
                } finally { try { (e?.target as HTMLInputElement).value = ''; } catch {} }
              };
              el.click();
            }}>Reattach (Import)</button>
            <button className="btn-ghost" onClick={async ()=>{
              try {
                
                const r: any = await sendBg('backup/history/snapshotNow', { interactive: true } as any);
                if (!r?.ok) { alert(`Snapshot failed: ${r?.error || 'unknown'}`); return; }
                alert(`Snapshot saved: ${r?.name || 'snapshots/settings-*.json'}`);
              } catch (e: any) {
                alert(`Snapshot failed: ${e?.message || e}`);
              }
            }}>Snapshot now</button>
            <label className="muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <input type="checkbox" checked={fullDiffs} onChange={(e)=> setFullDiffs(e.currentTarget.checked)} /> Full diffs
            </label>
            <button className="btn-ghost" onClick={onClose}>Close</button>
          </div>
        </div>
        {usage && (
          <div className="muted" style={{ marginBottom: 8 }}>Drive usage (appDataFolder): {formatBytes(usage.totalBytes)} across {usage.files} files</div>
        )}
        {loading ? (<div className="muted">Loading…</div>) : error ? (<div className="muted" style={{ color: '#f66' }}>{error}</div>) : (
          <div>
            {commits.length === 0 && <div className="muted">No commits yet.</div>}
            {commits.map((c) => (
              <div key={c.commitId} style={{ padding: '6px 0', borderBottom: '1px solid #222' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: 8 }}>
                  <div style={{ fontWeight: 600 }}>{new Date(c.ts).toLocaleString()} — {c.summary}</div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    weight {c.weight} • size {formatBytes(c.size)} • events {c.counts.events}{c.counts.videos?` • videos ${c.counts.videos}`:''}{c.counts.channels?` • channels ${c.counts.channels}`:''}{c.counts.tags?` • tags ${c.counts.tags}`:''}{c.counts.groups?` • groups ${c.counts.groups}`:''}
                  </div>
                  <button className="btn-ghost" onClick={() => toggleDetails(c.commitId)}>{openCommit === c.commitId ? 'Hide' : 'Details'}</button>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button className="btn-ghost" onClick={() => downloadCommit(c.commitId)}>Download commit</button>
                  <button className="btn-ghost" onClick={() => downloadUpTo(c.commitId)}>Download up to here</button>
                  <button className="btn-ghost" onClick={() => deleteUpToCommit(c)}>Delete up to here</button>
                  <button className="btn-ghost" onClick={() => revertTo(c.commitId, 'dryRun')}>Revert (dry‑run)</button>
                  <button className="btn-ghost" onClick={() => revertTo(c.commitId, 'apply')}>Revert (apply)</button>
                </div>
                </div>
                {openCommit === c.commitId && (
                  <div style={{ marginTop: 8 }}>
                    {(commitEvents[c.commitId] || []).slice(0, 100).map((ev, idx) => {
                      const key = `${c.commitId}:${idx}`;
                      const labels: string[] = Array.isArray(ev._labels) ? ev._labels : [];
                      const idsTotal = Array.isArray(ev?.payload?.ids) ? ev.payload.ids.length : (ev?.payload?.id ? 1 : 0);
                      const showAll = !!showAllIds[key];
                      const shown = showAll ? labels : labels.slice(0, 10);
                      const hasMore = labels.length > shown.length;
                      const isAttr = String(ev?.kind || '').endsWith('attrChanged');
                      const changed = ev?.payload?.changed || null;
                      const previewLocal = (s: string) => (fullDiffs ? s : preview(s));
                      const copy = async (text: string) => { try { await navigator.clipboard?.writeText(text); } catch { /* ignore */ } };
                      return (
                        <div key={idx} style={{ marginBottom: 8 }}>
                          <div className="muted" style={{ fontSize: 12, marginBottom: 2 }}>
                            <span style={{ color: '#bcd' }}>{ev.kind}</span>
                            {shown.length > 0 && (<span> — {shown.join(', ')}{hasMore?` (+${labels.length-shown.length} more)`:''}</span>)}
                            {labels.length > 10 && (
                              <button className="btn-ghost" style={{ marginLeft: 8, padding: '2px 6px' }} onClick={() => setShowAllIds(prev => ({ ...prev, [key]: !prev[key] }))}>
                                {showAll ? 'Show less' : 'Show all'}
                              </button>
                            )}
                          </div>
                          {isAttr && changed && (
                            <div style={{ paddingLeft: 8 }}>
                              {Object.keys(changed).map((k) => (
                                <div key={k} className="muted" style={{ fontSize: 12 }}>
                                  <span style={{ color: '#8ad' }}>{k}:</span>{' '}
                                  <span title={String(changed[k]?.from ?? '')}>{previewLocal(String(changed[k]?.from ?? ''))}</span>
                                  <button className="btn-ghost" style={{ marginLeft: 6, padding: '1px 6px' }} onClick={() => copy(String(changed[k]?.from ?? ''))}>Copy</button>
                                  {' '}→{' '}
                                  <span title={String(changed[k]?.to ?? '')}>{previewLocal(String(changed[k]?.to ?? ''))}</span>
                                  <button className="btn-ghost" style={{ marginLeft: 6, padding: '1px 6px' }} onClick={() => copy(String(changed[k]?.to ?? ''))}>Copy</button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return '';
  const u = ['B','KB','MB','GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || v % 1 === 0 ? 0 : 1)} ${u[i]}`;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Minimal ZIP builder (store only, no compression)
function crc32(bytes: Uint8Array): number {
  let c = 0 ^ -1;
  for (let i = 0; i < bytes.length; i++) {
    c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]) & 0xFF];
  }
  return (c ^ -1) >>> 0;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function buildZip(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const enc = new TextEncoder();
  const records: Array<{ local: Uint8Array; central: Uint8Array; data: Uint8Array }> = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;
    const local = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true); // local file header signature
    view.setUint16(4, 20, true); // version needed
    view.setUint16(6, 0, true); // flags
    view.setUint16(8, 0, true); // compression method = 0 (store)
    view.setUint16(10, 0, true); // mod time
    view.setUint16(12, 0, true); // mod date
    view.setUint32(14, crc, true);
    view.setUint32(18, size, true);
    view.setUint32(22, size, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true); // extra len
    local.set(nameBytes, 30);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); // central dir header
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0, true); // flags
    cv.setUint16(10, 0, true); // method
    cv.setUint16(12, 0, true); // time
    cv.setUint16(14, 0, true); // date
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra len
    cv.setUint16(32, 0, true); // comment len
    cv.setUint16(34, 0, true); // disk number start
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, offset, true); // relative offset to local header
    central.set(nameBytes, 46);

    records.push({ local, central, data: f.data });
    offset += local.length + f.data.length;
  }
  // Concat all
  let centralSize = 0;
  for (const r of records) centralSize += r.central.length;
  const endCD = new Uint8Array(22);
  const ev = new DataView(endCD.buffer);
  ev.setUint32(0, 0x06054b50, true); // end of central dir signature
  ev.setUint16(4, 0, true); // number of this disk
  ev.setUint16(6, 0, true); // disk where central directory starts
  ev.setUint16(8, records.length, true); // number of central records on this disk
  ev.setUint16(10, records.length, true); // total number of central records
  ev.setUint32(12, centralSize, true); // size of central directory
  ev.setUint32(16, offset, true); // offset of central directory
  ev.setUint16(20, 0, true); // comment length

  let totalSize = offset + centralSize + endCD.length;
  const out = new Uint8Array(totalSize);
  let p = 0;
  for (const r of records) { out.set(r.local, p); p += r.local.length; out.set(r.data, p); p += r.data.length; }
  for (const r of records) { out.set(r.central, p); p += r.central.length; }
  out.set(endCD, p);
  return out;
}

function preview(s: string): string {
  if (!s) return '';
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > 120 ? clean.slice(0, 120) + '…' : clean;
}

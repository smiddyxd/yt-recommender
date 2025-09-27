import React from 'react';
import { send as sendBg } from '../../lib/messaging';

type FileEntry = { id: string; name: string; size?: number | null; modifiedTime?: string | null; createdTime?: string | null };

type Props = {
  open: boolean;
  onClose: () => void;
};

export default function BackupModal({ open, onClose }: Props) {
  try { if (open) console.log('[UI] BackupModal open'); } catch {}
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [files, setFiles] = React.useState<FileEntry[]>([]);
  const [driveEnabled, setDriveEnabled] = React.useState<boolean>(true);
  const [localEnabled, setLocalEnabled] = React.useState<boolean>(true);
  const [lastDriveUploadAt, setLastDriveUploadAt] = React.useState<number | null>(null);
  const [lastLocalDownloadAt, setLastLocalDownloadAt] = React.useState<number | null>(null);
  const [usage, setUsage] = React.useState<{ files: number; totalBytes: number }>({ files: 0, totalBytes: 0 });
  const [lastTickAt, setLastTickAt] = React.useState<number | null>(null);

  React.useEffect(() => {
    if (!open) return;
    (async () => {
      setLoading(true); setError(null);
      try {
        try {
          const cfg: any = await sendBg('backup/config/get', {} as any);
          if (cfg?.ok) {
            setDriveEnabled(!!cfg.driveEnabled);
            setLocalEnabled(!!cfg.localEnabled);
            setLastDriveUploadAt(cfg.lastDriveUploadAt ?? null);
            setLastLocalDownloadAt(cfg.lastLocalDownloadAt ?? null);
            setLastTickAt(cfg.lastTickAt ?? null);
          }
        } catch {}
        const r: any = await sendBg('backup/listFiles', {} as any);
        const items: FileEntry[] = Array.isArray(r?.items) ? r.items : [];
        setFiles(items);
        try { const u: any = await sendBg('backup/history/usage', {} as any); if (u?.ok) setUsage({ files: u.files || 0, totalBytes: u.totalBytes || 0 }); } catch {}
      } catch (e: any) {
        setError(e?.message || String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [open]);

  async function saveConfig(nextDrive: boolean, nextLocal: boolean) {
    try { await sendBg('backup/config/set', { driveEnabled: nextDrive, localEnabled: nextLocal } as any); }
    catch {}
  }

  async function runBackupNow() {
    try {
      setLoading(true); setError(null);
      const r: any = await sendBg('backup/runNow', {} as any);
      if (!r?.ok) throw new Error(r?.error || 'Backup failed');
      // Refresh timestamps and usage list
      try {
        const cfg: any = await sendBg('backup/config/get', {} as any);
        if (cfg?.ok) {
          setLastDriveUploadAt(cfg.lastDriveUploadAt ?? null);
          setLastLocalDownloadAt(cfg.lastLocalDownloadAt ?? null);
          setLastTickAt(cfg.lastTickAt ?? null);
        }
      } catch {}
      try { const rr: any = await sendBg('backup/listFiles', {} as any); setFiles(Array.isArray(rr?.items) ? rr.items : []); } catch {}
      try { const u: any = await sendBg('backup/history/usage', {} as any); if (u?.ok) setUsage({ files: u.files || 0, totalBytes: u.totalBytes || 0 }); } catch {}
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally { setLoading(false); }
  }

  async function download(id: string, suggestedName?: string | null) {
    try {
      const r: any = await sendBg('backup/downloadFile', { id } as any);
      if (!r?.ok || !r?.contentB64) { alert(`Download failed: ${r?.error || 'unknown'}`); return; }
      const contentB64 = String(r.contentB64);
      const bin = atob(contentB64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const ab = new ArrayBuffer(bytes.byteLength); new Uint8Array(ab).set(bytes);
      const blob = new Blob([ab], { type: r?.mimeType || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = suggestedName || r?.name || 'backup.bin';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e: any) {
      alert(`Download failed: ${e?.message || e}`);
    }
  }

  if (!open) return null;

  async function downloadAllZip() {
    try {
      setLoading(true); setError(null);
      // Ensure we have latest list
      let list = files;
      if (!list || !list.length) {
        const r: any = await sendBg('backup/listFiles', {} as any);
        list = Array.isArray(r?.items) ? r.items : [];
      }
      const parts: Array<{ name: string; data: Uint8Array }> = [];
      for (const f of list) {
        try {
          const r: any = await sendBg('backup/downloadFile', { id: f.id } as any);
          if (!r?.ok || !r?.contentB64) continue;
          parts.push({ name: String(f.name || r?.name || f.id), data: b64ToBytes(String(r.contentB64)) });
        } catch {}
      }
      const zip = buildZip(parts);
      const a = document.createElement('a');
      const ts = new Date().toISOString().replace(/[:.]/g, '').replace('T','-').slice(0, 15);
      // Ensure ArrayBuffer to satisfy BlobPart typing under TS 5.9
      const ab = new ArrayBuffer(zip.byteLength); new Uint8Array(ab).set(zip);
      a.href = URL.createObjectURL(new Blob([ab], { type: 'application/zip' }));
      a.download = `drive-appData-${ts}.zip`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 500);
    } catch (e: any) {
      alert(`Download all failed: ${e?.message || e}`);
    } finally {
      setLoading(false);
    }
  }

  async function wipeAll() {
    try {
      const c1 = confirm('This will delete ALL files in your Google Drive appDataFolder for this app. Download a backup first. Continue?');
      if (!c1) return;
      const c2 = confirm('Last warning: this is irreversible. Delete all now?');
      if (!c2) return;
      setLoading(true); setError(null);
      const r: any = await sendBg('backup/wipeAll', {} as any);
      if (!r?.ok) { alert(`Wipe failed: ${r?.error || 'unknown'}`); return; }
      // Reload list
      try {
        const rr: any = await sendBg('backup/listFiles', {} as any);
        const items: FileEntry[] = Array.isArray(rr?.items) ? rr.items : [];
        setFiles(items);
      } catch {}
    } catch (e: any) {
      alert(`Wipe failed: ${e?.message || e}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 99999 }}>
      <div style={{ background: '#111', color: '#eee', border: '1px solid #333', borderRadius: 6, width: 600, maxWidth: '95vw', maxHeight: '80vh', overflow: 'auto', padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Backups</h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-ghost" onClick={runBackupNow} disabled={loading}>Backup</button>
            <button className="btn-ghost" onClick={downloadAllZip} disabled={loading || (files.length === 0)}>Download All (zip)</button>
            <button className="btn-ghost" onClick={wipeAll} disabled={loading}>Wipe All</button>
            <button className="btn-ghost" onClick={onClose}>Close</button>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 8 }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={driveEnabled} onChange={(e)=>{ const v=e.currentTarget.checked; setDriveEnabled(v); saveConfig(v, localEnabled); }} />
            <span>Hourly upload to Drive</span>
          </label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={localEnabled} onChange={(e)=>{ const v=e.currentTarget.checked; setLocalEnabled(v); saveConfig(driveEnabled, v); }} />
            <span>Hourly local download</span>
          </label>
          <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
            Drive files: {usage.files} • {formatBytes(usage.totalBytes)}
          </span>
        </div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          {lastDriveUploadAt ? `Last Drive upload: ${new Date(lastDriveUploadAt).toLocaleString()}` : 'Last Drive upload: (never)'}
          {'  '}•{'  '}
          {lastLocalDownloadAt ? `Last local download: ${new Date(lastLocalDownloadAt).toLocaleString()}` : 'Last local download: (never)'}
          {'  '}•{'  '}
          {lastTickAt ? `Last hourly tick: ${new Date(lastTickAt).toLocaleString()}` : 'Last hourly tick: (unknown)'}
        </div>
        {loading ? (
          <div className="muted">Loading...</div>
        ) : error ? (
          <div className="muted" style={{ color: '#f66' }}>{error}</div>
        ) : (
          <div>
            {files.length === 0 && <div className="muted">No files found.</div>}
            {files.map((f) => (
              <div key={f.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #222' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{f.name || '(unnamed)'}</div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {f.modifiedTime ? new Date(f.modifiedTime).toLocaleString() : ''}
                    {typeof f.size === 'number' ? `  ${formatBytes(f.size)}` : ''}
                  </div>
                </div>
                <button className="btn-ghost" onClick={() => download(f.id, f.name)}>Download</button>
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

// Helpers for building a simple ZIP (store only, no compression)
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) out[i] = bin.charCodeAt(i);
  return out;
}

function crc32(bytes: Uint8Array): number {
  let c = 0 ^ -1;
  for (let i = 0; i < bytes.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]) & 0xFF];
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
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, size, true);
    view.setUint32(22, size, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);

    records.push({ local, central, data: f.data });
    offset += local.length + f.data.length;
  }
  // Build central directory
  let centralSize = 0;
  for (const r of records) centralSize += r.central.length;
  const endCD = new Uint8Array(22);
  const ev = new DataView(endCD.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, records.length, true);
  ev.setUint16(10, records.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const totalSize = offset + centralSize + endCD.length;
  const out = new Uint8Array(totalSize);
  let p = 0;
  for (const r of records) { out.set(r.local, p); p += r.local.length; out.set(r.data, p); p += r.data.length; }
  for (const r of records) { out.set(r.central, p); p += r.central.length; }
  out.set(endCD, p);
  return out;
}

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

  React.useEffect(() => {
    if (!open) return;
    (async () => {
      setLoading(true); setError(null);
      try {
        const r: any = await sendBg('backup/listFiles', {} as any);
        const items: FileEntry[] = Array.isArray(r?.items) ? r.items : [];
        setFiles(items);
      } catch (e: any) {
        setError(e?.message || String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [open]);

  async function download(id: string, suggestedName?: string | null) {
    try {
      const r: any = await sendBg('backup/downloadFile', { id } as any);
      if (!r?.ok || !r?.contentB64) { alert(`Download failed: ${r?.error || 'unknown'}`); return; }
      const contentB64 = String(r.contentB64);
      const bin = atob(contentB64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: r?.mimeType || 'application/octet-stream' });
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

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 99999 }}>
      <div style={{ background: '#111', color: '#eee', border: '1px solid #333', borderRadius: 6, width: 600, maxWidth: '95vw', maxHeight: '80vh', overflow: 'auto', padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Backups (appDataFolder)</h2>
          <button className="btn-ghost" onClick={onClose}>Close</button>
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

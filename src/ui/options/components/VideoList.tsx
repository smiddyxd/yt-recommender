// src/ui/options/components/VideoList.tsx
import React, { useState } from 'react';
import { fmtDate, secToClock, thumbUrl, watchUrl } from '../../lib/format';

type Video = {
  id: string;
  title?: string | null;
  channelName?: string | null;
  durationSec?: number | null;
  uploadedAt?: number | null;
  uploadedText?: string | null;
  lastSeenAt?: number;
  flags?: { started?: boolean; completed?: boolean };
  tags?: string[];
};

type Props = {
  items: Video[];
  layout: 'grid' | 'list';
  loading: boolean;
  selected: Set<string>;
  onToggle: (id: string)=>void;
};

export default function VideoList({ items, layout, loading, selected, onToggle }: Props) {
  const [openDebug, setOpenDebug] = useState<Set<string>>(new Set());
  const toggleDebug = (id: string) => {
    setOpenDebug(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  return (
    <main id="list" aria-live="polite" data-layout={layout}>
      {items.map(v => {
        const isSelected = selected.has(v.id);
        return (
          <article className={`card${isSelected ? ' selected' : ''}`} key={v.id}>
            <label className="select">
              <input type="checkbox" checked={isSelected} onChange={() => onToggle(v.id)} aria-label="Select video" />
            </label>
            <img
              className="thumb toggle-select"
              loading="lazy"
              src={thumbUrl(v.id)}
              alt={v.title || 'thumbnail'}
              draggable={false}
              onClick={() => onToggle(v.id)}
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(v.id); } }}
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
                  v.uploadedAt ? fmtDate(v.uploadedAt) : (v.uploadedText || '')
                ].filter(Boolean).join(' • ')}
              </div>
              <div className="badges">
                {v.flags?.started && <span className="badge">started</span>}
                {v.flags?.completed && <span className="badge">completed</span>}
                {v.tags && v.tags.length > 0 && <span className="badge">{v.tags.join(', ')}</span>}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <button
                  type="button"
                  className="btn-ghost debug-btn"
                  onClick={() => toggleDebug(v.id)}
                  aria-expanded={openDebug.has(v.id)}
                  title={openDebug.has(v.id) ? 'Hide stored data' : 'Show stored data'}
                >
                  {openDebug.has(v.id) ? 'Hide info' : 'Show info'}
                </button>
              </div>
              {openDebug.has(v.id) && (
                <div className="debug-panel" role="region" aria-label="Stored data">
                  <div className="debug-panel-head">
                    <span>Stored data</span>
                    <button className="debug-close" onClick={() => toggleDebug(v.id)} title="Close">×</button>
                  </div>
                  <pre className="debug-pre">{JSON.stringify(v as any, null, 2)}</pre>
                </div>
              )}
            </div>
          </article>
        );
      })}
      {!loading && items.length === 0 && (
        <div style={{ padding: 16, color: 'var(--muted)' }}>No videos match your search.</div>
      )}
    </main>
  );
}

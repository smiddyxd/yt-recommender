// src/ui/options/components/VideoList.tsx
import React from 'react';
import { fmtDate, secToClock, thumbUrl, watchUrl } from '../../lib/format';

type Video = {
  id: string;
  title?: string | null;
  channelName?: string | null;
  durationSec?: number | null;
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
                {[v.channelName || '(unknown channel)', secToClock(v.durationSec), fmtDate(v.lastSeenAt)]
                  .filter(Boolean).join(' • ')}
              </div>
              <div className="badges">
                {v.flags?.started && <span className="badge">started</span>}
                {v.flags?.completed && <span className="badge">completed</span>}
                {v.tags && v.tags.length > 0 && <span className="badge">{v.tags.join(', ')}</span>}
              </div>
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

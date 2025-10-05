// src/ui/options/components/VideoList.tsx
import React, { useMemo, useState } from 'react';
import { fmtDate, secToClock, thumbUrl, watchUrl } from '../../lib/format';
import { getOne as idbGetOne } from '../../lib/idb';
import type { TagGroupRec, TagRec, CollectionRec } from '../../../types/messages';
import { toHex6, darken, textColorBW } from '../../lib/colors';

type Video = {
  id: string;
  title?: string | null;
  channelName?: string | null;
  durationSec?: number | null;
  uploadedAt?: number | null;
  channelId?: string | null;
  flags?: { started?: boolean; completed?: boolean };
  tags?: string[];
  progressSec?: number | null;
};

type Props = {
  items: Video[];
  layout: 'grid' | 'list';
  loading: boolean;
  selected: Set<string>;
  onToggle: (id: string)=>void;
  tagGroups?: TagGroupRec[];
  tagsRegistry?: TagRec[];
  variant?: 'manager' | 'compact';
  collections?: CollectionRec[];
  chipsById?: Record<string, string[]>;
};

export default function VideoList({ items, layout, loading, selected, onToggle, tagGroups = [], tagsRegistry = [], variant = 'manager', collections = [], chipsById = {} }: Props) {
  const [openDebug, setOpenDebug] = useState<Set<string>>(new Set());
  const [fullData, setFullData] = useState<Record<string, any>>({});
  const groupById = useMemo(() => new Map<string, TagGroupRec>(tagGroups.map(g => [g.id, g] as [string, TagGroupRec])), [tagGroups]);
  const tagReg = useMemo(() => new Map<string, TagRec>(tagsRegistry.map(t => [t.name, t] as [string, TagRec])), [tagsRegistry]);
  const collById = useMemo(() => new Map<string, CollectionRec>(collections.map(c => [c.id, c] as [string, CollectionRec])), [collections]);
  const getParentColor = (tag: string): { bg?: string; fg?: string; br?: string } => {
    const t = tagReg.get(tag);
    const gid = (t?.groupId || '') as string;
    const g = gid ? groupById.get(gid) : undefined;
    const parent = g ? (g.parentId ? groupById.get(String(g.parentId)) || g : g) : undefined;
    const bg = parent?.color ? toHex6(parent.color) : null;
    if (!bg) return {};
    return { bg, fg: textColorBW(bg || undefined), br: darken(bg, 0.25) } as any;
  };
  const toggleDebug = (id: string) => {
    setOpenDebug(prev => {
      const next = new Set(prev);
      const willOpen = !next.has(id);
      if (next.has(id)) next.delete(id); else next.add(id);
      // lazy-load full row for debug view
      if (willOpen && !fullData[id]) {
        idbGetOne('videos', id).then((row) => {
          if (row) setFullData(fd => ({ ...fd, [id]: row }));
        }).catch(() => void 0);
      }
      return next;
    });
  };
  // Relative time updates every minute for compact variant
  const [now, setNow] = useState(Date.now());
  React.useEffect(() => {
    if (variant !== 'compact') return;
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [variant]);

  const relTime = (ts?: number | null) => {
    if (!ts) return '';
    const ms = now - ts;
    const min = Math.floor(ms / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min} minute${min===1?'':'s'} ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} hour${hr===1?'':'s'} ago`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day} day${day===1?'':'s'} ago`;
    return new Date(ts).toLocaleDateString();
  };
  const fmtViews = (n?: number | null) => {
    if (!Number.isFinite(n as any)) return '';
    try { return `${(n as number).toLocaleString()} views`; } catch { return `${n} views`; }
  };

  return (
    <main id="list" aria-live="polite" data-layout={layout} data-variant={variant}>
      {items.map(v => {
        const isSelected = selected.has(v.id);
        if (variant === 'compact') {
          return (
            <article className={`card yt-compact${isSelected ? ' selected' : ''}`} key={v.id}>
              <label className="select">
                <input type="checkbox" checked={isSelected} onChange={() => onToggle(v.id)} aria-label="Select video" />
              </label>
              <img className="thumb toggle-select" loading="lazy" src={thumbUrl(v.id)} alt={v.title || 'thumbnail'} draggable={false} onClick={() => onToggle(v.id)} />
              <div className="ytc-body">
                <h3 className="title two-line">
                  <a href={watchUrl(v.id)} target="_blank" rel="noopener noreferrer">{v.title || '(no title)'}</a>
                </h3>
                {/* Chips (e.g., recommender: from preset, hints) */}
                {Array.isArray(chipsById[v.id]) && chipsById[v.id].length > 0 && (
                  <div className="meta">
                    {chipsById[v.id].map((c, i) => (<span key={`chip-${i}`} className="badge">{c}</span>))}
                  </div>
                )}
                <div className="meta">
                  {v.channelId ? (
                    <a href={`https://www.youtube.com/channel/${v.channelId}`} target="_blank" rel="noopener noreferrer">{v.channelName || '(unknown channel)'}</a>
                  ) : (
                    <span>{v.channelName || '(unknown channel)'}</span>
                  )}
                </div>
                <div className="meta">
                  {fmtViews((v as any).views)}{(v as any).views ? <span> · </span> : null}
                  <span>{secToClock(v.durationSec)}</span>
                  {v.uploadedAt ? (<><span> · </span><span>{relTime(v.uploadedAt)}</span></>) : null}
                </div>
              </div>
            </article>
          );
        }
        // Manager (original) variant
        return (
          <article className={`card${isSelected ? ' selected' : ''}`} key={v.id}>
            <label className="select">
              <input type="checkbox" checked={isSelected} onChange={() => onToggle(v.id)} aria-label="Select video" />
            </label>
            <img className="thumb toggle-select" loading="lazy" src={thumbUrl(v.id)} alt={v.title || 'thumbnail'} draggable={false} onClick={() => onToggle(v.id)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(v.id); } }} />
            <div>
              <h3 className="title">
                {(() => {
                  const t = (typeof v.progressSec === 'number' && v.progressSec > 0) ? v.progressSec : (v.flags?.started ? 1 : undefined);
                  const href = watchUrl(v.id, t);
                  return (
                    <a href={href} target="_blank" rel="noopener noreferrer">{v.title || '(no title)'}</a>
                  );
                })()}
              </h3>
              <div className="meta">
                {(() => {
                  const nodes: React.ReactNode[] = [];
                  const chName = v.channelName || '(unknown channel)';
                  if (v.channelId) nodes.push(<a key="ch" href={`https://www.youtube.com/channel/${v.channelId}`} target="_blank" rel="noopener noreferrer">{chName}</a>);
                  else nodes.push(<span key="ch">{chName}</span>);
                  nodes.push(<span key="dur">{secToClock(v.durationSec)}</span>);
                  if (v.uploadedAt) nodes.push(<span key="up">{fmtDate(v.uploadedAt)}</span>);
                  return nodes.map((node, i) => (<React.Fragment key={`p-${i}`}>{i > 0 && <span> · </span>}{node}</React.Fragment>));
                })()}
              </div>
              <div className="badges">
                {v.flags?.started && <span className="badge">started</span>}
                {v.flags?.completed && <span className="badge">completed</span>}
                {Array.isArray(v.tags) && v.tags.length > 0 && (
                  <>{v.tags.map(tag => { const c = getParentColor(tag); return (<span key={tag} className="badge" style={{ background: c.bg, color: c.fg, border: c.br ? `1px solid ${c.br}` : undefined }}>{tag}</span>); })}</>
                )}
                {Array.isArray((v as any).collectionIds) && ((v as any).collectionIds as string[]).length > 0 && (
                  <> {((v as any).collectionIds as string[]).map(cid => {
                    const c = collById.get(cid);
                    const bg = c?.color || undefined;
                    const fg = bg ? textColorBW(bg) : undefined;
                    const br = bg ? darken(bg as string, 0.25) : undefined;
                    return (<span key={`col-${cid}`} className="badge" style={{ background: bg || undefined, color: fg, border: br ? `1px solid ${br}` : undefined }}>{c?.name || 'collection'}</span>);
                  })}
                  </>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <button type="button" className="btn-ghost debug-btn" onClick={() => toggleDebug(v.id)} aria-expanded={openDebug.has(v.id)} title={openDebug.has(v.id) ? 'Hide stored data' : 'Show stored data'}>
                  {openDebug.has(v.id) ? 'Hide info' : 'Show info'}
                </button>
              </div>
              {openDebug.has(v.id) && (
                <div className="debug-panel" role="region" aria-label="Stored data">
                  <div className="debug-panel-head">
                    <span>Stored data</span>
                    <button className="debug-close" onClick={() => toggleDebug(v.id)} title="Close">A-</button>
                  </div>
                  <pre className="debug-pre">{JSON.stringify((fullData[v.id] ?? v) as any, null, 2)}</pre>
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

import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { send as sendBg } from '../lib/messaging';
import { getOne, getVideosByChannel } from '../lib/idb';
import { VIDEO_CATEGORIES } from '../options/lib/videoCategories';
import type { TagRec } from '../../types/messages';

type PageContext = {
  page: 'watch' | 'channel' | 'other';
  videoId?: string | null;
  channelId?: string | null;
  url?: string;
};

function useActiveTabContext() {
  const [tabId, setTabId] = useState<number | null>(null);
  const [ctx, setCtx] = useState<PageContext>({ page: 'other' });
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const t = tabs?.[0];
        if (!t?.id) return;
        setTabId(t.id);
        chrome.tabs.sendMessage(t.id, { type: 'page/GET_CONTEXT', payload: {} }, (resp) => {
          if (!alive) return;
          const err = chrome.runtime.lastError;
          if (err) { setCtx({ page: 'other' }); return; }
          setCtx(resp as PageContext);
        });
      } catch {
        setCtx({ page: 'other' });
      }
    })();
    return () => { alive = false; };
  }, []);
  return { tabId, ctx };
}

function useTagsRegistry() {
  const [all, setAll] = useState<TagRec[]>([]);
  const refresh = async () => {
    const r: any = await sendBg('tags/list', {});
    if (r?.ok && Array.isArray(r.items)) setAll(r.items as TagRec[]);
  };
  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    const h = (msg: any) => { if (msg?.type === 'db/change' && msg?.payload?.entity === 'tags') refresh(); };
    chrome.runtime.onMessage.addListener(h);
    return () => chrome.runtime.onMessage.removeListener(h);
  }, []);
  return all;
}

function useRowRefresh<T>(store: 'videos' | 'channels', id?: string | null) {
  const [row, setRow] = useState<T | undefined>(undefined);
  const refresh = async () => {
    if (!id) { setRow(undefined); return; }
    try { const r = await getOne<T>(store as any, id); setRow(r); } catch { /* ignore */ }
  };
  useEffect(() => { refresh(); }, [id]);
  useEffect(() => {
    const h = (msg: any) => {
      if (msg?.type === 'db/change' && (msg.payload?.entity === 'videos' || msg.payload?.entity === 'channels')) refresh();
    };
    chrome.runtime.onMessage.addListener(h);
    return () => chrome.runtime.onMessage.removeListener(h);
  }, [id]);
  return row;
}

function TagChips(props: { labels: string[]; onRemove?: (name: string)=>void }) {
  const labels = props.labels || [];
  if (labels.length === 0) return <div className="empty">No tags yet</div>;
  return (
    <div className="chips">
      {labels.map(t => (
        <span key={t} className="chip">
          <span>{t}</span>
          {props.onRemove && <span className="x" title="Remove" onClick={() => props.onRemove?.(t)}>✕</span>}
        </span>
      ))}
    </div>
  );
}

function AddTagSelect(props: { all: string[]; onAdd: (name: string)=>void; disabled?: boolean }) {
  const [val, setVal] = useState('');
  return (
    <select value={val} disabled={props.disabled} onChange={(e) => { const v = e.currentTarget.value; setVal(''); if (v) props.onAdd(v); }}>
      <option value="">Add tag…</option>
      {props.all.map(n => <option key={n} value={n}>{n}</option>)}
    </select>
  );
}

function PopupApp() {
  const { tabId, ctx } = useActiveTabContext();
  const allTags = useTagsRegistry();
  const video = useRowRefresh<any>('videos', ctx.videoId || null);
  const channel = useRowRefresh<any>('channels', ctx.channelId || null);
  const [scrapeCount, setScrapeCount] = useState<number | null>(null);
  const [autoStubOnWatch, setAutoStubOnWatch] = useState<boolean>(false);

  const allTagNames = useMemo(() => allTags.map(t => t.name), [allTags]);

  const addVideoTag = async (name: string) => {
    if (!ctx.videoId) return;
    await sendBg('videos/applyTags', { ids: [ctx.videoId], addIds: [name] });
  };
  const removeVideoTag = async (name: string) => {
    if (!ctx.videoId) return;
    await sendBg('videos/applyTags', { ids: [ctx.videoId], removeIds: [name] });
  };
  const addChannelTag = async (name: string) => {
    if (!ctx.channelId) return;
    await sendBg('channels/applyTags', { ids: [ctx.channelId], addIds: [name] });
  };
  const removeChannelTag = async (name: string) => {
    if (!ctx.channelId) return;
    await sendBg('channels/applyTags', { ids: [ctx.channelId], removeIds: [name] });
  };

  const onScrape = async () => {
    if (!tabId) return;
    try {
      let respInfo: any = null;
      await new Promise<void>((resolve) => {
        try {
          chrome.tabs.sendMessage(tabId, { type: 'scrape/NOW', payload: {} }, (resp: any) => {
            respInfo = resp || null;
            const c = Number((resp || {}).count || 0);
            if (Number.isFinite(c)) {
              setScrapeCount(c);
              setTimeout(() => setScrapeCount(null), 3000);
            }
            resolve();
          });
        } catch { resolve(); }
      });
      // If channel page, refresh channel and mark per-tab counts + total
      const chId = (respInfo?.channelId || ctx.channelId) as (string | null | undefined);
      const tab = (respInfo?.pageTab as ('videos'|'shorts'|'live'|undefined)) || undefined;
      if (chId) {
        await sendBg('channels/refreshByIds', { ids: [chId] });
        const row: any = await getOne<any>('channels', chId);
        const totalVideoCountOnScrapeTime: number | null = (row?.videos ?? null);
        await sendBg('channels/markScraped', { id: chId, at: Date.now(), tab, count: Number(respInfo?.count || 0), totalVideoCountOnScrapeTime });
      }
    } catch {}
  };

  const videoTags = Array.isArray((video as any)?.tags) ? (video as any).tags as string[] : [];
  const channelTags = Array.isArray((channel as any)?.tags) ? (channel as any).tags as string[] : [];

  // Load and derive suggestions from channel's stored videos
  const [chanVideoCats, setChanVideoCats] = useState<string[]>([]);
  const [chanVideoTopics, setChanVideoTopics] = useState<string[]>([]);
  useEffect(() => {
    (async () => {
      if (!ctx.channelId) { setChanVideoCats([]); setChanVideoTopics([]); return; }
      try {
        const vids = await getVideosByChannel<any>(ctx.channelId);
        const catSet = new Set<number>();
        const topicSet = new Set<string>();
        for (const v of vids) {
          const cid = Number(v?.categoryId);
          if (Number.isFinite(cid)) catSet.add(cid);
          const ts: string[] = Array.isArray(v?.videoTopics) ? v.videoTopics : [];
          for (const t of ts) { const s = (t || '').toString().trim(); if (s) topicSet.add(s); }
        }
        const catNames: string[] = Array.from(catSet.values()).map(id => VIDEO_CATEGORIES.find(c => c.id === id)?.name).filter(Boolean) as string[];
        setChanVideoCats(catNames.sort((a,b)=>a.localeCompare(b)));
        setChanVideoTopics(Array.from(topicSet.values()).sort((a,b)=>a.localeCompare(b)));
      } catch {
        setChanVideoCats([]); setChanVideoTopics([]);
      }
    })();
  }, [ctx.channelId]);

  // Video-level suggestions from its own metadata
  const videoCatName = useMemo(() => {
    const cid = Number((video as any)?.categoryId);
    if (!Number.isFinite(cid)) return null;
    return VIDEO_CATEGORIES.find(c => c.id === cid)?.name || null;
  }, [video]);
  const videoTopics = useMemo(() => Array.isArray((video as any)?.videoTopics) ? ((video as any).videoTopics as string[]) : [], [video]);

  // Auto-stub toggle (read + write to storage)
  useEffect(() => {
    try { chrome.storage?.local?.get('autoStubOnWatch', (o) => setAutoStubOnWatch(!!o?.autoStubOnWatch)); } catch {}
  }, []);
  const toggleAutoStub = async () => {
    const next = !autoStubOnWatch;
    setAutoStubOnWatch(next);
    try { chrome.storage?.local?.set({ autoStubOnWatch: next }); } catch {}
  };

  return (
    <div className="wrap">
      <h1>YT Cacher</h1>
      <div className="row">
        <button onClick={onScrape}>Scrape current page</button>
        {typeof scrapeCount === 'number' && <span className="meta">Captured: {scrapeCount}</span>}
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={autoStubOnWatch} onChange={toggleAutoStub} />
          <span className="meta">Auto-capture stubs on watch pages</span>
        </label>
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <span className="meta">{ctx.page === 'watch' ? `watch: ${ctx.videoId}` : ctx.page === 'channel' ? `channel: ${ctx.channelId || 'unknown'}` : 'Not on YouTube'}</span>
      </div>

      {ctx.channelId && (
        <div className="section">
          <h2>Channel Tags</h2>
          <TagChips labels={channelTags} onRemove={removeChannelTag} />
          <div style={{ marginTop: 6 }}>
            <AddTagSelect all={allTagNames} onAdd={addChannelTag} />
          </div>
          {(chanVideoCats.length > 0 || chanVideoTopics.length > 0 || Array.isArray((channel as any)?.videoTags)) && (
            <div style={{ marginTop: 6 }}>
              <AddTagSelect
                all={Array.from(new Set<string>([
                  ...(Array.isArray((channel as any)?.videoTags) ? (channel as any).videoTags as string[] : []),
                  ...chanVideoCats,
                  ...chanVideoTopics,
                ]))}
                onAdd={addChannelTag}
              />
              <div className="meta">Suggestions from channel videos (tags, categories, topics)</div>
            </div>
          )}
        </div>
      )}

      {ctx.videoId && (
        <div className="section">
          <h2>Video Tags</h2>
          <TagChips labels={videoTags} onRemove={removeVideoTag} />
          <div style={{ marginTop: 6 }}>
            <AddTagSelect all={allTagNames} onAdd={addVideoTag} />
          </div>
          {(videoCatName || (videoTopics && videoTopics.length)) && (
            <div style={{ marginTop: 6 }}>
              <AddTagSelect all={Array.from(new Set<string>([
                ...(videoCatName ? [videoCatName] : []),
                ...videoTopics,
              ]))} onAdd={addVideoTag} />
              <div className="meta">Suggestions from this video (category, topics)</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<PopupApp />);

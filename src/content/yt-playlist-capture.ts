import { SELECTORS, parseVideoIdFromHref, getPlaylistIdFromURL, parseDurationToSec } from '../types/util';
import type { VideoSeed } from '../types/messages';
import type { Group as GroupRec, Condition } from '../shared/conditions';

function q1(selList: string[]): HTMLElement | null {
  for (const s of selList) {
    const el = document.querySelector(s) as HTMLElement | null;
    if (el) return el;
  }
  return null;
}

function tileToSeed(el: HTMLElement, source: VideoSeed['sources'][number]): VideoSeed | null {
  const a = el.querySelector(SELECTORS.tileLink) as HTMLAnchorElement | null;
  if (!a) return null;
  const id = parseVideoIdFromHref(a.href);
  if (!id) return null;

  // We intentionally capture only ids; metadata comes from YouTube API later

  return {
    id,
    sources: [source]
  };
}

function send(type: 'cache/VIDEO_SEEN', payload: VideoSeed) {
  chrome.runtime.sendMessage({ type, payload });
}

async function sendBatch(type: 'cache/VIDEO_SEEN_BATCH', items: VideoSeed[]): Promise<void> {
  if (!Array.isArray(items) || items.length === 0) return;
  await new Promise<void>((resolve) => {
    try { chrome.runtime.sendMessage({ type, payload: { items } } as any, () => resolve()); }
    catch { resolve(); }
  });
}

async function sendInChunks(items: VideoSeed[], chunkSize = 50, delayMs = 120): Promise<void> {
  for (let i = 0; i < items.length; i += chunkSize) {
    const batch = items.slice(i, i + chunkSize);
    if (batch.length === 0) continue;
    await sendBatch('cache/VIDEO_SEEN_BATCH', batch);
    if (delayMs > 0) await sleep(delayMs);
  }
}

function sendProgressPct(id: string, pct: number, started?: boolean, completed?: boolean) {
  try {
    chrome.runtime.sendMessage({ type: 'cache/VIDEO_PROGRESS_PCT', payload: { id, pct, started: !!started, completed: !!completed } });
  } catch {}
}

export function detectPageContext() {
  const url = new URL(location.href);
  const out: any = { page: 'other' as const, url: String(url) };
  // watch or shorts
  const vid = url.searchParams.get('v') || (location.pathname.startsWith('/shorts/') ? location.pathname.split('/')[2] : null);
  if (vid) {
    out.page = 'watch';
    out.videoId = vid;
    // Try find channel id on watch page
    try {
      const a = document.querySelector('ytd-video-owner-renderer a[href^="/channel/"]') as HTMLAnchorElement | null
             || document.querySelector('#owner a[href^="/channel/"]') as HTMLAnchorElement | null;
      if (a) {
        const u = new URL(a.href, location.origin);
        const seg = u.pathname.split('/');
        if (seg[1] === 'channel' && seg[2]) out.channelId = seg[2];
      }
    } catch {}
    // Fallback: data-channel-external-id (subscribe/collection buttons sometimes carry it)
    if (!out.channelId) {
      try {
        const el = document.querySelector('div.add-to-collection-button-new[data-channel-external-id], [data-channel-external-id]') as HTMLElement | null;
        const val = el?.getAttribute('data-channel-external-id');
        if (val) out.channelId = val;
      } catch {}
    }
    return out;
  }
  // channel page
  if (location.pathname.startsWith('/channel/')) {
    out.page = 'channel';
    try { out.channelId = location.pathname.split('/')[2] || null; } catch { out.channelId = null; }
    return out;
  }
  if (location.pathname.startsWith('/@') || location.pathname.startsWith('/c/')) {
    out.page = 'channel';
    // Try canonical link first (robust for @handle pages)
    try {
      const link = document.querySelector('link[rel="canonical"][href*="/channel/"]') as HTMLLinkElement | null;
      if (link?.href) {
        const u = new URL(link.href);
        const seg = u.pathname.split('/');
        if (seg[1] === 'channel' && seg[2]) out.channelId = seg[2];
      }
    } catch {}
    // Fallback to header links
    if (!out.channelId) {
      try {
        const a = document.querySelector('ytd-c4-tabbed-header-renderer a[href^="/channel/"]') as HTMLAnchorElement | null
               || document.querySelector('a[href^="/channel/"]') as HTMLAnchorElement | null;
        if (a) {
          const u = new URL(a.href, location.origin);
          const seg = u.pathname.split('/');
          if (seg[1] === 'channel' && seg[2]) out.channelId = seg[2];
        }
      } catch {}
    }
    return out;
  }
  // (Reverted) no generic vanity path detection here
  return out;
}

const TILE_ROOT_SEL = 'ytd-rich-item-renderer, ytd-grid-video-renderer, ytd-video-renderer, ytd-compact-video-renderer';

function findTileRootFromAnchor(a: HTMLAnchorElement): HTMLElement | null {
  return (a.closest(TILE_ROOT_SEL) as HTMLElement | null) || null;
}

export function scrapeProgressForTile(a: HTMLAnchorElement, videoId: string) {
  const root = findTileRootFromAnchor(a);
  if (!root) return;
  try {
    const prog = root.querySelector('div#progress[style]') as HTMLDivElement | null;
    if (!prog) return;
    const m = /width:\s*([0-9.]+)%/i.exec(prog.getAttribute('style') || '');
    if (!m) return;
    const pct = Math.max(0, Math.min(100, parseFloat(m[1] || '0')));
    const started = pct > 0.5;
    const completed = pct > 95;
    sendProgressPct(videoId, pct, started, completed);
  } catch {}
}

function getActiveChannelTab(): 'videos' | 'shorts' | 'live' | 'other' {
  try {
    const el = document.querySelector('.yt-tab-shape__tab--tab-selected') as HTMLElement | null;
    const t = (el?.textContent || '').trim().toLowerCase();
    if (t === 'videos') return 'videos';
    if (t === 'shorts') return 'shorts';
    if (t === 'live' || t === 'livestreams' || t === 'live streams') return 'live';
    return 'other';
  } catch { return 'other'; }
}

// Click-to-scrape: returns details for popup to record per-tab counts
export async function scrapeNowDetailed(): Promise<{ count: number; page: 'watch'|'channel'|'other'; pageTab?: 'videos'|'shorts'|'live'|'other'; channelId?: string | null }> {
  let sent = 0;
  const added = new Set<string>();
  const ctx = detectPageContext();
  const listId = getPlaylistIdFromURL();
  const container = q1(SELECTORS.playlistContainer);

  // Optional preset gating for manual scrapes, controlled from popup (applies to playlist and channel tabs)
  const useGate = await new Promise<boolean>((resolve) => {
    try { chrome.storage?.local?.get('popup.gateManual', (o) => resolve(!!o?.['popup.gateManual'])); } catch { resolve(false); }
  });
  let gateGroups: GroupRec[] = [];
  if (useGate) {
    gateGroups = await new Promise<GroupRec[]>((resolve) => {
      try { chrome.runtime.sendMessage({ type: 'groups/list', payload: {} } as any, (r: any) => {
        const items: GroupRec[] = Array.isArray(r?.items) ? r.items : [];
        resolve(items.filter(g => (g as any).scrape === true));
      }); } catch { resolve([]); }
    });
  }

  function tileRootFromAnchor(a: HTMLAnchorElement): HTMLElement | null {
    try {
      const sel = 'ytd-rich-item-renderer, ytd-grid-video-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-playlist-video-renderer';
      return a.closest(sel) as HTMLElement | null;
    } catch { return null; }
  }
  function extractChannelFromRoot(root: HTMLElement | null): { channelId?: string | null; handle?: string | null; name?: string | null } {
    try {
      if (!root) return {};
      const a = root.querySelector('ytd-channel-name a[href^="/channel/"]') as HTMLAnchorElement | null
             || root.querySelector('#byline a[href^="/channel/"]') as HTMLAnchorElement | null
             || root.querySelector('#channel-name a[href^="/channel/"]') as HTMLAnchorElement | null;
      if (a) {
        const u = new URL(a.href, location.origin);
        const seg = u.pathname.split('/');
        if (seg[1] === 'channel' && seg[2]) return { channelId: seg[2] };
      }
      const h = root.querySelector('ytd-channel-name a[href^="/@"]') as HTMLAnchorElement | null;
      if (h?.href) {
        const u = new URL(h.href, location.origin);
        const handle = u.pathname.slice(1);
        const name = (h.textContent || '').trim() || null;
        return { handle, name };
      }
      return {};
    } catch { return {}; }
  }
  type Cand = { id: string; sources: Array<{ type: string; id?: string | null }>; channelId?: string | null; handle?: string | null; channelName?: string | null; title?: string | null };
  function candidateFromAnchor(a: HTMLAnchorElement): Cand | null {
    const id = parseVideoIdFromHref(a.href);
    if (!id) return null;
    const src = listId ? [{ type: 'playlist', id: listId }] as Array<{ type: string; id?: string | null }> : [{ type: 'panel', id: null }];
    const root = tileRootFromAnchor(a);
    const ch = extractChannelFromRoot(root);
    let title: string | null = null;
    try {
      const tEl = (root?.querySelector('#video-title') as HTMLElement | null)
               || (root?.querySelector('a#video-title') as HTMLElement | null)
               || (root?.querySelector('a#video-title-link') as HTMLElement | null)
               || (a as HTMLElement | null);
      const t = (tEl?.textContent || (tEl as any)?.title || '').toString().trim();
      title = t || null;
    } catch {}
    // Channel page context fallback
    try {
      if (ctx?.page === 'channel' && !ch.channelId && !ch.handle && !ch.name) {
        if (ctx.channelId) ch.channelId = ctx.channelId;
        else if (location.pathname.startsWith('/@')) ch.handle = location.pathname.slice(1);
      }
    } catch {}
    return { id, sources: src, channelId: ch.channelId || null, handle: ch.handle || null, channelName: ch.name || null, title };
  }
  function evalPresetOnCandidate(c: Cand, cond: Condition, groupsById: Map<string, GroupRec>): boolean {
    function isCheckable(node: any, seen: Set<string>): boolean {
      if (!node) return true;
      if ('all' in node) return (Array.isArray(node.all) ? node.all : []).every((n: any) => isCheckable(n, seen));
      if ('any' in node) return (Array.isArray(node.any) ? node.any : []).every((n: any) => isCheckable(n, seen));
      if ('not' in node) return isCheckable(node.not, seen);
      const p = node as any;
      if (p.kind === 'groupRef') {
        const ids: string[] = Array.isArray(p.ids) ? p.ids : [];
        if (!ids.length) return false;
        return ids.every((gid) => {
          if (!gid || seen.has(gid)) return true;
          seen.add(gid);
          const g = groupsById.get(gid);
          return !!g && isCheckable(g.condition as any, new Set(seen));
        });
      }
      switch (p.kind) {
        case 'sourceAny':
        case 'sourcePlaylistAny':
          return true; // sources always present for evaluation
        case 'channelIdIn': {
          const hasChan = !!(c.channelId || c.handle || c.channelName);
          return hasChan; // must have some channel identifier/name to apply this
        }
        case 'titleRegex': {
          const hasTitle = !!(c.title && String(c.title).trim());
          return hasTitle; // require a usable title for regex
        }
        default:
          return false;
      }
    }
    function evalCond(node: any): boolean {
      if (!node) return true;
      if ('all' in node) return (Array.isArray(node.all) ? node.all : []).every(evalCond);
      if ('any' in node) return (Array.isArray(node.any) ? node.any : []).some(evalCond);
      if ('not' in node) return !evalCond(node.not);
      const p = node as any;
      switch (p.kind) {
        case 'sourceAny': {
          const items = Array.isArray(p.items) ? p.items : [];
          if (!items.length) return false;
          const src = Array.isArray(c.sources) ? c.sources : [];
          return src.some(s => items.some((it: any) => (s?.type || '') === (it?.type || '') && ((s?.id ?? null) === (it?.id ?? null))));
        }
        case 'sourcePlaylistAny': {
          const ids = new Set((p.ids || []).map(String));
          const src = Array.isArray(c.sources) ? c.sources : [];
          return src.some(s => s?.type === 'playlist' && s?.id && ids.has(String(s.id)));
        }
        case 'channelIdIn': {
          const id = (c.channelId || '').trim().toLowerCase();
          const handle = (c.handle || '').trim().toLowerCase();
          const name = (c.channelName || '').trim().toLowerCase();
          const set = new Set((Array.isArray(p.ids) ? p.ids : []).map((s: any) => String(s || '').trim().toLowerCase()));
          const handleBare = handle.startsWith('@') ? handle.slice(1) : handle;
          return (!!id && set.has(id)) || (!!handle && (set.has(handle) || set.has(handleBare))) || (!!name && set.has(name));
        }
        case 'titleRegex': {
          const pat = String(p.pattern || '');
          if (!pat) return false;
          let re: RegExp | null = null;
          try { re = new RegExp(pat, String(p.flags || '')); } catch { re = null; }
          const t = (c.title || '').toString();
          return !!re && re.test(t);
        }
        case 'groupRef': {
          const ids: string[] = Array.isArray(p.ids) ? p.ids : [];
          if (!ids.length) return false;
          return ids.some((gid) => {
            const g = gid ? groupsById.get(gid) : undefined;
            return g ? evalCond(g.condition as any) : false;
          });
        }
        default:
          return false;
      }
    }
    if (!isCheckable(cond as any, new Set())) return false;
    return evalCond(cond as any);
  }

  // Special handling: Subscriptions feed
  try {
    if (location.pathname === '/feed/subscriptions') {
      // New rich grid uses yt-lockup anchors; include any watch links inside rich items
      const anchors = Array.from(document.querySelectorAll(
        'ytd-rich-item-renderer a[href^="/watch"]'
      )) as HTMLAnchorElement[];
      const seen = new Set<string>();
      const seeds: VideoSeed[] = [];
      for (const a of anchors) {
        const vid = parseVideoIdFromHref(a.href);
        if (!vid || seen.has(vid) || added.has(vid)) continue;
        seen.add(vid); added.add(vid);
        const seed: VideoSeed = { id: vid, sources: [{ type: 'panel', id: listId }] };
        seeds.push(seed);
        try { scrapeProgressForTile(a, vid); } catch {}
      }
      if (seeds.length) { await sendInChunks(seeds); sent += seeds.length; }
      return { count: sent, page: 'other' } as any;
    }
    // Special handling: Watch History
    if (location.pathname === '/feed/history') {
      const anchors = Array.from(document.querySelectorAll(
        'a#thumbnail[href^="/watch"], a#video-title[href^="/watch"], a#video-title-link[href^="/watch"], ytd-rich-item-renderer a[href^="/watch"]'
      )) as HTMLAnchorElement[];
      const seen = new Set<string>();
      const seeds: VideoSeed[] = [];
      for (const a of anchors) {
        const vid = parseVideoIdFromHref(a.href);
        if (!vid || seen.has(vid) || added.has(vid)) continue;
        seen.add(vid); added.add(vid);
        const seed: VideoSeed = { id: vid, sources: [{ type: 'panel', id: listId }] };
        seeds.push(seed);
        try { scrapeProgressForTile(a, vid); } catch {}
      }
      if (seeds.length) { await sendInChunks(seeds); sent += seeds.length; }
      return { count: sent, page: 'other' } as any;
    }
  } catch { /* ignore */ }

  // Playlist page scrape (distinct tiles renderers)
  if (container) {
    const tiles = container.querySelectorAll(SELECTORS.playlistTiles);
    if (tiles.length > 0) {
      const seeds: VideoSeed[] = [];
      const groupsById = new Map<string, GroupRec>(); gateGroups.forEach(g => groupsById.set(g.id, g));
      tiles.forEach(el => {
        const node = el as HTMLElement;
        const a = node.querySelector(SELECTORS.tileLink) as HTMLAnchorElement | null;
        if (!a) return;
        const id = parseVideoIdFromHref(a.href);
        if (!id || added.has(id)) return;
        let accept = true;
        if (useGate && gateGroups.length > 0) {
          const cand = candidateFromAnchor(a);
          accept = gateGroups.some(g => evalPresetOnCandidate(cand!, g.condition as any, groupsById));
        }
        if (!accept) return;
        const seed = tileToSeed(node, { type: 'playlist', id: listId });
        if (seed) {
          added.add(seed.id);
          seeds.push(seed);
          sent++;
        }
        if (id) scrapeProgressForTile(a, id);
      });
      if (seeds.length) await sendInChunks(seeds);
      return { count: sent, page: ctx.page || 'other' } as any;
    }
  }

  if (ctx.page === 'channel') {
    const pageTab = getActiveChannelTab();
    if (pageTab === 'shorts') {
      // Shorts: anchors under /shorts/...
      try {
        const anchors = Array.from(document.querySelectorAll('a[href^="/shorts/"]')) as HTMLAnchorElement[];
        const seen = new Set<string>();
        const seeds: VideoSeed[] = [];
        const groupsById = new Map<string, GroupRec>(); gateGroups.forEach(g => groupsById.set(g.id, g));
        for (const a of anchors) {
          try {
            const u = new URL(a.href, location.origin);
            const id = u.pathname.split('/')[2] || '';
            if (!id || seen.has(id)) continue;
            let accept = true;
            if (useGate && gateGroups.length > 0) {
              const cand: any = { id, sources: [{ type: 'ChannelShortsTab' }], channelId: ctx.channelId || null, handle: (location.pathname.startsWith('/@') ? location.pathname.slice(1) : null) };
              accept = gateGroups.some(g => evalPresetOnCandidate(cand, g.condition as any, groupsById));
            }
            if (!accept) continue;
            seen.add(id);
            const seed: VideoSeed = { id, sources: [{ type: 'ChannelShortsTab' }] };
            seeds.push(seed);
            sent++;
          } catch { /* ignore */ }
        }
        if (seeds.length) await sendInChunks(seeds);
      } catch { /* ignore */ }
      return { count: sent, page: 'channel', pageTab, channelId: ctx.channelId || null };
    } else {
      // Videos or Live: scan document-wide anchors, filter by tile roots, de-dupe by video id
      const sourceType: VideoSeed['sources'][number]['type'] = pageTab === 'live' ? 'ChannelLivestreamsTab' : 'ChannelVideosTab';
      const anchors = Array.from(document.querySelectorAll(
        'a#thumbnail[href^="/watch"], a#video-title[href^="/watch"], a#video-title-link[href^="/watch"]'
      )) as HTMLAnchorElement[];
      const seen = new Set<string>();
      const seeds: VideoSeed[] = [];
      const groupsById = new Map<string, GroupRec>(); gateGroups.forEach(g => groupsById.set(g.id, g));
      for (const a of anchors) {
        const root = findTileRootFromAnchor(a);
        if (!root) continue;
        const id = parseVideoIdFromHref(a.href);
        if (!id || seen.has(id)) continue;
        let accept = true;
        if (useGate && gateGroups.length > 0) {
          const cand = candidateFromAnchor(a);
          accept = gateGroups.some(g => evalPresetOnCandidate(cand!, g.condition as any, groupsById));
        }
        if (!accept) continue;
        seen.add(id);
        const seed = tileToSeed(root, { type: sourceType });
        if (seed) {
          seeds.push(seed);
          // Try progress
          scrapeProgressForTile(a, id);
        }
      }
      if (seeds.length) { await sendInChunks(seeds); sent += seeds.length; }
      return { count: sent, page: 'channel', pageTab, channelId: ctx.channelId || null };
    }
  }

  // Fallback to current video on watch/shorts
  const url = new URL(location.href);
  const id = url.searchParams.get('v') || (location.pathname.startsWith('/shorts/') ? location.pathname.split('/')[2] : null);
  if (id) {
    // Capture title and channel name from watch page (best-effort without waits here)
    const titleEl = document.querySelector('ytd-watch-metadata h1 yt-formatted-string') || document.querySelector('h1.ytd-watch-metadata yt-formatted-string');
    const title = titleEl ? (titleEl as HTMLElement).textContent?.trim() || null : null;
    let channelName: string | null = null;
    try {
      const chTxt = document.querySelector('ytd-channel-name #text a, #channel-name #text a') as HTMLElement | null;
      channelName = chTxt?.textContent?.trim() || null;
    } catch { channelName = null; }
    // Try resolve channel id via canonical / owner / subscribe renderer
    let channelId: string | null = null;
    try {
      const link = document.querySelector('link[rel="canonical"][href*="/channel/"]') as HTMLLinkElement | null;
      if (link?.href) {
        const u = new URL(link.href);
        const seg = u.pathname.split('/');
        if (seg[1] === 'channel' && seg[2]) channelId = seg[2];
      }
    } catch {}
    if (!channelId) {
      try {
        const a = document.querySelector('ytd-video-owner-renderer a[href^="/channel/"]') as HTMLAnchorElement | null
               || document.querySelector('#owner a[href^="/channel/"]') as HTMLAnchorElement | null;
        if (a) {
          const u = new URL(a.href, location.origin);
          const seg = u.pathname.split('/');
          if (seg[1] === 'channel' && seg[2]) channelId = seg[2];
        }
      } catch {}
    }
    if (!channelId) {
      try {
        const el = document.querySelector('[data-channel-external-id]') as HTMLElement | null;
        const val = el?.getAttribute('data-channel-external-id');
        if (val) channelId = val;
      } catch {}
    }

    if (!added.has(id)) {
      added.add(id);
    chrome.runtime.sendMessage({ type: 'cache/VIDEO_STUB', payload: { id, title, channelName, channelId, sources: [{ type: 'WatchPage', id: null }] } });
    if (channelId) {
      try { chrome.runtime.sendMessage({ type: 'channels/upsertStub', payload: { id: channelId, name: channelName || null } }); } catch {}
    }
      sent++;
    }

    // Progress from player time display
    try {
      const curTxt = (document.querySelector('.ytp-time-display .ytp-time-current') as HTMLElement | null)?.textContent || '';
      const durTxt = (document.querySelector('.ytp-time-display .ytp-time-duration') as HTMLElement | null)?.textContent || '';
      const current = parseDurationToSec(curTxt) || 0;
      const duration = parseDurationToSec(durTxt) || 0;
      const started = current > 0;
      const completed = duration > 0 && current / duration > 0.95;
      if (duration > 0) {
        chrome.runtime.sendMessage({ type: 'cache/VIDEO_PROGRESS', payload: { id, current, duration, started, completed } });
      }
    } catch {}
  }

  // General fallback: scan visible anchors pointing to /watch and de-dupe by id
  try {
    const anchors = Array.from(document.querySelectorAll('a#thumbnail[href], a#video-title[href], a#video-title-link[href]')) as HTMLAnchorElement[];
    const seen = new Set<string>();
    const seeds: VideoSeed[] = [];
    for (const a of anchors) {
      const vid = parseVideoIdFromHref(a.href);
      if (!vid || seen.has(vid) || added.has(vid)) continue;
      seen.add(vid);
      const seed: VideoSeed = { id: vid, sources: [{ type: 'panel', id: listId }] };
      added.add(vid);
      seeds.push(seed);
      scrapeProgressForTile(a, vid);
    }
    if (seeds.length) { await sendInChunks(seeds); sent += seeds.length; }
  } catch { /* ignore */ }
  return { count: sent, page: ctx.page || 'other' } as any;
}

function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }

// Async wrapper with brief retries to avoid racing render on channel pages
export async function scrapeNowDetailedAsync(): Promise<{ count: number; page: 'watch'|'channel'|'other'; pageTab?: 'videos'|'shorts'|'live'|'other'; channelId?: string | null }> {
  const first = await scrapeNowDetailed();
  if (first.page === 'channel' && first.count === 0) {
    for (let i = 0; i < 2; i++) { // two quick retries
      await sleep(180);
      const again = await scrapeNowDetailed();
      if (again.count > 0) return again;
    }
  }
  return first;
}


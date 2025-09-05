import { SELECTORS, parseVideoIdFromHref, getPlaylistIdFromURL, parseDurationToSec } from '../types/util';
import type { VideoSeed } from '../types/messages';

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
export function scrapeNowDetailed(): { count: number; page: 'watch'|'channel'|'other'; pageTab?: 'videos'|'shorts'|'live'|'other'; channelId?: string | null } {
  let sent = 0;
  const added = new Set<string>();
  const ctx = detectPageContext();
  const listId = getPlaylistIdFromURL();
  const container = q1(SELECTORS.playlistContainer);

  // Playlist page scrape (distinct tiles renderers)
  if (container) {
    const tiles = container.querySelectorAll(SELECTORS.playlistTiles);
    if (tiles.length > 0) {
      tiles.forEach(el => {
        const node = el as HTMLElement;
        const seed = tileToSeed(node, { type: 'playlist', id: listId });
        if (seed) {
          if (!added.has(seed.id)) {
            added.add(seed.id);
            send('cache/VIDEO_SEEN', seed);
            sent++;
          }
          const a = node.querySelector(SELECTORS.tileLink) as HTMLAnchorElement | null;
          if (a) {
            const id = parseVideoIdFromHref(a.href);
            if (id && !added.has(id)) scrapeProgressForTile(a, id);
          }
        }
      });
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
        for (const a of anchors) {
          try {
            const u = new URL(a.href, location.origin);
            const id = u.pathname.split('/')[2] || '';
            if (!id || seen.has(id)) continue;
            seen.add(id);
            const seed: VideoSeed = { id, sources: [{ type: 'ChannelShortsTab' }] };
            send('cache/VIDEO_SEEN', seed);
            sent++;
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
      return { count: sent, page: 'channel', pageTab, channelId: ctx.channelId || null };
    } else {
      // Videos or Live: scan document-wide anchors, filter by tile roots, de-dupe by video id
      const sourceType: VideoSeed['sources'][number]['type'] = pageTab === 'live' ? 'ChannelLivestreamsTab' : 'ChannelVideosTab';
      const anchors = Array.from(document.querySelectorAll(
        'a#thumbnail[href^="/watch"], a#video-title[href^="/watch"], a#video-title-link[href^="/watch"]'
      )) as HTMLAnchorElement[];
      const seen = new Set<string>();
      for (const a of anchors) {
        const root = findTileRootFromAnchor(a);
        if (!root) continue;
        const id = parseVideoIdFromHref(a.href);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const seed = tileToSeed(root, { type: sourceType });
        if (seed) {
          send('cache/VIDEO_SEEN', seed);
          sent++;
          // Try progress
          scrapeProgressForTile(a, id);
        }
      }
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
    for (const a of anchors) {
      const vid = parseVideoIdFromHref(a.href);
      if (!vid || seen.has(vid) || added.has(vid)) continue;
      seen.add(vid);
      const seed: VideoSeed = { id: vid, sources: [{ type: 'panel', id: listId }] };
      added.add(vid);
      send('cache/VIDEO_SEEN', seed);
      sent++;
      scrapeProgressForTile(a, vid);
    }
  } catch { /* ignore */ }
  return { count: sent, page: ctx.page || 'other' } as any;
}

function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }

// Async wrapper with brief retries to avoid racing render on channel pages
export async function scrapeNowDetailedAsync(): Promise<{ count: number; page: 'watch'|'channel'|'other'; pageTab?: 'videos'|'shorts'|'live'|'other'; channelId?: string | null }> {
  const first = scrapeNowDetailed();
  if (first.page === 'channel' && first.count === 0) {
    for (let i = 0; i < 2; i++) { // two quick retries
      await sleep(180);
      const again = scrapeNowDetailed();
      if (again.count > 0) return again;
    }
  }
  return first;
}

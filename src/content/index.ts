import { scrapeNowDetailedAsync, detectPageContext } from './yt-playlist-capture';
import { onNavigate } from './yt-navigation';
import { parseVideoIdFromHref } from '../types/util';
import { scrapeWatchStub } from './yt-watch-stub';
import { startWatchProgressTracking, stopWatchProgressTracking } from './yt-watch-progress';
import type { Condition, Group as GroupRec } from '../shared/conditions';
import { getPlaylistIdFromURL } from '../types/util';
import { dlog, dwarn } from '../types/debug';

// Only act when background asks us to scrape
chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
  try {
    if (msg?.type === 'scrape/NOW') {
      (async () => {
        try {
          const info = await scrapeNowDetailedAsync();
          sendResponse?.({ ok: true, ...info });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      })();
      return true; // keep channel open for async
  } else if (msg?.type === 'scrape/SCROLL') {
      // Simple incremental scroll; options: { times?: number, delayMs?: number }
      (async () => {
        try {
          const times = Math.max(1, Math.min(50, Number(msg?.payload?.times ?? 1)));
          const delay = Math.max(50, Math.min(2000, Number(msg?.payload?.delayMs ?? 400)));
          for (let i = 0; i < times; i++) {
            try { window.scrollBy({ top: Math.floor(window.innerHeight * 0.9), behavior: 'instant' as any }); } catch {}
            await new Promise(res => setTimeout(res, delay));
          }
          sendResponse?.({ ok: true });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      })();
      return true;
    } else if (msg?.type === 'scrape/LOG') {
      try {
        const what = (msg?.payload?.what || 'scrape') as ('SubscriptionsFeed' | 'WatchHistory' | string);
        const seen = Number(msg?.payload?.seen || 0);
        const max = Number(msg?.payload?.max || 0);
        const stall = Number(msg?.payload?.stall || 0);
        const pending = Number(msg?.payload?.pending || 0);
        // Detailed scan like the manual snippet
        const stats = scanCurrentAnchors(what);
        // Reset cumulative tracker when switching modes
        if (domUniqueWhat !== what) { domUniqueWhat = what; try { domUniqueSeen.clear(); } catch {} }
        // Merge pass uniques into cumulative
        try { for (const id of stats.uniques) domUniqueSeen.add(id); } catch {}
        const prefix = what === 'SubscriptionsFeed' ? '[subs]' : (what === 'WatchHistory' ? '[history]' : '[scrape]');
        // eslint-disable-next-line no-console
        console.log(`${prefix} anchors:`, stats.anchors.length,
                    'withId:', stats.withId.length,
                    'uniqueIds:', stats.uniques.length,
                    'noRoot:', stats.noRoot.length,
                    'noId:', stats.noId.length,
                    'seen(upserts):', seen,
                    'pending(upserts):', pending,
                    'cumulative(dom):', domUniqueSeen.size,
                    'max:', max,
                    'stall:', stall);
        // eslint-disable-next-line no-console
        console.log(`${prefix} sample ids:`, stats.uniques.slice(0, 10));
        // eslint-disable-next-line no-console
        console.log(`${prefix} duplicates (id:count):`, stats.dups.slice(0, 10));
        // Keep a handle for DevTools inspection
        (window as any).YTM_SCRAPE_PASS = { what, seen, pending, max, stall, cumulativeUnique: domUniqueSeen.size, ...stats };
        // Visual highlight each iteration using the already-collected anchors
        try {
          if (what === 'SubscriptionsFeed') highlightFromAnchors(stats.anchors, 'sf');
          else if (what === 'WatchHistory') highlightFromAnchors(stats.anchors, 'wh');
        } catch {}
        sendResponse?.({ ok: true, dom: { passUnique: stats.uniques.length, cumulativeUnique: domUniqueSeen.size } });
      } catch (e: any) {
        sendResponse?.({ ok: false, error: e?.message || String(e) });
      }
      return true;
    } else if (msg?.type === 'scrape/LIST_SUBSCRIPTIONS') {
      // On https://www.youtube.com/feed/channels, extract channel identifiers.
      // Prefer concrete /channel/ IDs, but also capture @handles via #main-link or /@ links.
      try {
        const anchors = Array.from(document.querySelectorAll('a#main-link, a[href^="/channel/"], a[href^="/@"]')) as HTMLAnchorElement[];
        const ids = new Set<string>();
        const handles = new Set<string>();
        for (const a of anchors) {
          try {
            const u = new URL(a.href, location.origin);
            const seg = u.pathname.split('/');
            if (seg[1] === 'channel' && seg[2]) {
              ids.add(seg[2]);
            } else if (u.pathname.startsWith('/@')) {
              const h = u.pathname.slice(1); // include leading @ in value
              if (h) handles.add(h);
            }
          } catch { /* ignore */ }
        }
        sendResponse?.({ ok: true, ids: Array.from(ids.values()), handles: Array.from(handles.values()) });
      } catch (e: any) {
        sendResponse?.({ ok: false, error: e?.message || String(e) });
      }
      return true;
    } else if (msg?.type === 'scrape/FINAL') {
      try {
        const what = (msg?.payload?.what || 'scrape') as string;
        const idsFromBg = Array.isArray(msg?.payload?.ids) ? (msg.payload.ids as any[]).map(String) : [];
        const max = Number(msg?.payload?.max || 0);
        // Prefer DOM cumulative uniques for final highlight/logging
        const allIds = Array.from(domUniqueSeen.values());
        const info = finalizeScrapeHighlights(what as any, allIds);
        // eslint-disable-next-line no-console
        console.log(`[YT-Manager] FINAL ${what}: uniqueIds(dom)=${allIds.length} uniqueIds(upserts)=${idsFromBg.length} max=${max}`);
        // eslint-disable-next-line no-console
        console.log('[YT-Manager] Final anchors (first 40):', info.anchors.slice(0, 40));
        (window as any).YTM_SCRAPE_FINAL = { what, idsDom: allIds, idsUpsert: idsFromBg, ...info };
        // Pause auto-scan ticker to avoid further background noise
        try { if (ticker != null) { clearInterval(ticker as any); ticker = null; } } catch {}
        sendResponse?.({ ok: true, count: allIds.length });
      } catch (e: any) {
        sendResponse?.({ ok: false, error: e?.message || String(e) });
      }
      return true;
    } else if (msg?.type === 'page/GET_CONTEXT') {
      const ctx = detectPageContext();
      sendResponse?.(ctx);
      return true;
    }
  } catch (e: any) {
    sendResponse?.({ ok: false, error: e?.message || String(e) });
  }
  return false;
});

// Setting: auto-stub on watch pages
let autoStubOnWatch = false;
try {
  chrome.storage?.local?.get('autoStubOnWatch', (o) => { autoStubOnWatch = !!o?.autoStubOnWatch; });
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'local' && changes?.autoStubOnWatch) {
      autoStubOnWatch = !!changes.autoStubOnWatch.newValue;
      // If toggled on while on a watch page, capture immediately once
      if (autoStubOnWatch) {
        try {
          const ctx = detectPageContext();
          if (ctx.page === 'watch') scrapeWatchStub();
        } catch {}
      }
    }
  });
} catch {}

// On YT SPA navigation, auto-capture watch stubs if enabled
try {
  onNavigate(() => {
    // Clear per-page pending dedupe on navigation
    try { pendingKeysSubmitted.clear(); } catch {}
    try { domUniqueSeen.clear(); domUniqueWhat = null; } catch {}
    const ctx = detectPageContext();
    dlog('[content] navigate', ctx?.page, location.pathname);
    // Always track progress on watch pages
    if (ctx.page === 'watch') {
      try { void startWatchProgressTracking(); } catch {}
      if (autoStubOnWatch) {
        try { void scrapeWatchStub(); } catch {}
      }
    } else {
      // Stop tracker when leaving watch pages
      try { stopWatchProgressTracking(); } catch {}
    }
    // On channel pages, resolve pending channel handle/name to id
    if (ctx.page === 'channel' && ctx.channelId) {
      try {
        let handle: string | null = null;
        try {
          if (location.pathname.startsWith('/@')) handle = location.pathname.slice(1);
        } catch {}
        dlog('[content] resolvePending channel', { id: ctx.channelId, handle });
        chrome.runtime.sendMessage({ type: 'channels/resolvePending', payload: { id: ctx.channelId, handle } });
      } catch {}
    }
    // Start or stop auto-scrape ticker based on page
    try { setupAutoScrapeTicker(); } catch (e) { dwarn('ticker error', e); }
  });
} catch {}

// ---- Universal auto-scrape (preset-gated) ----
let ticker: number | null = null;
let scrapeGroups: GroupRec[] = [];
let lastActivityAt = Date.now();
// Track cumulative DOM-unique ids for the current scraping mode (Sub Feed or History)
let domUniqueWhat: 'SubscriptionsFeed' | 'WatchHistory' | string | null = null;
const domUniqueSeen: Set<string> = new Set();

function markActive() { lastActivityAt = Date.now(); }
try {
  window.addEventListener('mousemove', markActive, { passive: true });
  window.addEventListener('scroll', markActive, { passive: true });
  window.addEventListener('click', markActive, { passive: true });
  window.addEventListener('keydown', markActive, { passive: true });
  window.addEventListener('touchstart', markActive, { passive: true });
} catch {}
async function refreshScrapeGroups() {
  await new Promise<void>((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'groups/list', payload: {} } as any, (r: any) => {
        try {
          const items: GroupRec[] = Array.isArray(r?.items) ? r.items : [];
          scrapeGroups = items.filter(g => (g as any).scrape === true);
          dlog('[content] refreshScrapeGroups', { enabled: scrapeGroups.length });
        } catch { scrapeGroups = []; }
        resolve();
      });
    } catch {
      scrapeGroups = [];
      resolve();
    }
  });
}

function setupAutoScrapeTicker() {
  // stop existing
  if (ticker != null) { clearInterval(ticker as any); ticker = null; }
  // Exclusions: do NOT auto-scan on channel pages or any playlist pages
  try {
    const ctx = detectPageContext();
    const onChannel = ctx?.page === 'channel';
    const onPlaylist = !!getPlaylistIdFromURL();
    if (onChannel || onPlaylist) {
      dlog('[content] auto-scrape disabled on', onChannel ? 'channel page' : 'playlist page');
      return;
    }
  } catch { /* ignore */ }
  // Start ticker
  void refreshScrapeGroups();
  ticker = setInterval(() => { void autoScanOnce(); }, 2000) as any; // run every 2s
  dlog('[content] auto-scrape ticker started');
  // listen for group changes
  try {
    const h = (msg: any) => { if (msg?.type === 'db/change' && msg?.payload?.entity === 'groups') void refreshScrapeGroups(); };
    chrome.runtime.onMessage.addListener(h);
  } catch {}
}

function tileRoot(a: HTMLAnchorElement): HTMLElement | null {
  const sel = 'ytd-rich-item-renderer, ytd-grid-video-renderer, ytd-video-renderer, ytd-compact-video-renderer';
  return a.closest(sel) as HTMLElement | null;
}
function extractChannelIdFromTile(root: HTMLElement | null): { channelId?: string | null; handle?: string | null; name?: string | null } {
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

// ---- Visual debug: highlight elements considered during scraping loops ----
function ensureHighlightStyles() {
  try {
    if (document.getElementById('ytm-highlight-style')) return;
    const style = document.createElement('style');
    style.id = 'ytm-highlight-style';
    style.textContent = `
      .ytm-hl-sf { outline: 2px solid #42a5f5 !important; outline-offset: -2px !important; }
      .ytm-hl-sf-ch { box-shadow: inset 0 0 0 2px #66bb6a !important; border-radius: 3px; }
      .ytm-hl-wh { outline: 2px solid #ff9800 !important; outline-offset: -2px !important; }
      .ytm-hl-wh-ch { box-shadow: inset 0 0 0 2px #66bb6a !important; border-radius: 3px; }
      .ytm-hl-final { outline: 3px solid #e91e63 !important; outline-offset: -2px !important; }
      .ytm-hl-final-ch { box-shadow: inset 0 0 0 3px #e91e63 !important; border-radius: 3px; }
    `;
    document.head?.appendChild(style);
  } catch { /* ignore */ }
}

function clearHighlight(tag: 'sf' | 'wh') {
  try {
    document.querySelectorAll(`.ytm-hl-${tag}, .ytm-hl-${tag}-ch`).forEach(el => {
      try { el.classList.remove(`ytm-hl-${tag}`); el.classList.remove(`ytm-hl-${tag}-ch`); } catch {}
    });
  } catch { /* ignore */ }
}

function highlightFromAnchors(anchors: HTMLAnchorElement[], tag: 'sf' | 'wh') {
  ensureHighlightStyles();
  clearHighlight(tag);
  for (const a of anchors) {
    try {
      const root = tileRoot(a);
      if (root) {
        root.classList.add(`ytm-hl-${tag}`);
        // Also mark channel anchors inside the tile
        try {
          const ch = (root.querySelector('ytd-channel-name a[href^="/channel/"]') as HTMLAnchorElement | null)
                  || (root.querySelector('#byline a[href^="/channel/"]') as HTMLAnchorElement | null)
                  || (root.querySelector('#channel-name a[href^="/channel/"]') as HTMLAnchorElement | null)
                  || (root.querySelector('ytd-channel-name a[href^="/@"]') as HTMLAnchorElement | null);
          if (ch) ch.classList.add(`ytm-hl-${tag}-ch`);
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }
}

function applyScrapeHighlightsFor(what: 'SubscriptionsFeed' | 'WatchHistory' | string) {
  try {
    if (what === 'SubscriptionsFeed') {
      const anchors = Array.from(document.querySelectorAll('ytd-rich-item-renderer a[href^="/watch"]')) as HTMLAnchorElement[];
      highlightFromAnchors(anchors, 'sf');
    } else if (what === 'WatchHistory') {
      const anchors = Array.from(document.querySelectorAll('a#thumbnail[href^="/watch"], a#video-title[href^="/watch"], a#video-title-link[href^="/watch"], ytd-rich-item-renderer a[href^="/watch"]')) as HTMLAnchorElement[];
      highlightFromAnchors(anchors, 'wh');
    }
  } catch { /* ignore */ }
}

function finalizeScrapeHighlights(what: 'SubscriptionsFeed' | 'WatchHistory' | string, ids: string[]): { anchors: HTMLAnchorElement[] } {
  ensureHighlightStyles();
  const sel = (what === 'SubscriptionsFeed')
    ? 'ytd-rich-item-renderer a[href^="/watch"]'
    : 'a#thumbnail[href^="/watch"], a#video-title[href^="/watch"], a#video-title-link[href^="/watch"], ytd-rich-item-renderer a[href^="/watch"]';
  const idsSet = new Set((ids || []).map(String));
  const anchors = Array.from(document.querySelectorAll(sel)) as HTMLAnchorElement[];
  const matched: HTMLAnchorElement[] = [];
  for (const a of anchors) {
    let id: string | null = null;
    try { id = parseVideoIdFromHref(a.href); } catch { id = null; }
    if (!id || !idsSet.has(id)) continue;
    matched.push(a);
    const root = tileRoot(a);
    if (root) {
      root.classList.add('ytm-hl-final');
      try {
        const ch = (root.querySelector('ytd-channel-name a[href^="/channel/"]') as HTMLAnchorElement | null)
                || (root.querySelector('#byline a[href^="/channel/"]') as HTMLAnchorElement | null)
                || (root.querySelector('#channel-name a[href^="/channel/"]') as HTMLAnchorElement | null)
                || (root.querySelector('ytd-channel-name a[href^="/@"]') as HTMLAnchorElement | null);
        if (ch) ch.classList.add('ytm-hl-final-ch');
      } catch { /* ignore */ }
    }
  }
  return { anchors: matched };
}

// Build detailed per-pass stats similar to the manual console snippets
function scanCurrentAnchors(what: 'SubscriptionsFeed' | 'WatchHistory' | string): {
  anchors: HTMLAnchorElement[];
  withId: HTMLAnchorElement[];
  noId: HTMLAnchorElement[];
  noRoot: HTMLAnchorElement[];
  uniques: string[];
  dups: Array<{ id: string; count: number }>;
} {
  const sel = (what === 'SubscriptionsFeed')
    ? 'ytd-rich-item-renderer a[href^="/watch"]'
    : 'a#thumbnail[href^="/watch"], a#video-title[href^="/watch"], a#video-title-link[href^="/watch"], ytd-rich-item-renderer a[href^="/watch"]';
  const anchors = Array.from(document.querySelectorAll(sel)) as HTMLAnchorElement[];
  const idTo = new Map<string, { count: number; root: Element | null }>();
  const withId: HTMLAnchorElement[] = [];
  const noId: HTMLAnchorElement[] = [];
  const noRoot: HTMLAnchorElement[] = [];
  for (const a of anchors) {
    let id: string | null = null;
    try { id = parseVideoIdFromHref(a.href); } catch { id = null; }
    if (!id) { noId.push(a); continue; }
    withId.push(a);
    const root = tileRoot(a);
    if (!root) { noRoot.push(a); continue; }
    const r = idTo.get(id);
    if (r) r.count += 1; else idTo.set(id, { count: 1, root });
  }
  const uniques = Array.from(idTo.keys());
  const dups = Array.from(idTo.entries()).filter(([, v]) => v.count > 1).map(([k, v]) => ({ id: k, count: v.count }));
  return { anchors, withId, noId, noRoot, uniques, dups };
}

// Track pending-channel keys we have already submitted on this page to avoid repeated upserts
const pendingKeysSubmitted = new Set<string>();

function candidateFromAnchor(a: HTMLAnchorElement): Cand | null {
  const id = parseVideoIdFromHref(a.href);
  if (!id) return null;
  // source derivation: playlist vs panel
  const list = getPlaylistIdFromURL();
  const src = list ? [{ type: 'playlist', id: list }] as Array<{ type: string; id?: string | null }> : [{ type: 'panel', id: null }];
  const root = tileRoot(a);
  const ch = extractChannelIdFromTile(root);
  // Title from tile
  let title: string | null = null;
  try {
    const tEl = (root?.querySelector('#video-title') as HTMLElement | null)
             || (root?.querySelector('a#video-title') as HTMLElement | null)
             || (root?.querySelector('a#video-title-link') as HTMLElement | null)
             || (a as HTMLElement | null);
    const t = (tEl?.textContent || (tEl as any)?.title || '').toString().trim();
    title = t || null;
  } catch {}
  // Fallback on channel pages: infer channel from page URL/context
  try {
    const ctx = detectPageContext();
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
    return (
      p.kind === 'sourceAny' ||
      p.kind === 'sourcePlaylistAny' ||
      p.kind === 'channelIdIn' ||
      p.kind === 'titleRegex'
    );
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
        // Unknown at scrape time: preset should not be applied
        return false;
    }
  }
  if (!isCheckable(cond as any, new Set())) return false;
  return evalCond(cond as any);
}

async function autoScanOnce() {
  if (scrapeGroups.length === 0) return; // nothing enabled
  // Idle gating: only scrape within 10s of last user interaction
  const idleMs = Date.now() - lastActivityAt;
  if (idleMs > 10_000) { dlog('[content] idle, skipping scan', idleMs); return; }
  const ctx = detectPageContext();
  // Exclude channel pages and all playlist pages
  try {
    const onChannel = ctx?.page === 'channel';
    const onPlaylist = !!getPlaylistIdFromURL();
    if (onChannel || onPlaylist) return;
  } catch { /* ignore */ }
  const currentWatchId: string | null = ctx.page === 'watch' ? (ctx as any).videoId || null : null;
  // Always ensure current watch video is scraped as well (regardless of presets)
  if (currentWatchId) {
    try {
      dlog('[content] scrape current watch', currentWatchId);
      chrome.runtime.sendMessage({ type: 'cache/VIDEO_SEEN', payload: { id: currentWatchId, sources: [{ type: 'WatchPage', id: null }] } });
    } catch {}
  }
  // Collect anchors for watch + shorts
  const anchors = Array.from(document.querySelectorAll(
    'a#thumbnail[href^="/watch"], a#video-title[href^="/watch"], a#video-title-link[href^="/watch"]'
  )) as HTMLAnchorElement[]; // exclude generic /shorts links from auto-scan
  dlog('[content] scan anchors', anchors.length);
  if (anchors.length === 0) return;
  const groupsById = new Map<string, GroupRec>(); scrapeGroups.forEach(g => groupsById.set(g.id, g));
  const accepted: Cand[] = [];
  for (const a of anchors) {
    const cand = candidateFromAnchor(a);
    if (!cand) continue;
    // gate by any enabled preset
    const ok = scrapeGroups.some(g => evalPresetOnCandidate(cand, g.condition, groupsById));
    if (ok) accepted.push(cand);
  }
  // Submit distinct ids
  if (accepted.length) {
    const seen = new Set<string>();
    for (const c of accepted) {
      if (seen.has(c.id)) continue; seen.add(c.id);
      // Channel side-effects now only for accepted candidates
      try {
        if (c.channelId) {
          chrome.runtime.sendMessage({ type: 'channels/upsertStub', payload: { id: c.channelId, name: c.channelName || null, handle: c.handle || null } });
        } else if ((c.handle || c.channelName)) {
          const handleKey = c.handle ? (c.handle!.startsWith('@') ? c.handle! : `@${c.handle!}`) : null;
          const key = handleKey ? `handle:${handleKey}` : (c.channelName ? `name:${c.channelName}` : null);
          if (key && !pendingKeysSubmitted.has(key)) {
            pendingKeysSubmitted.add(key);
            chrome.runtime.sendMessage({ type: 'channels/upsertPending', payload: { key, name: c.channelName || null, handle: handleKey || null } });
          }
        }
      } catch {}
      try {
        dlog('[content] scrape candidate', c.id, { hasTitle: !!c.title });
        if (c.title || c.channelId || c.channelName) {
          chrome.runtime.sendMessage({ type: 'cache/VIDEO_STUB', payload: { id: c.id, title: c.title || null, channelName: c.channelName || null, channelId: c.channelId || null, sources: c.sources } });
        } else {
          chrome.runtime.sendMessage({ type: 'cache/VIDEO_SEEN', payload: { id: c.id, sources: c.sources } });
        }
      } catch {}
    }
    dlog('[content] scraped accepted', seen.size);
  }
}

// Initial setup
try { setupAutoScrapeTicker(); } catch {}

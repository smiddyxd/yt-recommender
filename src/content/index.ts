import { scrapeNowDetailedAsync, detectPageContext } from './yt-playlist-capture';

function getChannelHandleNow(): string | null {
  try {
    const a = document.querySelector('ytd-c4-tabbed-header-renderer a[href^="/@"]') as HTMLAnchorElement | null;
    if (a?.pathname && a.pathname.startsWith('/@')) return a.pathname.slice(1);
  } catch {}
  try {
    const span = document.querySelector('yt-content-metadata-view-model span.yt-core-attributed-string--link-inherit-color');
    const txt = (span as HTMLElement | null)?.textContent || '';
    const m = /@\w[\w._-]*/i.exec(txt);
    if (m) return m[0];
  } catch {}
  try {
    const any = document.querySelector('a[href^="/@"]') as HTMLAnchorElement | null;
    if (any?.pathname && any.pathname.startsWith('/@')) return any.pathname.slice(1);
  } catch {}
  return null;
}

try { setupAutoScrapeTicker(); } catch {}
// Initial setup
import { onNavigate } from './yt-navigation';
import { parseVideoIdFromHref } from '../types/util';
import { scrapeWatchStub } from './yt-watch-stub';
import { startWatchProgressTracking, stopWatchProgressTracking } from './yt-watch-progress';
import type { Condition, Group as GroupRec } from '../shared/conditions';
import { getPlaylistIdFromURL } from '../types/util';
import { dlog, dwarn } from '../types/debug';

// Only act when background asks us to scrape
// ---- Globals used by message handlers (declared early) ----
let ticker: number | null = null;
let tickerTimeout: number | null = null;
type AutoSpeed = 'fast' | 'slow';
let autoSpeed: AutoSpeed = 'fast';
let lastSignature: string | null = null;
let sameSignatureCount = 0;
let autoDisabled = false;
let lastScrollY = 0;
let scrapeGroups: GroupRec[] = [];
let lastActivityAt = Date.now();
let domUniqueWhat: 'SubscriptionsFeed' | 'WatchHistory' | string | null = null;
const domUniqueSeen: Set<string> = new Set();
// Track last watch-page stub capture to avoid spamming
let lastWatchStubId: string | null = null;
let lastWatchStubAt = 0;
// Track latest marker sent for Sub Feed (to avoid spamming background)
let lastSubFeedLatestId: string | null = null;

// ---- Channel tag highlight (default tag: "tagged") ----
const TAGGED_CLASS = 'ytm-channel-tagged';
let taggedChannelIds = new Set<string>();
const HANDLE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const handleResolveCache = new Map<string, { id: string | null; at: number }>();
const nameResolveCache = new Map<string, { id: string | null; at: number }>();

function ensureTaggedHighlightStyles() {
  try {
    const css = `
      .${TAGGED_CLASS} { border: 3px solid #5edf8b !important; border-radius: 3px; box-sizing: border-box; }
      a.${TAGGED_CLASS}, .yt-core-attributed-string__link.${TAGGED_CLASS}, .yt-simple-endpoint.${TAGGED_CLASS} { display: inline-block !important; }
    `;
    let style = document.getElementById('ytm-chan-tag-style') as HTMLStyleElement | null;
    if (!style) { style = document.createElement('style'); style.id = 'ytm-chan-tag-style'; document.head?.appendChild(style); }
    if (style) style.textContent = css;
  } catch {}
}

async function loadTaggedChannelIdsFromStorage(): Promise<void> {
  try {
    const o = await chrome.storage.local.get('settings.channelTagsById');
    const map = (o?.['settings.channelTagsById'] && typeof o['settings.channelTagsById'] === 'object') ? (o['settings.channelTagsById'] as Record<string, string[]>) : {};
    const next = new Set<string>();
    for (const [id, tags] of Object.entries(map || {})) {
      if ((tags || []).some(t => String(t || '').toLowerCase() === 'tagged')) next.add(id);
    }
    taggedChannelIds = next;
  } catch { taggedChannelIds = new Set(); }
}

function channelIdFromAnchor(a: HTMLAnchorElement): string | null {
  try { const u = new URL(a.href, location.origin); const seg = (u.pathname || '').split('/'); if (seg[1] === 'channel' && seg[2]) return seg[2]; }
  catch {}
  return null;
}
function isHandleAnchor(a: HTMLAnchorElement): boolean {
  try { return a.pathname?.startsWith('/@') || a.getAttribute('href')?.startsWith('/@') || false; } catch { return false; }
}
function extractHandleFromAnchor(a: HTMLAnchorElement): string | null {
  try {
    const href = a.getAttribute('href') || '';
    if (href.startsWith('/@')) return href.slice(1);
    const u = new URL(a.href, location.origin);
    if (u.pathname.startsWith('/@')) return u.pathname.slice(1);
  } catch {}
  return null;
}
async function resolveHandleToChannelId(handleRaw: string): Promise<string | null> {
  const h = (handleRaw || '').trim(); if (!h) return null; const norm = h.startsWith('@') ? h : ('@' + h);
  const now = Date.now(); const cached = handleResolveCache.get(norm); if (cached && (now - cached.at) < HANDLE_CACHE_TTL) return cached.id;
  const id: string | null = await new Promise((resolve) => {
    try { chrome.runtime.sendMessage({ type: 'channels/lookupByHandle', payload: { handle: norm } } as any, (r: any) => resolve((r?.ok && r?.found && r?.id) ? String(r.id) : null)); }
    catch { resolve(null); }
  });
  handleResolveCache.set(norm, { id, at: now }); return id;
}
async function resolveNameToChannelId(nameRaw: string): Promise<string | null> {
  const nm = (nameRaw || '').trim(); if (!nm) return null;
  const now = Date.now(); const cached = nameResolveCache.get(nm.toLowerCase()); if (cached && (now - cached.at) < HANDLE_CACHE_TTL) return cached.id;
  const id: string | null = await new Promise((resolve) => {
    try { chrome.runtime.sendMessage({ type: 'channels/lookupByName', payload: { name: nm } } as any, (r: any) => resolve((r?.ok && r?.found && r?.id) ? String(r.id) : null)); }
    catch { resolve(null); }
  });
  nameResolveCache.set(nm.toLowerCase(), { id, at: now }); return id;
}

async function markChannelAnchorsIn(root: ParentNode | null) {
  if (!root) return;
  try {
    // Anchors to /channel/ or /@handle
    const anchors = Array.from(root.querySelectorAll('a[href*="/channel/"], a[href^="/@"]')) as HTMLAnchorElement[];
    const seenHref = new Set<string>();
    for (const a of anchors) {
      const hrefVal = (a.getAttribute('href') || a.href || '').trim();
      if (hrefVal && seenHref.has(hrefVal)) continue; if (hrefVal) seenHref.add(hrefVal);
      // Direct channel id link
      if (!isHandleAnchor(a)) {
        const id = channelIdFromAnchor(a);
        const on = !!(id && taggedChannelIds.has(id));
        const rootEl = tileRoot(a);
        if (on) { a.classList.add(TAGGED_CLASS); if (rootEl) rootEl.classList.add(TAGGED_CLASS); }
        else { a.classList.remove(TAGGED_CLASS); if (rootEl) rootEl.classList.remove(TAGGED_CLASS); }
        continue;
      }
      // Handle link -> resolve to channel id (async apply)
      const handle = extractHandleFromAnchor(a); if (!handle) { a.classList.remove(TAGGED_CLASS); continue; }
      const cached = handleResolveCache.get(handle.startsWith('@') ? handle : ('@' + handle));
      if (cached) {
        const id = cached.id; const on = !!(id && taggedChannelIds.has(id)); const rootEl = tileRoot(a);
        if (on) { a.classList.add(TAGGED_CLASS); if (rootEl) rootEl.classList.add(TAGGED_CLASS); }
        else { a.classList.remove(TAGGED_CLASS); if (rootEl) rootEl.classList.remove(TAGGED_CLASS); }
      } else {
        a.classList.remove(TAGGED_CLASS);
        void resolveHandleToChannelId(handle).then((id) => {
          try { const on = !!(id && taggedChannelIds.has(id)); const rootEl = tileRoot(a);
            if (on) { a.classList.add(TAGGED_CLASS); if (rootEl) rootEl.classList.add(TAGGED_CLASS); }
            else { a.classList.remove(TAGGED_CLASS); if (rootEl) rootEl.classList.remove(TAGGED_CLASS); }
          } catch {}
        });
      }
    }
    // Watch suggestions (name-only without channel link)
    try {
      const tiles = Array.from(document.querySelectorAll('ytd-compact-video-renderer')) as HTMLElement[];
      for (const tile of tiles) {
        // Skip if this tile already has a channel anchor
        const hasAnchor = !!(tile.querySelector('a[href*="/channel/"]') || tile.querySelector('a[href^="/@"]'));
        if (hasAnchor) continue;
        const meta = tile.querySelector('.yt-content-metadata-view-model') as HTMLElement | null;
        const firstChild = meta && (meta.firstElementChild as HTMLElement | null);
        const text = (firstChild?.textContent || '').trim();
        if (!text) continue;
        const id = await resolveNameToChannelId(text);
        const on = !!(id && taggedChannelIds.has(id));
        if (on) { tile.classList.add(TAGGED_CLASS); }
        else { tile.classList.remove(TAGGED_CLASS); }
      }
    } catch {}
  } catch {}
}

chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
  try {
    if (msg?.type === 'scrape/NOW') {
      (async () => {
        try {
          const path = location.pathname || '';
          // Subscriptions Feed: gate by enabled scrape presets and upsert missing channels
          if (path === '/feed/subscriptions') {
            await refreshScrapeGroups();
            const anchors = Array.from(document.querySelectorAll('a[href^="/watch"]')) as HTMLAnchorElement[];
            if (anchors.length === 0) { sendResponse?.({ ok: true, count: 0, page: 'other' }); return; }
            const groupsById = new Map<string, GroupRec>(); scrapeGroups.forEach(g => groupsById.set(g.id, g));
            const seeds: Array<{ id: string; sources: Array<{ type: string; id?: string | null }> }> = [];
            const seenIds = new Set<string>();
            const seenChan = new Set<string>();
            const markSubscribedIds = new Set<string>();
            for (const a of anchors) {
              const cand = candidateFromAnchor(a);
              if (!cand) continue;
              const ok = scrapeGroups.length > 0 && scrapeGroups.some(g => evalPresetOnCandidate(cand, g.condition, groupsById));
              if (!ok) continue;
              if (!seenIds.has(cand.id)) {
                seenIds.add(cand.id);
                seeds.push({ id: cand.id, sources: Array.isArray(cand.sources) ? cand.sources : [] });
              }
              // Upsert channel stub/pending for accepted tiles (now also flags subscribed)
              try {
                const chanId = (cand.channelId || '').trim();
                const handle = (cand.handle || '').trim();
                const name = (cand.channelName || '').trim();
                if (chanId || handle || name) {
                  const key = chanId ? `id:${chanId}` : (handle ? `handle:${handle.startsWith('@') ? handle : ('@' + handle)}` : `name:${name}`);
                  if (!seenChan.has(key)) {
                    seenChan.add(key);
                    if (chanId) {
                      chrome.runtime.sendMessage({ type: 'channels/upsertStub', payload: { id: chanId, name: name || null, handle: handle || null } });
                      markSubscribedIds.add(chanId);
                    } else {
                      const handleKey = handle ? (handle.startsWith('@') ? handle : ('@' + handle)) : null;
                      const pendKey = handleKey ? `handle:${handleKey}` : (name ? `name:${name}` : null);
                      if (pendKey && !pendingKeysSubmitted.has(pendKey)) {
                        pendingKeysSubmitted.add(pendKey);
                        chrome.runtime.sendMessage({ type: 'channels/upsertPending', payload: { key: pendKey, name: name || null, handle: handleKey || null, subscribedPending: true } });
                      }
                    }
                  }
                }
              } catch {}
            }
            // Batch submit accepted seeds (background will append SubscriptionsFeed source override)
            if (seeds.length) {
              for (let i = 0; i < seeds.length; i += 50) {
                const batch = seeds.slice(i, i + 50);
                try { chrome.runtime.sendMessage({ type: 'cache/VIDEO_SEEN_BATCH', payload: { items: batch } } as any, () => void 0); } catch {}
                await new Promise(res => setTimeout(res, 120));
              }
            }
            // Additionally (non-gated): ensure all tiles' channels are upserted and marked subscribed
            try {
              let stubs = 0, pend = 0;
              let chanLinks = 0;
              try { chanLinks = document.querySelectorAll('a.yt-core-attributed-string__link').length; } catch {}
              for (const a of anchors) {
                const cand = candidateFromAnchor(a);
                if (!cand) continue;
                const chanId = (cand.channelId || '').trim();
                const handle = (cand.handle || '').trim();
                const name = (cand.channelName || '').trim();
                if (!(chanId || handle || name)) continue;
                if (chanId) {
                  if (!seenChan.has(`id:${chanId}`)) {
                    seenChan.add(`id:${chanId}`);
                    chrome.runtime.sendMessage({ type: 'channels/upsertStub', payload: { id: chanId, name: name || null, handle: handle || null } });
                  }
                  markSubscribedIds.add(chanId);
                  stubs++;
                } else {
                  const handleKey = handle ? (handle.startsWith('@') ? handle : ('@' + handle)) : null;
                  const pendKey = handleKey ? `handle:${handleKey}` : (name ? `name:${name}` : null);
                  if (pendKey && !pendingKeysSubmitted.has(pendKey)) {
                    pendingKeysSubmitted.add(pendKey);
                    chrome.runtime.sendMessage({ type: 'channels/upsertPending', payload: { key: pendKey, name: name || null, handle: handleKey || null, subscribedPending: true } });
                    pend++;
                  }
                }
              }
              const ids = Array.from(markSubscribedIds.values());
              if (ids.length) { try { chrome.runtime.sendMessage({ type: 'channels/markSubscribed', payload: { ids } }); } catch {} }
              // eslint-disable-next-line no-console
              console.log('[YT-Manager][SubFeed][active] channels', { stubs, pend, marked: ids.length, chanLinks });
            } catch {}
            sendResponse?.({ ok: true, count: seeds.length, page: 'sub' });
            return;
          }

          const info = await scrapeNowDetailedAsync();
          // Also upsert channels present on Watch History tiles for better coverage
          try {
            if (path.startsWith('/feed/history')) {
              const anchors = Array.from(document.querySelectorAll(
                'a#thumbnail[href^="/watch"], a#video-title[href^="/watch"], a#video-title-link[href^="/watch"], ytd-rich-item-renderer a[href^="/watch"]'
              )) as HTMLAnchorElement[];
              const seenChan = new Set<string>();
              for (const a of anchors) {
                const root = tileRoot(a);
                const c = extractChannelIdFromTile(root);
                const chanId = (c.channelId || '').trim();
                const handle = (c.handle || '').trim();
                const name = (c.name || '').trim();
                if (!chanId && !handle && !name) continue;
                const key = chanId ? `id:${chanId}` : (handle ? `handle:${handle.startsWith('@') ? handle : ('@'+handle)}` : `name:${name}`);
                if (seenChan.has(key)) continue; seenChan.add(key);
                try {
                  if (chanId) {
                    chrome.runtime.sendMessage({ type: 'channels/upsertStub', payload: { id: chanId, name: name || null, handle: handle || null } });
                  } else {
                    const handleKey = handle ? (handle.startsWith('@') ? handle : ('@' + handle)) : null;
                    const pendKey = handleKey ? `handle:${handleKey}` : (name ? `name:${name}` : null);
                    if (pendKey && !pendingKeysSubmitted.has(pendKey)) {
                      pendingKeysSubmitted.add(pendKey);
                      chrome.runtime.sendMessage({ type: 'channels/upsertPending', payload: { key: pendKey, name: name || null, handle: handleKey || null } });
                    }
                  }
                } catch {}
              }
            }
          } catch {}
          sendResponse?.({ ok: true, ...info });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      })();
      return true; // keep channel open for async
    } else if (msg?.type === 'channel/RESOLVE_ID_NOW') {
      (async () => {
        try {
          const handle = getChannelHandleNow() || (location.pathname.startsWith('/@') ? location.pathname.slice(1) : null);
          const result = await resolveChannelIdWithRetries(20, 250); // up to ~5s
          if (result.id) {
            try { dlog('[content] manual resolve channel id', { id: result.id, handle, from: result.from }); } catch {}
            try { chrome.runtime.sendMessage({ type: 'channels/resolvePending', payload: { id: result.id, handle } }); } catch {}
            sendResponse?.({ ok: true, id: result.id, from: result.from });
          } else {
            sendResponse?.({ ok: false, error: 'Not found', fromTried: result.from });
          }
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      })();
      return true;
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
    } else if (msg?.type === 'scrape/SCROLL_BOTTOM') {
      // Force scroll to the bottom to nudge infinite loader
      (async () => {
        try {
          const delay = Math.max(100, Math.min(4000, Number(msg?.payload?.delayMs ?? 600)));
          const times = Math.max(1, Math.min(10, Number(msg?.payload?.times ?? 2)));
          for (let i = 0; i < times; i++) {
            try { window.scrollTo({ top: (document.documentElement?.scrollHeight || document.body?.scrollHeight || 9999999), behavior: 'instant' as any }); } catch {}
            await new Promise(res => setTimeout(res, delay));
          }
          sendResponse?.({ ok: true });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      })();
      return true;
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
        const stopAtId = typeof msg?.payload?.stopAtId === 'string' ? String(msg.payload.stopAtId) : '';
        // Detailed scan like the manual snippet
        const stats = scanCurrentAnchors(what);
        // Channel link count (best-effort). On Sub Feed, these are the channel-name anchors.
        let channelLinks = 0;
        try {
          if (what === 'SubscriptionsFeed') {
            channelLinks = document.querySelectorAll('a.yt-core-attributed-string__link').length;
          }
        } catch { channelLinks = 0; }
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
                    'stall:', stall,
                    'channels(links):', channelLinks);
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
        // First id on page (best-effort)
        // SubscriptionsFeed: choose the first non-livestream tile (badge text is 'LIVE' for livestreams)
        // Other modes: fallback to the first anchor with an id
        let firstId: string | null = null;
        try {
          let a: HTMLAnchorElement | null = null;
          if (what === 'SubscriptionsFeed') {
            const pick = (stats.withId || []).find((el) => {
              try {
                const root = tileRoot(el);
                return !isLivestreamTile(root);
              } catch { return true; }
            });
            a = pick || null;
          } else {
            a = (stats.withId && stats.withId.length > 0) ? stats.withId[0] : null;
          }
          if (a) { try { firstId = parseVideoIdFromHref(a.href); } catch { firstId = null; } }
        } catch { firstId = null; }
        const foundStopId = !!(stopAtId && stats.uniques.includes(stopAtId));
        sendResponse?.({ ok: true, dom: { passUnique: stats.uniques.length, cumulativeUnique: domUniqueSeen.size, firstId, channelLinks }, foundStopId });
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

function getChannelIdNow(): { id: string | null; from: string[] } {
  const from: string[] = [];
  // Decide by page context
  const ctx = (() => { try { return detectPageContext(); } catch { return { page: 'other' } as any; } })();
  if (ctx?.page === 'channel') {
    // Only use canonical link on channel pages to avoid sidebar/other-channel mismatches
    try {
      const link = document.querySelector('link[rel="canonical"][href*="/channel/"]') as HTMLLinkElement | null;
      if (link?.href) {
        const u = new URL(link.href);
        const seg = u.pathname.split('/');
        if (seg[1] === 'channel' && seg[2]) { from.push('canonical'); return { id: seg[2], from }; }
      }
    } catch {}
    return { id: null, from };
  }
  if (ctx?.page === 'watch') {
    // Prefer subscribe-button holder with data-channel-external-id
    try {
      const el = (document.querySelector('#subscribe-button .add-to-collection-button-new[data-channel-external-id]') as HTMLElement | null)
             || (document.querySelector('#subscribe-button [data-channel-external-id]') as HTMLElement | null)
             || (document.querySelector('[data-channel-external-id]') as HTMLElement | null);
      const val = el?.getAttribute('data-channel-external-id');
      if (val) { from.push('subscribe-button'); return { id: val, from }; }
    } catch {}
    // Fallback: owner link
    try {
      const a = (document.querySelector('ytd-video-owner-renderer a[href^="/channel/"]') as HTMLAnchorElement | null)
             || (document.querySelector('#owner a[href^="/channel/"]') as HTMLAnchorElement | null);
      if (a?.href) {
        const u = new URL(a.href, location.origin);
        const seg = u.pathname.split('/');
        if (seg[1] === 'channel' && seg[2]) { from.push('owner-link'); return { id: seg[2], from }; }
      }
    } catch {}
    return { id: null, from };
  }
  // Other pages: no generic resolution
  return { id: null, from };
}

async function resolveChannelIdWithRetries(maxTries: number, delayMs: number): Promise<{ id: string | null; from: string[] }> {
  for (let i = 0; i < maxTries; i++) {
    const { id, from } = getChannelIdNow();
    try { dlog('[content] resolve try', { n: i + 1, found: !!id, from }); } catch {}
    if (id) return { id, from };
    await new Promise(res => setTimeout(res, delayMs));
  }
  return { id: null, from: [] };
}

// Setting: auto-stub on watch pages (default ON)
let autoStubOnWatch = true;
try {
  chrome.storage?.local?.get('autoStubOnWatch', (o) => {
    if (typeof o?.autoStubOnWatch === 'boolean') autoStubOnWatch = o.autoStubOnWatch; else autoStubOnWatch = true;
  });
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
      // One-shot immediate stub capture on SPA navigation (independent of auto loop)
      try {
        const vid = (ctx as any).videoId || null;
        void (async () => {
          try { await scrapeWatchStub(); } catch {}
          try { if (vid) { lastWatchStubId = String(vid); lastWatchStubAt = Date.now(); } } catch {}
        })();
      } catch {}
    } else {
      // Stop tracker when leaving watch pages
      try { stopWatchProgressTracking(); } catch {}
    }
    // On channel pages, resolve pending channel handle/name to id (with retries for SPA renders)
    if (ctx.page === 'channel') {
      const getIdNow = (): { id: string | null; from: string[] } => {
        const from: string[] = [];
        // Only use canonical link while on channel pages
        try {
          const link = document.querySelector('link[rel="canonical"][href*="/channel/"]') as HTMLLinkElement | null;
          if (link?.href) {
            const u = new URL(link.href);
            const seg = u.pathname.split('/');
            if (seg[1] === 'channel' && seg[2]) { from.push('canonical'); return { id: seg[2], from }; }
          }
        } catch {}
        return { id: null, from };
      };
      const handle = getChannelHandleNow() || (location.pathname.startsWith('/@') ? location.pathname.slice(1) : null);
      const initial = ctx.channelId || getIdNow().id;
      if (initial) {
        try {
          dlog('[content] resolvePending channel', { id: initial, handle, mode: 'initial' });
          chrome.runtime.sendMessage({ type: 'channels/resolvePending', payload: { id: initial, handle } });
          } catch {}
      } else if (handle) {
        // Poll for a short period to allow SPA to render canonical/attrs
        let tries = 0; const max = 30; const delay = 300; // ~9s max
        try { dlog('[content] resolvePending channel', { handle, mode: 'start-poll', max, delay }); } catch {}
        const timer = setInterval(() => {
          try {
            const { id, from } = getIdNow();
            try { dlog('[content] resolvePending channel try', { n: tries + 1, from, found: !!id }); } catch {}
            if (id) {
              try { dlog('[content] resolvePending channel (delayed)', { id, handle, from }); } catch {}
              try { chrome.runtime.sendMessage({ type: 'channels/resolvePending', payload: { id, handle } }); } catch {}
              clearInterval(timer);
            } else if (++tries >= max) {
              try { dlog('[content] resolvePending channel timeout', { handle }); } catch {}
              clearInterval(timer);
            }
          } catch { clearInterval(timer); }
        }, delay);
      }
    }
    // Start or stop auto-scrape ticker based on page
    try { setupAutoScrapeTicker(); } catch (e) { dwarn('ticker error', e); }
    // Re-apply tagged channel highlights on navigation
    try { ensureTaggedHighlightStyles(); void loadTaggedChannelIdsFromStorage().then(() => void markChannelAnchorsIn(document)); } catch {}
  });
} catch {}

// ---- Universal auto-scrape (preset-gated) ----
// Track cumulative DOM-unique ids for the current scraping mode (Sub Feed or History)

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
  if (tickerTimeout != null) { clearTimeout(tickerTimeout as any); tickerTimeout = null; }
  // Reset state
  autoSpeed = 'fast';
  lastSignature = null;
  sameSignatureCount = 0;
  autoDisabled = false;
  lastScrollY = window.scrollY || 0;
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
  // Start scheduler
  void refreshScrapeGroups();
  scheduleNextAutoScan(2000);
  dlog('[content] auto-scrape scheduler started');
  // listen for group changes
  try {
    const h = (msg: any) => { if (msg?.type === 'db/change' && msg?.payload?.entity === 'groups') void refreshScrapeGroups(); };
    chrome.runtime.onMessage.addListener(h);
  } catch {}
}

function scheduleNextAutoScan(ms: number) {
  if (tickerTimeout != null) { clearTimeout(tickerTimeout as any); }
  tickerTimeout = setTimeout(async () => {
    try {
      if (!autoDisabled) {
        const res = await autoScanOnce();
        const sig = res?.signature || '';
        const hasSig = sig.length > 0; // only count non-empty signatures (uniqueIds > 0)
        if (hasSig) {
          if (lastSignature != null && sig === lastSignature) {
            sameSignatureCount += 1;
          } else {
            sameSignatureCount = 0;
          }
          lastSignature = sig;
        }
        if (autoSpeed === 'fast' && sameSignatureCount >= 3) {
          autoSpeed = 'slow';
          sameSignatureCount = 0;
        } else if (autoSpeed === 'slow' && sameSignatureCount >= 3) {
          autoDisabled = true; // disable until scroll progress threshold
          dlog('[content] auto-scrape disabled due to repeated identical results');
        }
      }
    } catch {}
    if (!autoDisabled) {
      scheduleNextAutoScan(autoSpeed === 'fast' ? 2000 : 4000);
    }
  }, Math.max(250, ms)) as any;
}

function tileRoot(a: HTMLAnchorElement): HTMLElement | null {
  const sel = 'yt-lockup-view-model, ytd-rich-item-renderer, ytd-grid-video-renderer, ytd-video-renderer, ytd-compact-video-renderer';
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
    const h = (root.querySelector('ytd-channel-name a[href^="/@"]') as HTMLAnchorElement | null)
           || (root.querySelector('a[href^="/@"]') as HTMLAnchorElement | null);
    if (h?.href) {
      const u = new URL(h.href, location.origin);
      const handle = u.pathname.slice(1);
      const name = (h.textContent || '').trim() || null;
      return { handle, name };
    }
    return {};
  } catch { return {}; }
}

// Determine if a tile represents a livestream by inspecting common badge elements
function isLivestreamTile(root: HTMLElement | null): boolean {
  try {
    if (!root) return false;
    // New badge shape style
    try {
      const badges = Array.from(root.querySelectorAll('.yt-badge-shape__text')) as HTMLElement[];
      for (const el of badges) {
        const t = (el.textContent || '').trim().toUpperCase();
        if (t === 'LIVE') return true;
      }
    } catch { /* ignore */ }
    // Fallback: classic overlay time/status renderer
    try {
      const status = root.querySelector('ytd-thumbnail-overlay-time-status-renderer') as HTMLElement | null;
      const txt = (status?.textContent || '').trim().toUpperCase();
      if (txt === 'LIVE') return true;
    } catch { /* ignore */ }
  } catch { /* ignore */ }
  return false;
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
      const anchors = Array.from(document.querySelectorAll('a[href^="/watch"]')) as HTMLAnchorElement[];
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
    ? 'a[href^="/watch"]'
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
    ? 'a[href^="/watch"]'
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
  // Title from tile (prefer title anchor/content; avoid picking duration badges)
  let title: string | null = null;
  try {
    const tEl = (root?.querySelector('a.yt-lockup-metadata-view-model__title .yt-core-attributed-string') as HTMLElement | null)
             || (root?.querySelector('a.yt-lockup-metadata-view-model__title') as HTMLElement | null)
             || (root?.querySelector('#video-title') as HTMLElement | null)
             || (root?.querySelector('a#video-title') as HTMLElement | null)
             || (root?.querySelector('a#video-title-link') as HTMLElement | null)
             || (a as HTMLElement | null);
    let t = (tEl?.textContent || (tEl as any)?.title || '').toString().trim();
    // Filter out duration-only or LIVE badges if fallback picked the thumbnail anchor
    const isDurationOnly = /^\d{1,2}:\d{2}$/.test(t);
    if (t && !isDurationOnly && t.toUpperCase() !== 'LIVE') title = t; else title = null;
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
    switch (p.kind) {
      case 'sourceAny':
      case 'sourcePlaylistAny':
        return true; // always derivable from sources array
      case 'channelIdIn': {
        const hasChan = !!(c.channelId || c.handle || c.channelName);
        return hasChan; // require some channel identifier/name present
      }
      case 'titleRegex': {
        const hasTitle = !!(c.title && String(c.title).trim());
        return hasTitle; // require a title string to apply regex meaningfully
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
        // Unknown at scrape time: preset should not be applied
        return false;
    }
  }
  if (!isCheckable(cond as any, new Set())) return false;
  return evalCond(cond as any);
}

async function autoScanOnce(): Promise<{ signature: string; accepted: number }> {
  // Ensure scrapeGroups reflect current default preset and user presets
  try { await refreshScrapeGroups(); } catch {}
  const gatingEnabled = scrapeGroups.length > 0;
  // Idle gating: only scrape within 10s of last user interaction
  const idleMs = Date.now() - lastActivityAt;
  if (idleMs > 10_000) { dlog('[content] idle, skipping scan', idleMs); return { signature: '', accepted: 0 }; }
  const ctx = detectPageContext();
  // Exclude channel pages and all playlist pages
  try {
    const onChannel = ctx?.page === 'channel';
    const onPlaylist = !!getPlaylistIdFromURL();
    if (onChannel || onPlaylist) return { signature: '', accepted: 0 };
  } catch { /* ignore */ }
    const currentWatchId: string | null = ctx.page === 'watch' ? (ctx as any).videoId || null : null;
  // Always ensure current watch video is captured with title/channel when available
  if (currentWatchId) {
    try {
      if (currentWatchId !== lastWatchStubId || (Date.now() - lastWatchStubAt) > 15000) {
        dlog('[content] scrape watch stub', currentWatchId);
        try { await scrapeWatchStub(); } catch {}
        lastWatchStubId = currentWatchId;
        lastWatchStubAt = Date.now();
      }
    } catch {}
  }  // Collect anchors for watch + common tiles. On search results, include /shorts/ anchors too.
  // Apply channel highlights each interval (handles anchors and watch name-only tiles)
  try { ensureTaggedHighlightStyles(); await loadTaggedChannelIdsFromStorage(); await markChannelAnchorsIn(document); } catch {}
  let sel = 'a[href^="/watch"]';
  try { if (location.pathname.startsWith('/results')) sel += ', a[href^="/shorts/"]'; } catch {}
  const anchors = Array.from(document.querySelectorAll(sel)) as HTMLAnchorElement[];
  dlog('[content] scan anchors', anchors.length);
  if (anchors.length === 0) return { signature: '', accepted: 0 };
  // On Sub Feed, mark latest (first non-livestream tile) once per change
  try {
    if (location.pathname === '/feed/subscriptions') {
      const a = anchors.find((el) => { try { const root = tileRoot(el); return !isLivestreamTile(root); } catch { return true; } });
      if (a) {
        let id: string | null = null; try { id = parseVideoIdFromHref(a.href); } catch { id = null; }
        if (id && id !== lastSubFeedLatestId) {
          lastSubFeedLatestId = id;
          try { chrome.runtime.sendMessage({ type: 'latest/mark', payload: { source: 'SubscriptionsFeed', id, createIfMissing: true } }); } catch {}
          dlog('[content][subfeed] mark latest', id);
        }
      }
    }
  } catch {}
  // On Subscriptions Feed, upsert channel stubs/pending for ALL tiles and mark them as subscribed
  try {
    if (location.pathname === '/feed/subscriptions') {
      const seenIds = new Set<string>();
      const markIds = new Set<string>();
      let stubs = 0, pend = 0;
      let chanLinks = 0;
      try { chanLinks = document.querySelectorAll('a.yt-core-attributed-string__link').length; } catch {}
      for (const a of anchors) {
        const c = candidateFromAnchor(a);
        if (!c) continue;
        // Prefer concrete channel id
        if (c.channelId) {
          if (!seenIds.has(c.channelId)) {
            seenIds.add(c.channelId);
            try { chrome.runtime.sendMessage({ type: 'channels/upsertStub', payload: { id: c.channelId, name: c.channelName || null, handle: c.handle || null } }); } catch {}
            markIds.add(c.channelId);
            stubs++;
          }
        } else if (c.handle || c.channelName) {
          // Pending entry with subscribedPending so later resolve promotes subscribed=true
          const handleKey = c.handle ? (c.handle!.startsWith('@') ? c.handle! : `@${c.handle!}`) : null;
          const key = handleKey ? `handle:${handleKey}` : (c.channelName ? `name:${c.channelName}` : null);
          if (key && !pendingKeysSubmitted.has(key)) {
            pendingKeysSubmitted.add(key);
            try { chrome.runtime.sendMessage({ type: 'channels/upsertPending', payload: { key, name: c.channelName || null, handle: handleKey || null, subscribedPending: true } }); } catch {}
            pend++;
          }
        }
      }
      const ids = Array.from(markIds.values());
      if (ids.length) {
        try { chrome.runtime.sendMessage({ type: 'channels/markSubscribed', payload: { ids } }); } catch {}
      }
      dlog('[content][subfeed] passive channels', { stubs, pend, marked: ids.length, chanLinks });
    }
  } catch {}
  // Build total (non-gated) signature from unique ids in anchors
  const idSetAll = new Set<string>();
  for (const a of anchors) {
    try { const vid = parseVideoIdFromHref(a.href); if (vid) idSetAll.add(vid); } catch {}
  }
  const groupsById = new Map<string, GroupRec>(); scrapeGroups.forEach(g => groupsById.set(g.id, g));
  const accepted: Cand[] = [];
  if (gatingEnabled) {
    for (const a of anchors) {
      const cand = candidateFromAnchor(a);
      if (!cand) continue;
      // gate by any enabled preset
      const ok = scrapeGroups.some(g => evalPresetOnCandidate(cand, g.condition, groupsById));
      if (ok) accepted.push(cand);
    }
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
  // Build signature from total ids (sorted, capped) — independent of preset gating
  const sigIds = Array.from(idSetAll.values()).slice(0, 200).sort();
  const signature = sigIds.join('|');
  return { signature, accepted: sigIds.length };
}

// Reactivate auto-scrape on scroll based on page-specific thresholds when disabled
function getPageReactivateThresholdPct(): number {
  try {
    const path = location.pathname || '';
    if (path.startsWith('/results')) return 0.99; // Search page: 99%
    if (path === '/feed/subscriptions') return 0.89; // Sub Feed: 89%
    if (path === '/' || path === '/feed/what_to_watch') return 0.81; // Home: 81%
    const ctx = detectPageContext();
    if (ctx?.page === 'watch') return 0.40; // Watch page: 40%
  } catch {}
  return 0.60; // default for other pages
}
function getScrollProgress(): number {
  try {
    const doc = document.documentElement;
    const max = Math.max(1, (doc.scrollHeight || 0) - (window.innerHeight || 0));
    const y = Math.max(0, window.scrollY || window.pageYOffset || 0);
    return Math.max(0, Math.min(1, y / max));
  } catch { return 0; }
}
try {
  window.addEventListener('scroll', () => {
    try { markActive(); } catch {}
    const y = window.scrollY || 0;
    const goingDown = y > lastScrollY;
    lastScrollY = y;
    if (autoDisabled && goingDown) {
      const pct = getScrollProgress();
      const need = getPageReactivateThresholdPct();
      if (pct >= need) {
        dlog('[content] auto-scrape reactivated at', Math.round(pct * 100), '%');
        autoDisabled = false;
        autoSpeed = 'slow';
        sameSignatureCount = 0;
        scheduleNextAutoScan(4000);
      }
    }
  }, { passive: true });
} catch {}

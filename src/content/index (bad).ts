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
// Start channel tagged highlighter on initial load
try { startChannelTagHighlighter(); } catch {}
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
// Marks channel elements for channels that have the default tag "tagged"
let taggedChannelIds = new Set<string>();
let channelTagHLObserver: MutationObserver | null = null;
let channelTagHLStarted = false;
const handleResolveCache = new Map<string, { id: string | null; at: number }>();
const HANDLE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const nameResolveCache = new Map<string, { id: string | null; at: number }>();
let taggedIdsLoadedOnce = false;
let taggedIdsLastSize = 0;
function hlog(...a: any[]) { try { console.log('[YT-Manager][HL]', ...a); } catch {} }
const TAGGED_CLASS = 'ytm-channel-tagged';

function ensureTaggedHighlightStyles() {
  try {
    const css = `
      .${TAGGED_CLASS} { border: 3px solid #5edf8b !important; border-radius: 3px; box-sizing: border-box; }
      a.${TAGGED_CLASS}, .yt-core-attributed-string__link.${TAGGED_CLASS}, .yt-simple-endpoint.${TAGGED_CLASS} { display: inline-block !important; }
    `;
    let style = document.getElementById('ytm-chan-tag-style') as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement('style');
      style.id = 'ytm-chan-tag-style';
      document.head?.appendChild(style);
    }
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
    taggedIdsLoadedOnce = true;
    taggedIdsLastSize = taggedChannelIds.size;
  } catch { taggedChannelIds = new Set(); }
}

function channelIdFromAnchor(a: HTMLAnchorElement): string | null {
  try {
    const u = new URL(a.href, location.origin);
    const seg = (u.pathname || '').split('/');
    if (seg[1] === 'channel' && seg[2]) return seg[2];
  } catch {}
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
  const h = (handleRaw || '').trim();
  if (!h) return null;
  const norm = h.startsWith('@') ? h : ('@' + h);
  const now = Date.now();
  const cached = handleResolveCache.get(norm);
  if (cached && (now - cached.at) < HANDLE_CACHE_TTL) { return cached.id; }
  const id: string | null = await new Promise((resolve) => {
    try { chrome.runtime.sendMessage({ type: 'channels/lookupByHandle', payload: { handle: norm } } as any, (r: any) => resolve((r?.ok && r?.found && r?.id) ? String(r.id) : null)); }
    catch { resolve(null); }
  });
  handleResolveCache.set(norm, { id, at: now });
  return id;
}

async function resolveNameToChannelId(nameRaw: string): Promise<string | null> {
  const nm = (nameRaw || '').trim();
  if (!nm) return null;
  const now = Date.now();
  const cached = nameResolveCache.get(nm.toLowerCase());
  if (cached && (now - cached.at) < HANDLE_CACHE_TTL) { return cached.id; }
  const id: string | null = await new Promise((resolve) => {
    try { chrome.runtime.sendMessage({ type: 'channels/lookupByName', payload: { name: nm } } as any, (r: any) => resolve((r?.ok && r?.found && r?.id) ? String(r.id) : null)); }
    catch { resolve(null); }
  });
  nameResolveCache.set(nm.toLowerCase(), { id, at: now });
  return id;
}

async function markChannelAnchorsIn(root: ParentNode | null) {
  if (!root) return;
  try {
    const anchorsRaw = Array.from(root.querySelectorAll('a[href*="/channel/"], a[href^="/@"]')) as HTMLAnchorElement[];
    const anchors = anchorsRaw.filter(el => isVisible(el));
    const tagged: Array<{ type: 'anchor'|'name'; id?: string|null; handle?: string|null; href?: string; text?: string }> = [];
    const notTagged: Array<{ type: 'anchor'|'name'; id?: string|null; handle?: string|null; href?: string; text?: string }> = [];
    const pendingHandleResolves: string[] = [];
    const handleCachedNull: string[] = [];
    const nameLookupMisses: string[] = [];
    const seenHref = new Set<string>();
    for (const a of anchors) {
      const hrefVal = (a.getAttribute('href') || a.href || '').trim();
      if (hrefVal && seenHref.has(hrefVal)) continue; if (hrefVal) seenHref.add(hrefVal);
      // Direct channel id link
      if (!isHandleAnchor(a)) {
        let id: string | null = null;
        try { id = channelIdFromAnchor(a); } catch { id = null; }
        const on = !!(id && taggedChannelIds.has(id));
        const root = tileRoot(a);
        if (on) {
          a.classList.add(TAGGED_CLASS);
          if (root) root.classList.add(TAGGED_CLASS);
          tagged.push({ type: 'anchor', id, href: hrefVal, text: (a.textContent || '').trim() });
        } else {
          a.classList.remove(TAGGED_CLASS);
          if (root) root.classList.remove(TAGGED_CLASS);
          notTagged.push({ type: 'anchor', id, href: hrefVal, text: (a.textContent || '').trim() });
        }
        continue;
      }
      // Handle link -> resolve to channel id
      const handle = extractHandleFromAnchor(a);
      if (!handle) { a.classList.remove(TAGGED_CLASS); continue; }
      const cached = handleResolveCache.get(handle.startsWith('@') ? handle : ('@' + handle));
      if (cached) {
        const id = cached.id;
        const on = !!(id && taggedChannelIds.has(id));
        const root = tileRoot(a);
        if (on) {
          a.classList.add(TAGGED_CLASS);
          if (root) root.classList.add(TAGGED_CLASS);
          tagged.push({ type: 'anchor', id, handle, href: hrefVal, text: (a.textContent || '').trim() });
        } else {
          a.classList.remove(TAGGED_CLASS);
          if (root) root.classList.remove(TAGGED_CLASS);
          notTagged.push({ type: 'anchor', id, handle, href: hrefVal, text: (a.textContent || '').trim() });
          if (id == null) handleCachedNull.push(handle.startsWith('@') ? handle : ('@' + handle));
        }
      } else {
        a.classList.remove(TAGGED_CLASS);
        pendingHandleResolves.push(handle.startsWith('@') ? handle : ('@' + handle));
        // Fire and apply for this anchor only
        void resolveHandleToChannelId(handle).then((id) => {
          try {
            const on = !!(id && taggedChannelIds.has(id));
            const root = tileRoot(a);
            if (on) { a.classList.add(TAGGED_CLASS); if (root) root.classList.add(TAGGED_CLASS); }
            else { a.classList.remove(TAGGED_CLASS); if (root) root.classList.remove(TAGGED_CLASS); }
          } catch {}
        });
      }
    }
        // Also process watch suggestions (name-only without channel link)
    try {
      const tiles = Array.from(document.querySelectorAll('ytd-compact-video-renderer')) as HTMLElement[];
      for (const tile of tiles) {
        if (!isVisible(tile)) continue;
        const hasAnchor = !!(tile.querySelector('a[href*="/channel/"]') || tile.querySelector('a[href^="/@"]'));
        if (hasAnchor) continue;
        const meta = tile.querySelector('.yt-content-metadata-view-model') as HTMLElement | null;
        const firstChild = meta && (meta.firstElementChild as HTMLElement | null);
        const text = (firstChild?.textContent || '').trim();
        if (!text) continue;
        const id = await resolveNameToChannelId(text);
        const on = !!(id && taggedChannelIds.has(id));
        if (on) {
          tile.classList.add(TAGGED_CLASS);
          tagged.push({ type: 'name', id, text });
        } else {
          tile.classList.remove(TAGGED_CLASS);
          notTagged.push({ type: 'name', id, text });
          if (!id) nameLookupMisses.push(text);
        }
      }
    } catch {}  } catch {}
}

// Tile root for better-visible container border
function tileRoot(a: HTMLAnchorElement): HTMLElement | null {
  try {
    const sel = 'yt-lockup-view-model, ytd-rich-item-renderer, ytd-grid-video-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-channel-name';
    return a.closest(sel) as HTMLElement | null;
  } catch { return null; }
}

function isVisible(el: Element): boolean {
  try {
    const rect = (el as HTMLElement).getBoundingClientRect();
    const hasBox = !!rect && (rect.width > 0 || rect.height > 0);
    const style = window.getComputedStyle(el as Element);
    const vis = style?.visibility !== 'hidden' && style?.display !== 'none' && parseFloat(style?.opacity || '1') > 0.01;
    return hasBox && vis;
  } catch { return true; }
}

function applyTaggedHighlightOnChannelPageHeader() {
  try {
    const ctx = detectPageContext();
    if (ctx?.page === 'channel' && ctx?.channelId && taggedChannelIds.has(String(ctx.channelId))) {
      const headerA = (document.querySelector('ytd-c4-tabbed-header-renderer #channel-name a[href]') as HTMLAnchorElement | null)
                   || (document.querySelector('ytd-c4-tabbed-header-renderer a[href^="/channel/"]') as HTMLAnchorElement | null)
                   || (document.querySelector('ytd-channel-name a[href^="/channel/"]') as HTMLAnchorElement | null);
      if (headerA) headerA.classList.add(TAGGED_CLASS);
    }
  } catch {}
}

function startChannelTagHighlighter() {
  try {
    if (channelTagHLStarted) return;
    channelTagHLStarted = true;
    ensureTaggedHighlightStyles();
    // Initial load, then apply once
    void loadTaggedChannelIdsFromStorage().then(() => {
      void markChannelAnchorsIn(document);
      try { applyTaggedHighlightOnChannelPageHeader(); } catch {}
    });
    // Re-apply on settings changes
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if ((changes as any)['settings.channelTagsById']) {
          void loadTaggedChannelIdsFromStorage().then(() => {
            void markChannelAnchorsIn(document);
            try { applyTaggedHighlightOnChannelPageHeader(); } catch {}
          });
        }
      });
    } catch {}
  } catch {}
}

function setupAutoScrapeTicker() {
  try {
    if (ticker != null) { clearInterval(ticker as any); ticker = null; }
    const mark = () => { try { lastActivityAt = Date.now(); } catch {} };
    try {
      window.addEventListener('mousemove', mark, { passive: true });
      window.addEventListener('scroll', mark, { passive: true });
      window.addEventListener('click', mark, { passive: true });
      window.addEventListener('keydown', mark, { passive: true });
    } catch {}
  } catch {}
  ticker = setInterval(async () => {
    try { ensureTaggedHighlightStyles(); await markChannelAnchorsIn(document); applyTaggedHighlightOnChannelPageHeader(); } catch {}
  }, 2000) as any;
}
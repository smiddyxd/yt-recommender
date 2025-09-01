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
  // If only handle/name known, record pending channel for later resolution
  if (!ch.channelId && (ch.handle || ch.name)) {
    const key = ch.handle ? `handle:@${ch.handle}` : (ch.name ? `name:${ch.name}` : null);
    if (key) try { chrome.runtime.sendMessage({ type: 'channels/upsertPending', payload: { key, name: ch.name || null, handle: ch.handle || null } }); } catch {}
  } else if (ch.channelId) {
    // If we do have id, upsert a channel stub so directory fills in
    try { chrome.runtime.sendMessage({ type: 'channels/upsertStub', payload: { id: ch.channelId, name: ch.name || null, handle: ch.handle || null } }); } catch {}
  }
  return { id, sources: src, channelId: ch.channelId || null, handle: ch.handle || null, channelName: ch.name || null, title };
}

function evalPresetOnCandidate(c: Cand, cond: Condition, groupsById: Map<string, GroupRec>): boolean {
  function isCheckable(node: any, seen: Set<string>): boolean {
    if (!node) return true;
    if ('all' in node) return (Array.isArray(node.all) ? node.all : []).every(n => isCheckable(n, seen));
    if ('any' in node) return (Array.isArray(node.any) ? node.any : []).every(n => isCheckable(n, seen));
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
        return src.some(s => items.some(it => (s?.type || '') === (it?.type || '') && ((s?.id ?? null) === (it?.id ?? null))));
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
        return (id && set.has(id)) || (handle && (set.has(handle) || set.has(handleBare))) || (name && set.has(name));
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
    'a#thumbnail[href^="/watch"], a#video-title[href^="/watch"], a#video-title-link[href^="/watch"], a#thumbnail[href^="/shorts/"], a[href^="/shorts/"]'
  )) as HTMLAnchorElement[];
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

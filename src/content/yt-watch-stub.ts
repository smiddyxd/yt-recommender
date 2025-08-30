import { parseDurationToSec } from '../types/util';

async function waitFor<T>(fn: () => T | null | undefined, tries = 6, delayMs = 200): Promise<T | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const v = fn();
      if (v) return v as T;
    } catch { /* ignore */ }
    await new Promise(res => setTimeout(res, delayMs));
  }
  return null;
}

// Scrape current watch/shorts video as a lightweight stub and progress.
// Returns 1 if a stub was sent, else 0.
export async function scrapeWatchStub(): Promise<number> {
  try {
    const url = new URL(location.href);
    const id = url.searchParams.get('v') || (location.pathname.startsWith('/shorts/') ? location.pathname.split('/')[2] : null);
    if (!id) return 0;

    const isShorts = location.pathname.startsWith('/shorts/');

    // For regular watch pages, wait until ytd-watch-flexy reflects the current video-id
    // This avoids scraping stale title/channel from the previous watch when SPA navigates.
    let flexy: HTMLElement | null = null;
    if (!isShorts) {
      flexy = await waitFor<HTMLElement>(() => {
        const el = document.querySelector('ytd-watch-flexy') as HTMLElement | null;
        if (!el) return null;
        const vidAttr = el.getAttribute('video-id');
        return vidAttr === id ? el : null;
      }, 20, 200); // up to ~4s
    }

    // Title (robust: wait briefly if not yet rendered), scoped to flexy when available
    const titleEl = await waitFor<HTMLElement>(() => (
      (flexy ? (flexy.querySelector('ytd-watch-metadata h1 yt-formatted-string') as HTMLElement | null) : null)
      || (flexy ? (flexy.querySelector('h1.ytd-watch-metadata yt-formatted-string') as HTMLElement | null) : null)
      || (document.querySelector('ytd-watch-metadata h1 yt-formatted-string') as HTMLElement | null)
      || (document.querySelector('h1.ytd-watch-metadata yt-formatted-string') as HTMLElement | null)
    ));
    const title = titleEl ? (titleEl.textContent || '').trim() || null : null;

    // Channel name (robust)
    let channelName: string | null = null;
    try {
      const chTxt = await waitFor<HTMLElement>(() => (
        flexy ? (flexy.querySelector('ytd-channel-name #text a, #channel-name #text a') as HTMLElement | null) : null
        || (document.querySelector('ytd-channel-name #text a, #channel-name #text a') as HTMLElement | null)
      ));
      channelName = chTxt?.textContent?.trim() || null;
    } catch { channelName = null; }

    // Channel ID via owner link or subscribe renderer (has data-channel-external-id)
    let channelId: string | null = null;
    try {
      const a = await waitFor<HTMLAnchorElement>(() => (
        flexy ? (flexy.querySelector('ytd-video-owner-renderer a[href^="/channel/"]') as HTMLAnchorElement | null) : null
        || (document.querySelector('ytd-video-owner-renderer a[href^="/channel/"]') as HTMLAnchorElement | null)
        || (document.querySelector('#owner a[href^="/channel/"]') as HTMLAnchorElement | null)
      ));
      if (a?.href) {
        const u = new URL(a.href, location.origin);
        const seg = u.pathname.split('/');
        if (seg[1] === 'channel' && seg[2]) channelId = seg[2];
      }
    } catch {}
    if (!channelId) {
      try {
        const el = await waitFor<HTMLElement>(() => (
          flexy ? (flexy.querySelector('[data-channel-external-id]') as HTMLElement | null) : null
          || (document.querySelector('[data-channel-external-id]') as HTMLElement | null)
        ));
        const val = el?.getAttribute('data-channel-external-id');
        if (val) channelId = val;
      } catch {}
    }

    chrome.runtime.sendMessage({ type: 'cache/VIDEO_STUB', payload: { id, title, channelName, channelId, sources: [{ type: 'WatchPage', id: null }] } });
    if (channelId) {
      // Also ensure channel stub exists (with name if we have it)
      chrome.runtime.sendMessage({ type: 'channels/upsertStub', payload: { id: channelId, name: channelName || null } });
    }

    // Progress (optional)
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
    return 1;
  } catch {
    return 0;
  }
}

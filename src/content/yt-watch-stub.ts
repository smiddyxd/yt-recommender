import { parseDurationToSec } from '../types/util';

// Scrape current watch/shorts video as a lightweight stub and progress.
// Returns 1 if a stub was sent, else 0.
export function scrapeWatchStub(): number {
  try {
    const url = new URL(location.href);
    const id = url.searchParams.get('v') || (location.pathname.startsWith('/shorts/') ? location.pathname.split('/')[2] : null);
    if (!id) return 0;

    // Title
    const titleEl = document.querySelector('ytd-watch-metadata h1 yt-formatted-string') || document.querySelector('h1.ytd-watch-metadata yt-formatted-string');
    const title = titleEl ? (titleEl as HTMLElement).textContent?.trim() || null : null;

    // Channel name
    let channelName: string | null = null;
    try {
      const chTxt = document.querySelector('ytd-channel-name #text a, #channel-name #text a') as HTMLElement | null;
      channelName = chTxt?.textContent?.trim() || null;
    } catch { channelName = null; }

    // Channel ID via canonical or owner link
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

    chrome.runtime.sendMessage({ type: 'cache/VIDEO_STUB', payload: { id, title, channelName, channelId, sources: [{ type: 'panel', id: null }] } });

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


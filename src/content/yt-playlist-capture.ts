import { SELECTORS, parseVideoIdFromHref, getPlaylistIdFromURL } from '../types/util';
import type { VideoSeed } from '../types/messages';

function q1(selList: string[]): HTMLElement | null {
  for (const s of selList) {
    const el = document.querySelector(s) as HTMLElement | null;
    if (el) return el;
  }
  return null;
}

function tileToSeed(el: HTMLElement, listId: string | null): VideoSeed | null {
  const a = el.querySelector(SELECTORS.tileLink) as HTMLAnchorElement | null;
  if (!a) return null;
  const id = parseVideoIdFromHref(a.href);
  if (!id) return null;

  // We intentionally capture only ids; metadata comes from YouTube API later

  return {
    id,
    sources: [{ type: 'playlist', id: listId }]
  };
}

function send(type: 'cache/VIDEO_SEEN', payload: VideoSeed) {
  chrome.runtime.sendMessage({ type, payload });
}

// Click-to-scrape: single pass over playlist tiles, with watch/shorts fallback
export function scrapeNow(): number {
  let sent = 0;
  const listId = getPlaylistIdFromURL();
  const container = q1(SELECTORS.playlistContainer);
  if (container) {
    container.querySelectorAll(SELECTORS.playlistTiles).forEach(el => {
      const node = el as HTMLElement;
      const seed = tileToSeed(node, listId);
      if (seed) { send('cache/VIDEO_SEEN', seed); sent++; }
    });
    return sent;
  }

  // Fallback to current video on watch/shorts
  const url = new URL(location.href);
  const id = url.searchParams.get('v') || (location.pathname.startsWith('/shorts/') ? location.pathname.split('/')[2] : null);
  if (id) {
    const seed: VideoSeed = {
      id,
      sources: [{ type: 'panel', id: null }]
    };
    send('cache/VIDEO_SEEN', seed);
    sent++;
  }
  return sent;
}

import { SELECTORS, parseDurationToSec, parseVideoIdFromHref, getPlaylistIdFromURL } from '../types/util';
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

  const titleEl = el.querySelector(SELECTORS.title);
  const chanEl = el.querySelector(SELECTORS.channel);
  const durEl = el.querySelector(SELECTORS.duration);
  const idxEl = el.querySelector(SELECTORS.index);

  return {
    id,
    title: titleEl?.textContent?.trim() ?? null,
    channelName: chanEl?.textContent?.trim() ?? null,
    channelId: null, // optional later
    durationSec: parseDurationToSec(durEl?.textContent || ''),
    sources: [{
      type: 'playlist',
      id: listId,
      index: idxEl ? Number(idxEl.textContent?.replace(/\D+/g, '')) : null,
      seenAt: Date.now()
    }]
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
    const titleEl = document.querySelector('#title h1, h1.title, h1') as HTMLElement | null;
    const chanEl = document.querySelector('ytd-channel-name a, #channel-name a') as HTMLElement | null;
    const video = document.querySelector('video') as HTMLVideoElement | null;
    const seed: VideoSeed = {
      id,
      title: titleEl?.textContent?.trim() ?? null,
      channelName: chanEl?.textContent?.trim() ?? null,
      channelId: null,
      durationSec: video && Number.isFinite(video.duration) ? Math.floor(video.duration) : null,
      sources: [{ type: 'panel', id: null, index: null, seenAt: Date.now() }]
    };
    send('cache/VIDEO_SEEN', seed);
    sent++;
  }
  return sent;
}

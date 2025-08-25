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

let observer: MutationObserver | null = null;

export function observePlaylistIfPresent() {
  const listId = getPlaylistIdFromURL();
  const container = q1(SELECTORS.playlistContainer);
  if (!container) return;

  // Parse existing
  container.querySelectorAll(SELECTORS.playlistTiles).forEach(el => {
    const node = el as HTMLElement;
    if (node.dataset._cached) return;
    const seed = tileToSeed(node, listId);
    if (seed) send('cache/VIDEO_SEEN', seed);
    node.dataset._cached = '1';
  });

  // Observe future
  observer?.disconnect();
  observer = new MutationObserver(muts => {
    for (const m of muts) {
      m.addedNodes.forEach(n => {
        if (!(n instanceof HTMLElement)) return;
        const tiles = n.matches?.(SELECTORS.playlistTiles)
          ? [n]
          : Array.from(n.querySelectorAll?.(SELECTORS.playlistTiles) || []);
        tiles.forEach(el => {
          const node = el as HTMLElement;
          if (node.dataset._cached) return;
          const seed = tileToSeed(node, listId);
          if (seed) send('cache/VIDEO_SEEN', seed);
          node.dataset._cached = '1';
        });
      });
    }
  });
  observer.observe(container, { childList: true, subtree: true });
}

export function maybeWatchProgress() {
  const video = document.querySelector('video') as HTMLVideoElement | null;
  if (!video) return;
  const isWatch = location.pathname.startsWith('/watch') || location.pathname.startsWith('/shorts/');
  if (!isWatch) return;

  let startedSent = false;
  setInterval(() => {
    if (!video.duration || !Number.isFinite(video.duration)) return;

    const url = new URL(location.href);
    const id = url.searchParams.get('v') || (location.pathname.startsWith('/shorts/') ? location.pathname.split('/')[2] : null);
    if (!id) return;

    const current = video.currentTime || 0;
    const duration = video.duration || 0;
    const started = !startedSent && current >= Math.max(15, duration * 0.03);
    const completed = duration > 0 && current / duration >= 0.9;
    if (started) startedSent = true;

    chrome.runtime.sendMessage({
      type: 'cache/VIDEO_PROGRESS',
      payload: { id, current, duration, started, completed }
    });
  }, 3000);
}

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
  // Attempt to read upload date text from common meta lines
  const metaSpans = Array.from(el.querySelectorAll('ytd-video-meta-block #metadata-line span, #metadata-line span')) as HTMLElement[];
  let uploadedText: string | null = null;
  for (let i = metaSpans.length - 1; i >= 0; i--) {
    const t = metaSpans[i]?.textContent?.trim();
    if (t && /\d/.test(t)) { uploadedText = t; break; }
  }
  const uploadedAt = parsePublishedToMs(uploadedText);

  return {
    id,
    title: titleEl?.textContent?.trim() ?? null,
    channelName: chanEl?.textContent?.trim() ?? null,
    channelId: null, // optional later
    durationSec: parseDurationToSec(durEl?.textContent || ''),
    uploadedAt,
    uploadedText,
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
      uploadedAt: readWatchPageUploadDate(),
      uploadedText: null,
      sources: [{ type: 'panel', id: null, index: null, seenAt: Date.now() }]
    };
    send('cache/VIDEO_SEEN', seed);
    sent++;
  }
  return sent;
}

// Try to parse published text like "2 years ago" or ISO-like dates
function parsePublishedToMs(txt?: string | null): number | null {
  if (!txt) return null;
  const s = txt.trim().toLowerCase();
  // Simple relative "N unit ago"
  const m = s.match(/(\d+)\s+(year|month|week|day|hour|minute)s?\s+ago/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2];
    const now = Date.now();
    const ms = unit === 'year' ? n * 365 * 86400000
      : unit === 'month' ? n * 30 * 86400000
      : unit === 'week' ? n * 7 * 86400000
      : unit === 'day' ? n * 86400000
      : unit === 'hour' ? n * 3600000
      : /* minute */ n * 60000;
    return now - ms;
  }
  // Absolute dates (very rough); try Date.parse
  const t = Date.parse(txt);
  return Number.isFinite(t) ? t : null;
}

// On watch pages, use structured data if possible
function readWatchPageUploadDate(): number | null {
  const meta = document.querySelector('meta[itemprop="datePublished"]') as HTMLMetaElement | null;
  if (meta?.content) {
    const t = Date.parse(meta.content);
    if (Number.isFinite(t)) return t;
  }
  // Fallback: try info strings
  const info = document.querySelector('#info-strings yt-formatted-string') as HTMLElement | null;
  if (info?.textContent) {
    const t = Date.parse(info.textContent);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

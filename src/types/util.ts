export const SELECTORS = {
  // Tweak these later if YouTube changes DOM
  playlistContainer: [
    'ytd-playlist-video-list-renderer #contents',
    'ytd-playlist-panel-renderer #items',
    'ytd-browse #contents'
  ],
  playlistTiles: 'ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer',
  duration: 'ytd-thumbnail-overlay-time-status-renderer #text, ytd-thumbnail-overlay-time-status-renderer span',
  title: '#video-title',
  channel: 'ytd-channel-name a, #byline a, #channel-name a',
  index: '#index, .index, #index-container',
  tileLink: 'a#thumbnail, a#video-title'
};

export function parseDurationToSec(txt?: string | null): number | null {
  if (!txt) return null;
  const parts = txt.trim().split(':').map(Number);
  if (parts.some(n => Number.isNaN(n))) return null;
  let sec = 0;
  for (const n of parts) sec = sec * 60 + n;
  return sec;
}

export function parseVideoIdFromHref(href: string): string | null {
  try {
    const url = new URL(href, location.origin);
    if (url.pathname.startsWith('/shorts/')) return url.pathname.split('/')[2] || null;
    if (url.pathname === '/watch') return url.searchParams.get('v');
    return null;
  } catch { return null; }
}

export function getPlaylistIdFromURL(u: string = location.href): string | null {
  try { return new URL(u).searchParams.get('list'); } catch { return null; }
}

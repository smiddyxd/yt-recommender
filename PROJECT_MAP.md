# Project Map

## What this is
Chrome MV3 extension. Background = data boss (IndexedDB). Content script scrapes YouTube playlist/watch pages. Options page (React) lists & filters cached videos (dark mode).

## Where code runs
- Background Service Worker (SW): owns DB, merges new videos, exposes message APIs, (later) auto-tag rules.
- Content script (youtube.com): observes SPA navigation, scrapes visible tiles, sends "video seen" + "progress".
- Options page (React): control panel listing cached videos; search/filter; (soon) selection, tagging, rules.

## Data (IndexedDB object stores)
- **videos** (key: `id` = videoId)
  Fields: { id, title, channelId?, channelName?, durationSec?, flags{started,completed}, progress{sec,duration}, tags[], sources[], lastSeenAt }
  Indices: byChannel, byTag (multi), byLastSeen
- (future) **tags**, **rules**, **groups**

## Messages (names = contracts)
- From content → background
  - `cache/VIDEO_SEEN`: seed a video with `sources[{type:'playlist'|'panel', id?, index?, seenAt}]`
  - `cache/VIDEO_PROGRESS`: { id, current, duration, started?, completed? }
- UI ↔ background (planned)
  - `videos/query`, `videos/applyTags`, `videos/delete`
  - `tags/*`, `rules/*`, `groups/*`
- Push from background
  - `db/change` { entity: 'videos'|'tags'|'rules'|'groups' }

## File tree (high-signal)
src/
  background/
    db.ts                 — open/upgrade IndexedDB; merge existing + new; schemaVersion lives here
    index.ts              — message router (handles cache/* now; UI APIs later)
  content/
    yt-navigation.ts      — hooks for YouTube SPA navigations (yt-navigate-finish, URL fallback)
    yt-playlist-capture.ts— DOM selectors → VideoSeed; sends VIDEO_SEEN / VIDEO_PROGRESS
  types/
    messages.ts           — message payload types (nice-to-have for edits)
    util.ts               — SELECTORS + parsers (centralized selectors, tweak here)
  ui/
    options/
      index.html          — options page shell with <div id="root"> + script include
      index.tsx           — mount React root into #root
      App.tsx             — React UI (list/grid, search, future selection/tagging)
      styles.css          — dark theme + layout classes (cards/grid/list)

## Centralized selectors (content script)
SELECTORS = {
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
}

## Build & load
- build: `npm run build`
- load: Chrome → chrome://extensions → Load unpacked → select `dist/`

## Tiny glossary (ELI5)
- Shadow DOM: CSS/HTML bubble for injected UI so YouTube’s styles can’t mess with your widgets.
- Virtualization: only render list items that are on-screen for speed when lists get huge.

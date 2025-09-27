# AGENTS - YT Manager

- 2025-09-22
  - Scrape loop stops on content-reported DOM-unique; added `scrape/SCROLL_BOTTOM` stall recovery; finalization waits until DB writes are flushed and closes tabs.
  - Batch upserts: `cache/VIDEO_SEEN_BATCH` + bulk IDB upserts reduce overhead; per-iteration logs include `pending` upserts.
  - Content: richer per-pass logs and continuous highlights; history scan includes rich-grid anchors.
  - Options: Scrape Panel adds "Debug: No stubs" toggle.

## Meta Contract
- Purpose: This document is the ground truth primer for new Codex chats. It must always reflect the current behavior, structures, and flows of the system.
- When to update: Whenever changes affect how the project works, what data it stores, how components communicate, or what the user can see or do. Ignore minor refactors, type fixes, or debug notes unless they alter semantics.
- How to update:
  1. Bump the "Verified As Of" date.
  2. Adjust Architecture and Storage Model to match reality.
  3. Reflect new or changed message contracts under Messaging Protocol.
  4. Capture any user-visible changes in UI sections.

Verified As Of: 2025-09-27

## Project Snapshot
- Extension (MV3) that caches YouTube videos/channels you see, enriches via YouTube Data API, lets you filter/tag/group in an Options UI, and backs up configuration and history to Google Drive appData.
- Build: `npm run build` -> `dist/`; load unpacked extension from `dist` in Chromium-based browser.
- Scrape Panel: adds "Debug: No stubs" (persists chrome.storage.local[debug.noStubs]), which treats VIDEO_STUB as VIDEO_SEEN during runs to reduce overhead.
- Dev watch (run each in separate terminals): `npm run watch:bg`, `watch:cs`, `watch:opt`, `watch:pop`.
- First-use: Open Options, click "Fetch video data" and provide your YouTube API key (stored in `chrome.storage.local.ytApiKey`).

## Repo Layout
- `manifest.json`: MV3 manifest; background worker is module script `background/index.js`; exposes popup and options pages.
- `src/background/`: service worker orchestration, IndexedDB access, Drive backup + history, restore logic.
- `src/content/`: scraping logic for watch pages, playlists, navigation hooks, progress tracking.
- `src/ui/options/`: React options dashboard, pending/scrape panel, backups modal.
- `src/ui/popup/`: React popup for page-aware quick actions.
- `src/shared/`: shared condition ASTs used by background + UI.
- `src/types/`: message contracts, debug flags, DOM parsing utilities (`util.ts`).
- `dist/`: build output; load unpacked extension from here after running build/watch scripts.

## Architecture Overview
- Manifest V3: background service worker, one content script, Options page (React), Popup (React).

### Recent Changes (2025-09-27)
- Settings storage swap: Tags, Tag Groups, Presets (Groups), and Channel Tags are stored in `chrome.storage.local` and managed exclusively by the background. Video tag assignments remain in IndexedDB.
- Migration: on startup, if `settings.useLocal` is true (default) and no local settings exist, the background migrates tags, tag groups, presets, and per-channel tags from IndexedDB to local storage.
- Version history: disabled (no events/commits). The Version History entry now opens the Backups modal.
- Backups: hourly backup tick with two toggles (both enabled by default):
  - Upload current settings snapshot to Drive appData (`settings.json`).
  - Download current settings snapshot to the local Downloads folder.
  - Manual “Backup” button runs the enabled actions immediately. The Backups modal shows Drive file count and total size, timestamps for last Drive upload, last local download, and last hourly tick.
  - Requires `downloads` permission.

### Background
- `src/background/index.ts`: single message router and orchestration (DB writes, refresh, backups, restore routes). Scrape loop stops based on DOM-unique counts reported by content, supports batching, stall detection, and wait-until-flushed finalization. Initializes settings migration and hourly backups.
- `src/background/db.ts`: IndexedDB schema and data mutations for videos/channels/trash/pending/meta. Current `DB_VERSION = 14`.
- `src/background/settingsStorage.ts`: Local settings adapter with mutex + `rev`-guarded read-modify-write for tags, tag groups, presets, and channel tags.
- `src/background/driveBackup.ts`: Google Drive appData auth + read/write (settings snapshots). Plaintext storage only.
- `src/background/events.ts`: Version history disabled; provides no-op implementations.
- `src/background/restore.ts`: Restore routes remain; history is inert.

### Content
- `src/content/index.ts`: listens for `scrape/NOW`, tracks SPA navigation, auto-scrape ticker gated by presets, watch progress tracking toggle. Adds helpers for Scrape Panel: `scrape/SCROLL`, `scrape/SCROLL_BOTTOM`, and `scrape/LIST_SUBSCRIPTIONS`. Provides detailed per-iteration logging/highlighting and a `scrape/FINAL` handler. `scrape/LOG` returns `dom.firstId` and accepts `stopAtId`. For `SubscriptionsFeed`, `dom.firstId` skips livestream tiles so the "latest" marker reflects the newest upload.
- `src/content/yt-playlist-capture.ts`: page context detection, tile scanning, progress scraping, watch fallback. Channel page detection considers DOM markers for vanity root channel URLs; resolves channel id from the canonical link when available.
- `src/content/yt-watch-stub.ts`: robust watch-page stub capture (title/channel/channelId) with short waits for SPA render.
- `src/content/yt-watch-progress.ts`: samples HTML5 player and sends periodic progress.
- `src/content/yt-navigation.ts`: navigation hooks (yt-navigate-finish + URL polling fallback).

### UI
- Options (`src/ui/options/*`): filterable list, tagging, presets, channels directory + trash, pending channels debug, Backups modal.
- Popup (`src/ui/popup/*`): page-aware quick actions (scrape current page; tag current video/channel; toggle auto-stub-on-watch). Popup polls the active tab context and resolves channel id on channel pages.

## Data Flow (Happy Path)
1) Content finds candidate video ids and sends `cache/VIDEO_SEEN` or `cache/VIDEO_STUB` to background with minimal fields and sources (playlist/panel/watch/channel-tab).
2) Background upserts into `videos`, optionally ensures channel stubs, and emits `db/change`.
3) Options UI reads from IDB (read-only for videos/channels) and from local settings via background for tags/tag groups/groups/channel tags; sends background actions for mutations.
4) Refresh uses YouTube Data API to fetch `videos.list` and `channels.list` in batches; background normalizes and stores selective fields.
5) On mutations, background optionally records events (disabled now), triggers settings backups, and pushes `db/change`.

## Auto-Scrape & Presets
- Passive scraping runs on Home, Sub Feed, Watch pages (side suggestions), and Search results; disabled on channel and playlist pages.
- Frequency: every ~2s; slows/pauses based on result signature stability and scroll thresholds.
- Preset gating controls what is upserted, not the stop/slowdown logic. The current watch video is always upserted; side tiles are gated.
- Sub Feed latest marker: marks top-most non-livestream as latest; if missing creates a sentinel stub tagged `no fetch`+`hide`; purges the previous sentinel when new one set.

## Scrape Panel (Sub Feed / Watch History)
- Stop condition: background stops when content-reported cumulative DOM-unique IDs reach the configured max.
- Batching: content sends seeds via `cache/VIDEO_SEEN_BATCH` and background bulk-writes.
- Aggressive scrolling: `scrape/SCROLL_BOTTOM` every iteration.
- Toggles: stop when previously marked most recent video encountered on Sub Feed and Watch History.
- Finalization: wait until pending upserts are flushed and upserts >= last DOM cumulative, then close the tab.
- Per-iteration logs: anchors/withId/uniqueIds/noRoot/noId/seen/pending/cumulative/max/stall.
- Sub Feed channels: always upsert channel stubs/pending for all tiles and mark subscribed status.

## Storage Model (IndexedDB)
- DB: `yt-recommender`, `DB_VERSION = 14`.
- Stores and key fields (selected):
  - `videos` (keyPath: `id`) - indexes: `byChannel` on `channelId`, `byTag` on `tags` (multiEntry).
  - `trash` (keyPath: `id`) - index: `byDeletedAt`.
  - `channels` (keyPath: `id`) - indexes: `byName`, `byFetchedAt`.
  - `channels_trash` (keyPath: `id`) - index: `byDeletedAt`.
  - `channels_pending` (keyPath: `key`) - index: `byCreatedAt`.
  - `meta` (keyPath: `key`).
- Video row highlights: compact top-level projections, no raw `yt` payload stored.
- Channel row highlights: compact projections, including `thumbnailID`, `playlists`, derived fields; no raw `yt` payload stored.
- Channel tags: user-managed channel tags moved to local settings (see below). `videoTags[]` remains derived in IDB.

### Local Settings (chrome.storage.local)
- Keys: `settings.tags`, `settings.tagGroups`, `settings.groups`, `settings.channelTagsById`, `settings.rev`, `settings.updatedAt`, `settings.useLocal`.
- Background is the only writer. Updates use an in-memory mutex and a `rev` counter (monotonic) for read-modify-write safety.
- One-time migration from IDB runs on startup when `settings.useLocal = true` and no local settings exist.

## Messaging Protocol
- Content -> Background: `cache/VIDEO_SEEN`, `cache/VIDEO_STUB`, `cache/VIDEO_PROGRESS`, `cache/VIDEO_PROGRESS_PCT`, `scrape/SCROLL`, `scrape/LIST_SUBSCRIPTIONS`, `cache/VIDEO_SEEN_BATCH`, `channels/markSubscribed`.
- Background -> Content: `scrape/NOW`, `scrape/LOG`, `scrape/SCROLL`, `scrape/SCROLL_BOTTOM`, `scrape/FINAL`.
- UI -> Background (selected):
  - Videos: `videos/delete`, `videos/restore`, `videos/applyTags`, `videos/setType`, `videos/wipeSources`, `videos/refreshAll`, `videos/stubsCount`, `videos/applyYTBatch`.
  - Channels: `channels/list`, `channels/trashList`, `channels/refreshUnfetched`, `channels/refreshByIds`, `channels/applyTags`, `channels/markScraped`, `channels/upsertStub`, `channels/delete`, `channels/restore`, `channels/stubsCount`, `channels/getTags`.
  - Tags: `tags/list`, `tags/create`, `tags/rename`, `tags/delete`, `tags/assignGroup`.
  - Tag Groups: `tagGroups/list`, `tagGroups/create`, `tagGroups/rename`, `tagGroups/delete`.
  - Groups/Presets: `groups/list`, `groups/create`, `groups/update`, `groups/delete`.
  - Topics: `topics/list`.
  - Backups: `backup/saveSettings`, `backup/getClientId`, `backup/setClientId`, `backup/listFiles`, `backup/downloadFile`, `backup/downloadFileRange`, `backup/wipeAll`.
  - Backups (new): `backup/config/get`, `backup/config/set { driveEnabled?, localEnabled? }`, `backup/runNow`, `backup/local/downloadNow`.
  - History (disabled): `backup/history/*` routes remain but return empty/no-ops.
- Background -> UI push: `db/change { entity }`, refresh and backup progress events.

## YouTube API Refresh
- Uses YouTube Data API (`videos.list`, `channels.list`) with retries and chunking (50 ids per call).
- API key stored in `chrome.storage.local.ytApiKey`.
- After video refresh: fetch missing/stale channels, recompute per-channel `videoTags[]`, recompute global `videoTopics` in `meta`.
- Refresh gating: `videos/refreshAll` skips any video tagged `no fetch` and any video whose channel is tagged `no fetch` (channel “no fetch” resolved from local settings).

## Backups, History & Snapshots
- OAuth via `chrome.identity.launchWebAuthFlow` (scope: `drive.appdata`). Silent by default; UI requests interactive auth on demand.
- Files written:
  - `settings.json` (latest snapshot; plaintext only).
  - `snapshots/settings-YYYYMMDD-HHMMSS.json` (manual/dynamic checkpoints).
- Hourly backup tick with toggles (Drive upload, local download). Manual "Backup" button runs enabled actions now.
- History versioning disabled: no events JSONL; existing history routes are inert.
- UI shows Drive usage (file count & total size), last backup times (Drive/local), and last hourly tick.

## Restore (Dry Run + Apply)
- Restore/import temporarily disabled in UI (Version History modal replaced by Backups modal). Routes remain but are inert while history is disabled.

## Options UI Highlights
- Views: Videos, Trash, Channels, Channels Trash, and Pending (debug).
- Top bar toggles: List/Grid, Videos/Channels, Trash toggle.
- Selection toolbar and default tags/presets behavior unchanged.
- Sidebar: Tag CRUD, Tag Groups CRUD, assign tags to groups; Backups entry opens the Backups modal.
- Backups modal: toggles for hourly Drive upload/local download; shows usage and timestamps; buttons for manual backup, download all, wipe all.

## Popup Highlights
- Shows page context (watch/channel/other); "Scrape current page"; toggle "Auto-capture stubs on watch pages".
- Tag current video/channel using grouped tag pickers; channel tags read/written via local settings.

## Core Invariants
- Background is the only writer to IndexedDB and local settings; UI and content scripts perform read-only transactions and close DB connections after `oncomplete`.
- Background message handlers must return `true` to keep async response channel open (MV3).
- Push notifications (`db/change { entity }`) remain accurate to refresh only what is needed.
- Storage/type uses the name "Group"; UI labels it "Preset".

## Adding Features Safely
- New DB fields or stores: update `src/background/db.ts`, bump `DB_VERSION`, handle migration in `onupgradeneeded`, and update this doc's Storage Model section.
- New message/route: add to `src/types/messages.ts`, implement in `src/background/index.ts`, and list under Messaging Protocol.
- New predicates: update `src/shared/conditions.ts` and Filters UI; update content-side evaluator if needed.
- Backup/Restore: update backup plumbing; document thresholds and flows.

## Development Workflow
### Environment & Build
- Prereqs: Node.js 18+, npm.
- Install: `npm i`
- Build once: `npm run build` (writes `dist/`)
- Dev watch (parallel terminals):
  - `npm run watch:bg` - background bundle to `dist/background/`
  - `npm run watch:cs` - content script bundle to `dist/content/`
  - `npm run watch:opt` - Options UI to `dist/ui/options/`
  - `npm run watch:pop` - Popup UI to `dist/ui/popup/`
- Load in Chrome/Chromium: Extensions -> Developer Mode -> Load unpacked -> select `dist/`.

### Schema Changes (IndexedDB)
- Bump `DB_VERSION` and handle migrations in `onupgradeneeded`.
- Create new stores/indexes defensively; delete old indexes with try/catch.
- Avoid data loss; migrate/normalize where practical.
- Validate upgrade path on a profile that already has prior data.
- Update storage model section in this doc after schema changes.

### Adding or Changing Message Contracts
- Add union cases in `src/types/messages.ts` with precise payload shapes.
- Implement the handler in `src/background/index.ts` and ensure the listener returns `true`.
- Emit `chrome.runtime.sendMessage({ type: 'db/change', payload: { entity } })` for affected entities.
- Schedule settings backup for user-visible mutations.

### Predicates & Filters (end-to-end)
- Extend `src/shared/conditions.ts` types and both evaluators:
  - `matches(video, cond, ctx)` for video-side predicates
  - `matchesChannel(channel, cond, ctx)` for channel-side and existential video predicates
- Map new predicates in `src/ui/options/lib/filters.ts` and render/edit widgets in `FiltersBar.tsx`.
- If scrape-time evaluation is required, update `src/content/index.ts` and `isPresetScrapeCheckable` in App.tsx.

### Auto-Scrape & Sources Field
- Candidates carry `sources: Array<{ type: string; id?: string | null }>` so you can filter by where a video was seen.
- Known types: `playlist`, `panel`, `WatchPage`, `ChannelVideosTab`, `ChannelShortsTab`, `ChannelLivestreamsTab`, `SubscriptionsFeed`, `WatchHistory`.
- When adding new source types, update content emitters, Filters UI, and derived displays that list sources.


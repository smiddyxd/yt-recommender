# AGENTS - YT Manager

- 2025-09-22
  - Scrape loop stops on content-reported DOM-unique; added `scrape/SCROLL_BOTTOM` stall recovery; finalization waits until DB writes are flushed and closes tabs.
  - Batch upserts: `cache/VIDEO_SEEN_BATCH` + bulk IDB upserts reduce overhead; per-iteration logs include `pending` upserts.
  - Content: richer per-pass logs and continuous highlights; history scan includes rich-grid anchors.
  - Options: Scrape Panel adds "Debug: No stubs" toggle.
## Meta Contract
- **Purpose:** This document is the ground truth primer for new Codex chats. It must always reflect the current behavior, structures, and flows of the system.
- **When to update:** Whenever changes affect how the project works, what data it stores, how components communicate, or what the user can see or do. Ignore minor refactors, type fixes, or debug notes unless they alter semantics.
- **How to update:**
  1. Bump the "Verified As Of" date.
  2. Adjust Architecture and Storage Model to match reality.
  3. Reflect new or changed message contracts under Messaging Protocol.
  4. Capture any user-visible changes in UI sections.

### Editing Policy for AGENTS.md (Do Not Remove)

Purpose
- Protect this document from accidental rewrites, truncation, or destructive edits.
- Permit autonomous, surgical edits while preserving the document's integrity.

Non-Negotiable Rules (MUST)
- Never rewrite, replace, shorten, or summarize this file wholesale. Do not remove sections unless explicitly requested.
- Perform only surgical edits targeted to the requested change. Preserve all other content, order, headings, anchors, encoding, and line endings.
- Apply the minimum patch necessary; do not reorder content or 'clean up' formatting unless requested.
- If any constraint prevents a safe, surgical edit (encoding, tool limits, sandbox), stop and report. Do not work around by creating a new shortened file or by replacing the entire file.
- Keep this policy section intact and visible near the top of the file.

Allowed Changes (SHOULD)
- Update the 'Verified As Of' date.
- Append items to 'Recent Changes'.
- Append bullets/notes to existing sections (Architecture, Storage Model, Messaging Protocol, UI Highlights, Backups).
- Add new section anchors when necessary (no removal of existing content).

Prohibited Changes
- Removing sections or large blocks without explicit user request.
- Moving or splitting the document into separate files without request.
- Converting file encoding or line endings silently (ask first if conversion is required).
- Incidental whitespace, numbering, or formatting changes unless requested.

Edit Workflow (Autonomous, Surgical)
1) Read the entire file and locate precise insertion/edit anchors (section headers, bullet lists). If anchors are ambiguous or missing, ask the user where to insert.
2) Compute a minimal patch (only the necessary hunks) that touches as few lines as possible and avoids unrelated changes.
3) Apply the patch.
4) Re-open and verify that only the intended lines changed. Report a short summary (anchors used and lines touched).

Patch Requirements
- Minimal, focused hunks with context lines.
- Preserve encoding and line endings exactly as found.
- Avoid incidental trailing-space or numbering changes unless requested.

Failure Contingencies (Ask, Don't Guess)
- Encoding issue (e.g., not UTF-8): ask the user to re-save as UTF-8 (no BOM) or paste the exact text to patch. Do not convert silently.
- Tool/size limits: ask for smaller anchor snippets or permission to split the patch into multiple hunks.
- Sandbox/permission denial: ask for approval to escalate or provide the patch for the user to apply manually.

Pre-Edit Checklist
- Confirm encoding and line endings will be preserved.
- Confirm exact insertion anchors and scope.
- Ensure the patch removes nothing except explicitly requested lines.
- Dry-run mentally (or via diff) to confirm minimal blast radius.

Global Reminder
- Treat AGENTS.md as canonical. Always favor minimal, surgical edits. If in doubt, stop and ask.

**Verified As Of:** 2025-10-04

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
- `src/ui/options/`: React options dashboard, pending/scrape panel, backup history modal.
- `src/ui/popup/`: React popup for page-aware quick actions.
- `src/shared/`: shared condition ASTs used by background + UI.
- `src/types/`: message contracts, debug flags, DOM parsing utilities (`util.ts`).
- `dist/`: build output; load unpacked extension from here after running build/watch scripts.

## Architecture Overview
- Manifest V3: background service worker, one content script, Options page (React), Popup (React).
 - Collections: metadata (list, parent/child links) stored in chrome.storage.local; video membership stored on video rows in IndexedDB as `collectionIds[]`.

### Recent Changes (2025-09-29)
- Channel highlight: Across YouTube, channel anchors for channels tagged with the default channel tag `tagged` are outlined (`border: 3px solid #5edf8b`). Implemented in content via `chrome.storage.local.settings.channelTagsById`, MutationObserver, and navigation hooks; channel page headers are also marked when applicable.
  - Handle links: `@handle` anchors are resolved to channel IDs via a background route (`channels/lookupByHandle`) that queries the local DB’s `customUrl`; resolved matches are highlighted the same as `/channel/UC...` links.
  - Name-only elements (watch suggestions): when only a channel name is rendered without a link, content resolves the name to a channel id via `channels/lookupByName` (exact match on the `byName` index) and highlights the name element if the channel is tagged.

### Recent Changes (2025-09-27)
- Settings storage swap: Tags, Tag Groups, Presets (Groups), and Channel Tags are stored in `chrome.storage.local` and managed by the background. Video tag assignments remain in IndexedDB.
- One-time migration: On startup, if `settings.useLocal` is true (default) and local settings are empty, tags/tag groups/presets/channel tags are migrated from IDB to local settings.
- Version History: Disabled (no events/commits). The “Version History” entry is replaced by a Backups modal.
- Backups: Hourly tick with two toggles (both enabled by default):
  - Upload settings snapshot to Drive appData (`settings.json`)
  - Download settings snapshot locally to the Downloads folder
  - Manual “Backup” button runs the enabled actions immediately
  - Backups modal shows Drive file count and total size, timestamps for last Drive upload, last local download, and last hourly tick.
  - Rules: stored in `chrome.storage.local.settings.rules`; included in settings backup/restore snapshot.
- Manifest: adds `downloads` permission for automatic local saves.


### Background
- `src/background/index.ts`: single message router and orchestration (DB writes, refresh, backup/history routes, restore routes). Scrape loop stops based on DOM-unique counts reported by content, supports batching, stall detection, and wait-until-flushed finalization.
- `src/background/db.ts`: IndexedDB schema and all data mutations (videos/channels/tags/groups/tag-groups/trash/pending/events/meta). Current `DB_VERSION = 16`.
- `src/background/driveBackup.ts`: Google Drive appData auth + read/write (JSON, JSONL, snapshots). Plaintext storage only; pass `{ interactive: true }` when user prompts are needed.
- `src/background/events.ts`: Event batching into commits, local history in IDB, append to monthly JSONL in Drive, dynamic checkpoints, backlog replay.
- `src/background/restore.ts`: Dry-run and apply restore from settings snapshots (merge/overwrite, selective fields).

### Content
- `src/content/index.ts`: listens for `scrape/NOW`, tracks SPA navigation, auto-scrape ticker gated by presets, watch progress tracking toggle. Adds helpers for Scrape Panel: `scrape/SCROLL` (incremental scroll), `scrape/SCROLL_BOTTOM` (force bottom scroll for infinite loader), and `scrape/LIST_SUBSCRIPTIONS` (extract ids on `/feed/channels`). Provides detailed per-iteration logging/highlighting and a `scrape/FINAL` handler for end-of-run highlighting/reporting. `scrape/LOG` returns `dom.firstId` and accepts `stopAtId`, replying with `foundStopId`. For `SubscriptionsFeed`, `dom.firstId` skips livestream tiles (identified by a `LIVE` badge) so the "latest" marker reflects the newest upload.
- `src/content/yt-playlist-capture.ts`: page context detection, tile scanning, progress scraping, watch fallback. Channel page detection now also considers DOM markers (`#page-header-banner` or `ytd-c4-tabbed-header-renderer`) to recognize vanity root channel URLs (e.g., `/SomeChannel`). Channel id is resolved from the canonical `<link rel="canonical" href=".../channel/UC...">` when available.
- `src/content/yt-watch-stub.ts`: robust watch-page stub capture (title/channel/channelId) with short waits for SPA render.
- `src/content/yt-watch-progress.ts`: samples HTML5 player and sends periodic progress.
- `src/content/yt-navigation.ts`: navigation hooks (yt-navigate-finish + URL polling fallback).

### UI
- Options (`src/ui/options/*`): filterable list, tagging, presets, channels directory + trash, pending channels debug, backup + version history modal.
  - Collections: Sidebar section to manage collections (create/rename/delete, set parent). Clicking a collection filters the Videos list to show only its items. Topbar tagger exposes a Collections dropdown plus +/− buttons to add/remove the current selection to/from the chosen collection.
- Pending (debug): includes a Scrape Panel with one-click routines (Run all, Resolve ids, Scrape Sub Feed, Scrape Subscriptions Manager, Scrape Watch History, Stop), per-routine and global "Last run" timestamps, and max limits for feed/history. Each pending row shows an "Open" link (if a handle is present) and a small delete "×" button on the right to remove the entry.
- Popup (`src/ui/popup/*`): page-aware quick actions (scrape current page; tag current video/channel; toggle auto-stub-on-watch). The popup now:
  - Polls the active tab context every ~1s while open to reflect SPA navigation changes (e.g., channel ? channel), updating video/channel id in place.
  - Proactively resolves channel id on channel pages when not yet available (mirrors watch pages' behavior).
  - Adds a quick "Create tag" row: input for tag name and a dropdown to choose a Tag Group (optional). Uses `tags/create` and `tags/assignGroup`.

### Shared / Types
- `src/shared/conditions.ts`: Condition AST, evaluation for videos/channels; "Group" type (called "Preset" in UI).
- `src/types/messages.ts`: central message union and supporting types.
- `src/types/debug.ts`: simple debug logging flags.
- `src/types/util.ts`: DOM selectors and parsing helpers reused by content scripts.

## Data Flow (Happy Path)
1) Content finds candidate video ids from tiles or the watch page; sends `cache/VIDEO_SEEN` or `cache/VIDEO_STUB` to background with minimal fields and sources (playlist/panel/watch/channel-tab).
2) Background upserts into `videos` (merges flags/tags/progress/sources), optionally ensures channel stubs, and emits `db/change` to update UI.
3) Options UI reads from IDB (read-only) and sends background actions (tagging, delete/restore, refresh, channel tagging, presets CRUD, backup/history ops).
4) Refresh uses YouTube Data API (via stored API key) to fetch `videos.list` and `channels.list` in batches with retries; background normalizes and stores selective fields.
5) On mutations, background records lightweight events -> commits; appends to `events-YYYY-MM.jsonl` in Drive and occasionally saves snapshots.

## Auto-Scrape & Presets
- Passive scraping runs on Home (`/`), Sub Feed (`/feed/subscriptions`), Watch pages (side suggestions), and Search results (`/results`) — disabled on channel and playlist pages.
- Frequency: every ~2s; if the total (non-gated) result signature is unchanged 3 consecutive ticks, slow to every ~4s; if unchanged 3 more ticks at 4s, pause until scroll passes a page-specific threshold to reactivate at 4s:
  - Search =99%, Sub Feed =89%, Home =81%, Watch =40%.
- Preset gating only controls what is upserted, not the stop/slowdown logic.
- The current watch video is always upserted regardless of presets; side tiles are gated by presets.
## Scrape Panel (Sub Feed / Watch History)
- Stop condition: background stops when content-reported cumulative DOM-unique IDs reach the configured max.
- Batching: content sends seeds via `cache/VIDEO_SEEN_BATCH` (chunked) and background bulk-writes (`upsertVideosBulk`).
- Aggressive scrolling: background now issues `scrape/SCROLL_BOTTOM` every iteration to continuously push the page to the bottom and load more items; this replaces the prior stall-only nudge.
 - New toggles: checkboxes allow stopping when the previously marked most recent item is encountered again on Sub Feed and Watch History runs. Labels: "Sub Feed: stop at previous most recent video" and "History: stop at previous most recent video". Stored in `chrome.storage.local` under `scrape.stopAtPrevLatest.subFeed` and `scrape.stopAtPrevLatest.history`.
- Finalization: background waits until pending upserts are flushed and upserts >= last DOM cumulative, logs a final summary, then closes the tab.
- Per-iteration page-console logs include anchors/withId/uniqueIds/noRoot/noId/seen(upserts)/pending(upserts)/cumulative(dom)/max/stall.

- Sub Feed gating: Sub Feed scraping respects only presets with `scrape` enabled; content evaluates checkable predicates and only submits accepted tiles.
- Sub Feed channels: for Sub Feed tiles, content always upserts channels (non-preset-gated) and marks them as subscribed:
  - Accepted tiles still gate video upserts by presets, but channel capture runs for all tiles.
  - When a channel id is present, it upserts a stub and marks it `subscribed`.
  - When only a handle/name is present, it upserts a pending entry with `subscribedPending: true` so resolution promotes `subscribed=true`.
  - This behavior applies to both passive auto-scrape and the active Scrape Panel "Scrape Sub Feed" routine.
- Latest marker: both active runs and passive auto-scrapes mark the top-most non-livestream video as latest for Sub Feed (`latestFromSubFeed` and `meta['latestBy.SubscriptionsFeed']`).
   - If the latest video is not yet in DB, a stub is created and flagged, tagged with `no fetch` and `hide` so it remains a lightweight sentinel.
   - If it is already in DB, only the flag is set/updated.
   - When a newer latest is set, the previous sentinel (tags include `no fetch`+`hide`, never fetched) is purged permanently.
 - Sub Feed channels (passive): during passive auto-scrape on Sub Feed, content now upserts channel stubs/pending for all tiles (not gated by presets) and marks encountered channels as subscribed. For handle/name-only tiles, pending entries carry `subscribedPending: true` so resolution promotes the channel to subscribed.

- Auto-scrape runs every ~2s only if user was active within the last 10s. Disabled on channel pages and all playlist pages.
- Current watch page is always captured; other tiles are captured only if accepted by at least one enabled "Preset".
- A preset participates at scrape-time only if its condition tree is fully checkable from in-page data. Supported predicates: `sourceAny`, `sourcePlaylistAny`, `channelIdIn`, `titleRegex`, and `groupRef` (only if referenced presets are themselves checkable).
- Tiles with just a handle/name may upsert to `channels_pending` (gated by accepted presets, per-page de-duped). Channel pages resolve pending entries to real ids automatically; Options exposes a debug panel to open background tabs and auto-resolve handles in batches.

## Storage Model (IndexedDB)
- DB: `yt-recommender`, `DB_VERSION = 16`.
- Stores and key fields
  - `videos` (keyPath: `id`) - indexes: `byChannel` on `channelId`, `byTag` on `tags` (multiEntry).
    - New: `byCollection` on `collectionIds` (multiEntry); `collectionIds: string[]` holds collection membership by id.
  - `trash` (keyPath: `id`) - index: `byDeletedAt`.
  - `tags` (keyPath: `name`) - index: `byCreatedAt`; record: `{ name, color?, createdAt?, groupId? }`.
  - `tag_groups` (keyPath: `id`) - indexes: `byName`, `byCreatedAt`.
  - `groups` (keyPath: `id`) - indexes: `byName`, `byUpdatedAt`; record includes `scrape?: boolean`.
  - `channels` (keyPath: `id`) - indexes: `byName`, `byFetchedAt`.
  - `channels_trash` (keyPath: `id`) - index: `byDeletedAt`.
  - `channels_pending` (keyPath: `key`) - index: `byCreatedAt`; rows like `{ key: 'handle:@foo' | 'name:Some Name', name?, handle?, subscribedPending?, createdAt?, updatedAt? }`.
  - `meta` (keyPath: `key`) - holds aggregated lists like `{ key: 'videoTopics', list: string[] }`. Also stores per-source latest markers: `{ key: 'latestBy.SubscriptionsFeed', value: '<videoId>' }`, `{ key: 'latestBy.WatchHistory', value: '<videoId>' }`.
  - `events_commits` (keyPath: `commitId`) - index: `byTs`.
  - `events` (keyPath: `id`) - index: `byCommit`.
- Video row highlights: `id`, `title`, `channelId`, `channelName`, `durationSec`, `uploadedAt`, `fetchedAt`, `ytTags[]`, `description`, `categoryId`, `languageCode`, `visibility`, `isLive`, `videoTopics[]`, `tags[]`, `flags.started/completed`, `progress{sec|pct|duration}`, `sources[{type,id?}]`, `lastSeenAt`.
  - New compact projections (replacing heavy raw `yt` usage): `type` (`short` | `video` | `livestream`), `transcript` ("" if captions available, "no transcript" if not), `views`, `likes`, `commentCount`, `liveViewers`, `rejectionReason`, `failureReason`, `premiereTime`, `customThumbnail`, `contentRating`, `regionRestriction`.
  - Removed redundant: `thumbUrl` (derivable from `id`). The raw `yt` payload is no longer stored.
- Channel row highlights: `id`, `name`, `subs`, `views`, `videos`, `country`, `publishedAt`, `subsHidden`, `tags[]`, derived `videoTags[]`, `videoTopics[]`, `keywords[]`, `channelTopics[]`, `description`, `fetchedAt`, `scrapedAt*` and per-tab counts, `subscribed?`, `unsubscribed?`.
  - New compact projection: `thumbnailID` (unique part of `yt3.ggpht.com` avatar URLs), `playlists` (from `contentDetails.relatedPlaylists`).
  - Removed redundant: `bannerUrl`, raw `yt` payload, and full `thumbnails` object.

### Stored Record Signatures (v14)
- Video (store: `videos`, keyPath: `id`):
  - Identity: `id: string`
  - Basic: `title?: string`, `channelId?: string`, `channelName?: string`, `uploadedAt?: number|null`, `durationSec?: number|null`, `fetchedAt?: number|null`
  - Tags/flags: `tags?: string[]`, `ytTags?: string[]`, `flags?: { started?: boolean; completed?: boolean }`
  - Progress: `progress?: { sec?: number; pct?: number; duration?: number }`
  - Sources: `sources?: Array<{ type: string; id?: string|null }>`
  - Collections: `collectionIds?: string[]` (ids referencing settings collections)
  - Visibility/lang: `visibility?: 'public'|'unlisted'|'private'|null`, `languageCode?: 'en'|'de'|'other'|null`, `isLive?: boolean|null`
  - Topics: `videoTopics?: string[]`
  - Compact projections: `type?: 'video'|'short'|'livestream'`, `transcript?: ''|'no transcript'`, `views?: number`, `likes?: number`, `commentCount?: number`, `liveViewers?: number`, `rejectionReason?: string`, `failureReason?: string`, `premiereTime?: number|null`, `customThumbnail?: boolean`, `contentRating?: string`, `regionRestriction?: { allowed?: string[]; blocked?: string[] }`
  - Recency/markers: `lastSeenAt?: number`, `latestFromSubFeed?: boolean`, `latestFromWatchHistory?: boolean` (Sub Feed latest excludes livestreams)
  - Removed in v14: `thumbUrl`, `yt`

- Channel (store: `channels`, keyPath: `id`):
  - Identity: `id: string`, `name?: string`, `customUrl?: string|null`, `altHandles?: string[]`
  - Stats: `subs?: number|null`, `views?: number|null`, `videos?: number|null`, `subsHidden?: boolean`
  - Locale/meta: `country?: string|null`, `publishedAt?: number|null`, `keywords?: string[]`
  - Avatars/playlists: `thumbnailID?: string|null`, `playlists?: { uploads?: string; likes?: string; watchHistory?: string; watchLater?: string; favorites?: string } | null`
  - Topics/descriptions: `channelTopics?: string[]` (derived from YouTube channel topicCategories; readable labels), `videoTopics?: string[]` (aggregated from videos), `description?: string|null`
  - Tags: `tags?: string[]`, `videoTags?: string[]` (derived from videos’ tags)
  - Scrape markers: `scrapedAt?: number`, `scrapedAtVideos?: number`, `scrapedAtShorts?: number`, `scrapedAtLivestreams?: number`, `scrapedVideoCount?: number`, `scrapedShortsCount?: number`, `scrapedLivestreamCount?: number`, `totalVideoCountOnScrapeTime?: number|null`
  - Subscriptions: `subscribed?: boolean`, `unsubscribed?: boolean`
  - Timestamps: `fetchedAt?: number|null`
  - Removed in v14: `thumbnails`, `bannerUrl`, `yt`

## Messaging Protocol
- Content -> Background
  - `cache/VIDEO_SEEN`, `cache/VIDEO_STUB`
  - `cache/VIDEO_PROGRESS`, `cache/VIDEO_PROGRESS_PCT`
  - Scrape helpers (used by background routines): `scrape/SCROLL`, `scrape/LIST_SUBSCRIPTIONS`
  - `cache/VIDEO_SEEN_BATCH` (batched seeds for bulk DB write via single transaction)
  - `channels/markSubscribed { ids: string[] }` (mark existing/new channel rows as `subscribed=true`, `unsubscribed=false`)

- Background -> Content (scrape loop)
  - `scrape/NOW`, `scrape/LOG` (accepts `stopAtId`, returns `foundStopId` and `dom.firstId`), `scrape/SCROLL`, `scrape/SCROLL_BOTTOM`, `scrape/FINAL`
- UI -> Background (selected)
  - Videos: `videos/delete`, `videos/restore`, `videos/applyTags`, `videos/setType`, `videos/wipeSources`, `videos/refreshAll`, `videos/stubsCount`, `videos/applyYTBatch`
  - Channels: `channels/list`, `channels/trashList`, `channels/refreshUnfetched`, `channels/refreshByIds`, `channels/applyTags`, `channels/markScraped`, `channels/upsertStub`, `channels/delete`, `channels/restore`, `channels/stubsCount`
  - Trash purge: `videos/purge` (delete permanently from videos trash), `channels/purge` (delete permanently from channels trash)
  - Tags: `tags/list`, `tags/create`, `tags/rename`, `tags/delete`, `tags/assignGroup`
  - Collections: `collections/list`, `collections/create { name, parentId? }`, `collections/update { id, patch }`, `collections/delete { id }`
  - Apply: `videos/collections/apply { ids, collectionId, op: 'add'|'remove' }`
  - Tag Groups: `tagGroups/list`, `tagGroups/create`, `tagGroups/rename`, `tagGroups/delete`
  - Tag Groups (update): `tagGroups/update { id, patch }` (supports `parentId`, `color`)
  - Groups/Presets: `groups/list`, `groups/create`, `groups/update` (accepts `{ scrape?: boolean }`), `groups/delete`
  - Rules: `rules/list`, `rules/create { name, groupId, action, channelIds?, enabled? }`, `rules/update { id, patch }`, `rules/delete { id }`, `rules/runAll { onlyEnabled? }`
  - Topics: `topics/list`
- Pending (debug): `channels/upsertPending`, `channels/resolvePending`, `channels/pending/list`, `channels/pending/resolveBatch`, `channels/pending/delete`
  - Scrape Panel: `scrape/status`, `scrape/stop`, `scrape/resolveIds`, `scrape/subFeed`, `scrape/subscriptionsManager`, `scrape/history`, `scrape/runAll`
  - Backup core: `backup/getClientId`, `backup/setClientId`, `backup/saveSettings`, `backup/restoreSettings`, `backup/listFiles`, `backup/downloadFile`, `backup/downloadFileRange`, `backup/wipeAll`
  - History: `backup/history/list`, `backup/history/getCommit`, `backup/history/getUpTo`, `backup/history/deleteUpTo`, `backup/history/usage`, `backup/history/import`, `backup/history/revertTo`, `backup/history/snapshotNow`
  - Restore & Apply: `backup/restore/dryRun`, `backup/restore/apply`
- Background -> UI push
  - `db/change { entity }` (videos | tags | groups | tagGroups | channels | topics)
  - Refresh progress: `refresh/progress`, `refresh/error`, `refresh/done`
  - Backup state: `backup/progress`, `backup/done`, `backup/error`

## YouTube API Refresh
- Uses YouTube Data API (`videos.list`, `channels.list`) with retries and chunking (50 ids per call).
- API key is stored in `chrome.storage.local.ytApiKey`.
- Batch fetch relies on `fetchVideosListWithRetry` / `fetchChannelsListWithRetry`; back off between attempts.
- Selective change history is recorded during refresh:
  - Videos: diffs for `title`, `description` (thumbnail diffs dropped; computed from `id`).
  - Channels: diffs for `thumbnailID` and `description`.
- After video refresh: fetch missing/stale channel rows, recompute channel `videoTags[]`, recompute per-channel `videoTopics[]`, and recompute global `videoTopics` in `meta`.
 - Refresh gating: `videos/refreshAll` skips any video tagged `no fetch` and any video whose channel is tagged `no fetch`.

### Request Parts (standardized)
- `videos.list.part`: `snippet,contentDetails,status,statistics,topicDetails,recordingDetails,liveStreamingDetails,localizations`
- `channels.list.part`: `snippet,statistics,brandingSettings,contentDetails,topicDetails`

## Backup, History & Snapshots
- OAuth via `chrome.identity.launchWebAuthFlow` (scope: `drive.appdata`). Silent by default; UI requests interactive auth on demand.
- Files written:
  - `settings.json` (latest snapshot; plaintext only).
  - `snapshots/settings-YYYYMMDD-HHMMSS.json` (dynamic checkpoints). Background ensures a baseline snapshot exists after Drive is configured.
  - `events-YYYY-MM.jsonl` (monthly append-only history with a JSON header line).
  - Optional `cutoff.json` markers after "Delete up to here".
  - Settings content includes: `tags`, `tagGroups`, `groups/presets`, `rules`, `collections`, `videoIndex`, `channelIndex`, and `pendingChannels`.
- Dynamic checkpoints: when commit processing weight >= 10,000 or month file size >= 20 MB, background saves a snapshot and resets counters; a daily alarm also saves settings.
- Event history: call `recordEvent` for meaningful mutations (tag ops, delete/restore, assign group, channel tag ops, etc.) and include an `impact` estimate for snapshot thresholds. Ephemeral pending-channels operations (`pending/upsert`, `pending/resolve`, `pending/delete`) are excluded from version history and do not create events/commits.
- Commit flush: `queueCommitFlush(3000)` batches events; `finalizeCommitAndFlushIfAny()` runs during backup schedule.
- JSONL month files are rewritten by appending full commits; export slicing operates on entire commits so follow-up events stay intact.
- Deduplication: when appending a commit to a monthly JSONL, the background checks for an existing matching `commitId` in that file and skips appending duplicates. This protects against replay/import edge cases.
- Backlog replay: if Drive append fails, commit ids queue in `chrome.storage.local['drive.unsyncedCommitIds']` and are replayed silently; Options header shows "Drive backlog: N" when pending.
- New history routes: `backup/history/revertTo { commitId, dryRun? }` and `backup/history/snapshotNow { interactive?, name? }`.
- Manual "Backup settings" flow finalizes pending commits, saves `settings.json`, then triggers backlog replay.
- Wipe: `backup/wipeAll` deletes all files from Drive appDataFolder after confirmation in UI and clears the local IndexedDB (all stores). Intended for a full reset. Use "Download All (zip)" first if you want a backup.
- Import path: `backup/history/import` validates against the current cutoff marker, stitches imported month logs and snapshots, then clears the marker.
- Importing earlier history also requires matching the Drive cutoff marker before data is merged locally.

### History Exports Behavior
- Download commit: exports only that commit's events from local IDB (no header; event lines omit `commitId`/`size`).
- Download up to here: bundles monthly files from Drive, slicing the commit month from the file header through the target commit (inclusive), using raw JSONL lines (with `commitId` and `size`).
- Slicing detail: the month slicer includes all lines up to the last occurrence of the target `commitId`. If a month file ever contained duplicate entries for the same commit (e.g., older replay/import), the bundle may include intervening commits and a repeated target commit. The dedup-on-append guard above prevents new duplicates.
 - Pending channels operations (`pending/*`) are not recorded in version history; they do not appear in export lines.

## Restore (Dry Run + Apply)
 - Snapshot shape: `{ version:1, at, tags[], tagGroups[], groups[], rules[], collections[], videoIndex[], channelIndex[], pendingChannels[] }`.
- Dry run (`backup/restore/dryRun`) returns counts by category for merge/overwrite and indicates which apply flags would enact changes.
- Apply (`backup/restore/apply`) supports merge/overwrite and selective application of `channelTags`, `videoTags`, `sources`, `progress`, and `collections` (registry + per‑video membership). Tag names are de‑duplicated and tag groups remapped by name.
- Post-apply: emit `db/change` for affected entities, queue commit flush, and queue settings backup.

## Options UI Highlights
- Top-level tabs: Manager (current Options UI), Subs (chronological feed view), Recommender (multi-source recommendations). Manager contains the existing views and toolbars below. Subs shows the Presets section in the sidebar for parity with Manager.
- Subs mode: shows videos from channels tagged `subscribed` and videos whose `sources` include `SubscriptionsFeed`, sorted by `uploadedAt` (chronological). Reuses FiltersBar and Presets. Adds top-right indicators: latest publish time and last subs scrape timestamp, plus a "Scrape" button.
- Recommender mode: placeholder view for now; includes a top-right "Shuffle" button (no-op).
- Pagination: Manager and Subs show pager and page-size controls at both top and bottom. Recommender does not paginate.
- IndexedDB: `DB_VERSION = 15`; added compound index `videos.byUploadedAt` on `['uploadedAt','id']` for chronological paging (use cursor direction 'prev' for newest first). UI exposes a helper to page by this index.
- Views: Videos, Trash, Channels, Channels Trash, and Pending (debug). A view header shows the current view ("Videos", "Videos Trash", "Channels", "Channels Trash", or "Pending (debug)").
- Top bar toggles (single buttons):
  - List <-> Grid view
  - Videos <-> Channels (aware of trash)
  - Trash toggle (switches Videos <-> Videos Trash or Channels <-> Channels Trash)
- Selection toolbar:
  - Buttons: `all` (select all matching current filter), `C` (clear all selection), `Inv` (invert selection within current filter), `D` (toggle display between normal filtered results and the disabled selection), `X` (delete/purge selected; disabled when no visible selection), `tags` (open tagger; disabled when no visible selection).
  - Count display shows visible and disabled selection: `N -M` where `N` is the number of selected items currently visible under the normal filter, and `M` is the number of selected items hidden by active filters (temporarily disabled). Hidden selections are ignored by actions in normal view and automatically re-enable if they become visible again. `C` clears both visible and hidden selections.
  - Display toggle `D`: when active, the list shows only the disabled selection (items currently hidden by the filter). Actions (`X`, `tags`, `Inv`, `all`) operate on the items visible in the current display mode. The `N -M` counter remains anchored to the normal filter (so `-M` always means "hidden by current filters").
- Default tags (hardcoded): system tags shown like normal tags but not deletable/renamable. The default tag group `default tags` appears at the top for manual defaults.
  - `no fetch` (videos/channels; manual): excludes tagged videos from API refresh; on channels, excludes that channel’s videos from video refresh.
  - `hide` (videos/channels; manual):
    - Videos: excluded from the Videos list by default; visible when filtering by the `hide` tag.
    - Channels: excluded from the Channels list by default; visible when filtering by the `hide` tag.
  - `subscribed` / `unsubscribed` (channels; automatic): set by Subscriptions Manager scraping; hidden from tag pickers but available in filters.
  - `tagged` (channels; manual+auto): auto-applied when tagging a channel via Popup; also manually appliable under `default tags`.
  - `scrape` (channels; manual): when applied, the channel is included in the `scrapable channels` default preset.
  - `0`..`10` (videos/channels; manual): Rating tags grouped under the `Rating` tag group (default). These are default tags and are not deletable/renamable.
 - Default tag group (additional): `Rating` — contains rating tags `0`..`10` and is not deletable/renamable.
- Default preset (hardcoded): `scrapable channels` with scrape enabled and a `channelIdIn` condition built from channels tagged `scrape`. It is non-deletable and its scrape toggle is locked on.
- Actions and labels:
  - "Refresh DB" reloads local list (no API calls).
 - Rules: A section below Presets lists all rules and provides a creator form with fields: `name`, `preset` (existing Group/Presets), `action` (initially supports tags add/remove), optional `channelIds` (comma/space‑separated), and an `enabled` toggle. Buttons: `Create`, `Run` (apply all enabled rules now). Each rule row shows enable/disable and delete controls.
  - "Fetch video data" calls YouTube API to fetch video metadata.
  - "Fetch channels (unfetched)" fetches channels that were never fetched.
- Stubs indicator: merged into the checkbox label, shows "X stubs" (total across videos+channels) and "Y in view" on a second line (aligned with padding).
  - Images: the Options UI uses lowest-resolution thumbnails/avatars for efficiency.
- Sidebar: Tag CRUD, Tag Groups CRUD, assign tags to groups; tag pickers grouped by Tag Group.
  - Tag Groups: one-level nesting via parent selector ("parent" makes a group a parent); each row includes a 26px color picker. Rename (R) and delete (x) mirror tag controls.
- Tagger (top bar): groups are shown per parent tag group. Parent headers use the parent color with opposite text; tag buttons inherit the nested tag group color (if set). Within a parent, nested groups are ordered alphabetically, then tags inside each nested group are sorted (numeric for Rating).
- Video/Channel list badges: each applied tag renders as a mini-badge colored by its parent tag group (background + darker 1px border, opposite text color).
- Bulk actions: selection + bulk tagging; delete/restore; wipe duplicate sources.
  - Backup/History: Version History modal lists commits with sizes/weights, shows Drive usage, can download a commit (UTF-8 base64), download a bundle up to a commit (zip, UTF-8 base64 parts), delete up to a commit (commit-bounded). "Revert to here" and "Snapshot now" buttons added. Delete-up-to preflight warns if no baseline snapshot exists before the target commit.
  - Version History modal header also includes:
    - "DL": triggers per-file downloads (OK for small data).
    - "DL (folder)": uses chunked ranges (`backup/downloadFileRange`) to write all files to a chosen folder via File System Access API, avoiding OOM for large datasets.
    - "DL Snapshot": creates a new `snapshots/settings-YYYYMMDD-HHMMSS.json` and downloads it immediately.
    - "Wipe All": clears appDataFolder after confirmation.
- Debug panels: per-video and per-channel raw record inspectors; channels list shows derived `videoTags`, `keywords`, `topics`.

## Popup Highlights
- Shows current page context (watch/channel/other); "Scrape current page"; toggle "Auto-capture stubs on watch pages".
- Tag current video/channel using grouped tag pickers; non-manual default tags are hidden. Applying any channel tag auto-applies the `tagged` default tag.
 - Parent/nested tag group presentation mirrors Options: parent headers use parent color; tag buttons use nested group colors.

## Core Invariants
- Background is the only writer to IndexedDB; UI and content scripts perform read-only transactions and close DB connections after `oncomplete`.
- Background message handlers must return `true` from the listener to keep the async response channel open (MV3 requirement).
- Keep push notifications (`db/change { entity }`) accurate so UIs refresh only what is needed.
- Storage/type uses the name "Group"; UI labels it "Preset". Keep the clarifying comments in code and this doc.

## Adding Features Safely
- New DB fields or stores: update `src/background/db.ts`, bump `DB_VERSION`, handle migration in `onupgradeneeded`, and update this doc's Storage Model section.
- New message/route: add to `src/types/messages.ts`, implement in `src/background/index.ts`, and list under Messaging Protocol.
- New predicates: update `src/shared/conditions.ts` (matchers) and extend Filters UI (`src/ui/options/lib/filters.ts`, `FiltersBar.tsx`). If auto-scrape should evaluate them, extend the content-side evaluator and the `isPresetScrapeCheckable` logic, then document the predicate under Auto-Scrape.
- UI updates: wire through `src/ui/lib/messaging.ts`, keep debounced refresh patterns, and document user-visible changes here.
- Backup/Restore: update `driveBackup.ts` / `events.ts` / `restore.ts` and document any new thresholds or flows.

## Development Workflow
### Environment & Build
- Prereqs: recent Node.js (18+ recommended), npm.
- Install: `npm i`
- Build once: `npm run build` (writes `dist/`)
- Dev watch (run in parallel terminals):
  - `npm run watch:bg` - background service worker bundle to `dist/background/`
  - `npm run watch:cs` - content script bundle to `dist/content/`
  - `npm run watch:opt` - Options UI to `dist/ui/options/`
  - `npm run watch:pop` - Popup UI to `dist/ui/popup/`
- Load in Chrome/Chromium: Extensions -> Developer Mode -> Load unpacked -> select `dist/` (manifest is `dist/manifest.json`). Reload extension after background changes.

### Schema Changes (IndexedDB)
- Bump `DB_VERSION` and handle migrations in `onupgradeneeded`.
  - Create new object stores and indexes defensively (`db.objectStoreNames.contains(...)`).
  - For index changes, delete old indexes with try/catch to stay resilient across versions.
  - Avoid data loss; migrate or normalize rows when practical.
  - Validate upgrade path on a profile that already has prior data.
  - Update the Storage Model section in this doc after schema changes.

### Adding or Changing Message Contracts
- Add union cases in `src/types/messages.ts` with precise payload shapes.
- Implement the handler in `src/background/index.ts` and ensure the listener returns `true`.
- Emit `chrome.runtime.sendMessage({ type: 'db/change', payload: { entity } })` for affected entities.
- Record events via `recordEvent(kind, payload, { impact })` around meaningful mutations.
- Call `scheduleBackup()` (queues commit flush + snapshot save) for user-visible mutations.
- Document new routes under Messaging Protocol.

### Predicates & Filters (end-to-end)
- Extend `src/shared/conditions.ts` types and both evaluators:
  - `matches(video, cond, ctx)` for video-side predicates
  - `matchesChannel(channel, cond, ctx)` for channel-side and existential video predicates
- Map new predicates in `src/ui/options/lib/filters.ts` (`entryToCondition`, `chainToCondition`, `conditionToChainSimple`).
- Render/edit widgets in `src/ui/options/components/FiltersBar.tsx`.
- If scrape-time evaluation is required, update `src/content/index.ts` (candidate evaluator) and UI gating (`isPresetScrapeCheckable` in App.tsx), then update Auto-Scrape docs.

### Auto-Scrape & Sources Field
- Candidates carry `sources: Array<{ type: string; id?: string | null }>` so you can filter by where a video was seen.
- Known types: `playlist`, `panel`, `WatchPage`, `ChannelVideosTab`, `ChannelShortsTab`, `ChannelLivestreamsTab`, `SubscriptionsFeed`, `WatchHistory`.
- When adding new source types, update content emitters, Filters UI sources chip (`v_sources_any`), and any derived counts/displays that list sources.

## UI Patterns & UX
- Debounce: Options listens to `db/change` and debounces reloads (~200ms) to avoid churn during batch ops.
- Lazy debug loads: "Show info" toggles fetch full rows for display to reduce baseline payload.
- Accessibility basics: list items are keyboard-toggleable; badges for flags; counts and progress surfaced.
- Channel directory: shows derived `videoTags[]` from videos; kept in sync by recompute functions after tag updates.
- Pending -> Scrape Panel: stores limits in `chrome.storage.local` (`scrape.max.subFeed`, `scrape.max.history`) and reports running state via `scrape/status`.

## Logging & Debug
- Debug helpers in `src/types/debug.ts` - set `DEBUG=false` to silence logs.
- Background catches `unhandledrejection` and `error` to surface worker errors.
- Options header shows last refresh/backup times and Drive backlog size.

## Quality Checklist (before shipping a change)
- Build OK: `npm run build` succeeds; `dist/` contains background, content, UI, and manifest.
- Options loads; switching views (Videos/Trash/Channels/Channels Trash/Pending) works.
- Tag CRUD, Tag Group CRUD, Preset save/edit/delete, and scrape toggle behavior correct.
- "Refresh DB" reloads lists; "Fetch video data" prompts for API key if missing; progress counters/alerts update; stubs count (videos+channels) reasonable.
- Backup: "Version History" shows commits; download commit works; usage numbers present.
- History cutoffs: "Delete up to here" creates cutoff marker; "Download up to here" bundles lines; import verifies marker; slicing respects commit boundaries.
- Restore: dry-run and apply exercise counts and write paths; data merges as expected (sanity-check tags/sources/progress on a few rows).

## Common Task Recipes
- Add a new tag predicate for videos:
  1) Add predicate in `conditions.ts` (types + both evaluators)
  2) Add UI mapping in `filters.ts` and component rendering in `FiltersBar.tsx`
  3) If needed at scrape-time, support in content evaluator and UI's `isPresetScrapeCheckable`
  4) Update this doc's predicate lists
- Add a background route:
  1) Add type in `messages.ts`
  2) Implement handler in `background/index.ts` (return `true`, record events, push `db/change`, schedule backup)
  3) Call from UI via `send()` and handle response
- Add a new DB store/index:
  1) Bump `DB_VERSION`, add store/index in `onupgradeneeded`
  2) Write read/write helpers (keep background as the only writer)
  3) Update Options to read via `src/ui/lib/idb.ts` (read-only)
  4) Document store schema in this file

## Changelog
- 2025-09-25
  - Sub Feed latest marker ignores livestreams: content selects the first non-livestream tile (skips tiles whose badge text reads `LIVE`) when computing `dom.firstId` for `scrape/LOG`. As a result, `latestFromSubFeed` and `meta['latestBy.SubscriptionsFeed']` reflect the latest uploaded video, not a live stream.
- 2025-09-24
  - Data: stop storing raw `yt` payloads for videos/channels; add compact projections to video rows (`type`, `transcript`, `views`, `likes`, `commentCount`, `liveViewers`, `rejectionReason`, `failureReason`, `premiereTime`, `customThumbnail`, `contentRating`, `regionRestriction`).
  - Data: channels store `thumbnailID` (unique avatar hash), `playlists` (related playlists), and omit `thumbnails`/`bannerUrl`/raw `yt`.
  - UI: Options uses lowest-resolution images; channel avatars built from `thumbnailID`.
  - Refresh: channel fetch now requests `contentDetails` and `topicDetails`; selective diffs updated (`thumbnailID` instead of `avatarUrl`/`bannerUrl`). Video fetch no longer requests the `player` part.
  - Derived: added per-channel `videoTopics[]` aggregation after video refresh.
  - History: exclude pending channel operations from version history (`pending/*` are ignored by the event recorder) to reduce noise in Version History and snapshots.
  - Scrape: Sub Feed and Watch History routines now scroll aggressively — background sends `scrape/SCROLL_BOTTOM` every iteration to reach the bottom faster and load more items.
  - Scrape Panel: Added per-source toggles to "stop at previous most recent video" for Sub Feed and Watch History. Each run marks the top-most item as latest for that source (stored in `meta` and flagged on the video), and early-stops when enabled.
- 2025-09-23
  - DB_VERSION bumped to 13. Removed legacy `videos.byLastSeen` index during upgrade; no data loss.
  - History: added dedup-on-append guard to monthly JSONL (skip appending a commit if the same `commitId` already exists).
  - Drive: implemented `backup/downloadFileRange` for chunked downloads (used by "DL (folder)").
  - Wipe All: fixed route implementation; now deletes Drive appData files and clears local IndexedDB.
  - Scrape: Sub Feed now respects enabled scrape presets (content-side gating) and upserts channel stubs/pending for accepted tiles.
- 2025-09-21
  - DB_VERSION bumped to 12. `channels_pending` rows may include `subscribedPending` to record a pending "subscribed" state captured from Subscriptions Manager before a concrete channel id exists. On resolve, background promotes `subscribed=true` on the resolved channel id and clears the pending entry.
- 2025-09-22
  - Added `backup/wipeAll`. Version History modal gained "DL" and chunked "DL (folder)" (uses new `backup/downloadFileRange`), plus "DL Snapshot" to create and download a settings snapshot.
- 2025-09-06
  - Scrape Panel v1 integrated into Pending (debug): Run all, Resolve ids, Scrape Sub Feed, Scrape Subscriptions Manager, Scrape Watch History, Stop. Shows last-run timestamps and supports max limits.
  - Sub Feed/History scrapers merge into existing videos, append sources (`SubscriptionsFeed`/`WatchHistory`), and bump `lastSeenAt`. History marks `flags.started=true`; explicit watch progress still wins.
  - Subscriptions Manager scrapes `/feed/channels` and updates channel `subscribed`/`unsubscribed` flags.
- 2025-09-05
  - Drive backups: encryption/passphrase removed; all snapshots/history stored as plaintext JSON/JSONL. Silent auth by default; manual "Backup settings" finalizes pending commit and replays backlog.
  - History downloads: commit JSONL and "up to" bundles use UTF-8-safe base64 downloads; slicing operates on full commits.
  - Options top bar: single toggles for List/Grid, Videos/Channels, and Trash; removed separate Channel Trash button and "Select page"; renamed "Refresh" -> "Refresh DB"; clarified "Fetch video data" and "Fetch channels (unfetched)".
  - Stubs indicator: shows total across videos+channels and "X in view". New `channels/stubsCount` complements `videos/stubsCount` for totals.
  - History modal: widened; added "Revert to here" and "Snapshot now"; delete-up-to warns if no baseline snapshot exists before target.
- 2025-09-01
  - Restore & Apply (dry run/apply) added; pending channels pipeline refined (gated, de-duped, batch resolver); Drive auth made silent by default; backlog replay and "Drive backlog" badge added; history routes and UI extended; selective API-change events logged on refresh.

## Notes / TODO
- Rules: first-pass implemented (local storage `settings.rules`, background routes, Options Rules section). Engine currently supports tag add/remove actions on preset matches; additional actions can be added next.
- Consider optional "visible folder" backup mode (Drive `drive.file`) if needed later; current implementation targets appData only.

## Update Inbox
Use this section as an "inbox" for future patch notes. After integrating updates into the sections above and the Changelog, clear the notes here.

## Removed From Project Overview
- Original preface line: "tell me when you're ready to work on my project, here's my project_ovierview.md:" (removed to keep this doc focused on actionable project context).


### Recent Changes (2025-10-04)
- Tag Groups: add one-level nesting and colors.
  - Sidebar: each tag group row includes a parent selector (option "parent" makes a group a parent) and a native color picker (26px width). Buttons mirror tag buttons: rename=R, delete=x.
  - Messaging: new `tagGroups/update { id, patch }` route to set `parentId` and `color`.
  - Options Tagger (top bar): tags are grouped under parent tag groups; within each parent, tags are ordered by nested tag group (alphabetically) and then by tag (numeric for Rating). Parent `<summary>` uses the parent group color; tag buttons use their nested group color; text uses the exact opposite color; borders use a darker shade.
  - Video/Channel views: tag badges use their parent tag group color as background, darker 1px border, and opposite text color.
  - Popup: mirrors the Options Tagger grouping and colors (parent summaries colored; buttons use nested group colors).
  - Filters: tag filter chips group by parent -> nested tag group; parent summaries use parent color; individual checkboxes use nested group color with opposite text color.
- Options (top-level tabs): Sidebar now shows three tabs at the very top — "Manager", "Subs", and "Recommender" — spanning the full sidebar width. The active tab uses normal interface colors and the bottom border disappears (tab look); inactive tabs use slightly muted background/text. Selecting a tab switches the entire Options layout: Manager shows the existing Options UI; Subs renders placeholders for now but exposes Presets in the sidebar (same as Manager); Recommender renders placeholders for now.
 - Filters everywhere: FiltersBar and Presets are available in all three modes (Manager, Subs, Recommender). Subs/Recommender currently apply filters but show placeholder result areas until fully implemented.
 - URL hash: Options page reflects/persists `mode` and `view` as a hash query (e.g., `#mode=subs&view=channels`). Mode also persists in `chrome.storage.local['options.mode']` and view in `['options.view']`.
 - Sidebar UX: Tabs sit outside the scrollable sidebar body to avoid layout shifts when the body scrollbar appears/disappears.
### Recent Changes (2025-10-04)
- Collections: hierarchical, playlist-like groups of videos.
  - Storage: definitions in `chrome.storage.local.settings.collections`; membership on videos via `collectionIds: string[]` with new index `videos.byCollection`.
  - Rules: support `action.kind = 'collections'` with `add[]` / `remove[]` of collection ids.
  - UI: Always‑visible topbar control next to `tags` in Manager/Subs/Recommender lets you pick a collection and +/− add/remove the current selection.
    - Tagger panel also exposes the same control.
    - Sidebar adds a Collections section (below Rules) to create/rename/delete, pick a color, set `parentId`, and click to filter the video list by that collection.
    - Collections have colors; video cards render collection badges tinted with that color.
    - A new Filters chip “Collections” lets you include/exclude videos by collection id; parent inheritance applies (videos in a child match their ancestors too).
    - Switching between a collection view and normal Videos view disables the selection; switching Channels ↔ Videos clears it (unchanged).
  - Backups: settings `collections[]` included in `settings.json` snapshots and baseline snapshots.

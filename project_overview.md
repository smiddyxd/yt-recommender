Ultimate Project Overview — YT Manager

Meta: Always-Update Contract
- Purpose: This document is the ground truth primer for new Codex chats. If code changes alter architecture, data schema, message contracts, or UI flows, update this file in the same PR.
- When to update: Any change to one of the following:
  - IndexedDB schema or `DB_VERSION`
  - Message types in `src/types/messages.ts` or routes in `src/background/index.ts`
  - Content auto-scrape behavior or gating rules
  - Backup/history/restore behavior
  - Options/Popup UI features or flows
- How to update (checklist):
  1) Bump “Verified As Of” date below. 2) Add/remove items in Architecture and Storage Model. 3) Reflect new/changed messages under Messaging Protocol. 4) Note any new user-visible flows in UI. 5) Record notable behavior changes in Changelog.

Verified As Of: 2025-09-05

TL;DR
- Extension (MV3) that caches YouTube videos/channels you see, enriches via YouTube Data API, lets you filter/tag/group in an Options UI, and backs up configuration and history to Google Drive appData.
- Build: `npm run build` → `dist/`; load unpacked extension from `dist` in Chromium-based browser.
- Dev watch (run each in separate terminals): `npm run watch:bg`, `watch:cs`, `watch:opt`, `watch:pop`.
- First-use: Open Options, click “Refresh data” and provide your YouTube API key (stored in `chrome.storage.local.ytApiKey`).

Architecture
- Manifest V3: background service worker, one content script, Options page (React), Popup (React).
- Background
  - `src/background/index.ts`: single message router and orchestration (DB writes, refresh, backup/history routes, restore routes).
  - `src/background/db.ts`: IndexedDB schema and all data mutations (videos/channels/tags/groups/tag-groups/trash/pending/events/meta). Current `DB_VERSION = 11`.
  - `src/background/driveBackup.ts`: Google Drive appData auth + read/write (JSON, JSONL, snapshots). Plaintext storage (no encryption).
  - `src/background/events.ts`: Event batching into commits, local history in IDB, append to monthly JSONL in Drive, dynamic checkpoints, backlog replay.
  - `src/background/restore.ts`: Dry-run and apply restore from settings snapshots (merge/overwrite, selective fields).
- Content
  - `src/content/index.ts`: listens for `scrape/NOW`, tracks SPA navigation, auto-scrape ticker gated by presets, watch progress tracking toggle.
  - `src/content/yt-playlist-capture.ts`: page context detection, tile scanning, progress scraping, watch fallback.
  - `src/content/yt-watch-stub.ts`: robust watch-page stub capture (title/channel/channelId) with short waits for SPA render.
  - `src/content/yt-watch-progress.ts`: samples HTML5 player and sends periodic progress.
  - `src/content/yt-navigation.ts`: navigation hooks (yt-navigate-finish + URL polling fallback).
- UI
  - Options (`src/ui/options/*`): filterable list, tagging, presets, channels directory + trash, pending channels debug, backup history modal.
  - Popup (`src/ui/popup/*`): page-aware quick actions (scrape current page; tag current video/channel; toggle auto-stub-on-watch).
- Shared/Types
  - `src/shared/conditions.ts`: Condition AST, evaluation for videos/channels; “Group” type (called “Preset” in UI).
  - `src/types/messages.ts`: central message union and supporting types.
  - `src/types/debug.ts`: simple debug logging flags.

Data Flow (Happy Path)
1) Content finds candidate video ids from tiles or the watch page; sends `cache/VIDEO_SEEN` or `cache/VIDEO_STUB` to background with minimal fields and sources (playlist/panel/watch/channel-tab).
2) Background upserts into `videos` (merges flags/tags/progress/sources), optionally ensures channel stubs, and emits `db/change` to update UI.
3) Options UI reads from IDB (read-only) and sends background actions (tagging, delete/restore, refresh, channel tagging, presets CRUD, backup/history ops).
4) Refresh uses YouTube Data API (via stored API key) to fetch `videos.list` and `channels.list` in batches with retries; background normalizes and stores selective fields.
5) On mutations, background records lightweight events → commits; appends to `events-YYYY-MM.jsonl` in Drive and occasionally saves snapshots.

Auto-Scrape & Presets
- Auto-scrape runs every ~2s only if user was active within the last 10s. Disabled on channel pages and all playlist pages.
- Current watch page is always captured; other tiles are captured only if accepted by at least one enabled “Preset”.
- A preset participates at scrape-time only if its condition tree is fully checkable from in-page data. Supported predicates: `sourceAny`, `sourcePlaylistAny`, `channelIdIn`, `titleRegex`, and `groupRef` (only if referenced presets are themselves checkable).
- Tiles with just a handle/name may upsert to `channels_pending` (gated by accepted presets, per-page de-duped). Channel pages resolve pending entries to real ids automatically; Options exposes a debug panel to open background tabs and auto-resolve handles in batches.

Storage Model (IndexedDB)
- DB: `yt-recommender`, `DB_VERSION = 11`.
- Stores and key fields
  - `videos` (keyPath: `id`) — indexes: `byChannel` on `channelId`, `byTag` on `tags` (multiEntry).
  - `trash` (keyPath: `id`) — index: `byDeletedAt`.
  - `tags` (keyPath: `name`) — index: `byCreatedAt`; record: `{ name, color?, createdAt?, groupId? }`.
  - `tag_groups` (keyPath: `id`) — indexes: `byName`, `byCreatedAt`.
  - `groups` (keyPath: `id`) — indexes: `byName`, `byUpdatedAt`; record includes `scrape?: boolean`.
  - `channels` (keyPath: `id`) — indexes: `byName`, `byFetchedAt`.
  - `channels_trash` (keyPath: `id`) — index: `byDeletedAt`.
  - `channels_pending` (keyPath: `key`) — index: `byCreatedAt`; rows like `{ key: 'handle:@foo' | 'name:Some Name', name?, handle?, createdAt?, updatedAt? }`.
  - `meta` (keyPath: `key`) — holds aggregated lists like `{ key: 'videoTopics', list: string[] }`.
  - `events_commits` (keyPath: `commitId`) — index: `byTs`.
  - `events` (keyPath: `id`) — index: `byCommit`.
- Video row highlights: `id`, `title`, `channelId`, `channelName`, `durationSec`, `uploadedAt`, `fetchedAt`, `ytTags[]`, `description`, `categoryId`, `languageCode`, `visibility`, `isLive`, `videoTopics[]`, `thumbUrl`, `tags[]`, `flags.started/completed`, `progress{sec|pct|duration}`, `sources[{type,id?}]`.
- Channel row highlights: `id`, `name`, `subs`, `views`, `videos`, `country`, `publishedAt`, `subsHidden`, `tags[]`, derived `videoTags[]`, `keywords`, `topics[]`, `description`, `bannerUrl`, `fetchedAt`, `scrapedAt*` and per-tab counts.

Messaging Protocol (truth: `src/types/messages.ts`; router: background)
- Content → Background
  - `cache/VIDEO_SEEN`, `cache/VIDEO_STUB`
  - `cache/VIDEO_PROGRESS`, `cache/VIDEO_PROGRESS_PCT`
- UI → Background (selected)
  - Videos: `videos/delete`, `videos/restore`, `videos/applyTags`, `videos/wipeSources`, `videos/refreshAll`, `videos/stubsCount`, `videos/applyYTBatch`
  - Channels: `channels/list`, `channels/trashList`, `channels/refreshUnfetched`, `channels/refreshByIds`, `channels/applyTags`, `channels/markScraped`, `channels/upsertStub`, `channels/delete`, `channels/restore`
  - Tags: `tags/list`, `tags/create`, `tags/rename`, `tags/delete`, `tags/assignGroup`
  - Tag Groups: `tagGroups/list`, `tagGroups/create`, `tagGroups/rename`, `tagGroups/delete`
  - Groups/Presets: `groups/list`, `groups/create`, `groups/update` (accepts `{ scrape?: boolean }`), `groups/delete`
  - Topics: `topics/list`
  - Pending (debug): `channels/upsertPending`, `channels/resolvePending`, `channels/pending/list`, `channels/pending/resolveBatch`
  - Backup core: `backup/getClientId`, `backup/setClientId`, `backup/saveSettings`, `backup/restoreSettings`, `backup/listFiles`, `backup/downloadFile`
  - History: `backup/history/list`, `backup/history/getCommit`, `backup/history/getUpTo`, `backup/history/deleteUpTo`, `backup/history/usage`, `backup/history/import`
  - Restore & Apply: `backup/restore/dryRun`, `backup/restore/apply`
- Background → UI push
  - `db/change { entity }` (videos | tags | groups | tagGroups | channels | topics)
  - Refresh progress: `refresh/progress`, `refresh/error`, `refresh/done`
  - Backup state: `backup/progress`, `backup/done`, `backup/error`

YouTube API Refresh
- Uses `videos.list` and `channels.list` with retries and chunking (50 ids per call). API key read from `chrome.storage.local.ytApiKey`.
- Selective change history recorded during refresh:
  - Videos: diffs for `title`, `thumbnailUrl`, `description`.
  - Channels: diffs for best `avatarUrl` (from thumbnails), `bannerUrl`, `description`.
- After video refresh, background ensures channel directory consistency (fetches missing/stale channels), recomputes `channel.videoTags[]`, and aggregates distinct `videoTopics` into `meta`.

Backup, History, Snapshots (Google Drive appData)
- OAuth via `chrome.identity.launchWebAuthFlow` (scope: `drive.appdata`). Silent by default; UI requests interactive on demand.
- Files written:
  - `settings.json` (latest snapshot; optionally encrypted with AES-GCM passphrase).
  - `snapshots/settings-YYYYMMDD-HHMMSS.json` (dynamic checkpoints).
  - `events-YYYY-MM.jsonl` (monthly append-only history with a JSON header line).
  - Optional `cutoff.json` or `cutoff-*.json` marker after “Delete up to here”.
- Dynamic checkpoints: when commit processing weight ≥ 10,000 or month file size ≥ 20 MB, background saves a snapshot and resets the counter.
- Backlog replay: if Drive append fails, commit ids queue in `chrome.storage.local['drive.unsyncedCommitIds']`; background periodically replays to Drive. Options header shows a “Drive backlog: N” badge when > 0.
- Import path: `backup/history/import` validates against the current cutoff marker and stitches imported month logs and snapshots, then removes the cutoff marker on success.

Restore (Dry Run + Apply)
- Snapshot shape: `{ version:1, at, tags[], tagGroups[], groups[], videoIndex[], channelIndex[], pendingChannels[] }`.
- Dry run (`backup/restore/dryRun`): returns counts by category for merge/overwrite and which apply flags will touch what.
- Apply (`backup/restore/apply`): merge/overwrite semantics; selective application of `channelTags`, `videoTags`, `sources`, `progress`.

Options UI Highlights
- Views: Videos, Trash, Channels, Channels Trash, and Pending (debug).
- Filters editor: AND/OR/NOT linear editor for many predicates (video/channel/tag/source/topic); Save as “Preset” (backed by Group). Not all predicates are scrape-checkable — UI disables scrape toggle when unsupported.
- Tags sidebar: Tag CRUD, Tag Groups CRUD, assign tags to groups; tag pickers grouped by Tag Group.
- Bulk actions: selection + bulk tagging; delete/restore; wipe duplicate sources.
- Refresh panel: stubs count, “Refresh data” (videos), “Fetch channels (unfetched)”.
- Backup/History: Version History modal lists commits with sizes/weights, shows Drive usage, can download a commit, download bundle up to a commit, or delete up to a commit.
- Debug panels: per-video and per-channel raw record inspectors; channels list shows derived `videoTags`, `keywords`, `topics`.

Popup Highlights
- Shows current page context (watch/channel/other); “Scrape current page”; toggle “Auto-capture stubs on watch pages”.
- Tag current video/channel using grouped tag pickers; channel auto-tag helper applies a `.tagged` tag alongside the chosen tag.

Important Invariants
- Background is the only writer to IDB; UI uses read-only transactions and closes DB connections on completion.
- All background message handlers return `true` to keep response channels open for async work.
- “Group” in storage/type is labeled “Preset” in UI; keep the permanent clarification comments in code and this doc.

Adding Features Safely (playbook)
- New DB fields or stores: update `src/background/db.ts`, bump `DB_VERSION`, handle migration in `onupgradeneeded`, and reflect here under Storage Model.
- New message/route: add to `src/types/messages.ts`, implement in `src/background/index.ts`, and list under Messaging Protocol.
- New predicates: update `src/shared/conditions.ts` (matchers) and extend Filters UI (`src/ui/options/lib/filters.ts`, `FiltersBar.tsx`). If you want auto-scrape to evaluate them, add support in content scrape-time evaluator and list predicate under “scrape-checkable”.
- UI: wire via `src/ui/lib/messaging.ts`; keep debounced refresh patterns; reflect user-visible changes here.
- Backup/Restore: update `driveBackup.ts`/`events.ts`/`restore.ts` and document any new thresholds/flows.

Changelog (concise)
- 2025-09-01: Restore & Apply (dry run/apply) added; pending channels pipeline refined (gated, de-duped, batch resolver); Drive auth made silent by default; backlog replay and “Drive backlog” badge added; history routes and UI extended; selective API-change events logged on refresh.

Notes / TODO
- `rules` store and `rules/*` message types are presently stubs; no background routes implemented yet.
- Consider optional “visible folder” backup mode (Drive `drive.file`) if needed in future; current implementation targets appData only.


Contributing Guide (for new Codex chats)

Environment & Build
- Prereqs: recent Node.js (18+ recommended), npm.
- Install: `npm i`
- Build once: `npm run build` (writes `dist/`)
- Dev watch (run in parallel terminals):
  - `npm run watch:bg` — background service worker bundle to `dist/background/`
  - `npm run watch:cs` — content script bundle to `dist/content/`
  - `npm run watch:opt` — Options UI to `dist/ui/options/`
  - `npm run watch:pop` — Popup UI to `dist/ui/popup/`
- Load in Chrome/Chromium: Extensions → Developer Mode → Load unpacked → select `dist/` (manifest is `dist/manifest.json`). Reload extension after background changes.

Core Invariants
- Background is the sole writer to IndexedDB. UI and content scripts only perform read-only IDB transactions and close DB connections after `oncomplete`.
- Background message handlers should return `true` from the listener to keep the async response channel open (MV3 requirement).
- Keep push notifications (`db/change { entity }`) accurate so UIs refresh only what’s needed.
- Maintain the “Preset vs Group” naming: storage/type is Group; UI labels as Preset. Keep the permanent comments in code and this overview.

Schema Changes (IndexedDB)
- Location: `src/background/db.ts`
- Bump `DB_VERSION` and handle migrations in `onupgradeneeded`:
  - Create new object stores and indexes defensively (check `db.objectStoreNames.contains(...)`).
  - For index changes, delete old indexes with try/catch to be resilient across versions.
  - Avoid data loss; migrate or normalize rows when practical.
- Validate upgrade path on a profile that already has prior data.
- Update Storage Model section in this doc after schema changes.

Adding/Changing Message Contracts
- Types: add union cases in `src/types/messages.ts` with precise payload shapes.
- Router: implement corresponding branch in `src/background/index.ts` and ensure the listener returns `true`.
- Side effects:
  - Emit `chrome.runtime.sendMessage({ type: 'db/change', payload: { entity } })` for affected entities (videos, tags, groups, tagGroups, channels, topics).
  - Record events via `recordEvent(kind, payload, { impact })` around mutating ops when useful for history.
  - Call `scheduleBackup()` (queues commit flush + snapshot save) for user-visible mutations.
- UI: use `src/ui/lib/messaging.ts` `send(type, payload)` helper. Handle `chrome.runtime.lastError` in responses (the helper already does this).
- Document new routes under “Messaging Protocol”.

Predicates & Filters (end‑to‑end)
- Shared AST: extend `src/shared/conditions.ts` types and both evaluators:
  - `matches(video, cond, ctx)` for video-side predicates
  - `matchesChannel(channel, cond, ctx)` for channel-side and existential video predicates
- Filters UI: map new predicates in `src/ui/options/lib/filters.ts`:
  - `entryToCondition`, `chainToCondition`, and `conditionToChainSimple` (if reversible)
  - Render/edit widgets in `src/ui/options/components/FiltersBar.tsx`
- Auto-scrape support: if the predicate should be checkable at scrape-time, add handling to content’s evaluator and keep the “checkable” list in sync:
  - `src/content/index.ts` scrape-time `evalPresetOnCandidate` and `isCheckable`
  - UI gating for scrape toggle in Options (`isPresetScrapeCheckable` in App.tsx)
- Update this doc’s “Auto‑Scrape & Presets” section with any changes to checkable predicates.

Auto‑Scrape & Sources Field
- Candidates carry `sources: Array<{ type: string; id?: string | null }>` so you can filter by where a video was seen.
- Known types: `playlist`, `panel`, `WatchPage`, `ChannelVideosTab`, `ChannelShortsTab`, `ChannelLivestreamsTab`.
- If you add new source types, update:
  - Content emitters (where candidates are created)
  - Filters UI sources chip (`v_sources_any`)
  - Any derived counts or displays that list sources

Backup / History (Drive appData)
- Event history: call `recordEvent` for meaningful mutations (tag ops, delete/restore, assign group, channel tag ops, etc.). Include an `impact` estimate to drive snapshot thresholds.
- Commit flush: `queueCommitFlush(3000)` batches events into a single commit; `finalizeCommitAndFlushIfAny()` runs during backup schedule.
- JSONL month files: background rewrites `events-YYYY-MM.jsonl` by appending; includes a header line with month metadata.
- Snapshots: dynamic checkpoint when weight ≥ 10k or month size ≥ 20 MB; daily alarm also saves settings.
- Backlog replay: if Drive append fails (auth, network), commits are queued in `chrome.storage.local['drive.unsyncedCommitIds']` and later replayed silently.
- Import of history: must match the current cutoff marker on Drive; then stitches earlier months and snapshots and clears the marker.

Restore (Dry Run + Apply)
- Snapshot: `SettingsSnapshot` includes registries and compact indices; versioned at 1.
- Dry run: `backup/restore/dryRun { mode, apply }` counts potential changes without writing.
- Apply: `backup/restore/apply { mode, apply }` merges or overwrites selectively:
  - `channelTags`, `videoTags`, `sources`, `progress`
- Post-apply: emit db/change for affected entities, queue commit flush, and queue settings backup.

UI Patterns & UX
- Debounce: Options listens to `db/change` and debounces reloads (~200ms) to avoid churn during batch ops.
- Lazy debug loads: “Show info” toggles fetch full rows for display to reduce baseline payload.
- Accessibility basics: list items are keyboard-toggleable; badges for flags; counts and progress surfaced.
- Channel directory: shows derived `videoTags[]` from videos; kept in sync by recompute functions after tag updates.

YouTube API Refresh Tips
- API key is stored in `chrome.storage.local.ytApiKey`.
- Batch fetch with `fetchVideosListWithRetry` / `fetchChannelsListWithRetry` at up to 50 ids per call; backoff between attempts.
- After video refresh: fetch missing/stale channel rows, recompute channel `videoTags[]`, recompute global `videoTopics` in `meta`.
- Selective attribute-diff events are recorded for videos (title, thumbnailUrl, description) and channels (avatarUrl, bannerUrl, description).

Logging & Debug
- Debug helpers in `src/types/debug.ts` — set `DEBUG=false` to silence logs.
- Background catches `unhandledrejection` and `error` to surface worker errors.
- Options header shows last refresh/backup times and Drive backlog size.

Quality Checklist (before shipping a change)
- Build OK: `npm run build` succeeds; `dist/` contains background, content, UI, and manifest.
- Options loads; switching views (Videos/Trash/Channels/Channels Trash/Pending) works.
- Tag CRUD, Tag Group CRUD, Preset save/edit/delete, and scrape toggle behavior correct.
- Refresh data prompts for API key if missing; progress counters/alerts update; stubs count reasonable.
- Backup: “Version History” shows commits; download commit works; usage numbers present.
- History cutoffs: “Delete up to here” creates cutoff marker; “Download up to here” bundles lines; import verifies marker.
- Restore: dry-run and apply exercise counts and write paths; data merges as expected (sanity-check tags/sources/progress on a few rows).

Common Task Recipes
- Add a new tag predicate for videos:
  1) Add predicate in `conditions.ts` (types + both evaluators)
  2) Add UI mapping in `filters.ts` and component rendering in `FiltersBar.tsx`
  3) If needed at scrape-time, support in content evaluator and UI’s `isPresetScrapeCheckable`
  4) Update this doc’s predicate lists
- Add a background route:
  1) Add type in `messages.ts`
  2) Implement handler in `background/index.ts` (return `true`, record events, push `db/change`, schedule backup)
  3) Call from UI via `send()` and handle response
- Add a new DB store/index:
  1) Bump `DB_VERSION`, add store/index in `onupgradeneeded`
  2) Write read/write helpers (keep background as the only writer)
  3) Update Options to read via `src/ui/lib/idb.ts` (read-only)
  4) Document store schema in this file

Housekeeping
- Keep this file’s “Verified As Of” date current when semantics change.
- Record notable changes in the Changelog block above.
- Prefer small, explicit message names and payloads; include enough info in `impact` for meaningful history summaries.

Recent Updates (2025-09-02)
- Name: project branding updated to "YT Manager".
- Drive backups: encryption/passphrase removed � all snapshots/history stored as plaintext JSON/JSONL.
- History export slicing: "Download up to here" and "Delete up to here" now include/remove entire commits (all lines sharing the commitId), fixing missed fast-follow events.
- Restore (merge mode): tag-name dedupe (case/trim) and tag-group remap by name to avoid duplicates; incoming references mapped to local canonical names/groups.
- Revert to Here: new route `backup/history/revertTo { commitId, dryRun? }` (snapshot + forward replay), with UI buttons in the History modal.
- Baseline bootstrap: background creates an initial snapshot if none exists (on startup silently; and after setting Drive Client ID interactively).
- Snapshot now: new route `backup/history/snapshotNow { interactive?, name? }` and button in History modal.
- UI: History modal widened; delete-up-to preflight warns if no baseline snapshot exists before the target commit.


Ultimate Project Overview — YT Manager

Meta: Always-Update Contract
- Purpose: This document is the ground truth primer for new Codex chats. If code changes alter architecture, data schema, message contracts, or UI flows, update this file in the same PR.
- When to update: Any change to one of the following:
  - IndexedDB schema or DB_VERSION
  - Message types in src/types/messages.ts or routes in src/background/index.ts
  - Content auto-scrape behavior or gating rules
  - Backup/history/restore behavior
  - Options/Popup UI features or flows
- How to update (checklist):
  1) Bump “Verified As Of” date below. 2) Add/remove items in Architecture and Storage Model. 3) Reflect new/changed messages under Messaging Protocol. 4) Note any new user-visible flows in UI. 5) Record notable behavior changes in Changelog.

Verified As Of: 2025-09-05

TL;DR
- MV3 extension that caches YouTube videos/channels as you browse, enriches via YouTube Data API, lets you filter/tag/group in an Options UI, and backs up configuration and history to Google Drive appData.
- Build: npm run build → dist/; load unpacked from dist in a Chromium-based browser.
- Dev watch (run each in separate terminals): watch:bg, watch:cs, watch:opt, watch:pop.
- First-use: open Options, click “Fetch video data”, provide your YouTube API key (stored in chrome.storage.local.ytApiKey).

Architecture
- Background
  - src/background/index.ts: single message router and orchestration (DB writes, refresh, backup/history, restore).
  - src/background/db.ts: IndexedDB schema and all mutations (videos/channels/tags/groups/tag-groups/trash/pending/events/meta). Current DB_VERSION = 11.
  - src/background/driveBackup.ts: Google Drive appData auth + read/write (JSON, JSONL, snapshots). Plaintext storage (no encryption). Silent auth by default; pass interactive: true when prompting is desired.
  - src/background/events.ts: Event batching into commits, local history in IDB, append to monthly JSONL in Drive, dynamic checkpoints, backlog replay.
  - src/background/restore.ts: Dry-run and apply restore from settings snapshots (merge/overwrite, selective fields).
- Content
  - src/content/index.ts: listens for scrape/NOW, tracks SPA navigation, auto-scrape ticker gated by presets, watch progress toggle.
  - src/content/yt-* files: page context detection, tile scanning, watch-page stub capture and progress.
- UI
  - Options (React): filtering/tagging, channels directory + trash, pending channels debug, backup/history modal.
  - Popup (React): page-aware quick actions.
- Shared/Types
  - src/shared/conditions.ts: Condition AST and evaluators for videos/channels (“Group” in storage; labeled “Preset” in UI).
  - src/types/messages.ts: central message union and supporting types.

Data Flow (Happy Path)
1) Content finds candidate video IDs from tiles or the watch page; sends cache/VIDEO_SEEN or cache/VIDEO_STUB to background with minimal fields and sources (playlist/panel/watch/channel-tab).
2) Background upserts into videos (merges flags/tags/progress/sources), optionally ensures channel stubs, and emits db/change for UI refresh.
3) Options UI reads from IDB (read-only) and sends background actions (tagging, delete/restore, refresh, channel tagging, presets CRUD, backup/history ops).
4) Refresh uses YouTube Data API (stored API key) to fetch videos.list and channels.list; background normalizes and stores selective fields.
5) Mutations record lightweight events → commits; appended to events-YYYY-MM.jsonl in Drive; periodic snapshots.

Auto-Scrape & Presets
- Auto-scrape runs every ~2s only if user was active within the last 10s. Disabled on channel pages and all playlist pages.
- Watch page is always captured; other tiles only if accepted by an enabled preset.
- Preset is eligible at scrape-time only if fully checkable from in-page data. Supported: sourceAny, sourcePlaylistAny, channelIdIn, titleRegex, groupRef (only if referenced presets are also checkable).
- Tiles with only a handle/name may upsert to channels_pending (gated and de-duped). Channel pages resolve pending entries to real IDs; Options includes a debug panel to auto-resolve handles.

Storage Model (IndexedDB)
- DB name: yt-recommender, DB_VERSION = 11.
- Stores
  - videos (keyPath: id) — indexes: byChannel on channelId, byTag on tags (multiEntry).
  - trash (keyPath: id) — index: byDeletedAt.
  - tags (keyPath: name) — index: byCreatedAt; row: { name, color?, createdAt?, groupId? }.
  - tag_groups (keyPath: id) — indexes: byName, byCreatedAt.
  - groups (keyPath: id) — indexes: byName, byUpdatedAt; row includes scrape?: boolean.
  - channels (keyPath: id) — indexes: byName, byFetchedAt.
  - channels_trash (keyPath: id) — index: byDeletedAt.
  - channels_pending (keyPath: key) — index: byCreatedAt; rows like { key: 'handle:@foo' | 'name:Some Name', name?, handle?, createdAt?, updatedAt? }.
  - meta (keyPath: key) — holds aggregated lists like { key: 'videoTopics', list: string[] }.
  - events_commits (keyPath: commitId) — index: byTs.
  - events (keyPath: id) — index: byCommit.

Messaging Protocol (truth: src/types/messages.ts; router: background)
- Content → Background: cache/VIDEO_SEEN, cache/VIDEO_STUB, cache/VIDEO_PROGRESS, cache/VIDEO_PROGRESS_PCT
- UI → Background (selected)
  - Videos: videos/delete, videos/restore, videos/applyTags, videos/wipeSources, videos/refreshAll, videos/stubsCount, videos/applyYTBatch
  - Channels: channels/list, channels/trashList, channels/refreshUnfetched, channels/refreshByIds, channels/applyTags, channels/markScraped, channels/upsertStub, channels/delete, channels/restore, channels/stubsCount
  - Tags: tags/list, tags/create, tags/rename, tags/delete, tags/assignGroup
  - Tag Groups: tagGroups/list, tagGroups/create, tagGroups/rename, tagGroups/delete
  - Groups/Presets: groups/list, groups/create, groups/update (accepts { scrape?: boolean }), groups/delete
  - Topics: topics/list
  - Pending (debug): channels/upsertPending, channels/resolvePending, channels/pending/list, channels/pending/resolveBatch
  - Backup core: backup/getClientId, backup/setClientId, backup/saveSettings, backup/restoreSettings, backup/listFiles, backup/downloadFile
  - History: backup/history/list, backup/history/getCommit, backup/history/getUpTo, backup/history/deleteUpTo, backup/history/usage, backup/history/import, backup/history/revertTo, backup/history/snapshotNow
  - Restore & Apply: backup/restore/dryRun, backup/restore/apply
- Background → UI push
  - db/change { entity } (videos | tags | groups | tagGroups | channels | topics)
  - refresh/progress, refresh/error, refresh/done
  - backup/progress, backup/done, backup/error

YouTube API Refresh
- Stored API key in chrome.storage.local.ytApiKey.
- Batch fetch (up to 50 IDs per call) with retries/backoff.
- After video refresh: fetch missing/stale channels, recompute channel videoTags[], recompute global videoTopics in meta.
- Selective attribute-diff events recorded for videos (title, thumbnailUrl, description) and channels (avatarUrl, bannerUrl, description).

Backup / History (Drive appData)
- OAuth via chrome.identity.launchWebAuthFlow (scope: drive.appdata). Silent by default; UI requests interactive when needed.
- Files:
  - settings.json (latest snapshot; plaintext)
  - snapshots/settings-YYYYMMDD-HHMMSS.json (dynamic checkpoints)
  - events-YYYY-MM.jsonl (monthly append-only history with a JSON header line)
  - Optional cutoff.json or cutoff-*.json marker after “Delete up to here”
- Dynamic checkpoints: when commit processing weight ≥ 10k or month size ≥ 20 MB; daily alarm also saves settings.
- Backlog replay: if Drive append fails, commit IDs queue in chrome.storage.local['drive.unsyncedCommitIds'] and later replay silently. Manual “Backup settings” finalizes any pending commit and also triggers backlog replay.
- Downloads are UTF‑8 safe (commit JSONL and “up to” bundles).

Restore (Dry Run + Apply)
- Snapshot shape: { version:1, at, tags[], tagGroups[], groups[], videoIndex[], channelIndex[], pendingChannels[] }.
- Dry run: backup/restore/dryRun { mode, apply } returns counts by category for merge/overwrite and what apply flags will touch.
- Apply: backup/restore/apply { mode, apply } writes changes; emits db/change; queues commit flush and settings backup.

Options UI Highlights
- Views: Videos, Videos Trash, Channels, Channels Trash, Pending (debug).
- Filters editor: AND/OR/NOT linear editor for many predicates; Save as “Preset” (backed by Group). Not all predicates are scrape-checkable.
- Tags sidebar: Tag CRUD, Tag Groups CRUD, assign tags to groups; pickers grouped by Tag Group.
- Top bar: single toggles for List/Grid, Videos/Channels, and Trash; “Refresh DB” (reload local list), “Fetch video data” (videos via API), “Fetch unfetched channels”.
- Stubs indicator: checkbox label shows “X stubs” (total across videos+channels) with a second line “Y in view”.
- Backup/History: Version History modal lists commits with sizes/weights, shows Drive usage, can download a commit, download bundle up to a commit, or delete up to a commit.

Popup Highlights
- Shows current page context (watch/channel/other); “Scrape current page”; toggle “Auto‑capture stubs on watch pages”.
- Tag current video/channel using grouped tag pickers; channel auto-tag helper applies a “.tagged” tag alongside the chosen tag.

Important Invariants
- Background is the only writer to IDB; UI uses read-only transactions and closes DB connections on completion.
- Background message handlers return true to keep async response channels open.
- Storage/type name is Group; UI labels it Preset (keep comments in code and this doc).

Adding Features Safely (playbook)
- New DB fields or stores: update src/background/db.ts, bump DB_VERSION, handle migrations in onupgradeneeded, and reflect here under Storage Model.
- New message/route: add to src/types/messages.ts, implement in src/background/index.ts, and list under Messaging Protocol.
- New predicates: update src/shared/conditions.ts; extend Filters UI; add scrape-time support where needed.
- UI: wire via src/ui/lib/messaging.ts; keep debounced refresh patterns; document user-visible changes here.
- Backup/Restore: update driveBackup.ts/events.ts/restore.ts and document thresholds/flows.

Changelog (concise)
- 2025-09-05
  - Drive backups: encryption/passphrase removed — all snapshots/history stored as plaintext JSON/JSONL. Silent auth by default; “Backup settings” finalizes any pending commit and replays backlog.
  - History downloads: commit and “up to” bundles use UTF‑8 encoding (Unicode‑safe).
  - Options Top Bar: single toggles for List/Grid, Videos/Channels, Trash; removed “Channel trash” and “Select page”; “Refresh” renamed to “Refresh DB”.
  - Stubs indicator: merged into checkbox label showing total across videos+channels and a second line “X in view”.
- 2025-09-01
  - Restore & Apply (dry run/apply) added; pending channels pipeline refined; Drive backlog badge added; history routes and UI extended; selective API-change events logged on refresh.


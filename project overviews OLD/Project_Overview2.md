Updated Project Overview

Purpose: Capture seen YouTube videos/channels locally, enrich via YouTube API, filter/tag/group, and manage via Options UI.
Workflow: Content scrapes → Background persists/enriches → UIs read from IndexedDB and message via chrome.runtime.

Architecture

- Manifest V3: Service worker background, content scripts, options and popup pages.
- Background: `src/background/index.ts` (router, API fetchers, routes, wiring), `src/background/db.ts` (IndexedDB schema/ops, DB_VERSION 11), `src/background/driveBackup.ts` (Google Drive auth + appDataFolder I/O, snapshots, text upsert/delete), `src/background/events.ts` (event/commit logging, JSONL flush, dynamic checkpoints).
- Content: `src/content/index.ts` (message listener, SPA nav, auto-scrape), `src/content/yt-playlist-capture.ts` (seeds/progress), `src/content/yt-watch-stub.ts`, `src/content/yt-watch-progress.ts`, `src/content/yt-navigation.ts`.
- UI: Options `src/ui/options/*` (React) for browsing/filtering/tagging/backups; Popup `src/ui/popup/*` for quick actions.

Auto-Scrape

- Scope: Runs on watch/home/subscriptions/search feeds; disabled on channel pages and all playlist pages (incl. Watch Later).
- Interval + activity gate: Every 2s, only within 10s of recent user interaction (mousemove/scroll/click/key/touch); idle otherwise. File: `src/content/index.ts`.
- Watch pages: Always scrapes the current video; suggested tiles gated by presets.
- Scrape-time matching: A preset participates only if its condition tree is fully checkable in-page. Supported: `sourceAny`, `sourcePlaylistAny`, `channelIdIn`, `titleRegex`, `groupRef` (only if referenced presets are also fully checkable).
- Title + channel matching: Extracts tile title and applies `titleRegex`. `channelIdIn` accepts channel id, handle (with/without @), or displayed name.
- Pending channels: Tiles with only handle/name upsert to `channels_pending`; now gated by accepted presets and deduped per page. Visiting a channel page resolves to channel id. A debug resolver can open handle tabs in batches and auto-close on resolve.

Storage Model (IndexedDB)

- Stores: `videos`, `trash`, `channels`, `channels_trash`, `tags`, `groups`, `rules` (stub), `meta`, `tag_groups`, `channels_pending`, `events_commits`, `events`.
- `tag_groups`: `{ id, name, createdAt }`.
- `channels_pending`: `{ key, name?, handle? }` with keyPath `key` (e.g., `handle:@foo`, `name:Some Name`).
- Groups/Presets: `groups` include `scrape?: boolean` to gate auto-scrape.
- Tags: `TagRec` has `groupId?: string | null` to associate a tag with a Tag Group.
- Video fields: `id`, `title`, `channelId`, `channelName`, `progress`, `flags`, `tags`, `sources`, enrichment fields, `thumbUrl`.
- Channel fields: `id`, `name`, `subs`, `views`, `videos`, `country`, `publishedAt`, `subsHidden`, `tags`, derived `videoTags`, `keywords`/`topics`, `description`, `bannerUrl`, `fetchedAt`, `scrapedAt` counts.
- Derived: `Channel.videoTags` (union of tags across videos); `meta.videoTopics` (distinct topics across videos).

Backups & Version History (Drive)

- Mode: Google Drive `appDataFolder` with OAuth; optional AES-GCM encryption via passphrase.
- Triggers: Automatic backups on most writes (debounced ~3s); daily alarm remains.
- Files: `settings.json` (latest), `snapshots/settings-YYYYMMDD-HHMMSS.json` (dynamic checkpoints), `events-YYYY-MM.jsonl` (event log), `cutoff-*.json` (reattach markers).
- Snapshot content: `tags`, `tagGroups`, `groups` (include `scrape` flag), `videoIndex` (`id`, `tags[]`, `sources[]`, `progressSec`, `channelId`), `channelIndex` (`id`, `tags[]`), `pendingChannels` (`key`, `name?`, `handle?`).
- Dynamic checkpoints: Trigger when processing weight ≥ 10,000 or monthly JSONL size ≥ 20 MB.
- Event logging: `events` and `events_commits` in IDB; monthly JSONL append (by rewrite). Debounced flush (~3s); progress events are not recorded; seen/stub attr logs removed.
- Selective API-change history on refresh: videos diff `title`, `thumbnailUrl` (best), `description`; channels diff `avatarUrl` (best), `bannerUrl`, `description`. Heavy API payloads are not logged.

Messaging Protocol

- Central types: `src/types/messages.ts`. Background switch: `src/background/index.ts`.
- Content → Background: `cache/VIDEO_SEEN`, `cache/VIDEO_STUB`, `cache/VIDEO_PROGRESS`, `cache/VIDEO_PROGRESS_PCT`.
- UI ↔ Background:
  - Videos: `videos/*` (applyTags/delete/restore/refreshAll/stubsCount)
  - Channels: `channels/*` (list/trash/refreshByIds/applyTags/markScraped/upsertStub/delete/restore)
  - Tags: `tags/*`, plus `tags/assignGroup` to set/clear a tag’s `groupId`
  - Tag Groups: `tagGroups/list|create|rename|delete`
  - Topics: `topics/list`
  - Pending channels: `channels/upsertPending { key, name?, handle? }`, `channels/resolvePending { id, name?, handle? }`
  - Pending debug: `channels/pending/list {}` → items; `channels/pending/resolveBatch { limit? }` → `{ opened, remaining }`
  - Groups update: `groups/update` accepts `{ scrape: boolean }` in patch
  - Backup core: `backup/getClientId`, `backup/setClientId`, `backup/saveSettings { passphrase? }`, `backup/restoreSettings { passphrase? }`
  - Drive files: `backup/listFiles`, `backup/downloadFile`
  - History ops: `backup/history/list { limit? }`, `backup/history/getCommit { commitId }`, `backup/history/getUpTo { commitId }`, `backup/history/deleteUpTo { commitId }`, `backup/history/import { files }`, `backup/history/usage`
- Push: `db/change` (entity can be videos, channels, tags, tagGroups, etc.), `refresh/error`, `refresh/done`, `backup/progress`, `backup/done { at }`, `backup/error { message }`.

Options UI

- Views: videos, trash, channels, channels trash; selection and bulk tag ops; pagination, multi-field sorts; inline debug inspector.
- Debug: Pending Channels panel lists `channels_pending` and can open batches of channel tabs to auto-resolve handles to IDs (tabs close automatically).
- Tags sidebar: “Tags” has tabs: Tags and Groups. Each tag row can assign a Tag Group. Tag Groups tab supports CRUD.
- Tag pickers: Apply popovers group tags by Tag Group (+ “Ungrouped”); selection highlighting preserved in bulk.
- Filters editor: Rich predicates with AND/OR/NOT; “Tags (any/all/none)” chips render grouped sections per Tag Group.
- Presets: UI label “Presets” (storage/type still uses Group; groupRef remains storage-level). Each preset shows an “S” toggle (gates auto-scrape). Toggle disabled when the preset contains predicates unsupported at scrape time; tooltip explains.
- Videos list: Channel names clickable (`/channel/<id>`) with muted style and hover accent.
- Stability: DB reads close the IndexedDB connection after each transaction; videos view debounces `db/change` refresh by 200ms.
- Backup section: Sidebar includes “Set Client ID”, “Backup Settings”, and “Version History”. Header shows “Backing up…” during flush; if unsynced commits exist, shows “Drive backlog: N” instead of last backup time.
- Version History modal: Lists commits (time, summary, weight, size), shows Drive usage; expand per commit and resolve IDs to names via IndexedDB; actions: Download commit, Download up to here (Zip), Delete up to here, Reattach (Import). “Full diffs” toggle shows complete text for changed fields; Copy buttons for from/to diffs; “Show all” expands affected names.

Popup UI

- Tagging: Grouped tag dropdowns (by Tag Group + Ungrouped).
- Channel auto-tag: Adding any tag to a channel also applies “.tagged” automatically (idempotent).

YouTube API

- Endpoints: `videos.list`, `channels.list` with retry/backoff and chunking (50 ids).
- Apply results: `applyYouTubeVideo` stores `thumbUrl`; `applyYouTubeChannel` stores `description` and `bannerUrl`; best thumbnails for channels derived; descriptions trimmed.
- API key: `chrome.storage.local.ytApiKey`.

Build & Run

- Build: `npm run build` → `dist/`.
- Dev watch: `npm run watch:bg`, `watch:cs`, `watch:opt`, `watch:pop`.
- Load unpacked: point Chrome to `dist/`. Options at `ui/options/index.html`.

Scraping Notes

- SPA detection: `yt-navigate-finish` and URL polling.
- Tile scanning with dedupe; current watch stub capture; DOM selectors: `src/types/util.ts`.

Filtering & Presets

- Predicates defined/evaluated in `src/shared/conditions.ts`.
- Video: title/desc regex, duration/age/category/visibility/language/isLive/topics/tags/flags/sources, groupRef.
- Channel (and channel-scoped filters on videos via `resolveChannel`): subs/views/videos/country/createdAge/subsHidden/tags.
- Editor mapping: `src/ui/options/lib/filters.ts` maps chip UI ⇄ condition trees; load/save supported.
- Note: UI says “Presets” but storage/types still use Group; `groupRef` remains storage-level.

Dev Tips

- Logging: `src/types/debug.ts` (DEBUG = true) logs navigation, ticker start/idle skips/scan counts/current watch/scraped candidates.
- Caveats: YT SPA timing; DOM selector drift; Shorts progress; ensure API key before refresh; scrape-time predicates only use in-page data.

Changelog (since prior overview)

- Manifest: ensure permissions include "identity" and "alarms".
- Background: added `driveBackup.ts` (OAuth, appDataFolder I/O, snapshots, text file upsert/delete); added `events.ts` (event/commit logging, Drive JSONL flush, dynamic checkpoints); `index.ts` wires backup/history routes, records events around mutating routes, logs `videos/attrChanged` and `channels/attrChanged` during refresh; derives best channel thumbnails; trims descriptions.
- Storage Model: added `events_commits` and `events` stores; `videos` +`thumbUrl`; `channels` +`description`, +`bannerUrl`.
- Messaging: added `backup/getClientId|setClientId|saveSettings|restoreSettings`, `backup/listFiles|downloadFile`, and history routes `backup/history/list|getCommit|getUpTo|deleteUpTo|import|usage`; push `backup/progress|done|error`.
- Options UI: Backup section; header shows backup status/time; “View Backups” replaced by “Version History”; Version History adds full diffs toggle, Copy buttons, resolved names, and improved actions.
- Behavior: Events flush debounced (~3s); progress events not recorded; seen/stub attr logs removed.

Planned / Not Yet Implemented

- Restore & Apply: Apply a Drive snapshot (settings.json or snapshots/*) back into IndexedDB.
  - API: `backup/restore/apply { name|snapshot, mode: 'merge'|'overwrite', apply: { channelTags?, videoTags?, sources?, progress? } }`, plus `backup/restore/dryRun` for a change summary.
  - Modes: Merge (upsert/merge) vs Overwrite (clear then replace registries).
  - Data: tags, tagGroups, groups (incl. scrape); per-channel tags; per-video tags/sources/progress; pendingChannels.
  - Edge cases: tag rename dedupe, group ID collisions (preserve/create + remap), version mismatch (enforce version:1).
- Revert To Here (time travel): Event-sourced replay to a target `commitId` (reverse via `inverse`, forward via `payload`).
  - API: `backup/history/revertTo { commitId, dryRun? }`.
  - Notes: batch in chunks, per-commit transactions, rollback on error, require continuous chain.
- Direct Zip Import: Accept a Zip from “Download up to here” and reattach in one step.
  - API: `backup/history/importZip { contentB64 }` → unzip → feed existing import path.
  - Validation: must include cutoff marker matching Drive `cutoff.json`; merge snapshots and month logs; remove cutoff on success.
- History Filters (UI only): Kind checkboxes (tags/groups/channelTags, videos/channels CRUD, attrChanged), text search, expand/collapse all; persist via `chrome.storage.local`.
- Cutoff Indicator: Show current cutoff commit in History header; optional clear button.
  - API: `backup/history/cutoff` → `{ id, ts } | null`.
- Trim Header Rewrite (JSONL cosmetic): After “Delete up to here”, rewrite month header to new first kept commit/ts.
- My Drive Backups (visible folder): Optional mode using Drive `drive.file` scope to store in a visible “YT Recommender Backups” folder; switchable setting.
- Local Export/Restore (no OAuth): Export snapshot/history to files; restore locally using same apply logic.

Files (for reference)

- `src/background/driveBackup.ts`
- `src/background/events.ts`
- `src/background/index.ts`
- `src/background/db.ts` (DB_VERSION 11)
- `src/ui/options/components/HistoryModal.tsx`
- `src/ui/options/components/Sidebar.tsx`
- `src/ui/options/App.tsx`
 
Patch Notes (2025-09-01)

- Restore & Apply:
  - Background: added `src/background/restore.ts` with `dryRunRestoreApply` and `applyRestore` (merge/overwrite modes; tags/tagGroups/groups, channel/video tags/sources/progress, pending channels; version=1 enforced).
  - Routes: `backup/restore/dryRun` and `backup/restore/apply` wired in `src/background/index.ts`.
  - Types: message union extended in `src/types/messages.ts`.
  - Drive helper: `downloadSnapshotByName(name,{ passphrase? })` in `src/background/driveBackup.ts`.

- Pending Channels (noise fix + tools):
  - Content: pending upserts now gated by accepted presets; per-page dedupe to avoid repeated upserts; normalized handle → key `handle:@foo`; reset dedupe on SPA navigation. File: `src/content/index.ts`.
  - DB: `upsertPendingChannel` normalizes handle and returns `changed:boolean`; avoids rewriting identical rows. File: `src/background/db.ts`.
  - Events: background records `pending/upsert` only when row changed. File: `src/background/index.ts`.
  - New routes: `channels/pending/list`, `channels/pending/resolveBatch { limit? }` (opens background tabs for handles; auto-closes after resolve/timeout). Files: `src/background/db.ts`, `src/background/index.ts`.
  - UI: “Pending (debug)” view lists `channels_pending` and can resolve handles in batches. File: `src/ui/options/components/PendingPanel.tsx`, `src/ui/options/App.tsx`.

- Drive OAuth & backups (no random prompts):
  - `getAccessToken(interactive=false)` with silent auth by default; UI ops pass `interactive:true` as needed. Prompt now `select_account` (not `consent`). File: `src/background/driveBackup.ts`.
  - Background Drive calls (events JSONL, snapshots) use `interactive:false`. Files: `src/background/events.ts`, `src/background/index.ts`.
  - `queueSettingsBackup` attempts silent save; on auth failure, pushes `backup/error` without prompting.

- Backlog replay (missed uploads):
  - Track unsynced commits in `chrome.storage.local['drive.unsyncedCommitIds']` when Drive append fails. File: `src/background/events.ts`.
  - `replayUnsyncedCommitsToDrive()` replays queued commits (ordered by ts) on next cycles; `scheduleBackup()` invokes it. File: `src/background/index.ts`.
  - UI header shows “Drive backlog: N” badge when unsynced > 0; otherwise shows last backup time. File: `src/ui/options/App.tsx`.

- Messaging Protocol additions:
  - Restore: `backup/restore/dryRun`, `backup/restore/apply`.
  - Pending debug: `channels/pending/list`, `channels/pending/resolveBatch { limit? }`.

- Other:
  - Overview updated: Pending channels are gated/deduped; Options header indicates Drive backlog when present; Debug panel described.

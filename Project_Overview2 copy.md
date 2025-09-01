Here's an Overview to understand my project, tell me when you have a sufficient understanding to implement a new feature. Also with each feature added or change made later, each time tell me surgically what I need to add/replace/remove about my project overview. I added patch notes way at the bottom, synthesize them into my existing project overview to create a new one.
Updated Project Overview

Purpose: Capture seen YouTube videos/channels locally, enrich via YouTube API, filter/tag/group, and manage via Options UI.
Workflow: Content scrapes → Background persists/enriches → UIs read from IndexedDB and message via chrome.runtime.
Architecture

Manifest V3: Service worker background, content scripts, options and popup pages.
Background: src/background/index.ts (router, API fetchers), src/background/db.ts (IndexedDB schema/ops).
Content: src/content/index.ts (message listener, SPA nav, auto‑scrape), yt-playlist-capture.ts (seeds/progress), yt-watch-stub.ts, yt-watch-progress.ts, yt-navigation.ts.
UI: Options src/ui/options/* (React) for browsing/filtering/tagging; Popup src/ui/popup/* for quick actions.
Auto‑Scrape

Scope: Runs on watch/home/subscriptions/search feeds; disabled on channel pages and on all playlist pages (incl. Watch Later).
Interval + activity gate: Every 2s, only within 10s of recent user interaction (mousemove/scroll/click/key/touch); idle otherwise. File: src/content/index.ts.
Watch pages: Always scrapes the current video; suggested tiles gated by presets.
Scrape‑time matching: A preset participates only if its condition tree is fully checkable in‑page. Supported: sourceAny, sourcePlaylistAny, channelIdIn, titleRegex, groupRef (only if referenced presets are also fully checkable).
Title + channel matching: Extracts tile title and applies titleRegex. channelIdIn accepts channel id, handle (with/without @), or displayed name.
Pending channels: Tiles with only handle/name upsert to channels_pending; visiting a channel page resolves to channel id.
Storage Model (IndexedDB)

Stores: videos, trash, channels, channels_trash, tags, groups, rules(stub), meta, tag_groups, channels_pending.
tag_groups: { id, name, createdAt }.
channels_pending: { key, name?, handle? } with keyPath key (e.g., handle:@foo, name:Some Name).
Groups/Presets: groups records include scrape?: boolean to gate auto‑scrape.
Tags: TagRec has groupId?: string | null to associate a tag with a Tag Group.
Video fields: id/title/channelId/channelName, progress, flags, tags, sources, enrichment fields.
Channel fields: id/name/subs/views/videos/country/publishedAt/subsHidden, tags, derived videoTags, keywords/topics, fetchedAt, scrapedAt counts.
Derived: Channel.videoTags (union of tags across videos); meta.videoTopics (distinct topics across videos).
Messaging Protocol

Central types: src/types/messages.ts. Background switch: src/background/index.ts.
Content → Background: cache/VIDEO_SEEN, cache/VIDEO_STUB, cache/VIDEO_PROGRESS, cache/VIDEO_PROGRESS_PCT.
UI ↔ Background:
Videos: videos/* (applyTags/delete/restore/refreshAll/stubsCount)
Channels: channels/* (list/trash/refreshByIds/applyTags/markScraped/upsertStub/delete/restore)
Tags: tags/*, plus tags/assignGroup to set/clear a tag’s groupId
Tag Groups: tagGroups/list|create|rename|delete
Topics: topics/list
Pending channels: channels/upsertPending { key, name?, handle? }, channels/resolvePending { id, name?, handle? }
Groups update: groups/update accepts { scrape: boolean } in patch
Push notifications: db/change (entity can be videos, channels, tags, tagGroups, etc.), refresh/error, refresh/done.
Options UI

Views: videos, trash, channels, channels trash; selection and bulk tag ops; pagination, multi‑field sorts; inline debug inspector.
Tags sidebar: “Tags” section has tabs: Tags and Groups. Each tag row has a dropdown to assign it to a Tag Group. Tag Groups tab supports CRUD.
Tag pickers: Tag apply popovers group tags by Tag Group (+ “Ungrouped”); selection highlighting preserved in bulk.
Filters editor: Rich predicates with AND/OR/NOT; “Tags (any/all/none)” chips render grouped sections per Tag Group.
Presets: UI label “Presets” (storage/type still uses Group; permanent code comment clarifies and should remain). Each preset shows an “S” toggle (gates auto‑scrape). Toggle is disabled when the preset contains predicates unsupported at scrape time; tooltip explains.
Videos list: Channel names are clickable (/channel/<id>) with muted style and hover accent.
Stability: DB reads close the IndexedDB connection after each transaction; videos view debounces db/change refresh by 200ms.
Popup UI

Tagging: Grouped tag dropdowns (by Tag Group + Ungrouped).
Channel auto‑tag: Adding any tag to a channel also applies “.tagged” automatically (idempotent).
YouTube API

Endpoints: videos.list, channels.list with retry/backoff and chunking (50 ids).
Apply results: applyYouTubeVideo, applyYouTubeChannel.
API key: chrome.storage.local.ytApiKey.
Build & Run

Build: npm run build → dist/.
Dev watch: npm run watch:bg, watch:cs, watch:opt, watch:pop.
Load unpacked: point Chrome to dist/. Options at ui/options/index.html.
Scraping Notes

SPA detection: yt-navigate-finish and URL polling.
Tile scanning with dedupe; current watch stub capture; DOM selectors: src/types/util.ts.
Filtering & Presets

Predicates defined/evaluated in src/shared/conditions.ts.
Video: title/desc regex, duration/age/category/visibility/language/isLive/topics/tags/flags/sources, groupRef.
Channel (and channel‑scoped filters on videos via resolveChannel): subs/views/videos/country/createdAge/subsHidden/tags.
Editor mapping: src/ui/options/lib/filters.ts maps chip UI ⇄ condition trees; load/save supported.
Note: UI says “Presets” but storage/types still use Group; groupRef remains storage‑level.
Dev Tips

Logging: src/types/debug.ts (DEBUG = true) logs navigation, ticker start/idle skips/scan counts/current watch/scraped candidates.
Caveats: YT SPA timing; DOM selector drift; Shorts progress; ensure API key before refresh; scrape‑time predicates only use in‑page data.
What changed in this update (surgical):

Added Auto‑Scrape section with scope, interval/activity gate, scrape‑time matching, and exclusions.
Storage: added tag_groups, channels_pending, scrape?: boolean on groups, and groupId on TagRec.
Messaging: added tagGroups/*, tags/assignGroup, channels/upsertPending|resolvePending, groups/update with scrape.
Options UI: Tags sidebar tabs and Tag Group assignment; grouped tag pickers; “Groups” label → “Presets” in UI; “S” toggle with disabled state hint; clickable channel links; stability notes (IDB close, debounce).
Popup UI: grouped tags and .tagged auto‑tag on channel tag add.

Patch notes:

Manifest: add “identity” and “alarms” to permissions.
Architecture → Background: add src/background/driveBackup.ts (Google Drive backup: OAuth, encryption, appDataFolder upload, daily alarm).
Messaging Protocol: add
backup/getClientId, backup/setClientId
backup/saveSettings { passphrase? }
backup/restoreSettings { passphrase? } → snapshot (fetch-only)
Options UI: add “Backup” section in sidebar: set Client ID; “Backup Settings” button; optional passphrase prompt for encryption.
YouTube API: unchanged.
Build & Run: unchanged.

--

Manifest: add “identity”, “alarms” to permissions (done).
Messaging Protocol: add backup/getClientId, backup/setClientId, backup/saveSettings { passphrase? }, backup/restoreSettings { passphrase? }.
Options UI: “Backup” section to set Client ID and trigger backup.
Background: src/background/driveBackup.ts handles OAuth, appDataFolder uploads, optional AES‑GCM, daily alarm.


--
Messaging Protocol: add
backup/listFiles → { items: [{ id, name, size?, modifiedTime?, createdTime? }] }
backup/downloadFile { id } → { contentB64, name?, mimeType? }
Options UI: Backup section now includes “View Backups” modal to list and download files.
Background: src/background/driveBackup.ts now exposes file listing and download helpers for appDataFolder.


--

Messaging Protocol
Push events: backup/progress, backup/done { at }, backup/error { message }.
Existing backup routes unchanged (backup/getClientId|setClientId|saveSettings|restoreSettings, listFiles, downloadFile).
Background
driveBackup.ts builds expanded SettingsSnapshot (tags, tagGroups, groups, videoIndex, channelIndex, pendingChannels).
Automatic backups: scheduled on most write operations with a 3s debounce; daily alarm remains.
Options UI
Header now shows backup status/time next to last refresh time.
Backup modal unchanged functionally (still lists and downloads appDataFolder files).
Snapshot Content (Drive)
videoIndex: id, tags[], sources[], progressSec (sec or derived from pct/duration), channelId.
channelIndex: id, tags[].
pendingChannels: key, name?, handle?.
--

Storage Model (IndexedDB)
Added events_commits: { commitId, ts, summary, weight, size, counts }
Added events: { id, commitId, ts, kind, payload, inverse?, impact?, size }
Messaging Protocol
backup/history/list { limit? } → { commits: [commit] }
backup/history/getCommit { commitId } → { contentB64, name, mimeType }
backup/history/usage {} → { totalBytes, files }
Background
src/background/events.ts: records events → commits, persists to IDB, flushes to Drive JSONL, triggers dynamic snapshots via thresholds (10k weight or 20 MB per month file).
src/background/driveBackup.ts: added upsertAppDataTextFile(name, text), saveSnapshotWithName(name, snapshot), getCurrentSettingsSnapshot().
src/background/index.ts: wraps all major mutating routes with event recording and calls finalize+backup on debounce.
Options UI
Backup section: “Version History” button opens a modal listing commits (time, summary, weight, size), with “Download commit” and drive usage summary.
--

Messaging Protocol
backup/history/list { limit? } → { commits }
backup/history/getCommit { commitId } → { contentB64, name, mimeType }
backup/history/getUpTo { commitId } → { files: [{ name, contentB64 }] } (used to build the zip client‑side)
backup/history/deleteUpTo { commitId } → { deleted }
backup/history/usage {} → { totalBytes, files }
Background
src/background/events.ts: Event/Commit IDB, commit finalize/flush, Drive JSONL append, dynamic snapshot thresholds.
src/background/driveBackup.ts: upsertAppDataTextFile(name,text), deleteAppDataFile(id), saveSnapshotWithName(name, snapshot), getCurrentSettingsSnapshot().
src/background/index.ts: Records events on mutating routes; adds history routes for list/download/downloadUpTo/deleteUpTo/usage; cuts month logs; writes cutoff markers.
Options UI
src/ui/options/components/HistoryModal.tsx: Commit list, sizes/weights, Drive usage, buttons: Download commit / Download up to here (zip) / Delete up to here.
src/ui/options/components/Sidebar.tsx: “Version History” button.

--
Background
src/background/index.ts: logs videos/attrChanged and channels/attrChanged during refresh if fields changed; derives best thumbnails for channels; trims descriptions.
src/background/db.ts: channel rows now store description and bannerUrl.
UI
src/ui/options/components/HistoryModal.tsx: expand per commit, resolve IDs to names via IndexedDB, plus “Download up to here” and “Delete up to here”.
Drive helpers
src/background/driveBackup.ts: added upsertAppDataTextFile(name,text) and deleteAppDataFile(id) for log management and cutoff markers.
--

Background: applyYouTubeVideo now stores video thumbUrl; applyYouTubeChannel stores description and bannerUrl.
Version History:
Selective API-change events recorded:
videos: title, thumbnailUrl, description
channels: avatarUrl, bannerUrl, description
Dynamic checkpoints by processing weight (10k) or monthly JSONL size (20 MB).
History UI shows commit weight and size; can download a single commit, download all up to a commit as Zip, or delete up to a commit (writes a cutoff marker).
Options UI: “View Backups” replaced by “Version History”.
--

Storage Model
Video row adds thumbUrl.
Channel row adds description and bannerUrl.
History/Event System
API-change events recorded:
videos: title, thumbnailUrl, description
channels: avatarUrl (best thumb), bannerUrl, description
Import route stitches earlier logs and snapshots; validates against Drive cutoff marker.
Options UI
Version History modal: adds Reattach (Import), details with resolved names, and improved actions.
--

Storage Model
videos: +thumbUrl
channels: +description, +bannerUrl
Messaging Protocol
backup/history/import { files: [{ name, contentB64 }] } → merges if cutoff matches
Options UI
Version History: Details with “Show all”, inline diffs, Reattach (Import)

--

Full diffs toggle

New “Full diffs” checkbox in the Version History modal header.
When enabled, shows complete text for changed fields (titles/descriptions/URLs) instead of truncated previews.
Copy buttons for diffs

Each changed field now has “Copy” buttons next to the from/to values for quick clipboard copy.
Details list improvements

“Show all” toggle per event expands the full list of affected names/IDs (defaults to first 10).
Name resolution uses local IndexedDB to display video titles or channel names when available.
Files touched

src/ui/options/components/HistoryModal.tsx
Added state fullDiffs and UI toggle.
Added Copy buttons and helper to write to clipboard.
Adjusted details rendering to use full diffs when toggled.
--

Files: settings.json (latest), snapshots/settings-YYYYMMDD-HHMMSS.json (dynamic checkpoints), events-YYYY-MM.jsonl (JSONL log), cutoff-*.json (reattach markers).
Dynamic checkpoints: Triggers when processing weight ≥ 10,000 or month log ≥ 20 MB.
Version History UI: Lists commits with time, summary, weight, size; expand for details with names and inline diffs; actions: Download commit, Download up to here (Zip), Delete up to here, Reattach (Import).
Storage usage: Shows total Drive appDataFolder size and file count.
Storage Model (IndexedDB)

New stores: events_commits { commitId, ts, summary, weight, size, counts }, events { id, commitId, ts, kind, payload, inverse?, impact?, size }.
Channels: +description, +bannerUrl for diffing.
Videos: +thumbUrl (best thumbnail) for diffing.
Messaging Protocol

Backup core: backup/saveSettings, backup/getClientId, backup/setClientId, backup/restoreSettings.
Drive files: backup/listFiles, backup/downloadFile.
History ops:
backup/history/list { limit? } → { commits }
backup/history/getCommit { commitId } → { contentB64, name, mimeType }
backup/history/getUpTo { commitId } → { files: [{ name, contentB64 }] }
backup/history/deleteUpTo { commitId } → { deleted }
backup/history/import { files: [{ name, contentB64 }] } → { ok }
backup/history/usage → { totalBytes, files }
Push events: backup/progress, backup/done { at }, backup/error { message }.
Background

Files: src/background/driveBackup.ts (OAuth, appDataFolder I/O, snapshots, text file upsert/delete), src/background/events.ts (event/commit logging, Drive JSONL flush, dynamic checkpoint), src/background/index.ts (routes, wiring).
Auto‑backup: Schedules (debounced ~3s) after most writes (videos/channels/tags/groups/pending, refresh finalization).
JSONL flush: Appends commit to events-YYYY-MM.jsonl (by rewrite); checkpoints saved under snapshots/.
Reattach: Validates imported history against Drive cutoff marker, merges month logs, upserts snapshots, removes cutoff.
Selective API Change History

On refresh:
Videos: logs videos/attrChanged for title, thumbnailUrl, description diffs.
Channels: logs channels/attrChanged for avatarUrl (best thumb), bannerUrl, description diffs.
Heavy API payloads are not logged; only diffs of selected fields.
Options UI

Backup section: “Set Client ID”, “Backup Settings”, “Version History”.
Header: shows “Backing up…” during flush and last backup time.
History modal: commit list with weight/size; expand to see names; Full diffs toggle; Copy buttons for from/to; actions: download commit, download up to here (Zip), delete up to here, reattach (import).
Manifest

Permissions: ensure "identity" and "alarms" are present (already added).
Files (for reference)

src/background/driveBackup.ts
src/background/events.ts
src/background/index.ts
src/background/db.ts (DB_VERSION 11, new stores, added fields)
src/ui/options/components/HistoryModal.tsx
src/ui/options/components/Sidebar.tsx
src/ui/options/App.tsx
--


Background: events now flush on a 3s debounce; progress events are not recorded; seen/stub attr logs removed.
UI: unchanged; commit list should settle down.

--
supposed features left to be implemented: 

Restore & Apply

Scope: Apply a selected Drive snapshot (settings.json or snapshots/settings-*.json) back into IndexedDB.
Modes:
Merge: upsert tags, tagGroups, groups; update associations; do not drop unknown local items.
Overwrite: replace registries (tags/tagGroups/groups) entirely; clear affected stores first.
Data applied:
tags, tagGroups, groups (presets, including scrape flag)
channelIndex (per-channel tags): upsert channel rows if not present; merge/overwrite tags by mode
videoIndex (per-video tags/sources/progressSec): apply tags; optionally sources/progressSec if enabled
pendingChannels: upsert
API:
backup/restore/apply { name | snapshot, mode: 'merge'|'overwrite', apply: { channelTags?: boolean, videoTags?: boolean, sources?: boolean, progress?: boolean } }
backup/restore/dryRun to return a change summary before applying
UI:
Version History → select snapshot → “Restore & Apply” with mode toggles + dry-run preview
Edge cases:
Tag rename conflicts: recommend Merge+dedupe; Overwrite clears and applies
Group ID collisions: preserve IDs; if mismatch, generate new ID and update references
Version mismatch: enforce version:1; otherwise block with message
Revert To Here (time travel)

Approach: Event-sourced replay between current head and a target commitId.
Forward/backward:
Backwards: walk commits > target in reverse and apply each event.inverse (must exist/reconstructable)
Forwards: walk commits from first after target up to head and apply event.payload
Supported events (reversible): videos/channels applyTags, delete/restore, tag CRUD, tagGroup CRUD, group CRUD, pending upsert/resolve, markScraped (restore prior scrapedAt/scraped counts), wipeSources (requires per-video before snapshot)
Excluded from reversible set: bulk API refreshes (non-deterministic); we already log attrChanged separately for audit
API:
backup/history/revertTo { commitId, dryRun?: boolean } → { summary } or applies
Implementation notes:
Batch in chunks; wrap per-commit in IDB transactions; fail-safe rollback on error
Validate continuous commit chain (no gaps due to trims); otherwise block and suggest restoring from a snapshot
Direct Zip Import (single file)

Goal: Accept a Zip bundle (produced by “Download up to here”) and reattach in one step.
Parser:
Current code can “build” Zip; to “read” Zip we need a tiny unzip. Options:
Embed a minimal unzip reader (no network); parse central directory + entries
Or accept multiple file selection (already supported) and keep Zip for convenience later
Validation:
Must include a cutoff marker (or an events-YYYY-MM-upTo-<cid>.jsonl) that matches Drive’s current cutoff.json
Process:
Upsert snapshots/* and events-YYYY-MM.jsonl (merge imported “up to” part with existing “after” part)
Remove cutoff.json on success
API: backup/history/importZip { contentB64 } → unpack + feed into existing import path
History Filters

Filters:
Kind filters: tags/groups/channelTags, videos/channels CRUD, attrChanged (toggle to hide)
Text filter: matches names/IDs inside events and summaries
“Expand all” / “Collapse all” for details
Behavior:
All client-side; fetch commit, then filter events for display
Persist filter settings in chrome.storage.local to keep user prefs
UI:
Controls in Version History header (checkboxes + search input); counts update live
Cutoff Indicator

Display: Show current cutoff commit (from cutoff.json) in the History header:
“History starts at commit <shortId> (YYYY‑MM‑DD HH
)”
Actions:
Optional “Clear cutoff marker” (for diagnostics) if no local history needs reattach
Implementation:
Background route backup/history/cutoff → reads cutoff.json (id, ts), or null
UI fetches and displays on open/refresh
Trim Header Rewrite (JSONL cosmetic)

Context: After “Delete up to here”, month JSONL header still shows original firstCommitId/Ts.
Change: Rewrite the header line to reflect the new first kept commit (peek next line with commitId, set firstCommitId, firstCommitTs accordingly).
Process:
During month file rewrite, compute first kept event’s ts/commitId and emit updated header line before appending remaining events
My Drive Backups (visible folder)

Scope: Store backups in a visible My Drive folder (vs appDataFolder) to browse in drive.google.com.
Permissions:
Requires https://www.googleapis.com/auth/drive.file scope; user re-consent; Google verification may be required for wide distribution
Behavior:
Create/find folder “YT Recommender Backups”
Store settings.json, snapshots, and events JSONL under that folder; preserve current appDataFolder mode as default
Option to switch between modes (appData vs My Drive) in Settings
Impact:
Version History UI can still operate (different listing path)
Larger files visible; user can manage retention directly in Drive
Local Export/Restore (no OAuth)

Export:
Buttons in History modal: Export settings snapshot (download JSON); Export history (download selected month’s JSONL or all into a Zip)
Restore:
Apply locally without Drive: user chooses snapshot JSON; background apply merges/overwrites (same logic as Restore & Apply)
Benefits:
No Google account dependency for backup/restore on a single machine; quick manual backups
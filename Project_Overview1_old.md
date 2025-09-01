Here's an Overview to understand my project, tell me when you have a sufficient understanding to implement a new feature. Also with each feature added or change made later, each time tell me surgically what has to be changed about my project overview below:

Chrome extension that captures YouTube videos/channels you see and stores them locally for filtering and tagging.
Content script scrapes IDs and progress from YouTube pages; background handles storage and API enrichment; Options page provides powerful filtering, tagging, grouping, and channel views; Popup offers quick actions.
How It Works

Content → Background:
Scrape playlist/channel/watch pages and send seeds/stubs: cache/VIDEO_SEEN, cache/VIDEO_STUB (src/content/yt-playlist-capture.ts
).
Track watch progress continuously and from tiles/player: cache/VIDEO_PROGRESS and % variant (src/content/yt-watch-progress.ts
).
SPA detection to re-run on navigation (src/content/yt-navigation.ts
).
Background service worker:
Persists/upserts videos, tags, channels; trash/restore; group CRUD; computes derived channel.videoTags, topics meta (src/background/index.ts
).
Fetches full metadata via YouTube Data API v3 (Videos/Channels list) with local ytApiKey and applies to rows (src/background/index.ts
).
Maintains channels (stub upsert, refresh, mark scraped counts/timestamps) (src/background/db.ts
).
Options UI (React):
Lists videos/channels with selection, bulk tag apply/remove, delete/restore, pagination and multi-field sorts (src/ui/options/App.tsx
).
Rich filter editor (duration, age, title regex, sources, flags, video tags, topics, categories, visibility, language, channel properties and tags), AND/OR/NOT chaining (src/ui/options/components/FiltersBar.tsx
, src/ui/options/lib/filters.ts
).
Groups: save/load filter sets; evaluate recursively in filters (src/shared/conditions.ts
).
Derived tag/topic/source option lists reflect current filtered results (src/ui/options/App.tsx
).
Channel directory and trash views with tags and videoTags rollups (src/ui/options/App.tsx
).
Popup UI:
“Scrape current page” triggers content scrape; shows current page context; quick add/remove tags for current video/channel; toggle “Auto capture stubs on watch pages” (src/ui/popup/index.tsx
).
Storage Model (IndexedDB)

Object stores: videos, trash, tags, groups, rules (stub), channels, channels_trash, meta (src/background/db.ts
).
Video fields include progress, flags, tags, sources, and optional YouTube payload-derived fields (src/shared/conditions.ts
).
Channel fields include subscribers/views/videos/country/keywords/topics, tags/videoTags, scrapedAt per-tab counts (src/shared/conditions.ts
, src/background/db.ts
).
Derived:
Channel.videoTags = union of tags across videos (src/background/db.ts
).
Meta.videoTopics = distinct topics across videos (src/background/db.ts
).
APIs & Messages

Message types centralized (src/types/messages.ts
). Background switches on raw.type and responds with {ok} and data where relevant (src/background/index.ts
).
YouTube API fetchers with retry/backoff for videos.list and channels.list (src/background/index.ts
).
Build/Load

Build all bundles and copy pages: npm run build (package.json
).
Load unpacked from dist in Chrome; options page at ui/options/index.html (manifest.json
).

Detailed Project overview (improved for pasting into codex chats):

Project Overview

Purpose: Capture seen YouTube videos/channels locally, enrich via YouTube API, filter/group/tag, and manage via Options UI.
Workflow: Content script scrapes → Background persists/enriches → UIs read via IndexedDB and communicate via chrome.runtime messages.
Architecture

Manifest V3: Service worker background, content scripts, options and popup pages.
Background: src/background/index.ts (message router, API fetchers), src/background/db.ts (IndexedDB schema + ops).
Content: src/content/index.ts (message listener, SPA nav), yt-playlist-capture.ts (scrape seeds, progress), yt-watch-stub.ts (watch page stub capture), yt-watch-progress.ts (interval progress tracking), yt-navigation.ts (SPA detection).
UI: Options src/ui/options/* (React) for browsing, filtering, tagging; Popup src/ui/popup/* for quick actions.
Build & Run

Build: npm run build → outputs to dist/.
Dev watch: npm run watch:bg, watch:cs, watch:opt, watch:pop.
Load unpacked: point Chrome to dist/.
API key: stored in chrome.storage.local.ytApiKey. Options UI prompts on refresh.
Data Model (IndexedDB)

Stores: videos, trash, channels, channels_trash, tags, groups, rules(stub), meta.
Video fields (subset): id, title, channelId, channelName, durationSec, uploadedAt, fetchedAt, ytTags, description, categoryId, visibility, languageCode, isLive, videoTopics, flags.started|completed, progress.{sec|duration|pct}, sources[{type,id}], yt raw.
Channel fields (subset): id, name, subs, views, videos, country, publishedAt, subsHidden, tags[] (local), videoTags[] (derived from videos), keywords, topics[], fetchedAt, thumbnails, scrapedAt* and per‑tab counts.
Derived jobs: channel videoTags rollup, meta.videoTopics aggregation.
Messaging Protocol

Types centralized in src/types/messages.ts. Core ones:
Content → Background: cache/VIDEO_SEEN, cache/VIDEO_STUB, cache/VIDEO_PROGRESS, cache/VIDEO_PROGRESS_PCT.
UI ↔ Background: videos/* (applyTags/delete/restore/refreshAll/stubsCount), channels/* (list/trash/refreshByIds/applyTags/markScraped/upsertStub/delete/restore), tags/*, groups/*, topics/list.
Push notifications: db/change, refresh/error, refresh/done.
Background handler: switch in src/background/index.ts.
YouTube API

Endpoints: videos.list, channels.list with retries/backoff and chunking (50 ids).
Where: fetchVideosListWithRetry, fetchChannelsListWithRetry (in background).
Apply results: applyYouTubeVideo, applyYouTubeChannel normalize and persist.
API key storage: chrome.storage.local.ytApiKey.
Scraping Notes

SPA detection: yt-navigate-finish and URL polling.
Watch stubs and continuous progress capture; channel/playlist tile scanning with dedupe.
DOM selectors centralized in src/types/util.ts → update if YT DOM changes.
Filtering & Groups

Predicates defined and evaluated in src/shared/conditions.ts:
Video: title/desc regex, duration/age/category/visibility/language/isLive/topics/tags/flags/sources, groupRef.
Channel on channels, and channel‑scoped filters on videos via resolveChannel: subs/views/videos/country/createdAge/subsHidden/tags.
UI editor model: src/ui/options/lib/filters.ts maps chip UI ⇄ Condition trees; AND/OR/NOT supported; groupRef supported; simple reverse mapping for load.
Options UI Features

Views: videos, trash, channels, channels trash; selection and bulk tag ops; pagination and multi‑field sorts; inline debug inspector.
Tag management: create/rename/delete; one‑time import of channel tag mappings from JSON.
Common Tasks (Where To Change)

Add a new filter predicate:
Define/evaluate in src/shared/conditions.ts.
Extend editor types and mappings in src/ui/options/lib/filters.ts.
Add chip UI in src/ui/options/components/FiltersBar.tsx.
Add a new video/channel field:
Write during merge/apply in src/background/db.ts (video: merge/applyYouTubeFields; channel: applyYouTubeChannel).
Project into UI slim models in src/ui/options/App.tsx and render where needed.
Add a new message/action:
Add type in src/types/messages.ts.
Handle in src/background/index.ts; wire to DB in src/background/db.ts if needed.
Call from UI via src/ui/lib/messaging.ts.
Add a new scrape source:
Update src/content/yt-playlist-capture.ts and/or watch stub/progress files; ensure seeds use sources[{type,id}].
Permissions

Manifest: "storage", "tabs", host permissions "https://www.youtube.com/*", "https://www.googleapis.com/*".
Dev Tips

Logs controlled in src/types/debug.ts (DEBUG = true).
Stubs vs enriched: “stubsOnly” toggle in UI helps verify pre‑fetch state.
Known caveats: YT SPA timing; DOM selector drift; progress for Shorts; ensure API key before refresh.


Patch notes to integrate:

patch 1:

Storage Model

Tag groups: add a new store “tag_groups” with { id, name, createdAt }. Reference: src/background/db.ts:1
Tags: note optional groupId on tag records. Reference: src/types/messages.ts:1, src/background/db.ts:1
Messaging Protocol

New tag-group messages: tagGroups/list|create|rename|delete. Reference: src/types/messages.ts:1, src/background/index.ts:1
New tag assignment message: tags/assignGroup to set/clear a tag’s groupId. Reference: src/types/messages.ts:1, src/background/index.ts:1
Push events: db/change.entity can now be tagGroups. Reference: src/types/messages.ts:1, src/background/index.ts:1
Options UI

Sidebar: “Tags” section now has tabs: Tags and Groups. Reference: src/ui/options/components/Sidebar.tsx:1
Tag row: each tag shows a dropdown to assign it to a Tag Group. Reference: src/ui/options/components/Sidebar.tsx:1
Tag Groups tab: CRUD for tag groups (create/rename/delete). Reference: src/ui/options/components/Sidebar.tsx:1, src/ui/options/App.tsx:1
Tag apply popover: tags are presented in grouped dropdowns (one per Tag Group + Ungrouped), with “all-selected have it” highlighting preserved. Reference: src/ui/options/App.tsx:1
Popup UI

Tagging controls: presented as grouped dropdowns (one per Tag Group + Ungrouped). Reference: src/ui/popup/index.tsx:1
Auto-tag on channel tag add: when adding any tag to a channel, the popup also applies the “.tagged” tag automatically (idempotent). Reference: src/ui/popup/index.tsx:1
Data Types

TagRec: now includes groupId?: string | null. Reference: src/types/messages.ts:1
Add TagGroupRec type for UI. Reference: src/types/messages.ts:1

Terminology (clarification)

Distinguish “Groups” (saved filter sets used in filtering) from “Tag Groups” (organizational buckets for tags). The former stays as-is; the latter is new and appears in the Tags sidebar and tag UIs.

patch 2:

Tag filters UI: Video and Channel “Tags (any/all/none)” chips now render grouped sections per Tag Group (plus Ungrouped) with checkboxes; counts preserved; logic unchanged. References: src/ui/options/components/FiltersBar.tsx, src/ui/options/App.tsx:passes tagsRegistry/tagGroups.

patch 3:

Terminology

Presets: “Groups” are now called “Presets” in the UI; code and storage still use Group. A permanent comment clarifies this and must not be removed. References:
src/shared/conditions.ts:1
src/ui/options/components/FiltersBar.tsx:1
src/ui/options/components/Sidebar.tsx:1
Storage Model

Presets (groups): add scrape?: boolean to preset records to gate auto-scraping. References:
src/shared/conditions.ts:1
src/background/db.ts:1
Pending channels: new store channels_pending with keyPath key (e.g., handle:@foo or name:Some Name) to hold handle/name-only discoveries until resolved. References:
src/background/db.ts:1
Messaging Protocol

Pending channels:
channels/upsertPending payload { key, name?, handle? }
channels/resolvePending payload { id, name?, handle? }
Presets update: groups/update now accepts { scrape: boolean } in patch.
References:
src/types/messages.ts:1
src/background/index.ts:1
Content (Auto‑Scrape)

Universal auto-scrape: runs every ~1s on all YouTube pages (home, subscriptions, search, watch, channel, playlists).
Preset-gated: only scrapes videos that match at least one preset with scrape enabled. Unknown-at-scrape-time fields are ignored.
Watch pages:
Always scrapes the current video (source WatchPage) regardless of presets.
Scans suggested videos and applies preset gating.
Pending channels:
From tiles, if only @handle/name is present, upserts channels_pending.
On channel pages, resolves channelId and merges/deletes the pending entry.
References:
src/content/index.ts:1
src/content/yt-playlist-capture.ts:1
src/types/util.ts:1
Options UI

Presets section:
Sidebar “Groups” → “Presets” (UI label change).
“S” toggle per preset controls its scrape flag; includes pressed-state styling.
Filters bar:
“Group” input/labels now read “Preset” (save as preset, preset selector).
Videos list:
Channel names are clickable (to /channel/<id>) with muted styling in meta; hover highlights.
References:
src/ui/options/components/Sidebar.tsx:1
src/ui/options/components/FiltersBar.tsx:1
src/ui/options/components/VideoList.tsx:1
src/ui/options/styles.css:1
Styling

Preset “S” toggle pressed-state:
.btn-ghost[aria-pressed="true"] shows accent border and inset glow. Reference: src/ui/options/styles.css:1
Channel link in meta:
.meta a styled to match muted meta text; hover shows accent/underline. Reference: src/ui/options/styles.css:1
Behavioral Notes

Auto-scrape evaluates only fields available at scrape time:
Supported now: sourceAny, sourcePlaylistAny, channelIdIn, and nested groupRef.
Predicates that depend on enrichment (e.g., topics/category/ytTags) are ignored during scrape-time evaluation; they still apply in Options filtering after enrichment.
If you want, I can also add a concise “Auto-Scrape” subsection under “How It

patch 4:

Auto‑Scrape

Scope: Runs on all YouTube surfaces (home, subscriptions, search, watch, channel, playlists).
Interval + activity gate: Scans every 2s, but only within 10s of your last user interaction (mouse/scroll/click/key/touch). Goes idle otherwise. File: src/content/index.ts
Watch pages: Always scrapes the current video (source WatchPage). Suggested tiles are gated by presets.
Scrape‑Time Matching

Preset gating: A preset participates in auto‑scrape only if its condition tree is fully checkable in‑page; otherwise it’s ignored (no partial apply). Supported now:
sourceAny, sourcePlaylistAny, channelIdIn, titleRegex, groupRef (only if referenced presets are also fully checkable)
Title check: Extracts tile title (#video-title / a#video-title / a#video-title-link) and applies titleRegex at scrape time. File: src/content/index.ts
Channel match: channelIdIn accepts channel id, handle (with/without @), or displayed channel name for scrape‑time gating. File: src/content/index.ts
Channel Handling

Channel pages: If tiles omit channel links, falls back to page context (detectPageContext) to set channelId/handle for matching. File: src/content/index.ts
Pending channels: Handle/name-only encounters add a pending entry; visiting a channel page resolves it to an id. Files: src/background/db.ts, src/background/index.ts
Stub Capture

When a candidate has title and/or channel info, content sends cache/VIDEO_STUB (id, title, channelName, channelId, sources), else cache/VIDEO_SEEN. File: src/content/index.ts
Presets UI

“S” toggle disabled when a preset contains any unsupported scrape‑time predicates; tooltip explains why. Files: src/ui/options/App.tsx, src/ui/options/components/Sidebar.tsx
“S” toggle highlights when enabled; disabled shows grey. File: src/ui/options/styles.css
Reminder: UI says “Presets” but storage/type remains “Group” (comment added; do not remove). Files: src/shared/conditions.ts, src/ui/options/components/FiltersBar.tsx, src/ui/options/components/Sidebar.tsx
Options UI Resilience

DB reads now close their IndexedDB connection after each transaction (prevents handle leaks on frequent refresh). File: src/ui/lib/idb.ts
Debounced refresh (200ms) on db/change for videos to avoid refresh thrash. File: src/ui/options/App.tsx
Minor UX

Channel names in Videos view are clickable (muted styling, hover accent). Files: src/ui/options/components/VideoList.tsx, src/ui/options/styles.css
Debugging

Content script logs key actions: navigation, ticker start, group refresh counts, idle skips, scan counts, current watch, and each scraped candidate. Toggle via DEBUG in src/types/debug.ts. Files: src/content/index.ts, src/types/debug.ts

patch notes 6: 
Auto‑Scrape Exclusions: Disabled on channel pages and on all playlist pages (including Watch Later). Only runs on watch/home/subscriptions/search and similar feeds. File: src/content/index.ts
Activity Gate + Interval: Still runs every 2s, but only within 10s of user interaction (mousemove/scroll/click/key/touch). File: src/content/index.ts
Stub Capture on Tiles: When title and/or channel info is available, content sends cache/VIDEO_STUB so Options show titles immediately. File: src/content/index.ts
Options Stability: Confirmed debounced refresh is used and read-only IDB connections are closed after completion to prevent handle leaks. Files: src/ui/options/App.tsx, src/ui/lib/idb.ts
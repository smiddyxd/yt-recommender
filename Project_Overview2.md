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
src/
├─ background/
│  ├─ db.ts
│  └─ index.ts
├─ content/
│  ├─ index.ts
│  ├─ yt-navigation.ts
│  └─ yt-playlist-capture.ts
├─ shared/
│  └─ conditions.ts
├─ types/
│  ├─ debug.ts
│  ├─ messages.ts
│  └─ util.ts
├─ ui/
│  ├─ lib/
│  │  ├─ format.ts
│  │  └─ idb.ts
│  └─ options/
│     ├─ components/
│     │  ├─ FiltersBar.tsx
│     │  ├─ Sidebar.tsx
│     │  └─ VideoList.tsx
│     ├─ App.tsx
│     ├─ index.html
│     ├─ index.tsx
│     └─ styles.css


# `src/background/db.ts` — concise map

**Purpose:** Owns the **IndexedDB** for the extension. Creates schema, merges incoming video data, and handles soft-delete (trash) + restore, plus a channel directory aggregation.

---

## DB schema

* **DB:** `yt-recommender` **v2**
* **Stores**

  * `videos` (keyPath: `id`)

    * Index `byChannel` → `channelId`
    * Index `byTag` → `tags` (**multiEntry**)
    * Index `byLastSeen` → `lastSeenAt`
  * `trash` (keyPath: `id`)

    * Index `byDeletedAt` → `deletedAt`

> Rows are YouTube videos you’ve seen/cached. `trash` holds copies with `deletedAt`.

---

## API (all return `Promise<…>`)

### `openDB(): IDBDatabase`

Opens DB at version 2. In `onupgradeneeded` it creates the stores/indexes above.

### `upsertVideo(obj: any): void`

Read-modify-write of a single video in `videos`.

* Reads existing row, **merges** with `obj`, then `put`.
* Merge rules:

  * Shallow merge base fields.
  * `flags` and `progress` merged field-wise.
  * `tags` preserved/initialized to `[]` if absent.
  * `sources` de-duplicated by `type:id:index`.
  * `lastSeenAt = Date.now()`.

### `moveToTrash(ids: string[]): void`

For each `id`:

* Get from `videos`; if present, write to `trash` with `deletedAt = Date.now()`, then delete from `videos`.
* Single readwrite transaction over `['videos','trash']`.

### `restoreFromTrash(ids: string[]): void`

For each `id`:

* Get from `trash`; if present, remove `deletedAt`, write back to `videos`, delete from `trash`.
* Single readwrite transaction over `['videos','trash']`.

### `listChannels(): Array<{ id: string; name: string; count: number }>`

Aggregates channels from `videos` using the `byChannel` index:

* Counts rows per `channelId`, upgrades name from `(unknown)` when a better one appears.
* Returns array sorted by **count desc**, then **name asc**.

---

## Data shape (informal)

```ts
type VideoRow = {
  id: string;
  title?: string | null;
  channelId?: string | null;
  channelName?: string | null;
  durationSec?: number | null;
  lastSeenAt?: number;
  flags?: { started?: boolean; completed?: boolean };
  progress?: { sec?: number; duration?: number };
  tags?: string[];
  sources?: Array<{ type: string; id?: string; index?: number }>;
  // only in `trash`:
  deletedAt?: number;
};
```

---

## Notes / invariants

* **Background** is the **sole writer**; UI opens DB **without version** and reads only.
* Transactions resolve on `oncomplete`; errors bubble via `reject(tx.error)` / `req.onerror`.
* Soft delete keeps full row history in `trash` until restored or permanently cleared (future op).



---------------------------------
# `src/background/index.ts` — concise map

**Purpose:** MV3 **service worker** that routes `chrome.runtime` messages to DB ops and broadcasts changes to the UI.

---

## Responsibilities

* Listen for one-off messages (`chrome.runtime.onMessage`).
* Perform async DB actions (via `db.ts`) and respond.
* Notify UIs with `db/change` after mutations (so Options page refreshes).
* Log errors (`dlog/derr`) and keep the response channel open (`return true`).

---

## Message contracts (inbound → action → outbound)

### `cache/VIDEO_SEEN`

* **In:** `{ id, ...partial video fields }`
* **Do:** `upsertVideo(payload)` (merge/refresh a row).
* **Out:** `{ ok: true }`

### `cache/VIDEO_PROGRESS`

* **In:** `{ id, current?, duration?, started?, completed? }`
* **Do:** `upsertVideo({ id, progress:{ sec:current, duration }, flags:{ started, completed } })`
* **Out:** `{ ok: true }`

### `videos/delete`

* **In:** `{ ids: string[] }`
* **Do:** `moveToTrash(ids)`
* **Out:** `{ ok: true }` **and** broadcast `chrome.runtime.sendMessage({ type:'db/change', payload:{ entity:'videos' } })`

### `videos/restore`

* **In:** `{ ids: string[] }`
* **Do:** `restoreFromTrash(ids)`
* **Out:** `{ ok: true }` **and** broadcast `db/change`

### `channels/list`

* **In:** `{}`
* **Do:** `listChannels()` (aggregate from `videos` by `byChannel` index)
* **Out:** `{ ok: true, channels: Array<{ id, name, count }> }`

> On any error: `{ ok:false, error }` is sent via the message callback.

---

## Error & lifecycle handling

* Wraps each case in `try/catch`; logs with `derr`.
* Adds global listeners for unhandled promise rejections and worker errors:

  * `self.addEventListener('unhandledrejection', …)`
  * `self.addEventListener('error', …)`
* Returns `true` from `onMessage` to keep the handler async-safe (MV3 requirement).

---

## Coupling

* **Imports:** `upsertVideo`, `moveToTrash`, `restoreFromTrash`, `listChannels` from `./db`.
* **Types/Logs:** `Msg` from `types/messages`, `dlog/derr` from `types/debug`.
* **UIs listening:** Options page reacts to `db/change` to refresh lists and channel directory.

------------------------

# `src/shared/conditions.ts` — concise map

**Purpose:** Defines the **Condition AST** used to express filters; defines a persisted **Group** (named condition); provides helpers to evaluate a video against a condition and to compose/normalize trees.

---

## Exports (conceptual contracts)

### Types

```ts
// Boolean expression over video fields
export type Condition =
  | { all: Condition[] }                               // AND
  | { any: Condition[] }                               // OR
  | { not: Condition }                                 // NOT
  | { kind: 'durationRange'; minSec: number; maxSec: number }
  | { kind: 'channelIdIn'; ids: string[] }
  | { kind: 'titleRegex'; pattern: string; flags: string }
  | { kind: 'groupRef'; ids: string[] };              // OR over referenced groups

export type Group = {
  id: string;
  name: string;
  condition: Condition;                                // persisted JSON
  createdAt?: number;
  updatedAt?: number;
};
```

### Evaluation

```ts
// Eval a video against a condition tree.
// ctx.resolveGroup(id) -> Group | undefined (to follow groupRef)
// Safe-regex evaluation (try/catch) recommended.
export function matches(
  video: {
    id: string;
    title?: string | null;
    channelId?: string | null;
    durationSec?: number | null;
    tags?: string[];
  },
  cond: Condition,
  ctx: { resolveGroup: (id: string) => Group | undefined }
): boolean;
```

### Composition / utilities (typical helpers)

```ts
export const all = (...nodes: Condition[]): Condition;
export const any = (...nodes: Condition[]): Condition;
export const not = (node: Condition): Condition;

// Optional normalizers (if present):
// - flatten nested {all}/{any}
// - drop empty nodes
// - clamp duration ranges
export function normalize(c: Condition): Condition;
```

---

## Semantics

* `{ all:[…] }` is logical AND; `{ any:[…] }` is OR; `{ not:x }` negates.
* `durationRange` matches `minSec <= (video.durationSec ?? ∞) <= maxSec`.
* `channelIdIn` matches if `video.channelId` is in `ids`.
* `titleRegex` compiles `new RegExp(pattern, flags)` and tests `video.title ?? ''` (guard with try/catch).
* `groupRef` is OR over the referenced groups’ conditions; evaluation must use `ctx.resolveGroup` and **avoid cycles** (track visited IDs).

---

## Usage in the app

* **FiltersBar** builds a linear chip chain, which `App` converts to a `Condition` (AND/OR/NOT) before saving as a **Group**.
* **Sidebar → Groups** lists saved `Group`s; clicking **Edit** loads a group’s `condition` back into the filter editor.
* **Filtering**: when applying current filters, `matches(video, condition, { resolveGroup })` decides inclusion.

---

## Invariants / notes

* Conditions are serializable JSON; stored with groups; safe to persist in IDB or `chrome.storage`.
* Normalization is idempotent (no behavior change).
* Regex evaluation must be exception-safe; invalid patterns should evaluate to **false** (or be stripped on normalize).
* `groupRef` cycles must be detected to prevent infinite recursion.

----------------------
# `src/types/debug.ts`

* **Purpose:** Minimal logging helpers used across background + UI.
* **Exports:**

  * `dlog(...args: any[])` → dev logging (typically `console.log` gated by a flag).
  * `derr(...args: any[])` → error logging (`console.error`), always on.

# `src/types/messages.ts`

* **Purpose:** Shapes for extension messages sent via `chrome.runtime.sendMessage`.
* **Exports:**

  * `type Msg = { type: string; payload?: any }` (base envelope).
  * Narrowed message names used today:

    * `'cache/VIDEO_SEEN'`, `'cache/VIDEO_PROGRESS'`
    * `'videos/delete'`, `'videos/restore'`
    * `'channels/list'`
  * (UI also uses names for tags/groups; safe to type as `Msg` until handlers are added.)

# `src/types/util.ts`

* **Purpose:** Small, framework-agnostic helpers shared by UI/background.
* **Typical contents:** tiny pure functions (e.g., number/string guards, time/seconds helpers, array set/merge helpers). No DOM, no Chrome APIs.
------------------

# `src/ui/lib/format.ts`

* **Purpose:** Pure formatting helpers used in the UI.
* **Typical things here:** seconds → `hh:mm:ss`, safe date → locale string, small string/number prettifiers.
* **Notes:** No DOM/Chrome calls; import from components to keep JSX clean.

# `src/ui/lib/idb.ts`

* **Purpose:** UI-side **read-only** IndexedDB helpers.
* **Exports:**
  `openDB()` → open `yt-recommender` **without** a version;
  `getAll(store: 'videos'|'trash')` → fetch all rows.
* **Why:** Background owns schema/upgrades; UI only reads.

-----------

# `src/ui/options/components/FiltersBar.tsx`

## What it is

Top-bar “filters editor” for the Options page. It renders filter “chips” (Duration, Channel, Title regex, Group) and lets you combine them with `AND/OR` and per-chip `NOT`. It also hosts the “Save as group / Save changes / Cancel edit” controls. &#x20;

## Exports

* `default function FiltersBar(props: Props)` — the component.&#x20;
* `export type FilterEntry` — one chip row in the chain: `{ pred, not?, op? }`. `op` is `AND|OR`, omitted for the first row.&#x20;
* `export type ChannelOption` — dropdown source for Channel chip (`{ id, name }`).&#x20;

## Props (data in/out)

* `chain`, `setChain` — the current list of filter entries and its setter.&#x20;
* `channelOptions` — channels to suggest in the Channel chip. `groups` — saved groups for the Group chip.&#x20;
* Group editor controls: `groupName`, `setGroupName`, `editingGroupId`, `onSaveAsGroup`, `onSaveChanges`, `onCancelEdit`.&#x20;

## Filter model (what a “chip” is)

```ts
type DurationUI = { minH,minM,minS,maxH,maxM,maxS };
type FilterNode =
  | { kind:'duration'; ui: DurationUI }
  | { kind:'channel'; ids:string[]; q:string }
  | { kind:'title'; pattern:string; flags:string }
  | { kind:'group'; ids:string[] };

type FilterOp = 'AND' | 'OR';
type FilterEntry = { pred: FilterNode; not?: boolean; op?: FilterOp };
```



## Key helpers (local)

* **addFilter(kind)** — appends a default chip; first row has no `op`, later rows default to `AND`.&#x20;
* **removeFilter(idx)** — removes a chip; if you delete the first one, clears `op` on the new first.&#x20;
* **toggleOp(idx)** — flips `AND↔OR` (no-op for index 0).&#x20;
* **toggleNot(idx)** — toggles the per-chip `NOT`.&#x20;

## Rendered UI (per chip)

Each chip row shows: optional `OpToggle` (from 2nd row), a header with `NOT` checkbox and “×” remove, plus its specific controls.

* **Duration** — two rows of numeric inputs (Min & Max; h/m/s). Updates are narrowed by kind when patching state. &#x20;
* **Channel** — search box filters `channelOptions`; below it a checklist of channels to include. Toggling adds/removes channel IDs. &#x20;
* **Title (regex)** — text input for `pattern` and `flags` (e.g., `i`).&#x20;
* **Group** — checklist of saved groups (by id).&#x20;

## Add/Clear controls

* “+ Add filter…” `<select>` with options: Duration, Channel, Title (regex), Group. Uses `addFilter`.&#x20;
* “Clear” button wipes the whole chain.&#x20;

## Group save/edit controls

Name input + buttons:

* **Save as group** (always creates a new group from current `chain`)
* **Save changes** / **Save as new** / **Cancel edit** (only when `editingGroupId` is set)
  Wiring uses `groupName`, `onSaveAsGroup`, `onSaveChanges`, `onCancelEdit`.&#x20;

## Data flow (mental model)

* Parent owns the filter chain and passes `chain` + `setChain`.
* Chips are stateless; they **narrow by kind** when editing (e.g., only modify `pred.kind==='channel'` entries for channel changes).&#x20;
* Group editor actions call the provided handlers; persistence lives in the parent (App).

## Gotchas / notes

* The first chip must have `op: undefined`; helpers keep that invariant after deletions.&#x20;
* Channel list is truncated to avoid huge DOM; UI hints when more exist (“…N more, refine search”).&#x20;
* Per-chip `NOT` is a boolean on `FilterEntry` and is honored by the matcher in the parent when applying filters. (This component only edits UI state.)

------------



# `src/ui/options/components/Sidebar.tsx`

* **Purpose:** Left sidebar for **Tag manager** (CRUD tag names) and **Groups list** (load into Filters editor, delete).
* **Props:**
  `tags, newTag, setNewTag, tagEditing, tagEditValue, setTagEditValue, startRename, cancelRename, commitRename, addTag, removeTag, groups, startEditFromGroup, removeGroup`.
* **Behavior:**

  * “New tag” input + Add button.
  * Tag rows: rename inline (Enter=save, Esc=cancel) or delete.
  * Group rows: **Edit** → calls `startEditFromGroup(g)`, **Delete** → `removeGroup(g.id)`.
  * Pure UI; no storage logic inside.

# `src/ui/options/components/VideoList.tsx`

* **Purpose:** Renders the **list/grid** of videos with selection and quick info.
* **Props:**
  `items` (videos), `layout` ('grid'|'list'), `loading`, `selected` (Set of ids), `onToggle(id)`.
* **Behavior:**

  * Each card: checkbox + thumbnail click toggles selection.
  * Shows title (links to YouTube), channel name, `durationSec` (formatted), `lastSeenAt`, and badges (`started`, `completed`, tags).
  * Empty-state message when not loading and no items.
  * No data fetching or mutation here—pure presentational component.

--------------
# `src/ui/options/App.tsx` — concise map

**Purpose:** The Options-page React root. Loads data from IndexedDB, orchestrates tags/groups/filters, handles selection + pagination, and renders `Sidebar`, `FiltersBar`, and `VideoList`.

---

## Responsibilities

* **Data loading:** Read `videos` or `trash` from IDB; refresh on background `db/change`.
* **Mutations via background:** delete → trash, restore, tags CRUD, groups CRUD, apply tags.
* **Filter building:** Convert chip chain (AND/OR/NOT) to a Condition AST; evaluate with `matches(...)`.
* **UI state:** list/grid layout, trash toggle, selection, pagination, search, tag popover, group editing.

---

## Key types

```ts
type Video = {
  id: string; title?: string|null; channelId?: string|null; channelName?: string|null;
  durationSec?: number|null; lastSeenAt?: number; deletedAt?: number;
  flags?: { started?: boolean; completed?: boolean }; tags?: string[];
};
type TagRec = { name: string; color?: string; createdAt?: number };
type GroupRec = { id: string; name: string; condition: Condition; };
type FilterEntry = { pred: FilterNode; not?: boolean; op?: 'AND' | 'OR' };
```

---

## State (high-level)

* **Data:** `videos: Video[]`, `tags: TagRec[]`, `groups: GroupRec[]`
* **View:** `layout: 'grid'|'list'`, `view: 'videos'|'trash'`
* **Selection:** `selected: Set<string>` (+ helpers to toggle/select page/all/clear)
* **Filters:** `chain: FilterEntry[]` (chips), search `q`
* **Groups edit:** `editingGroupId`, `groupName`
* **Tags edit:** `tagEditing`, `tagEditValue`, `newSidebarTag`
* **Paging:** `page`, `pageSize`
* **UX:** `loading`, `error`, `lastDeleted`, `showUndo`, `showTagger`

---

## Data access

* **`send(type, payload)`**: one-off messages to background (delete, restore, tags/groups ops).
* **`openDB` + `getAll(store)`**: read-only IDB helpers; load either `videos` or `trash`, then sort by `lastSeenAt` or `deletedAt`.
* **Refresh flow:** `refresh()` loads rows; a `useEffect` listens for `db/change` and calls `refresh()`/`loadTags()`/`loadGroups()` based on the entity.

---

## Filters & Conditions

* **`entryToPred(FilterEntry) → Condition | null`**: map a chip to a leaf:

  * duration → `{ kind:'durationRange', minSec?, maxSec? }`
  * channel → `{ kind:'channelIdIn', ids }`
  * title   → `{ kind:'titleRegex', pattern, flags }`
  * group   → `{ kind:'groupRef', ids }`
  * honors per-chip `not`
* **`chainToCondition() → Condition | null`**: linear chips → boolean tree with **AND precedence over OR**:

  * Split by `OR` into segments of `AND`s, then fold into `{ any:[ {all:[…]}, … ] }` or a single node.
* **Apply:** `filtered = videos.filter(v => matches(v, cond, { resolveGroup }))`, then search filter by title/channel.

---

## Tags

* **CRUD (names):** `addTag`, `startRename/cancelRename/commitRename`, `removeTag` → background `tags/*`.
* **Bulk apply:** `toggleTag(tag)` computes if all selected already have it; sends `videos/applyTags` with `addIds`/`removeIds`.

---

## Groups

* **List:** `loadGroups()`.
* **Create/Update:** `saveAsGroup()` / `saveChangesToGroup()` save current `chain` as a `Condition` AST.
* **Edit:** `startEditFromGroup(group)` loads a *simple* group back into chips via `conditionToChainSimple` (supports single-level `all/any` and leaf NOT; warns on complex nesting).
* **Delete:** `removeGroup(id)`.

---

## Derived data (memoized)

* **`channelOptions`**: unique `{id,name}` from loaded videos (for the channel chip).
* **`groupsById`**: quick lookup for `resolveGroup`.
* **`selectedVideos`, `tagCounts`, `availableTags`**: support bulk tagging UI.
* **Pagination:** compute `filtered`, `total`, `pageItems` based on `page` & `pageSize`.

---

## Rendering layout

* **`<Sidebar …>`**: Tag manager (CRUD) + Groups list (Edit/Delete); receives handlers & current lists.
* **Header controls:** list/grid toggle, **Trash** toggle, selection actions (select page/all/clear), **Delete** (disabled in Trash), **Tags…** button, search, **Refresh**.
* **`<FiltersBar …>`**: chip editor; AND/OR/NOT between chips; “Save as group / Save changes / Cancel”.
* **Toolbar-2:** page size select, pager (prev/next), total count.
* **`<VideoList …>`**: grid/list cards with checkbox + thumbnail click-to-select; shows badges (started/completed/tags).
* **Undo toast:** restore last deletion batch.

---

## Message endpoints used

* **Videos:** `'videos/delete'`, `'videos/restore'`, `'videos/applyTags'`
* **Tags:** `'tags/list'`, `'tags/create'`, `'tags/rename'`, `'tags/delete'`
* **Groups:** `'groups/list'`, `'groups/create'`, `'groups/update'`, `'groups/delete'`
* **Change broadcast from background:** `'db/change'` with `{ entity }`

---

## Test checklist

* Toggle **Trash** and ensure list reloads and Delete disables.
* Add a **Channel** chip and verify filtering; combine with **Title** regex and **Duration**.
* Save current chips as a **Group**, then **Edit** it back into chips.
* Select items → **Tags…** toggle-tag; confirm counts update.
* Delete → Undo; verify items move between `videos` and `trash`.


---------------------



# `src/ui/options/index.html`

* **Purpose:** Options page shell.
* **What it does:** Sets dark/light color-scheme, loads `styles.css`, mounts React into `<div id="root">`, imports `index.js` (bundled from `index.tsx`).&#x20;

# `src/ui/options/index.tsx`

* **Purpose:** React bootstrap.
* **What it does:** `createRoot(document.getElementById('root')).render(<App />)`; throws if `#root` missing.&#x20;

# `src/ui/options/styles.css`

* **Purpose:** Global styling for the options UI (dark by default).
* **Highlights:**

  * CSS variables (colors, sizes) and base typography.&#x20;
  * Header/controls, search, buttons.
  * **List/Grid** container with responsive cards; compact list-mode sizing.
  * Thumbnail aspect/fit; title/meta/badge styles.
  * Selection overlay + selected state, keyboard focus.
  * Secondary toolbar (pagination, page size, totals).
  * Danger/ghost/link buttons; undo toast.
  * **Layout:** fixed left **sidebar**; scrollable content.
  * **Tag popover** UI (grid of toggles), **Tag Manager** rows.
  * **Groups** forms/list.
  * **Filters** panel with chip UI, op toggles, duration inputs.
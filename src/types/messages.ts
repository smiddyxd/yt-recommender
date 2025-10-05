// add near top
import type { Condition, Group } from '../shared/conditions';

// ---- Recommender / Rec Sets ----
export interface RecEntry {
  presetId: string;
  role: 'filter' | 'weighted';
  weight: number; // 0..3 (0 disables when role=weighted)
  minPerPage?: number;
  maxPerPage?: number;
  prioritizeViewcount: number; // 0..1
  prioritizeRecency: number;   // 0..1
  randomness: number;          // 0..1
}

export interface PageRecord {
  id: string;
  recSetId: string;
  timestamp: number;
  videoIds: string[];
}

export interface RecSet {
  id: string;
  name: string;
  pageSize: number;
  entries: RecEntry[];
  history?: PageRecord[]; // output-only, bounded (e.g., last 100)
}

// ---- Collections ----
export interface CollectionRec {
  id: string;
  name: string;
  parentId?: string | null;
  color?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

// ---- Rules ----
export type RuleAction =
  | { kind: 'tags'; add?: string[]; remove?: string[] }
  | { kind: 'collections'; add?: string[]; remove?: string[]; recursive?: boolean }
  | { kind: 'delete' }
  | { kind: 'purge' };

export interface RuleRec {
  id: string;
  name: string;
  groupId: string; // preset id to match against
  channelIds?: string[]; // optional channel scope
  action: RuleAction;
  enabled?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

export type Msg =
  | { type: 'cache/VIDEO_SEEN'; payload: VideoSeed }
  | { type: 'cache/VIDEO_SEEN_BATCH'; payload: { items: VideoSeed[] } }
  | { type: 'cache/VIDEO_PROGRESS'; payload: { id: string; current: number; duration: number; started?: boolean; completed?: boolean } }
  | { type: 'cache/VIDEO_PROGRESS_PCT'; payload: { id: string; pct: number; started?: boolean; completed?: boolean } }
  | { type: 'cache/VIDEO_STUB'; payload: { id: string; title?: string | null; channelName?: string | null; channelId?: string | null; sources?: VideoSeed['sources'] } }
  | { type: 'scrape/NOW'; payload: {} }
  // Scrape panel (Options)
  | { type: 'scrape/status'; payload: {} }
  | { type: 'scrape/stop'; payload: {} }
  | { type: 'scrape/resolveIds'; payload: { limit?: number } }
  | { type: 'scrape/subFeed'; payload: { max?: number } }
  | { type: 'scrape/subscriptionsManager'; payload: {} }
  | { type: 'scrape/history'; payload: { max?: number } }
  | { type: 'page/GET_CONTEXT'; payload: {} }
  | { type: 'db/change'; payload: { entity: 'videos' | 'tags' | 'rules' | 'groups' | 'tagGroups' | 'collections' | 'recSets' } } // optional push event
  | { type: 'videos/delete';  payload: { ids: string[] } }
  | { type: 'videos/restore'; payload: { ids: string[] } }
  | { type: 'videos/applyTags'; payload: { ids: string[]; addIds?: string[]; removeIds?: string[] } }
  | { type: 'videos/wipeSources'; payload: {} }
  | { type: 'videos/applyYTBatch'; payload: { items: any[] } }
  | { type: 'videos/refreshAll'; payload: { skipFetched?: boolean } }
  | { type: 'videos/stubsCount'; payload: {} }
  | { type: 'channels/stubsCount'; payload: {} }
  | { type: 'videos/purge'; payload: { ids: string[] } }
  | { type: 'channels/list'; payload: {} }
  | { type: 'channels/trashList'; payload: {} }
  | { type: 'channels/refreshUnfetched'; payload: {} }
  | { type: 'channels/refreshByIds'; payload: { ids: string[] } }
  | { type: 'channels/applyTags'; payload: { ids: string[]; addIds?: string[]; removeIds?: string[] } }
  | { type: 'channels/getTags'; payload: { id: string } }
  | { type: 'channels/markScraped'; payload: { id: string; at: number; tab?: 'videos'|'shorts'|'live'; count?: number; totalVideoCountOnScrapeTime?: number | null } }
  | { type: 'channels/upsertPending'; payload: { key: string; name?: string | null; handle?: string | null; subscribedPending?: boolean } }
  | { type: 'channels/resolvePending'; payload: { id: string; name?: string | null; handle?: string | null; altHandle?: string | null } }
  | { type: 'channels/pending/list'; payload: {} }
  | { type: 'channels/pending/resolveBatch'; payload: { limit?: number } }
  | { type: 'channels/pending/delete'; payload: { key: string } }
  | { type: 'channels/delete'; payload: { ids: string[] } }
  | { type: 'channels/restore'; payload: { ids: string[] } }
  | { type: 'channels/purge'; payload: { ids: string[] } }
  | { type: 'channels/upsertStub'; payload: { id: string; name?: string | null; handle?: string | null } }
  | { type: 'channels/lookupByHandle'; payload: { handle: string } }
  | { type: 'channels/lookupByName'; payload: { name: string } }
  | { type: 'latest/mark'; payload: { source: 'SubscriptionsFeed'|'WatchHistory'; id: string | null; createIfMissing?: boolean } }
  | { type: 'channels/markSubscribed'; payload: { ids: string[] } }
  // TAGS (you already added earlier)
  | { type: 'tags/list';    payload: {} }
  | { type: 'tags/create';  payload: { name: string; color?: string } }
  | { type: 'tags/rename';  payload: { oldName: string; newName: string } }
  | { type: 'tags/delete';  payload: { name: string; cascade?: boolean } }
  | { type: 'tags/assignGroup'; payload: { name: string; groupId: string | null } }
  // GROUPS
  | { type: 'groups/list';   payload: {} }
  | { type: 'groups/create'; payload: { name: string; condition: Condition } }
  | { type: 'groups/update'; payload: { id: string; patch: Partial<Group> } }
  | { type: 'groups/delete'; payload: { id: string } }
  // COLLECTIONS
  | { type: 'collections/list'; payload: {} }
  | { type: 'collections/create'; payload: { name: string; parentId?: string | null } }
  | { type: 'collections/update'; payload: { id: string; patch: Partial<CollectionRec> } }
  | { type: 'collections/delete'; payload: { id: string } }
  // RECOMMENDER / REC SETS
  | { type: 'recSets/list'; payload: {} }
  | { type: 'recSets/create'; payload: { name: string; pageSize: number; entries?: RecEntry[] } }
  | { type: 'recSets/update'; payload: { id: string; patch: Partial<RecSet> } }
  | { type: 'recSets/delete'; payload: { id: string } }
  | { type: 'recSets/duplicate'; payload: { id: string; name?: string } }
  // REC SETS HISTORY
  | { type: 'recSets/history/list'; payload: { recSetId: string } }
  | { type: 'recSets/history/open'; payload: { recordId: string } }
  | { type: 'recSets/history/delete'; payload: { recordId: string } }
  | { type: 'recSets/history/export'; payload: { recordId: string } }
  // PAGE BUILD
  | { type: 'recommender/buildPage'; payload: { recSetId: string; seed?: string; respectDontRecommend?: boolean } }
  // RECOMMENDER EVAL (no history writes)
  | { type: 'recommender/evaluate'; payload: { recSetId: string; respectDontRecommend?: boolean } }
  | { type: 'recommender/presetCount'; payload: { presetId: string; respectDontRecommend?: boolean } }
  // VIDEO <-> COLLECTIONS
  | { type: 'videos/collections/apply'; payload: { ids: string[]; collectionId: string; op: 'add'|'remove' } }
  // TAG GROUPS (for organizing tags)
  | { type: 'tagGroups/list';   payload: {} }
  | { type: 'tagGroups/create'; payload: { name: string } }
  | { type: 'tagGroups/rename'; payload: { id: string; name: string } }
  | { type: 'tagGroups/delete'; payload: { id: string } }
  | { type: 'tagGroups/update'; payload: { id: string; patch: Partial<TagGroupRec> } }
  // META
  | { type: 'topics/list'; payload: {} }
  // RULES (stubs for next step)
  | { type: 'rules/list';    payload: {} }
  | { type: 'rules/create';  payload: { name: string; groupId: string; action: RuleAction; channelIds?: string[]; enabled?: boolean } }
  | { type: 'rules/update';  payload: { id: string; patch: Partial<RuleRec> } }
  | { type: 'rules/delete';  payload: { id: string } }
  | { type: 'rules/runAll';  payload: { onlyEnabled?: boolean } }
  | { type: 'db/change'; payload: { entity: 'videos' | 'tags' | 'groups' | 'rules' | 'tagGroups' | 'collections' | 'recSets' } }
  // BACKUP (Google Drive)
  | { type: 'backup/saveSettings'; payload: {} }
  | { type: 'backup/getClientId'; payload: {} }
  | { type: 'backup/setClientId'; payload: { clientId: string } }
  | { type: 'backup/restoreSettings'; payload: {} }
  | { type: 'backup/listFiles'; payload: {} }
  | { type: 'backup/downloadFile'; payload: { id: string } }
  | { type: 'backup/downloadFileRange'; payload: { id: string; start: number; length?: number } }
  | { type: 'backup/wipeAll'; payload: {} }
  | { type: 'backup/history/list'; payload: { limit?: number } }
  | { type: 'backup/history/getCommit'; payload: { commitId: string } }
  | { type: 'backup/history/getUpTo'; payload: { commitId: string } }
  | { type: 'backup/history/deleteUpTo'; payload: { commitId: string } }
  | { type: 'backup/history/usage'; payload: {} }
  | { type: 'backup/history/revertTo'; payload: { commitId: string; dryRun?: boolean } }
  | { type: 'backup/history/snapshotNow'; payload: { interactive?: boolean; name?: string } }
  // RESTORE & APPLY
  | { type: 'backup/restore/dryRun'; payload: { name?: string; snapshot?: any; mode: 'merge'|'overwrite'; apply?: { channelTags?: boolean; videoTags?: boolean; sources?: boolean; progress?: boolean } } }
  | { type: 'backup/restore/apply';  payload: { name?: string; snapshot?: any; mode: 'merge'|'overwrite'; apply?: { channelTags?: boolean; videoTags?: boolean; sources?: boolean; progress?: boolean; collections?: boolean } } };

export interface VideoSeed {
  id: string;
  sources: Array<{
    type:
      | 'playlist'
      | 'panel'
      | 'WatchPage'
      | 'ChannelVideosTab'
      | 'ChannelShortsTab'
      | 'ChannelLivestreamsTab'
      // Scrape Panel routines
      | 'SubscriptionsFeed'
      | 'WatchHistory';
    id?: string | null;
  }>;
}

// Background message for creating/updating a minimal channel stub
// Used by watch-page stub capture to ensure the channel exists in DB.
export type ChannelUpsertStubMsg = { type: 'channels/upsertStub'; payload: { id: string; name?: string | null; handle?: string | null } };

export interface TagRec { name: string; color?: string; createdAt?: number; groupId?: string | null }
export interface TagGroupRec { id: string; name: string; createdAt?: number; color?: string; parentId?: string | null }




// add near top
import type { Condition, Group } from '../shared/conditions';

export type Msg =
  | { type: 'cache/VIDEO_SEEN'; payload: VideoSeed }
  | { type: 'cache/VIDEO_PROGRESS'; payload: { id: string; current: number; duration: number; started?: boolean; completed?: boolean } }
  | { type: 'cache/VIDEO_PROGRESS_PCT'; payload: { id: string; pct: number; started?: boolean; completed?: boolean } }
  | { type: 'cache/VIDEO_STUB'; payload: { id: string; title?: string | null; channelName?: string | null; channelId?: string | null; sources?: VideoSeed['sources'] } }
  | { type: 'scrape/NOW'; payload: {} }
  | { type: 'page/GET_CONTEXT'; payload: {} }
  | { type: 'db/change'; payload: { entity: 'videos' | 'tags' | 'rules' | 'groups' | 'tagGroups' } } // optional push event
  | { type: 'videos/delete';  payload: { ids: string[] } }
  | { type: 'videos/restore'; payload: { ids: string[] } }
  | { type: 'videos/applyTags'; payload: { ids: string[]; addIds?: string[]; removeIds?: string[] } }
  | { type: 'videos/wipeSources'; payload: {} }
  | { type: 'videos/applyYTBatch'; payload: { items: any[] } }
  | { type: 'videos/refreshAll'; payload: { skipFetched?: boolean } }
  | { type: 'videos/stubsCount'; payload: {} }
  | { type: 'channels/list'; payload: {} }
  | { type: 'channels/trashList'; payload: {} }
  | { type: 'channels/refreshUnfetched'; payload: {} }
  | { type: 'channels/refreshByIds'; payload: { ids: string[] } }
  | { type: 'channels/applyTags'; payload: { ids: string[]; addIds?: string[]; removeIds?: string[] } }
  | { type: 'channels/markScraped'; payload: { id: string; at: number; tab?: 'videos'|'shorts'|'live'; count?: number; totalVideoCountOnScrapeTime?: number | null } }
  | { type: 'channels/upsertPending'; payload: { key: string; name?: string | null; handle?: string | null } }
  | { type: 'channels/resolvePending'; payload: { id: string; name?: string | null; handle?: string | null } }
  | { type: 'channels/delete'; payload: { ids: string[] } }
  | { type: 'channels/restore'; payload: { ids: string[] } }
  | { type: 'channels/upsertStub'; payload: { id: string; name?: string | null; handle?: string | null } }
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
  // TAG GROUPS (for organizing tags)
  | { type: 'tagGroups/list';   payload: {} }
  | { type: 'tagGroups/create'; payload: { name: string } }
  | { type: 'tagGroups/rename'; payload: { id: string; name: string } }
  | { type: 'tagGroups/delete'; payload: { id: string } }
  // META
  | { type: 'topics/list'; payload: {} }
  // RULES (stubs for next step)
  | { type: 'rules/list';    payload: {} }
  | { type: 'rules/create';  payload: any }
  | { type: 'rules/update';  payload: any }
  | { type: 'rules/delete';  payload: { id: string } }
  | { type: 'rules/runAll';  payload: { onlyEnabled?: boolean } }
  | { type: 'db/change'; payload: { entity: 'videos' | 'tags' | 'groups' | 'rules' | 'tagGroups' } };

export interface VideoSeed {
  id: string;
  sources: Array<{
    type:
      | 'playlist'
      | 'panel'
      | 'WatchPage'
      | 'ChannelVideosTab'
      | 'ChannelShortsTab'
      | 'ChannelLivestreamsTab';
    id?: string | null;
  }>;
}

// Background message for creating/updating a minimal channel stub
// Used by watch-page stub capture to ensure the channel exists in DB.
export type ChannelUpsertStubMsg = { type: 'channels/upsertStub'; payload: { id: string; name?: string | null; handle?: string | null } };

export interface TagRec { name: string; color?: string; createdAt?: number; groupId?: string | null }
export interface TagGroupRec { id: string; name: string; createdAt?: number }

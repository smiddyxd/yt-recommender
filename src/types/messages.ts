// add near top
import type { Condition, Group } from '../shared/conditions';

export type Msg =
  | { type: 'cache/VIDEO_SEEN'; payload: VideoSeed }
  | { type: 'cache/VIDEO_PROGRESS'; payload: { id: string; current: number; duration: number; started?: boolean; completed?: boolean } }
  | { type: 'scrape/NOW'; payload: {} }
  | { type: 'db/change'; payload: { entity: 'videos' | 'tags' | 'rules' | 'groups' } } // optional push event
  | { type: 'videos/delete';  payload: { ids: string[] } }
  | { type: 'videos/restore'; payload: { ids: string[] } }
  | { type: 'videos/applyTags'; payload: { ids: string[]; addIds?: string[]; removeIds?: string[] } }
  | { type: 'videos/wipeSources'; payload: {} }
  | { type: 'videos/applyYTBatch'; payload: { items: any[] } }
  | { type: 'videos/refreshAll'; payload: { skipFetched?: boolean } }
  | { type: 'channels/list'; payload: {} }
  | { type: 'channels/applyTags'; payload: { ids: string[]; addIds?: string[]; removeIds?: string[] } }
  // TAGS (you already added earlier)
  | { type: 'tags/list';    payload: {} }
  | { type: 'tags/create';  payload: { name: string; color?: string } }
  | { type: 'tags/rename';  payload: { oldName: string; newName: string } }
  | { type: 'tags/delete';  payload: { name: string; cascade?: boolean } }
  // GROUPS
  | { type: 'groups/list';   payload: {} }
  | { type: 'groups/create'; payload: { name: string; condition: Condition } }
  | { type: 'groups/update'; payload: { id: string; patch: Partial<Group> } }
  | { type: 'groups/delete'; payload: { id: string } }
  // META
  | { type: 'topics/list'; payload: {} }
  // RULES (stubs for next step)
  | { type: 'rules/list';    payload: {} }
  | { type: 'rules/create';  payload: any }
  | { type: 'rules/update';  payload: any }
  | { type: 'rules/delete';  payload: { id: string } }
  | { type: 'rules/runAll';  payload: { onlyEnabled?: boolean } }
  | { type: 'db/change'; payload: { entity: 'videos' | 'tags' | 'groups' | 'rules' } };

export interface VideoSeed {
  id: string;
  sources: Array<{ type: 'playlist' | 'panel'; id?: string | null }>;
}

export interface TagRec { name: string; color?: string; createdAt?: number }

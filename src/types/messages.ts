export type Msg =
  | { type: 'cache/VIDEO_SEEN'; payload: VideoSeed }
  | { type: 'cache/VIDEO_PROGRESS'; payload: { id: string; current: number; duration: number; started?: boolean; completed?: boolean } }
  | { type: 'videos/delete';  payload: { ids: string[] } }
  | { type: 'videos/restore'; payload: { ids: string[] } }
  | { type: 'db/change'; payload: { entity: 'videos' | 'tags' | 'rules' | 'groups' } } // optional push event
  | { type: 'videos/applyTags'; payload: { ids: string[]; addIds?: string[]; removeIds?: string[] } }

export interface VideoSeed {
  id: string;
  title?: string | null;
  channelName?: string | null;
  channelId?: string | null;
  durationSec?: number | null;
  sources: Array<{ type: 'playlist' | 'panel'; id?: string | null; index?: number | null; seenAt: number }>;
}
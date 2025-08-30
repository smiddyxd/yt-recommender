// src/shared/conditions.ts
export type Condition = Pred | { all: Condition[] } | { any: Condition[] } | { not: Condition };

export type Pred =
  | { kind: 'titleRegex'; pattern: string; flags?: string }
  | { kind: 'channelIdIn'; ids: string[] }
  | { kind: 'durationRange'; minSec?: number; maxSec?: number }
  | { kind: 'ageDays'; min?: number; max?: number }            // based on uploadedAt
  // Video-specific predicates
  | { kind: 'descriptionRegex'; pattern: string; flags?: string }
  | { kind: 'categoryIn'; ids: number[] }
  | { kind: 'isLive'; value: boolean }
  | { kind: 'languageCodeIn'; codes: Array<'en'|'de'|'other'> }
  | { kind: 'visibilityIn'; values: Array<'public'|'unlisted'|'private'> }
  | { kind: 'topicAny'; topics: string[] }
  | { kind: 'topicAll'; topics: string[] }
  | { kind: 'tagsAny';  tags: string[] }
  | { kind: 'tagsAll';  tags: string[] }
  | { kind: 'tagsNone'; tags: string[] }                        // has none of
  | { kind: 'flag'; name: 'started' | 'completed'; value: boolean }
  | { kind: 'sourceAny'; items: Array<{ type: string; id?: string | null }> }
  | { kind: 'sourcePlaylistAny'; ids: string[] }
  | { kind: 'groupRef'; ids: string[] }                         // video matches ANY of these groups
  // Channel-specific predicates (used on videos via resolveChannel; and directly on channels via matchesChannel)
  | { kind: 'channelSubsRange'; min?: number; max?: number }
  | { kind: 'channelViewsRange'; min?: number; max?: number }
  | { kind: 'channelVideosRange'; min?: number; max?: number }
  | { kind: 'channelCountryIn'; codes: string[] }
  | { kind: 'channelCreatedAgeDays'; min?: number; max?: number }
  | { kind: 'channelSubsHidden'; value: boolean }
  | { kind: 'channelTagsAny';  tags: string[] }
  | { kind: 'channelTagsAll';  tags: string[] }
  | { kind: 'channelTagsNone'; tags: string[] };

export type VideoRow = {
  id: string;
  title?: string | null;
  channelId?: string | null;
  channelName?: string | null;
  durationSec?: number | null;
  uploadedAt?: number | null;
  fetchedAt?: number | null; // when YouTube data was last fetched/applied
  ytTags?: string[] | null; // YouTube native tags (fetched later)
  yt?: any;                 // Raw YouTube videos.list payload (parts)
  tags?: string[] | null;
  flags?: { started?: boolean; completed?: boolean } | null;
  sources?: Array<{ type: string; id?: string | null }> | null;
  // Optional denormalized fields for filters
  description?: string | null;
  categoryId?: number | null;
  languageCode?: 'en'|'de'|'other'|null;
  visibility?: 'public'|'unlisted'|'private'|null;
  isLive?: boolean | null;
  videoTopics?: string[] | null;
};

export type ChannelRow = {
  id: string;
  name?: string | null;
  subs?: number | null;
  views?: number | null;
  videos?: number | null;
  country?: string | null;
  publishedAt?: number | null;
  subsHidden?: boolean | null;
  tags?: string[] | null;
  videoTags?: string[] | null;
  keywords?: string | null;
  topics?: string[] | null;
};

export type Group = {
  id: string;
  name: string;
  condition: Condition;
  createdAt: number;
  updatedAt: number;
};

export function matches(
  v: VideoRow,
  c: Condition,
  ctx: {
    resolveGroup: (id: string) => Group | undefined;
    resolveChannel?: (id: string) => ChannelRow | undefined;
    seenGroups?: Set<string>;
  }
): boolean {
  // combinators
  if ('all' in (c as any)) return (c as any).all.every((sub: Condition) => matches(v, sub, ctx));
  if ('any' in (c as any)) return (c as any).any.some((sub: Condition) => matches(v, sub, ctx));
  if ('not' in (c as any)) return !matches(v, (c as any).not, ctx);

  const p = c as Pred;
  const tags = (v.tags ?? []) as string[];
  switch (p.kind) {
    case 'titleRegex': {
      const s = v.title ?? '';
      const re = safeRe(p.pattern, p.flags);
      return re ? re.test(s) : false;
    }
    case 'channelIdIn': {
      const id = (v.channelId ?? '').trim();
      return !!id && p.ids.includes(id);
    }
    case 'durationRange': {
      const sec = v.durationSec;
      if (sec == null || !Number.isFinite(sec)) return false;
      if (p.minSec != null && sec < p.minSec) return false;
      if (p.maxSec != null && sec > p.maxSec) return false;
      return true;
    }
    case 'ageDays': {
      const ts = v.uploadedAt;
      if (!ts || !Number.isFinite(ts)) return false;
      const age = (Date.now() - ts) / 86400000; // ms per day
      if (p.min != null && age < p.min) return false;
      if (p.max != null && age > p.max) return false;
      return true;
    }
    case 'tagsAny': {
      if (!tags.length) return false;
      const want = new Set(normList(p.tags));
      return tags.some(t => want.has(norm(t)));
    }
    case 'tagsAll': {
      const have = new Set(normList(tags));
      return normList(p.tags).every(t => have.has(t));
    }
    case 'tagsNone': {
      if (!tags.length) return true;
      const have = new Set(normList(tags));
      return !normList(p.tags).some(t => have.has(t));
    }
    case 'descriptionRegex': {
      const s = v.description ?? '';
      const re = safeRe(p.pattern, p.flags);
      return re ? re.test(s) : false;
    }
    case 'categoryIn': {
      const id = v.categoryId;
      return id != null && p.ids.includes(id);
    }
    case 'isLive': {
      return (v.isLive === true) === (p.value === true);
    }
    case 'languageCodeIn': {
      const lc = (v.languageCode || '').toString().toLowerCase();
      return lc ? p.codes.includes(lc as any) : false;
    }
    case 'visibilityIn': {
      const vis = (v.visibility || '').toString();
      return !!vis && p.values.includes(vis as any);
    }
    case 'topicAny': {
      const vt = (v.videoTopics || []) as string[];
      if (!vt.length) return false;
      const want = new Set((p.topics || []).map(norm));
      return vt.some(t => want.has(norm(t)));
    }
    case 'topicAll': {
      const vt = new Set((v.videoTopics || []).map(norm));
      return (p.topics || []).every(t => vt.has(norm(t)));
    }
    case 'channelSubsRange':
    case 'channelViewsRange':
    case 'channelVideosRange':
    case 'channelCountryIn':
    case 'channelCreatedAgeDays':
    case 'channelSubsHidden':
    case 'channelTagsAny':
    case 'channelTagsAll':
    case 'channelTagsNone': {
      const chId = (v.channelId || '').trim();
      const ch = chId && ctx.resolveChannel ? ctx.resolveChannel(chId) : undefined;
      if (!ch) return false;
      switch (p.kind) {
        case 'channelSubsRange': {
          const n = ch.subs ?? null; if (n == null) return false;
          if (p.min != null && n < p.min) return false; if (p.max != null && n > p.max) return false; return true;
        }
        case 'channelViewsRange': {
          const n = ch.views ?? null; if (n == null) return false;
          if (p.min != null && n < p.min) return false; if (p.max != null && n > p.max) return false; return true;
        }
        case 'channelVideosRange': {
          const n = ch.videos ?? null; if (n == null) return false;
          if (p.min != null && n < p.min) return false; if (p.max != null && n > p.max) return false; return true;
        }
        case 'channelCountryIn': {
          const code = (ch.country || '').toString().trim().toLowerCase();
          const set = new Set((p.codes || []).map(s => (s || '').toLowerCase()));
          return !!code && set.has(code);
        }
        case 'channelCreatedAgeDays': {
          const ts = ch.publishedAt ?? null; if (!ts || !Number.isFinite(ts)) return false;
          const age = (Date.now() - ts) / 86400000; if (p.min != null && age < p.min) return false; if (p.max != null && age > p.max) return false; return true;
        }
        case 'channelSubsHidden': {
          const val = !!ch.subsHidden; return p.value ? val : !val;
        }
        case 'channelTagsAny': {
          const have: string[] = Array.isArray(ch.tags) ? ch.tags : [];
          if (!have.length) return false;
          const want = new Set(normList(p.tags));
          return have.some(t => want.has(norm(t)));
        }
        case 'channelTagsAll': {
          const have = new Set(normList(Array.isArray(ch.tags) ? ch.tags : []));
          return normList(p.tags).every(t => have.has(t));
        }
        case 'channelTagsNone': {
          const have = new Set(normList(Array.isArray(ch.tags) ? ch.tags : []));
          if (have.size === 0) return true;
          return !normList(p.tags).some(t => have.has(t));
        }
      }
    }
    case 'flag': {
      const f = v.flags || {};
      const val = (f as any)[p.name] === true;
      return p.value ? val : !val;
    }
    case 'sourceAny': {
      const src = Array.isArray(v.sources) ? v.sources : [];
      if (!src.length) return false;
      const items = Array.isArray(p.items) ? p.items : [];
      if (!items.length) return false;
      return src.some(s => items.some(it => (s?.type || '') === (it?.type || '') && ((s?.id ?? null) === (it?.id ?? null))));
    }
    case 'sourcePlaylistAny': {
      const src = v.sources ?? [];
      const set = new Set(p.ids);
      return src.some(s => s?.type === 'playlist' && s?.id && set.has(s.id));
    }
    case 'groupRef': {
      if (!p.ids?.length) return false;
      for (const gid of p.ids) {
        if (!gid) continue;
        const seen = ctx.seenGroups ?? (ctx.seenGroups = new Set());
        if (seen.has(gid)) continue; // avoid cycles
        seen.add(gid);
        const g = ctx.resolveGroup(gid);
        if (g && matches(v, g.condition, { ...ctx, seenGroups: new Set(seen) })) return true;
      }
      return false;
    }
    default:
      return false;
  }
}

// Channel evaluator: supports channel predicates directly, and video predicates existentially across that channel's videos
export function matchesChannel(
  ch: ChannelRow,
  c: Condition,
  ctx: { videos: VideoRow[]; resolveGroup: (id: string) => Group | undefined; seenGroups?: Set<string> }
): boolean {
  if ('all' in (c as any)) return (c as any).all.every((sub: Condition) => matchesChannel(ch, sub, ctx));
  if ('any' in (c as any)) return (c as any).any.some((sub: Condition) => matchesChannel(ch, sub, ctx));
  if ('not' in (c as any)) return !matchesChannel(ch, (c as any).not, ctx);
  const p = c as Pred;
  const isVideoPred = (
    p.kind === 'titleRegex' || p.kind === 'durationRange' || p.kind === 'ageDays' ||
    p.kind === 'descriptionRegex' || p.kind === 'categoryIn' || p.kind === 'isLive' ||
    p.kind === 'languageCodeIn' || p.kind === 'visibilityIn' || p.kind === 'topicAny' ||
    p.kind === 'topicAll' || p.kind === 'tagsAny' || p.kind === 'tagsAll' || p.kind === 'tagsNone' ||
    p.kind === 'flag' || p.kind === 'sourceAny' || p.kind === 'sourcePlaylistAny' || p.kind === 'groupRef'
  );
  if (isVideoPred) {
    const vids = ctx.videos.filter(v => (v.channelId || '') === ch.id);
    if (vids.length === 0) return false;
    return vids.some(v => matches(v, p as any, { resolveGroup: ctx.resolveGroup } as any));
  }
  switch (p.kind) {
    case 'channelSubsRange': {
      const n = ch.subs ?? null; if (n == null) return false;
      if (p.min != null && n < p.min) return false; if (p.max != null && n > p.max) return false; return true;
    }
    case 'channelViewsRange': {
      const n = ch.views ?? null; if (n == null) return false;
      if (p.min != null && n < p.min) return false; if (p.max != null && n > p.max) return false; return true;
    }
    case 'channelVideosRange': {
      const n = ch.videos ?? null; if (n == null) return false;
      if (p.min != null && n < p.min) return false; if (p.max != null && n > p.max) return false; return true;
    }
    case 'channelCountryIn': {
      const code = (ch.country || '').toString().trim().toLowerCase();
      const set = new Set((p.codes || []).map(s => (s || '').toLowerCase()));
      return !!code && set.has(code);
    }
    case 'channelCreatedAgeDays': {
      const ts = ch.publishedAt ?? null; if (!ts || !Number.isFinite(ts)) return false;
      const age = (Date.now() - ts) / 86400000; if (p.min != null && age < p.min) return false; if (p.max != null && age > p.max) return false; return true;
    }
    case 'channelSubsHidden': {
      const val = !!ch.subsHidden; return p.value ? val : !val;
    }
    case 'channelTagsAny': {
      const have: string[] = Array.isArray(ch.tags) ? ch.tags : [];
      if (!have.length) return false;
      const want = new Set(normList(p.tags));
      return have.some(t => want.has(norm(t)));
    }
    case 'channelTagsAll': {
      const have = new Set(normList(Array.isArray(ch.tags) ? ch.tags : []));
      return normList(p.tags).every(t => have.has(t));
    }
    case 'channelTagsNone': {
      const have = new Set(normList(Array.isArray(ch.tags) ? ch.tags : []));
      if (have.size === 0) return true;
      return !normList(p.tags).some(t => have.has(t));
    }
    default:
      return false;
  }
}

function safeRe(pattern: string, flags?: string): RegExp | null {
  try { return new RegExp(pattern, flags); } catch { return null; }
}
function norm(s: string) { return (s ?? '').trim().toLowerCase(); }
function normList(a: string[]) { return (a ?? []).map(norm).filter(Boolean); }

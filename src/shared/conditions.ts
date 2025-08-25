// src/shared/conditions.ts
export type Condition = Pred | { all: Condition[] } | { any: Condition[] } | { not: Condition };

export type Pred =
  | { kind: 'titleRegex'; pattern: string; flags?: string }
  | { kind: 'channelIdIn'; ids: string[] }
  | { kind: 'channelNameRegex'; pattern: string; flags?: string }
  | { kind: 'durationRange'; minSec?: number; maxSec?: number }
  | { kind: 'ageDays'; min?: number; max?: number }            // based on lastSeenAt
  | { kind: 'tagsAny';  tags: string[] }
  | { kind: 'tagsAll';  tags: string[] }
  | { kind: 'tagsNone'; tags: string[] }                        // has none of
  | { kind: 'flag'; name: 'started' | 'completed'; value: boolean }
  | { kind: 'sourcePlaylistAny'; ids: string[] }
  | { kind: 'groupRef'; ids: string[] };                        // video matches ANY of these groups

export type VideoRow = {
  id: string;
  title?: string | null;
  channelId?: string | null;
  channelName?: string | null;
  durationSec?: number | null;
  lastSeenAt?: number | null;
  tags?: string[] | null;
  flags?: { started?: boolean; completed?: boolean } | null;
  sources?: Array<{ type: string; id?: string | null }> | null;
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
    case 'channelNameRegex': {
      const s = v.channelName ?? '';
      const re = safeRe(p.pattern, p.flags);
      return re ? re.test(s) : false;
    }
    case 'durationRange': {
      const sec = v.durationSec;
      if (sec == null || !Number.isFinite(sec)) return false;
      if (p.minSec != null && sec < p.minSec) return false;
      if (p.maxSec != null && sec > p.maxSec) return false;
      return true;
    }
    case 'ageDays': {
      const ts = v.lastSeenAt;
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
    case 'flag': {
      const f = v.flags || {};
      const val = (f as any)[p.name] === true;
      return p.value ? val : !val;
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

function safeRe(pattern: string, flags?: string): RegExp | null {
  try { return new RegExp(pattern, flags); } catch { return null; }
}
function norm(s: string) { return (s ?? '').trim().toLowerCase(); }
function normList(a: string[]) { return (a ?? []).map(norm).filter(Boolean); }

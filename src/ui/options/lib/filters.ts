import type { Condition } from '../../../shared/conditions';

// Shared filter editor types + helpers
export type DurationUI = { minH: number; minM: number; minS: number; maxH: number; maxM: number; maxS: number };
export type AgeUI = { min?: number; max?: number; unit?: 'd'|'w'|'m'|'y' };
export type FilterNode =
  // Existing
  | { kind: 'duration'; ui: DurationUI }
  | { kind: 'age'; ui: AgeUI }
  | { kind: 'channel'; ids: string[]; q: string }
  | { kind: 'title'; pattern: string; flags: string }
  | { kind: 'group'; ids: string[] }
  // Video filters
  | { kind: 'v_flag'; name: 'started'|'completed'; value: boolean }
  | { kind: 'v_tags_any'; tagsCsv: string }
  | { kind: 'v_tags_all'; tagsCsv: string }
  | { kind: 'v_tags_none'; tagsCsv: string }
  | { kind: 'v_desc'; pattern: string; flags: string }
  | { kind: 'v_category'; ids: number[] }
  | { kind: 'v_livestream'; value: boolean }
  | { kind: 'v_language'; codes: Array<'en'|'de'|'other'> }
  | { kind: 'v_visibility'; values: Array<'public'|'unlisted'|'private'> }
  | { kind: 'v_topics_any'; itemsCsv: string }
  | { kind: 'v_topics_all'; itemsCsv: string }
  // Channel filters
  | { kind: 'c_subs'; min?: number; max?: number }
  | { kind: 'c_views'; min?: number; max?: number }
  | { kind: 'c_videos'; min?: number; max?: number }
  | { kind: 'c_country'; codesCsv: string }
  | { kind: 'c_createdAge'; ui: AgeUI }
  | { kind: 'c_subsHidden'; value: boolean };

export type FilterOp = 'AND' | 'OR';
export type FilterEntry = { pred: FilterNode; not?: boolean; op?: FilterOp };

const clamp = (n: number) => Math.max(0, Number.isFinite(n) ? Math.floor(n) : 0);
const hmsToSec = (h: number, m: number, s: number) => clamp(h) * 3600 + clamp(m) * 60 + clamp(s);
const toDays = (n?: number, unit?: AgeUI['unit']) => {
  if (!Number.isFinite(n as any)) return undefined;
  const v = Math.max(0, Math.floor(n as number));
  switch (unit) { case 'w': return v * 7; case 'm': return v * 30; case 'y': return v * 365; default: return v; }
};
const csv = (s: string) => (s || '').split(',').map(x => x.trim()).filter(Boolean);
const numCsv = (s: string) => csv(s).map(x => Number(x)).filter(n => Number.isFinite(n));

export function entryToCondition(e: FilterEntry): Condition | null {
  const f = e.pred;
  if (f.kind === 'duration') {
    const min = hmsToSec(f.ui.minH, f.ui.minM, f.ui.minS);
    const max = hmsToSec(f.ui.maxH, f.ui.maxM, f.ui.maxS);
    if (min === 0 && max === 0) return null;
    const node: Condition = { kind: 'durationRange', ...(min ? { minSec: min } : {}), ...(max ? { maxSec: max } : {}) } as any;
    return e.not ? ({ not: node } as any) : node;
  }
  if (f.kind === 'age') {
    const min = toDays(f.ui.min, f.ui.unit);
    const max = toDays(f.ui.max, f.ui.unit);
    if (min == null && max == null) return null;
    const node: Condition = { kind: 'ageDays', ...(min != null ? { min } : {}), ...(max != null ? { max } : {}) } as any;
    return e.not ? ({ not: node } as any) : node;
  }
  if (f.kind === 'channel') {
    if (f.ids.length === 0) return null;
    const node: Condition = { kind: 'channelIdIn', ids: f.ids.slice() } as any;
    return e.not ? ({ not: node } as any) : node;
  }
  if (f.kind === 'title') {
    const pattern = (f.pattern || '').trim();
    if (!pattern) return null;
    const node: Condition = { kind: 'titleRegex', pattern, flags: (f.flags || '').trim() } as any;
    return e.not ? ({ not: node } as any) : node;
  }
  // Video filters
  if (f.kind === 'v_flag') {
    const node: Condition = { kind: 'flag', name: f.name, value: !!f.value } as any;
    return e.not ? ({ not: node } as any) : node;
  }
  if (f.kind === 'v_tags_any') {
    const tags = csv(f.tagsCsv);
    if (!tags.length) return null;
    const node: Condition = { kind: 'tagsAny', tags } as any;
    return e.not ? ({ not: node } as any) : node;
  }
  if (f.kind === 'v_tags_all') {
    const tags = csv(f.tagsCsv);
    if (!tags.length) return null;
    const node: Condition = { kind: 'tagsAll', tags } as any;
    return e.not ? ({ not: node } as any) : node;
  }
  if (f.kind === 'v_tags_none') {
    const tags = csv(f.tagsCsv);
    if (!tags.length) return null;
    const node: Condition = { kind: 'tagsNone', tags } as any;
    return e.not ? ({ not: node } as any) : node;
  }
  if (f.kind === 'v_desc') {
    const pattern = (f.pattern || '').trim(); if (!pattern) return null;
    const node: Condition = { kind: 'descriptionRegex', pattern, flags: (f.flags || '').trim() } as any;
    return e.not ? ({ not: node } as any) : node;
  }
  if (f.kind === 'v_category') {
    if (!f.ids?.length) return null;
    const node: Condition = { kind: 'categoryIn', ids: f.ids.slice() } as any;
    return e.not ? ({ not: node } as any) : node;
  }
  if (f.kind === 'v_livestream') {
    const node: Condition = { kind: 'isLive', value: !!f.value } as any;
    return e.not ? ({ not: node } as any) : node;
  }
  if (f.kind === 'v_language') {
    if (!f.codes?.length) return null;
    const node: Condition = { kind: 'languageCodeIn', codes: f.codes.slice() } as any;
    return e.not ? ({ not: node } as any) : node;
  }
  if (f.kind === 'v_visibility') {
    if (!f.values?.length) return null;
    const node: Condition = { kind: 'visibilityIn', values: f.values.slice() } as any;
    return e.not ? ({ not: node } as any) : node;
  }
  if (f.kind === 'v_topics_any') {
    const items = csv(f.itemsCsv);
    if (!items.length) return null;
    const node: Condition = { kind: 'topicAny', topics: items } as any;
    return e.not ? ({ not: node } as any) : node;
  }
  if (f.kind === 'v_topics_all') {
    const items = csv(f.itemsCsv);
    if (!items.length) return null;
    const node: Condition = { kind: 'topicAll', topics: items } as any;
    return e.not ? ({ not: node } as any) : node;
  }
  // Channel filters
  if (f.kind === 'c_subs') {
    const node: Condition = { kind: 'channelSubsRange', ...(Number.isFinite(f.min!) ? { min: Math.floor(f.min!) } : {}), ...(Number.isFinite(f.max!) ? { max: Math.floor(f.max!) } : {}) } as any;
    return e.not ? ({ not: node } as any) : node;
  }
  if (f.kind === 'c_views') {
    const node: Condition = { kind: 'channelViewsRange', ...(Number.isFinite(f.min!) ? { min: Math.floor(f.min!) } : {}), ...(Number.isFinite(f.max!) ? { max: Math.floor(f.max!) } : {}) } as any;
    return e.not ? ({ not: node } as any) : node;
  }
  if (f.kind === 'c_videos') {
    const node: Condition = { kind: 'channelVideosRange', ...(Number.isFinite(f.min!) ? { min: Math.floor(f.min!) } : {}), ...(Number.isFinite(f.max!) ? { max: Math.floor(f.max!) } : {}) } as any;
    return e.not ? ({ not: node } as any) : node;
  }
  if (f.kind === 'c_country') {
    const codes = csv(f.codesCsv).map(s => s.toLowerCase()); if (!codes.length) return null;
    const node: Condition = { kind: 'channelCountryIn', codes } as any;
    return e.not ? ({ not: node } as any) : node;
  }
  if (f.kind === 'c_createdAge') {
    const min = toDays(f.ui.min, f.ui.unit); const max = toDays(f.ui.max, f.ui.unit);
    if (min == null && max == null) return null;
    const node: Condition = { kind: 'channelCreatedAgeDays', ...(min != null ? { min } : {}), ...(max != null ? { max } : {}) } as any;
    return e.not ? ({ not: node } as any) : node;
  }
  if (f.kind === 'c_subsHidden') {
    const node: Condition = { kind: 'channelSubsHidden', value: !!f.value } as any;
    return e.not ? ({ not: node } as any) : node;
  }
  if (f.kind === 'group') {
    if (f.ids.length === 0) return null;
    const node: Condition = { kind: 'groupRef', ids: f.ids.slice() } as any;
    return e.not ? ({ not: node } as any) : node;
  }
  return null;
}

export function chainToCondition(chain: FilterEntry[]): Condition | null {
  const items: Array<{ op?: FilterEntry['op']; node: Condition }> = [];
  for (let i = 0; i < chain.length; i++) {
    const node = entryToCondition(chain[i]);
    if (node) items.push({ op: chain[i].op, node });
  }
  if (items.length === 0) return null;

  // Split by OR (AND has higher precedence)
  const segments: Condition[][] = [];
  let cur: Condition[] = [];
  for (let i = 0; i < items.length; i++) {
    const { op, node } = items[i];
    if (i > 0 && op === 'OR') {
      segments.push(cur);
      cur = [];
    }
    cur.push(node);
  }
  segments.push(cur);

  const collapsed = segments.map(seg => seg.length === 1 ? seg[0] : ({ all: seg } as Condition));
  return collapsed.length === 1 ? collapsed[0] : ({ any: collapsed } as Condition);
}

// Simple reverse mapping to load a group back into the linear editor
export function conditionToChainSimple(cond: any): FilterEntry[] | null {
  const toEntry = (c: any): FilterEntry | null => {
    let not = false;
    let leaf = c;
    if (leaf && 'not' in leaf) {
      not = true;
      leaf = leaf.not;
    }
    if (!leaf || typeof leaf !== 'object') return null;

    if (leaf.kind === 'durationRange') {
      const min = leaf.minSec | 0, max = leaf.maxSec | 0;
      return {
        op: undefined,
        not,
        pred: {
          kind: 'duration',
          ui: {
            minH: Math.floor((min || 0) / 3600), minM: Math.floor(((min || 0) % 3600) / 60), minS: (min || 0) % 60,
            maxH: Math.floor((max || 0) / 3600), maxM: Math.floor(((max || 0) % 3600) / 60), maxS: (max || 0) % 60,
          }
        }
      };
    }
    if (leaf.kind === 'channelIdIn') {
      return { op: undefined, not, pred: { kind: 'channel', ids: leaf.ids || [], q: '' } };
    }
    if (leaf.kind === 'titleRegex') {
      return { op: undefined, not, pred: { kind: 'title', pattern: leaf.pattern || '', flags: leaf.flags || '' } };
    }
    if (leaf.kind === 'groupRef') {
      return { op: undefined, not, pred: { kind: 'group', ids: leaf.ids || [] } };
    }
    if (leaf.kind === 'ageDays') {
      return { op: undefined, not, pred: { kind: 'age', ui: { min: leaf.min, max: leaf.max, unit: 'd' } } } as any;
    }
    return null; // other predicates not yet mapped back
  };

  if (!cond) return null;
  if (cond.kind) {
    const e = toEntry(cond);
    return e ? [e] : null;
  }

  if ('all' in cond || 'any' in cond) {
    const list: any[] = (cond.all || cond.any || []) as any[];
    const isAny = 'any' in cond;
    const out: FilterEntry[] = [];
    for (let i = 0; i < list.length; i++) {
      const e = toEntry(list[i]);
      if (!e) return null;
      out.push({ ...e, op: i === 0 ? undefined : (isAny ? 'OR' : 'AND') });
    }
    return out;
  }

  // NOT on a group is not supported in the linear editor yet
  if ('not' in cond) return null;

  return null;
}

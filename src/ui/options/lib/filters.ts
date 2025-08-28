import type { Condition } from '../../../shared/conditions';

// Shared filter editor types + helpers
export type DurationUI = { minH: number; minM: number; minS: number; maxH: number; maxM: number; maxS: number };
export type FilterNode =
  | { kind: 'duration'; ui: DurationUI }
  | { kind: 'channel'; ids: string[]; q: string }
  | { kind: 'title'; pattern: string; flags: string }
  | { kind: 'group'; ids: string[] };

export type FilterOp = 'AND' | 'OR';
export type FilterEntry = { pred: FilterNode; not?: boolean; op?: FilterOp };

const clamp = (n: number) => Math.max(0, Number.isFinite(n) ? Math.floor(n) : 0);
const hmsToSec = (h: number, m: number, s: number) => clamp(h) * 3600 + clamp(m) * 60 + clamp(s);

export function entryToCondition(e: FilterEntry): Condition | null {
  const f = e.pred;
  if (f.kind === 'duration') {
    const min = hmsToSec(f.ui.minH, f.ui.minM, f.ui.minS);
    const max = hmsToSec(f.ui.maxH, f.ui.maxM, f.ui.maxS);
    if (min === 0 && max === 0) return null;
    const node: Condition = { kind: 'durationRange', ...(min ? { minSec: min } : {}), ...(max ? { maxSec: max } : {}) } as any;
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


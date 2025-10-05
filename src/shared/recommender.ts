import type { ChannelRow, Group, VideoRow } from './conditions';
import { matches } from './conditions';
import type { RecSet, RecEntry } from '../types/messages';

export interface BuildPageParams {
  recSet: RecSet;
  videos: VideoRow[]; // candidate universe (e.g., all videos or pre-filtered)
  resolveGroup: (id: string) => Group | undefined;
  resolveChannel?: (id: string) => ChannelRow | undefined;
  respectDontRecommend: boolean;
  seed: string; // stable per build; Topbar Reshuffle changes this
  dontRecommendTag?: string; // default 'dontRecommend'
  getViews?: (v: VideoRow) => number | undefined; // fallback to (v as any).views
}

export interface BuildPageResult {
  videoIds: string[];
  debug?: {
    globalPool: number;
    perRow: Array<{ rowIndex: number; role: RecEntry['role']; candidates: number; placed: number; weight: number; min?: number; max?: number }>
  };
}

const DEFAULT_DONT_RECOMMEND = 'dontRecommend';

export function buildRecommendationPage(params: BuildPageParams): BuildPageResult {
  const {
    recSet,
    videos,
    resolveGroup,
    resolveChannel,
    respectDontRecommend,
    seed,
    dontRecommendTag = DEFAULT_DONT_RECOMMEND,
    getViews,
  } = params;

  const pageSize = Math.max(0, Math.floor(recSet.pageSize || 0));
  if (pageSize <= 0) return { videoIds: [] };

  const filterRows = recSet.entries.filter(e => e.role === 'filter');
  const weightedRows = recSet.entries
    .map((e, idx) => ({ ...e, __rowIndex: idx }))
    .filter(e => e.role === 'weighted') as Array<RecEntry & { __rowIndex: number }>;

  // Build global pool: must pass all filter rows, and (optional) not tagged dontRecommend
  const pool = videos.filter(v => {
    if (respectDontRecommend) {
      const tags = (v as any).tags as string[] | null | undefined;
      if (Array.isArray(tags) && tags.some(t => norm(t) === norm(dontRecommendTag))) return false;
    }
    if (!filterRows.length) return true;
    const ok = filterRows.every(fr => matchPreset(v, fr.presetId, resolveGroup, resolveChannel));
    return ok;
  });

  if (!pool.length) return { videoIds: [], debug: { globalPool: 0, perRow: [] } };

  // Per-row candidates and scores
  type Cand = { id: string; s: number; bRec: number; bViews: number };
  type RowState = {
    idx: number; // entry index in recSet.entries
    entry: RecEntry;
    enabled: boolean; // weight>0
    min: number; // effective min after clamp
    max: number; // effective max after clamp
    candidates: Cand[]; // sorted desc by s
    ptr: number; // next candidate index to consider
    placed: number; // total placed in final result for this row
  };

  const rowStates: RowState[] = weightedRows.map(wr => {
    const enabled = wr.weight > 0;
    const candidatesRaw = enabled
      ? pool.filter(v => matchPreset(v, wr.presetId, resolveGroup, resolveChannel))
      : [];
    const cands = scoreRowCandidates(candidatesRaw, wr, seed, getViews);
    const capacity = cands.length;
    const maxCap = wr.maxPerPage != null ? Math.max(0, Math.floor(wr.maxPerPage)) : capacity;
    const max = Math.min(capacity, maxCap);
    const minWanted = Math.max(0, Math.floor(wr.minPerPage ?? 0));
    const min = enabled ? Math.min(minWanted, max) : 0;
    return { idx: (wr as any).__rowIndex, entry: wr, enabled, min, max, candidates: cands, ptr: 0, placed: 0 };
  });

  const perRowDbg = rowStates.map(rs => ({ rowIndex: rs.idx, role: 'weighted' as const, candidates: rs.candidates.length, placed: 0, weight: rs.entry.weight, min: rs.min, max: rs.max }));
  // Precompute 75th percentile thresholds per row for recency and views
  const quartileByRow: Record<number, { rec: number; views: number }> = {};
  for (const rs of rowStates) {
    const recVals = rs.candidates.map(c => c.bRec);
    const viewVals = rs.candidates.map(c => c.bViews);
    quartileByRow[rs.idx] = { rec: q75(recVals), views: q75(viewVals) };
  }

  // If no weighted rows or sumW=0, empty result
  const sumW = rowStates.reduce((a, r) => a + (r.enabled ? r.entry.weight : 0), 0);
  if (!rowStates.length || sumW <= 0) {
    return { videoIds: [], debug: { globalPool: pool.length, perRow: perRowDbg } };
  }

  // Stage 1: place mins
  const sumMin = rowStates.reduce((a, r) => a + r.min, 0);
  let minTargets = rowStates.map(r => r.min);

  if (sumMin > pageSize) {
    // Hamilton method shrink to exactly pageSize
    const scaled = rowStates.map(r => (pageSize * r.min) / sumMin);
    const base = scaled.map(x => Math.floor(x));
    let rem = pageSize - base.reduce((a, x) => a + x, 0);
    const rema = scaled.map((x, i) => ({ i, frac: x - Math.floor(x) }));
    rema.sort((a, b) => b.frac - a.frac);
    for (let k = 0; k < rema.length && rem > 0; k++, rem--) base[rema[k].i]++;
    minTargets = base;
  }

  const picked = new Set<string>();
  const selection: Array<{ id: string; rowIdx: number; score: number; bRec: number; bViews: number }> = [];

  // Helper to get next candidate for a row that is not yet picked
  function nextCand(rs: RowState): Cand | undefined {
    const n = rs.candidates.length;
    while (rs.ptr < n) {
      const c = rs.candidates[rs.ptr++];
      if (!picked.has(c.id)) return c;
    }
    return undefined;
  }

  // Phase A: fill minimums
  let totalPlaced = 0;
  while (totalPlaced < pageSize) {
    // Rows that still need to meet min
    const needing = rowStates
      .map((r, i) => ({ r, need: Math.max(0, (minTargets[i] || 0) - r.placed) }))
      .filter(x => x.need > 0 && x.r.placed < x.r.max);
    if (!needing.length) break;

    // Process rows in order of descending need
    needing.sort((a, b) => b.need - a.need);
    let progress = false;
    for (const { r } of needing) {
      if (totalPlaced >= pageSize) break;
      const c = nextCand(r);
      if (!c) continue;
      pick(c, r);
      progress = true;
    }
    if (!progress) break; // no more candidates available
  }

  // Stage 2: allocate remaining targets by weights
  const placedMin = totalPlaced;
  const L = Math.max(0, pageSize - placedMin);
  if (L > 0) {
    // Only rows with capacity remaining and enabled contribute to weights
    const rowsForW = rowStates.filter(r => r.enabled && r.placed < r.max && r.candidates.length > r.placed);
    const sumW2 = rowsForW.reduce((a, r) => a + r.entry.weight, 0);
    let t: number[] = new Array(rowStates.length).fill(0);
    if (sumW2 > 0) {
      const raw = rowsForW.map(r => ({ r, raw: (L * r.entry.weight) / sumW2 }));
      const base = raw.map(x => Math.floor(x.raw));
      let baseSum = base.reduce((a, x) => a + x, 0);
      const rema = raw.map((x, i) => ({ i, frac: x.raw - Math.floor(x.raw) }));
      rema.sort((a, b) => b.frac - a.frac);
      let remaining = L - baseSum;
      for (let k = 0; k < rema.length && remaining > 0; k++, remaining--) base[rema[k].i]++;
      // Map back into t[] aligned with rowStates order
      for (let i = 0, j = 0; i < rowStates.length; i++) {
        if (rowsForW.includes(rowStates[i])) {
          t[i] = base[j++];
        }
      }
    }

    // Fill targets honoring max, then backfill
    totalPlaced = placeByQuotas(rowStates, t, pageSize, nextCand, pick, totalPlaced);
  }

  // Final ordering: by claimant row score desc, ties by hash(itemId, seed)
  selection.sort((a, b) => (b.score - a.score) || (hash32(seed + ':' + a.id) - hash32(seed + ':' + b.id)));

  // Update debug placed counts
  for (const s of selection) {
    const dbg = perRowDbg.find(x => x.rowIndex === s.rowIdx);
    if (dbg) dbg.placed++;
  }

  const metaById: Record<string, { rowIdx: number; presetId: string; recent: boolean; highViews: boolean }> = {};
  for (const s of selection) {
    const rs = rowStates.find(r => r.idx === s.rowIdx);
    const alpha = clamp01(rs?.entry?.prioritizeRecency ?? 0);
    const beta = clamp01(rs?.entry?.prioritizeViewcount ?? 0);
    const thr = quartileByRow[s.rowIdx] || { rec: 1, views: 1 };
    const recent = alpha >= 0.3 && s.bRec >= (thr.rec ?? 1);
    const highViews = beta >= 0.3 && s.bViews >= (thr.views ?? 1);
    metaById[s.id] = { rowIdx: s.rowIdx, presetId: String(rs?.entry?.presetId || ''), recent, highViews };
  }

  return { videoIds: selection.map(s => s.id), metaById, debug: { globalPool: pool.length, perRow: perRowDbg } };

  function pick(c: Cand, r: RowState) {
    picked.add(c.id);
    r.placed++;
    selection.push({ id: c.id, rowIdx: r.idx, score: c.s, bRec: c.bRec, bViews: c.bViews });
    totalPlaced++;
  }
}

function placeByQuotas(
  rows: Array<{ max: number; placed: number } & any>,
  quotas: number[],
  pageSize: number,
  nextCand: (r: any) => { id: string; s: number; bRec: number; bViews: number } | undefined,
  pick: (c: { id: string; s: number; bRec: number; bViews: number }, r: any) => void,
  totalPlacedStart: number,
): number {
  let totalPlaced = totalPlacedStart;
  // Initial pass: fill quotas
  while (totalPlaced < pageSize) {
    const needing = rows
      .map((r, i) => ({ r, need: Math.max(0, (quotas[i] || 0) - r.placed) }))
      .filter(x => x.need > 0 && x.r.placed < x.r.max);
    if (!needing.length) break;
    needing.sort((a, b) => b.need - a.need);
    let progress = false;
    for (const { r } of needing) {
      if (totalPlaced >= pageSize) break;
      const c = nextCand(r);
      if (!c) continue;
      pick(c, r);
      progress = true;
    }
    if (!progress) break;
  }

  if (totalPlaced >= pageSize) return totalPlaced;

  // Backfill proportionally among rows with capacity
  while (totalPlaced < pageSize) {
    const avail = rows.filter(r => r.placed < r.max);
    if (!avail.length) break;
    // Simple round-robin weighted by (max - placed)
    const order = avail
      .map((r, i) => ({ r, gap: r.max - r.placed, i }))
      .sort((a, b) => b.gap - a.gap);
    let progress = false;
    for (const { r } of order) {
      if (totalPlaced >= pageSize) break;
      const c = nextCand(r);
      if (!c) continue;
      pick(c, r);
      progress = true;
    }
    if (!progress) break;
  }
  return totalPlaced;
}

function matchPreset(
  v: VideoRow,
  presetId: string,
  resolveGroup: (id: string) => Group | undefined,
  resolveChannel?: (id: string) => ChannelRow | undefined,
): boolean {
  const g = resolveGroup(presetId);
  if (!g) return false;
  try {
    return matches(v, g.condition, { resolveGroup, resolveChannel, seenGroups: new Set() });
  } catch {
    return false;
  }
}

function scoreRowCandidates(
  vids: VideoRow[],
  row: RecEntry,
  seed: string,
  getViews?: (v: VideoRow) => number | undefined,
): Array<{ id: string; s: number; bRec: number; bViews: number }> {
  const alpha = clamp01(row.prioritizeRecency ?? 0);
  const beta = clamp01(row.prioritizeViewcount ?? 0);

  // Precompute views transform and min-max across this row
  const logs: number[] = [];
  for (const v of vids) {
    const vv = typeof getViews === 'function' ? getViews(v) : (v as any)?.views;
    const n = typeof vv === 'number' && Number.isFinite(vv) ? vv : undefined;
    logs.push(n != null ? Math.log10(Math.max(0, n) + 1) : NaN);
  }
  let minLog = Infinity, maxLog = -Infinity, anyNum = false;
  for (const x of logs) {
    if (Number.isFinite(x)) {
      anyNum = true;
      if (x < minLog) minLog = x;
      if (x > maxLog) maxLog = x;
    }
  }

  const out = vids.map((v, i) => {
    const bRec = recencyBase(v);
    let bViews = 0.5;
    if (anyNum) {
      const x = logs[i];
      if (Number.isFinite(x)) {
        if (maxLog > minLog) bViews = (x - minLog) / (maxLog - minLog);
        else bViews = 0.5; // constant case
      } else {
        bViews = 0.5;
      }
    }
    let base = 0.5;
    if (alpha + beta > 0) base = (alpha * bRec + beta * bViews) / (alpha + beta);
    const r = hash32(seed + ':' + (v.id || '')) / 0x100000000; // [0,1)
    const rand = clamp01(row.randomness ?? 0);
    const s = (1 - rand) * base + rand * r;
    return { id: v.id, s, bRec, bViews };
  });

  out.sort((a, b) => b.s - a.s);
  return out;
}

function recencyBase(v: VideoRow): number {
  const ts = (v as any).uploadedAt;
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    const ageDays = (Date.now() - ts) / 86400000;
    return Math.pow(2, -ageDays / 30);
  }
  return 0.5;
}

function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }
function norm(s: string): string { return (s || '').trim().toLowerCase(); }
function q75(arr: number[]): number {
  if (!arr || arr.length === 0) return 1;
  const a = arr.slice().sort((x, y) => x - y);
  const idx = Math.floor(0.75 * (a.length - 1));
  return a[idx];
}

// Simple 32-bit FNV-1a based hash with a xorshift mix for better distribution
export function hash32(str: string): number {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // xorshift
  h ^= h << 13; h >>>= 0;
  h ^= h >> 17; h >>>= 0;
  h ^= h << 5;  h >>>= 0;
  return h >>> 0;
}

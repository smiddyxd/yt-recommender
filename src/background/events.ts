// Lightweight event history: records batched commit of events, computes size/weight,
// persists to IDB, and flushes to Drive JSONL with dynamic checkpoints.

import { openDB } from './db';
import { saveSnapshotWithName, getCurrentSettingsSnapshot, downloadAppDataFileBase64 as dlFile, listAppDataFiles as listFiles, upsertAppDataTextFile } from './driveBackup';
import { dlog, derr } from '../types/debug';

type EventKind =
  | 'videos/applyTags'
  | 'videos/delete' | 'videos/restore'
  | 'videos/progress'
  | 'videos/wipeSources'
  | 'groups/create' | 'groups/update' | 'groups/delete'
  | 'tags/create' | 'tags/rename' | 'tags/delete' | 'tags/assignGroup'
  | 'tagGroups/create' | 'tagGroups/rename' | 'tagGroups/delete'
  | 'channels/applyTags' | 'channels/delete' | 'channels/restore' | 'channels/markScraped'
  | 'pending/upsert' | 'pending/resolve'
  | 'videos/attrChanged' | 'channels/attrChanged';

export type EventRecord = {
  id: string; // commitId:idx
  commitId: string;
  ts: number;
  kind: EventKind;
  payload: any;
  inverse?: any;
  impact?: { videos?: number; channels?: number; tags?: number; groups?: number };
  size?: number; // JSON size in bytes
};

export type CommitRecord = {
  commitId: string;
  ts: number;
  summary: string;
  weight: number;
  size: number;
  counts: { events: number; videos?: number; channels?: number; tags?: number; groups?: number };
};

let pending: EventRecord[] = [];
let accWeight = 0;
let accSize = 0;
let currentCommitId: string | null = null;
let commitTimer: number | undefined;

function nowCommitId(): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

export function recordEvent(kind: EventKind, payload: any, opts?: { inverse?: any; impact?: EventRecord['impact'] }) {
  if (!currentCommitId) currentCommitId = nowCommitId();
  const ts = Date.now();
  const rec: EventRecord = {
    id: `${currentCommitId}:${pending.length}`,
    commitId: currentCommitId,
    ts,
    kind,
    payload,
    inverse: opts?.inverse,
    impact: opts?.impact,
  };
  const s = JSON.stringify({ kind, payload, inverse: rec.inverse, impact: rec.impact });
  rec.size = s.length;
  const rows = (opts?.impact?.videos || 0) + (opts?.impact?.channels || 0) + (opts?.impact?.tags || 0) + (opts?.impact?.groups || 0);
  const weight = rows + Math.round(s.length / 1024);
  pending.push(rec);
  accSize += rec.size || 0;
  accWeight += weight;
  // Lazy schedule flush; actual debounce controlled by caller or via queueCommitFlush
}

export async function finalizeCommitAndFlushIfAny(): Promise<void> {
  if (!currentCommitId || pending.length === 0) return;
  const commitId = currentCommitId;
  const ts = Date.now();
  // Build summary
  const counts = { events: pending.length, videos: 0, channels: 0, tags: 0, groups: 0 } as CommitRecord['counts'];
  const byKind = new Map<string, number>();
  for (const ev of pending) {
    byKind.set(ev.kind, (byKind.get(ev.kind) || 0) + 1);
    counts.videos = (counts.videos || 0) + (ev.impact?.videos || 0);
    counts.channels = (counts.channels || 0) + (ev.impact?.channels || 0);
    counts.tags = (counts.tags || 0) + (ev.impact?.tags || 0);
    counts.groups = (counts.groups || 0) + (ev.impact?.groups || 0);
  }
  const summary = Array.from(byKind.entries()).map(([k, n]) => `${k}×${n}`).join(', ');
  const commit: CommitRecord = { commitId, ts, summary, weight: accWeight, size: accSize, counts };
  // Persist to IDB
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['events', 'events_commits'] as any, 'readwrite');
    const es = tx.objectStore('events');
    const cs = tx.objectStore('events_commits');
    for (const ev of pending) es.put(ev);
    cs.put(commit);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  // Flush to Drive JSONL and maybe snapshot
  try { await appendCommitToDrive(commit, pending); } catch (e) { derr('appendCommitToDrive error', e as any); }
  pending = [];
  accWeight = 0;
  accSize = 0;
  currentCommitId = null;
}

// Debounced flush for commits so multiple events batch into a single commit
export function queueCommitFlush(delayMs: number = 3000) {
  if (commitTimer) { clearTimeout(commitTimer as any); }
  commitTimer = setTimeout(async () => {
    commitTimer = undefined;
    try { await finalizeCommitAndFlushIfAny(); } catch {}
  }, delayMs) as unknown as number;
}

function monthKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

async function appendCommitToDrive(commit: CommitRecord, events: EventRecord[]) {
  const mk = monthKey(commit.ts);
  const name = `events-${mk}.jsonl`;
  // Fetch existing file content (header + lines), append, upload
  let fileId: string | null = null;
  try {
    const files = await listFiles();
    const found = files.find(f => f.name === name);
    fileId = found ? found.id : null;
  } catch {}
  const header = { type: 'fileHeader', month: mk, firstCommitTs: commit.ts, firstCommitId: commit.commitId };
  let current = '';
  if (!fileId) {
    current += JSON.stringify(header) + '\n';
  } else {
    try {
      const { contentB64 } = await dlFile(fileId);
      const bin = atob(contentB64);
      current = bin;
    } catch { current = ''; }
    if (!current) current = JSON.stringify(header) + '\n';
  }
  const lines = events.map(ev => JSON.stringify({ ts: ev.ts, kind: ev.kind, payload: ev.payload, impact: ev.impact, size: ev.size, commitId: commit.commitId }));
  current += lines.join('\n') + '\n';

  // Upload new content
  await upsertAppDataTextFile(name, current);

  // Dynamic checkpoint
  try {
    const LIMIT_WEIGHT = 10_000; // user-approved
    const LIMIT_MONTH_BYTES = 20 * 1024 * 1024; // 20 MB
    const add = commit.weight || 0;
    const get = <T = any>(k: string) => new Promise<T>((res) => chrome.storage?.local?.get(k, (o) => res((o as any)?.[k])));
    const set = (k: string, v: any) => new Promise<void>((res) => { try { chrome.storage?.local?.set({ [k]: v }, () => res()); } catch { res(); } });
    const prevWeight = Number(await get<number>('eventsWeightSinceSnap')) || 0;
    const monthSize = current.length; // in bytes (characters)
    const nextWeight = prevWeight + add;
    await set('eventsWeightSinceSnap', nextWeight);
    await set('eventsMonthSizeBytes', monthSize);
    if (nextWeight >= LIMIT_WEIGHT || monthSize >= LIMIT_MONTH_BYTES) {
      try {
        const snap = await getCurrentSettingsSnapshot();
        const ts = new Date().toISOString().replace(/[:.]/g, '').replace('T','-').slice(0, 15);
        await saveSnapshotWithName(`snapshots/settings-${ts}.json`, snap);
        await set('eventsWeightSinceSnap', 0);
      } catch (e) { derr('checkpoint error', e as any); }
    }
  } catch {}
}

// Public history APIs
export async function listCommits(limit: number = 100): Promise<CommitRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('events_commits', 'readonly');
    const idx = (tx.objectStore('events_commits') as any).index('byTs');
    const req = idx.openCursor(null, 'prev');
    const out: CommitRecord[] = [];
    req.onsuccess = () => {
      const c = req.result as IDBCursorWithValue | null;
      if (!c || out.length >= limit) { resolve(out); return; }
      out.push(c.value as CommitRecord);
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getCommitEvents(commitId: string): Promise<EventRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('events', 'readonly');
    const idx = (tx.objectStore('events') as any).index('byCommit');
    const out: EventRecord[] = [];
    const range = IDBKeyRange.only(commitId);
    const cur = idx.openCursor(range);
    cur.onsuccess = () => {
      const c = cur.result as IDBCursorWithValue | null;
      if (!c) { resolve(out); return; }
      out.push(c.value as EventRecord);
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
}

export async function getCommit(commitId: string): Promise<CommitRecord | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('events_commits', 'readonly');
    const os = tx.objectStore('events_commits');
    const req = os.get(commitId);
    req.onsuccess = () => resolve((req.result as CommitRecord) || null);
    req.onerror = () => reject(req.error);
  });
}

// Purge local history (IDB) up to and including commits with ts <= cutoffTs
export async function purgeHistoryUpToTs(cutoffTs: number): Promise<number> {
  const db = await openDB();
  const toDelete: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('events_commits', 'readonly');
    const idx = (tx.objectStore('events_commits') as any).index('byTs');
    const range = IDBKeyRange.upperBound(cutoffTs);
    const cur = idx.openCursor(range);
    cur.onsuccess = () => {
      const c = cur.result as IDBCursorWithValue | null;
      if (!c) { resolve(); return; }
      const rec = c.value as CommitRecord;
      toDelete.push(rec.commitId);
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
  if (!toDelete.length) return 0;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['events_commits','events'] as any, 'readwrite');
    const cs = tx.objectStore('events_commits');
    const es = tx.objectStore('events');
    for (const cid of toDelete) cs.delete(cid);
    // delete events by commit via index
    const idx = (es as any).index('byCommit');
    let i = 0;
    const delFor = (cid: string, done: () => void) => {
      const range = IDBKeyRange.only(cid);
      const cur = idx.openCursor(range);
      cur.onsuccess = () => {
        const c = cur.result as IDBCursorWithValue | null;
        if (!c) { done(); return; }
        c.delete();
        c.continue();
      };
      cur.onerror = () => done();
    };
    const step = () => {
      if (i >= toDelete.length) return;
      const cid = toDelete[i++];
      delFor(cid, step);
    };
    step();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return toDelete.length;
}

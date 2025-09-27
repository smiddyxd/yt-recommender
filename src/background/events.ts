// Version history is disabled. This module provides no-op implementations
// to satisfy existing imports and calls across the codebase.

export type EventRecord = {
  id: string;
  commitId: string;
  ts: number;
  kind: string;
  payload: any;
  inverse?: any;
  impact?: { videos?: number; channels?: number; tags?: number; groups?: number };
  size?: number;
};

export type CommitRecord = {
  commitId: string;
  ts: number;
  summary: string;
  weight: number;
  size: number;
  counts: { events: number; videos?: number; channels?: number; tags?: number; groups?: number };
};

export function recordEvent(_kind: string, _payload: any, _opts?: { inverse?: any; impact?: EventRecord['impact'] }) {
  return; // no-op
}

export async function finalizeCommitAndFlushIfAny(): Promise<void> { return; }
export function queueCommitFlush(_delayMs?: number) { return; }
export async function listCommits(_limit?: number): Promise<CommitRecord[]> { return []; }
export async function getCommitEvents(_commitId: string): Promise<EventRecord[]> { return []; }
export async function getCommit(_commitId: string): Promise<CommitRecord | null> { return null; }
export async function replayUnsyncedCommitsToDrive(): Promise<number> { return 0; }
export async function purgeHistoryUpToTs(_cutoffTs: number): Promise<number> { return 0; }


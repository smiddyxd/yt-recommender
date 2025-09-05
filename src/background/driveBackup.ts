// Google Drive backup for settings & snapshots tailored to this extension.
// Scope: drive.appdata (hidden app folder). Auth via chrome.identity.launchWebAuthFlow.
// Plaintext storage only (no encryption).

import type { Group as GroupRec } from '../shared/conditions';
import type { TagRec, TagGroupRec } from '../types/messages';

// -------------------- Types --------------------
export type VideoIndexEntry = {
  id: string;
  tags?: string[];
  sources?: Array<{ type: string; id?: string | null }>;
  progressSec?: number | null;
  channelId?: string | null;
};

export type ChannelIndexEntry = { id: string; tags?: string[] };

export type PendingChannelEntry = { key: string; name?: string | null; handle?: string | null };

export type SettingsSnapshot = {
  version: 1;
  at: number;
  tags: TagRec[];
  tagGroups: TagGroupRec[];
  groups: GroupRec[]; // includes scrape?: boolean
  videoIndex: VideoIndexEntry[];
  channelIndex: ChannelIndexEntry[];
  pendingChannels: PendingChannelEntry[];
  // Future: add rules/prefs as needed
};

type TokenCache = { access_token: string; expires_at: number };

// -------------------- Config --------------------
// Client ID is stored in chrome.storage.local under KEY.clientId
const KEY = {
  token: 'drive.token',
  clientId: 'drive.clientId',
};

async function getClientId(): Promise<string> {
  const o = await chrome.storage.local.get(KEY.clientId);
  const id = String(o?.[KEY.clientId] || '');
  if (!id) throw new Error('Missing Google OAuth Client ID (set in Options → Backup)');
  return id;
}

const OAUTH_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const REDIRECT_URI = `https://${chrome.runtime.id}.chromiumapp.org/`;

// -------------------- Token --------------------
// Silent by default; callers pass interactive:true for user prompts.
async function getAccessToken(interactive: boolean = false): Promise<string> {
  const cached = await chrome.storage.local.get(KEY.token);
  const tok: TokenCache | undefined = cached[KEY.token];
  const now = Date.now();
  if (tok && tok.expires_at - 60_000 > now) return tok.access_token;

  const clientId = await getClientId();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'token',
    redirect_uri: REDIRECT_URI,
    scope: OAUTH_SCOPE,
    include_granted_scopes: 'true',
    prompt: interactive ? 'consent' : 'none',
  });
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;

  const cb = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive });
  if (!cb) throw new Error('OAuth cancelled');

  const hash = new URL(cb).hash.slice(1);
  const sp = new URLSearchParams(hash);
  const access_token = sp.get('access_token');
  const expires_in = Number(sp.get('expires_in') || '3600');
  if (!access_token) throw new Error('No access_token');

  const expires_at = Date.now() + expires_in * 1000;
  await chrome.storage.local.set({ [KEY.token]: { access_token, expires_at } });
  return access_token;
}

// -------------------- Drive helpers --------------------
async function driveFetch(path: string, init: RequestInit & { token: string }) {
  const { token, ...rest } = init;
  const resp = await fetch(`https://www.googleapis.com${path}`, {
    ...rest,
    headers: { ...(rest.headers || {}), Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}: ${await resp.text()}`);
  return resp;
}

async function findAppDataFileId(name: string, token: string): Promise<string | null> {
  const q = encodeURIComponent(`name='${name.replace(/'/g, "\\'")}' and trashed=false`);
  const resp = await driveFetch(
    `/drive/v3/files?q=${q}&spaces=appDataFolder&fields=files(id,name)&pageSize=1`,
    { method: 'GET', token }
  );
  const json = await resp.json();
  return json.files?.[0]?.id ?? null;
}

async function uploadJSONAppData(name: string, obj: unknown, token: string, fileId?: string) {
  if (!fileId) {
    // CREATE via multipart with parents
    const meta = { name, parents: ['appDataFolder'] };
    const boundary = 'batch_' + Math.random().toString(36).slice(2);
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify(meta) +
      `\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify(obj) +
      `\r\n--${boundary}--`;
    await driveFetch(`/upload/drive/v3/files?uploadType=multipart`, {
      method: 'POST',
      token,
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    return;
  }
  // UPDATE content only (no parents in metadata) using media upload
  await driveFetch(`/upload/drive/v3/files/${fileId}?uploadType=media`, {
    method: 'PATCH',
    token,
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(obj),
  });
}

// Resumable (for big files, optional)
async function startResumable(name: string, mime: string, token: string): Promise<string> {
  const meta = { name, parents: ['appDataFolder'] };
  const resp = await driveFetch(`/upload/drive/v3/files?uploadType=resumable`, {
    method: 'POST',
    token,
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mime },
    body: JSON.stringify(meta),
  });
  const session = resp.headers.get('Location');
  if (!session) throw new Error('No resumable session Location');
  return session;
}
async function uploadToSession(sessionUrl: string, data: Blob | ArrayBuffer, token: string) {
  const body = data instanceof Blob ? data : new Blob([data]);
  await fetch(sessionUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
    body,
  }).then(r => { if (!r.ok) throw new Error(`${r.status} ${r.statusText}`); });
}

// (No encryption helpers — plaintext storage only)

// -------------------- Public API --------------------
let settingsProducer: null | (() => Promise<SettingsSnapshot>) = null;
let debounceTimer: number | undefined;

export function registerSettingsProducer(fn: () => Promise<SettingsSnapshot>) {
  settingsProducer = fn;
}

// Expose current snapshot via the registered producer
export async function getCurrentSettingsSnapshot(): Promise<SettingsSnapshot> {
  if (!settingsProducer) throw new Error('No settings producer registered');
  return await settingsProducer();
}

export async function saveSettingsNow(
  snapshot: SettingsSnapshot,
  opts?: { interactive?: boolean }
) {
  const token = await getAccessToken(opts?.interactive ?? false);
  const name = 'settings.json';

  const fileId = await findAppDataFileId(name, token);
  await uploadJSONAppData(name, snapshot, token, fileId || undefined);
}

// Save a snapshot under a custom name (e.g., snapshots/settings-<ts>.json)
export async function saveSnapshotWithName(
  name: string,
  snapshot: SettingsSnapshot,
  opts?: { interactive?: boolean }
) {
  const token = await getAccessToken(opts?.interactive ?? false);
  const fileId = await findAppDataFileId(name, token);
  await uploadJSONAppData(name, snapshot, token, fileId || undefined);
}

export function queueSettingsBackup(opts?: { interactive?: boolean }) {
  if (!settingsProducer) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    try {
      try { chrome.runtime.sendMessage({ type: 'backup/progress', payload: {} }); } catch {}
      const snap = await settingsProducer!();
      await saveSettingsNow(snap, opts);
      try {
        const now = Date.now();
        chrome.storage?.local?.set({ lastBackupAt: now });
        chrome.runtime.sendMessage({ type: 'backup/done', payload: { at: now } });
      } catch {}
    } catch (e) {
      console.error('[driveBackup] settings backup failed:', e);
      try { chrome.runtime.sendMessage({ type: 'backup/error', payload: { message: (e as any)?.message || String(e) } }); } catch {}
    }
  }, 3000) as unknown as number;
}

export async function restoreSettings(opts?: { interactive?: boolean }): Promise<SettingsSnapshot | null> {
  const token = await getAccessToken(opts?.interactive ?? false);
  const name = 'settings.json';
  const id = await findAppDataFileId(name, token);
  if (!id) return null;
  const resp = await driveFetch(`/drive/v3/files/${id}?alt=media`, { method: 'GET', token });
  const raw = await resp.json();
  return raw as SettingsSnapshot;
}

// Optional: large snapshot (array -> JSONL)
export async function saveDataSnapshotNow(baseName: string, rows: unknown[], opts?: { interactive?: boolean }) {
  const token = await getAccessToken(opts?.interactive ?? false);
  const name = baseName.endsWith('.jsonl') ? baseName : `${baseName}.jsonl`;
  let payload = rows.map(r => JSON.stringify(r)).join('\n');

  const session = await startResumable(name, 'application/json', token);
  // Pass ArrayBuffer to satisfy uploadToSession signature
  await uploadToSession(session, new TextEncoder().encode(payload).buffer, token);
}

// Daily alarm (optional)
export function initDriveBackupAlarms() {
  chrome.alarms.create('drive.daily', { periodInMinutes: 60 * 24 });
  chrome.alarms.onAlarm.addListener(async (a) => {
    if (a.name !== 'drive.daily') return;
    try {
      if (settingsProducer) {
        const snap = await settingsProducer();
        await saveSettingsNow(snap);
      }
      // If you want weekly data snapshot, call saveDataSnapshotNow(...) here.
    } catch (e) {
      console.error('[driveBackup] daily alarm failed:', e);
    }
  });
}

// Settings for client id
export async function setClientId(id: string) {
  const val = (id || '').trim();
  if (!val) throw new Error('Empty client id');
  await chrome.storage.local.set({ [KEY.clientId]: val });
}
export async function getClientIdState(): Promise<string | null> {
  const o = await chrome.storage.local.get(KEY.clientId);
  const id = String(o?.[KEY.clientId] || '');
  return id || null;
}

// -------------------- File listing and download (appDataFolder) --------------------
export async function listAppDataFiles(opts?: { interactive?: boolean }): Promise<Array<{ id: string; name: string; size?: number | null; modifiedTime?: string | null; createdTime?: string | null }>> {
  const token = await getAccessToken(opts?.interactive ?? false);
  const fields = encodeURIComponent('files(id,name,size,modifiedTime,createdTime)');
  const resp = await driveFetch(`/drive/v3/files?spaces=appDataFolder&fields=${fields}&orderBy=modifiedTime%20desc`, { method: 'GET', token });
  const json = await resp.json();
  const files = Array.isArray(json?.files) ? json.files : [];
  return files.map((f: any) => ({ id: String(f.id), name: String(f.name || ''), size: f.size != null ? Number(f.size) : null, modifiedTime: f.modifiedTime || null, createdTime: f.createdTime || null }));
}

export async function downloadAppDataFileBase64(
  id: string,
  opts?: { interactive?: boolean }
): Promise<{ contentB64: string; name?: string | null; mimeType?: string | null }> {
  const token = await getAccessToken(opts?.interactive ?? false);
  // Get minimal metadata for name and mimeType
  const metaResp = await driveFetch(`/drive/v3/files/${encodeURIComponent(id)}?fields=name,mimeType`, { method: 'GET', token });
  const meta = await metaResp.json();
  const resp = await driveFetch(`/drive/v3/files/${encodeURIComponent(id)}?alt=media`, { method: 'GET', token });
  const buf = await resp.arrayBuffer();
  // Convert to base64
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  const contentB64 = btoa(s);
  return { contentB64, name: meta?.name || null, mimeType: meta?.mimeType || null };
}

// Upsert arbitrary text file (used for events JSONL). Creates or replaces content.
export async function upsertAppDataTextFile(
  name: string,
  text: string,
  opts?: { interactive?: boolean }
): Promise<void> {
  const token = await getAccessToken(opts?.interactive ?? false);
  const fileId = await findAppDataFileId(name, token);
  if (!fileId) {
    const meta = { name, parents: ['appDataFolder'] };
    const boundary = 'batch_' + Math.random().toString(36).slice(2);
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify(meta) +
      `\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n` +
      text +
      `\r\n--${boundary}--`;
    await driveFetch(`/upload/drive/v3/files?uploadType=multipart`, {
      method: 'POST', token,
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
  } else {
    await driveFetch(`/upload/drive/v3/files/${fileId}?uploadType=media`, {
      method: 'PATCH', token,
      headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
      body: text,
    });
  }
}

export async function deleteAppDataFile(id: string, opts?: { interactive?: boolean }): Promise<void> {
  const token = await getAccessToken(opts?.interactive ?? false);
  await driveFetch(`/drive/v3/files/${encodeURIComponent(id)}`, { method: 'DELETE', token });
}

// Load a JSON snapshot by Drive appData name (e.g., 'snapshots/settings-20250101.json')
export async function downloadSnapshotByName(
  name: string,
  opts?: { interactive?: boolean }
): Promise<SettingsSnapshot | null> {
  const token = await getAccessToken(opts?.interactive ?? false);
  const id = await findAppDataFileId(name, token);
  if (!id) return null;
  const resp = await driveFetch(`/drive/v3/files/${encodeURIComponent(id)}?alt=media`, { method: 'GET', token });
  const raw = await resp.json();
  return raw as SettingsSnapshot;
}

import { upsertVideo, moveToTrash, restoreFromTrash, applyTags, listChannels, wipeSourcesDuplicates, applyYouTubeVideo, openDB, missingChannelIds, applyYouTubeChannel, applyChannelTags, recomputeVideoTagsForAllChannels, recomputeVideoTagsForChannels, recomputeVideoTopicsMeta, readVideoTopicsMeta, listChannelIdsNeedingFetch, markChannelScraped, upsertChannelStub, moveChannelsToTrash, restoreChannelsFromTrash, listChannelsTrash, listTagGroups, createTagGroup, renameTagGroup, deleteTagGroup, setTagGroup, upsertPendingChannel, resolvePendingChannel } from './db';
import type { Msg } from '../types/messages';
import { dlog, derr } from '../types/debug';
import { listTags, createTag, renameTag, deleteTag } from './db';
import { listGroups, createGroup, updateGroup, deleteGroup } from './db';
import { matches, type Group as GroupRec } from '../shared/conditions';
import { registerSettingsProducer, saveSettingsNow, initDriveBackupAlarms, getClientIdState, setClientId, type SettingsSnapshot, restoreSettings, listAppDataFiles, downloadAppDataFileBase64 } from './driveBackup';

// Click the extension icon to trigger scrape in active tab
chrome.action?.onClicked.addListener((tab) => {
  try {
    if (!tab?.id) return;
    chrome.tabs.sendMessage(tab.id, { type: 'scrape/NOW', payload: {} }, () => void 0);
  } catch (e) {
    // ignore
  }
});

// --- Google Drive backup wiring ---
registerSettingsProducer(async (): Promise<SettingsSnapshot> => {
  const [tags, tagGroups, groups] = await Promise.all([
    listTags().catch(() => []),
    listTagGroups().catch(() => []),
    listGroups().catch(() => []),
  ]);
  return {
    version: 1 as const,
    at: Date.now(),
    tags: (tags as any) || [],
    tagGroups: (tagGroups as any) || [],
    groups: (groups as any) || [],
  };
});
initDriveBackupAlarms();

chrome.runtime.onMessage.addListener((raw: Msg, _sender, sendResponse) => {
  (async () => {
    dlog('onMessage:', raw?.type, raw?.payload ? Object.keys(raw.payload) : null);
    try {
      if (raw.type === 'cache/VIDEO_SEEN') {
        await upsertVideo(raw.payload);
        try { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } }); } catch {}
        sendResponse?.({ ok: true });
      } else if (raw.type === 'cache/VIDEO_STUB') {
        await upsertVideo(raw.payload);
        try { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } }); } catch {}
        sendResponse?.({ ok: true });
      } else if (raw.type === 'cache/VIDEO_PROGRESS') {
        const { id, current, duration, started, completed } = raw.payload;
        await upsertVideo({
          id,
          progress: { sec: current, duration },
          flags: { started: !!started, completed: !!completed }
        });
        try { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } }); } catch {}
        sendResponse?.({ ok: true });
      } else if (raw.type === 'cache/VIDEO_PROGRESS_PCT') {
        const { id, pct, started, completed } = raw.payload || {};
        const pctNum = Number(pct);
        if (id && Number.isFinite(pctNum)) {
          await upsertVideo({ id, progress: { pct: Math.max(0, Math.min(100, pctNum)) }, flags: { started: !!started, completed: !!completed } });
          try { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } }); } catch {}
          sendResponse?.({ ok: true });
        } else {
          sendResponse?.({ ok: false });
        }
      } else if (raw.type === 'groups/list') {
        const items = await listGroups();
        sendResponse?.({ ok: true, items });
      } else if (raw.type === 'channels/list') {
        const items = await listChannels();
        sendResponse?.({ ok: true, items });
      } else if (raw.type === 'channels/trashList') {
        const items = await listChannelsTrash();
        sendResponse?.({ ok: true, items });
      } else if (raw.type === 'topics/list') {
        try {
          let items = await readVideoTopicsMeta();
          if (!items || items.length === 0) {
            try { await recomputeVideoTopicsMeta(); items = await readVideoTopicsMeta(); } catch {}
          }
          sendResponse?.({ ok: true, items });
        } catch (e) {
          sendResponse?.({ ok: false, items: [] });
        }
      } else if (raw.type === 'groups/create') {
        const { name, condition } = raw.payload || {};
        await createGroup(name, condition);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'groups' } });
        sendResponse?.({ ok: true });
      } else if (raw.type === 'groups/update') {
        const { id, patch } = raw.payload || {};
        await updateGroup(id, patch);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'groups' } });
        sendResponse?.({ ok: true });
      } else if (raw.type === 'groups/delete') {
        const { id } = raw.payload || {};
        await deleteGroup(id);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'groups' } });
        sendResponse?.({ ok: true });
      } else if (raw.type === 'videos/applyTags') {
        const { ids, addIds = [], removeIds = [] } = raw.payload || {};
        dlog('videos/applyTags', { ids: ids?.length || 0, add: addIds.length, remove: removeIds.length });
        await applyTags(ids || [], addIds, removeIds);
        // Update channel videoTags for affected channels
        try {
          const chs = await channelIdsForVideos(ids || []);
          if (chs.length) await recomputeVideoTagsForChannels(chs);
          chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } });
        } catch {}
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } });
        sendResponse?.({ ok: true });
      } else if (raw.type === 'tags/list') {
        const items = await listTags();
        sendResponse?.({ ok: true, items });
      } else if (raw.type === 'tags/assignGroup') {
        const name = String(raw.payload?.name || '');
        const groupId = (raw.payload?.groupId ?? null) as (string | null);
        await setTagGroup(name, groupId);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'tags' } });
        sendResponse?.({ ok: true });
      } else if ((raw as any)?.type === 'channels/upsertStub') {
        const { id, name, handle } = (raw as any).payload || {};
        if (!id) { sendResponse?.({ ok: false }); return; }
        try {
          await upsertChannelStub(id, name, handle);
          chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } });
          sendResponse?.({ ok: true });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      } else if (raw.type === 'tags/create') {
        await createTag(raw.payload?.name, raw.payload?.color);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'tags' } });
        sendResponse?.({ ok: true });
      } else if (raw.type === 'tags/rename') {
        await renameTag(raw.payload?.oldName, raw.payload?.newName);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'tags' } });
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } }); // videos updated too
        try { await recomputeVideoTagsForAllChannels(); chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } }); } catch{}
        sendResponse?.({ ok: true });
  } else if (raw.type === 'tags/delete') {
        const cascade = raw.payload?.cascade ?? true;
        await deleteTag(raw.payload?.name, cascade);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'tags' } });
      if (cascade) { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } }); try { await recomputeVideoTagsForAllChannels(); chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } }); } catch{} }
      sendResponse?.({ ok: true });
      } else if (raw.type === 'tagGroups/list') {
        const items = await listTagGroups();
        sendResponse?.({ ok: true, items });
      } else if (raw.type === 'tagGroups/create') {
        const id = await createTagGroup(String(raw.payload?.name || ''));
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'tagGroups' } });
        sendResponse?.({ ok: true, id });
      } else if (raw.type === 'tagGroups/rename') {
        await renameTagGroup(String(raw.payload?.id || ''), String(raw.payload?.name || ''));
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'tagGroups' } });
        sendResponse?.({ ok: true });
      } else if (raw.type === 'tagGroups/delete') {
        await deleteTagGroup(String(raw.payload?.id || ''));
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'tagGroups' } });
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'tags' } });
        sendResponse?.({ ok: true });
    } else if (raw.type === 'channels/refreshUnfetched') {
      const apiKey = await getApiKey();
      if (!apiKey) { sendResponse?.({ ok: false, error: 'Missing API key' }); return; }
      try {
        const ids = await listChannelIdsNeedingFetch();
        const parts = ['snippet','statistics','brandingSettings'].join(',');
        const chunkSize = 50;
        let applied = 0;
        for (let i = 0; i < ids.length; i += chunkSize) {
          const batch = ids.slice(i, i + chunkSize);
          if (batch.length === 0) continue;
          try {
            const items = await fetchChannelsListWithRetry(parts, batch, apiKey);
            for (const ch of items) { try { await applyYouTubeChannel(ch); applied += 1; } catch {} }
          } catch (e: any) {
            const msg = e?.message || String(e);
            chrome.runtime.sendMessage({ type: 'refresh/error', payload: { scope: 'channels', batchStart: i, batchSize: batch.length, message: msg } });
          }
          await sleep(300);
        }
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } });
        sendResponse?.({ ok: true, count: applied });
      } catch (e: any) {
        sendResponse?.({ ok: false, error: e?.message || String(e) });
      }
    } else if (raw.type === 'channels/refreshByIds') {
      const ids: string[] = Array.isArray(raw.payload?.ids) ? raw.payload.ids.filter(Boolean) : [];
      const apiKey = await getApiKey();
      if (!apiKey) { sendResponse?.({ ok: false, error: 'Missing API key' }); return; }
      if (ids.length === 0) { sendResponse?.({ ok: true, count: 0 }); return; }
      try {
        const parts = ['snippet','statistics','brandingSettings'].join(',');
        const chunkSize = 50;
        let applied = 0;
        for (let i = 0; i < ids.length; i += chunkSize) {
          const batch = ids.slice(i, i + chunkSize);
          try {
            const items = await fetchChannelsListWithRetry(parts, batch, apiKey);
            for (const ch of items) { try { await applyYouTubeChannel(ch); applied += 1; } catch {} }
          } catch (e: any) {
            const msg = e?.message || String(e);
            chrome.runtime.sendMessage({ type: 'refresh/error', payload: { scope: 'channels', batchStart: i, batchSize: batch.length, message: msg } });
          }
          await sleep(300);
        }
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } });
        sendResponse?.({ ok: true, count: applied });
      } catch (e: any) {
        sendResponse?.({ ok: false, error: e?.message || String(e) });
      }
      } else if (raw.type === 'channels/applyTags') {
        const { ids, addIds = [], removeIds = [] } = raw.payload || {};
        dlog('channels/applyTags', { ids: ids?.length || 0, add: addIds.length, remove: removeIds.length });
        await applyChannelTags(ids || [], addIds, removeIds);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } });
        sendResponse?.({ ok: true });
      } else if (raw.type === 'channels/delete') {
        const ids: string[] = raw.payload?.ids || [];
        await moveChannelsToTrash(ids);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } });
        sendResponse?.({ ok: true });
      } else if (raw.type === 'channels/restore') {
        const ids: string[] = raw.payload?.ids || [];
        await restoreChannelsFromTrash(ids);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } });
        sendResponse?.({ ok: true });
      } else if (raw.type === 'channels/markScraped') {
        const { id, at, tab, count, totalVideoCountOnScrapeTime } = raw.payload || {};
        if (!id || !at) { sendResponse?.({ ok: false }); return; }
        try {
          await markChannelScraped(id, Number(at), { tab, count, totalVideoCountOnScrapeTime });
          chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } });
          sendResponse?.({ ok: true });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      } else if ((raw as any)?.type === 'channels/upsertPending') {
        const { key, name, handle } = (raw as any).payload || {};
        await upsertPendingChannel(String(key || ''), { name: name ?? null, handle: handle ?? null });
        // optional UI could listen to a 'channels' change, but pending are background-only for now
        sendResponse?.({ ok: true });
      } else if ((raw as any)?.type === 'channels/resolvePending') {
        const { id, name, handle } = (raw as any).payload || {};
        await resolvePendingChannel(String(id || ''), { name: name ?? null, handle: handle ?? null });
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } });
        sendResponse?.({ ok: true });
      } else if (raw.type === 'videos/delete') {
        const ids = raw.payload.ids || [];
        dlog('videos/delete count=', ids.length);
        await moveToTrash(ids);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } });
        dlog('videos/delete done');
        sendResponse?.({ ok: true });
      } else if (raw.type === 'videos/restore') {
        const ids = raw.payload.ids || [];
        console.log('[bg] videos/restore', ids.length);
        await restoreFromTrash(ids);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } });
        sendResponse?.({ ok: true });
      } else if (raw.type === 'videos/wipeSources') {
        await wipeSourcesDuplicates();
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } });
        sendResponse?.({ ok: true });
      } else if (raw.type === 'videos/applyYTBatch') {
        const items: any[] = raw.payload?.items || [];
        for (const it of items) {
          try { await applyYouTubeVideo(it); } catch { /* ignore individual item errors */ }
        }
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } });
        sendResponse?.({ ok: true, count: items.length });
      } else if (raw.type === 'videos/refreshAll') {
        const skipFetched = !!raw.payload?.skipFetched;
        const apiKey = await getApiKey();
        if (!apiKey) { sendResponse?.({ ok: false, error: 'Missing API key' }); return; }
        const ids = await listVideoIds({ skipFetched });
        const parts = [
          'snippet', 'contentDetails', 'status', 'statistics',
          'player', 'topicDetails', 'recordingDetails', 'liveStreamingDetails', 'localizations'
        ].join(',');
        const chunkSize = 50;
        const total = ids.length;
        let processed = 0; // ids attempted
        let applied = 0;   // items returned
        let failedBatches = 0;
        for (let i = 0; i < ids.length; i += chunkSize) {
          const batch = ids.slice(i, i + chunkSize);
          if (batch.length === 0) continue;
          processed += batch.length;
          try {
            const items = await fetchVideosListWithRetry(parts, batch, apiKey);
            applied += items.length;
            for (const it of items) {
              try { await applyYouTubeVideo(it); } catch { /* ignore */ }
            }
          } catch (e: any) {
            failedBatches += 1;
            const msg = e?.message || String(e);
            chrome.runtime.sendMessage({ type: 'refresh/error', payload: { batchStart: i, batchSize: batch.length, message: msg } });
          }
          chrome.runtime.sendMessage({ type: 'refresh/progress', payload: { processed, total, applied, failedBatches } });
          await sleep(300); // longer pause to reduce memory/CPU pressure
        }
        // After video refresh, build/refresh channel directory:
        // 1) fetch missing channels for any channel ids seen in videos
        // 2) also fetch any existing channel rows that have never been fetched (stubs)
        try {
          const chanIds = await listDistinctChannelIds();
          const missing = await missingChannelIds(chanIds);
          const stale = await listChannelIdsNeedingFetch();
          const toFetch = Array.from(new Set<string>([...missing, ...stale]));
          const chanChunk = 50;
          for (let j = 0; j < toFetch.length; j += chanChunk) {
            const batch = toFetch.slice(j, j + chanChunk);
            try {
              const items = await fetchChannelsListWithRetry(['snippet','statistics','brandingSettings'].join(','), batch, apiKey);
              for (const ch of items) { try { await applyYouTubeChannel(ch); } catch { /* ignore */ } }
            } catch (e: any) {
              const msg = e?.message || String(e);
              chrome.runtime.sendMessage({ type: 'refresh/error', payload: { scope: 'channels', batchStart: j, batchSize: batch.length, message: msg } });
            }
            await sleep(300);
          }
          chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } });
        } catch { /* ignore */ }
        try {
          // Compute videoTags for all channels now that videos' tags are current
          await recomputeVideoTagsForAllChannels();
          chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } });
        } catch {}
        try {
          await recomputeVideoTopicsMeta();
          chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'topics' } });
        } catch {}
        try { chrome.storage?.local?.set({ lastRefreshAt: Date.now() }); } catch {}
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } });
        chrome.runtime.sendMessage({ type: 'refresh/done', payload: { processed, total, applied, failedBatches, at: Date.now() } });
        sendResponse?.({ ok: true, processed, total, applied, failedBatches });
      } else if (raw.type === 'videos/stubsCount') {
        try {
          const db = await openDB();
          const tx = db.transaction('videos', 'readonly');
          const os = tx.objectStore('videos');
          const cur = os.openCursor();
          let count = 0;
          await new Promise<void>((resolve, reject) => {
            cur.onsuccess = () => {
              const c = cur.result as IDBCursorWithValue | null;
              if (!c) { resolve(); return; }
              const row: any = c.value;
              if (!Number.isFinite(row?.fetchedAt)) count += 1;
              c.continue();
            };
            cur.onerror = () => reject(cur.error);
          });
          sendResponse?.({ ok: true, count });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e), count: 0 });
        }
      }
      // --- Backup routes ---
      else if ((raw as any)?.type === 'backup/saveSettings') {
        const passphrase: string | undefined = (raw as any)?.payload?.passphrase || undefined;
        try {
          const snapshot = await (async (): Promise<SettingsSnapshot> => {
            const [tags, tagGroups, groups] = await Promise.all([
              listTags().catch(() => []),
              listTagGroups().catch(() => []),
              listGroups().catch(() => []),
            ]);
            return { version: 1, at: Date.now(), tags: tags as any, tagGroups: tagGroups as any, groups: groups as any };
          })();
          await saveSettingsNow(snapshot, passphrase ? { passphrase } : undefined);
          sendResponse?.({ ok: true });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      } else if ((raw as any)?.type === 'backup/getClientId') {
        try {
          const id = await getClientIdState();
          sendResponse?.({ ok: true, clientId: id });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      } else if ((raw as any)?.type === 'backup/setClientId') {
        try {
          const id = String((raw as any)?.payload?.clientId || '');
          await setClientId(id);
          sendResponse?.({ ok: true });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      } else if ((raw as any)?.type === 'backup/restoreSettings') {
        try {
          const passphrase: string | undefined = (raw as any)?.payload?.passphrase || undefined;
          const snap = await restoreSettings(passphrase ? { passphrase } : undefined);
          sendResponse?.({ ok: true, snapshot: snap });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      } else if ((raw as any)?.type === 'backup/listFiles') {
        try {
          const items = await listAppDataFiles();
          sendResponse?.({ ok: true, items });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e), items: [] });
        }
      } else if ((raw as any)?.type === 'backup/downloadFile') {
        try {
          const id = String((raw as any)?.payload?.id || '');
          if (!id) { sendResponse?.({ ok: false, error: 'Missing id' }); return; }
          const res = await downloadAppDataFileBase64(id);
          sendResponse?.({ ok: true, ...res });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      }
    } catch (e: any) {
      derr('bg handler error:', e?.message || e);
      sendResponse?.({ ok: false, error: e?.message || String(e) });
    }
  })();

  // IMPORTANT: keep the response channel open for async work
  return true;
});
self.addEventListener('unhandledrejection', (ev: any) => derr('unhandledrejection', ev?.reason));
self.addEventListener('error', (ev: any) => derr('error', ev?.message || ev));

async function getApiKey(): Promise<string | null> {
  return new Promise((resolve) => {
    try { chrome.storage?.local?.get('ytApiKey', (o) => resolve((o?.ytApiKey as string) || null)); }
    catch { resolve(null); }
  });
}

async function listVideoIds(opts: { skipFetched: boolean }): Promise<string[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('videos', 'readonly');
    const os = tx.objectStore('videos');
    const cur = os.openCursor();
    const ids: string[] = [];
    cur.onsuccess = () => {
      const c = cur.result as IDBCursorWithValue | null;
      if (!c) { resolve(ids); return; }
      const row: any = c.value;
      if (!opts.skipFetched || !row?.fetchedAt) ids.push(row?.id);
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
}

function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }

async function fetchVideosListWithRetry(parts: string, ids: string[], apiKey: string): Promise<any[]> {
  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.searchParams.set('part', parts);
  url.searchParams.set('id', ids.join(','));
  url.searchParams.set('key', apiKey);
  const maxAttempts = 3;
  let attempt = 0;
  let lastErr: any = null;
  while (attempt < maxAttempts) {
    try {
      const resp = await fetch(String(url));
      if (!resp.ok) {
        let detail = '';
        try { detail = await resp.text(); } catch { /* ignore */ }
        throw new Error(`videos.list ${resp.status} ${resp.statusText}${detail ? ' - ' + detail.slice(0, 240) : ''}`);
      }
      const data = await resp.json();
      const items = Array.isArray((data as any)?.items) ? (data as any).items : [];
      return items;
    } catch (e) {
      lastErr = e;
      attempt += 1;
      if (attempt >= maxAttempts) break;
      await sleep(500 * attempt * attempt); // 0.5s, 2s
    }
  }
  throw (lastErr || new Error('videos.list failed after retries'));
}

async function fetchChannelsListWithRetry(parts: string, ids: string[], apiKey: string): Promise<any[]> {
  const url = new URL('https://www.googleapis.com/youtube/v3/channels');
  url.searchParams.set('part', parts);
  url.searchParams.set('id', ids.join(','));
  url.searchParams.set('key', apiKey);
  const maxAttempts = 3;
  let attempt = 0;
  let lastErr: any = null;
  while (attempt < maxAttempts) {
    try {
      const resp = await fetch(String(url));
      if (!resp.ok) {
        let detail = '';
        try { detail = await resp.text(); } catch { /* ignore */ }
        throw new Error(`channels.list ${resp.status} ${resp.statusText}${detail ? ' - ' + detail.slice(0, 240) : ''}`);
      }
      const data = await resp.json();
      const items = Array.isArray((data as any)?.items) ? (data as any).items : [];
      return items;
    } catch (e) {
      lastErr = e;
      attempt += 1;
      if (attempt >= maxAttempts) break;
      await sleep(500 * attempt * attempt);
    }
  }
  throw (lastErr || new Error('channels.list failed after retries'));
}

async function listDistinctChannelIds(): Promise<string[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('videos', 'readonly');
    const os = tx.objectStore('videos');
    const idx = os.index('byChannel');
    const set = new Set<string>();
    const cur = idx.openCursor();
    cur.onsuccess = () => {
      const c = cur.result as IDBCursorWithValue | null;
      if (!c) { resolve(Array.from(set)); return; }
      const row: any = c.value;
      const chId = row?.channelId;
      if (chId) set.add(chId);
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
}

async function channelIdsForVideos(ids: string[]): Promise<string[]> {
  const set = new Set<string>();
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('videos', 'readonly');
    const os = tx.objectStore('videos');
    (async () => {
      for (const id of ids) {
        await new Promise<void>((res, rej) => {
          const g = os.get(id);
          g.onsuccess = () => { const row: any = g.result; if (row?.channelId) set.add(row.channelId); res(); };
          g.onerror = () => rej(g.error);
        });
      }
    })().then(() => (tx as any).commit?.());
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return Array.from(set);
}

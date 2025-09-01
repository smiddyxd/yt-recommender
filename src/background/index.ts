import { upsertVideo, moveToTrash, restoreFromTrash, applyTags, listChannels, wipeSourcesDuplicates, applyYouTubeVideo, openDB, missingChannelIds, applyYouTubeChannel, applyChannelTags, recomputeVideoTagsForAllChannels, recomputeVideoTagsForChannels, recomputeVideoTopicsMeta, readVideoTopicsMeta, listChannelIdsNeedingFetch, markChannelScraped, upsertChannelStub, moveChannelsToTrash, restoreChannelsFromTrash, listChannelsTrash, listTagGroups, createTagGroup, renameTagGroup, deleteTagGroup, setTagGroup, upsertPendingChannel, resolvePendingChannel } from './db';
import type { Msg } from '../types/messages';
import { dlog, derr } from '../types/debug';
import { listTags, createTag, renameTag, deleteTag } from './db';
import { listGroups, createGroup, updateGroup, deleteGroup } from './db';
import { matches, type Group as GroupRec } from '../shared/conditions';
import { registerSettingsProducer, saveSettingsNow, initDriveBackupAlarms, getClientIdState, setClientId, type SettingsSnapshot, restoreSettings, listAppDataFiles, downloadAppDataFileBase64, queueSettingsBackup, deleteAppDataFile, upsertAppDataTextFile } from './driveBackup';
import { recordEvent, finalizeCommitAndFlushIfAny, listCommits as listHistoryCommits, getCommitEvents as getHistoryCommitEvents, getCommit as getHistoryCommit, queueCommitFlush, purgeHistoryUpToTs } from './events';

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
  const db = await openDB();
  const videoIndex: Array<{ id: string; tags?: string[]; sources?: Array<{ type: string; id?: string | null }>; progressSec?: number | null; channelId?: string | null }> = [];
  const channelIndex: Array<{ id: string; tags?: string[] }> = [];
  const pendingChannels: Array<{ key: string; name?: string | null; handle?: string | null }> = [];
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['videos', 'channels', 'channels_pending'] as any, 'readonly');
    // videos
    try {
      const vs = tx.objectStore('videos');
      const curV = vs.openCursor();
      curV.onsuccess = () => {
        const c = curV.result as IDBCursorWithValue | null;
        if (!c) return;
        const r: any = c.value || {};
        const entry: any = { id: r.id };
        if (Array.isArray(r.tags) && r.tags.length) entry.tags = r.tags.slice();
        if (Array.isArray(r.sources) && r.sources.length) entry.sources = r.sources.map((s: any) => ({ type: String(s?.type || ''), id: (s?.id ?? null) }));
        let ps: number | null = null;
        try {
          const sec = Number(r?.progress?.sec);
          if (Number.isFinite(sec) && sec > 0) ps = Math.floor(sec);
          else {
            const pct = Number(r?.progress?.pct);
            const dur = Number(r?.progress?.duration ?? r?.durationSec);
            if (Number.isFinite(pct) && Number.isFinite(dur) && dur > 0) ps = Math.floor(Math.max(0, Math.min(100, pct)) / 100 * dur);
          }
        } catch {}
        if (ps != null) entry.progressSec = ps;
        if (r.channelId) entry.channelId = r.channelId;
        videoIndex.push(entry);
        c.continue();
      };
      curV.onerror = () => reject(curV.error);
    } catch {}
    // channels
    try {
      const cs = tx.objectStore('channels');
      const curC = cs.openCursor();
      curC.onsuccess = () => {
        const c = curC.result as IDBCursorWithValue | null;
        if (!c) return;
        const r: any = c.value || {};
        const entry: any = { id: r.id };
        if (Array.isArray(r.tags) && r.tags.length) entry.tags = r.tags.slice();
        channelIndex.push(entry);
        c.continue();
      };
      curC.onerror = () => reject(curC.error);
    } catch {}
    // pending channels
    try {
      const ps = (tx as any).objectStore('channels_pending') as IDBObjectStore;
      const curP = ps.openCursor();
      curP.onsuccess = () => {
        const c = curP.result as IDBCursorWithValue | null;
        if (!c) return;
        const r: any = c.value || {};
        pendingChannels.push({ key: String(r.key || ''), name: r.name ?? null, handle: r.handle ?? null });
        c.continue();
      };
      curP.onerror = () => reject(curP.error);
    } catch {}
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return {
    version: 1 as const,
    at: Date.now(),
    tags: (tags as any) || [],
    tagGroups: (tagGroups as any) || [],
    groups: (groups as any) || [],
    videoIndex,
    channelIndex,
    pendingChannels,
  };
});
initDriveBackupAlarms();

async function scheduleBackup() {
  try { queueCommitFlush(3000); } catch {}
  try { queueSettingsBackup(); } catch {}
}

chrome.runtime.onMessage.addListener((raw: Msg, _sender, sendResponse) => {
  (async () => {
    dlog('onMessage:', raw?.type, raw?.payload ? Object.keys(raw.payload) : null);
    try {
      if (raw.type === 'cache/VIDEO_SEEN') {
        await upsertVideo(raw.payload);
        try { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } }); } catch {}
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if (raw.type === 'cache/VIDEO_STUB') {
        await upsertVideo(raw.payload);
        try { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } }); } catch {}
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if (raw.type === 'cache/VIDEO_PROGRESS') {
        const { id, current, duration, started, completed } = raw.payload;
        await upsertVideo({
          id,
          progress: { sec: current, duration },
          flags: { started: !!started, completed: !!completed }
        });
        try { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } }); } catch {}
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if (raw.type === 'cache/VIDEO_PROGRESS_PCT') {
        const { id, pct, started, completed } = raw.payload || {};
        const pctNum = Number(pct);
        if (id && Number.isFinite(pctNum)) {
          await upsertVideo({ id, progress: { pct: Math.max(0, Math.min(100, pctNum)) }, flags: { started: !!started, completed: !!completed } });
          try { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } }); } catch {}
          scheduleBackup();
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
        recordEvent('groups/create', { name }, { impact: { groups: 1 } });
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if (raw.type === 'groups/update') {
        const { id, patch } = raw.payload || {};
        await updateGroup(id, patch);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'groups' } });
        recordEvent('groups/update', { id, patch }, { impact: { groups: 1 } });
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if (raw.type === 'groups/delete') {
        const { id } = raw.payload || {};
        await deleteGroup(id);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'groups' } });
        recordEvent('groups/delete', { id }, { impact: { groups: 1 } });
        scheduleBackup();
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
        recordEvent('videos/applyTags', { ids: ids || [], addIds, removeIds }, { impact: { videos: (ids || []).length, tags: addIds.length + removeIds.length } });
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if (raw.type === 'tags/list') {
        const items = await listTags();
        sendResponse?.({ ok: true, items });
      } else if (raw.type === 'tags/assignGroup') {
        const name = String(raw.payload?.name || '');
        const groupId = (raw.payload?.groupId ?? null) as (string | null);
        await setTagGroup(name, groupId);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'tags' } });
        recordEvent('tags/assignGroup', { name, groupId }, { impact: { tags: 1 } });
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if ((raw as any)?.type === 'channels/upsertStub') {
        const { id, name, handle } = (raw as any).payload || {};
        if (!id) { sendResponse?.({ ok: false }); return; }
        try {
          await upsertChannelStub(id, name, handle);
          chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } });
          recordEvent('pending/resolve', { id, name, handle }, { impact: { channels: 1 } });
          scheduleBackup();
          sendResponse?.({ ok: true });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      } else if (raw.type === 'tags/create') {
        await createTag(raw.payload?.name, raw.payload?.color);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'tags' } });
        recordEvent('tags/create', { name: raw.payload?.name }, { impact: { tags: 1 } });
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if (raw.type === 'tags/rename') {
        await renameTag(raw.payload?.oldName, raw.payload?.newName);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'tags' } });
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } }); // videos updated too
        try { await recomputeVideoTagsForAllChannels(); chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } }); } catch{}
        recordEvent('tags/rename', { from: raw.payload?.oldName, to: raw.payload?.newName }, { impact: { tags: 1 } });
        scheduleBackup();
        sendResponse?.({ ok: true });
  } else if (raw.type === 'tags/delete') {
        const cascade = raw.payload?.cascade ?? true;
        await deleteTag(raw.payload?.name, cascade);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'tags' } });
      if (cascade) { chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } }); try { await recomputeVideoTagsForAllChannels(); chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } }); } catch{} }
      recordEvent('tags/delete', { name: raw.payload?.name, cascade }, { impact: { tags: 1 } });
      scheduleBackup();
      sendResponse?.({ ok: true });
      } else if (raw.type === 'tagGroups/list') {
        const items = await listTagGroups();
        sendResponse?.({ ok: true, items });
      } else if (raw.type === 'tagGroups/create') {
        const id = await createTagGroup(String(raw.payload?.name || ''));
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'tagGroups' } });
        recordEvent('tagGroups/create', { id, name: String(raw.payload?.name || '') }, { impact: {} });
        scheduleBackup();
        sendResponse?.({ ok: true, id });
      } else if (raw.type === 'tagGroups/rename') {
        await renameTagGroup(String(raw.payload?.id || ''), String(raw.payload?.name || ''));
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'tagGroups' } });
        recordEvent('tagGroups/rename', { id: String(raw.payload?.id || ''), name: String(raw.payload?.name || '') }, { impact: {} });
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if (raw.type === 'tagGroups/delete') {
        await deleteTagGroup(String(raw.payload?.id || ''));
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'tagGroups' } });
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'tags' } });
        recordEvent('tagGroups/delete', { id: String(raw.payload?.id || '') }, { impact: {} });
        scheduleBackup();
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
        recordEvent('channels/applyTags', { ids: ids || [], addIds, removeIds }, { impact: { channels: (ids || []).length, tags: addIds.length + removeIds.length } });
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if (raw.type === 'channels/delete') {
        const ids: string[] = raw.payload?.ids || [];
        await moveChannelsToTrash(ids);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } });
        recordEvent('channels/delete', { ids }, { impact: { channels: ids.length } });
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if (raw.type === 'channels/restore') {
        const ids: string[] = raw.payload?.ids || [];
        await restoreChannelsFromTrash(ids);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } });
        recordEvent('channels/restore', { ids }, { impact: { channels: ids.length } });
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if (raw.type === 'channels/markScraped') {
        const { id, at, tab, count, totalVideoCountOnScrapeTime } = raw.payload || {};
        if (!id || !at) { sendResponse?.({ ok: false }); return; }
        try {
          await markChannelScraped(id, Number(at), { tab, count, totalVideoCountOnScrapeTime });
          chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } });
          recordEvent('channels/markScraped', { id, at, tab, count }, { impact: { channels: 1 } });
          sendResponse?.({ ok: true });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      } else if ((raw as any)?.type === 'channels/upsertPending') {
        const { key, name, handle } = (raw as any).payload || {};
        await upsertPendingChannel(String(key || ''), { name: name ?? null, handle: handle ?? null });
        // optional UI could listen to a 'channels' change, but pending are background-only for now
        recordEvent('pending/upsert', { key: String(key || ''), name: name ?? null, handle: handle ?? null }, { impact: {} });
        sendResponse?.({ ok: true });
      } else if ((raw as any)?.type === 'channels/resolvePending') {
        const { id, name, handle } = (raw as any).payload || {};
        await resolvePendingChannel(String(id || ''), { name: name ?? null, handle: handle ?? null });
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'channels' } });
        recordEvent('pending/resolve', { id: String(id || ''), name: name ?? null, handle: handle ?? null }, { impact: { channels: 1 } });
        sendResponse?.({ ok: true });
      } else if (raw.type === 'videos/delete') {
        const ids = raw.payload.ids || [];
        dlog('videos/delete count=', ids.length);
        await moveToTrash(ids);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } });
        recordEvent('videos/delete', { ids }, { impact: { videos: ids.length } });
        scheduleBackup();
        dlog('videos/delete done');
        sendResponse?.({ ok: true });
      } else if (raw.type === 'videos/restore') {
        const ids = raw.payload.ids || [];
        console.log('[bg] videos/restore', ids.length);
        await restoreFromTrash(ids);
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } });
        recordEvent('videos/restore', { ids }, { impact: { videos: ids.length } });
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if (raw.type === 'videos/wipeSources') {
        await wipeSourcesDuplicates();
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } });
        recordEvent('videos/wipeSources', {}, { impact: {} });
        scheduleBackup();
        sendResponse?.({ ok: true });
      } else if (raw.type === 'videos/applyYTBatch') {
        const items: any[] = raw.payload?.items || [];
        for (const it of items) {
          try { await applyYouTubeVideo(it); } catch { /* ignore individual item errors */ }
        }
        chrome.runtime.sendMessage({ type: 'db/change', payload: { entity: 'videos' } });
        scheduleBackup();
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
              try {
                // Selective API-change history: title/description diffs
                const id = it?.id;
                if (id) {
                  try {
                    const db = await openDB();
                    await new Promise<void>((resolve, reject) => {
                      const tx = db.transaction('videos', 'readonly');
                      const os = tx.objectStore('videos');
                      const g = os.get(id);
                      g.onsuccess = () => {
                        const prev: any = g.result || null;
                        const prevTitle = prev?.title || null;
                        const prevDesc = typeof prev?.description === 'string' ? prev.description : null;
                        const prevThumb = (prev?.thumbUrl || null) as (string | null);
                        const sn = it?.snippet || {};
                        const nextTitle: string | null = sn?.title || null;
                        const nextDesc: string | null = (typeof sn?.description === 'string') ? sn.description : null;
                        const nextThumb: string | null = bestThumb(sn?.thumbnails) || null;
                        const changed: any = {};
                        if (prevTitle != null && nextTitle != null && prevTitle !== nextTitle) changed.title = { from: prevTitle, to: nextTitle };
                        if (prevDesc != null && nextDesc != null && prevDesc !== nextDesc) changed.description = { from: trimText(prevDesc), to: trimText(nextDesc) };
                        if (prevThumb != null && nextThumb != null && prevThumb !== nextThumb) changed.thumbnailUrl = { from: prevThumb, to: nextThumb };
                        if (Object.keys(changed).length) {
                          try { recordEvent('videos/attrChanged', { id, changed }, { impact: { videos: 1 } }); } catch {}
                        }
                        resolve();
                      };
                      g.onerror = () => reject(g.error);
                    });
                  } catch {}
                }
                await applyYouTubeVideo(it);
              } catch { /* ignore */ }
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
              for (const ch of items) {
                try {
                  const id = ch?.id;
                  if (id) {
                    try {
                      const db = await openDB();
                      await new Promise<void>((resolve, reject) => {
                        const tx = db.transaction('channels', 'readonly');
                        const os = tx.objectStore('channels');
                        const g = os.get(id);
                        g.onsuccess = () => {
                          const prev: any = g.result || null;
                          const prevAvatar = bestThumb(prev?.thumbnails) || null;
                          const prevBanner = (prev?.bannerUrl || null) as (string | null);
                          const prevDesc = typeof prev?.description === 'string' ? prev.description : null;
                          const sn = ch?.snippet || {};
                          const branding = ch?.brandingSettings || {};
                          const nextAvatar = bestThumb(sn?.thumbnails) || null;
                          const nextBanner = (branding?.image?.bannerExternalUrl as string) || null;
                          const nextDesc = (typeof sn?.description === 'string') ? sn.description : null;
                          const changed: any = {};
                          if (prevAvatar != null && nextAvatar != null && prevAvatar !== nextAvatar) changed.avatarUrl = { from: prevAvatar, to: nextAvatar };
                          if (prevBanner != null && nextBanner != null && prevBanner !== nextBanner) changed.bannerUrl = { from: prevBanner, to: nextBanner };
                          if (prevDesc != null && nextDesc != null && prevDesc !== nextDesc) changed.description = { from: trimText(prevDesc), to: trimText(nextDesc) };
                          if (Object.keys(changed).length) {
                            try { recordEvent('channels/attrChanged', { id, changed }, { impact: { channels: 1 } }); } catch {}
                          }
                          resolve();
                        };
                        g.onerror = () => reject(g.error);
                      });
                    } catch {}
                  }
                  await applyYouTubeChannel(ch);
                } catch { /* ignore */ }
              }
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
        scheduleBackup();
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
          try { chrome.runtime.sendMessage({ type: 'backup/progress', payload: {} }); } catch {}
          const snapshot = await (async (): Promise<SettingsSnapshot> => {
            const [tags, tagGroups, groups] = await Promise.all([
              listTags().catch(() => []),
              listTagGroups().catch(() => []),
              listGroups().catch(() => []),
            ]);
            // Also include compact indices
            const db = await openDB();
            const videoIndex: any[] = [];
            const channelIndex: any[] = [];
            const pendingChannels: any[] = [];
            await new Promise<void>((resolve, reject) => {
              const tx = db.transaction(['videos','channels','channels_pending'] as any, 'readonly');
              const vs = tx.objectStore('videos');
              const curV = vs.openCursor();
              curV.onsuccess = () => {
                const c = curV.result as IDBCursorWithValue | null;
                if (!c) return;
                const r: any = c.value || {};
                const entry: any = { id: r.id };
                if (Array.isArray(r.tags) && r.tags.length) entry.tags = r.tags.slice();
                if (Array.isArray(r.sources) && r.sources.length) entry.sources = r.sources.map((s: any) => ({ type: String(s?.type || ''), id: (s?.id ?? null) }));
                let ps: number | null = null;
                try {
                  const sec = Number(r?.progress?.sec);
                  if (Number.isFinite(sec) && sec > 0) ps = Math.floor(sec);
                  else {
                    const pct = Number(r?.progress?.pct);
                    const dur = Number(r?.progress?.duration ?? r?.durationSec);
                    if (Number.isFinite(pct) && Number.isFinite(dur) && dur > 0) ps = Math.floor(Math.max(0, Math.min(100, pct)) / 100 * dur);
                  }
                } catch {}
                if (ps != null) entry.progressSec = ps;
                if (r.channelId) entry.channelId = r.channelId;
                videoIndex.push(entry);
                c.continue();
              };
              curV.onerror = () => reject(curV.error);
              const cs = tx.objectStore('channels');
              const curC = cs.openCursor();
              curC.onsuccess = () => {
                const c = curC.result as IDBCursorWithValue | null;
                if (!c) return;
                const r: any = c.value || {};
                const entry: any = { id: r.id };
                if (Array.isArray(r.tags) && r.tags.length) entry.tags = r.tags.slice();
                channelIndex.push(entry);
                c.continue();
              };
              curC.onerror = () => reject(curC.error);
              const ps = (tx as any).objectStore('channels_pending') as IDBObjectStore;
              const curP = ps.openCursor();
              curP.onsuccess = () => {
                const c = curP.result as IDBCursorWithValue | null;
                if (!c) return;
                const r: any = c.value || {};
                pendingChannels.push({ key: String(r.key || ''), name: r.name ?? null, handle: r.handle ?? null });
                c.continue();
              };
              curP.onerror = () => reject(curP.error);
              tx.oncomplete = () => resolve();
              tx.onerror = () => reject(tx.error);
            });
            return { version: 1, at: Date.now(), tags: tags as any, tagGroups: tagGroups as any, groups: groups as any, videoIndex, channelIndex, pendingChannels };
          })();
          await saveSettingsNow(snapshot, passphrase ? { passphrase } : undefined);
          try { const now = Date.now(); chrome.storage?.local?.set({ lastBackupAt: now }); chrome.runtime.sendMessage({ type: 'backup/done', payload: { at: now } }); } catch {}
          sendResponse?.({ ok: true });
        } catch (e: any) {
          try { chrome.runtime.sendMessage({ type: 'backup/error', payload: { message: e?.message || String(e) } }); } catch {}
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
      } else if ((raw as any)?.type === 'backup/history/list') {
        try {
          const limit = Number((raw as any)?.payload?.limit || 100);
          const commits = await listHistoryCommits(limit);
          sendResponse?.({ ok: true, commits });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e), commits: [] });
        }
      } else if ((raw as any)?.type === 'backup/history/getCommit') {
        try {
          const cid = String((raw as any)?.payload?.commitId || '');
          if (!cid) { sendResponse?.({ ok: false, error: 'Missing commitId' }); return; }
          const events = await getHistoryCommitEvents(cid);
          const text = events.map(ev => JSON.stringify({ ts: ev.ts, kind: ev.kind, payload: ev.payload, impact: ev.impact })).join('\n') + '\n';
          const b64 = btoa(text);
          sendResponse?.({ ok: true, contentB64: b64, name: `commit-${cid}.jsonl`, mimeType: 'text/plain' });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      } else if ((raw as any)?.type === 'backup/history/usage') {
        try {
          const items = await listAppDataFiles();
          const total = items.reduce((n, f) => n + (Number(f.size) || 0), 0);
          sendResponse?.({ ok: true, totalBytes: total, files: items.length });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      } else if ((raw as any)?.type === 'backup/history/getUpTo') {
        try {
          const cid = String((raw as any)?.payload?.commitId || '');
          if (!cid) { sendResponse?.({ ok: false, error: 'Missing commitId' }); return; }
          const commit = await getHistoryCommit(cid);
          if (!commit) { sendResponse?.({ ok: false, error: 'Unknown commitId' }); return; }
          const commitMonth = (() => { const d = new Date(commit.ts); const y=d.getUTCFullYear(); const m=String(d.getUTCMonth()+1).padStart(2,'0'); return `${y}-${m}`; })();
          const files = await listAppDataFiles();
          // Collect earlier full months and partial of commit month
          const out: Array<{ name: string; contentB64: string }> = [];
          for (const f of files) {
            const name = f.name || '';
            if (name.startsWith('events-') && name.endsWith('.jsonl')) {
              const month = name.substring('events-'.length, 'events-'.length+7);
              if (month < commitMonth) {
                // full file
                const one = await downloadAppDataFileBase64(f.id);
                out.push({ name, contentB64: one.contentB64 });
              } else if (month === commitMonth) {
                const one = await downloadAppDataFileBase64(f.id);
                const text = atob(one.contentB64);
                const lines = text.split('\n');
                const header = lines[0] || '';
                const keep: string[] = [header];
                for (let i=1;i<lines.length;i++) {
                  const line = lines[i];
                  if (!line.trim()) continue;
                  try {
                    const obj = JSON.parse(line);
                    keep.push(line);
                    if (obj?.commitId === cid) {
                      // Stop after we included this commit's events
                      break;
                    }
                  } catch { /* ignore parse errors */ }
                }
                const partial = keep.join('\n') + '\n';
                const b64 = btoa(partial);
                out.push({ name: `${name.replace(/\.jsonl$/, '')}-upTo-${cid}.jsonl`, contentB64: b64 });
              }
            } else if (name.startsWith('snapshots/')) {
              // include snapshots older than commit ts
              const t = Date.parse(String(f.modifiedTime || '')) || 0;
              if (t > 0 && t <= commit.ts) {
                const one = await downloadAppDataFileBase64(f.id);
                out.push({ name, contentB64: one.contentB64 });
              }
            }
          }
          sendResponse?.({ ok: true, files: out });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      } else if ((raw as any)?.type === 'backup/history/deleteUpTo') {
        try {
          const cid = String((raw as any)?.payload?.commitId || '');
          if (!cid) { sendResponse?.({ ok: false, error: 'Missing commitId' }); return; }
          const commit = await getHistoryCommit(cid);
          if (!commit) { sendResponse?.({ ok: false, error: 'Unknown commitId' }); return; }
          const commitMonth = (() => { const d = new Date(commit.ts); const y=d.getUTCFullYear(); const m=String(d.getUTCMonth()+1).padStart(2,'0'); return `${y}-${m}`; })();
          const files = await listAppDataFiles();
          let deleted = 0;
          // Delete full earlier months and older snapshots; rewrite partial month after commit
          for (const f of files) {
            const name = f.name || '';
            if (name.startsWith('events-') && name.endsWith('.jsonl')) {
              const month = name.substring('events-'.length, 'events-'.length+7);
              if (month < commitMonth) {
                await deleteAppDataFile(f.id); deleted++;
              } else if (month === commitMonth) {
                const one = await downloadAppDataFileBase64(f.id);
                const text = atob(one.contentB64);
                const lines = text.split('\n');
                const header = lines[0] || '';
                const keep: string[] = [header];
                let reached = false;
                for (let i=1;i<lines.length;i++) {
                  const line = lines[i];
                  if (!line.trim()) continue;
                  if (!reached) {
                    try { const obj = JSON.parse(line); if (obj?.commitId === cid) { reached = true; } } catch {}
                    continue; // skip until reached
                  } else {
                    keep.push(line);
                  }
                }
                const remain = keep.join('\n');
                await upsertAppDataTextFile(name, remain);
              }
            } else if (name.startsWith('snapshots/')) {
              const t = Date.parse(String(f.modifiedTime || '')) || 0;
              if (t > 0 && t <= commit.ts) { await deleteAppDataFile(f.id); deleted++; }
            }
          }
          // Remove existing cutoff markers and write a single cutoff.json
          try {
            const all = await listAppDataFiles();
            for (const f of all) { if ((f.name || '').startsWith('cutoff')) { try { await deleteAppDataFile(f.id); } catch {} } }
          } catch {}
          const marker = { cutoffAtCommitId: cid, cutoffAtTs: commit.ts, createdAt: Date.now() };
          await upsertAppDataTextFile(`cutoff.json`, JSON.stringify(marker, null, 2));
          // Purge local history up to this commit so UI reflects deletion
          try { await purgeHistoryUpToTs(commit.ts); } catch {}
          sendResponse?.({ ok: true, deleted });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      } else if ((raw as any)?.type === 'backup/history/import') {
        try {
          const filesIn: Array<{ name: string; contentB64: string }> = Array.isArray((raw as any)?.payload?.files) ? (raw as any).payload.files : [];
          if (!filesIn.length) { sendResponse?.({ ok: false, error: 'No files' }); return; }
          // Find imported cutoff commit from an '-upTo-<cid>' filename or cutoff marker content
          let importedCutoffCid: string | null = null;
          for (const f of filesIn) {
            const m = /^events-\d{4}-\d{2}-upTo-([^.]+)\.jsonl$/.exec(f.name);
            if (m) { importedCutoffCid = m[1]; break; }
          }
          if (!importedCutoffCid) {
            // Try to parse cutoff marker within imported files
            for (const f of filesIn) {
              if (f.name.startsWith('cutoff-') && f.name.endsWith('.json')) {
                try { const text = atob(f.contentB64); const obj = JSON.parse(text); if (obj?.cutoffAtCommitId) { importedCutoffCid = String(obj.cutoffAtCommitId); break; } } catch {}
              }
            }
          }
          // Validate against current Drive cutoff marker (if any)
          try {
            const currentFiles = await listAppDataFiles();
            // Prefer cutoff.json, otherwise latest cutoff-* marker
            let chosen = currentFiles.find(f => (f.name || '') === 'cutoff.json') || null as any;
            if (!chosen) {
              const cutoffFiles = currentFiles.filter(f => (f.name || '').startsWith('cutoff'));
              if (!cutoffFiles.length) { sendResponse?.({ ok: false, error: 'No cutoff marker present in Drive; delete up to a commit first.' }); return; }
              chosen = cutoffFiles[0];
              for (const c of cutoffFiles) {
                if ((Date.parse(String(c.modifiedTime || '')) || 0) > (Date.parse(String(chosen.modifiedTime || '')) || 0)) chosen = c;
              }
            }
            const marker = await downloadAppDataFileBase64(chosen.id);
            const markerObj = (()=>{ try { return JSON.parse(atob(marker.contentB64)); } catch { return null; } })();
            const expectedCid = markerObj?.cutoffAtCommitId ? String(markerObj.cutoffAtCommitId) : null;
            if (!importedCutoffCid || !expectedCid || importedCutoffCid !== expectedCid) {
              sendResponse?.({ ok: false, error: 'Imported history does not match Drive cutoff marker.' });
              return;
            }
            // Process files: events and snapshots
            for (const f of filesIn) {
              if (f.name.startsWith('events-') && f.name.endsWith('.jsonl')) {
                const m = /^events-(\d{4}-\d{2})(?:-upTo-[^.]+)?\.jsonl$/.exec(f.name);
                if (!m) continue;
                const month = m[1];
                const baseName = `events-${month}.jsonl`;
                const current = currentFiles.find(x => x.name === baseName);
                const importedText = atob(f.contentB64);
                if (!current) {
                  // Write imported (strip suffix in name)
                  await upsertAppDataTextFile(baseName, importedText);
                } else {
                  // Merge: imported is earlier part; existing is later part -> remove header from later part and concat
                  const existing = await downloadAppDataFileBase64(current.id);
                  const exText = atob(existing.contentB64);
                  const exLines = exText.split('\n');
                  const exBody = exLines.slice(1).join('\n');
                  const merged = importedText.replace(/\n*$/, '\n') + exBody;
                  await upsertAppDataTextFile(baseName, merged);
                }
              } else if (f.name.startsWith('snapshots/')) {
                await upsertAppDataTextFile(f.name, atob(f.contentB64));
              }
            }
            // Delete cutoff marker after successful import
            await deleteAppDataFile(chosen.id);
            sendResponse?.({ ok: true });
          } catch (e: any) {
            sendResponse?.({ ok: false, error: e?.message || String(e) });
          }
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

function bestThumb(thumbs: any): string | null {
  try {
    return (thumbs?.high?.url || thumbs?.medium?.url || thumbs?.default?.url || null) as (string | null);
  } catch { return null; }
}
function trimText(s: string, max: number = 1000): string { return (s || '').length > max ? (s || '').slice(0, max) + '…' : (s || ''); }

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

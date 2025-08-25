import { upsertVideo, moveToTrash, restoreFromTrash } from './db';
import type { Msg } from '../types/messages';
import { dlog, derr } from '../types/debug';

chrome.runtime.onMessage.addListener((raw: Msg, _sender, sendResponse) => {
  (async () => {
    dlog('onMessage:', raw?.type, raw?.payload ? Object.keys(raw.payload) : null);
    try {
      if (raw.type === 'cache/VIDEO_SEEN') {
        await upsertVideo(raw.payload);
        sendResponse?.({ ok: true });
      } else if (raw.type === 'cache/VIDEO_PROGRESS') {
        const { id, current, duration, started, completed } = raw.payload;
        await upsertVideo({
          id,
          progress: { sec: current, duration },
          flags: { started: !!started, completed: !!completed }
        });
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
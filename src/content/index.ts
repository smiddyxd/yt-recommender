import { scrapeNowDetailedAsync, detectPageContext } from './yt-playlist-capture';
import { onNavigate } from './yt-navigation';
import { parseVideoIdFromHref } from '../types/util';
import { scrapeWatchStub } from './yt-watch-stub';
import { startWatchProgressTracking, stopWatchProgressTracking } from './yt-watch-progress';

// Only act when background asks us to scrape
chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
  try {
    if (msg?.type === 'scrape/NOW') {
      (async () => {
        try {
          const info = await scrapeNowDetailedAsync();
          sendResponse?.({ ok: true, ...info });
        } catch (e: any) {
          sendResponse?.({ ok: false, error: e?.message || String(e) });
        }
      })();
      return true; // keep channel open for async
    } else if (msg?.type === 'page/GET_CONTEXT') {
      const ctx = detectPageContext();
      sendResponse?.(ctx);
      return true;
    }
  } catch (e: any) {
    sendResponse?.({ ok: false, error: e?.message || String(e) });
  }
  return false;
});

// Setting: auto-stub on watch pages
let autoStubOnWatch = false;
try {
  chrome.storage?.local?.get('autoStubOnWatch', (o) => { autoStubOnWatch = !!o?.autoStubOnWatch; });
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'local' && changes?.autoStubOnWatch) {
      autoStubOnWatch = !!changes.autoStubOnWatch.newValue;
      // If toggled on while on a watch page, capture immediately once
      if (autoStubOnWatch) {
        try {
          const ctx = detectPageContext();
          if (ctx.page === 'watch') scrapeWatchStub();
        } catch {}
      }
    }
  });
} catch {}

// On YT SPA navigation, auto-capture watch stubs if enabled
try {
  onNavigate(() => {
    const ctx = detectPageContext();
    // Always track progress on watch pages
    if (ctx.page === 'watch') {
      try { void startWatchProgressTracking(); } catch {}
      if (autoStubOnWatch) {
        try { void scrapeWatchStub(); } catch {}
      }
    } else {
      // Stop tracker when leaving watch pages
      try { stopWatchProgressTracking(); } catch {}
    }
  });
} catch {}

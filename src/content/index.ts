import { scrapeNowDetailed, detectPageContext } from './yt-playlist-capture';
import { onNavigate } from './yt-navigation';
import { parseVideoIdFromHref } from '../types/util';
import { scrapeWatchStub } from './yt-watch-stub';

// Only act when background asks us to scrape
chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
  try {
    if (msg?.type === 'scrape/NOW') {
      const info = scrapeNowDetailed();
      sendResponse?.({ ok: true, ...info });
      return true;
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
    if (area === 'local' && changes?.autoStubOnWatch) autoStubOnWatch = !!changes.autoStubOnWatch.newValue;
  });
} catch {}

// On YT SPA navigation, auto-capture watch stubs if enabled
try {
  onNavigate(() => {
    if (!autoStubOnWatch) return;
    const ctx = detectPageContext();
    if (ctx.page === 'watch') {
      try { scrapeWatchStub(); } catch {}
    }
  });
} catch {}

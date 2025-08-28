import { scrapeNow } from './yt-playlist-capture';

// Only act when background asks us to scrape
chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
  try {
    if (msg?.type === 'scrape/NOW') {
      const count = scrapeNow();
      sendResponse?.({ ok: true, count });
      return true;
    }
  } catch (e: any) {
    sendResponse?.({ ok: false, error: e?.message || String(e) });
  }
  return false;
});

import { dlog, derr } from '../../types/debug';

// Lightweight message sender for UI → background.
// Keeps the same shape App.tsx used: resolves to response or void on error.
export async function send<T = any>(type: string, payload: any): Promise<T | void> {
  return new Promise((resolve) => {
    try {
      dlog('UI send', type, payload && Object.keys(payload));
      chrome.runtime.sendMessage({ type, payload }, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) {
          derr('UI send error:', err.message);
          return resolve();
        }
        dlog('UI recv', type, resp);
        resolve(resp as T);
      });
    } catch (e: any) {
      derr('UI send exception:', e?.message || e);
      resolve();
    }
  });
}


export const DEBUG = true; // set to false to silence all logs

export function dlog(...a: any[])  { if (DEBUG) console.log('[dbg]', ...a); }
export function dwarn(...a: any[]) { if (DEBUG) console.warn('[dbg]', ...a); }
export function derr(...a: any[])  { if (DEBUG) console.error('[dbg]', ...a); }

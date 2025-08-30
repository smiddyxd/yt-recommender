// Watch-page progress tracker: periodically samples the HTML5 video element
// and sends cache/VIDEO_PROGRESS updates as the user watches.

type Tracker = {
  videoId: string;
  timer: number | null;
  lastSentSec: number;
  lastSentAt: number;
  onEnded?: () => void;
};

let tracker: Tracker | null = null;

function getCurrentVideoId(): string | null {
  try {
    const url = new URL(location.href);
    return url.searchParams.get('v') || (location.pathname.startsWith('/shorts/') ? location.pathname.split('/')[2] : null);
  } catch { return null; }
}

function findVideoEl(): HTMLVideoElement | null {
  // Prefer main watch player
  let v = document.querySelector('video.html5-main-video') as HTMLVideoElement | null;
  if (v) return v;
  v = document.querySelector('video.video-stream') as HTMLVideoElement | null;
  if (v) return v;
  // Shorts fallback
  v = document.querySelector('ytd-shorts video') as HTMLVideoElement | null;
  if (v) return v;
  // Any visible video element as a last resort
  v = document.querySelector('video') as HTMLVideoElement | null;
  return v || null;
}

async function waitForVideoEl(tries = 30, delayMs = 200): Promise<HTMLVideoElement | null> {
  for (let i = 0; i < tries; i++) {
    const v = findVideoEl();
    if (v) return v;
    await new Promise(res => setTimeout(res, delayMs));
  }
  return null;
}

function sendProgress(id: string, current: number, duration: number) {
  const started = current > 0;
  const completed = Number.isFinite(duration) && duration > 0 && current / duration > 0.95;
  try {
    chrome.runtime.sendMessage({ type: 'cache/VIDEO_PROGRESS', payload: { id, current, duration: Number.isFinite(duration) ? duration : 0, started, completed } });
  } catch { /* ignore */ }
}

export async function startWatchProgressTracking(): Promise<void> {
  const id = getCurrentVideoId();
  if (!id) { stopWatchProgressTracking(); return; }
  if (tracker?.videoId === id && tracker?.timer) return; // already tracking this id

  stopWatchProgressTracking();

  const video = await waitForVideoEl();
  if (!video) return;

  const state: Tracker = { videoId: id, timer: null, lastSentSec: -1, lastSentAt: 0 };

  // Immediate initial send (best-effort)
  try {
    const current = Number(video.currentTime) || 0;
    const duration = Number(video.duration);
    sendProgress(id, current, duration);
    state.lastSentSec = Math.floor(current);
    state.lastSentAt = Date.now();
  } catch { /* ignore */ }

  // Periodic sampling (throttled)
  const intervalMs = 1500;
  const tick = () => {
    try {
      const current = Number(video.currentTime) || 0;
      const duration = Number(video.duration);
      const curSec = Math.floor(current);
      // Throttle: send if >= 1s advance
      if (curSec !== state.lastSentSec) {
        sendProgress(id, current, duration);
        state.lastSentSec = curSec;
        state.lastSentAt = Date.now();
      }
    } catch { /* ignore */ }
  };
  const t = setInterval(tick, intervalMs) as unknown as number;
  state.timer = t;

  // Also send on ended/pause/seeked
  const onEnded = () => {
    try {
      const current = Number(video.currentTime) || 0;
      const duration = Number(video.duration);
      sendProgress(id, current, duration);
    } catch { /* ignore */ }
  };
  video.addEventListener('ended', onEnded, { once: false });
  state.onEnded = () => video.removeEventListener('ended', onEnded);
  const onPause = () => {
    try { const c = Number(video.currentTime) || 0; const d = Number(video.duration); sendProgress(id, c, d); } catch {}
  };
  video.addEventListener('pause', onPause, { once: false });
  const onSeeked = () => {
    try { const c = Number(video.currentTime) || 0; const d = Number(video.duration); sendProgress(id, c, d); } catch {}
  };
  video.addEventListener('seeked', onSeeked, { once: false });
  const oldOnEnded = state.onEnded;
  state.onEnded = () => { try { video.removeEventListener('ended', onEnded); } catch {}; try { video.removeEventListener('pause', onPause); } catch {}; try { video.removeEventListener('seeked', onSeeked); } catch {}; oldOnEnded?.(); };

  tracker = state;
}

export function stopWatchProgressTracking(): void {
  if (!tracker) return;
  try { if (tracker.timer) clearInterval(tracker.timer as unknown as number); } catch {}
  try { tracker.onEnded?.(); } catch {}
  tracker = null;
}

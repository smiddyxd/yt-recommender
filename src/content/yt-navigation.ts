export function onNavigate(cb: () => void) {
  cb(); // run once on initial load

  // YouTube SPA event
  document.addEventListener('yt-navigate-finish', () => cb(), true);

  // URL fallback (if YT changes events)
  let last = location.href;
  setInterval(() => {
    if (location.href !== last) {
      last = location.href;
      cb();
    }
  }, 1000);
}

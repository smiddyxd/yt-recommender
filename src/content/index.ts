import { onNavigate } from './yt-navigation';
import { observePlaylistIfPresent, maybeWatchProgress } from './yt-playlist-capture';

onNavigate(() => {
  // small delay to let YT paint DOM
  setTimeout(() => {
    observePlaylistIfPresent();
    maybeWatchProgress(); // harmless on playlist pages; active on /watch or /shorts
  }, 500);
});

export function secToClock(n?: number | null): string {
  if (!n || !Number.isFinite(n)) return '–:–';
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = Math.floor(n % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}
export function fmtDate(ts?: number) {
  if (!ts) return '';
  return new Date(ts).toLocaleString();
}
// Use lowest-res thumbnails to reduce bandwidth/storage in the Options UI
export const thumbUrl = (id: string) => `https://i.ytimg.com/vi/${id}/default.jpg`;

// Build a channel avatar URL from a stored thumbnailID (unique part of yt3.ggpht.com URLs)
export const avatarUrlFromThumbId = (thumbnailID?: string | null, size: number = 88): string => {
  const id = String(thumbnailID || '').trim();
  if (!id) return '';
  return `https://yt3.ggpht.com/${id}=s${Math.max(1, Math.floor(size))}-c-k-c0x00ffffff-no-rj`;
};
export const watchUrl = (id: string, t?: number) => {
  const base = `https://www.youtube.com/watch?v=${id}`;
  const sec = Number(t);
  if (Number.isFinite(sec) && sec > 0) return `${base}&t=${Math.floor(sec)}`;
  return base;
};
export const hmsToSec = (h=0,m=0,s=0) => (Math.max(0, h|0)*3600) + (Math.max(0, m|0)*60) + Math.max(0, s|0);

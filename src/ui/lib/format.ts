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
export const thumbUrl = (id: string) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
export const watchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;
export const hmsToSec = (h=0,m=0,s=0) => (Math.max(0, h|0)*3600) + (Math.max(0, m|0)*60) + Math.max(0, s|0);

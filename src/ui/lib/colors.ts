export function toHex6(s?: string | null): string | null {
  if (!s) return null;
  let v = s.trim();
  if (!v) return null;
  if (v.startsWith('#')) v = v.slice(1);
  if (v.length === 3) v = v.split('').map(c => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(v)) return null;
  return `#${v.toLowerCase()}`;
}

export function invertColor(hex: string): string {
  const v = toHex6(hex) || '#000000';
  const r = 255 - parseInt(v.slice(1,3), 16);
  const g = 255 - parseInt(v.slice(3,5), 16);
  const b = 255 - parseInt(v.slice(5,7), 16);
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}

export function darken(hex: string, pct: number = 0.2): string {
  const v = toHex6(hex) || '#000000';
  const r = Math.max(0, Math.min(255, Math.round(parseInt(v.slice(1,3), 16) * (1 - pct))));
  const g = Math.max(0, Math.min(255, Math.round(parseInt(v.slice(3,5), 16) * (1 - pct))));
  const b = Math.max(0, Math.min(255, Math.round(parseInt(v.slice(5,7), 16) * (1 - pct))));
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}

function to2(n: number): string {
  const s = n.toString(16);
  return s.length < 2 ? `0${s}` : s;
}

// Choose black or white text for contrast based on YIQ brightness
export function textColorBW(hex?: string | null): string | undefined {
  const v = toHex6(hex || '') || null;
  if (!v) return undefined;
  const r = parseInt(v.slice(1,3), 16);
  const g = parseInt(v.slice(3,5), 16);
  const b = parseInt(v.slice(5,7), 16);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 128 ? '#000000' : '#ffffff';
}

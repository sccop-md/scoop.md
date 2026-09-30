import type { SourceKind } from './api';

export const KIND_LABEL: Record<SourceKind, string> = {
  'page-md': 'page .md',
  llms: 'llms.txt',
  'llms-full': 'llms-full.txt',
  'page-html': 'page HTML',
};

export const KIND_HINT: Record<SourceKind, string> = {
  'page-md': "The page's Markdown twin, published by the site",
  llms: "The site's llms.txt index",
  'llms-full': "The site's full documentation in one file",
  'page-html': "Converted from the page's HTML",
};

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function isoDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '';
}

// "3 hours ago", relative to render time. Paired with a <time> element that
// carries the exact timestamp.
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  const steps: [number, string][] = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [30, 'day'],
    [12, 'month'],
    [Infinity, 'year'],
  ];
  let v = s;
  for (const [size, unit] of steps) {
    if (v < size) {
      if (unit === 'second') return 'just now';
      return `${v} ${unit}${v === 1 ? '' : 's'} ago`;
    }
    v = Math.floor(v / size);
  }
  return '';
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// Read-only client for the library API (docs/BACKEND.md §5). Only the website's
// two endpoints are used: GET /v1/sites and GET /v1/sites/:site.

import { env } from 'cloudflare:workers';

export type SourceKind = 'page-md' | 'llms' | 'llms-full' | 'page-html';

export interface Source {
  kind: SourceKind;
  label: string;
  url: string;
}

export interface SkillSummary {
  id: string;
  site: string;
  pageUrl: string;
  title: string;
  worked: number;
  failed: number;
  createdAt: string;
  lastWorkedAt: string | null;
  status: string;
  sources: Source[];
  sizeBytes: number;
}

export interface SiteEntry {
  site: string;
  best: SkillSummary;
}

export interface SiteDetail {
  site: string;
  best: SkillSummary | null;
  recent: SkillSummary[];
}

export type Result<T> = { ok: true; data: T } | { ok: false; reason: 'not_found' | 'unavailable' };

const DEFAULT_API = 'https://api.scoop.md';

// The Worker's PUBLIC_API_URL var (wrangler.jsonc; .dev.vars overrides it
// locally), otherwise production.
export function apiBase(): string {
  const url = (env as Record<string, unknown>)?.PUBLIC_API_URL;
  return (typeof url === 'string' && url ? url : DEFAULT_API).replace(/\/+$/, '');
}

async function get<T>(path: string): Promise<Result<T>> {
  try {
    const res = await fetch(apiBase() + path, {
      headers: { accept: 'application/json', 'x-scoop-client': 'site' },
      signal: AbortSignal.timeout(5000),
      // Cloudflare edge cache for the subrequest; ignored outside Workers.
      cf: { cacheTtl: 60, cacheEverything: true },
    } as RequestInit);
    if (res.status === 404) return { ok: false, reason: 'not_found' };
    if (!res.ok) return { ok: false, reason: 'unavailable' };
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

export async function listSites(limit = 100): Promise<Result<SiteEntry[]>> {
  const r = await get<{ sites: SiteEntry[] }>(`/v1/sites?limit=${limit}`);
  return r.ok ? { ok: true, data: r.data.sites ?? [] } : r;
}

export function getSite(site: string): Promise<Result<SiteDetail>> {
  return get<SiteDetail>(`/v1/sites/${encodeURIComponent(site)}`);
}

// Same normalisation as the API's site key: lowercase, no leading www.
export function normalizeSite(raw: string): string {
  return raw.trim().toLowerCase().replace(/^www\./, '');
}

// A plausible public hostname. Anything else is a 404 without asking the API.
export function isHostname(s: string): boolean {
  return s.length <= 253 && /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(s);
}

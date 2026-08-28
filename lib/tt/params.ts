/**
 * Pure validation/normalization params for the Trust Tai adapter routes.
 *
 * No imports — safe for unit tests (node --test) without pulling in
 * playwright/better-sqlite3, which the route files load transitively.
 * Routes import from here so the schema contract lives in exactly one place.
 */

/** Max result pages per lookup request (LinkedIn search pagination). */
export const MAX_PAGES = 3;
/** Hard cap on merged lookup candidates across all pages. */
export const MAX_CANDIDATES = 25;
/** Max profile URLs per enrich request. */
export const MAX_ENRICH_URLS = 5;

/** Flagship /in/ profile URL — no subroutes, https, www host only. */
export const ENRICH_URL_RE = /^https:\/\/www\.linkedin\.com\/in\/[^/]+\/?$/;

/**
 * Validate the optional lookup `pages` body param.
 * Absent/null → 1 (default single page). Returns null when invalid.
 */
export function parsePages(raw: unknown): number | null {
  if (raw === undefined || raw === null) return 1;
  if (typeof raw !== "number" || !Number.isInteger(raw)) return null;
  if (raw < 1 || raw > MAX_PAGES) return null;
  return raw;
}

/**
 * Validate the enrich `urls` body param: array of 1-MAX_ENRICH_URLS strings,
 * each a flagship /in/ URL. Returns the validated string[] or null.
 */
export function validateEnrichUrls(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_ENRICH_URLS) return null;
  for (const u of raw) {
    if (typeof u !== "string" || !ENRICH_URL_RE.test(u)) return null;
  }
  return raw as string[];
}

/**
 * Merge-dedupe candidates by linkedin_url (first occurrence wins — earlier
 * search page + higher rank), hard-capped at MAX_CANDIDATES.
 */
export function dedupeCandidates<T extends { linkedin_url: string }>(all: T[]): T[] {
  const seen = new Set<string>();
  return all
    .filter((c) => {
      if (seen.has(c.linkedin_url)) return false;
      seen.add(c.linkedin_url);
      return true;
    })
    .slice(0, MAX_CANDIDATES);
}

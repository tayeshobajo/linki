/**
 * Nav-first enrichment engine (2026-08-31 account-safety refactor).
 *
 * Cold profile deep-links (direct page.goto on /in/ URLs) from this
 * datacenter trigger LinkedIn's risk wall. Nav-first replaces them with
 * natural navigation: ONE search results page load → click the candidate's
 * anchor → read the profile → goBack → repeat. Strictly sequential, single
 * tab, hard cap of MAX_NAV_ENRICH_URLS profile visits per request.
 *
 * WALL DOCTRINE: immediately after ANY navigation (search load, profile
 * click, goBack) the page URL is checked against the risk-wall regex
 * (lookup.ts convention); a goto that throws ERR_TOO_MANY_REDIRECTS is the
 * same wall. On wall: STOP the entire loop — never retry, never fall back
 * to cold goto — and return partials with stopped_reason:"risk_wall".
 *
 * Testability: Page is consumed through a minimal structural interface
 * (NavPage) and the profile extraction is injected, so the engine runs under
 * `node --test` with a mock and zero network/browser traffic.
 */

import { isRiskWall, isRedirectWallError, candidateSlugFromUrl, MAX_NAV_ENRICH_URLS } from "./params.ts";

/** Structural subset of playwright Page that this engine needs. */
export interface NavLocator {
  first(): NavLocator;
  count(): Promise<number>;
  click(options?: { timeout?: number }): Promise<void>;
}

/** Structural subset of playwright Page that this engine needs. */
export interface NavPage {
  url(): string;
  goto(url: string, options?: { waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit"; timeout?: number }): Promise<unknown>;
  goBack(options?: { waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit"; timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  locator(selector: string): NavLocator;
}

/** Mirrors lib/linkedin/profile-lite.ts ProfileLite (kept structural for tests). */
export interface NavProfileLite {
  url: string;
  full_name: string | null;
  headline: string | null;
  company: string | null;
  title: string | null;
  location: string | null;
}

export type NavEnrichEntry = NavProfileLite | { url: string; error: "parse_failed" };

export interface NavEnrichOutcome {
  profiles: NavEnrichEntry[];
  stopped_reason: "risk_wall" | null;
}

export interface NavEnrichDeps {
  /** Extraction on the CURRENT (already navigated) page — no navigation inside. */
  extract: (page: NavPage, url: string) => Promise<NavProfileLite>;
}

/** Search results URL for a name (lookup.ts convention). */
export const searchUrlFor = (name: string) =>
  `https://www.linkedin.com/search/results/all/?keywords=${encodeURIComponent(name)}&origin=GLOBAL_SEARCH_HEADER`;

/**
 * Canonicalize the navigated page URL for result stamping: keep origin +
 * pathname, drop query/hash (search-click hrefs carry ?originalSubdomain=…
 * noise that would fail the strict /in/ contract downstream).
 * Returns the input unchanged when it does not parse.
 */
export function canonicalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return u.origin + u.pathname;
  } catch {
    return raw;
  }
}

/**
 * Nav-first enrich loop. `urls` are flagship /in/ URLs (validated upstream);
 * only the first MAX_NAV_ENRICH_URLS are processed, in the given order.
 *
 * Per URL: find its /in/<slug> anchor on the CURRENT search results page.
 * Not found → silent skip (false negative, accepted: no cold goto, no
 * pagination). Found → human click, humanized wait, wall check, extract on
 * the navigated page, goBack, pacing pause.
 *
 * Throws only for non-wall transport failures on the initial search load
 * (caller maps to 500); walls NEVER throw — they stop the loop.
 */
export async function enrichNavFirst(
  page: NavPage,
  urls: string[],
  searchName: string,
  deps: NavEnrichDeps,
): Promise<NavEnrichOutcome> {
  const profiles: NavEnrichEntry[] = [];
  const stop = (): NavEnrichOutcome => ({ profiles, stopped_reason: "risk_wall" });

  // ── One search page load ──
  try {
    await page.goto(searchUrlFor(searchName), { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (err) {
    if (isRedirectWallError(err)) return stop();
    throw err; // genuine transport failure — caller decides
  }
  await page.waitForTimeout(3000 + Math.random() * 2000);
  if (isRiskWall(page.url())) return stop();

  // ── Candidate loop: hard cap, given order, strictly sequential ──
  for (const url of urls.slice(0, MAX_NAV_ENRICH_URLS)) {
    const slug = candidateSlugFromUrl(url);
    if (!slug) {
      profiles.push({ url, error: "parse_failed" });
      continue;
    }

    const anchor = page.locator(`a[href*="${slug}"]`);
    if ((await anchor.count().catch(() => 0)) === 0) {
      // Not on this search page → silent skip. NEVER cold-goto, NEVER paginate.
      continue;
    }

    // Human click into the profile.
    try {
      await anchor.first().click({ timeout: 10000 });
    } catch (err) {
      console.error(`[enrich:nav] click failed for ${slug}:`, err instanceof Error ? err.message : err);
      profiles.push({ url, error: "parse_failed" });
      continue; // navigation unconfirmed — do NOT goBack from the search page
    }
    await page.waitForTimeout(3000 + Math.random() * 2000);
    if (isRiskWall(page.url())) return stop();

    // Extract on the navigated page — stamp the CURRENT url, not the input.
    const currentUrl = canonicalizeUrl(page.url());
    try {
      const p = await deps.extract(page, currentUrl);
      if (!p.full_name && !p.headline) {
        profiles.push({ url: currentUrl, error: "parse_failed" });
      } else {
        profiles.push(p);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/browser (?:has been |is )?closed|target.*closed|context.*closed/i.test(msg)) throw err;
      console.error(`[enrich:nav] extract failed at ${currentUrl}: ${msg}`);
      profiles.push({ url: currentUrl, error: "parse_failed" });
    }

    // Back to the search results, pacing pause before the next candidate.
    await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(2000 + Math.random() * 1500);
    if (isRiskWall(page.url())) return stop();
  }

  return { profiles, stopped_reason: null };
}

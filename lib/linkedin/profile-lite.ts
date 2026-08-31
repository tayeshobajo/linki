import type { Page } from "playwright";
import { parseHeadline } from "./headline";

/**
 * Lightweight flagship (non-Sales-Nav) profile scraper.
 *
 * Navigates to a /in/ URL and structurally extracts the top card:
 *   - name     → the <h1> inside the top-card section
 *   - headline → the rendered line directly under the <h1>
 *   - location → the "· <Location>" segment (profile top cards render
 *                "City, State · 500+ connections"; location is the segment
 *                before the connection count)
 *   - company/title → derived from the headline via the shared
 *                "… at <Company>" parser (lib/linkedin/headline.ts)
 *
 * Structural anchoring follows the visit.ts convention (commit eea1967): the
 * top card is `main section` filtered to the one containing the page's <h1>,
 * which survives LinkedIn's periodic class-name hashing. Legacy
 * `.pv-top-card` selectors are tried first so an A/B flip back to old markup
 * still works.
 *
 * Account-risk posture: one real page visit per call with a humanized wait
 * (3000 + rand(2000) ms, same as visit.ts). NEVER throws on DOM misses —
 * partial extraction returns nulls, and the caller decides what to do.
 */

export interface ProfileLite {
  url: string;
  full_name: string | null;
  headline: string | null;
  company: string | null;
  title: string | null;
  location: string | null;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** Connection-count noise ("500+ connections") that trails the location line. */
const CONNECTIONS_RE = /[\d.,]+\+?\s*connections?\b/i;

const emptyProfile = (url: string): ProfileLite => ({ url, full_name: null, headline: null, company: null, title: null, location: null });

/**
 * Navigate to a /in/ URL with the humanized wait (goto half of
 * scrapeProfileLite). Split out so nav-first enrichment can click into a
 * profile and reuse the extraction without a redundant cold goto.
 */
export async function gotoProfileLite(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000 + Math.random() * 2000);
}

/**
 * Extract the top card from the CURRENT page state (extraction half of
 * scrapeProfileLite). `url` is stamped on the result — nav-first callers pass
 * the navigated page's canonical URL, not the original input URL.
 * NEVER throws on DOM misses — partial extraction returns nulls.
 */
export async function extractProfileLite(page: Page, url: string): Promise<ProfileLite> {
  const empty = emptyProfile(url);
  const topCard = page.locator("main section").filter({ has: page.locator("h1") }).first();

  // --- name: h1 in the top card (legacy pv-top-card h1 first) ---
  let full_name: string | null = null;
  const h1 = topCard.locator("h1").first();
  if ((await h1.count().catch(() => 0)) > 0) {
    full_name = norm((await h1.innerText().catch(() => "")) ?? "");
  }
  if (!full_name) {
    const legacy = page.locator(".pv-top-card h1").first();
    if ((await legacy.count().catch(() => 0)) > 0) {
      full_name = norm((await legacy.innerText().catch(() => "")) ?? "");
    }
  }
  full_name = full_name ? full_name.slice(0, 200) : null;

  // --- headline + location: rendered lines of the top card ---
  const cardText = await topCard.innerText().catch(() => "");
  if (!cardText) return { ...empty, full_name };

  const lines = cardText.split("\n").map(norm).filter(Boolean);

  // Headline = the first non-name, non-chrome line under the h1.
  const NOISE = /^(message|connect|follow|pending|inmail|accept|more)$/i;
  const isNameLine = (l: string) =>
    l === full_name || /^•?\s*(?:1st|2nd|3rd)\+?\s*•?$/.test(l) || l === "·";
  const content = lines.filter((l) => !NOISE.test(l) && !isNameLine(l) && !CONNECTIONS_RE.test(l));

  let headline: string | null = content.find((l) => / at |@/.test(l)) ?? content[0] ?? null;
  // A bare location line ("Nashville, TN") should not masquerade as a headline
  // when a real title/company line exists elsewhere in the card.
  if (headline && !/ at |@/.test(headline) && /^[A-Z][^A-Z]*,\s*[A-Z]{2}\b/.test(headline)) {
    const better = content.find((l, i) => i > content.indexOf(headline!) && / at |@/.test(l));
    if (better) headline = better;
  }
  headline = headline ? headline.slice(0, 300) : null;

  // Location: the "· <Location>" segment — top cards render
  // "Nashville, TN · 500+ connections"; take the segment(s) before the
  // connection count that look like a place.
  let location: string | null = null;
  for (const l of content) {
    // Preferred: "City, ST · 500+ connections" with the connections stripped.
    const segs = l.split("·").map(norm).filter(Boolean);
    const place = segs.find((s) => !CONNECTIONS_RE.test(s) && /,\s*[A-Z]{2}$|,\s*[A-Z]{2}\s/.test(s));
    if (place) { location = place.slice(0, 120); break; }
  }
  if (!location) {
    // Fallback: any standalone "City, ST" line.
    const placeLine = content.find((l) => /^[A-Z][A-Za-z .'-]+,\s*[A-Z]{2}$/.test(l));
    if (placeLine) location = placeLine.slice(0, 120);
  }

  // --- company/title: shared headline parser (same as search cards) ---
  const { company, title } = parseHeadline(headline);

  return { url, full_name, headline, company, title, location };
}

/**
 * Navigate-then-extract: the original scrapeProfileLite contract (cold goto
 * to a /in/ URL, humanized wait, structural top-card extraction). Legacy
 * enrichment mode keeps this; nav-first uses gotoProfileLite-equivalent
 * navigation (clicks) plus extractProfileLite on the navigated page.
 */
export async function scrapeProfileLite(page: Page, url: string): Promise<ProfileLite> {
  await gotoProfileLite(page, url);

  // Auth/challenge walls surface as a login/challenge URL — nothing to extract.
  if (/\/login|\/authwall|\/checkpoint|\/uas\//.test(page.url())) return emptyProfile(url);

  return extractProfileLite(page, url);
}

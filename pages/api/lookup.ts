import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { getSessionPage } from "@/lib/linkedin/session";
import { resolveAnyAuthenticatedAccount } from "@/lib/linkedin/resolve-account";

// POST /api/lookup — flagship (non-Sales-Nav) people search for Trust Tai's
// "find contact route" NextMoveAction. Search keyword → parse result cards →
// return candidate {linkedin_url, full_name, headline, location, degree}.
// Read-only on LinkedIn: one search page load per call, no pagination, no
// profile visits. Results are NEVER auto-written — caller owns matching.
//
// Trust Tai integration brief §9 sanctioned a Sales-Nav intercept adapter, but
// the account has no Sales Nav (verified 2026-08-24: /sales/ → premium upsell
// redirect). This is the sanctioned pivot: flagship search + DOM parse.

export interface LookupCandidate {
  linkedin_url: string;
  full_name: string | null;
  headline: string | null;
  location: string | null;
  degree: string | null;
}

const SEARCH_URL = (kw: string) =>
  `https://www.linkedin.com/search/results/all/?keywords=${encodeURIComponent(kw)}&origin=GLOBAL_SEARCH_HEADER`;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const keywords = (req.body?.keywords ?? "").toString().trim();
  if (!keywords || keywords.length < 2) return res.status(400).json({ error: "keywords required (min 2 chars)" });
  if (keywords.length > 200) return res.status(400).json({ error: "keywords too long (max 200)" });

  const db = getDb();
  const account = resolveAnyAuthenticatedAccount(db, req.body?.account_id);
  if (!account) return res.status(400).json({ error: "No authenticated LinkedIn account could be resolved." });

  const page = await getSessionPage(account.id);
  try {
    await page.goto(SEARCH_URL(keywords), { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(4000);
    // Wait for result cards; tolerate absence (zero results) without failing.
    try {
      await page.waitForSelector("li.reusable-search__result-container, .entity-result", { timeout: 10000 });
    } catch { /* zero results or slow render — fall through to DOM parse */ }

    // Auth/challenge walls surface as a login/challenge URL — never return junk.
    if (/\/login|\/authwall|\/checkpoint|\/uas\//.test(page.url())) {
      return res.status(503).json({ error: "Session needs re-authentication", redirect: page.url() });
    }

    const debug = await page.evaluate(() => ({
      url: location.href,
      cardCount: document.querySelectorAll("li.reusable-search__result-container").length,
      viewNames: document.querySelectorAll("[data-view-name]").length,
      inAnchors: document.querySelectorAll('a[href*="/in/"]').length,
      bodyStart: document.body.innerText.slice(0, 200),
    })).catch(() => ({ url: "", cardCount: 0, viewNames: 0, inAnchors: 0, bodyStart: "" }));
    console.log("[lookup:debug]", JSON.stringify(debug));
    const resultCount = (typeof debug.bodyStart === "string" ? debug.bodyStart : "").match(/([\d.,]+)\s+results?/i)?.[1]?.replace(/[.,]/g, "") ?? null;

    const candidates: LookupCandidate[] = await page.evaluate(() => {
      const out: {
        linkedin_url: string; full_name: string | null; headline: string | null; location: string | null; degree: string | null;
      }[] = [];
      const seen = new Set<string>();
      const anchors = [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"]')];
      for (const a of anchors) {
        const href = a.getAttribute("href") ?? "";
        let clean: string;
        try { clean = new URL(href, "https://www.linkedin.com").pathname.split("?")[0]; } catch { continue; }
        if (!/^\/in\/[^/]+\/?$/.test(clean)) continue; // result-card links only, skip /in/x/detail/ subroutes
        if (seen.has(clean)) continue;
        seen.add(clean);
        // Card = nearest list item ancestor; fall back to anchor's own text block
        const card = (a.closest("li, div[data-view-name]") as HTMLElement | null) ?? a.parentElement;
        const textOf = (el: Element | null) => el?.textContent?.trim().replace(/\s+/g, " ") ?? null;
        let name = textOf(card?.querySelector(".entity-result__title-text a span[aria-hidden=true], .actor-name, a[href*='/in/'] span[aria-hidden=true]") ?? null)
          ?? textOf(a.querySelector("span[aria-hidden=true]") ?? null);
        if (!name) {
          // visible-link variant: the anchor's accessible label or innerText
          name = (a as HTMLAnchorElement & { innerText?: string }).innerText?.trim().split("\n")[0] || a.getAttribute("aria-label")?.trim() || null;
        }
        if (name) name = name.replace(/\s*[•·]\s*\d(?:st|nd|rd|th)\+?\s*$/i, "").replace(/\s*\b(1st|2nd|3rd\+?|\d+\w*)\b\s*$/i, "").trim();
        if (!name && card) {
          const t = card.innerText || "";
          const m = t.match(/([A-Z][\w.'’-]+(?:\s+[A-Z][\w.'’-]+){1,3})\n/);
          if (m) name = m[1];
        }
        if (!name) continue; // name unresolvable → not a person card; never return null names
        const headline = textOf(card?.querySelector(".entity-result__primary-subtitle, .subline-level-1, [data-field='current_position']") ?? null);
        const location = textOf(card?.querySelector(".entity-result__secondary-subtitle, .subline-level-2, [data-field='location']") ?? null);
        const location0 = textOf(card?.querySelector(".entity-result__secondary-subtitle, .subline-level-2") ?? null);
        const degree = textOf(card?.querySelector(".entity-result__badge-text, .image-text-visible, .dist-value") ?? null);
        out.push({ linkedin_url: "https://www.linkedin.com" + clean, full_name: name, headline: headline ?? null, location: location ?? location0, degree });
      }
      return out;
    }).catch(() => [] as LookupCandidate[]);

    return res.json({
      account_id: account.id,
      keywords,
      result_count: resultCount ? parseInt(resultCount, 10) : null,
      candidates: candidates.slice(0, 10),
      provider: "linki-flagship-search",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/re-authentication|No data intercepted|login|checkpoint/i.test(message)) {
      const { markNeedsReauth } = await import("@/lib/linkedin/session");
      await markNeedsReauth(account.id);
    }
    console.error("[lookup]", message);
    return res.status(500).json({ error: message });
  } finally {
    await page.close().catch(() => {});
  }
}

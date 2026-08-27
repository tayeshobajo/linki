import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { getSessionPage } from "@/lib/linkedin/session";
import { resolveAnyAuthenticatedAccount } from "@/lib/linkedin/resolve-account";

// POST /api/lookup — flagship (non-Sales-Nav) people search for Trust Tai's
// "find contact route" NextMoveAction. Search keyword → parse result cards →
// return candidate {linkedin_url, full_name, headline, location, degree, company}.
// Read-only on LinkedIn: one search page load per call, no pagination, no
// profile visits. Results are NEVER auto-written — caller owns matching.
//
// Trust Tai integration brief §9 sanctioned a Sales-Nav intercept adapter, but
// the account has no Sales Nav (verified 2026-08-24: /sales/ → premium upsell
// redirect). This is the sanctioned pivot: flagship search + DOM parse.
//
// DOM note (2026-08-26 ground-truth probe): flagship search no longer serves
// the classic `.entity-result__*` markup — cards now use rotated hashed CSS
// classes. Extraction is therefore structure-anchored: find /in/ profile
// anchors, walk up to the person card, parse its rendered text lines
// [name, "• Nth", headline, location, action…]. Legacy selectors are kept as
// a first-choice path so an A/B flip back to old markup still works.

export interface LookupCandidate {
  linkedin_url: string;
  full_name: string;
  headline: string | null;
  location: string | null;
  degree: string | null;
  company: string | null;
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
    // Wait for result content; tolerate absence (zero results) without failing.
    try {
      await page.waitForSelector('a[href*="/in/"], li.reusable-search__result-container, .entity-result', { timeout: 10000 });
    } catch { /* zero results or slow render — fall through to DOM parse */ }

    // Auth/challenge walls surface as a login/challenge URL — never return junk.
    if (/\/login|\/authwall|\/checkpoint|\/uas\//.test(page.url())) {
      return res.status(503).json({ error: "Session needs re-authentication", redirect: page.url() });
    }

    const debug = await page.evaluate(() => ({
      url: location.href,
      inAnchors: document.querySelectorAll('a[href*="/in/"]').length,
      legacyCards: document.querySelectorAll("li.reusable-search__result-container").length,
      bodyStart: document.body.innerText.slice(0, 200),
    })).catch(() => ({ url: "", inAnchors: 0, legacyCards: 0, bodyStart: "" }));
    console.log("[lookup:debug]", JSON.stringify(debug));
    const resultCount = (typeof debug.bodyStart === "string" ? debug.bodyStart : "").match(/([\d.,]+)\s+results?/i)?.[1]?.replace(/[.,]/g, "") ?? null;

    const candidates: LookupCandidate[] = await page.evaluate(() => {
      const out: LookupCandidate[] = [];
      const seen = new Set<string>();

      const norm = (s: string) => s.replace(/\s+/g, " ").trim();
      // Rendered action/noise lines that are never identity data.
      const ACTION_LINE = /^(message|connect|follow|pending|inmail|accept|send message|message\s*⓿)$/i;
      const NOISE_LINE = /mutual connection|followers?\b|view(?:ed)? (?:full )?profile|see more/i;
      // Degree renders as its own line ("• 3rd+") or trails the name ("Name • 2nd").
      const DEGREE_LINE = /^[•·]\s*((?:1st|2nd|3rd)(?:\+)?)$/i;
      const DEGREE_TRAILING = /\s+[•·]\s*((?:1st|2nd|3rd)(?:\+)?)$/i;
      // Follower counts can share the degree line ("• 3rd+ · 1,234 followers").
      const DEGREE_INLINE = /\b((?:1st|2nd|3rd)\+?)/i;

      // Structure-anchored card discovery: climb from a /in/ anchor to the
      // nearest ancestor whose rendered text spans a full person card
      // (name + degree + at least one more line). Hashed classes are ignored.
      const findCard = (anchor: HTMLElement): HTMLElement | null => {
        let el: HTMLElement | null = anchor;
        for (let i = 0; el && i < 8; i += 1) {
          const lines = (el.innerText || "").split("\n").map(norm).filter(Boolean);
          if (lines.length >= 3 && (el.innerText || "").length <= 700) return el;
          el = el.parentElement;
        }
        return null;
      };

      const anchors = [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"]')];
      for (const a of anchors) {
        const href = a.getAttribute("href") ?? "";
        let clean: string;
        try { clean = new URL(href, "https://www.linkedin.com").pathname.split("?")[0]; } catch { continue; }
        if (!/^\/in\/[^/]+\/?$/.test(clean)) continue; // result-card links only, skip /in/x/detail/ subroutes
        if (seen.has(clean)) continue;
        seen.add(clean);

        const card = (a.closest("li, div[data-view-name]") as HTMLElement | null) ?? findCard(a) ?? a.parentElement;
        if (!card) continue;
        const textOf = (el: Element | null) => norm(el?.textContent ?? "");
        const lines = (card.innerText || "").split("\n").map(norm).filter(Boolean);

        // --- name (legacy selectors first, line parse as fallback) ---
        let name =
          textOf(card.querySelector(".entity-result__title-text a span[aria-hidden=true], .actor-name, a[href*='/in/'] span[aria-hidden=true]") ?? null) ||
          textOf(a.querySelector("span[aria-hidden=true]") ?? null) ||
          (a as HTMLAnchorElement).innerText?.trim().split("\n")[0] ||
          lines[0] ||
          "";
        name = name.trim();
        let degree: string | null =
          textOf(card.querySelector(".entity-result__badge-text, .image-text-visible, .dist-value") ?? null) || null;
        // Degree may also surface inside a line like "1d •" / "• 3rd+ · 123 followers"
        // — pull the canonical token out, discard the rest of the line.
        const inlineDegree = (l: string | undefined) => {
          if (!l) return null;
          const m = l.match(DEGREE_INLINE);
          return m ? m[1] : null;
        };
        if (!degree) {
          const degreeLine = lines.find((l) => /^[•·]/.test(l) && DEGREE_INLINE.test(l));
          if (degreeLine) degree = inlineDegree(degreeLine);
        }
        // Trailing degree on the name itself ("Isaac Meek • 3rd+") splits into both.
        const trailing = name.match(DEGREE_TRAILING);
        if (trailing) {
          if (!degree) degree = trailing[1];
          name = name.replace(DEGREE_TRAILING, "").trim();
        }
        if (!name) continue; // name unresolvable → not a person card; never return null names

        // --- headline / location (legacy selectors first, line parse fallback) ---
        let headline =
          textOf(card.querySelector(".entity-result__primary-subtitle, .subline-level-1, [data-field='current_position']") ?? null) || null;
        let location =
          textOf(card.querySelector(".entity-result__secondary-subtitle, .subline-level-2, [data-field='location']") ?? null) || null;

        if (!headline || !location) {
          const degreeIdx = lines.findIndex((l) => DEGREE_LINE.test(l));
          if (degreeIdx >= 0 && !degree) degree = lines[degreeIdx].replace(/^[•·]\s*/, "");
          // A line that is just the name with an inline degree ("Isaac Meek • 3rd+")
          // is identity chrome, never headline/location evidence.
          const isNameChrome = (l: string) =>
            l.replace(DEGREE_TRAILING, "").trim() === name || DEGREE_LINE.test(l) || l === name;
          const rest = lines
            .slice(1)
            .filter((l) => !isNameChrome(l))
            .filter((l) => !ACTION_LINE.test(l))
            .filter((l) => !NOISE_LINE.test(l))
            .filter((l) => !/^[•·]/.test(l))
            .filter((l) => !/^\d+[dwm]?\s*[•·]?/i.test(l));
          if (!headline && rest.length > 0) headline = rest[0];
          if (!location && rest.length > 1) location = rest[1];
        }
        if (headline) headline = headline.slice(0, 300);
        if (location) location = location.slice(0, 120);

        // --- company: parsed from "… at <Company>" headline when present ---
        let company: string | null = null;
        if (headline) {
          const atIdx = headline.lastIndexOf(" at ");
          if (atIdx > 0) company = norm(headline.slice(atIdx + 4)).slice(0, 120) || null;
        }

        out.push({
          linkedin_url: "https://www.linkedin.com" + clean,
          full_name: name,
          headline: headline || null,
          location: location || null,
          degree: degree || null,
          company: company || null,
        });
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

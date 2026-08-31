import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { getSessionPage } from "@/lib/linkedin/session";
import { resolveAnyAuthenticatedAccount } from "@/lib/linkedin/resolve-account";
import { scrapeProfileLite, extractProfileLite, type ProfileLite } from "@/lib/linkedin/profile-lite";
import { validateEnrichUrls, MAX_ENRICH_URLS, parseSearchName, isRiskWall, isRedirectWallError } from "@/lib/tt/params";
import { enrichNavFirst } from "@/lib/tt/enrich-nav";

// POST /api/enrich — flagship (non-Sales-Nav) profile visits for Trust Tai's
// enrichment pipeline. Body: {urls: string[] ≤5, each a flagship /in/ URL,
// search_name?: string}. When search_name is present the request runs in
// NAV-FIRST mode (2026-08-31 account-safety refactor): one search page load
// → click each candidate's anchor → extract on the navigated page → back.
// Cold direct page.goto on /in/ URLs from this datacenter triggers
// LinkedIn's risk wall; nav-first replaces deep links with natural
// navigation, hard-capped at 3 profile visits, strictly sequential.
//
// LEGACY MODE (no search_name): cold-goto per URL (backward compat), but
// the loop now STOPS at the first wall — partials + stopped_reason:
// "risk_wall" — instead of hammering every URL against the wall.
//
// Fail-soft per URL: a DOM miss or parse failure yields
// {url, error: "parse_failed"} for THAT entry — the batch is still 200.
// 500 is reserved for transport failures (browser/session unreachable) —
// a getSessionPage throw propagates to the top-level catch, which also
// flags re-auth on session-death signals (lookup.ts catch shape).
// Results are NEVER auto-written — caller owns matching/ranking.

/** Humanized inter-profile pacing, layered on the session's teardown gap. */
const profileGap = () => 1500 + Math.random() * 2500;

type EnrichEntry = ProfileLite | { url: string; error: "parse_failed" };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const urls = validateEnrichUrls(req.body?.urls);
  if (!urls) return res.status(400).json({ error: `urls must be an array of 1-${MAX_ENRICH_URLS} flagship /in/ URLs` });

  const searchName = parseSearchName(req.body?.search_name);
  if (searchName === "") return res.status(400).json({ error: "search_name must be a string of 2-200 characters when present" });

  const db = getDb();
  const account = resolveAnyAuthenticatedAccount(db, req.body?.account_id);
  if (!account) return res.status(400).json({ error: "No authenticated LinkedIn account could be resolved." });

  const profiles: EnrichEntry[] = [];
  let stoppedReason: "risk_wall" | null = null;

  try {
    // ── NAV-FIRST MODE ──
    if (searchName !== null) {
      const page = await getSessionPage(account.id);
      try {
        const outcome = await enrichNavFirst(page, urls, searchName, {
          extract: (p, u) => extractProfileLite(p as never, u),
        });
        profiles.push(...outcome.profiles);
        stoppedReason = outcome.stopped_reason;
      } finally {
        await page.close().catch(() => {});
      }

      return res.json({
        account_id: account.id,
        profiles,
        ...(stoppedReason ? { stopped_reason: stoppedReason } : {}),
        provider: "linki-flagship-profile-lite",
      });
    }

    // ── LEGACY MODE (no search_name): cold goto, stop-on-wall ──
    for (let i = 0; i < urls.length; i += 1) {
      const url = urls[i];
      // getSessionPage throw = transport failure → 500 via the catch below.
      const page = await getSessionPage(account.id);
      try {
        const p = await scrapeProfileLite(page, url);
        if (!p.full_name && !p.headline) {
          profiles.push({ url, error: "parse_failed" });
        } else {
          profiles.push(p);
        }
        // Wall check on the page we actually landed on — the risk wall can
        // surface after the cold goto redirected; stop the loop (partials
        // kept), never continue hammering a walled session.
        if (isRiskWall(page.url())) {
          stoppedReason = "risk_wall";
          break;
        }
      } catch (err) {
        // Wall-equivalent navigation failure: stop the whole loop, keep partials.
        if (isRedirectWallError(err)) {
          stoppedReason = "risk_wall";
          break;
        }
        // Browser/session death = transport failure → rethrow → 500 below.
        const msg = err instanceof Error ? err.message : String(err);
        if (/browser (?:has been |is )?closed|target.*closed|context.*closed/i.test(msg)) throw err;
        console.error(`[enrich] ${url}: ${msg}`);
        profiles.push({ url, error: "parse_failed" });
      } finally {
        await page.close().catch(() => {});
      }

      if (i < urls.length - 1) await new Promise((r) => setTimeout(r, profileGap()));
    }

    return res.json({
      account_id: account.id,
      profiles,
      ...(stoppedReason ? { stopped_reason: stoppedReason } : {}),
      provider: "linki-flagship-profile-lite",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/re-authentication|No data intercepted|login|checkpoint/i.test(message)) {
      const { markNeedsReauth } = await import("@/lib/linkedin/session");
      await markNeedsReauth(account.id);
    }
    console.error("[enrich]", message);
    return res.status(500).json({ error: message });
  }
}

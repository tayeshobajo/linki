import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { getSessionPage } from "@/lib/linkedin/session";
import { resolveAnyAuthenticatedAccount } from "@/lib/linkedin/resolve-account";
import { scrapeProfileLite, type ProfileLite } from "@/lib/linkedin/profile-lite";
import { validateEnrichUrls, MAX_ENRICH_URLS } from "@/lib/tt/params";

// POST /api/enrich — flagship (non-Sales-Nav) profile visits for Trust Tai's
// enrichment pipeline. Body: {urls: string[] ≤5, each a flagship /in/ URL}.
// For each URL: one real profile-page visit (visit.ts pattern, humanized
// waits + serialized page opens via getSessionPage), structural top-card
// extraction, {company,title} derived from the headline via the shared parser.
//
// Fail-soft per URL: a DOM miss or parse failure yields
// {url, error: "parse_failed"} for THAT entry — the batch is still 200.
// 500 is reserved for transport failures (browser/session unreachable) —
// a getSessionPage throw propagates to the top-level catch, which also
// flags re-auth on session-death signals (lookup.ts catch shape).
// Results are NEVER auto-written — caller owns matching/ranking.;

/** Humanized inter-profile pacing, layered on the session's teardown gap. */
const profileGap = () => 1500 + Math.random() * 2500;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const urls = validateEnrichUrls(req.body?.urls);
  if (!urls) return res.status(400).json({ error: `urls must be an array of 1-${MAX_ENRICH_URLS} flagship /in/ URLs` });

  const db = getDb();
  const account = resolveAnyAuthenticatedAccount(db, req.body?.account_id);
  if (!account) return res.status(400).json({ error: "No authenticated LinkedIn account could be resolved." });

  const profiles: Array<ProfileLite | { url: string; error: "parse_failed" }> = [];

  try {
    for (let i = 0; i < urls.length; i += 1) {
      const url = urls[i];
      // getSessionPage throw = transport failure → 500 via the catch below.
      const page = await getSessionPage(account.id);
      try {
        const p = await scrapeProfileLite(page, url);
        // A profile with no name AND no headline was not meaningfully parsed
        // (authwall/challenge/empty render) — report it, don't fail the batch.
        if (!p.full_name && !p.headline) {
          profiles.push({ url, error: "parse_failed" });
        } else {
          profiles.push(p);
        }
      } catch (err) {
        // Browser/session death = transport failure → rethrow → 500 below.
        // Any other DOM/navigation miss on ONE profile is fail-soft.
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

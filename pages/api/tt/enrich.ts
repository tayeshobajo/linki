import type { NextApiRequest, NextApiResponse } from "next";
import { validateEnrichUrls, MAX_ENRICH_URLS, parseSearchName } from "@/lib/tt/params";

const seenKeys = new Map<string, number>();
const REPLAY_WINDOW_MS = 15 * 60 * 1000;

/** Trust Tai adapter enrich: strict-schema passthrough to internal /api/enrich. */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  const { urls: urls_raw, search_name, idempotency_key } = req.body || {};
  const now = Date.now();

  const urls = validateEnrichUrls(urls_raw);
  if (!urls) return res.status(400).json({ error: `urls must be an array of 1-${MAX_ENRICH_URLS} flagship /in/ URLs` });
  if (idempotency_key !== undefined && (typeof idempotency_key !== "string" || idempotency_key.length > 200))
    return res.status(400).json({ error: "invalid idempotency_key" });

  // Optional nav-first selector: a search_name switches the internal route to
  // natural navigation (search page → click → extract → back) instead of cold
  // /in/ deep-links. Present-but-invalid is a 400, absent is legacy mode.
  const searchName = parseSearchName(search_name);
  if (searchName === "") return res.status(400).json({ error: "search_name must be a string of 2-200 characters when present" });

  if (idempotency_key) {
    for (const [k, ts] of seenKeys) if (now - ts > REPLAY_WINDOW_MS) seenKeys.delete(k);
    if (seenKeys.has(idempotency_key)) return res.status(409).json({ error: "duplicate request" });
    seenKeys.set(idempotency_key, now);
  }

  const base = process.env.LINKI_INTERNAL_URL || "http://127.0.0.1:3456";
  try {
    const r = await fetch(base + "/api/enrich", {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-secret": process.env.INTERNAL_API_SECRET || "" },
      body: JSON.stringify({ urls, ...(searchName !== null ? { search_name: searchName } : {}) }),
    });
    const data = await r.json().catch(() => ({}));
    return res.status(r.status).json(data);
  } catch {
    return res.status(502).json({ error: "linki internal unreachable" });
  }
}

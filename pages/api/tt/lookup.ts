import type { NextApiRequest, NextApiResponse } from "next";

const seenKeys = new Map<string, number>();
const REPLAY_WINDOW_MS = 15 * 60 * 1000;

/** Trust Tai adapter lookup: strict-schema passthrough to internal /api/lookup. */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  const { keywords, limit, idempotency_key } = req.body || {};
  const now = Date.now();

  if (typeof keywords !== "string" || keywords.length < 2 || keywords.length > 120)
    return res.status(400).json({ error: "invalid keywords" });
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 25))
    return res.status(400).json({ error: "invalid limit" });
  if (idempotency_key !== undefined && (typeof idempotency_key !== "string" || idempotency_key.length > 200))
    return res.status(400).json({ error: "invalid idempotency_key" });

  if (idempotency_key) {
    for (const [k, ts] of seenKeys) if (now - ts > REPLAY_WINDOW_MS) seenKeys.delete(k);
    if (seenKeys.has(idempotency_key)) return res.status(409).json({ error: "duplicate request" });
    seenKeys.set(idempotency_key, now);
  }

  const base = process.env.LINKI_INTERNAL_URL || "http://127.0.0.1:3456";
  try {
    const r = await fetch(base + "/api/lookup", {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-secret": process.env.INTERNAL_API_SECRET || "" },
      body: JSON.stringify({ keywords, ...(limit ? { limit } : {}) }),
    });
    const data = await r.json().catch(() => ({}));
    return res.status(r.status).json(data);
  } catch {
    return res.status(502).json({ error: "linki internal unreachable" });
  }
}

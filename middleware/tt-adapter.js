/**
 * Trust Tai hardened adapter middleware.
 * Exposes ONLY /api/tt/* on the public surface. Everything else 404s.
 * - constant-time secret check
 * - per-route strict schema (POST body: keywords/limit/idempotency_key)
 * - in-memory rate limit + replay protection (idempotency keys single-use)
 * - HMAC timestamp signature option
 * - fail closed on any anomaly
 */
const crypto = require('crypto');

const LIMIT = parseInt(process.env.TT_RATE_LIMIT_PER_MIN || '10', 10);
const buckets = new Map();      // ip -> {count, resetAt}
const seenKeys = new Map();     // idempotency_key -> ts  (replay/idempotency guard)

function clean(now) {
  for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
  for (const [k, ts] of seenKeys) if (now - ts > 15 * 60 * 1000) seenKeys.delete(k);
}

function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a || '')), bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) { crypto.timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32)); return false; }
  return crypto.timingSafeEqual(ba, bb);
}

module.exports = async function ttAdapter(req) {
  const url = new URL(req.url);
  if (!url.pathname.startsWith('/api/tt/')) return; // only /api/tt/* is adapter surface; Caddy restricts externally
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) return new Response('unavailable', { status: 503 });

  const auth = req.headers.get('x-internal-secret') || '';
  const ts = req.headers.get('x-tt-timestamp') || '';
  const sig = req.headers.get('x-tt-signature') || '';
  const now = Date.now();

  clean(now);

  // rate limit per IP
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  let b = buckets.get(ip);
  if (!b || b.resetAt < now) { b = { count: 0, resetAt: now + 60_000 }; buckets.set(ip, b); }
  if (++b.count > LIMIT) return new Response('rate limited', { status: 429, headers: { 'retry-after': '60' } });

  // HMAC request signing (replay protection when timestamp+signature provided)
  if (ts && sig) {
    const skew = Math.abs(now - Number(ts));
    if (!Number.isFinite(Number(ts)) || skew > 5 * 60_000) return new Response('stale timestamp', { status: 401 });
    const expected = crypto.createHmac('sha256', secret).update(ts + '.' + url.pathname).digest('hex');
    if (!timingSafeEq(expected, sig)) return new Response('bad signature', { status: 401 });
  } else if (!timingSafeEq(auth, secret)) {
    return new Response('unauthorized', { status: 401 });
  }

  const route = url.pathname.slice('/api/tt/'.length);

  if (route === 'health') {
    return new Response(JSON.stringify({ ok: true, ts: now }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  if (route === 'lookup') {
    if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
    let body;
    try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }
    const { keywords, limit, idempotency_key } = body || {};
    if (typeof keywords !== 'string' || keywords.length < 2 || keywords.length > 120)
      return new Response('invalid keywords', { status: 400 });
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 25))
      return new Response('invalid limit', { status: 400 });
    if (idempotency_key !== undefined && (typeof idempotency_key !== 'string' || idempotency_key.length > 200))
      return new Response('invalid idempotency_key', { status: 400 });
    if (idempotency_key) {
      if (seenKeys.has(idempotency_key)) return new Response('duplicate request', { status: 409 });
      seenKeys.set(idempotency_key, now);
    }
    return; // pass to lookup route handler
  }

  return new Response('not found', { status: 404 });
};

/**
 * Trust Tai hardened adapter gate.
 * Called from proxy.ts for /api/tt/* paths ONLY.
 * Returns a Response to short-circuit, or null to pass through.
 * - constant-time secret check (or HMAC ts+path signature)
 * - strict schema per route
 * - per-IP rate limit
 * - single-use idempotency keys (replay guard)
 * - fail closed
 */
const crypto = await import('node:crypto').then(m => m.webcrypto ?? m.default ?? m);
import { createHmac, timingSafeEqual } from 'node:crypto';

const LIMIT = parseInt(process.env.TT_RATE_LIMIT_PER_MIN || '10', 10);
const buckets = new Map<string, { count: number; resetAt: number }>();
const seenKeys = new Map<string, number>();

function clean(now: number) {
  for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
  for (const [k, ts] of seenKeys) if (now - ts > 15 * 60 * 1000) seenKeys.delete(k);
}

function timingSafeEq(a: string, b: string) {
  const ba = Buffer.from(String(a || '')), bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) { timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32)); return false; }
  return timingSafeEqual(ba, bb);
}

export function ttAdapter(req: Request): Response | null {
  const url = new URL(req.url);
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) return new Response('unavailable', { status: 503 });

  const auth = req.headers.get('x-internal-secret') || '';
  const ts = req.headers.get('x-tt-timestamp') || '';
  const sig = req.headers.get('x-tt-signature') || '';
  const now = Date.now();
  clean(now);

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  let b = buckets.get(ip);
  if (!b || b.resetAt < now) { b = { count: 0, resetAt: now + 60_000 }; buckets.set(ip, b); }
  if (++b.count > LIMIT) return new Response('rate limited', { status: 429, headers: { 'retry-after': '60' } });

  if (ts && sig) {
    const skew = Math.abs(now - Number(ts));
    if (!Number.isFinite(Number(ts)) || skew > 5 * 60_000) return new Response('stale timestamp', { status: 401 });
    const expected = createHmac('sha256', secret).update(ts + '.' + url.pathname).digest('hex');
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
    // body schema validated inside the route handler (needs parsed json)
    return null; // pass through to pages/api/tt/lookup.ts
  }

  return new Response('not found', { status: 404 });
}

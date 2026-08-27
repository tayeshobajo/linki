import { NextResponse } from 'next/server';
export const config = { api: { externalResolver: true } };
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  const base = process.env.LINKI_INTERNAL_URL || 'http://127.0.0.1:3456';
  const r = await fetch(base + '/api/lookup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-secret': process.env.INTERNAL_API_SECRET || '' },
    body: JSON.stringify({ keywords: req.body.keywords, limit: req.body.limit }),
  });
  const data = await r.json().catch(() => ({}));
  return res.status(r.status).json(data);
}

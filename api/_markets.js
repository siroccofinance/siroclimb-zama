// Shared by the server routes: the market list (same file as the front) and small helpers.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const MARKETS = JSON.parse(readFileSync(join(root, 'js', 'chain', 'markets.json'), 'utf8')).markets;

export function send(res, status, body, maxAge = 0) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', maxAge ? `public, max-age=0, s-maxage=${maxAge}` : 'no-store');
  res.end(JSON.stringify(body));
}

const hits = new Map();
/** Per-client, per-route rate limit (requests per minute); true when over. Each route has its own
 *  count: the price polling (30 a minute) must not use up the drip's or the share link's budget. */
export function limited(req, perMinute, route = (req.url || '').split('?')[0]) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'local').split(',')[0].trim();
  const k = `${route}|${ip}`, now = Date.now(), h = hits.get(k);
  if (!h || now > h.reset) { hits.set(k, { n: 1, reset: now + 60_000 }); return false; }
  return ++h.n > perMinute;
}

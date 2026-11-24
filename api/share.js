// POST /api/share { market, status, pnlPct, maxLeverage, duration, pnl?, side? } → { id, url, image }
// Signs the result the player chose to reveal (see _share.js). pnl and side are left out to keep them private.
import { limited, send } from './_markets.js';
import { normalize, origin, sign } from './_share.js';

async function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  let s = ''; for await (const c of req) { s += c; if (s.length > 4096) throw new Error('too large'); }
  return JSON.parse(s || '{}');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('allow', 'POST'); return send(res, 405, { error: 'POST only' }); }
  if (limited(req, 30)) return send(res, 429, { error: 'Too many share links, try again in a minute' });
  let n;
  try { n = normalize(await body(req)); } catch { n = null; }
  if (!n) return send(res, 400, { error: 'Not a valid result' });
  let id;
  try { id = sign(n); } catch (e) { return send(res, 503, { error: 'Sharing is not configured' }); }
  const o = origin(req);
  send(res, 200, { id, url: `${o}/s/${id}`, image: `${o}/api/og?id=${encodeURIComponent(id)}` });
}

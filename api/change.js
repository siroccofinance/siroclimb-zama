// GET /api/change → { ok, at, markets: [{ id, pct, ref, refAt, now }] }
// The 24 h change of every market, from the hourly candles of the venue the game prices it with:
// Hyperliquid's xyz perps (candleSnapshot, 1h), else Kraken's OHLC (interval=60: xStock books, XAUTUSD,
// GBPUSD). ref = the price 24 h ago (the open of the hourly candle that holds that instant), now = the live
// mid (api/prices.js).
// A market without data gets pct null: the lobby hides the figure rather than show a made-up 0.00 %.
import { MARKETS, limited, send } from './_markets.js';
import { prices } from './prices.js';

const CACHE_MS = 60_000, DAY = 86_400;
let cache = null;

async function hlRef24(m, now) {
  const t = now - DAY;
  const r = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'candleSnapshot', req: { coin: m.hyperliquid, interval: '1h', startTime: (t - 7200) * 1000, endTime: (t + 3600) * 1000 } }), signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`hyperliquid ${r.status}`);
  const rows = await r.json(), c = Array.isArray(rows) && rows.find(x => x.t <= t * 1000 && t * 1000 <= x.T);
  const open = c ? Number(c.o) : NaN;
  if (!(open > 0)) throw new Error('hyperliquid: no candle 24 h ago');
  return { ref: open, refAt: Math.floor(c.t / 1000), src: 'hyperliquid' };
}

async function ref24(m, now) {
  if (m.hyperliquid) { try { return await hlRef24(m, now); } catch {} }
  const r = await fetch(`https://api.kraken.com/0/public/OHLC?pair=${m.kraken}&interval=60${m.krakenClass ? `&asset_class=${m.krakenClass}` : ''}`, { signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error(`kraken ${r.status}`);
  const d = await r.json();
  const rows = d.result && Object.entries(d.result).find(([k]) => k !== 'last')?.[1];
  if (!rows?.length) throw new Error(`kraken ${d.error?.join(',') || 'no candles'}`);
  const t = now - DAY, c = rows.find(x => x[0] <= t && t < x[0] + 3600);
  if (!c) throw new Error('no candle 24 h ago');
  const open = Number(c[1]);
  if (!(open > 0)) throw new Error('bad candle');
  return { ref: open, refAt: c[0], src: 'kraken' };
}

export async function changes() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.body;
  const now = Math.floor(Date.now() / 1000), live = await prices().catch(() => null);
  const rows = await Promise.all(MARKETS.map(async (m, i) => {
    const p = live?.markets?.[i]?.price;
    if (!m.kraken) return { id: m.id, pct: null };
    try {
      const { ref, refAt, src } = await ref24(m, now);
      return { id: m.id, ref, refAt, src, now: p ?? null, pct: p > 0 ? (p / ref - 1) * 100 : null };
    } catch (e) { return { id: m.id, pct: null, error: e.message }; }
  }));
  const body = { ok: true, at: Date.now(), markets: rows };
  if (rows.some(r => r.pct != null)) cache = { at: Date.now(), body };
  return body;
}

export default async function handler(req, res) {
  if (limited(req, 60, 'change')) return send(res, 429, { ok: false, reason: 'rate-limited' });
  try { send(res, 200, await changes(), 60); } catch (e) { send(res, 502, { ok: false, reason: e.message }); }
}

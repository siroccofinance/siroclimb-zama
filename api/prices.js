// Reference market data for the bounded fallback and the live chart, with market hours.
//  - stocks (TSLA, NVDA, AAPL) and GBP/USD: Yahoo Finance chart API (server side: no CORS),
//    1-minute candles including pre and post market; a stock market is "open" while now is
//    inside today's pre/regular/post session (4:00 to 20:00 New York time, trading days only)
//    and the last candle is recent. Outside sessions the market is closed in the game.
//  - gold (XAUt): Binance spot XAUTUSDT, always open (it trades around the clock).
// The browser posts these on chain with ClimbPriceOracle.pushPublic, which bounds every
// checkpoint (+/-0.5 % per 10 s, +/-3 % from the last Pyth price) whenever Pyth has no fresh price.
import { MARKETS, limited, send } from './_markets.js';

const CACHE_MS = 2000;
let cache = null;

async function yahoo(symbol) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d&includePrePost=true`, {
    headers: { 'user-agent': 'Mozilla/5.0 (siroclimb price route)' }, signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) throw new Error(`yahoo ${r.status}`);
  const res = (await r.json()).chart.result[0];
  const m = res.meta, now = Date.now() / 1000;
  const ts = res.timestamp || [], close = res.indicators?.quote?.[0]?.close || [];
  let last = -1; for (let i = close.length - 1; i >= 0; i--) if (close[i] != null) { last = i; break; }
  const price = m.regularMarketPrice ?? (last >= 0 ? close[last] : null);
  const at = Math.max(m.regularMarketTime || 0, last >= 0 ? ts[last] : 0);
  const p = m.currentTradingPeriod || {};
  const start = p.pre?.start ?? p.regular?.start, end = p.post?.end ?? p.regular?.end;
  const inSession = start != null && now >= start && now < end;
  return { price: last >= 0 && ts[last] > (m.regularMarketTime || 0) ? close[last] : price, at, open: inSession && now - at < 15 * 60, session: { start, end } };
}

async function binance(symbol) {
  const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`, { signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error(`binance ${r.status}`);
  return { price: Number((await r.json()).price), at: Date.now() / 1000, open: true };
}

export async function prices() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.body;
  const rows = await Promise.all(MARKETS.map(async (m, i) => {
    try {
      const q = m.yahoo ? await yahoo(m.yahoo) : await binance(m.binance);
      return { market: i, id: m.id, ...q, source: m.yahoo ? 'yahoo' : 'binance' };
    } catch (e) {
      return { market: i, id: m.id, price: null, open: false, error: e.message };
    }
  }));
  const body = { ok: true, at: Date.now(), markets: rows };
  cache = { at: Date.now(), body };
  return body;
}

export default async function handler(req, res) {
  if (limited(req, 120)) return send(res, 429, { ok: false, reason: 'rate-limited' });
  try { send(res, 200, await prices()); } catch (e) { send(res, 502, { ok: false, reason: e.message }); }
}

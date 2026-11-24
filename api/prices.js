// Reference market data for the bounded fallback and the live chart, with market hours.
//  - stocks (TSLAx, NVDAx, AAPLx, AMZNx): the xStock itself, the token the game's confidential tokens
//    wrap. xStocks trade 24/7, so these markets never close: Kraken's xStock spot book (asset class
//    tokenized_asset), mid of the best bid and ask, which moves every few seconds around the clock.
//    (Pyth's Equity.US feeds only move in the regular session and hold a frozen price with a fresh
//    timestamp outside it; Pyth's 24/7 Crypto.*X/USD feeds need a Hermes grant this key lacks.)
//  - GBP/USD: Yahoo Finance chart API (server side: no CORS), 1-minute candles, FX hours.
//  - gold (XAUt): Kraken spot XAUTUSD, always open (it trades around the clock), Yahoo XAUT-USD as
//    a fallback. Binance answers 451 from US hosting regions (Vercel), so it is not used.
// One source per market, always the same one: no alternating feeds, no spikes.
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

const lastGood = new Map();   // pair -> { q, at }: a failed poll keeps the last quote for 30 s (same source, no switch)
async function kraken(pair, aclass) {
  try {
    const r = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${pair}${aclass ? `&asset_class=${aclass}` : ''}`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error(`kraken ${r.status}`);
    const d = await r.json();
    const t = d.result && Object.values(d.result)[0];
    if (!t) throw new Error(`kraken ${d.error?.join(',') || 'no ticker'}`);
    const bid = Number(t.b[0]), ask = Number(t.a[0]);
    // xStocks: the mid of the book (the last trade can sit still for minutes on a quiet pair)
    const price = aclass && bid > 0 && ask > 0 ? (bid + ask) / 2 : Number(t.c[0]);
    const q = { price, at: Date.now() / 1000, open: price > 0 };
    lastGood.set(pair, { q, at: Date.now() });
    return q;
  } catch (e) {
    const g = lastGood.get(pair);
    if (g && Date.now() - g.at < 30_000) return g.q;
    throw e;
  }
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
      if (m.yahoo) return { market: i, id: m.id, ...(await yahoo(m.yahoo)), source: 'yahoo' };
      if (m.kraken) {
        try { return { market: i, id: m.id, ...(await kraken(m.kraken, m.krakenClass)), source: m.krakenClass ? 'kraken-xstock' : 'kraken' }; }
        catch (e) { if (!m.yahooFallback) throw e; const q = await yahoo(m.yahooFallback); return { market: i, id: m.id, ...q, open: true, source: 'yahoo' }; }
      }
      return { market: i, id: m.id, ...(await binance(m.binance)), source: 'binance' };
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

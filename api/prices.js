// Reference market data for the bounded fallback and the live chart, with market hours.
//  - stocks (TSLAx, NVDAx, AAPLx, AMZNx): the xStock itself, the token the game's confidential tokens
//    wrap. xStocks trade 24/7, so these markets never close: Kraken's xStock spot book (asset class
//    tokenized_asset), mid of the best bid and ask, which moves every few seconds around the clock.
//    (Pyth's Equity.US feeds only move in the regular session and hold a frozen price with a fresh
//    timestamp outside it; Pyth's 24/7 Crypto.*X/USD feeds need a Hermes grant this key lacks.)
//  - gold (XAUt) and GBP/USD: Kraken spot XAUTUSD and GBPUSD, mid of the book, both trade around the
//    clock (weekends included), so every market is open 24/7. Binance answers 451 from US hosting
//    regions (Vercel), so it is not used.
// Since 2026-11-26 every market is priced by Hyperliquid's trade.xyz perps (HIP-3 dex "xyz", one allMids
// call: xyz:TSLA, NVDA, AAPL, AMZN, GOLD, GBP; GBP quoted in USD like Kraken's GBPUSD). They tick 24/7,
// while Kraken's xStock books can sit still for minutes (US holidays). Kraken's mid (above) is only the
// fallback when Hyperliquid fails or has no mid for the market. Bybit is not used (about 0.5 % off).
// The browser posts these on chain with ClimbPriceOracle.pushPublic, which bounds every
// checkpoint (+/-0.5 % per 10 s, +/-3 % from the last Pyth price) whenever Pyth has no fresh price.
import { MARKETS, limited, send } from './_markets.js';

const CACHE_MS = 2000;
let cache = null;

const lastGood = new Map();   // pair -> { q, at }: a failed poll keeps the last quote for 30 s (same source, no switch)
async function kraken(pair, aclass, mid = !!aclass) {
  try {
    const r = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${pair}${aclass ? `&asset_class=${aclass}` : ''}`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error(`kraken ${r.status}`);
    const d = await r.json();
    const t = d.result && Object.values(d.result)[0];
    if (!t) throw new Error(`kraken ${d.error?.join(',') || 'no ticker'}`);
    const bid = Number(t.b[0]), ask = Number(t.a[0]);
    // the mid of the book (the last trade can sit still for minutes on a quiet pair)
    const price = mid && bid > 0 && ask > 0 ? (bid + ask) / 2 : Number(t.c[0]);
    const q = { price, at: Date.now() / 1000, open: price > 0 };
    lastGood.set(pair, { q, at: Date.now() });
    return q;
  } catch (e) {
    const g = lastGood.get(pair);
    if (g && Date.now() - g.at < 30_000) return g.q;
    throw e;
  }
}

let hlLast = null;   // { mids, at }: one allMids call serves every market; a failed call keeps it for 10 s
async function hyperliquid() {
  try {
    const r = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":"allMids","dex":"xyz"}', signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(`hyperliquid ${r.status}`);
    const mids = await r.json(); if (!mids || typeof mids !== 'object') throw new Error('hyperliquid: no mids');
    hlLast = { mids, at: Date.now() }; return mids;
  } catch { return hlLast && Date.now() - hlLast.at < 10_000 ? hlLast.mids : null; }
}
async function binance(symbol) {
  const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`, { signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error(`binance ${r.status}`);
  return { price: Number((await r.json()).price), at: Date.now() / 1000, open: true };
}

export async function prices() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.body;
  const hl = MARKETS.some(m => m.hyperliquid) ? hyperliquid() : Promise.resolve(null);
  const rows = await Promise.all(MARKETS.map(async (m, i) => {
    try {
      if (m.kraken) {
        const mids = await hl, h = m.hyperliquid && mids ? Number(mids[m.hyperliquid]) : NaN;
        if (h > 0) return { market: i, id: m.id, price: h, at: Date.now() / 1000, open: true, source: 'hyperliquid' };
        return { market: i, id: m.id, ...(await kraken(m.kraken, m.krakenClass, !!(m.krakenClass || m.krakenMid))), source: m.krakenClass ? 'kraken-xstock' : 'kraken' };
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
  if (limited(req, 120, 'prices')) return send(res, 429, { ok: false, reason: 'rate-limited' });
  try { send(res, 200, await prices()); } catch (e) { send(res, 502, { ok: false, reason: e.message }); }
}

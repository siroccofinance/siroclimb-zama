// Server-only proxy to Pyth Hermes. The API key (PYTH_API_KEY, or ~/.config/zama/pyth.key in
// local dev) never reaches the browser. The browser gets the *signed* update for our market feeds
// and posts it on chain itself (ClimbPriceOracle.pushPyth -> Pyth.updatePriceFeeds, verified with
// Wormhole signatures), so this route cannot forge prices: a tampered update is rejected on chain.
// Feeds the key is not entitled to (Hermes 403 "Not entitled") are skipped and remembered; those
// markets use the bounded public fallback (see /api/prices).
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MARKETS, limited, send } from './_markets.js';

const HERMES = process.env.PYTH_HERMES_URL || 'https://hermes.pyth.network';
const CACHE_MS = 1500;
const notEntitled = new Set();
let cache = null;

function apiKey() {
  if (process.env.PYTH_API_KEY) return process.env.PYTH_API_KEY.trim();
  const f = join(homedir(), '.config', 'zama', 'pyth.key');
  return process.env.NODE_ENV !== 'production' && existsSync(f) ? readFileSync(f, 'utf8').trim() : '';
}

export async function pythUpdate() {
  const key = apiKey();
  if (!key) return { ok: false, reason: 'no-key' };
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.body;
  for (let attempt = 0; attempt <= MARKETS.length; attempt++) {
    // pythLive false: the market's Pyth feed is not used (the stocks follow their 24/7 xStock, see prices.js)
    const feeds = MARKETS.filter(m => m.pythLive !== false).map(m => m.pyth.toLowerCase()).filter(f => !notEntitled.has(f));
    if (!feeds.length) return { ok: false, reason: 'no-entitled-feed' };
    const url = `${HERMES}/v2/updates/price/latest?${feeds.map(f => `ids[]=${f}`).join('&')}&parsed=true&encoding=hex`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(6000) });
    if (r.status === 403) {
      const m = /feed (0x)?([0-9a-fA-F]{64})/.exec(await r.text());
      if (!m) return { ok: false, reason: 'hermes-403' };
      notEntitled.add('0x' + m[2].toLowerCase());
      continue;
    }
    if (!r.ok) return { ok: false, reason: `hermes-${r.status}` };
    const d = await r.json();
    const body = {
      ok: true,
      updateData: d.binary.data.map(x => '0x' + x),
      prices: d.parsed.map(p => {
        const id = '0x' + p.id.toLowerCase();
        // mantissa and expo too: the front converts them exactly like the oracle does
        return { market: MARKETS.findIndex(m => m.pyth.toLowerCase() === id), price: Number(p.price.price) * 10 ** p.price.expo, mantissa: p.price.price, expo: p.price.expo, publishTime: p.price.publish_time };
      }),
      notEntitled: MARKETS.map((m, i) => (notEntitled.has(m.pyth.toLowerCase()) ? i : -1)).filter(i => i >= 0),
    };
    cache = { at: Date.now(), body };
    return body;
  }
  return { ok: false, reason: 'no-entitled-feed' };
}

export default async function handler(req, res) {
  if (limited(req, 90)) return send(res, 429, { ok: false, reason: 'rate-limited' });
  try {
    const body = await pythUpdate();
    send(res, body.ok ? 200 : 503, body);
  } catch (e) {
    send(res, 502, { ok: false, reason: e.name || 'error' });
  }
}

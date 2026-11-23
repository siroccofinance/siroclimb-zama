// Price checkpoints on chain, from this browser.
//  - Pyth (trustless): the signed Hermes update from our route rides along with game transactions
//    (startRun / cashOut) or is posted alone with `pushPyth`; the Pyth contract verifies it.
//  - Bounded fallback: markets the Hermes plan does not cover (or Pyth down) take the reference
//    price from /api/prices with `pushPublic`, clamped here to the oracle's bounds (+/-0.5 % per
//    checkpoint, at most every 10 s), so a fast market converges in a few checkpoints.
import { PRICE_DECIMALS } from './config.js';
import * as feed from './feed.js';
import { oracle, pythContract } from './wallet.js';

const MAX_MOVE = 0.0049;
const PYTH_FRESH_S = 20;

async function getPyth() {
  if (feed.pythPayload.body && Date.now() - feed.pythPayload.at < 2500) return feed.pythPayload.body;
  try {
    const r = await fetch('/api/pyth', { cache: 'no-store', signal: AbortSignal.timeout(6000) });
    const b = await r.json();
    if (b.ok) { feed.pythPayload.at = Date.now(); feed.pythPayload.body = b; }
    return b.ok ? b : null;
  } catch { return null; }
}

/** The signed Pyth update to ride along for `market`, with its fee, or null when Pyth does not cover it now. */
export async function pythFor(market) {
  const b = await getPyth();
  if (!b) return null;
  const p = b.prices.find(x => x.market === market);
  if (!p || Date.now() / 1000 - p.publishTime > PYTH_FRESH_S) return null;
  const fee = await pythContract.getUpdateFee(b.updateData);
  return { updateData: b.updateData, fee, price: p.price };
}

/** Writes a checkpoint for `market` if the last one is older than `maxAge` seconds. Returns the source used or null. */
export async function pushIfStale(sender, market, maxAge = 12) {
  const [, ts, last] = await oracle.latest(market);
  const age = Date.now() / 1000 - Number(ts);
  if (age < maxAge) return null;
  const pyth = await pythFor(market);
  if (pyth) { await sender.send(oracle, 'pushPyth', [pyth.updateData], pyth.fee, 'pushPyth'); return 'pyth'; }
  if (age < 10.5) return null;                                   // public spacing
  const ref = feed.refPrice(market);
  if (!(ref > 0) || !feed.isOpen(market)) return null;
  const lastP = Number(last) / 10 ** PRICE_DECIMALS;
  const clamped = Math.min(lastP * (1 + MAX_MOVE), Math.max(lastP * (1 - MAX_MOVE), ref));
  const units = BigInt(Math.round(clamped * 10 ** PRICE_DECIMALS));
  await sender.send(oracle, 'pushPublic', [[market], [units]], 0n, 'pushPublic');
  return 'public';
}

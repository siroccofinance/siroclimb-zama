// A finished run, read from the Siroclimb contract on Sepolia, never from the browser: player, market,
// top leverage, times, entry and exit prices, the public long and short multipliers, and, once the player
// has published it (publishRun + recordRun with the KMS proof), the player's own return. The side stays an
// encrypted bool; a published return equals one of the two public multipliers, so the side follows from it.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Contract, JsonRpcProvider } from 'ethers';
import { MARKETS } from './_markets.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const json = p => JSON.parse(readFileSync(join(root, p), 'utf8'));
const ADDR = json('js/chain/deployments.json')['11155111'];
const ABI = json('js/chain/abi.json');
const LADDER = [1, 1.5, 2, 2.5, 3, 3.5, 4], SCALE = 1e6, RUN_SECONDS = 60, ENDED = 2;
const RPC = process.env.CHAIN_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
/** The game before real positions (2026-11-25): share links minted for its runs keep reading it. */
export const LEGACY_GAME = '0x890b2bAb3f2EC280FcD4761cC0C655eaE13f03a0';
/** The game with real positions at a x25 boost on every market (2026-11-25 to 2026-11-26): its x and y links keep reading it. */
export const PREVIOUS_GAME = '0x95B271D1D751dfAA9E997caD0CE45B37B5ad242d';
let provider = null;
const games = new Map();
const contract = (address = ADDR.Siroclimb) => {
  provider ||= new JsonRpcProvider(RPC, 11155111, { staticNetwork: true, batchMaxCount: 1 });
  if (!games.has(address)) games.set(address, new Contract(address, ABI.Siroclimb, provider));
  return games.get(address);
};

const cache = new Map();   // game:runId -> verified run (a published run never changes)

async function retry(fn, n = 6) { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= n) throw e; await new Promise(r => setTimeout(r, 1200)); } } }

/** The published return of `runId` (pnl in millionths), or null when the run has not been published. */
async function publishedPnl(g, runId, tag) {
  const n = Number(await retry(() => g.resultCount(tag)));
  for (let to = n; to > 0; to -= 400) {
    const from = Math.max(0, to - 400);
    const list = await retry(() => g.results(from, to - from, tag));
    for (let i = list.length - 1; i >= 0; i--) if (Number(list[i].runId) === runId) return Number(list[i].pnlPpm);
    if (n - from > 4000) break;                     // far enough back
  }
  return null;
}

/**
 * The run as the chain has it: { runId, player, market, token, name, status, maxLeverage, duration,
 * entryPrice, exitPrice, published, pnlPct, side } (pnlPct and side null until published),
 * or null when the run does not exist or is not over.
 */
export async function verifiedRun(runId, game = ADDR.Siroclimb, atBlock = null) {
  const tag = atBlock ? { blockTag: atBlock } : {};    // as of a block the caller knows holds the record
  runId = Number(runId);
  if (!Number.isInteger(runId) || runId < 0) return null;
  const key = `${game}:${runId}`;
  if (cache.has(key)) return cache.get(key);
  const g = contract(game);
  if (runId >= Number(await retry(() => g.runCount(tag)))) return null;
  const r = await retry(() => g.getRun(BigInt(runId), tag));
  if (Number(r.status) !== ENDED) return null;
  const m = MARKETS[Number(r.market)]; if (!m) return null;
  const duration = Number(r.endAt - r.startAt), mL = Number(r.multLong), mS = Number(r.multShort);
  const pnl = r.published ? await publishedPnl(g, runId, tag) : null;
  const mult = pnl == null ? null : pnl + SCALE;
  const side = mult == null || mL === mS ? null : mult === mL ? 'long' : mult === mS ? 'short' : null;
  const v = {
    runId, player: r.player, market: m.id, token: m.token?.symbol || m.ticker, name: m.name,
    status: mult === 0 ? 'busted' : duration >= RUN_SECONDS ? 'expired' : 'cashed',
    maxLeverage: LADDER[Math.min(LADDER.length - 1, Number(r.topStep))], duration,
    entryPrice: Number(r.entryPrice) / 1e10, exitPrice: Number(r.exitPrice) / 1e10,
    published: pnl != null, pnlPct: pnl == null ? null : pnl / 1e4, side,
  };
  if (v.published) cache.set(key, v);
  return v;
}

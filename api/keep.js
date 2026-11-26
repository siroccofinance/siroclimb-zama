// GET /api/keep (Vercel cron, every minute): keeps every market's on-chain price fresh with no visitor.
// The players' browsers write checkpoints while someone plays; with nobody on the site the oracle went stale
// for hours (NVDAx 12 h, 1.1 % off), and the first run after that would have caught up 0.5 % per checkpoint
// toward the real price (a free trend). This pushes the reference price (/api/prices, Hyperliquid 24/7) as one
// bounded public checkpoint for every market that moved more than 0.05 % since its last checkpoint, or
// whose checkpoint is older than 20 minutes: the same `pushPublic` anyone may call, clamped on chain to
// +/-0.5 % of the last checkpoint. Key: KEEPER_KEY (server only). Authorization: CRON_SECRET (Vercel cron).
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Contract, JsonRpcProvider, Wallet, formatEther } from 'ethers';
import { send } from './_markets.js';
import { prices } from './prices.js';

const root = join(new URL('.', import.meta.url).pathname, '..');
const ADDR = JSON.parse(readFileSync(join(root, 'js/chain/deployments.json'), 'utf8'))['11155111'];
const RPC = process.env.KEEP_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
const ORACLE_ABI = [
  'function latestAll() view returns (uint64[] timestamps, uint64[] prices, uint8[] sources)',
  'function pushPublic(uint256[] markets, uint64[] prices)',
];
const MOVE = 0.0005, MAX_AGE = 20 * 60, MIN_SPACING = 11, CLAMP = 0.0049, WARN_ETH = 0.05;

function key() {
  if (process.env.KEEPER_KEY) return process.env.KEEPER_KEY.trim();
  const f = join(homedir(), '.config', 'siroclimb', 'sepolia', 'keeper.key');   // local dev only
  return process.env.VERCEL_ENV !== 'production' && existsSync(f) ? readFileSync(f, 'utf8').trim() : '';
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) return send(res, 401, { ok: false });
  const k = key(); if (!k) return send(res, 503, { ok: false, error: 'Keeper not configured' });
  const provider = new JsonRpcProvider(RPC, 11155111, { staticNetwork: true, batchMaxCount: 1 });
  const w = new Wallet(k, provider), oracle = new Contract(ADDR.ClimbPriceOracle, ORACLE_ABI, w);
  try {
    const [[ts, px], ref] = await Promise.all([oracle.latestAll(), prices()]);
    const now = Date.now() / 1000, ms = [], ps = [], plan = [];
    for (const m of ref.markets) {
      if (!m.open || !(m.price > 0)) continue;
      const last = Number(px[m.market]) / 1e10, age = now - Number(ts[m.market]);
      const dev = last ? Math.abs(m.price / last - 1) : 1;
      if (age < MIN_SPACING || (dev < MOVE && age < MAX_AGE)) continue;
      const target = Math.min(last * (1 + CLAMP), Math.max(last * (1 - CLAMP), m.price));
      ms.push(m.market); ps.push(BigInt(Math.round(target * 1e10)));
      plan.push(`${m.id} ${last} -> ${target.toFixed(6)} (ref ${m.price}, ${Math.round(age)} s old)`);
    }
    if (!ms.length) return send(res, 200, { ok: true, pushed: [] });
    const fee = await provider.getFeeData(), tip = 200_000_000n;
    const tx = await oracle.pushPublic(ms, ps, { maxPriorityFeePerGas: tip, maxFeePerGas: (fee.maxFeePerGas ?? 0n) * 2n + tip });
    const left = Number(formatEther(await provider.getBalance(w.address).catch(() => 0n)));
    (left < WARN_ETH ? console.warn : console.log)(`keep ${tx.hash}: ${plan.join('; ')}; keeper ${w.address} has ${left.toFixed(4)} ETH${left < WARN_ETH ? ' (LOW: top it up)' : ''}`);
    send(res, 200, { ok: true, pushed: plan, tx: tx.hash });
  } catch (e) {
    console.error('keep failed', e.shortMessage || e.message);
    send(res, 502, { ok: false, error: e.shortMessage || e.message });
  }
}

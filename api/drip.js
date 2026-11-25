// POST /api/drip { player }: first visit, server side. The moment a wallet has derived its game account,
// a dedicated drip key (DRIP_KEY, server only) sends that account a little Sepolia gas AND claims its
// 1,000 test cUSDC from ClimbFaucet (claimFor is permissionless), both in parallel: one block instead
// of a wallet transfer, its confirmation, then the account's own claim. The wallet needs no Sepolia ETH.
// Only what is missing is sent (gas below the floor, the first claim); rate-limited per client and per
// address. The front calls it again when the account runs low (re-drip on demand).
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Contract, JsonRpcProvider, Wallet, getAddress, parseEther, formatEther } from 'ethers';
import { limited, send } from './_markets.js';
import { readJson } from './_body.js';

const RPC = process.env.DRIP_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
const root = join(new URL('.', import.meta.url).pathname, '..');
const ADDR = JSON.parse(readFileSync(join(root, 'js/chain/deployments.json'), 'utf8'))['11155111'];
// Measured on Sepolia (F60): startRun 3.46M gas, cashOut 3.67M, deposit 2.08M, setOperator 0.13M, paid at
// the 0.2 gwei tip floor: ~0.0014 ETH per start + cash out. A drip of 0.005 ETH covers the first few runs
// with margin; the front asks again (re-drip on demand) when the account falls below SESSION_MIN_ETH,
// which covers one 6M-gas transaction at up to 0.4 gwei.
const GAS_ETH = '0.005', MIN_ETH = 0.0025;           // SESSION_FUND_ETH / SESSION_MIN_ETH in js/chain/config.js
const WARN_ETH = 0.05;                              // logs a warning when the drip key runs low
const REDRIP_MS = 10 * 60_000;                      // gas at most once per 10 min per address (this instance)
const FAUCET_ABI = ['function claimFor(address account)', 'function waitOf(address account) view returns (uint256)', 'function lastClaim(address account) view returns (uint256)'];

function key() {
  if (process.env.DRIP_KEY) return process.env.DRIP_KEY.trim();
  const f = join(homedir(), '.config', 'siroclimb', 'sepolia', 'drip.key');   // local dev only
  return process.env.VERCEL_ENV !== 'production' && existsSync(f) ? readFileSync(f, 'utf8').trim() : '';
}
const seen = new Map();                              // player -> last gas drip (this instance)
const claimed = new Map();                           // player -> claim sent (this instance): not twice while it lands
let nonceLock = Promise.resolve();

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' });
  if (limited(req, 6)) return send(res, 429, { ok: false, error: 'Too many requests, try again in a minute' });
  const k = key(); if (!k) return send(res, 503, { ok: false, error: 'Drip not configured' });
  let player;
  try { player = getAddress(String((await readJson(req)).player || '')); } catch { return send(res, 400, { ok: false, error: 'Bad address' }); }
  const provider = new JsonRpcProvider(RPC, 11155111, { staticNetwork: true, batchMaxCount: 1 });
  const w = new Wallet(k, provider), faucet = new Contract(ADDR.ClimbFaucet, FAUCET_ABI, w);
  try {
    const [eth, last] = await Promise.all([provider.getBalance(player), faucet.lastClaim(player)]);
    // gas: only below the floor, at most once per REDRIP_MS; the 1,000 cUSDC: only on the very first visit
    const needGas = Number(formatEther(eth)) < MIN_ETH && Date.now() - (seen.get(player) || 0) >= REDRIP_MS, needClaim = last === 0n && Date.now() - (claimed.get(player) || 0) >= REDRIP_MS;
    if (needGas) seen.set(player, Date.now());
    if (needClaim) claimed.set(player, Date.now());
    if (!needGas && !needClaim) return send(res, 200, { ok: true, gas: null, claim: null });
    // both transactions leave together from one key: consecutive nonces, taken under a lock
    const out = await (nonceLock = nonceLock.catch(() => {}).then(async () => {
      let n = await provider.getTransactionCount(w.address, 'pending');
      const fee = await provider.getFeeData();
      const opts = { maxFeePerGas: fee.maxFeePerGas * 2n, maxPriorityFeePerGas: fee.maxPriorityFeePerGas * 2n };
      const sent = await Promise.all([
        needGas ? w.sendTransaction({ to: player, value: parseEther(GAS_ETH), nonce: n++, ...opts }) : null,
        needClaim ? faucet.claimFor(player, { nonce: n++, gasLimit: 1_600_000n, ...opts }) : null,
      ]);
      return sent;
    }));
    send(res, 200, { ok: true, gas: out[0]?.hash ?? null, claim: out[1]?.hash ?? null });
    const left = Number(formatEther(await provider.getBalance(w.address).catch(() => 0n)));
    (left < WARN_ETH ? console.warn : console.log)(`drip ${player}${out[0] ? ` gas ${GAS_ETH}` : ''}${out[1] ? ' claim' : ''}; drip key ${w.address} has ${left.toFixed(4)} ETH left${left < WARN_ETH ? ' (LOW: top it up)' : ''}`);
  } catch (e) {
    seen.delete(player); claimed.delete(player);
    console.error('drip failed', player, e.shortMessage || e.message);
    send(res, 502, { ok: false, error: e.shortMessage || e.message });
  }
}

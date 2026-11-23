// Shared by the ops scripts (battery, keeper): Sepolia provider, contracts, nonce-safe senders,
// the Zama relayer SDK (Node build), price checkpoints (same server code as the site's routes).
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Contract, HDNodeWallet, JsonRpcProvider, Mnemonic, Wallet, formatEther, parseEther } from 'ethers';
import { pythUpdate } from '../api/pyth.js';
import { prices } from '../api/prices.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const json = p => JSON.parse(readFileSync(join(root, p), 'utf8'));
export const ADDR = json('js/chain/deployments.json')['11155111'];
export const ABI = json('js/chain/abi.json');
export const MARKETS = json('js/chain/markets.json').markets;
export const RPC_URL = process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
export const provider = new JsonRpcProvider(RPC_URL, 11155111, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1, pollingInterval: 2000 });
export const game = new Contract(ADDR.Siroclimb, ABI.Siroclimb, provider);
export const oracle = new Contract(ADDR.ClimbPriceOracle, ABI.ClimbPriceOracle, provider);
export const ladder = new Contract(ADDR.ClimbLadder, ABI.ClimbLadder, provider);
export const faucet = new Contract(ADDR.ClimbFaucet, ABI.ClimbFaucet, provider);
export const token = new Contract(ADDR.StakeToken, ABI.ERC7984, provider);
export const pyth = new Contract(ADDR.Pyth, ['function getUpdateFee(bytes[]) view returns (uint256)'], provider);
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const USDC = 1_000_000n, SCALE = 1_000_000n;

const cfg = f => join(homedir(), '.config', 'zama', f);
export function key(file) { const k = readFileSync(cfg(file), 'utf8').trim(); return k.startsWith('0x') ? k : '0x' + k; }
/** Battery players: own mnemonic (never shared with another project), index i. */
export function batteryWallet(i) {
  const m = Mnemonic.fromPhrase(readFileSync(cfg('siroclimb-battery.mnemonic'), 'utf8').trim());
  return HDNodeWallet.fromMnemonic(m, `m/44'/60'/0'/0/${i}`).privateKey;
}
export const hasFile = f => existsSync(cfg(f));

export function errText(e) {
  const data = e?.data || e?.info?.error?.data || e?.error?.data;
  for (const c of [game, oracle, faucet]) { try { const d = c.interface.parseError(typeof data === 'string' ? data : data?.data); if (d) return `${d.name}(${d.args.join(', ')})`; } catch {} }
  return e?.shortMessage || e?.message || String(e);
}

const MIN_TIP = 200_000_000n;
export async function fees() {
  const fd = await provider.getFeeData();
  const tip = (fd.maxPriorityFeePerGas ?? 0n) > MIN_TIP ? fd.maxPriorityFeePerGas : MIN_TIP;
  return { maxPriorityFeePerGas: tip, maxFeePerGas: (fd.maxFeePerGas ?? fd.gasPrice ?? 0n) + tip };
}
const RETRY = /nonce|underpriced|already known|replacement|timeout|ECONNRESET|socket|fetch failed|503|502|429|missing response|insufficient funds/i;
/** One key, one queue: nonces tracked locally, resynced after any failure (public RPCs lag). */
export class Sender {
  constructor(k, label = '') { this.wallet = new Wallet(k, provider); this.address = this.wallet.address; this.label = label; this.q = Promise.resolve(); this.nonce = null; this.gasSpent = 0n; }
  send(contract, method, args = [], value = 0n) {
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const c = contract.connect(this.wallet);
          const est = await c[method].estimateGas(...args, { value });
          const gasLimit = est * 2n > 16_000_000n ? 16_000_000n : est * 2n;
          const pending = await provider.getTransactionCount(this.address, 'pending');
          const nonce = this.nonce == null ? pending : Math.max(this.nonce, pending);
          const tx = await c[method](...args, { value, gasLimit, nonce, ...(await fees()) });
          this.nonce = nonce + 1;
          const rc = await provider.waitForTransaction(tx.hash, 1, 240_000);
          if (!rc) throw new Error(`timeout waiting for ${method} ${tx.hash}`);
          if (rc.status !== 1) throw new Error(`${method} reverted ${tx.hash}`);
          this.gasSpent += rc.gasUsed * (rc.gasPrice ?? 0n);
          return rc;
        } catch (e) {
          this.nonce = null;
          if (attempt < 4 && RETRY.test(errText(e))) { await sleep(3000 + attempt * 2000); continue; }
          throw e;
        }
      }
    };
    const p = this.q.then(run, run); this.q = p.catch(() => {}); return p;
  }
  sendEth(to, eth) {
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const pending = await provider.getTransactionCount(this.address, 'pending');
          const nonce = this.nonce == null ? pending : Math.max(this.nonce, pending);
          const tx = await this.wallet.sendTransaction({ to, value: parseEther(String(eth)), nonce, ...(await fees()) });
          this.nonce = nonce + 1;
          await provider.waitForTransaction(tx.hash, 1, 240_000);
          return tx.hash;
        } catch (e) { this.nonce = null; if (attempt < 4 && RETRY.test(errText(e))) { await sleep(3000); continue; } throw e; }
      }
    };
    const p = this.q.then(run, run); this.q = p.catch(() => {}); return p;
  }
  async eth() { return Number(formatEther(await provider.getBalance(this.address))); }
}

// ── FHE (Zama relayer SDK, Node build)
let fheP = null;
export function fhe() {
  fheP ||= (async () => { const { createInstance, SepoliaConfig } = await import('@zama-fhe/relayer-sdk/node'); return createInstance({ ...SepoliaConfig, network: RPC_URL }); })();
  return fheP;
}
const hex = b => '0x' + Buffer.from(b).toString('hex');
export async function encryptRun(sender, long, stakeUnits) {
  const input = (await fhe()).createEncryptedInput(ADDR.Siroclimb, sender);
  input.addBool(long); if (stakeUnits != null) input.add64(BigInt(stakeUnits));
  const enc = await input.encrypt();
  return { handles: enc.handles.map(hex), proof: hex(enc.inputProof) };
}
const grants = new Map();
/** User decryption by a wallet we hold (EIP-712 grant signed in Node). */
export async function userDecrypt(wallet, items) {
  const f = await fhe();
  let g = grants.get(wallet.address);
  if (!g) {
    const kp = f.generateKeypair(), start = Math.floor(Date.now() / 1000), contracts = [ADDR.Siroclimb, ADDR.StakeToken];
    const t = f.createEIP712(kp.publicKey, contracts, start, 1);
    const types = { ...t.types }; delete types.EIP712Domain;
    const sig = await wallet.signTypedData(t.domain, types, t.message);
    g = { kp, start, contracts, sig }; grants.set(wallet.address, g);
  }
  const live = items.filter(i => !/^0x0+$/.test(i.handle));
  const out = new Map();
  if (live.length) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await f.userDecrypt(live.map(i => ({ handle: i.handle, contractAddress: i.contract })), g.kp.privateKey, g.kp.publicKey, g.sig.replace('0x', ''), g.contracts, wallet.address, g.start, 1);
        for (const i of live) out.set(i.handle, BigInt(res[i.handle]));
        break;
      } catch (e) { if (attempt >= 5) throw e; await sleep(3000 + attempt * 2000); }
    }
  }
  return items.map(i => out.get(i.handle) ?? 0n);
}
export async function balanceOf(wallet) {
  const h = await token.confidentialBalanceOf(wallet.address);
  return (await userDecrypt(wallet, [{ handle: h, contract: ADDR.StakeToken }]))[0];
}
export async function publicDecrypt(handles) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await (await fhe()).publicDecrypt(handles);
      return { values: handles.map(h => { const v = res.clearValues[h]; return typeof v === 'boolean' ? (v ? 1n : 0n) : BigInt(v); }), proof: res.decryptionProof };
    } catch (e) { if (attempt >= 8) throw e; await sleep(3000 + attempt * 1500); }   // the gateway may not have seen the ACL change yet
  }
}

// ── prices
export async function pythFor(market) {
  const b = await pythUpdate();
  if (!b.ok) return null;
  const p = b.prices.find(x => x.market === market);
  if (!p || Date.now() / 1000 - p.publishTime > 20) return null;
  return { updateData: b.updateData, fee: await pyth.getUpdateFee(b.updateData) };
}
/** Bounded public price to ride along with startRun (0n when the checkpoint is fresh). */
export async function fallbackFor(market, fresh = 0) {
  const [, ts, last] = await oracle.latest(market);
  if (Date.now() / 1000 - Number(ts) < fresh) return 0n;
  const ref = (await prices()).markets[market];
  if (!(ref?.price > 0)) return 0n;
  const lastP = Number(last) / 1e10;
  return BigInt(Math.round(Math.min(lastP * 1.0049, Math.max(lastP * 0.9951, ref.price)) * 1e10));
}
/** Fresh checkpoint for `market` from `sender` if the last one is older than maxAge s. */
export async function pushIfStale(sender, market, maxAge = 11) {
  const [, ts, last] = await oracle.latest(market);
  const age = Date.now() / 1000 - Number(ts);
  if (age < maxAge) return null;
  const py = await pythFor(market);
  if (py) { await sender.send(oracle, 'pushPyth', [py.updateData], py.fee); return 'pyth'; }
  if (age < 10.5) return null;
  const ref = (await prices()).markets[market];
  if (!(ref?.price > 0) || !ref.open) return null;
  const lastP = Number(last) / 1e10, c = Math.min(lastP * 1.0049, Math.max(lastP * 0.9951, ref.price));
  await sender.send(oracle, 'pushPublic', [[market], [BigInt(Math.round(c * 1e10))]]);
  return 'public';
}
export async function openMarkets() { return (await prices()).markets.filter(m => m.open).map(m => m.market); }

/** Realistic player handles (no "test" or "bot"): trading, desert winds, RWA words. */
const A = ['saffron', 'dune', 'mistral', 'atlas', 'oasis', 'zephyr', 'bullion', 'tesla', 'nvda', 'apple', 'sterling', 'gold', 'quiet', 'alpha', 'delta', 'theta', 'night', 'cedar'];
const B = ['trader', 'whale', 'falcon', 'lynx', 'hodler', 'scalper', 'otter', 'climber', 'nomad', 'monk', 'fox', 'raven', 'gecko', 'ape', 'maxi', 'sniper'];
export function handle(i) {
  let s = (i * 2654435761) >>> 0; const r = () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const a = A[Math.floor(r() * A.length)], b = B[Math.floor(r() * B.length)], n = Math.floor(r() * 99);
  return [`${a}_${b}`, `${a}${b}${n}`, `${a}.${b}`, `${b}${n}`, `${a}.eth`][Math.floor(r() * 5)].slice(0, 24);
}

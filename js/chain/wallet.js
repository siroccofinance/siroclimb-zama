// Wallet + game account.
//  - The wallet (MetaMask, Rabby... any injected EIP-1193 provider) signs one message, once: the game
//    account's key is derived from that signature, so the same wallet finds the same account on any
//    device. It also sends the account a little Sepolia ETH for gas. That is all it is asked for.
//  - The game account holds the player's test cUSDC and sends every game transaction (start, cash
//    out, join, faucet, operator approval) and signs the decryption grant locally: no pop-up during
//    play. It plays with test tokens only.
// Every sender (game account, keeper key) has one queue: one transaction at a time
// with a locally tracked nonce, so concurrent duties never race for a nonce.
import { BrowserProvider, Contract, FetchRequest, JsonRpcProvider, Wallet, getBytes, keccak256, parseEther, formatEther, toUtf8Bytes } from '../vendor/ethers-6.17.0.min.js';
import { ABI, ADDR, CHAIN_HEX, CHAIN_ID, RPC_URL, SESSION_FUND_ETH, SESSION_MIN_ETH } from './config.js';

// a request the RPC never answers fails after 20 s (ethers waits 5 minutes by default), and is retried
const rpcRequest = new FetchRequest(RPC_URL);
rpcRequest.timeout = 20_000;
// on HTTP 429 ethers retries up to 12 times with growing back-off (minutes of silence): keep it short,
// our own senders retry rate limits anyway (F34)
rpcRequest.setThrottleParams({ maxAttempts: 3, slotInterval: 500 });
export const rpc = new JsonRpcProvider(rpcRequest, CHAIN_ID, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1, pollingInterval: 1000 });
export const game = new Contract(ADDR.Siroclimb, ABI.Siroclimb, rpc);
export const oracle = new Contract(ADDR.ClimbPriceOracle, ABI.ClimbPriceOracle, rpc);
export const token = new Contract(ADDR.StakeToken, ABI.ERC7984, rpc);
export const faucet = new Contract(ADDR.ClimbFaucet, ABI.ClimbFaucet, rpc);
export const pythContract = new Contract(ADDR.Pyth, ['function getUpdateFee(bytes[] updateData) view returns (uint256)'], rpc);

// ───────────────────────────── senders (session key, keeper key)
const TX_GAS_CAP = 16_000_000n;
/** Gas limits of game calls, about 1.5x to 2x the peak measured on Sepolia (FINDINGS F35). */
const FIXED_GAS = { startRun: 6_000_000n, cashOut: 4_500_000n, settleRun: 4_000_000n, joinRound: 5_000_000n, exitAtBell: 2_500_000n, claim: 2_500_000n };
// 'unknown custom error': right after the operator approval, a lagging node can still refuse the
// token transfer (the error comes from the token contract); a few seconds later it goes through
const RETRY = /nonce|underpriced|already known|replacement|timeout|failed to fetch|network|ECONNRESET|503|502|429|insufficient funds|unknown custom error|Panic\(50\)/i;

export class Sender {
  constructor(key) { this.wallet = new Wallet(key, rpc); this.address = this.wallet.address; this.queue = Promise.resolve(); this.nonce = null; }
  /** Sends `contract.method(...args)` from this key, serialized with its other transactions. */
  /**
   * `fast`: resolves as soon as the transaction is broadcast, with { hash, mined } (mined = the
   * receipt promise), so the screen can move on while Sepolia includes it.
   */
  send(contract, method, args = [], value = 0n, label = method, { fast = false } = {}) {
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const c = contract.connect(this.wallet);
          // game calls with a known cost skip the estimate (one round trip less, and no stale-state
          // estimate right after a previous transaction); a call that would revert is caught by its receipt
          let gas = FIXED_GAS[method];
          if (!gas) {
            const est = await c[method].estimateGas(...args, { value });
            gas = est * 2n > TX_GAS_CAP ? TX_GAS_CAP : est * 2n;     // the FHE cost depends on the state it lands on
          }
          const nonce = this.nonce ?? (await rpc.getTransactionCount(this.address, 'pending'));
          const tx = await c[method](...args, { value, gasLimit: gas, nonce, ...(await fees()) });
          this.nonce = nonce + 1;
          emitTx({ label, hash: tx.hash, from: this.address, state: 'sent' });
          const check = async () => {
            const rc = await receipt(tx.hash);
            if (!rc || rc.status !== 1) { this.nonce = null; throw new Error(`${label} reverted`); }
            emitTx({ label, hash: tx.hash, from: this.address, state: 'mined' });
            return rc;
          };
          if (fast) return { hash: tx.hash, mined: check() };
          const rc = await check();
          if (!rc || rc.status !== 1) throw new Error(`${label} reverted`);
          return rc;
        } catch (e) {
          this.nonce = null;
          if (attempt < 3 && RETRY.test(errText(e))) { await sleep(2500 + attempt * 2000); continue; }
          throw e;
        }
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }
  async eth() { return Number(formatEther(await rpc.getBalance(this.address))); }
  /** Plain ETH transfer (gas for the keeper key), through the same queue. */
  sendEth(to, eth) {
    const run = async () => {
      const pending = await rpc.getTransactionCount(this.address, 'pending');
      const nonce = this.nonce == null ? pending : Math.max(this.nonce, pending);
      const tx = await this.wallet.sendTransaction({ to, value: parseEther(String(eth)), nonce });
      this.nonce = nonce + 1;
      if (!(await receipt(tx.hash))) throw new Error('transfer not mined');
    };
    const p = this.queue.then(run, run).catch(e => { this.nonce = null; throw e; });
    this.queue = p.catch(() => {});
    return p;
  }
}

/** A key derived from the session key (keeper duties): same browser, own nonce queue. */
export function derived(sender, tag) {
  const key = keccak256(toUtf8Bytes(`${sender.key}:${tag}`));
  return new Sender(key);
}

/** A small tip above the floor so a game transaction lands in the next block even when Sepolia is busy. */
const MIN_TIP = 200_000_000n; // 0.2 gwei
async function fees() {
  const fd = await rpc.getFeeData();
  const tip = (fd.maxPriorityFeePerGas ?? 0n) > MIN_TIP ? fd.maxPriorityFeePerGas : MIN_TIP;
  return { maxPriorityFeePerGas: tip, maxFeePerGas: (fd.maxFeePerGas ?? fd.gasPrice ?? 0n) + tip };
}

/** Polls for a receipt every second (ethers' waitForTransaction can miss blocks behind a load balancer). */
export async function receipt(hash, ms = 180_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const rc = await rpc.getTransactionReceipt(hash).catch(() => null);
    if (rc) return rc;
    await sleep(1000);
  }
  return null;
}

const txSubs = new Set();
export const onTx = cb => (txSubs.add(cb), () => txSubs.delete(cb));
const emitTx = t => txSubs.forEach(cb => { try { cb(t); } catch {} });

// ───────────────────────────── wallet
let wallet = null;      // { provider, signer, address }
const store = {
  get: (k, d) => { try { const v = localStorage.getItem('siroclimb:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('siroclimb:' + k, JSON.stringify(v)); } catch {} },
  del: k => { try { localStorage.removeItem('siroclimb:' + k); } catch {} },
};
export { store };

export const account = () => wallet?.address || null;
export const hasWallet = () => !!window.ethereum;

async function ensureSepolia(eth) {
  const id = await eth.request({ method: 'eth_chainId' });
  if (id === CHAIN_HEX) return;
  try { await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_HEX }] }); }
  catch (e) {
    if (e.code !== 4902) throw new Error('Switch your wallet to Sepolia');
    await eth.request({ method: 'wallet_addEthereumChain', params: [{ chainId: CHAIN_HEX, chainName: 'Sepolia', nativeCurrency: { name: 'Sepolia ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: [RPC_URL], blockExplorerUrls: ['https://sepolia.etherscan.io'] }] });
  }
}

/** Connects the injected wallet on Sepolia. `silent`: only if already authorised (page reload). */
export async function connectWallet(silent = false) {
  const eth = window.ethereum;
  if (!eth) throw new Error('No wallet found. Install MetaMask or Rabby, then reload');
  const accts = await eth.request({ method: silent ? 'eth_accounts' : 'eth_requestAccounts' });
  if (!accts?.length) { if (silent) return null; throw new Error('Wallet connection refused'); }
  if (!silent) await ensureSepolia(eth);
  else if ((await eth.request({ method: 'eth_chainId' })) !== CHAIN_HEX) return null;
  const provider = new BrowserProvider(eth, 'any');
  const signer = await provider.getSigner(accts[0]);
  wallet = { provider, signer, address: await signer.getAddress() };
  store.set('wallet', wallet.address);
  eth.on?.('accountsChanged', a => { if (wallet && a[0]?.toLowerCase() !== wallet.address.toLowerCase()) location.reload(); });
  eth.on?.('chainChanged', () => location.reload());
  return wallet.address;
}
export function disconnectWallet() { wallet = null; store.del('wallet'); }
export const wasConnected = () => !!store.get('wallet', null);

// ───────────────────────────── game account
// The player's game account is a key derived from one wallet signature (the same wallet always
// derives the same account, on any device). It holds the player's test cUSDC, signs every game
// transaction and the decryption grant locally: after that single signature and one gas transfer,
// nothing asks the wallet again. The key never leaves the browser.
let session = null;
const keyStore = owner => 'gamekey:' + owner.toLowerCase();
export const gameMessage = owner =>
  `Siroclimb game account\n\nSign to create (or recover) your Siroclimb game key on this device. The key stays in your browser and plays with test tokens on Sepolia.\n\nWallet: ${owner}\nChain: ${CHAIN_ID}`;
function sessionFromKey(k) {
  if (!session || session.key !== k) { session = new Sender(k); session.key = k; }
  return session;
}
export function storedGameKey(owner) { return store.get(keyStore(owner), null); }
export const currentSession = () => {
  const k = wallet && storedGameKey(wallet.address);
  return k ? sessionFromKey(k) : null;
};
/** The game account's address (the on-chain player), or null before the first signature. */
export const player = () => currentSession()?.address || null;
let keeper = null;
/** The keeper key: autopilot duties never queue behind the player's own transactions. */
export function currentKeeper() {
  const s = currentSession(); if (!s) return null;
  if (!keeper || keeper.parent !== s.address) { keeper = derived(s, 'keeper'); keeper.parent = s.address; }
  return keeper;
}
/** EIP-712 signature by the game account (decryption grant): local, no wallet pop-up. */
export async function signTyped(t) {
  const s = currentSession(); if (!s) throw new Error('Connect your wallet first');
  const types = { ...t.types }; delete types.EIP712Domain;
  return s.wallet.signTypedData(t.domain, types, t.message);
}

/** What is missing before playing: [] when ready. 'key' = one wallet signature, 'gas' = one transfer. */
export async function setupNeeds() {
  const s = currentSession();
  if (!s) return ['key', 'gas'];
  return (await s.eth()) < SESSION_MIN_ETH ? ['gas'] : [];
}

/**
 * First visit: one wallet signature (derives the game account) and one transfer (gas for it). The
 * account then approves the game as ERC-7984 operator of its own cUSDC in the background, queued
 * before its first game transaction. `step(label)` reports progress.
 */
export async function setup(step = () => {}) {
  if (!storedGameKey(wallet.address)) {
    step('Sign once to create your game account (wallet)');
    const sig = await wallet.signer.signMessage(gameMessage(wallet.address));
    store.set(keyStore(wallet.address), keccak256(sig));
  }
  const s = currentSession();
  if ((await s.eth()) < SESSION_MIN_ETH) {
    const spare = (await walletEth()) - 0.002;
    const fund = Math.min(Number(SESSION_FUND_ETH), spare);
    if (fund < 0.008) throw new Error('Your wallet needs a little Sepolia ETH (about 0.03) for game gas. Get some from a Sepolia faucet');
    step('Send gas to your game account (wallet)');
    const tx = await wallet.signer.sendTransaction({ to: s.address, value: parseEther(fund.toFixed(6)) });
    emitTx({ label: 'fund', hash: tx.hash, from: wallet.address, state: 'sent' });
    step('Confirming on Sepolia…');
    await mined(tx.hash, 'gas transfer');
  }
  ensureOperator(s);
  return s;
}

/** The game account lets the game pull its stakes (ERC-7984 operator), once, in its own queue. */
let operatorChecked = null;
export function ensureOperator(s = currentSession()) {
  if (!s) return Promise.resolve();
  operatorChecked ||= (async () => {
    if (await token.isOperator(s.address, ADDR.Siroclimb)) return;
    await s.send(token, 'setOperator', [ADDR.Siroclimb, Math.floor(Date.now() / 1000) + 365 * 86400], 0n, 'setOperator');
  })().catch(e => { operatorChecked = null; throw e; });
  return operatorChecked;
}

async function mined(hash, what) {
  const rc = await receipt(hash, 300_000);
  if (!rc || rc.status !== 1) throw new Error(`${what} failed`);
  return rc;
}

/** The connected wallet (the owner of the game account). */
export const walletAddress = () => wallet?.address || null;

export async function walletEth() { return wallet ? Number(formatEther(await rpc.getBalance(wallet.address))) : 0; }

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Retries a read a lagging RPC node may not serve yet (a block it has not seen, a new array index). */
export async function view(fn, tries = 10) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) { if (i >= tries) throw e; await sleep(1500); }
  }
}

/** A readable message for contract errors (custom errors decoded with the game and oracle ABIs). */
export function errText(e) {
  const data = e?.data || e?.info?.error?.data || e?.error?.data;
  for (const c of [game, oracle, faucet, token]) {
    try { const d = c.interface.parseError(typeof data === 'string' ? data : data?.data); if (d) return `${d.name}(${d.args.join(', ')})`; } catch {}
  }
  return e?.shortMessage || e?.reason || e?.message || String(e);
}

const FRIENDLY = [
  [/user rejected|denied|4001/i, 'Cancelled in the wallet'],
  [/insufficient funds/i, 'Not enough Sepolia ETH for gas'],
  [/StaleEntry/, 'The price is being refreshed, try again in a few seconds'],
  [/FaucetCooldown/, 'Faucet already used, try again in a few minutes'],
  [/PackCooldown/, 'One pack every 10 minutes'],
];
export function friendly(e) {
  const t = errText(e);
  for (const [re, msg] of FRIENDLY) if (re.test(t)) return msg;
  return t.length > 120 ? t.slice(0, 117) + '…' : t;
}

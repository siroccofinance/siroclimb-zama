// Wallet + session key.
//  - The wallet (MetaMask, Rabby... any injected EIP-1193 provider) holds the player's cUSDC and
//    signs three things once: the ERC-7984 operator approval for the game, the session grant
//    (which also sends the session a little Sepolia ETH for gas), and the daily decryption grant.
//  - The session key is a burner key kept in this browser. It sends every game transaction for the
//    player (start, cash out, join, faucet, keeper duties), so a run never waits on a pop-up. It can
//    only play with what the player approved; it can never withdraw.
// Every sender (session key, practice bots) has one queue: one transaction at a time with a
// locally tracked nonce, so concurrent duties never race for a nonce.
import { BrowserProvider, Contract, JsonRpcProvider, Wallet, getBytes, keccak256, parseEther, formatEther, toUtf8Bytes } from '../vendor/ethers-6.17.0.min.js';
import { ABI, ADDR, CHAIN_HEX, CHAIN_ID, RPC_URL, SESSION_FUND_ETH, SESSION_MIN_ETH } from './config.js';

export const rpc = new JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1, pollingInterval: 1000 });
export const game = new Contract(ADDR.Siroclimb, ABI.Siroclimb, rpc);
export const oracle = new Contract(ADDR.ClimbPriceOracle, ABI.ClimbPriceOracle, rpc);
export const token = new Contract(ADDR.StakeToken, ABI.ERC7984, rpc);
export const faucet = new Contract(ADDR.ClimbFaucet, ABI.ClimbFaucet, rpc);
export const pythContract = new Contract(ADDR.Pyth, ['function getUpdateFee(bytes[] updateData) view returns (uint256)'], rpc);

// ───────────────────────────── senders (session key, bots)
const TX_GAS_CAP = 16_000_000n;
const RETRY = /nonce|underpriced|already known|replacement|timeout|failed to fetch|network|ECONNRESET|503|502|429|insufficient funds/i;

export class Sender {
  constructor(key) { this.wallet = new Wallet(key, rpc); this.address = this.wallet.address; this.queue = Promise.resolve(); this.nonce = null; }
  /** Sends `contract.method(...args)` from this key, serialized with its other transactions. */
  send(contract, method, args = [], value = 0n, label = method) {
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const c = contract.connect(this.wallet);
          const est = await c[method].estimateGas(...args, { value });
          const gas = est * 2n > TX_GAS_CAP ? TX_GAS_CAP : est * 2n;     // the FHE cost depends on the state it lands on
          const pending = await rpc.getTransactionCount(this.address, 'pending');
          const nonce = this.nonce == null ? pending : Math.max(this.nonce, pending);
          const tx = await c[method](...args, { value, gasLimit: gas, nonce, ...(await fees()) });
          this.nonce = nonce + 1;
          emitTx({ label, hash: tx.hash, from: this.address, state: 'sent' });
          const rc = await receipt(tx.hash);
          if (!rc || rc.status !== 1) throw new Error(`${label} reverted`);
          emitTx({ label, hash: tx.hash, from: this.address, state: 'mined' });
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
  /** Plain ETH transfer (gas for the keeper key and the practice bots), through the same queue. */
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

/** A key derived from the session key (keeper duties, practice bots): same browser, own nonce queue. */
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

/** EIP-712 signature by the wallet (decryption grant). */
export async function signTyped(t) {
  if (!wallet) throw new Error('Connect your wallet first');
  const types = { ...t.types }; delete types.EIP712Domain;
  return wallet.signer.signTypedData(t.domain, types, t.message);
}

/** One transaction from the wallet itself (operator approval, session grant). */
async function walletSend(contract, method, args, value = 0n) {
  const c = contract.connect(wallet.signer);
  const tx = await c[method](...args, { value });
  emitTx({ label: method, hash: tx.hash, from: wallet.address, state: 'sent' });
  const rc = await receipt(tx.hash, 300_000);
  if (!rc || rc.status !== 1) throw new Error(`${method} failed`);
  return rc;
}

// ───────────────────────────── session key
let session = null;
const sessionStoreKey = player => 'session:' + player.toLowerCase();
export function sessionFor(player) {
  let k = store.get(sessionStoreKey(player), null);
  if (!k) { k = Wallet.createRandom().privateKey; store.set(sessionStoreKey(player), k); }
  if (!session || session.key !== k) { session = new Sender(k); session.key = k; }
  return session;
}
export const currentSession = () => (wallet ? sessionFor(wallet.address) : null);
let keeper = null;
/** The keeper key: autopilot duties never queue behind the player's own transactions. */
export function currentKeeper() {
  const s = currentSession(); if (!s) return null;
  if (!keeper || keeper.parent !== s.address) { keeper = derived(s, 'keeper'); keeper.parent = s.address; }
  return keeper;
}

/** What the player still has to do before playing: [] when ready. */
export async function setupNeeds(player) {
  const s = sessionFor(player), now = Math.floor(Date.now() / 1000);
  const [op, grant, mine, eth] = await Promise.all([
    token.isOperator(player, ADDR.Siroclimb), game.sessions(s.address), game.sessionOf(player), s.eth(),
  ]);
  const needs = [];
  if (!op) needs.push('operator');
  if (grant.player.toLowerCase() !== player.toLowerCase() || Number(grant.expiry) < now + 3600 || mine.toLowerCase() !== s.address.toLowerCase()) needs.push('session');
  else if (eth < SESSION_MIN_ETH) needs.push('gas');
  return needs;
}

/**
 * Wallet steps, each one pop-up: approve the game as ERC-7984 operator of the player's cUSDC (30
 * days), then grant the session key (7 days) and send it gas. `step(label)` reports progress.
 */
export async function setup(step = () => {}) {
  const player = wallet.address, s = sessionFor(player);
  const needs = await setupNeeds(player);
  if (needs.includes('operator')) {
    step('Approve the game for your cUSDC (wallet 1/2)');
    await walletSend(token, 'setOperator', [ADDR.Siroclimb, Math.floor(Date.now() / 1000) + 30 * 86400]);
  }
  // gas for the session key: what the wallet can spare, at most SESSION_FUND_ETH (a wallet that cannot
  // pay gets a clear message instead of the node's "missing revert data")
  const spare = (await walletEth()) - 0.004;
  const fund = Math.min(Number(SESSION_FUND_ETH), spare);
  if ((needs.includes('session') || needs.includes('gas')) && fund < 0.008)
    throw new Error('Your wallet needs a little Sepolia ETH (about 0.02) for the game session. Get some from a Sepolia faucet');
  if (needs.includes('session')) {
    step('Start a 7-day game session (wallet 2/2)');
    const expiry = Math.floor(Date.now() / 1000) + 7 * 86400;
    const digest = await game.sessionDigest(player, expiry);
    const sig = await s.wallet.signMessage(getBytes(digest));
    await walletSend(game, 'authorizeSession', [s.address, expiry, sig], parseEther(fund.toFixed(6)));
  } else if (needs.includes('gas')) {
    step('Top up the session gas (wallet)');
    const tx = await wallet.signer.sendTransaction({ to: s.address, value: parseEther(fund.toFixed(6)) });
    await receipt(tx.hash, 300_000);
  }
  return s;
}

export async function walletEth() { return wallet ? Number(formatEther(await rpc.getBalance(wallet.address))) : 0; }

export const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  [/RoundNotJoinable/, 'This round has started, join the next one'],
  [/AlreadyJoined/, 'You are already in this round'],
  [/RoundFull/, 'This round is full, join the next one'],
  [/FaucetCooldown/, 'Faucet already used, try again in a few minutes'],
  [/PackCooldown/, 'One pack every 10 minutes'],
];
export function friendly(e) {
  const t = errText(e);
  for (const [re, msg] of FRIENDLY) if (re.test(t)) return msg;
  return t.length > 120 ? t.slice(0, 117) + '…' : t;
}

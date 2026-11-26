// Siroclimb on Sepolia: the api.js contract (see ../api.js) implemented on the Zama Protocol.
//
// What happens where:
//  - the wallet approves the game once (ERC-7984 operator) and grants a browser session key;
//  - the session key sends every game transaction for the player: encrypted side and stake on
//    start, cash out (with a fresh signed Pyth price riding along), faucet;
//  - the screen runs a local estimate of the run on live prices, the chain settles it on oracle
//    checkpoints (`ClimbLadder`) and pays it in the same transaction with an encrypted amount;
//  - the leverage of every run is borrowed from the Sirocco Reserve (SiroccoReserve), a confidential
//    cUSDC lending pool: S x (L - 1) is borrowed, interest is charged on it, the PnL goes to lenders;
//  - this browser is also the keeper (autopilot.js): price checkpoints, expired runs, reserve syncs.
import { ADDR, BOOST, LADDER, MARKETS, MAX_STAKE, PRICE_DECIMALS, RUN_SECONDS, SCALE, SESSION_MIN_ETH, SESSION_TX_ETH, STEP_SECONDS, USDC, indexOf, txUrl } from './config.js';
import * as feed from './feed.js';
import { encryptAmount, encryptRun, ensureGrant, hasGrant, publicDecrypt, userDecrypt, warmUp } from './fhe.js';
import * as W from './wallet.js';
import { fallbackFor, pythFor, pythNow } from './prices.js';
import { multipliers, pythToFixed10 } from './ladder.js';
import { POSITION_LEVERAGE, closePosition, openPosition } from '../position.js';
import * as autopilot from './autopilot.js';

const { game, faucet: faucetC, token, reserve, rpc, store, friendly, sleep } = W;

export const rules = { ladder: LADDER, stepEvery: STEP_SECONDS, duration: RUN_SECONDS, boost: BOOST, maxStake: MAX_STAKE };
export const chain = true;

// ───────────────────────────── markets and prices
export const listAssets = () => MARKETS.map(m => ({ id: m.id, name: m.name, ticker: m.ticker, kind: m.kind, token: m.token.symbol, boost: m.boost, open: feed.isOpen(m.index) }));
export const subscribePrice = (id, cb) => feed.subscribe(indexOf(id), cb);
export const history = (id, seconds = 60) => feed.history(indexOf(id), seconds);
export const quotes = (id, seconds = 90) => feed.quotes(indexOf(id), seconds);
export const marketOpen = id => feed.isOpen(indexOf(id));
/** Where the chain gets this market's checkpoints from now: 'Pyth' (verified) or 'bounded' (public fallback). */
const SOURCE = { pyth: 'Pyth verified', 'kraken-xstock': 'xStock 24/7, Kraken', kraken: 'Kraken spot 24/7', hyperliquid: 'Hyperliquid 24/7', 'hyperliquid-ws': 'Hyperliquid live book', oracle: 'on-chain checkpoints' };
/** The market's latest quote (a new value = a real move), not the eased price the screen animates. */
export const quote = id => feed.quoteOf(indexOf(id));
export const priceSource = id => { const i = indexOf(id); return feed.isPyth(i) ? SOURCE.pyth : SOURCE[feed.sourceOf(i)] || 'bounded checkpoints'; };
export const onMarkets = cb => feed.onMarkets(cb);
let focusId = null;
/** The market the lobby shows: its price checkpoint is kept fresh so a start is instant. */
export function focus(id) { focusId = id; }
export const focused = () => focusId;

// ───────────────────────────── status line for the UI (wallet, chain, decryption states)
const statusSubs = new Set();
let statusNow = null;
export function onStatus(cb) { statusSubs.add(cb); cb(statusNow); return () => statusSubs.delete(cb); }
export function status(s) { statusNow = s; statusSubs.forEach(cb => cb(s)); }
W.onTx(t => { if (t.state === 'sent' && t.from === W.currentSession()?.address) lastTx = t; });
let lastTx = null;
export const lastTransaction = () => (lastTx ? { ...lastTx, url: txUrl(lastTx.hash) } : null);

// ───────────────────────────── wallet, session, balance
// The balance is an ERC-7984 handle: the screen shows one state at a time, in the balance pill itself.
//   locked: no game account yet · sealed: encrypted, not decrypted yet · decrypting (value = last known, or null)
//   ready: value decrypted · error: the decryption failed (the pill offers a retry)
let bal = null;               // decrypted balance in cUSDC, null = still encrypted
let balState = 'locked', balError = null;
const balSubs = new Set();
const emitBal = () => balSubs.forEach(cb => cb(bal));
const setBal = v => { bal = v == null ? null : Math.round(v * 100) / 100; if (v != null) { balState = 'ready'; balError = null; } emitBal(); };
const setBalState = (st, err = null) => { balState = st; balError = err; emitBal(); };
// every local change (stake out, payout in) bumps the epoch: a decryption that read the balance
// before it is stale and must not overwrite it (it is read again instead)
let balEpoch = 0;
// local moves the chain has not shown yet: a decryption only counts if it was read at a block that
// includes every known move (movesBlock) and no move is still in flight (movesPending), otherwise a
// handle read on a node a block behind put back a stake that had just left (F62)
let movesPending = 0, movesBlock = 0;
const moveBal = (d, { pending = false, block = 0 } = {}) => {
  balEpoch++; if (pending) movesPending++; if (block) movesBlock = Math.max(movesBlock, block);
  if (bal != null) setBal(bal + d);
};
const moveLanded = (block, settled = true) => { if (settled) movesPending = Math.max(0, movesPending - 1); if (block) movesBlock = Math.max(movesBlock, block); balEpoch++; };
export const balance = () => bal;
export const balanceSealed = () => bal == null;
/** { state: 'locked' | 'sealed' | 'decrypting' | 'ready' | 'error', value, error } */
export const balanceInfo = () => ({ state: W.player() ? balState : 'locked', value: bal, error: balError });
export function onBalance(cb) { balSubs.add(cb); return () => balSubs.delete(cb); }

// first-visit setup, shown next to the balance: { step, steps, text } or null; { done: true } once ready
let setupNow = null;
const setupSubs = new Set();
const setSetup = v => { setupNow = v; setupSubs.forEach(cb => cb(v)); };
export function onSetup(cb) { setupSubs.add(cb); cb(setupNow); return () => setupSubs.delete(cb); }

let names = new Map();
/** The player's game account (where the cUSDC lives), or the wallet before the first signature. */
export const account = () => W.player() || W.account();
let ready = false;
export const sessionReady = () => ready;

export async function init() {
  feed.start(); warmUp();
  if (W.wasConnected() && W.hasWallet()) {
    try {
      const a = await W.connectWallet(true);
      if (a) {
        if (W.player()) setBalState('sealed');
        ready = (await W.setupNeeds()).length === 0;
        if (ready) afterConnect();
        // low on gas: the top-up waits for the next action, but decrypting the balance needs none
        else if (W.player() && hasGrant(W.player())) refreshBalance().catch(() => {});
      }
    } catch {}
  }
  await feed.ready(4000);
  return { user: { name: (W.player() && names.get(W.player().toLowerCase())) || 'You' }, balance: bal };
}

// first visit: the server drip sends gas and claims the 1,000 cUSDC in one block (api/drip.js)
let drip = null;
export async function askDrip(player, keeper = W.currentKeeper()?.address) {
  try {
    const r = await fetch('/api/drip', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ player, keeper }), signal: AbortSignal.timeout(15000) });
    const b = await r.json();
    return b.ok ? b : null;
  } catch { return null; }
}

export async function connect() {
  if (!W.account()) { status({ kind: 'wallet', text: 'Connect your wallet…' }); await W.connectWallet(false); status(null); }
  const needs = await W.setupNeeds();
  // first visit: the steps show under the balance; a returning account that only needs gas tops up quietly
  const first = needs.includes('key');
  if (needs.length) {
    const steps = 3;
    let n = 0;
    try {
      await W.setup(t => first && setSetup({ step: Math.min(++n, steps), steps, text: t }), {
        // as soon as the game account exists: gas + the first 1,000 cUSDC from the server, and the
        // decryption grant signed (locally) meanwhile
        onAccount: async a => {
          if (bal == null) setBalState('sealed');
          drip = askDrip(a);
          ensureGrant(a, W.signTyped).catch(() => {});   // local signature, ready before the balance is
          const d = await drip;
          if (d && first) setSetup({ step: steps - 1, steps, text: 'Getting your 1,000 test cUSDC…' });
          return !!d?.gas;                               // gas on its way: the wallet is not asked
        },
      });
    } catch (e) { setSetup(null); throw new Error(friendly(e)); }
  }
  ready = true;
  afterConnect(first);
  return { address: W.player() };
}

async function afterConnect(fresh = false) {
  const a = W.player(); if (!a) return;
  autopilot.start(api);
  W.ensureOperator().catch(() => {});
  game.nameOf(a).then(n => n && names.set(a.toLowerCase(), n)).catch(() => {});
  try {
    const d = drip && (await drip);
    if (d && d.claim) {
      // the claim from the server: decrypt as of its block, as soon as it lands
      if (fresh) setSetup({ step: 2, steps: 3, text: 'Getting your 1,000 test cUSDC…' });
      const rc = await W.receipt(d.claim, 120_000);
      if (fresh) setSetup({ step: 3, steps: 3, text: 'Decrypting your balance…' });
      await refreshBalance(rc?.blockNumber ?? true);
    } else if (Number(await faucetC.lastClaim(a)) === 0) {
      // no server drip: the game account claims for itself
      if (fresh) setSetup({ step: 2, steps: 3, text: 'Getting your 1,000 test cUSDC…' });
      const rc = await claim();
      if (fresh) setSetup({ step: 3, steps: 3, text: 'Decrypting your balance…' });
      await refreshBalance(rc.blockNumber);
    } else await refreshBalance();
    if (fresh && setupNow) { setSetup({ done: true, text: 'Ready' }); setTimeout(() => setSetup(null), 2500); }
  } catch { if (setupNow) setSetup(null); }
}

export function disconnect() { W.disconnectWallet(); ready = false; bal = null; setBalState('locked'); autopilot.stop(); }

/** Decrypts the player's encrypted cUSDC balance (asks the wallet for the daily grant once).
 *  expectChange: true = after a transfer (wait for the new handle), a number = as of that block. */
let balHandle = null;
export async function refreshBalance(expectChange = false) {
  const a = W.player(); if (!a) return null;
  const epoch = balEpoch;
  setBalState('decrypting');
  try {
    // read as of a block that includes every move this screen already counted
    // the state as of the last block holding a move this screen counted is exact, whichever node answers
    // (a "latest" read on a node one block behind put a stake back during its run)
    const at = Math.max(typeof expectChange === 'number' ? expectChange : 0, movesBlock);
    let h = await (at ? W.view(() => token.confidentialBalanceOf(a, { blockTag: at })) : token.confidentialBalanceOf(a));
    // no known block: after a transfer, a lagging RPC node can still serve the old handle, wait for the new one
    for (let i = 0; !at && expectChange === true && h === balHandle && i < 10; i++) { await sleep(2000); h = await token.confidentialBalanceOf(a); }
    if (expectChange === true && h === balHandle) { setBalState(bal == null ? 'sealed' : 'ready'); return bal; }
    const [v] = await userDecrypt(a, W.signTyped, [{ handle: h, contract: ADDR.StakeToken }]);
    if (epoch !== balEpoch || movesPending > 0) { if (bal != null) setBalState('ready'); refreshSoon(true); return bal; }
    balHandle = h;
    setBal(Number(v) / USDC);
    return bal;
  } catch (e) {
    setBalState('error', friendly(e));
    throw e;
  }
}
export const decryptBalance = refreshBalance;
/** Re-decrypts the balance; `atBlock`: as of the block of a known transfer (exact even on a lagging node). */
const refreshSoon = (atBlock = true) => { if (W.player()) setTimeout(() => refreshBalance(atBlock).catch(() => {}), 1500); };

/** The game account claims 1,000 cUSDC from the faucet (minted and wrapped). */
async function claim() {
  const s = await session();
  try { return await s.send(faucetC, 'claimFor', [W.player()], 0n, 'faucet'); }
  catch (e) { throw new Error(friendly(e)); }
}
export async function faucet() {
  status({ kind: 'chain', text: 'Minting and wrapping 1,000 cUSDC…' });
  let rc;
  try { rc = await claim(); } finally { status(null); }
  moveBal(1000, { block: rc.blockNumber });
  refreshSoon(rc.blockNumber);
  return bal;
}

let lastRedrip = 0;
async function session() {
  await W.gasReady;
  if (!W.player() || !ready) await connect();
  const s = W.currentSession();
  // re-drip on demand, below the floor: in the background while there is still gas for this transaction,
  // waited for only when there is not (never in the middle of a cash out otherwise)
  const eth = await s.eth().catch(() => 1);
  if (eth < SESSION_MIN_ETH && Date.now() - lastRedrip > 45_000) {
    lastRedrip = Date.now();
    const top = askDrip(s.address);
    if (eth < SESSION_TX_ETH) {
      const d = await top;
      status({ kind: 'chain', text: 'Topping up your game gas…' });
      if (d?.gas) await W.receipt(d.gas, 60_000).catch(() => {});
      // nothing sent now: a top-up sent moments ago (first visit) may still be landing, or this node lags
      for (let i = 0; i < 20 && (await s.eth().catch(() => 0)) < SESSION_TX_ETH; i++) await sleep(1500);
      status(null);
      if ((await s.eth().catch(() => 0)) < SESSION_TX_ETH) throw new Error('Your game account is out of gas and the top-up did not go through. Try again in a minute');
    }
  }
  return s;
}

// ───────────────────────────── runs
const runs = new Map();        // id -> local run
const sideSign = s => (s === 'short' ? -1 : 1);
const stepAt = t => Math.min(LADDER.length - 1, Math.max(0, Math.floor(t / STEP_SECONDS)));

// ── borrowing: a run of stake S at leverage L borrows S x (L - 1) from the Sirocco Reserve and pays
//    interest on it for the time it is borrowed (Siroclimb.borrowedTenthSeconds, same integer math)
let APR_BPS = 2000n;
const INTEREST_DIVISOR = 10_000n * 10n * 365n * 86_400n;
game.borrowAprBps().then(v => { APR_BPS = BigInt(v); }).catch(() => {});
export const borrowAprPct = () => Number(APR_BPS) / 100;
// the real position borrows (POSITION_LEVERAGE - 1) x the stake for the whole run (Siroclimb.borrowedTenthSeconds)
function borrowedTenthSeconds(elapsed) { return 10n * BigInt(POSITION_LEVERAGE - 1) * BigInt(Math.max(0, elapsed)); }
/** The run's real position at the end (cUSDC), and the game boost: what the ladder pays beyond it. */
function realPosition(run, exit, elapsed, value) {
  const p = closePosition(run.stake, run.side === 'long', run.entryPrice, exit, elapsed);
  return { borrowed: p.borrowed, qty: p.qty, token: MARKETS[run.market].token.symbol, position: p.value, boost: value - p.value };
}
/** What the contract pays for `stake` (cUSDC) at multiplier `mult` (6 decimals) after `elapsed` s: stake x mult minus interest. */
function net(stake, mult, elapsed) {
  const paid = BigInt(Math.round(stake * USDC)), gross = (paid * BigInt(mult)) / BigInt(SCALE);
  const i = (paid * APR_BPS * borrowedTenthSeconds(Math.max(0, Math.floor(elapsed)))) / INTEREST_DIVISOR;
  const charged = i < gross ? i : gross;
  return { value: Number(gross - charged) / USDC, interest: Number(charged) / USDC };
}
const multOf = acc => Math.max(0, Math.round((1 + acc) * SCALE));

function makeRun({ id, cid = null, assetId, side, stake, startedAt, entryPrice }) {
  const run = { id: String(id), cid: cid == null ? null : String(cid), assetId, side, stake, startedAt, entryPrice, ladder: LADDER, stepEvery: STEP_SECONDS, duration: RUN_SECONDS,
    acc: 0, last: entryPrice, maxLev: 1, status: 'live', subs: new Set(), endedAt: 0, local: null, chain: null, waiters: [], settleWaiters: [],
    cps: null, market: indexOf(assetId), pending: cid == null };
  runs.set(run.id, run);
  run.unsub = feed.subscribe(run.market, ({ price, ts }) => advance(run, price, ts));
  return run;
}

// ── the value on screen is the value the contract will pay: ClimbLadder's rules over the oracle
//    checkpoints since the entry, plus, for a Pyth market, the live signed price the cash out will
//    carry (FINDINGS F44). Markets on the bounded fallback settle on their last checkpoint.
async function trackCheckpoints(run) {
  if (run.cpTimer) return;
  // atBlock: read as of a block known to hold a new checkpoint (a lagging node retries until it has it)
  const pull = run.pull = async (force = false, atBlock = null) => {
    if ((!force && run.status !== 'live') || !run.cid) return;
    try {
      if (run.entryIndex == null) {
        // a node that has not seen the start yet answers an empty run (entry index 0): ask again next time
        const r = await W.view(() => game.getRun(BigInt(run.cid)));
        if (Number(r.startAt) === 0) return;
        run.entryIndex = Number(r.entryIndex);
      }
      const [ts, px] = atBlock
        ? await W.view(() => W.oracle.path(run.market, run.entryIndex, 2n ** 256n - 1n, 64, { blockTag: atBlock }))
        : await W.oracle.path(run.market, run.entryIndex, 2n ** 256n - 1n, 64);
      run.cps = ts.map((t, i) => ({ ts: Number(t), price: px[i] }));
    } catch {}
  };
  await pull();
  run.cpTimer = setInterval(pull, 2500);
}
// The live value: the checkpoints so far, plus the market's live price as the next checkpoint (bounded like a
// public one, +/-0.49 % of the last), so the value moves with every price change on screen. A cash out writes
// that very price as its checkpoint before it leaves (sendCashOut), so the payout is the value shown.
// `provisional` false: the checkpoints alone (the exact path the contract reads, and the bust test).
const PUBLIC_MAX_MOVE = 0.0049;
function provisionalPrice(run, lastPrice) {
  const q = feed.quoteOf(run.market), lp = Number(lastPrice) / 10 ** PRICE_DECIMALS;
  if (!(q > 0) || !(lp > 0)) return null;
  const c = Math.min(lp * (1 + PUBLIC_MAX_MOVE), Math.max(lp * (1 - PUBLIC_MAX_MOVE), q));
  return BigInt(Math.round(c * 10 ** PRICE_DECIMALS));
}
function chainValue(run, nowMs, live = pythNow(run.market), provisional = true) {
  if (!run.cps || !run.cps.length) return null;
  const pts = run.cps.slice();
  const nowS = Math.floor(nowMs / 1000), last = pts[pts.length - 1];
  if (live && live.mantissa != null && nowS > last.ts) pts.push({ ts: nowS, price: pythToFixed10(live.mantissa, live.expo) });
  else if (!live && provisional) { const pp = provisionalPrice(run, last.price); if (pp != null && pp !== last.price) pts.push({ ts: Math.max(nowS, last.ts + 1), price: pp }); }
  const m = multipliers(pts, Math.floor(run.startedAt / 1000), BOOST[run.market]);
  const mult = Number(run.side === 'long' ? m.long : m.short) / SCALE;
  return { mult, exit: Number(pts[pts.length - 1].price) / 10 ** PRICE_DECIMALS };
}
function advance(run, price, ts) {
  if (run.status !== 'live') return;
  const t = (ts - run.startedAt) / 1000;
  run.last = price;
  if (run.pending || t < 0) { const u = update(run, ts); run.subs.forEach(cb => cb(u)); return; }
  const lev = LADDER[stepAt(t)];
  run.maxLev = Math.max(run.maxLev, lev);
  const cv = chainValue(run, ts), exact = chainValue(run, ts, undefined, false);
  if (cv) run.acc = cv.mult - 1;
  if (exact && exact.mult === 0) { run.acc = -1; endLocal(run, 'busted', ts); }   // a fall the checkpoints confirm
  else if (t >= run.duration) endLocal(run, 'expired', ts);
  const u = update(run, ts); run.subs.forEach(cb => cb(u));
}
function update(run, ts) {
  const t = run.pending ? 0 : Math.max(0, (Math.min(ts, run.endedAt || ts) - run.startedAt) / 1000), step = stepAt(t);
  const { value, interest } = net(run.stake, multOf(run.acc), t);
  return { t, price: run.last, step, leverage: LADDER[step], value, pnl: value - run.stake, pnlPct: (value / run.stake - 1) * 100, risk: Math.min(1, Math.max(0, -run.acc)),
    borrowed: openPosition(run.stake, run.side === 'long', run.entryPrice).borrowed, qty: openPosition(run.stake, run.side === 'long', run.entryPrice).qty,
    interest, status: run.status, pending: !!run.pending };
}
/** The run is over on screen; the chain settles it (cash out or expiry tx) and `whenSettled` follows. */
const refineSubs = new Set();
/** cb(runId, result) when a cashed-out value is re-checked against the exact on-chain path. */
export function onRefine(cb) { refineSubs.add(cb); return () => refineSubs.delete(cb); }
function endLocal(run, st, ts = Date.now(), frozen = null) {
  if (run.status !== 'live') return;
  run.status = st; run.endedAt = ts;
  clearInterval(run.cpTimer);
  if (frozen) run.acc = frozen.mult - 1;
  const duration = Math.min(run.duration, (ts - run.startedAt) / 1000), { value, interest } = net(run.stake, multOf(run.acc), duration);
  run.local = { status: st, value, pnl: value - run.stake, pnlPct: (value / run.stake - 1) * 100, maxLeverage: run.maxLev, duration, interest, ...realPosition(run, frozen?.exit ?? run.last, duration, value),
    entryPrice: run.entryPrice, exitPrice: frozen?.exit ?? run.last, pending: true, runId: run.cid ?? run.id };
  run.waiters.splice(0).forEach(r => r(run.local));
  if (st === 'expired') autopilot.kick();            // anyone may settle at the 60th second; this browser does it now
  else sendCashOut(run, frozen?.pyth, frozen?.after, frozen).catch(e => status({ kind: 'error', text: `Cash out: ${friendly(e)}` }));
}

// ── pre-encryption: side and stake are encrypted in the background as soon as they are picked in the
//    lobby, so the click only sends the transaction (F45)
const preEnc = new Map();
const encKey = (long, units) => `s:${long}:${units}`;
export function prepare({ side = 'long', stake = 10 } = {}) {
  const s = W.currentSession(); if (!s) return;
  const long = side === 'long', units = Math.round(stake * USDC), k = `${s.address}:${encKey(long, units)}`;
  if (preEnc.has(k)) return;
  const p = encryptRun(s.address, long, units);
  p.catch(() => preEnc.delete(k));
  preEnc.set(k, p);
}
function takeEncryption(s, long, units) {
  const k = `${s.address}:${encKey(long, units)}`;
  const p = preEnc.get(k) || encryptRun(s.address, long, units);
  preEnc.delete(k);
  setTimeout(() => prepare({ side: long ? 'long' : 'short', stake: units / USDC }), 0);   // ready for the next one
  return p;
}

export async function startRun({ assetId, side = 'long', stake }) {
  const m = indexOf(assetId);
  if (!feed.isOpen(m)) throw new Error(`${MARKETS[m].token.symbol} (${MARKETS[m].name}) has no live price right now. Try another market`);
  if (!(stake > 0) || stake > MAX_STAKE) throw new Error(`Stake between 1 and ${MAX_STAKE} cUSDC`);
  if (bal != null && stake > bal) throw new Error('Not enough cUSDC: use the faucet');
  const s = await session();
  // the game must be the account's ERC-7984 operator before the start pulls the stake: the approval is
  // queued first (broadcast-only, one nonce before the start, same block), never after it
  await W.ensureOperator(s);
  const units = Math.round(stake * USDC);
  if (!preEnc.has(`${s.address}:${encKey(side === 'long', units)}`)) status({ kind: 'fhe', text: 'Encrypting your side and stake…' });
  const enc = await takeEncryption(s, side === 'long', units);
  // entry price, in the same transaction: a fresh signed Pyth price, or a bounded public one
  const pyth = await pythFor(m);
  const fallback = pyth ? 0n : await fallbackFor(m);
  let sent;
  status({ kind: 'chain', text: 'Sending your encrypted start…' });
  try { sent = await s.send(game, 'startRun', [m, enc.handles[0], enc.handles[1], enc.proof, false, pyth ? pyth.updateData : [], fallback], pyth ? pyth.fee : 0n, 'startRun', { fast: true }); }
  catch (e) { status(null); throw new Error(friendly(e)); }
  // the climb starts now; the chain's start time and entry price snap in when the block lands
  const run = makeRun({ id: `tx:${sent.hash}`, assetId, side, stake, startedAt: Date.now(), entryPrice: pyth ? pyth.price : feed.last(m) });
  run.tx = sent.hash;
  // remembered at once (a reload before the start is mined finds it through its transaction)
  store.set(liveKey(), { tx: sent.hash, assetId, side, stake, startedAt: run.startedAt, entryPrice: run.entryPrice, game: ADDR.Siroclimb });
  status({ kind: 'chain', text: 'Locking your entry on Sepolia…' });
  moveBal(-stake, { pending: true });
  sent.mined.then(rc => {
    moveLanded(rc.blockNumber);
    const ev = parseEvent(rc, 'RunStarted');
    Object.assign(run, { cid: String(ev.runId), startedAt: Number(ev.startAt) * 1000, entryPrice: Number(ev.entryPrice) / 10 ** PRICE_DECIMALS, pending: false });
    // remembered on this device: a reload during the run finds it again (side and stake stay off chain in clear)
    store.set(liveKey(), { tx: sent.hash, cid: run.cid, assetId, side, stake, startedAt: run.startedAt, entryPrice: run.entryPrice, game: ADDR.Siroclimb });
    status(null);
    trackCheckpoints(run);
    autopilot.watchRun(run);
  }).catch(e => {
    status({ kind: 'error', text: `Start failed: ${friendly(e)}. Nothing was staked` });
    if (store.get(liveKey(), null)?.tx === sent.hash) store.del(liveKey());
    moveLanded(0);
    moveBal(stake);
    run.failed = true;
    endLocal(run, 'failed');
  });
  return publicRun(run);
}

function parseEvent(rc, name) {
  for (const l of rc.logs) { try { const e = game.interface.parseLog(l); if (e?.name === name) return e.args; } catch {} }
  throw new Error(`no ${name} event`);
}
const publicRun = r => ({ id: r.id, assetId: r.assetId, side: r.side, stake: r.stake, entryPrice: r.entryPrice, startedAt: r.startedAt, ladder: r.ladder, stepEvery: r.stepEvery, duration: r.duration, tx: r.tx, pending: !!r.pending, chainId: r.cid });
export function onRun(id, cb) { const run = runs.get(String(id)); run.subs.add(cb); return () => run.subs.delete(cb); }
export const runInfo = id => { const r = runs.get(String(id)); return r ? publicRun(r) : null; };
export const runResult = id => { const r = runs.get(String(id)); return r?.chain || r?.local || null; };
export function whenEnded(id) { const r = runs.get(String(id)); return r.local ? Promise.resolve(r.local) : new Promise(res => r.waiters.push(res)); }
/** Resolves with the chain-verified result once the run is settled on chain. */
export function whenSettled(id) { const r = runs.get(String(id)); return r.chain ? Promise.resolve(r.chain) : new Promise(res => r.settleWaiters.push(res)); }

/**
 * Cash out: the value is frozen at the click with the signed price the transaction will carry, so
 * the number on screen is the number paid (unless another checkpoint lands first, F44).
 */
export async function cashOut(id) {
  const run = runs.get(String(id));
  if (run.status !== 'live') return run.local;
  if (run.pending) await new Promise(r => { const t = setInterval(() => { if (!run.pending || run.failed) { clearInterval(t); r(); } }, 200); });
  if (run.status !== 'live') return run.local;
  if (!run.cps && run.pull) await run.pull();                       // a run that was still locking its entry
  const pyth = await pythFor(run.market).catch(() => null);
  const now = Date.now(), live = pyth ? { mantissa: pyth.mantissa, expo: pyth.expo } : null;
  const cv = chainValue(run, now, live);
  // the price this cash out writes as its checkpoint (no signed Pyth price): the one its value was shown on
  const lastCp = run.cps?.[run.cps.length - 1];
  const pushPx = !pyth && lastCp ? provisionalPrice(run, lastCp.price) : null;
  // the result shows now; the transaction leaves now, or right after a checkpoint this browser is
  // still writing on the market; the value is then re-checked against the exact path the contract reads
  const after = autopilot.inflight(run.market);
  endLocal(run, 'cashed', now, { ...(cv || { mult: 1 + run.acc, exit: run.last }), pyth, after, pushPx, lastCpTs: lastCp?.ts });
  return run.local;
}
async function sendCashOut(run, frozenPyth, after = null, frozen = null) {
  const s = await session();
  // the shown price becomes the exit checkpoint: once the public spacing allows it (at most ~10 s), pushed
  // right before the cash out (next nonce, same block in general). If someone else wrote a checkpoint
  // meanwhile, that one is the exit and the value is re-checked below.
  if (frozen?.pushPx != null && !frozenPyth) {
    try {
      for (let i = 0; i < 24; i++) {
        const [, ts] = await W.oracle.latest(run.market);
        if (Number(ts) > (frozen.lastCpTs ?? 0)) { after = after || Promise.resolve({ block: null }); break; }   // a newer checkpoint landed
        if (Date.now() / 1000 - Number(ts) >= 11) {
          await s.send(W.oracle, 'pushPublic', [[run.market], [frozen.pushPx]], 0n, 'pushPublic', { fast: true });
          after = null; break;
        }
        status({ kind: 'chain', text: 'Writing your exit price on Sepolia…' });
        await sleep(500);
      }
    } catch {}
  }
  // a checkpoint this browser is writing on the market lands first: in the same block it would take
  // the cash out's place as the exit price and the paid value would differ from the frozen one
  // ...but never for long: a checkpoint stuck in this browser's keeper queue once held a cash out for 15 min (F63)
  const landed = after ? await Promise.race([after, sleep(8000).then(() => null)]) : null;
  let pyth = frozenPyth === undefined ? await pythFor(run.market) : frozenPyth;
  if (after && run.local && !run.chain && run.pull) {
    // re-check the value against the exact path the contract will read, with a signed price fresh
    // enough to still be accepted when the block lands (Pyth max age 25 s)
    // the frozen signed price stays, unless it would be too old for the oracle when the block lands
    if (pyth && Date.now() / 1000 - pyth.publishTime > 15) pyth = (await pythFor(run.market).catch(() => null)) ?? pyth;
    await run.pull(true, landed?.block ?? null);
    const exact = chainValue(run, Date.now(), pyth ? { mantissa: pyth.mantissa, expo: pyth.expo } : null, false);
    if (exact) {
      const { value, interest } = net(run.stake, multOf(exact.mult - 1), run.local.duration);
      Object.assign(run.local, { value, interest, pnl: value - run.stake, pnlPct: (value / run.stake - 1) * 100, exitPrice: exact.exit });
      refineSubs.forEach(cb => cb(run.id, run.local));
    }
  }
  status({ kind: 'chain', text: 'Cashing out: encrypted payout on Sepolia…' });
  try {
    const rc = await s.send(game, 'cashOut', [BigInt(run.cid), pyth ? pyth.updateData : []], pyth ? pyth.fee : 0n, 'cashOut');
    run.tx = rc.hash;
    run.txBlock = rc.blockNumber;
  } catch (e) {
    // already settled (the 60th-second settlement won the race): not an error, the result stands
    const settledAlready = /WrongRunStatus/.test(W.errText(e)) || Number((await game.getRun(BigInt(run.cid)).catch(() => ({ status: 0 }))).status) === 2;
    if (!settledAlready) throw e;
  } finally { status(null); }
  await settleFromChain(run);
}

/** Reads the settled run from the chain: the public long/short multipliers + the player's side. */
export async function settleFromChain(run) {
  // the cash out and the 60th-second settlement can both get here: the payout is counted once
  if (run.chain) return run.chain;
  if (run.settlePromise) return run.settlePromise;
  run.settlePromise = settleOnce(run).finally(() => { run.settlePromise = null; });
  return run.settlePromise;
}
async function settleOnce(run) {
  for (let i = 0; i < 40; i++) {
    // a node behind the load balancer may not have the run's block yet (it reverts Panic 0x32): retried
    const r = await W.view(() => game.getRun(BigInt(run.cid), ...(run.txBlock ? [{ blockTag: run.txBlock }] : [])), 6);
    if (Number(r.status) === 2) {
      const m = run.side === 'long' ? r.multLong : r.multShort, mult = Number(m) / SCALE;
      const { value, interest } = net(run.stake, m, Number(r.endAt - r.startAt));
      const step = Number(r.topStep);
      run.chain = { status: mult === 0 ? 'busted' : run.local?.status === 'busted' ? 'cashed' : run.local?.status || (Number(r.endAt) >= Number(r.startAt) + RUN_SECONDS ? 'expired' : 'cashed'),
        value, pnl: value - run.stake, pnlPct: (value / run.stake - 1) * 100, maxLeverage: LADDER[step], duration: Number(r.endAt - r.startAt),
        interest, ...realPosition(run, Number(r.exitPrice) / 10 ** PRICE_DECIMALS, Number(r.endAt - r.startAt), value),
        entryPrice: Number(r.entryPrice) / 10 ** PRICE_DECIMALS, exitPrice: Number(r.exitPrice) / 10 ** PRICE_DECIMALS,
        multLong: Number(r.multLong) / SCALE, multShort: Number(r.multShort) / SCALE, chain: true, runId: run.cid, tx: run.tx };
      if (!run.local) { run.status = run.chain.status; run.local = run.chain; run.waiters.splice(0).forEach(f => f(run.chain)); }
      run.unsub?.();
      // the payout counts in the balance before the screen says "Settled" (no await in between)
      moveBal(value, { block: run.txBlock || 0 });
      run.settleWaiters.splice(0).forEach(f => f(run.chain));
      if (statusNow?.kind === 'keeper' && !liveRuns().length) status(null);   // "Settled on chain": no keeper line left spinning
      if (!run.txBlock) rpc.getBlockNumber().then(b => { movesBlock = Math.max(movesBlock, b); }).catch(() => {});
      const rec = store.get(liveKey(), null);
      if (rec && (rec.cid === run.cid || rec.tx === run.tx)) store.del(liveKey());
      refreshSoon(run.txBlock ?? true); record(run);
      return run.chain;
    }
    await sleep(3000);
  }
  throw new Error('run not settled yet');
}
export const liveRuns = () => [...runs.values()].filter(r => !r.chain && !r.failed && r.cid);

function record(run) {
  const h = store.get('history', []);
  h.unshift({ ts: Date.now(), assetId: run.assetId, side: run.side, stake: run.stake, ...run.chain });
  store.set('history', h.slice(0, 100));
}

// ── a run in progress survives a reload: this device remembers it, the chain says if it is still live
const liveKey = () => `liveRun:${(W.player() || '').toLowerCase()}`;
/**
 * The player's run from before a reload: { run } if it is still live (the climb goes on), { result } if it
 * ended meanwhile (settled by its cash out or at its 60th second), or null.
 */
export async function resumeRun() {
  const rec = W.player() && store.get(liveKey(), null);
  if (!rec || rec.game !== ADDR.Siroclimb) return null;
  if (rec.cid == null) {
    // the start was still on its way at the reload: its receipt names the run
    const rc = rec.tx ? await W.receipt(rec.tx, 90_000).catch(() => null) : null;
    if (!rc || rc.status !== 1) { store.del(liveKey()); return null; }
    try { rec.cid = String(parseEvent(rc, 'RunStarted').runId); } catch { store.del(liveKey()); return null; }
    store.set(liveKey(), rec);
  }
  let r;
  try { r = await W.view(() => game.getRun(BigInt(rec.cid))); } catch { return null; }
  const status = Number(r.status);
  const run = runs.get(`chain:${rec.cid}`) || makeRun({ id: `chain:${rec.cid}`, cid: rec.cid, assetId: rec.assetId, side: rec.side, stake: rec.stake,
    startedAt: Number(r.startAt) * 1000, entryPrice: Number(r.entryPrice) / 10 ** PRICE_DECIMALS });
  run.pending = false;
  if (status === 1 && Date.now() < run.startedAt + RUN_SECONDS * 1000) {
    trackCheckpoints(run); autopilot.watchRun(run);
    return { run: publicRun(run) };
  }
  // over: its 60 seconds ran out (the autopilot settles it now), or it was settled already
  if (status === 1) { run.status = 'expired'; run.endedAt = run.startedAt + RUN_SECONDS * 1000; autopilot.kick(); }
  try { return { result: await settleFromChain(run), run: publicRun(run) }; } catch { return null; }
}

/** Reveals a finished solo run on the leaderboard (multiplier public, stake stays private). */
export async function publishRun(id) {
  const s = await session();
  const r = await W.view(() => game.getRun(BigInt(id)));
  if (r.published) return true;
  let multH = null;
  if (!r.publishRequested) {                                       // a retry only records
    const rc = await s.send(game, 'publishRun', [BigInt(id)], 0n, 'publishRun');
    try { multH = parseEvent(rc, 'PublishRequested').multHandle; } catch {}
  }
  // the handle from the receipt; else read it, as of a node that has the run (a lagging one answers 0x0…0)
  for (let i = 0; !multH || /^0x0+$/.test(multH); i++) {
    if (i >= 15) throw new Error('Sepolia is still catching up, try again in a few seconds');
    if (i) await sleep(2000);
    multH = (await W.view(() => game.runHandles(BigInt(id))))[3];
  }
  for (let i = 0; i < 10; i++) {
    try { const { values, proof } = await publicDecrypt([multH]); const rc = await s.send(game, 'recordRun', [BigInt(id), values[0], proof], 0n, 'recordRun'); return { block: rc.blockNumber }; }
    catch (e) { if (i === 9) throw e; await sleep(4000); }
  }
}

// ───────────────────────────── leaderboards (public results only: the runs players chose to post)
export async function leaderboard(scope = 'today') {
  const n = Number(await game.resultCount());
  // plain objects: ethers' Result arrays are read-only, so sorting them throws
  const list = (n ? [...(await game.results(Math.max(0, n - 400), 400))] : []).map(x => ({ player: x.player, timestamp: x.timestamp, pnlPpm: x.pnlPpm }));
  await loadNames(list.map(x => x.player));
  const a = W.player()?.toLowerCase();
  const row = x => ({ name: x.player.toLowerCase() === a ? 'You' : nameOf(x.player), pnlPct: Number(x.pnlPpm) / 1e4, you: x.player.toLowerCase() === a });
  const since = scope === 'all' ? 0 : Date.now() / 1000 - 86400;
  const best = new Map();
  for (const x of list) {
    if (Number(x.timestamp) < since) continue;
    const k = x.player.toLowerCase(), b = best.get(k);
    if (!b || Number(x.pnlPpm) > Number(b.pnlPpm)) best.set(k, x);
  }
  return [...best.values()].sort((p, q) => Number(q.pnlPpm) - Number(p.pnlPpm)).slice(0, 12).map(row);
}

// ───────────────────────────── Sirocco Reserve (the lending pool behind the leverage)
let reserveCache = { at: 0, v: null }, launchTs = null;
/** Public figures: synced TVL, share price, interest earned, committed liquidity, utilization, APR, APY. */
export async function reserveStats(force = false) {
  if (!force && reserveCache.v && Date.now() - reserveCache.at < 10_000) return reserveCache.v;
  const [assets, shares, earned, syncedAt, locked, loans, pending] = await Promise.all([
    reserve.syncedAssets(), reserve.syncedShares(), reserve.syncedInterest(), reserve.syncedAt(), reserve.lockedAssets(), reserve.openLoans(), reserve.syncRequestedAt(),
  ]);
  if (launchTs == null) launchTs = Number((await rpc.getBlock(ADDR.deployBlock).catch(() => null))?.timestamp ?? 0) || null;
  const tvl = Number(assets) / USDC, price = Number(shares) ? Number(assets) / Number(shares) : 1;
  const days = launchTs ? (Date.now() / 1000 - launchTs) / 86400 : 0;
  const v = {
    tvl, shares: Number(shares) / USDC, sharePrice: price, interestEarned: Number(earned) / USDC,
    syncedAt: Number(syncedAt) * 1000, syncPending: Number(pending) > 0, locked: Number(locked) / USDC, openLoans: Number(loans),
    utilization: tvl ? Number(locked) / Number(assets) : 0, aprPct: borrowAprPct(),
    apyPct: days >= 1 ? (Math.pow(price, 365 / days) - 1) * 100 : null, returnPct: (price - 1) * 100, days,
  };
  reserveCache = { at: Date.now(), v };
  return v;
}

/** The player's encrypted reserve shares, decrypted in the browser, and what they are worth at the synced price.
 *  `atBlock`: as of the block of a deposit or withdrawal (exact even on a lagging node). */
export async function reservePosition(atBlock = null) {
  const a = W.player(); if (!a) return null;
  const h = atBlock ? await W.view(() => reserve.confidentialBalanceOf(a, { blockTag: atBlock })) : await reserve.confidentialBalanceOf(a);
  const [units] = await userDecrypt(a, W.signTyped, [{ handle: h, contract: ADDR.SiroccoReserve }]);
  const st = await reserveStats();
  const shares = Number(units) / USDC;
  return { shares, value: shares * st.sharePrice };
}

/** Deposits `amount` cUSDC, encrypted, from the game account; the reserve becomes its ERC-7984 operator once. */
export async function reserveDeposit(amount) {
  const s = await session();
  const units = Math.round(amount * USDC);
  if (!(units > 0)) throw new Error('Enter an amount');
  status({ kind: 'fhe', text: 'Encrypting the deposit…' });
  try {
    const [enc] = await Promise.all([encryptAmount(ADDR.SiroccoReserve, s.address, units), W.ensureOperatorFor(ADDR.SiroccoReserve, s)]);
    status({ kind: 'chain', text: 'Depositing into the Sirocco Reserve…' });
    const rc = await s.send(reserve, 'deposit', [enc.handle, enc.proof], 0n, 'deposit');
    moveBal(-amount, { block: rc.blockNumber });       // known move; the decryption at the block confirms it
    refreshSoon(rc.blockNumber);
    return { tx: rc.hash, block: rc.blockNumber };
  } catch (e) { throw new Error(friendly(e)); }
  finally { status(null); }
}

/** Withdraws about `amount` cUSDC: the matching shares (at the synced price) are encrypted and redeemed, all or nothing. */
export async function reserveWithdraw(amount) {
  const s = await session();
  const st = await reserveStats(true);
  const shares = Math.floor((amount / st.sharePrice) * USDC);
  if (!(shares > 0)) throw new Error('Enter an amount');
  status({ kind: 'fhe', text: 'Encrypting the withdrawal…' });
  try {
    const enc = await encryptAmount(ADDR.SiroccoReserve, s.address, shares);
    status({ kind: 'chain', text: 'Withdrawing from the Sirocco Reserve…' });
    const rc = await s.send(reserve, 'withdraw', [enc.handle, enc.proof], 0n, 'withdraw');
    // all or nothing on ciphertexts: the amount that moved is decrypted here, for this player only
    const ev = rc.logs.map(l => { try { return reserve.interface.parseLog(l); } catch { return null; } }).find(e => e?.name === 'WithdrawRequested');
    let out = null;
    if (ev) { const [v] = await userDecrypt(s.address, W.signTyped, [{ handle: ev.args.assetsHandle, contract: ADDR.SiroccoReserve }]).catch(() => [null]); out = v == null ? null : Number(v) / USDC; }
    if (out != null) moveBal(out, { block: rc.blockNumber });
    refreshSoon(rc.blockNumber);
    return { tx: rc.hash, block: rc.blockNumber, out };
  } catch (e) { throw new Error(friendly(e)); }
  finally { status(null); }
}

export async function setName(name) { const s = await session(); await s.send(game, 'setName', [name.slice(0, 24)], 0n, 'setName'); names.set(W.player().toLowerCase(), name); }

// ───────────────────────────── leverage packs (encrypted PRNG on chain). UI off for now.
export const PACKS = [
  { tier: 'Bronze', maxLeverage: 1.5, odds: 0.45 }, { tier: 'Silver', maxLeverage: 2, odds: 0.28 },
  { tier: 'Gold', maxLeverage: 3, odds: 0.18 }, { tier: 'Diamond', maxLeverage: 4, odds: 0.09 },
];
export async function openPack() {
  const s = await session();
  const rc = await s.send(game, 'openPack', [], 0n, 'openPack');
  const h = parseEvent(rc, 'PackOpened').tierHandle;
  const [tier] = await userDecrypt(W.player(), W.signTyped, [{ handle: h, contract: ADDR.Siroclimb }]);
  const p = PACKS[Number(tier)];
  return { tier: p.tier, maxLeverage: p.maxLeverage, proof: rc.hash };
}

export async function shareCard() { return null; }

export const _debug = { runs, feed, autopilot };

/** A checkpoint this browser wrote just landed: the runs on that market re-read their path now. */
function checkpointed(m) {
  for (const run of runs.values()) if (run.market === m && run.status === 'live' && run.pull) { run.pull(); setTimeout(() => run.pull?.(), 2500); }
}
const api = { runs, liveRuns, settleFromChain, focused, status, checkpointed, reserveStats, askDrip };

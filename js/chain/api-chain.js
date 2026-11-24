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
import { ADDR, LADDER, MARKETS, MAX_STAKE, MOVE_SCALE, PRICE_DECIMALS, RUN_SECONDS, SCALE, STEP_SECONDS, USDC, indexOf, txUrl } from './config.js';
import * as feed from './feed.js';
import { encryptAmount, encryptRun, hasGrant, publicDecrypt, userDecrypt, warmUp } from './fhe.js';
import * as W from './wallet.js';
import { fallbackFor, pythFor, pythNow } from './prices.js';
import { multipliers, pythToFixed10 } from './ladder.js';
import * as autopilot from './autopilot.js';

const { game, faucet: faucetC, token, reserve, rpc, store, friendly, sleep } = W;

export const rules = { ladder: LADDER, stepEvery: STEP_SECONDS, duration: RUN_SECONDS, moveScale: MOVE_SCALE, maxStake: MAX_STAKE };
export const chain = true;

// ───────────────────────────── markets and prices
export const listAssets = () => MARKETS.map(m => ({ id: m.id, name: m.name, ticker: m.ticker, kind: m.kind, token: m.token.symbol, open: feed.isOpen(m.index) }));
export const subscribePrice = (id, cb) => feed.subscribe(indexOf(id), cb);
export const history = (id, seconds = 60) => feed.history(indexOf(id), seconds);
export const marketOpen = id => feed.isOpen(indexOf(id));
/** Where the chain gets this market's checkpoints from now: 'Pyth' (verified) or 'bounded' (public fallback). */
export const priceSource = id => (feed.isPyth(indexOf(id)) ? 'Pyth verified' : 'bounded fallback');
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
let bal = null;               // decrypted balance in cUSDC, null = still encrypted
const balSubs = new Set();
const setBal = v => { bal = v == null ? null : Math.round(v * 100) / 100; balSubs.forEach(cb => cb(bal)); };
// every local change (stake out, payout in) bumps the epoch: a decryption that read the balance
// before it is stale and must not overwrite it (it is read again instead)
let balEpoch = 0;
const moveBal = d => { balEpoch++; if (bal != null) setBal(bal + d); };
export const balance = () => bal;
export const balanceSealed = () => bal == null;
export function onBalance(cb) { balSubs.add(cb); return () => balSubs.delete(cb); }
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
      if (a) { ready = (await W.setupNeeds()).length === 0; if (ready) afterConnect(); }
    } catch {}
  }
  await feed.ready(4000);
  return { user: { name: (W.player() && names.get(W.player().toLowerCase())) || 'You' }, balance: bal };
}

export async function connect() {
  if (!W.account()) { status({ kind: 'wallet', text: 'Connect your wallet…' }); await W.connectWallet(false); }
  const needs = await W.setupNeeds();
  if (needs.length) {
    try { await W.setup(t => status({ kind: 'wallet', text: t })); }
    catch (e) { status(null); throw new Error(friendly(e)); }
  }
  ready = true;
  status(null);
  // first visit: 1,000 test cUSDC straight away (minted and wrapped by the faucet, through the session key)
  afterConnect();
  return { address: W.player() };
}

function afterConnect() {
  const a = W.player(); if (!a) return;
  autopilot.start(api);
  W.ensureOperator().catch(() => {});
  // first visit: 1,000 test cUSDC straight away (minted and wrapped by the faucet, from the game account)
  faucetC.lastClaim(a).then(t => (Number(t) === 0 ? faucet() : null)).catch(() => {}).finally(() => refreshBalance().catch(() => {}));
  game.nameOf(a).then(n => n && names.set(a.toLowerCase(), n)).catch(() => {});
}

export function disconnect() { W.disconnectWallet(); ready = false; setBal(null); autopilot.stop(); }

/** Decrypts the player's encrypted cUSDC balance (asks the wallet for the daily grant once). */
let balHandle = null;
export async function refreshBalance(expectChange = false) {
  const a = W.player(); if (!a) return null;
  const epoch = balEpoch;
  let h = await (typeof expectChange === 'number' ? W.view(() => token.confidentialBalanceOf(a, { blockTag: expectChange })) : token.confidentialBalanceOf(a));
  // after a transfer, a lagging RPC node can still serve the old balance handle: wait for the new one
  for (let i = 0; expectChange === true && h === balHandle && i < 10; i++) { await sleep(2000); h = await token.confidentialBalanceOf(a); }
  if (expectChange === true && h === balHandle) return bal;
  status({ kind: 'decrypt', text: 'Decrypting your balance…' });
  try {
    const [v] = await userDecrypt(a, W.signTyped, [{ handle: h, contract: ADDR.StakeToken }]);
    if (epoch !== balEpoch) { refreshSoon(true); return bal; }
    balHandle = h;
    setBal(Number(v) / USDC);
    return bal;
  } finally { status(null); }
}
export const decryptBalance = refreshBalance;
/** Re-decrypts the balance; `atBlock`: as of the block of a known transfer (exact even on a lagging node). */
const refreshSoon = (atBlock = true) => { if (W.player()) setTimeout(() => refreshBalance(atBlock).catch(() => {}), 1500); };

export async function faucet() {
  const s = await session();
  status({ kind: 'chain', text: 'Minting and wrapping 1,000 cUSDC…' });
  try { await s.send(faucetC, 'claimFor', [W.player()], 0n, 'faucet'); }
  catch (e) { throw new Error(friendly(e)); }
  finally { status(null); }
  moveBal(1000);
  refreshSoon();
  return bal;
}

async function session() {
  if (!W.player() || !ready) await connect();
  return W.currentSession();
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
function borrowedTenthSeconds(elapsed, cap = LADDER.length - 1) {
  let total = 0;
  for (let i = 0; i < LADDER.length; i++) {
    const from = i * STEP_SECONDS;
    if (elapsed <= from) break;
    const to = Math.min(i === LADDER.length - 1 ? elapsed : (i + 1) * STEP_SECONDS, elapsed);
    total += 5 * Math.min(i, cap) * (to - from);
  }
  return BigInt(total);
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
      if (run.entryIndex == null) run.entryIndex = Number((await W.view(() => game.getRun(BigInt(run.cid)))).entryIndex);
      const [ts, px] = atBlock
        ? await W.view(() => W.oracle.path(run.market, run.entryIndex, 2n ** 256n - 1n, 64, { blockTag: atBlock }))
        : await W.oracle.path(run.market, run.entryIndex, 2n ** 256n - 1n, 64);
      run.cps = ts.map((t, i) => ({ ts: Number(t), price: px[i] }));
    } catch {}
  };
  await pull();
  run.cpTimer = setInterval(pull, 2500);
}
function chainValue(run, nowMs, live = pythNow(run.market)) {
  if (!run.cps || !run.cps.length) return null;
  const pts = run.cps.slice();
  const nowS = Math.floor(nowMs / 1000), last = pts[pts.length - 1];
  if (live && live.mantissa != null && nowS > last.ts) pts.push({ ts: nowS, price: pythToFixed10(live.mantissa, live.expo) });
  const m = multipliers(pts, Math.floor(run.startedAt / 1000), MOVE_SCALE);
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
  const cv = chainValue(run, ts);
  if (cv) run.acc = cv.mult - 1;
  if (cv && cv.mult === 0) { run.acc = -1; endLocal(run, 'busted', ts); }
  else if (t >= run.duration) endLocal(run, 'expired', ts);
  const u = update(run, ts); run.subs.forEach(cb => cb(u));
}
function update(run, ts) {
  const t = run.pending ? 0 : Math.max(0, (Math.min(ts, run.endedAt || ts) - run.startedAt) / 1000), step = stepAt(t);
  const { value, interest } = net(run.stake, multOf(run.acc), t);
  return { t, price: run.last, step, leverage: LADDER[step], value, pnl: value - run.stake, pnlPct: (value / run.stake - 1) * 100, risk: Math.min(1, Math.max(0, -run.acc)),
    borrowed: run.stake * (LADDER[step] - 1), interest, status: run.status, pending: !!run.pending };
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
  run.local = { status: st, value, pnl: value - run.stake, pnlPct: (value / run.stake - 1) * 100, maxLeverage: run.maxLev, duration, interest, borrowed: run.stake * (run.maxLev - 1),
    entryPrice: run.entryPrice, exitPrice: frozen?.exit ?? run.last, pending: true, runId: run.cid ?? run.id };
  run.waiters.splice(0).forEach(r => r(run.local));
  if (st === 'expired') autopilot.kick();            // anyone may settle at the 60th second; this browser does it now
  else sendCashOut(run, frozen?.pyth, frozen?.after).catch(e => status({ kind: 'error', text: `Cash out: ${friendly(e)}` }));
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
  if (!feed.isOpen(m)) throw new Error(`${MARKETS[m].name} is closed now (US market hours). Try gold or GBP`);
  if (!(stake > 0) || stake > MAX_STAKE) throw new Error(`Stake between 1 and ${MAX_STAKE} cUSDC`);
  if (bal != null && stake > bal) throw new Error('Not enough cUSDC: use the faucet');
  const s = await session();
  const units = Math.round(stake * USDC);
  if (!preEnc.has(`${s.address}:${encKey(side === 'long', units)}`)) status({ kind: 'fhe', text: 'Encrypting your side and stake…' });
  const enc = await takeEncryption(s, side === 'long', units);
  // entry price, in the same transaction: a fresh signed Pyth price, or a bounded public one
  const pyth = await pythFor(m);
  const fallback = pyth ? 0n : await fallbackFor(m);
  let sent;
  try { sent = await s.send(game, 'startRun', [m, enc.handles[0], enc.handles[1], enc.proof, false, pyth ? pyth.updateData : [], fallback], pyth ? pyth.fee : 0n, 'startRun', { fast: true }); }
  catch (e) { status(null); throw new Error(friendly(e)); }
  // the climb starts now; the chain's start time and entry price snap in when the block lands
  const run = makeRun({ id: `tx:${sent.hash}`, assetId, side, stake, startedAt: Date.now(), entryPrice: pyth ? pyth.price : feed.last(m) });
  run.tx = sent.hash;
  status({ kind: 'chain', text: 'Locking your entry on Sepolia…' });
  moveBal(-stake);
  sent.mined.then(rc => {
    const ev = parseEvent(rc, 'RunStarted');
    Object.assign(run, { cid: String(ev.runId), startedAt: Number(ev.startAt) * 1000, entryPrice: Number(ev.entryPrice) / 10 ** PRICE_DECIMALS, pending: false });
    status(null);
    trackCheckpoints(run);
    autopilot.watchRun(run);
  }).catch(e => {
    status({ kind: 'error', text: `Start failed: ${friendly(e)}. Nothing was staked` });
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
  // the result shows now; the transaction leaves now, or right after a checkpoint this browser is
  // still writing on the market; the value is then re-checked against the exact path the contract reads
  const after = autopilot.inflight(run.market);
  endLocal(run, 'cashed', now, { ...(cv || { mult: 1 + run.acc, exit: run.last }), pyth, after });
  return run.local;
}
async function sendCashOut(run, frozenPyth, after = null) {
  const s = await session();
  // a checkpoint this browser is writing on the market lands first: in the same block it would take
  // the cash out's place as the exit price and the paid value would differ from the frozen one
  const landed = after ? await after : null;
  let pyth = frozenPyth === undefined ? await pythFor(run.market) : frozenPyth;
  if (after && run.local && !run.chain && run.pull) {
    // re-check the value against the exact path the contract will read, with a signed price fresh
    // enough to still be accepted when the block lands (Pyth max age 25 s)
    // the frozen signed price stays, unless it would be too old for the oracle when the block lands
    if (pyth && Date.now() / 1000 - pyth.publishTime > 15) pyth = (await pythFor(run.market).catch(() => null)) ?? pyth;
    await run.pull(true, landed?.block ?? null);
    const exact = chainValue(run, Date.now(), pyth ? { mantissa: pyth.mantissa, expo: pyth.expo } : null);
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
    if (!/WrongRunStatus/.test(W.errText(e))) throw e;      // already settled (expiry)
  } finally { status(null); }
  await settleFromChain(run);
}

/** Reads the settled run from the chain: the public long/short multipliers + the player's side. */
export async function settleFromChain(run) {
  for (let i = 0; i < 40; i++) {
    const r = await game.getRun(BigInt(run.cid));
    if (Number(r.status) === 2) {
      const m = run.side === 'long' ? r.multLong : r.multShort, mult = Number(m) / SCALE;
      const { value, interest } = net(run.stake, m, Number(r.endAt - r.startAt));
      const step = Number(r.topStep);
      run.chain = { status: mult === 0 ? 'busted' : run.local?.status === 'busted' ? 'cashed' : run.local?.status || (Number(r.endAt) >= Number(r.startAt) + RUN_SECONDS ? 'expired' : 'cashed'),
        value, pnl: value - run.stake, pnlPct: (value / run.stake - 1) * 100, maxLeverage: LADDER[step], duration: Number(r.endAt - r.startAt),
        interest, borrowed: run.stake * (LADDER[step] - 1),
        entryPrice: Number(r.entryPrice) / 10 ** PRICE_DECIMALS, exitPrice: Number(r.exitPrice) / 10 ** PRICE_DECIMALS,
        multLong: Number(r.multLong) / SCALE, multShort: Number(r.multShort) / SCALE, chain: true, runId: run.cid, tx: run.tx };
      if (!run.local) { run.status = run.chain.status; run.local = run.chain; run.waiters.splice(0).forEach(f => f(run.chain)); }
      run.unsub?.();
      run.settleWaiters.splice(0).forEach(f => f(run.chain));
      moveBal(value);
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

/** Reveals a finished solo run on the leaderboard (multiplier public, stake stays private). */
export async function publishRun(id) {
  const s = await session();
  await s.send(game, 'publishRun', [BigInt(id)], 0n, 'publishRun');
  const [, , , multH] = await game.runHandles(BigInt(id));
  for (let i = 0; i < 10; i++) {
    try { const { values, proof } = await publicDecrypt([multH]); await s.send(game, 'recordRun', [BigInt(id), values[0], proof], 0n, 'recordRun'); return true; }
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
const api = { runs, liveRuns, settleFromChain, focused, status, checkpointed, reserveStats };

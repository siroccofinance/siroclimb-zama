// Siroclimb on Sepolia: the api.js contract (see ../api.js) implemented on the Zama Protocol.
//
// What happens where:
//  - the wallet approves the game once (ERC-7984 operator) and grants a browser session key;
//  - the session key sends every game transaction for the player: encrypted side and stake on
//    start, cash out (with a fresh signed Pyth price riding along), joins, faucet;
//  - the screen runs a local estimate of the run on live prices, the chain settles it on oracle
//    checkpoints (`ClimbLadder`) and pays it in the same transaction with an encrypted amount;
//  - this browser is also the keeper (autopilot.js): price checkpoints, expired runs, round close
//    and the KMS-proven standings reveal, plus practice bots so a round never plays alone.
import { ADDR, JOIN_SECONDS, LADDER, MARKETS, MAX_STAKE, MOVE_SCALE, PRICE_DECIMALS, PRIZE_SPLIT, ROUND_ENTRY, RUN_SECONDS, SCALE, STEP_SECONDS, USDC, indexOf, txUrl } from './config.js';
import * as feed from './feed.js';
import { encryptRun, hasGrant, publicDecrypt, userDecrypt, warmUp } from './fhe.js';
import * as W from './wallet.js';
import { fallbackFor, pythFor } from './prices.js';
import * as autopilot from './autopilot.js';
import * as bots from './bots.js';

const { game, faucet: faucetC, token, rpc, store, friendly, sleep } = W;

export const rules = { ladder: LADDER, stepEvery: STEP_SECONDS, duration: RUN_SECONDS, roundEntry: ROUND_ENTRY, prizeSplit: PRIZE_SPLIT, moveScale: MOVE_SCALE, maxStake: MAX_STAKE };
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
export const balance = () => bal;
export const balanceSealed = () => bal == null;
export function onBalance(cb) { balSubs.add(cb); return () => balSubs.delete(cb); }
let names = new Map();
export const account = () => W.account();
let ready = false;
export const sessionReady = () => ready;

export async function init() {
  feed.start(); warmUp();
  if (W.wasConnected() && W.hasWallet()) {
    try {
      const a = await W.connectWallet(true);
      if (a) { ready = (await W.setupNeeds(a)).length === 0; afterConnect(); }
    } catch {}
  }
  await feed.ready(4000);
  return { user: { name: (W.account() && names.get(W.account().toLowerCase())) || 'You' }, balance: bal };
}

export async function connect() {
  if (!W.account()) { status({ kind: 'wallet', text: 'Connect your wallet…' }); await W.connectWallet(false); }
  const needs = await W.setupNeeds(W.account());
  if (needs.length) {
    try { await W.setup(t => status({ kind: 'wallet', text: t })); }
    catch (e) { status(null); throw new Error(friendly(e)); }
  }
  ready = true;
  status(null);
  // first visit: 1,000 test cUSDC straight away (minted and wrapped by the faucet, through the session key)
  if (Number(await faucetC.lastClaim(W.account()).catch(() => 1)) === 0) await faucet().catch(() => {});
  afterConnect();
  return { address: W.account() };
}

function afterConnect() {
  const a = W.account(); if (!a) return;
  autopilot.start(api);
  if (hasGrant(a)) refreshBalance().catch(() => {});
  game.nameOf(a).then(n => n && names.set(a.toLowerCase(), n)).catch(() => {});
  setTimeout(() => bots.prepareAll(), 4000);       // practice bots ready before the first round
}

export function disconnect() { W.disconnectWallet(); ready = false; setBal(null); autopilot.stop(); }

/** Decrypts the player's encrypted cUSDC balance (asks the wallet for the daily grant once). */
export async function refreshBalance() {
  const a = W.account(); if (!a) return null;
  const h = await token.confidentialBalanceOf(a);
  if (!hasGrant(a)) status({ kind: 'decrypt', text: 'Sign the decryption grant in your wallet (once a day)' });
  else status({ kind: 'decrypt', text: 'Decrypting your balance…' });
  try {
    const [v] = await userDecrypt(a, W.signTyped, [{ handle: h, contract: ADDR.StakeToken }]);
    setBal(Number(v) / USDC);
    return bal;
  } finally { status(null); }
}
export const decryptBalance = refreshBalance;
const refreshSoon = () => { if (W.account() && hasGrant(W.account())) setTimeout(() => refreshBalance().catch(() => {}), 1500); };

export async function faucet() {
  const s = await session();
  status({ kind: 'chain', text: 'Minting and wrapping 1,000 cUSDC…' });
  try { await s.send(faucetC, 'claimFor', [W.account()], 0n, 'faucet'); }
  catch (e) { throw new Error(friendly(e)); }
  finally { status(null); }
  if (bal != null) setBal(bal + 1000);
  refreshSoon();
  return bal;
}

async function session() {
  if (!W.account() || !ready) await connect();
  return W.currentSession();
}

// ───────────────────────────── runs
const runs = new Map();        // id -> local run
const sideSign = s => (s === 'short' ? -1 : 1);
const stepAt = t => Math.min(LADDER.length - 1, Math.max(0, Math.floor(t / STEP_SECONDS)));

function makeRun({ id, mode, assetId, side, stake, startedAt, entryPrice, roundId = null }) {
  const run = { id: String(id), mode, assetId, side, stake, startedAt, entryPrice, roundId, ladder: LADDER, stepEvery: STEP_SECONDS, duration: RUN_SECONDS,
    acc: 0, last: entryPrice, maxLev: 1, status: 'live', subs: new Set(), endedAt: 0, local: null, chain: null, waiters: [], settleWaiters: [], finalWaiters: [] };
  runs.set(run.id, run);
  run.unsub = feed.subscribe(indexOf(assetId), ({ price, ts }) => advance(run, price, ts));
  return run;
}
function advance(run, price, ts) {
  const t = (ts - run.startedAt) / 1000;
  if (run.status !== 'live') return;
  if (t < 0) { run.entryPrice = run.last = price; return; }           // a round fixes its entry on the bell
  const lev = LADDER[stepAt(t)];
  run.acc += MOVE_SCALE * lev * sideSign(run.side) * (price / run.last - 1);
  run.last = price; run.maxLev = Math.max(run.maxLev, lev);
  if (run.acc <= -1) { run.acc = -1; endLocal(run, 'busted', ts); }
  else if (t >= run.duration) endLocal(run, 'expired', ts);
  const u = update(run, ts); run.subs.forEach(cb => cb(u));
}
function update(run, ts) {
  const t = Math.max(0, (Math.min(ts, run.endedAt || ts) - run.startedAt) / 1000), step = stepAt(t), value = run.stake * (1 + run.acc);
  return { t, price: run.last, step, leverage: LADDER[step], value, pnl: value - run.stake, pnlPct: run.acc * 100, risk: Math.min(1, Math.max(0, -run.acc)), status: run.status };
}
/** The run is over on screen; the chain settles it (cash out or expiry tx) and `whenSettled` follows. */
function endLocal(run, st, ts = Date.now()) {
  if (run.status !== 'live') return;
  run.status = st; run.endedAt = ts;
  const value = run.stake * (1 + run.acc);
  run.local = { status: st, value, pnl: value - run.stake, pnlPct: run.acc * 100, maxLeverage: run.maxLev, duration: Math.min(run.duration, (ts - run.startedAt) / 1000),
    entryPrice: run.entryPrice, exitPrice: run.last, pending: true, runId: run.id };
  run.waiters.splice(0).forEach(r => r(run.local));
  if (run.mode === 'solo') {
    if (st === 'expired') autopilot.kick();          // anyone may settle at the 60th second; this browser does it now
    else sendCashOut(run).catch(e => status({ kind: 'error', text: `Cash out: ${friendly(e)}` }));
  } else if (st !== 'expired') sendCashOut(run).catch(e => status({ kind: 'error', text: `Cash out: ${friendly(e)}` }));
}

export async function startRun({ mode = 'solo', assetId, side = 'long', stake }) {
  if (mode === 'round') throw new Error('use joinRound for rounds');
  const m = indexOf(assetId);
  if (!feed.isOpen(m)) throw new Error(`${MARKETS[m].name} is closed now (US market hours). Try gold or GBP`);
  if (!(stake > 0) || stake > MAX_STAKE) throw new Error(`Stake between 1 and ${MAX_STAKE} cUSDC`);
  if (bal != null && stake > bal) throw new Error('Not enough cUSDC: use the faucet');
  const s = await session();
  status({ kind: 'fhe', text: 'Encrypting your side and stake…' });
  const enc = await encryptRun(s.address, side === 'long', Math.round(stake * USDC));
  // entry price, in the same transaction: a fresh signed Pyth price, or a bounded public one
  const pyth = await pythFor(m);
  const fallback = pyth ? 0n : await fallbackFor(m);
  status({ kind: 'chain', text: 'Sealing your run on Sepolia…' });
  let rc;
  try { rc = await s.send(game, 'startRun', [m, enc.handles[0], enc.handles[1], enc.proof, false, pyth ? pyth.updateData : [], fallback], pyth ? pyth.fee : 0n, 'startRun'); }
  catch (e) { status(null); throw new Error(friendly(e)); }
  status(null);
  const ev = parseEvent(rc, 'RunStarted');
  const run = makeRun({ id: ev.runId, mode: 'solo', assetId, side, stake, startedAt: Number(ev.startAt) * 1000, entryPrice: Number(ev.entryPrice) / 10 ** PRICE_DECIMALS });
  run.tx = rc.hash;
  if (bal != null) setBal(bal - stake);
  autopilot.watchRun(run);
  return publicRun(run);
}

function parseEvent(rc, name) {
  for (const l of rc.logs) { try { const e = game.interface.parseLog(l); if (e?.name === name) return e.args; } catch {} }
  throw new Error(`no ${name} event`);
}
const publicRun = r => ({ id: r.id, mode: r.mode, assetId: r.assetId, side: r.side, stake: r.stake, entryPrice: r.entryPrice, startedAt: r.startedAt, ladder: r.ladder, stepEvery: r.stepEvery, duration: r.duration, tx: r.tx });
export function onRun(id, cb) { const run = runs.get(String(id)); run.subs.add(cb); return () => run.subs.delete(cb); }
export const runInfo = id => { const r = runs.get(String(id)); return r ? publicRun(r) : null; };
export const runResult = id => { const r = runs.get(String(id)); return r?.chain || r?.local || null; };
export function whenEnded(id) { const r = runs.get(String(id)); return r.local ? Promise.resolve(r.local) : new Promise(res => r.waiters.push(res)); }
/** Resolves with the chain-verified result once the run is settled on chain. */
export function whenSettled(id) { const r = runs.get(String(id)); return r.chain ? Promise.resolve(r.chain) : new Promise(res => r.settleWaiters.push(res)); }

export async function cashOut(id) {
  const run = runs.get(String(id));
  if (run.status === 'live') endLocal(run, 'cashed');
  return run.local;
}
async function sendCashOut(run) {
  const s = await session();
  const pyth = await pythFor(indexOf(run.assetId));
  status({ kind: 'chain', text: run.mode === 'solo' ? 'Cashing out: encrypted payout on Sepolia…' : 'Locking your exit on Sepolia…' });
  try {
    const rc = await s.send(game, 'cashOut', [BigInt(run.id), pyth ? pyth.updateData : []], pyth ? pyth.fee : 0n, 'cashOut');
    run.tx = rc.hash;
  } catch (e) {
    if (!/WrongRunStatus/.test(W.errText(e))) throw e;      // already settled (expiry, round close)
  } finally { status(null); }
  await settleFromChain(run);
}

/** Reads the settled run from the chain: the public long/short multipliers + the player's side. */
export async function settleFromChain(run) {
  for (let i = 0; i < 40; i++) {
    const r = await game.getRun(BigInt(run.id));
    if (Number(r.status) === 2) {
      const mult = Number(run.side === 'long' ? r.multLong : r.multShort) / SCALE;
      const value = run.stake * mult;
      const step = Number(r.topStep);
      run.chain = { status: mult === 0 ? 'busted' : run.local?.status === 'busted' ? 'cashed' : run.local?.status || (Number(r.endAt) >= Number(r.startAt) + RUN_SECONDS ? 'expired' : 'cashed'),
        value, pnl: value - run.stake, pnlPct: (mult - 1) * 100, maxLeverage: LADDER[step], duration: Number(r.endAt - r.startAt),
        entryPrice: Number(r.entryPrice) / 10 ** PRICE_DECIMALS, exitPrice: Number(r.exitPrice) / 10 ** PRICE_DECIMALS,
        multLong: Number(r.multLong) / SCALE, multShort: Number(r.multShort) / SCALE, chain: true, runId: run.id, tx: run.tx };
      if (!run.local) { run.status = run.chain.status; run.local = run.chain; run.waiters.splice(0).forEach(f => f(run.chain)); }
      run.unsub?.();
      run.settleWaiters.splice(0).forEach(f => f(run.chain));
      if (run.mode === 'solo') { if (bal != null) setBal(bal - 0 + value); refreshSoon(); record(run); }
      return run.chain;
    }
    await sleep(3000);
  }
  throw new Error('run not settled yet');
}
export const liveRuns = () => [...runs.values()].filter(r => !r.chain);

function record(run) {
  const h = store.get('history', []);
  h.unshift({ ts: Date.now(), assetId: run.assetId, side: run.side, stake: run.stake, mode: run.mode, ...run.chain });
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

// ───────────────────────────── rounds
let round = null;             // cached public round
const roundSubs = new Set();
let roundCache = { latest: null, runs: [], at: 0 };
const myRoundRuns = new Map(); // roundId -> run id

async function pollRound() {
  try {
    const n = Number(await game.roundCount());
    let latest = null, runsInfo = [];
    if (n > 0) {
      const [r, ids] = await game.getRound(n - 1);
      latest = { id: n - 1, market: Number(r.market), status: Number(r.status), opensAt: Number(r.opensAt) * 1000, startsAt: Number(r.startsAt) * 1000, endsAt: Number(r.endsAt) * 1000, entry: Number(r.entry) / USDC, ids: ids.map(Number) };
      runsInfo = await Promise.all(latest.ids.map(async i => { const x = await game.getRun(i); return { id: i, player: x.player, status: Number(x.status), endAt: Number(x.endAt) * 1000 }; }));
      await loadNames(runsInfo.map(x => x.player));
    }
    const next = Number(await game.nextRoundMarket());
    roundCache = { latest, runs: runsInfo, next, count: n, at: Date.now() };
    const a = W.account()?.toLowerCase();
    if (latest && a) { const mine = runsInfo.find(x => x.player.toLowerCase() === a); if (mine) myRoundRuns.set(latest.id, String(mine.id)); }
  } catch {}
}
async function loadNames(addrs) {
  const missing = [...new Set(addrs.map(a => a.toLowerCase()))].filter(a => !names.has(a));
  await Promise.all(missing.map(async a => { try { names.set(a, (await game.nameOf(a)) || ''); } catch {} }));
}
export const nameOf = a => names.get(a.toLowerCase()) || a.slice(0, 6) + '…' + a.slice(-4);

function buildRound(now = Date.now()) {
  const L = roundCache.latest, a = W.account()?.toLowerCase();
  const joinedRun = L ? myRoundRuns.get(L.id) : null;
  if (L && now < L.endsAt && (now < L.startsAt || joinedRun)) {
    return { id: L.id, assetId: MARKETS[L.market].id, opensAt: L.opensAt, startsAt: L.startsAt, endsAt: L.endsAt, status: now < L.startsAt ? 'open' : 'live',
      players: L.ids.length, pot: L.ids.length * L.entry, entry: L.entry, joined: !!joinedRun, late: false, runId: joinedRun || null, virtual: false };
  }
  // no round open: the next join opens one on the next live market of the rotation
  const id = roundCache.count ?? 0, next = roundCache.next ?? 0;
  return { id, assetId: MARKETS[next].id, opensAt: now, startsAt: now + JOIN_SECONDS * 1000, endsAt: now + (JOIN_SECONDS + RUN_SECONDS) * 1000, status: 'open',
    players: 0, pot: 0, entry: ROUND_ENTRY, joined: false, late: false, runId: null, virtual: true, liveRound: L && now < L.endsAt ? L.id : null };
}
export const currentRound = () => (round = buildRound());
export function onRound(cb) { roundSubs.add(cb); cb(currentRound()); return () => roundSubs.delete(cb); }
setInterval(() => { const r = currentRound(); roundSubs.forEach(cb => cb(r)); }, 1000);
setInterval(pollRound, 3000); pollRound();
export const roundData = () => roundCache;

export async function joinRound({ side = 'long' }) {
  const r = currentRound();
  if (r.joined) return r;
  if (!r.virtual && Date.now() > r.startsAt - 3000) throw new Error('This round has started, join the next one');
  if (bal != null && bal < r.entry) throw new Error('Not enough cUSDC: use the faucet');
  const s = await session();
  status({ kind: 'fhe', text: 'Encrypting your side…' });
  const enc = await encryptRun(s.address, side === 'long');
  status({ kind: 'chain', text: r.virtual ? 'Opening the round on Sepolia…' : 'Joining the round on Sepolia…' });
  let rc;
  try { rc = await s.send(game, 'joinRound', [r.id, enc.handles[0], enc.proof], 0n, 'joinRound'); }
  catch (e) { status(null); throw new Error(friendly(e)); }
  status(null);
  const ev = parseEvent(rc, 'RunStarted');
  const id = String(ev.runId);
  myRoundRuns.set(Number(ev.roundId), id);
  makeRun({ id, mode: 'round', assetId: MARKETS[Number(ev.market)].id, side, stake: ROUND_ENTRY, startedAt: Number(ev.startAt) * 1000, entryPrice: feed.last(Number(ev.market)), roundId: Number(ev.roundId) });
  if (bal != null) setBal(bal - ROUND_ENTRY);
  for (let i = 0; i < 10; i++) { await pollRound(); if ((roundCache.latest?.id ?? -1) >= Number(ev.roundId)) break; await sleep(1500); }   // lagging RPC nodes
  bots.fill(Number(ev.roundId));
  return currentRound();
}

/** Live standings: everyone's side and score are encrypted until the bell, only exits are public. */
export function roundStandings() {
  const L = roundCache.latest; if (!L) return [];
  const a = W.account()?.toLowerCase();
  const out = roundCache.runs.map(x => {
    const me = x.player.toLowerCase() === a, local = me ? runs.get(String(x.id)) : null;
    const u = local ? update(local, Date.now()) : null;
    return { name: me ? 'You' : nameOf(x.player), pnlPct: u ? u.pnlPct : null, sealed: !me, status: x.status === 2 || (u && u.status !== 'live') ? 'cashed' : 'live', you: me };
  });
  return out.map((s, i) => ({ ...s, rank: i + 1 }));
}

/** Resolves once the round's standings are revealed (KMS proof checked on chain) and the pot paid. */
export function whenRoundFinal(runId) {
  const run = runs.get(String(runId));
  return new Promise(res => {
    const check = async () => {
      try {
        const [r] = await game.getRound(run.roundId);
        if (Number(r.status) === 3) {
          const n = Number(await game.resultCount());
          const list = await game.results(Math.max(0, n - 80), 80);
          const mine = list.find(x => x.inRound && Number(x.ref) === run.roundId && x.player.toLowerCase() === W.account().toLowerCase());
          if (!run.chain) await settleFromChain(run).catch(() => {});
          // the prize is a pull payment (one encrypted transfer per claim): the session claims it
          if (Number(await game.prizeOf(BigInt(run.id))) > 0 && !(await game.claimed(BigInt(run.id)))) {
            status({ kind: 'chain', text: 'Claiming your prize: encrypted transfer…' });
            await W.currentSession().send(game, 'claim', [BigInt(run.id)], 0n, 'claim').catch(() => {});
            status(null);
          }
          const base = run.chain || run.local;
          const out = { ...base, rank: mine ? Number(mine.rank) : null, of: Number(r.fundedCount), prize: mine ? Number(mine.prize) / USDC : 0, pnlPct: mine ? Number(mine.pnlPpm) / 1e4 : base.pnlPct, final: true };
          lastRoundId = run.roundId;
          if (bal != null && out.prize) setBal(bal + out.prize);
          refreshSoon();
          return res(out);
        }
      } catch {}
      setTimeout(check, 3000);
    };
    check();
  });
}

// ───────────────────────────── leaderboards (public results only: round standings + published runs)
let lastRoundId = null;
export async function leaderboard(scope = 'today') {
  const n = Number(await game.resultCount());
  const list = n ? await game.results(Math.max(0, n - 400), 400) : [];
  await loadNames(list.map(x => x.player));
  const a = W.account()?.toLowerCase();
  const row = x => ({ name: x.player.toLowerCase() === a ? 'You' : nameOf(x.player), pnlPct: Number(x.pnlPpm) / 1e4, prize: Number(x.prize) / USDC, you: x.player.toLowerCase() === a, rank: Number(x.rank) });
  if (scope === 'round') {
    const rounds = list.filter(x => x.inRound);
    const id = rounds.length ? Number(rounds[rounds.length - 1].ref) : null;
    return rounds.filter(x => Number(x.ref) === id).sort((p, q) => Number(p.rank) - Number(q.rank)).map(row);
  }
  const since = scope === 'all' ? 0 : Date.now() / 1000 - 86400;
  const best = new Map();
  for (const x of list) {
    if (Number(x.timestamp) < since) continue;
    const k = x.player.toLowerCase(), b = best.get(k);
    if (!b || Number(x.pnlPpm) > Number(b.pnlPpm)) best.set(k, x);
  }
  return [...best.values()].sort((p, q) => Number(q.pnlPpm) - Number(p.pnlPpm)).slice(0, 12).map(row);
}

export async function setName(name) { const s = await session(); await s.send(game, 'setName', [name.slice(0, 24)], 0n, 'setName'); names.set(W.account().toLowerCase(), name); }

// ───────────────────────────── leverage packs (encrypted PRNG on chain). UI off for now.
export const PACKS = [
  { tier: 'Bronze', maxLeverage: 1.5, odds: 0.45 }, { tier: 'Silver', maxLeverage: 2, odds: 0.28 },
  { tier: 'Gold', maxLeverage: 3, odds: 0.18 }, { tier: 'Diamond', maxLeverage: 4, odds: 0.09 },
];
export async function openPack() {
  const s = await session();
  const rc = await s.send(game, 'openPack', [], 0n, 'openPack');
  const h = parseEvent(rc, 'PackOpened').tierHandle;
  const [tier] = await userDecrypt(W.account(), W.signTyped, [{ handle: h, contract: ADDR.Siroclimb }]);
  const p = PACKS[Number(tier)];
  return { tier: p.tier, maxLeverage: p.maxLeverage, proof: rc.hash };
}

export async function shareCard() { return null; }

export const _debug = { runs, roundCache: () => roundCache, feed, bots, autopilot };

const api = { runs, liveRuns, settleFromChain, roundData, pollRound, focused, status, myRoundRuns };

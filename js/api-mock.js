// Siroclimb: the in-browser simulation of the back end (open the game with ?mock).
//
// Same exported names and event shapes as the Sepolia version (js/chain/api-chain.js); the
// contract between the front and the back end is documented at the top of js/api.js.
// Prices here are a random walk that moves faster than the market, so a minute has stakes.

// ─────────────────────────────── MOCK ───────────────────────────────

const Q = new URLSearchParams(location.search);
const WILD = Q.get('demo') === 'wild';          // ?demo=wild: much bigger moves, to see the fall
const DEMO_VOL = 4;                              // the demo feed moves faster than the real market, so a minute of play has stakes
const TICK_MS = 200;

const ASSETS = [
  { id: 'TSLAx', name: 'Tesla', ticker: 'TSLAx', kind: 'stock', token: 'cTSLAx', p0: 385.17, vol: 0.0011 },
  { id: 'NVDAx', name: 'NVIDIA', ticker: 'NVDAx', kind: 'stock', token: 'cNVDAx', p0: 165.01, vol: 0.0010 },
  { id: 'AAPLx', name: 'Apple', ticker: 'AAPLx', kind: 'stock', token: 'cAAPLx', p0: 349.03, vol: 0.0007 },
  { id: 'AMZNx', name: 'Amazon', ticker: 'AMZNx', kind: 'stock', token: 'cAMZNx', p0: 252.56, vol: 0.0009 },
  { id: 'XAUt', name: 'Gold', ticker: 'XAUt', kind: 'gold', token: 'cXAUt', p0: 3625.1, vol: 0.0005 },
  { id: 'tGBP', name: 'British pound', ticker: 'GBP', kind: 'fx', token: 'ctGBP', p0: 1.3031, vol: 0.0003 },
];

export const rules = { ladder: [1, 1.5, 2, 2.5, 3, 3.5, 4], stepEvery: 6, duration: 60, roundEntry: 10, prizeSplit: [0.5, 0.3, 0.2] };

// ── prices: one random walk per asset (per-second volatility), shared clock
const feeds = new Map();
for (const a of ASSETS) feeds.set(a.id, { price: a.p0 * (1 + (Math.random() - 0.5) * 0.004), hist: [], subs: new Set(), vol: a.vol * DEMO_VOL * (WILD ? 3 : 1), drift: 0 });
const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
function tick() {
  const ts = Date.now(), dt = TICK_MS / 1000;
  for (const f of feeds.values()) {
    f.drift = f.drift * 0.98 + gauss() * 0.02;                 // a little momentum, so moves read as trends
    f.price *= Math.exp(f.vol * Math.sqrt(dt) * (gauss() + f.drift * 1.5));
    f.hist.push({ price: f.price, ts }); if (f.hist.length > 900) f.hist.shift();
    f.subs.forEach(cb => cb({ price: f.price, ts }));
  }
  runTick(ts); roundTick(ts);
}
for (let i = 0; i < 300; i++) { const ts = Date.now() - (300 - i) * TICK_MS; for (const f of feeds.values()) { f.price *= Math.exp(f.vol * Math.sqrt(TICK_MS / 1000) * gauss()); f.hist.push({ price: f.price, ts }); } }
setInterval(tick, TICK_MS);

export const listAssets = () => ASSETS.map(({ id, name, ticker, kind, token }) => ({ id, name, ticker, kind, token, open: true }));
export function subscribePrice(id, cb) { const f = feeds.get(id); f.subs.add(cb); cb(f.hist[f.hist.length - 1]); return () => f.subs.delete(cb); }
export function history(id, seconds = 60) { const f = feeds.get(id), from = Date.now() - seconds * 1000; return f.hist.filter(h => h.ts >= from); }

// ── wallet (test tokens, kept in this browser)
const store = {
  get(k, d) { try { const v = localStorage.getItem('siroclimb:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('siroclimb:' + k, JSON.stringify(v)); } catch {} },
};
let bal = store.get('balance', 1000);
const balSubs = new Set();
const setBal = v => { bal = Math.round(v * 100) / 100; store.set('balance', bal); balSubs.forEach(cb => cb(bal)); };
export const balance = () => bal;
export function onBalance(cb) { balSubs.add(cb); return () => balSubs.delete(cb); }
export async function faucet() { setBal(Math.max(bal, 1000)); return bal; }
export const account = () => store.get('address', null);
export async function connect() {               // wallet + game session (one signature, then instant actions)
  await new Promise(r => setTimeout(r, 650));
  let a = account();
  if (!a) { const B = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; a = Array.from(crypto.getRandomValues(new Uint8Array(44)), b => B[b % 58]).join(''); store.set('address', a); }
  return { address: a };
}
export function disconnect() { store.set('address', null); }
export async function init() { return { user: { name: store.get('name', 'You') }, balance: bal }; }

// ── runs
const runs = new Map();
const sideSign = s => (s === 'short' ? -1 : 1);
function makeRun({ mode, assetId, side, stake, startedAt = Date.now(), name = 'You', bot = null }) {
  const f = feeds.get(assetId);
  return { id: Math.random().toString(36).slice(2), mode, assetId, side, stake, name, bot, entryPrice: f.price, last: f.price, startedAt,
    ladder: rules.ladder, stepEvery: rules.stepEvery, duration: rules.duration, value: stake, maxLev: 1, status: 'live', subs: new Set(), endedAt: 0 };
}
function stepOf(run, t) { return Math.min(run.ladder.length - 1, Math.floor(t / run.stepEvery)); }
function advance(run, ts) {
  if (run.status !== 'live') return;
  const f = feeds.get(run.assetId), t = (ts - run.startedAt) / 1000;
  if (t < 0) { run.last = f.price; run.entryPrice = f.price; return; }
  const step = stepOf(run, t), lev = run.ladder[step];
  run.value *= 1 + lev * sideSign(run.side) * (f.price / run.last - 1);
  run.last = f.price; run.maxLev = Math.max(run.maxLev, lev);
  if (run.value <= 0) { run.value = 0; run.status = 'busted'; run.endedAt = ts; }
  else if (t >= run.duration) { run.status = 'expired'; run.endedAt = ts; }
  if (run.bot && run.status === 'live' && run.bot(t, run)) { run.status = 'cashed'; run.endedAt = ts; }
}
function update(run, ts) {
  const t = Math.max(0, (Math.min(ts, run.endedAt || ts) - run.startedAt) / 1000), step = stepOf(run, t);
  return { t, price: run.last, step, leverage: run.ladder[step], value: run.value, pnl: run.value - run.stake, pnlPct: (run.value / run.stake - 1) * 100,
    risk: Math.min(1, Math.max(0, 1 - run.value / run.stake)), status: run.status };
}
function settle(run) {
  const r = { status: run.status, value: run.value, pnl: run.value - run.stake, pnlPct: (run.value / run.stake - 1) * 100, maxLeverage: run.maxLev,
    duration: ((run.endedAt || Date.now()) - run.startedAt) / 1000, entryPrice: run.entryPrice, exitPrice: run.last };
  if (run.mode === 'solo' && !run.bot) { setBal(bal + run.value); record(run, r); }
  return r;
}
function runTick(ts) {
  for (const run of runs.values()) {
    const was = run.status; advance(run, ts);
    const u = update(run, ts); run.subs.forEach(cb => cb(u));
    if (was === 'live' && run.status !== 'live' && !run.bot) { run.result = settle(run); run.done?.(run.result); }
  }
}
export async function startRun({ mode = 'solo', assetId, side = 'long', stake }) {
  if (mode === 'round') throw new Error('use joinRound for rounds');
  if (!(stake > 0) || stake > bal) throw new Error('Not enough test tokens');
  setBal(bal - stake);
  const run = makeRun({ mode, assetId, side, stake }); runs.set(run.id, run);
  return publicRun(run);
}
const publicRun = r => ({ id: r.id, mode: r.mode, assetId: r.assetId, side: r.side, stake: r.stake, entryPrice: r.entryPrice, startedAt: r.startedAt, ladder: r.ladder, stepEvery: r.stepEvery, duration: r.duration });
export function onRun(id, cb) { const run = runs.get(id); run.subs.add(cb); return () => run.subs.delete(cb); }
export function runResult(id) { const run = runs.get(id); return run.result || null; }
export function whenEnded(id) { const run = runs.get(id); return run.result ? Promise.resolve(run.result) : new Promise(res => { run.done = res; }); }
export async function cashOut(id) {
  const run = runs.get(id);
  if (run.status === 'live') { advance(run, Date.now()); if (run.status === 'live') { run.status = 'cashed'; run.endedAt = Date.now(); } run.result = settle(run); run.done?.(run.result); }
  return run.result;
}

// ── history + leaderboards (local for the mock)
function record(run, r) {
  const h = store.get('history', []);
  h.unshift({ ts: Date.now(), assetId: run.assetId, side: run.side, stake: run.stake, mode: run.mode, ...r });
  store.set('history', h.slice(0, 100));
}
const NAMES = ['dune.sol', 'mistral', 'saffron', 'harmattan', 'oasis', 'zephyr', 'atlas', 'ghibli', 'khamsin', 'leveche', 'simoom', 'tramontane', 'bora', 'chinook'];
export async function leaderboard(scope = 'today') {
  if (scope === 'round') return lastRound ? lastRound.standings : [];
  const mine = store.get('history', []).filter(h => scope === 'all' || Date.now() - h.ts < 864e5).map(h => ({ name: 'You', pnlPct: h.pnlPct, pnl: h.pnl, you: true }));
  const seed = scope === 'all' ? 7 : new Date().getDate();
  const bots = NAMES.map((n, i) => ({ name: n, pnlPct: ((Math.sin(seed * 97 + i * 13.7) * 0.5 + 0.5) ** 2) * (scope === 'all' ? 46 : 22) + 0.4 }));
  const best = mine.sort((a, b) => b.pnlPct - a.pnlPct).slice(0, 3);
  return [...bots, ...best].sort((a, b) => b.pnlPct - a.pnlPct).slice(0, 12);
}

// ── rounds: every 80 s, 20 s to join then 60 s live, same asset for everyone
const CYCLE = 80000, OPEN = 20000;
let round = null, lastRound = null; const roundSubs = new Set();
const hash = n => { const x = Math.sin(n * 127.1) * 43758.5453; return x - Math.floor(x); };
function roundFor(now) {
  const n = Math.floor(now / CYCLE), opensAt = n * CYCLE;
  const asset = ASSETS[Math.floor(hash(n) * ASSETS.length)];
  return { id: n, assetId: asset.id, opensAt, startsAt: opensAt + OPEN, endsAt: opensAt + OPEN + rules.duration * 1000, entry: rules.roundEntry, players: 0, pot: 0, joined: false, runs: [] };
}
function botStrategy(seed) {           // cash out at a profit target, a stop, or a time; some ride to the end
  const target = 0.6 + hash(seed) * 4, stop = -2 - hash(seed + 1) * 10, until = 12 + hash(seed + 2) * 50;
  return (t, run) => { const p = (run.value / run.stake - 1) * 100; return p >= target || p <= stop || t >= until; };
}
function roundTick(ts) {
  if (round && ts >= round.endsAt && !round.paid) payRound(round);
  if (!round || ts >= round.endsAt + 4000 || (round.id !== Math.floor(ts / CYCLE) && ts >= round.endsAt)) {
    if (round && round.runs.length) lastRound = { id: round.id, standings: standings(round) };
    round = roundFor(ts);
    if (ts > round.startsAt) round.late = true;                    // page opened mid-round: watch, join the next one
  }
  // bots drift in while the round is open
  if (ts < round.startsAt) {
    const want = Math.floor(3 + hash(round.id) * 6 + ((ts - round.opensAt) / OPEN) * (4 + hash(round.id + 3) * 5));
    while (round.runs.filter(r => r.bot).length < want && !round.late) {
      const i = round.runs.length, s = round.id * 31 + i;
      const run = makeRun({ mode: 'round', assetId: round.assetId, side: hash(s) > 0.5 ? 'long' : 'short', stake: round.entry, startedAt: round.startsAt, name: NAMES[(round.id + i) % NAMES.length], bot: botStrategy(s) });
      round.runs.push(run); runs.set(run.id, run);
    }
  }
  round.players = round.runs.length; round.pot = round.players * round.entry;
  round.status = ts < round.startsAt ? 'open' : 'live';
  if (ts >= round.endsAt && !round.paid) payRound(round);
  if (Math.floor(ts / 1000) !== round._s) { round._s = Math.floor(ts / 1000); roundSubs.forEach(cb => cb(publicRound(round))); }
}
function standings(r) {
  return r.runs.map(run => ({ name: run.name, pnlPct: (run.value / run.stake - 1) * 100, status: run.status, you: !run.bot }))
    .sort((a, b) => b.pnlPct - a.pnlPct).map((s, i) => ({ ...s, rank: i + 1 }));
}
function payRound(r) {
  r.paid = true;
  const st = standings(r);
  st.forEach((s, i) => { s.prize = i < rules.prizeSplit.length ? Math.round(r.pot * rules.prizeSplit[i] * 100) / 100 : 0; });
  const me = st.find(s => s.you), myRun = r.runs.find(x => !x.bot);
  if (me && myRun) {
    if (me.prize) setBal(bal + me.prize);
    myRun.result = { ...(myRun.result || { status: myRun.status, value: myRun.value, pnl: myRun.value - myRun.stake, pnlPct: me.pnlPct, maxLeverage: myRun.maxLev, duration: rules.duration, entryPrice: myRun.entryPrice, exitPrice: myRun.last }), rank: me.rank, of: st.length, prize: me.prize, final: true };
    record(myRun, myRun.result);
    myRun.final?.(myRun.result);
  }
  lastRound = { id: r.id, standings: st };
}
const publicRound = r => ({ id: r.id, assetId: r.assetId, opensAt: r.opensAt, startsAt: r.startsAt, endsAt: r.endsAt, status: r.status, players: r.players, pot: r.pot, entry: r.entry, joined: r.joined, late: !!r.late, runId: r.myRunId || null });
export const currentRound = () => publicRound(round);
export function onRound(cb) { roundSubs.add(cb); cb(publicRound(round)); return () => roundSubs.delete(cb); }
export async function joinRound({ side = 'long' }) {
  if (round.status !== 'open' || round.late) throw new Error('This round has started, join the next one');
  if (round.joined) return publicRound(round);
  if (round.entry > bal) throw new Error('Not enough test tokens');
  setBal(bal - round.entry);
  const run = makeRun({ mode: 'round', assetId: round.assetId, side, stake: round.entry, startedAt: round.startsAt, name: 'You' });
  round.runs.push(run); runs.set(run.id, run); round.joined = true; round.myRunId = run.id;
  roundTick(Date.now());
  return publicRound(round);
}
export const roundStandings = () => (round ? standings(round) : []);
export function whenRoundFinal(runId) { const run = runs.get(runId); return run.result?.final ? Promise.resolve(run.result) : new Promise(res => { run.final = res; }); }
export function runInfo(id) { const r = runs.get(id); return r ? publicRun(r) : null; }

// ── leverage packs (VRF on chain). Kept off in the UI for now.
export const PACKS = [
  { tier: 'Bronze', maxLeverage: 1.5, odds: 0.45 }, { tier: 'Silver', maxLeverage: 2, odds: 0.28 },
  { tier: 'Gold', maxLeverage: 3, odds: 0.18 }, { tier: 'Diamond', maxLeverage: 4, odds: 0.09 },
];
export async function openPack() {
  const r = crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32; let acc = 0;
  const p = PACKS.find(p => (acc += p.odds) >= r) || PACKS[0];
  return { tier: p.tier, maxLeverage: p.maxLeverage, proof: 'mock-' + r.toString(16).slice(2, 10) };
}

// the front cannot host pictures alone: the back end can upload `png` and return a page with twitter:card = summary_large_image
export async function shareCard(png, result) { return null; }

// test hook for the front (not part of the contract): force a fall on a live run
export const _debug = { bust() { for (const r of runs.values()) if (!r.bot && r.status === 'live') r.value = -1; } };

roundTick(Date.now());                          // a round exists from the first frame

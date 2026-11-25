// On-chain test battery on Sepolia: many players at once, every result checked end to end.
//
//  setup   fresh players from our own mnemonic: gas from the Siroclimb deployer, test cUSDC
//          from the faucet, the game as ERC-7984 operator, a name.
//  solo    every player runs concurrently on the open markets with random encrypted sides and
//          stakes; some cash out early (with a signed Pyth price when covered), some ride to the
//          60th second and are settled by someone else; scenarios: stake above the 100 cap
//          (clamped on ciphertexts), an unfunded player (moves 0, paid 0), leverage packs (capped
//          path selected on ciphertexts), published runs (KMS proof).
//          Checks: the public multipliers equal ClimbLadder's recomputation on the oracle path;
//          the player's decrypted multiplier is the one of its side; the decrypted interest is the
//          borrow interest of the run; the decrypted balance moved by exactly paid x mult - interest - paid.
//
// usage: node battery.mjs [players=16] [soloWaves=2]
import { mkdirSync, writeFileSync } from 'node:fs';
import { Contract } from 'ethers';
import { ADDR, MARKETS, SCALE, Sender, USDC, balanceAt, provider, withTimeout, balanceOf, settledBlock, view, batteryWallet, encryptRun, errText, faucet, fallbackFor, game, handle, key, ladder, openMarkets, publicDecrypt, pushIfStale, pythFor, sleep, token, userDecrypt } from './lib.mjs';

const N = Number(process.argv[2] || 16), WAVES = Number(process.argv[3] || 2);
const OFFSET = Number(process.env.OFFSET || 1);         // index 0 is the browser e2e player
const t0 = Date.now(), T = () => `${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s`;
const log = (...a) => console.log(T(), ...a);
const results = { started: new Date().toISOString(), game: ADDR.Siroclimb, players: N, solo: [], findings: [], gas: {} };
const pass = (kind, ok, detail) => { results.solo.push({ ok, ...detail }); if (!ok) log('FAIL', kind, JSON.stringify(detail, (k, v) => (typeof v === 'bigint' ? v.toString() : v))); };

const deployer = new Sender(key('deployer.key'), 'deployer');
const keeper = new Sender(key('keeper.key'), 'keeper');
const players = Array.from({ length: N }, (_, i) => Object.assign(new Sender(batteryWallet(OFFSET + i)), { i, name: handle(OFFSET + i + 7) }));
const poor = Object.assign(new Sender(batteryWallet(800)), { i: 'poor', name: 'quiet.nomad' });

// ── setup
async function setup(p, { fund = true } = {}) {
  if ((await p.eth()) < 0.01) await deployer.sendEth(p.address, 0.02);
  if (fund && Number(await faucet.lastClaim(p.address)) === 0) await p.send(faucet, 'claim');
  if (!(await token.isOperator(p.address, ADDR.Siroclimb))) await p.send(token, 'setOperator', [ADDR.Siroclimb, Math.floor(Date.now() / 1000) + 30 * 86400]);
  if (!(await game.nameOf(p.address))) await p.send(game, 'setName', [p.name]);
}
async function topUp(p) {
  const wait = Number(await faucet.waitOf(p.address));
  if (wait === 0) await p.send(faucet, 'claimFor', [p.address]);
}

// ── keeper loop: checkpoints for markets in use; settlements run on their own key below
const inUse = new Set(), expired = new Set();
let keeping = true;
async function keeperLoop() {
  while (keeping) {
    try { await keeperTick(); } catch (e) { log('keeper tick', errText(e)); }   // a lagging read must never stop the keeper
    await sleep(2500);
  }
}
async function keeperTick() {
  for (const m of inUse) await pushIfStale(keeper, m, 11).catch(e => log('keeper price', MARKETS[m].id, errText(e)));
}
// settlements on their own key: a price checkpoint waiting for its block never delays a settlement
const settler = new Sender(batteryWallet(901), 'settler');
async function settlerLoop() {
  while (keeping) {
    try { await settlerTick(); } catch (e) { log('settler tick', errText(e)); }
    await sleep(2500);
  }
}
async function settlerTick() {
  {
    for (const id of [...expired]) {
      const r = await game.getRun(id);
      if (Number(r.status) === 2) { expired.delete(id); continue; }
      if (Date.now() / 1000 > Number(r.startAt) + 62) await settler.send(game, 'settleRun', [id]).then(() => expired.delete(id)).catch(e => { if (!/WrongRunStatus/.test(errText(e))) log('keeper settle', id, errText(e)); });
    }
  }
}

// ── solo
function expectedPaid(stake) { return stake > 100n * USDC ? 100n * USDC : stake; }
// borrow interest on the real position's loan, 3 x the stake for the run's seconds (Siroclimb.borrowedTenthSeconds)
const APR_BPS = await game.borrowAprBps(), INTEREST_DIVISOR = await game.interestDivisor();
const borrowedTenthSeconds = elapsed => 30n * BigInt(elapsed);
async function soloRun(p, wave, delay = 0) {
  await sleep(delay);                                    // staggered starts: the relayer is shared
  let open = await openMarkets();
  if (!open.length) open = [MARKETS.findIndex(m => m.id === 'XAUt')];   // gold trades around the clock
  const market = open[Math.floor(Math.random() * open.length)];
  const long = Math.random() < 0.5;
  const scenario = p === poor ? 'unfunded' : Math.random() < 0.12 ? 'clamp' : Math.random() < 0.15 && p.hasPack ? 'pack' : Math.random() < 0.35 ? 'expire' : 'cash';
  const stake = scenario === 'clamp' ? 150n * USDC : BigInt(5 + Math.floor(Math.random() * 60)) * USDC;
  inUse.add(market);
  const step = (what) => process.env.TRACE && log(`  ${p.name} ${what}`);
  const enc = await encryptRun(p.address, long, stake);
  step('encrypted');
  // entry price riding along: a signed Pyth update, else a bounded public price. A start without either
  // on a stale market would revert (StaleEntry), so the lookup is retried before sending (F38)
  let rc;
  for (let attempt = 0; ; attempt++) {
    const py = await withTimeout(pythFor(market), 30_000, 'pyth update').catch(() => null);
    const fb = py ? 0n : await withTimeout(fallbackFor(market), 30_000, 'fallback price').catch(() => 0n);
    step(`prices ready (${py ? 'pyth' : fb ? 'fallback' : 'none'})`);
    if (!py && !fb && attempt < 4) { await sleep(5000); continue; }
    try { rc = await p.send(game, 'startRun', [market, enc.handles[0], enc.handles[1], enc.proof, scenario === 'pack', py ? py.updateData : [], fb], py ? py.fee : 0n); break; }
    catch (e) { if (attempt >= 2 || !/reverted|StaleEntry/.test(errText(e))) throw e; step('start reverted, retrying with fresh prices'); }
  }
  const ev = rc.logs.map(l => { try { return game.interface.parseLog(l); } catch { return null; } }).find(e => e?.name === 'RunStarted');
  const id = ev.args.runId;
  step(`started run ${id}`);
  // balances are read at exact blocks: just before the start, and at the settlement
  const before = p === poor ? 0n : await balanceAt(p.wallet, rc.blockNumber - 1);
  if (scenario === 'pack') p.hasPack = false;
  log(`solo w${wave} ${p.name.padEnd(18)} run ${id} ${MARKETS[market].id} ${long ? 'long ' : 'short'} ${Number(stake) / 1e6} ${scenario}`);
  if (scenario === 'expire') { expired.add(id); await view(() => game.getRun(id), x => Number(x.status) === 2, 80); }
  else {
    await sleep((8 + Math.random() * 40) * 1000);
    const py2 = await pythFor(market);
    await p.send(game, 'cashOut', [id, py2 ? py2.updateData : []], py2 ? py2.fee : 0n).catch(e => { if (!/WrongRunStatus/.test(errText(e))) throw e; });
  }
  // public RPC nodes lag: read the run until it shows as settled with its handles
  step('exit sent');
  const r = await view(() => game.getRun(id), x => Number(x.status) === 2, 30);
  step('settled seen');
  const handles = await view(() => game.runHandles(id), h => !/^0x0+$/.test(h[3]) && !/^0x0+$/.test(h[2]), 30);
  const sb = await settledBlock(id, rc.blockNumber);       // recompute at the settlement block (lagging nodes)
  const [mL, mS] = await view(() => ladder.multipliers(market, r.entryIndex, r.exitIndex, r.startAt, 6, { blockTag: sb }));
  const [, paidH, valueH, multH, capH, , interestH] = handles;  // the same read that showed them set
  step('decrypting');
  const [paid, value, mult, cap, charged] = await userDecrypt(p.wallet, [paidH, valueH, multH, capH, interestH].map(handle => ({ handle, contract: ADDR.Siroclimb })));
  let expMult = long ? r.multLong : r.multShort;
  if (scenario === 'pack') { const [cl, cs] = await ladder.multipliers(market, r.entryIndex, r.exitIndex, r.startAt, Number(cap)); expMult = long ? cl : cs; }
  const expPaid = scenario === 'unfunded' ? 0n : expectedPaid(stake);
  const gross = (expPaid * expMult) / SCALE;
  const owed = (expPaid * APR_BPS * borrowedTenthSeconds(r.endAt - r.startAt)) / INTEREST_DIVISOR;
  const expInterest = owed < gross ? owed : gross;
  const expValue = gross - expInterest;
  const after = p === poor ? 0n : await balanceAt(p.wallet, sb);
  const checks = {
    pathMatchesLadder: mL === r.multLong && mS === r.multShort,
    sideMultiplier: mult === expMult,
    paid: paid === expPaid,
    interest: charged === expInterest,
    payout: value === expValue,
    balance: p === poor ? after === 0n : after - before === expValue - expPaid,
  };
  log(`solo w${wave} ${p.name.padEnd(18)} run ${id} ${Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL'} mult ${Number(mult) / 1e6} payout ${Number(value) / 1e6}`);
  pass('solo', Object.values(checks).every(Boolean), { wave, player: p.name, run: Number(id), market: MARKETS[market].id, side: long ? 'long' : 'short', stake: Number(stake) / 1e6, scenario,
    mult: Number(mult) / 1e6, multLong: Number(r.multLong) / 1e6, multShort: Number(r.multShort) / 1e6, payout: Number(value) / 1e6, interest: Number(charged) / 1e6, seconds: Number(r.endAt - r.startAt), checks });
  if (scenario !== 'unfunded' && Math.random() < 0.15) {        // publish: reveal the multiplier with a KMS proof
    await p.send(game, 'publishRun', [id]);
    const { values, proof } = await publicDecrypt([multH]);
    await p.send(game, 'recordRun', [id, values[0], proof]);
    pass('solo', values[0] === mult, { wave, player: p.name, run: Number(id), scenario: 'publish', mult: Number(values[0]) / 1e6 });
  }
}

// ── main
log(`battery: ${N} players, ${WAVES} solo waves, game ${ADDR.Siroclimb}`);
const eth0 = await deployer.eth();
await Promise.all(players.map(p => setup(p).catch(e => log('setup', p.name, errText(e)))));
await setup(poor, { fund: false }).catch(e => log('setup poor', errText(e)));
for (const k of [keeper, settler]) if ((await k.eth()) < 0.05) await deployer.sendEth(k.address, 0.1).catch(() => {});
log('setup done');
keeperLoop();
settlerLoop();
// a few players draw an encrypted leverage pack first
const guard0 = (pr, ms) => Promise.race([pr, sleep(ms)]);
await guard0(Promise.all(players.slice(0, Math.ceil(N / 3)).map(async p => {
  try { await p.send(game, 'openPack'); p.hasPack = true; } catch (e) { p.hasPack = await game.hasPack(p.address).catch(() => false); }
})), 4 * 60_000);
log('packs', players.filter(p => p.hasPack === true).length);
for (let w = 1; w <= WAVES; w++) {
  await guard0(Promise.all(players.map(p => topUp(p).catch(() => {}))), 4 * 60_000);
  log(`wave ${w}: start`);
  const runners = w === 1 ? [...players, poor] : players;
  // watchdog: a run that hangs (a dropped request somewhere) fails after 8 minutes instead of blocking the wave
  const guard = (pr, ms, what) => Promise.race([pr, new Promise((_, rej) => setTimeout(() => rej(new Error(`watchdog: ${what} took over ${ms / 60000} min`)), ms))]);
  const res = await Promise.allSettled(runners.map((p, i) => guard(soloRun(p, w, i * 2000), 25 * 60_000, 'solo run')));
  res.forEach((r, i) => { if (r.status === 'rejected') { log('solo error', runners[i].name, errText(r.reason)); pass('solo', false, { wave: w, player: runners[i].name, error: errText(r.reason) }); } });
  log(`wave ${w}: ${results.solo.filter(x => x.wave === w && x.ok).length} / ${results.solo.filter(x => x.wave === w).length} pass`);
}
keeping = false;
results.finished = new Date().toISOString();
results.summary = {
  solo: `${results.solo.filter(x => x.ok).length} / ${results.solo.length}`,
  deployerEthSpent: +(eth0 - (await deployer.eth())).toFixed(4),
};
mkdirSync('battery-results', { recursive: true });
const file = `battery-results/sepolia-${results.started.replace(/[:.]/g, '-')}.json`;
writeFileSync(file, JSON.stringify(results, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
log('summary', JSON.stringify(results.summary), '->', file);
process.exit(0);

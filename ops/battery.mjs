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
//          the player's decrypted multiplier is the one of its side; the decrypted balance moved
//          by exactly paid x mult - paid.
//  rounds  rounds filled by up to 24 players, random sides and exits; close, KMS reveal,
//          finalize. Checks: decrypted standings match each player's side, ranks and prizes
//          (50/30/20, ties share) match a local recomputation, balances moved by prize - entry.
//
// usage: node battery.mjs [players=16] [soloWaves=2] [rounds=2]
import { mkdirSync, writeFileSync } from 'node:fs';
import { Contract } from 'ethers';
import { ADDR, MARKETS, SCALE, Sender, USDC, balanceAt, balanceOf, settledBlock, view, batteryWallet, encryptRun, errText, faucet, fallbackFor, game, handle, key, ladder, openMarkets, publicDecrypt, pushIfStale, pythFor, sleep, token, userDecrypt } from './lib.mjs';

const N = Number(process.argv[2] || 16), WAVES = Number(process.argv[3] || 2), ROUNDS = Number(process.argv[4] || 2);
const OFFSET = Number(process.env.OFFSET || 1);         // index 0 is the browser e2e player
const t0 = Date.now(), T = () => `${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s`;
const log = (...a) => console.log(T(), ...a);
const results = { started: new Date().toISOString(), game: ADDR.Siroclimb, players: N, solo: [], rounds: [], findings: [], gas: {} };
const pass = (kind, ok, detail) => { (kind === 'round' ? results.rounds : results.solo).push({ ok, ...detail }); if (!ok) log('FAIL', kind, JSON.stringify(detail, (k, v) => (typeof v === 'bigint' ? v.toString() : v))); };

const deployer = new Sender(key('siroclimb-deployer.key'), 'deployer');
const keeper = new Sender(batteryWallet(900), 'keeper');
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

// ── keeper loop: checkpoints for markets in use, settles expired runs, closes and finalizes rounds
const inUse = new Set(), expired = new Set();
let keeping = true;
async function keeperLoop() {
  while (keeping) {
    try { await keeperTick(); } catch (e) { log('keeper tick', errText(e)); }   // a lagging read must never stop the keeper
    await sleep(2500);
  }
}
async function keeperTick() {
  {
    for (const m of inUse) await pushIfStale(keeper, m, 11).catch(e => log('keeper price', MARKETS[m].id, errText(e)));
    for (const id of [...expired]) {
      const r = await game.getRun(id);
      if (Number(r.status) === 2) { expired.delete(id); continue; }
      if (Date.now() / 1000 > Number(r.startAt) + 62) await keeper.send(game, 'settleRun', [id]).then(() => expired.delete(id)).catch(e => { if (!/WrongRunStatus/.test(errText(e))) log('keeper settle', id, errText(e)); });
    }
  }
}

// ── solo
function expectedPaid(stake) { return stake > 100n * USDC ? 100n * USDC : stake; }
async function soloRun(p, wave, delay = 0) {
  await sleep(delay);                                    // staggered starts: the relayer is shared
  let open = await openMarkets();
  if (!open.length) open = [3];                          // gold trades around the clock
  const market = open[Math.floor(Math.random() * open.length)];
  const long = Math.random() < 0.5;
  const scenario = p === poor ? 'unfunded' : Math.random() < 0.12 ? 'clamp' : Math.random() < 0.15 && p.hasPack ? 'pack' : Math.random() < 0.35 ? 'expire' : 'cash';
  const stake = scenario === 'clamp' ? 150n * USDC : BigInt(5 + Math.floor(Math.random() * 60)) * USDC;
  inUse.add(market);
  const enc = await encryptRun(p.address, long, stake);
  const py = await pythFor(market);
  const fb = py ? 0n : await fallbackFor(market);
  const rc = await p.send(game, 'startRun', [market, enc.handles[0], enc.handles[1], enc.proof, scenario === 'pack', py ? py.updateData : [], fb], py ? py.fee : 0n);
  const ev = rc.logs.map(l => { try { return game.interface.parseLog(l); } catch { return null; } }).find(e => e?.name === 'RunStarted');
  const id = ev.args.runId;
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
  const r = await view(() => game.getRun(id), x => Number(x.status) === 2, 30);
  await view(() => game.runHandles(id), h => !/^0x0+$/.test(h[3]), 30);
  const sb = await settledBlock(id, rc.blockNumber);       // recompute at the settlement block (lagging nodes)
  const [mL, mS] = await view(() => ladder.multipliers(market, r.entryIndex, r.exitIndex, r.startAt, 6, { blockTag: sb }));
  const [, paidH, valueH, multH, , capH] = await game.runHandles(id);
  const [paid, value, mult, cap] = await userDecrypt(p.wallet, [{ handle: paidH, contract: ADDR.Siroclimb }, { handle: valueH, contract: ADDR.Siroclimb }, { handle: multH, contract: ADDR.Siroclimb }, { handle: capH, contract: ADDR.Siroclimb }]);
  let expMult = long ? r.multLong : r.multShort;
  if (scenario === 'pack') { const [cl, cs] = await ladder.multipliers(market, r.entryIndex, r.exitIndex, r.startAt, Number(cap)); expMult = long ? cl : cs; }
  const expPaid = scenario === 'unfunded' ? 0n : expectedPaid(stake);
  const expValue = (expPaid * expMult) / SCALE;
  const after = p === poor ? 0n : await balanceAt(p.wallet, sb);
  const checks = {
    pathMatchesLadder: mL === r.multLong && mS === r.multShort,
    sideMultiplier: mult === expMult,
    paid: paid === expPaid,
    payout: value === expValue,
    balance: p === poor ? after === 0n : after - before === expValue - expPaid,
  };
  log(`solo w${wave} ${p.name.padEnd(18)} run ${id} ${Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL'} mult ${Number(mult) / 1e6} payout ${Number(value) / 1e6}`);
  pass('solo', Object.values(checks).every(Boolean), { wave, player: p.name, run: Number(id), market: MARKETS[market].id, side: long ? 'long' : 'short', stake: Number(stake) / 1e6, scenario,
    mult: Number(mult) / 1e6, multLong: Number(r.multLong) / 1e6, multShort: Number(r.multShort) / 1e6, payout: Number(value) / 1e6, seconds: Number(r.endAt - r.startAt), checks });
  if (scenario !== 'unfunded' && Math.random() < 0.15) {        // publish: reveal the multiplier with a KMS proof
    await p.send(game, 'publishRun', [id]);
    const { values, proof } = await publicDecrypt([multH]);
    await p.send(game, 'recordRun', [id, values[0], proof]);
    pass('solo', values[0] === mult, { wave, player: p.name, run: Number(id), scenario: 'publish', mult: Number(values[0]) / 1e6 });
  }
}

// ── rounds
async function roundGame(k) {
  const live = await openMarkets();
  const roster = players.slice(0, Math.min(players.length, 24));
  const entrants = k === 1 ? [poor, ...roster.slice(0, 23)] : roster;
  const sides = new Map(), joinBlock = new Map(), encs = new Map();
  // every player encrypts its side first (at its own pace, like a player choosing before clicking),
  // so 17 relayer encryptions at once do not eat the 60 s join window
  for (const p of entrants) { const long = Math.random() < 0.5; sides.set(p, long); encs.set(p, await encryptRun(p.address, long)); }
  // wait for a joinable state: nothing open, or an open round with time left
  const n = Number(await game.roundCount());
  let id = n;
  if (n) { const [r] = await game.getRound(n - 1); if (Date.now() / 1000 < Number(r.startsAt) - 20) id = n - 1; else if (Date.now() / 1000 < Number(r.startsAt)) { await sleep((Number(r.startsAt) - Date.now() / 1000 + 1) * 1000); } }
  const join = async p => { const enc = encs.get(p); const rc = await p.send(game, 'joinRound', [id, enc.handles[0], enc.proof]); joinBlock.set(p, rc.blockNumber); };
  await join(entrants[0]);
  const [r0] = await view(() => game.getRound(id));
  inUse.add(Number(r0.market));
  log(`round ${id} on ${MARKETS[Number(r0.market)].id} (${live.length} markets open), ${entrants.length} players`);
  const joined = await Promise.allSettled(entrants.slice(1).map(join));
  joined.forEach((j, i) => { if (j.status === 'rejected') log('join failed', entrants[i + 1].name, errText(j.reason)); });
  const [r1, ids] = await view(() => game.getRound(id), ([, x]) => x.length >= entrants.length - joined.filter(j => j.status === 'rejected').length);
  const startsAt = Number(r1.startsAt), endsAt = Number(r1.endsAt);
  const runOf = new Map();
  for (const rid of ids) { const x = await view(() => game.getRun(rid)); runOf.set(x.player.toLowerCase(), rid); }
  // exits: 40 % cash out during the minute
  await sleep(Math.max(0, startsAt * 1000 - Date.now()) + 2000);
  await Promise.all(entrants.filter(p => runOf.has(p.address.toLowerCase())).map(async p => {
    if (Math.random() > 0.4) return;
    await sleep(Math.random() * 45_000);
    const py = await pythFor(Number(r0.market));
    await p.send(game, 'cashOut', [runOf.get(p.address.toLowerCase()), py ? py.updateData : []], py ? py.fee : 0n).catch(e => log('round cash out', p.name, errText(e)));
  }));
  await sleep(Math.max(0, endsAt * 1000 - Date.now()) + 4000);
  await keeper.send(game, 'closeRound', [id]).catch(e => { if (!/WrongRoundStatus/.test(errText(e))) throw e; });
  const handles = await view(() => game.roundScoreHandles(id), hs => hs.length && hs.every(h => !/^0x0+$/.test(h)), 30);
  const { values: scores, proof } = await publicDecrypt([...handles]);
  await keeper.send(game, 'finalizeRound', [id, scores, proof]).catch(e => { if (!/WrongRoundStatus/.test(errText(e))) throw e; });
  const finalBlock = await view(async () => (await game.queryFilter(game.filters.RoundFinalized(id), Math.min(...joinBlock.values()))).at(-1)?.blockNumber, b => b != null, 30);
  // local recomputation of ranks and prizes
  const [rf] = await view(() => game.getRound(id), ([x]) => Number(x.status) === 3, 30);
  const order = scores.map((s, i) => i).sort((a, b) => (scores[b] > scores[a] ? 1 : scores[b] < scores[a] ? -1 : a - b));
  const funded = scores.filter(s => s !== 0n).length, pot = BigInt(funded) * 10n * USDC, places = Math.min(3, funded);
  const bps = [5000n, 3000n, 2000n], shareSum = bps.slice(0, places).reduce((a, b) => a + b, 0n);
  const prize = new Map();
  for (let pos = 0; pos < order.length;) {
    let end = pos + 1; while (end < order.length && scores[order[end]] === scores[order[pos]]) end++;
    let pz = 0n;
    if (scores[order[pos]] !== 0n && pos < places) { let b = 0n; for (let k2 = pos; k2 < end && k2 < places; k2++) b += bps[k2]; pz = (pot * b) / shareSum / BigInt(end - pos); }
    for (let k2 = pos; k2 < end; k2++) prize.set(order[k2], scores[order[k2]] === 0n ? 0n : pz);
    pos = end;
  }
  const checks = [];
  for (let i = 0; i < ids.length; i++) {
    const run = await view(() => game.getRun(ids[i]), x => Number(x.status) === 2);
    const p = entrants.find(x => x.address.toLowerCase() === run.player.toLowerCase());
    const long = sides.get(p);
    const expScore = p === poor ? 0n : (long ? run.multLong : run.multShort) + 1n;
    // exact blocks: just before the join, and the finalize block (prize paid)
    const delta = p === poor ? 0n : (await balanceAt(p.wallet, finalBlock)) - (await balanceAt(p.wallet, joinBlock.get(p) - 1));
    const ok = scores[i] === expScore && (p === poor || delta === prize.get(i) - 10n * USDC);
    checks.push({ player: p.name, side: long ? 'long' : 'short', score: Number(scores[i]), pnlPct: scores[i] ? (Number(scores[i]) - 1 - 1e6) / 1e4 : null, prize: Number(prize.get(i)) / 1e6, ok });
  }
  const ok = checks.every(c => c.ok) && Number(rf.status) === 3 && rf.pot === pot;
  pass('round', ok, { round: id, market: MARKETS[Number(r0.market)].id, players: ids.length, funded, pot: Number(pot) / 1e6, standings: checks.sort((a, b) => b.score - a.score) });
  log(`round ${id} ${ok ? 'PASS' : 'FAIL'}: ${ids.length} players, pot ${Number(pot) / 1e6}, top ${checks.slice(0, 3).map(c => `${c.player} ${c.pnlPct}% +${c.prize}`).join(', ')}`);
}

// ── main
log(`battery: ${N} players, ${WAVES} solo waves, ${ROUNDS} rounds, game ${ADDR.Siroclimb}`);
const eth0 = await deployer.eth();
await Promise.all(players.map(p => setup(p).catch(e => log('setup', p.name, errText(e)))));
await setup(poor, { fund: false }).catch(e => log('setup poor', errText(e)));
await deployer.sendEth(keeper.address, 0.05).catch(() => {});
log('setup done');
keeperLoop();
// a few players draw an encrypted leverage pack first
await Promise.all(players.slice(0, Math.ceil(N / 3)).map(async p => { await p.send(game, 'openPack').then(() => { p.hasPack = true; }).catch(e => { if (/PackCooldown/.test(errText(e))) p.hasPack = (async () => game.hasPack(p.address))(); }); if (p.hasPack instanceof Promise) p.hasPack = await p.hasPack; }));
for (let w = 1; w <= WAVES; w++) {
  await Promise.all(players.map(p => topUp(p).catch(() => {})));
  const runners = w === 1 ? [...players, poor] : players;
  // watchdog: a run that hangs (a dropped request somewhere) fails after 8 minutes instead of blocking the wave
  const guard = (pr, ms, what) => Promise.race([pr, new Promise((_, rej) => setTimeout(() => rej(new Error(`watchdog: ${what} took over ${ms / 60000} min`)), ms))]);
  const res = await Promise.allSettled(runners.map((p, i) => guard(soloRun(p, w, i * 2000), 8 * 60_000, 'solo run')));
  res.forEach((r, i) => { if (r.status === 'rejected') { log('solo error', runners[i].name, errText(r.reason)); pass('solo', false, { wave: w, player: runners[i].name, error: errText(r.reason) }); } });
  log(`wave ${w}: ${results.solo.filter(x => x.wave === w && x.ok).length} / ${results.solo.filter(x => x.wave === w).length} pass`);
}
for (let k = 1; k <= ROUNDS; k++) {
  await Promise.all(players.map(p => topUp(p).catch(() => {})));
  await roundGame(k).catch(e => { log('round error', errText(e)); pass('round', false, { error: errText(e) }); });
}
keeping = false;
results.finished = new Date().toISOString();
results.summary = {
  solo: `${results.solo.filter(x => x.ok).length} / ${results.solo.length}`,
  rounds: `${results.rounds.filter(x => x.ok).length} / ${results.rounds.length}`,
  deployerEthSpent: +(eth0 - (await deployer.eth())).toFixed(4),
};
mkdirSync('battery-results', { recursive: true });
const file = `battery-results/sepolia-${results.started.replace(/[:.]/g, '-')}.json`;
writeFileSync(file, JSON.stringify(results, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
log('summary', JSON.stringify(results.summary), '->', file);
process.exit(0);

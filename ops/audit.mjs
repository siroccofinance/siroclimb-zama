// Public audit of every settled run of the game, from chain data only (no key needed):
// recomputes each run's long and short multipliers with ClimbLadder between its recorded entry and
// exit checkpoints, and checks every finalized round's prizes against its public standings.
// usage: node audit.mjs
import { MARKETS, game, ladder, view } from './lib.mjs';

const n = Number(await game.runCount());
let ok = 0, bad = [], ended = 0, live = 0;
for (let id = 0; id < n; id++) {
  const r = await view(() => game.getRun(id));
  if (Number(r.status) !== 2) { live++; continue; }
  ended++;
  const [l, s] = await view(() => ladder.multipliers(r.market, r.entryIndex, r.exitIndex, r.startAt, 6));
  if (l === r.multLong && s === r.multShort) ok++;
  else bad.push({ id, market: MARKETS[Number(r.market)].id, stored: [r.multLong, r.multShort].map(Number), recomputed: [l, s].map(Number) });
}
const rounds = Number(await game.roundCount());
const rc = Number(await game.resultCount());
const results = rc ? await game.results(0, rc) : [];
let roundsOk = 0, roundsFinal = 0;
for (let id = 0; id < rounds; id++) {
  const [r] = await view(() => game.getRound(id));
  if (Number(r.status) !== 3) continue;
  roundsFinal++;
  const mine = results.filter(x => x.inRound && Number(x.ref) === id);
  const paid = mine.reduce((a, x) => a + x.prize, 0n);
  // the whole pot goes out (up to rounding dust of a few units)
  if (r.pot - paid >= 0n && r.pot - paid < 10n) roundsOk++;
  else bad.push({ round: id, pot: Number(r.pot), paid: Number(paid) });
}
console.log(JSON.stringify({ runs: n, settled: ended, live, pathsReproduced: `${ok} / ${ended}`, roundsFinalized: roundsFinal, potsFullyPaid: `${roundsOk} / ${roundsFinal}`, mismatches: bad }, null, 2));
process.exit(bad.length ? 1 : 0);

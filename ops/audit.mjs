// Public audit of every settled run of the game, from chain data only (no key needed):
// recomputes each run's long and short multipliers with ClimbLadder between its recorded entry and
// exit checkpoints.
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
console.log(JSON.stringify({ runs: n, settled: ended, live, pathsReproduced: `${ok} / ${ended}`, mismatches: bad }, null, 2));
process.exit(bad.length ? 1 : 0);

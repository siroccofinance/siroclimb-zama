// Optional ops keeper. Nothing needs it: every duty below is permissionless and the players'
// browsers already do it (js/chain/autopilot.js). Running it just makes settlements snappier when
// few players are online.
//  - price checkpoints every ~12 s for open markets with a live run;
//  - settles runs past their 60th second.
// Key: ~/.config/siroclimb/sepolia/keeper.key (fund it with a little Sepolia ETH). Do not run it
// at the same time as the battery, which pushes prices with the same key.
import { MARKETS, Sender, errText, game, key, pushIfStale, sleep } from './lib.mjs';

const k = new Sender(key('keeper.key'), 'keeper');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const IGNORE = /WrongRunStatus|RunNotOver|TooSoon|PythIsFresh/;
log('keeper', k.address, (await k.eth()).toFixed(4), 'ETH');

let scanFrom = Math.max(0, Number(await game.runCount()) - 50);
const live = new Map();   // runId -> { market, startAt }
for (;;) {
  try {
    const now = Date.now() / 1000;
    const n = Number(await game.runCount());
    for (let id = scanFrom; id < n; id++) { const r = await game.getRun(id); if (Number(r.status) === 1) live.set(id, { market: Number(r.market), startAt: Number(r.startAt) }); }
    scanFrom = n;
    const markets = new Set();
    for (const [id, r] of live) {
      if (now < r.startAt - 15) continue;
      if (now > r.startAt + 62) {
        await k.send(game, 'settleRun', [id, 0]).then(() => log('settled run', id)).catch(e => { if (!IGNORE.test(errText(e))) log('settle', id, errText(e)); });
        live.delete(id); continue;
      }
      markets.add(r.market);
    }
    for (const m of markets) await pushIfStale(k, m, 11).then(s => s && log('checkpoint', MARKETS[m].id, s)).catch(e => { if (!IGNORE.test(errText(e))) log('price', MARKETS[m].id, errText(e)); });
  } catch (e) { log('tick', errText(e)); }
  await sleep(3000);
}

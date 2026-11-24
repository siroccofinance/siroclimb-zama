// Optional ops keeper. Nothing needs it: every duty below is permissionless and the players'
// browsers already do it (js/chain/autopilot.js). Running it just makes rounds and settlements
// snappier when few players are online.
//  - price checkpoints every ~12 s for open markets with a live run or round;
//  - settles solo runs past their 60th second;
//  - closes rounds at the bell, KMS-decrypts the standings and finalizes with the proof.
// Key: ~/.config/siroclimb/sepolia/keeper.key (fund it with a little Sepolia ETH). Do not run it
// at the same time as the battery, which pushes prices with the same key.
import { MARKETS, Sender, errText, game, key, publicDecrypt, pushIfStale, sleep } from './lib.mjs';

const k = new Sender(key('keeper.key'), 'keeper');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const IGNORE = /WrongRoundStatus|WrongRunStatus|RunNotOver|RoundNotOver|TooSoon|PythIsFresh/;
log('keeper', k.address, (await k.eth()).toFixed(4), 'ETH');

let scanFrom = Math.max(0, Number(await game.runCount()) - 50);
const live = new Map();   // runId -> { market, startAt, inRound }
for (;;) {
  try {
    const now = Date.now() / 1000;
    const n = Number(await game.runCount());
    for (let id = scanFrom; id < n; id++) { const r = await game.getRun(id); if (Number(r.status) === 1) live.set(id, { market: Number(r.market), startAt: Number(r.startAt), inRound: r.inRound }); }
    scanFrom = n;
    const markets = new Set();
    for (const [id, r] of live) {
      if (now < r.startAt - 15) continue;
      if (!r.inRound && now > r.startAt + 62) {
        await k.send(game, 'settleRun', [id]).then(() => log('settled run', id)).catch(e => { if (!IGNORE.test(errText(e))) log('settle', id, errText(e)); });
        live.delete(id); continue;
      }
      if (now > r.startAt + 61) { live.delete(id); continue; }
      markets.add(r.market);
    }
    for (const m of markets) await pushIfStale(k, m, 11).then(s => s && log('checkpoint', MARKETS[m].id, s)).catch(e => { if (!IGNORE.test(errText(e))) log('price', MARKETS[m].id, errText(e)); });
    const rc = Number(await game.roundCount());
    for (let id = Math.max(0, rc - 3); id < rc; id++) {
      const [r] = await game.getRound(id);
      if (Number(r.status) === 1 && now > Number(r.endsAt) + 2) {
        const [, ids] = await game.getRound(id);
        for (const rid of ids) if (Number((await game.getRun(rid)).status) === 1) await k.send(game, 'exitAtBell', [rid]).catch(e => { if (!IGNORE.test(errText(e))) log('exit', rid, errText(e)); });
        await k.send(game, 'closeRound', [id]).then(() => log('closed round', id)).catch(e => { if (!IGNORE.test(errText(e))) log('close', id, errText(e)); });
      } else if (Number(r.status) === 2) {
        const { values, proof } = await publicDecrypt([...(await game.roundScoreHandles(id))]);
        await k.send(game, 'finalizeRound', [id, values, proof]).then(() => log('finalized round', id)).catch(e => { if (!IGNORE.test(errText(e))) log('finalize', id, errText(e)); });
      } else if (Number(r.status) === 3) {
        const [, ids] = await game.getRound(id);
        for (const rid of ids) if ((await game.prizeOf(rid)) > 0n && !(await game.claimed(rid))) await k.send(game, 'claim', [rid]).then(() => log('claimed prize of run', rid)).catch(() => {});
      }
    }
  } catch (e) { log('tick', errText(e)); }
  await sleep(3000);
}

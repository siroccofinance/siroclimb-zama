// Finishes everything left open on the game (anyone may do it, every call is permissionless):
// settles solo runs past their 60th second, closes rounds past their bell, finalizes closed rounds
// with the KMS proof. Uses the battery keeper key. usage: node sweep.mjs
import { Sender, batteryWallet, errText, game, publicDecrypt, view } from './lib.mjs';

const k = new Sender(batteryWallet(900), 'sweeper');
const now = () => Date.now() / 1000;
const n = Number(await game.runCount());
let settled = 0, closed = 0, finalized = 0, live = 0;
for (let id = 0; id < n; id++) {
  const r = await view(() => game.getRun(id));
  if (Number(r.status) !== 1) continue;
  if (r.inRound) continue;
  if (now() > Number(r.startAt) + 61) { await k.send(game, 'settleRun', [id]).then(() => settled++).catch(e => console.log('settle', id, errText(e))); }
  else live++;
}
const rounds = Number(await game.roundCount());
for (let id = 0; id < rounds; id++) {
  let [r] = await view(() => game.getRound(id));
  if (Number(r.status) === 1 && now() > Number(r.endsAt) + 1) {
    const [, ids] = await view(() => game.getRound(id));
    for (const rid of ids) if (Number((await view(() => game.getRun(rid))).status) === 1) await k.send(game, 'exitAtBell', [rid]).catch(e => console.log('exit', rid, errText(e)));
    await k.send(game, 'closeRound', [id]).then(() => closed++).catch(e => console.log('close', id, errText(e))); [r] = await view(() => game.getRound(id), ([x]) => Number(x.status) !== 1); }
  if (Number(r.status) === 2) {
    const hs = await view(() => game.roundScoreHandles(id), h => h.every(x => !/^0x0+$/.test(x)));
    const { values, proof } = await publicDecrypt([...hs]);
    await k.send(game, 'finalizeRound', [id, values, proof]).then(() => finalized++).catch(e => console.log('finalize', id, errText(e)));
  }
}
// pull payments left: prizes of finalized rounds, entries of refunded rounds
let claims = 0;
for (let id = 0; id < rounds; id++) {
  const [r, ids] = await view(() => game.getRound(id));
  const st = Number(r.status);
  if (st !== 3 && st !== 4) continue;
  for (const rid of ids) {
    if (await game.claimed(rid)) continue;
    if (st === 3 && (await game.prizeOf(rid)) === 0n) continue;
    await k.send(game, 'claim', [rid]).then(() => claims++).catch(e => console.log('claim', rid, errText(e)));
  }
}
console.log(JSON.stringify({ runs: n, settled, stillLive: live, rounds, closed, finalized, claims }));
process.exit(0);

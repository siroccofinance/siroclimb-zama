// Finishes everything left open on the game (anyone may do it, every call is permissionless):
// settles runs past their 60th second. Uses the Siroclimb keeper key. usage: node sweep.mjs
import { Sender, errText, game, key, view } from './lib.mjs';

const k = new Sender(key('keeper.key'), 'sweeper');
const now = () => Date.now() / 1000;
const n = Number(await game.runCount());
let settled = 0, live = 0;
for (let id = 0; id < n; id++) {
  const r = await view(() => game.getRun(id));
  if (Number(r.status) !== 1) continue;
  if (now() > Number(r.startAt) + 61) { await k.send(game, 'settleRun', [id]).then(() => settled++).catch(e => console.log('settle', id, errText(e))); }
  else live++;
}
console.log(JSON.stringify({ runs: n, settled, stillLive: live }));
process.exit(0);

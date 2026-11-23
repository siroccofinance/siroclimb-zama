// In-browser practice bots: real players with their own keys (derived from the session key, so
// they come back on every visit), funded once with a little gas from the session key and test
// cUSDC from the faucet. When the player is in a round that few people joined, up to three bots
// join it with their own encrypted sides (encrypted through the relayer like anyone), then each
// cashes out at its own moment or rides to the bell. Nobody, the player included, sees their sides.
import { MARKETS, RUN_SECONDS } from './config.js';
import { encryptRun } from './fhe.js';
import * as W from './wallet.js';

const BOTS = 3, MIN_PLAYERS = 4, BOT_GAS = 0.004;
const HANDLES = ['saffron.dune', 'harmattan', 'mistral_77', 'khamsin.eth', 'oasis_trader', 'leveche', 'zephyr42', 'simoom', 'tramontane', 'chinook.eth', 'bora_bull', 'atlas_dunes'];
let pool = null;
export const enabled = () => W.store.get('bots', true);
export const setEnabled = v => W.store.set('bots', !!v);

function bots() {
  const s = W.currentSession(); if (!s) return [];
  if (!pool || pool.parent !== s.address) {
    pool = Array.from({ length: BOTS }, (_, i) => Object.assign(W.derived(s, `bot:${i}`), { i }));
    pool.parent = s.address;
    const base = parseInt(s.address.slice(2, 8), 16);
    pool.forEach((b, i) => { b.handle = HANDLES[(base + i * 5) % HANDLES.length]; });
  }
  return pool;
}

/** One-time setup of a bot: gas, test cUSDC, the game as operator, a name. */
async function prepare(b) {
  const s = W.currentSession();
  if ((await b.eth()) < BOT_GAS / 2) await s.sendEth(b.address, BOT_GAS);
  if (Number(await W.faucet.lastClaim(b.address)) === 0) await b.send(W.faucet, 'claim', [], 0n, 'bot faucet');
  if (!(await W.token.isOperator(b.address, W.game.target))) await b.send(W.token, 'setOperator', [W.game.target, Math.floor(Date.now() / 1000) + 90 * 86400], 0n, 'bot operator');
  if (!(await W.game.nameOf(b.address))) await b.send(W.game, 'setName', [b.handle], 0n, 'bot name');
}

const filling = new Set();
/** Fills round `roundId` with practice bots if it has fewer than MIN_PLAYERS when its join window closes. */
export function fill(roundId) {
  if (!enabled() || filling.has(roundId)) return;
  filling.add(roundId);
  (async () => {
    const [r] = await W.game.getRound(roundId);
    const startsAt = Number(r.startsAt) * 1000, endsAt = Number(r.endsAt) * 1000;
    // give humans most of the join window, keep ~25 s for the bots' encryption and blocks
    await W.sleep(Math.max(0, startsAt - 27_000 - Date.now()));
    const [, ids] = await W.game.getRound(roundId);
    const need = Math.max(0, Math.min(BOTS, MIN_PLAYERS - ids.length));
    await Promise.all(bots().slice(0, need).map(b => playRound(b, roundId, startsAt, endsAt).catch(e => console.warn('bot', b.handle, W.errText(e)))));
  })().catch(e => console.warn('bots', W.errText(e)));
}

async function playRound(b, roundId, startsAt, endsAt) {
  await prepare(b);
  if (Date.now() > startsAt - 4000) return;
  const long = Math.random() < 0.5;
  const enc = await encryptRun(b.address, long);
  const rc = await b.send(W.game, 'joinRound', [roundId, enc.handles[0], enc.proof], 0n, 'bot join');
  let runId = null;
  for (const l of rc.logs) { try { const e = W.game.interface.parseLog(l); if (e?.name === 'RoundJoined') runId = e.args.runId; } catch {} }
  if (runId == null) return;
  // strategy: 35 % ride to the bell, the rest cash out somewhere in the minute
  if (Math.random() < 0.35) return;
  const at = startsAt + (10 + Math.random() * (RUN_SECONDS - 18)) * 1000;
  await W.sleep(Math.max(0, at - Date.now()));
  if (Date.now() < endsAt - 3000) await b.send(W.game, 'cashOut', [runId, []], 0n, 'bot cash out').catch(() => {});
}

export const roster = () => bots().map(b => ({ address: b.address, name: b.handle }));
export const marketLabel = i => MARKETS[i].ticker;

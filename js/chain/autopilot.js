// Autopilot: every keeper duty is a permissionless call, so the player's browser does it with its
// session key, without wallet pop-ups. Nothing has to run on our side:
//  - price checkpoints for the market being played (Pyth when covered, bounded fallback else),
//    and for the market the lobby shows, so a start finds a fresh entry price;
//  - settles the player's solo runs at their 60th second;
//  - closes rounds at the bell (standings made publicly decryptable), then decrypts them through
//    the KMS and finalizes with the proof, which pays the pot. Any recent round left closed by
//    someone else is finalized too.
// An optional ops keeper (ops/) does the same; whoever is first wins, the others' calls revert
// harmlessly (WrongRoundStatus, WrongRunStatus, TooSoon) and are ignored.
import { MARKETS, RUN_SECONDS, indexOf } from './config.js';
import { publicDecrypt } from './fhe.js';
import { pushIfStale } from './prices.js';
import * as W from './wallet.js';

const TICK_MS = 3000;
const IGNORE = /WrongRoundStatus|WrongRunStatus|RoundNotOver|RunNotOver|TooSoon|PythIsFresh|not allowed|not ready|404|NoCheckpoint/i;
let timer = null, api = null, busy = false, watched = new Set();
let lastFocusPush = 0;

export function start(a) { api = a; if (!timer) { timer = setInterval(tick, TICK_MS); tick(); } }
export function stop() { clearInterval(timer); timer = null; }
export function kick() { setTimeout(tick, 50); }
export function watchRun(run) { watched.add(run.id); kick(); }

const say = t => api?.status(t ? { kind: 'keeper', text: t } : null);

async function duty(label, fn) {
  try { say(label); await fn(); }
  catch (e) { const t = W.errText(e); if (!IGNORE.test(t)) console.warn('autopilot', label, t); }
  finally { say(null); }
}

async function tick() {
  const s = W.currentKeeper();
  if (busy || !s || !api || !(await gasOk(s))) return;
  busy = true;
  try {
    const now = Date.now();
    // 1. the player's own runs: checkpoints while live, settlement at the 60th second
    for (const run of api.liveRuns()) {
      const m = indexOf(run.assetId);
      if (run.mode === 'solo') {
        if (now >= run.startedAt + RUN_SECONDS * 1000 + 1500 && !run.settling) {
          run.settling = true;
          await duty('Settling your run at the bell…', () => s.send(W.game, 'settleRun', [BigInt(run.id)], 0n, 'settleRun'));
          api.settleFromChain(run).catch(() => { run.settling = false; });
        } else if (run.status === 'live') await duty(null, () => pushIfStale(s, m, 11));
      } else if (now > run.startedAt - 15000 && now < run.startedAt + RUN_SECONDS * 1000) {
        await duty(null, () => pushIfStale(s, m, 11));
      }
    }
    // 2. rounds: checkpoints around the bell, close, KMS reveal and finalize
    const rc = api.roundData();
    if (rc.latest) {
      const L = rc.latest;
      if (L.ids.length && now > L.startsAt - 15000 && now < L.endsAt) await duty(null, () => pushIfStale(s, L.market, 11));
      for (let id = Math.max(0, rc.count - 3); id < rc.count; id++) await settleRound(s, id);
    }
    // 3. the lobby's market: keep a fresh checkpoint so starting is a single transaction
    const f = api.focused();
    if (f && now - lastFocusPush > 15000 && !api.liveRuns().length) {
      lastFocusPush = now;
      await duty(null, () => pushIfStale(s, indexOf(f), 20));
    }
  } finally { busy = false; }
}

// the keeper key is topped up from the session key (gas the wallet sent once)
let gasCheck = { at: 0, ok: false };
async function gasOk(k) {
  if (Date.now() - gasCheck.at < 30000) return gasCheck.ok;
  gasCheck.at = Date.now();
  let eth = await k.eth().catch(() => 0);
  if (eth < 0.002) {
    const s = W.currentSession();
    if (s && (await s.eth().catch(() => 0)) > 0.012) { await s.sendEth(k.address, 0.008).catch(() => {}); eth = await k.eth().catch(() => 0); }
  }
  gasCheck.ok = eth > 0.0005;
  return gasCheck.ok;
}

const finalizing = new Set();
async function settleRound(s, id) {
  const [r] = await W.game.getRound(id);
  const st = Number(r.status), now = Date.now() / 1000;
  if (st === 1 && now >= Number(r.endsAt) + 2) {
    await duty('Bell: closing the round, scores sealed until the reveal…', () => s.send(W.game, 'closeRound', [id], 0n, 'closeRound'));
  } else if (st === 2 && !finalizing.has(id)) {
    finalizing.add(id);
    await duty('KMS decrypting the standings…', async () => {
      const handles = await W.game.roundScoreHandles(id);
      const { values, proof } = await publicDecrypt([...handles]);
      await s.send(W.game, 'finalizeRound', [id, values, proof], 0n, 'finalizeRound');
    });
    finalizing.delete(id);
  }
}

export const marketName = i => MARKETS[i].name;

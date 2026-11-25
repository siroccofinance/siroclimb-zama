// Autopilot: every keeper duty is a permissionless call, so the player's browser does it with its
// session key, without wallet pop-ups. Nothing has to run on our side:
//  - price checkpoints for the market being played (Pyth when covered, bounded fallback else),
//    and for the market the lobby shows, so a start finds a fresh entry price;
//  - settles the player's runs at their 60th second;
//  - syncs the Sirocco Reserve's totals every 10 minutes: asks for the reveal, then the KMS decrypts
//    them and the browser records them with the proof (share price, TVL, interest earned).
// An optional ops keeper (ops/) does the same; whoever is first wins, the others' calls revert
// harmlessly (WrongRunStatus, TooSoon) and are ignored.
import { MARKETS, RUN_SECONDS, indexOf } from './config.js';
import { publicDecrypt } from './fhe.js';
import { pushIfStale as push } from './prices.js';

// checkpoints this browser is writing, per market: a cash out waits for them so its frozen value
// counts exactly the checkpoints the contract will count (F44)
const writing = new Map();
export const inflight = m => writing.get(m) || Promise.resolve();
async function pushIfStale(s, m, maxAge) {
  const p = push(s, m, maxAge);
  writing.set(m, p.catch(() => null));
  const src = await p.finally(() => { if (writing.get(m)) writing.delete(m); });
  if (src) api?.checkpointed?.(m);
  return src;
}
import * as W from './wallet.js';

const TICK_MS = 3000;
const IGNORE = /WrongRunStatus|RunNotOver|SyncTooSoon|NoSyncPending|TooSoon|PythIsFresh|not allowed|not ready|404|NoCheckpoint/i;
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
      if (now >= run.startedAt + RUN_SECONDS * 1000 + 1500 && !run.settling) {
        run.settling = true;
        await duty('Settling your run at the 60th second…', () => s.send(W.game, 'settleRun', [BigInt(run.cid)], 0n, 'settleRun'));
        api.settleFromChain(run).catch(() => { run.settling = false; });
      } else if (run.status === 'live') await duty(null, () => pushIfStale(s, m, 11));
    }
    // 2. the lobby's market: keep a fresh checkpoint so starting is a single transaction
    const f = api.focused();
    if (f && now - lastFocusPush > 15000 && !api.liveRuns().length) {
      lastFocusPush = now;
      await duty(null, () => pushIfStale(s, indexOf(f), 20));
    }
    // 3. the reserve's synced totals, when no run of this player is live
    if (!api.liveRuns().length) await reserveSync(s);
  } finally { busy = false; }
}

// the keeper key is topped up from the session key (gas the wallet sent once)
let gasCheck = { at: 0, ok: false };
async function gasOk(k) {
  if (Date.now() - gasCheck.at < 30000) return gasCheck.ok;
  gasCheck.at = Date.now();
  let eth = await k.eth().catch(() => 0);
  // checkpoints and settlements cost ~0.2M gas each (~0.00004 ETH at 0.2 gwei): a small float is plenty
  if (eth < 0.0004) {
    const s = W.currentSession();
    if (s && (await s.eth().catch(() => 0)) > 0.003) { await s.sendEth(k.address, 0.0012).catch(() => {}); eth = await k.eth().catch(() => 0); }
  }
  gasCheck.ok = eth > 0.0001;
  return gasCheck.ok;
}

// many browsers may run this: a random back-off keeps the race small, the losers revert harmlessly
let lastSyncCheck = 0;
async function reserveSync(s) {
  const now = Date.now() / 1000;
  if (now - lastSyncCheck < 30 + Math.random() * 30) return;
  lastSyncCheck = now;
  const [requested, synced, interval] = await Promise.all([W.reserve.syncRequestedAt(), W.reserve.syncedAt(), W.reserve.SYNC_INTERVAL()]);
  if (Number(requested) > 0) {
    await duty(null, async () => {                 // background upkeep: nothing for the player to watch
      const [a, sh, i] = await W.reserve.pendingSync();
      const { values, proof } = await publicDecrypt([a, sh, i]);
      await s.send(W.reserve, 'finalizeSync', [values[0], values[1], values[2], proof], 0n, 'finalizeSync');
      api?.reserveStats?.(true).catch(() => {});
    });
  } else if (now >= Number(synced) + Number(interval)) {
    await duty(null, () => s.send(W.reserve, 'requestSync', [], 0n, 'requestSync'));
  }
}

export const marketName = i => MARKETS[i].name;

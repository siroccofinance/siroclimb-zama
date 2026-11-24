// Siroclimb: the contract between the front end and the back end.
//
// The UI only talks to this module. By default it is the Sepolia version on the Zama Protocol
// (js/chain/api-chain.js: FHEVM contracts, Zama's confidential USDC, Pyth prices, the browser as
// keeper); `?mock` switches to the in-browser simulation (js/api-mock.js), same names and shapes.
//
// Units: amounts in confidential USDC (cUSDC), prices in USD, times in ms since epoch unless noted.
//
//   init()                                   → Promise<{ user: { name }, balance }>
//   connect() / account() / disconnect()     → wallet + session key: { address } | address | null
//   listAssets()                             → Asset[]            { id, name, ticker, kind: 'stock' | 'gold' | 'fx', token, open }
//   subscribePrice(assetId, cb)              → unsubscribe()      cb({ price, ts })
//   history(assetId, seconds)                → [{ price, ts }]    recent ticks, oldest first
//   rules                                    → { ladder: number[], stepEvery: s, duration: s, roundEntry, prizeSplit }
//   startRun({ mode, assetId, side, stake }) → Promise<Run>       mode 'solo' | 'round', side 'long' | 'short'
//   onRun(runId, cb)                         → unsubscribe()      cb(RunUpdate) on every price tick
//   cashOut(runId)                           → Promise<RunResult>
//   whenEnded(runId)                         → Promise<RunResult> the run is over on screen (pending: true until the chain settles it)
//   whenSettled(runId)                       → Promise<RunResult> chain-verified result (chain: true)
//   currentRound()                           → Round              { id, assetId, opensAt, startsAt, endsAt, status: 'open' | 'live', players, pot, entry, joined, virtual }
//   onRound(cb)                              → unsubscribe()      cb(Round) every second
//   joinRound({ side })                      → Promise<Round>
//   roundStandings(roundId)                  → Standing[]         { name, pnlPct (null while sealed), sealed, status, you }
//   whenRoundFinal(runId)                    → Promise<RunResult & { rank, of, prize, final }>
//   leaderboard(scope)                       → Promise<Standing[]> scope 'round' | 'today' | 'all'
//   balance()                                → number | null      null while the encrypted balance is not decrypted
//   onBalance(cb)                            → unsubscribe()
//   decryptBalance()                         → Promise<number>    user decryption (one wallet signature per day)
//   faucet()                                 → Promise<number>    mints and wraps 1,000 test cUSDC
//   openPack()                               → Promise<{ tier, maxLeverage, proof }>   leverage packs (encrypted PRNG), UI off for now
//   onStatus(cb)                             → unsubscribe()      cb({ kind: 'wallet' | 'fhe' | 'chain' | 'decrypt' | 'keeper' | 'error', text } | null)
//   shareCard(png, result)                   → Promise<string|null> optional hosted share page (null: the front attaches the picture)
//
// Run        { id, mode, assetId, side, stake, entryPrice, startedAt, ladder, stepEvery, duration }
// RunUpdate  { t (s since start), price, step, leverage, value, pnl, pnlPct, risk (0..1 of the stake lost), status }
// RunResult  { status: 'cashed' | 'busted' | 'expired', value, pnl, pnlPct, maxLeverage, duration (s), entryPrice, exitPrice, rank?, prize?, pending?, chain? }

const MOCK = new URLSearchParams(location.search).has('mock');
let impl, chainError = null;
if (MOCK) impl = await import('./api-mock.js');
else {
  try { impl = await import('./chain/api-chain.js'); }
  catch (e) { chainError = e; console.error('Sepolia back end unavailable, using the simulation', e); impl = await import('./api-mock.js'); }
}
export const mode = impl.chain ? 'chain' : 'mock';
export const unavailable = chainError ? String(chainError.message || chainError) : null;
const noop = () => () => {};

export const rules = impl.rules;
export const PACKS = impl.PACKS;
export const _debug = impl._debug;
export const init = (...a) => impl.init(...a);
export const connect = (...a) => impl.connect(...a);
export const account = () => impl.account();
export const disconnect = () => impl.disconnect();
export const listAssets = () => impl.listAssets();
export const subscribePrice = (id, cb) => impl.subscribePrice(id, cb);
export const history = (id, s) => impl.history(id, s);
export const startRun = o => impl.startRun(o);
export const onRun = (id, cb) => impl.onRun(id, cb);
export const cashOut = id => impl.cashOut(id);
export const runInfo = id => impl.runInfo(id);
export const runResult = id => impl.runResult(id);
export const whenEnded = id => impl.whenEnded(id);
export const whenSettled = id => (impl.whenSettled ? impl.whenSettled(id) : impl.whenEnded(id));
export const currentRound = () => impl.currentRound();
export const onRound = cb => impl.onRound(cb);
export const joinRound = o => impl.joinRound(o);
export const roundStandings = id => impl.roundStandings(id);
export const whenRoundFinal = id => impl.whenRoundFinal(id);
export const leaderboard = s => impl.leaderboard(s);
export const balance = () => impl.balance();
export const onBalance = cb => impl.onBalance(cb);
export const decryptBalance = () => (impl.decryptBalance ? impl.decryptBalance() : Promise.resolve(impl.balance()));
export const faucet = () => impl.faucet();
export const openPack = () => impl.openPack();
export const shareCard = (png, r) => impl.shareCard(png, r);
export const onStatus = cb => (impl.onStatus ? impl.onStatus(cb) : noop());
export const focus = id => impl.focus?.(id);
/** Lets the back end prepare the next start (encrypt side and stake in the background). */
export const prepare = o => impl.prepare?.(o);
/** cb(runId, result) when the value shown at a cash out is re-checked before the chain answers. */
export const onRefine = cb => (impl.onRefine ? impl.onRefine(cb) : noop());
export const priceSource = id => impl.priceSource?.(id) ?? '';
export const marketOpen = id => (impl.marketOpen ? impl.marketOpen(id) : true);
export const onMarkets = cb => (impl.onMarkets ? impl.onMarkets(cb) : noop());
export const lastTransaction = () => impl.lastTransaction?.() ?? null;
export const publishRun = id => (impl.publishRun ? impl.publishRun(id) : Promise.resolve(false));
export const setName = n => impl.setName?.(n);

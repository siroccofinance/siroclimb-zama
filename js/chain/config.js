// Chain configuration of the front: network, contract addresses, ABIs, markets, game constants
// mirrored from the contracts. Loaded once (top-level await) before the game starts.
const load = p => fetch(new URL(p, import.meta.url)).then(r => { if (!r.ok) throw new Error(`${p}: ${r.status}`); return r.json(); });
const [marketsFile, deployments, ABI] = await Promise.all([load('./markets.json'), load('./deployments.json'), load('./abi.json')]);

export const CHAIN_ID = 11155111;
export const CHAIN_HEX = '0xaa36a7';
const q = new URLSearchParams(location.search);
// A busy page (live feed, autopilot) hit 429s on Tenderly's gateway, so the
// browser reads from publicnode; every read after a write waits for it (F27, F29). ?rpc= overrides.
export const RPC_URL = q.get('rpc') || window.SIROCLIMB_RPC || 'https://ethereum-sepolia-rpc.publicnode.com';
export const EXPLORER = 'https://sepolia.etherscan.io';
export const ADDR = deployments[String(CHAIN_ID)];
if (!ADDR) throw new Error('Siroclimb is not deployed on Sepolia yet');
export { ABI };

/** Markets in on-chain order (index = market id). */
export const MARKETS = marketsFile.markets.map((m, i) => ({ ...m, index: i }));
export const byIndex = i => MARKETS[i];
export const indexOf = id => MARKETS.findIndex(m => m.id === id);

export const PRICE_DECIMALS = 10;
export const USDC = 1e6;
export const SCALE = 1e6;
export const LADDER = [1, 1.5, 2, 2.5, 3, 3.5, 4];
export const STEP_SECONDS = 6;
export const RUN_SECONDS = 60;
/** Game boost per market (markets.json `boost`, ClimbLadder.moveScale(market)): how many times a move counts. */
export const BOOST = MARKETS.map(m => m.boost);
export const MAX_STAKE = 100;
/** Gas for the game account (it pays every game transaction): the server drip sends SESSION_FUND_ETH and
 *  again below SESSION_MIN_ETH. A start or a cash out (real positions) uses ~8M gas and reserves 12M:
 *  SESSION_TX_ETH at the 0.2 gwei tip floor (F67). */
export const SESSION_FUND_ETH = '0.015';
export const SESSION_MIN_ETH = 0.005;
export const SESSION_TX_ETH = 0.0025;

export const txUrl = h => `${EXPLORER}/tx/${h}`;
export const addressUrl = a => `${EXPLORER}/address/${a}`;

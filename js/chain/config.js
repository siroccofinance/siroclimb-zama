// Chain configuration of the front: network, contract addresses, ABIs, markets, game constants
// mirrored from the contracts. Loaded once (top-level await) before the game starts.
const load = p => fetch(new URL(p, import.meta.url)).then(r => { if (!r.ok) throw new Error(`${p}: ${r.status}`); return r.json(); });
const [marketsFile, deployments, ABI] = await Promise.all([load('./markets.json'), load('./deployments.json'), load('./abi.json')]);

export const CHAIN_ID = 11155111;
export const CHAIN_HEX = '0xaa36a7';
const q = new URLSearchParams(location.search);
// Tenderly's public gateway: CORS-enabled and far more consistent than load-balanced public nodes (F27)
export const RPC_URL = q.get('rpc') || window.SIROCLIMB_RPC || 'https://sepolia.gateway.tenderly.co';
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
export const MOVE_SCALE = 25;
export const MAX_STAKE = 100;
export const ROUND_ENTRY = 10;
export const JOIN_SECONDS = 60;
export const PRIZE_SPLIT = [0.5, 0.3, 0.2];
/** Gas sent once from the wallet to the browser's session key (it pays every game transaction). */
export const SESSION_FUND_ETH = '0.03';
export const SESSION_MIN_ETH = 0.006;

export const txUrl = h => `${EXPLORER}/tx/${h}`;
export const addressUrl = a => `${EXPLORER}/address/${a}`;

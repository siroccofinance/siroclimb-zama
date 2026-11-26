# Deployments

**Play it:** https://climb.sirocco.finance

## Sepolia (chain id 11155111)

Sources are verified on [Sourcify](https://sourcify.dev) (`cd contracts && npm run verify:sourcify`).
The deployment records are in `contracts/deployments/sepolia/`, and the front reads its addresses
from `js/chain/deployments.json` (written by `npm run export -- sepolia`).

### Game

| Contract | Address | Role |
| --- | --- | --- |
| `Siroclimb` | [`0x95B271D1D751dfAA9E997caD0CE45B37B5ad242d`](https://sepolia.etherscan.io/address/0x95B271D1D751dfAA9E997caD0CE45B37B5ad242d) | Runs with an encrypted side and stake, a real position in the market token (4x the stake, 3x borrowed from the Sirocco Reserve) traded with the desk, the game boost settled with the reserve, encrypted payouts, KMS-verified posted results, packs, sessions (solo only) |
| `SiroccoDesk` | [`0x80e8AD821E31f566A70D7C1B6a6d5E5418Bc6760`](https://sepolia.etherscan.io/address/0x80e8AD821E31f566A70D7C1B6a6d5E5418Bc6760) | The Sirocco desk: buys, sells, lends (to shorts) and takes back the markets' confidential tokens at the oracle price ± 10 bps, all legs encrypted |
| `SiroccoReserve` | [`0x52589ca1590C6e8FDbB4d617906eEF8D1d8EB130`](https://sepolia.etherscan.io/address/0x52589ca1590C6e8FDbB4d617906eEF8D1d8EB130) | The Sirocco Reserve: confidential cUSDC lending pool, encrypted `rcUSDC` shares (ERC-7984), loans to runs, KMS-verified reveals of its totals |
| `ClimbPriceOracle` | [`0x9eAf890d59Bf5F38DE42FE92901E0F8607eFab07`](https://sepolia.etherscan.io/address/0x9eAf890d59Bf5F38DE42FE92901E0F8607eFab07) | Per-market price checkpoints: Pyth (trustless) or the bounded public fallback |
| `ClimbLadder` | [`0x66119f55A4f7baC3c697684c114280917Cf0E366`](https://sepolia.etherscan.io/address/0x66119f55A4f7baC3c697684c114280917Cf0E366) | Run rules in clear: long and short multipliers on the oracle path (game scale 25x) |
| `ClimbFaucet` | [`0x9a61CF739874c52785f923488F37ceF9817A3C10`](https://sepolia.etherscan.io/address/0x9a61CF739874c52785f923488F37ceF9817A3C10) | Mints USDCMock and wraps it into cUSDC for any account: 1,000 per claim, every 10 min |

Earlier test deployments (made while fixing F10, F15, F24 and F44, and with keys shared with another
project) are retired with nothing left open, and so is the game without real positions that ran until
2026-11-25 (`Siroclimb` `0x890b…03a0`: 91 runs, the last three settled by the keeper before the switch;
its `SiroccoReserve` `0x0E59…0628` keeps its lenders' shares, withdrawable at any time), and so is the five-market game that ran before AMZNx was
added (`Siroclimb` `0x92e5…7649`, oracle `0xFB3B…19b1`, ladder `0xd6E0…bc20`: 44 runs, 2 rounds, all
settled and claimed), and the six-market game with rounds that followed it (`Siroclimb` `0x8544…f0a6`:
3 runs, all settled, no round ever opened), and the solo-only game that paid from an auto-minted house
bankroll (`Siroclimb` `0x422f…2B85`: 3 runs, all settled). The oracle, the ladder, the faucet and the mirrors carried over; every contract above was deployed from Siroclimb's own keys.

Deployed by `0x6d3376996531a23aBe413AA9D1aC5902644a2A5d` (Siroclimb's dedicated deployer, also the creator of the mirrors). It owns
`Siroclimb`, `ClimbPriceOracle` and `SiroccoReserve` and is the only trusted price updater, used once to seed the
first prices. Its only power over the reserve was wiring the game, once (`setGame`); it cannot move
lenders' cUSDC. It is also the reserve's first lender (250,000 cUSDC).

The desk was stocked at deployment (`scripts/stock-desk.ts`, public underlyings minted and wrapped in
the desk): 100,000 cTSLAx, 200,000 cNVDAx, 100,000 cAAPLx, 100,000 cAMZNx, 2,000 cXAUt, 1,000,000
ctGBP and 500,000 cUSDC. The reserve was seeded with 250,000 cUSDC by the deployer as first lender.

### Zama contracts used

| Contract | Address | |
| --- | --- | --- |
| `cUSDCMock` (shown as cUSDC) | [`0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639`](https://sepolia.etherscan.io/address/0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639) | Stakes and payouts. Zama's official confidential USDC on Sepolia (ERC-7984), resolved from USDCMock `0x9b5C…DFfF` through the Wrappers Registry at deploy time |
| Wrappers Registry | [`0x2f0750Bbb0A246059d80e94c454586a7F27a128e`](https://sepolia.etherscan.io/address/0x2f0750Bbb0A246059d80e94c454586a7F27a128e) | Source of truth for Zama's confidential tokens |
| `cXAUtMock` (shown as cXAUt) | [`0xe4FcF848739845BC81Dee1d5352cf3844F0a60C7`](https://sepolia.etherscan.io/address/0xe4FcF848739845BC81Dee1d5352cf3844F0a60C7) | Gold market, valid in the registry |
| `ctGBPMock` (shown as ctGBP) | [`0xfCE5c7069c5525eF6c8C2b2E35A745bA20a2F7CC`](https://sepolia.etherscan.io/address/0xfCE5c7069c5525eF6c8C2b2E35A745bA20a2F7CC) | Pound market, valid in the registry. Zama's non-mock `ctGBP` (`0x167D…A208`) is valid too, but its underlying cannot be minted publicly, so the test market uses the mock |
| Pyth | [`0xDd24F84d36BF92C65F92307595335bdFab5Bbd21`](https://sepolia.etherscan.io/address/0xDd24F84d36BF92C65F92307595335bdFab5Bbd21) | Verifies Hermes updates (Wormhole) |

### Sirocco mirrors (stock markets)

Tokenized stocks have no Zama confidential token on Sepolia, so Siroclimb deploys mirrors of
Backed's xStocks, built with **the same contracts as Zama's own Sepolia tokens**:

- **Confidential token: the same implementation.** Zama's `cUSDCMock`, `ctGBPMock` and `cXAUtMock`
  are ERC-1967 proxies to Zama's `ConfidentialWrapper` implementation
  [`0xae37…af04`](https://sepolia.etherscan.io/address/0xae37b998d453e1fabe85dd46cf04295ca4a3af04)
  (verified on Sourcify: the OpenZeppelin `ERC7984ERC20Wrapper`, upgradeable, plus Zama's
  multi-chain FHEVM config, owner, pause, deny-list, observers and ERC-1363 wrapping). `cTSLAx`,
  `cNVDAx`, `cAAPLx` and `cAMZNx` are ERC-1967 proxies (`ConfidentialTokenProxy`) to **that same
  implementation**, initialized exactly like `ctGBPMock` and `cXAUtMock`: no pauser, no observers,
  deny-list off. 6 decimals, `rate()` = 10^12, the same name / symbol / contractURI pattern.
- **Underlying: the same contract.** `MirrorToken` is Zama's `ERC20Mock` (the underlying of
  `cXAUtMock`, verified on Sourcify): an ERC-20 with the real token's name, symbol and decimals (18,
  like the mainnet xStocks) and a public mint capped at 1,000,000 tokens per call.

The differences, and only these: the proxy shell is our own build of OpenZeppelin's
`ERC1967Proxy` (Zama's was compiled with 0.8.29, ours with 0.8.27), the owner is Siroclimb's
deployer instead of Zama's, and **they are not listed in Zama's Wrappers Registry**, where
registration is owner-only. The first mirrors (until this change) used the plain OpenZeppelin
`ERC7984ERC20Wrapper` without Zama's extras; they held no supply and nothing depended on them.

| Market | Confidential token | Underlying | Mainnet xStock |
| --- | --- | --- | --- |
| Tesla | `cTSLAx` [`0x290737a05b46FA970318A1539c262ba8AcCaC27B`](https://sepolia.etherscan.io/address/0x290737a05b46FA970318A1539c262ba8AcCaC27B) | Tesla xStock (TSLAx) [`0x28F9…C23E`](https://sepolia.etherscan.io/address/0x28F90781Ce9Af15d070C81DC27C439c39f25C23E) | `0x8aD3c73F833d3F9A523aB01476625F269aEB7Cf0` |
| NVIDIA | `cNVDAx` [`0xF441a77c96F24c52CC53bcdB6e8b4B0BEDac3daD`](https://sepolia.etherscan.io/address/0xF441a77c96F24c52CC53bcdB6e8b4B0BEDac3daD) | NVIDIA xStock (NVDAx) [`0xA31c…4c72`](https://sepolia.etherscan.io/address/0xA31c505C280793f0d32c15Ccbc54e5db7A2f4c72) | `0xc845b2894dBddd03858fd2D643B4eF725fE0849d` |
| Apple | `cAAPLx` [`0xA8b91F85E56EF8d5F8C7b7c0765f73C27ad9f8a9`](https://sepolia.etherscan.io/address/0xA8b91F85E56EF8d5F8C7b7c0765f73C27ad9f8a9) | Apple xStock (AAPLx) [`0x4530…a1b4`](https://sepolia.etherscan.io/address/0x4530495F1dECc8f02C067460EBd6a758E3fBa1b4) | `0x9d275685dC284C8eB1C79f6ABA7a63Dc75ec890a` |
| Amazon | `cAMZNx` [`0xd432D9B2c87d4497ea7CdCBC23ee5322E6D264ec`](https://sepolia.etherscan.io/address/0xd432D9B2c87d4497ea7CdCBC23ee5322E6D264ec) | Amazon.com xStock (AMZNx) [`0xD889…23cB`](https://sepolia.etherscan.io/address/0xD889F2087FA97673C22BB05404b5892A2D0D23cB) | `0x3557Ba345B01EFa20A1bdDC61F573BFD87195081` |

### Game parameters

| Parameter | Value |
| --- | --- |
| Markets (oracle order) | 0 cTSLAx, 1 cNVDAx, 2 cAAPLx, 3 cAMZNx, 4 cXAUt, 5 ctGBP (shown by their confidential token) |
| Pyth feeds (oracle) | Equity.US.TSLA/USD, Equity.US.NVDA/USD, Equity.US.AAPL/USD, Equity.US.AMZN/USD, Crypto.XAUT/USD, FX.GBP/USD. The four Equity feeds only move 9:30 to 16:00 New York and are not posted (F56) |
| Live prices | Every market 24/7 on Kraken, mid of the book: the stocks' xStock (`tokenized_asset`: TSLAxUSD, NVDAxUSD, AAPLxUSD, AMZNxUSD), XAUTUSD, GBPUSD. Posted as bounded public checkpoints; no Pyth feed is posted (`pythLive: false`) |
| Ladder | 1x, 1.5x, 2x, 2.5x, 3x, 3.5x, 4x, one step every 6 s, 60 s runs |
| Game scale | 25x: a 0.1 % move counts 2.5 % at 1x, 10 % at 4x |
| Stake | Encrypted, clamped to 100 cUSDC on ciphertexts |
| Leverage | Game ladder 1x to 4x (moves ×25). Real position: 4x the stake, 3x borrowed from the Sirocco Reserve for the whole run |
| Desk | Oracle price ± 10 bps (`spreadBps`), a long buys at the ask and sells at the bid, a short borrows, sells at the bid, buys back at the ask |
| Borrow APR | 20 % (`borrowAprBps` 2000, fixed at deployment); interest = paid x 2000 x (30 x seconds) / 3.1536e12 |
| Liquidity per live run | 1,000 cUSDC lent into the game at the start (the public bound of a run), returned with the PnL at the end |
| Reserve seed | 250,000 cUSDC, deposited by the deployer as first lender (public deposit of the underlying) |
| Reserve reveals | At most every 10 min (`SYNC_INTERVAL`), KMS proof checked by `finalizeSync`; a stuck one can be asked again after 1 h |
| Packs | One per 10 min, Bronze 45 % / Silver 28 % / Gold 18 % / Diamond 9 % (1.5x / 2x / 3x / 4x cap) |
| Entry | At most 60 s old; a Pyth update or a bounded public price can ride along with `startRun` |
| Oracle | Pyth max age 25 s; fallback at most every 10 s, +/-0.5 % per checkpoint, +/-3 % from the last Pyth price |

### Server keys (Vercel functions, never in the repo)

| Key | Address | Used by |
| --- | --- | --- |
| Drip | [`0xc4F684B2F465C828fF947f679Af6B77b60d84e9A`](https://sepolia.etherscan.io/address/0xc4F684B2F465C828fF947f679Af6B77b60d84e9A) | `api/drip.js` (`DRIP_KEY`): 0.006 Sepolia ETH of gas per new game account (again below 0.0025, at most every 45 s per address), 0.0015 ETH for the browser keeper key, and the account's first `ClimbFaucet.claimFor`. Logs its balance, warns below 0.05 ETH |
| Keeper | [`0x924BB8eA5eD286a2aCF9655A1db294b48bF83c65`](https://sepolia.etherscan.io/address/0x924BB8eA5eD286a2aCF9655A1db294b48bF83c65) | `api/keep.js` (`KEEPER_KEY`, cron every minute, `CRON_SECRET`): bounded public price checkpoints when a market moved or went quiet for 20 min. Logs its balance, warns below 0.05 ETH |
| Share secret | n/a | `api/share.js` (`SHARE_SECRET`): HMAC of share links, which name runs verified on chain |

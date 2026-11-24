# Deployments

**Play it:** https://climb.sirocco.finance

## Sepolia (chain id 11155111)

Sources are verified on [Sourcify](https://sourcify.dev) (`cd contracts && npm run verify:sourcify`).
The deployment records are in `contracts/deployments/sepolia/`, and the front reads its addresses
from `js/chain/deployments.json` (written by `npm run export -- sepolia`).

### Game

| Contract | Address | Role |
| --- | --- | --- |
| `Siroclimb` | [`0x890b2bAb3f2EC280FcD4761cC0C655eaE13f03a0`](https://sepolia.etherscan.io/address/0x890b2bAb3f2EC280FcD4761cC0C655eaE13f03a0) | Runs with an encrypted side and stake, leverage borrowed from the Sirocco Reserve with interest, encrypted payouts, KMS-verified posted results, packs, sessions (solo only) |
| `SiroccoReserve` | [`0x0E59E03fa74728DE740444D0D976616Cd3080628`](https://sepolia.etherscan.io/address/0x0E59E03fa74728DE740444D0D976616Cd3080628) | The Sirocco Reserve: confidential cUSDC lending pool, encrypted `rcUSDC` shares (ERC-7984), loans to runs, KMS-verified reveals of its totals |
| `ClimbPriceOracle` | [`0x9eAf890d59Bf5F38DE42FE92901E0F8607eFab07`](https://sepolia.etherscan.io/address/0x9eAf890d59Bf5F38DE42FE92901E0F8607eFab07) | Per-market price checkpoints: Pyth (trustless) or the bounded public fallback |
| `ClimbLadder` | [`0x66119f55A4f7baC3c697684c114280917Cf0E366`](https://sepolia.etherscan.io/address/0x66119f55A4f7baC3c697684c114280917Cf0E366) | Run rules in clear: long and short multipliers on the oracle path (game scale 25x) |
| `ClimbFaucet` | [`0x9a61CF739874c52785f923488F37ceF9817A3C10`](https://sepolia.etherscan.io/address/0x9a61CF739874c52785f923488F37ceF9817A3C10) | Mints USDCMock and wraps it into cUSDC for any account: 1,000 per claim, every 10 min |

Earlier test deployments (made while fixing F10, F15, F24 and F44, and with keys shared with another
project) are retired with nothing left open, and so is the five-market game that ran before AMZNx was
added (`Siroclimb` `0x92e5…7649`, oracle `0xFB3B…19b1`, ladder `0xd6E0…bc20`: 44 runs, 2 rounds, all
settled and claimed), and the six-market game with rounds that followed it (`Siroclimb` `0x8544…f0a6`:
3 runs, all settled, no round ever opened), and the solo-only game that paid from an auto-minted house
bankroll (`Siroclimb` `0x422f…2B85`: 3 runs, all settled). The oracle, the ladder, the faucet and the mirrors carried over; every contract above was deployed from Siroclimb's own keys.

Deployed by `0x6d3376996531a23aBe413AA9D1aC5902644a2A5d` (Siroclimb's dedicated deployer, also the creator of the mirrors). It owns
`Siroclimb`, `ClimbPriceOracle` and `SiroccoReserve` and is the only trusted price updater, used once to seed the
first prices. Its only power over the reserve was wiring the game, once (`setGame`); it cannot move
lenders' cUSDC. It is also the reserve's first lender (250,000 cUSDC).

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
Backed's xStocks. They are built exactly like Zama's Sepolia tokens: an ERC-20 underlying
(`MirrorToken`) with the real token's name, symbol and decimals (18, like the mainnet xStocks) and a
public mint capped per call, wrapped by the OpenZeppelin `ERC7984ERC20Wrapper` (6 decimals,
`rate()` = 10^12). **They are not listed in Zama's Wrappers Registry**, where registration is
owner-only.

| Market | Confidential token | Underlying | Mainnet xStock |
| --- | --- | --- | --- |
| Tesla | `cTSLAx` [`0xaDDb52A774647E8C28ce2CF7f86Ba48E9beFf96a`](https://sepolia.etherscan.io/address/0xaDDb52A774647E8C28ce2CF7f86Ba48E9beFf96a) | Tesla xStock (TSLAx) [`0x28F9…C23E`](https://sepolia.etherscan.io/address/0x28F90781Ce9Af15d070C81DC27C439c39f25C23E) | `0x8aD3c73F833d3F9A523aB01476625F269aEB7Cf0` |
| NVIDIA | `cNVDAx` [`0x82Be7e7C57473867e80a32596911eF58fdceF1B4`](https://sepolia.etherscan.io/address/0x82Be7e7C57473867e80a32596911eF58fdceF1B4) | NVIDIA xStock (NVDAx) [`0xA31c…4c72`](https://sepolia.etherscan.io/address/0xA31c505C280793f0d32c15Ccbc54e5db7A2f4c72) | `0xc845b2894dBddd03858fd2D643B4eF725fE0849d` |
| Apple | `cAAPLx` [`0x5bc5E456A4e3628Bf2da5FF088671E2BeAF164C9`](https://sepolia.etherscan.io/address/0x5bc5E456A4e3628Bf2da5FF088671E2BeAF164C9) | Apple xStock (AAPLx) [`0x4530…a1b4`](https://sepolia.etherscan.io/address/0x4530495F1dECc8f02C067460EBd6a758E3fBa1b4) | `0x9d275685dC284C8eB1C79f6ABA7a63Dc75ec890a` |
| Amazon | `cAMZNx` [`0x581E8376F8fA97e75515C9FA94B5D98a19Ced2db`](https://sepolia.etherscan.io/address/0x581E8376F8fA97e75515C9FA94B5D98a19Ced2db) | Amazon.com xStock (AMZNx) [`0xD889…23cB`](https://sepolia.etherscan.io/address/0xD889F2087FA97673C22BB05404b5892A2D0D23cB) | `0x3557Ba345B01EFa20A1bdDC61F573BFD87195081` |

### Game parameters

| Parameter | Value |
| --- | --- |
| Markets (oracle order) | 0 TSLAx, 1 NVDAx, 2 AAPLx, 3 AMZNx, 4 XAUt, 5 tGBP |
| Pyth feeds | Equity.US.TSLA/USD, Equity.US.NVDA/USD, Equity.US.AAPL/USD, Equity.US.AMZN/USD, Crypto.XAUT/USD, FX.GBP/USD |
| Ladder | 1x, 1.5x, 2x, 2.5x, 3x, 3.5x, 4x, one step every 6 s, 60 s runs |
| Game scale | 25x: a 0.1 % move counts 2.5 % at 1x, 10 % at 4x |
| Stake | Encrypted, clamped to 100 cUSDC on ciphertexts |
| Leverage | Borrowed from the Sirocco Reserve: S x (L - 1) for a stake S at leverage L |
| Borrow APR | 20 % (`borrowAprBps` 2000, fixed at deployment); interest = paid x 2000 x borrowed tenth-seconds / 3.1536e12 |
| Liquidity per live run | 1,000 cUSDC lent into the game at the start (the public bound of a run), returned with the PnL at the end |
| Reserve seed | 250,000 cUSDC, deposited by the deployer as first lender (public deposit of the underlying) |
| Reserve reveals | At most every 10 min (`SYNC_INTERVAL`), KMS proof checked by `finalizeSync`; a stuck one can be asked again after 1 h |
| Packs | One per 10 min, Bronze 45 % / Silver 28 % / Gold 18 % / Diamond 9 % (1.5x / 2x / 3x / 4x cap) |
| Entry | At most 60 s old; a Pyth update or a bounded public price can ride along with `startRun` |
| Oracle | Pyth max age 25 s; fallback at most every 10 s, +/-0.5 % per checkpoint, +/-3 % from the last Pyth price |

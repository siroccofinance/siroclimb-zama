# Deployments

## Sepolia (chain id 11155111)

Sources are verified on [Sourcify](https://sourcify.dev) (`cd contracts && npm run verify:sourcify`).
The deployment records are in `contracts/deployments/sepolia/`, and the front reads its addresses
from `js/chain/deployments.json` (written by `npm run export -- sepolia`).

### Game

| Contract | Address | Role |
| --- | --- | --- |
| `Siroclimb` | [`0x074aE03f93B912178F14e52F25Ab7801addDD1A0`](https://sepolia.etherscan.io/address/0x074aE03f93B912178F14e52F25Ab7801addDD1A0) | Solo runs and rounds with an encrypted side and stake, encrypted payouts, sealed standings, packs, sessions |
| `ClimbPriceOracle` | [`0x4e8089656593558d300b7004aEc61c4E74a78720`](https://sepolia.etherscan.io/address/0x4e8089656593558d300b7004aEc61c4E74a78720) | Per-market price checkpoints: Pyth (trustless) or the bounded public fallback |
| `ClimbLadder` | [`0x004604E9396ff5934389336Bdd81825C3E6537D5`](https://sepolia.etherscan.io/address/0x004604E9396ff5934389336Bdd81825C3E6537D5) | Run rules in clear: long and short multipliers on the oracle path (game scale 25x) |
| `ClimbFaucet` | [`0x7A123FE051f33B393AE55Ba99F3dc044F36F69D8`](https://sepolia.etherscan.io/address/0x7A123FE051f33B393AE55Ba99F3dc044F36F69D8) | Mints USDCMock and wraps it into cUSDC for any account: 1,000 per claim, every 10 min |

Earlier versions, replaced after findings from the battery (see FINDINGS.md), held only test runs:
`Siroclimb` `0x42EA…65aF` (F10, single-transaction starts), `0x0A6b…018d` with `ClimbLadder`
`0xc84B…29F1` (F15, index-bounded paths), and `0x205A…81E2` (F24, rounds over the gas cap; its
round 2 keeps 170 battery cUSDC that can never be paid out, F25).

Deployed by `0x599490b003820a882f988C05Ff0323Ff663DC229` (Siroclimb's own deployer key). It owns
`Siroclimb` and `ClimbPriceOracle` and is the only trusted price updater, used once to seed the
first prices.

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
| Tesla | `cTSLAx` [`0x6a9b0628378DcbE094164C29577D9e53D031d7E1`](https://sepolia.etherscan.io/address/0x6a9b0628378DcbE094164C29577D9e53D031d7E1) | Tesla xStock (TSLAx) [`0xd5Fd…373E`](https://sepolia.etherscan.io/address/0xd5Fde06DdbA04b289839fb0d362F15aa3E72373E) | `0x8aD3c73F833d3F9A523aB01476625F269aEB7Cf0` |
| NVIDIA | `cNVDAx` [`0x2C4a032CD3A8f895B31dc32aB1f3a4CdF65e3E81`](https://sepolia.etherscan.io/address/0x2C4a032CD3A8f895B31dc32aB1f3a4CdF65e3E81) | NVIDIA xStock (NVDAx) [`0x738F…62A3`](https://sepolia.etherscan.io/address/0x738F3128b18A09e460Ef4bB16A473F76F51a62A3) | `0xc845b2894dBddd03858fd2D643B4eF725fE0849d` |
| Apple | `cAAPLx` [`0x1881F38510f5B8040966312535C80Cb94c5e6433`](https://sepolia.etherscan.io/address/0x1881F38510f5B8040966312535C80Cb94c5e6433) | Apple xStock (AAPLx) [`0x2f12…92da`](https://sepolia.etherscan.io/address/0x2f12893FEcDA47b694EB56459a4039Ddb57792da) | `0x9d275685dC284C8eB1C79f6ABA7a63Dc75ec890a` |

### Game parameters

| Parameter | Value |
| --- | --- |
| Markets (oracle order) | 0 TSLAx, 1 NVDAx, 2 AAPLx, 3 XAUt, 4 tGBP |
| Pyth feeds | Equity.US.TSLA/USD, Equity.US.NVDA/USD, Equity.US.AAPL/USD, Crypto.XAUT/USD, FX.GBP/USD |
| Ladder | 1x, 1.5x, 2x, 2.5x, 3x, 3.5x, 4x, one step every 6 s, 60 s runs |
| Game scale | 25x: a 0.1 % move counts 2.5 % at 1x, 10 % at 4x |
| Stake | Encrypted, clamped to 100 cUSDC on ciphertexts |
| Rounds | Entry 10 cUSDC, 60 s to join, 60 s live, at most 24 players, prizes 50 / 30 / 20 % |
| Round rotation | Every market, skipping any without a checkpoint in the last 60 s |
| Packs | One per 10 min, Bronze 45 % / Silver 28 % / Gold 18 % / Diamond 9 % (1.5x / 2x / 3x / 4x cap) |
| Entry | At most 60 s old; a Pyth update or a bounded public price can ride along with `startRun` |
| Oracle | Pyth max age 25 s; fallback at most every 10 s, +/-0.5 % per checkpoint, +/-3 % from the last Pyth price |

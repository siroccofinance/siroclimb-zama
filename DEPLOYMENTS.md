# Deployments

**Play it:** https://climb.sirocco.finance

## Sepolia (chain id 11155111)

Sources are verified on [Sourcify](https://sourcify.dev) (`cd contracts && npm run verify:sourcify`).
The deployment records are in `contracts/deployments/sepolia/`, and the front reads its addresses
from `js/chain/deployments.json` (written by `npm run export -- sepolia`).

### Game

| Contract | Address | Role |
| --- | --- | --- |
| `Siroclimb` | [`0xf280D0B11E57BAe4Fd959E8E3b8b53FE33C8DE8c`](https://sepolia.etherscan.io/address/0xf280D0B11E57BAe4Fd959E8E3b8b53FE33C8DE8c) | Solo runs and rounds with an encrypted side and stake, encrypted payouts, sealed standings, packs, sessions |
| `ClimbPriceOracle` | [`0xFB3Be33B9b1589df87FB4E132B334cEC67De19b1`](https://sepolia.etherscan.io/address/0xFB3Be33B9b1589df87FB4E132B334cEC67De19b1) | Per-market price checkpoints: Pyth (trustless) or the bounded public fallback |
| `ClimbLadder` | [`0xcb916F937dcaB2f0bb09BE2845593cCD316b1D0a`](https://sepolia.etherscan.io/address/0xcb916F937dcaB2f0bb09BE2845593cCD316b1D0a) | Run rules in clear: long and short multipliers on the oracle path (game scale 25x) |
| `ClimbFaucet` | [`0x9a61CF739874c52785f923488F37ceF9817A3C10`](https://sepolia.etherscan.io/address/0x9a61CF739874c52785f923488F37ceF9817A3C10) | Mints USDCMock and wraps it into cUSDC for any account: 1,000 per claim, every 10 min |

Earlier test deployments (made while fixing F10, F15 and F24, and with keys shared with another
project) are retired; every contract above was redeployed from Siroclimb's own keys.

Deployed by `0x6d3376996531a23aBe413AA9D1aC5902644a2A5d` (Siroclimb's dedicated deployer, also the creator of the mirrors). It owns
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
| Tesla | `cTSLAx` [`0xaDDb52A774647E8C28ce2CF7f86Ba48E9beFf96a`](https://sepolia.etherscan.io/address/0xaDDb52A774647E8C28ce2CF7f86Ba48E9beFf96a) | Tesla xStock (TSLAx) [`0x28F9…C23E`](https://sepolia.etherscan.io/address/0x28F90781Ce9Af15d070C81DC27C439c39f25C23E) | `0x8aD3c73F833d3F9A523aB01476625F269aEB7Cf0` |
| NVIDIA | `cNVDAx` [`0x82Be7e7C57473867e80a32596911eF58fdceF1B4`](https://sepolia.etherscan.io/address/0x82Be7e7C57473867e80a32596911eF58fdceF1B4) | NVIDIA xStock (NVDAx) [`0xA31c…4c72`](https://sepolia.etherscan.io/address/0xA31c505C280793f0d32c15Ccbc54e5db7A2f4c72) | `0xc845b2894dBddd03858fd2D643B4eF725fE0849d` |
| Apple | `cAAPLx` [`0x5bc5E456A4e3628Bf2da5FF088671E2BeAF164C9`](https://sepolia.etherscan.io/address/0x5bc5E456A4e3628Bf2da5FF088671E2BeAF164C9) | Apple xStock (AAPLx) [`0x4530…a1b4`](https://sepolia.etherscan.io/address/0x4530495F1dECc8f02C067460EBd6a758E3fBa1b4) | `0x9d275685dC284C8eB1C79f6ABA7a63Dc75ec890a` |

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

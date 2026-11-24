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

# Siroclimb on Zama: a confidential climbing game

Pick a market, go long or short, and the Sirocco coin climbs a staircase that follows the price.
Your leverage climbs from 1x to 4x every 6 seconds over a 60-second run, and you cash out whenever
you want. Every run is solo, against the house.

Siroclimb is about real world assets. The markets are tokenized stocks (Tesla, NVIDIA, Apple and
Amazon xStocks), gold (XAUt) and the British pound. Stakes and payouts are in **Zama's confidential USDC**.

Built on the **Zama Protocol (FHEVM)** on Sepolia for the Zama Developer Program, Season 5:
Confidential Gaming.

- **Network**: Ethereum Sepolia
- **Stakes**: Zama's `cUSDCMock` (ERC-7984, shown as cUSDC), resolved and checked through Zama's
  Wrappers Registry
- **Contracts**: Solidity 0.8.27, `@fhevm/solidity` 0.11, OpenZeppelin confidential contracts 0.5,
  Pyth
- **Front**: static site (Three.js scene, ES modules), ethers 6, Zama relayer SDK 0.4.1 from Zama's
  CDN, two small server routes (Pyth, reference prices)

**Play it:** https://climb.sirocco.finance (Sepolia)

Contract addresses are in [DEPLOYMENTS.md](DEPLOYMENTS.md), bugs found on chain and their fixes in
[FINDINGS.md](FINDINGS.md), and the 3-minute video script in [DEMO.md](DEMO.md).

## How to play (judges)

1. Open https://climb.sirocco.finance, click **Start playing**, then **Connect wallet**. Use MetaMask or Rabby on
   Sepolia with about 0.05 Sepolia ETH.
2. On the first visit your wallet signs one message and sends one transaction:
   - the signature creates your **game account**, a key derived from it and kept in your browser;
   - the transaction sends 0.03 Sepolia ETH of gas to that game account.

   From then on the game account sends every game transaction, with no pop-ups. It approves the
   game as ERC-7984 operator of its cUSDC and claims 1,000 test cUSDC from the faucet in the
   background. Any browser where you connect the same wallet finds the same game account.
3. Your balance is encrypted on chain. The game account signs a 7-day decryption grant locally, so
   the balance is decrypted in your browser automatically, and again after every payout.
4. **Play**: pick a market, long or short, and a stake (10 to 100), then **Start climbing**. Your
   side and stake were already encrypted in the background when you picked them, so the climb starts
   at the click while the entry locks on Sepolia. The coin follows the live price and the leverage
   climbs every 6 s. **Cash out** with the button or the space bar: the value is frozen with the
   signed price the transaction carries and shown at once, and it is the value the contract pays.
   The contract computes your payout on ciphertexts and sends it as an encrypted transfer in the
   same transaction; the result screen then adds the transaction link. You can
   post your return to the leaderboard: the return becomes public, your stake stays private.
5. The trophy icon shows the leaderboards (today, all time). They list public results only: the
   runs players chose to post.

Stocks trade during US market hours (4:00 to 20:00 New York time, pre and post market included,
US trading days only: weekends and exchange holidays are closed). Outside those hours their chips
show *Closed*, while gold and the pound stay open.

**Nothing has to run on our side.** Every keeper duty is a permissionless call, and the player's
browser does each one itself (autopilot):

- price checkpoints;
- settling a run at its 60th second.

An optional ops keeper (`ops/keeper.mjs`) does the same duties.

## Every transaction and signature

The wallet signs once and sends one transaction, on the first visit only. Everything after that is
sent by the **game account**: a key derived from that one signature, kept in the browser, holding
the test cUSDC and a little gas. It signs locally, so there are no pop-ups. "Waits" means the player
waits for it on screen.

**First visit**

| Step | Who signs | Kind | Waits | Gas |
| --- | --- | --- | --- | --- |
| Create the game account (`personal_sign` of a fixed message) | wallet | signature | yes | none |
| Send 0.03 Sepolia ETH to the game account | wallet | transaction | yes (one block) | 21k |
| `setOperator(Siroclimb)` on cUSDC, 365 days | game account | transaction | no, background | 136k |
| `ClimbFaucet.claimFor`: mint and wrap 1,000 cUSDC | game account | transaction | no, background | 856k |
| User-decryption grant (EIP-712, 7 days), then the balance is decrypted | game account | signature | no, automatic | none |

**Run**

| Step | Who signs | Kind | Waits | Gas |
| --- | --- | --- | --- | --- |
| Encrypt side and stake (relayer proof) | browser | off chain | no, done in the lobby when picked | none |
| `startRun` with the signed Pyth price (or a bounded public price) | game account | transaction | the coin moves at the click; the entry snaps in when mined | up to 3.77M |
| Price checkpoints (`pushPyth` / `pushPublic`) | game account (autopilot) | transaction | no, background | 340k (Pyth) |
| `cashOut` with the signed Pyth price frozen at the click | game account | transaction | no: the result shows in 1.5 s, marked "Settling on chain" | 2.21M |
| `settleRun` at the 60th second, if not cashed out | game account (autopilot, anyone) | transaction | no, background | 1.88M |
| Balance decryption after the payout | game account | off chain | no, automatic | none |
| `publishRun` then `recordRun` with the KMS proof | game account | 2 transactions | only when the player clicks **Post** | small |

So a player waits for two things only: the first visit's gas transfer, and the start (`startRun`).
A run costs two transactions (start and cash out); posting it adds two more, on demand.

There are no rounds: Siroclimb is solo only. Timed rounds with sealed standings were removed to
keep the game, the contract and the play flow small (F49).

## Confidentiality design

*Would the game break if this were public?* Yes, in three places, and each one is encrypted.

| What | Why it must be private | How (FHEVM) |
| --- | --- | --- |
| **Side of a run** (long / short) | A visible side is copied or faded: a known whale going long is a free signal for everyone else. | `externalEbool` with an input proof (`FHE.fromExternal`), stored as `ebool`. ACL: the contract and the player only. Never decrypted for anyone else during the run. |
| **Stake** | Bankrolls and position sizes are private information, and whales get front-run. | `externalEuint64`, clamped to 100 cUSDC **on ciphertexts** (`FHE.min`), pulled with ERC-7984 `confidentialTransferFrom`. The amount actually moved (`paid`) stays encrypted: an unfunded stake moves 0 and earns 0, without revealing any balance. |
| **Value and payout** | The payout reveals the stake and the side. | The contract works out in clear, from the public oracle path, what a long and what a short would have made (`multLong`, `multShort`, see `ClimbLadder`). It then selects one with the encrypted side (`FHE.select`) and multiplies the encrypted stake by it (`FHE.mul`, `FHE.div`). The payout is an ERC-7984 transfer of that ciphertext **in the same transaction**. Money never waits for a decryption. |
| **Leverage packs** | A known cap would let rivals size you up. | The tier is drawn with the on-chain encrypted PRNG (`FHE.randEuint8`, then `FHE.lt` / `FHE.select` into 45 / 28 / 18 / 9 %), and only the player can decrypt it. A packed run picks among the capped paths on ciphertexts (`FHE.eq` on the encrypted cap). |
| **Balances** | Private by nature. | Zama's cUSDC (ERC-7984): every balance and transfer is an `euint64`. The house bankroll is encrypted too, and even the deployer cannot read it. |

What becomes public, and when:

| Data | Visibility |
| --- | --- |
| Market, start time, exit time of a run | Public (transactions) |
| Long and short multipliers of a finished run | Public: both are computed from public prices, and the encrypted side picks one |
| Side, stake, value of a run | Player only, forever. If the player posts the run, the multiplier becomes public with a KMS proof, and the stake stays private |
| Pack tier | Player only |
| Balances | Owner only (ERC-7984) |

Honest limit: once a run ends, an observer knows its value is one of two numbers (long or
short). The side and the stake stay hidden, and so does the amount paid.

## Prices: Pyth, with a bounded fallback

Every run is settled on `ClimbPriceOracle` checkpoints. Each checkpoint is tagged with its source,
and the result never depends on when settlement is called. Sepolia blocks come every ~12 s, so the
screen animates smoothly on live prices and the chain settles on 3 to 6 checkpoints per minute.

1. **Pyth (trustless)**. The browser fetches a *signed* Hermes update from our server route
   `/api/pyth`. The API key stays on the server (`PYTH_API_KEY`). The browser posts the update to
   Pyth's Sepolia contract, which verifies the Wormhole signatures, so the route cannot forge
   prices. Entry and exit rides along with `startRun` and `cashOut`, which makes them the freshest
   verified price (at most 25 s old).
2. **Bounded public fallback**. Markets the Hermes plan does not cover take the reference price from
   `/api/prices` (Yahoo Finance for stocks and GBP, Kraken for XAUt, with market hours) through
   `pushPublic`. The oracle bounds it: at most every 10 s, +/-0.5 % per checkpoint, +/-3 % from the
   last Pyth price, and only while Pyth has nothing fresher than 2 minutes for that market.
   *Trade-off*: in this mode players are semi-trusted price reporters within those bounds. Each
   checkpoint's source is public.

The current API key is entitled to Equity.US.TSLA/USD. NVDA, AAPL, AMZN, XAUT and GBP answer 403
and go through the fallback. The route detects entitlements by itself, so adding grants to the key moves
those markets to trustless Pyth with no code change.

**Game scale**: real prices move little in a minute, so every move counts 25x, then the leverage
applies on top. A 0.1 % move pays 2.5 % at 1x and 10 % at 4x. PnL adds up on a constant notional,
and at -100 % the coin falls and the run is worth 0 for good.

## Architecture

```
 browser (static site)                                    Sepolia
 ┌─────────────────────────────────────┐   tx   ┌──────────────────────────────────────────┐
 │ wallet: 1 signature, 1 gas transfer ├───────►│ Siroclimb ── FHE ops (Zama coprocessor)  │
 │ game account: every game tx         │        │   ├─ cUSDCMock (Zama, ERC-7984)          │
 │ relayer SDK: encrypt, user/public    │        │   ├─ ClimbLadder ── ClimbPriceOracle      │
 │   decrypt (KMS proofs)               │        │   │                    └─ Pyth (Wormhole) │
 │ autopilot: checkpoints, settle,      │        │ ClimbFaucet ─► USDCMock.mint + wrap      │
 │   (permissionless duties)            │        └──────────────────────────────────────────┘
 └───────────────┬─────────────────────┘
                 │ /api/pyth (signed Hermes update, key server-side)
                 │ /api/prices (reference prices, market hours)
           server routes (Vercel functions, or dev.mjs locally)
```

| Path | Content |
| --- | --- |
| `contracts/contracts/Siroclimb.sol` | Runs, packs, sessions, encrypted payouts, KMS-verified posted results |
| `contracts/contracts/ClimbLadder.sol` | Run rules: long and short multipliers on the oracle path |
| `contracts/contracts/ClimbPriceOracle.sol` | Per-market checkpoints: Pyth, bounded fallback, seeding |
| `contracts/contracts/ClimbFaucet.sol` | Mint + wrap test cUSDC for any account |
| `contracts/contracts/tokens/` | `MirrorToken` (xStock underlyings) and the OpenZeppelin ERC-7984 wrapper |
| `contracts/test/` | FHEVM mock tests, HCU budget |
| `js/api.js` | The front/back contract; Sepolia by default, `?mock` for the simulation |
| `js/chain/` | Sepolia implementation: config, FHE client, wallet and game account, feed, prices, autopilot |
| `api/` | Server routes: `pyth.js` (Hermes proxy), `prices.js` (reference prices, market hours) |
| `ops/` | On-chain battery, optional keeper |
| `tests/chain/` | Puppeteer end to end tests of the real front on Sepolia (injected test wallet) |

HCU budget per transaction (worst cases, limits 20M global / 5M depth). HCU is not the binding
limit on Sepolia, gas is: each FHE operation and encrypted transfer costs about 1M gas on the real
host, and Sepolia caps a transaction at 16.78M gas. No transaction loops over heavy work: each one
handles a single run.

| Transaction | Global HCU | Depth |
| --- | --- | --- |
| `startRun` (encrypted side and stake, clamp, transfer) | 1.32M | 0.68M |
| `cashOut` (select, mul, div, encrypted payout) | 1.95M | 1.74M |
| `cashOut` packed (4 capped paths selected on ciphertexts) | 2.45M | 1.90M |
| `openPack` (encrypted PRNG) | 0.34M | 0.24M |

## Running it

```bash
npm i && npm run dev                      # http://127.0.0.1:3043 (site + /api routes), Sepolia
open "http://127.0.0.1:3043/?mock#play"   # the in-browser simulation, no wallet
```

Locally, the Pyth route reads the key from `PYTH_API_KEY` or `~/.config/zama/pyth.key`. Without a
key, every market uses the bounded fallback.

### Contracts

```bash
cd contracts && npm i && npx hardhat test          # 29 tests on the FHEVM mock, HCU budget
npm run deploy:sepolia && npm run verify:sourcify  # key: ~/.config/siroclimb/sepolia/deployer.key
```

### Hosting

Live at https://climb.sirocco.finance (Vercel). The site is static, and `api/pyth.js` and `api/prices.js` are Vercel Node functions
(`vercel.json`). Deploy the repo root and set `PYTH_API_KEY` as a server-side environment
variable. No secret ever reaches the bundle. Contract addresses come from
`js/chain/deployments.json`, and the relayer SDK loads from Zama's CDN.

### Tests on Sepolia

```bash
node tests/chain/solo.mjs     # connect, faucet, decrypt, encrypted run, cash out, settlement
node tests/chain/timing.mjs   # click to coin, cash out to result, cash out to settled
cd ops && npm i
caffeinate -i node battery.mjs 24 2     # 24 concurrent players, every payout checked by decryption
node audit.mjs                          # recompute every settled run from public chain data
node sweep.mjs                          # settle any run left open past its 60th second
```

The browser tests inject a test wallet (an EIP-1193 provider backed by a key in Node). The
battery's players come from `~/.config/siroclimb/sepolia/battery.mnemonic`, the browser tests use `player.key`
in the same folder, and the ops keeper uses `keeper.key`. No key is ever committed.

## Limitations and next steps

- Fallback markets (NVDA, AAPL, AMZN, XAUT, GBP with the current key) rely on semi-trusted, bounded
  reporters. A wider Pyth entitlement makes them trustless with no code change.
- Runs pay from a house bankroll that the testnet auto-mints (`_reserve`). A mainnet version
  would need a real liquidity pool.
- The game account key lives in the browser's local storage and holds only test cUSDC and a little
  gas. It is derived from a wallet signature, so the same wallet recovers it in any browser. A
  mainnet version would want a passkey or a smart account instead.
- Market hours come from the reference route. The contract itself does not know the trading
  calendar; a closed market simply has no fresh checkpoint, and `startRun` refuses stale entries.

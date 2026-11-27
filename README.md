# Siroclimb on Zama: a confidential climbing game

Pick a market, go long or short, and the Sirocco coin climbs a staircase that follows the price.
Your leverage climbs from 1x to 4x every 6 seconds over a 60-second run, and you cash out whenever
you want. Every run is solo, and it holds **real tokens**: your stake plus three times your stake
borrowed from the **Sirocco Reserve**, a confidential cUSDC lending pool, buys the market's
confidential token at the **Sirocco desk** (a long), or the token is borrowed from the desk and sold
(a short). At the end the position is closed with the desk and the loan is repaid with interest.
The game keeps its amplification on top: every price move counts several times over on the stairs (the game boost, per market, bigger for quieter markets: **×90** Tesla, Apple, Amazon, **×25** NVIDIA, **×60** gold, **×200** the pound), and the
part of the payout beyond the real position, the **game boost**, is settled with the reserve.
Lenders earn the borrow interest and carry the players' gains and losses.

Siroclimb is about real world assets, and you trade them as **confidential tokens** (ERC-7984):
`cTSLAx`, `cNVDAx`, `cAAPLx` and `cAMZNx` (the Tesla, NVIDIA, Apple and Amazon xStocks), `cXAUt`
(gold) and `ctGBP` (the British pound). Our four stock tokens run on the same contract as Zama's
`ctGBPMock` and `cXAUtMock` (see DEPLOYMENTS.md). Stakes and payouts are in **Zama's confidential USDC**.

Built on the **Zama Protocol (FHEVM)** on Sepolia for the Zama Developer Program, Season 5:
Confidential Gaming.

- **Network**: Ethereum Sepolia
- **Stakes**: Zama's `cUSDCMock` (ERC-7984, shown as cUSDC), resolved and checked through Zama's
  Wrappers Registry
- **Contracts**: Solidity 0.8.27, `@fhevm/solidity` 0.11, OpenZeppelin confidential contracts 0.5,
  Pyth
- **Front**: static site (Three.js scene, ES modules), ethers 6, Zama relayer SDK 0.4.1 from Zama's
  CDN, small server routes on Vercel (prices, Pyth, first-visit drip, share links verified on chain)

**Play it:** https://climb.sirocco.finance (Sepolia)

Contract addresses are in [DEPLOYMENTS.md](DEPLOYMENTS.md), bugs found on chain and their fixes in
[FINDINGS.md](FINDINGS.md), and the submission draft (description, FHEVM use, 3-minute video script, tweet) in [SUBMISSION.md](SUBMISSION.md).

## How to play (judges)

1. Open https://climb.sirocco.finance, click **Start playing**, then **Connect wallet**. Use MetaMask or Rabby on
   Sepolia. The wallet needs no Sepolia ETH.
2. On the first visit your wallet signs one message, and that is all it is asked:
   - the signature creates your **game account**, a key derived from it and kept in your browser;
   - the game account gets its gas (0.006 Sepolia ETH, topped up again when it runs low) and its first
     1,000 cUSDC from the server drip (`api/drip.js`), in one block. The wallet sends nothing (it only
     sends the gas itself if the drip is down). About 10 s after the click, the 1,000 cUSDC show as a
     decrypted balance; a line under the balance says each step.

   From then on the game account sends every game transaction, with no pop-ups. It approves the
   game as ERC-7984 operator of its cUSDC in the background, one nonce before your first start. Any
   browser where you connect the same wallet finds the same game account.
3. Your balance is encrypted on chain. The game account signs a 7-day decryption grant locally, so
   the balance is decrypted in your browser automatically, and again after every payout.
4. **Play**: pick a confidential token (cTSLAx, cNVDAx, cAAPLx, cAMZNx, cXAUt or ctGBP), long or
   short, and a stake (10 to 100), then **Start climbing**. Your
   side and stake were already encrypted in the background when you picked them, so the climb starts
   at the click while the entry locks on Sepolia. The coin follows the live price and the leverage
   climbs every 6 s. **Cash out** with the button or the space bar: the value is frozen with the
   signed price the transaction carries and shown at once, and it is the value the contract pays.
   The contract computes your payout on ciphertexts and sends it as an encrypted transfer in the
   same transaction; the result screen then adds the transaction link. You can
   post your return to the leaderboard or **Share on X**: the return becomes public with a KMS proof
   (and with it the side, since both sides' results are public), your stake stays private. The share
   card is built by the server from the chain, never from the browser.
   While you climb, the HUD shows what you borrow: at 3x on a 50 cUSDC stake, 100 cUSDC comes from
   the Sirocco Reserve. The result screen shows the interest you paid on it.
5. The trophy icon shows the leaderboards (today, all time). They list public results only: the
   runs players chose to post.
6. The bank icon opens the **Sirocco Reserve**: its value locked, utilization, share price, APY,
   borrow APR and interest earned. You can lend your test cUSDC to it (an encrypted deposit) and
   withdraw (an encrypted, all-or-nothing withdrawal). Your position is decrypted in your browser
   only.

xStocks trade 24/7, so the stock markets never close: cTSLAx, cNVDAx, cAAPLx and cAMZNx follow the
stock, priced around the clock from Hyperliquid's trade.xyz perps (xyz:TSLA, NVDA, AAPL, AMZN), which
keep ticking when Kraken's xStock books sit still (US holidays). cXAUt follows xyz:GOLD and ctGBP xyz:GBP:
**every market is open 24/7**. One source, the mid; Kraken's mid (xStock books, XAUTUSD, GBPUSD) is only
the fallback when Hyperliquid does not answer. The lobby's 24 h change uses the same venue's hourly candles.

**Nothing has to run on our side.** Every keeper duty is a permissionless call, and the player's
browser does each one itself (autopilot):

- price checkpoints;
- settling a run at its 60th second;

What the screen shows is what is paid: the climb's value is the on-chain checkpoints plus the live price as the
next one. A cash out sends the price shown at the click, and the player's own settlement at the 60th second the
price frozen on screen at that second; the contract writes it as the exit checkpoint (bounded like any public
price, +/-0.49 % of the last checkpoint, within `EXIT_GRACE`) and the run exits on it.
- revealing the Sirocco Reserve's totals every 10 minutes (`requestSync`, then the KMS decrypts them
  and `finalizeSync` checks the proof).

With nobody on the site, a Vercel cron (`/api/keep`, every minute) keeps every market's on-chain price
fresh: one bounded `pushPublic` (the same call anyone can make) for each market that moved more than
0.05 % or whose checkpoint is older than 20 minutes, so the first run after a quiet night starts on
the real price (F72). An optional ops keeper (`ops/keeper.mjs`) does the browsers' duties too.

A reload during a run does not lose it: the device remembers the run once its start is mined, and the
climb comes back on the same run (or its result, if it ended meanwhile).

## Every transaction and signature

The wallet signs once, on the first visit only (and sends the game gas itself only if the server
drip is down). Everything after that is
sent by the **game account**: a key derived from that one signature, kept in the browser, holding
the test cUSDC and a little gas. It signs locally, so there are no pop-ups. "Waits" means the player
waits for it on screen.

**First visit**

| Step | Who signs | Kind | Waits | Gas |
| --- | --- | --- | --- | --- |
| Create the game account (`personal_sign` of a fixed message) | wallet | signature | yes | none |
| Gas (0.006 ETH) and the first 1,000 cUSDC for the game account | server drip | 2 transactions, parallel | yes (one block) | 21k + 1M |
| `setOperator(Siroclimb)` on cUSDC, 365 days | game account | transaction | no, background (before the first start) | 136k |
| User-decryption grant (EIP-712, 7 days), then the balance is decrypted | game account | signature | no, automatic | none |

**Run**

| Step | Who signs | Kind | Waits | Gas |
| --- | --- | --- | --- | --- |
| Encrypt side and stake (relayer proof) | browser | off chain | no, done in the lobby when picked | none |
| `startRun` with the entry price; the reserve lends the run's liquidity, and the run opens its real position with the desk (4 encrypted transfers) in the same transaction | game account | transaction | the coin moves at the click; the entry snaps in when mined | 8.45M |
| Price checkpoints (`pushPyth` / `pushPublic`) | game account (autopilot) | transaction | no, background | 340k (Pyth) |
| `cashOut` at the price frozen at the click: the position is closed with the desk (3 encrypted transfers), payout net of interest to the player, the rest back to the reserve | game account | transaction | no: the result shows in 1.5 s, marked "Settling on chain" | 7.26M |
| `settleRun` at the 60th second, if not cashed out | game account (autopilot, anyone) | transaction | no, background | 3.64M to 3.67M |
| Balance decryption after the payout | game account | off chain | no, automatic | none |
| `publishRun` then `recordRun` with the KMS proof | game account | 2 transactions | only when the player clicks **Post** | small |

So a player waits for two things only: the first visit's drip (one block), and the start (`startRun`).
A run costs two transactions (start and cash out); posting it adds two more, on demand. Borrowing
adds no transaction: the loan rides along with the start and is repaid by the cash out.

**Sirocco Reserve** (never in the play flow)

| Step | Who signs | Kind | Waits | Gas |
| --- | --- | --- | --- | --- |
| `setOperator(SiroccoReserve)` on cUSDC, once | game account | transaction | with the first deposit | 136k |
| Encrypt the amount (relayer proof) | browser | off chain | yes | none |
| `deposit` (encrypted amount, shares at the synced price) | game account | transaction | yes, one block | 1.98M to 2.08M |
| `withdraw` (encrypted shares, all or nothing) | game account | transaction | yes, one block | 2.08M |
| Decrypt the position | game account | off chain | yes, in the panel | none |
| `requestSync`, then `finalizeSync` with the KMS proof | any browser (autopilot) | 2 transactions | no, background, every 10 minutes | 0.66M to 0.97M + 0.37M |

There are no rounds: Siroclimb is solo only. Timed rounds with sealed standings were removed to
keep the game, the contract and the play flow small (F49).

## Confidentiality design

*Would the game break if this were public?* Yes, in four places, and each one is encrypted.

| What | Why it must be private | How (FHEVM) |
| --- | --- | --- |
| **Side of a run** (long / short) | A visible side is copied or faded: a known whale going long is a free signal for everyone else. | `externalEbool` with an input proof (`FHE.fromExternal`), stored as `ebool`. ACL: the contract and the player only. Never decrypted for anyone else during the run. |
| **Stake** | Bankrolls and position sizes are private information, and whales get front-run. | `externalEuint64`, clamped to 100 cUSDC **on ciphertexts** (`FHE.min`), pulled with ERC-7984 `confidentialTransferFrom`. The amount actually moved (`paid`) stays encrypted: an unfunded stake moves 0 and earns 0, without revealing any balance. |
| **Value and payout** | The payout reveals the stake and the side. | The contract works out in clear, from the public oracle path, what a long and what a short would have made (`multLong`, `multShort`, see `ClimbLadder`). It then selects one with the encrypted side (`FHE.select`) and multiplies the encrypted stake by it (`FHE.mul`, `FHE.div`). The payout is an ERC-7984 transfer of that ciphertext **in the same transaction**. Money never waits for a decryption. |
| **Borrowing** | The amount borrowed is the stake times (leverage - 1): a public loan would reveal the stake. Interest follows the loan, so it would too. | The loan is never a number in clear: the reserve lends the run's **public bound** (`MAX_PAYOUT`, what a 100 cUSDC stake can be paid at most) into the game as an encrypted transfer, the same for every run. Interest is computed on the encrypted stake: `paid x APR x borrowed time / divisor` (`FHE.mul`, `FHE.div`), where the borrowed time follows the public ladder (selected on ciphertexts for a packed run). The payout is `min(stake x multiplier - interest, ...)` floored at 0, and the game sends `stake + lent - payout` back to the reserve, all encrypted. |
| **Lender positions** | Who lends how much is private, like any balance. | Reserve shares are an ERC-7984 token (`rcUSDC`): every share balance is encrypted. Deposits and withdrawals take encrypted amounts. A withdrawal is all or nothing on ciphertexts (`FHE.le` on the shares held and on the cUSDC the reserve holds, then `FHE.select`), so a failed one moves 0 and reveals nothing. |
| **Leverage packs** | A known cap would let rivals size you up. | The tier is drawn with the on-chain encrypted PRNG (`FHE.randEuint8`, then `FHE.lt` / `FHE.select` into 45 / 28 / 18 / 9 %), and only the player can decrypt it. A packed run picks among the capped paths on ciphertexts (`FHE.eq` on the encrypted cap). |
| **Balances** | Private by nature. | Zama's cUSDC (ERC-7984): every balance and transfer is an `euint64`. The reserve's cUSDC is encrypted too, and even the deployer cannot read it. |

What becomes public, and when:

| Data | Visibility |
| --- | --- |
| Market, start time, exit time of a run | Public (transactions) |
| Long and short multipliers of a finished run | Public: both are computed from public prices, and the encrypted side picks one |
| Side, stake, value of a run | Player only, forever. If the player posts or shares the run, the multiplier becomes public with a KMS proof: it equals the long or the short multiplier, so the side becomes public too; the stake and the amount paid stay private |
| Borrowed amount and interest of a run | Player only (encrypted handles the player can decrypt; the screen computes them from the stake the player chose) |
| Liquidity committed to live runs | Public: 1,000 cUSDC per live run (`lockedAssets`), whatever the stake. That is the price of a private stake: the reserve commits the worst case of every run |
| Reserve totals: assets, shares, interest earned | Encrypted between reveals; public at each reveal, at most every 10 minutes, with a KMS proof. Share price, value locked, utilization and APY come from them |
| Deposit and withdrawal amounts, lender shares | Encrypted (ERC-7984), owner only |
| Pack tier | Player only |
| Balances | Owner only (ERC-7984) |

Honest limits:

- Once a run ends, an observer knows its value is one of two numbers (long or short). The side and
  the stake stay hidden, and so does the amount paid.
- A reserve reveal shows the change in total assets since the last one. If a single run settled in
  between and no lender moved, that change is the run's stake minus its payout, which together with
  the two public multipliers can point to the stake. Reveals are at most every 10 minutes so that
  each one mixes many runs and lender flows; on a quiet testnet that mix can be thin.
- Deposits and withdrawals use the share price of the last reveal, which can be up to 10 minutes
  old. Someone who saw a big win since then could deposit before the next reveal at the old price.
  The reveal window bounds it.

## Real positions: the Sirocco desk

Every run trades the market's real confidential token (`cTSLAx`, `cNVDAx`, `cAAPLx`, `cAMZNx`,
`cXAUt`, `ctGBP`) with `SiroccoDesk`, a desk that holds inventories of every market token and of
cUSDC and quotes at the oracle price plus or minus a 10 bps half spread.

- **Long.** Stake S plus 3S borrowed from the reserve (notional 4S) buys `qty = 4S / ask` tokens.
  At the end the run sells `qty` at the bid.
- **Short.** The run borrows `qty = 4S / ask` tokens from the desk's lending book and sells them at
  the bid. At the end it buys `qty` back at the ask and returns them.
- **The real position at the end** = S + what came in - what went out - the loan's interest,
  floored at 0 (`positionHandles`, decryptable by the player). The **payout** follows the game ladder
  (`stake x multiplier - interest`, moves × the market's boost, leverage 1x to 4x on the stairs). The difference, the
  **game boost**, positive or negative, is settled with the reserve in the same transaction: the game
  sends the reserve `stake + lent + cash in - cash out - payout`. The result screen shows both parts.
- **Encrypted all the way.** Quantities are computed on ciphertexts at a public price
  (`FHE.mul`, `FHE.div` by a plaintext); every amount moves as an ERC-7984 transfer. The side is an
  encrypted bool and **both legs of every trade always move**, one with an encrypted 0: at the open
  the desk sends the run `qty` tokens, the run pays `long ? notional : 0` cUSDC and sends back
  `long ? 0 : qty` tokens, the desk pays `long ? 0 : sale` cUSDC; at the close the run sends
  `long ? qty : 0` tokens, the desk pays `long ? sale : 0`, the run pays `long ? 0 : buy-back`.
  A long and a short make the same transfers (`test/Desk.ts` checks it).
- **What the desk's flows reveal.** Public: that a run traded, which market and token, when, and the
  public entry and exit prices (and so the desk's quotes). Encrypted: the quantity, the cash amounts,
  the side, and the desk's inventories (readable by its owner only). Like any ERC-7984 holder, the
  desk's balance changes are not visible, so its inventory does not reveal the net side of the
  players either.
- **Inventory.** The desk was stocked at deployment by minting the public underlyings and wrapping
  them into the desk: our mirrors (TSLAx, NVDAx, AAPLx, AMZNx) and Zama's `XAUtMock`, `GBPMock`
  and `USDCMock` all have a public mint (DEPLOYMENTS.md lists the amounts). If the desk runs out of
  a token, the ERC-7984 transfer moves 0 and that run's position is empty (the payout is unchanged,
  the reserve carries it): the inventory is sized for thousands of runs.
- **Trust.** Only the game trades on the desk (`setGame`, once); the game makes the desk its ERC-7984
  operator for cUSDC and the market tokens so the desk pulls the runs' legs itself.

## The Sirocco Reserve: real leverage, borrowed

`SiroccoReserve` is a cUSDC lending pool, and it is the only source of a run's leverage.

- **Borrowing.** A run's real position is 4x its stake S: 3S of it is borrowed for the whole run
  and buys (or backs) the market tokens at the desk. The HUD shows the tokens held and the loan; the
  contract never needs them as numbers.
- **Interest.** `interest = paid x APR x B / (10,000 x 10 x 365 days)`, where B = 30 x the run's
  seconds (the loan is 3x the stake, in tenths: `borrowedTenthSeconds`). With the stated **20 % APR**,
  a 100 cUSDC stake held to the 60th second pays 0.000114 cUSDC. A minute of borrowing is cheap: the
  APR is a yearly rate.
- **Payout.** `stake x multiplier - interest`, floored at 0, paid as an encrypted transfer in the
  cash-out transaction. The most a player loses is the stake; there is no liquidation, the reserve
  absorbs a shortfall. Everything else (`stake + lent - payout`) goes back to the reserve in the same
  transaction, so the players' losses and the interest accrue to lenders and their wins are paid by
  them.
- **Liquidity guard.** The stake is encrypted, so the reserve commits liquidity with the public
  bound of a run: at the start it lends 1,000 cUSDC (`MAX_PAYOUT`) into the game, as an encrypted
  transfer of a public amount. Every live run is fully funded on its own: whatever lenders withdraw
  meanwhile, its payout is already in the game. A start is refused (`ReserveFull`) when the
  committed liquidity would exceed the reserve's last revealed assets. If the reserve still cannot
  lend (lenders withdrew since the reveal), the ERC-7984 transfer moves 0 and the run becomes a plain
  refund, without leverage or interest; the outcome stays encrypted.
- **Shares.** Lenders hold `rcUSDC`, an ERC-7984 token, worth `assets / shares` cUSDC each at the
  last reveal. Deposits mint shares at that price, withdrawals burn them at it. The deployer seeded
  the reserve with 250,000 cUSDC as its first lender (a public deposit of the underlying USDC).
- **Reveals.** Every 10 minutes at most, anyone can call `requestSync`: the reserve's assets (cUSDC
  held + lent to live runs), its share supply and the interest earned become publicly decryptable;
  the KMS decrypts them and `finalizeSync` checks the proof (`FHE.checkSignatures`) before it
  records them. The players' browsers do it in the background.
- **Packs** need no budget: a pack only caps the leverage, so a packed run borrows less, and its
  interest follows the capped path, selected on ciphertexts like its multiplier.
- **No rounds.** Rounds (player against player pots) would not borrow; they were removed when the
  game became solo only (F49), so the reserve has a single path.

## Prices: 24/7 xStocks, Pyth where it is live, bounded checkpoints

Every run is settled on `ClimbPriceOracle` checkpoints. Each checkpoint is tagged with its source,
and the result never depends on when settlement is called. Sepolia blocks come every ~12 s, so the
screen animates smoothly on live prices and the chain settles on 3 to 6 checkpoints per minute.

1. **Pyth (trustless)**. The browser fetches a *signed* Hermes update from our server route
   `/api/pyth`. The API key stays on the server (`PYTH_API_KEY`). The browser posts the update to
   Pyth's Sepolia contract, which verifies the Wormhole signatures, so the route cannot forge
   prices. Entry and exit rides along with `startRun` and `cashOut`, which makes them the freshest
   verified price (at most 25 s old).
2. **Bounded public fallback**. Markets the Hermes plan does not cover take the reference price from
   `/api/prices` (Hyperliquid xyz perps 24/7, mid; Kraken mid as fallback) through
   `pushPublic`. The oracle bounds it: at most every 10 s, +/-0.5 % per checkpoint, +/-3 % from the
   last Pyth price, and only while Pyth has nothing fresher than 2 minutes for that market.
   *Trade-off*: in this mode players are semi-trusted price reporters within those bounds. Each
   checkpoint's source is public.

The stocks follow their xStock, which trades 24/7, through the fallback. The oracle's stock feed ids
are Pyth's Equity.US feeds, which only move in the regular session (9:30 to 16:00 New York) and
outside it keep publishing the closing price with a fresh timestamp: a climb on them froze at night
(F56). So the stocks are flagged `pythLive: false` and never post that feed. Pyth's 24/7
Crypto.TSLAX/USD, NVDAX, AAPLX and AMZNX feeds would make them trustless again; the current key
answers 403 for them ("no grant accepts this feed (asset type 'crypto', instrument type 'spot')"),
and wiring them in needs that grant plus an oracle with those feed ids. XAUT and GBP answer 403 too.
The route detects entitlements by itself.

**Game scale**: real prices move little in a minute, so every move counts 25x, then the leverage
applies on top. A 0.1 % move pays 2.5 % at 1x and 10 % at 4x. PnL adds up on a constant notional,
and at -100 % the coin falls and the run is worth 0 for good.

## Architecture

```
 browser (static site)                                    Sepolia
 ┌─────────────────────────────────────┐   tx   ┌──────────────────────────────────────────┐
 │ wallet: 1 signature                 ├───────►│ Siroclimb ── FHE ops (Zama coprocessor)  │
 │ game account: every game tx         │        │   ├─ SiroccoReserve (lends the leverage, │
 │                                     │        │   │    rcUSDC shares, KMS-synced totals)  │
 │                                     │        │   ├─ SiroccoDesk (real token trades:     │
 │                                     │        │   │    cTSLAx … ctGBP, cUSDC inventory)   │
 │                                     │        │   ├─ cUSDCMock (Zama, ERC-7984)          │
 │ relayer SDK: encrypt, user/public    │        │   ├─ ClimbLadder ── ClimbPriceOracle      │
 │   decrypt (KMS proofs)               │        │   │                    └─ Pyth (Wormhole) │
 │ autopilot: checkpoints, settle,      │        │ ClimbFaucet ─► USDCMock.mint + wrap      │
 │   reserve reveals                    │        └──────────────────────────────────────────┘
 └───────────────┬─────────────────────┘
                 │ /api/pyth (signed Hermes update, key server-side)
                 │ /api/prices (24/7 Hyperliquid xyz perps, Kraken fallback)
                 │ /api/drip (first visit: gas + 1,000 cUSDC, drip key server-side)
                 │ /api/share, /api/og, /s/<id> (share links verified on chain, card PNG)
           server routes (Vercel functions, or dev.mjs locally)
```

| Path | Content |
| --- | --- |
| `contracts/contracts/Siroclimb.sol` | Runs, packs, sessions, borrowing and interest, encrypted payouts, KMS-verified posted results |
| `contracts/contracts/SiroccoDesk.sol` | The desk: real trades of the market tokens at the oracle price ± spread, token lending for shorts, encrypted legs |
| `contracts/contracts/SiroccoReserve.sol` | The lending pool: encrypted deposits and shares (ERC-7984), loans to runs, KMS-verified reveals |
| `contracts/contracts/ClimbLadder.sol` | Run rules: long and short multipliers on the oracle path |
| `contracts/contracts/ClimbPriceOracle.sol` | Per-market checkpoints: Pyth, bounded fallback, seeding |
| `contracts/contracts/ClimbFaucet.sol` | Mint + wrap test cUSDC for any account |
| `contracts/contracts/tokens/` | `MirrorToken` (xStock underlyings) and the OpenZeppelin ERC-7984 wrapper |
| `contracts/test/` | FHEVM mock tests, HCU budget |
| `js/api.js` | The front/back contract; Sepolia by default, `?mock` for the simulation |
| `js/chain/` | Sepolia implementation: config, FHE client, wallet and game account, feed, prices, autopilot |
| `api/` | Server routes: `pyth.js` (Hermes proxy), `prices.js` (reference prices), `drip.js` (first-visit gas and cUSDC), `keep.js` (cron: fresh prices with no visitor), `_run.js` + `share.js` + `og.js` + `s.js` (share links verified on chain, the result card) |
| `ops/` | On-chain battery, optional keeper |
| `tests/chain/` | Puppeteer end to end tests of the real front on Sepolia (injected test wallet) |

HCU budget per transaction (worst cases, limits 20M global / 5M depth). HCU is not the binding
limit on Sepolia, gas is: each FHE operation and encrypted transfer costs about 1M gas on the real
host, and Sepolia caps a transaction at 16.78M gas. No transaction loops over heavy work: each one
handles a single run.

| Transaction | Global HCU | Depth |
| --- | --- | --- |
| `startRun` (encrypted side and stake, clamp, transfer, the reserve's loan, the desk: 4 transfers) | 6.71M | 3.57M |
| `startRun` packed | 7.04M | 3.57M |
| `cashOut` (select, mul, div, interest, the desk: 3 transfers, encrypted payout, repayment to the reserve) | 10.21M | 2.61M |
| `cashOut` packed (4 capped paths selected on ciphertexts) | 10.70M | 2.77M |
| `openPack` (encrypted PRNG) | 0.34M | 0.24M |
| reserve `deposit` (encrypted amount, shares at the synced price) | 3.09M | 2.66M |
| reserve `withdraw` (all or nothing on ciphertexts) | 3.53M | 2.52M |
| reserve `requestSync` (three totals made publicly decryptable) | 0.49M | 0.16M |

## Running it

```bash
npm i && npm run dev                      # http://127.0.0.1:3043 (site + /api routes), Sepolia
open "http://127.0.0.1:3043/?mock#play"   # the in-browser simulation, no wallet
```

Locally, the Pyth route reads the key from `PYTH_API_KEY`, the drip route from `DRIP_KEY` (or
`~/.config/siroclimb/sepolia/drip.key`), the share routes sign with a dev secret. Without a Pyth
key, every market uses the bounded checkpoints.

### Contracts

```bash
cd contracts && npm i && npx hardhat test          # 44 tests on the FHEVM mock, HCU budget
npx hardhat run scripts/stock-desk.ts --network sepolia   # stock the desk (idempotent)
npm run deploy:sepolia && npm run verify:sourcify  # key: ~/.config/siroclimb/sepolia/deployer.key
```

### Hosting

Live at https://climb.sirocco.finance (Vercel). The site is static, and `api/pyth.js` and `api/prices.js` are Vercel Node functions
(`vercel.json`), as are the share routes and the first-visit drip (`api/drip.js`). Share links are
verified on chain: `POST /api/share { runId }` reads the finished run from the Siroclimb contract
(`api/_run.js`: market, top leverage, time, entry, exit, and the return the player published with the
KMS proof) and signs a link naming the run (HMAC-SHA256 with `SHARE_SECRET`); nothing from the browser
reaches the card. A run whose return is not published yet gets a 409, and the share sheet offers to
publish it first. Publishing makes the return public, and since a run's long and short results are
public, it also tells the side; the stake stays encrypted. `/s/<id>` serves the `summary_large_image`
page X unfolds, `/api/og?id=` renders the 1200×630 card (satori + resvg, the 3D coin still from
`3d/coin-still.mjs`). Older self-reported links still open the game, with a generic card. Deploy the
repo root and set `PYTH_API_KEY`, `SHARE_SECRET`, `DRIP_KEY`, `KEEPER_KEY` and `CRON_SECRET` as server-side environment variables. No secret ever reaches the bundle. Contract addresses come from
`js/chain/deployments.json`, and the relayer SDK loads from Zama's CDN.

### Tests on Sepolia

```bash
node tests/chain/battery-prod.mjs https://climb.sirocco.finance out/battery 1440   # fresh wallet, every market long and short, reserve
node tests/chain/battery-prod.mjs https://climb.sirocco.finance out/battery-390 390 # the same on a phone viewport
node tests/chain/firstvisit.mjs https://climb.sirocco.finance out/firstvisit       # a first visit, timed step by step
```

```bash
node tests/chain/solo.mjs     # connect, faucet, decrypt, encrypted run, cash out, settlement
node tests/chain/timing.mjs   # click to coin, cash out to result, cash out to settled
node tests/chain/reserve.mjs  # reserve panel: encrypted deposit, decrypted position, encrypted withdrawal
node tests/reserve.mjs . out  # the same panel, borrowed line and interest in the simulation (no chain)
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
- The Sirocco Reserve commits 1,000 cUSDC per live run whatever the stake, because the stake is
  private: capital efficiency is traded for confidentiality. A mainnet version could tighten the
  bound with stake tiers, or reveal a coarse stake bucket.
- The borrow APR is fixed at deployment (20 %). A mainnet pool would want a utilization curve, which
  needs utilization in clear more often than every 10 minutes.
- The game account key lives in the browser's local storage and holds only test cUSDC and a little
  gas. It is derived from a wallet signature, so the same wallet recovers it in any browser. A
  mainnet version would want a passkey or a smart account instead.
- Market hours come from the reference route: every market is 24/7 now (Hyperliquid xyz perps, Kraken
  as fallback).
  The contract itself does not know the trading calendar; a closed market simply has no fresh
  checkpoint, and `startRun` refuses stale entries.

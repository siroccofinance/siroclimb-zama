# Siroclimb on Zama: 3-minute demo script

For the Zama Developer Program, Season 5 video, recorded by a person on screen with voice-over.
Have ready a Sepolia wallet holding about 0.05 ETH, a US market session if you want the stocks
open (or use gold and GBP), and a second tab on Sepolia Etherscan.

## 0:00 to 0:20 · The hook

*Screen: https://climb.sirocco.finance, the landing page, the coin rolling on the terracotta stairs. Click "Start playing".*

> "This is Siroclimb by Sirocco. You pick a real world asset (Tesla, NVIDIA, Apple, Amazon, gold
> or the pound), go long or short, and the coin climbs the stairs with the price. Every 6 seconds your
> leverage steps up, from 1x to 4x, and that leverage is borrowed from a lending pool, the Sirocco
> Reserve. Cash out whenever you want. And on Zama, nobody can see which way you went or how much
> you put in."

## 0:20 to 0:50 · Connect once, play without pop-ups

*Click Connect wallet. Sign one message, then approve one gas transfer. The status line shows each step.*

> "One signature and one transaction, once. The signature creates my game account, a key in my
> browser that plays for me, so a run never waits on a pop-up. The transaction gives it a little
> gas. It approves the game as operator of its confidential USDC, Zama's ERC-7984 token, and
> claims test cUSDC from the faucet by itself."

*The balance decrypts by itself a moment later.*

> "My balance is encrypted on chain. It is decrypted here, in my browser, with a grant my game
> account signed locally. Nobody else can read it, not even the game's deployer."

## 0:50 to 1:40 · A run

*Pick a market (TSLAx or AMZNx if open, else XAUt), Short, 50 cUSDC, then Start climbing. Point at the
status line: "Encrypting your side and stake…", then "Sealing your run on Sepolia…".*

> "My side and my stake are encrypted right here with Zama's relayer SDK and sealed on chain. The
> stake is even clamped to 100 on ciphertexts."

*The run plays. The coin climbs and steps down, the leverage gauge fills. Point at the line under
the PnL: "Borrowed 100.00 cUSDC from the Sirocco Reserve" at 3x. Cash out around 4x.*

> "The coin follows real prices: Pyth when it's covered, a bounded fallback otherwise. Every move
> counts 25 times, then the leverage on top. And the leverage is real: at 3x on 50, I borrow 100
> from the Sirocco Reserve and pay interest on it by the second. I'll take it here."

*Result screen: "Settling on chain: encrypted payout…" then "Settled on chain. Paid … cUSDC as an
encrypted transfer." Click "View the transaction".*

> "The contract worked out, in the open, what a long and what a short would have made on the oracle
> prices. My encrypted side picked one, it was multiplied by my encrypted stake, and the payout went
> out as an encrypted transfer in the same transaction. On Etherscan you see the call and two public
> multipliers. My side, my stake and my payout stay ciphertexts. So does my loan: the interest was
> computed on my encrypted stake, and the rest went back to the reserve in the same transaction."

*Point at the result's "Borrowed" and "Interest paid" stats.*

## 1:40 to 2:35 · The Sirocco Reserve, and posting a run

*Open the bank icon: the Sirocco Reserve panel. Point at value locked, utilization, share price,
APY, borrow APR, interest earned, "Last reveal".*

> "This is who lent me that leverage. Lenders deposit confidential USDC and hold encrypted shares.
> They earn the interest and carry our gains and losses. Every live run has its worst case set
> aside, so a withdrawal can never touch a payout. The totals are revealed every ten minutes by
> Zama's KMS, with a proof the contract checks."

*Type 100, click Deposit. "Encrypting the deposit…", then the position shows "100.00 cUSDC".*

> "My deposit is encrypted, my shares are encrypted, and my position is decrypted only here."

*Back on the result, click "Post to the leaderboard": "Posted: return public, stake still
private". Open the trophy icon, Today tab.*

> "And if I want the glory, I post the run: only the return is made public, with a KMS proof.
> Every keeper step, from the checkpoints to the reserve's reveals, runs from my own browser."

## 2:35 to 3:00 · Wrap-up

*Show the README's confidentiality table, then the repo's test output (39 tests, HCU table) and the
battery summary in FINDINGS.md.*

> "Encrypted sides and stakes, leverage borrowed from a confidential lending pool, payouts and
> interest computed on ciphertexts, results revealed only when the player posts them, with a KMS
> proof, leverage packs from the encrypted PRNG. Stakes in Zama's confidential USDC, real world
> assets as markets. All on Sepolia, verified on Sourcify, with a battery of concurrent players and
> every payout checked. Siroclimb: climb higher, privately."

# Siroclimb: Zama Developer Program, Season 5 (Confidential Gaming)

Draft submission. Nothing here has been submitted or posted. Deadline: 2026-12-14.

- **Play:** https://climb.sirocco.finance (Sepolia, any wallet, no Sepolia ETH needed)
- **Code:** https://github.com/siroccofinance/siroclimb-zama
- **Contracts:** [DEPLOYMENTS.md](DEPLOYMENTS.md) (verified on Sourcify)
- **Design and limits:** [README.md](README.md) · **What broke on chain and how it was fixed:** [FINDINGS.md](FINDINGS.md)

## One line

A 60-second climbing game on real-world assets where your side, your stake, your loan and your payout
are ciphertexts: you go long or short on confidential tokens, borrow your leverage from a confidential
lending pool, and get paid by an encrypted transfer computed on FHE.

## Description

Pick a market, go long or short, and the Sirocco coin climbs a staircase that follows the live price.
Every 6 seconds the leverage steps up, from 1x to 4x, and you cash out whenever you want. The markets
are confidential tokens (ERC-7984) of real-world assets: `cTSLAx`, `cNVDAx`, `cAAPLx` and `cAMZNx`
(the Tesla, NVIDIA, Apple and Amazon xStocks), `cXAUt` (gold) and `ctGBP` (the British pound). Our four
stock tokens are proxies to the same verified `ConfidentialWrapper` implementation as Zama's
`cXAUtMock` and `ctGBPMock`. Stakes and payouts are in Zama's confidential USDC (`cUSDCMock`, resolved
through Zama's Wrappers Registry).

Every run holds **real tokens**, the way Sirocco Finance does it: the stake plus 3x the stake
borrowed from the **Sirocco Reserve** (a cUSDC lending pool whose lenders hold encrypted `rcUSDC`
shares and earn 20 % APR) buys the market's confidential token at the **Sirocco desk**, at the oracle
price plus or minus a spread (a long); or the token is borrowed from the desk's lending book and sold
(a short). At cash out the desk takes the position back, the loan is repaid with interest. The game
keeps its amplification on top, shown as such: every move counts several times on the stairs (×25 to ×200 by market, bigger for quieter markets), and the part of
the payout beyond the real position, the "game boost", is settled with the reserve, encrypted. The
result screen splits the payout into the two.

Prices: every market is open 24/7. Prices come from Hyperliquid's trade.xyz perps (TSLA, NVDA, AAPL,
AMZN, GOLD, GBP), which tick around the clock, weekends and US holidays included; Kraken is the fallback. Every run settles on an on-chain oracle path with bounded checkpoints, and the
contract computes the outcome from it.

A player's first visit is one wallet signature: a game account (a key derived from that signature,
kept in the browser) receives its gas and 1,000 test cUSDC from a server drip in one block, and from
then on there are no pop-ups. The balance is decrypted in the browser about ten seconds after the click.

## How FHEVM is used

| What | Why it must be private | FHEVM |
| --- | --- | --- |
| Side (long/short) | A visible side is copied or faded | `externalEbool` + input proof, stored `ebool`, ACL contract + player |
| Stake | Bankrolls get sized and front-run | `externalEuint64`, clamped to 100 on ciphertexts (`FHE.min`), pulled with ERC-7984 `confidentialTransferFrom`; an unfunded stake moves 0 |
| Payout | It reveals the stake and the side | The contract computes in clear what a long and a short would make on the public price path, picks one with the encrypted side (`FHE.select`), multiplies the encrypted stake (`FHE.mul`, `FHE.div`) and pays it as an encrypted transfer in the same transaction |
| Loan and interest | A public loan reveals the stake | The reserve lends the public worst case (1,000 cUSDC) as an encrypted transfer; interest = paid x APR x time on ciphertexts; `stake + lent + cash in - cash out - payout` returns to the reserve, encrypted |
| Real token trades | Quantities reveal the stake, the direction of the trades reveals the side | `qty = notional x 1e10 / price` on ciphertexts at the public price; every leg is an ERC-7984 transfer, and both legs always move (one with an encrypted 0), so a long and a short make the same transfers |
| Lender positions | Balances are private | Encrypted deposits and withdrawals (all or nothing with `FHE.le` + `FHE.select`), encrypted `rcUSDC` shares |
| Reserve totals | Needed for a share price, without leaking flows run by run | Made publicly decryptable at most every 10 min (`FHE.makePubliclyDecryptable`), the KMS decrypts, `FHE.checkSignatures` verifies the proof before they are recorded |
| Posted results and share cards | The player chooses to reveal a return | `publishRun` makes the player's multiplier publicly decryptable; `recordRun` checks the KMS proof. Share links are signed only for runs read back from the contract |
| Leverage packs | A known cap sizes you up | Tier drawn with `FHE.randEuint8`, capped path selected on ciphertexts |
| Balances in the browser | Only the owner reads them | User decryption with an EIP-712 grant the game account signs locally (relayer SDK 0.4.1) |

Honest limits are in the README: once a run ends its value is one of two public numbers (long or
short); posting a return reveals which one; a reserve reveal on a quiet testnet can isolate a run.

## Video script (about 3 minutes)

**0:00 to 0:20 · Hook.** *Landing page, the coin rolling on the terracotta stairs, click Start playing.*
> "Siroclimb: pick a confidential token of a real-world asset, go long or short, and the coin climbs
> with the price. Your leverage steps up every 6 seconds, borrowed from a confidential lending pool.
> On Zama, nobody sees which way you went or how much you put in."

**0:20 to 0:45 · One signature.** *Connect wallet, sign once. The line under the balance: "Getting your
1,000 test cUSDC… 2/3", "Decrypting your balance… 3/3", "Ready".*
> "One signature creates my game account, a key in my browser. It gets gas and 1,000 confidential USDC
> in one block, and my balance, encrypted on chain, is decrypted here, only for me. No more pop-ups."

**0:45 to 1:35 · A run.** *cTSLAx, Short, 50, Start climbing. HUD: price from the 24/7 xStock, the
gauge "Leverage · moves ×90", the line "Short 0.52 cTSLAx · borrowed 150.00 cUSDC from the Sirocco
Reserve". Cash out. Result: "Real position (0.52 cTSLAx)" and "Game boost (moves ×90)".*
> "My side and stake were encrypted while I picked them, so the climb starts at the click. xStocks
> trade around the clock, and so do gold and the pound here, so every market is live at any hour. My
> 50 plus 150 borrowed from the reserve sold real cTSLAx short at the Sirocco desk, and nobody can
> tell it from a long: the desk's transfers are the same both ways, all encrypted. Cash out: the desk
> takes the position back, the loan is repaid, and the game boost, every move counted 25 times, is
> settled with the reserve. One encrypted transfer pays me, in the same transaction."
*Result: "Settled on chain", open the transaction on Etherscan: the call and two public multipliers,
nothing else.*

**1:35 to 2:15 · The Sirocco Reserve.** *Bank icon: value locked, utilization, share price, APY,
"Last reveal". Deposit 100: "Encrypting the deposit…", the position decrypts.*
> "Lenders deposit confidential USDC and hold encrypted shares. They earn the interest and carry our
> gains and losses. The totals are revealed every ten minutes by Zama's KMS, with a proof the contract
> checks."

**2:15 to 2:45 · Share, verified.** *Share on X: "Reveal my return and share", the card renders
"Verified on Sepolia · run #N".*
> "If I want the glory, I publish my return: the KMS decrypts it with a proof, and the share card is
> built by the server from the chain, so nobody can fake a score. My stake stays encrypted."

**2:45 to 3:00 · Wrap-up.** *README confidentiality table, contract tests passing, FINDINGS.*
> "Encrypted sides, stakes, loans and payouts; a confidential lending pool; KMS-verified reveals; real
> assets as confidential tokens. All on Sepolia. Siroclimb: climb higher, privately."

## Tweet draft

> Siroclimb is live on @zama's FHEVM (Sepolia) 🪙
>
> Go long or short on real confidential xStocks, gold or GBP, 24/7: your stake + a loan from a
> confidential lending pool buys the actual tokens. Moves count ×25 to ×200 on the stairs, by market. Side, stake,
> trades and payout stay encrypted on-chain (ERC-7984).
>
> One signature to play: climb.sirocco.finance

(Before posting: attach a 20 s screen capture of a climb and the verified share card.)

## Checklist before submitting

- [ ] Record the video from the script above (Sepolia, a live market, the Etherscan tab ready)
- [ ] Re-run `tests/chain/battery-prod.mjs` the day before (FINDINGS: production battery)
- [ ] Top up the drip key if below 0.05 ETH (DEPLOYMENTS: server keys)
- [ ] Submit the form with the links at the top of this file

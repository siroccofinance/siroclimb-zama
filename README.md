# Siroclimb on Zama: a confidential climbing game

Pick a market, go long or short, and the Sirocco coin climbs a staircase that follows the price.
Your leverage climbs from 1x to 4x every 6 seconds over a 60-second run, and you cash out whenever
you want. Play alone against the house, or in timed rounds where everyone rides the same market and
the top 3 share the pot.

Siroclimb is about real world assets. The markets are tokenized stocks (Tesla, NVIDIA and Apple
xStocks), gold (XAUt) and the British pound. Stakes and payouts are in **Zama's confidential USDC**.

Built on the **Zama Protocol (FHEVM)** on Sepolia for the Zama Developer Program, Season 5:
Confidential Gaming.

- **Network**: Ethereum Sepolia
- **Stakes**: Zama's `cUSDCMock` (ERC-7984, shown as cUSDC), resolved and checked through Zama's
  Wrappers Registry
- **Contracts**: Solidity 0.8.27, `@fhevm/solidity` 0.11, OpenZeppelin confidential contracts 0.5,
  Pyth
- **Front**: static site (Three.js scene, ES modules), ethers 6, Zama relayer SDK 0.4.1 from Zama's
  CDN, two small server routes (Pyth, reference prices)

Contract addresses are in [DEPLOYMENTS.md](DEPLOYMENTS.md), bugs found on chain and their fixes in
[FINDINGS.md](FINDINGS.md), and the 3-minute video script in [DEMO.md](DEMO.md).

## How to play (judges)

1. Open the site, click **Start playing**, then **Connect wallet**. Use MetaMask or Rabby on
   Sepolia with about 0.05 Sepolia ETH.
2. Your wallet signs two transactions, once:
   - it approves the game as ERC-7984 operator of your cUSDC (30 days);
   - it starts a 7-day game session, which sends 0.03 Sepolia ETH to a session key kept in your
     browser.

   From then on the session key sends every game transaction for you, with no pop-ups. It can only
   play with the stake you approved and can never withdraw. On your first visit the faucet mints and
   wraps 1,000 test cUSDC for you.
3. Your balance is encrypted, so it shows **Decrypt**. Click it to decrypt it in your browser. Your
   wallet signs a decryption grant once a day.
4. **Solo**: pick a market, long or short, and a stake (10 to 100), then **Start climbing**. Your
   side and stake are encrypted in the browser and sealed on chain. The coin follows the live price
   and the leverage climbs every 6 s. **Cash out** with the button or the space bar. The contract
   computes your payout on ciphertexts and sends it as an encrypted transfer in the same
   transaction. The result screen then shows the settled values and the transaction link. You can
   post your return to the leaderboard: the return becomes public, your stake stays private.
5. **Round**: switch to Round, pick a side, then **Open a round** (or **Join**). Players have 60 s
   to join. If few players are around, the **practice bots** in your browser take the empty seats with
   their own encrypted sides. While the round is live, every other player shows as *Sealed*. At the
   bell your browser closes the round, the KMS decrypts the standings, the contract checks the proof,
   and your session claims your prize as an encrypted transfer.
6. The trophy icon shows the leaderboards (last round, today, all time). They list public results
   only: round standings and the runs players chose to post.

Stocks trade during US market hours (4:00 to 20:00 New York time, pre and post market included).
Outside those hours their chips show *Closed*, while gold and the pound stay open. A round only
opens on a market with a live price.

**Nothing has to run on our side.** Every keeper duty is a permissionless call, and the player's
browser does each one itself (autopilot):

- price checkpoints;
- settling a run at its 60th second;
- closing a round at the bell;
- the KMS reveal and `finalizeRound` with the proof.

The practice bots are real players whose keys come from your session key. An optional ops keeper
(`ops/keeper.mjs`) does the same duties.

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

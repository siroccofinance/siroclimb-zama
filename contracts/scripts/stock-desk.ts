/**
 * Stocks the Sirocco desk on a network: every market token (minted from its public underlying, wrapped
 * in the desk) and cUSDC for the shorts' sales. Idempotent: tokens with a `Stocked` event are skipped.
 * One nonce at a time, each transaction mined before the next (public RPC nodes lag behind each other).
 * Usage: npx hardhat run scripts/stock-desk.ts --network sepolia
 */
import { ethers, deployments } from "hardhat";
import { MARKETS } from "./markets";

const STOCK: Record<string, bigint> = { TSLAx: 100_000n, NVDAx: 200_000n, AAPLx: 100_000n, AMZNx: 100_000n, XAUt: 2_000n, tGBP: 1_000_000n, cUSDC: 500_000n };
const ERC20 = ["function mint(address,uint256)", "function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)", "function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [signer] = await ethers.getSigners();
  const desk = await ethers.getContractAt("SiroccoDesk", (await deployments.get("SiroccoDesk")).address, signer);
  const game = await ethers.getContractAt("Siroclimb", (await deployments.get("Siroclimb")).address);
  const deskAddr = await desk.getAddress();
  const stocked = new Set((await desk.queryFilter(desk.filters.Stocked(), (await deployments.get("SiroccoDesk")).receipt!.blockNumber)).map((e) => e.args.token.toLowerCase()));
  const targets: [string, string, bigint][] = [];
  for (const [i, m] of MARKETS.entries()) targets.push([await game.marketTokens(i), m.token.symbol, STOCK[m.id]]);
  targets.push([await desk.cash(), "cUSDC", STOCK.cUSDC]);
  let nonce = await ethers.provider.getTransactionCount(signer.address, "pending");
  const send = async (p: Promise<{ hash: string; wait: () => Promise<unknown> }>) => { const tx = await p; nonce++; await tx.wait(); };
  for (const [wrapper, label, whole] of targets) {
    if (stocked.has(wrapper.toLowerCase())) { console.log(`${label} already stocked`); continue; }
    const w = await ethers.getContractAt(["function underlying() view returns (address)"], wrapper);
    const u = await ethers.getContractAt(ERC20, await w.underlying(), signer);
    const unit = 10n ** BigInt(await u.decimals()), amount = whole * unit, perCall = 1_000_000n * unit;
    let have = await u.balanceOf(signer.address);
    while (have < amount) {
      const m = amount - have > perCall ? perCall : amount - have;
      await send(u.mint(signer.address, m, { nonce }));
      have += m;
    }
    if ((await u.allowance(signer.address, deskAddr)) < amount) await send(u.approve(deskAddr, amount, { nonce }));
    for (let i = 0; i < 30 && (await u.allowance(signer.address, deskAddr)) < amount; i++) await sleep(2000);
    await send(desk.stock(wrapper, amount, { nonce, gasLimit: 3_000_000 }));
    console.log(`stocked ${whole} ${label}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

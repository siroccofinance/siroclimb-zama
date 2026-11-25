import { FhevmType } from "@fhevm/hardhat-plugin";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import {
  AAPL,
  BASE,
  GBP,
  type Fixture,
  MAX_PAYOUT,
  USDC,
  XAUT,
  at,
  balance,
  decrypt64,
  deployFixture,
  model,
  payout,
  position,
  price,
  quotes,
  startRun,
} from "./helpers";

const STOCK = 1_000_000n * USDC;

/** The desk's (or the game's) encrypted balance of a market token, decrypted by the deployer (desk owner). */
async function deskBalance(f: Fixture, market: number) {
  const t = f.marketTokens[market];
  await f.desk.revealInventoryTo(await t.getAddress(), f.deployer.address);
  const h = await t.confidentialBalanceOf(f.deskAddress);
  return fhevm.userDecryptEuint(FhevmType.euint64, h, await t.getAddress(), f.deployer);
}
async function deskCash(f: Fixture) {
  await f.desk.revealInventoryTo(f.tokenAddress, f.deployer.address);
  return fhevm.userDecryptEuint(FhevmType.euint64, await f.token.confidentialBalanceOf(f.deskAddress), f.tokenAddress, f.deployer);
}
async function positionOf(f: Fixture, id: bigint) {
  const [qtyH, cashH, posH] = await f.game.positionHandles(id);
  return {
    qty: await fhevm.userDecryptEuint(FhevmType.euint64, qtyH, f.gameAddress, f.alice),
    cashLeg: await decrypt64(f, cashH, f.alice),
    value: posH === ethers.ZeroHash ? null : await decrypt64(f, posH, f.alice),
  };
}
/** ConfidentialTransfer events emitted by the run's transaction, per token contract. */
async function transfers(f: Fixture, tx: Promise<{ wait: () => Promise<unknown> }>) {
  const rc = (await (await tx).wait()) as { logs: { address: string; topics: string[] }[] };
  const topic = f.token.interface.getEvent("ConfidentialTransfer").topicHash;
  return rc.logs.filter((l) => l.topics[0] === topic).map((l) => l.address.toLowerCase()).sort();
}

describe("SiroccoDesk: every run holds real tokens", function () {
  let f: Fixture;

  beforeEach(async function () {
    if (!fhevm.isMock) this.skip();
    f = await deployFixture();
  });

  it("a long buys the market token with stake + borrowed cUSDC at the ask, and sells it at the bid", async function () {
    const stake = 50n * USDC;
    const before = await balance(f, f.alice);
    await price(f, AAPL, BASE[AAPL]);
    const id = await startRun(f, f.alice, AAPL, true, stake);
    const open = position(stake, true, BASE[AAPL], BASE[AAPL], 0);
    expect(open.qty).to.eq((stake * 4n * 10_000_000_000n) / quotes(BASE[AAPL]).ask);
    const p = await positionOf(f, id);
    expect(p.qty).to.eq(open.qty); // real cAAPLx in the game, for this run
    expect(p.cashLeg).to.eq(stake * 4n); // what it paid: 4x the stake
    expect(await deskBalance(f, AAPL)).to.eq(STOCK - open.qty);
    expect(await deskCash(f)).to.eq(100_000n * USDC + stake * 4n);

    const run = await f.game.getRun(id);
    const p1 = (BASE[AAPL] * 10_040n) / 10_000n; // +0.4 %
    await at(run.startAt, 13);
    await price(f, AAPL, p1);
    await at(run.startAt, 20);
    await f.game.connect(f.alice).cashOut(id, []);
    const pos = position(stake, true, BASE[AAPL], p1, 20);
    const mult = model([{ t: 0, p: BASE[AAPL] }, { t: 13, p: p1 }]).long;
    // the payout keeps the game scale; the real position is reported next to it
    const paid = payout(stake, mult, 20);
    expect(await balance(f, f.alice)).to.eq(before - stake + paid);
    expect((await positionOf(f, id)).value).to.eq(pos.value);
    expect(pos.value).to.be.gt(stake); // +0.4 % on 4x, minus the spread both ways and the interest
    expect(paid).to.be.gt(pos.value); // the game boost: x25 moves
    // the tokens went back to the desk, which paid the sale
    expect(await deskBalance(f, AAPL)).to.eq(STOCK);
    expect(await deskCash(f)).to.eq(100_000n * USDC + stake * 4n - pos.cashIn);
  });

  it("a short borrows the token from the desk and sells it, then buys it back at the ask and returns it", async function () {
    const stake = 40n * USDC;
    const before = await balance(f, f.alice);
    await price(f, XAUT, BASE[XAUT]);
    const id = await startRun(f, f.alice, XAUT, false, stake);
    const open = position(stake, false, BASE[XAUT], BASE[XAUT], 0);
    const p = await positionOf(f, id);
    expect(p.qty).to.eq(open.qty); // owed to the desk
    expect(p.cashLeg).to.eq(open.cashLeg); // what the sale brought in, at the bid
    expect(await deskBalance(f, XAUT)).to.eq(STOCK); // lent, then sold back to it
    expect(await deskCash(f)).to.eq(100_000n * USDC - open.cashLeg);

    const run = await f.game.getRun(id);
    const p1 = (BASE[XAUT] * 9_970n) / 10_000n; // -0.3 %
    await at(run.startAt, 8);
    await price(f, XAUT, p1);
    await at(run.startAt, 15);
    await f.game.connect(f.alice).cashOut(id, []);
    const pos = position(stake, false, BASE[XAUT], p1, 15);
    const mult = model([{ t: 0, p: BASE[XAUT] }, { t: 8, p: p1 }]).short;
    expect(await balance(f, f.alice)).to.eq(before - stake + payout(stake, mult, 15));
    expect((await positionOf(f, id)).value).to.eq(pos.value);
    expect(pos.value).to.be.gt(stake);
    expect(await deskBalance(f, XAUT)).to.eq(STOCK);
    expect(await deskCash(f)).to.eq(100_000n * USDC - open.cashLeg + pos.cashOut);
  });

  it("a long and a short move the same transfers: the side cannot be read from the trades", async function () {
    await price(f, GBP, BASE[GBP]);
    const long = await f.game.runCount();
    const eL = await (await import("./helpers")).encrypt(f, f.alice, true, 20n * USDC);
    const tL = await transfers(f, f.game.connect(f.alice).startRun(GBP, eL.handles[0], eL.handles[1], eL.proof, false, [], 0));
    const eS = await (await import("./helpers")).encrypt(f, f.bob, false, 20n * USDC);
    const tS = await transfers(f, f.game.connect(f.bob).startRun(GBP, eS.handles[0], eS.handles[1], eS.proof, false, [], 0));
    expect(tL).to.deep.eq(tS);
    const run = await f.game.getRun(long);
    await at(run.startAt, 10);
    const cL = await transfers(f, f.game.connect(f.alice).cashOut(long, []));
    const cS = await transfers(f, f.game.connect(f.bob).cashOut(long + 1n, []));
    expect(cL).to.deep.eq(cS);
  });

  it("quantities and the position stay private to the player", async function () {
    await price(f, AAPL, BASE[AAPL]);
    const id = await startRun(f, f.alice, AAPL, true, 10n * USDC);
    const [qtyH] = await f.game.positionHandles(id);
    await expect(fhevm.userDecryptEuint(FhevmType.euint64, qtyH, f.gameAddress, f.bob)).to.be.rejected;
  });

  it("only the game trades, and the game is set once", async function () {
    const zero = ethers.ZeroHash;
    await expect(f.desk.open.staticCall(0, f.tokenAddress, zero, zero, 1)).to.be.revertedWithCustomError(f.desk, "NotGame");
    await expect(f.desk.setGame.staticCall(f.alice.address)).to.be.revertedWithCustomError(f.desk, "GameAlreadySet");
    expect(await f.desk.spreadBps()).to.eq(10);
    expect(await f.game.marketTokens(XAUT)).to.eq(await f.marketTokens[XAUT].getAddress());
    expect(MAX_PAYOUT).to.be.gte(4n * 100n * USDC); // the public loan covers the largest position
  });
});

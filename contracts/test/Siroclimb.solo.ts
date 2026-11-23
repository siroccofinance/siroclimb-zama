import { FhevmType } from "@fhevm/hardhat-plugin";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import {
  BASE,
  AAPL,
  NVDA,
  type Fixture,
  FAUCET_AMOUNT,
  SCALE,
  USDC,
  XAUT,
  at,
  balance,
  decrypt32,
  decrypt64,
  deployFixture,
  encrypt,
  model,
  price,
  startRun,
} from "./helpers";

describe("Siroclimb: solo runs", function () {
  let f: Fixture;

  beforeEach(async function () {
    if (!fhevm.isMock) this.skip();
    f = await deployFixture();
  });

  async function runAndPath(long: boolean, stake: bigint, moves: [number, bigint][], exit: number, market = AAPL) {
    await price(f, market, BASE[market]); // fresh entry
    const id = await startRun(f, f.alice, market, long, stake);
    const run = await f.game.getRun(id);
    const pts = [{ t: 0, p: BASE[market] }];
    for (const [t, p] of moves) {
      await at(run.startAt, t);
      await price(f, market, p);
      pts.push({ t, p });
    }
    await at(run.startAt, exit);
    await f.game.connect(f.alice).cashOut(id, []);
    return { id, expected: model(pts), run: await f.game.getRun(id) };
  }

  it("pulls the encrypted stake and keeps side and stake private", async function () {
    const before = await balance(f, f.alice);
    const id = await startRun(f, f.alice, AAPL, true, 25n * USDC);
    expect(await balance(f, f.alice)).to.eq(before - 25n * USDC);
    const [longH, paidH] = await f.game.runHandles(id);
    expect(await fhevm.userDecryptEbool(longH, f.gameAddress, f.alice)).to.eq(true);
    expect(await decrypt64(f, paidH, f.alice)).to.eq(25n * USDC);
    // nobody else may decrypt the side or the stake
    await expect(fhevm.userDecryptEbool(longH, f.gameAddress, f.bob)).to.be.rejected;
    await expect(decrypt64(f, paidH, f.bob)).to.be.rejected;
    const run = await f.game.getRun(id);
    expect(run.status).to.eq(1);
    expect(run.entryPrice).to.eq(BASE[AAPL]);
  });

  it("a long cashed out on a rise is paid stake x multiplier in the same transaction", async function () {
    const stake = 40n * USDC;
    const before = await balance(f, f.alice);
    const p1 = (BASE[AAPL] * 10_010n) / 10_000n; // +0.1 % at 13 s (2x)
    const p2 = (BASE[AAPL] * 10_030n) / 10_000n; // +0.2 % more at 25 s (3x)
    const { id, expected, run } = await runAndPath(true, stake, [[13, p1], [25, p2]], 31);
    expect(run.multLong).to.eq(expected.long);
    expect(run.multShort).to.eq(expected.short);
    expect(expected.long).to.be.gt(SCALE);
    const paid = (stake * expected.long) / SCALE;
    expect(await balance(f, f.alice)).to.eq(before - stake + paid);
    const [, , valueH, multH] = await f.game.runHandles(id);
    expect(await decrypt64(f, valueH, f.alice)).to.eq(paid);
    expect(await decrypt32(f, multH, f.alice)).to.eq(expected.long);
    expect(run.topStep).to.eq(5);
  });

  it("a short on the same path gets the mirror multiplier", async function () {
    const stake = 10n * USDC;
    const before = await balance(f, f.alice);
    const p1 = (BASE[AAPL] * 9_985n) / 10_000n;
    const { expected, run } = await runAndPath(false, stake, [[20, p1]], 22);
    expect(run.multShort).to.eq(expected.short);
    expect(expected.short).to.be.gt(SCALE);
    expect(await balance(f, f.alice)).to.eq(before - stake + (stake * expected.short) / SCALE);
  });

  it("the coin falls at -100 % and stays down even if the price comes back", async function () {
    const stake = 10n * USDC;
    const before = await balance(f, f.alice);
    const crash = (BASE[AAPL] * 9_850n) / 10_000n; // -1.5 % at 4x x25 = -150 %
    const back = (BASE[AAPL] * 10_200n) / 10_000n;
    const { expected, run } = await runAndPath(true, stake, [[37, crash], [43, back]], 50);
    expect(expected.long).to.eq(0n);
    expect(run.multLong).to.eq(0);
    expect(await balance(f, f.alice)).to.eq(before - stake);
  });

  it("anyone settles an expired run at its 60th second, whenever they call", async function () {
    const stake = 20n * USDC;
    const before = await balance(f, f.alice);
    const id = await startRun(f, f.alice, NVDA, true, stake);
    const run = await f.game.getRun(id);
    await at(run.startAt, 30);
    await price(f, NVDA, (BASE[NVDA] * 10_010n) / 10_000n);
    await at(run.startAt, 59);
    await expect(f.game.connect(f.bob).settleRun(id)).to.be.revertedWithCustomError(f.game, "RunNotOver");
    await at(run.startAt, 70);
    await price(f, NVDA, (BASE[NVDA] * 9_000n) / 10_000n); // after the bell: must not count
    await time.increase(100);
    await f.game.connect(f.bob).settleRun(id);
    const end = await f.game.getRun(id);
    expect(end.endAt).to.eq(run.startAt + 60n);
    const expected = model([
      { t: 0, p: BASE[NVDA] },
      { t: 30, p: (BASE[NVDA] * 10_010n) / 10_000n },
    ]);
    expect(end.multLong).to.eq(expected.long);
    expect(await balance(f, f.alice)).to.eq(before - stake + (stake * expected.long) / SCALE);
    await expect(f.game.settleRun(id)).to.be.revertedWithCustomError(f.game, "WrongRunStatus");
  });

  it("only the player (or their session) cashes out", async function () {
    const id = await startRun(f, f.alice, AAPL, true, 10n * USDC);
    await expect(f.game.connect(f.bob).cashOut(id, [])).to.be.revertedWithCustomError(f.game, "NotPlayer");
  });

  it("clamps the stake to 100 cUSDC on ciphertexts", async function () {
    const before = await balance(f, f.alice);
    const id = await startRun(f, f.alice, AAPL, true, 500n * USDC);
    const [, paidH] = await f.game.runHandles(id);
    expect(await decrypt64(f, paidH, f.alice)).to.eq(100n * USDC);
    expect(await balance(f, f.alice)).to.eq(before - 100n * USDC);
  });

  it("an unfunded stake moves 0 and is paid 0, without revealing the balance", async function () {
    const poor = f.players[5];
    await f.token.connect(poor).setOperator(f.gameAddress, (await time.latest()) + 3600);
    const id = await startRun(f, poor, AAPL, true, 10n * USDC);
    const [, paidH] = await f.game.runHandles(id);
    expect(await decrypt64(f, paidH, poor)).to.eq(0n);
    const run = await f.game.getRun(id);
    await at(run.startAt, 10);
    await price(f, AAPL, (BASE[AAPL] * 10_100n) / 10_000n);
    await f.game.connect(poor).cashOut(id, []);
    expect(await balance(f, poor)).to.eq(0n);
  });

  it("refuses a stale entry price", async function () {
    await time.increase(31);
    const { handles, proof } = await encrypt(f, f.alice, true, 10n * USDC);
    await expect(f.game.connect(f.alice).startRun(AAPL, handles[0], handles[1], proof, false, [])).to.be.revertedWithCustomError(
      f.game,
      "StaleEntry",
    );
    await expect(f.game.connect(f.alice).startRun(9, handles[0], handles[1], proof, false, [])).to.be.revertedWithCustomError(
      f.game,
      "UnknownMarket",
    );
  });

  it("a signed Pyth update can ride along on entry and exit", async function () {
    const feed = await f.oracle.feedIds();
    const now = await time.latest();
    const upd = await f.pyth.createPriceFeedUpdateData(feed[AAPL], 61_500n * 10n ** 8n, 10n, -8, 61_500n * 10n ** 8n, 10n, now + 1, now);
    const { handles, proof } = await encrypt(f, f.alice, true, 10n * USDC);
    await time.setNextBlockTimestamp(now + 1);
    await f.game.connect(f.alice).startRun(AAPL, handles[0], handles[1], proof, false, [upd], { value: 1 });
    const id = (await f.game.runCount()) - 1n;
    const run = await f.game.getRun(id);
    expect(run.entryPrice).to.eq(61_500n * 10n ** 10n);
    const upd2 = await f.pyth.createPriceFeedUpdateData(feed[AAPL], 61_530n * 10n ** 8n, 10n, -8, 61_530n * 10n ** 8n, 10n, now + 20, now + 1);
    await time.setNextBlockTimestamp(now + 20);
    await f.game.connect(f.alice).cashOut(id, [upd2], { value: 1 });
    const end = await f.game.getRun(id);
    expect(end.exitPrice).to.eq(61_530n * 10n ** 10n);
    expect(end.multLong).to.eq(model([
      { t: 0, p: 61_500n * 10n ** 10n },
      { t: 19, p: 61_530n * 10n ** 10n },
    ]).long);
  });

  it("the bounded fallback market (XAUT) settles like any other", async function () {
    const before = await balance(f, f.alice);
    const p1 = (BASE[XAUT] * 10_040n) / 10_000n;
    const { expected } = await runAndPath(true, 10n * USDC, [[11, p1]], 15, XAUT);
    expect(await balance(f, f.alice)).to.eq(before - 10n * USDC + (10n * USDC * expected.long) / SCALE);
  });

  it("keeps a reserve able to pay any live run at its maximum", async function () {
    expect(await f.game.reserveFloor()).to.eq(0n);
    await startRun(f, f.alice, AAPL, true, 10n * USDC);
    const max = await f.game.MAX_PAYOUT();
    expect(await f.game.reserveFloor()).to.eq(1_000_000n * USDC - max);
    // the house balance is encrypted: the owner of the contract cannot read it either
    const h = await f.token.confidentialBalanceOf(f.gameAddress);
    await expect(fhevm.userDecryptEuint(FhevmType.euint64, h, f.tokenAddress, f.deployer)).to.be.rejected;
  });

  it("publishes a finished run on the leaderboard with the KMS proof, forged values rejected", async function () {
    const p1 = (BASE[AAPL] * 10_020n) / 10_000n;
    const { id, expected } = await runAndPath(true, 30n * USDC, [[8, p1]], 12);
    await expect(f.game.connect(f.bob).publishRun(id)).to.be.revertedWithCustomError(f.game, "NotPlayer");
    await f.game.connect(f.alice).publishRun(id);
    const [, , , multH] = await f.game.runHandles(id);
    const res = await fhevm.publicDecrypt([multH]);
    const mult = res.clearValues[multH] as bigint;
    expect(mult).to.eq(expected.long);
    await expect(f.game.recordRun(id, mult + 1n, res.decryptionProof)).to.be.reverted;
    await f.game.connect(f.bob).recordRun(id, mult, res.decryptionProof);
    expect(await f.game.resultCount()).to.eq(1n);
    const [r] = await f.game.results(0, 10);
    expect(r.player).to.eq(f.alice.address);
    expect(r.pnlPpm).to.eq(Number(expected.long - SCALE));
    expect(r.inRound).to.eq(false);
    await expect(f.game.recordRun(id, mult, res.decryptionProof)).to.be.revertedWithCustomError(f.game, "WrongRunStatus");
    // the stake is still private
    const [, paidH] = await f.game.runHandles(id);
    await expect(decrypt64(f, paidH, f.bob)).to.be.rejected;
  });

  it("faucet: claim for anyone, once per cooldown", async function () {
    const p = f.players[6];
    await f.faucet.connect(f.bob).claimFor(p.address);
    expect(await balance(f, p)).to.eq(FAUCET_AMOUNT);
    await expect(f.faucet.claimFor(p.address)).to.be.revertedWithCustomError(f.faucet, "FaucetCooldown");
    expect(await f.faucet.waitOf(p.address)).to.be.gt(0n);
    await time.increase(601);
    await f.faucet.connect(p).claim();
    expect(await balance(f, p)).to.eq(2n * FAUCET_AMOUNT);
    expect(ethers.isAddress(await f.faucet.underlying())).to.eq(true);
  });
});

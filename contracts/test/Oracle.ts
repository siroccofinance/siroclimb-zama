import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { fhevm } from "hardhat";
import { BASE, AAPL, NVDA, type Fixture, GBP, NVDA, TSLA, XAUT, deployFixture, joinRound, model } from "./helpers";

describe("ClimbPriceOracle and ClimbLadder", function () {
  let f: Fixture;

  beforeEach(async function () {
    if (!fhevm.isMock) this.skip();
    f = await deployFixture({ fund: 2 });
  });

  async function pythUpdate(market: number, price: bigint, publishTime: number) {
    const feed = (await f.oracle.feedIds())[market];
    return f.pyth.createPriceFeedUpdateData(feed, price, 10n, -8, price, 10n, publishTime, publishTime - 1);
  }

  it("only updaters push trusted checkpoints; one per market and block", async function () {
    await expect(f.oracle.connect(f.alice).pushPrices.staticCall([AAPL], [1n])).to.be.revertedWithCustomError(f.oracle, "NotUpdater");
    await expect(f.oracle.pushPrices([AAPL], [0n])).to.be.revertedWithCustomError(f.oracle, "ZeroPrice");
    await expect(f.oracle.pushPrices([9], [1n])).to.be.revertedWithCustomError(f.oracle, "UnknownMarket");
    await expect(f.oracle.pushPrices([AAPL, AAPL], [1n, 2n])).to.be.revertedWithCustomError(f.oracle, "TooSoon");
    await expect(f.oracle.pushPrices([AAPL], [1n, 2n])).to.be.revertedWithCustomError(f.oracle, "LengthMismatch");
    const [idx, , p, src] = await f.oracle.latest(AAPL);
    expect(idx).to.eq(0n);
    expect(p).to.eq(BASE[AAPL]);
    expect(src).to.eq(0);
  });

  it("pushPyth writes every fresh Pyth market, skips stale ones and refunds the fee excess", async function () {
    const now = await time.latest();
    const u1 = await pythUpdate(NVDA, 172_500_000_000n, now + 1);
    const u2 = await pythUpdate(TSLA, 38_700_000_000n, now - 100); // stale (market closed): not taken
    await time.setNextBlockTimestamp(now + 1);
    const mask = await f.oracle.connect(f.alice).pushPyth.staticCall([u1, u2], { value: 10 });
    expect(mask).to.eq(1n << BigInt(NVDA));
    await f.oracle.connect(f.alice).pushPyth([u1, u2], { value: 10 });
    const [, ts, p, src] = await f.oracle.latest(NVDA);
    expect(ts).to.eq(BigInt(now + 1));
    expect(p).to.eq(1725n * 10n ** 10n);
    expect(src).to.eq(1);
    expect((await f.oracle.latest(TSLA))[3]).to.eq(0); // still the seed
    expect(await f.oracle.lastPythPlusOne(NVDA)).to.eq(2n);
    // the same update again in a later block: nothing newer, nothing written, no revert
    await f.oracle.pushPyth([u1], { value: 1 });
    expect(await f.oracle.checkpointCount(NVDA)).to.eq(3n); // Pyth still answers the fresh price: a new checkpoint
  });

  it("pushPublic: bounded, spaced, refused while Pyth is fresh", async function () {
    await expect(f.oracle.connect(f.alice).pushPublic([XAUT], [BASE[XAUT]])).to.be.revertedWithCustomError(f.oracle, "TooSoon");
    await time.increase(10);
    await expect(f.oracle.connect(f.alice).pushPublic([XAUT], [(BASE[XAUT] * 10_060n) / 10_000n])).to.be.revertedWithCustomError(
      f.oracle,
      "PriceJump",
    );
    await f.oracle.connect(f.alice).pushPublic([XAUT, GBP, NVDA], [(BASE[XAUT] * 10_050n) / 10_000n, BASE[GBP], BASE[NVDA]]);
    expect((await f.oracle.latest(XAUT))[3]).to.eq(2);
    // a market Pyth just priced (NVDA, at its base price) refuses public checkpoints
    const now = await time.latest();
    await time.setNextBlockTimestamp(now + 1);
    await f.oracle.pushPyth([await pythUpdate(NVDA, 16_500_000_000n, now + 1)], { value: 1 });
    await time.increase(30);
    await expect(f.oracle.pushPublic([NVDA], [BASE[NVDA]])).to.be.revertedWithCustomError(f.oracle, "PythIsFresh");
    // once Pyth is stale, the fallback takes over, within 3 % of the last Pyth price
    await time.increase(120);
    await f.oracle.pushPublic([NVDA], [(BASE[NVDA] * 10_040n) / 10_000n]);
    for (let i = 0; i < 6; i++) {
      await time.increase(10);
      const [, , last] = await f.oracle.latest(NVDA);
      const next = (last * 10_049n) / 10_000n;
      if (next * 10_000n > BASE[NVDA] * 10_300n) {
        await expect(f.oracle.pushPublic([NVDA], [next])).to.be.revertedWithCustomError(f.oracle, "PriceJump");
        return;
      }
      await f.oracle.pushPublic([NVDA], [next]);
    }
    expect.fail("the Pyth drift bound never applied");
  });

  it("indexAtOrBefore and path read the checkpoints known at a time", async function () {
    const t0 = await time.latest();
    for (let i = 1; i <= 5; i++) {
      await time.setNextBlockTimestamp(t0 + 10 * i);
      await f.oracle.pushPrices([AAPL], [BASE[AAPL] + BigInt(i)]);
    }
    expect(await f.oracle.indexAtOrBefore(AAPL, t0 + 25)).to.eq(2n);
    expect(await f.oracle.indexAtOrBefore(AAPL, t0 + 50)).to.eq(5n);
    await expect(f.oracle.indexAtOrBefore(AAPL, 1)).to.be.revertedWithCustomError(f.oracle, "NoCheckpointBefore");
    const [ts, px] = await f.oracle.path(AAPL, 1, t0 + 35, 64);
    expect(ts.length).to.eq(3);
    expect(px[2]).to.eq(BASE[AAPL] + 3n);
    const [ts2] = await f.oracle.path(AAPL, 1, t0 + 100, 2);
    expect(ts2.length).to.eq(2);
  });

  it("the ladder matches the TypeScript model on random paths, both sides", async function () {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let trial = 0; trial < 6; trial++) {
      const t0 = await time.latest();
      const [i0] = await f.oracle.latest(NVDA);
      const [, , p0] = await f.oracle.latest(NVDA);
      const pts = [{ t: 0, p: p0 }];
      let t = 0;
      let p = p0;
      for (let k = 0; k < 6; k++) {
        t += 3 + Math.floor(rnd() * 12);
        p = (p * BigInt(Math.round(10_000 + (rnd() - 0.5) * 60))) / 10_000n;
        await time.setNextBlockTimestamp(t0 + t);
        await f.oracle.pushPrices([NVDA], [p]);
        pts.push({ t, p });
      }
      const exp = model(pts);
      const [l, s, exit] = await f.ladder.multipliers(NVDA, i0, t0, t0 + t, 6);
      expect([l, s]).to.deep.eq([exp.long, exp.short]);
      expect(exit).to.eq(p);
      const capped = model(pts, 2);
      const [lc, sc] = await f.ladder.multipliers(NVDA, i0, t0, t0 + t, 2);
      expect([lc, sc]).to.deep.eq([capped.long, capped.short]);
    }
    expect(await f.ladder.ladder()).to.deep.eq([10n, 15n, 20n, 25n, 30n, 35n, 40n]);
  });

  it("a round only opens on a market with a live price (closed stock market skipped)", async function () {
    await time.increase(120); // every seed is stale now
    await f.oracle.pushPrices([NVDA], [BASE[NVDA]]); // only NVDA is live
    expect(await f.game.nextRoundMarket()).to.eq(NVDA); // rotation starts at TSLA, which is closed
    const { roundId } = await joinRound(f, f.alice, true, 0n);
    expect((await f.game.getRound(roundId))[0].market).to.eq(NVDA);
  });
});

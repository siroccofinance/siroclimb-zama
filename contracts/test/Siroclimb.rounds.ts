import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { fhevm } from "hardhat";
import {
  BASE,
  AAPL,
  ENTRY,
  NVDA,
  type Fixture,
  JOIN_SECONDS,
  SCALE,
  TSLA,
  at,
  balance,
  balances,
  closeAndFinalize,
  decrypt32,
  deployFixture,
  encrypt,
  joinRound,
  model,
  price,
} from "./helpers";

describe("Siroclimb: rounds", function () {
  let f: Fixture;

  beforeEach(async function () {
    if (!fhevm.isMock) this.skip();
    f = await deployFixture({ fund: 6 });
  });

  it("the first join opens the round on the announced market, later joins fill it", async function () {
    expect(await f.game.nextRoundMarket()).to.eq(TSLA);
    const a = await joinRound(f, f.alice, true, 0n);
    const [r, ids] = await f.game.getRound(0);
    expect(r.market).to.eq(TSLA);
    expect(r.startsAt - r.opensAt).to.eq(BigInt(JOIN_SECONDS));
    expect(r.endsAt - r.startsAt).to.eq(60n);
    expect(ids).to.deep.eq([a.runId]);
    await joinRound(f, f.bob, false, 0n);
    expect((await f.game.getRound(0))[1].length).to.eq(2);
    expect(await f.game.nextRoundMarket()).to.eq(NVDA);
    // nobody can read another player's side
    const [longH] = await f.game.runHandles(a.runId);
    await expect(fhevm.userDecryptEbool(longH, f.gameAddress, f.bob)).to.be.rejected;
  });

  it("rejects wrong round ids, double joins and late joins (a late join opens the next round)", async function () {
    await expect(joinRound(f, f.alice, true, 1n)).to.be.revertedWithCustomError(f.game, "RoundNotJoinable");
    await joinRound(f, f.alice, true, 0n);
    await expect(joinRound(f, f.alice, false, 0n)).to.be.revertedWithCustomError(f.game, "AlreadyJoined");
    await expect(joinRound(f, f.bob, false, 1n)).to.be.revertedWithCustomError(f.game, "RoundNotJoinable");
    const [r] = await f.game.getRound(0);
    await time.setNextBlockTimestamp(Number(r.startsAt));
    await expect(joinRound(f, f.bob, false, 0n)).to.be.revertedWithCustomError(f.game, "RoundNotJoinable");
    const b = await joinRound(f, f.bob, false, 1n);
    const [r1] = await f.game.getRound(1);
    expect(r1.market).to.eq(NVDA);
    expect((await f.game.getRun(b.runId)).roundId).to.eq(1);
  });

  it("cash out only once live; standings stay encrypted until the close; prizes 50/30/20", async function () {
    const [alice, bob, carol, dave] = f.players;
    const before = await balances(f, [alice, bob, carol, dave]);
    await joinRound(f, alice, true, 0n); // long, rides to the end
    const b = await joinRound(f, bob, false, 0n); // short, cashes out early
    await joinRound(f, carol, true, 0n); // long, rides
    const d = await joinRound(f, dave, false, 0n); // short, rides
    expect(await balance(f, alice)).to.eq(before[0] - ENTRY);
    const [r] = await f.game.getRound(0);
    await expect(f.game.connect(bob).cashOut(b.runId, [])).to.be.revertedWithCustomError(f.game, "RoundNotLive");

    await at(r.startsAt, -1);
    await price(f, TSLA, BASE[TSLA]); // entry checkpoint just before the bell
    await at(r.startsAt, 8);
    const p1 = (BASE[TSLA] * 9_990n) / 10_000n;
    await price(f, TSLA, p1);
    await at(r.startsAt, 10);
    await f.game.connect(bob).cashOut(b.runId, []);
    await at(r.startsAt, 40);
    const p2 = (BASE[TSLA] * 10_020n) / 10_000n;
    await price(f, TSLA, p2);
    // live: scores exist only as ciphertexts the owner can read
    const bobScore = (await f.game.runHandles(b.runId))[4];
    const bobMult = model([{ t: -1, p: BASE[TSLA] }, { t: 8, p: p1 }]).short;
    expect(await decrypt32(f, bobScore, bob)).to.eq(bobMult + 1n);
    await expect(decrypt32(f, bobScore, alice)).to.be.rejected;
    await expect(f.game.closeRound(0)).to.be.revertedWithCustomError(f.game, "RoundNotOver");

    await at(r.endsAt, 5);
    const scores = await closeAndFinalize(f, 0n);
    const path = [{ t: -1, p: BASE[TSLA] }, { t: 8, p: p1 }, { t: 40, p: p2 }];
    const full = model(path);
    expect(scores).to.deep.eq([full.long + 1n, bobMult + 1n, full.long + 1n, full.short + 1n]);
    // alice and carol tie for 1st (share 50 + 30 %), bob 3rd (20 %), dave last
    const pot = 4n * ENTRY;
    const after = await balances(f, [alice, bob, carol, dave]);
    expect(after[0] - before[0]).to.eq((pot * 8000n) / 10000n / 2n - ENTRY);
    expect(after[2] - before[2]).to.eq((pot * 8000n) / 10000n / 2n - ENTRY);
    expect(after[1] - before[1]).to.eq((pot * 2000n) / 10000n - ENTRY);
    expect(after[3] - before[3]).to.eq(-ENTRY);
    const [rd] = await f.game.getRound(0);
    expect(rd.status).to.eq(3);
    expect(rd.pot).to.eq(pot);
    const res = await f.game.results(0, 10);
    expect(res.map((x) => Number(x.rank))).to.deep.eq([1, 1, 3, 4]);
    expect(res[0].pnlPpm).to.eq(Number(full.long - SCALE));
  });

  it("forged standings are rejected", async function () {
    await joinRound(f, f.alice, true, 0n);
    await joinRound(f, f.bob, false, 0n);
    const [r] = await f.game.getRound(0);
    await at(r.endsAt, 1);
    await f.game.closeRound(0);
    const handles = await f.game.roundScoreHandles(0);
    const res = await fhevm.publicDecrypt([...handles]);
    const scores = handles.map((h) => res.clearValues[h] as bigint);
    await expect(f.game.finalizeRound(0, [scores[1] + 5n, scores[0]], res.decryptionProof)).to.be.reverted;
    await expect(f.game.finalizeRound(0, [scores[0]], res.decryptionProof)).to.be.revertedWithCustomError(f.game, "LengthMismatch");
    await f.game.finalizeRound(0, scores, res.decryptionProof);
    await expect(f.game.finalizeRound(0, scores, res.decryptionProof)).to.be.revertedWithCustomError(f.game, "WrongRoundStatus");
  });

  it("an unfunded entry ranks last, wins nothing and does not count in the pot", async function () {
    const poor = f.players[10];
    await f.token.connect(poor).setOperator(f.gameAddress, (await time.latest()) + 3600);
    const before = await balance(f, f.alice);
    await joinRound(f, poor, true, 0n);
    await joinRound(f, f.alice, false, 0n);
    const [r] = await f.game.getRound(0);
    await at(r.startsAt, 20);
    await price(f, TSLA, (BASE[TSLA] * 10_030n) / 10_000n); // the long (unfunded) would have won
    await at(r.endsAt, 1);
    const scores = await closeAndFinalize(f, 0n);
    expect(scores[0]).to.eq(0n);
    const [rd] = await f.game.getRound(0);
    expect(rd.fundedCount).to.eq(1);
    expect(rd.pot).to.eq(ENTRY);
    expect(await balance(f, f.alice)).to.eq(before); // alone in the pot: gets the whole pot back
    expect(await balance(f, poor)).to.eq(0n);
  });

  it("two players split 62.5 / 37.5 (50 / 30 renormalised)", async function () {
    const before = await balances(f, [f.alice, f.bob]);
    await joinRound(f, f.alice, true, 0n);
    await joinRound(f, f.bob, false, 0n);
    const [r] = await f.game.getRound(0);
    await at(r.startsAt, 30);
    await price(f, TSLA, (BASE[TSLA] * 9_995n) / 10_000n);
    await at(r.endsAt, 1);
    await closeAndFinalize(f, 0n);
    const pot = 2n * ENTRY;
    expect((await balance(f, f.bob)) - before[1]).to.eq((pot * 5000n) / 8000n - ENTRY);
    expect((await balance(f, f.alice)) - before[0]).to.eq((pot * 3000n) / 8000n - ENTRY);
  });

  it("rotates markets and caps players", async function () {
    for (let i = 0; i < 3; i++) {
      const id = await f.game.roundCount();
      await joinRound(f, f.alice, true, id);
      const [r] = await f.game.getRound(id);
      expect(r.market).to.eq([TSLA, NVDA, AAPL][i]);
      await time.setNextBlockTimestamp(Number(r.startsAt) + 1);
    }
    expect(await f.game.MAX_ROUND_PLAYERS()).to.eq(24n);
  });

  it("refunds every entry when the round was never finalized for a day", async function () {
    const before = await balance(f, f.alice);
    await joinRound(f, f.alice, true, 0n);
    await joinRound(f, f.bob, true, 0n);
    const [r] = await f.game.getRound(0);
    await at(r.endsAt, 1);
    await f.game.closeRound(0);
    await expect(f.game.refundRound(0)).to.be.revertedWithCustomError(f.game, "TooEarly");
    await time.increase(24 * 3600);
    await f.game.refundRound(0);
    expect(await balance(f, f.alice)).to.eq(before);
    await expect(f.game.refundRound(0)).to.be.revertedWithCustomError(f.game, "WrongRoundStatus");
  });

  it("a full round of 24 closes and finalizes within the gas and HCU budget", async function () {
    const all = f.players.slice(0, 24);
    const until = (await time.latest()) + 3600 * 24;
    for (const p of all.slice(6)) {
      await f.faucet.claimFor(p.address);
      await f.token.connect(p).setOperator(f.gameAddress, until);
    }
    for (let i = 0; i < all.length; i++) await joinRound(f, all[i], i % 2 === 0, 0n);
    const extra = f.players[25];
    const { handles, proof } = await encrypt(f, extra, true);
    await expect(f.game.connect(extra).joinRound(0, handles[0], proof)).to.be.revertedWithCustomError(f.game, "RoundFull");
    const [r] = await f.game.getRound(0);
    for (let k = 1; k <= 6; k++) {
      await at(r.startsAt, k * 9);
      await price(f, TSLA, (BASE[TSLA] * BigInt(10_000 + (k % 2 ? 7 : -4) * k)) / 10_000n);
    }
    await at(r.endsAt, 1);
    const tx = await f.game.closeRound(0);
    const rc = await tx.wait();
    expect(rc!.gasUsed).to.be.lt(16_000_000n);
    const hs = await f.game.roundScoreHandles(0);
    const res = await fhevm.publicDecrypt([...hs]);
    const tx2 = await f.game.finalizeRound(0, hs.map((h) => res.clearValues[h] as bigint), res.decryptionProof);
    expect((await tx2.wait())!.gasUsed).to.be.lt(16_000_000n);
    expect(await f.game.resultCount()).to.eq(24n);
  });
});

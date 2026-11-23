import type { ContractTransactionResponse } from "ethers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { fhevm } from "hardhat";
import { BASE, NVDA, type Fixture, TSLA, USDC, at, deployFixture, encrypt, joinRound, price } from "./helpers";

// Per-transaction limits of the Zama coprocessor (HCU = homomorphic complexity units).
const GLOBAL_LIMIT = 20_000_000;
const DEPTH_LIMIT = 5_000_000;
const report: { tx: string; globalHCU: number; maxHCUDepth: number; gas: string }[] = [];

async function measure(label: string, tx: Promise<ContractTransactionResponse>) {
  const receipt = await (await tx).wait();
  const info = fhevm.computeTransactionHCU(receipt!);
  report.push({ tx: label, globalHCU: info.globalHCU, maxHCUDepth: info.maxHCUDepth, gas: receipt!.gasUsed.toString() });
  expect(info.globalHCU, `${label} global HCU`).to.be.lt(GLOBAL_LIMIT);
  expect(info.maxHCUDepth, `${label} HCU depth`).to.be.lt(DEPTH_LIMIT);
}

describe("Siroclimb: HCU budget (worst cases)", function () {
  let f: Fixture;

  before(function () {
    if (!fhevm.isMock) this.skip();
  });
  after(function () {
    if (report.length) console.table(report);
  });
  beforeEach(async function () {
    f = await deployFixture({ fund: 24 });
  });

  it("solo: start (with reserve refill), packed start, cash out, packed cash out", async function () {
    await price(f, NVDA, BASE[NVDA]);
    let e = await encrypt(f, f.alice, true, 10n * USDC);
    await measure("startRun (first: reserve refill)", f.game.connect(f.alice).startRun(NVDA, e.handles[0], e.handles[1], e.proof, false, [], 0));
    await measure("openPack", f.game.connect(f.bob).openPack());
    e = await encrypt(f, f.bob, false, 10n * USDC);
    await measure("startRun (packed)", f.game.connect(f.bob).startRun(NVDA, e.handles[0], e.handles[1], e.proof, true, [], 0));
    const run = await f.game.getRun(0);
    for (let k = 1; k <= 5; k++) {
      await at(run.startAt, k * 10);
      await price(f, NVDA, (BASE[NVDA] * BigInt(10_000 + k)) / 10_000n);
    }
    await measure("cashOut (solo, encrypted payout)", f.game.connect(f.alice).cashOut(0, []));
    await measure("cashOut (packed: 4 capped paths)", f.game.connect(f.bob).cashOut(1, []));
    await measure("publishRun", f.game.connect(f.alice).publishRun(0));
  });

  it("round: join, cash out, close and finalize a full round", async function () {
    const players = f.players.slice(0, 24);
    for (let i = 0; i < players.length; i++) {
      const enc = await encrypt(f, players[i], i % 3 === 0);
      await measure(i === 0 ? "joinRound (opens)" : `joinRound`, f.game.connect(players[i]).joinRound(0, enc.handles[0], enc.proof));
    }
    const [r] = await f.game.getRound(0);
    await at(r.startsAt, 12);
    await price(f, TSLA, (BASE[TSLA] * 10_004n) / 10_000n);
    await measure("cashOut (round, encrypted score)", f.game.connect(players[0]).cashOut(0, []));
    await at(r.endsAt, 1);
    await measure("closeRound (23 runs at the bell, 24 reveals)", f.game.closeRound(0));
    const hs = await f.game.roundScoreHandles(0);
    const res = await fhevm.publicDecrypt([...hs]);
    await measure(
      "finalizeRound (KMS proof, 3 prizes)",
      f.game.finalizeRound(0, hs.map((h) => res.clearValues[h] as bigint), res.decryptionProof),
    );
    expect(await time.latest()).to.be.gt(0);
  });
});

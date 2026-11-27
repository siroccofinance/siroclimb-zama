import type { ContractTransactionResponse } from "ethers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { fhevm } from "hardhat";
import { BASE, NVDA, type Fixture, USDC, at, deployFixture, encrypt, price } from "./helpers";

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
    f = await deployFixture();
  });

  it("start (borrows from the reserve), packed start, cash out (interest, repays the reserve), packed cash out", async function () {
    await price(f, NVDA, BASE[NVDA]);
    let e = await encrypt(f, f.alice, true, 10n * USDC);
    await measure("startRun (borrows from the reserve)", f.game.connect(f.alice).startRun(NVDA, e.handles[0], e.handles[1], e.proof, false, [], 0));
    await measure("openPack", f.game.connect(f.bob).openPack());
    e = await encrypt(f, f.bob, false, 10n * USDC);
    await measure("startRun (packed)", f.game.connect(f.bob).startRun(NVDA, e.handles[0], e.handles[1], e.proof, true, [], 0));
    const run = await f.game.getRun(0);
    for (let k = 1; k <= 5; k++) {
      await at(run.startAt, k * 10);
      await price(f, NVDA, (BASE[NVDA] * BigInt(10_000 + k)) / 10_000n);
    }
    await measure("cashOut (solo, encrypted payout)", f.game.connect(f.alice).cashOut(0, [], 0));
    await measure("cashOut (packed: 4 capped paths)", f.game.connect(f.bob).cashOut(1, [], 0));
    await measure("publishRun", f.game.connect(f.alice).publishRun(0));
  });

  it("reserve: encrypted deposit, encrypted withdrawal, sync request", async function () {
    await f.token.connect(f.alice).setOperator(f.reserveAddress, (await time.latest()) + 3600);
    const enc = async (v: bigint) => {
      const input = fhevm.createEncryptedInput(f.reserveAddress, f.alice.address);
      input.add64(v);
      const e = await input.encrypt();
      return [e.handles[0], e.inputProof] as const;
    };
    await measure("reserve deposit (encrypted, shares at the synced price)", f.reserve.connect(f.alice).deposit(...(await enc(100n * USDC))));
    await measure("reserve withdraw (all or nothing on ciphertexts)", f.reserve.connect(f.alice).withdraw(...(await enc(40n * USDC))));
    await measure("reserve requestSync (3 public decryptions)", f.reserve.requestSync());
  });
});

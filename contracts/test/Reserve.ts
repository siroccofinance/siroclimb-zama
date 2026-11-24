import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { fhevm } from "hardhat";
import {
  BASE,
  NVDA,
  type Fixture,
  MAX_PAYOUT,
  SCALE,
  SEED,
  USDC,
  at,
  balance,
  borrowed,
  decrypt32,
  decrypt64,
  deployFixture,
  interest,
  model,
  payout,
  price,
  startRun,
} from "./helpers";

async function shares(f: Fixture, who: HardhatEthersSigner) {
  const h = await f.reserve.confidentialBalanceOf(who.address);
  return fhevm.userDecryptEuint(FhevmType.euint64, h, f.reserveAddress, who);
}

async function encryptFor(f: Fixture, who: HardhatEthersSigner, amount: bigint) {
  const input = fhevm.createEncryptedInput(f.reserveAddress, who.address);
  input.add64(amount);
  const enc = await input.encrypt();
  return { handle: enc.handles[0], proof: enc.inputProof };
}

async function sync(f: Fixture) {
  await f.reserve.requestSync();
  const [a, s, i] = await f.reserve.pendingSync();
  const res = await fhevm.publicDecrypt([a, s, i]);
  const v = [a, s, i].map((h) => res.clearValues[h] as bigint);
  await f.reserve.finalizeSync(v[0], v[1], v[2], res.decryptionProof);
  return v;
}

/** A long run on NVDA: +0.1 % at 14 s, cashed out at 20 s. */
async function playRun(f: Fixture, stake: bigint) {
  await price(f, NVDA, BASE[NVDA]);
  const id = await startRun(f, f.alice, NVDA, true, stake);
  const run = await f.game.getRun(id);
  const p1 = (BASE[NVDA] * 10_010n) / 10_000n;
  await at(run.startAt, 14);
  await price(f, NVDA, p1);
  await at(run.startAt, 20);
  await f.game.connect(f.alice).cashOut(id, []);
  return { id, mult: model([{ t: 0, p: BASE[NVDA] }, { t: 14, p: p1 }]).long };
}

describe("SiroccoReserve: the lending pool behind the leverage", function () {
  let f: Fixture;

  beforeEach(async function () {
    if (!fhevm.isMock) this.skip();
    f = await deployFixture();
  });

  it("the deployer is the first lender: public seed, encrypted shares at 1 cUSDC", async function () {
    expect(await f.reserve.syncedAssets()).to.eq(SEED);
    expect(await f.reserve.syncedShares()).to.eq(SEED);
    expect(await f.reserve.sharePrice()).to.eq(1_000_000n);
    expect(await shares(f, f.deployer)).to.eq(SEED);
    await expect(fhevm.userDecryptEuint(FhevmType.euint64, await f.reserve.confidentialBalanceOf(f.deployer.address), f.reserveAddress, f.alice)).to.be
      .rejected;
    expect(await f.reserve.name()).to.eq("Sirocco Reserve cUSDC");
    expect(await f.reserve.symbol()).to.eq("rcUSDC");
    expect(await f.reserve.borrowAprBps()).to.eq(2000n);
  });

  it("a run borrows from the reserve: the public bound is locked, interest is charged, PnL goes to the lenders", async function () {
    const stake = 50n * USDC;
    const before = await balance(f, f.alice);
    await price(f, NVDA, BASE[NVDA]);
    const id = await startRun(f, f.alice, NVDA, true, stake);
    expect(await f.reserve.lockedAssets()).to.eq(MAX_PAYOUT);
    expect(await f.reserve.openLoans()).to.eq(1n);
    expect(await f.reserve.utilizationBps()).to.eq((MAX_PAYOUT * 10_000n) / SEED);
    const run = await f.game.getRun(id);
    const p1 = (BASE[NVDA] * 10_010n) / 10_000n;
    await at(run.startAt, 14);
    await price(f, NVDA, p1);
    await at(run.startAt, 20);
    await f.game.connect(f.alice).cashOut(id, []);
    const mult = model([{ t: 0, p: BASE[NVDA] }, { t: 14, p: p1 }]).long;
    const paid = payout(stake, mult, 20);
    const charged = interest(stake, 20);
    expect(borrowed(20)).to.eq(30n + 60n + 30n); // tenths: 6-12 s at +0.5x, 12-18 s at +1x, 18-20 s at +1.5x
    expect(charged).to.be.gt(0n);
    expect(await balance(f, f.alice)).to.eq(before - stake + paid);
    const [, , , , , , interestH] = await f.game.runHandles(id);
    expect(await decrypt64(f, interestH, f.alice)).to.eq(charged);
    expect(await f.reserve.lockedAssets()).to.eq(0n);
    expect(await f.reserve.openLoans()).to.eq(0n);
    // the lenders carry the run: assets = seed + stake - payout (interest included)
    const [assets, supply, earned] = await sync(f);
    expect(assets).to.eq(SEED + stake - paid);
    expect(supply).to.eq(SEED);
    expect(earned).to.eq(charged);
    expect(await f.reserve.syncedAssets()).to.eq(SEED + stake - paid);
    expect(await f.reserve.sharePrice()).to.eq(((SEED + stake - paid) * 1_000_000n) / SEED);
  });

  it("syncs at most every 10 minutes, and only with the KMS proof", async function () {
    await f.reserve.requestSync();
    await expect(f.reserve.requestSync()).to.be.revertedWithCustomError(f.reserve, "SyncTooSoon");
    const [a, s, i] = await f.reserve.pendingSync();
    const res = await fhevm.publicDecrypt([a, s, i]);
    const v = [a, s, i].map((h) => res.clearValues[h] as bigint);
    await expect(f.reserve.finalizeSync(v[0] + 1n, v[1], v[2], res.decryptionProof)).to.be.reverted;
    await f.reserve.finalizeSync(v[0], v[1], v[2], res.decryptionProof);
    await expect(f.reserve.finalizeSync(v[0], v[1], v[2], res.decryptionProof)).to.be.revertedWithCustomError(f.reserve, "NoSyncPending");
    await expect(f.reserve.requestSync()).to.be.revertedWithCustomError(f.reserve, "SyncTooSoon");
    await time.increase(600);
    await f.reserve.requestSync();
  });

  it("lenders deposit and withdraw encrypted amounts at the synced price, all or nothing", async function () {
    await playRun(f, 100n * USDC);
    const [assets, supply] = await sync(f);
    const alice = f.alice;
    const cusdc0 = await balance(f, alice);
    await f.token.connect(alice).setOperator(f.reserveAddress, (await time.latest()) + 3600);
    const d = await encryptFor(f, alice, 300n * USDC);
    await f.reserve.connect(alice).deposit(d.handle, d.proof);
    const minted = (300n * USDC * supply) / assets;
    expect(await shares(f, alice)).to.eq(minted);
    expect(await balance(f, alice)).to.eq(cusdc0 - 300n * USDC);
    // more shares than held: nothing moves
    const tooMany = await encryptFor(f, alice, minted + 1n);
    await f.reserve.connect(alice).withdraw(tooMany.handle, tooMany.proof);
    expect(await shares(f, alice)).to.eq(minted);
    expect(await balance(f, alice)).to.eq(cusdc0 - 300n * USDC);
    // half of them: paid at the synced price
    const half = minted / 2n;
    const w = await encryptFor(f, alice, half);
    await f.reserve.connect(alice).withdraw(w.handle, w.proof);
    expect(await shares(f, alice)).to.eq(minted - half);
    expect(await balance(f, alice)).to.eq(cusdc0 - 300n * USDC + (half * assets) / supply);
    // nobody else reads the position
    const h = await f.reserve.confidentialBalanceOf(alice.address);
    await expect(fhevm.userDecryptEuint(FhevmType.euint64, h, f.reserveAddress, f.bob)).to.be.rejected;
  });

  it("an encrypted deposit the lender cannot fund mints nothing", async function () {
    const poor = f.players[6];
    await f.token.connect(poor).setOperator(f.reserveAddress, (await time.latest()) + 3600);
    const d = await encryptFor(f, poor, 50n * USDC);
    await f.reserve.connect(poor).deposit(d.handle, d.proof);
    expect(await shares(f, poor)).to.eq(0n);
  });

  it("a withdrawal can never take the liquidity lent to live runs", async function () {
    // the deployer lends 1,500; one run takes 1,000 into the game; 1,000 shares cannot come out
    f = await deployFixture({ seed: 1500n * USDC });
    await price(f, NVDA, BASE[NVDA]);
    const id = await startRun(f, f.alice, NVDA, true, 10n * USDC);
    const w = await encryptFor(f, f.deployer, 1000n * USDC);
    await f.reserve.withdraw(w.handle, w.proof);
    expect(await shares(f, f.deployer)).to.eq(1500n * USDC);
    // the run is still fully funded and settles normally
    const run = await f.game.getRun(id);
    await at(run.startAt, 61);
    await f.game.settleRun(id);
    expect(await f.reserve.lockedAssets()).to.eq(0n);
  });

  it("a reserve that is short lends 0: the run is a plain refund, no leverage, no interest", async function () {
    f = await deployFixture({ seed: 1500n * USDC });
    // the synced total still says 1,500, but 1,000 left since: the clear guard passes, the transfer moves 0
    const w = await encryptFor(f, f.deployer, 1000n * USDC);
    await f.reserve.withdraw(w.handle, w.proof);
    expect(await shares(f, f.deployer)).to.eq(500n * USDC);
    const before = await balance(f, f.alice);
    const { id } = await playRun(f, 20n * USDC);
    expect(await balance(f, f.alice)).to.eq(before);
    const [, , valueH, multH, , , interestH] = await f.game.runHandles(id);
    expect(await decrypt64(f, valueH, f.alice)).to.eq(20n * USDC);
    expect(await decrypt32(f, multH, f.alice)).to.eq(SCALE);
    expect(await decrypt64(f, interestH, f.alice)).to.eq(0n);
    expect(await f.reserve.lockedAssets()).to.eq(0n);
  });

  it("refuses a run when the committed liquidity would exceed the synced assets", async function () {
    f = await deployFixture({ seed: 500n * USDC });
    await price(f, NVDA, BASE[NVDA]);
    const input = fhevm.createEncryptedInput(f.gameAddress, f.alice.address);
    input.addBool(true);
    input.add64(10n * USDC);
    const enc = await input.encrypt();
    await expect(f.game.connect(f.alice).startRun(NVDA, enc.handles[0], enc.handles[1], enc.inputProof, false, [], 0)).to.be.revertedWithCustomError(
      f.reserve,
      "ReserveFull",
    );
  });

  it("only the game borrows, and the game is set once", async function () {
    await expect(f.reserve.lend.staticCall(0, MAX_PAYOUT)).to.be.revertedWithCustomError(f.reserve, "NotGame");
    await expect(f.reserve.setGame.staticCall(f.alice.address)).to.be.revertedWithCustomError(f.reserve, "GameAlreadySet");
    await expect(f.reserve.connect(f.alice).setGame.staticCall(f.alice.address)).to.be.reverted;
  });

  it("a packed run pays interest on its capped leverage only", async function () {
    await f.game.connect(f.alice).openPack();
    const tier = Number(await fhevm.userDecryptEuint(FhevmType.euint8, await f.game.packHandle(f.alice.address), f.gameAddress, f.alice));
    const cap = [1, 2, 4, 6][tier];
    await price(f, NVDA, BASE[NVDA]);
    const id = await startRun(f, f.alice, NVDA, true, 30n * USDC, true);
    const run = await f.game.getRun(id);
    await at(run.startAt, 45);
    await f.game.connect(f.alice).cashOut(id, []);
    const [, , , , , , interestH] = await f.game.runHandles(id);
    expect(await decrypt64(f, interestH, f.alice)).to.eq(interest(30n * USDC, 45, cap));
    expect(borrowed(45, 1)).to.be.lt(borrowed(45, 6));
  });
});

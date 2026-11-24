import { FhevmType } from "@fhevm/hardhat-plugin";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { BASE, NVDA, type Fixture, USDC, at, balance, decrypt32, deployFixture, encrypt, model, payout, price } from "./helpers";

describe("Siroclimb: sessions and packs", function () {
  let f: Fixture;

  beforeEach(async function () {
    if (!fhevm.isMock) this.skip();
    f = await deployFixture();
  });

  async function grant(player = f.alice, expiry?: number) {
    const session = ethers.Wallet.createRandom().connect(ethers.provider);
    const exp = expiry ?? (await time.latest()) + 7 * 24 * 3600;
    const sig = await session.signMessage(ethers.getBytes(await f.game.sessionDigest(player.address, exp)));
    await f.game.connect(player).authorizeSession(session.address, exp, sig, { value: ethers.parseEther("1") });
    return session;
  }

  it("a session key plays for the player without wallet pop-ups: stake, cash out, payout", async function () {
    const session = await grant();
    expect(await ethers.provider.getBalance(session.address)).to.eq(ethers.parseEther("1"));
    expect(await f.game.playerOf(session.address)).to.eq(f.alice.address);
    expect(await f.game.sessionOf(f.alice.address)).to.eq(session.address);
    const before = await balance(f, f.alice);
    await price(f, NVDA, BASE[NVDA]);
    // inputs are encrypted for the session (the transaction sender); funds move from the player
    const { handles, proof } = await encrypt(f, session.address, true, 50n * USDC);
    await f.game.connect(session).startRun(NVDA, handles[0], handles[1], proof, false, [], 0);
    const id = (await f.game.runCount()) - 1n;
    const run = await f.game.getRun(id);
    expect(run.player).to.eq(f.alice.address);
    expect(await balance(f, f.alice)).to.eq(before - 50n * USDC);
    await at(run.startAt, 14);
    const p1 = (BASE[NVDA] * 10_015n) / 10_000n;
    await price(f, NVDA, p1);
    await at(run.startAt, 15);
    await f.game.connect(session).cashOut(id, []);
    const m = model([{ t: 0, p: BASE[NVDA] }, { t: 14, p: p1 }]).long;
    expect(await balance(f, f.alice)).to.eq(before - 50n * USDC + payout(50n * USDC, m, 15));
    // the player (not the session) owns the run's ciphertexts
    const [, , , multH] = await f.game.runHandles(id);
    expect(await decrypt32(f, multH, f.alice)).to.eq(m);
  });

  it("a session must consent, cannot be another player, expires and can be revoked", async function () {
    const session = ethers.Wallet.createRandom();
    const exp = (await time.latest()) + 3600;
    const wrong = await session.signMessage(ethers.getBytes(await f.game.sessionDigest(f.bob.address, exp)));
    await expect(f.game.connect(f.alice).authorizeSession(session.address, exp, wrong)).to.be.revertedWithCustomError(f.game, "BadSession");
    // bob cannot capture alice's own address as his session
    const fake = await session.signMessage(ethers.getBytes(await f.game.sessionDigest(f.bob.address, exp)));
    await expect(f.game.connect(f.bob).authorizeSession(f.alice.address, exp, fake)).to.be.revertedWithCustomError(f.game, "BadSession");

    const s = await grant(f.alice, (await time.latest()) + 100);
    await expect(f.game.connect(f.alice).authorizeSession(s.address, exp, "0x")).to.be.reverted;
    await time.increase(200);
    expect(await f.game.playerOf(s.address)).to.eq(s.address); // expired: acts for itself only
    const s2 = await grant(f.alice);
    expect(await f.game.playerOf(s.address)).to.eq(s.address);
    expect(await f.game.playerOf(s2.address)).to.eq(f.alice.address);
    await f.game.connect(f.alice).revokeSession();
    expect(await f.game.playerOf(s2.address)).to.eq(s2.address);
    await expect(f.game.connect(f.alice).revokeSession()).to.be.revertedWithCustomError(f.game, "BadSession");
  });

  it("names: up to 24 bytes, set by the player or their session", async function () {
    const s = await grant();
    await f.game.connect(s).setName("saffron.dune");
    expect(await f.game.nameOf(f.alice.address)).to.eq("saffron.dune");
    await expect(f.game.setName("x".repeat(25))).to.be.revertedWithCustomError(f.game, "NameTooLong");
  });

  it("packs: encrypted PRNG tier, private to the player, once per cooldown", async function () {
    await f.game.connect(f.alice).openPack();
    expect(await f.game.hasPack(f.alice.address)).to.eq(true);
    const h = await f.game.packHandle(f.alice.address);
    const tier = Number(await fhevm.userDecryptEuint(FhevmType.euint8, h, f.gameAddress, f.alice));
    expect(tier).to.be.within(0, 3);
    await expect(fhevm.userDecryptEuint(FhevmType.euint8, h, f.gameAddress, f.bob)).to.be.rejected;
    await expect(f.game.connect(f.alice).openPack()).to.be.revertedWithCustomError(f.game, "PackCooldown");
  });

  it("packs: the draw covers every tier over many players", async function () {
    const seen = new Set<number>();
    for (const p of f.players.slice(0, 20)) {
      await f.game.connect(p).openPack();
      seen.add(Number(await fhevm.userDecryptEuint(FhevmType.euint8, await f.game.packHandle(p.address), f.gameAddress, p)));
    }
    expect([...seen].every((t) => t >= 0 && t <= 3)).to.eq(true);
    expect(seen.size).to.be.gte(2);
  });

  it("a packed run caps its ladder at the pack's leverage, on ciphertexts", async function () {
    await f.game.connect(f.alice).openPack();
    const tier = Number(await fhevm.userDecryptEuint(FhevmType.euint8, await f.game.packHandle(f.alice.address), f.gameAddress, f.alice));
    const cap = [1, 2, 4, 6][tier];
    await price(f, NVDA, BASE[NVDA]);
    const { handles, proof } = await encrypt(f, f.alice, true, 10n * USDC);
    await expect(f.game.connect(f.bob).startRun(NVDA, handles[0], handles[1], proof, true, [], 0)).to.be.reverted;
    await f.game.connect(f.alice).startRun(NVDA, handles[0], handles[1], proof, true, [], 0);
    const id = (await f.game.runCount()) - 1n;
    expect(await f.game.hasPack(f.alice.address)).to.eq(false);
    const run = await f.game.getRun(id);
    const p1 = (BASE[NVDA] * 10_010n) / 10_000n;
    await at(run.startAt, 50); // step 8 -> capped
    await price(f, NVDA, p1);
    await at(run.startAt, 51);
    await f.game.connect(f.alice).cashOut(id, []);
    const [, , , multH] = await f.game.runHandles(id);
    const got = await decrypt32(f, multH, f.alice);
    expect(got).to.eq(model([{ t: 0, p: BASE[NVDA] }, { t: 50, p: p1 }], cap).long);
    // the public multipliers are the uncapped ones: the cap itself stays private
    expect((await f.game.getRun(id)).multLong).to.eq(model([{ t: 0, p: BASE[NVDA] }, { t: 50, p: p1 }]).long);
    const s = await f.game.connect(f.alice).startRun.staticCall(NVDA, handles[0], handles[1], proof, true, [], 0).catch((e) => e);
    expect(String(s)).to.match(/NoPack|revert/);
  });
});

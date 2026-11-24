import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { ethers, fhevm } from "hardhat";
import type {
  ClimbFaucet,
  ClimbLadder,
  ClimbPriceOracle,
  ConfidentialTokenWrapper,
  MirrorToken,
  MockPyth,
  Siroclimb,
} from "../types";

/** Market order on chain: stocks and real world assets. */
export const MARKETS = ["TSLAx", "NVDAx", "AAPLx", "XAUt", "tGBP"] as const;
export const [TSLA, NVDA, AAPL, XAUT, GBP] = [0, 1, 2, 3, 4];
/** Pyth feeds (vs USD): Equity.US.TSLA / NVDA / AAPL, Crypto.XAUT, FX.GBP. */
export const PYTH_FEEDS = [
  "0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1",
  "0xb1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593",
  "0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
  "0x44465e17d2e9d390e70c999d5a11fda4f092847fcd2e3e5aa089d96c98a30e67",
  "0x84c2dde9633d93d1bcad84e7dc41c9d56578b7ec52fabedc1f335d673df0a7c1",
];
/** 10-decimal prices: TSLA 386, NVDA 165, AAPL 350, XAUt 3626, GBP 1.30. */
export const BASE = [3_860_000_000_000n, 1_650_000_000_000n, 3_500_000_000_000n, 36_260_000_000_000n, 13_000_000_000n];

export const USDC = 1_000_000n;
export const SCALE = 1_000_000n;
export const MOVE_SCALE = 25n;
export const ENTRY = 10n * USDC;
export const JOIN_SECONDS = 45;
export const RUN_SECONDS = 60;
export const ROUND_MARKETS = [TSLA, NVDA, AAPL, XAUT, GBP];
export const FAUCET_AMOUNT = 1000n * USDC;

export interface Fixture {
  deployer: HardhatEthersSigner;
  players: HardhatEthersSigner[];
  alice: HardhatEthersSigner;
  bob: HardhatEthersSigner;
  carol: HardhatEthersSigner;
  usdc: MirrorToken;
  token: ConfidentialTokenWrapper;
  faucet: ClimbFaucet;
  pyth: MockPyth;
  oracle: ClimbPriceOracle;
  ladder: ClimbLadder;
  game: Siroclimb;
  gameAddress: string;
  tokenAddress: string;
}

export async function deployFixture(opts: { fund?: number } = {}): Promise<Fixture> {
  const [deployer, ...players] = await ethers.getSigners();
  const usdc = (await (await ethers.getContractFactory("MirrorToken")).deploy("Test USDC", "USDC", 6)) as MirrorToken;
  const token = (await (
    await ethers.getContractFactory("ConfidentialTokenWrapper")
  ).deploy(await usdc.getAddress(), "Confidential USDC", "cUSDC")) as ConfidentialTokenWrapper;
  const faucet = (await (await ethers.getContractFactory("ClimbFaucet")).deploy(await token.getAddress(), FAUCET_AMOUNT, 600)) as ClimbFaucet;
  const pyth = (await (await ethers.getContractFactory("MockPyth")).deploy(120, 1)) as MockPyth;
  const oracle = (await (await ethers.getContractFactory("ClimbPriceOracle")).deploy(
    deployer.address,
    await pyth.getAddress(),
    PYTH_FEEDS,
  )) as ClimbPriceOracle;
  const ladder = (await (await ethers.getContractFactory("ClimbLadder")).deploy(await oracle.getAddress(), MOVE_SCALE)) as ClimbLadder;
  const game = (await (await ethers.getContractFactory("Siroclimb")).deploy(
    deployer.address,
    await token.getAddress(),
    await ladder.getAddress(),
    ENTRY,
    JOIN_SECONDS,
    ROUND_MARKETS,
  )) as Siroclimb;
  await oracle.setUpdater(deployer.address, true);
  await oracle.pushPrices([0, 1, 2, 3, 4], BASE);

  const gameAddress = await game.getAddress();
  const tokenAddress = await token.getAddress();
  const until = (await time.latest()) + 365 * 24 * 3600;
  for (const p of players.slice(0, opts.fund ?? 3)) {
    await faucet.claimFor(p.address);
    await token.connect(p).setOperator(gameAddress, until);
  }
  return { deployer, players, alice: players[0], bob: players[1], carol: players[2], usdc, token, faucet, pyth, oracle, ladder, game, gameAddress, tokenAddress };
}

/** Pushes BASE prices scaled per market in basis points (10000 = unchanged), one block later. */
export async function move(f: Fixture, market: number, bps: number) {
  await f.oracle.pushPrices([market], [(BASE[market] * BigInt(bps)) / 10_000n]);
}

export async function price(f: Fixture, market: number, p: bigint) {
  await f.oracle.pushPrices([market], [p]);
}

export async function encrypt(f: Fixture, signer: HardhatEthersSigner | string, long: boolean, stake?: bigint) {
  const input = fhevm.createEncryptedInput(f.gameAddress, typeof signer === "string" ? signer : signer.address);
  input.addBool(long);
  if (stake !== undefined) input.add64(stake);
  const enc = await input.encrypt();
  return { handles: enc.handles, proof: enc.inputProof };
}

export async function startRun(f: Fixture, signer: HardhatEthersSigner, market: number, long: boolean, stake: bigint, usePack = false) {
  const { handles, proof } = await encrypt(f, signer, long, stake);
  await f.game.connect(signer).startRun(market, handles[0], handles[1], proof, usePack, [], 0);
  return (await f.game.runCount()) - 1n;
}

export async function joinRound(f: Fixture, signer: HardhatEthersSigner, long: boolean, roundId?: bigint) {
  const { handles, proof } = await encrypt(f, signer, long);
  const id = roundId ?? (await currentJoinable(f));
  await f.game.connect(signer).joinRound(id, handles[0], proof);
  return { roundId: id, runId: (await f.game.runCount()) - 1n };
}

/** The round id to join now: the open one, or the next one to open. */
export async function currentJoinable(f: Fixture): Promise<bigint> {
  const n = await f.game.roundCount();
  if (n === 0n) return 0n;
  const [r] = await f.game.getRound(n - 1n);
  return BigInt(await time.latest()) + 1n < r.startsAt ? n - 1n : n;
}

export async function balance(f: Fixture, signer: HardhatEthersSigner): Promise<bigint> {
  const h = await f.token.confidentialBalanceOf(signer.address);
  if (h === ethers.ZeroHash) return 0n;
  return fhevm.userDecryptEuint(FhevmType.euint64, h, f.tokenAddress, signer);
}

/** Sequential: the FHEVM mock's coprocessor cursor does not support concurrent decryptions. */
export async function balances(f: Fixture, signers: HardhatEthersSigner[]): Promise<bigint[]> {
  const out: bigint[] = [];
  for (const s of signers) out.push(await balance(f, s));
  return out;
}

export async function decrypt64(f: Fixture, handle: string, signer: HardhatEthersSigner) {
  return fhevm.userDecryptEuint(FhevmType.euint64, handle, f.gameAddress, signer);
}

export async function decrypt32(f: Fixture, handle: string, signer: HardhatEthersSigner) {
  return fhevm.userDecryptEuint(FhevmType.euint32, handle, f.gameAddress, signer);
}

export async function closeAndFinalize(f: Fixture, roundId: bigint) {
  await f.game.closeRound(roundId);
  const handles = await f.game.roundScoreHandles(roundId);
  const res = await fhevm.publicDecrypt([...handles]);
  const scores = handles.map((h) => res.clearValues[h] as bigint);
  await f.game.finalizeRound(roundId, scores, res.decryptionProof);
  await claimAll(f, roundId);
  return scores;
}

/** Pays every run of a round what it is owed (prize or refund), one claim per run. */
export async function claimAll(f: Fixture, roundId: bigint) {
  const [, ids] = await f.game.getRound(roundId);
  const [r] = await f.game.getRound(roundId);
  for (const id of ids) {
    if (Number(r.status) === 3 && (await f.game.prizeOf(id)) === 0n) continue;
    await f.game.claim(id);
  }
}

/** TypeScript mirror of ClimbLadder.multipliers over [{t (s from start), price}]: 6-decimal multipliers. */
export function model(points: { t: number; p: bigint }[], cap = 6, scale = MOVE_SCALE): { long: bigint; short: bigint } {
  let accL = 0n;
  let accS = 0n;
  let fellL = false;
  let fellS = false;
  for (let j = 1; j < points.length; j++) {
    const prev = points[j - 1].p;
    let mv = ((points[j].p - prev) * SCALE) / prev;
    if (mv > 200_000n) mv = 200_000n;
    if (mv < -200_000n) mv = -200_000n;
    const step = BigInt(Math.min(cap, Math.floor(Math.max(0, points[j - 1].t) / 6)));   // leverage when the move began
    const d = (mv * scale * (10n + 5n * step)) / 10n;
    if (!fellL) {
      accL += d;
      if (accL <= -SCALE) fellL = true;
    }
    if (!fellS) {
      accS -= d;
      if (accS <= -SCALE) fellS = true;
    }
  }
  const m = (fell: boolean, acc: bigint) => {
    if (fell) return 0n;
    const v = SCALE + acc;
    if (v <= 0n) return 0n;
    return v > 10n * SCALE ? 10n * SCALE : v;
  };
  return { long: m(fellL, accL), short: m(fellS, accS) };
}

/** Moves the chain clock so the next block lands at `start + offset`. */
export async function at(start: bigint, offset: number) {
  await time.setNextBlockTimestamp(Number(start) + offset);
}

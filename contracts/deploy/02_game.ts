import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { MARKETS, seedPrices } from "../scripts/markets";

/** Zama Protocol confidential token registry ("Wrappers Registry") on Sepolia. */
export const SEPOLIA_WRAPPERS_REGISTRY = "0x2f0750Bbb0A246059d80e94c454586a7F27a128e";
/** USDCMock: the publicly mintable underlying of Zama's cUSDCMock on Sepolia. */
export const SEPOLIA_USDC_MOCK = "0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF";
/** Pyth on Ethereum Sepolia (accepts Hermes updates, Wormhole-verified). */
export const SEPOLIA_PYTH = "0xDd24F84d36BF92C65F92307595335bdFab5Bbd21";

/** Game boost per market (markets.json `boost`), as on Siroclimb MagicBlock: bigger for quieter markets. */
export const MOVE_SCALES = MARKETS.map((m) => m.boost);
const FAUCET_AMOUNT = 1_000_000_000; // 1000 cUSDC
const FAUCET_COOLDOWN = 600;
/** Sirocco Reserve: borrow APR in basis points, and the deployer's seed as first lender (cUSDC). */
export const BORROW_APR_BPS = Number(process.env.BORROW_APR_BPS ?? 2000);
const RESERVE_SEED = BigInt(process.env.RESERVE_SEED ?? 250_000) * 1_000_000n;
/** Sirocco desk: half spread around the oracle price (bps), and its inventories (whole tokens). */
export const DESK_SPREAD_BPS = Number(process.env.DESK_SPREAD_BPS ?? 10);
const DESK_CASH = 500_000n; // cUSDC, for the shorts' sales
const DESK_STOCK: Record<string, bigint> = { TSLAx: 100_000n, NVDAx: 200_000n, AAPLx: 100_000n, AMZNx: 100_000n, XAUt: 2_000n, tGBP: 1_000_000n };
const ERC20_ABI = [
  "function mint(address,uint256)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const REGISTRY_ABI = [
  "function getConfidentialTokenAddress(address token) view returns (bool, address)",
  "function isConfidentialTokenValid(address confidentialToken) view returns (bool)",
];

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy, execute, read, log } = hre.deployments;
  const sepolia = hre.network.name === "sepolia";

  // Stakes: Zama's own cUSDCMock on Sepolia, resolved and checked through the Wrappers Registry
  let stake: string;
  if (sepolia) {
    const registry = await hre.ethers.getContractAt(REGISTRY_ABI, SEPOLIA_WRAPPERS_REGISTRY);
    const [found, wrapper] = await registry.getConfidentialTokenAddress(SEPOLIA_USDC_MOCK);
    if (!found || !(await registry.isConfidentialTokenValid(wrapper))) throw new Error("cUSDCMock is not valid in the registry");
    stake = wrapper;
    log(`cUSDCMock (Zama registry) ${stake}`);
  } else {
    const usdc = await deploy("USDC", { contract: "MirrorToken", from: deployer, args: ["Test USDC", "USDC", 6], log: true });
    stake = (
      await deploy("cUSDC", {
        contract: "ConfidentialTokenWrapper",
        from: deployer,
        args: [usdc.address, "Confidential USDC", "cUSDC"],
        log: true,
      })
    ).address;
  }

  const faucet = await deploy("ClimbFaucet", { from: deployer, args: [stake, FAUCET_AMOUNT, FAUCET_COOLDOWN], log: true });
  const pyth = sepolia ? SEPOLIA_PYTH : (await deploy("MockPyth", { from: deployer, args: [120, 1], log: true })).address;
  const oracle = await deploy("ClimbPriceOracle", { from: deployer, args: [deployer, pyth, MARKETS.map((m) => m.pyth)], log: true });
  const ladder = await deploy("ClimbLadder", { from: deployer, args: [oracle.address, MOVE_SCALES], log: true });
  const reserve = await deploy("SiroccoReserve", { from: deployer, args: [deployer, stake, BORROW_APR_BPS], log: true });
  const desk = await deploy("SiroccoDesk", { from: deployer, args: [deployer, stake, DESK_SPREAD_BPS], log: true });
  // the markets' confidential tokens: Zama's for XAUt and GBP, our mirrors for the stocks (01_mirrors)
  const marketTokens: string[] = [];
  for (const m of MARKETS) {
    if (m.token.origin === "zama" && sepolia) marketTokens.push(m.token.sepolia!);
    else marketTokens.push((await hre.deployments.getOrNull(m.token.symbol))?.address ?? (await deployLocalToken(hre, deployer, m.token.symbol)));
  }
  const game = await deploy("Siroclimb", {
    from: deployer,
    args: [deployer, stake, ladder.address, reserve.address, desk.address, marketTokens],
    log: true,
  });
  if ((await read("SiroccoReserve", "game")) === hre.ethers.ZeroAddress) await execute("SiroccoReserve", { from: deployer, log: true }, "setGame", game.address);
  if ((await read("SiroccoDesk", "game")) === hre.ethers.ZeroAddress) await execute("SiroccoDesk", { from: deployer, log: true }, "setGame", game.address);
  // the desk's inventories: every market token (minted from its public underlying, wrapped in the desk)
  // and cUSDC for the shorts' sales. Zama's XAUtMock, GBPMock and USDCMock mint publicly, like our mirrors.
  const signer = await hre.ethers.getSigner(deployer);
  const stockDesk = async (wrapperAddr: string, whole: bigint, label: string) => {
    const w = await hre.ethers.getContractAt(["function underlying() view returns (address)"], wrapperAddr);
    const u = await hre.ethers.getContractAt(ERC20_ABI, await w.underlying(), signer);
    const amount = whole * 10n ** BigInt(await u.decimals());
    const perCall = 1_000_000n * 10n ** BigInt(await u.decimals());
    for (let left = amount; left > 0n; left -= left > perCall ? perCall : left) await (await u.mint(deployer, left > perCall ? perCall : left)).wait();
    await (await u.approve(desk.address, amount)).wait();
    for (let i = 0; i < 20 && (await u.allowance(deployer, desk.address)) < amount; i++) await new Promise((r) => setTimeout(r, 3000));
    await execute("SiroccoDesk", { from: deployer, log: true }, "stock", wrapperAddr, amount);
    log(`desk stocked with ${whole} ${label}`);
  };
  // stocked once, when the desk is new (STOCK_DESK=1 stocks it again)
  if (desk.newlyDeployed || process.env.STOCK_DESK) {
    for (const [i, m] of MARKETS.entries()) await stockDesk(marketTokens[i], DESK_STOCK[m.id] ?? 100_000n, m.token.symbol);
    await stockDesk(stake, DESK_CASH, "cUSDC");
  }
  // the deployer is the first lender: mints the public underlying, deposits it (public amount)
  if ((await read("SiroccoReserve", "syncedShares")) == 0n) {
    const wrapper = await hre.ethers.getContractAt(["function underlying() view returns (address)"], stake);
    const underlying = await wrapper.underlying();
    const usdc = await hre.ethers.getContractAt(
      [
        "function mint(address,uint256)",
        "function approve(address,uint256) returns (bool)",
        "function allowance(address,address) view returns (uint256)",
        "function balanceOf(address) view returns (uint256)",
      ],
      underlying,
      await hre.ethers.getSigner(deployer),
    );
    // a rerun after a lagging node picks up where the last one stopped
    if ((await usdc.balanceOf(deployer)) < RESERVE_SEED) await (await usdc.mint(deployer, RESERVE_SEED)).wait();
    if ((await usdc.allowance(deployer, reserve.address)) < RESERVE_SEED) await (await usdc.approve(reserve.address, RESERVE_SEED)).wait();
    for (let i = 0; i < 20 && (await usdc.allowance(deployer, reserve.address)) < RESERVE_SEED; i++) await new Promise((r) => setTimeout(r, 3000));
    await execute("SiroccoReserve", { from: deployer, log: true }, "depositUnderlying", RESERVE_SEED);
  }

  const updaters = [deployer, ...(process.env.KEEPER_ADDRESS ? [process.env.KEEPER_ADDRESS] : [])];
  for (const u of updaters) {
    if (!(await read("ClimbPriceOracle", "isUpdater", u))) await execute("ClimbPriceOracle", { from: deployer, log: true }, "setUpdater", u, true);
  }
  // public RPC nodes can lag a block behind: wait until the updater role is visible before seeding
  for (let i = 0; i < 20 && !(await read("ClimbPriceOracle", "isUpdater", deployer)); i++) await new Promise((r) => setTimeout(r, 3000));
  if ((await read("ClimbPriceOracle", "checkpointCount", 0)) == 0n) {
    const prices = await seedPrices();
    log(`seed ${MARKETS.map((m, i) => `${m.id}=${Number(prices[i]) / 1e10}`).join(" ")}`);
    await execute("ClimbPriceOracle", { from: deployer, log: true }, "pushPrices", MARKETS.map((_, i) => i), prices);
  }
  log(`stake ${stake}\nfaucet ${faucet.address}\noracle ${oracle.address}\nladder ${ladder.address}\nreserve ${reserve.address}\ndesk ${desk.address}\ngame ${game.address}`);
};

/** Local networks: a confidential market token over a mintable underlying (6 decimals). */
async function deployLocalToken(hre: HardhatRuntimeEnvironment, deployer: string, symbol: string) {
  const { deploy } = hre.deployments;
  const u = await deploy(`${symbol}Underlying`, { contract: "MirrorToken", from: deployer, args: [symbol, symbol, 6], log: true });
  return (await deploy(symbol, { contract: "ConfidentialTokenWrapper", from: deployer, args: [u.address, `Confidential ${symbol}`, symbol], log: true })).address;
}

export default func;
func.id = "siroclimb_game_v10_boosts";
func.tags = ["Siroclimb"];

import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { MARKETS, ROUND_MARKETS, seedPrices } from "../scripts/markets";

/** Zama Protocol confidential token registry ("Wrappers Registry") on Sepolia. */
export const SEPOLIA_WRAPPERS_REGISTRY = "0x2f0750Bbb0A246059d80e94c454586a7F27a128e";
/** USDCMock: the publicly mintable underlying of Zama's cUSDCMock on Sepolia. */
export const SEPOLIA_USDC_MOCK = "0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF";
/** Pyth on Ethereum Sepolia (accepts Hermes updates, Wormhole-verified). */
export const SEPOLIA_PYTH = "0xDd24F84d36BF92C65F92307595335bdFab5Bbd21";

export const MOVE_SCALE = Number(process.env.MOVE_SCALE ?? 25);
export const ROUND_ENTRY = 10_000_000; // 10 cUSDC
export const JOIN_SECONDS = Number(process.env.JOIN_SECONDS ?? 60);
const FAUCET_AMOUNT = 1_000_000_000; // 1000 cUSDC
const FAUCET_COOLDOWN = 600;

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
  const ladder = await deploy("ClimbLadder", { from: deployer, args: [oracle.address, MOVE_SCALE], log: true });
  const game = await deploy("Siroclimb", {
    from: deployer,
    args: [deployer, stake, ladder.address, ROUND_ENTRY, JOIN_SECONDS, ROUND_MARKETS],
    log: true,
  });

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
  log(`stake ${stake}\nfaucet ${faucet.address}\noracle ${oracle.address}\nladder ${ladder.address}\ngame ${game.address}`);
};

export default func;
func.id = "siroclimb_game_v5";
func.tags = ["Siroclimb"];

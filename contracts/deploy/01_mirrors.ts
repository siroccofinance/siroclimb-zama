import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { MARKETS } from "../scripts/markets";

/** Zama's `ConfidentialWrapper` implementation on Sepolia: behind cUSDCMock, ctGBPMock and cXAUtMock. */
export const ZAMA_CONFIDENTIAL_WRAPPER_IMPL = "0xae37b998d453e1fabe85dd46cf04295ca4a3af04";
const INIT_ABI = [
  "function initialize(string name_, string symbol_, string contractURI_, address underlying_, address owner_, address[] blockedUsers, bytes4 underlyingDenyListSelector, address[] initialObservers, address pauser_)",
];

/**
 * Sirocco mirrors: confidential tokens for markets that have no Zama token on Sepolia
 * (cTSLAx, cNVDAx, cAAPLx, cAMZNx). Each is built exactly like Zama's Sepolia tokens:
 *  - the underlying is an ERC-20 with the real token's name, symbol and decimals and a public mint
 *    capped at 1,000,000 tokens per call (`MirrorToken`, the same as Zama's `ERC20Mock`);
 *  - on Sepolia the confidential token is an ERC-1967 proxy to Zama's own `ConfidentialWrapper`
 *    implementation, initialized like ctGBPMock and cXAUtMock (no pauser, no observers, deny-list
 *    off); locally, where Zama's implementation does not exist, the OpenZeppelin
 *    `ERC7984ERC20Wrapper` it is built on.
 * They are not listed in Zama's Wrappers Registry (registration there is owner-only).
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy, log } = hre.deployments;
  const sepolia = hre.network.name === "sepolia";
  const iface = new hre.ethers.Interface(INIT_ABI);
  for (const m of MARKETS.filter((x) => x.token.origin === "mirror")) {
    const u = m.token.underlying!;
    const underlying = await deploy(`${u.symbol}Mirror`, {
      contract: "MirrorToken",
      from: deployer,
      args: [u.name, u.symbol, u.decimals],
      log: true,
    });
    const name = `Confidential ${u.name}`;
    const uri = `data:application/json;utf8,${JSON.stringify({ name, symbol: m.token.symbol, description: `Confidential wrapper of ${u.symbol} shielding it into a confidential token` })}`;
    const wrapper = sepolia
      ? await deploy(m.token.symbol, {
          contract: "ConfidentialTokenProxy",
          from: deployer,
          args: [
            ZAMA_CONFIDENTIAL_WRAPPER_IMPL,
            iface.encodeFunctionData("initialize", [name, m.token.symbol, uri, underlying.address, deployer, [], "0x00000000", [], hre.ethers.ZeroAddress]),
          ],
          log: true,
        })
      : await deploy(m.token.symbol, { contract: "ConfidentialTokenWrapper", from: deployer, args: [underlying.address, name, m.token.symbol], log: true });
    log(`${m.token.symbol.padEnd(8)} ${wrapper.address}  (underlying ${u.symbol} ${underlying.address})`);
  }
};

export default func;
func.id = "siroclimb_mirrors_v2";
func.tags = ["Mirrors"];

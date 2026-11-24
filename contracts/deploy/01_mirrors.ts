import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { MARKETS } from "../scripts/markets";

/**
 * Sirocco mirrors: confidential tokens for markets that have no Zama token on Sepolia
 * (cTSLAx, cNVDAx, cAAPLx, cAMZNx). Each is built exactly like Zama's Sepolia mocks: an ERC-20
 * underlying with the real token's name, symbol and decimals and a capped public mint, wrapped
 * by the OpenZeppelin ERC7984ERC20Wrapper (6 decimals, rate = 10^(decimals - 6)).
 * They are not listed in Zama's Wrappers Registry (registration there is owner-only).
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy, log } = hre.deployments;
  for (const m of MARKETS.filter((x) => x.token.origin === "mirror")) {
    const u = m.token.underlying!;
    const underlying = await deploy(`${u.symbol}Mirror`, {
      contract: "MirrorToken",
      from: deployer,
      args: [u.name, u.symbol, u.decimals],
      log: true,
    });
    const wrapper = await deploy(m.token.symbol, {
      contract: "ConfidentialTokenWrapper",
      from: deployer,
      args: [underlying.address, `Confidential ${u.name}`, m.token.symbol],
      log: true,
    });
    log(`${m.token.symbol.padEnd(8)} ${wrapper.address}  (underlying ${u.symbol} ${underlying.address})`);
  }
};

export default func;
func.id = "siroclimb_mirrors_v1";
func.tags = ["Mirrors"];

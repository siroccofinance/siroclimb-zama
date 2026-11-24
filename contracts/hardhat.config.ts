import "@fhevm/hardhat-plugin";
import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-verify";
import "@typechain/hardhat";
import "hardhat-deploy";
import type { HardhatUserConfig } from "hardhat/config";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const MNEMONIC = process.env.MNEMONIC ?? "test test test test test test test test test test test junk";

/** Sepolia deployer key: env DEPLOYER_KEY, or ~/.config/siroclimb/sepolia/deployer.key (never committed). */
function deployerKey(): string | undefined {
  if (process.env.DEPLOYER_KEY) return process.env.DEPLOYER_KEY;
  const file = process.env.DEPLOYER_KEY_FILE ?? join(homedir(), ".config", "siroclimb", "sepolia", "deployer.key");
  if (!existsSync(file)) return undefined;
  const key = readFileSync(file, "utf8").trim();
  return key.startsWith("0x") ? key : `0x${key}`;
}

const key = deployerKey();

const config: HardhatUserConfig = {
  defaultNetwork: "hardhat",
  namedAccounts: { deployer: 0 },
  sourcify: { enabled: true },
  etherscan: { apiKey: process.env.ETHERSCAN_API_KEY ?? "" },
  networks: {
    hardhat: { accounts: { mnemonic: MNEMONIC, count: 30 }, chainId: 31337 },
    localhost: { accounts: { mnemonic: MNEMONIC }, chainId: 31337, url: "http://127.0.0.1:8545" },
    sepolia: {
      accounts: key ? [key] : [],
      chainId: 11155111,
      url: process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com",
    },
  },
  paths: { artifacts: "./artifacts", cache: "./cache", sources: "./contracts", tests: "./test" },
  solidity: {
    version: "0.8.27",
    settings: {
      metadata: { bytecodeHash: "none" },
      optimizer: { enabled: true, runs: 1 },
      viaIR: true,
      evmVersion: "cancun",
    },
  },
  mocha: { timeout: 600_000 },
  typechain: { outDir: "types", target: "ethers-v6" },
};

export default config;

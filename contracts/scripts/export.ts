/**
 * Writes the deployed addresses for the front and the ops scripts: js/chain/deployments.json,
 * keyed by chain id. Usage: npm run export -- <network>
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { MARKETS } from "./markets";

const network = process.argv[2] ?? "localhost";
const dir = join(__dirname, "..", "deployments", network);
const chainId = readFileSync(join(dir, ".chainId"), "utf8").trim();
const read = (name: string) => {
  const f = join(dir, `${name}.json`);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as { address: string; receipt?: { blockNumber: number } }) : null;
};
const SEPOLIA_CUSDC = "0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639";
const SEPOLIA_PYTH = "0xDd24F84d36BF92C65F92307595335bdFab5Bbd21";
const game = read("Siroclimb");
if (!game) throw new Error(`no Siroclimb deployment on ${network}`);
const out = {
  Siroclimb: game.address,
  deployBlock: game.receipt?.blockNumber ?? 0,
  ClimbPriceOracle: read("ClimbPriceOracle")!.address,
  ClimbLadder: read("ClimbLadder")!.address,
  ClimbFaucet: read("ClimbFaucet")!.address,
  SiroccoReserve: read("SiroccoReserve")!.address,
  StakeToken: read("cUSDC")?.address ?? SEPOLIA_CUSDC,
  Pyth: read("MockPyth")?.address ?? SEPOLIA_PYTH,
  tokens: Object.fromEntries(
    MARKETS.map((m) => [m.id, m.token.origin === "zama" ? m.token.sepolia : read(m.token.symbol)?.address ?? null]),
  ),
  underlyings: Object.fromEntries(
    MARKETS.filter((m) => m.token.origin === "mirror").map((m) => [m.id, read(`${m.token.underlying!.symbol}Mirror`)?.address ?? null]),
  ),
};
const file = join(__dirname, "..", "..", "js", "chain", "deployments.json");
const all = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
all[chainId] = out;
writeFileSync(file, JSON.stringify(all, null, 2) + "\n");
console.log(`wrote ${file} [${chainId}]`);

// ABIs for the front and ops (full for our contracts, the ERC-7984 subset the game uses)
const art = (dir: string, name: string) =>
  JSON.parse(readFileSync(join(__dirname, "..", "artifacts", "contracts", ...(dir ? [dir] : []), `${name}.sol`, `${name}.json`), "utf8")).abi;
const ERC7984_USED = ["confidentialBalanceOf", "isOperator", "setOperator", "name", "symbol", "decimals", "underlying", "rate"];
const abi = {
  Siroclimb: art("", "Siroclimb"),
  ClimbPriceOracle: art("", "ClimbPriceOracle"),
  ClimbLadder: art("", "ClimbLadder"),
  ClimbFaucet: art("", "ClimbFaucet"),
  SiroccoReserve: art("", "SiroccoReserve"),
  ERC7984: art("tokens", "ConfidentialTokenWrapper").filter((x: { name?: string }) => x.name && ERC7984_USED.includes(x.name)),
};
writeFileSync(join(__dirname, "..", "..", "js", "chain", "abi.json"), JSON.stringify(abi) + "\n");
console.log("wrote js/chain/abi.json");

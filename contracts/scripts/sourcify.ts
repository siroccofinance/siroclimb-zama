/**
 * Verifies the Sepolia deployments on Sourcify (API v2, no key needed).
 * Usage: npm run verify:sourcify
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const CHAIN_ID = 11155111;
const root = join(__dirname, "..");
const depDir = join(root, "deployments", "sepolia");

interface BuildInfo {
  solcLongVersion: string;
  input: unknown;
  output: { contracts: Record<string, Record<string, unknown>> };
}
const buildInfos: BuildInfo[] = readdirSync(join(root, "artifacts", "build-info")).map((f) =>
  JSON.parse(readFileSync(join(root, "artifacts", "build-info", f), "utf8")),
);

function sourceOf(contractName: string) {
  for (const info of buildInfos)
    for (const [file, contracts] of Object.entries(info.output.contracts))
      if (contracts[contractName] && !file.startsWith("contracts/test/")) return { file, info };
  throw new Error(`no build info for ${contractName}`);
}

/** hardhat-deploy names: mirrors are aliases of the two token contracts. */
const artifactOf = (name: string) => (name.endsWith("Mirror") ? "MirrorToken" : name.startsWith("c") && name !== "cUSDC" ? "ConfidentialTokenWrapper" : name);

async function main() {
  for (const f of readdirSync(depDir).filter((x) => x.endsWith(".json"))) {
    const dep = JSON.parse(readFileSync(join(depDir, f), "utf8"));
    const name = f.replace(".json", "");
    const contractName = artifactOf(name);
    const { file, info } = sourceOf(contractName);
    const res = await fetch(`https://sourcify.dev/server/v2/verify/${CHAIN_ID}/${dep.address}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stdJsonInput: info.input,
        compilerVersion: info.solcLongVersion,
        contractIdentifier: `${file}:${contractName}`,
        creationTransactionHash: dep.transactionHash,
      }),
    });
    const json = (await res.json()) as { verificationId?: string; customCode?: string; message?: string };
    console.log(name.padEnd(20), dep.address, res.status, json.verificationId ?? json.customCode ?? json.message);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

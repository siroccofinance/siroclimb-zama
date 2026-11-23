/**
 * Verifies the Sepolia deployments on Sourcify (API v2, no key needed).
 * Usage: npm run verify:sourcify
 */
import { existsSync, readFileSync, readdirSync } from "fs";
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
  const only = process.argv.slice(2);
  for (const f of readdirSync(depDir).filter((x) => x.endsWith(".json") && (!only.length || only.includes(x.replace(".json", ""))))) {
    const dep = JSON.parse(readFileSync(join(depDir, f), "utf8"));
    const name = f.replace(".json", "");
    const contractName = artifactOf(name);
    const { file, info } = sourceOf(contractName);
    // the exact compiler input of this deployment (hardhat-deploy keeps it), not the latest build
    const inputFile = join(depDir, "solcInputs", `${dep.solcInputHash}.json`);
    const stdJsonInput = dep.solcInputHash && existsSync(inputFile) ? JSON.parse(readFileSync(inputFile, "utf8")) : info.input;
    const compilerVersion = dep.metadata ? `v${JSON.parse(dep.metadata).compiler.version}` : info.solcLongVersion;
    const res = await fetch(`https://sourcify.dev/server/v2/verify/${CHAIN_ID}/${dep.address}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stdJsonInput,
        compilerVersion: compilerVersion.replace(/^v/, ""),
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

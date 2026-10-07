/**
 * A local stand-in for Arc's ERC-8004 registries plus a fresh Callbook, so
 * `npm run callbook:setup -- --network local` can run for real end to end.
 *
 *   npx hardhat node --port 8547                    # in another terminal
 *   node scripts/callbook-local-chain.js --rpc http://127.0.0.1:8547
 *
 * Deploys test/fixtures/IdentityRegistry8004.sol (compiled here with solc: it
 * mirrors the reference IdentityRegistry v2.0.0, including register(string)
 * and its ERC-721 storage layout), MockValidationRegistry and Callbook from
 * build/, with the Hardhat node's first public test account, and writes
 * deployments/callbook-local-<port>.json (gitignored). Local only: it refuses
 * any chain id but 31337.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPublicClient, createWalletClient, http, defineChain } from "viem";
import { mnemonicToAccount } from "viem/accounts";

import { artifact } from "./artifact.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = path.join(ROOT, "test", "fixtures", "IdentityRegistry8004.sol");
export const HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";
export const DEFAULT_LOCAL_RPC = "http://127.0.0.1:8547";

let compiled = null;
/** { abi, bytecode } of the fixture IdentityRegistry, compiled once per process. */
export function identityFixture() {
  if (compiled) return compiled;
  const solc = createRequire(import.meta.url)("solc");
  const input = {
    language: "Solidity",
    sources: { "IdentityRegistry8004.sol": { content: readFileSync(FIXTURE, "utf8") } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
  const c = out.contracts["IdentityRegistry8004.sol"].IdentityRegistry8004;
  compiled = { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` };
  return compiled;
}

export const localChain = (rpc) =>
  defineChain({ id: 31337, name: "Local", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });

/** Deploy the registries and Callbook on a local node. Returns the deployment record (and writes it when `out` is set). */
export async function deployLocal({ rpc = DEFAULT_LOCAL_RPC, out, log = () => {} } = {}) {
  const chain = localChain(rpc);
  const transport = http(rpc);
  const publicClient = createPublicClient({ chain, transport, pollingInterval: 100 });
  const chainId = await publicClient.getChainId();
  if (chainId !== 31337) throw new Error(`refusing to deploy test registries on chain ${chainId}: local Hardhat (31337) only`);
  const account = mnemonicToAccount(HARDHAT_MNEMONIC, { addressIndex: 0 });
  const wallet = createWalletClient({ account, chain, transport });

  async function deploy({ abi, bytecode }, args = []) {
    const hash = await wallet.deployContract({ abi, bytecode, args, account, chain });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`deploy reverted: ${hash}`);
    return receipt;
  }

  const identity = await deploy(identityFixture());
  const validation = await deploy(artifact("MockValidationRegistry"), [identity.contractAddress]);
  const callbook = await deploy(artifact("Callbook"), [identity.contractAddress]);
  log(`IdentityRegistry8004 ${identity.contractAddress}`);
  log(`MockValidationRegistry ${validation.contractAddress}`);
  log(`Callbook ${callbook.contractAddress} (${callbook.gasUsed} gas)`);

  const record = {
    network: "local",
    chainId,
    rpc,
    deployer: account.address,
    contracts: { callbook: callbook.contractAddress },
    fromBlock: Number(identity.blockNumber),
    txs: { callbook: callbook.transactionHash },
    gasUsed: { callbook: Number(callbook.gasUsed) },
    external: { identityRegistry: identity.contractAddress, validationRegistry: validation.contractAddress, fixtures: true },
    deployedAt: new Date().toISOString(),
  };
  if (out) {
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
  }
  return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i !== -1 ? process.argv[i + 1] : fallback;
  };
  const rpc = arg("--rpc", DEFAULT_LOCAL_RPC);
  const out = arg("--out", path.join(ROOT, "deployments", `callbook-local-${new URL(rpc).port || "80"}.json`));
  deployLocal({ rpc, out, log: (m) => console.log(`  ${m}`) })
    .then(() => console.log(`\n  wrote ${path.relative(ROOT, out)}\n`))
    .catch((err) => {
      console.error(`\n  local deploy failed: ${err.shortMessage ?? err.message}\n`);
      process.exit(1);
    });
}

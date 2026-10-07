/**
 * Deploy Callbook, pointed at the ERC-8004 IdentityRegistry of the network.
 *
 *   node scripts/deploy-callbook.js --network local                         # local Hardhat node
 *   node --env-file=.env scripts/deploy-callbook.js --network testnet --dry-run
 *   node --env-file=.env scripts/deploy-callbook.js --network mainnet --dry-run
 *   node --env-file=.env scripts/deploy-callbook.js --network mainnet --yes  # the real mainnet deploy
 *
 * Flags: --network local|testnet|mainnet, --dry-run, --yes (required for a real
 * mainnet deploy). Unknown flags stop the script.
 *
 * Uses CALLBOOK_DEPLOYER_KEY. On `local` that may be left unset, and the
 * Hardhat node's first (public) test account deploys; a MockIdentityRegistry
 * is deployed alongside, since a bare node has no ERC-8004 registry.
 *
 * Callbook has no owner and holds no funds, so the deployer key gains nothing
 * by deploying: any funded key will do. Writes public addresses to
 * deployments/callbook-<network>.json and refuses to overwrite a testnet or
 * mainnet record.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, formatEther, encodeDeployData, defineChain } from "viem";
import { privateKeyToAccount, mnemonicToAccount } from "viem/accounts";
import { arc, arcTestnet } from "viem/chains";

import { artifact } from "./artifact.js";
import { parseFlags, mainnetConfirmation } from "./cli-flags.js";
import { REGISTRIES } from "../evaluator/abi.js";

const LOCAL_RPC = process.env.RATCHET_RPC ?? "http://127.0.0.1:8545";
const HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";

const localChain = defineChain({
  id: 31337,
  name: "Ratchet Local",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [LOCAL_RPC] } },
});

const NETWORKS = {
  local: { chain: localChain, rpc: LOCAL_RPC, identity: null },
  testnet: { chain: arcTestnet, rpc: undefined, identity: REGISTRIES[arcTestnet.id].identity },
  mainnet: { chain: arc, rpc: undefined, identity: REGISTRIES[arc.id].identity },
};

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

const flags = parseFlags(process.argv.slice(2), { values: ["--network"], booleans: ["--dry-run", "--yes"] });
if (flags.problems.length) fail(`deploy-callbook: ${flags.problems.join("; ")}`);
const network = flags.get("--network");
const dryRun = flags.has("--dry-run");
const net = NETWORKS[network];
if (!net) fail(`--network must be one of ${Object.keys(NETWORKS).join(", ")}`);
const unconfirmed = mainnetConfirmation({ network, dryRun, yes: flags.has("--yes") });
if (unconfirmed) fail(`deploy-callbook: ${unconfirmed}`);

const OUT = `deployments/callbook-${network}.json`;
const key = process.env.CALLBOOK_DEPLOYER_KEY;
if (!key && network !== "local") fail("CALLBOOK_DEPLOYER_KEY missing from .env");
const account = key ? privateKeyToAccount(key) : mnemonicToAccount(HARDHAT_MNEMONIC, { addressIndex: 0 });

const transport = http(net.rpc);
const publicClient = createPublicClient({ chain: net.chain, transport });
const wallet = createWalletClient({ account, chain: net.chain, transport });

const CALLBOOK = artifact("Callbook");

async function deploy(art, args) {
  const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args, account, chain: net.chain });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`deploy reverted: ${hash}`);
  return { address: receipt.contractAddress, hash, gasUsed: receipt.gasUsed, block: receipt.blockNumber };
}

/** The registry the book links agents through must actually be there. */
async function assertHasCode(address, label) {
  const code = await publicClient.getCode({ address });
  if (!code || code === "0x") fail(`${label} ${address} has no code on ${network}`);
}

async function main() {
  const chainId = await publicClient.getChainId();
  if (chainId !== net.chain.id) fail(`RPC is chain ${chainId}, expected ${net.chain.id} for ${network}`);

  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`\n  ${network} (chain ${chainId}) · deployer ${account.address}`);
  console.log(`  balance   ${formatEther(balance)} USDC`);

  if (network !== "local" && existsSync(OUT)) {
    fail(`${OUT} already exists: ${readFileSync(OUT, "utf8").trim()}\n  Refusing to redeploy.`);
  }

  let identity = net.identity;
  let identityTx = null;
  if (identity) {
    await assertHasCode(identity, "IdentityRegistry");
  } else if (!dryRun) {
    const mock = await deploy(artifact("MockIdentityRegistry"), []);
    identity = mock.address;
    identityTx = mock.hash;
    console.log(`  MockIdentityRegistry ${identity}`);
  }

  const gasPrice = await publicClient.getGasPrice();
  const gas = await publicClient.estimateGas({
    account: account.address,
    data: encodeDeployData({
      abi: CALLBOOK.abi,
      bytecode: CALLBOOK.bytecode,
      args: [identity ?? "0x0000000000000000000000000000000000000000"],
    }),
  });
  const cost = gas * gasPrice;
  console.log(`  estimate  ${gas} gas ≈ ${formatEther(cost)} USDC`);

  if (dryRun) {
    console.log(`\n  dry run: nothing sent.${balance < cost ? " Fund the deployer first." : ""}\n`);
    return;
  }
  if (balance < (cost * 3n) / 2n) fail(`Not enough USDC for gas (need ~${formatEther((cost * 3n) / 2n)} with headroom).`);

  const callbook = await deploy(CALLBOOK, [identity]);
  const linked = await publicClient.readContract({ address: callbook.address, abi: CALLBOOK.abi, functionName: "identityRegistry" });
  if (linked.toLowerCase() !== identity.toLowerCase()) throw new Error(`Callbook points at ${linked}, not ${identity}`);
  console.log(`  Callbook  ${callbook.address}  (${callbook.gasUsed} gas)`);

  mkdirSync("deployments", { recursive: true });
  writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        network,
        chainId,
        deployer: account.address,
        contracts: { callbook: callbook.address },
        fromBlock: Number(callbook.block), // where readers (API, verify, runner) start scanning
        txs: { callbook: callbook.hash, ...(identityTx ? { mockIdentityRegistry: identityTx } : {}) },
        external: { identityRegistry: identity, mockIdentityRegistry: identityTx !== null },
        deployedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\n  wrote ${OUT}\n`);
}

main().catch((err) => {
  console.error("\n  deploy failed:", err.shortMessage ?? err.message);
  process.exit(1);
});

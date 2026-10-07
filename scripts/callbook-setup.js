/**
 * Register our Callbook agents on ERC-8004, open their books and ask our
 * validator to score them.
 *
 *   npm run callbook:setup -- --network testnet --dry-run      # read-only: eth_call + gas estimates
 *   npm run callbook:setup -- --network testnet                # sends transactions from the OWNER key
 *   npm run callbook:setup -- --network mainnet --dry-run
 *   npm run callbook:setup -- --network mainnet --yes          # mainnet needs --yes to send
 *   npm run callbook:setup -- --cards-only                     # rewrite the registration files from the records
 *
 * For each agent in runner/callbook-agents.js, in order, skipping whatever the
 * chain already holds (so a second run, or a run after a crash, only does
 * what's missing):
 *   1. register an ERC-8004 identity: IdentityRegistry.register(agentURI),
 *      agentURI = ${CALLBOOK_REPORT_BASE}/arena/agents/<slug>.json
 *      (setAgentURI instead, when the agent exists with another URI)
 *   2. open its strategy book on Callbook, linked to that agent, sealed by the
 *      caller key (setCaller instead, when the book exists with another caller)
 *   3. file validationRequest(validator, agentId, requestURI, requestHash) for
 *      the book, with the book descriptor as a data: URI and its keccak256
 *
 * What counts as "already done": a book opened by the owner for the same
 * strategy and still open (its agentId identifies the agent); else the agent
 * recorded in deployments/callbook-<network>-books.json if the owner still
 * owns it; else a Registered event to the owner with our URI since the
 * Callbook deploy block. A request is filed when getValidationStatus(hash)
 * answers.
 *
 * --dry-run sends nothing and writes nothing: every step is an eth_call
 * (estimateGas) with state overrides standing in for what earlier steps would
 * have created (the agent's ERC-721 owner slot; the Callbook's code when it
 * isn't deployed yet), priced at the current gas price in USDC.
 *
 * Environment (keys are never printed):
 *   CALLBOOK_OWNER_KEY          owns the agents and books (CALLBOOK_OWNER_ADDRESS is enough for --dry-run)
 *   CALLBOOK_CALLER_ADDRESS     the key that seals (the runner's CALLBOOK_AGENT_KEY); else derived from CALLBOOK_AGENT_KEY
 *   CALLBOOK_VALIDATOR_ADDRESS  our validator (the runner's CALLBOOK_VALIDATOR_KEY); else derived from it
 *   CALLBOOK_REPORT_BASE        public URL of the app (default https://app.reins.one)
 *   CALLBOOK_MCP_URL            the MCP endpoint named in the registration files
 *   CALLBOOK_RPC                RPC URL (default: the chain's public RPCs, in turn)
 * Flags: --network, --dry-run, --yes, --rpc, --deployment <file>, --books <file>, --cards-dir <dir>,
 * --from-block <n>, --cards-only. Unknown flags stop the script; a real mainnet run needs --yes.
 *
 * The validation request's descriptor names the agent too (chain, contract,
 * book, agent), so a request filed for one agent can't be read as another's,
 * and setup refuses a filed request whose agent isn't the book's.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createPublicClient, createWalletClient, http, fallback, parseAbi, encodeFunctionData, encodeDeployData,
  decodeFunctionResult, parseEventLogs, getAddress, isAddress, formatEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arc, arcTestnet } from "viem/chains";

import { artifact } from "./artifact.js";
import { parseFlags, mainnetConfirmation } from "./cli-flags.js";
import { localChain, DEFAULT_LOCAL_RPC } from "./callbook-local-chain.js";
import { REGISTRIES, VALIDATION_REGISTRY_ABI } from "../evaluator/abi.js";
import { readCallbook } from "../app/verify/callbook-chain.js";
import { AGENTS } from "../runner/callbook-agents.js";
import { OUR_STRATEGIES } from "../app/verify/callbook-agents.js";
import {
  slugOf, agentUriFor, requestForBook, registrationFile, booksFromFile, mergeBooks, planAgent, pickAgentId, findBook,
  checkRoles, ownershipOverride, DEFAULT_BASE, DEFAULT_MCP, CARDS_PATH,
} from "./callbook-setup-lib.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LOG_CHUNK = 5_000n;
/** Where a dry run pretends an undeployed Callbook lives. Never sent to. */
const PLACEHOLDER = getAddress("0x00000000000000000000000000000000ca11b00c");
const RICH = 10n ** 24n; // balance override for gas estimates: 1,000,000 USDC

export const IDENTITY_ABI = parseAbi([
  "struct MetadataEntry { string metadataKey; bytes metadataValue; }",
  "function register() returns (uint256 agentId)",
  "function register(string agentURI) returns (uint256 agentId)",
  "function register(string agentURI, MetadataEntry[] metadata) returns (uint256 agentId)",
  "function setAgentURI(uint256 agentId, string newURI)",
  "function setMetadata(uint256 agentId, string metadataKey, bytes metadataValue)",
  "function getMetadata(uint256 agentId, string metadataKey) view returns (bytes)",
  "function tokenURI(uint256 agentId) view returns (string)",
  "function ownerOf(uint256 agentId) view returns (address)",
  "function getVersion() view returns (string)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);

const NETWORKS = { local: null, testnet: arcTestnet, mainnet: arc };

// ------------------------------------------------------------------ config

function readJson(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

const addressFromKey = (key) => (/^0x[0-9a-fA-F]{64}$/.test(key ?? "") ? privateKeyToAccount(key).address : null);

/** Everything setup needs, from flags and environment. Throws listing every problem. */
export const SETUP_FLAGS = {
  values: ["--network", "--rpc", "--deployment", "--books", "--cards-dir", "--from-block"],
  booleans: ["--dry-run", "--yes", "--cards-only"],
};

export function setupConfig({ argv = process.argv.slice(2), env = process.env } = {}) {
  const flags = parseFlags(argv, SETUP_FLAGS);
  const arg = flags.get;
  const network = arg("--network") ?? env.CALLBOOK_NETWORK;
  const dryRun = flags.has("--dry-run");
  const cardsOnly = flags.has("--cards-only");
  const problems = [...flags.problems];
  if (!cardsOnly && !(network in NETWORKS)) problems.push("--network must be local, testnet or mainnet");
  const unconfirmed = cardsOnly ? null : mainnetConfirmation({ network, dryRun, yes: flags.has("--yes") });
  if (unconfirmed) problems.push(unconfirmed);

  const ownerKey = env.CALLBOOK_OWNER_KEY || null;
  if (ownerKey && !/^0x[0-9a-fA-F]{64}$/.test(ownerKey)) problems.push("CALLBOOK_OWNER_KEY must be 0x + 64 hex");
  const owner = addressFromKey(ownerKey) ?? (dryRun ? env.CALLBOOK_OWNER_ADDRESS : null);
  const caller = env.CALLBOOK_CALLER_ADDRESS ?? addressFromKey(env.CALLBOOK_AGENT_KEY);
  const validator = env.CALLBOOK_VALIDATOR_ADDRESS ?? addressFromKey(env.CALLBOOK_VALIDATOR_KEY);
  if (!cardsOnly) {
    if (!owner || !isAddress(owner, { strict: false })) problems.push(dryRun ? "set CALLBOOK_OWNER_KEY (or CALLBOOK_OWNER_ADDRESS for a dry run)" : "CALLBOOK_OWNER_KEY is missing");
    if (!caller || !isAddress(caller, { strict: false })) problems.push("CALLBOOK_CALLER_ADDRESS is missing or not an address (the runner's sealing key; or set CALLBOOK_AGENT_KEY)");
    if (!validator || !isAddress(validator, { strict: false })) problems.push("CALLBOOK_VALIDATOR_ADDRESS is missing or not an address (the key that posts scores)");
    if (!problems.length) problems.push(...checkRoles({ owner, caller, validator }));
  }
  if (problems.length) throw new Error(`callbook:setup can't start:\n  - ${problems.join("\n  - ")}`);

  const deployment = arg("--deployment") ?? path.join(ROOT, "deployments", `callbook-${network}.json`);
  const local = network === "local";
  return {
    network, dryRun, cardsOnly, ownerKey, owner: owner && getAddress(owner), caller: caller && getAddress(caller),
    validator: validator && getAddress(validator),
    rpc: arg("--rpc") ?? env.CALLBOOK_RPC ?? (local ? DEFAULT_LOCAL_RPC : undefined),
    deployment,
    books: arg("--books") ?? deployment.replace(/\.json$/, "-books.json"),
    cardsDir: arg("--cards-dir") ?? (local ? path.join(ROOT, "deployments", "callbook-local-agents") : path.join(ROOT, "app", "public", ...CARDS_PATH.split("/"))),
    base: (env.CALLBOOK_REPORT_BASE || DEFAULT_BASE).replace(/\/+$/, ""),
    mcpUrl: env.CALLBOOK_MCP_URL || DEFAULT_MCP,
    fromBlock: arg("--from-block"),
  };
}

function clientsFor(cfg) {
  let chain = NETWORKS[cfg.network];
  let transport;
  if (cfg.network === "local") {
    chain = localChain(cfg.rpc);
    transport = http(cfg.rpc);
  } else {
    const urls = cfg.rpc ? [cfg.rpc] : chain.rpcUrls.default.http;
    transport = fallback(urls.map((u) => http(u, { retryCount: 4, retryDelay: 800 })));
  }
  const publicClient = createPublicClient({ chain, transport, pollingInterval: cfg.network === "local" ? 100 : 1_000 });
  const wallet = cfg.ownerKey ? createWalletClient({ account: privateKeyToAccount(cfg.ownerKey), chain, transport }) : null;
  return { chain, publicClient, wallet };
}

// ------------------------------------------------------------------ chain reads

async function registeredTo(publicClient, identity, owner, fromBlock) {
  const head = await publicClient.getBlockNumber();
  const out = [];
  for (let from = fromBlock; from <= head; from += LOG_CHUNK) {
    const to = from + LOG_CHUNK - 1n < head ? from + LOG_CHUNK - 1n : head;
    const logs = await publicClient.getLogs({ address: identity, event: IDENTITY_ABI.find((x) => x.name === "Registered"), args: { owner }, fromBlock: from, toBlock: to });
    out.push(...logs.map((l) => ({ agentId: Number(l.args.agentId), agentURI: l.args.agentURI })));
  }
  return out;
}

async function ownerOf(publicClient, identity, agentId) {
  try {
    return await publicClient.readContract({ address: identity, abi: IDENTITY_ABI, functionName: "ownerOf", args: [BigInt(agentId)] });
  } catch {
    return null;
  }
}

async function requestStatus(publicClient, registry, requestHash) {
  try {
    const [validator, agentId] = await publicClient.readContract({ address: registry, abi: VALIDATION_REGISTRY_ABI, functionName: "getValidationStatus", args: [requestHash] });
    return { validator, agentId: Number(agentId) };
  } catch {
    return null; // "unknown": not filed
  }
}

/** What the chain says about one agent: the facts planAgent works from. */
async function factsFor(ctx, agent, slug, recorded) {
  const { publicClient, identity, cfg } = ctx;
  const agentURI = agentUriFor(cfg.base, slug);
  const opened = [...ctx.books.values()].filter((b) => b.owner === cfg.owner.toLowerCase() && b.strategyHash.toLowerCase() === agent.strategyHash.toLowerCase() && b.closedAt == null && b.agentId != null);
  let fromRecord = null;
  if (recorded?.agentId != null && (await ownerOf(publicClient, identity, recorded.agentId))?.toLowerCase() === cfg.owner.toLowerCase()) fromRecord = recorded.agentId;
  let fromRegistered = [];
  if (!opened.length && fromRecord == null && ctx.scanFrom != null) {
    ctx.registered ??= await registeredTo(publicClient, identity, cfg.owner, ctx.scanFrom);
    // Registered names the first owner; only agents the owner still holds count.
    for (const r of ctx.registered.filter((x) => x.agentURI === agentURI)) {
      if ((await ownerOf(publicClient, identity, r.agentId))?.toLowerCase() === cfg.owner.toLowerCase()) fromRegistered.push(r);
    }
  }
  const agentId = pickAgentId({ fromBooks: opened.map((b) => b.agentId), fromRecord, fromRegistered }, agentURI);
  const tokenURI = agentId == null ? null : await publicClient.readContract({ address: identity, abi: IDENTITY_ABI, functionName: "tokenURI", args: [BigInt(agentId)] });
  const book = agentId == null ? null : findBook([...ctx.books.values()], { owner: cfg.owner, strategyHash: agent.strategyHash, agentId });
  const req = book ? requestForBook({ chainId: ctx.chainId, callbook: ctx.callbook, bookId: book.id, agentId }) : null;
  const request = req ? await requestStatus(publicClient, ctx.validation, req.requestHash) : null;
  return { agentURI, agentId, tokenURI, book, request };
}

// ------------------------------------------------------------------ steps

/**
 * One step as a transaction request: { to, abi, functionName, args, req? }.
 * `ids` carries the agent and book the step is about (predicted in a dry run).
 */
function stepCall(ctx, agent, step, ids, agentURI) {
  const cfg = ctx.cfg;
  switch (step) {
    case "register":
      return { to: ctx.identity, abi: IDENTITY_ABI, functionName: "register", args: [agentURI] };
    case "setAgentURI":
      return { to: ctx.identity, abi: IDENTITY_ABI, functionName: "setAgentURI", args: [BigInt(ids.agentId), agentURI] };
    case "open":
      return { to: ctx.callbook, abi: ctx.CB, functionName: "open", args: [BigInt(ids.agentId), cfg.caller, agent.strategyHash, agent.coins, agent.periodSec, agent.horizonSec] };
    case "setCaller":
      return { to: ctx.callbook, abi: ctx.CB, functionName: "setCaller", args: [BigInt(ids.bookId), cfg.caller] };
    case "request": {
      const req = requestForBook({ chainId: ctx.chainId, callbook: ctx.callbook, bookId: ids.bookId, agentId: ids.agentId });
      return { to: ctx.validation, abi: VALIDATION_REGISTRY_ABI, functionName: "validationRequest", args: [cfg.validator, BigInt(ids.agentId), req.requestURI, req.requestHash], req };
    }
    default:
      throw new Error(`unknown step ${step}`);
  }
}

/** eth_call + estimateGas for a step, with the overrides a dry run needs. Returns { gas, result }. */
async function simulate(ctx, call, { predictedAgentId } = {}) {
  const { publicClient, cfg } = ctx;
  const stateOverride = [{ address: cfg.owner, balance: RICH }];
  if (ctx.placeholderCode) stateOverride.push({ address: ctx.callbook, code: ctx.placeholderCode });
  if (predictedAgentId != null) stateOverride.push(ownershipOverride(ctx.identity, predictedAgentId, cfg.owner));
  const data = encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args });
  const tx = { account: cfg.owner, to: call.to, data, stateOverride };
  const { data: ret } = await publicClient.call(tx);
  const gas = cfg.network === "local" ? await estimateOnSnapshot(publicClient, tx) : await publicClient.estimateGas(tx);
  const result = ret && ret !== "0x" ? decodeFunctionResult({ abi: call.abi, functionName: call.functionName, data: ret, args: call.args }) : null;
  return { gas, result };
}

/**
 * A Hardhat node takes state overrides in eth_call but not in eth_estimateGas,
 * so locally the overrides are applied for real inside a snapshot that is
 * reverted straight after the estimate.
 */
async function estimateOnSnapshot(publicClient, { stateOverride, ...tx }) {
  const snapshot = await publicClient.request({ method: "evm_snapshot", params: [] });
  try {
    for (const o of stateOverride ?? []) {
      if (o.balance != null) await publicClient.request({ method: "hardhat_setBalance", params: [o.address, `0x${o.balance.toString(16)}`] });
      if (o.code) await publicClient.request({ method: "hardhat_setCode", params: [o.address, o.code] });
      for (const d of o.stateDiff ?? []) await publicClient.request({ method: "hardhat_setStorageAt", params: [o.address, d.slot, d.value] });
    }
    return await publicClient.estimateGas(tx);
  } finally {
    await publicClient.request({ method: "evm_revert", params: [snapshot] });
  }
}

async function send(ctx, call) {
  const { wallet, publicClient } = ctx;
  const hash = await wallet.writeContract({ address: call.to, abi: call.abi, functionName: call.functionName, args: call.args, account: wallet.account, chain: wallet.chain });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${call.functionName} reverted (${hash})`);
  return receipt;
}

/** Run (or, dry, simulate) one agent's remaining steps. Returns its book entry and what each step cost. */
async function doAgent(ctx, agent, slug, facts, steps) {
  const ids = { agentId: facts.agentId, bookId: facts.book?.id ?? null };
  const done = [];
  for (const step of steps) {
    const call = stepCall(ctx, agent, step, ids, facts.agentURI);
    if (ctx.cfg.dryRun) {
      const predictedAgentId = facts.agentId == null && step !== "register" ? ids.agentId : null;
      const { gas, result } = await simulate(ctx, call, { predictedAgentId });
      if (step === "register") ids.agentId = Number(result) + ctx.predicted.agents++;
      if (step === "open") ids.bookId = ctx.predicted.nextBook++;
      done.push({ step, gas, cost: gas * ctx.gasPrice, predicted: true, requestHash: call.req?.requestHash });
      continue;
    }
    const receipt = await send(ctx, call);
    if (step === "register") ids.agentId = Number(parseEventLogs({ abi: IDENTITY_ABI, logs: receipt.logs, eventName: "Registered" })[0].args.agentId);
    if (step === "open") ids.bookId = Number(parseEventLogs({ abi: ctx.CB, logs: receipt.logs, eventName: "Opened" })[0].args.bookId);
    done.push({ step, gas: receipt.gasUsed, cost: receipt.gasUsed * receipt.effectiveGasPrice, tx: receipt.transactionHash, requestHash: call.req?.requestHash });
  }
  const req = ids.bookId == null ? null : requestForBook({ chainId: ctx.chainId, callbook: ctx.callbook, bookId: ids.bookId, agentId: ids.agentId });
  return {
    entry: {
      key: agent.key, slug, name: agent.name, strategy: agent.strategy, strategyHash: agent.strategyHash,
      agentId: ids.agentId, agentURI: facts.agentURI, bookId: ids.bookId, coins: agent.coins, periodSec: agent.periodSec, horizonSec: agent.horizonSec,
      requestHash: req?.requestHash ?? null, requestURI: req?.requestURI ?? null, descriptor: req?.descriptor ?? null,
    },
    done,
  };
}

// ------------------------------------------------------------------ files

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Rewrite each agent's registration file, keeping books on other networks. `records`: books records to merge in. */
export function writeCards({ cardsDir, base, mcpUrl, records, agents = AGENTS }) {
  const written = [];
  for (const agent of agents) {
    const slug = slugOf(agent.strategy);
    const file = path.join(cardsDir, `${slug}.json`);
    let books = booksFromFile(readJson(file));
    for (const rec of records) {
      const e = rec?.agents?.find((a) => a.strategy === agent.strategy);
      if (!e || e.agentId == null || e.bookId == null) continue;
      books = mergeBooks(books, [{
        chainId: rec.chainId, identityRegistry: rec.identityRegistry, agentId: e.agentId, callbook: rec.callbook,
        bookId: e.bookId, requestHash: e.requestHash, validator: rec.validator,
      }]);
    }
    const description = OUR_STRATEGIES[agent.strategy]?.description ?? "";
    writeJson(file, registrationFile({ agent: { ...agent, description }, base, mcpUrl, books }));
    written.push(file);
  }
  return written;
}

// ------------------------------------------------------------------ main

/** Run setup. Returns { record, results, totals }. */
export async function runSetup(cfg, { log = (m) => console.log(`  ${m}`), agents = AGENTS } = {}) {
  const { chain, publicClient, wallet } = clientsFor(cfg);
  const chainId = await publicClient.getChainId();
  if (chainId !== chain.id) throw new Error(`RPC is chain ${chainId}, expected ${chain.id} for ${cfg.network}`);
  const dep = readJson(cfg.deployment);
  const known = REGISTRIES[chainId] ?? {};
  const identity = getAddress(known.identity ?? dep?.external?.identityRegistry ?? "0x0000000000000000000000000000000000000000");
  const validation = known.validation ?? dep?.external?.validationRegistry ?? process.env.CALLBOOK_VALIDATION_REGISTRY;
  if (!dep?.external?.identityRegistry && !known.identity) throw new Error(`no IdentityRegistry for chain ${chainId}`);
  if (!validation) throw new Error(`no ValidationRegistry for chain ${chainId} (local: deploy with scripts/callbook-local-chain.js)`);
  const CB = artifact("Callbook").abi;

  const ctx = { cfg, publicClient, wallet, chainId, identity, validation: getAddress(validation), CB, books: new Map(), placeholderCode: null };
  if (dep?.contracts?.callbook) {
    if (Number(dep.chainId) !== chainId) throw new Error(`${cfg.deployment} is for chain ${dep.chainId}, not ${chainId}`);
    ctx.callbook = getAddress(dep.contracts.callbook);
    const fromBlock = BigInt(cfg.fromBlock ?? dep.fromBlock ?? 0);
    ctx.scanFrom = fromBlock;
    ctx.books = (await readCallbook({ client: publicClient, address: ctx.callbook, fromBlock })).books;
  } else if (cfg.dryRun) {
    // Not deployed yet: run the constructor in an eth_call and stand its runtime code in at a placeholder.
    const { bytecode } = artifact("Callbook");
    const { data } = await publicClient.call({ account: cfg.owner, data: encodeDeployData({ abi: CB, bytecode, args: [identity] }), stateOverride: [{ address: cfg.owner, balance: RICH }] });
    ctx.callbook = PLACEHOLDER;
    ctx.placeholderCode = data;
    ctx.scanFrom = null;
    log(`Callbook not deployed on ${cfg.network}: simulating a fresh one (constructor run in eth_call) at ${PLACEHOLDER}`);
  } else {
    throw new Error(`${path.relative(ROOT, cfg.deployment)} not found: deploy Callbook first (npm run deploy:callbook -- --network ${cfg.network})`);
  }

  ctx.gasPrice = await publicClient.getGasPrice();
  const bookCount = await publicClient.readContract({ address: ctx.callbook, abi: CB, functionName: "bookCount", stateOverride: ctx.placeholderCode ? [{ address: ctx.callbook, code: ctx.placeholderCode }] : undefined });
  ctx.predicted = { agents: 0, nextBook: Number(bookCount) + 1 };
  const balance = await publicClient.getBalance({ address: cfg.owner });
  log(`${cfg.network} (chain ${chainId})${cfg.dryRun ? " DRY RUN" : ""} · owner ${cfg.owner} · balance ${formatEther(balance)} USDC · gas price ${Number(ctx.gasPrice) / 1e9} gwei`);
  log(`Callbook ${ctx.callbook} · IdentityRegistry ${identity} · ValidationRegistry ${ctx.validation}`);
  log(`caller ${cfg.caller} · validator ${cfg.validator} · agent URIs under ${cfg.base}/${CARDS_PATH}/`);

  const previous = readJson(cfg.books);
  const results = [];
  for (const agent of agents) {
    const slug = slugOf(agent.strategy);
    const facts = await factsFor(ctx, agent, slug, previous?.agents?.find((a) => a.strategy === agent.strategy));
    const steps = planAgent(facts, { agentURI: facts.agentURI, caller: cfg.caller, validator: cfg.validator, agentId: facts.agentId });
    if (!cfg.dryRun && steps.length && !wallet) throw new Error("CALLBOOK_OWNER_KEY is needed to send");
    const { entry, done } = await doAgent(ctx, agent, slug, facts, steps);
    results.push({ entry, done, skipped: ["register", "open", "request"].filter((s) => !steps.includes(s)) });
    const what = done.map((d) => `${d.step} ${d.gas} gas ≈ ${formatEther(d.cost)} USDC${d.tx ? ` ${d.tx}` : ""}`).join("; ");
    log(`${agent.name.padEnd(10)} agent #${entry.agentId ?? "?"}${done.some((d) => d.predicted && d.step === "register") ? " (predicted)" : ""} · book #${entry.bookId ?? "?"} · ${what || "nothing to do"}`);
  }

  const gasTotal = results.flatMap((r) => r.done).reduce((s, d) => s + d.gas, 0n);
  const costTotal = results.flatMap((r) => r.done).reduce((s, d) => s + d.cost, 0n);
  log(`total ${gasTotal} gas ≈ ${formatEther(costTotal)} USDC${cfg.dryRun ? " at the current gas price" : ""}`);

  const record = {
    network: cfg.network, chainId, callbook: ctx.callbook, identityRegistry: identity, validationRegistry: ctx.validation,
    owner: cfg.owner, caller: cfg.caller, validator: cfg.validator, agentUriBase: `${cfg.base}/${CARDS_PATH}/`,
    agents: results.map((r) => ({ ...r.entry, txs: mergeTxs(previous, r) })),
    updatedAt: new Date().toISOString(),
  };
  if (cfg.dryRun) {
    if (balance < (costTotal * 3n) / 2n) log(`the owner needs ~${formatEther((costTotal * 3n) / 2n)} USDC (estimate + 50%) before the real run`);
    log("dry run: nothing sent, nothing written");
  } else {
    writeJson(cfg.books, record);
    const cards = writeCards({ cardsDir: cfg.cardsDir, base: cfg.base, mcpUrl: cfg.mcpUrl, records: [record] });
    log(`wrote ${path.relative(ROOT, cfg.books)} and ${cards.length} registration files in ${path.relative(ROOT, cfg.cardsDir)}`);
  }
  return { record, results, totals: { gas: gasTotal, cost: costTotal, gasPrice: ctx.gasPrice } };
}

function mergeTxs(previous, r) {
  const before = previous?.agents?.find((a) => a.strategy === r.entry.strategy)?.txs ?? {};
  return { ...before, ...Object.fromEntries(r.done.filter((d) => d.tx).map((d) => [d.step, d.tx])) };
}

async function main() {
  const cfg = setupConfig();
  if (cfg.cardsOnly) {
    const records = ["testnet", "mainnet"].map((n) => readJson(path.join(ROOT, "deployments", `callbook-${n}-books.json`))).filter(Boolean);
    const files = writeCards({ cardsDir: cfg.cardsDir, base: cfg.base, mcpUrl: cfg.mcpUrl, records });
    console.log(`\n  wrote ${files.length} registration files from ${records.length} record(s) into ${path.relative(ROOT, cfg.cardsDir)}\n`);
    return;
  }
  console.log("");
  await runSetup(cfg);
  console.log("");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\n  setup failed: ${err.shortMessage ?? err.message}\n`);
    process.exit(1);
  });
}

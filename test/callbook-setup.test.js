/**
 * `npm run callbook:setup`: registering our agents on ERC-8004, opening their
 * books and filing validation requests, without ever doing a step twice.
 *
 * The pure parts (registration file, request descriptor, step planning) run
 * everywhere. The end-to-end runs need a Hardhat node on
 * CALLBOOK_SETUP_TEST_RPC (default http://127.0.0.1:8547) and skip themselves
 * when there isn't one; each deploys fresh registries and a fresh Callbook.
 */
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPublicClient, createWalletClient, http, keccak256, toBytes } from "viem";
import { mnemonicToAccount } from "viem/accounts";

import {
  slugOf, agentUriFor, requestForBook, registrationFile, booksFromFile, mergeBooks, planAgent, pickAgentId, findBook,
  checkRoles, ownerSlot, agentRegistryOf, REGISTRATION_TYPE,
} from "../scripts/callbook-setup-lib.js";
import { setupConfig, runSetup, writeCards, IDENTITY_ABI } from "../scripts/callbook-setup.js";
import { deployLocal, localChain, HARDHAT_MNEMONIC } from "../scripts/callbook-local-chain.js";
import { parseValidationRequest, readCallbook } from "../app/verify/callbook-chain.js";
import { AGENTS } from "../runner/callbook-agents.js";
import { artifact } from "../scripts/artifact.js";
import { VALIDATION_REGISTRY_ABI } from "../evaluator/abi.js";

const BASE = "https://app.reins.one";
const CALLBOOK = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0";
const MAIN_ID = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const TEST_ID = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";
const hot = { ...AGENTS.find((a) => a.key === "hot"), description: "Goes long the hottest coin." };

// ------------------------------------------------------------------ names, URIs, descriptors

describe("names and requests", () => {
  test("a slug is the strategy id's name part", () => {
    assert.equal(slugOf("reins/arena/hot-list/v1"), "hot-list");
    assert.equal(slugOf("reins/arena/coin-flip/v1"), "coin-flip");
    assert.deepEqual(AGENTS.map((a) => slugOf(a.strategy)), ["hot-list", "cold-list", "coin-flip"]);
  });

  test("agent URIs live under /arena/agents, whatever the base's trailing slash", () => {
    assert.equal(agentUriFor(BASE, "hot-list"), "https://app.reins.one/arena/agents/hot-list.json");
    assert.equal(agentUriFor(`${BASE}/`, "hot-list"), "https://app.reins.one/arena/agents/hot-list.json");
  });

  test("a book's request is a data: URI of the canonical descriptor and its keccak256", () => {
    const r = requestForBook({ chainId: 5042, callbook: CALLBOOK, bookId: 7 });
    assert.equal(r.descriptor, `{"bookId":"7","callbook":"${CALLBOOK.toLowerCase()}","chainId":5042,"scoring":"arena-v1"}`);
    assert.equal(r.requestHash, keccak256(toBytes(r.descriptor)));
    assert.equal(r.requestURI, `data:application/json;base64,${Buffer.from(r.descriptor).toString("base64")}`);
    assert.deepEqual(parseValidationRequest(r.requestURI, r.requestHash), { chainId: 5042, callbook: CALLBOOK.toLowerCase(), bookId: 7 });
  });

  test("the same book on another chain or contract is another request", () => {
    const a = requestForBook({ chainId: 5042, callbook: CALLBOOK, bookId: 1 }).requestHash;
    assert.notEqual(a, requestForBook({ chainId: 5042002, callbook: CALLBOOK, bookId: 1 }).requestHash);
    assert.notEqual(a, requestForBook({ chainId: 5042, callbook: A, bookId: 1 }).requestHash);
    assert.notEqual(a, requestForBook({ chainId: 5042, callbook: CALLBOOK, bookId: 2 }).requestHash);
  });

  test("the ERC-721 owner slot matches OpenZeppelin's ERC-7201 layout (agent 0's, read on Arc mainnet)", () => {
    assert.equal(ownerSlot(0), "0x4ec63b08e96ab700bfcbd7fae8e840edde8dd056fe07ad2bc9f7c74dbfee1ce8");
  });
});

// ------------------------------------------------------------------ the registration file

describe("registration file", () => {
  const testnetBook = { chainId: 5042002, identityRegistry: TEST_ID, agentId: 12, callbook: A, bookId: 3, requestHash: "0xaa", validator: C };
  const mainnetBook = { chainId: 5042, identityRegistry: MAIN_ID, agentId: 1413, callbook: B, bookId: 1, requestHash: "0xbb", validator: C };

  test("has the ERC-8004 registration-v1 shape before any registration", () => {
    const f = registrationFile({ agent: hot, base: BASE });
    assert.equal(f.type, REGISTRATION_TYPE);
    assert.equal(f.name, "Arena: Hot list");
    assert.match(f.description, /^Goes long the hottest coin\. /);
    assert.equal(f.image, "https://app.reins.one/favicon.svg");
    assert.deepEqual(f.services[0], { name: "web", endpoint: "https://app.reins.one/arena" });
    assert.equal(f.services[1].name, "MCP");
    assert.equal(f.active, true);
    assert.equal(f.x402Support, false);
    assert.deepEqual(f.registrations, []);
    assert.deepEqual(f.supportedTrust, ["validation"]);
    assert.equal(f.callbook.strategyHash, hot.strategyHash);
  });

  test("lists every registration as eip155:<chain>:<registry> and points the web service at the mainnet book", () => {
    const f = registrationFile({ agent: hot, base: BASE, books: [mainnetBook, testnetBook] });
    assert.deepEqual(f.registrations, [
      { agentId: 1413, agentRegistry: `eip155:5042:${MAIN_ID}` },
      { agentId: 12, agentRegistry: `eip155:5042002:${TEST_ID}` },
    ]);
    assert.equal(f.services[0].endpoint, "https://app.reins.one/arena-bot?b=1");
    assert.equal(f.callbook.books.find((b) => b.chainId === 5042).page, "https://app.reins.one/arena-bot?b=1");
    assert.equal(f.callbook.books.find((b) => b.chainId === 5042002).page, null);
  });

  test("falls back to the testnet book while there is no mainnet one", () => {
    const f = registrationFile({ agent: hot, base: BASE, books: [testnetBook] });
    assert.equal(f.services[0].endpoint, "https://app.reins.one/arena-bot?b=3");
  });

  test("a rewrite for one network keeps the other network's book", () => {
    const before = registrationFile({ agent: hot, base: BASE, books: [testnetBook] });
    const kept = booksFromFile(JSON.parse(JSON.stringify(before)));
    assert.equal(kept.length, 1);
    assert.equal(kept[0].identityRegistry, TEST_ID);
    const merged = mergeBooks(kept, [mainnetBook]);
    assert.equal(merged.length, 2);
    // A newer book on the same chain and contract replaces the old one.
    const replaced = mergeBooks(merged, [{ ...testnetBook, bookId: 9 }]);
    assert.equal(replaced.length, 2);
    assert.equal(replaced.find((b) => b.chainId === 5042002).bookId, 9);
  });

  test("agentRegistry is checksummed", () => {
    assert.equal(agentRegistryOf(5042, MAIN_ID.toLowerCase()), `eip155:5042:${MAIN_ID}`);
  });
});

// ------------------------------------------------------------------ idempotency

describe("planning", () => {
  const want = { agentURI: "u", caller: A, validator: C };

  test("nothing on chain: register, open, request", () => {
    assert.deepEqual(planAgent({ agentId: null, book: null, request: null }, want), ["register", "open", "request"]);
  });

  test("everything on chain: nothing to do (addresses compared without case)", () => {
    const facts = { agentId: 4, tokenURI: "u", book: { id: 1, caller: A.toLowerCase() }, request: { validator: C.toLowerCase() } };
    assert.deepEqual(planAgent(facts, want), []);
  });

  test("a crash after registering resumes at open", () => {
    assert.deepEqual(planAgent({ agentId: 4, tokenURI: "u", book: null, request: null }, want), ["open", "request"]);
  });

  test("a moved agent URI is updated, a rotated caller key is set, nothing else", () => {
    const facts = { agentId: 4, tokenURI: "old", book: { id: 1, caller: B }, request: { validator: C } };
    assert.deepEqual(planAgent(facts, want), ["setAgentURI", "setCaller"]);
  });

  test("a request already filed for another validator is an error, not a silent skip", () => {
    const facts = { agentId: 4, tokenURI: "u", book: { id: 1, caller: A }, request: { validator: B } };
    assert.throws(() => planAgent(facts, want), /already names validator/);
  });

  test("a request filed for another agent is an error too", () => {
    const facts = { agentId: 4, tokenURI: "u", book: { id: 1, caller: A }, request: { validator: C, agentId: 9 } };
    assert.throws(() => planAgent(facts, { ...want, agentId: 4 }), /filed for agent #9, not agent #4/);
    assert.deepEqual(planAgent({ ...facts, request: { validator: C, agentId: 4 } }, { ...want, agentId: 4 }), []);
  });

  test("our agent: a book's agent, then the record, then a registration with our URI", () => {
    assert.equal(pickAgentId({ fromBooks: [3, 8], fromRecord: 5, fromRegistered: [{ agentId: 1, agentURI: "u" }] }, "u"), 8);
    assert.equal(pickAgentId({ fromRecord: 5, fromRegistered: [{ agentId: 1, agentURI: "u" }] }, "u"), 5);
    assert.equal(pickAgentId({ fromRegistered: [{ agentId: 1, agentURI: "x" }, { agentId: 2, agentURI: "u" }] }, "u"), 2);
    assert.equal(pickAgentId({ fromRegistered: [{ agentId: 1, agentURI: "x" }] }, "u"), null);
  });

  test("our book: same owner, strategy and agent, still open, newest", () => {
    const s = hot.strategyHash;
    const books = [
      { id: 1, owner: A.toLowerCase(), strategyHash: s, agentId: 4, closedAt: null },
      { id: 2, owner: A.toLowerCase(), strategyHash: s, agentId: 4, closedAt: 123 },
      { id: 3, owner: B.toLowerCase(), strategyHash: s, agentId: 4, closedAt: null },
      { id: 4, owner: A.toLowerCase(), strategyHash: "0x01", agentId: 4, closedAt: null },
      { id: 5, owner: A.toLowerCase(), strategyHash: s, agentId: 9, closedAt: null },
      { id: 6, owner: A.toLowerCase(), strategyHash: s, agentId: 4, closedAt: null },
    ];
    assert.equal(findBook(books, { owner: A, strategyHash: s, agentId: 4 }).id, 6);
    assert.equal(findBook(books.slice(1, 5), { owner: A, strategyHash: s, agentId: 4 }), null);
  });

  test("owner, caller and validator must be three different keys", () => {
    assert.deepEqual(checkRoles({ owner: A, caller: B, validator: C }), []);
    assert.equal(checkRoles({ owner: A, caller: A.toLowerCase(), validator: C }).length, 1);
    assert.equal(checkRoles({ owner: A, caller: B, validator: A }).length, 1);
    assert.equal(checkRoles({ owner: A, caller: A, validator: A }).length, 3);
  });
});

describe("configuration", () => {
  const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // Hardhat test account 1
  const env = { CALLBOOK_CALLER_ADDRESS: B, CALLBOOK_VALIDATOR_ADDRESS: C };

  test("a real run needs the owner key; a dry run can do with the owner's address", () => {
    assert.throws(() => setupConfig({ argv: ["--network", "testnet"], env: { ...env, CALLBOOK_OWNER_ADDRESS: A } }), /CALLBOOK_OWNER_KEY is missing/);
    const cfg = setupConfig({ argv: ["--network", "testnet", "--dry-run"], env: { ...env, CALLBOOK_OWNER_ADDRESS: A } });
    assert.equal(cfg.owner, A);
    assert.equal(cfg.dryRun, true);
    assert.match(cfg.books, /callbook-testnet-books\.json$/);
    assert.match(cfg.cardsDir, /app[\\/]public[\\/]arena[\\/]agents$/);
  });

  test("the owner comes from the key, never printed; shared roles are refused", () => {
    const cfg = setupConfig({ argv: ["--network", "mainnet", "--yes"], env: { ...env, CALLBOOK_OWNER_KEY: KEY } });
    assert.equal(cfg.owner, "0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    assert.throws(() => setupConfig({ argv: ["--network", "mainnet", "--yes"], env: { ...env, CALLBOOK_OWNER_KEY: KEY, CALLBOOK_CALLER_ADDRESS: cfg.owner } }), /different keys/);
  });

  test("an unknown network is refused", () => {
    assert.throws(() => setupConfig({ argv: ["--network", "goerli", "--dry-run"], env: { ...env, CALLBOOK_OWNER_ADDRESS: A } }), /--network must be/);
  });

  test("a real mainnet run needs --yes; a dry run doesn't", () => {
    const keyed = { ...env, CALLBOOK_OWNER_KEY: KEY };
    assert.throws(() => setupConfig({ argv: ["--network", "mainnet"], env: keyed }), /real transactions on Arc mainnet.*--yes/);
    assert.equal(setupConfig({ argv: ["--network", "mainnet", "--dry-run"], env: keyed }).dryRun, true);
    assert.equal(setupConfig({ argv: ["--network", "testnet"], env: keyed }).network, "testnet");
  });

  test("unknown flags and stray words stop it, so a typo never runs for real", () => {
    const keyed = { ...env, CALLBOOK_OWNER_KEY: KEY };
    assert.throws(() => setupConfig({ argv: ["--network", "testnet", "--dryrun"], env: keyed }), /unknown flag --dryrun/);
    assert.throws(() => setupConfig({ argv: ["--network", "testnet", "dry-run"], env: keyed }), /unexpected argument "dry-run"/);
    assert.throws(() => setupConfig({ argv: ["--network"], env: keyed }), /--network needs a value/);
    assert.equal(setupConfig({ argv: ["--network=testnet", "--rpc=http://x"], env: keyed }).rpc, "http://x");
  });

  test("a missing caller is a sentence", () => {
    assert.throws(() => setupConfig({ argv: ["--network", "testnet"], env: { CALLBOOK_OWNER_KEY: KEY, CALLBOOK_VALIDATOR_ADDRESS: C } }), /CALLBOOK_CALLER_ADDRESS is missing/);
  });
});

// ------------------------------------------------------------------ against a local node

const RPC = process.env.CALLBOOK_SETUP_TEST_RPC ?? "http://127.0.0.1:8547";
const chain = localChain(RPC);
const pc = createPublicClient({ chain, transport: http(RPC), pollingInterval: 100 });
const acct = (i) => mnemonicToAccount(HARDHAT_MNEMONIC, { addressIndex: i });
const keyOf = (i) => `0x${Buffer.from(acct(i).getHdKey().privateKey).toString("hex")}`;
let nodeUp = false;
before(async () => {
  try {
    nodeUp = (await pc.getChainId()) === 31337;
  } catch {
    nodeUp = false;
  }
});

/** Fresh registries and Arena, and a setup config pointing at them with files in a temp dir. */
async function freshSetup({ caller = acct(2).address, dryRun = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "callbook-setup-"));
  const deployment = path.join(dir, "callbook-local.json");
  const dep = await deployLocal({ rpc: RPC, out: deployment });
  const argv = ["--network", "local", "--rpc", RPC, "--deployment", deployment, "--cards-dir", path.join(dir, "agents"), ...(dryRun ? ["--dry-run"] : [])];
  const env = { CALLBOOK_OWNER_KEY: keyOf(1), CALLBOOK_CALLER_ADDRESS: caller, CALLBOOK_VALIDATOR_ADDRESS: acct(3).address };
  return { dir, dep, cfg: (over = {}) => setupConfig({ argv: [...argv, ...(over.argv ?? [])], env: { ...env, ...over.env } }) };
}
const quiet = { log: () => {} };
const stepsOf = (res) => res.results.map((r) => r.done.map((d) => d.step));

test("on a local node: a dry run predicts every step and changes nothing", async (t) => {
  if (!nodeUp) return t.skip(`no Hardhat node at ${RPC}`);
  const { dep, cfg } = await freshSetup();
  const res = await runSetup(cfg({ argv: ["--dry-run"] }), quiet);
  assert.deepEqual(stepsOf(res), AGENTS.map(() => ["register", "open", "request"]));
  assert.deepEqual(res.record.agents.map((a) => [a.agentId, a.bookId]), [[0, 1], [1, 2], [2, 3]]);
  for (const d of res.results.flatMap((r) => r.done)) assert.ok(d.gas > 20_000n && d.gas < 1_000_000n, `${d.step} ${d.gas}`);
  assert.equal(await pc.readContract({ address: dep.contracts.callbook, abi: artifact("Callbook").abi, functionName: "bookCount" }), 0n);
  assert.equal(existsSync(cfg().books), false);
});

test("on a local node: registers, opens and requests once; a second run does nothing", async (t) => {
  if (!nodeUp) return t.skip(`no Hardhat node at ${RPC}`);
  const { dep, cfg } = await freshSetup();
  const first = await runSetup(cfg(), quiet);
  assert.deepEqual(stepsOf(first), AGENTS.map(() => ["register", "open", "request"]));

  const identity = dep.external.identityRegistry;
  const state = await readCallbook({ client: pc, address: dep.contracts.callbook, fromBlock: BigInt(dep.fromBlock) });
  for (const [i, a] of first.record.agents.entries()) {
    assert.equal(await pc.readContract({ address: identity, abi: IDENTITY_ABI, functionName: "ownerOf", args: [BigInt(a.agentId)] }), acct(1).address);
    assert.equal(await pc.readContract({ address: identity, abi: IDENTITY_ABI, functionName: "tokenURI", args: [BigInt(a.agentId)] }), agentUriFor(BASE, a.slug));
    const book = state.books.get(a.bookId);
    assert.equal(book.agentId, a.agentId);
    assert.equal(book.caller, acct(2).address.toLowerCase());
    assert.equal(book.strategyHash, AGENTS[i].strategyHash);
    assert.deepEqual(book.coins, AGENTS[i].coins);
    const [validator, agentId] = await pc.readContract({ address: dep.external.validationRegistry, abi: VALIDATION_REGISTRY_ABI, functionName: "getValidationStatus", args: [a.requestHash] });
    assert.equal(validator, acct(3).address);
    assert.equal(Number(agentId), a.agentId);
  }

  const rec = JSON.parse(readFileSync(cfg().books, "utf8"));
  assert.equal(rec.agents.length, AGENTS.length);
  assert.ok(rec.agents.every((a) => a.txs.register && a.txs.open && a.txs.request));
  const card = JSON.parse(readFileSync(path.join(cfg().cardsDir, "hot-list.json"), "utf8"));
  assert.deepEqual(card.registrations, [{ agentId: first.record.agents[0].agentId, agentRegistry: agentRegistryOf(31337, identity) }]);

  const second = await runSetup(cfg(), quiet);
  assert.deepEqual(stepsOf(second), AGENTS.map(() => []));
  assert.deepEqual(second.record.agents.map((a) => [a.agentId, a.bookId]), first.record.agents.map((a) => [a.agentId, a.bookId]));
  // The record keeps the first run's transactions.
  assert.deepEqual(JSON.parse(readFileSync(cfg().books, "utf8")).agents[0].txs, rec.agents[0].txs);
});

test("on a local node: resumes after a crash, finds a registered agent by its URI, and rotates the caller", async (t) => {
  if (!nodeUp) return t.skip(`no Hardhat node at ${RPC}`);
  const { dep, cfg } = await freshSetup();
  // A run that died right after registering the first agent: no book, no record.
  const owner = createWalletClient({ account: acct(1), chain, transport: http(RPC) });
  const hash = await owner.writeContract({ address: dep.external.identityRegistry, abi: IDENTITY_ABI, functionName: "register", args: [agentUriFor(BASE, "hot-list")] });
  await pc.waitForTransactionReceipt({ hash });

  const res = await runSetup(cfg(), quiet);
  assert.deepEqual(stepsOf(res), [["open", "request"], ["register", "open", "request"], ["register", "open", "request"]]);
  assert.equal(res.record.agents[0].agentId, 0);

  // The runner's key moves: only setCaller, on every book.
  const rotated = await runSetup(cfg({ env: { CALLBOOK_CALLER_ADDRESS: acct(4).address } }), quiet);
  assert.deepEqual(stepsOf(rotated), AGENTS.map(() => ["setCaller"]));
  const state = await readCallbook({ client: pc, address: dep.contracts.callbook, fromBlock: BigInt(dep.fromBlock) });
  for (const a of rotated.record.agents) assert.equal(state.books.get(a.bookId).caller, acct(4).address.toLowerCase());
});

test("writeCards rebuilds the files from records of both networks", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "callbook-cards-"));
  const rec = (chainId, identityRegistry, callbook, base) => ({
    chainId, identityRegistry, callbook, validator: C,
    agents: AGENTS.map((a, i) => ({ strategy: a.strategy, agentId: base + i, bookId: i + 1, requestHash: `0x0${i}` })),
  });
  writeCards({ cardsDir: dir, base: BASE, mcpUrl: "https://example.org/mcp", records: [rec(5042002, TEST_ID, A, 100)] });
  writeCards({ cardsDir: dir, base: BASE, mcpUrl: "https://example.org/mcp", records: [rec(5042, MAIN_ID, B, 1413)] });
  const flip = JSON.parse(readFileSync(path.join(dir, "coin-flip.json"), "utf8"));
  assert.deepEqual(flip.registrations.map((r) => r.agentId), [1415, 102]);
  assert.equal(flip.services[0].endpoint, "https://app.reins.one/arena-bot?b=3");
  assert.equal(flip.services[1].endpoint, "https://example.org/mcp");
  assert.match(flip.description, /control/);
});

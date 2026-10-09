/**
 * The fixes from the Arena security review, one test (or more) each:
 *
 *   H1  the runner acts only on books owned by our owner and in our record
 *   H2  relayer: see test/callbook-callers.test.js; IP buckets and counters here
 *   H3  coins resolved before fetching, unscorable books listed, period cap
 *   H4  names and `ours` only for our books by owner and record
 *   H5  off local, validations ignored without a valid CALLBOOK_VALIDATOR
 *   M2  agentMoved when the ERC-8004 agent changed hands
 *   M3  scores posted only for allowlisted books, within a daily gas cap
 *   M5  no Math.max(...spread) on long arrays; report cache and limit
 *   M6  fromBlock required off local; chain-state snapshots
 *   L9  logged errors carry no URLs
 *
 * The on-chain half needs a Hardhat node on CALLBOOK_TEST_RPC (default :8546)
 * and skips itself without one.
 */
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { createPublicClient, createWalletClient, http, defineChain, parseEventLogs } from "viem";
import { mnemonicToAccount } from "viem/accounts";

import {
  deriveCalls, scoreBook, evaluateBook, buildCallbook, readCallbook, snapshotText, stateFromSnapshot, MAX_PERIODS, latestResponse,
} from "../app/verify/callbook.js";
import { priceBook } from "../app/verify/callbook-prices.js";
import { agentInfo, isOurBook, strategyHashOf } from "../app/verify/callbook-agents.js";
import { callbookNetwork, ourBooksFrom } from "../app/verify/callbook-network.js";
import { publishScores } from "../app/verify/callbook-publish.js";
import { maxOf, minOf, brief, ipBucket, memoryCounter, restCounter, countersFromEnv } from "../app/verify/callbook-util.js";
import { ourBooks, tick, writeSnapshot } from "../runner/callbook.js";
import { AGENTS } from "../runner/callbook-agents.js";
import { mountCallbook } from "../app/callbook-routes.js";
import { artifact } from "../scripts/artifact.js";

const HOUR = 3600, DAY = 86400, P = 4 * HOUR;
const T0 = 1_790_000_000 - (1_790_000_000 % P);
const OWNER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const OTHER = "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65";
const CALLER = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const HOT = AGENTS.find((a) => a.key === "hot");
const ours = { owner: OWNER, bookIds: new Set([1, 2]), order: [2, 1] };

const bookOf = (over = {}) => ({
  id: 1, kind: "scheduled", owner: OWNER, agentId: 7, caller: CALLER, strategyHash: HOT.strategyHash, coins: ["BTC", "ETH"],
  periodSec: P, horizonSec: P, start: T0, openedAt: T0 - P, closedAt: null, seals: new Map(), ...over,
});

function synthetic(coins, t0, t1, price = () => 100) {
  const candles = {}, funding = {};
  for (const c of coins) {
    candles[c] = []; funding[c] = [];
    for (let t = Math.floor(t0 / HOUR) * HOUR; t <= t1; t += HOUR) {
      candles[c].push({ t, o: price(c, t), h: price(c, t), l: price(c, t), c: price(c, t + HOUR), v: 1 });
      funding[c].push([t, 0]);
    }
  }
  return { interval: "1h", candles, funding, fundingOk: true };
}

// ------------------------------------------------------------------ H1, H4

describe("H1/H4: which books are ours", () => {
  const chainOf = (books) => ({ books: new Map(books.map((b) => [b.id, b])) });

  test("the runner skips a book with our caller and strategy but someone else's owner, or not in our record", () => {
    const chain = chainOf([
      bookOf({ id: 1 }),
      bookOf({ id: 2, owner: OTHER }), // an impostor: in the record's id range, wrong owner
      bookOf({ id: 3 }), // our owner, but not in the record
      bookOf({ id: 4, kind: "free" }),
    ]);
    assert.deepEqual(ourBooks(chain, CALLER, ours).map((x) => x.book.id), [1]);
    assert.deepEqual(ourBooks(chain, CALLER, null), [], "no record, no books");
  });

  test("our books come first, in record order, and a pass is capped", () => {
    const chain = chainOf([bookOf({ id: 1 }), bookOf({ id: 2 })]);
    assert.deepEqual(ourBooks(chain, CALLER, ours).map((x) => x.book.id), [2, 1]);
    assert.equal(ourBooks(chain, CALLER, ours, 1).length, 1);
  });

  test("tick refuses to run without our owner", async () => {
    await assert.rejects(tick({ log: () => {} }), /owner/);
  });

  test("names and `ours` only when owner and record agree; else Book #N", () => {
    const base = { chainId: 5042, callbook: "0x01", strategyHash: HOT.strategyHash };
    assert.equal(agentInfo({ ...base, bookId: 1, owner: OWNER, ours }).name, "Hot list");
    assert.equal(agentInfo({ ...base, bookId: 1, owner: OWNER, ours }).ours, true);
    const fake = agentInfo({ ...base, bookId: 2, owner: OTHER, ours });
    assert.deepEqual([fake.name, fake.ours], ["Book #2", false], "same strategy hash, another owner");
    assert.equal(agentInfo({ ...base, bookId: 9, owner: OWNER, ours }).name, "Book #9", "not in the record");
    assert.equal(agentInfo({ ...base, bookId: 1, owner: OWNER }).name, "Book #1", "no record at all");
    assert.equal(isOurBook(ours, { bookId: 1, owner: OWNER.toUpperCase().replace("0X", "0x") }), true);
  });

  test("the books record: owner from it or CALLBOOK_OWNER, ignored for another contract", () => {
    const record = { owner: OWNER, callbook: "0xAA", agents: [{ bookId: 1 }, { bookId: 2 }] };
    const o = ourBooksFrom({ record, callbook: "0xaa" });
    assert.deepEqual([o.owner, [...o.bookIds]], [OWNER, [1, 2]]);
    assert.equal(ourBooksFrom({ record, callbook: "0xbb" }).bookIds.size, 0);
    assert.equal(ourBooksFrom({ record, owner: OTHER, callbook: "0xaa" }).bookIds.size, 0, "a record for another owner gives no books");
    assert.equal(ourBooksFrom({ record: null }), null);
  });
});

// ------------------------------------------------------------------ H5, M6

describe("H5/M6: network config", () => {
  const ADDR = "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0";
  test("off local, a missing or invalid validator turns validations off", () => {
    // Mainnet has no deployment record yet, so nothing names a validator there (testnet's record does).
    const net = callbookNetwork({ CALLBOOK_NETWORK: "mainnet", CALLBOOK_ADDRESS: ADDR, CALLBOOK_FROM_BLOCK: "100" });
    assert.equal(net.registry, null);
    assert.match(net.validationOff, /ARENA_VALIDATOR/);
    const bad = callbookNetwork({ CALLBOOK_NETWORK: "mainnet", CALLBOOK_ADDRESS: ADDR, CALLBOOK_FROM_BLOCK: "100", CALLBOOK_VALIDATOR: "0x123" });
    assert.equal(bad.registry, null);
    // The deployment record can name it (testnet's does), and a setting overrides the record.
    assert.match(callbookNetwork({ CALLBOOK_NETWORK: "testnet", CALLBOOK_ADDRESS: ADDR, CALLBOOK_FROM_BLOCK: "100" }).registry, /^0x8004/);
    const good = callbookNetwork({ CALLBOOK_NETWORK: "testnet", CALLBOOK_ADDRESS: ADDR, CALLBOOK_FROM_BLOCK: "100", CALLBOOK_VALIDATOR: OWNER });
    assert.match(good.registry, /^0x8004/);
  });

  test("off local, CALLBOOK_FROM_BLOCK is required", () => {
    assert.throws(() => callbookNetwork({ CALLBOOK_NETWORK: "mainnet", CALLBOOK_ADDRESS: ADDR }), /FROM_BLOCK/);
    assert.equal(callbookNetwork({ CALLBOOK_NETWORK: "local", CALLBOOK_ADDRESS: ADDR }).fromBlock, 0n);
  });

  test("snapshots round-trip, and one taken with another contract, registry or validator is refused", () => {
    const b = bookOf();
    b.seals.set(0, { p: 0, hash: "0x01", sealedAt: T0 - 300, sealTx: "0xs", reveal: { coinIndex: 1, side: -1, at: T0 + P + 5, tx: "0xr" } });
    const state = {
      address: "0xaa", chainId: 5042, toBlock: 1234n, books: new Map([[1, b]]),
      validation: { requests: new Map([["0xq", { requestHash: "0xq", agentId: 7 }]]), responses: new Map([["0xq", [{ score: 3, block: 99n }]]]) }, blockTimes: new Map([[1n, 5]]),
    };
    const text = snapshotText(state, { validationRegistry: "0xRR", validator: OWNER });
    const back = stateFromSnapshot(text, { address: "0xAA", chainId: 5042, validationRegistry: "0xrr", validator: OWNER });
    assert.equal(back.toBlock, 1234n);
    assert.deepEqual(back.books.get(1).seals.get(0), b.seals.get(0));
    assert.equal(back.validation.responses.get("0xq")[0].block, 99n);
    assert.equal(back.blockTimes.size, 0);
    assert.equal(stateFromSnapshot(text, { address: "0xbb", chainId: 5042, validationRegistry: "0xrr", validator: OWNER }), null);
    assert.equal(stateFromSnapshot(text, { address: "0xaa", chainId: 5042, validationRegistry: "0xrr", validator: OTHER }), null);
    assert.equal(stateFromSnapshot(text, { address: "0xaa", chainId: 1, validationRegistry: "0xrr", validator: OWNER }), null);
    assert.equal(stateFromSnapshot("{not json", { address: "0xaa", chainId: 5042 }), null);
    const dir = mkdtempSync(path.join(tmpdir(), "cb-snap-"));
    writeSnapshot(path.join(dir, "s.json"), state, { validationRegistry: "0xRR", validator: OWNER });
    const fromFile = stateFromSnapshot(readFileSync(path.join(dir, "s.json"), "utf8"), { address: "0xaa", chainId: 5042, validationRegistry: "0xrr", validator: OWNER });
    assert.equal(fromFile.toBlock, 1234n, "the runner's snapshot file is what the API starts from");
  });
});

// ------------------------------------------------------------------ H3, M2

describe("H3/M2: scoring guards", () => {
  test("a scheduled book's unknown coin is never fetched, and a call on it is unscorable", async () => {
    const asked = [];
    const source = {
      perpNames: async () => ["BTC", "ETH"],
      load: async (coins, from, to) => { asked.push(...coins); return synthetic(coins, from, to, (c, t) => (c === "ETH" ? 100 + (t - T0) / HOUR : 100)); },
    };
    const b = bookOf({ coins: ["btc", "NOTACOIN", "ETH"] });
    b.seals.set(0, { p: 0, hash: "0x01", sealedAt: T0 - 300, reveal: { coinIndex: 1, side: 1, at: T0 + P + 5 } });
    b.seals.set(1, { p: 1, hash: "0x02", sealedAt: T0 + P - 300, reveal: { coinIndex: 0, side: 1, at: T0 + 2 * P + 5 } });
    const ev = await evaluateBook({ chain: { chainId: 1, address: "0x01" }, book: b, source, asOf: T0 + 2 * P + 60 });
    assert.deepEqual([...new Set(asked)].sort(), ["BTC", "ETH"]);
    const [p0, p1] = ev.scored.periods;
    assert.equal(p0.status, "unscorable");
    assert.deepEqual(p0.worst, { coin: "ETH", side: -1 }, "scored at the worst of the coins Hyperliquid lists");
    assert.equal(p1.status, "revealed");
    assert.equal(ev.scored.metrics.unscorable, 1);
    assert.ok(ev.scored.score.coverage < 1);
  });

  test("a book with no listed coin, or over the rebuild's coin cap, is listed as unscorable, not dropped", async () => {
    const source = { perpNames: async () => ["BTC", "ETH", "SOL"], load: async (coins, f, t) => synthetic(coins, f, t) };
    const books = new Map([
      [1, bookOf({ id: 1, coins: ["ZZZ"] })],
      [2, bookOf({ id: 2, coins: ["BTC", "ETH"] })],
      [3, bookOf({ id: 3, coins: ["SOL"] })],
    ]);
    const chain = { chainId: 1, address: "0x01", books, validation: { requests: new Map(), responses: new Map() } };
    const built = await buildCallbook({ chain, source, asOf: T0 + P, meta: {}, maxCoins: 2 });
    const byId = Object.fromEntries(built.index.books.map((b) => [b.id, b]));
    assert.equal(byId["1"].unscorable, true);
    assert.match(byId["1"].reason, /Hyperliquid perp/);
    assert.equal(byId["2"].unscorable, undefined);
    assert.equal(byId["3"].unscorable, true);
    assert.match(byId["3"].reason, /coin limit/);
    assert.equal(built.index.stats.books, 3);
  });

  test("a strategy's skill compares like with like: funding alone doesn't make every long right", async () => {
    // BTC flat at 100 while longs pay funding; a long every round is neither right nor wrong.
    const withFunding = (coins, from, to) => {
      const d = synthetic(coins, from, to);
      for (const c of coins) d.funding[c] = d.funding[c].map(([t]) => [t, 0.0001]);
      return d;
    };
    const source = { perpNames: async () => ["BTC"], load: async (coins, f, t) => withFunding(coins, f, t) };
    const b = bookOf({ coins: ["BTC"] });
    for (let p = 0; p < 5; p++) b.seals.set(p, { p, hash: `0x0${p}`, sealedAt: T0 + p * P - 300, reveal: { coinIndex: 0, side: 1, at: T0 + (p + 1) * P + 5 } });
    const chain = { chainId: 1, address: "0x01", books: new Map([[1, b]]), validation: { requests: new Map(), responses: new Map() } };
    const ev = await evaluateBook({ chain, book: b, source, asOf: T0 + 5 * P + 10 });
    assert.equal(ev.scored.skill.calls, 5);
    assert.equal(ev.scored.skill.hitRate, 0.5, "each long only matched the market: a tie, not a hit");
  });

  test("a score as of a moment rebuilds the same later, when more prices exist", async () => {
    const rising = (c, t) => 100 + (t - T0) / HOUR;
    const source = { perpNames: async () => ["BTC", "ETH"], load: async (coins, f, t) => synthetic(coins, f, t, rising) };
    const b = bookOf();
    b.seals.set(0, { p: 0, hash: "0x01", sealedAt: T0 - 300, reveal: { coinIndex: 0, side: 1, at: T0 + P + 5 } });
    const chain = { chainId: 1, address: "0x01", books: new Map([[1, b]]), validation: { requests: new Map(), responses: new Map() } };
    const asOf = T0 + P + 1234; // not on an hour
    const now = await evaluateBook({ chain, book: b, source, asOf });
    // The same source later returns candles past asOf too; the rebuild must not use them.
    const later = { ...source, load: async (coins, f, t) => synthetic(coins, f, t + 5 * DAY, rising) };
    const again = await evaluateBook({ chain, book: b, source: later, asOf });
    assert.equal(again.report.hash, now.report.hash);
  });

  test("periods per book are capped at the latest MAX_PERIODS", () => {
    const b = bookOf({ periodSec: 300, horizonSec: 300 });
    const calls = deriveCalls(b, b.seals, T0 + (MAX_PERIODS + 10) * 300);
    assert.equal(calls.length, MAX_PERIODS);
    assert.ok(calls[0].period > 0);
  });

  test("M2: a book whose ERC-8004 agent moved to someone else is flagged", async () => {
    const source = { perpNames: async () => ["BTC", "ETH"], load: async (coins, f, t) => synthetic(coins, f, t) };
    const chain = { chainId: 1, address: "0x01", books: new Map([[1, bookOf()], [2, bookOf({ id: 2, agentId: 8 })]]), validation: { requests: new Map(), responses: new Map() } };
    const built = await buildCallbook({ chain, source, asOf: T0 + P, meta: {}, ours, agentOwner: async (id) => (id === 7 ? OWNER : OTHER) });
    const byId = Object.fromEntries(built.index.books.map((b) => [b.id, b]));
    assert.equal(byId["1"].agentMoved, false);
    assert.equal(byId["2"].agentMoved, true);
    assert.equal(built.details.get("2").agentMoved, true);
    assert.equal(built.index.books[0].id, "2", "ours first, in record order");
  });
});

// ------------------------------------------------------------------ M3

describe("M3: publishing", () => {
  const evOf = (id) => ({ book: bookOf({ id, agentId: id }), scored: { score: { value: 5 } }, report: { hash: `0x${String(id).padStart(64, "0")}` }, uri: "u" });
  const chainWith = (ids) => ({
    chainId: 1, address: "0x01", books: new Map(ids.map((id) => [id, bookOf({ id, agentId: id })])),
    validation: { requests: new Map(ids.map((id) => [`0xr${id}`, { requestHash: `0xr${id}`, validator: OWNER, agentId: id, book: { bookId: id, callbook: "0x01", chainId: 1 } }])), responses: new Map() },
  });
  const sent = [];
  const wallet = { account: { address: OWNER }, chain: null, writeContract: async (x) => { sent.push(x.args[0]); return `0xtx${sent.length}`; } };
  const publicClient = { getGasPrice: async () => 20_000_000_000n, waitForTransactionReceipt: async () => ({ status: "success" }) };

  test("only allowlisted books get an answer; the allowlist is required", async () => {
    sent.length = 0;
    const chain = chainWith([1, 2]);
    await assert.rejects(publishScores({ chain, evaluated: [evOf(1)], wallet, publicClient, registry: "0x02", validator: OWNER, now: T0 }), /allowlist/);
    const out = await publishScores({ chain, evaluated: [evOf(1), evOf(2)], wallet, publicClient, registry: "0x02", validator: OWNER, now: T0, allow: new Set([1]) });
    assert.deepEqual(out.map((r) => r.bookId), [1]);
    assert.deepEqual(sent, ["0xr1"]);
  });

  test("a skill score gets its own answer, tagged, and the two never stand in for each other", async () => {
    const args = [];
    const tagged = { ...wallet, writeContract: async (x) => { args.push(x.args); return `0xtx${args.length}`; } };
    const chain = chainWith([1, 2]);
    const withSkill = { ...evOf(1), scored: { score: { value: 5 }, skill: { score: 41, level: "provisional" } } };
    const unrated = { ...evOf(2), scored: { score: { value: 7 }, skill: { score: null, level: "unrated" } } };
    const out = await publishScores({ chain, evaluated: [withSkill, unrated], wallet: tagged, publicClient, registry: "0x02", validator: OWNER, now: T0, allow: new Set([1, 2]) });
    // Skill first, so the registry's latest answer is the track record score.
    assert.deepEqual(out.map((r) => [r.bookId, r.tag, r.score]), [[1, "arena-skill-v1", 41], [1, "arena-v1", 5], [2, "arena-v1", 7]]);
    assert.deepEqual(args.map((a) => [a[0], a[1], a[4]]), [["0xr1", 41, "arena-skill-v1"], ["0xr1", 5, "arena-v1"], ["0xr2", 7, "arena-v1"]]);

    // Read back: each tag has its own latest answer.
    chain.validation.responses.set("0xr1", [
      { score: 5, tag: "arena-v1", at: T0, responseHash: "0xa" },
      { score: 41, tag: "arena-skill-v1", at: T0, responseHash: "0xa" },
    ]);
    assert.equal(latestResponse(chain, "0xr1").score, 5, "the track record score by default, not the later skill answer");
    assert.equal(latestResponse(chain, "0xr1", "arena-skill-v1").score, 41);
    assert.equal(latestResponse(chain, "0xr1", "someone-else"), null);
  });

  test("a daily gas cap stops posting until the next day", async () => {
    sent.length = 0;
    const chain = chainWith([1, 2, 3]);
    // 300k gas at 20 gwei is 0.006 USDC; a 0.01 budget covers one.
    const out = await publishScores({ chain, evaluated: [evOf(1), evOf(2), evOf(3)], wallet, publicClient, registry: "0x02", validator: OWNER, now: T0, allow: new Set([1, 2, 3]), budgetUsdc: 0.01 });
    assert.equal(sent.length, 1);
    assert.deepEqual(out.slice(1).map((r) => r.why), ["daily gas budget used up", "daily gas budget used up"]);
  });
});

// ------------------------------------------------------------------ M5, L9, H2 helpers

describe("helpers", () => {
  test("maxOf/minOf handle arrays far too long to spread", () => {
    const big = Array.from({ length: 300_000 }, (_, i) => i);
    assert.throws(() => Math.max(...Array.from({ length: 5_000_000 }, () => 1)), RangeError);
    assert.equal(maxOf(big), 299_999);
    assert.equal(minOf(big), 0);
    assert.equal(maxOf([], -1), -1);
  });

  test("L9: logged errors are one line, without URLs", () => {
    const err = { shortMessage: "HTTP request failed. URL: https://rpc.example.com/v2/SECRETKEY\nmore", message: "long" };
    assert.equal(brief(err), "HTTP request failed. URL: <url>");
    assert.equal(brief(new Error("plain")), "plain");
  });

  test("H2: IP buckets: IPv4 as is, IPv6 by /64, mapped IPv4 as IPv4", () => {
    assert.equal(ipBucket("203.0.113.9"), "203.0.113.9");
    assert.equal(ipBucket("::ffff:203.0.113.9"), "203.0.113.9");
    assert.equal(ipBucket("2001:db8:abcd:12:1::5"), "2001:db8:abcd:12::/64");
    assert.equal(ipBucket("2001:db8:abcd:12:ffff:ffff:ffff:ffff"), "2001:db8:abcd:12::/64");
    assert.equal(ipBucket("2001:db8::1"), "2001:db8:0:0::/64");
    assert.notEqual(ipBucket("2001:db8:abcd:13::1"), ipBucket("2001:db8:abcd:12::1"));
    assert.equal(ipBucket(undefined), "unknown");
  });

  test("H2: counters: memory windows, the shared REST store, and falling back when it's down", async () => {
    let t = 1000;
    const m = memoryCounter({ now: () => t });
    assert.equal(await m.hit("k", 60), 1);
    assert.equal(await m.hit("k", 60, 5), 6);
    t += 60;
    assert.equal(await m.peek("k", 60), 0, "a new window");

    const calls = [];
    const fake = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
      return { ok: true, json: async () => [{ result: 7 }, { result: 1 }] };
    };
    const r = restCounter({ url: "https://kv.example/", token: "tok", fetch: fake, now: () => 120 });
    assert.equal(await r.hit("lock:a", 3600), 7);
    assert.equal(calls[0].url, "https://kv.example/pipeline");
    assert.equal(calls[0].auth, "Bearer tok");
    assert.deepEqual(calls[0].body[0], ["INCRBY", "callbook:lock:a:0", "1"]);

    assert.equal(countersFromEnv({}).kind, "memory");
    const logs = [];
    const down = countersFromEnv({ KV_REST_API_URL: "http://127.0.0.1:9", KV_REST_API_TOKEN: "x" }, { log: (l) => logs.push(l) });
    assert.equal(down.kind, "rest");
    assert.equal(await down.hit("x", 60), 1, "falls back to memory");
    assert.ok(logs.length >= 1);
  });
});

// ------------------------------------------------------------------ on a local node

const RPC = process.env.CALLBOOK_TEST_RPC ?? "http://127.0.0.1:8546";
const local = defineChain({ id: 31337, name: "Local", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pc = createPublicClient({ chain: local, transport: http(RPC), pollingInterval: 50 });
const MN = "test test test test test test test test test test test junk";
const w = (i) => createWalletClient({ account: mnemonicToAccount(MN, { addressIndex: i }), chain: local, transport: http(RPC), pollingInterval: 50 });
let nodeUp = false;
before(async () => {
  try {
    nodeUp = (await pc.getChainId()) === 31337;
  } catch {
    nodeUp = false;
  }
});

test("on a local node: H1, an impostor book with our caller and strategy is never sealed; M5, reports are cached and limited", async (t) => {
  if (!nodeUp) return t.skip(`no Hardhat node at ${RPC}`);
  const deployer = w(0), owner = w(1), agentKey = w(2), impostor = w(6);
  const CB = artifact("Callbook").abi;
  const deploy = async (name, args = []) => {
    const { abi, bytecode } = artifact(name);
    return (await pc.waitForTransactionReceipt({ hash: await deployer.deployContract({ abi, bytecode, args, account: deployer.account, chain: local }) })).contractAddress;
  };
  const identity = await deploy("MockIdentityRegistry");
  const callbook = await deploy("Callbook", [identity]);
  const fromBlock = await pc.getBlockNumber();
  const latest = async () => Number((await pc.getBlock()).timestamp);
  const openAt = Math.ceil((await latest()) / P) * P + 1000;
  await pc.request({ method: "evm_mine", params: [`0x${openAt.toString(16)}`] });
  const flip = AGENTS.find((a) => a.key === "flip");
  const open = async (wallet) => {
    const rc = await pc.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: callbook, abi: CB, functionName: "open", args: [2n ** 256n - 1n, agentKey.account.address, flip.strategyHash, ["BTC"], P, P], account: wallet.account, chain: local }) });
    return Number(parseEventLogs({ abi: CB, logs: rc.logs, eventName: "Opened" })[0].args.bookId);
  };
  const mine = await open(owner);
  const theirs = await open(impostor);
  const start = openAt - (openAt % P) + P;
  const source = { perpNames: async () => ["BTC"], load: async (coins, f, to) => synthetic(coins, f, to) };
  const ctx = {
    publicClient: pc, wallet: agentKey, callbook, chainId: 31337, secret: "s".repeat(40), source, fromBlock, log: () => {},
    ours: { owner: owner.account.address.toLowerCase(), bookIds: new Set([mine]), order: [mine] },
  };
  await pc.request({ method: "evm_mine", params: [`0x${(start - 300).toString(16)}`] });
  const actions = await tick(ctx, { now: start - 300 });
  assert.deepEqual(actions.map((a) => a.bookId), [mine], "only our book was sealed");
  const state = await readCallbook({ client: pc, address: callbook, fromBlock });
  assert.equal(state.books.get(theirs).seals.size, 0);

  // A daily runner budget: zero allows nothing.
  const broke = { ...ctx, state: null, dailyUsdc: 0 };
  await pc.request({ method: "evm_mine", params: [`0x${(start + P - 300).toString(16)}`] });
  const logs = [];
  broke.log = (m) => logs.push(m);
  assert.deepEqual(await tick(broke, { now: start + P - 300 }), []);
  assert.match(logs.join(" "), /budget/);

  // M5: the report route caches by (id, asOf) and limits new builds per client.
  const app = express();
  app.set("trust proxy", 1);
  let clock = start + P;
  mountCallbook(app, { env: { CALLBOOK_NETWORK: "local", CALLBOOK_ADDRESS: callbook, CALLBOOK_RPC: RPC, CALLBOOK_FROM_BLOCK: String(fromBlock), CALLBOOK_STATE_FILE: path.join(tmpdir(), "none.json") }, source, now: () => clock });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const get = (asOf, ip = "198.51.100.7") => fetch(`${url}/api/callbook/report/${mine}?asOf=${asOf}`, { headers: { "x-forwarded-for": ip } });
    const a = await get(start);
    assert.equal(a.status, 200);
    const again = await get(start);
    assert.equal(again.headers.get("x-report-hash"), a.headers.get("x-report-hash"));
    let limited = 0;
    for (let i = 1; i <= 31; i++) if ((await get(start + i)).status === 429) limited++;
    assert.ok(limited >= 1, "past 30 new reports a minute, a client is refused");
    assert.equal((await get(start + 40, "2001:db8:1:2::9")).status, 200, "another client is not");
    assert.equal((await get(start)).status, 200, "a cached report is still served");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

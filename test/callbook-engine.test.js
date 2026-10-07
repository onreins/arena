/**
 * The Arena engine: period statuses, outcomes, the score, the report and
 * its hash, salts, and one run against a local node (deploy, open, seal,
 * travel, reveal, read back, score, post, re-check).
 *
 * The integration test needs a Hardhat node on CALLBOOK_TEST_RPC (default
 * http://127.0.0.1:8546) and skips itself when there isn't one. Prices are
 * synthetic throughout, so nothing here touches the network.
 */
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { createPublicClient, createWalletClient, http, defineChain, parseEventLogs } from "viem";
import { mnemonicToAccount } from "viem/accounts";

import {
  deriveCalls, nextPeriod, worstOutcome, excessOverMarket, callbookScore, scoreBook, buildReport, tStat,
  canonicalJson, hashText, callHash, validationRequestFor, parseValidationRequest, readCallbook, evaluateBook,
  requestForBook, latestResponse, asOfFromUri, SEAL_LEAD, GRACE, SCORE_RULES,
} from "../app/verify/callbook.js";
import { priceBook } from "../app/verify/callbook-prices.js";
import { shouldPublish, publishScores } from "../app/verify/callbook-publish.js";
import { deriveSalt, recoverCall, tick } from "../runner/callbook.js";
import { coinFlip, rowFromCandles, AGENTS } from "../runner/callbook-agents.js";
import { artifact } from "../scripts/artifact.js";
import { VALIDATION_REGISTRY_ABI } from "../evaluator/abi.js";

const HOUR = 3600, DAY = 86400, P = 4 * HOUR;
const T0 = 1_790_000_000 - (1_790_000_000 % P); // a period boundary

// ------------------------------------------------------------------ fixtures

const bookOf = (over = {}) => ({
  id: 1, owner: "0xowner", agentId: 7, caller: "0xcaller", strategyHash: "0x01", coins: ["BTC", "ETH"],
  periodSec: P, horizonSec: P, start: T0, openedAt: T0 - P + 600, closedAt: null, seals: new Map(), ...over,
});
const seal = (p, at, reveal) => ({ p, hash: `0x${String(p).padStart(64, "0")}`, sealedAt: at, sealTx: `0xs${p}`, reveal });
const rev = (coinIndex, side, at) => ({ coinIndex, side, at, tx: "0xr" });

/** Hourly candles from t0 to t1 with price(coin, t), and a constant hourly funding rate. */
function synthetic(coins, t0, t1, price, fundingRate = 0) {
  const candles = {}, funding = {};
  for (const c of coins) {
    candles[c] = [];
    funding[c] = [];
    for (let t = t0; t <= t1; t += HOUR) {
      const o = price(c, t), cl = price(c, t + HOUR);
      candles[c].push({ t, o, h: Math.max(o, cl), l: Math.min(o, cl), c: cl, v: 1000 });
      funding[c].push([t, fundingRate]);
    }
  }
  return { interval: "1h", candles, funding, fundingOk: true };
}

// ------------------------------------------------------------------ periods

describe("deriveCalls", () => {
  test("revealed, pending, missed and withheld, each by its own clock", () => {
    const b = bookOf();
    b.seals.set(0, seal(0, T0 - 300, rev(1, 1, T0 + P + 60)));
    // period 1: never sealed -> missed
    b.seals.set(2, seal(2, T0 + 2 * P - 300, null)); // sealed, not revealed
    b.seals.set(3, seal(3, T0 + 3 * P - 300, null));

    // Just after period 3's exit: 2 and 3 are still pending.
    let now = T0 + 4 * P + 10;
    let calls = deriveCalls(b, b.seals, now);
    assert.deepEqual(calls.map((c) => c.status), ["revealed", "missed", "pending", "pending", "missed"]);
    assert.equal(calls[0].coin, "ETH");
    assert.equal(calls[0].side, 1);
    assert.equal(calls[4].deadline, T0 + 4 * P - SEAL_LEAD, "period 4's deadline passed before its start");

    // Period 2's grace ends at its exit + 7 days; one second later it's withheld.
    const graceEnd = T0 + 3 * P + GRACE;
    calls = deriveCalls(b, b.seals, graceEnd);
    assert.equal(calls[2].status, "pending", "on the last second of grace it can still be revealed");
    calls = deriveCalls(b, b.seals, graceEnd + 1);
    assert.equal(calls[2].status, "withheld");
  });

  test("a deadline is SEAL_LEAD before the start: a period isn't missed until it has passed", () => {
    const b = bookOf();
    assert.equal(deriveCalls(b, b.seals, T0 - SEAL_LEAD).length, 0, "at the deadline the seal could still land");
    assert.deepEqual(deriveCalls(b, b.seals, T0 - SEAL_LEAD + 1).map((c) => c.status), ["missed"]);
  });

  test("a closed book stops collecting misses; calls sealed before the close still count", () => {
    const b = bookOf({ closedAt: T0 + P + 100 });
    b.seals.set(0, seal(0, T0 - 300, null));
    const calls = deriveCalls(b, b.seals, T0 + 20 * DAY);
    assert.deepEqual(calls.map((c) => c.status), ["withheld", "missed"], "period 1's deadline came before the close; period 2's after");
    assert.equal(nextPeriod(b, b.seals, T0 + 20 * DAY), null);
  });

  test("seals and reveals after asOf are ignored, so the past can be rebuilt", () => {
    const b = bookOf();
    b.seals.set(0, seal(0, T0 - 300, rev(0, -1, T0 + P + 60)));
    assert.equal(deriveCalls(b, b.seals, T0 + P + 59)[0].status, "pending");
    assert.equal(deriveCalls(b, b.seals, T0 - 301).length, 0);
    assert.deepEqual(nextPeriod(b, b.seals, T0 - 400), { period: 0, startsAt: T0, sealed: false });
    assert.deepEqual(nextPeriod(b, b.seals, T0 - 300), { period: 0, startsAt: T0, sealed: true });
  });
});

// ------------------------------------------------------------------ outcomes

describe("outcomes", () => {
  test("withheld scores as the worst coin and side", () => {
    const w = worstOutcome(["BTC", "ETH", "SOL"], [0.01, -0.04, 0.02]);
    assert.deepEqual([w.coin, w.side], ["ETH", 1], "ETH fell most, so the worst call was long ETH");
    assert.equal(w.gross, -0.04);
    const up = worstOutcome(["BTC", "ETH"], [0.05, null]);
    assert.deepEqual([up.coin, up.side, up.gross], ["BTC", -1, -0.05]);
  });

  test("vsMarket is direction-neutral: riding the market earns nothing either way", () => {
    assert.equal(excessOverMarket(0.03, 1, 0.03), 0);
    assert.equal(excessOverMarket(-0.03, -1, 0.03), 0, "a short in a rising market, as bad as the market is good");
    assert.ok(Math.abs(excessOverMarket(0.05, 1, 0.03) - 0.02) < 1e-12);
    assert.ok(Math.abs(excessOverMarket(0.01, -1, -0.03) - -0.02) < 1e-12, "short a coin that fell less than the market: worse than the market");
  });

  test("scoreBook: a book that only rides the market has vsMarket of minus its fees; flats score zero", () => {
    // Both coins rise 1% an hour in lockstep, no funding.
    const price = (_c, t) => 100 * 1.01 ** ((t - T0) / HOUR);
    const data = synthetic(["BTC", "ETH"], T0 - DAY, T0 + 3 * DAY, price);
    const b = bookOf();
    for (let p = 0; p < 6; p++) b.seals.set(p, seal(p, T0 + p * P - 300, rev(p % 2, p === 5 ? 0 : 1, T0 + (p + 1) * P + 30)));
    const asOf = T0 + 6 * P + 60;
    const s = scoreBook(b, deriveCalls(b, b.seals, asOf), priceBook(data), { asOf });
    const longs = s.periods.filter((c) => c.side === 1);
    assert.equal(longs.length, 5);
    const fees = longs.reduce((a, c) => a + c.fee, 0);
    assert.ok(Math.abs(s.metrics.vsMarket + fees) < 1e-9, `vsMarket ${s.metrics.vsMarket} should be −fees ${fees}`);
    const flat = s.periods.find((c) => c.period === 5);
    assert.equal(flat.ret, 0);
    assert.ok(Math.abs(s.metrics.flatShare - 1 / 6) < 1e-12);
    assert.ok(s.metrics.totalReturn > 0.19, "five 4h longs in a 1%/h market, about 4% each");
    assert.equal(s.costs, "hyperliquid-funding");
  });

  test("funding comes out of longs and goes to shorts", () => {
    const flatPrice = () => 100;
    const data = synthetic(["BTC"], T0 - DAY, T0 + DAY, flatPrice, 0.001);
    const b = bookOf({ coins: ["BTC"] });
    b.seals.set(0, seal(0, T0 - 300, rev(0, 1, T0 + P + 1)));
    b.seals.set(1, seal(1, T0 + P - 300, rev(0, -1, T0 + 2 * P + 1)));
    const s = scoreBook(b, deriveCalls(b, b.seals, T0 + 2 * P + 10), priceBook(data), { asOf: T0 + 2 * P + 10 });
    const [long, short] = s.periods;
    const funding4h = 1 - Math.exp(-0.004);
    assert.ok(Math.abs(long.ret + long.fee + funding4h) < 1e-9, "a long pays four hourly payments");
    assert.ok(Math.abs(short.ret + short.fee - funding4h) < 1e-9, "a short collects them");
    assert.ok(short.ret > 0, "a short in a flat market comes out ahead of its fees");
  });

  test("a withheld call is scored as the worst outcome, net of fees", () => {
    const price = (c, t) => (c === "BTC" ? 100 + (t - T0) / HOUR : 100 - 2 * ((t - T0) / HOUR));
    const data = synthetic(["BTC", "ETH"], T0 - DAY, T0 + 10 * DAY, price);
    const b = bookOf();
    b.seals.set(0, seal(0, T0 - 300, null));
    const asOf = T0 + P + GRACE + 1;
    const s = scoreBook(b, deriveCalls(b, b.seals, asOf), priceBook(data), { asOf });
    const w = s.periods[0];
    assert.equal(w.status, "withheld");
    assert.deepEqual(w.worst, { coin: "ETH", side: 1 });
    assert.ok(Math.abs(w.ret - (92 / 100 - 1 - w.fee)) < 1e-9);
    assert.equal(s.metrics.withheld, 1);
    assert.ok(s.score.coverage < 1);
  });

  test("the thesis row is rebuilt from complete hourly candles only", () => {
    const candles = Array.from({ length: 30 }, (_, i) => ({ t: T0 + i * HOUR, o: 100 + i, h: 101 + i, l: 99 + i, c: 101 + i, v: 10 }));
    const now = T0 + 25 * HOUR + 1800; // candle 25 is still open
    const row = rowFromCandles("BTC", candles, [[T0, 0.0001], [T0 + 40 * HOUR, 9]], now);
    assert.equal(row.last, 125, "close of candle 24, the newest complete one");
    assert.equal(row.open, 101, "open 24 candles back");
    assert.equal(row.funding, 0.0001, "funding from the future is not seen");
    assert.equal(rowFromCandles("BTC", candles.slice(0, 10), [], now), null);
  });
});

// ------------------------------------------------------------------ the score

describe("the score", () => {
  const base = { days: 61, revealed: 10, missed: 0, withheld: 0, maxDrawdown: 0 };
  const strong = Array.from({ length: 10 }, (_, i) => ({ side: i % 2 ? 1 : -1, ret: 0.01 + (i % 3) * 0.001, market: 0 }));

  test("strong profit, a strong edge, full coverage and no drawdown is 100", () => {
    const s = callbookScore({ ...base, outcomes: strong });
    assert.ok(s.tStat > SCORE_RULES.fullT);
    assert.ok(s.profitT > SCORE_RULES.fullT);
    assert.equal(s.value, 100);
  });

  test("nothing due scores 0; a young record keeps its score and says so in its level", () => {
    assert.equal(callbookScore({ days: 0, revealed: 0, missed: 0, withheld: 0, maxDrawdown: 0, outcomes: [] }).value, 0);
    const young = callbookScore({ ...base, days: 30.5, outcomes: strong });
    assert.equal(young.value, 100, "the record's length is no longer a cut in the score");
    assert.equal(young.level, "new", "10 calls is a new record");
    assert.equal(callbookScore({ ...base, days: 30.5, revealed: 40, outcomes: strong }).level, "building");
    assert.equal(callbookScore({ ...base, revealed: 40, outcomes: strong }).level, "full");
  });

  test("a big drawdown scales what was earned down, and never adds points on its own", () => {
    const calm = callbookScore({ ...base, outcomes: strong });
    const rough = callbookScore({ ...base, maxDrawdown: 0.5, outcomes: strong });
    assert.equal(rough.value, Math.round(calm.value * SCORE_RULES.riskFloor), "past the 40% limit, 60% of the score is kept");
    const losing = strong.map((o) => ({ ...o, ret: -o.ret }));
    assert.equal(callbookScore({ ...base, outcomes: losing }).value, 0, "a smooth losing record earns nothing");
  });

  test("misses and withheld calls cut coverage; flats cut the risk credit", () => {
    assert.equal(callbookScore({ ...base, missed: 10, outcomes: strong }).value, 50);
    const mostlyFlat = callbookScore({ ...base, revealed: 10, outcomes: strong.slice(0, 2) });
    assert.ok(Math.abs(mostlyFlat.risk - 0.4) < 1e-12, "20% exposure is 40% of the 50% minimum");
  });

  test("no edge and a 10% drawdown scores 0; beta-riding is not edge", () => {
    const losing = strong.map((o) => ({ ...o, ret: -o.ret }));
    assert.equal(callbookScore({ ...base, maxDrawdown: 0.1, outcomes: losing }).value, 0);
    // Always long, and every return is exactly the market's: beta 1 removes it all.
    const beta = Array.from({ length: 10 }, (_, i) => ({ side: 1, ret: 0.01 * (i + 1), market: 0.01 * (i + 1) }));
    const s = callbookScore({ ...base, maxDrawdown: 0.1, outcomes: beta });
    assert.equal(s.beta, 1);
    assert.equal(s.edge, 0);
  });

  test("tStat", () => {
    assert.equal(tStat([1]), 0);
    assert.equal(tStat([2, 2, 2]), 0, "no spread is no evidence");
    assert.ok(Math.abs(tStat([1, 2, 3]) - 2 / (1 / Math.sqrt(3))) < 1e-12);
  });
});

// ------------------------------------------------------------------ report, salts, requests

describe("report and keys", () => {
  test("canonical JSON sorts keys at every level, so the hash doesn't depend on order", () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: 2n } }), '{"a":{"c":"2","d":[3,{"x":2,"y":1}]},"b":1}');
    assert.equal(hashText(canonicalJson({ a: 1, b: 2 })), hashText(canonicalJson({ b: 2, a: 1 })));
  });

  test("the report is deterministic and every number in it is pinned", () => {
    const price = (c, t) => (c === "BTC" ? 100 + Math.sin(t / 7200) * 3 : 50 + Math.cos(t / 5000));
    const data = synthetic(["BTC", "ETH"], T0 - DAY, T0 + 3 * DAY, price, 0.00001);
    const make = () => {
      const b = bookOf();
      for (let p = 0; p < 8; p++) if (p !== 3) b.seals.set(p, seal(p, T0 + p * P - 300, rev(p % 2, p % 3 ? 1 : -1, T0 + (p + 1) * P + 30)));
      const asOf = T0 + 8 * P + 100;
      const scored = scoreBook(b, deriveCalls(b, b.seals, asOf), priceBook(data), { asOf });
      return buildReport({ chainId: 31337, callbook: "0xAbC0000000000000000000000000000000000001", book: b, asOf, scored });
    };
    const a = make(), b = make();
    assert.equal(a.text, b.text);
    assert.equal(a.hash, b.hash);
    assert.equal(a.report.callbook, "0xabc0000000000000000000000000000000000001");
    assert.deepEqual(a.report.periods[3], [3, "missed", null, null, 0]);
    const tampered = JSON.parse(a.text);
    tampered.score.value += 1;
    assert.notEqual(hashText(canonicalJson(tampered)), a.hash);
    assert.equal(asOfFromUri(`callbook-report:eip155:1/0xabc/1?asOf=${a.report.asOf}`), a.report.asOf);
  });

  test("salts are HMAC(secret, chainId:callbook:bookId:p), and the call is recoverable from them", () => {
    const secret = "x".repeat(32);
    const ctx = { chainId: 5042, callbook: "0xAbC0000000000000000000000000000000000001", bookId: 3, p: 10 };
    const s = deriveSalt(secret, ctx);
    assert.match(s, /^0x[0-9a-f]{64}$/);
    assert.equal(s, deriveSalt(secret, { ...ctx, callbook: ctx.callbook.toLowerCase() }), "address case doesn't matter");
    assert.notEqual(s, deriveSalt(secret, { ...ctx, p: 11 }));
    assert.notEqual(s, deriveSalt(secret, { ...ctx, bookId: 4 }));
    assert.notEqual(s, deriveSalt(secret, { ...ctx, chainId: 5042002 }));
    assert.notEqual(s, deriveSalt("y".repeat(32), ctx));
    assert.throws(() => deriveSalt("short", ctx), /32 characters/);

    const hash = callHash({ ...ctx, coinIndex: 2, side: -1, salt: s });
    assert.deepEqual(recoverCall({ hash, ...ctx, coinCount: 3, salt: s }), { coinIndex: 2, side: -1 });
    assert.equal(recoverCall({ hash, ...ctx, coinCount: 3, salt: deriveSalt(secret, { ...ctx, p: 9 }) }), null);
  });

  test("the coin flip is keyed and deterministic", () => {
    const ctx = { chainId: 1, callbook: "0x01", bookId: 1 };
    const sides = Array.from({ length: 200 }, (_, p) => coinFlip("k".repeat(32), { ...ctx, p }));
    assert.deepEqual(sides, Array.from({ length: 200 }, (_, p) => coinFlip("k".repeat(32), { ...ctx, p })));
    const longs = sides.filter((x) => x === 1).length;
    assert.ok(longs > 70 && longs < 130, `roughly half long (${longs})`);
  });

  test("validation requests describe their book, and a tampered one is refused", () => {
    const r = validationRequestFor({ chainId: 5042, callbook: "0xAbC0000000000000000000000000000000000001", bookId: 2 });
    assert.deepEqual(parseValidationRequest(r.requestURI, r.requestHash), { chainId: 5042, callbook: "0xabc0000000000000000000000000000000000001", bookId: 2 });
    assert.equal(parseValidationRequest(r.requestURI, `0x${"0".repeat(64)}`), null);
    assert.equal(parseValidationRequest("https://example.com", r.requestHash), null);
  });

  test("a request names its agent, so another agent can't squat the same book's hash", () => {
    const callbook = "0xAbC0000000000000000000000000000000000001";
    const ours = validationRequestFor({ chainId: 5042, callbook, bookId: 2, agentId: 1413n });
    const theirs = validationRequestFor({ chainId: 5042, callbook, bookId: 2, agentId: 7n });
    assert.notEqual(ours.requestHash, theirs.requestHash);
    assert.equal(parseValidationRequest(ours.requestURI, ours.requestHash).agentId, "1413");

    // A request whose descriptor names agent 1413 but was filed by agent 7 doesn't count.
    const books = new Map([[2, { agentId: 7n }]]);
    const filedBy = (agentId, req) => ({
      validation: { requests: new Map([[req.requestHash, { book: parseValidationRequest(req.requestURI, req.requestHash), agentId, validator: "0x01" }]]) },
      books, address: callbook, chainId: 5042,
    });
    assert.equal(requestForBook(filedBy(7n, ours), 2), null);
    assert.ok(requestForBook(filedBy(7n, theirs), 2));
  });

  test("scores go out at most daily, and only when something changed", () => {
    assert.equal(shouldPublish({ last: null, score: 5, reportHash: "0x1", now: 100 }).due, true);
    const last = { at: 1000, score: 5, responseHash: "0x1" };
    assert.equal(shouldPublish({ last, score: 9, reportHash: "0x2", now: 1000 + 23 * HOUR - 1 }).due, false);
    assert.equal(shouldPublish({ last, score: 5, reportHash: "0x2", now: 1000 + DAY - 2 }).due, true, "a daily job a few seconds early still posts");
    assert.equal(shouldPublish({ last, score: 5, reportHash: "0x1", now: 1000 + 3 * DAY }).due, false);
  });
});

// ------------------------------------------------------------------ against a local node

const RPC = process.env.CALLBOOK_TEST_RPC ?? "http://127.0.0.1:8546";
const local = defineChain({ id: 31337, name: "Local", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pc = createPublicClient({ chain: local, transport: http(RPC) });
let nodeUp = false;
before(async () => {
  try {
    nodeUp = (await pc.getChainId()) === 31337;
  } catch {
    nodeUp = false;
  }
});

test("on a local node: open, seal, travel, reveal, read back, score, post and re-check", async (t) => {
  if (!nodeUp) return t.skip(`no Hardhat node at ${RPC}`);
  const MN = "test test test test test test test test test test test junk";
  const w = (i) => createWalletClient({ account: mnemonicToAccount(MN, { addressIndex: i }), chain: local, transport: http(RPC) });
  const [deployer, owner, agentKey, validator] = [0, 1, 2, 3].map(w);
  const send = async (wallet, address, abi, functionName, args) => {
    const r = await pc.waitForTransactionReceipt({ hash: await wallet.writeContract({ address, abi, functionName, args, account: wallet.account, chain: local }) });
    assert.equal(r.status, "success");
    return r;
  };
  const deploy = async (name, args = []) => {
    const { abi, bytecode } = artifact(name);
    return (await pc.waitForTransactionReceipt({ hash: await deployer.deployContract({ abi, bytecode, args, account: deployer.account, chain: local }) })).contractAddress;
  };
  const latest = async () => Number((await pc.getBlock()).timestamp);
  const mineAt = (s) => pc.request({ method: "evm_mine", params: [`0x${s.toString(16)}`] });

  const identity = await deploy("MockIdentityRegistry");
  const registry = await deploy("MockValidationRegistry", [identity]);
  const callbook = await deploy("Callbook", [identity]);
  const fromBlock = await pc.getBlockNumber();
  const ID = artifact("MockIdentityRegistry").abi, CB = artifact("Callbook").abi;

  // Open at a clean spot: 1000s past a boundary, so period 0 starts at the next one.
  const openAt = Math.ceil((await latest()) / P) * P + 1000;
  await mineAt(openAt);
  const flip = AGENTS.find((a) => a.key === "flip");
  const reg = await send(owner, identity, ID, "register", []);
  const agentId = parseEventLogs({ abi: ID, logs: reg.logs, eventName: "Transfer" })[0].args.tokenId;
  const opened = await send(owner, callbook, CB, "open", [agentId, agentKey.account.address, flip.strategyHash, ["BTC", "ETH"], P, P]);
  const bookId = Number(parseEventLogs({ abi: CB, logs: opened.logs, eventName: "Opened" })[0].args.bookId);
  const req = validationRequestFor({ chainId: 31337, callbook, bookId });
  await send(owner, registry, VALIDATION_REGISTRY_ABI, "validationRequest", [validator.account.address, agentId, req.requestURI, req.requestHash]);
  const start = openAt - (openAt % P) + P;

  // Synthetic prices: BTC up, ETH down, no network.
  const source = { load: async (coins, from, to, interval) => synthetic(coins, Math.floor(from / HOUR) * HOUR, to, (c, s) => (c === "BTC" ? 100 + (s - start) / 3600 : 100 - (s - start) / 7200), 0.00001) };
  const secret = "integration-test-secret-0123456789";
  const ours = { owner: owner.account.address.toLowerCase(), bookIds: new Set([bookId]), order: [bookId] };
  const ctx = { publicClient: pc, wallet: agentKey, callbook, chainId: 31337, secret, source, fromBlock, log: () => {}, ours };
  const skip = ({ p, action }) => (action === "seal" && p === 1) || (action === "reveal" && p === 2);

  // Period 0: sealed 5 minutes before; period 1: skipped (missed); period 2: sealed but held back.
  for (let p = 0; p < 4; p++) {
    await mineAt(start + p * P - 300);
    await tick(ctx, { now: start + p * P - 300, skip });
    await mineAt(start + p * P + 60);
    await tick(ctx, { now: start + p * P + 60, skip });
  }
  const late = start + 3 * P + GRACE + 600; // period 2's grace is over; period 3 is revealed by this tick
  await mineAt(late);
  await tick(ctx, { now: late, skip });
  const asOf = await latest();

  const chain = await readCallbook({ client: pc, address: callbook, fromBlock, validationRegistry: registry, validator: validator.account.address, chunk: 7n });
  const book = chain.books.get(bookId);
  assert.equal(book.agentId, Number(agentId));
  assert.deepEqual(book.coins, ["BTC", "ETH"]);
  const calls = deriveCalls(book, book.seals, asOf);
  assert.deepEqual(calls.slice(0, 4).map((c) => c.status), ["revealed", "missed", "withheld", "revealed"]);
  assert.equal(calls[0].side, coinFlip(secret, { chainId: 31337, callbook, bookId, p: 0 }));
  assert.ok(calls[0].sealedAt > start - 300 && calls[0].sealedAt <= start - 240, "sealed just after the tick's clock, well before the deadline");

  const ev = await evaluateBook({ chain, book, source, asOf });
  assert.equal(ev.scored.metrics.withheld, 1);
  assert.ok(ev.scored.score.coverage < 1);
  assert.ok(ev.scored.score.value >= 0 && ev.scored.score.value <= 100);

  const posted = await publishScores({ chain, evaluated: [ev], wallet: validator, publicClient: pc, registry, validator: validator.account.address, now: asOf, allow: ours.bookIds });
  assert.equal(posted.length, 1);
  assert.ok(posted[0].tx);

  // Re-check: read the response back and rebuild the report at its asOf.
  const again = await readCallbook({ client: pc, address: callbook, fromBlock, validationRegistry: registry, validator: validator.account.address });
  const r = requestForBook(again, bookId, validator.account.address);
  const last = latestResponse(again, r.requestHash);
  assert.equal(last.score, ev.scored.score.value);
  assert.equal(last.tag, "arena-v1");
  const rebuilt = await evaluateBook({ chain: again, book: again.books.get(bookId), source, asOf: asOfFromUri(last.uri) });
  assert.equal(rebuilt.report.hash, last.responseHash, "the posted hash rebuilds from chain and prices");
  // Within a day, nothing more is posted.
  const second = await publishScores({ chain: again, evaluated: [rebuilt], wallet: validator, publicClient: pc, registry, validator: validator.account.address, now: asOf + 3600, allow: ours.bookIds });
  assert.equal(second[0].due, false);
});

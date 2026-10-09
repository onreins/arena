/**
 * Callers (open-call books) and the gasless relayer: lock statuses, worst
 * outcomes for hidden and unknown calls, the caller score, and, against a
 * local node on CALLBOOK_TEST_RPC (default :8546, skipped without one), the
 * relayer's checks and limits and the HTTP routes end to end. Prices are
 * synthetic; nothing here touches the network.
 */
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createPublicClient, createWalletClient, http, defineChain, parseEventLogs } from "viem";
import { mnemonicToAccount } from "viem/accounts";

import {
  deriveLocks, priceLocks, scoreCaller, callerScore, worstOver, netOf, curveDrawdown, withheldAfter,
  symbolCallHash, lockedHash, readCallbook, evaluateCaller, buildCallbook, REFERENCE_SET, REFERENCE_SET_NAME, GRACE, MAX_LOCKS_PER_BOOK, CALLER_RULES,
} from "../app/verify/callbook.js";
import { priceBook, resolveSymbol } from "../app/verify/callbook-prices.js";
import { createRelayer, DOMAIN, LOCK_TYPES, SEAL_TYPES, PROFILE_TYPES, LINK_TYPES, UNLINK_TYPES } from "../app/verify/callbook-relay.js";
import { profileFor } from "../app/verify/callbook-agents.js";
import { createAgentCards, cardSource, isPrivateAddress, safeLookup, safeGet } from "../app/verify/arena-agent-card.js";
import { mountCallbook } from "../app/callbook-routes.js";
import { artifact } from "../scripts/artifact.js";

const HOUR = 3600, DAY = 86400;
const T0 = 1_790_000_000 - (1_790_000_000 % DAY);
const NAMES = ["BTC", "ETH", "SOL", "kPEPE", "HYPE"];

function synthetic(coins, t0, t1, price, fundingRate = 0, step = HOUR) {
  const candles = {}, funding = {};
  for (const c of coins) {
    candles[c] = [];
    funding[c] = [];
    for (let t = Math.floor(t0 / HOUR) * HOUR; t <= t1; t += step) {
      const o = price(c, t), cl = price(c, t + step);
      candles[c].push({ t, o, h: Math.max(o, cl), l: Math.min(o, cl), c: cl, v: 1000 });
      if (t % HOUR === 0) funding[c].push([t, fundingRate]);
    }
  }
  return { interval: step === HOUR ? "1h" : "5m", candles, funding, fundingOk: true };
}
const sourceOf = (price, fundingRate = 0) => ({
  perpNames: async () => NAMES,
  load: async (coins, from, to) => synthetic(coins, from, to, price, fundingRate),
});

const anyCoinBook = (locks) => ({
  id: 9, kind: "free", owner: "0xowner", agentId: null, caller: "0xowner", strategyHash: `0x${"0".repeat(64)}`,
  coins: [], anyCoin: true, minHorizon: 300, maxHorizon: 30 * DAY, openedAt: T0 - 100, closedAt: null,
  locks: new Map(locks.map((l) => [l.callId, l])),
});
/** A lock: its horizon is fixed when it's locked (the Locked event carries it). */
const lock = (callId, entryAt, horizon, reveal) => ({ callId, hash: `0x${String(callId).padStart(64, "0")}`, lockedAt: entryAt - 90, entryAt, horizon, lockTx: "0xl", reveal });
const rev = (symbol, side, horizon, at) => ({ coinIndex: null, symbol, side, horizon, at, tx: "0xr" });

// ------------------------------------------------------------------ statuses and prices

describe("locks", () => {
  test("symbols match Hyperliquid perps without regard to case", () => {
    assert.equal(resolveSymbol("btc", NAMES), "BTC");
    assert.equal(resolveSymbol("KPEPE", NAMES), "kPEPE");
    assert.equal(resolveSymbol(" eth ", NAMES), "ETH");
    assert.equal(resolveSymbol("NOTACOIN", NAMES), null);
    assert.equal(resolveSymbol("", NAMES), null);
  });

  test("revealed, unscorable, pending and withheld, each by its own clock (H6: entryAt + its horizon + 7 days)", () => {
    const b = anyCoinBook([
      lock(0, T0, 4 * HOUR, rev("btc", 1, 4 * HOUR, T0 + 5 * HOUR)),
      lock(1, T0 + HOUR, 2 * HOUR, rev("NOTACOIN", -1, 2 * HOUR, T0 + 4 * HOUR)),
      lock(2, T0 + 2 * HOUR, 6 * HOUR, null),
    ]);
    const asOf = T0 + 6 * HOUR;
    const ls = deriveLocks(b, asOf, NAMES);
    assert.deepEqual(ls.map((c) => c.status), ["revealed", "unscorable", "pending"]);
    assert.equal(ls[0].coin, "BTC");
    assert.equal(ls[0].exitAt, T0 + 4 * HOUR);
    assert.equal(ls[2].horizon, 6 * HOUR, "a pending lock already knows its horizon");
    const deadline = withheldAfter(b, b.locks.get(2));
    assert.equal(deadline, T0 + 2 * HOUR + 6 * HOUR + GRACE, "its own horizon plus grace, not the book's longest");
    assert.equal(deriveLocks(b, deadline, NAMES)[2].status, "pending");
    assert.equal(deriveLocks(b, deadline + 1, NAMES)[2].status, "withheld");
    assert.equal(deriveLocks(b, T0 + 2 * HOUR - 91, NAMES).length, 2, "a lock after asOf isn't seen");
    assert.equal(deriveLocks(b, T0 + 4 * HOUR + 1, NAMES)[0].status, "pending", "a reveal after asOf isn't seen");
  });

  test("a revealed call: side × the move, less fees, at hourly opens", () => {
    const price = (c, t) => (c === "BTC" ? 100 * (1 + (t - T0) / (100 * HOUR)) : 50);
    const prices = priceBook(synthetic(["BTC", "ETH", "SOL"], T0 - DAY, T0 + 40 * DAY, price));
    const b = anyCoinBook([lock(0, T0 + 600, 3 * HOUR, rev("BTC", -1, 3 * HOUR, T0 + 5 * HOUR))]);
    const [c] = priceLocks(b, deriveLocks(b, T0 + 6 * HOUR, NAMES), prices, NAMES);
    assert.equal(c.entry, price("BTC", T0 + HOUR), "entry rounds up to the next hour, never back");
    assert.equal(c.exit, price("BTC", T0 + 4 * HOUR));
    const move = c.exit / c.entry - 1;
    assert.ok(Math.abs(c.ret - netOf(-1, move).net) < 1e-12);
    assert.ok(c.ret < 0);
  });

  test("a call under an hour is priced on 5-minute candles while Hyperliquid has them, else on hourly ones", async () => {
    const price = (c, t) => 100 + (t - T0) / 60; // up 1 a minute
    const hourly = priceBook(synthetic(["BTC"], T0 - DAY, T0 + DAY, price));
    const fine = priceBook(synthetic(["BTC"], T0 - HOUR, T0 + 2 * HOUR, price, 0, 300));
    // Entry at T0 + 2m, 5 minutes long: priced from the 5-minute opens at T0 + 5m and T0 + 10m.
    const b = anyCoinBook([lock(0, T0 + 120, 300, rev("BTC", 1, 300, T0 + 900))]);
    const ls = deriveLocks(b, T0 + HOUR, NAMES);
    const [c] = priceLocks(b, ls, hourly, NAMES, fine);
    assert.equal(c.candles, "5m");
    assert.equal(c.entry, price("BTC", T0 + 300), "entry rounds up to the next 5 minutes, never back");
    assert.equal(c.exit, price("BTC", T0 + 600));
    assert.ok(c.ret > 0);
    // With no 5-minute prices left (older than Hyperliquid keeps), it falls back to hourly ones.
    const [h] = priceLocks(b, ls, hourly, NAMES, null);
    assert.equal(h.candles, "1h");
    assert.equal(h.entry, price("BTC", T0 + HOUR));
    // Calls of an hour or more always use hourly candles.
    const long = anyCoinBook([lock(0, T0 + 120, HOUR, rev("BTC", 1, HOUR, T0 + 2 * HOUR))]);
    assert.equal(priceLocks(long, deriveLocks(long, T0 + 3 * HOUR, NAMES), hourly, NAMES, fine)[0].candles, "1h");
    // evaluateCaller fetches 5-minute candles only when there's a short call.
    const asked = [];
    const source = { perpNames: async () => NAMES, load: async (coins, from, to, interval = "1h") => { asked.push(interval); return synthetic(coins, from, to, price, 0, interval === "5m" ? 300 : HOUR); } };
    const ev = await evaluateCaller({ chain: { chainId: 1, address: "0x01" }, book: b, source, asOf: T0 + HOUR, reportUri: () => "x" });
    assert.deepEqual(asked, ["1h", "5m"]);
    assert.equal(ev.scored.periods[0].candles, "5m");
    asked.length = 0;
    await evaluateCaller({ chain: { chainId: 1, address: "0x01" }, book: long, source, asOf: T0 + 3 * HOUR, reportUri: () => "x" });
    assert.deepEqual(asked, ["1h"]);
  });

  test("the skill score: always long on a rising coin isn't skill, and a hidden call counts as wrong", async () => {
    const source = (price) => ({ perpNames: async () => NAMES, load: async (coins, from, to) => synthetic(coins, from, to, price) });
    const evaluate = (book, price, asOf) => evaluateCaller({ chain: { chainId: 1, address: "0x01" }, book, source: source(price), asOf, reportUri: () => "x" });

    // Long BTC every 2 hours while it rises steadily: judged against its own drift, about half are "right".
    const rising = (c, t) => 100 * (1 + Math.max(0, t - T0) / (100 * HOUR));
    const always = anyCoinBook(Array.from({ length: 30 }, (_, i) => lock(i, T0 + i * 2 * HOUR, HOUR, rev("BTC", 1, HOUR, T0 + i * 2 * HOUR + 2 * HOUR))));
    const a = (await evaluate(always, rising, T0 + 62 * HOUR)).scored.skill;
    assert.equal(a.calls, 30);
    assert.ok(a.hitRate > 0.3 && a.hitRate < 0.7, `hit rate ${a.hitRate}`);
    assert.equal(a.level, "unrated");

    // One long that caught a jump, one call never revealed: half right.
    const jump = (c, t) => (c === "BTC" && t >= T0 + HOUR ? 110 : 100);
    const two = anyCoinBook([lock(0, T0, 2 * HOUR, rev("BTC", 1, 2 * HOUR, T0 + 3 * HOUR)), lock(1, T0 + 5 * HOUR, HOUR, null)]);
    const ev = await evaluate(two, jump, T0 + 6 * HOUR + GRACE + 1);
    assert.deepEqual([ev.scored.skill.calls, ev.scored.skill.hitRate], [2, 0.5]);
    assert.deepEqual(ev.report.report.skill, ev.scored.skill, "the published report carries the skill score");
  });

  test("H6: withheld and unscorable any-coin calls score the worst over the 50-perp reference set at their horizon", () => {
    // ZEC (in the reference set, not BTC/ETH/SOL) swings hardest: up 1% an hour for 10 days.
    const price = (c, t) => (c === "ZEC" ? 100 * (1 + Math.min(240, Math.max(0, (t - T0) / HOUR)) / 100) : c === "SOL" ? 100 * (1 + Math.max(0, (t - T0) / HOUR) / 1000) : 100);
    const prices = priceBook(synthetic(["BTC", "ETH", "SOL", "ZEC"], T0 - DAY, T0 + 40 * DAY, price));
    const b = anyCoinBook([lock(0, T0, 10 * HOUR, null), lock(1, T0, 2 * HOUR, rev("NOPE", 1, 2 * HOUR, T0 + 3 * HOUR))]);
    const asOf = T0 + 10 * HOUR + GRACE + 1;
    const [w, u] = priceLocks(b, deriveLocks(b, asOf, NAMES), prices, NAMES);
    assert.equal(REFERENCE_SET.length, 50);
    assert.ok(REFERENCE_SET.includes("ZEC"));
    assert.equal(REFERENCE_SET_NAME, "hyperliquid-top50-2026-10-07");
    assert.equal(w.status, "withheld");
    assert.deepEqual(w.worst, { coin: "ZEC", side: -1, horizon: 10 * HOUR }, "worst coin of the set, at the lock's own horizon");
    assert.ok(Math.abs(w.ret - netOf(-1, 0.1).net) < 1e-9);
    assert.equal(u.status, "unscorable");
    assert.match(u.note, /NOPE/);
    assert.deepEqual(u.worst, { coin: "ZEC", side: -1, horizon: 2 * HOUR });
    assert.ok(Math.abs(u.ret - netOf(-1, 102 / 100 - 1).net) < 1e-9);
    // A coin-list book's hidden call is scored over its own coins.
    const listed = { ...b, anyCoin: false, coins: ["btc"] };
    assert.equal(priceLocks(listed, deriveLocks(listed, asOf, NAMES), prices, NAMES)[0].ret, netOf(1, 0).net);
    assert.equal(worstOver(prices, ["BTC"], T0, 2 * HOUR).move, 0);
  });

  test("H3: coins are matched to Hyperliquid before any fetch; unknown ones are never fetched", async () => {
    const asked = [];
    const source = {
      perpNames: async () => NAMES,
      load: async (coins, from, to) => { asked.push(...coins); return synthetic(coins, from, to, () => 100); },
    };
    const b = anyCoinBook([lock(0, T0, HOUR, rev("ScamCoin", 1, HOUR, T0 + 2 * HOUR)), lock(1, T0, HOUR, rev("eth", 1, HOUR, T0 + 2 * HOUR))]);
    const ev = await evaluateCaller({ chain: { chainId: 1, address: "0x01" }, book: b, source, asOf: T0 + 3 * HOUR, reportUri: () => "x" });
    assert.ok(!asked.some((c) => /scam/i.test(c)), "the unknown symbol was never fetched");
    assert.ok(asked.includes("ETH"), "the known one was, by its Hyperliquid name");
    assert.equal(ev.scored.metrics.unscorable, 1);
    // A rebuild's coin budget is enforced.
    await assert.rejects(evaluateCaller({ chain: { chainId: 1, address: "0x01" }, book: b, source, asOf: T0 + 3 * HOUR, reportUri: () => "x", budget: { coins: new Set(["A", "B"]), max: 2 } }), /coin limit/);
  });

  test("H3: locks per book are capped (the latest kept)", () => {
    const many = Array.from({ length: MAX_LOCKS_PER_BOOK + 5 }, (_, i) => lock(i, T0 + i, HOUR, null));
    const ls = deriveLocks(anyCoinBook(many), T0 + 2 * HOUR, NAMES);
    assert.equal(ls.length, MAX_LOCKS_PER_BOOK);
    assert.equal(ls[0].callId, 5);
  });
});

describe("the caller score", () => {
  const strong = Array.from({ length: 30 }, (_, i) => ({ side: i % 2 ? 1 : -1, ret: 0.01 + (i % 3) * 0.002, move: 0 }));

  test("a full record, a strong edge and no drawdown is 100", () => {
    assert.equal(callerScore({ days: 61, outcomes: strong, maxDrawdown: 0 }).value, 100);
  });

  test("the record's length is its level, not a cut in the score; no calls is 0", () => {
    const full = callerScore({ days: 61, outcomes: strong, maxDrawdown: 0 });
    assert.equal(full.level, "full");
    assert.equal(callerScore({ days: 30.5, outcomes: strong, maxDrawdown: 0 }).value, full.value);
    assert.equal(callerScore({ days: 30.5, outcomes: strong, maxDrawdown: 0 }).level, "building");
    assert.equal(callerScore({ days: 61, outcomes: strong.slice(0, 15), maxDrawdown: 0 }).level, "new");
    assert.equal(callerScore({ days: 61, outcomes: [], maxDrawdown: 0 }).value, 0);
  });

  test("always long on a rising coin earns for its profit, but without beating the coin it can't pass 60", () => {
    const beta = Array.from({ length: 30 }, (_, i) => ({ side: 1, ret: 0.01 * (1 + (i % 4)), move: 0.01 * (1 + (i % 4)) }));
    const s = callerScore({ days: 61, outcomes: beta, maxDrawdown: 0.2 });
    assert.equal(s.beta, 1);
    assert.equal(s.edge, 0);
    assert.ok(s.profit > 0);
    assert.ok(s.value > 0 && s.value <= 100 * CALLER_RULES.profitWeight, `score ${s.value}`);
  });

  test("drawdown of the call-by-call record, and the metrics around it", () => {
    assert.ok(Math.abs(curveDrawdown([0.05, -0.1, 0.02]) - 0.1 / 1.05) < 1e-12);
    assert.equal(curveDrawdown([0.01, 0.02]), 0);
    const b = anyCoinBook([]);
    const priced = [
      { callId: 0, status: "revealed", entryAt: T0, side: 1, coin: "BTC", ret: 0.02, move: 0.021, horizon: HOUR, resolvedAt: T0 + HOUR },
      { callId: 1, status: "revealed", entryAt: T0 + DAY, side: -1, coin: "ETH", ret: -0.01, move: 0.009, horizon: 3 * HOUR, resolvedAt: T0 + DAY + 3 * HOUR },
      { callId: 2, status: "withheld", entryAt: T0 + DAY, ret: -0.05, move: 0, worst: { coin: "SOL", side: 1, horizon: HOUR }, resolvedAt: T0 + 40 * DAY },
      { callId: 3, status: "pending", entryAt: T0 + 2 * DAY },
    ];
    const s = scoreCaller(b, priced, { asOf: T0 + 41 * DAY });
    assert.equal(s.metrics.calls, 4);
    assert.equal(s.metrics.pending, 1);
    assert.ok(Math.abs(s.metrics.coverage - 2 / 3) < 1e-12);
    assert.equal(s.metrics.hitRate, 0.5);
    assert.deepEqual(s.metrics.best, { callId: 0, coin: "BTC", side: 1, ret: 0.02, status: "revealed" });
    assert.equal(s.metrics.worst.callId, 2);
    assert.equal(s.metrics.worst.coin, "SOL");
    assert.ok(Math.abs(s.metrics.totalReturn - -0.04) < 1e-12);
    assert.equal(s.curve[0].v, 1);
    assert.ok(Math.abs(s.curve[s.curve.length - 1].v - 0.96) < 1e-9);
  });
});

// ------------------------------------------------------------------ against a local node

const RPC = process.env.CALLBOOK_TEST_RPC ?? "http://127.0.0.1:8546";
const local = defineChain({ id: 31337, name: "Local", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pc = createPublicClient({ chain: local, transport: http(RPC), pollingInterval: 50 });
const MN = "test test test test test test test test test test test junk";
const w = (i) => createWalletClient({ account: mnemonicToAccount(MN, { addressIndex: i }), chain: local, transport: http(RPC), pollingInterval: 50 });
const CB = () => artifact("Callbook").abi;
let nodeUp = false;
before(async () => {
  try {
    nodeUp = (await pc.getChainId()) === 31337;
  } catch {
    nodeUp = false;
  }
});

async function deployCallbook() {
  const deployer = w(0);
  const deploy = async (name, args = []) => {
    const { abi, bytecode } = artifact(name);
    return (await pc.waitForTransactionReceipt({ hash: await deployer.deployContract({ abi, bytecode, args, account: deployer.account, chain: local }) })).contractAddress;
  };
  const identity = await deploy("MockIdentityRegistry");
  const callbook = await deploy("Callbook", [identity]);
  return { identity, callbook, fromBlock: await pc.getBlockNumber() };
}

async function signedLock(callbook, wallet, { coin = "BTC", side = 1, horizon = HOUR, deadline, salt = `0x${"11".repeat(32)}` } = {}) {
  const account = wallet.account.address;
  const nonce = await pc.readContract({ address: callbook, abi: CB(), functionName: "nonces", args: [account] });
  const callHash = symbolCallHash({ callbook, chainId: 31337, account, nonce, coin, side, horizon, salt });
  const dl = deadline ?? BigInt(Number((await pc.getBlock()).timestamp) + 600);
  const signature = await wallet.signTypedData({ account: wallet.account, domain: DOMAIN(31337, callbook), types: LOCK_TYPES, primaryType: "LockCall", message: { account, callHash, horizon, nonce, deadline: dl } });
  return { account, callHash, deadline: dl.toString(), signature, coin, side, horizon, salt, nonce };
}

const chainNow = async () => Number((await pc.getBlock()).timestamp);
/** The relayer's clock, kept on chain time: earlier tests move the node's clock far ahead of the wall's. */
const clock = { t: 0 };
const tickClock = async () => { clock.t = await chainNow(); };

test("the relayer: checks a signed lock off-chain, sends it, reveals it, and the engine scores it", async (t) => {
  if (!nodeUp) return t.skip(`no Hardhat node at ${RPC}`);
  const { callbook, fromBlock } = await deployCallbook();
  const relayer = createRelayer({ publicClient: pc, wallet: w(4), callbook, abi: CB(), chainId: 31337, now: () => clock.t });
  const user = w(9);
  // 20 minutes past an hour, so the call's exit (2 hours on) never lands on a candle open:
  // the "waiting for its exit price" check below needs its candle not to have opened yet.
  await pc.request({ method: "evm_mine", params: [`0x${(Math.ceil((await chainNow()) / HOUR) * HOUR + 20 * 60).toString(16)}`] });
  await tickClock();

  // The JS preimage is the contract's.
  const s = await signedLock(callbook, user, { coin: "kPEPE", side: -1, horizon: 2 * HOUR });
  assert.equal(await pc.readContract({ address: callbook, abi: CB(), functionName: "symbolCallHashOf", args: [callbook, 31337n, s.account, 0n, "kPEPE", -1, 2 * HOUR, s.salt] }), s.callHash);
  assert.equal(
    await pc.readContract({ address: callbook, abi: CB(), functionName: "lockedHashOf", args: [callbook, 31337n, 3n, 4n, 1, 1, HOUR, s.salt] }),
    lockedHash({ callbook, chainId: 31337, bookId: 3, callId: 4, coinIndex: 1, side: 1, horizon: HOUR, salt: s.salt }),
  );

  const before = await pc.getBalance({ address: s.account });
  const r = await relayer.lock(s);
  assert.equal(r.callId, "0");
  assert.match(r.txHash, /^0x[0-9a-f]{64}$/);
  assert.equal(await pc.getBalance({ address: s.account }), before, "the caller paid nothing");

  // The same signature again: the nonce moved on, refused before anything is sent.
  await assert.rejects(relayer.lock(s), (e) => e.status === 401);
  // Someone else's signature for this account.
  const forged = await signedLock(callbook, w(8));
  await assert.rejects(relayer.lock({ ...forged, account: s.account }), (e) => e.status === 401);
  await assert.rejects(relayer.lock({ ...s, deadline: "1" }), (e) => e.status === 400 && /deadline/.test(e.message));
  await assert.rejects(relayer.lock({ ...s, callHash: "0x1234" }), (e) => e.status === 400);
  // H2: exactly 65 bytes, a deadline at least 30 s away, a plain key, and the horizon is part of what was signed.
  await assert.rejects(relayer.lock({ ...s, signature: `${s.signature}00` }), (e) => e.status === 400 && /65 bytes/.test(e.message));
  await assert.rejects(relayer.lock({ ...s, deadline: String(clock.t + 10) }), (e) => e.status === 400 && /30 seconds/.test(e.message));
  await assert.rejects(relayer.lock({ ...s, account: callbook }), (e) => e.status === 400 && /contract wallet/.test(e.message));
  const fresh = await signedLock(callbook, user, { horizon: HOUR });
  await assert.rejects(relayer.lock({ ...fresh, horizon: 2 * HOUR }), (e) => e.status === 401, "a relayer can't change the horizon");

  // Reveal after the horizon, through the relayer (anyone may).
  await pc.request({ method: "evm_mine", params: [`0x${(r.entryAt + 2 * HOUR + 30).toString(16)}`] });
  await tickClock();
  await assert.rejects(relayer.reveal({ kind: "symbol", bookId: r.bookId, callId: r.callId, coin: "KPEPE", side: -1, horizon: 2 * HOUR, salt: s.salt }), (e) => e.status === 422, "a wrong preimage is refused in simulation");
  const rv = await relayer.reveal({ kind: "symbol", bookId: r.bookId, callId: r.callId, coin: "kPEPE", side: -1, horizon: 2 * HOUR, salt: s.salt });
  assert.match(rv.txHash, /^0x/);

  const chain = await readCallbook({ client: pc, address: callbook, fromBlock });
  const book = chain.books.get(Number(r.bookId));
  assert.equal(book.kind, "free");
  assert.equal(book.anyCoin, true);
  assert.equal(book.owner, s.account.toLowerCase());
  // Scored once the hourly candle its exit is priced at has opened; before that it waits.
  const early = await evaluateCaller({ chain, book, source: sourceOf((c, x) => 100 + (x % 7)), asOf: await chainNow(), reportUri: () => "x" });
  assert.equal(early.scored.periods[0].status, "pending");
  assert.match(early.scored.periods[0].note, /waiting for its exit price/);
  const ev = await evaluateCaller({ chain, book, source: sourceOf((c, x) => 100 + (x % 7)), asOf: (await chainNow()) + HOUR, reportUri: () => "x" });
  assert.equal(ev.scored.periods[0].status, "revealed");
  assert.equal(ev.scored.periods[0].coin, "kPEPE");
  assert.equal(ev.scored.metrics.calls, 1);
  const built = await buildCallbook({ chain, source: sourceOf(() => 100), asOf: await chainNow(), meta: { mode: "replay" } });
  assert.equal(built.index.callers.length, 1);
  assert.equal(built.index.books.length, 0);
  assert.deepEqual(built.index.feed.map((f) => f.kind).sort(), ["locked", "revealed"]);
  assert.equal(built.callerDetails.get(r.bookId).calls[0].lockTx, r.txHash);
});

test("the relayer's limits: per account, and the daily gas budget", async (t) => {
  if (!nodeUp) return t.skip(`no Hardhat node at ${RPC}`);
  const { callbook } = await deployCallbook();
  const user = w(7);
  const tight = createRelayer({ publicClient: pc, wallet: w(4), callbook, abi: CB(), chainId: 31337, now: () => clock.t, limits: { locksPerAccountHour: 2 } });
  await tickClock();
  await tight.lock(await signedLock(callbook, user));
  await tight.lock(await signedLock(callbook, user));
  await assert.rejects(tight.lock(await signedLock(callbook, user)), (e) => e.status === 429);

  const broke = createRelayer({ publicClient: pc, wallet: w(4), callbook, abi: CB(), chainId: 31337, now: () => clock.t, limits: { dailyBudgetUsdc: 0.000001 } });
  await assert.rejects(broke.lock(await signedLock(callbook, w(6))), (e) => e.status === 503 && /budget/.test(e.message));
});

test("the relayer seals for a scheduled book's caller, and refuses anyone else's signature", async (t) => {
  if (!nodeUp) return t.skip(`no Hardhat node at ${RPC}`);
  const { callbook } = await deployCallbook();
  const owner = w(1), caller = w(2);
  const now = await chainNow();
  const openAt = Math.ceil(now / (4 * HOUR)) * 4 * HOUR + 1000;
  await pc.request({ method: "evm_mine", params: [`0x${openAt.toString(16)}`] });
  const rc = await pc.waitForTransactionReceipt({ hash: await owner.writeContract({ address: callbook, abi: CB(), functionName: "open", args: [2n ** 256n - 1n, caller.account.address, `0x${"ab".repeat(32)}`, ["BTC"], 4 * HOUR, 4 * HOUR], account: owner.account, chain: local }) });
  const bookId = parseEventLogs({ abi: CB(), logs: rc.logs, eventName: "Opened" })[0].args.bookId;
  const relayer = createRelayer({ publicClient: pc, wallet: w(4), callbook, abi: CB(), chainId: 31337, now: () => openAt + 5 });
  const message = { bookId, p: 0n, callHash: `0x${"cd".repeat(32)}`, deadline: BigInt(openAt + 900) };
  const sign = (wallet) => wallet.signTypedData({ account: wallet.account, domain: DOMAIN(31337, callbook), types: SEAL_TYPES, primaryType: "SealCall", message });
  const body = { bookId: String(bookId), p: "0", callHash: message.callHash, deadline: String(message.deadline) };
  await assert.rejects(relayer.seal({ ...body, signature: await sign(w(9)) }), (e) => e.status === 401);
  const r = await relayer.seal({ ...body, signature: await sign(caller) });
  assert.equal(r.p, "0");
  await assert.rejects(relayer.seal({ ...body, signature: await sign(caller) }), (e) => e.status === 422 && /AlreadySealed/.test(e.message));
});

async function signedProfile(callbook, wallet, { bookId = 0n, name = "Midnight", bio = "", link = "", deadline } = {}) {
  const account = wallet.account.address;
  const nonce = await pc.readContract({ address: callbook, abi: CB(), functionName: "profileNonces", args: [account] });
  const dl = deadline ?? BigInt((await chainNow()) + 600);
  const message = { account, bookId, name, bio, link, nonce, deadline: dl };
  const signature = await wallet.signTypedData({ account: wallet.account, domain: DOMAIN(31337, callbook), types: PROFILE_TYPES, primaryType: "SetProfile", message });
  return { account, bookId: String(bookId), name, bio, link, deadline: dl.toString(), signature };
}

test("the relayer sets profiles, refuses bad ones before paying, and the index shows them", async (t) => {
  if (!nodeUp) return t.skip("no Hardhat node at " + RPC);
  const { callbook, fromBlock } = await deployCallbook();
  const relayer = createRelayer({ publicClient: pc, wallet: w(4), callbook, abi: CB(), chainId: 31337, now: () => clock.t, limits: { profilesPerAccountDay: 3 } });
  const user = w(9);
  await tickClock();

  // No record yet: a name would show nowhere, so we don't pay for it.
  await assert.rejects(relayer.profile(await signedProfile(callbook, user, { name: "Too Early" })), (e) => e.status === 400 && /first call/.test(e.message));
  const before = await pc.getBalance({ address: user.account.address });
  const locked = await relayer.lock(await signedLock(callbook, user));
  const r = await relayer.profile(await signedProfile(callbook, user, { name: "Midnight Momentum", bio: "Breakouts", link: "https://x.com/m" }));
  assert.equal(r.bookId, "0");
  assert.equal(await pc.getBalance({ address: user.account.address }), before, "the person paid nothing");

  // Refused before anything is sent: the rules, text that isn't the cleaned form, someone else's book, a stale signature.
  await assert.rejects(relayer.profile(await signedProfile(callbook, user, { name: "R3INS" })), (e) => e.status === 400 && /reserved/.test(e.message));
  await assert.rejects(relayer.profile(await signedProfile(callbook, user, { name: "ok", link: "http://x.com" })), (e) => e.status === 400);
  await assert.rejects(relayer.profile(await signedProfile(callbook, user, { name: " Spaced " })), (e) => e.status === 400 && /rules clean it/.test(e.message));
  await assert.rejects(relayer.profile(await signedProfile(callbook, w(8), { bookId: BigInt(locked.bookId), name: "Thief" })), (e) => e.status === 400 && /owner/.test(e.message));
  const signed = await signedProfile(callbook, user, { name: "Changed" });
  await assert.rejects(relayer.profile({ ...signed, name: "Tampered" }), (e) => e.status === 401);
  await relayer.profile(signed);
  await assert.rejects(relayer.profile(signed), (e) => e.status === 401, "the nonce moved on");
  // The book's own name, then the daily cap (3 here).
  await relayer.profile(await signedProfile(callbook, user, { bookId: BigInt(locked.bookId), name: "ETH swings" }));
  await assert.rejects(relayer.profile(await signedProfile(callbook, user, { name: "Fourth" })), (e) => e.status === 429);

  const chain = await readCallbook({ client: pc, address: callbook, fromBlock });
  const built = await buildCallbook({ chain, source: sourceOf(() => 100), asOf: await chainNow(), meta: { mode: "replay" } });
  const caller = built.index.callers[0];
  assert.equal(caller.name, "ETH swings");
  assert.equal(caller.nameSource, "book");
  // Cleared, the book falls back to the person's latest name.
  const hash = await user.writeContract({ address: callbook, abi: CB(), functionName: "setProfile", args: [BigInt(locked.bookId), "", "", ""], account: user.account, chain: local });
  await pc.waitForTransactionReceipt({ hash });
  const again = await readCallbook({ client: pc, address: callbook, fromBlock, state: chain });
  const person = (await buildCallbook({ chain: again, source: sourceOf(() => 100), asOf: await chainNow(), meta: { mode: "replay" } })).index.callers[0];
  assert.deepEqual([person.name, person.nameSource, person.bio, person.link, person.linkDomain], ["Changed", "person", null, null, null]);
});

test("profileFor: own name, then the person's (numbered when they run several), then the agent card; hidden ones never", () => {
  const p = (name, bio = "", link = "") => ({ name, bio, link });
  const owner = "0x00000000000000000000000000000000000000aa";
  const books = new Map([[1, { id: 1, owner, anyCoin: true }], [2, { id: 2, owner, kind: "scheduled", agentId: 7 }], [3, { id: 3, owner: "0x00000000000000000000000000000000000000bb", agentId: 9 }]]);
  const chain = { chainId: 31337, address: "0xc0", books, profiles: new Map([[owner + ":0", p("Midnight", "hi", "https://x.com/m")], [owner + ":2", p("")]]) };
  assert.deepEqual(profileFor({ chain, book: books.get(1) }), { name: "Midnight", bio: "hi", link: "https://x.com/m", domain: "x.com", source: "person" });
  assert.equal(profileFor({ chain, book: books.get(2) }).name, "Midnight #2"); // an empty own name falls through
  const cards = new Map([["9", { name: "Agent Nine", description: "an ERC-8004 agent" }]]);
  assert.deepEqual(profileFor({ chain, book: books.get(3), cards }), { name: "Agent Nine", bio: "an ERC-8004 agent", link: null, domain: null, source: "agent" });
  assert.equal(profileFor({ chain, book: books.get(3), cards: new Map([["9", { name: "Reins", description: "" }]]) }), null, "a card can't impersonate us either");
});

test("agent cards: inline, https and ipfs files; private addresses refused at connect time; slow hosts never hold up the index", async () => {
  assert.equal(cardSource("data:application/json;base64," + Buffer.from('{"name":"A"}').toString("base64")).inline, '{"name":"A"}');
  assert.equal(cardSource("ipfs://bafyabc/agent.json").url, "https://ipfs.io/ipfs/bafyabc/agent.json");
  assert.equal(cardSource("http://x.com/a.json"), null);
  assert.equal(cardSource("file:///etc/passwd"), null);
  for (const ip of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.1.1", "172.20.0.1", "100.64.0.1", "192.0.0.1", "::1", "fd00::1", "fec0::1",
    "::ffff:127.0.0.1", "::127.0.0.1", "64:ff9b::7f00:1", "2002:7f00:1::", "0:0:0:0:0:ffff:7f00:1"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "2606:4700::1111"]) assert.equal(isPrivateAddress(ip), false, ip);

  // The address is checked when the connection is made: a resolver that answers private is refused.
  const lookupWith = (answer) => new Promise((resolve) => safeLookup((h, o, cb) => cb(null, answer))("x.example", { all: true }, (err, addrs) => resolve(err ? err.message : addrs)));
  assert.match(await lookupWith([{ address: "127.0.0.1", family: 4 }]), /isn't a public address/);
  assert.match(await lookupWith([{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }]), /isn't a public address/);
  assert.deepEqual(await lookupWith([{ address: "93.184.216.34", family: 4 }]), [{ address: "93.184.216.34", family: 4 }]);
  await assert.rejects(safeGet("https://127.0.0.1/a.json"), /public address/);
  await assert.rejects(safeGet("http://x.example/a.json"), /https only/);

  let gets = 0;
  const uris = { 1: "https://cards.example/1.json", 3: "https://cards.example/big.json", 4: "data:application/json,%7B%22name%22%3A%22Inline%22%7D", 5: "https://cards.example/slow.json" };
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const cards = createAgentCards({
    tokenUri: async (id) => uris[id],
    get: async (url) => {
      gets++;
      if (url.includes("big")) throw new Error("the registration file is over 65536 bytes");
      if (url.includes("slow")) { await slow; return JSON.stringify({ name: "Slow One" }); }
      return JSON.stringify({ name: "Card One", description: "d", image: "ignored" });
    },
  });
  assert.deepEqual(await cards.card(1), { name: "Card One", description: "d" });
  await cards.card(1);
  assert.equal(gets, 1, "one read a day");
  await assert.rejects(cards.card(3), /over/);
  assert.equal(await cards.card(3), null, "a failure is cached as no card");
  assert.deepEqual(await cards.card(4), { name: "Inline", description: "" });

  // peek answers at once; the slow card arrives for the next rebuild.
  assert.equal(cards.peek(5), null);
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(cards.peek(5), { name: "Slow One", description: "" });
});

test("the relayer links an agent to a wallet with both halves, the index shows it, and either side unlinks", async (t) => {
  if (!nodeUp) return t.skip("no Hardhat node at " + RPC);
  const { callbook, fromBlock } = await deployCallbook();
  const relayer = createRelayer({ publicClient: pc, wallet: w(4), callbook, abi: CB(), chainId: 31337, now: () => clock.t });
  const agent = w(9), wallet = w(7);
  await tickClock();
  await relayer.lock(await signedLock(callbook, agent)); // the agent has a record

  const deadline = BigInt((await chainNow()) + 3600);
  const message = { agent: agent.account.address, wallet: wallet.account.address, nonce: 0n, deadline };
  const sign = (who) => who.signTypedData({ account: who.account, domain: DOMAIN(31337, callbook), types: LINK_TYPES, primaryType: "LinkAgent", message });
  const body = { agent: message.agent, wallet: message.wallet, deadline: String(deadline), agentSig: await sign(agent) };

  // The link page checks the agent's half before showing anything; nothing is sent.
  const checked = await relayer.linkCheck(body);
  assert.deepEqual([checked.nonce, checked.linkedTo], ["0", null]);
  await assert.rejects(relayer.linkCheck({ ...body, agentSig: await sign(wallet) }), (e) => e.status === 401);
  await assert.rejects(relayer.linkCheck({ ...body, wallet: body.agent }), (e) => e.status === 400 && /itself/.test(e.message));

  // The wallet's half must be the wallet's.
  await assert.rejects(relayer.link({ ...body, walletSig: await sign(agent) }), (e) => e.status === 401);
  const r = await relayer.link({ ...body, walletSig: await sign(wallet) });
  assert.match(r.txHash, /^0x/);
  await assert.rejects(relayer.link({ ...body, walletSig: await sign(wallet) }), (e) => e.status === 401, "used once");

  const chain = await readCallbook({ client: pc, address: callbook, fromBlock });
  assert.equal(chain.links.get(agent.account.address.toLowerCase()).wallet, wallet.account.address.toLowerCase());
  const built = await buildCallbook({ chain, source: sourceOf(() => 100), asOf: await chainNow(), meta: { mode: "replay" } });
  assert.deepEqual(built.index.links, { [agent.account.address.toLowerCase()]: wallet.account.address.toLowerCase() });

  // The wallet unlinks it, by signature, through the relayer.
  const unlinkDeadline = BigInt((await chainNow()) + 600);
  const unlinkSig = await wallet.signTypedData({ account: wallet.account, domain: DOMAIN(31337, callbook), types: UNLINK_TYPES, primaryType: "UnlinkAgent", message: { agent: message.agent, nonce: 1n, deadline: unlinkDeadline } });
  await assert.rejects(relayer.unlink({ agent: message.agent, signer: w(8).account.address, deadline: String(unlinkDeadline), signature: unlinkSig }), (e) => e.status === 400 && /only the agent or its wallet/.test(e.message));
  await relayer.unlink({ agent: message.agent, signer: message.wallet, deadline: String(unlinkDeadline), signature: unlinkSig });
  const after = await readCallbook({ client: pc, address: callbook, fromBlock, state: chain });
  assert.equal(after.links.size, 0);
  await assert.rejects(relayer.unlink({ agent: message.agent, signer: message.wallet, deadline: String(unlinkDeadline), signature: unlinkSig }), (e) => e.status === 400 && /isn't linked/.test(e.message));
});

test("HTTP: the relay routes are 503 without a key, and work with one; unconfigured routes redirect to the export", async (t) => {
  const serve = async (env) => {
    const app = express();
    app.use(express.json());
    mountCallbook(app, { env, source: sourceOf(() => 100), now: () => clock.t });
    const server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
  };
  const off = await serve({});
  try {
    const r = await fetch(`${off.url}/api/callbook/caller/12`, { redirect: "manual" });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), "/data/callbook-caller-12.json");
    const relay = await fetch(`${off.url}/api/callbook/relay/lock`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(relay.status, 503);
    const health = await (await fetch(`${off.url}/api/callbook/health`)).json();
    assert.equal(health.ok, false);
    assert.match(health.problems.join(" "), /isn't configured/);
  } finally {
    await off.close();
  }
  if (!nodeUp) return t.skip(`no Hardhat node at ${RPC} for the live half`);

  const { callbook, fromBlock } = await deployCallbook();
  const base = { CALLBOOK_NETWORK: "local", CALLBOOK_ADDRESS: callbook, CALLBOOK_RPC: RPC, CALLBOOK_FROM_BLOCK: String(fromBlock) };
  const nokey = await serve(base);
  try {
    const r = await fetch(`${nokey.url}/api/callbook/relay/lock`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /relayer is off/);
  } finally {
    await nokey.close();
  }
  await tickClock();
  const on = await serve({ ...base, CALLBOOK_RELAYER_KEY: `0x${Buffer.from(mnemonicToAccount(MN, { addressIndex: 4 }).getHdKey().privateKey).toString("hex")}` });
  try {
    const s = await signedLock(callbook, w(9));
    const post = (body) => fetch(`${on.url}/api/callbook/relay/lock`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: body.account, callHash: body.callHash, horizon: body.horizon, deadline: body.deadline, signature: body.signature }) });
    const bad = await post({ ...s, signature: s.signature.replace(/.$/, (c) => (c === "0" ? "1" : "0")) });
    assert.equal(bad.status, 401);
    const ok = await post(s);
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.callId, "0");
    await tickClock();
    const index = await (await fetch(`${on.url}/api/callbook`)).json();
    assert.equal(index.callers.length, 1);
    assert.equal(index.callers[0].pending, 1);
    assert.equal(index.callers[0].baseline, false);
    const detail = await (await fetch(`${on.url}/api/callbook/caller/${body.bookId}`)).json();
    assert.equal(detail.calls[0].status, "pending");
    assert.equal(detail.calls[0].lockTx, body.txHash);
    const report = await fetch(`${on.url}/api/callbook/report/${body.bookId}?asOf=${await chainNow()}`);
    assert.equal(report.status, 200);
    assert.match(report.headers.get("x-report-hash"), /^0x[0-9a-f]{64}$/);
    // The board is cached by the CDN too (it reads s-maxage only).
    assert.match((await fetch(`${on.url}/api/callbook`)).headers.get("cache-control"), /s-maxage=30/);
    // Health: the relayer is on and funded; without a validator, that's the problem it names.
    const health = await (await fetch(`${on.url}/api/callbook/health`)).json();
    assert.equal(health.relayer.on, true);
    assert.ok(health.relayer.balanceUsdc > 1);
    assert.equal(health.ok, false);
    assert.deepEqual(health.problems, ["no validator is set, so no published score is shown"]);
    assert.ok(Number(health.chain.head) > 0);
  } finally {
    await on.close();
  }
});

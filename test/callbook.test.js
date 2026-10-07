/**
 * Arena — the notary for trading agents.
 *
 * The contract's whole value is that a sealed call was fixed before the
 * outcome and is revealed exactly as sealed. So these tests are mostly about
 * the ways an agent could cheat that: sealing late, sealing many futures,
 * revealing something else, replaying a hash from another book, contract or
 * chain, or linking an identity that isn't theirs.
 *
 * Time is driven exactly with evm_setNextBlockTimestamp, so every deadline is
 * tested on both sides of its boundary.
 */
import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, keccak256, decodeEventLog, toHex, domainSeparator } from "viem";

import { publicClient, walletFor, account, waitForNode, localChain, expectRevert } from "./helpers.js";
import { artifact } from "../scripts/artifact.js";

const deployer = walletFor(0);
const owner = walletFor(1);
const agentKey = walletFor(2);
const validator = walletFor(3);
const stranger = walletFor(4);
const operator = walletFor(5);
const approved = walletFor(6);

const OWNER = account(1).address;
const AGENT_KEY = account(2).address;
const VALIDATOR = account(3).address;
const STRANGER = account(4).address;
const OPERATOR = account(5).address;
const APPROVED = account(6).address;
const ZERO = "0x0000000000000000000000000000000000000000";

const CALLBOOK = artifact("Callbook");
const IDENTITY = artifact("MockIdentityRegistry");
const VALIDATION = artifact("MockValidationRegistry");

const MIN = 60n;
const HOUR = 3600n;
const DAY = 86400n;
const PERIOD = 4n * HOUR;
const HORIZON = 4n * HOUR;
const SEAL_LEAD = 60n;
const GRACE = 7n * DAY;
const COINS = ["BTC", "ETH", "SOL"];
const STRATEGY = keccak256(toHex("smart-money v1"));
const LONG = 1;
const FLAT = 0;
const SHORT = -1;
/** "No ERC-8004 agent linked". Not 0: the real registry numbers agents from 0. */
const NO_AGENT = 2n ** 256n - 1n;

let identity;
const gasUsed = {};

before(async () => {
  await waitForNode();
  identity = await deploy("MockIdentityRegistry");
});

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

async function deploy(name, args = [], wallet = deployer) {
  const { abi, bytecode } = artifact(name);
  const hash = await wallet.deployContract({ abi, bytecode, args, account: wallet.account, chain: localChain });
  return (await publicClient.waitForTransactionReceipt({ hash })).contractAddress;
}

async function send(wallet, address, abi, functionName, args) {
  const hash = await wallet.writeContract({ address, abi, functionName, args, account: wallet.account, chain: localChain });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success");
  return receipt;
}

const read = (address, functionName, args = [], abi = CALLBOOK.abi) =>
  publicClient.readContract({ address, abi, functionName, args });

const rpc = (method, params = []) => publicClient.request({ method, params });
const hex = (n) => `0x${BigInt(n).toString(16)}`;
const latest = async () => (await publicClient.getBlock()).timestamp;

/** The next transaction (or gas estimate) runs at exactly `t`. */
const at = (t) => rpc("evm_setNextBlockTimestamp", [hex(t)]);
/** Mine an empty block at `t`, so views see that time. */
const mineAt = (t) => rpc("evm_mine", [hex(t)]);

/** 1000s past the next period boundary: a clean, predictable place to open. */
async function cleanSlot(period = PERIOD) {
  const now = await latest();
  return (now / period + 1n) * period + 1000n;
}

function eventsOf(receipt, address, abi = CALLBOOK.abi) {
  return receipt.logs
    .filter((l) => l.address.toLowerCase() === address.toLowerCase())
    .map((l) => decodeEventLog({ abi, data: l.data, topics: l.topics }));
}

const salt = (n) => keccak256(toHex(`salt-${n}`));

/** The preimage hash, computed independently of the contract. */
function callHash({ callbook, chainId = localChain.id, bookId, p, coinIndex, side, salt: s }) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint64" },
        { type: "uint8" },
        { type: "int8" },
        { type: "bytes32" },
      ],
      [callbook, BigInt(chainId), BigInt(bookId), BigInt(p), coinIndex, side, s],
    ),
  );
}

/** A fresh Arena and a book opened at a clean time. Returns its timeline. */
async function setup({
  coins = COINS,
  period = PERIOD,
  horizon = HORIZON,
  caller = AGENT_KEY,
  agentId = NO_AGENT,
  registry = identity,
  openAt,
} = {}) {
  const callbook = await deploy("Callbook", [registry]);
  const openedAt = openAt ?? (await cleanSlot(period));
  await at(openedAt);
  const receipt = await send(owner, callbook, CALLBOOK.abi, "open", [agentId, caller, STRATEGY, coins, Number(period), Number(horizon)]);
  const bookId = eventsOf(receipt, callbook)[0].args.bookId;
  const start = (await read(callbook, "books", [bookId]))[6];
  const startOf = (p) => start + BigInt(p) * period;
  return { callbook, bookId, start, startOf, openedAt, receipt, period, horizon };
}

/** Seal call `p` at time `t` with the agent key; returns the preimage. */
async function sealAt(book, t, p, { coinIndex = 0, side = LONG, s = salt(p), wallet = agentKey } = {}) {
  const call = { callbook: book.callbook, bookId: book.bookId, p, coinIndex, side, salt: s };
  await at(t);
  const receipt = await send(wallet, book.callbook, CALLBOOK.abi, "seal", [book.bookId, BigInt(p), callHash(call)]);
  return { ...call, receipt };
}

const revealArgs = (c) => [c.bookId, BigInt(c.p), c.coinIndex, c.side, c.salt];

// ---------------------------------------------------------------------------
// Opening a book
// ---------------------------------------------------------------------------

describe("open", () => {
  test("without an agent: stores the book, aligns the start and emits everything", async () => {
    const book = await setup();
    const b = await read(book.callbook, "books", [book.bookId]);
    const [bOwner, period, horizon, coinCount, closedAt, caller, start, agentId, strategyHash, coinsHash] = b;

    assert.equal(book.bookId, 1n);
    assert.equal(bOwner, OWNER);
    assert.equal(BigInt(period), PERIOD);
    assert.equal(BigInt(horizon), HORIZON);
    assert.equal(coinCount, COINS.length);
    assert.equal(closedAt, 0n);
    assert.equal(caller, AGENT_KEY);
    assert.equal(agentId, NO_AGENT);
    assert.equal(await read(book.callbook, "NO_AGENT"), NO_AGENT);
    assert.equal(strategyHash, STRATEGY);
    assert.equal(coinsHash, keccak256(encodeAbiParameters([{ type: "string[]" }], [COINS])));

    // Period 0 begins at the next boundary, and is at least SEAL_LEAD away.
    assert.equal(start % PERIOD, 0n);
    assert.ok(start > book.openedAt + SEAL_LEAD);
    assert.ok(start <= book.openedAt + SEAL_LEAD + PERIOD);

    const [ev] = eventsOf(book.receipt, book.callbook);
    assert.equal(ev.eventName, "Opened");
    assert.deepEqual(ev.args, {
      bookId: 1n,
      owner: OWNER,
      agentId: NO_AGENT,
      caller: AGENT_KEY,
      strategyHash: STRATEGY,
      coins: COINS,
      period: Number(PERIOD),
      horizon: Number(HORIZON),
      start,
    });

    assert.equal(await read(book.callbook, "bookCount"), 1n);
    assert.deepEqual(await read(book.callbook, "booksOf", [OWNER]), [1n]);
    assert.deepEqual(await read(book.callbook, "booksOfAgent", [NO_AGENT]), []);
    assert.deepEqual(await read(book.callbook, "booksOfAgent", [0n]), []);
    gasUsed.open = book.receipt.gasUsed;
  });

  test("opened inside SEAL_LEAD of a boundary, period 0 is the one after, so it can still be sealed", async () => {
    const boundary = ((await latest()) / PERIOD + 2n) * PERIOD;
    const book = await setup({ openAt: boundary - 30n });
    assert.equal(book.start, boundary + PERIOD);
    assert.equal(await read(book.callbook, "sealablePeriod", [book.bookId]), 0n);
    await sealAt(book, boundary - 29n, 0); // the very next second
  });

  test("with an agent the sender owns, the book is listed under the agent", async () => {
    await send(deployer, identity, IDENTITY.abi, "mint", [OWNER, 101n]);
    const book = await setup({ agentId: 101n });
    assert.equal((await read(book.callbook, "books", [book.bookId]))[7], 101n);
    assert.deepEqual(await read(book.callbook, "booksOfAgent", [101n]), [book.bookId]);
    assert.equal(eventsOf(book.receipt, book.callbook)[0].args.agentId, 101n);
  });

  test("agent #0, which exists on Arc mainnet, links like any other", async () => {
    // A fresh registry, so id 0 is free; the real one hands out 0 first.
    const registry = await deploy("MockIdentityRegistry");
    const reg = await send(owner, registry, IDENTITY.abi, "register", []);
    assert.equal(BigInt(reg.logs[0].topics[3]), 0n);

    const book = await setup({ agentId: 0n, registry });
    assert.equal((await read(book.callbook, "books", [book.bookId]))[7], 0n);
    assert.equal(eventsOf(book.receipt, book.callbook)[0].args.agentId, 0n);
    assert.deepEqual(await read(book.callbook, "booksOfAgent", [0n]), [book.bookId]);
    assert.deepEqual(await read(book.callbook, "booksOfAgent", [NO_AGENT]), []);

    // Only its owner (or an operator) may link it.
    await expectRevert(
      stranger.writeContract({
        address: book.callbook,
        abi: CALLBOOK.abi,
        functionName: "open",
        args: [0n, AGENT_KEY, STRATEGY, COINS, Number(PERIOD), Number(HORIZON)],
        account: stranger.account,
        chain: localChain,
      }),
      "NotAgentOwner",
    );
  });

  test("refuses someone else's agent, and an agent that doesn't exist", async () => {
    await send(deployer, identity, IDENTITY.abi, "mint", [STRANGER, 102n]);
    const callbook = await deploy("Callbook", [identity]);
    const open = (agentId) =>
      owner.writeContract({
        address: callbook,
        abi: CALLBOOK.abi,
        functionName: "open",
        args: [agentId, AGENT_KEY, STRATEGY, COINS, Number(PERIOD), Number(HORIZON)],
        account: owner.account,
        chain: localChain,
      });
    await expectRevert(open(102n), "NotAgentOwner");
    await expectRevert(open(999_999n), "UnknownAgent");
    assert.equal(await read(callbook, "bookCount"), 0n);
  });

  test("an operator approved for all, or for the one agent, may link it", async () => {
    await send(deployer, identity, IDENTITY.abi, "mint", [STRANGER, 103n]);
    await send(deployer, identity, IDENTITY.abi, "mint", [STRANGER, 104n]);
    await send(stranger, identity, IDENTITY.abi, "setApprovalForAll", [OPERATOR, true]);
    await send(stranger, identity, IDENTITY.abi, "approve", [APPROVED, 104n]);
    const callbook = await deploy("Callbook", [identity]);
    const args = (agentId) => [agentId, AGENT_KEY, STRATEGY, COINS, Number(PERIOD), Number(HORIZON)];

    await send(operator, callbook, CALLBOOK.abi, "open", args(103n));
    await send(approved, callbook, CALLBOOK.abi, "open", args(104n));
    // Approval for 104 says nothing about 103.
    await expectRevert(
      approved.writeContract({ address: callbook, abi: CALLBOOK.abi, functionName: "open", args: args(103n), account: approved.account, chain: localChain }),
      "NotAgentOwner",
    );

    assert.deepEqual(await read(callbook, "booksOfAgent", [103n]), [1n]);
    assert.deepEqual(await read(callbook, "booksOfAgent", [104n]), [2n]);
    // The opener owns the book, not the agent's owner.
    assert.equal((await read(callbook, "books", [1n]))[0], OPERATOR);
  });

  test("on a chain with no IdentityRegistry, only NO_AGENT is accepted (agent #0 is refused too)", async () => {
    const callbook = await deploy("Callbook", [ZERO]);
    const open = (agentId) =>
      owner.writeContract({
        address: callbook,
        abi: CALLBOOK.abi,
        functionName: "open",
        args: [agentId, AGENT_KEY, STRATEGY, COINS, Number(PERIOD), Number(HORIZON)],
        account: owner.account,
        chain: localChain,
      });
    await expectRevert(open(1n), "NoIdentityRegistry");
    await expectRevert(open(0n), "NoIdentityRegistry");
    await send(owner, callbook, CALLBOOK.abi, "open", [NO_AGENT, AGENT_KEY, STRATEGY, COINS, Number(PERIOD), Number(HORIZON)]);
  });

  test("refuses a registry address with no code", async () => {
    await assert.rejects(deploy("Callbook", [STRANGER]));
  });

  test("coins: 1 to 32 symbols of 1 to 16 bytes", async () => {
    const callbook = await deploy("Callbook", [identity]);
    const open = (coins, wallet = owner) =>
      wallet.writeContract({
        address: callbook,
        abi: CALLBOOK.abi,
        functionName: "open",
        args: [NO_AGENT, AGENT_KEY, STRATEGY, coins, Number(PERIOD), Number(HORIZON)],
        account: wallet.account,
        chain: localChain,
      });
    const max = Array.from({ length: 32 }, (_, i) => `C${String(i).padStart(15, "0")}`); // 16 bytes each

    await expectRevert(open([]), "BadCoins");
    await expectRevert(open([...max, "X"]), "BadCoins");
    await expectRevert(open(["BTC", ""]), "BadCoins");
    await expectRevert(open(["BTC", "A".repeat(17)]), "BadCoins");
    await expectRevert(open(["é".repeat(9)]), "BadCoins"); // 18 bytes, though 9 characters

    const receipt = await send(owner, callbook, CALLBOOK.abi, "open", [NO_AGENT, AGENT_KEY, STRATEGY, max, Number(PERIOD), Number(HORIZON)]);
    assert.deepEqual(eventsOf(receipt, callbook)[0].args.coins, max);
    assert.equal((await read(callbook, "books", [1n]))[3], 32);
  });

  test("period: whole minutes from 5 minutes to 7 days; horizon: whole minutes from period to 30 days", async () => {
    const callbook = await deploy("Callbook", [identity]);
    const open = (period, horizon) =>
      owner.writeContract({
        address: callbook,
        abi: CALLBOOK.abi,
        functionName: "open",
        args: [NO_AGENT, AGENT_KEY, STRATEGY, COINS, Number(period), Number(horizon)],
        account: owner.account,
        chain: localChain,
      });
    const ok = (period, horizon) =>
      send(owner, callbook, CALLBOOK.abi, "open", [NO_AGENT, AGENT_KEY, STRATEGY, COINS, Number(period), Number(horizon)]);

    await expectRevert(open(4n * MIN, 4n * MIN), "BadPeriod");
    await expectRevert(open(5n * MIN - 1n, HOUR), "BadPeriod");
    await expectRevert(open(5n * MIN + 30n, HOUR), "BadPeriod"); // not whole minutes
    await expectRevert(open(7n * DAY + MIN, 7n * DAY + MIN), "BadPeriod");
    await expectRevert(open(HOUR, HOUR - MIN), "BadHorizon"); // shorter than the period
    await expectRevert(open(HOUR, 30n * DAY + MIN), "BadHorizon");
    await expectRevert(open(HOUR, HOUR + 1n), "BadHorizon"); // not whole minutes
    await expectRevert(open(0n, 0n), "BadPeriod");

    await ok(5n * MIN, 5n * MIN);
    await ok(7n * DAY, 30n * DAY);
    await ok(HOUR, 24n * HOUR);
    assert.equal(await read(callbook, "bookCount"), 3n);
  });
});

// ---------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------

describe("seal", () => {
  test("only the caller or the owner; a stranger is refused", async () => {
    const book = await setup();
    const t = book.openedAt + 1n; // inside period 0's window
    await at(t);
    await expectRevert(
      stranger.writeContract({
        address: book.callbook,
        abi: CALLBOOK.abi,
        functionName: "seal",
        args: [book.bookId, 0n, salt("x")],
        account: stranger.account,
        chain: localChain,
      }),
      "NotCaller",
    );
    const c = await sealAt(book, t, 0, { wallet: agentKey });
    gasUsed.seal = c.receipt.gasUsed;
    await sealAt(book, book.startOf(1) - PERIOD, 1, { wallet: owner });
  });

  test("the deadline is SEAL_LEAD before the period starts, to the second", async () => {
    // Two books with the same timeline: one seals on the deadline, one a second after.
    const book = await setup();
    await at(book.openedAt + 1n);
    const r = await send(owner, book.callbook, CALLBOOK.abi, "open", [NO_AGENT, AGENT_KEY, STRATEGY, COINS, Number(PERIOD), Number(HORIZON)]);
    const late = { ...book, bookId: eventsOf(r, book.callbook)[0].args.bookId };
    assert.equal(await read(book.callbook, "startOf", [late.bookId, 0n]), book.start);

    await sealAt(book, book.start - SEAL_LEAD, 0);
    const call = { callbook: book.callbook, bookId: late.bookId, p: 0, coinIndex: 0, side: LONG, salt: salt(0) };
    await at(book.start - SEAL_LEAD + 1n);
    const err = await expectRevert(
      agentKey.writeContract({
        address: book.callbook,
        abi: CALLBOOK.abi,
        functionName: "seal",
        args: [late.bookId, 0n, callHash(call)],
        account: agentKey.account,
        chain: localChain,
      }),
      "SealTooLate",
    );
    assert.ok(err);
  });

  test("a period that has started, or already passed, can't be sealed", async () => {
    const book = await setup();
    const trySeal = (p) =>
      agentKey.writeContract({
        address: book.callbook,
        abi: CALLBOOK.abi,
        functionName: "seal",
        args: [book.bookId, BigInt(p), salt(p)],
        account: agentKey.account,
        chain: localChain,
      });
    await at(book.startOf(2) + 10n); // period 2 under way
    await expectRevert(trySeal(2), "SealTooLate");
    await expectRevert(trySeal(0), "SealTooLate");
    await sealAt(book, book.startOf(2) + 11n, 3); // period 3 is the upcoming one
  });

  test("only the upcoming period: no stockpiling seals for later ones", async () => {
    const book = await setup();
    const trySeal = (p) =>
      agentKey.writeContract({
        address: book.callbook,
        abi: CALLBOOK.abi,
        functionName: "seal",
        args: [book.bookId, BigInt(p), salt(p)],
        account: agentKey.account,
        chain: localChain,
      });
    // Period 1 opens for sealing the second after period 0's deadline.
    const opensAt = book.startOf(1) - PERIOD - SEAL_LEAD + 1n;
    await at(opensAt - 1n);
    await expectRevert(trySeal(1), "SealTooEarly");
    await expectRevert(trySeal(50), "SealTooEarly");
    await expectRevert(trySeal(2n ** 64n - 1n), "SealTooEarly"); // no overflow trick
    await sealAt(book, opensAt, 1);
    await at(opensAt + 1n);
    await expectRevert(trySeal(2), "SealTooEarly");
  });

  test("the boundary second belongs to one period: never two sealable at once", async () => {
    const book = await setup();
    const trySeal = (p) =>
      agentKey.writeContract({
        address: book.callbook,
        abi: CALLBOOK.abi,
        functionName: "seal",
        args: [book.bookId, BigInt(p), salt(p)],
        account: agentKey.account,
        chain: localChain,
      });
    const deadline0 = book.start - SEAL_LEAD; // period 0's last second
    await at(deadline0);
    await expectRevert(trySeal(1), "SealTooEarly"); // period 1 starts exactly period + SEAL_LEAD away
    await sealAt(book, deadline0, 0); // same second: period 0 still can
    await at(deadline0 + 1n);
    await expectRevert(trySeal(0), "SealTooLate");
    await sealAt(book, deadline0 + 1n, 1);
  });

  test("opened exactly SEAL_LEAD before a boundary, period 0 is one period after it and opens a second later", async () => {
    const boundary = ((await latest()) / PERIOD + 2n) * PERIOD;
    const book = await setup({ openAt: boundary - SEAL_LEAD });
    assert.equal(book.start, boundary + PERIOD);
    await sealAt(book, boundary - SEAL_LEAD + 1n, 0);
  });

  test("once per period, and never an empty hash", async () => {
    const book = await setup();
    const t = book.start - 1000n;
    const c = await sealAt(book, t, 0);
    await at(t + 1n);
    await expectRevert(
      agentKey.writeContract({
        address: book.callbook,
        abi: CALLBOOK.abi,
        functionName: "seal",
        args: [book.bookId, 0n, salt("other")],
        account: agentKey.account,
        chain: localChain,
      }),
      "AlreadySealed",
    );
    await expectRevert(
      agentKey.writeContract({
        address: book.callbook,
        abi: CALLBOOK.abi,
        functionName: "seal",
        args: [book.bookId, 1n, `0x${"00".repeat(32)}`],
        account: agentKey.account,
        chain: localChain,
      }),
      "EmptyCall",
    );
    const s = await read(book.callbook, "sealOf", [book.bookId, 0n]);
    assert.equal(s.callHash, callHash(c));
    assert.equal(s.sealedAt, t);
    assert.equal(s.revealed, false);

    const [ev] = eventsOf(c.receipt, book.callbook);
    assert.equal(ev.eventName, "Sealed");
    assert.deepEqual(ev.args, { bookId: book.bookId, p: 0n, callHash: callHash(c) });
  });

  test("an unknown book is refused", async () => {
    const book = await setup();
    await expectRevert(
      agentKey.writeContract({
        address: book.callbook,
        abi: CALLBOOK.abi,
        functionName: "seal",
        args: [99n, 0n, salt(0)],
        account: agentKey.account,
        chain: localChain,
      }),
      "UnknownBook",
    );
    await expectRevert(read(book.callbook, "startOf", [0n, 0n]), "UnknownBook");
  });
});

// ---------------------------------------------------------------------------
// Revealing
// ---------------------------------------------------------------------------

describe("reveal", () => {
  const tryReveal = (book, args, wallet = stranger) =>
    wallet.writeContract({
      address: book.callbook,
      abi: CALLBOOK.abi,
      functionName: "reveal",
      args,
      account: wallet.account,
      chain: localChain,
    });

  test("only once the horizon has passed, and then by anyone with the preimage", async () => {
    const book = await setup();
    const c = await sealAt(book, book.start - 600n, 0, { coinIndex: 2, side: SHORT });
    const exitAt = book.start + HORIZON;

    await at(exitAt - 1n);
    await expectRevert(tryReveal(book, revealArgs(c)), "RevealTooEarly");

    await at(exitAt);
    const receipt = await send(stranger, book.callbook, CALLBOOK.abi, "reveal", revealArgs(c));
    gasUsed.reveal = receipt.gasUsed;

    const [ev] = eventsOf(receipt, book.callbook);
    assert.equal(ev.eventName, "Revealed");
    assert.deepEqual(ev.args, { bookId: book.bookId, p: 0n, coinIndex: 2, side: SHORT });

    const s = await read(book.callbook, "sealOf", [book.bookId, 0n]);
    assert.equal(s.revealed, true);
    assert.equal(s.coinIndex, 2);
    assert.equal(s.side, SHORT);

    await at(exitAt + 1n);
    await expectRevert(tryReveal(book, revealArgs(c), owner), "AlreadyRevealed");
  });

  test("anything but the exact preimage is refused", async () => {
    const book = await setup();
    const c = await sealAt(book, book.start - 600n, 0, { coinIndex: 1, side: LONG });
    await at(book.start + HORIZON + 100n);

    await expectRevert(tryReveal(book, [c.bookId, 0n, 1, LONG, salt("wrong")]), "WrongPreimage");
    await expectRevert(tryReveal(book, [c.bookId, 0n, 0, LONG, c.salt]), "WrongPreimage"); // other coin
    await expectRevert(tryReveal(book, [c.bookId, 0n, 1, SHORT, c.salt]), "WrongPreimage"); // other side
    await expectRevert(tryReveal(book, [c.bookId, 0n, 1, FLAT, c.salt]), "WrongPreimage");
    await expectRevert(tryReveal(book, [c.bookId, 0n, 3, LONG, c.salt]), "BadCoinIndex");
    await expectRevert(tryReveal(book, [c.bookId, 0n, 1, 2, c.salt]), "BadSide");
    await expectRevert(tryReveal(book, [c.bookId, 1n, 1, LONG, c.salt]), "NotSealed");
    await send(stranger, book.callbook, CALLBOOK.abi, "reveal", revealArgs(c));
  });

  test("a call sealed with an out-of-range coin or side can never be revealed", async () => {
    const book = await setup();
    const badCoin = await sealAt(book, book.start - 600n, 0, { coinIndex: 3, side: LONG });
    const badSide = await sealAt(book, book.startOf(1) - 600n, 1, { coinIndex: 0, side: 2 });
    await at(book.startOf(1) + HORIZON);
    await expectRevert(tryReveal(book, revealArgs(badCoin)), "BadCoinIndex");
    await expectRevert(tryReveal(book, revealArgs(badSide)), "BadSide");
  });

  test("the grace window closes GRACE after the horizon, to the second", async () => {
    const book = await setup();
    const c0 = await sealAt(book, book.start - 600n, 0);
    const c1 = await sealAt(book, book.startOf(1) - 600n, 1);

    await at(book.start + HORIZON + GRACE); // last second for period 0
    await send(stranger, book.callbook, CALLBOOK.abi, "reveal", revealArgs(c0));

    await at(book.startOf(1) + HORIZON + GRACE + 1n); // one second late for period 1
    await expectRevert(tryReveal(book, revealArgs(c1)), "RevealExpired");
    assert.equal((await read(book.callbook, "sealOf", [book.bookId, 1n])).revealed, false);
  });
});

// ---------------------------------------------------------------------------
// Close and caller rotation
// ---------------------------------------------------------------------------

describe("close and setCaller", () => {
  test("close stops new seals but leaves pending reveals open", async () => {
    const book = await setup();
    const c0 = await sealAt(book, book.start - 600n, 0);

    await at(book.start - 500n);
    await expectRevert(
      stranger.writeContract({ address: book.callbook, abi: CALLBOOK.abi, functionName: "close", args: [book.bookId], account: stranger.account, chain: localChain }),
      "NotBookOwner",
    );
    const receipt = await send(owner, book.callbook, CALLBOOK.abi, "close", [book.bookId]);
    assert.deepEqual(eventsOf(receipt, book.callbook)[0], { eventName: "Closed", args: { bookId: book.bookId } });
    assert.equal((await read(book.callbook, "books", [book.bookId]))[4], book.start - 500n);

    const sealAgain = (wallet) =>
      wallet.writeContract({
        address: book.callbook,
        abi: CALLBOOK.abi,
        functionName: "seal",
        args: [book.bookId, 1n, salt(1)],
        account: wallet.account,
        chain: localChain,
      });
    await at(book.startOf(1) - 600n);
    await expectRevert(sealAgain(agentKey), "BookClosed");
    await expectRevert(sealAgain(owner), "BookClosed");
    await expectRevert(
      owner.writeContract({ address: book.callbook, abi: CALLBOOK.abi, functionName: "close", args: [book.bookId], account: owner.account, chain: localChain }),
      "BookClosed",
    );
    await expectRevert(
      owner.writeContract({ address: book.callbook, abi: CALLBOOK.abi, functionName: "setCaller", args: [book.bookId, STRANGER], account: owner.account, chain: localChain }),
      "BookClosed",
    );

    await at(book.start + HORIZON);
    await send(stranger, book.callbook, CALLBOOK.abi, "reveal", revealArgs(c0));
  });

  test("the owner rotates the caller; the old key loses the right to seal", async () => {
    const book = await setup();
    const trySeal = (wallet, p) =>
      wallet.writeContract({
        address: book.callbook,
        abi: CALLBOOK.abi,
        functionName: "seal",
        args: [book.bookId, BigInt(p), salt(p)],
        account: wallet.account,
        chain: localChain,
      });

    await at(book.start - 1000n);
    await expectRevert(
      agentKey.writeContract({ address: book.callbook, abi: CALLBOOK.abi, functionName: "setCaller", args: [book.bookId, AGENT_KEY], account: agentKey.account, chain: localChain }),
      "NotBookOwner",
    );
    const receipt = await send(owner, book.callbook, CALLBOOK.abi, "setCaller", [book.bookId, VALIDATOR]);
    assert.deepEqual(eventsOf(receipt, book.callbook)[0], { eventName: "CallerSet", args: { bookId: book.bookId, caller: VALIDATOR } });
    assert.equal((await read(book.callbook, "books", [book.bookId]))[5], VALIDATOR);

    await at(book.start - 999n);
    await expectRevert(trySeal(agentKey, 0), "NotCaller");
    await sealAt(book, book.start - 998n, 0, { wallet: validator });

    // Clearing the caller leaves only the owner.
    await at(book.start - 997n);
    await send(owner, book.callbook, CALLBOOK.abi, "setCaller", [book.bookId, ZERO]);
    await at(book.startOf(1) - 1000n);
    await expectRevert(trySeal(validator, 1), "NotCaller");
    await sealAt(book, book.startOf(1) - 999n, 1, { wallet: owner });
  });
});

// ---------------------------------------------------------------------------
// The hash binds contract, chain, book and period
// ---------------------------------------------------------------------------

describe("hash binding", () => {
  test("the contract's callHashOf matches an independent computation, negative sides included", async () => {
    const book = await setup();
    for (const side of [SHORT, FLAT, LONG]) {
      const c = { callbook: book.callbook, bookId: book.bookId, p: 7, coinIndex: 2, side, salt: salt(side) };
      const onchain = await read(book.callbook, "callHashOf", [c.callbook, BigInt(localChain.id), c.bookId, 7n, 2, side, c.salt]);
      assert.equal(onchain, callHash(c));
    }
  });

  test("a hash made for another book, period, contract or chain doesn't verify", async () => {
    const book = await setup();
    const other = await deploy("Callbook", [identity]);
    const base = { callbook: book.callbook, bookId: book.bookId, coinIndex: 0, side: LONG, salt: salt("bind") };
    // Period i gets a hash that differs from the right one for period i in
    // exactly one field.
    const variants = [
      (p) => ({ ...base, p, bookId: book.bookId + 1n }),
      (p) => ({ ...base, p: p + 1 }),
      (p) => ({ ...base, p, callbook: other }),
      (p) => ({ ...base, p, chainId: 1 }),
    ];

    // Seal each foreign hash into its own period of this book, then try to
    // reveal it here with the same coin, side and salt.
    for (let i = 0; i < variants.length; i++) {
      await at(book.startOf(i) - 600n);
      await send(agentKey, book.callbook, CALLBOOK.abi, "seal", [book.bookId, BigInt(i), callHash(variants[i](i))]);
    }
    await at(book.startOf(variants.length) + HORIZON);
    for (let i = 0; i < variants.length; i++) {
      await expectRevert(
        stranger.writeContract({
          address: book.callbook,
          abi: CALLBOOK.abi,
          functionName: "reveal",
          args: [book.bookId, BigInt(i), 0, LONG, base.salt],
          account: stranger.account,
          chain: localChain,
        }),
        "WrongPreimage",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

describe("views", () => {
  test("startOf, currentPeriod and sealablePeriod follow the clock", async () => {
    const book = await setup({ period: HOUR, horizon: 4n * HOUR });
    assert.equal(await read(book.callbook, "startOf", [book.bookId, 5n]), book.start + 5n * HOUR);
    await expectRevert(read(book.callbook, "currentPeriod", [book.bookId]), "NotStarted");
    assert.equal(await read(book.callbook, "sealablePeriod", [book.bookId]), 0n);

    await mineAt(book.start + 2n * HOUR + 5n);
    assert.equal(await read(book.callbook, "currentPeriod", [book.bookId]), 2n);
    assert.equal(await read(book.callbook, "sealablePeriod", [book.bookId]), 3n);

    await mineAt(book.startOf(4) - SEAL_LEAD); // the last second period 4 can be sealed
    assert.equal(await read(book.callbook, "sealablePeriod", [book.bookId]), 4n);
    await mineAt(book.startOf(4) - SEAL_LEAD + 1n);
    assert.equal(await read(book.callbook, "sealablePeriod", [book.bookId]), 5n);
    await sealAt(book, book.startOf(4) - SEAL_LEAD + 2n, 5);
  });

  test("booksOf lists every book an address opened", async () => {
    const callbook = await deploy("Callbook", [identity]);
    for (let i = 0; i < 3; i++) {
      await send(i === 1 ? stranger : owner, callbook, CALLBOOK.abi, "open", [NO_AGENT, AGENT_KEY, STRATEGY, COINS, Number(PERIOD), Number(HORIZON)]);
    }
    assert.deepEqual(await read(callbook, "booksOf", [OWNER]), [1n, 3n]);
    assert.deepEqual(await read(callbook, "booksOf", [STRANGER]), [2n]);
    assert.equal(await read(callbook, "bookCount"), 3n);
  });
});

// ---------------------------------------------------------------------------
// Open-call (free) books: lock whenever you like, reveal after your horizon
// ---------------------------------------------------------------------------

const LOCKED_TAG = keccak256(toHex("callbook.locked"));
const META = keccak256(toHex("hot-list thesis v1"));

/** The locked-call hash, computed independently of the contract. */
function lockedHash({ callbook, chainId = localChain.id, bookId, callId, coinIndex, side, horizon, salt: s }) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint64" },
        { type: "uint8" },
        { type: "int8" },
        { type: "uint32" },
        { type: "bytes32" },
      ],
      [LOCKED_TAG, callbook, BigInt(chainId), BigInt(bookId), BigInt(callId), coinIndex, side, Number(horizon), s],
    ),
  );
}

const openFreeArgs = ({ agentId = NO_AGENT, caller = AGENT_KEY, coins = COINS, minH = 5n * MIN, maxH = DAY } = {}) => [
  agentId,
  caller,
  META,
  coins,
  Number(minH),
  Number(maxH),
];

/** A fresh Arena with one free book. */
async function setupFree(opts = {}) {
  const callbook = await deploy("Callbook", [opts.registry ?? identity]);
  const receipt = await send(owner, callbook, CALLBOOK.abi, "openFree", openFreeArgs(opts));
  const bookId = eventsOf(receipt, callbook)[0].args.bookId;
  return { callbook, bookId, receipt };
}

/**
 * Lock a call at time `t`, naming the call id the hash is made for. `hashHorizon`
 * lets a test put a different horizon in the hash than the public one.
 */
async function lockAt(book, t, { coinIndex = 0, side = LONG, horizon = 2n * HOUR, hashHorizon, s, wallet = agentKey } = {}) {
  const callId = await read(book.callbook, "lockCount", [book.bookId]);
  const call = { callbook: book.callbook, bookId: book.bookId, callId, coinIndex, side, horizon, salt: s ?? salt(`lock-${callId}`) };
  await at(t);
  const hash = lockedHash({ ...call, horizon: hashHorizon ?? horizon });
  const receipt = await send(wallet, book.callbook, CALLBOOK.abi, "lock", [book.bookId, hash, Number(horizon), callId]);
  const [ev] = eventsOf(receipt, book.callbook);
  return { ...call, callHash: hash, entryAt: ev.args.entryAt, receipt };
}

const revealLockedArgs = (c) => [c.bookId, c.callId, c.coinIndex, c.side, c.salt];

const tx = (wallet, address, functionName, args) =>
  wallet.writeContract({ address, abi: CALLBOOK.abi, functionName, args, account: wallet.account, chain: localChain });

describe("open-call books", () => {
  test("openFree stores a free book, announces it with OpenedFree only, and reports its bounds", async () => {
    const book = await setupFree({ minH: 15n * MIN, maxH: 3n * DAY });
    gasUsed.openFree = book.receipt.gasUsed;
    const [bOwner, period, horizon, coinCount, closedAt, caller, start, agentId, metaHash, coinsHash] = await read(book.callbook, "books", [book.bookId]);
    assert.equal(bOwner, OWNER);
    assert.equal(period, 0);
    assert.equal(BigInt(horizon), 3n * DAY);
    assert.equal(coinCount, COINS.length);
    assert.equal(closedAt, 0n);
    assert.equal(caller, AGENT_KEY);
    assert.equal(start, 0n);
    assert.equal(agentId, NO_AGENT);
    assert.equal(metaHash, META);
    assert.equal(coinsHash, keccak256(encodeAbiParameters([{ type: "string[]" }], [COINS])));

    const events = eventsOf(book.receipt, book.callbook);
    assert.deepEqual(events.map((e) => e.eventName), ["OpenedFree"]);
    assert.deepEqual(events[0].args, {
      bookId: book.bookId,
      owner: OWNER,
      agentId: NO_AGENT,
      caller: AGENT_KEY,
      metaHash: META,
      coins: COINS,
      minHorizon: Number(15n * MIN),
      maxHorizon: Number(3n * DAY),
    });

    assert.equal(await read(book.callbook, "isFree", [book.bookId]), true);
    assert.deepEqual(await read(book.callbook, "horizonBounds", [book.bookId]), [Number(15n * MIN), Number(3n * DAY)]);
    assert.equal(await read(book.callbook, "lockCount", [book.bookId]), 0n);
    assert.deepEqual(await read(book.callbook, "booksOf", [OWNER]), [book.bookId]);

    // A scheduled book in the same contract says the opposite.
    const r = await send(owner, book.callbook, CALLBOOK.abi, "open", [NO_AGENT, AGENT_KEY, STRATEGY, COINS, Number(PERIOD), Number(HORIZON)]);
    const scheduled = eventsOf(r, book.callbook)[0].args.bookId;
    assert.equal(await read(book.callbook, "isFree", [scheduled]), false);
    assert.deepEqual(await read(book.callbook, "horizonBounds", [scheduled]), [Number(HORIZON), Number(HORIZON)]);
    await expectRevert(read(book.callbook, "isFree", [99n]), "UnknownBook");
  });

  test("links an agent only for its owner", async () => {
    await send(deployer, identity, IDENTITY.abi, "mint", [OWNER, 201n]);
    await send(deployer, identity, IDENTITY.abi, "mint", [STRANGER, 202n]);
    const book = await setupFree({ agentId: 201n });
    assert.equal(eventsOf(book.receipt, book.callbook)[0].args.agentId, 201n);
    assert.deepEqual(await read(book.callbook, "booksOfAgent", [201n]), [book.bookId]);
    await expectRevert(tx(owner, book.callbook, "openFree", openFreeArgs({ agentId: 202n })), "NotAgentOwner");
    await expectRevert(tx(owner, book.callbook, "openFree", openFreeArgs({ agentId: 999_998n })), "UnknownAgent");
  });

  test("horizon bounds: whole minutes, 5 minutes <= min <= max <= 30 days; coins as for open", async () => {
    const callbook = await deploy("Callbook", [identity]);
    const bad = (opts) => tx(owner, callbook, "openFree", openFreeArgs(opts));
    await expectRevert(bad({ minH: 4n * MIN }), "BadHorizon");
    await expectRevert(bad({ minH: 5n * MIN + 1n }), "BadHorizon");
    await expectRevert(bad({ minH: HOUR, maxH: HOUR - MIN }), "BadHorizon");
    await expectRevert(bad({ maxH: 30n * DAY + MIN }), "BadHorizon");
    await expectRevert(bad({ maxH: DAY + 30n }), "BadHorizon");
    await expectRevert(bad({ minH: 0n, maxH: 0n }), "BadHorizon");
    await expectRevert(bad({ coins: [] }), "BadCoins");
    await expectRevert(bad({ coins: ["A".repeat(17)] }), "BadCoins");

    await send(owner, callbook, CALLBOOK.abi, "openFree", openFreeArgs({ minH: 5n * MIN, maxH: 5n * MIN }));
    await send(owner, callbook, CALLBOOK.abi, "openFree", openFreeArgs({ minH: 5n * MIN, maxH: 30n * DAY }));
    assert.equal(await read(callbook, "bookCount"), 2n);
  });

  test("lock: caller or owner only, ids count from 0, entry is the first whole minute >= 60s away, horizon public", async () => {
    const book = await setupFree();
    const minute = ((await latest()) / MIN + 2n) * MIN; // a whole minute, in the future

    await at(minute);
    await expectRevert(tx(stranger, book.callbook, "lock", [book.bookId, salt("x"), Number(HOUR), 0n]), "NotCaller");
    await expectRevert(tx(agentKey, book.callbook, "lock", [book.bookId, `0x${"00".repeat(32)}`, Number(HOUR), 0n]), "EmptyCall");

    const c0 = await lockAt(book, minute, { wallet: agentKey });
    gasUsed.lock = c0.receipt.gasUsed;
    const c1 = await lockAt(book, minute + 1n, { wallet: owner, horizon: 90n * MIN });
    const c2 = await lockAt(book, minute + 59n);
    assert.deepEqual([c0.callId, c1.callId, c2.callId], [0n, 1n, 2n]);
    assert.equal(c0.entryAt, minute + 60n); // exactly SEAL_LEAD away, already whole
    assert.equal(c1.entryAt, minute + 120n); // 61s away rounds up to the next minute
    assert.equal(c2.entryAt, minute + 120n); // 60s away, exactly on it
    assert.equal(await read(book.callbook, "lockCount", [book.bookId]), 3n);

    const [ev] = eventsOf(c1.receipt, book.callbook);
    assert.deepEqual(ev, {
      eventName: "Locked",
      args: { bookId: book.bookId, callId: 1n, callHash: lockedHash(c1), entryAt: minute + 120n, horizon: Number(90n * MIN) },
    });
    const l = await read(book.callbook, "lockedOf", [book.bookId, 1n]);
    assert.equal(l.callHash, lockedHash(c1));
    assert.equal(l.lockedAt, minute + 1n);
    assert.equal(l.entryAt, minute + 120n);
    assert.equal(BigInt(l.horizon), 90n * MIN); // known from the lock, before any reveal
    assert.equal(l.revealed, false);
  });

  test("the horizon is checked when the call is locked, not when it is revealed", async () => {
    const book = await setupFree({ minH: 30n * MIN, maxH: 6n * HOUR });
    const lockWith = (h) => tx(agentKey, book.callbook, "lock", [book.bookId, salt(`h${h}`), Number(h), 0n]);
    await at((await latest()) + 10n);
    await expectRevert(lockWith(29n * MIN), "BadHorizon"); // under the book's minimum
    await expectRevert(lockWith(6n * HOUR + MIN), "BadHorizon"); // over its maximum
    await expectRevert(lockWith(2n * HOUR + 1n), "BadHorizon"); // not whole minutes
    await expectRevert(lockWith(0n), "BadHorizon");
    assert.equal(await read(book.callbook, "lockCount", [book.bookId]), 0n);

    const t = (await latest()) + 10n;
    await lockAt(book, t, { horizon: 30n * MIN });
    await lockAt(book, t + 1n, { horizon: 6n * HOUR });
  });

  test("a lock made for an id someone else just took reverts StaleId, instead of recording a dead call", async () => {
    const book = await setupFree();
    // Owner and caller both read lockCount = 0 and hash for call 0.
    const mine = { callbook: book.callbook, bookId: book.bookId, callId: 0n, coinIndex: 0, side: LONG, horizon: HOUR, salt: salt("owner") };
    const theirs = { ...mine, coinIndex: 1, salt: salt("caller") };
    const t = (await latest()) + 10n;
    await at(t);
    await send(owner, book.callbook, CALLBOOK.abi, "lock", [book.bookId, lockedHash(mine), Number(HOUR), 0n]);
    await at(t + 1n);
    const err = await expectRevert(tx(agentKey, book.callbook, "lock", [book.bookId, lockedHash(theirs), Number(HOUR), 0n]), "StaleId");
    assert.match(`${err.shortMessage} ${err.message} ${err.metaMessages?.join(" ")}`, /\(0, 1\)/); // expected 0, actual 1
    await expectRevert(tx(agentKey, book.callbook, "lock", [book.bookId, lockedHash(theirs), Number(HOUR), 5n]), "StaleId");
    assert.equal(await read(book.callbook, "lockCount", [book.bookId]), 1n);

    // Retried for the id that is actually next, it goes through and reveals.
    const retry = { ...theirs, callId: 1n };
    await at(t + 2n);
    await send(agentKey, book.callbook, CALLBOOK.abi, "lock", [book.bookId, lockedHash(retry), Number(HOUR), 1n]);
    const entryAt = (await read(book.callbook, "lockedOf", [book.bookId, 1n])).entryAt;
    await at(entryAt + HOUR);
    await send(stranger, book.callbook, CALLBOOK.abi, "revealLocked", revealLockedArgs(retry));
  });

  test("reveal: only after entry plus the locked horizon, by anyone, once, and within GRACE", async () => {
    const book = await setupFree();
    const t = (await latest()) + 100n;
    const c0 = await lockAt(book, t, { coinIndex: 2, side: SHORT, horizon: 90n * MIN });
    const c1 = await lockAt(book, t + 1n, { horizon: 90n * MIN });
    const exit0 = c0.entryAt + 90n * MIN;

    await at(exit0 - 1n);
    await expectRevert(tx(stranger, book.callbook, "revealLocked", revealLockedArgs(c0)), "RevealTooEarly");
    await at(exit0);
    const receipt = await send(stranger, book.callbook, CALLBOOK.abi, "revealLocked", revealLockedArgs(c0));
    gasUsed.revealLocked = receipt.gasUsed;
    assert.deepEqual(eventsOf(receipt, book.callbook)[0], {
      eventName: "RevealedLocked",
      args: { bookId: book.bookId, callId: 0n, coinIndex: 2, side: SHORT, horizon: Number(90n * MIN) },
    });
    const l = await read(book.callbook, "lockedOf", [book.bookId, 0n]);
    assert.equal(l.revealed, true);
    assert.equal(l.coinIndex, 2);
    assert.equal(l.side, SHORT);
    assert.equal(BigInt(l.horizon), 90n * MIN);

    await at(exit0 + 1n);
    await expectRevert(tx(owner, book.callbook, "revealLocked", revealLockedArgs(c0)), "AlreadyRevealed");

    const exit1 = c1.entryAt + 90n * MIN;
    await at(exit1 + GRACE + 1n);
    await expectRevert(tx(stranger, book.callbook, "revealLocked", revealLockedArgs(c1)), "RevealExpired");
  });

  test("the grace window's last second still counts", async () => {
    const book = await setupFree();
    const c = await lockAt(book, (await latest()) + 100n, { horizon: HOUR });
    await at(c.entryAt + HOUR + GRACE);
    await send(stranger, book.callbook, CALLBOOK.abi, "revealLocked", revealLockedArgs(c));
  });

  test("anything but the exact preimage is refused", async () => {
    const book = await setupFree({ minH: 30n * MIN, maxH: 6n * HOUR });
    const c = await lockAt(book, (await latest()) + 100n, { coinIndex: 1, side: LONG, horizon: 2n * HOUR });
    await at(c.entryAt + 3n * HOUR);
    const reveal = (over) => tx(stranger, book.callbook, "revealLocked", revealLockedArgs({ ...c, ...over }));

    await expectRevert(reveal({ salt: salt("wrong") }), "WrongPreimage");
    await expectRevert(reveal({ coinIndex: 0 }), "WrongPreimage");
    await expectRevert(reveal({ side: SHORT }), "WrongPreimage");
    await expectRevert(reveal({ side: FLAT }), "BadSide"); // open calls are long or short
    await expectRevert(reveal({ side: 2 }), "BadSide");
    await expectRevert(reveal({ coinIndex: 3 }), "BadCoinIndex");
    await expectRevert(reveal({ callId: 1n }), "NotLocked");
    await send(stranger, book.callbook, CALLBOOK.abi, "revealLocked", revealLockedArgs(c));
  });

  test("a hash made for another horizon than the public one can never be revealed", async () => {
    const book = await setupFree({ minH: 30n * MIN, maxH: 6n * HOUR });
    // Public horizon 1h, but the hash says 2h: no reveal at any time matches.
    const c = await lockAt(book, (await latest()) + 100n, { horizon: HOUR, hashHorizon: 2n * HOUR });
    await at(c.entryAt + HOUR);
    await expectRevert(tx(stranger, book.callbook, "revealLocked", revealLockedArgs(c)), "WrongPreimage");
    await at(c.entryAt + 2n * HOUR);
    await expectRevert(tx(stranger, book.callbook, "revealLocked", revealLockedArgs(c)), "WrongPreimage");
  });

  test("a call locked as flat can never be revealed", async () => {
    const book = await setupFree();
    const c = await lockAt(book, (await latest()) + 100n, { side: FLAT, horizon: HOUR });
    await at(c.entryAt + HOUR);
    await expectRevert(tx(stranger, book.callbook, "revealLocked", revealLockedArgs(c)), "BadSide");
  });

  test("close stops new locks but leaves pending reveals open; setCaller rotates the locking key", async () => {
    const book = await setupFree();
    const t = (await latest()) + 100n;
    const c = await lockAt(book, t, { horizon: HOUR });

    await at(t + 1n);
    await send(owner, book.callbook, CALLBOOK.abi, "setCaller", [book.bookId, VALIDATOR]);
    await at(t + 2n);
    await expectRevert(tx(agentKey, book.callbook, "lock", [book.bookId, salt("old key"), Number(HOUR), 1n]), "NotCaller");
    await lockAt(book, t + 3n, { wallet: validator });

    await at(t + 4n);
    await send(owner, book.callbook, CALLBOOK.abi, "close", [book.bookId]);
    await at(t + 5n);
    await expectRevert(tx(validator, book.callbook, "lock", [book.bookId, salt("after close"), Number(HOUR), 2n]), "BookClosed");
    await expectRevert(tx(owner, book.callbook, "lock", [book.bookId, salt("after close"), Number(HOUR), 2n]), "BookClosed");
    assert.equal(await read(book.callbook, "lockCount", [book.bookId]), 2n);

    await at(c.entryAt + HOUR);
    await send(stranger, book.callbook, CALLBOOK.abi, "revealLocked", revealLockedArgs(c));
  });

  test("the two kinds of book never mix", async () => {
    const free = await setupFree();
    const sched = await setup();
    await send(owner, free.callbook, CALLBOOK.abi, "open", [NO_AGENT, AGENT_KEY, STRATEGY, COINS, Number(PERIOD), Number(HORIZON)]);
    const schedId = 2n; // in free.callbook

    await at((await latest()) + 10n);
    await expectRevert(tx(agentKey, free.callbook, "seal", [free.bookId, 0n, salt("s")]), "NotScheduled");
    await expectRevert(tx(stranger, free.callbook, "reveal", [free.bookId, 0n, 0, LONG, salt("s")]), "NotScheduled");
    await expectRevert(tx(agentKey, free.callbook, "lock", [schedId, salt("l"), Number(HOUR), 0n]), "NotFree");
    await expectRevert(tx(agentKey, sched.callbook, "lock", [sched.bookId, salt("l"), Number(HOUR), 0n]), "NotFree");
    await expectRevert(tx(stranger, sched.callbook, "revealLocked", [sched.bookId, 0n, 0, LONG, salt("l")]), "NotFree");
    await expectRevert(read(free.callbook, "startOf", [free.bookId, 0n]), "NotScheduled");
    await expectRevert(read(free.callbook, "currentPeriod", [free.bookId]), "NotScheduled");
    await expectRevert(read(free.callbook, "sealablePeriod", [free.bookId]), "NotScheduled");
  });

  test("hash domains: a scheduled hash can't reveal a locked call, nor the reverse", async () => {
    const free = await setupFree({ minH: HOUR, maxH: HOUR });
    const sched = await setup({ horizon: PERIOD });
    const tag = await read(free.callbook, "LOCKED_TAG");
    assert.equal(tag, LOCKED_TAG);

    // The contract's helper agrees with an independent computation, and the
    // two helpers never agree with each other on the same fields.
    const same = { callbook: free.callbook, bookId: free.bookId, coinIndex: 1, side: SHORT, salt: salt("domain") };
    const onchain = await read(free.callbook, "lockedHashOf", [free.callbook, BigInt(localChain.id), free.bookId, 0n, 1, SHORT, Number(HOUR), same.salt]);
    assert.equal(onchain, lockedHash({ ...same, callId: 0n, horizon: HOUR }));
    assert.notEqual(onchain, callHash({ ...same, p: 0 }));

    const other = await deploy("Callbook", [identity]);

    // A scheduled-style hash locked into a free book.
    const t = (await latest()) + 100n;
    await at(t);
    await send(agentKey, free.callbook, CALLBOOK.abi, "lock", [free.bookId, callHash({ ...same, p: 0 }), Number(HOUR), 0n]);
    // A locked hash bound to another call id, book, contract or chain.
    const variants = [
      { callId: 2n },
      { bookId: free.bookId + 1n },
      { callbook: other },
      { chainId: 1 },
    ];
    for (let i = 0; i < variants.length; i++) {
      await at(t + 1n + BigInt(i));
      await send(agentKey, free.callbook, CALLBOOK.abi, "lock", [
        free.bookId,
        lockedHash({ ...same, callId: BigInt(i + 1), horizon: HOUR, ...variants[i] }),
        Number(HOUR),
        BigInt(i + 1),
      ]);
    }

    // A locked-style hash sealed into a scheduled book.
    const lockedStyle = lockedHash({ callbook: sched.callbook, bookId: sched.bookId, callId: 0n, coinIndex: 1, side: SHORT, horizon: PERIOD, salt: same.salt });
    await at(sched.start - 600n);
    await send(agentKey, sched.callbook, CALLBOOK.abi, "seal", [sched.bookId, 0n, lockedStyle]);

    // Both kinds are revealable at this moment, so only the hash can fail.
    await at(sched.start + PERIOD);
    await expectRevert(tx(stranger, free.callbook, "revealLocked", [free.bookId, 0n, 1, SHORT, same.salt]), "WrongPreimage");
    await expectRevert(tx(stranger, sched.callbook, "reveal", [sched.bookId, 0n, 1, SHORT, same.salt]), "WrongPreimage");
    for (let i = 0; i < variants.length; i++) {
      await expectRevert(tx(stranger, free.callbook, "revealLocked", [free.bookId, BigInt(i + 1), 1, SHORT, same.salt]), "WrongPreimage");
    }
  });

  test("gas for open calls on the local node", (t) => {
    assert.ok(gasUsed.openFree && gasUsed.lock && gasUsed.revealLocked);
    t.diagnostic(`openFree (3 coins) ${gasUsed.openFree} · lock ${gasUsed.lock} · revealLocked ${gasUsed.revealLocked}`);
  });
});

// ---------------------------------------------------------------------------
// Gasless: EIP-712 signatures, submitted and paid for by a relayer
// ---------------------------------------------------------------------------

const user = walletFor(7);
const USER = account(7).address;
const relayer = walletFor(8);
const SYMBOL_TAG = keccak256(toHex("callbook.locked.symbol"));
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const LOCK_TYPES = {
  LockCall: [
    { name: "account", type: "address" },
    { name: "callHash", type: "bytes32" },
    { name: "horizon", type: "uint32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};
const SEAL_TYPES = {
  SealCall: [
    { name: "bookId", type: "uint256" },
    { name: "p", type: "uint64" },
    { name: "callHash", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
};
const domainOf = (callbook) => ({ name: "Arena", version: "1", chainId: localChain.id, verifyingContract: callbook });

/** An any-coin call's hash: it names the account and its nonce, not a book or call id. */
function symbolHash({ callbook, chainId = localChain.id, account: who, nonce, coin, side, horizon, salt: s }) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "uint256" },
        { type: "address" },
        { type: "uint64" },
        { type: "bytes32" },
        { type: "int8" },
        { type: "uint32" },
        { type: "bytes32" },
      ],
      [SYMBOL_TAG, callbook, BigInt(chainId), who, BigInt(nonce), keccak256(toHex(coin)), side, Number(horizon), s],
    ),
  );
}

/** What a frontend does: read the nonce, hash the call, sign LockCall (horizon in plain sight). */
async function signLock(callbook, { signer = user, who = USER, coin = "BTC", side = LONG, horizon = HOUR, s, deadline, domain } = {}) {
  const nonce = await read(callbook, "nonces", [who]);
  const call = { callbook, account: who, nonce, coin, side, horizon, salt: s ?? salt(`sig-${who}-${nonce}`) };
  const callHash = symbolHash(call);
  const dl = deadline ?? (await latest()) + HOUR;
  const signature = await signer.signTypedData({
    account: signer.account,
    domain: domain ?? domainOf(callbook),
    types: LOCK_TYPES,
    primaryType: "LockCall",
    message: { account: who, callHash, horizon: Number(horizon), nonce, deadline: dl },
  });
  return { ...call, callHash, deadline: dl, signature };
}

const lockBySigArgs = (sg, who = USER) => [who, sg.callHash, Number(sg.horizon), sg.deadline, sg.signature];

/** The relayer submits a signed lock; returns the call with its book and call id. */
async function relayLock(callbook, signed, who = USER) {
  const receipt = await send(relayer, callbook, CALLBOOK.abi, "lockBySig", lockBySigArgs(signed, who));
  const locked = eventsOf(receipt, callbook).find((e) => e.eventName === "Locked");
  assert.equal(BigInt(locked.args.horizon), BigInt(signed.horizon));
  return { ...signed, bookId: locked.args.bookId, callId: locked.args.callId, entryAt: locked.args.entryAt, receipt };
}

const revealSymbolArgs = (c) => [c.bookId, c.callId, c.coin, c.side, c.salt];

/** Flip a signature to its high-s twin: same signer for ecrecover, refused by ECDSA. */
function malleate(signature) {
  const r = signature.slice(0, 66);
  const sv = BigInt(`0x${signature.slice(66, 130)}`);
  const v = parseInt(signature.slice(130, 132), 16);
  return `${r}${(SECP256K1_N - sv).toString(16).padStart(64, "0")}${(v === 27 ? 28 : 27).toString(16)}`;
}

describe("gasless (EIP-712)", () => {
  test("the domain is Arena v1 on this chain and contract", async () => {
    const callbook = await deploy("Callbook", [identity]);
    const [, name, version, chainId, verifyingContract] = await read(callbook, "eip712Domain");
    assert.deepEqual([name, version, chainId, verifyingContract.toLowerCase()], ["Arena", "1", BigInt(localChain.id), callbook.toLowerCase()]);
    assert.equal(await read(callbook, "domainSeparator"), domainSeparator({ domain: domainOf(callbook) }));
    assert.equal(
      await read(callbook, "LOCK_TYPEHASH"),
      keccak256(toHex("LockCall(address account,bytes32 callHash,uint32 horizon,uint256 nonce,uint256 deadline)")),
    );
    assert.equal(await read(callbook, "SEAL_TYPEHASH"), keccak256(toHex("SealCall(uint256 bookId,uint64 p,bytes32 callHash,uint256 deadline)")));
  });

  test("the first signed lock opens the account's book; the second reuses it; the user pays nothing", async () => {
    const callbook = await deploy("Callbook", [identity]);
    const userBalance = await publicClient.getBalance({ address: USER });
    assert.equal(await read(callbook, "defaultBookOf", [USER]), 0n);

    const c0 = await relayLock(callbook, await signLock(callbook, { coin: "BTC" }));
    gasUsed.lockBySigFirst = c0.receipt.gasUsed;
    const [opened, locked] = eventsOf(c0.receipt, callbook);
    assert.deepEqual(opened, {
      eventName: "OpenedFree",
      args: {
        bookId: 1n,
        owner: USER,
        agentId: NO_AGENT,
        caller: USER,
        metaHash: `0x${"00".repeat(32)}`,
        coins: [],
        minHorizon: Number(5n * MIN),
        maxHorizon: Number(30n * DAY),
      },
    });
    assert.equal(locked.eventName, "Locked");
    assert.equal(c0.bookId, 1n);
    assert.equal(c0.callId, 0n);
    assert.equal(await read(callbook, "defaultBookOf", [USER]), 1n);
    assert.equal(await read(callbook, "isAnyCoin", [1n]), true);
    assert.equal(await read(callbook, "isFree", [1n]), true);
    assert.deepEqual(await read(callbook, "booksOf", [USER]), [1n]);
    assert.deepEqual(await read(callbook, "booksOf", [account(8).address]), []);
    assert.equal(await read(callbook, "nonces", [USER]), 1n);
    const l0 = await read(callbook, "lockedOf", [1n, 0n]);
    assert.equal(l0.nonce, 0n);
    assert.equal(BigInt(l0.horizon), HOUR);

    const c1 = await relayLock(callbook, await signLock(callbook, { coin: "kPEPE", side: SHORT, horizon: 4n * HOUR }));
    gasUsed.lockBySigLater = c1.receipt.gasUsed;
    assert.deepEqual(eventsOf(c1.receipt, callbook).map((e) => e.eventName), ["Locked"]);
    assert.equal(c1.bookId, 1n);
    assert.equal(c1.callId, 1n);
    assert.equal((await read(callbook, "lockedOf", [1n, 1n])).nonce, 1n);
    assert.equal(await read(callbook, "bookCount"), 1n);

    assert.equal(await publicClient.getBalance({ address: USER }), userBalance);
  });

  test("a signature can't be replayed, used late, re-aimed, or used by anyone but the account", async () => {
    const callbook = await deploy("Callbook", [identity]);
    const signed = await signLock(callbook);
    await relayLock(callbook, signed);
    const submit = (sg, who = USER) => tx(relayer, callbook, "lockBySig", lockBySigArgs(sg, who));

    await expectRevert(submit(signed), "BadSignature"); // the nonce moved on

    const late = await signLock(callbook, { deadline: (await latest()) - 1n });
    await expectRevert(submit(late), "SignatureExpired");

    const forged = await signLock(callbook, { signer: stranger }); // the stranger signs for the user
    await expectRevert(submit(forged), "BadSignature");
    const theirs = await signLock(callbook, { signer: stranger, who: STRANGER }); // ...or for itself, claimed as the user's
    await expectRevert(submit(theirs, USER), "BadSignature");

    const other = await deploy("Callbook", [identity]);
    const elsewhere = await signLock(callbook, { domain: domainOf(other) }); // signed for another contract
    await expectRevert(submit(elsewhere), "BadSignature");
    const wrongChain = await signLock(callbook, { domain: { ...domainOf(callbook), chainId: 1 } });
    await expectRevert(submit(wrongChain), "BadSignature");

    const good = await signLock(callbook);
    await expectRevert(submit({ ...good, signature: malleate(good.signature) }), "BadSignature");
    await expectRevert(submit({ ...good, callHash: salt("swapped") }), "BadSignature"); // a relayer can't change the call
    await expectRevert(submit({ ...good, horizon: 2n * HOUR }), "BadSignature"); // ...or its horizon
    await expectRevert(tx(relayer, callbook, "lockBySig", lockBySigArgs(good, ZERO)), "BadSignature");
    await relayLock(callbook, good);
    assert.equal(await read(callbook, "nonces", [USER]), 2n);

    // A horizon outside 5 minutes..30 days, properly signed, is still refused.
    await expectRevert(submit(await signLock(callbook, { horizon: 4n * MIN })), "BadHorizon");
    await expectRevert(submit(await signLock(callbook, { horizon: 30n * DAY + MIN })), "BadHorizon");
    await expectRevert(submit(await signLock(callbook, { horizon: HOUR + 1n })), "BadHorizon");
  });

  test("a relayer reveals any-coin calls by symbol, on the locked horizon; the preimage binds coin, side and nonce", async () => {
    const callbook = await deploy("Callbook", [identity]);
    const c = await relayLock(callbook, await signLock(callbook, { coin: "ETH", side: SHORT, horizon: 2n * HOUR }));
    const exitAt = c.entryAt + 2n * HOUR;
    const reveal = (over) => tx(relayer, callbook, "revealLockedSymbol", revealSymbolArgs({ ...c, ...over }));

    await at(exitAt - 1n);
    await expectRevert(reveal({}), "RevealTooEarly");
    await at(exitAt + 10n);
    await expectRevert(reveal({ coin: "BTC" }), "WrongPreimage");
    await expectRevert(reveal({ coin: "eth" }), "WrongPreimage"); // symbols are case-sensitive
    await expectRevert(reveal({ side: LONG }), "WrongPreimage");
    await expectRevert(reveal({ salt: salt("nope") }), "WrongPreimage");
    await expectRevert(reveal({ coin: "" }), "BadCoins");
    await expectRevert(reveal({ coin: "X".repeat(17) }), "BadCoins");
    await expectRevert(reveal({ side: FLAT }), "BadSide");
    await expectRevert(tx(relayer, callbook, "revealLocked", [c.bookId, c.callId, 0, SHORT, c.salt]), "WrongCoinMode");

    const receipt = await send(relayer, callbook, CALLBOOK.abi, "revealLockedSymbol", revealSymbolArgs(c));
    gasUsed.revealLockedSymbol = receipt.gasUsed;
    assert.deepEqual(eventsOf(receipt, callbook)[0], {
      eventName: "RevealedLockedSymbol",
      args: { bookId: c.bookId, callId: c.callId, coin: "ETH", side: SHORT, horizon: Number(2n * HOUR) },
    });
    const l = await read(callbook, "lockedOf", [c.bookId, c.callId]);
    assert.equal(l.revealed, true);
    assert.equal(l.side, SHORT);
    assert.equal(BigInt(l.horizon), 2n * HOUR);
    await expectRevert(reveal({}), "AlreadyRevealed");

    // A book with a coin list refuses symbol reveals.
    const indexed = await setupFree();
    await expectRevert(tx(relayer, indexed.callbook, "revealLockedSymbol", [indexed.bookId, 0n, "BTC", LONG, salt(0)]), "WrongCoinMode");
  });

  test("the contract's symbolCallHashOf matches; a direct lock names the nonce and uses it up", async () => {
    const callbook = await deploy("Callbook", [identity]);
    const c0 = await relayLock(callbook, await signLock(callbook, { coin: "SOL", horizon: HOUR }));
    assert.equal(
      await read(callbook, "symbolCallHashOf", [callbook, BigInt(localChain.id), USER, 0n, "SOL", LONG, Number(HOUR), c0.salt]),
      c0.callHash,
    );

    // The user, holding gas after all, locks straight into its own book.
    const nonce = await read(callbook, "nonces", [USER]);
    const direct = { callbook, account: USER, nonce, coin: "BTC", side: LONG, horizon: HOUR, salt: salt("direct") };
    await expectRevert(tx(user, callbook, "lock", [c0.bookId, symbolHash(direct), Number(HOUR), nonce - 1n]), "StaleId");
    await expectRevert(tx(user, callbook, "lock", [c0.bookId, symbolHash(direct), Number(HOUR), nonce + 1n]), "StaleId");
    const receipt = await send(user, callbook, CALLBOOK.abi, "lock", [c0.bookId, symbolHash(direct), Number(HOUR), nonce]);
    const callId = eventsOf(receipt, callbook)[0].args.callId;
    assert.equal(await read(callbook, "nonces", [USER]), nonce + 1n);
    // A signature made against the old nonce is now stale.
    const stale = await signLock(callbook, { s: salt("stale") });
    await send(user, callbook, CALLBOOK.abi, "lock", [c0.bookId, salt("burns a nonce"), Number(HOUR), nonce + 1n]);
    await expectRevert(tx(relayer, callbook, "lockBySig", lockBySigArgs(stale)), "BadSignature");

    const entryAt = (await read(callbook, "lockedOf", [c0.bookId, callId])).entryAt;
    await at(entryAt + HOUR);
    await send(stranger, callbook, CALLBOOK.abi, "revealLockedSymbol", revealSymbolArgs({ ...direct, bookId: c0.bookId, callId }));
  });

  test("once the account closes its book, the next signed lock opens a new one", async () => {
    const callbook = await deploy("Callbook", [identity]);
    const c0 = await relayLock(callbook, await signLock(callbook));
    await send(user, callbook, CALLBOOK.abi, "close", [c0.bookId]);
    const nonce = await read(callbook, "nonces", [USER]);
    await expectRevert(tx(user, callbook, "lock", [c0.bookId, salt("x"), Number(HOUR), nonce]), "BookClosed");

    const c1 = await relayLock(callbook, await signLock(callbook));
    assert.equal(c1.bookId, 2n);
    assert.equal(c1.callId, 0n);
    assert.equal(await read(callbook, "defaultBookOf", [USER]), 2n);
    assert.deepEqual(await read(callbook, "booksOf", [USER]), [1n, 2n]);
  });

  test("sealBySig: the caller or owner signs, anyone submits; strangers, late and replayed signatures are refused", async () => {
    const book = await setup();
    const t = book.openedAt + 10n;
    const signSeal = async (signer, p, { deadline = t + HOUR, domain } = {}) => {
      const call = { callbook: book.callbook, bookId: book.bookId, p, coinIndex: 0, side: LONG, salt: salt(`bysig-${p}`) };
      const hash = callHash(call);
      const signature = await signer.signTypedData({
        account: signer.account,
        domain: domain ?? domainOf(book.callbook),
        types: SEAL_TYPES,
        primaryType: "SealCall",
        message: { bookId: book.bookId, p: BigInt(p), callHash: hash, deadline },
      });
      return { ...call, callHash: hash, deadline, signature };
    };
    const submit = (sg, p = sg.p) => tx(relayer, book.callbook, "sealBySig", [book.bookId, BigInt(p), sg.callHash, sg.deadline, sg.signature]);

    const byStranger = await signSeal(stranger, 0);
    const late = await signSeal(agentKey, 0, { deadline: t - 1n });
    const byCaller = await signSeal(agentKey, 0);
    await at(t);
    await expectRevert(submit(byStranger), "BadSignature");
    await expectRevert(submit(late), "SignatureExpired");
    await expectRevert(submit(byCaller, 1), "BadSignature"); // signed for period 0, not 1
    await expectRevert(submit({ ...byCaller, signature: malleate(byCaller.signature) }), "BadSignature");
    const receipt = await send(relayer, book.callbook, CALLBOOK.abi, "sealBySig", [book.bookId, 0n, byCaller.callHash, byCaller.deadline, byCaller.signature]);
    gasUsed.sealBySig = receipt.gasUsed;
    assert.deepEqual(eventsOf(receipt, book.callbook)[0].args, { bookId: book.bookId, p: 0n, callHash: byCaller.callHash });
    await at(t + 1n);
    await expectRevert(submit(byCaller), "AlreadySealed");

    // Once the caller key is rotated out its signatures stop working; the owner's always do.
    await at(book.startOf(1) - PERIOD);
    await send(owner, book.callbook, CALLBOOK.abi, "setCaller", [book.bookId, VALIDATOR]);
    const oldKey = await signSeal(agentKey, 1, { deadline: book.startOf(1) });
    const byOwner = await signSeal(owner, 1, { deadline: book.startOf(1) });
    await at(book.startOf(1) - PERIOD + 1n);
    await expectRevert(submit(oldKey), "BadSignature");
    await send(relayer, book.callbook, CALLBOOK.abi, "sealBySig", [book.bookId, 1n, byOwner.callHash, byOwner.deadline, byOwner.signature]);

    // Not for free books.
    const free = await setupFree();
    await expectRevert(tx(relayer, free.callbook, "sealBySig", [free.bookId, 0n, salt(1), book.startOf(1), byCaller.signature]), "NotScheduled");
  });

  test("ERC-1271: a contract wallet locks and seals through its owner's signature, checked live", async () => {
    // lockBySig: the wallet is the account; its owner key (the user) signs.
    const callbook = await deploy("Callbook", [identity]);
    const wallet = await deploy("MockERC1271Wallet", [USER]);
    const WALLET = artifact("MockERC1271Wallet");
    const c = await relayLock(callbook, await signLock(callbook, { who: wallet, coin: "BTC", horizon: HOUR }), wallet);
    assert.equal((await read(callbook, "books", [c.bookId]))[0].toLowerCase(), wallet.toLowerCase()); // the wallet owns its book
    assert.equal(await read(callbook, "defaultBookOf", [wallet]), c.bookId);

    // Someone else's key can't sign for the wallet.
    await expectRevert(tx(relayer, callbook, "lockBySig", lockBySigArgs(await signLock(callbook, { who: wallet, signer: stranger }), wallet)), "BadSignature");
    // The wallet's own verdict counts at the moment of use: switched off, its signatures stop working.
    const next = await signLock(callbook, { who: wallet, coin: "ETH" });
    await send(user, wallet, WALLET.abi, "setDisabled", [true]);
    await expectRevert(tx(relayer, callbook, "lockBySig", lockBySigArgs(next, wallet)), "BadSignature");
    await send(user, wallet, WALLET.abi, "setDisabled", [false]);
    await relayLock(callbook, next, wallet);

    // Its call reveals like any other, with the wallet's address in the hash.
    await at(c.entryAt + HOUR);
    await send(relayer, callbook, CALLBOOK.abi, "revealLockedSymbol", revealSymbolArgs(c));

    // sealBySig: a scheduled book whose caller is a contract wallet owned by the agent key.
    const agentWallet = await deploy("MockERC1271Wallet", [AGENT_KEY]);
    const book = await setup({ caller: agentWallet });
    const t = book.openedAt + 10n;
    const call = { callbook: book.callbook, bookId: book.bookId, p: 0, coinIndex: 2, side: SHORT, salt: salt("wallet-seal") };
    const message = { bookId: book.bookId, p: 0n, callHash: callHash(call), deadline: t + HOUR };
    const sign = (signer) => signer.signTypedData({ account: signer.account, domain: domainOf(book.callbook), types: SEAL_TYPES, primaryType: "SealCall", message });
    await at(t);
    await expectRevert(tx(relayer, book.callbook, "sealBySig", [book.bookId, 0n, message.callHash, message.deadline, await sign(stranger)]), "BadSignature");
    await send(relayer, book.callbook, CALLBOOK.abi, "sealBySig", [book.bookId, 0n, message.callHash, message.deadline, await sign(agentKey)]);
    await at(book.start + HORIZON);
    await send(relayer, book.callbook, CALLBOOK.abi, "reveal", revealArgs(call));
  });

  test("gas for signed calls on the local node", (t) => {
    assert.ok(gasUsed.lockBySigFirst && gasUsed.lockBySigLater && gasUsed.sealBySig && gasUsed.revealLockedSymbol);
    t.diagnostic(
      `lockBySig first ${gasUsed.lockBySigFirst} · later ${gasUsed.lockBySigLater} · sealBySig ${gasUsed.sealBySig} · revealLockedSymbol ${gasUsed.revealLockedSymbol}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

const PROFILE_TYPES = {
  SetProfile: [
    { name: "account", type: "address" },
    { name: "bookId", type: "uint256" },
    { name: "name", type: "string" },
    { name: "bio", type: "string" },
    { name: "link", type: "string" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

/** What the MCP does: read the profile nonce and sign SetProfile. */
async function signProfile(callbook, { signer = user, who = USER, bookId = 0n, name = "Midnight", bio = "", link = "", deadline, domain } = {}) {
  const nonce = await read(callbook, "profileNonces", [who]);
  const dl = deadline ?? (await latest()) + HOUR;
  const message = { account: who, bookId, name, bio, link, nonce, deadline: dl };
  const signature = await signer.signTypedData({ account: signer.account, domain: domain ?? domainOf(callbook), types: PROFILE_TYPES, primaryType: "SetProfile", message });
  return { ...message, signature };
}

const profileArgs = (p) => [p.account, p.bookId, p.name, p.bio, p.link, p.deadline, p.signature];
const profileOf = (receipt, callbook) => eventsOf(receipt, callbook).find((e) => e.eventName === "Profile")?.args;

describe("profiles", () => {
  test("the typehash matches what clients sign", async () => {
    const callbook = await deploy("Callbook", [identity]);
    assert.equal(
      await read(callbook, "PROFILE_TYPEHASH"),
      keccak256(toHex("SetProfile(address account,uint256 bookId,string name,string bio,string link,uint256 nonce,uint256 deadline)")),
    );
  });

  test("an account names itself (book 0) directly or through a relayer, and pays nothing when relayed", async () => {
    const callbook = await deploy("Callbook", [identity]);
    const direct = await send(stranger, callbook, CALLBOOK.abi, "setProfile", [0n, "Stranger", "hello", "https://example.com"]);
    assert.deepEqual(profileOf(direct, callbook), { account: STRANGER, bookId: 0n, name: "Stranger", bio: "hello", link: "https://example.com" });

    const balance = await publicClient.getBalance({ address: USER });
    const signed = await signProfile(callbook, { name: "Midnight Momentum", bio: "Breakouts on majors · ✓", link: "https://x.com/m" });
    const receipt = await send(relayer, callbook, CALLBOOK.abi, "setProfileBySig", profileArgs(signed));
    gasUsed.profile = receipt.gasUsed;
    assert.deepEqual(profileOf(receipt, callbook), { account: USER, bookId: 0n, name: "Midnight Momentum", bio: "Breakouts on majors · ✓", link: "https://x.com/m" });
    assert.equal(await read(callbook, "profileNonces", [USER]), 1n);
    assert.equal(await publicClient.getBalance({ address: USER }), balance);

    // An empty name is how a profile is cleared.
    const cleared = await send(relayer, callbook, CALLBOOK.abi, "setProfileBySig", profileArgs(await signProfile(callbook, { name: "" })));
    assert.equal(profileOf(cleared, callbook).name, "");
  });

  test("only a book's owner names it; unknown books are refused; closed books can still be named", async () => {
    const book = await setup();
    const { callbook, bookId } = book;
    await expectRevert(tx(stranger, callbook, "setProfile", [bookId, "Mine now", "", ""]), "NotBookOwner");
    await expectRevert(tx(agentKey, callbook, "setProfile", [bookId, "Caller", "", ""]), "NotBookOwner"); // the caller key isn't the owner
    await expectRevert(tx(owner, callbook, "setProfile", [99n, "Ghost", "", ""]), "UnknownBook");
    const r = await send(owner, callbook, CALLBOOK.abi, "setProfile", [bookId, "Weekend fader", "", ""]);
    assert.deepEqual(profileOf(r, callbook), { account: OWNER, bookId, name: "Weekend fader", bio: "", link: "" });

    // Signed for someone else's book: the signature is fine, the ownership isn't.
    const theirs = await signProfile(callbook, { bookId });
    await expectRevert(tx(relayer, callbook, "setProfileBySig", profileArgs(theirs)), "NotBookOwner");

    await send(owner, callbook, CALLBOOK.abi, "close", [bookId]);
    await send(owner, callbook, CALLBOOK.abi, "setProfile", [bookId, "Retired", "", ""]);
  });

  test("caps are in bytes: 32 for the name, 160 for the bio, 100 for the link", async () => {
    const callbook = await deploy("Callbook", [identity]);
    const ok = ["n".repeat(32), "b".repeat(160), "l".repeat(100)];
    await send(stranger, callbook, CALLBOOK.abi, "setProfile", [0n, ...ok]);
    await expectRevert(tx(stranger, callbook, "setProfile", [0n, "n".repeat(33), "", ""]), "ProfileTooLong");
    await expectRevert(tx(stranger, callbook, "setProfile", [0n, "é".repeat(17), "", ""]), "ProfileTooLong"); // 34 bytes, 17 characters
    await expectRevert(tx(stranger, callbook, "setProfile", [0n, "ok", "b".repeat(161), ""]), "ProfileTooLong");
    await expectRevert(tx(stranger, callbook, "setProfile", [0n, "ok", "", "l".repeat(101)]), "ProfileTooLong");
  });

  test("a signature can't be replayed, used late, re-aimed, altered or used for someone else", async () => {
    const callbook = await deploy("Callbook", [identity]);
    const submit = (p) => tx(relayer, callbook, "setProfileBySig", profileArgs(p));
    const signed = await signProfile(callbook);
    await send(relayer, callbook, CALLBOOK.abi, "setProfileBySig", profileArgs(signed));
    await expectRevert(submit(signed), "BadSignature"); // the nonce moved on

    await expectRevert(submit(await signProfile(callbook, { deadline: (await latest()) - 1n })), "SignatureExpired");
    await expectRevert(submit(await signProfile(callbook, { signer: stranger })), "BadSignature");
    const other = await deploy("Callbook", [identity]);
    await expectRevert(submit(await signProfile(callbook, { domain: domainOf(other) })), "BadSignature");

    const good = await signProfile(callbook, { name: "Real", bio: "b", link: "https://a.b" });
    for (const change of [{ name: "Fake" }, { bio: "x" }, { link: "https://evil.example" }, { bookId: 1n }, { account: STRANGER }]) {
      await expectRevert(submit({ ...good, ...change }), "BadSignature");
    }
    await expectRevert(submit({ ...good, signature: malleate(good.signature) }), "BadSignature");
    await expectRevert(submit({ ...good, account: ZERO }), "BadSignature");
    await submit(good);
  });

  test("profile nonces are separate from lock nonces, so a call signed ahead still lands", async () => {
    const callbook = await deploy("Callbook", [identity]);
    const call = await signLock(callbook); // signed against lock nonce 0
    await send(relayer, callbook, CALLBOOK.abi, "setProfileBySig", profileArgs(await signProfile(callbook)));
    await send(user, callbook, CALLBOOK.abi, "setProfile", [0n, "Again", "", ""]);
    assert.equal(await read(callbook, "profileNonces", [USER]), 2n);
    assert.equal(await read(callbook, "nonces", [USER]), 0n);
    await relayLock(callbook, call);
  });
});

test("gas on the local node", (t) => {
  assert.ok(gasUsed.open && gasUsed.seal && gasUsed.reveal);
  t.diagnostic(`open (3 coins) ${gasUsed.open} · seal ${gasUsed.seal} · reveal ${gasUsed.reveal}`);
});

// ---------------------------------------------------------------------------
// The ERC-8004 mocks behave like the v2.0.0 reference on Arc
// ---------------------------------------------------------------------------

describe("MockValidationRegistry (ERC-8004 v2.0.0 behaviour)", () => {
  test("the agent's owner requests, only the named validator answers, the latest answer stands", async () => {
    const registry = await deploy("MockIdentityRegistry");
    const validation = await deploy("MockValidationRegistry", [registry]);
    const reg = await send(owner, registry, IDENTITY.abi, "register", []);
    const agentId = BigInt(reg.logs[0].topics[3]);
    assert.equal(agentId, 0n); // the reference numbers agents from 0
    assert.equal(await read(registry, "ownerOf", [agentId], IDENTITY.abi), OWNER);

    const requestHash = keccak256(toHex("score book 1"));
    const request = (wallet, hash = requestHash, who = VALIDATOR) =>
      wallet.writeContract({
        address: validation,
        abi: VALIDATION.abi,
        functionName: "validationRequest",
        args: [who, agentId, "ipfs://request", hash],
        account: wallet.account,
        chain: localChain,
      });
    const respond = (wallet, score, tag = "callbook") =>
      wallet.writeContract({
        address: validation,
        abi: VALIDATION.abi,
        functionName: "validationResponse",
        args: [requestHash, score, "ipfs://report", keccak256(toHex(`report ${score}`)), tag],
        account: wallet.account,
        chain: localChain,
      });

    await expectRevert(request(stranger), "Not authorized");
    await expectRevert(request(owner, requestHash, ZERO), "bad validator");
    await send(owner, validation, VALIDATION.abi, "validationRequest", [VALIDATOR, agentId, "ipfs://request", requestHash]);
    await expectRevert(request(owner), "exists");

    await expectRevert(respond(stranger, 50), "not validator");
    await expectRevert(respond(owner, 50), "not validator");
    await expectRevert(respond(validator, 101), "resp>100");

    const t1 = (await latest()) + 10n;
    await at(t1);
    const r1 = await send(validator, validation, VALIDATION.abi, "validationResponse", [requestHash, 40, "ipfs://a", salt("a"), "callbook"]);
    await at(t1 + 5n);
    const r2 = await send(validator, validation, VALIDATION.abi, "validationResponse", [requestHash, 85, "ipfs://b", salt("b"), "callbook"]);
    assert.equal(eventsOf(r1, validation, VALIDATION.abi)[0].args.response, 40);
    assert.equal(eventsOf(r2, validation, VALIDATION.abi)[0].args.response, 85);

    const [validatorAddress, aId, response, responseHash, tag, lastUpdate] = await read(validation, "getValidationStatus", [requestHash], VALIDATION.abi);
    assert.equal(validatorAddress, VALIDATOR);
    assert.equal(aId, agentId);
    assert.equal(response, 85);
    assert.equal(responseHash, salt("b"));
    assert.equal(tag, "callbook");
    assert.equal(lastUpdate, t1 + 5n); // a timestamp, not a block number

    assert.deepEqual(await read(validation, "getAgentValidations", [agentId], VALIDATION.abi), [requestHash]);
    assert.deepEqual(await read(validation, "getValidatorRequests", [VALIDATOR], VALIDATION.abi), [requestHash]);
    assert.deepEqual(await read(validation, "getSummary", [agentId, [], ""], VALIDATION.abi), [1n, 85]);
    assert.deepEqual(await read(validation, "getSummary", [agentId, [STRANGER], ""], VALIDATION.abi), [0n, 0]);
    assert.deepEqual(await read(validation, "getSummary", [agentId, [], "other"], VALIDATION.abi), [0n, 0]);
    await expectRevert(read(validation, "getValidationStatus", [salt("nope")], VALIDATION.abi), "unknown");

    // An operator the owner approved may request too; an unregistered agent can't.
    await send(owner, registry, IDENTITY.abi, "setApprovalForAll", [OPERATOR, true]);
    await send(operator, validation, VALIDATION.abi, "validationRequest", [VALIDATOR, agentId, "ipfs://r2", salt("r2")]);
    await expectRevert(
      owner.writeContract({
        address: validation,
        abi: [...VALIDATION.abi, ...IDENTITY.abi.filter((e) => e.type === "error")],
        functionName: "validationRequest",
        args: [VALIDATOR, 77n, "ipfs://x", salt("x")],
        account: owner.account,
        chain: localChain,
      }),
      "ERC721NonexistentToken",
    );
  });
});

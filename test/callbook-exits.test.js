// Stop-loss and take-profit (app/verify/callbook-exits.js): prices sealed in a
// salt, the walk along the price path, and finding a reveal's salt in its
// transaction input. No chain or network needed.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parsePrice, encodePrice, decodePrice, sealedPrice, withExits, exitsOf, exitsProblem, exitPath, findSalt, MAX_EXIT_HOLD, EXITS_SINCE, FULL_SCAN_BYTES, GRID_SCAN_BYTES,
} from "../app/verify/callbook-exits.js";
import { deriveLocks } from "../app/verify/callbook-callers.js";

const SALT = `0x${"ab".repeat(32)}`;
const STEP = 300;
const T0 = 1_790_000_100; // not on the 5-minute grid: entry is the next open
const grid = (t) => Math.ceil(t / STEP) * STEP;
/** Candles every 5 minutes from the first open at or after T0: [o, h, l] each. */
const candles = (ohl) => ohl.map(([o, h, l], i) => ({ t: grid(T0) + i * STEP, o, h, l }));

test("prices keep up to 12 significant digits, from BTC to the smallest coins", () => {
  for (const [input, text] of [[82925, "82925"], ["82925.5", "82925.5"], [0.000012345, "0.000012345"], ["1e-9", "0.000000001"],
    ["123456.7890123456", "123456.789012"], [1, "1"], ["0.1", "0.1"], [1500000, "1500000"], ["999999999999.9", "1000000000000"]]) {
    assert.equal(sealedPrice(input), text, String(input));
  }
  assert.deepEqual(parsePrice("82925.50"), { m: 829255n, e: -1 });
  assert.equal(decodePrice(0n), null);
  assert.equal(encodePrice(null), 0n);
  for (const bad of ["0", "-5", "abc", Infinity]) assert.throws(() => encodePrice(bad), String(bad));
  assert.ok(encodePrice("123456789012") < 2n ** 48n, "fits in 6 bytes");
});

test("exits ride in the salt's last 16 bytes; the first 16 stay secret", () => {
  const salt = withExits(SALT, { stop: 80000, target: "90000.5" });
  assert.equal(salt.length, 66);
  assert.equal(salt.slice(0, 34), SALT.slice(0, 34), "secret half unchanged");
  assert.deepEqual(exitsOf(salt), { stop: { value: 80000, text: "80000" }, target: { value: 90000.5, text: "90000.5" } });
  assert.deepEqual(exitsOf(withExits(SALT, { stop: 1.25 })), { stop: { value: 1.25, text: "1.25" }, target: null });
  assert.equal(withExits(SALT, {}), SALT, "no exits: the salt as it was");
  assert.equal(exitsOf(SALT), null, "an ordinary salt has none");
  assert.equal(exitsOf("0x1234"), null);
});

test("levels must sit on the right side of the price and of each other", () => {
  assert.equal(exitsProblem({ side: 1, stop: 80000, target: 90000, price: 85000 }), null);
  assert.equal(exitsProblem({ side: -1, stop: 90000, target: 80000, price: 85000 }), null);
  assert.match(exitsProblem({ side: 1, stop: 86000, price: 85000, coin: "BTC" }), /long's stop must be below/);
  assert.match(exitsProblem({ side: 1, target: 84000, price: 85000 }), /target must be above/);
  assert.match(exitsProblem({ side: -1, stop: 84000, price: 85000 }), /short's stop must be above/);
  assert.match(exitsProblem({ side: 1, stop: 90000, target: 80000 }), /below its target/);
  assert.match(exitsProblem({ side: 1, stop: 80000, horizon: MAX_EXIT_HOLD + 60 }), /at most 7 days/);
  assert.equal(exitsProblem({ side: 1 }), null, "no levels: nothing to check");
});

test("the first level touched closes the call; untouched, it runs to its horizon", () => {
  const rows = candles([[100, 101, 99], [100, 103, 99], [102, 106, 101], [105, 105, 95], [96, 97, 95]]);
  const base = { rows, step: STEP, side: 1, entryAt: T0, exitAt: grid(T0) + 4 * STEP };
  assert.deepEqual(exitPath({ ...base, stop: 97, target: 105 }), { entryT: grid(T0), entry: 100, exitT: grid(T0) + 3 * STEP, exit: 105, reason: "target" });
  assert.deepEqual(exitPath({ ...base, stop: 96 }), { entryT: grid(T0), entry: 100, exitT: grid(T0) + 4 * STEP, exit: 96, reason: "stop" });
  assert.deepEqual(exitPath({ ...base, stop: 90, target: 110 }), { entryT: grid(T0), entry: 100, exitT: grid(T0) + 4 * STEP, exit: 96, reason: "time" });
  // A short: its stop is above, its target below.
  assert.equal(exitPath({ ...base, side: -1, stop: 106, target: 95 }).reason, "stop");
});

test("fills are never flattering: gaps, a candle touching both, a level crossed at entry", () => {
  // The price gaps from 100 to 90, through a stop at 95: it fills at the open, 90.
  const gap = candles([[100, 101, 99], [90, 91, 89], [90, 90, 90]]);
  assert.deepEqual(exitPath({ rows: gap, step: STEP, side: 1, entryAt: T0, exitAt: grid(T0) + 2 * STEP, stop: 95 }),
    { entryT: grid(T0), entry: 100, exitT: grid(T0) + STEP, exit: 90, reason: "stop" });
  // Gapping up through a target at 105 fills at the target, not the higher open.
  const up = candles([[100, 101, 99], [110, 111, 109], [110, 110, 110]]);
  assert.equal(exitPath({ rows: up, step: STEP, side: 1, entryAt: T0, exitAt: grid(T0) + 2 * STEP, target: 105 }).exit, 105);
  // One candle reaching both: the stop.
  const both = candles([[100, 101, 99], [100, 110, 90], [100, 100, 100]]);
  assert.equal(exitPath({ rows: both, step: STEP, side: 1, entryAt: T0, exitAt: grid(T0) + 2 * STEP, stop: 95, target: 105 }).reason, "stop");
  // A long whose stop is above the entry price: closed at entry.
  assert.deepEqual(exitPath({ rows: both, step: STEP, side: 1, entryAt: T0, exitAt: grid(T0) + 2 * STEP, stop: 101 }),
    { entryT: grid(T0), entry: 100, exitT: grid(T0), exit: 100, reason: "stop" });
});

test("a missing candle is a quiet slot; prices that end early leave the call unpriced", () => {
  const holed = candles([[100, 101, 99], [100, 101, 99], [100, 101, 99], [100, 100, 100]]).filter((_, i) => i !== 1);
  assert.equal(exitPath({ rows: holed, step: STEP, side: 1, entryAt: T0, exitAt: grid(T0) + 3 * STEP, stop: 90 }).reason, "time");
  // The open after a quiet slot still catches a gap through the stop.
  const gapAfter = candles([[100, 101, 99], [100, 101, 99], [88, 89, 87], [88, 88, 88]]).filter((_, i) => i !== 1);
  assert.deepEqual(exitPath({ rows: gapAfter, step: STEP, side: 1, entryAt: T0, exitAt: grid(T0) + 3 * STEP, stop: 90 }).exit, 88);
  const short = candles([[100, 101, 99]]);
  assert.equal(exitPath({ rows: short, step: STEP, side: 1, entryAt: T0, exitAt: grid(T0) + 3 * STEP, stop: 90 }), null);
  assert.equal(exitPath({ rows: [], step: STEP, side: 1, entryAt: T0, exitAt: T0 + STEP, stop: 90 }), null);
});

test("a reveal's salt is found in its input only where the call's hash agrees", () => {
  const salt = withExits(SALT, { stop: 80000 });
  const matches = (s) => s === salt;
  // A direct reveal: selector, then words.
  const direct = `0x12345678${"00".repeat(31)}01${"00".repeat(31)}02${salt.slice(2)}`;
  assert.equal(findSalt(direct, matches), salt);
  // Inside a wallet's call, off the word grid, next to a planted look-alike that fails the hash.
  const fake = withExits(SALT, { stop: 1 });
  const wrapped = `0xdeadbeef${"11".repeat(7)}${fake.slice(2)}${"22".repeat(3)}${salt.slice(2)}${"33".repeat(5)}`;
  assert.equal(findSalt(wrapped, matches), salt);
  assert.equal(findSalt(`0x${"00".repeat(100)}`, matches), null);
  assert.equal(findSalt("0x12", matches), null);
});

test("a huge reveal input is searched on the word grid only, so it can't stall the indexer", () => {
  const salt = withExits(SALT, { target: 2 });
  let tries = 0;
  const matches = (s) => { tries++; return s === salt; };
  const junk = "ee".repeat(1_000_000); // a 1 MB wrapper payload
  assert.equal(findSalt(`0xdeadbeef${junk}`, matches), null);
  assert.ok(tries <= 1, `${tries} tries for 1 MB: only where a direct reveal puts the salt`);
  // A direct reveal padded with junk is still read in one try (the salt is its fifth word).
  const word = (n) => n.toString(16).padStart(64, "0");
  const padded = `0x12345678${word(7)}${word(3)}${word(160)}${"ff".repeat(32)}${salt.slice(2)}${junk}`;
  tries = 0;
  assert.equal(findSalt(padded, matches), salt);
  assert.equal(tries, 1);
  // Inside a wallet's call of a few KB, on the grid, it's found too.
  assert.equal(findSalt(`0xdeadbeef${"ee".repeat(32 * 100)}${salt.slice(2)}`, (s) => s === salt), salt);
  assert.ok(FULL_SCAN_BYTES >= 512 && GRID_SCAN_BYTES >= 4096);
});

test("calls locked before exits existed are scored as always; later ones wait for their salt", () => {
  const book = { coins: [], anyCoin: true, maxHorizon: 86_400, locks: new Map() };
  const lock = (callId, lockedAt, salt) => ({ callId, hash: "0x", lockedAt, entryAt: lockedAt + 60, horizon: 3600, reveal: { symbol: "ETH", side: 1, at: lockedAt + 4000, tx: "0x1", ...(salt === "unread" ? {} : { salt }) } });
  const marked = withExits(SALT, { stop: 90 });
  book.locks.set(0, lock(0, EXITS_SINCE - 100_000, marked)); // old, with a look-alike marker: ignored
  book.locks.set(1, lock(1, EXITS_SINCE - 100_000, null)); // old, salt not found: still as before
  book.locks.set(2, lock(2, EXITS_SINCE + 100, "unread"));
  book.locks.set(3, lock(3, EXITS_SINCE + 200, null));
  book.locks.set(4, lock(4, EXITS_SINCE + 300, marked));
  const out = deriveLocks(book, EXITS_SINCE + 10 * 86_400, ["ETH"]);
  assert.deepEqual(out.map((c) => c.status), ["revealed", "revealed", "pending", "unscorable", "revealed"]);
  assert.equal(out[0].exits, undefined);
  assert.equal(out[3].saltUnread, true);
  assert.deepEqual(out[4].exits.stop, { value: 90, text: "90" });
});

test("exits the panel would refuse are dropped from a hand-built salt: the call scores on its time alone", () => {
  const book = { coins: [], anyCoin: true, maxHorizon: 30 * 86_400, locks: new Map() };
  const at = EXITS_SINCE + 100;
  const lock = (callId, horizon, exits) => ({ callId, hash: "0x", lockedAt: at, entryAt: at + 60, horizon, reveal: { symbol: "ETH", side: 1, at: at + horizon + 120, tx: "0x1", salt: withExits(SALT, exits) } });
  book.locks.set(0, lock(0, 3600, { stop: 110, target: 100 })); // a long's stop above its target
  book.locks.set(1, lock(1, 10 * 86_400, { stop: 90 })); // held longer than 7 days
  book.locks.set(2, lock(2, 3600, { stop: 90, target: 110 })); // a valid pair stays
  const out = deriveLocks(book, at + 20 * 86_400, ["ETH"]);
  assert.deepEqual(out.map((c) => c.status), ["revealed", "revealed", "revealed"]);
  assert.equal(out[0].exits, undefined);
  assert.equal(out[1].exits, undefined);
  assert.deepEqual(out[2].exits.target, { value: 110, text: "110" });
});

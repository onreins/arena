/**
 * The crowd: Arena's consensus (Numerai's meta model, without the money) and
 * each caller's edge over it (Numerai's MMC idea), built only from revealed
 * calls, causally (only views locked earlier count). Priced calls are
 * synthetic; nothing here touches the network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { crowdOf, CROWD_RULES, crowdMetricsOut, consensusOut } from "../app/verify/callbook-crowd.js";
import { netOf } from "../app/verify/callbook-callers.js";

const HOUR = 3600, DAY = 86400;
const T0 = 1_790_000_000 - (1_790_000_000 % DAY);
const ASOF = T0 + 30 * DAY;

let nextId = 1;
/** A revealed, priced open call, locked a minute before its entry. */
function call({ coin = "BTC", side, move, day = 0, hour = 1, horizon = 4 * HOUR, revealedAt, horizonMove }) {
  const entryAt = T0 + day * DAY + hour * HOUR;
  const { net, fee } = netOf(side, move);
  return {
    callId: nextId++, status: "revealed", coin, side, lockedAt: entryAt - 60, entryAt, exitAt: entryAt + horizon, horizon, move, ret: net, fee,
    revealedAt: revealedAt ?? entryAt + horizon + 60, ...(horizonMove != null ? { horizonMove } : {}),
  };
}
const caller = (id, periods, extra = {}) => ({ id: String(id), periods, ...extra });
const near = (a, b) => Math.abs(a - b) < 1e-12;

test("a caller who goes with an earlier crowd has no edge over it", () => {
  const crowd = [1, 2, 3].map((id) => caller(id, [call({ side: 1, move: 0.02, hour: 1 })]));
  const copier = caller(9, [call({ side: 1, move: 0.02, hour: 5 })]);
  const m = crowdOf([...crowd, copier], { asOf: ASOF }).byCaller.get("9");
  assert.equal(m.withCrowd, 1);
  assert.equal(m.agreement, 1);
  assert.ok(near(m.edge, 0), `edge ${m.edge}`);
});

test("a caller right where the earlier crowd was wrong has a large edge", () => {
  const crowd = [1, 2, 3].map((id) => caller(id, [call({ side: 1, move: -0.02, hour: 1 })]));
  const niche = caller(9, [call({ side: -1, move: -0.02, hour: 5 })]);
  const { byCaller } = crowdOf([...crowd, niche], { asOf: ASOF });
  const m = byCaller.get("9");
  assert.ok(near(m.edge, netOf(-1, -0.02).net - netOf(1, -0.02).net));
  assert.equal(m.agreement, 0);
  // The crowd locked together, with nobody before them: no crowd to measure them against.
  assert.equal(byCaller.get("1").withCrowd, 0);
});

test("a call locked later can't change an earlier call's edge", () => {
  const crowd = [1, 2].map((id) => caller(id, [call({ side: 1, move: 0.01, hour: 1 })]));
  const victim = caller(5, [call({ side: -1, move: 0.01, hour: 3 })]);
  const before = crowdOf([...crowd, victim], { asOf: ASOF }).byCaller.get("5");
  const attackers = [6, 7, 8].map((id) => caller(id, [call({ side: -1, move: 0.01, hour: 6 })]));
  const after = crowdOf([...crowd, victim, ...attackers], { asOf: ASOF }).byCaller.get("5");
  assert.deepEqual(after, before);
});

test("a caller with nobody before them on that coin and day has no crowd: n/a, not zero", () => {
  const lone = caller(1, [call({ coin: "SOL", side: 1, move: 0.01 })]);
  const other = caller(2, [call({ coin: "ETH", side: 1, move: 0.01 })]);
  const m = crowdOf([lone, other], { asOf: ASOF }).byCaller.get("1");
  assert.deepEqual([m.withCrowd, m.edge, m.edgeT, m.coverage], [0, null, null, 0]);
});

test("only revealed calls count: pending, withheld, unscorable and not-yet-revealed ones never do", () => {
  const visible = [1, 2].map((id) => caller(id, [call({ side: 1, move: 0.01, hour: id })]));
  const late = caller(4, [call({ side: -1, move: 0.01, hour: 0, revealedAt: ASOF + HOUR })]);
  const hidden = caller(3, [
    { callId: 900, status: "pending", entryAt: T0 + HOUR, horizon: 4 * HOUR, hash: "0xabc" },
    { callId: 902, status: "unscorable", symbol: "NOPE", side: -1, entryAt: T0 + HOUR, ret: -0.05 },
  ]);
  const { consensus, byCaller } = crowdOf([...visible, hidden, late], { asOf: ASOF });
  assert.equal(consensus.coins.find((c) => c.coin === "BTC").callers, 2);
  assert.equal(byCaller.get("3").revealed, 0);
  assert.equal(byCaller.get("4").revealed, 0);
  // Caller 2 locked after caller 1 only; the not-yet-revealed short never counted.
  assert.equal(byCaller.get("2").agreement, 1);
});

test("a caller with withheld or unscorable calls doesn't vote, but is still measured", () => {
  const hider = caller(1, [call({ side: -1, move: 0.01, hour: 1 }), { callId: 950, status: "withheld", entryAt: T0, ret: -0.05 }]);
  const later = caller(2, [call({ side: 1, move: 0.01, hour: 3 })]);
  const { byCaller } = crowdOf([hider, later], { asOf: ASOF });
  assert.equal(byCaller.get("1").inCrowd, false);
  assert.equal(byCaller.get("1").withheld, 1);
  assert.equal(byCaller.get("2").withCrowd, 0);
});

test("baseline bots don't vote, and one person's books are one view", () => {
  const baseline = caller(1, [call({ side: 1, move: 0.01, hour: 1 })], { excluded: true });
  const a = caller(2, [call({ side: 1, move: 0.01, hour: 2 })], { voter: "0xABC" });
  const b = caller(3, [call({ side: -1, move: 0.01, hour: 4 })], { voter: "0xabc" });
  const { byCaller } = crowdOf([baseline, a, b], { asOf: ASOF });
  assert.equal(byCaller.get("2").withCrowd, 0); // only the baseline was before it
  assert.equal(byCaller.get("3").withCrowd, 0); // only its own person was before it
  assert.equal(byCaller.get("1").inCrowd, false);
});

test("a split crowd means following it earned nothing, and it isn't counted as agreement", () => {
  const up = caller(1, [call({ side: 1, move: 0.01, hour: 1 })]);
  const down = caller(2, [call({ side: -1, move: 0.01, hour: 1 })]);
  const x = caller(3, [call({ side: 1, move: 0.01, hour: 4 })]);
  const m = crowdOf([up, down, x], { asOf: ASOF }).byCaller.get("3");
  assert.ok(near(m.edge, netOf(1, 0.01).net));
  assert.equal(m.agreement, null);
});

test("a caller's own earlier calls never count as their crowd", () => {
  const busy = caller(1, [call({ side: -1, move: 0.01, hour: 1 }), call({ side: -1, move: 0.01, hour: 2 }), call({ side: 1, move: 0.01, hour: 6 })]);
  const other = caller(2, [call({ side: 1, move: 0.01, hour: 3 })]);
  const m = crowdOf([busy, other], { asOf: ASOF }).byCaller.get("1");
  assert.equal(m.withCrowd, 1); // only the hour-6 call had someone else before it
  assert.equal(m.agreement, 1);
});

test("calls on different UTC days are separate crowds", () => {
  const night = caller(1, [call({ side: 1, move: 0.01, day: 0, hour: 23 })]);
  const morning = caller(2, [call({ side: -1, move: 0.01, day: 1, hour: 0 })]);
  assert.equal(crowdOf([night, morning], { asOf: ASOF }).byCaller.get("2").withCrowd, 0);
});

test("the lean weighs callers equally and agrees with the long share", () => {
  const busy = caller(1, Array.from({ length: 10 }, (_, i) => call({ side: 1, move: 0.01, day: 28, hour: i })));
  const quiet = [2, 3].map((id) => caller(id, [call({ side: -1, move: 0.01, day: 28, hour: 12 + id })]));
  const btc = crowdOf([busy, ...quiet], { asOf: ASOF }).consensus.coins.find((c) => c.coin === "BTC");
  assert.deepEqual([btc.recent.callers, btc.recent.longShare, btc.recent.lean], [3, 1 / 3, "short"]);
  // Callers who mostly lean long count as long, so the label and the share can't disagree.
  const mixed = [1, 2, 3].map((id) => caller(id, [call({ side: 1, move: 0.01, day: 29, hour: 1 }), call({ side: 1, move: 0.01, day: 29, hour: 2 }), call({ side: -1, move: 0.01, day: 29, hour: 3 })]));
  const shorts = [4, 5].map((id) => caller(id, [call({ side: -1, move: 0.01, day: 29, hour: 4 })]));
  const btc2 = crowdOf([...mixed, ...shorts], { asOf: ASOF }).consensus.coins.find((c) => c.coin === "BTC");
  assert.deepEqual([btc2.recent.longShare, btc2.recent.lean], [0.6, "long"]);
});

test("the recent lean only looks at the last days", () => {
  const old = [1, 2].map((id) => caller(id, [call({ side: -1, move: 0.01, day: 0, hour: id }), call({ side: 1, move: 0.01, day: 29, hour: id })]));
  const btc = crowdOf(old, { asOf: ASOF }).consensus.coins.find((c) => c.coin === "BTC");
  assert.equal(btc.recent.lean, "long");
  assert.equal(CROWD_RULES.recentDays, 7);
});

test("the consensus keeps its own record, after costs, once enough voters were in", () => {
  const rules = { ...CROWD_RULES, minCrowd: 2 };
  const day = (d, move) => [1, 2, 3].map((id) => call({ side: 1, move, day: d, hour: id }));
  const [a, b, c] = [0, 1, 2].map((i) => [day(0, 0.03)[i], day(1, -0.01)[i]]);
  const btc = crowdOf([caller(1, a), caller(2, b), caller(3, c)], { asOf: ASOF, rules }).consensus.coins.find((x) => x.coin === "BTC");
  // On each day only the third call had two voters before it.
  assert.equal(btc.record.days, 2);
  assert.equal(btc.record.hitRate, 0.5);
  assert.ok(Math.abs(btc.record.meanReturn - (netOf(1, 0.03).net + netOf(1, -0.01).net) / 2) < 1e-12);
  // With the default minCrowd of 3, two voters before a call isn't a consensus yet.
  assert.equal(crowdOf([caller(1, a), caller(2, b), caller(3, c)], { asOf: ASOF }).consensus.coins[0].record.days, 0);
});

test("a call closed early by a stop is measured against the crowd over its whole horizon", () => {
  const crowd = [1, 2].map((id) => caller(id, [call({ side: 1, move: 0.03, hour: id })]));
  // Stopped out at -1% on a short, while the coin rose 3% over the horizon.
  const stopped = caller(9, [call({ side: -1, move: 0.01, hour: 5, horizonMove: 0.03 })]);
  const m = crowdOf([...crowd, stopped], { asOf: ASOF }).byCaller.get("9");
  assert.ok(near(m.edge, netOf(-1, 0.01).net - netOf(1, 0.03).net));
});

test("the same calls in any order give the same crowd", () => {
  const a = [1, 2, 3].map((id) => caller(id, [call({ side: id === 2 ? -1 : 1, move: 0.015, hour: id }), call({ coin: "ETH", side: -1, move: -0.02, day: 2, hour: id })]));
  const first = crowdOf(a, { asOf: ASOF });
  const second = crowdOf([...a].reverse().map((c) => ({ ...c, periods: [...c.periods].reverse() })), { asOf: ASOF });
  assert.deepEqual(first.consensus, second.consensus);
  assert.deepEqual(Object.fromEntries(first.byCaller), Object.fromEntries(second.byCaller));
});

test("the API shapes round and keep n/a as null", () => {
  assert.deepEqual(crowdMetricsOut({ revealed: 3, withheld: 0, inCrowd: true, withCrowd: 2, coverage: 2 / 3, agreement: null, edge: 0.0123456, edgeT: null }),
    { revealed: 3, withheld: 0, inCrowd: true, withCrowd: 2, coverage: 0.667, agreement: null, edge: 0.01235, edgeT: null });
  assert.equal(crowdMetricsOut(undefined), undefined);
  const out = consensusOut({ rules: CROWD_RULES, coins: [{ coin: "BTC", callers: 3, recent: { callers: 3, longShare: 1 / 3, lean: "short" }, record: { days: 0, hitRate: null, meanReturn: null } }] });
  assert.deepEqual(out.coins[0].recent.longShare, 0.333);
  assert.equal(out.coins[0].record.hitRate, null);
});

test("thousands of calls per caller stay fast", () => {
  const callers = Array.from({ length: 50 }, (_, i) => caller(i + 1, Array.from({ length: 2000 }, (_, k) => call({
    coin: ["BTC", "ETH", "SOL"][k % 3], side: (i + k) % 2 ? 1 : -1, move: ((k % 7) - 3) / 1000, day: k % 20, hour: (i + k) % 24,
  }))));
  const start = process.hrtime.bigint();
  crowdOf(callers, { asOf: ASOF });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(ms < 1500, `took ${ms.toFixed(0)}ms`);
});

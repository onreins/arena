// The skill score (app/verify/callbook-skill.js): right or wrong against a
// baseline, overlapping calls sharing one vote, a cautious range, and levels
// reached by calls rather than days. No chain or network needed.
import { test } from "node:test";
import assert from "node:assert/strict";

import { skillScore, hitOf, overlapWeights, wilson, SKILL_RULES } from "../app/verify/callbook-skill.js";

const MIN = 60, HOUR = 3600;
const T0 = 1_790_000_000;
/** n back-to-back calls of `len` seconds from T0, right when right(i). */
const run = (n, len, right) => Array.from({ length: n }, (_, i) => ({ start: T0 + i * len, end: T0 + (i + 1) * len, hit: right(i) ? 1 : 0 }));

test("a call is right when it beats its baseline in its direction; a tie counts half", () => {
  assert.equal(hitOf(1, 0.02, 0.01), 1);
  assert.equal(hitOf(1, 0.005, 0.01), 0, "up, but less than the market drifted: not a forecast");
  assert.equal(hitOf(-1, -0.02, 0), 1);
  assert.equal(hitOf(-1, 0.01, 0), 0);
  assert.equal(hitOf(1, 0.01, 0.01), 0.5);
});

test("calls that overlap in time share one vote", () => {
  const same = Array.from({ length: 10 }, () => ({ start: T0, end: T0 + 5 * MIN }));
  assert.deepEqual(overlapWeights(same), Array(10).fill(0.1));
  assert.deepEqual(overlapWeights(run(5, 5 * MIN, () => true)), [1, 1, 1, 1, 1], "back to back isn't overlapping");
  // An hour-long call every 5 minutes for a day: about one vote per hour, not 288.
  const chain = Array.from({ length: 288 }, (_, i) => ({ start: T0 + i * 5 * MIN, end: T0 + i * 5 * MIN + HOUR }));
  const votes = overlapWeights(chain).reduce((s, w) => s + w, 0);
  assert.ok(votes > 10 && votes < 30, `${votes} votes`);
});

test("Wilson's 90% range", () => {
  const [lo, hi] = wilson(60, 100);
  assert.ok(Math.abs(lo - 0.518) < 0.002 && Math.abs(hi - 0.677) < 0.002, `${lo} ${hi}`);
  assert.deepEqual(wilson(0, 0), [0, 1]);
});

test("unrated until 150 effective calls over 24 hours; the score is the cautious end of the range", () => {
  const few = skillScore(run(149, 10 * MIN, (i) => i % 5 < 3));
  assert.equal(few.level, "unrated");
  assert.equal(few.score, null, "no score while unrated");
  assert.deepEqual(few.next, { level: "provisional", calls: 150, spanHours: 24 });

  const quick = skillScore(run(200, 5 * MIN, (i) => i % 5 < 3)); // 200 calls but under 17 hours
  assert.equal(quick.level, "unrated", "enough calls, not enough time");

  const s = skillScore(run(200, 10 * MIN, (i) => i % 5 < 3)); // 60% right over 33 hours
  assert.equal(s.level, "provisional");
  assert.equal(s.hitRate, 0.6);
  assert.ok(s.range[0] > 0.5 && s.range[0] < 0.6 && s.range[1] > 0.6);
  assert.equal(s.score, Math.round(100 * (s.range[0] - 0.5) / 0.15), "50% right is 0, 65% is 100, from the cautious end");
  assert.equal(s.score, s.scoreRange[0]);
  assert.ok(s.scoreRange[1] > s.score);
});

test("coin flips score about nothing however many calls", () => {
  const s = skillScore(run(2000, 15 * MIN, (i) => i % 2 === 0));
  assert.equal(s.hitRate, 0.5);
  assert.equal(s.score, 0);
});

test("rated from 600 effective calls over 14 days; established with a 61-day record", () => {
  const long = run(700, 30 * MIN, (i) => i % 10 < 6); // 60% over ~14.6 days
  const rated = skillScore(long);
  assert.equal(rated.level, "rated");
  assert.deepEqual(rated.next, { level: "established", days: 61 });
  assert.ok(rated.score > skillScore(run(200, 10 * MIN, (i) => i % 5 < 3)).score, "more evidence, narrower range, higher cautious score");
  assert.equal(skillScore(long, { recordDays: 61 }).level, "established");
  assert.equal(skillScore(long, { recordDays: 61 }).next, null);
});

test("ten simultaneous calls don't buy a level", () => {
  const burst = Array.from({ length: 1500 }, (_, i) => ({ start: T0 + Math.floor(i / 10) * 20 * MIN, end: T0 + Math.floor(i / 10) * 20 * MIN + 5 * MIN, hit: 1 }));
  const s = skillScore(burst);
  assert.equal(s.calls, 1500);
  assert.equal(s.effective, 150, "1,500 calls in bursts of ten count as 150");
  assert.equal(SKILL_RULES.provisional.calls, 150);
});

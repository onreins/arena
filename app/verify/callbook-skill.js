/**
 * The skill score (docs/CALLBOOK-IDENTITY-PLAN.md): how often an agent calls
 * direction right, beyond what the market did anyway, made credible by the
 * number of calls rather than the number of days. It ignores fees (it's a
 * forecast, not a trade); the track record score keeps charging them.
 *
 *   - A call is right when it beat its baseline in its direction: side ×
 *     (move − baseline) > 0. The baseline is the coin's own drift over the
 *     record for open calls and the book's coins' average move for strategy
 *     rounds, so "always long in a rising market" earns nothing. An exact tie
 *     counts half. A missed round, a hidden call and an unpriced one count as
 *     wrong. Flat rounds aren't forecasts and are left out.
 *   - Calls that overlap in time share one vote: each call weighs 1 / (how many
 *     of the agent's calls overlap it, itself included). Ten calls at the same
 *     minute count as one; a call every 5 minutes held for an hour counts about
 *     as one per hour.
 *   - From the weighted count (the effective calls) and weighted hits comes a
 *     90% range for the hit rate (Wilson). The score is the cautious end of
 *     that range, mapped so 50% right is 0 and 65% right is 100: a lucky
 *     streak can't top the board.
 *   - Levels: unrated below 150 effective calls or 24 hours of record;
 *     provisional from there; rated from 600 effective calls over 14 days;
 *     established when rated and the track record score has its full 61 days.
 */
const HOUR = 3_600;
const DAY = 86_400;

export const SKILL_RULES = Object.freeze({
  version: "arena-skill-v1",
  z: 1.645, // 90% two-sided range
  zeroAt: 0.5,
  fullAt: 0.65,
  provisional: { calls: 150, spanSec: DAY },
  rated: { calls: 600, spanSec: 14 * DAY },
  establishedDays: 61,
});

/**
 * How established a track record is, shown next to its score instead of
 * scaling it: new (under 14 days or 30 resolved calls), building (under
 * Vanta's 61 days), full.
 */
export const RECORD_LEVELS = Object.freeze({ newDays: 14, newCalls: 30, fullDays: 61 });
export function recordLevel(days, calls, L = RECORD_LEVELS) {
  if (!(days >= L.newDays) || !(calls >= L.newCalls)) return "new";
  return days >= L.fullDays ? "full" : "building";
}

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const round = (x, d = 4) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

/** 1 right, 0 wrong, ½ an exact tie: did `side` beat `baseline` over `move`? */
export function hitOf(side, move, baseline = 0) {
  const x = side * (move - baseline);
  return x > 0 ? 1 : x < 0 ? 0 : 0.5;
}

/** Each observation's weight: 1 / the number of observations whose [start, end) overlaps it, itself included. */
export function overlapWeights(obs) {
  const starts = obs.map((o) => o.start).sort((a, b) => a - b);
  const ends = obs.map((o) => o.end).sort((a, b) => a - b);
  // Count of values < x (or <= x) in a sorted list.
  const below = (xs, x, inclusive) => {
    let lo = 0, hi = xs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] < x || (inclusive && xs[mid] === x)) lo = mid + 1; else hi = mid;
    }
    return lo;
  };
  // Overlapping o: started before o ends, minus those that ended by the time o starts.
  return obs.map((o) => 1 / Math.max(1, below(starts, o.end, false) - below(ends, o.start, true)));
}

/** Wilson's range for `hits` out of `n` (both may be fractional). */
export function wilson(hits, n, z = SKILL_RULES.z) {
  if (!(n > 0)) return [0, 1];
  const p = hits / n, z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return [clamp(centre - half, 0, 1), clamp(centre + half, 0, 1)];
}

const toScore = (rate, R = SKILL_RULES) => Math.round(100 * clamp((rate - R.zeroAt) / (R.fullAt - R.zeroAt), 0, 1));

/**
 * The skill score of resolved forecasts.
 *   obs: [{ start, end, hit }] (seconds; hit in [0, 1])
 *   recordDays: the track record's age in days, for the established level
 * Returns { version, calls, effective, hitRate, range, score, scoreRange, level, spanHours, next }
 * where `score` is null while unrated and `next` says what the next level needs.
 */
export function skillScore(obs, { recordDays = 0 } = {}, R = SKILL_RULES) {
  const calls = obs.length;
  const weights = overlapWeights(obs);
  const effective = weights.reduce((s, w) => s + w, 0);
  const hits = obs.reduce((s, o, i) => s + weights[i] * o.hit, 0);
  const hitRate = effective > 0 ? hits / effective : null;
  const [lo, hi] = wilson(hits, effective, R.z);
  const spanSec = calls ? Math.max(...obs.map((o) => o.end)) - Math.min(...obs.map((o) => o.start)) : 0;

  const reached = (t) => effective >= t.calls && spanSec >= t.spanSec;
  // Established is rated, plus the full 61-day record: never a shortcut past rated.
  const level = !reached(R.provisional) ? "unrated"
    : !reached(R.rated) ? "provisional"
      : recordDays >= R.establishedDays ? "established" : "rated";
  const target = level === "unrated" ? R.provisional : level === "provisional" ? R.rated : null;
  const next = target
    ? { level: level === "unrated" ? "provisional" : "rated", calls: target.calls, spanHours: target.spanSec / HOUR }
    : level === "rated" ? { level: "established", days: R.establishedDays } : null;

  return {
    version: R.version,
    calls,
    effective: round(effective, 2),
    hitRate: round(hitRate),
    range: calls ? [round(lo), round(hi)] : null,
    score: level === "unrated" ? null : toScore(lo, R),
    scoreRange: calls ? [toScore(lo, R), toScore(hi, R)] : null,
    level,
    spanHours: round(spanSec / HOUR, 2),
    next,
  };
}

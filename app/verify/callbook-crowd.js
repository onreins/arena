/**
 * The crowd: Arena's consensus, and each caller's edge over it. Numerai's
 * meta model and meta-model contribution, without the money: nobody stakes,
 * nothing is paid. The rules are here; docs/CALLBOOK.md can point to this file.
 *
 *   - Only revealed calls count, once revealed (revealedAt <= asOf). A locked
 *     call stays hidden until its reveal and never feeds the crowd.
 *   - Who votes: each person once (a `voter`: an owner, or the wallet an agent
 *     is linked to), so one person's many books are one view. Baseline and
 *     sample bots don't vote, and nor does a caller with any withheld or
 *     unscorable call: a record that hides calls doesn't get to shape the
 *     crowd. Their own calls are still measured against it.
 *   - Causal: a call is measured only against views locked before it
 *     (lockedAt strictly earlier), on the same coin and UTC day. A call locked
 *     later can never change an earlier call's edge, so the crowd can't be
 *     poisoned with hindsight. A voter's view is the average side of their
 *     calls so far (+1 long, -1 short).
 *   - A call's edge over the crowd: its net return minus what the crowd's side
 *     (everyone else's earlier views, the caller's own left out) earned after
 *     the same costs, on the coin's move over the call's horizon (its whole
 *     horizon even if a stop or target closed it early, so risk management
 *     counts as edge); 0 for a split crowd. No one else before it: no crowd,
 *     and the call isn't counted rather than counted as 0. Going with the
 *     crowd scores about 0; right where it was wrong, high; wrong where it was
 *     right, low.
 *   - The consensus record: whenever at least `minCrowd` voters had a view
 *     before a call, the crowd's side applied to that call's window, after
 *     costs; averaged per caller per day, then per day.
 *   - Lean: per coin over the last `recentDays`, the share of voters leaning
 *     long; the lean is the majority side.
 *
 * Built in one pass over each coin and day (no per-call rescans), so a rebuild
 * stays fast with thousands of calls per caller. Deterministic: calls are
 * ordered by (lockedAt, caller, callId) first.
 *
 * Limits: keys are free, so a few sybil keys control the crowd on a coin with
 * few callers (nothing is at stake, and every number shows how many callers
 * it rests on). Only revealed calls count, so the lean and record lag by each
 * call's horizon and leave out calls not revealed yet.
 */
import { netOf } from "./callbook-callers.js";

const DAY = 86_400;

export const CROWD_RULES = Object.freeze({
  bucketSec: DAY, // a call is measured against the same coin's calls on its UTC day
  recentDays: 7, // the "lean" window
  minCrowd: 3, // voters needed before a call for the consensus to count it, and on a coin for the lean to show
  minOthers: 1, // other voters needed before a call for its edge to count
});

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const signOf = (x) => (x > 1e-12 ? 1 : x < -1e-12 ? -1 : 0);
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** One-sample t statistic against zero; null with under two values, 0 with no spread. */
function tStat(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
  return sd > 1e-12 ? m / (sd / Math.sqrt(xs.length)) : 0;
}

/** A call the crowd can use: revealed by asOf, a known coin, long or short, priced. */
function usable(c, asOf) {
  return c.status === "revealed" && c.coin && (c.side === 1 || c.side === -1)
    && Number.isFinite(c.move) && Number.isFinite(c.ret) && Number.isFinite(c.entryAt)
    && c.revealedAt != null && c.revealedAt <= asOf;
}

/** Running views: voter -> { sum, n }, with the total of views and the number of voters. */
function viewBook() {
  const per = new Map();
  let total = 0;
  return {
    voters: () => per.size,
    viewOf: (voter) => { const v = per.get(voter); return v ? v.sum / v.n : undefined; },
    // The average of everyone's views except `voter`'s, and how many that is.
    without(voter) {
      const own = per.get(voter);
      const k = per.size - (own ? 1 : 0);
      return { k, mean: k ? (total - (own ? own.sum / own.n : 0)) / k : 0 };
    },
    add(voter, side) {
      const v = per.get(voter) ?? { sum: 0, n: 0 };
      if (v.n) total -= v.sum / v.n;
      v.sum += side; v.n += 1;
      total += v.sum / v.n;
      per.set(voter, v);
    },
  };
}

/**
 * callers: [{ id, voter?, excluded?, periods }]: periods as scoreCaller returns
 * them; `voter` the person behind the book (default: its id); `excluded` for
 * baseline and sample bots. Returns { consensus: { rules, coins }, byCaller }.
 */
export function crowdOf(callers, { asOf, rules = CROWD_RULES }) {
  const coins = new Map(); // coin -> Map(day -> calls)
  const stats = new Map(); // caller id -> running metrics
  for (const caller of callers) {
    const id = String(caller.id);
    const withheld = caller.periods.filter((c) => c.status === "withheld" || c.status === "unscorable").length;
    const votes = !caller.excluded && withheld === 0;
    const voter = String(caller.voter ?? id).toLowerCase();
    const s = { revealed: 0, withheld, votes, edges: [], clear: 0, agree: 0 };
    stats.set(id, s);
    for (const c of caller.periods) {
      if (!usable(c, asOf)) continue;
      s.revealed += 1;
      const day = Math.floor(c.entryAt / rules.bucketSec);
      const call = {
        id, voter, votes, coin: c.coin, side: c.side, day, entryAt: c.entryAt, callId: c.callId, ret: c.ret,
        lockedAt: Number.isFinite(c.lockedAt) ? c.lockedAt : c.entryAt,
        // The crowd's side is valued over the call's whole horizon, even if a stop or target closed it early.
        move: Number.isFinite(c.horizonMove) ? c.horizonMove : c.move,
      };
      if (!coins.has(c.coin)) coins.set(c.coin, new Map());
      const days = coins.get(c.coin);
      if (!days.has(day)) days.set(day, []);
      days.get(day).push(call);
    }
  }

  const since = asOf - rules.recentDays * DAY;
  const order = (a, b) => a.lockedAt - b.lockedAt || byText(a.id, b.id) || a.callId - b.callId;
  const coinsOut = [];
  for (const [coin, days] of coins) {
    const allVoters = new Set();
    const recent = viewBook();
    const recordDays = [];
    for (const day of [...days.keys()].sort((a, b) => a - b)) {
      const group = days.get(day).sort(order);
      const book = viewBook();
      const dayRecord = new Map(); // caller id -> consensus returns on their windows
      for (let i = 0; i < group.length;) {
        // Calls locked in the same second see the same crowd: score the batch, then add it.
        let j = i;
        while (j < group.length && group[j].lockedAt === group[i].lockedAt) j++;
        const batch = group.slice(i, j);
        for (const c of batch) {
          const others = book.without(c.voter);
          if (others.k >= rules.minOthers) {
            const side = signOf(others.mean);
            const s = stats.get(c.id);
            s.edges.push(c.ret - (side ? netOf(side, c.move).net : 0));
            if (side) { s.clear += 1; if (c.side === side) s.agree += 1; }
          }
          const everyone = book.without(null);
          const consensus = signOf(everyone.mean);
          if (everyone.k >= rules.minCrowd && consensus) {
            if (!dayRecord.has(c.id)) dayRecord.set(c.id, []);
            dayRecord.get(c.id).push(netOf(consensus, c.move).net);
          }
        }
        for (const c of batch) {
          if (!c.votes) continue;
          book.add(c.voter, c.side);
          allVoters.add(c.voter);
          if (c.entryAt >= since) recent.add(c.voter, c.side);
        }
        i = j;
      }
      if (dayRecord.size) recordDays.push(mean([...dayRecord.values()].map(mean)));
    }
    const voterViews = [...allVoters].map((v) => recent.viewOf(v)).filter((v) => v !== undefined);
    const leaning = voterViews.filter((v) => v !== 0);
    const longShare = leaning.length ? leaning.filter((v) => v > 0).length / leaning.length : null;
    coinsOut.push({
      coin,
      callers: allVoters.size,
      recent: {
        callers: voterViews.length,
        longShare,
        lean: longShare == null ? null : longShare > 0.5 ? "long" : longShare < 0.5 ? "short" : "split",
      },
      record: {
        days: recordDays.length,
        hitRate: recordDays.length ? recordDays.filter((r) => r > 0).length / recordDays.length : null,
        meanReturn: mean(recordDays),
      },
    });
  }
  coinsOut.sort((a, b) => b.recent.callers - a.recent.callers || b.callers - a.callers || byText(a.coin, b.coin));

  const byCaller = new Map([...stats].map(([id, s]) => [id, {
    revealed: s.revealed,
    withheld: s.withheld,
    inCrowd: s.votes,
    withCrowd: s.edges.length,
    coverage: s.revealed ? s.edges.length / s.revealed : null,
    agreement: s.clear ? s.agree / s.clear : null,
    edge: mean(s.edges),
    edgeT: tStat(s.edges),
  }]));
  return { consensus: { rules: { ...rules }, coins: coinsOut }, byCaller };
}

const round = (x, dp) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** dp) / 10 ** dp);

/** A caller's crowd metrics as the API shows them. */
export const crowdMetricsOut = (m) => m && ({
  revealed: m.revealed, withheld: m.withheld, inCrowd: m.inCrowd, withCrowd: m.withCrowd,
  coverage: round(m.coverage, 3), agreement: round(m.agreement, 3), edge: round(m.edge, 5), edgeT: round(m.edgeT, 2),
});

/** The consensus as the API shows it. */
export const consensusOut = (c) => ({
  rules: c.rules,
  coins: c.coins.map((x) => ({
    coin: x.coin, callers: x.callers,
    recent: { ...x.recent, longShare: round(x.recent.longShare, 3) },
    record: { days: x.record.days, hitRate: round(x.record.hitRate, 3), meanReturn: round(x.record.meanReturn, 5) },
  })),
});

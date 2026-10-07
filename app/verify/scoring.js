/**
 * Portions ported from taoshidev/vanta-network, Copyright © 2024 Taoshi Inc,
 * MIT License. The full license text, with the Yuma Rao notice that Vanta's
 * LICENSE also carries, is in ./NOTICE next to this file.
 *
 * Callbook's scoring rules, taken from Vanta (Bittensor subnet 8) instead of
 * invented here. Agents seal a call (coin, long/short/flat, horizon) before
 * the outcome and reveal it after; this file turns revealed calls into an
 * equity curve and scores that curve the way Vanta scores its traders.
 *
 * How a call becomes money: each call is one position worth `leverage` times
 * the account (crypto is capped at 1x per position and 2x in total, as on
 * Vanta). It opens at the first price at or after the call and closes at the
 * first price at or after the horizon. It pays 0.03% of the order value on the
 * way in and on the way out, plus 0.01% of its market value for every full 8
 * hours it is held. Profits and fees add up on a fixed account, so equity is
 * 1 + the sum of every position's PnL less its fees.
 *
 * From the curve come Vanta's daily log returns (complete UTC days only), its
 * risk metrics, its challenge (61 to 90 days, 5% intraday and 5% end-of-day
 * drawdown limits, more than 10% return), its eliminations (5% intraday, 8%
 * end-of-day, 60 days without a call) and its copy detector.
 *
 * Everything is pure: no network, no clock. Time is unix seconds and is passed
 * in (`opts.now`). Every constant names the Vanta file it came from.
 */

// A reduce, not Math.max(...xs): spreading a long array overflows the stack.
const maxOf = (xs) => (xs.length ? xs.reduce((a, b) => (b > a ? b : a)) : -Infinity);

const HOUR = 3_600;
const DAY = 86_400;

const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === "object") deepFreeze(v);
  return Object.freeze(o);
};

// ------------------------------------------------------------------ constants

/** Vanta's numbers. Paths are relative to taoshidev/vanta-network@main unless noted. */
export const VANTA = deepFreeze({
  // vali_objects/vali_config.py: DAYS_IN_YEAR_CRYPTO (scoring.py score_miners hard-codes 365 too)
  daysInYear: 365,
  // vali_objects/vali_config.py: ANNUAL_RISK_FREE_PERCENTAGE / 100
  annualRiskFree: 0.0389,
  // vali_objects/vali_config.py: STATISTICAL_CONFIDENCE_MINIMUM_N_CEIL / _FLOOR, DYNAMIC_MIN_DAYS_NUM_MINERS
  minDaysCeil: 60,
  minDaysFloor: 7,
  dynamicMinDaysTraders: 20,
  // vali_objects/vali_config.py: WEIGHTED_AVERAGE_DECAY_RATE / _MIN / _MAX / _MIN_PNL
  decay: { rate: 0.075, min: 0.15, max: 1.0, minPnl: 0.045 },
  // vali_objects/vali_config.py: OMEGA_LOSS_MINIMUM, SHARPE_STDDEV_MINIMUM, SORTINO_DOWNSIDE_MINIMUM
  floors: { omegaLoss: 0.01, sharpeStddev: 0.01, sortinoDownside: 0.01, calmarDrawdown: 0.001 },
  // vali_objects/vali_config.py: *_NOCONFIDENCE_VALUE (returned when a trader has too few days)
  noConfidence: { sharpe: -100, sortino: -100, calmar: -100, statisticalConfidence: -100, omega: 0, pnl: 0 },
  // vali_objects/vali_config.py: SCORING_*_WEIGHT. Today only average daily PnL counts.
  weights: { calmar: 0, sharpe: 0, omega: 0, sortino: 0, statisticalConfidence: 0, pnl: 1 },
  // vali_objects/vali_config.py: DRAWDOWN_MAXVALUE_PERCENTAGE (calmar normaliser and full penalty)
  drawdownMaxPercent: 10,
  // vali_objects/vali_config.py: PRO_DAILY_RETURN_CAP (return consistency)
  dailyReturnCap: 0.015,
  // vali_objects/vali_config.py: SOFTMAX_TEMPERATURE, EPSILON
  softmaxTemperature: 0.15,
  epsilon: 1e-6,
  // vali_objects/vali_config.py: PROMOTION_THRESHOLD_RANK
  rankThreshold: 25,
  // vali_objects/trade_pair.py: TRANSACTION_FEE_RATE[CRYPTO], CARRY_FEE_RATE_PER_INTERVAL[CRYPTO];
  // vali_objects/vali_dataclasses/position.py refresh_position_fee_usd: crypto interval is 8 hours
  fees: { orderRate: 0.0003, carryRate: 0.0001, carryIntervalSec: 8 * HOUR },
  // vali_objects/trade_pair.py: HS_MIN_LEVERAGE / HS_MAX_LEVERAGE (Hyperliquid crypto perps);
  // vali_objects/vali_config.py: LEGACY_TIER_PORTFOLIO_LEVERAGE_BY_ASSET_CLASS tier 2 crypto
  leverage: { min: 0.01, max: 1.0, portfolio: 2.0 },
  // vali_objects/vali_config.py (at 4ba387d, before the detector moved to a private service):
  // PLAGIARISM_MATCHING_TIME_RESOLUTION_MS, _LOOKBACK_RANGE_MS, _ORDER_TIME_WINDOW_MS,
  // _MINIMUM_FOLLOW_MS, _FOLLOWER_SIMILARITY_THRESHOLD, _REPORTING_THRESHOLD
  plagiarism: {
    resolutionSec: 120,
    lookbackSec: 10 * DAY,
    windowSec: 12 * HOUR,
    minFollowSec: 10,
    followThreshold: 0.75,
    reportThreshold: 0.8,
  },
});

/** The challenge a new trader must pass. vali_objects/vali_config.py + challengeperiod_manager.py. */
export const VANTA_CHALLENGE = deepFreeze({
  minDays: 61,              // CHALLENGE_PERIOD_MINIMUM_DAYS (elapsed time, see _check_promotion)
  maxDays: 90,              // CHALLENGE_PERIOD_MAXIMUM_DAYS
  intradayDrawdown: 0.05,   // CHALLENGE_INTRADAY_DRAWDOWN_THRESHOLD
  eodDrawdown: 0.05,        // CHALLENGE_EOD_DRAWDOWN_THRESHOLD
  returnThreshold: 0.10,    // SUBACCOUNT_CHALLENGE_RETURNS_THRESHOLD[CRYPTO]
  rankThreshold: 25,        // PROMOTION_THRESHOLD_RANK
  inactiveDays: 60,         // IDLE_MINER_MAXIMUM_DAYS
  maxTotalDrawdown: null,   // MAX_TOTAL_DRAWDOWN elimination is disabled in elimination_manager.py
});

/** The rules after passing. vali_objects/vali_config.py FUNDED_* + IDLE_MINER_MAXIMUM_DAYS. */
export const VANTA_FUNDED = deepFreeze({
  intradayDrawdown: 0.05,   // FUNDED_INTRADAY_DRAWDOWN_THRESHOLD
  eodDrawdown: 0.08,        // FUNDED_EOD_DRAWDOWN_THRESHOLD
  inactiveDays: 60,         // IDLE_MINER_MAXIMUM_DAYS
  maxTotalDrawdown: null,
});

// ------------------------------------------------------------------ helpers

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const SIDES = { long: 1, short: -1, flat: 0 };

/**
 * The first price at or after `t`. `prices` is either a function
 * `(coin, t) => price` or `{ [coin]: [[t, price], ...] }` sorted by time.
 */
export function priceAt(prices, coin, t) {
  let p;
  if (typeof prices === "function") p = prices(coin, t);
  else {
    const rows = prices?.[coin] ?? [];
    let lo = 0, hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid][0] < t) lo = mid + 1; else hi = mid;
    }
    p = rows[lo]?.[1];
  }
  if (!(p > 0)) throw new Error(`no price for ${coin} at or after ${t}`);
  return p;
}

function checkCall(c, i) {
  if (!Number.isFinite(c?.t)) throw new Error(`call ${i}: t must be a number of seconds`);
  if (!(c.side in SIDES)) throw new Error(`call ${i}: side must be long, short or flat`);
  if (!(c.horizonSec > 0)) throw new Error(`call ${i}: horizonSec must be positive`);
  if (typeof c.coin !== "string" || !c.coin) throw new Error(`call ${i}: coin is required`);
}

// ------------------------------------------------------------------ returns

/**
 * Size a call the way Vanta sizes an order: clamp to the per-position cap,
 * then cut it to what the portfolio cap leaves; below the minimum it is refused.
 */
function sizeCall(call, open, lev) {
  const wanted = clamp(call.leverage ?? 1, lev.min, lev.max);
  const used = sum(open.filter((p) => p.t <= call.t && call.t < p.exitT).map((p) => p.leverage));
  const size = Math.min(wanted, lev.portfolio - used);
  return size >= lev.min ? size : 0;
}

/** Fees and carry for one position, priced once up front (position.py add_order / refresh_position_fee_usd). */
function openPosition(call, prices, now, cfg) {
  const dir = SIDES[call.side];
  const exitT = call.t + call.horizonSec;
  const entryPrice = priceAt(prices, call.coin, call.t);
  const markValue = (p) => Math.max(0, call.leverage * (1 + dir * (p / entryPrice - 1)));
  // Carry: each full 8h held charges a share of the position's market value at that moment.
  const carry = [0];
  const stop = Math.min(exitT, now);
  for (let k = 1; call.t + k * cfg.carryIntervalSec <= stop; k++) {
    const p = priceAt(prices, call.coin, call.t + k * cfg.carryIntervalSec);
    carry.push(carry[k - 1] + cfg.carryRate * markValue(p));
  }
  const closed = exitT <= now;
  const exitPrice = closed ? priceAt(prices, call.coin, exitT) : null;
  const gross = closed ? dir * call.leverage * (exitPrice / entryPrice - 1) : null;
  return {
    ...call, dir, exitT, entryPrice, exitPrice, closed, carry,
    entryFee: cfg.orderRate * call.leverage,
    // Vanta charges the exit on the exit value: entry value plus realised PnL.
    exitFee: closed ? cfg.orderRate * Math.max(0, call.leverage + gross) : 0,
    gross,
  };
}

/**
 * One position's PnL and fees at time T. It counts only after its open, so a
 * call placed exactly at midnight is charged to the day it starts, not the
 * day before.
 */
function positionAt(pos, prices, T, cfg) {
  if (T <= pos.t) return { pnl: 0, fees: 0, realized: 0, closed: false };
  const closed = pos.closed && T >= pos.exitT;
  const k = Math.floor((Math.min(T, pos.exitT) - pos.t) / cfg.carryIntervalSec);
  const carry = pos.carry[Math.min(k, pos.carry.length - 1)];
  if (closed) {
    return { pnl: pos.gross, fees: pos.entryFee + carry + pos.exitFee, realized: pos.gross, closed };
  }
  const p = priceAt(prices, pos.coin, T);
  return { pnl: pos.dir * pos.leverage * (p / pos.entryPrice - 1), fees: pos.entryFee + carry, realized: 0, closed };
}

/** Equity (everything marked) and balance (open PnL left out) at time T. */
function bookAt(positions, prices, T, cfg) {
  let equity = 1, balance = 1, unrealized = 0;
  for (const pos of positions) {
    const s = positionAt(pos, prices, T, cfg);
    equity += s.pnl - s.fees;
    balance += s.realized - s.fees;
    if (!s.closed) unrealized += s.pnl;
  }
  return { equity: Math.max(0, equity), balance, unrealized };
}

/** Times to mark the book: a regular grid, every UTC midnight, every open and close, and now. */
function markTimes(start, now, positions, step) {
  const set = new Set([start, now]);
  for (let t = Math.ceil(start / step) * step; t <= now; t += step) set.add(t);
  for (let t = Math.ceil(start / DAY) * DAY; t <= now; t += DAY) set.add(t);
  for (const p of positions) for (const t of [p.t, p.exitT]) if (t >= start && t <= now) set.add(t);
  return [...set].sort((a, b) => a - b);
}

/**
 * Days from the book marks. A day is complete when both its midnights are on
 * the record; Vanta only scores complete days (ledger_utils.py
 * _group_checkpoints_by_complete_days), so the first and current part-days are
 * kept for the drawdown rules but flagged incomplete.
 */
function buildDays(marks, start, now) {
  const days = new Map();
  const update = (day, m) => {
    day.close = m.equity; day.closeBalance = m.balance; day.closeUnrealized = m.unrealized;
    day.low = Math.min(day.low, m.equity);
  };
  for (const m of marks) {
    const d = Math.floor(m.t / DAY);
    // A mark on midnight closes the day before as well as opening this one.
    if (m.t % DAY === 0 && days.has(d - 1)) update(days.get(d - 1), m);
    if (d * DAY >= now && m.t !== start) continue;
    if (!days.has(d)) {
      days.set(d, {
        day: d, open: m.equity, close: m.equity, low: m.equity, closeBalance: m.balance,
        closeUnrealized: m.unrealized, complete: d * DAY >= start && (d + 1) * DAY <= now,
      });
    } else update(days.get(d), m);
  }
  return [...days.values()];
}

/**
 * Turn revealed calls into per-call results and a daily history.
 *
 * calls: [{ t, coin, side: "long"|"short"|"flat", horizonSec, leverage? }]
 * prices: function or table, see priceAt
 * opts: { now (default: last exit), markEverySec (3600), accountSize (1),
 *         fees: { orderRate, carryRate, carryIntervalSec }, leverage: { min, max, portfolio } }
 */
export function returnsFromCalls(calls, prices, opts = {}) {
  const cfg = { ...VANTA.fees, ...opts.fees };
  const lev = { ...VANTA.leverage, ...opts.leverage };
  const accountSize = opts.accountSize ?? 1;
  calls.forEach(checkCall);
  const sorted = [...calls].sort((a, b) => a.t - b.t);
  const now = opts.now ?? maxOf(sorted.map((c) => c.t + c.horizonSec));
  const live = sorted.filter((c) => c.t <= now);
  if (!live.length) throw new Error("no calls to score before now");

  const positions = [];
  const perCall = live.map((call) => {
    if (call.side === "flat") return { ...call, status: "flat", leverage: 0, netReturn: 0 };
    const size = sizeCall(call, positions, lev);
    if (!size) return { ...call, status: "rejected", leverage: 0, netReturn: 0, reason: "portfolio leverage cap" };
    const pos = openPosition({ ...call, requested: call.leverage ?? 1, leverage: size }, prices, now, cfg);
    positions.push(pos);
    return describe(pos);
  });

  const start = live[0].t;
  const marks = markTimes(start, now, positions, opts.markEverySec ?? HOUR)
    .map((t) => ({ t, ...bookAt(positions, prices, t, cfg) }));
  const days = buildDays(marks, start, now);
  const complete = days.filter((d) => d.complete);
  const nowBook = marks[marks.length - 1];

  return {
    start, now, lastCallT: live[live.length - 1].t, accountSize,
    calls: perCall,
    days,
    logReturns: complete.map((d) => Math.log(Math.max(d.close, 1e-12) / d.open)),
    dailyPnl: dailyPnl(complete, positions, accountSize),
    mddRatio: worstPointDrawdown(marks),
    equityNow: nowBook.equity,
    balanceNow: nowBook.balance,
  };
}

function describe(pos) {
  const fees = pos.closed
    ? { entry: pos.entryFee, carry: pos.carry[pos.carry.length - 1], exit: pos.exitFee }
    : { entry: pos.entryFee, carry: pos.carry[pos.carry.length - 1], exit: 0 };
  fees.total = fees.entry + fees.carry + fees.exit;
  return {
    t: pos.t, coin: pos.coin, side: pos.side, horizonSec: pos.horizonSec, requested: pos.requested,
    leverage: pos.leverage, status: pos.closed ? "closed" : "open", entryPrice: pos.entryPrice,
    exitPrice: pos.exitPrice, exitT: pos.exitT, grossReturn: pos.gross, fees,
    netReturn: pos.closed ? pos.gross - fees.total : null,
  };
}

/**
 * Vanta's daily PnL (ledger_utils.py daily_pnl_by_date): realised PnL of the
 * positions closed that day, before fees, and on the last day any open loss
 * (never an open gain).
 */
function dailyPnl(complete, positions, accountSize) {
  const out = complete.map((d) => accountSize * sum(positions
    .filter((p) => p.closed && p.exitT > d.day * DAY && p.exitT <= (d.day + 1) * DAY)
    .map((p) => p.gross)));
  if (out.length) out[out.length - 1] += accountSize * Math.min(0, complete[complete.length - 1].closeUnrealized);
  return out;
}

/** Worst equity against its running peak (peak starts at 1), as Vanta's mdd ratio: 0.95 is a 5% drawdown. */
function worstPointDrawdown(marks) {
  let peak = 1, worst = 1;
  for (const m of marks) {
    peak = Math.max(peak, m.equity);
    worst = Math.min(worst, peak > 0 ? m.equity / peak : 0);
  }
  return worst;
}

// ------------------------------------------------------------------ metrics (vali_objects/utils/metrics.py)

/** Recency weights, oldest first, decaying from 1 (today) towards 0.15. metrics.py weighting_distribution. */
export function weightingDistribution(n, { min = VANTA.decay.min, max = VANTA.decay.max, rate = VANTA.decay.rate } = {}) {
  const w = Array.from({ length: n }, (_, i) => min + (max - min) * Math.exp(-rate * i));
  return w.reverse();
}

/** Plain or recency-weighted mean, optionally over a subset of days. metrics.py average. */
export function average(xs, { weighting = false, indices = null, minWeight } = {}) {
  if (!xs.length) return 0;
  let w = weightingDistribution(xs.length, minWeight == null ? {} : { min: minWeight });
  let v = xs;
  if (indices && indices.length) {
    const keep = indices.filter((i) => i >= 0 && i < xs.length);
    v = keep.map((i) => xs[i]); w = keep.map((i) => w[i]);
  }
  if (!weighting) return sum(v) / v.length;
  return sum(v.map((x, i) => x * w[i])) / sum(w);
}

/**
 * Variance as Vanta computes it: the (weighted) mean squared deviation. The
 * ddof argument only gates the sample size; the divisor is n, not n - 1.
 * metrics.py variance.
 */
export function variance(xs, { weighting = false, indices = null } = {}) {
  if (!xs.length) return 0;
  const window = indices ? indices.length : xs.length;
  if (window < 2) return Infinity;
  const mean = average(xs, { weighting, indices });
  return average(xs.map((x) => (x - mean) ** 2), { weighting, indices });
}

const logRiskFree = (daysInYear) => (daysInYear > 0 ? Math.log(1 + VANTA.annualRiskFree) / daysInYear : Infinity);

/** Annualised mean daily log return less the annual risk-free rate. metrics.py ann_excess_return. */
export function annExcessReturn(xs, { weighting = false, daysInYear = VANTA.daysInYear } = {}) {
  if (!xs.length) return 0;
  return average(xs, { weighting }) * daysInYear - VANTA.annualRiskFree;
}

/** sqrt(variance * days in year); Infinity with fewer than 2 days. metrics.py ann_volatility. */
export function annVolatility(xs, { weighting = false, indices = null, daysInYear = VANTA.daysInYear } = {}) {
  const idx = indices ?? xs.map((_, i) => i);
  if (idx.length < 2) return Infinity;
  return Math.sqrt(variance(xs, { weighting, indices: idx }) * daysInYear);
}

/** Volatility of the days below the daily risk-free rate. metrics.py ann_downside_volatility. */
export function annDownsideVolatility(xs, { weighting = false, daysInYear = VANTA.daysInYear } = {}) {
  const target = logRiskFree(daysInYear);
  const idx = xs.flatMap((x, i) => (x < target ? [i] : []));
  return annVolatility(xs, { weighting, indices: idx, daysInYear });
}

const tooFew = (xs, opts) => xs.length < (opts.minDays ?? VANTA.minDaysCeil) && !opts.bypassConfidence;

/** metrics.py sharpe: excess return over volatility (at least 1%). */
export function sharpe(xs, opts = {}) {
  if (tooFew(xs, opts)) return VANTA.noConfidence.sharpe;
  return annExcessReturn(xs, opts) / Math.max(annVolatility(xs, opts), VANTA.floors.sharpeStddev);
}

/** metrics.py sortino: excess return over downside volatility (at least 1%). */
export function sortino(xs, opts = {}) {
  if (tooFew(xs, opts)) return VANTA.noConfidence.sortino;
  return annExcessReturn(xs, opts) / Math.max(annDownsideVolatility(xs, opts), VANTA.floors.sortinoDownside);
}

/** metrics.py omega: winning-day sum over losing-day sum (at least 1%). */
export function omega(xs, opts = {}) {
  if (tooFew(xs, opts)) return VANTA.noConfidence.omega;
  const floor = VANTA.floors.omegaLoss;
  if (!opts.weighting) {
    const up = sum(xs.filter((x) => x > 0));
    const down = sum(xs.filter((x) => x <= 0));
    return up / Math.max(Math.abs(down), floor);
  }
  // Weighted: each side's weighted sum, cross-multiplied by the other side's total weight.
  const w = weightingDistribution(xs.length);
  const side = (keep) => {
    const idx = xs.flatMap((x, i) => (keep(x) ? [i] : []));
    if (!idx.length) return { product: 0, weight: floor };
    return { product: sum(idx.map((i) => xs[i] * w[i])), weight: Math.max(sum(idx.map((i) => w[i])), floor) };
  };
  const pos = side((x) => x > 0), neg = side((x) => x <= 0);
  return (pos.product * neg.weight) / Math.max(Math.abs(neg.product * pos.weight), floor);
}

/**
 * metrics.py statistical_confidence: the one-sample t statistic of daily log
 * returns against zero. Near-zero variance (numpy isclose, |var| <= 1e-8)
 * counts as no confidence.
 */
export function statisticalConfidence(xs, opts = {}) {
  const none = VANTA.noConfidence.statisticalConfidence;
  if (xs.length < (opts.minDays ?? VANTA.minDaysCeil) && (!opts.bypassConfidence || xs.length < 2)) return none;
  const n = xs.length;
  const mean = sum(xs) / n;
  const ss = sum(xs.map((x) => (x - mean) ** 2));
  if (ss / n <= 1e-8) return none;
  return mean / (Math.sqrt(ss / (n - 1)) / Math.sqrt(n));
}

/** Drawdown ratio (0.95) to percent (5). ledger_utils.py drawdown_percentage. */
export function drawdownPercentage(ratio) {
  if (ratio >= 1) return 0;
  if (ratio <= 0) return 100;
  return clamp((1 - ratio) * 100, 0, 100);
}

/**
 * The calmar normaliser: 1 / drawdown percent, zero at 10% or worse. Also
 * zero with no drawdown at all, which is how Vanta behaves.
 * ledger_utils.py mdd_augmentation + mdd_base_augmentation.
 */
export function mddAugmentation(ratio) {
  if (ratio <= 0 || ratio > 1) return 0;
  const pct = drawdownPercentage(ratio);
  if (pct >= VANTA.drawdownMaxPercent) return 0;
  return pct <= 0 || pct > 100 ? 0 : 1 / pct;
}

/** metrics.py calmar: annualised log return in percent times mddAugmentation. */
export function calmar(xs, mddRatio, opts = {}) {
  if (tooFew(xs, opts)) return VANTA.noConfidence.calmar;
  const pct = xs.length ? average(xs, opts) * (opts.daysInYear ?? VANTA.daysInYear) * 100 : 0;
  return pct * mddAugmentation(mddRatio);
}

/** metrics.py pnl_score: mean daily PnL, weighted with the steeper 0.045 floor. No minimum days. */
export function pnlScore(dailyPnlValues, { weighting = false } = {}) {
  if (!dailyPnlValues.length) return VANTA.noConfidence.pnl;
  return average(dailyPnlValues, { weighting, minWeight: VANTA.decay.minPnl });
}

/**
 * metrics.py daily_max_drawdown, kept exactly: the peak is the running max of
 * cumulative log returns starting from day one, so a loss on the very first
 * day is not counted.
 */
export function dailyMaxDrawdown(xs) {
  let cum = 0, peak = -Infinity, worst = 0;
  for (const x of xs) {
    cum += x; peak = Math.max(peak, cum);
    worst = Math.max(worst, 1 - Math.exp(cum - peak));
  }
  return worst;
}

/** metrics.py return_consistency: best day's share of the total, profits capped at 1.5% a day. */
export function returnConsistency(xs) {
  const capped = xs.map((x) => Math.min(Math.exp(x) - 1, VANTA.dailyReturnCap));
  const total = sum(capped);
  return !capped.length || total <= 0 ? 1 : maxOf(capped) / total;
}

/** metrics.py all_time_calmar: realised return over max drawdown (ratio form), floored at 0.1%. */
export function allTimeCalmar(totalReturn, mddRatio) {
  return totalReturn / Math.max(1 - mddRatio, VANTA.floors.calmarDrawdown);
}

// ------------------------------------------------------------------ drawdowns

/**
 * Drawdowns of a history's days ({ open, close, low, complete }) or of plain
 * daily closing values (starting from 1).
 *   max:      Vanta's daily_max_drawdown of the daily log returns
 *   eod:      last close against the highest close so far (never below 1), and the worst seen
 *   intraday: worst fall from a day's open to its low (needs `low`)
 */
export function drawdowns(dailyValues) {
  const days = dailyValues.map((v, i, a) => (typeof v === "number"
    ? { open: i ? a[i - 1] : 1, close: v, low: null, complete: true } : v));
  const closes = days.filter((d) => d.complete);
  let hwm = 1, worstEod = 0, eod = 0;
  for (const d of closes) {
    hwm = Math.max(hwm, d.close);
    eod = 1 - d.close / hwm;
    worstEod = Math.max(worstEod, eod);
  }
  const lows = days.filter((d) => d.low != null && d.open > 0);
  return {
    max: dailyMaxDrawdown(closes.map((d) => Math.log(Math.max(d.close, 1e-12) / d.open))),
    eod: { current: eod, worst: worstEod },
    intraday: lows.length ? Math.max(0, maxOf(lows.map((d) => 1 - d.low / d.open))) : null,
  };
}

// ------------------------------------------------------------------ challenge and elimination

/**
 * Walk the days in order and apply Vanta's live rules at each day's close
 * (challengeperiod_manager.py refresh): time limit, intraday drawdown against
 * the day's open, end-of-day drawdown against the highest close (floored at 1),
 * then promotion. Breaches are strictly greater than the limit; promotion needs
 * strictly more than the return threshold, on min(equity, balance) so an open
 * gain does not count.
 */
function replay(history, rules) {
  const start = rules.start ?? history.start;
  let hwm = 1;
  for (const d of history.days) {
    const at = Math.min((d.day + 1) * DAY, history.now);
    if (rules.maxDays != null && at - start > rules.maxDays * DAY) {
      return { event: "fail", at: start + rules.maxDays * DAY, reason: `did not pass within ${rules.maxDays} days` };
    }
    const intraday = d.open > 0 ? 1 - d.low / d.open : 0;
    if (intraday > rules.intradayDrawdown) {
      return { event: "fail", at, reason: `intraday drawdown ${pct(intraday)} > ${pct(rules.intradayDrawdown)} on day ${iso(d.day)}` };
    }
    if (d.complete) {
      hwm = Math.max(hwm, d.close);
      const eod = 1 - d.close / hwm;
      if (eod > rules.eodDrawdown) {
        return { event: "fail", at, reason: `end-of-day drawdown ${pct(eod)} > ${pct(rules.eodDrawdown)} on ${iso(d.day)}` };
      }
    }
    if (rules.promote && rules.promote(d, at, start)) return { event: "pass", at };
  }
  return null;
}

/** 60 days without a call (elimination_manager.py handle_idle_miners); strictly more than the limit. */
function inactivity(history, rules) {
  const idle = history.now - history.lastCallT;
  if (!(idle > rules.inactiveDays * DAY)) return null;
  return { event: "fail", at: history.lastCallT + rules.inactiveDays * DAY, reason: `inactive: no call for ${(idle / DAY).toFixed(1)} days` };
}

const pct = (x) => `${(x * 100).toFixed(2)}%`;
const iso = (day) => new Date(day * DAY * 1000).toISOString().slice(0, 10);

/**
 * pass / fail / in-progress for the challenge, with reasons.
 * opts: VANTA_CHALLENGE fields, plus `rank` (the trader's place in the
 * field; left out, it is assumed inside the top 25, which is true whenever the
 * field has 25 traders or fewer) and `start` (defaults to the first call).
 */
export function challengeStatus(history, opts = {}) {
  const rules = { ...VANTA_CHALLENGE, ...opts };
  const rankOk = rules.rank == null || rules.rank <= rules.rankThreshold;
  const returnAt = (d) => Math.min(d.close, d.closeBalance) - 1;
  const promote = (d, at, start) => at - start >= rules.minDays * DAY && returnAt(d) > rules.returnThreshold && rankOk;
  const outcome = replay(history, { ...rules, promote }) ?? inactivity(history, rules);
  const start = rules.start ?? history.start;
  const elapsedDays = (history.now - start) / DAY;
  const currentReturn = Math.min(history.equityNow, history.balanceNow) - 1;
  const base = {
    elapsedDays, tradingDays: history.logReturns.length, currentReturn,
    drawdowns: drawdowns(history.days), rank: rules.rank ?? null,
  };
  if (outcome) return { ...base, status: outcome.event, at: outcome.at, reasons: [outcome.reason ?? "passed every rule"] };
  const reasons = [];
  if (elapsedDays < rules.minDays) reasons.push(`needs ${rules.minDays} days, has ${elapsedDays.toFixed(1)}`);
  if (!(currentReturn > rules.returnThreshold)) reasons.push(`return ${pct(currentReturn)} is not above ${pct(rules.returnThreshold)}`);
  if (!rankOk) reasons.push(`rank ${rules.rank} is outside the top ${rules.rankThreshold}`);
  return { ...base, status: "in-progress", at: null, reasons };
}

/**
 * Should a trader be removed? opts: VANTA_FUNDED fields (pass VANTA_CHALLENGE
 * for a trader still in the challenge). Drawdown breaches come first, then 60
 * days without a call. `maxTotalDrawdown` (a ratio such as 0.10) turns on the
 * all-time drawdown rule that Vanta has written but left switched off.
 */
export function eliminationCheck(history, opts = {}) {
  const rules = { ...VANTA_FUNDED, ...opts, maxDays: null, promote: null };
  const hit = replay(history, rules) ?? inactivity(history, rules);
  if (hit) return { eliminated: true, reason: hit.reason, at: hit.at };
  const worst = 1 - history.mddRatio;
  if (rules.maxTotalDrawdown != null && worst >= rules.maxTotalDrawdown) {
    return { eliminated: true, reason: `max drawdown ${pct(worst)}`, at: history.now };
  }
  return { eliminated: false, reason: null, at: null };
}

// ------------------------------------------------------------------ score and rank (vali_objects/scoring/scoring.py)

/**
 * The minimum days a metric needs before it counts, from the field: 7 when
 * fewer than 20 traders have any days, otherwise the shorter of the 20th
 * longest record and the median, kept within 7 to 60.
 * ledger_utils.py calculate_dynamic_minimum_days_for_asset_classes.
 */
export function dynamicMinDays(tradingDays) {
  if (!tradingDays.length) return VANTA.minDaysCeil;
  const days = tradingDays.filter((d) => d > 0).sort((a, b) => b - a);
  if (days.length < VANTA.dynamicMinDaysTraders) return VANTA.minDaysFloor;
  const mid = days.length / 2;
  const median = days.length % 2 ? days[Math.floor(mid)] : (days[mid - 1] + days[mid]) / 2;
  return clamp(Math.min(days[VANTA.dynamicMinDaysTraders - 1], Math.trunc(median)), VANTA.minDaysFloor, VANTA.minDaysCeil);
}

/**
 * One trader's scoring inputs: every metric Vanta computes, the weights it
 * uses, and the penalty multiplier (0 once the worst drawdown reaches 10%,
 * ledger_utils.py max_drawdown_threshold_penalty). The score itself only
 * exists against a field; see rankField.
 * opts: { weighting (true, as the rank refresh uses), minDays (7, Vanta's value for a field under 20), weights }
 */
export function score(history, opts = {}) {
  const o = { weighting: opts.weighting ?? true, minDays: opts.minDays ?? VANTA.minDaysFloor, daysInYear: VANTA.daysInYear };
  const xs = history.logReturns;
  const metrics = {
    calmar: calmar(xs, history.mddRatio, o),
    sharpe: sharpe(xs, o),
    omega: omega(xs, o),
    sortino: sortino(xs, o),
    statisticalConfidence: statisticalConfidence(xs, o),
    pnl: pnlScore(history.dailyPnl, o),
  };
  const drawdown = drawdownPercentage(history.mddRatio) >= VANTA.drawdownMaxPercent ? 0 : 1;
  return {
    metrics, weights: { ...VANTA.weights, ...opts.weights }, penalties: { drawdown }, penalty: drawdown,
    tradingDays: xs.length, minDays: o.minDays,
  };
}

/** Share of the other scores strictly below each one. scipy percentileofscore(kind="strict") / 100. */
export function percentiles(values) {
  return values.map((v) => values.filter((u) => u < v).length / values.length);
}

/** Softmax at temperature 0.15 over the non-zero scores; zeros stay zero. scoring.py softmax_scores. */
export function softmax(values, temperature = VANTA.softmaxTemperature) {
  if (values.length === 1) return [1];
  const live = values.filter((v) => v !== 0);
  if (!live.length) return values.map(() => 0);
  const top = maxOf(live);
  const total = sum(live.map((v) => Math.exp((v - top) / temperature))) + VANTA.epsilon;
  return values.map((v) => (v === 0 ? 0 : Math.exp((v - top) / temperature) / total));
}

/**
 * Rank a field the way Vanta weights its traders (scoring.py
 * compute_results_checkpoint): per metric, the percentile among traders not
 * fully penalised; the weighted sum of percentiles; times the penalty; softmax;
 * then shares that add to 1. A field of one gets 1.0, as on Vanta.
 * entries: [{ id, history }]. Returns [{ id, weight, combined, rank, ...score }] best first.
 */
export function rankField(entries, opts = {}) {
  if (!entries.length) return [];
  const minDays = opts.minDays ?? dynamicMinDays(entries.map((e) => e.history.logReturns.length));
  const scored = entries.map((e) => ({ id: e.id, ...score(e.history, { ...opts, minDays }) }));
  if (scored.length === 1) return [{ ...scored[0], combined: 1, weight: 1, rank: 1 }];
  const inPlay = scored.filter((s) => s.penalty !== 0);
  const combined = new Map(scored.map((s) => [s.id, 0]));
  for (const name of Object.keys(VANTA.weights)) {
    const w = scored[0].weights[name];
    const ranks = inPlay.length === 1 ? [1] : percentiles(inPlay.map((s) => s.metrics[name]));
    inPlay.forEach((s, i) => combined.set(s.id, combined.get(s.id) + w * ranks[i]));
  }
  const raw = scored.map((s) => combined.get(s.id) * s.penalty);
  const soft = softmax(inPlay.length ? raw : raw.map(() => 0));
  const total = sum(soft);
  return scored
    .map((s, i) => ({ ...s, combined: raw[i], weight: total ? soft[i] / total : 0 }))
    .sort((a, b) => b.weight - a.weight)
    .map((s, i) => ({ ...s, rank: i + 1 }));
}

// ------------------------------------------------------------------ copy detection

/*
 * Vanta's copy detector, ported from vali_objects/plagiarism/ at commit
 * 4ba387d (the last version before it moved to a private service): each
 * trader's positions on a coin become a leverage trace sampled every 2
 * minutes over the last 10 days. A follower is flagged on a coin when it
 * placed a call 10 seconds to 12 hours after at least 75% of the other's calls
 * ("follow") and its trace, shifted back by its average delay, has a cosine
 * similarity of at least 0.8 with the other's ("single" score).
 */

/** Calls on one coin as Vanta state segments: { start, end, leverage } (signed), last 10 days. PositionUtils.to_state_list. */
function segments(calls, coin, now, lookbackSec) {
  return calls
    .filter((c) => c.coin === coin && c.side !== "flat" && c.t >= now - lookbackSec && c.t <= now)
    .sort((a, b) => a.t - b.t)
    .map((c) => ({ start: c.t, end: Math.min(c.t + c.horizonSec, now), leverage: SIDES[c.side] * (c.leverage ?? 1) }));
}

/** The leverage trace. ReportingUtils.rasterize_cumulative_position. */
function rasterize(segs, now, { lookbackSec, resolutionSec }) {
  const from = now - lookbackSec;
  const out = new Float64Array(Math.ceil(lookbackSec / resolutionSec));
  for (const s of segs) {
    const lo = Math.max(0, Math.ceil((s.start - from) / resolutionSec));
    const hi = Math.min(out.length - 1, Math.floor((s.end - from) / resolutionSec));
    for (let k = lo; k <= hi; k++) out[k] = s.leverage;
  }
  return out;
}

/**
 * Delays (in 2-minute steps) from each of the leader's calls to a follower
 * call 10s to 12h later. FollowPercentage.compute_time_differences, kept
 * exactly: the scan restarts at the follower's first call for each leader
 * call, and it stops at the first leader call nobody followed, so later
 * matches are not counted. `skipUnfollowed: true` moves on instead.
 */
export function followDelays(follower, leader, p = VANTA.plagiarism, skipUnfollowed = false) {
  const out = [];
  let i = 0, j = 0;
  while (i < leader.length && j < follower.length) {
    const d = follower[j].start - leader[i].start;
    if (d <= p.windowSec && d >= p.minFollowSec) { out.push(d / p.resolutionSec); i++; j = 0; }
    else if (skipUnfollowed && j === follower.length - 1) { i++; j = 0; }
    else j++;
  }
  return out;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let k = 0; k < a.length; k++) { dot += a[k] * b[k]; na += a[k] ** 2; nb += b[k] ** 2; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** CopySimilarity.score_direct: cosine of the follower's trace shifted back by its average delay. */
function shiftedCosine(fRaster, lRaster, lag) {
  if (lag >= fRaster.length) return 0;
  return lag > 0 ? cosine(fRaster.subarray(lag), lRaster.subarray(0, lRaster.length - lag)) : cosine(fRaster, lRaster);
}

function pairOnCoin(callsA, callsB, coin, now, p, skipUnfollowed) {
  const segA = segments(callsA, coin, now, p.lookbackSec);
  const segB = segments(callsB, coin, now, p.lookbackSec);
  const rA = rasterize(segA, now, p), rB = rasterize(segB, now, p);
  const delays = followDelays(segA, segB, p, skipUnfollowed);
  const back = followDelays(segB, segA, p, skipUnfollowed);
  const lag = delays.length ? Math.trunc(sum(delays) / delays.length) : 0;
  const backLag = back.length ? Math.trunc(sum(back) / back.length) : 0;
  const single = shiftedCosine(rA, rB, lag);
  const reverse = shiftedCosine(rB, rA, backLag);
  return {
    coin,
    follow: segB.length ? delays.length / segB.length : 0,
    lagSteps: lag,
    lagSec: lag * p.resolutionSec,
    single,
    // Not Vanta's: the cosine with no shift. Vanta never flags a same-time copy (see similarity).
    unshifted: cosine(rA, rB),
    // LagDetection: how much better A fits B than B fits A. Vanta reports it but does not require it.
    lagScore: reverse > 0 ? single / reverse : 0,
  };
}

/**
 * Does A copy B? Per coin both trade: follow share, delay, cosine and whether
 * it is flagged (follow >= 0.75 and cosine >= 0.8, PlagiarismPipeline.compose_victims).
 * A call list identical to B's at the same instants is not flagged: under 10s
 * is not a follow, so each call matches B's next one instead, and the shift
 * by that delay ruins the cosine. `unshifted` near 1 is the tell for that case.
 * opts: { now (default: last call end), skipUnfollowed, ...VANTA.plagiarism overrides }
 */
export function similarity(callsA, callsB, opts = {}) {
  const p = { ...VANTA.plagiarism, ...opts };
  const now = opts.now ?? maxOf([...callsA, ...callsB].map((c) => c.t + c.horizonSec));
  const coins = [...new Set(callsA.map((c) => c.coin))].filter((c) => callsB.some((b) => b.coin === c));
  const byCoin = coins.map((coin) => {
    const r = pairOnCoin(callsA, callsB, coin, now, p, opts.skipUnfollowed);
    return { ...r, flagged: r.follow >= p.followThreshold && r.single >= p.reportThreshold };
  });
  const followed = byCoin.filter((r) => r.follow >= p.followThreshold);
  return {
    flagged: byCoin.some((r) => r.flagged),
    score: followed.length ? maxOf(followed.map((r) => r.single)) : 0,
    byCoin,
  };
}

/**
 * Copy detection across a field, adding Vanta's "two" and "three" scores: the
 * mean of a follower's two (three) closest matches on a coin, credited to each
 * of them (TwoCopySimilarity / ThreeCopySimilarity). A pair's score is the
 * highest of its single, two and three scores.
 * field: [{ id, calls }]. Returns every pair with some follow, flagged first.
 */
export function copyReport(field, opts = {}) {
  const p = { ...VANTA.plagiarism, ...opts };
  const now = opts.now ?? maxOf(field.flatMap((f) => f.calls.map((c) => c.t + c.horizonSec)));
  const out = [];
  for (const a of field) {
    const coins = [...new Set(a.calls.map((c) => c.coin))];
    for (const coin of coins) {
      const pairs = field.filter((b) => b.id !== a.id)
        .map((b) => ({ follower: a.id, leader: b.id, ...pairOnCoin(a.calls, b.calls, coin, now, p, opts.skipUnfollowed) }));
      const top = [...pairs].sort((x, y) => y.single - x.single);
      const meanTop = (k) => sum(top.slice(0, k).map((x) => x.single)) / Math.min(k, top.length);
      for (const pair of pairs) {
        const place = top.indexOf(pair);
        const scoreNow = Math.max(pair.single, place < 2 ? meanTop(2) : 0, place < 3 ? meanTop(3) : 0);
        const flagged = pair.follow >= p.followThreshold && scoreNow >= p.reportThreshold;
        if (pair.follow > 0) out.push({ ...pair, score: scoreNow, flagged });
      }
    }
  }
  return out.sort((x, y) => Number(y.flagged) - Number(x.flagged) || y.score - x.score);
}

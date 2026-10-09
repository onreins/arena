/**
 * The Callbook engine: from chain events and public prices to every period's
 * status, the book's metrics, its 0–100 score and the report that score
 * points to. Everything here but the I/O helpers at the bottom is pure; time
 * is always passed in (`asOf`, unix seconds), never read from the clock, so
 * a score can be rebuilt for any past moment and match to the byte.
 *
 * The rules (docs/CALLBOOK.md, "Rules the scorer publishes" and "The score"):
 *
 *   - entry is the candle open at the period start, exit the candle open at
 *     the horizon; Vanta's 0.03% fee each way; Hyperliquid funding instead of
 *     Vanta's flat carry when the funding history is available
 *   - a period with no seal by its deadline is a miss: no position, and it
 *     costs coverage
 *   - a seal not revealed within the 7-day grace is withheld: scored as the
 *     worst result among the book's coins, long or short
 *   - flat is a call: zero return, and it counts against exposure
 *   - vsMarket: each call's return less the equal-weight move of the book's
 *     coins over the same window, times the call's side
 */
import { encodeAbiParameters, keccak256 } from "viem";

import {
  returnsFromCalls, challengeStatus, drawdowns, score as vantaScore, pnlScore,
  VANTA, VANTA_CHALLENGE,
} from "./scoring.js";
import { canonicalJson, hashText, SCORING_VERSION, requestForBook, latestResponse } from "./callbook-chain.js";
import { priceBook, intervalFor, resolveSymbol } from "./callbook-prices.js";
import { maxOf, brief } from "./callbook-util.js";
import { agentInfo, profileFor, profileFields, personProfile } from "./callbook-agents.js";
import { evaluateCaller, callerToApi } from "./callbook-callers.js";
import { skillScore, hitOf, recordLevel } from "./callbook-skill.js";

export * from "./callbook-chain.js";
export {
  deriveLocks, priceLocks, scoreCaller, callerScore, buildCallerReport, evaluateCaller, callerToApi, worstOver, netOf,
  lockedHash, symbolCallHash, curveDrawdown, withheldAfter, REFERENCE_COINS, REFERENCE_SET, REFERENCE_SET_NAME, CALLER_RULES,
  driftRates, candidatesFor, MAX_LOCKS_PER_BOOK,
} from "./callbook-callers.js";

const HOUR = 3_600;
const DAY = 86_400;
/** Callbook.sol: SEAL_LEAD and GRACE. */
export const SEAL_LEAD = 60;
export const GRACE = 7 * DAY;
export const SIDE_NAME = { 1: "long", 0: "flat", "-1": "short" };
/** At most this many periods of a book are scored (the latest); the rest is dropped and the book flagged. */
export const MAX_PERIODS = 5_000;
/** At most this many distinct coins are fetched in one rebuild of every book. */
export const MAX_COINS_PER_REBUILD = 64;

/** The published score's constants. Changing any of them is a new scoring version. */
/**
 * The Callbook score (docs/CALLBOOK.md, "The score"), built on Vanta's metrics:
 *   score = 100 × coverage × (0.6 × profit + 0.4 × edge) × (0.6 + 0.4 × risk)
 * Points come only from what a book earned (profit) and how much it beat the
 * market (edge); risk scales them down, never adds. How long the record is
 * shows as its level (recordLevel), not in the number.
 */
export const SCORE_RULES = Object.freeze({
  fullT: 3, // a t-statistic of 3 or more earns the whole profit or edge part
  maxDrawdown: 0.4, // a 40% fall from a high takes the risk factor to its floor
  minExposure: 0.5, // risk credit needs half the periods in a position
  profitWeight: 0.6,
  edgeWeight: 0.4,
  riskFloor: 0.6, // the worst drawdown keeps 60% of what was earned
});

export const LIMITS = Object.freeze({
  intradayDrawdown: VANTA_CHALLENGE.intradayDrawdown,
  eodDrawdown: VANTA_CHALLENGE.eodDrawdown,
  minDays: VANTA_CHALLENGE.minDays,
  targetReturn: VANTA_CHALLENGE.returnThreshold,
  maxDays: VANTA_CHALLENGE.maxDays,
});

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : 0);
const round = (x, dp = 6) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** dp) / 10 ** dp);

// ------------------------------------------------------------------ the preimage

/** What a caller seals: Callbook.callHashOf, computed off-chain. */
export function callHash({ callbook, chainId, bookId, p, coinIndex, side, salt }) {
  return keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint64" }, { type: "uint8" }, { type: "int8" }, { type: "bytes32" }],
    [String(callbook).toLowerCase(), BigInt(chainId), BigInt(bookId), BigInt(p), coinIndex, side, salt],
  ));
}

// ------------------------------------------------------------------ periods

export const startOf = (book, p) => book.start + p * book.periodSec;
export const exitOf = (book, p) => startOf(book, p) + book.horizonSec;

function sealMap(seals) {
  if (seals instanceof Map) return seals;
  return new Map((seals ?? []).map((s) => [s.p, s]));
}

/**
 * Every period from 0 to now, with its status as of `now`:
 *   revealed  sealed, and revealed by now
 *   pending   sealed, not revealed, and the reveal window is still open
 *   withheld  sealed, never revealed, the 7-day grace after the horizon has passed
 *   missed    nothing sealed by its deadline (SEAL_LEAD before its start) while the book was open
 * Seals and reveals after `now` are ignored, so a past moment can be rebuilt.
 * Periods after a close that were never sealed are not misses: the book had stopped.
 */
export function deriveCalls(book, seals = book.seals, now) {
  const all = sealMap(seals);
  const known = (s) => s && s.sealedAt <= now;
  const closedAt = book.closedAt != null && book.closedAt <= now ? book.closedAt : null;
  const limit = closedAt ?? now;
  const lastSealed = maxOf([...all.values()].filter(known).map((s) => s.p), -1);
  // The last period whose deadline passed while the book was open, or the last sealed one.
  const lastDue = Math.ceil((limit + SEAL_LEAD - book.start) / book.periodSec) - 1;
  const last = Math.max(lastDue, lastSealed);
  // At most MAX_PERIODS (the latest): a 5-minute book left open for years would be millions.
  const firstP = Math.max(0, last - MAX_PERIODS + 1);

  const calls = [];
  for (let p = firstP; p <= last; p++) {
    const start = startOf(book, p), exit = start + book.horizonSec;
    const s = all.get(p);
    if (!known(s)) {
      calls.push({ period: p, start, exit, status: "missed", deadline: start - SEAL_LEAD });
      continue;
    }
    const c = { period: p, start, exit, sealedAt: s.sealedAt, sealTx: s.sealTx ?? null, hash: s.hash };
    if (s.reveal && s.reveal.at <= now) {
      Object.assign(c, {
        status: "revealed", revealedAt: s.reveal.at, revealTx: s.reveal.tx ?? null,
        coinIndex: s.reveal.coinIndex, coin: book.coins[s.reveal.coinIndex], side: s.reveal.side,
      });
    } else {
      c.status = now > exit + GRACE ? "withheld" : "pending";
    }
    calls.push(c);
  }
  return calls;
}

/** The period that opens next, and whether its call is already sealed. Null once closed. */
export function nextPeriod(book, seals = book.seals, now) {
  if (book.closedAt != null && book.closedAt <= now) return null;
  const p = now < book.start ? 0 : Math.floor((now - book.start) / book.periodSec) + 1;
  const s = sealMap(seals).get(p);
  return { period: p, startsAt: startOf(book, p), sealed: Boolean(s && s.sealedAt <= now) };
}

// ------------------------------------------------------------------ outcomes

/** Each coin's funding-adjusted move from `from` to `to`, and their equal-weight average. */
function movesOver(prices, coins, from, to) {
  const moves = coins.map((coin) => {
    const a = prices.index(coin, from), b = prices.index(coin, to);
    return a > 0 && b > 0 ? b / a - 1 : null;
  });
  const known = moves.filter((m) => m != null);
  return { moves, market: known.length ? mean(known) : 0 };
}

/**
 * The worst result available in a period: the coin that moved most, called
 * the wrong way. A withheld call is scored as this.
 */
export function worstOutcome(coins, moves) {
  let worst = { coinIndex: 0, side: 1, move: 0 };
  moves.forEach((m, i) => {
    if (m != null && Math.abs(m) > Math.abs(worst.move)) worst = { coinIndex: i, side: m > 0 ? -1 : 1, move: m };
  });
  return { ...worst, coin: coins[worst.coinIndex], gross: -Math.abs(worst.move) };
}

/** A period's return over the market's, direction-neutral: ret − side × market. */
export const excessOverMarket = (ret, side, market) => ret - side * market;

/** The calls that have an outcome as of `asOf`, as scoring.js calls. Pending periods wait. */
function scoringCalls(book, calls, prices, asOf) {
  // Prices are looked up by Hyperliquid name; null for a coin it doesn't list.
  const pc = book.priceCoins ?? book.coins;
  const flatCoin = pc.find(Boolean) ?? "FLAT";
  const out = [];
  for (const c of calls) {
    if (c.status === "pending" || (c.status === "missed" && c.exit > asOf)) continue;
    const { moves, market } = movesOver(prices, pc, c.start, c.exit);
    let coin = flatCoin, side = 0, worst = null, status = c.status;
    if (c.status === "revealed" && c.side) {
      if (pc[c.coinIndex]) { coin = pc[c.coinIndex]; side = c.side; }
      else status = "unscorable"; // a call on a coin Hyperliquid doesn't list: scored at its worst
    }
    if (status === "withheld" || status === "unscorable") {
      worst = worstOutcome(pc, moves);
      if (worst.coin) { coin = worst.coin; side = worst.side; }
    }
    out.push({ period: c.period, status, t: c.start, coin, side, market, worst, horizonSec: book.horizonSec });
  }
  return out;
}

// ------------------------------------------------------------------ the score

/** The one-sample t statistic of xs against zero; 0 with under two values or no spread. */
export function tStat(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const sd = Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1));
  return sd > 1e-12 ? m / (sd / Math.sqrt(xs.length)) : 0;
}

/**
 * The 0–100 score posted to ERC-8004 (docs/CALLBOOK.md, "The score"):
 *
 *   score    = 100 × record × coverage × (0.6 × edge + 0.4 × risk)
 *   record   = min(1, days / 61)
 *   coverage = revealed / (revealed + missed + withheld)
 *   edge     = clamp(t / 3, 0, 1), t the t-statistic of the per-call returns
 *              (net of fees and funding) less beta × the market move, beta the
 *              book's average side when in a position
 *   risk     = clamp(1 − maxDrawdown / 10%, 0, 1) × min(1, exposure / 50%)
 *
 * inputs: { days, revealed, missed, withheld, maxDrawdown, outcomes: [{ side, ret, market }] }
 * where `outcomes` are the periods in a position (revealed long/short, and withheld).
 */
export function callbookScore({ days, revealed, missed, withheld, maxDrawdown, outcomes }) {
  const R = SCORE_RULES;
  const due = revealed + missed + withheld;
  const coverage = due ? revealed / due : 0;
  const exposure = due ? outcomes.length / due : 0;
  const beta = outcomes.length ? mean(outcomes.map((o) => o.side)) : 0;
  const t = tStat(outcomes.map((o) => o.ret - beta * o.market));
  const edge = clamp(t / R.fullT, 0, 1);
  const rets = outcomes.map((o) => o.ret);
  const profitT = tStat(rets);
  const profit = sum(rets) > 0 ? clamp(profitT / R.fullT, 0, 1) : 0;
  const risk = clamp(1 - maxDrawdown / R.maxDrawdown, 0, 1) * Math.min(1, exposure / R.minExposure);
  const value = Math.round(100 * coverage * (R.profitWeight * profit + R.edgeWeight * edge) * (R.riskFloor + (1 - R.riskFloor) * risk));
  return { value: clamp(value, 0, 100), level: recordLevel(days, revealed), coverage, exposure, beta, tStat: t, profitT, profit, edge, risk };
}

// ------------------------------------------------------------------ scoring a book

const noHistory = (book, asOf) => ({
  history: null, perPeriod: new Map(),
  metricsExtra: { totalReturn: 0, sharpe: null, sortino: null, omega: null, maxDrawdown: 0, intradayDrawdown: null, eodDrawdown: null, avgDailyPnl: 0 },
  curve: [{ t: book.start, v: 1 }], challengeRaw: { status: "in-progress", elapsedDays: Math.max(0, (asOf - book.start) / DAY), currentReturn: 0 },
});

/** Vanta metrics need 7 days before they mean anything; until then they are null. */
const confident = (x, days) => (days >= VANTA.minDaysFloor && Number.isFinite(x) && x !== -100 ? x : null);

/**
 * Score one book as of `asOf`. `prices` is a priceBook over the book's coins
 * covering every period with an outcome.
 */
export function scoreBook(book, calls, prices, { asOf }) {
  const sc = scoringCalls(book, calls, prices, asOf);
  const costs = prices.useFunding ? "hyperliquid-funding" : "vanta-flat-carry";
  let run = noHistory(book, asOf);

  if (sc.length) {
    const input = sc.map((c) => ({ t: c.t, coin: c.coin, side: SIDE_NAME[c.side], horizonSec: c.horizonSec }));
    const history = returnsFromCalls(input, prices.scoringTable, prices.useFunding ? { fees: { carryRate: 0 } } : {});
    const byT = new Map(history.calls.map((r) => [r.t, r]));
    const v = vantaScore(history, { minDays: VANTA.minDaysFloor });
    const dd = drawdowns(history.days);
    const days = history.logReturns.length;
    run = {
      history,
      perPeriod: new Map(sc.map((c) => [c.period, { ...c, result: byT.get(c.t) }])),
      metricsExtra: {
        totalReturn: history.equityNow - 1,
        sharpe: confident(v.metrics.sharpe, days),
        sortino: confident(v.metrics.sortino, days),
        omega: confident(v.metrics.omega, days),
        maxDrawdown: 1 - history.mddRatio,
        intradayDrawdown: dd.intraday,
        eodDrawdown: dd.eod.worst,
        avgDailyPnl: pnlScore(history.dailyPnl),
      },
      curve: [{ t: book.start, v: 1 }, ...history.days.map((d) => ({ t: Math.min((d.day + 1) * DAY - 1, history.now), v: round(d.close, 5) }))],
      challengeRaw: challengeStatus(history, { start: book.start }),
    };
  }

  // Per period: what it scored, and its return against the market.
  const periods = calls.map((c) => {
    const s = run.perPeriod.get(c.period);
    if (!s) return { ...c };
    const r = s.result;
    const net = r?.netReturn ?? 0;
    const out = { ...c, ret: net, fee: r?.fees?.total ?? 0, market: s.market, vsMarket: s.side ? excessOverMarket(net, s.side, s.market) : 0 };
    if (s.side) { out.entry = prices.price(s.coin, c.start); out.exit = prices.price(s.coin, c.exit); }
    if (s.status === "withheld" || s.status === "unscorable") out.worst = { coin: s.coin, side: s.side };
    if (s.status === "unscorable") Object.assign(out, { status: "unscorable", note: `Hyperliquid lists no perp "${c.coin}"` });
    return out;
  });

  const count = (st) => calls.filter((c) => c.status === st).length;
  const revealedCalls = periods.filter((c) => c.status === "revealed");
  const inPosition = periods.filter((c) => (c.status === "revealed" && c.side) || ((c.status === "withheld" || c.status === "unscorable") && c.ret != null));
  const flats = revealedCalls.filter((c) => !c.side).length;
  const scoredRevealed = revealedCalls.filter((c) => c.side && c.ret != null);
  const end = book.closedAt != null && book.closedAt <= asOf ? Math.max(book.closedAt, run.history?.now ?? 0) : asOf;
  const days = Math.max(0, (Math.min(asOf, end) - book.start) / DAY);

  const metrics = {
    calls: calls.length,
    revealed: revealedCalls.length,
    missed: count("missed"),
    withheld: count("withheld"),
    unscorable: periods.filter((c) => c.status === "unscorable").length,
    pending: count("pending"),
    flatShare: revealedCalls.length ? flats / revealedCalls.length : 0,
    days,
    ...run.metricsExtra,
    vsMarket: sum(inPosition.map((c) => c.vsMarket ?? 0)),
    winRate: scoredRevealed.length ? scoredRevealed.filter((c) => c.ret > 0).length / scoredRevealed.length : null,
  };
  const score = callbookScore({
    days, revealed: metrics.revealed, missed: metrics.missed, withheld: metrics.withheld + metrics.unscorable, maxDrawdown: metrics.maxDrawdown,
    outcomes: inPosition.map((c) => ({ side: c.status === "revealed" ? c.side : c.worst.side, ret: c.ret, market: c.market })),
  });
  // The skill score: each round with a call right or wrong against the book's market move; a missed,
  // hidden or unpriced round wrong; flat rounds aren't forecasts.
  // Times come from `calls`: a priced round's `entry` and `exit` are prices.
  const skill = skillScore(calls.flatMap((c, i) => {
    if (c.status === "pending" || c.exit > asOf || (c.status === "revealed" && !c.side)) return [];
    // The coin's move on the same funding-adjusted prices as the market move it's compared with.
    const s = run.perPeriod?.get(c.period);
    const a = s && periods[i].status === "revealed" ? prices.index(s.coin, c.start) : null;
    const b = a ? prices.index(s.coin, c.exit) : null;
    return [{ start: c.start, end: c.exit, hit: a > 0 && b > 0 ? hitOf(c.side, b / a - 1, s.market ?? 0) : 0 }];
  }), { recordDays: days });
  return { periods, metrics, score, skill, challenge: challengeOf(run.challengeRaw), curve: run.curve, costs, interval: prices.interval };
}

const pctText = (x) => `${(x * 100).toFixed(1)}%`;

/** scoring.js's challenge, in the API's words. */
export function challengeOf(raw) {
  const day = Math.max(1, Math.ceil(raw.elapsedDays ?? 0));
  const status = raw.status === "pass" ? "passed" : raw.status === "fail" ? "failed" : "in_progress";
  let reasons;
  if (status === "passed") {
    reasons = [`Return ${pctText(raw.currentReturn)} over the ${pctText(LIMITS.targetReturn)} target after ${LIMITS.minDays} days, drawdown inside both limits`];
  } else if (status === "failed") {
    reasons = (raw.reasons ?? []).map((r) => r.charAt(0).toUpperCase() + r.slice(1));
  } else {
    reasons = [];
    if (raw.elapsedDays < LIMITS.minDays) reasons.push(`Needs ${LIMITS.minDays} days of record (${Math.floor(raw.elapsedDays)} so far)`);
    if (!(raw.currentReturn > LIMITS.targetReturn)) reasons.push(`Return ${pctText(raw.currentReturn ?? 0)} of the ${pctText(LIMITS.targetReturn)} target`);
  }
  return { status, day: Math.min(day, LIMITS.maxDays), of: LIMITS.maxDays, reasons };
}

// ------------------------------------------------------------------ the report

/**
 * The report a validation response points to: canonical JSON (sorted keys,
 * numbers to 6 places) and its keccak256, which is the responseHash.
 */
export function buildReport({ chainId, callbook, book, asOf, scored }) {
  const m = scored.metrics;
  const report = {
    version: SCORING_VERSION,
    scoring: "Vanta Network rules (MIT), see app/verify/NOTICE",
    chainId: Number(chainId),
    callbook: String(callbook).toLowerCase(),
    bookId: String(book.id),
    asOf,
    book: {
      owner: book.owner, agentId: book.agentId == null ? null : String(book.agentId), coins: book.coins,
      periodSec: book.periodSec, horizonSec: book.horizonSec, start: book.start, strategyHash: book.strategyHash,
      closedAt: book.closedAt != null && book.closedAt <= asOf ? book.closedAt : null,
    },
    prices: { source: "hyperliquid", interval: scored.interval, price: "candle open", costs: scored.costs, fees: VANTA.fees },
    // [period, status, coinIndex, side, net return]; withheld rows carry the worst outcome they were scored as.
    periods: scored.periods.map((c) => {
      // Withheld and unscorable rows carry the worst outcome they were scored as.
      const pc = book.priceCoins ?? book.coins;
      const coinIndex = c.status === "revealed" ? c.coinIndex : c.worst ? pc.indexOf(c.worst.coin) : null;
      const side = c.status === "revealed" ? c.side : c.worst ? c.worst.side : null;
      return [c.period, c.status, coinIndex, side, c.ret == null ? null : round(c.ret)];
    }),
    metrics: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === "number" ? round(v) : v])),
    challenge: scored.challenge,
    score: Object.fromEntries(Object.entries(scored.score).map(([k, v]) => [k, typeof v === "number" ? round(v) : v])),
    skill: scored.skill ?? null,
  };
  const text = canonicalJson(report);
  return { report, text, hash: hashText(text) };
}

/** Where a report can be fetched; `asOf` in the URI is what lets anyone rebuild it. */
export function reportUri({ base, chainId, callbook, bookId, asOf }) {
  if (base) return `${base.replace(/\/$/, "")}/api/callbook/report/${bookId}?asOf=${asOf}`;
  return `callbook-report:eip155:${chainId}/${String(callbook).toLowerCase()}/${bookId}?asOf=${asOf}`;
}
export function asOfFromUri(uri) {
  const m = /[?&]asOf=(\d+)/.exec(uri ?? "");
  return m ? Number(m[1]) : null;
}

// ------------------------------------------------------------------ prices for a book

/**
 * Load the prices a book needs up to `asOf`: only its coins that Hyperliquid
 * lists (matched without regard to case, before anything is fetched).
 */
export async function pricesForBook(source, book, asOf, priceCoins = book.coins) {
  const interval = intervalFor(book.periodSec, book.horizonSec);
  const step = interval === "1h" ? HOUR : 300;
  const coins = [...new Set(priceCoins.filter(Boolean))];
  // A day before the start (strategies look back) to one candle past now.
  const data = await source.load(coins, book.start - DAY, Math.max(book.start, asOf) + step, interval);
  return priceBook({ ...data, interval }, { openBy: asOf });
}

/**
 * Everything about one book as of `asOf`: calls, score, report. `budget`
 * (optional, shared across a rebuild): { coins: Set, max } caps the distinct
 * coins one rebuild fetches.
 */
export async function evaluateBook({ chain, book, source, asOf, reportBase, budget }) {
  const names = source.perpNames ? await source.perpNames() : book.coins;
  const priceCoins = book.coins.map((c) => resolveSymbol(c, names));
  if (!priceCoins.some(Boolean)) throw new Error("none of its coins is a Hyperliquid perp");
  if (budget) {
    const fresh = [...new Set(priceCoins.filter((c) => c && !budget.coins.has(c)))];
    if (budget.coins.size + fresh.length > budget.max) throw new Error(`over the ${budget.max}-coin limit for one rebuild`);
    for (const c of fresh) budget.coins.add(c);
  }
  const scoredBook = { ...book, priceCoins };
  const calls = deriveCalls(book, book.seals, asOf);
  const prices = await pricesForBook(source, book, asOf, priceCoins);
  const scored = scoreBook(scoredBook, calls, prices, { asOf });
  scored.truncated = calls.length > 0 && calls[0].period > 0;
  const rep = buildReport({ chainId: chain.chainId, callbook: chain.address, book: scoredBook, asOf, scored });
  return { book, calls, scored, report: rep, uri: reportUri({ base: reportBase, chainId: chain.chainId, callbook: chain.address, bookId: book.id, asOf }) };
}

// ------------------------------------------------------------------ the API's shapes

function validationOf(chain, book, validator) {
  const req = requestForBook(chain, book.id, validator);
  const last = req ? latestResponse(chain, req.requestHash) : null;
  if (!last) return { request: req, latest: null, api: null };
  return { request: req, latest: last, api: { score: last.score, tag: last.tag, responseHash: last.responseHash, txHash: last.tx, at: last.at, uri: last.uri } };
}

const roundAll = (o, dp) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "number" ? round(v, dp) : v]));

const metricsOut = (m) => ({
  calls: m.calls, revealed: m.revealed, missed: m.missed, withheld: m.withheld, pending: m.pending,
  flatShare: round(m.flatShare, 3), days: round(m.days, 1), totalReturn: round(m.totalReturn, 5), vsMarket: round(m.vsMarket, 5),
  sharpe: round(m.sharpe, 2), sortino: round(m.sortino, 2), omega: round(m.omega, 2),
  maxDrawdown: round(m.maxDrawdown, 4), intradayDrawdown: round(m.intradayDrawdown, 4), eodDrawdown: round(m.eodDrawdown, 4),
  avgDailyPnl: round(m.avgDailyPnl, 5), winRate: round(m.winRate, 3),
});

function callOut(c) {
  const o = { period: c.period, start: c.start, status: c.status };
  if (c.hash) Object.assign(o, { sealedAt: c.sealedAt, sealTx: c.sealTx, hash: c.hash });
  if (c.status === "revealed" || c.status === "unscorable") Object.assign(o, { revealedAt: c.revealedAt, revealTx: c.revealTx, coin: c.coin, side: c.side });
  if (c.note) o.note = c.note;
  if (c.ret != null) Object.assign(o, { ret: round(c.ret, 5), fee: round(c.fee, 5) });
  if (c.status === "revealed" && c.side) Object.assign(o, { entry: c.entry, exit: c.exit, vsMarket: round(c.vsMarket, 5) });
  if (c.worst) o.worst = c.worst;
  return o;
}

/**
 * The /api/callbook book summary and the /api/callbook/book/:id detail for
 * one evaluated book.
 */
export function bookToApi({ chain, ev, validator, asOf, ours = null, cards = null }) {
  const { book, scored } = ev;
  const profile = profileFor({ chain, book, cards });
  const info = agentInfo({ chainId: chain.chainId, callbook: chain.address, bookId: book.id, strategyHash: book.strategyHash, owner: book.owner, ours, profile });
  const v = validationOf(chain, book, validator);
  const summary = {
    id: String(book.id), name: info.name, description: info.description, owner: book.owner, agentId: book.agentId, caller: book.caller,
    coins: book.coins, periodSec: book.periodSec, horizonSec: book.horizonSec, openedAt: book.openedAt, start: book.start,
    closed: book.closedAt != null && book.closedAt <= asOf, strategyHash: book.strategyHash, ours: info.ours, baseline: info.baseline,
    ...profileFields(info),
    metrics: metricsOut(scored.metrics),
    challenge: scored.challenge,
    validation: v.api ? { ...v.api, score: v.api.score } : null,
    // The score as of now; `validation` is the latest one posted on chain, which can be up to a day older.
    score: { value: scored.score.value, asOf, reportHash: ev.report.hash, parts: roundAll(scored.score, 4) },
    skill: scored.skill ?? null,
    curve: scored.curve,
    next: nextPeriod(book, book.seals, asOf),
  };
  const detail = {
    ...summary,
    calls: scored.periods.map(callOut),
    report: { hash: ev.report.hash, uri: ev.uri, version: SCORING_VERSION, scoring: "Vanta Network rules (MIT), see app/verify/NOTICE", costs: scored.costs },
    request: v.request ? { requestHash: v.request.requestHash, validator: v.request.validator, tx: v.request.tx } : null,
    limits: { ...LIMITS },
  };
  return { summary, detail, feed: feedOf(book, info, scored.periods, chain, v) };
}

function feedOf(book, info, periods, chain, v) {
  const base = { bookId: String(book.id), book: info.name };
  const out = [];
  for (const c of periods) {
    if (c.hash) out.push({ ...base, t: c.sealedAt, kind: "sealed", period: c.period, hash: c.hash, tx: c.sealTx });
    if (c.status === "revealed" || c.status === "unscorable") out.push({ ...base, t: c.revealedAt, kind: "revealed", period: c.period, hash: c.hash, coin: c.coin, side: c.side, ret: round(c.ret, 5), tx: c.revealTx, ...(c.status === "unscorable" ? { note: "unscorable" } : {}) });
    if (c.status === "missed") out.push({ ...base, t: c.start - SEAL_LEAD, kind: "missed", period: c.period, tx: null });
    if (c.status === "withheld") out.push({ ...base, t: c.exit + GRACE, kind: "missed", note: "withheld", period: c.period, hash: c.hash, ret: round(c.ret, 5), tx: null });
  }
  if (v.request) {
    for (const r of chain.validation.responses.get(v.request.requestHash) ?? []) {
      out.push({ ...base, t: r.at, kind: "validated", period: null, hash: r.responseHash, score: r.score, tag: r.tag ?? null, tx: r.tx });
    }
  }
  return out;
}

/** The /api/callbook index from evaluated books and callers. */
export function indexToApi({ meta, chain, books, callers = [], feedLimit = 100 }) {
  const all = books.map((b) => b.summary);
  const people = callers.map((c) => c.summary);
  const feed = [...books, ...callers].flatMap((b) => b.feed).filter((f) => f.t != null).sort((a, b) => b.t - a.t);
  const sealed = books.reduce((n, b) => n + b.detail.calls.filter((c) => c.hash).length, 0);
  const tally = (list, k) => list.reduce((n, b) => n + (b.metrics?.[k] ?? 0), 0);
  return {
    ...meta,
    stats: {
      books: all.length,
      agents: new Set([...all, ...people].filter((b) => b.agentId != null).map((b) => String(b.agentId))).size,
      owners: new Set([...all, ...people].map((b) => b.owner)).size,
      sealed, revealed: tally(all, "revealed"), missed: tally(all, "missed"), withheld: tally(all, "withheld"),
      validations: [...chain.validation.responses.values()].reduce((n, l) => n + l.length, 0),
      callers: people.length,
      locked: tally(people, "calls"),
      lockedRevealed: tally(people, "revealed"),
      lockedWithheld: tally(people, "withheld"),
      unscorable: tally(people, "unscorable"),
    },
    books: all,
    callers: people,
    // Each person's own name, bio and link, for their profile page (/arena/p/<owner>),
    // including wallets whose records come through linked agents.
    people: Object.fromEntries([...new Set([...all, ...people].map((b) => b.owner).concat([...(chain.links?.values() ?? [])].map((l) => l.wallet)))]
      .map((owner) => [owner, personProfile(chain, owner)]).filter(([, p]) => p)),
    // Agents linked to a person's wallet: agent -> wallet. Their records also show on that wallet's profile.
    links: Object.fromEntries([...(chain.links ?? new Map())].map(([agent, l]) => [agent, l.wallet])),
    feed: feed.slice(0, feedLimit),
  };
}

/**
 * Read, score and shape everything: scheduled books and callers (open-call
 * books). meta: { mode, network, chainId, explorer, contract,
 * validationRegistry, note? }.
 *
 * opts:
 *   ours        our books (callbook-network.js ourBooksFrom): named, flagged
 *               `ours`, and scored first, so the coin limit never crowds them out
 *   agentOwner  async (agentId) => current ERC-8004 owner, to flag a book whose
 *               agent has since moved to someone else (`agentMoved`)
 *   agentCard   async (agentId) => { name, description } from the agent's
 *               ERC-8004 registration file, or null (arena-agent-card.js): the
 *               name of a linked book with no profile of its own
 *   maxCoins    distinct coins fetched in one rebuild (MAX_COINS_PER_REBUILD)
 * A book that can't be scored (no coin Hyperliquid lists, over the coin limit)
 * is still listed, flagged `unscorable` with the reason, never silently dropped.
 */
export async function buildCallbook({ chain, source, asOf, meta, validator, reportBase, log, ours = null, agentOwner = null, agentCard = null, maxCoins = MAX_COINS_PER_REBUILD }) {
  const books = [], callers = [];
  const budget = { coins: new Set(), max: maxCoins };
  const rank = (b) => (ours?.bookIds.has(b.id) && b.owner === ours.owner ? ours.order.indexOf(b.id) : Infinity);
  const ordered = [...chain.books.values()].filter((b) => b.openedAt <= asOf).sort((a, b) => rank(a) - rank(b) || a.id - b.id);
  const cards = await agentCardsFor(ordered, agentCard, log);
  for (const book of ordered) {
    const moved = await agentMovedFor(book, agentOwner, log);
    try {
      if (book.kind === "free") {
        const ev = await evaluateCaller({ chain, book, source, asOf, reportBase, reportUri, budget });
        const api = callerToApi({ chain, ev, validator, asOf, cards });
        callers.push({ ...withFlags(api, { agentMoved: moved, truncated: ev.scored.truncated }), ev });
      } else {
        const ev = await evaluateBook({ chain, book, source, asOf, reportBase, budget });
        const api = bookToApi({ chain, ev, validator, asOf, ours, cards });
        books.push({ ...withFlags(api, { agentMoved: moved, truncated: ev.scored.truncated }), ev });
      }
    } catch (err) {
      log?.(`book ${book.id}: ${brief(err)}`);
      const stub = unscorableStub(book, brief(err), moved, profileFor({ chain, book, cards }));
      (book.kind === "free" ? callers : books).push({ summary: stub, detail: { ...stub, calls: [] }, feed: [], ev: null });
    }
  }
  const generated = new Date(asOf * 1000).toISOString();
  const index = indexToApi({ meta: { ...meta, generated }, chain, books, callers });
  const details = new Map(books.map((b) => [b.summary.id, { ...meta, generated, ...b.detail }]));
  const callerDetails = new Map(callers.map((c) => [c.summary.id, { ...meta, generated, ...c.detail }]));
  return { index, details, callerDetails, evaluated: [...books, ...callers].map((b) => b.ev).filter(Boolean) };
}

/** agentId -> { name, description } for every linked agent, each read once; a failed read is just no card. */
async function agentCardsFor(books, agentCard, log) {
  const cards = new Map();
  if (!agentCard) return cards;
  for (const id of new Set(books.filter((b) => b.agentId != null).map((b) => String(b.agentId)))) {
    try {
      const card = await agentCard(id);
      if (card) cards.set(id, card);
    } catch (err) {
      log?.(`agent ${id} card: ${brief(err)}`);
    }
  }
  return cards;
}

/** True when the book's ERC-8004 agent now belongs to someone other than the book's owner. */
async function agentMovedFor(book, agentOwner, log) {
  if (book.agentId == null || !agentOwner) return false;
  try {
    const now = await agentOwner(book.agentId);
    return Boolean(now) && now.toLowerCase() !== book.owner;
  } catch (err) {
    log?.(`agent ${book.agentId}: ${brief(err)}`);
    return false;
  }
}

function withFlags(api, flags) {
  return { ...api, summary: { ...api.summary, ...flags }, detail: { ...api.detail, ...flags } };
}

function unscorableStub(book, reason, moved, profile = null) {
  return {
    id: String(book.id), name: profile?.name ?? `Book #${book.id}`, ...profileFields(profile ?? {}), kind: book.kind ?? "scheduled", owner: book.owner, agentId: book.agentId, caller: book.caller,
    coins: book.coins?.length ? book.coins : null, openedAt: book.openedAt, closed: book.closedAt != null, ours: false, baseline: false,
    unscorable: true, reason, agentMoved: moved, metrics: null, score: null, validation: null, curve: [], challenge: null,
  };
}

/** Evaluate any book, scheduled or open-call, as of `asOf` (the report route and the verify script). */
export function evaluateAny({ chain, book, source, asOf, reportBase }) {
  return book.kind === "free"
    ? evaluateCaller({ chain, book, source, asOf, reportBase, reportUri })
    : evaluateBook({ chain, book, source, asOf, reportBase });
}

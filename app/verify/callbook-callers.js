/**
 * Callers: open-call (free) books, where a call is locked whenever its caller
 * likes, with a horizon fixed at lock time, instead of once per period. An
 * account's default book (opened by its first gasless lock) names no coins:
 * each call carries its coin as text.
 *
 * Rules (docs/CALLBOOK.md, "Open calls" and "The caller score"):
 *
 *   - every lock counts; there is no flat and no period to miss
 *   - prices are Hyperliquid candle opens: entry at the first candle open at
 *     or after the lock's entryAt, exit at the first one at or after
 *     entryAt + horizon (never earlier, so a call can't see its own entry).
 *     Calls of 1 hour or more use hourly candles, which Hyperliquid keeps for
 *     months, so their score can always be rebuilt (a call can enter up to 59
 *     minutes after its entryAt). Shorter calls use 5-minute candles (entry
 *     within 4 minutes); Hyperliquid keeps those for about 17 days, and a short
 *     call with no 5-minute prices left falls back to hourly ones
 *   - fees: Vanta's 0.03% each way; funding: Hyperliquid's, as for books
 *   - a symbol is matched to a Hyperliquid perp without regard to case,
 *     before any price is fetched; one Hyperliquid doesn't list makes the call
 *     unscorable: flagged, never fetched, and scored as the worst outcome
 *   - a lock never revealed by entryAt + its horizon + 7 days is withheld
 *   - a withheld or unscorable call scores the worst outcome at its horizon
 *     over the candidates: the book's own coins, or, for an any-coin book, the
 *     fixed reference set REFERENCE_SET (arena-v1: Hyperliquid's 50 most
 *     traded perps on 2026-10-07), long or short. The report names the set
 */
import { VANTA } from "./scoring.js";
import { canonicalJson, hashText, SCORING_VERSION, requestForBook, latestResponse, LOCKED_TAG, SYMBOL_TAG, lockedHash, symbolCallHash } from "./callbook-chain.js";
import { priceBook, resolveSymbol } from "./callbook-prices.js";
import { callerInfo, profileFor, profileFields } from "./callbook-agents.js";
import { maxOf, minOf } from "./callbook-util.js";
import { skillScore, hitOf, recordLevel } from "./callbook-skill.js";
import { exitsOf, exitsProblem, exitPath, EXITS_SINCE } from "./callbook-exits.js";

const HOUR = 3_600;
const DAY = 86_400;
/** Calls shorter than this are priced on 5-minute candles, longer ones on hourly candles. */
export const FINE_BELOW = HOUR;
/** About how far back Hyperliquid serves 5-minute candles (its most recent 5,000). */
export const FINE_HISTORY = 17 * DAY;
export const GRACE = 7 * DAY;

/**
 * The reference set for any-coin books' hidden and unknown calls (arena-v1):
 * Hyperliquid's 50 most traded perps by 24h volume on 2026-10-07. Frozen, not
 * recomputed at scoring time, so a score rebuilds the same tomorrow; changing
 * it is a new scoring version.
 */
export const REFERENCE_SET = Object.freeze([
  "BTC", "ETH", "HYPE", "ZEC", "SOL", "NEAR", "PUMP", "XRP", "ENA", "UNI", "ZRO", "LIT", "SUI", "TAO", "WLD", "ONDO", "AVAX",
  "DOGE", "PONS", "kPEPE", "XPL", "ADA", "ARB", "VVV", "MON", "AAVE", "XMR", "FARTCOIN", "LINK", "PENGU", "LTC", "BNB",
  "CASHCAT", "ETHFI", "JUP", "CRV", "GRAM", "INJ", "GRASS", "TRUMP", "CHIP", "GRIFFAIN", "SAND", "MINA", "FET", "kNEIRO",
  "ASTER", "RENDER", "BCH", "ICP",
]);
export const REFERENCE_SET_NAME = "hyperliquid-top50-2026-10-07";
/** Kept for older imports: the reference set. */
export const REFERENCE_COINS = REFERENCE_SET;

export const CALLER_RULES = Object.freeze({
  fullT: 3, // a t-statistic of 3 or more earns the whole profit or edge part
  maxDrawdown: 0.4, // a 40% fall on the call-by-call curve takes risk to its floor
  profitWeight: 0.6,
  edgeWeight: 0.4,
  riskFloor: 0.6, // the worst drawdown keeps 60% of what was earned
});

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : 0);
const round = (x, dp = 6) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** dp) / 10 ** dp);

// ------------------------------------------------------------------ preimages

// The open-call hashes live with the chain reader, which checks each reveal's salt against them.
export { LOCKED_TAG, SYMBOL_TAG, lockedHash, symbolCallHash };

// ------------------------------------------------------------------ statuses

/** At most this many locks per book are scored (the latest); older ones are dropped and the book is flagged. */
export const MAX_LOCKS_PER_BOOK = 5_000;

/** When an unrevealed lock becomes withheld: its own horizon (fixed when it was locked) plus GRACE. */
export const withheldAfter = (book, lock) => lock.entryAt + (lock.horizon ?? book.maxHorizon) + GRACE;

/**
 * Every lock as of `now`: revealed, unscorable (revealed, but Hyperliquid
 * doesn't list its coin), pending (not revealed yet, and still could be) or
 * withheld. Locks and reveals after `now` are ignored.
 */
export function deriveLocks(book, now, perpNames) {
  const all = [...book.locks.values()].filter((l) => l.lockedAt <= now).sort((a, b) => a.callId - b.callId);
  const kept = all.length > MAX_LOCKS_PER_BOOK ? all.slice(-MAX_LOCKS_PER_BOOK) : all;
  return kept.map((l) => {
    const horizon = l.horizon ?? l.reveal?.horizon ?? null;
    const c = { callId: l.callId, hash: l.hash, lockedAt: l.lockedAt, entryAt: l.entryAt, lockTx: l.lockTx ?? null, horizon, exitAt: horizon == null ? null : l.entryAt + horizon };
    if (l.reveal && l.reveal.at <= now) {
      const coin = resolveSymbol(l.reveal.symbol, perpNames);
      const r = { ...c, symbol: l.reveal.symbol, coin, side: l.reveal.side, revealedAt: l.reveal.at, revealTx: l.reveal.tx ?? null };
      // A call locked before exits existed has none and scores as it always did.
      if (l.lockedAt < EXITS_SINCE) return { ...r, status: coin ? "revealed" : "unscorable" };
      // No salt in the reveal's transaction matches the call: its exits can't be known, so it scores at its worst.
      if (l.reveal.salt === null) return { ...r, status: "unscorable", saltUnread: true };
      // Its salt isn't read yet (callbook-chain.js reads a batch per read): it waits for it.
      if (l.reveal.salt === undefined) return { ...c, status: "pending", note: "revealed; reading its stop and target", withheldAfter: withheldAfter(book, l) };
      // Exits the SDK and the lock panel refuse (stop past target, or a hold over 7 days) are
      // dropped from a hand-built salt: the call then scores on its time alone.
      const found = exitsOf(l.reveal.salt);
      const exits = found && !exitsProblem({ side: l.reveal.side, stop: found.stop?.text, target: found.target?.text, horizon }) ? found : null;
      return { ...r, status: coin ? "revealed" : "unscorable", ...(exits ? { exits } : {}) };
    }
    return { ...c, status: now > withheldAfter(book, l) ? "withheld" : "pending", withheldAfter: withheldAfter(book, l) };
  });
}

// ------------------------------------------------------------------ outcomes

/** A position's net return: side × the funding-adjusted move, less Vanta's fee each way. */
export function netOf(side, move) {
  const gross = side * move;
  const fee = VANTA.fees.orderRate * (1 + Math.max(0, 1 + gross));
  return { gross, fee, net: gross - fee };
}

const moveOf = (prices, coin, from, to) => {
  const a = prices.index(coin, from), b = prices.index(coin, to);
  return a > 0 && b > 0 ? b / a - 1 : null;
};

/**
 * The worst a hidden or unknown call could have done over `horizon`: among the
 * candidate coins, the largest move called the wrong way.
 */
export function worstOver(prices, coins, entryAt, horizon) {
  let worst = { coin: coins[0] ?? null, side: 1, horizon, move: 0 };
  for (const coin of coins) {
    const m = moveOf(prices, coin, entryAt, entryAt + horizon);
    if (m != null && Math.abs(m) > Math.abs(worst.move)) worst = { coin, side: m > 0 ? -1 : 1, horizon, move: m };
  }
  return { ...worst, ...netOf(worst.side, worst.move) };
}

/** The coins a book's hidden call is scored against: its own coins that Hyperliquid lists, or the reference set. */
export function candidatesFor(book, perpNames) {
  if (book.anyCoin) return [...REFERENCE_SET];
  return book.coins.map((c) => resolveSymbol(c, perpNames)).filter(Boolean);
}

/**
 * Each lock with its outcome: revealed at prices; withheld and unscorable at their worst.
 * `prices`: hourly; `fine`: 5-minute, for calls shorter than FINE_BELOW (else they use hourly too).
 * `asOf`: the moment scored. A revealed call whose exit candle hadn't opened yet stays pending.
 */
export function priceLocks(book, locks, prices, perpNames = book.coins, fine = null, asOf = Infinity) {
  const candidates = candidatesFor(book, perpNames);
  // The finest prices a call can use: 5-minute ones for a recent short call, or one with exits, while Hyperliquid has them.
  const recent = (c) => !Number.isFinite(asOf) || c.exitAt > asOf - FINE_HISTORY;
  const gridFor = (c, coins) => {
    if (fine && (c.horizon < FINE_BELOW || c.exits) && recent(c) && coins.some((coin) => moveOf(fine, coin, c.entryAt, c.exitAt) != null)) return { p: fine, candles: "5m" };
    return { p: prices, candles: "1h" };
  };
  // The open the exit is priced at, on a grid: until it has opened, the call isn't done.
  const exitOpens = (c, step) => Math.ceil(c.exitAt / step) * step;
  return locks.map((c) => {
    if (c.status === "revealed") {
      const { p, candles } = gridFor(c, [c.coin]);
      const step = candles === "5m" ? 300 : HOUR;
      const priced = c.exits ? pathPriced(p, c, step) : timePriced(p, c);
      if (!priced && exitOpens(c, step) > asOf) return { ...c, status: "pending", note: "revealed; waiting for its exit price" };
      if (!priced) return { ...c, status: "unscorable", note: "no Hyperliquid price for this window", ...worstPriced(gridFor(c, candidates), candidates, c) };
      const r = netOf(c.side, priced.move);
      return { ...c, ...priced, ret: r.net, fee: r.fee, candles };
    }
    if (c.saltUnread) return { ...c, note: "no salt in its reveal matches the call, so its exits can't be read", ...worstPriced(gridFor(c, candidates), candidates, c) };
    if (c.status === "unscorable") return { ...c, note: `Hyperliquid lists no perp "${c.symbol}"`, ...worstPriced(gridFor(c, candidates), candidates, c) };
    if (c.status === "withheld") return { ...c, ...worstPriced(gridFor(c, candidates), candidates, c), resolvedAt: c.withheldAfter };
    return { ...c };
  });
}

/** A call without exits: entry and exit at the opens at or after entryAt and entryAt + horizon. */
function timePriced(p, c) {
  const move = moveOf(p, c.coin, c.entryAt, c.exitAt);
  return move == null ? null : { move, entry: p.price(c.coin, c.entryAt), exit: p.price(c.coin, c.exitAt), resolvedAt: c.exitAt };
}

/**
 * A call with exits: along its candles to the first level touched, or its
 * horizon (callbook-exits.js exitPath). The move is the fill against the entry
 * open, with the funding paid between them, as for any call.
 */
function pathPriced(p, c, step) {
  const path = exitPath({ rows: p.candles(c.coin), step, side: c.side, entryAt: c.entryAt, exitAt: c.exitAt, stop: c.exits.stop?.value ?? null, target: c.exits.target?.value ?? null });
  if (!path) return null;
  // Funding as a factor of the raw price: index / open at a candle, carried from the entry's when the exit's isn't loaded.
  const factor = (t) => { const i = p.index(c.coin, t), o = p.price(c.coin, t); return i > 0 && o > 0 ? i / o : null; };
  const fIn = factor(path.entryT);
  if (fIn == null) return null;
  const fOut = factor(path.exitT) ?? fIn;
  return {
    move: (path.exit * fOut) / (path.entry * fIn) - 1, entry: path.entry, exit: path.exit,
    closedAt: path.exitT, exitReason: path.reason, resolvedAt: Math.max(path.exitT, c.entryAt),
    // Skill judges the call, not its exits: the coin's move over the whole horizon.
    horizonMove: moveOf(p, c.coin, c.entryAt, c.exitAt),
  };
}

/** A hidden or unknown call's worst: its own horizon, on the candidate coins, either side. */
function worstPriced({ p, candles }, coins, c) {
  const w = worstOver(p, coins, c.entryAt, c.horizon);
  return { ret: w.net, fee: w.fee, move: 0, worst: { coin: w.coin, side: w.side, horizon: w.horizon }, candles, resolvedAt: c.exitAt };
}

/**
 * Each coin's passive drift over the caller's record, as a compounding
 * (log) growth rate per second: what simply holding it would have earned on
 * average. A call's expected move is expectedMove(rate, horizon), and the edge
 * is measured against beta × that, so an always-long caller is judged on
 * *when* it was long, not on the coin going up. (Compounding matters: a plain
 * total-move-per-second rate overstates the typical move in a long rise and
 * makes every long look worse than holding.)
 */
export function driftRates(prices, coins, from, to) {
  const rates = new Map();
  if (!(to > from)) return rates;
  for (const coin of coins) {
    const m = moveOf(prices, coin, from, to);
    if (m != null && m > -1) rates.set(coin, Math.log1p(m) / (to - from));
  }
  return rates;
}

/** The move holding a coin would have made over `horizon` seconds at a driftRates rate. */
export const expectedMove = (rate, horizon) => Math.expm1((rate ?? 0) * horizon);

/** How long a call was held: to its stop or target if one closed it, else its horizon. */
const heldOf = (c) => (c.closedAt != null ? Math.max(0, c.closedAt - c.entryAt) : c.horizon);

/**
 * A call with exits is right or wrong on the coin's move over its whole
 * horizon, as if it had none: a tight target and a wide stop would otherwise
 * "win" most of the time while predicting nothing. Exits change its return
 * only. Null for a call without exits (judged as before).
 */
const skillHit = (c, drift) => (c.exits && c.horizonMove != null ? hitOf(c.side, c.horizonMove, expectedMove(drift.get(c.coin), c.horizon)) : null);

// ------------------------------------------------------------------ the caller score

/** One-sample t statistic against zero; 0 with under two values or no spread. */
function tStat(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const sd = Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1));
  return sd > 1e-12 ? m / (sd / Math.sqrt(xs.length)) : 0;
}

/** Worst fall of 1 + the running sum of returns from its running peak (which starts at 1). */
export function curveDrawdown(rets) {
  let v = 1, peak = 1, worst = 0;
  for (const r of rets) {
    v += r;
    peak = Math.max(peak, v);
    worst = Math.max(worst, peak > 0 ? 1 - v / peak : 1);
  }
  return worst;
}

/**
 * The caller score (docs/CALLBOOK.md, "The score"):
 *   score  = 100 × (0.6 × profit + 0.4 × edge) × (0.6 + 0.4 × risk)
 *   profit = clamp(t / 3, 0, 1), t of the net returns, when they add up above 0
 *   edge   = clamp(t / 3, 0, 1), t of (net return − beta × expected), beta the
 *            average side and `expected` the coin's passive drift over the
 *            call's horizon (0 for withheld and unscorable calls)
 *   risk   = clamp(1 − maxDrawdown / 40%, 0, 1), drawdown of the call-by-call curve (1 unit a call)
 * Points come only from profit and edge; risk scales them, never adds. The
 * record's length is its level (recordLevel), shown beside the score.
 * outcomes: resolved calls in order [{ side, ret, expected }].
 */
export function callerScore({ days, outcomes, maxDrawdown }) {
  const R = CALLER_RULES;
  const n = outcomes.length;
  const beta = n ? mean(outcomes.map((o) => o.side ?? 0)) : 0;
  const t = tStat(outcomes.map((o) => o.ret - beta * (o.expected ?? o.move ?? 0)));
  const edge = clamp(t / R.fullT, 0, 1);
  const rets = outcomes.map((o) => o.ret);
  const profitT = tStat(rets);
  const profit = sum(rets) > 0 ? clamp(profitT / R.fullT, 0, 1) : 0;
  const risk = n ? clamp(1 - maxDrawdown / R.maxDrawdown, 0, 1) : 0;
  const value = clamp(Math.round(100 * (R.profitWeight * profit + R.edgeWeight * edge) * (R.riskFloor + (1 - R.riskFloor) * risk)), 0, 100);
  return { value, level: recordLevel(days, n), beta, tStat: t, profitT, profit, edge, risk };
}

/**
 * Metrics, curve and score for a caller's priced locks, as of `asOf`.
 * `drift`: Map coin -> passive log growth per second (driftRates); without it the
 * edge is measured against nothing (expected 0).
 */
export function scoreCaller(book, priced, { asOf, drift = new Map() }) {
  const resolved = priced.filter((c) => c.ret != null).sort((a, b) => a.resolvedAt - b.resolvedAt || a.callId - b.callId);
  const revealed = priced.filter((c) => c.status === "revealed");
  const count = (s) => priced.filter((c) => c.status === s).length;
  const first = priced.length ? minOf(priced.map((c) => c.entryAt)) : null;
  const days = first == null ? 0 : Math.max(0, (asOf - first) / DAY);
  const rets = resolved.map((c) => c.ret);
  const maxDrawdown = curveDrawdown(rets);
  const outcomes = resolved.map((c) => {
    const real = c.status === "revealed";
    // A call that closed early at a stop or target is held only until then.
    return { side: real ? c.side : 0, ret: c.ret, move: real ? c.move : 0, expected: real ? expectedMove(drift.get(c.coin), heldOf(c)) : 0 };
  });
  const score = callerScore({ days, outcomes, maxDrawdown });
  const pick = (c) => (c ? { callId: c.callId, coin: c.coin ?? c.worst?.coin ?? null, side: c.side ?? c.worst?.side ?? null, ret: round(c.ret, 5), status: c.status } : null);
  const byRet = [...resolved].sort((a, b) => a.ret - b.ret);
  const resolvedCount = revealed.length + count("withheld") + count("unscorable");
  const metrics = {
    calls: priced.length,
    revealed: revealed.length,
    withheld: count("withheld"),
    unscorable: count("unscorable"),
    pending: count("pending"),
    coverage: resolvedCount ? revealed.length / resolvedCount : null,
    days,
    hitRate: revealed.length ? revealed.filter((c) => c.ret > 0).length / revealed.length : null,
    meanReturn: resolved.length ? mean(rets) : null,
    meanMove: revealed.length ? mean(revealed.map((c) => c.move)) : null,
    // Against the coin's own move over the same window, direction-neutral by the caller's average side.
    vsCoin: resolved.length ? mean(outcomes.map((o) => o.ret - score.beta * o.move)) : null,
    totalReturn: sum(rets),
    tStat: score.tStat,
    maxDrawdown,
    avgHorizonHours: revealed.length ? mean(revealed.map((c) => c.horizon)) / HOUR : null,
    // Short calls priced on hourly candles because Hyperliquid no longer serves their 5-minute ones.
    // ...and calls with exits, whose path then runs on hourly candles.
    shortOnHourly: priced.filter((c) => (c.horizon < FINE_BELOW || c.exits) && c.candles === "1h").length,
    best: pick(byRet[byRet.length - 1]),
    worst: pick(byRet[0]),
  };
  // The skill score: each resolved call right or wrong against its coin's drift; hidden and unpriced ones wrong.
  const skill = skillScore(resolved.map((c, i) => ({
    start: c.entryAt, end: c.exitAt, hit: c.status === "revealed" ? skillHit(c, drift) ?? hitOf(c.side, c.move, outcomes[i].expected) : 0,
  })), { recordDays: days });
  return { periods: priced, metrics, score, skill, curve: curveOf(resolved, first, asOf) };
}

/** The record as daily points: 1 + every resolved call's return, counted on the day it resolved. */
function curveOf(resolved, first, asOf) {
  if (first == null) return [];
  const out = [{ t: first, v: 1 }];
  let v = 1, i = 0;
  for (let end = (Math.floor(first / DAY) + 1) * DAY; ; end += DAY) {
    const stop = Math.min(end, asOf);
    while (i < resolved.length && resolved[i].resolvedAt <= stop) v += resolved[i++].ret;
    out.push({ t: stop === end ? end - 1 : stop, v: round(v, 5) });
    if (end >= asOf) break;
  }
  return out;
}

// ------------------------------------------------------------------ report and API

export function buildCallerReport({ chainId, callbook, book, asOf, scored }) {
  const report = {
    version: SCORING_VERSION,
    kind: "caller",
    scoring: "Vanta Network fees (MIT), see app/verify/NOTICE; caller score per docs/CALLBOOK.md",
    chainId: Number(chainId),
    callbook: String(callbook).toLowerCase(),
    bookId: String(book.id),
    asOf,
    book: {
      owner: book.owner, agentId: book.agentId == null ? null : String(book.agentId), coins: book.anyCoin ? null : book.coins,
      minHorizon: book.minHorizon, maxHorizon: book.maxHorizon, metaHash: book.strategyHash,
      closedAt: book.closedAt != null && book.closedAt <= asOf ? book.closedAt : null,
    },
    prices: { source: "hyperliquid", interval: "1h; 5m for calls under 1h", price: "candle open", costs: "hyperliquid-funding", fees: VANTA.fees, reference: REFERENCE_SET_NAME, referenceSet: book.anyCoin ? REFERENCE_SET : null },
    // [callId, status, coin, side, horizon, net return, candles ("5m" or "1h") it was priced on]
    // and, for a call with exits, [stop, target, why it closed ("stop", "target" or "time"), when]
    calls: scored.periods.map((c) => [c.callId, c.status, c.coin ?? c.worst?.coin ?? null, c.side ?? c.worst?.side ?? null, c.horizon ?? c.worst?.horizon ?? null, c.ret == null ? null : round(c.ret), c.candles ?? null,
      ...(c.exits ? [[c.exits.stop?.text ?? null, c.exits.target?.text ?? null, c.exitReason ?? null, c.closedAt ?? null]] : [])]),
    metrics: Object.fromEntries(Object.entries(scored.metrics).map(([k, v]) => [k, typeof v === "number" ? round(v) : v])),
    score: Object.fromEntries(Object.entries(scored.score).map(([k, v]) => [k, typeof v === "number" ? round(v) : v])),
    skill: scored.skill ?? null,
  };
  const text = canonicalJson(report);
  return { report, text, hash: hashText(text) };
}

/**
 * Load prices and score one caller as of `asOf`. Coins are matched to
 * Hyperliquid's perp list first; only listed coins are ever fetched. The
 * reference set is fetched only when an any-coin book has a call to score at
 * its worst. `budget` (optional) is shared across a rebuild and caps the
 * distinct coins it fetches: { coins: Set, max }.
 */
export async function evaluateCaller({ chain, book, source, asOf, reportBase, reportUri, budget }) {
  const names = await source.perpNames();
  const locks = deriveLocks(book, asOf, names);
  const own = new Set();
  for (const c of locks) if (c.coin) own.add(c.coin);
  if (!book.anyCoin) for (const c of candidatesFor(book, names)) own.add(c);
  if (budget) {
    const fresh = [...own].filter((c) => !budget.coins.has(c));
    if (budget.coins.size + fresh.length > budget.max) throw new Error(`over the ${budget.max}-coin limit for one rebuild`);
    for (const c of fresh) budget.coins.add(c);
  }
  const needsReference = book.anyCoin && locks.some((c) => c.status === "withheld" || c.status === "unscorable");
  const coins = new Set([...own, ...(needsReference ? REFERENCE_SET : [])]);
  let prices = priceBook({ interval: "1h", candles: {}, funding: {}, fundingOk: true });
  let first = null;
  if (locks.length && coins.size) {
    first = minOf(locks.map((c) => c.entryAt));
    const data = await source.load([...coins], first - DAY, asOf + HOUR, "1h");
    prices = priceBook({ ...data, interval: "1h" }, { useFunding: true, openBy: asOf });
  }
  // Short calls and calls with exits get 5-minute prices too: only their coins (and the candidates,
  // for a hidden one), only over their own span, and only as far back as Hyperliquid keeps them.
  let fine = null;
  const short = locks.filter((c) => c.status !== "pending" && (c.horizon < FINE_BELOW || c.exits) && c.exitAt > asOf - FINE_HISTORY);
  if (short.length) {
    const fineCoins = new Set(short.map((c) => c.coin).filter(Boolean));
    if (short.some((c) => c.status !== "revealed")) for (const c of candidatesFor(book, names)) fineCoins.add(c);
    const from = Math.max(minOf(short.map((c) => c.entryAt)) - HOUR, asOf - FINE_HISTORY - DAY);
    const to = Math.min(maxOf(short.map((c) => c.exitAt)) + HOUR, asOf + HOUR);
    fine = priceBook({ ...(await source.load([...fineCoins], from, to, "5m")), interval: "5m" }, { useFunding: true, openBy: asOf });
  }
  // Drift runs to the last hourly open at or before asOf: the same candle for whoever rebuilds this later.
  const driftEnd = Math.floor(asOf / HOUR) * HOUR;
  const drift = first == null || driftEnd <= first ? new Map() : driftRates(prices, [...own], first, driftEnd);
  const scored = scoreCaller(book, priceLocks(book, locks, prices, names, fine, asOf), { asOf, drift });
  scored.truncated = book.locks.size > MAX_LOCKS_PER_BOOK;
  const report = buildCallerReport({ chainId: chain.chainId, callbook: chain.address, book, asOf, scored });
  return { book, scored, report, uri: reportUri({ base: reportBase, chainId: chain.chainId, callbook: chain.address, bookId: book.id, asOf }) };
}

const shortAddress = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function callOut(c) {
  const o = { callId: c.callId, status: c.status, hash: c.hash, lockedAt: c.lockedAt, entryAt: c.entryAt, lockTx: c.lockTx };
  if (c.horizon != null) Object.assign(o, { horizon: c.horizon, exitAt: c.exitAt, coin: c.coin, symbol: c.symbol, side: c.side, revealedAt: c.revealedAt, revealTx: c.revealTx });
  if (c.status === "revealed") Object.assign(o, { entry: c.entry, exit: c.exit, move: round(c.move, 5) });
  if (c.exits) Object.assign(o, { stop: c.exits.stop?.text ?? null, target: c.exits.target?.text ?? null, exitReason: c.exitReason ?? null, closedAt: c.closedAt ?? null });
  if (c.ret != null) Object.assign(o, { ret: round(c.ret, 5), fee: round(c.fee, 5) });
  if (c.worst) o.worst = c.worst;
  if (c.note) o.note = c.note;
  if (c.status === "pending") o.withheldAfter = c.withheldAfter;
  return o;
}

const metricsOut = (m) => ({
  calls: m.calls, revealed: m.revealed, withheld: m.withheld, unscorable: m.unscorable, pending: m.pending,
  coverage: round(m.coverage, 3), days: round(m.days, 1), hitRate: round(m.hitRate, 3), meanReturn: round(m.meanReturn, 5),
  meanMove: round(m.meanMove, 5), vsCoin: round(m.vsCoin, 5), totalReturn: round(m.totalReturn, 5), tStat: round(m.tStat, 2),
  maxDrawdown: round(m.maxDrawdown, 4), avgHorizonHours: round(m.avgHorizonHours, 1), best: m.best, worst: m.worst,
});

/** The /api/callbook caller summary, its /api/callbook/caller/:id detail, and its feed. */
export function callerToApi({ chain, ev, validator, asOf, cards = null }) {
  const { book, scored } = ev;
  const info = callerInfo({ chainId: chain.chainId, callbook: chain.address, book, profile: profileFor({ chain, book, cards }) });
  const req = requestForBook(chain, book.id, validator);
  const last = req ? latestResponse(chain, req.requestHash) : null;
  const lastCall = scored.periods.length ? maxOf(scored.periods.map((c) => c.lockedAt)) : null;
  const summary = {
    id: String(book.id), name: info.name ?? shortAddress(book.owner), description: info.description, sample: info.sample, ours: info.ours, baseline: info.baseline,
    ...profileFields(info),
    owner: book.owner, agentId: book.agentId, caller: book.caller, coins: book.anyCoin ? null : book.coins, anyCoin: book.anyCoin,
    minHorizon: book.minHorizon, maxHorizon: book.maxHorizon, openedAt: book.openedAt, closed: book.closedAt != null && book.closedAt <= asOf,
    metrics: metricsOut(scored.metrics),
    score: { value: scored.score.value, asOf, reportHash: ev.report.hash, parts: Object.fromEntries(Object.entries(scored.score).map(([k, v]) => [k, typeof v === "number" ? round(v, 4) : v])) },
    skill: scored.skill ?? null,
    validation: last ? { score: last.score, tag: last.tag, responseHash: last.responseHash, txHash: last.tx, at: last.at, uri: last.uri } : null,
    curve: scored.curve,
    pending: scored.metrics.pending,
    lastCallAt: lastCall,
  };
  const detail = {
    ...summary,
    calls: scored.periods.map(callOut),
    report: { hash: ev.report.hash, uri: ev.uri, version: SCORING_VERSION, kind: "caller", reference: REFERENCE_SET_NAME },
  };
  const base = { bookId: String(book.id), callerId: String(book.id), book: summary.name, caller: true };
  const feed = [];
  for (const c of scored.periods) {
    feed.push({ ...base, t: c.lockedAt, kind: "locked", callId: c.callId, hash: c.hash, tx: c.lockTx });
    if (c.revealedAt != null) {
      feed.push({
        ...base, t: c.revealedAt, kind: "revealed", callId: c.callId, hash: c.hash, coin: c.coin ?? c.symbol, side: c.side, horizon: c.horizon, ret: round(c.ret, 5), tx: c.revealTx,
        ...(c.status === "unscorable" ? { note: "unscorable" } : {}),
        ...(c.exits ? { stop: c.exits.stop?.text ?? null, target: c.exits.target?.text ?? null, exitReason: c.exitReason ?? null } : {}),
      });
    }
    if (c.status === "withheld") feed.push({ ...base, t: c.withheldAfter, kind: "missed", note: "withheld", callId: c.callId, hash: c.hash, ret: round(c.ret, 5), tx: null });
  }
  for (const r of req ? chain.validation.responses.get(req.requestHash) ?? [] : []) {
    feed.push({ ...base, t: r.at, kind: "validated", hash: r.responseHash, score: r.score, tag: r.tag ?? null, tx: r.tx });
  }
  return { summary, detail, feed };
}

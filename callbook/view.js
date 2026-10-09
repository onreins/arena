/**
 * Turning books into short, agent-friendly answers: what kind of book, what's
 * due, what's next, and the record. Everything here is pure.
 */
import { SEAL_LEAD, GRACE, startOf, exitOf } from "../app/verify/callbook.js";
import { formatDuration, countdown, utc, MIN_CALL_HORIZON } from "./durations.js";

const round = (x, dp = 4) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** dp) / 10 ** dp);
const pct = (x, dp = 1) => (x == null ? "n/a" : `${(x * 100).toFixed(dp)}%`);
export const SIDE_WORD = { 1: "long", "-1": "short", 0: "flat" };

export const kindOf = (book) => (book.kind === "scheduled" ? "strategy" : "calls");

/** Which round can be sealed now (the contract's sealablePeriod, with a safety margin). */
export function sealableRound(book, now, marginSec = 0) {
  const earliest = now + SEAL_LEAD + marginSec;
  const p = earliest <= book.start ? 0 : Math.ceil((earliest - book.start) / book.periodSec);
  const startsAt = startOf(book, p);
  // The contract refuses a round that starts a full period plus SEAL_LEAD away or more
  // (a window is (start - period - SEAL_LEAD, start - SEAL_LEAD]).
  const tooEarly = startsAt >= now + book.periodSec + SEAL_LEAD;
  return { round: p, startsAt, sealBy: startsAt - SEAL_LEAD, opensAt: startsAt - book.periodSec - SEAL_LEAD + 1, tooEarly };
}

/** One line per book for myBooks(). */
export function bookLine(book, { me, now, defaultBook, plain }) {
  const role = book.owner === me ? "owner" : "caller";
  const closed = book.closedAt != null;
  if (book.kind === "scheduled") {
    const seals = [...book.seals.values()];
    const unrevealed = seals.filter((s) => !s.reveal);
    const next = closed ? null : sealableRound(book, now);
    return {
      bookId: book.id, kind: "strategy", role, closed, coins: book.coins, every: formatDuration(book.periodSec), horizon: formatDuration(book.horizonSec),
      agentId: book.agentId, sealed: seals.length, revealed: seals.length - unrevealed.length,
      dueToReveal: unrevealed.filter((s) => now >= exitOf(book, s.p) && now <= exitOf(book, s.p) + GRACE).length,
      next: next && { round: next.round, startsAt: next.startsAt, sealBy: next.sealBy, sealed: book.seals.has(next.round), sealIn: countdown(next.sealBy - now) },
    };
  }
  const locks = [...book.locks.values()];
  const unrevealed = locks.filter((l) => !l.reveal);
  return {
    bookId: book.id, kind: "calls", role, closed, anyCoin: book.anyCoin, coins: book.anyCoin ? "any Hyperliquid perp" : book.coins,
    // The horizons the tools take: the book's own range, from 1h at least.
    horizons: `${formatDuration(Math.max(book.minHorizon, MIN_CALL_HORIZON))} to ${formatDuration(book.maxHorizon)}`, agentId: book.agentId, default: book.id === defaultBook,
    calls: locks.length, revealed: locks.length - unrevealed.length,
    dueToReveal: unrevealed.filter((l) => {
      const horizon = l.horizon ?? plain(book, l)?.horizon; // public since the lock
      return horizon != null && now >= l.entryAt + horizon && now <= l.entryAt + horizon + GRACE;
    }).length,
  };
}

const scoreOf = (d) => d.score && { value: d.score.value, parts: Object.fromEntries(Object.entries(d.score.parts ?? {}).map(([k, v]) => [k, round(v, 3)])) };

/** One sentence on the skill score: the score and level, or what it still needs. */
export function skillLine(s) {
  if (!s) return "";
  if (s.level === "unrated") {
    const need = s.next ? ` (${s.next.calls} over ${s.next.spanHours}h)` : "";
    return ` Skill: unrated, ${Math.floor(s.effective)} independent calls so far${need} to a provisional skill score.`;
  }
  return ` Skill ${s.score}/100 (${s.level}): ${pct(s.hitRate, 0)} of calls beat the market's own move.`;
}

/** status() for a strategy book, from its API-shaped detail. */
export function strategyStatus(d, { now, source, book }) {
  const horizon = d.horizonSec;
  const pending = (d.calls ?? []).filter((c) => c.status === "pending").map((c) => ({
    round: c.period, sealedAt: c.sealedAt, revealAt: c.start + horizon, revealIn: countdown(c.start + horizon - now),
  }));
  const m = d.metrics ?? {};
  // The round the contract will take now, from the chain (the API's `next` can be one that's already too late).
  const r = book && book.closedAt == null ? sealableRound(book, now) : null;
  const next = r && { round: r.round, startsAt: r.startsAt, sealBy: r.sealBy, sealed: book.seals.has(r.round), sealIn: countdown(r.sealBy - now) };
  const out = {
    bookId: Number(d.id), kind: "strategy", name: d.name ?? null, coins: d.coins, every: formatDuration(d.periodSec), horizon: formatDuration(horizon), closed: Boolean(d.closed),
    record: { rounds: m.calls, revealed: m.revealed, missed: m.missed, withheld: m.withheld, pending: m.pending, days: m.days, totalReturn: m.totalReturn, vsMarket: m.vsMarket, winRate: m.winRate, maxDrawdown: m.maxDrawdown },
    score: scoreOf(d), skill: d.skill ?? null, challenge: d.challenge?.status ?? null, pending, next, source,
  };
  const due = pending.filter((p) => p.revealAt <= now).length;
  out.summary = `Book ${out.bookId} (strategy, ${out.coins.join("/")} every ${out.every}): score ${out.score?.value ?? "n/a"}/100, ` +
    `${m.revealed ?? 0} revealed, ${m.missed ?? 0} missed, ${m.withheld ?? 0} withheld` +
    (due ? `, ${due} ready to reveal` : "") +
    (next ? (next.sealed ? `; round ${next.round} is locked.` : `; lock round ${next.round} by ${utc(next.sealBy)} (${next.sealIn}).`) : "; closed.") + skillLine(out.skill);
  return out;
}

/** status() for a call book, from its API-shaped detail; `plain(callId)` gives the horizon (public) and, if known, coin and side. */
export function callsStatus(d, { now, source, plain }) {
  const m = d.metrics ?? {};
  const pending = (d.calls ?? []).filter((c) => c.status === "pending").map((c) => {
    const p = plain(c.callId);
    const horizon = p?.horizon ?? c.horizonSec ?? c.horizon ?? null;
    const base = { callId: c.callId, entryAt: c.entryAt };
    if (!Number.isFinite(horizon)) return { ...base, note: "coin and side unknown here until revealed (made with another secret?)" };
    const revealAt = c.entryAt + horizon;
    const timing = { horizon: formatDuration(horizon), revealAt, revealIn: countdown(revealAt - now) };
    if (p?.coin == null) return { ...base, ...timing, note: "coin and side unknown here until revealed (made with another secret?)" };
    return { ...base, coin: p.coin, side: SIDE_WORD[p.side], ...(p.exits ? { stop: p.exits.stop ?? null, target: p.exits.target ?? null } : {}), ...timing };
  });
  const out = {
    bookId: Number(d.id), kind: "calls", anyCoin: Boolean(d.anyCoin), coins: d.anyCoin ? "any Hyperliquid perp" : d.coins, closed: Boolean(d.closed),
    record: { calls: m.calls, revealed: m.revealed, withheld: m.withheld, unscorable: m.unscorable, pending: m.pending, hitRate: m.hitRate, meanReturn: m.meanReturn, vsCoin: m.vsCoin, maxDrawdown: m.maxDrawdown, days: m.days },
    score: scoreOf(d), skill: d.skill ?? null, pending, source,
  };
  const due = pending.filter((p) => p.revealAt != null && p.revealAt <= now).length;
  out.summary = `Book ${out.bookId} (open calls${out.anyCoin ? ", any coin" : ""}): score ${out.score?.value ?? "n/a"}/100, ` +
    `${m.calls ?? 0} calls, ${m.revealed ?? 0} revealed, hit rate ${pct(m.hitRate, 0)}` +
    (pending.length ? `, ${pending.length} pending${due ? ` (${due} ready to reveal)` : ""}` : "") + "." + skillLine(out.skill) + " Lock a call any time.";
  return out;
}

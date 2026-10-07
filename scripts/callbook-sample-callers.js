/**
 * The replay's sample callers: discretionary calls locked whenever their rule
 * fires, each from what was known at that moment (a price view that shows
 * only closed hourly candles and funding already paid). They exist to show
 * the caller pages with something real in them; they are not strategies we
 * run, and the pages say so ("sample caller in the replay").
 *
 *   Breakout watcher  long a coin whose last hourly close beats its 3-day high, 12h
 *   Mean reverter     fade a 24h move bigger than 8%, 24h
 *   Weekend fader     on Saturdays and Sundays, every 6 hours, fade BTC or ETH
 *                     after a 12h move bigger than 1.5%, 8h
 *   Random caller     the BASELINE: about two calls a day at random, random
 *                     coin, side and horizon (1h to 24h)
 */
import { createHmac } from "node:crypto";

import { UNIVERSE, rowFromCandles } from "../runner/callbook-agents.js";

const HOUR = 3_600;
const DAY = 86_400;

/** A small seeded generator, so a replay is the same every time it runs over the same prices. */
export function seeded(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 2 ** 32;
  };
}

const closed = (view, coin, now) => view.candles(coin).filter((c) => c.t + HOUR <= now);

function breakout(state, view, now) {
  let best = null;
  for (const coin of UNIVERSE) {
    if (now - (state.last[coin] ?? -Infinity) < DAY) continue;
    const cs = closed(view, coin, now);
    if (cs.length < 73) continue;
    const last = cs[cs.length - 1];
    const high = Math.max(...cs.slice(-73, -1).map((c) => c.h));
    const by = last.c / high - 1;
    if (by > 0 && (!best || by > best.by)) best = { coin, side: 1, horizon: 12 * HOUR, by };
  }
  return best;
}

function reverter(state, view, now) {
  let best = null;
  for (const coin of UNIVERSE) {
    if (now - (state.last[coin] ?? -Infinity) < DAY) continue;
    const row = rowFromCandles(coin, view.candles(coin), view.funding(coin), now);
    if (!row || Math.abs(row.change) <= 0.08) continue;
    if (!best || Math.abs(row.change) > Math.abs(best.change)) best = { coin, side: row.change > 0 ? -1 : 1, horizon: 24 * HOUR, change: row.change };
  }
  return best;
}

function weekend(state, view, now) {
  const day = new Date(now * 1000).getUTCDay();
  const hourStart = Math.floor(now / HOUR) * HOUR;
  if ((day !== 0 && day !== 6) || hourStart % (6 * HOUR) !== 0) return null;
  for (const coin of ["BTC", "ETH"]) {
    if (now - (state.last[coin] ?? -Infinity) < 6 * HOUR) continue;
    const cs = closed(view, coin, now);
    if (cs.length < 13) continue;
    const move = cs[cs.length - 1].c / cs[cs.length - 13].c - 1;
    if (Math.abs(move) > 0.015) return { coin, side: move > 0 ? -1 : 1, horizon: 8 * HOUR, move };
  }
  return null;
}

const HORIZONS = [1, 2, 4, 8, 12, 24].map((h) => h * HOUR);
function random(state) {
  const r = state.rng;
  if (r() > 2 / 24) return null;
  return { coin: UNIVERSE[Math.floor(r() * UNIVERSE.length)], side: r() < 0.5 ? 1 : -1, horizon: HORIZONS[Math.floor(r() * HORIZONS.length)] };
}

const RULES = { breakout, reverter, weekend, random };

/**
 * A caller's state and its decision function.
 * decide(view, now) -> { coin, side, horizon, withhold?, label? } | null
 */
export function makeCaller(key, { start }) {
  const state = { last: {}, rng: seeded(createHmac("sha256", "callbook-replay").update(key).digest().readUInt32BE(0)), forced: [] };
  // The labelled lapses: the Random caller's first two calls are never revealed,
  // and on day three it names a coin Hyperliquid doesn't list.
  if (key === "random") {
    state.forced = [
      { at: start + 2 * HOUR, call: { coin: "SOL", side: 1, horizon: 4 * HOUR, withhold: true } },
      { at: start + 5 * HOUR, call: { coin: "ETH", side: -1, horizon: 8 * HOUR, withhold: true } },
      { at: start + 2 * DAY + 7 * HOUR, call: { coin: "FAKECOIN", side: 1, horizon: 4 * HOUR } },
    ];
  }
  return {
    key,
    /** An offset in minutes into each hour when this caller looks, fixed per caller. */
    minute: 3 + Math.floor(state.rng() * 50),
    decide(view, now) {
      const f = state.forced.find((x) => x.at <= now && !x.done);
      if (f) {
        f.done = true;
        return f.call;
      }
      const call = RULES[key](state, view, now);
      if (call) state.last[call.coin] = now;
      return call;
    },
  };
}

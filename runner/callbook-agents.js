/**
 * Our Callbook agents: what each one calls for the next period, from what was
 * known when it sealed. Every agent gets a price view that hides candles that
 * hadn't closed yet and funding not yet paid (priceBook's `upTo`), so the same
 * code runs live and in a replay without seeing the future.
 *
 * Hot list and Cold list are the Charts page's thesis (app/public/markets.js,
 * the very file the browser runs) applied to Hyperliquid perps. That thesis
 * reads 24-hour ticker stats; here they're rebuilt from the last 24 complete
 * hourly candles, live and in the replay alike:
 *   last    close of the newest complete hourly candle (up to an hour old at sealing time)
 *   open    open of the candle 24 hours before it, so change = last / open − 1
 *   volUsd  Σ volume × typical price ((h + l + c) / 3) over those 24 candles
 *   funding the latest hourly funding rate paid
 *   high/low left out, as Hyperliquid's own ticker leaves them out on Charts
 * and the volume rank is taken among the book's coins, not all of Hyperliquid.
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createHmac } from "node:crypto";

import { OUR_STRATEGIES, strategyHashOf } from "../app/verify/callbook-agents.js";

const HOUR = 3_600;
const FOUR_HOURS = 4 * HOUR;
const FRESH_SEC = 2 * HOUR; // a coin whose newest candle is older than this is skipped

/** Liquid Hyperliquid perps the list agents choose from (fixed when the book opens). */
export const UNIVERSE = ["BTC", "ETH", "SOL", "HYPE", "XRP", "DOGE", "SUI", "BNB", "LINK", "AVAX", "AAVE", "ENA"];

let markets = null;
/** app/public/markets.js, loaded the way its tests load it. */
export function loadMarkets() {
  if (!markets) {
    const ctx = { window: {} };
    vm.runInNewContext(readFileSync(new URL("../app/public/markets.js", import.meta.url), "utf8"), ctx);
    markets = ctx.window.ReinsMarkets;
  }
  return markets;
}

/** A Hyperliquid row for markets.js, rebuilt from candles known at `now`. Null if the data is stale or short. */
export function rowFromCandles(coin, candles, funding, now) {
  const done = candles.filter((c) => c.t + HOUR <= now);
  if (done.length < 24) return null;
  const day = done.slice(-24);
  const lastC = day[day.length - 1];
  if (now - (lastC.t + HOUR) > FRESH_SEC) return null;
  const last = lastC.c, open = day[0].o;
  const paid = funding.filter((f) => f[0] <= now);
  return {
    id: `hyperliquid:${coin}`, venue: "hyperliquid", kind: "perp", base: coin, quote: "USD",
    last, open, high: null, low: null, change: open ? last / open - 1 : null,
    volUsd: day.reduce((s, c) => s + c.v * ((c.h + c.l + c.c) / 3), 0),
    funding: paid.length ? paid[paid.length - 1][1] : null, oiUsd: null,
  };
}

/** The rows for every coin of a book, from a price view. */
export function rowsAt(view, coins, now) {
  return coins.map((coin) => rowFromCandles(coin, view.candles(coin), view.funding(coin), now)).filter(Boolean);
}

const FLAT = { coinIndex: 0, side: 0 };

function hotCall({ coins, view, now }) {
  const top = loadMarkets().hotList(rowsAt(view, coins, now)).hot[0];
  return top ? { coinIndex: coins.indexOf(top.row.base), side: 1, why: `${top.row.base} hot (thesis ${top.thesis.score})` } : { ...FLAT, why: "nothing hot" };
}

function coldCall({ coins, view, now }) {
  const bottom = loadMarkets().hotList(rowsAt(view, coins, now)).cold[0];
  return bottom ? { coinIndex: coins.indexOf(bottom.row.base), side: -1, why: `${bottom.row.base} cold (thesis ${bottom.thesis.score})` } : { ...FLAT, why: "nothing cold" };
}

/** Long or short BTC by a keyed coin flip: unpredictable without the secret, fixed once it's known. */
export function coinFlip(secret, { chainId, callbook, bookId, p }) {
  const byte = createHmac("sha256", secret).update(`flip:${chainId}:${String(callbook).toLowerCase()}:${bookId}:${p}`).digest()[0];
  return byte & 1 ? 1 : -1;
}

function flipCall({ secret, chainId, callbook, bookId, p }) {
  const side = coinFlip(secret, { chainId, callbook, bookId, p });
  return { coinIndex: 0, side, why: "coin flip" };
}

const DECIDE = { hot: hotCall, cold: coldCall, flip: flipCall };
const COINS = { hot: UNIVERSE, cold: UNIVERSE, flip: ["BTC"] };

/** Our agents, each with the book it opens and how it decides. */
export const AGENTS = Object.entries(OUR_STRATEGIES).map(([id, s]) => ({
  key: s.key, name: s.name, strategy: id, strategyHash: strategyHashOf(id),
  coins: COINS[s.key], periodSec: FOUR_HOURS, horizonSec: FOUR_HOURS, decide: DECIDE[s.key],
}));

export const agentByHash = (hash) => AGENTS.find((a) => a.strategyHash.toLowerCase() === String(hash).toLowerCase()) ?? null;

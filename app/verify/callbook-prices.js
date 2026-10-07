/**
 * Public prices for Callbook scoring: Hyperliquid candles and funding, read
 * through a small on-disk cache so a book's history is fetched once.
 *
 * Why Hyperliquid: the books call Hyperliquid perps, its info API needs no key,
 * and anyone re-checking a score gets the same numbers we did.
 *
 *   candles  POST /info {"type":"candleSnapshot","req":{coin,interval,startTime,endTime}}
 *            at most 5000 candles a request, and the API only serves the most
 *            recent 5000 of each interval (about 208 days of 1h, 17 days of 5m),
 *            which is one more reason to keep what we fetched.
 *   funding  POST /info {"type":"fundingHistory",coin,startTime,endTime}
 *            hourly rates, at most 500 a request.
 *
 * The cache stores fixed-size chunks per coin. A chunk that ended more than an
 * interval ago can never change, so it is kept on disk for good; the chunk
 * still being written is kept in memory for a minute. A cache that can't be
 * written (a read-only disk) is skipped, never fatal.
 *
 * Prices for scoring (see priceBook):
 *   price(coin, t)  the open of the first candle at or after t (entry at the
 *                   period start, exit at the horizon, both candle opens)
 *   index(coin, t)  the same price with funding folded in: price × exp(−F(t)),
 *                   F(t) the sum of the hourly funding rates paid up to t. A
 *                   long held from S to E earns index(E)/index(S) − 1, which is
 *                   the price move less the funding paid in (S, E]; a short
 *                   earns the opposite, so it collects that funding.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { brief } from "./callbook-util.js";

export const HYPERLIQUID_INFO = "https://api.hyperliquid.xyz/info";

const HOUR = 3_600;
const INTERVAL_SEC = { "5m": 300, "15m": 900, "1h": HOUR, "4h": 4 * HOUR };
const CANDLE_CHUNK = 1_000; // candles per cached chunk (the API allows 5000 per request)
const FUNDING_CHUNK_SEC = 20 * 24 * HOUR; // 480 hourly rates, under the API's 500
const LIVE_TTL_MS = 60_000;
const EMPTY_TTL_MS = 10 * 60_000;
const RETRIES = 5;

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** Where fetched prices are kept. On Vercel only /tmp is writable. */
export const DEFAULT_CACHE_DIR = process.env.CALLBOOK_PRICE_CACHE
  ?? (process.env.VERCEL ? "/tmp/callbook-prices"
    // The published MCP package keeps its cache in the user's home, not inside node_modules.
    : globalThis.__CALLBOOK_PACKAGED__ ? path.join(homedir(), ".arena", "prices")
    : path.join(ROOT, "data", "callbook-prices"));

/** The candle size for a book: hourly, or 5-minute when calls come more often than hourly. */
export function intervalFor(periodSec, horizonSec = periodSec) {
  return periodSec % HOUR === 0 && horizonSec % HOUR === 0 ? "1h" : "5m";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeName = (coin) => String(coin).replace(/[^A-Za-z0-9_-]/g, (ch) => `%${ch.charCodeAt(0).toString(16)}`);

/**
 * A price source.
 * opts: { cacheDir, fetch (for tests), wallNow () => ms, url, log }
 */
export function createPriceSource(opts = {}) {
  const cacheDir = opts.cacheDir === undefined ? DEFAULT_CACHE_DIR : opts.cacheDir;
  const doFetch = opts.fetch ?? globalThis.fetch;
  const wallNow = opts.wallNow ?? (() => Date.now());
  const url = opts.url ?? HYPERLIQUID_INFO;
  const live = new Map(); // chunk key -> { at, rows }, for chunks still being written
  const done = new Map(); // chunk key -> rows, for chunks that can't change
  let diskOk = Boolean(cacheDir);

  async function post(body) {
    let lastErr;
    for (let i = 0; i < RETRIES; i++) {
      try {
        const res = await doFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        if (res.ok) return res.json();
        lastErr = new Error(`Hyperliquid ${body.type} answered ${res.status}`);
        if (res.status !== 429 && res.status < 500) throw lastErr;
      } catch (err) {
        lastErr = err;
      }
      await sleep(500 * 2 ** i);
    }
    throw lastErr;
  }

  function fileOf(key) {
    return path.join(cacheDir, ...key.split("/"));
  }
  function readDisk(key) {
    if (!diskOk) return null;
    const f = fileOf(key);
    if (!existsSync(f)) return null;
    try {
      return JSON.parse(readFileSync(f, "utf8"));
    } catch {
      return null; // a torn write; fetch it again
    }
  }
  function writeDisk(key, rows) {
    if (!diskOk) return;
    try {
      const f = fileOf(key);
      mkdirSync(path.dirname(f), { recursive: true });
      writeFileSync(`${f}.tmp`, JSON.stringify(rows));
      renameSync(`${f}.tmp`, f);
    } catch (err) {
      diskOk = false;
      opts.log?.(`price cache disabled (${err.code ?? brief(err)})`);
    }
  }

  /** One chunk of rows: from disk if it is complete, from memory if fresh, else fetched. */
  async function chunk(key, endMs, fetchRows) {
    const complete = endMs <= wallNow();
    if (complete) {
      if (done.has(key)) return done.get(key);
      const saved = readDisk(key);
      if (saved) {
        done.set(key, saved);
        return saved;
      }
    }
    const mem = live.get(key);
    // An empty answer (a coin with no candles yet, a gap) is remembered longer: asking again soon won't change it.
    if (mem && (complete || wallNow() - mem.at < (mem.rows.length ? LIVE_TTL_MS : EMPTY_TTL_MS))) return mem.rows;
    const rows = await fetchRows();
    if (complete) {
      writeDisk(key, rows);
      done.set(key, rows);
    } else live.set(key, { at: wallNow(), rows });
    return rows;
  }

  /** Candles [{ t, o, h, l, c, v }] (t in seconds, the candle's open time) with t in [fromSec, toSec]. */
  async function candles(coin, interval, fromSec, toSec) {
    const step = INTERVAL_SEC[interval];
    if (!step) throw new Error(`unsupported candle interval ${interval}`);
    const span = step * CANDLE_CHUNK;
    const out = [];
    for (let k = Math.floor(fromSec / span); k * span <= toSec; k++) {
      const startMs = k * span * 1000, endMs = (k + 1) * span * 1000;
      // A chunk is final once its last candle has closed.
      const rows = await chunk(`${safeName(coin)}/${interval}-${k}.json`, endMs + step * 1000, async () => {
        const got = await post({ type: "candleSnapshot", req: { coin, interval, startTime: startMs, endTime: endMs - 1 } });
        return (Array.isArray(got) ? got : [])
          .map((x) => [Math.round(x.t / 1000), +x.o, +x.h, +x.l, +x.c, +x.v])
          .filter((r) => r[0] * 1000 >= startMs && r[0] * 1000 < endMs);
      });
      for (const r of rows) if (r[0] >= fromSec && r[0] <= toSec) out.push({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] });
    }
    return out.sort((a, b) => a.t - b.t);
  }

  /** Hourly funding [[tSec, rate]] in [fromSec, toSec], times rounded to the hour they are paid on. */
  async function funding(coin, fromSec, toSec) {
    const out = [];
    for (let k = Math.floor(fromSec / FUNDING_CHUNK_SEC); k * FUNDING_CHUNK_SEC <= toSec; k++) {
      const startMs = k * FUNDING_CHUNK_SEC * 1000, endMs = (k + 1) * FUNDING_CHUNK_SEC * 1000;
      const rows = await chunk(`${safeName(coin)}/funding-${k}.json`, endMs + HOUR * 1000, async () => {
        const all = [];
        let from = startMs;
        // 480 hours per chunk fits one page; loop anyway in case the API pages smaller.
        for (let page = 0; page < 4 && from < endMs; page++) {
          const got = await post({ type: "fundingHistory", coin, startTime: from, endTime: endMs - 1 });
          if (!Array.isArray(got) || !got.length) break;
          for (const f of got) if (f.time >= startMs && f.time < endMs) all.push([Math.round(f.time / 3_600_000) * HOUR, +f.fundingRate]);
          const last = got[got.length - 1].time;
          if (got.length < 500 || last + 1 <= from) break;
          from = last + 1;
        }
        const seen = new Map(all.map((r) => [r[0], r]));
        return [...seen.values()].sort((a, b) => a[0] - b[0]);
      });
      for (const r of rows) if (r[0] >= fromSec && r[0] <= toSec) out.push(r);
    }
    return out;
  }

  /**
   * Everything a set of coins needs between two times: candles, and funding
   * unless it can't be had (then `fundingOk` is false and scoring falls back
   * to Vanta's flat carry).
   */
  async function load(coins, fromSec, toSec, interval = "1h") {
    const data = { interval, from: fromSec, to: toSec, candles: {}, funding: {}, fundingOk: true };
    for (const coin of coins) {
      data.candles[coin] = await candles(coin, interval, fromSec, toSec);
      try {
        data.funding[coin] = await funding(coin, fromSec - HOUR, toSec);
      } catch (err) {
        opts.log?.(`no funding for ${coin}: ${brief(err)}`);
        data.fundingOk = false;
      }
    }
    if (coins.some((c) => !data.funding[c]?.length)) data.fundingOk = false;
    return data;
  }

  let perps = null;
  /**
   * Every Hyperliquid perp name, delisted ones included (their past prices
   * still exist). Fetched at most hourly; the last good list is kept on disk
   * for when the API can't be reached.
   */
  async function perpNames() {
    if (perps && wallNow() - perps.at < 3_600_000) return perps.names;
    try {
      const meta = await post({ type: "meta" });
      const names = (meta?.universe ?? []).map((u) => u.name).filter(Boolean);
      if (!names.length) throw new Error("empty perp list");
      perps = { at: wallNow(), names };
      writeDisk("meta/perps.json", names);
    } catch (err) {
      const saved = readDisk("meta/perps.json");
      if (!saved) throw err;
      perps = { at: wallNow(), names: saved };
    }
    return perps.names;
  }

  return { candles, funding, load, post, perpNames };
}

/**
 * A call's free-text coin, as a Hyperliquid perp: matched without regard to
 * case ("btc" is BTC, "KPEPE" is kPEPE). Null for a symbol Hyperliquid doesn't
 * list, which makes the call unscorable.
 */
export function resolveSymbol(symbol, names) {
  const want = String(symbol ?? "").trim().toLowerCase();
  if (!want) return null;
  return names.find((n) => n.toLowerCase() === want) ?? null;
}

/**
 * Lookups over loaded data. `upTo` (seconds) hides everything not yet known at
 * that moment: candles that hadn't closed, funding not yet paid. Strategies get
 * that view, so a replay can't see the future. `openBy` (seconds) keeps only
 * candles that had opened by then, and funding paid by then: scoring as of a
 * moment uses it, so whoever rebuilds a score later sees exactly the same prices.
 *
 * A lookup at t takes the first candle opening at or after t, and only within
 * one candle of t: a gap or a delisting gives null, never a price from later.
 */
export function priceBook(data, { upTo = Infinity, openBy = Infinity, useFunding = data.fundingOk } = {}) {
  const step = INTERVAL_SEC[data.interval] ?? HOUR;
  const table = {}, index = {}, funding = {};
  const paidBy = Math.min(upTo, openBy);
  for (const [coin, rows] of Object.entries(data.candles)) {
    const visible = rows.filter((r) => (r.t + step <= upTo || upTo === Infinity) && r.t <= openBy);
    table[coin] = visible;
    const f = (data.funding[coin] ?? []).filter((r) => r[0] <= paidBy);
    funding[coin] = f;
    // F(t): funding paid at hours <= t, so a position held over (S, E] pays F(E) - F(S).
    let j = 0, cum = 0;
    index[coin] = visible.map((r) => {
      while (useFunding && j < f.length && f[j][0] <= r.t) cum += f[j++][1];
      return [r.t, r.o * Math.exp(-cum)];
    });
  }
  const first = (rows, t) => {
    let lo = 0, hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((rows[mid].t ?? rows[mid][0]) < t) lo = mid + 1; else hi = mid;
    }
    const r = rows[lo];
    return r && (r.t ?? r[0]) - t < step ? r : undefined;
  };
  return {
    interval: data.interval,
    useFunding,
    /** The raw open of the first candle at or after t (within one candle), or null. */
    price(coin, t) {
      const r = first(table[coin] ?? [], t);
      return r ? r.o : null;
    },
    /** The funding-adjusted price, or null. */
    index(coin, t) {
      const r = first(index[coin] ?? [], t);
      return r ? r[1] : null;
    },
    /** For scoring.js: { coin: [[t, price], ...] }, funding-adjusted when funding is used. */
    scoringTable: index,
    candles: (coin) => table[coin] ?? [],
    funding: (coin) => funding[coin] ?? [],
  };
}

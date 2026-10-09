/**
 * Small shared pieces for the Callbook engine, API and runner: safe min/max
 * over long arrays, error text that is safe to log, IP buckets for rate
 * limits, and the counters those limits use.
 */

/**
 * Largest / smallest of an array, `empty` when there is none. A reduce, never
 * Math.max(...xs): spreading a long array overflows the call stack.
 */
export const maxOf = (xs, empty = -Infinity) => (xs.length ? xs.reduce((a, b) => (b > a ? b : a)) : empty);
export const minOf = (xs, empty = Infinity) => (xs.length ? xs.reduce((a, b) => (b < a ? b : a)) : empty);

/**
 * One line about an error, fit for a log: viem's short message, with any URL
 * removed (an RPC URL can carry an API key).
 */
export function brief(err) {
  const text = String(err?.shortMessage ?? err?.message ?? err).split("\n")[0];
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"')]+/gi, "<url>").slice(0, 300);
}

/**
 * The rate-limit bucket for a client address: IPv4 as is, IPv6 by its /64
 * (one subscriber usually holds a whole /64, so per-address limits would be
 * free to dodge). IPv4-mapped IPv6 (::ffff:1.2.3.4) counts as IPv4.
 */
export function ipBucket(ip) {
  const s = String(ip ?? "").trim().replace(/^\[|\]$/g, "").split("%")[0];
  if (!s) return "unknown";
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  if (mapped) return mapped[1];
  if (!s.includes(":")) return s;
  const [head, tail = ""] = s.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = s.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return `${groups.slice(0, 4).map((g) => (parseInt(g || "0", 16) || 0).toString(16)).join(":")}::/64`;
}

// ------------------------------------------------------------------ counters

/**
 * Fixed-window counters: hit(key, windowSec) adds one and returns the count in
 * the current window. In memory by default; with a shared store (Upstash or
 * Vercel KV, by their REST API) every server instance counts together.
 */
export function memoryCounter({ now = () => Math.floor(Date.now() / 1000) } = {}) {
  const counts = new Map();
  return {
    kind: "memory",
    async hit(key, windowSec, by = 1) {
      const t = now();
      const k = `${key}:${Math.floor(t / windowSec)}`;
      const n = (counts.get(k)?.n ?? 0) + by;
      counts.set(k, { n, until: (Math.floor(t / windowSec) + 1) * windowSec });
      if (counts.size > 50_000) for (const [kk, v] of counts) if (v.until <= t) counts.delete(kk);
      return n;
    },
    async peek(key, windowSec) {
      return counts.get(`${key}:${Math.floor(now() / windowSec)}`)?.n ?? 0;
    },
  };
}

/** Counters in Upstash / Vercel KV over REST (INCRBY + EXPIRE in one pipeline). */
export function restCounter({ url, token, prefix = "callbook:", fetch: doFetch = globalThis.fetch, now = () => Math.floor(Date.now() / 1000) }) {
  const base = url.replace(/\/$/, "");
  async function pipeline(cmds) {
    const res = await doFetch(`${base}/pipeline`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(cmds),
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) throw new Error(`counter store answered ${res.status}`);
    return res.json();
  }
  return {
    kind: "rest",
    async hit(key, windowSec, by = 1) {
      const k = `${prefix}${key}:${Math.floor(now() / windowSec)}`;
      const out = await pipeline([["INCRBY", k, String(by)], ["EXPIRE", k, String(windowSec * 2)]]);
      return Number(out?.[0]?.result ?? 0);
    },
    async peek(key, windowSec) {
      const out = await pipeline([["GET", `${prefix}${key}:${Math.floor(now() / windowSec)}`]]);
      return Number(out?.[0]?.result ?? 0);
    },
  };
}

/**
 * The counter the environment asks for: a shared store when
 * KV_REST_API_URL/KV_REST_API_TOKEN (Vercel KV) or
 * UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN are set, else memory. A
 * store that fails falls back to memory for that call, so limits still hold
 * on this instance.
 */
export function countersFromEnv(env = process.env, { now, log } = {}) {
  const memory = memoryCounter({ now });
  const url = (env.KV_REST_API_URL ?? env.UPSTASH_REDIS_REST_URL)?.trim();
  const token = (env.KV_REST_API_TOKEN ?? env.UPSTASH_REDIS_REST_TOKEN)?.trim();
  if (!url || !token) return memory;
  const shared = restCounter({ url, token, now });
  const safe = (fn) => async (...args) => {
    try {
      return await shared[fn](...args);
    } catch (err) {
      log?.(`shared counter unavailable, counting in memory: ${brief(err)}`);
      return memory[fn](...args);
    }
  };
  return { kind: "rest", hit: safe("hit"), peek: safe("peek") };
}

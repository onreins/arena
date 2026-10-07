/**
 * The coins a call can name: Hyperliquid perpetuals, from the public info API
 * (metaAndAssetCtxs), cached for a minute. `names()` is every perp ever
 * listed, delisted ones included: recovering an old call has to try them too.
 */
import { HYPERLIQUID_INFO, resolveSymbol } from "../app/verify/callbook-prices.js";
import { CallbookError } from "./errors.js";

const TTL_MS = 60_000;
/** "Liquid": at least this much traded in the last 24h. */
export const MIN_VOLUME_USD = 1_000_000;

const num = (x) => (x == null || x === "" || !Number.isFinite(Number(x)) ? null : Number(x));

/** Parse a metaAndAssetCtxs answer: [{ coin, volumeUsd, price, funding, maxLeverage, delisted }]. */
export function parsePerps(payload) {
  const universe = payload?.[0]?.universe ?? [];
  const ctxs = payload?.[1] ?? [];
  return universe.map((u, i) => {
    const c = ctxs[i] ?? {};
    return {
      coin: u.name, volumeUsd: num(c.dayNtlVlm) ?? 0, price: num(c.markPx), funding: num(c.funding),
      maxLeverage: u.maxLeverage ?? null, delisted: Boolean(u.isDelisted),
    };
  }).filter((p) => p.coin);
}

/**
 * opts: { fetch, url, ttlMs, now () => ms }
 * Returns { perps(), list({ minVolumeUsd, limit }), names(), resolve(symbol) }.
 */
export function createMarkets(opts = {}) {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const url = opts.url ?? HYPERLIQUID_INFO;
  const ttl = opts.ttlMs ?? TTL_MS;
  const now = opts.now ?? (() => Date.now());
  let cache = null, inflight = null;

  async function perps() {
    if (cache && now() - cache.at < ttl) return cache.perps;
    inflight ??= (async () => {
      try {
        const res = await doFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "metaAndAssetCtxs" }) });
        if (!res.ok) throw new Error(`Hyperliquid answered ${res.status}`);
        const list = parsePerps(await res.json());
        if (!list.length) throw new Error("Hyperliquid listed no perps");
        cache = { at: now(), perps: list };
        return list;
      } catch (err) {
        if (cache) return cache.perps; // a stale list beats none
        throw new CallbookError(`Can't load Hyperliquid's markets right now (${err.message}). Try again in a moment.`, "Markets");
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  return {
    perps,
    /** Liquid perps, most traded first. */
    async list({ minVolumeUsd = MIN_VOLUME_USD, limit = 50 } = {}) {
      return (await perps())
        .filter((p) => !p.delisted && p.volumeUsd >= minVolumeUsd)
        .sort((a, b) => b.volumeUsd - a.volumeUsd)
        .slice(0, limit);
    },
    /** Every perp name ever listed, most traded first (so a search finds popular coins sooner). */
    async names() {
      return [...(await perps())].sort((a, b) => b.volumeUsd - a.volumeUsd).map((p) => p.coin);
    },
    /** The listed spelling of a symbol ("eth" -> "ETH", "kpepe" -> "kPEPE"), or null. */
    async resolve(symbol) {
      const live = (await perps()).filter((p) => !p.delisted).map((p) => p.coin);
      return resolveSymbol(symbol, live);
    },
  };
}

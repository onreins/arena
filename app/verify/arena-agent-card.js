/**
 * The name and description in an ERC-8004 agent's registration file, for a
 * book that links the agent and has no Arena profile of its own.
 *
 * The file's address is whatever the agent's owner set (`tokenURI`), so it's
 * fetched carefully, and never on the path of a page view:
 *   - https://, ipfs:// (through one fixed gateway) or data:application/json
 *   - never a private, loopback or link-local address: the address is checked
 *     when the connection is made (safeLookup), so a second DNS answer can't
 *     swap in another one; and no redirects
 *   - every step has a deadline: the tokenURI read, DNS, and the download
 *     (5 seconds and 64 KB at most)
 *   - in the background: `peek` answers from the cache at once and starts at
 *     most 4 reads, so a slow host never holds up the index; the next
 *     rebuild picks the card up
 *   - one read per agent a day; a failure is cached as "no card" for an hour
 * Only `name` and `description` are kept, and arena-names.js still decides
 * whether they're shown. Pictures are ignored.
 */
import { lookup as dnsLookup } from "node:dns";
import { BlockList, isIP } from "node:net";
import https from "node:https";

export const AGENT_CARD_LIMITS = Object.freeze({
  timeoutMs: 5_000, maxBytes: 64 * 1024, ttlMs: 24 * 3_600_000, failTtlMs: 3_600_000, maxUriBytes: 2_048, concurrency: 4,
});
export const IPFS_GATEWAY = "https://ipfs.io/ipfs/";

// Everything a server must never be pointed at: private, loopback, link-local,
// shared, benchmarking, multicast and reserved ranges, and the IPv6 forms that
// embed an IPv4 address (mapped, NAT64, 6to4).
// Two lists: node checks an IPv4 address against IPv6 rules too (as ::ffff:a.b.c.d),
// so the IPv4-mapped rule would otherwise block every IPv4 address.
const BLOCKED_V4 = new BlockList();
for (const [net, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3]]) {
  BLOCKED_V4.addSubnet(net, bits, "ipv4");
}
const BLOCKED_V6 = new BlockList();
for (const [net, bits] of [["::", 96], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["100::", 64], ["2001:db8::", 32], ["2002::", 16],
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]]) {
  BLOCKED_V6.addSubnet(net, bits, "ipv6");
}

/** True for addresses a server must never be pointed at (and for anything that isn't an IP). */
export function isPrivateAddress(ip) {
  const v = isIP(ip);
  if (v === 4) return BLOCKED_V4.check(ip, "ipv4");
  if (v === 6) return BLOCKED_V6.check(ip, "ipv6");
  return true;
}

/**
 * A `lookup` for node's https: resolves, and refuses the connection if any
 * answer is a private address. It runs at connect time, so the address
 * checked is the address used.
 */
export function safeLookup(resolve = dnsLookup) {
  return (host, opts, cb) => {
    resolve(host, { all: true }, (err, addrs) => {
      if (err) return cb(err);
      const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: isIP(addrs) }];
      if (!list.length || list.some((a) => isPrivateAddress(a.address))) return cb(new Error(`${host} isn't a public address`));
      return opts?.all ? cb(null, list) : cb(null, list[0].address, list[0].family);
    });
  };
}

/** GET an https URL through safeLookup: no redirects, a deadline, a size cap. Resolves to the body text. */
export function safeGet(url, { timeoutMs = AGENT_CARD_LIMITS.timeoutMs, maxBytes = AGENT_CARD_LIMITS.maxBytes, lookup = safeLookup() } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== "https:") return reject(new Error("https only"));
    if (isIP(u.hostname.replace(/^\[|\]$/g, "")) && isPrivateAddress(u.hostname.replace(/^\[|\]$/g, ""))) return reject(new Error(`${u.hostname} isn't a public address`));
    const req = https.get(u, { lookup, headers: { accept: "application/json" }, timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); } // a redirect is a refusal
      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(new Error(`the registration file is over ${maxBytes} bytes`)); return; }
        chunks.push(c);
      });
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    });
    const timer = setTimeout(() => req.destroy(new Error("timed out")), timeoutMs);
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.on("close", () => clearTimeout(timer));
  });
}

/** The https URL to fetch for a tokenURI, the text of an inline data: URI, or null. */
export function cardSource(uri) {
  const s = String(uri ?? "").trim();
  if (!s || s.length > AGENT_CARD_LIMITS.maxUriBytes) return null;
  const data = /^data:application\/json(;charset=utf-8)?(;base64)?,(.*)$/is.exec(s);
  if (data) {
    try {
      return { inline: data[2] ? Buffer.from(data[3], "base64").toString("utf8") : decodeURIComponent(data[3]) };
    } catch {
      return null;
    }
  }
  const ipfs = /^ipfs:\/\/(?:ipfs\/)?([A-Za-z0-9]+(?:\/[\w.\-/]*)?)$/.exec(s);
  if (ipfs) return { url: `${IPFS_GATEWAY}${ipfs[1]}` };
  try {
    const u = new URL(s);
    return u.protocol === "https:" && !u.username && !u.password ? { url: u.toString() } : null;
  } catch {
    return null;
  }
}

/** { name, description } from a registration file's text, or null. */
export function parseCard(text) {
  try {
    const j = JSON.parse(text);
    if (!j || typeof j.name !== "string" || !j.name.trim()) return null;
    return { name: j.name.slice(0, 200), description: typeof j.description === "string" ? j.description.slice(0, 1_000) : "" };
  } catch {
    return null;
  }
}

const within = (ms, p, what) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms).unref?.())]);

/**
 * opts: { tokenUri: async (agentId) => string, get? (url, limits) => text, now?, limits? }
 * Returns { card, peek }:
 *   card(agentId)  waits for the card (scripts and tests)
 *   peek(agentId)  the cached card, or null while a background read fills it in
 */
export function createAgentCards({ tokenUri, get = safeGet, now = Date.now, limits = {} }) {
  const L = { ...AGENT_CARD_LIMITS, ...limits };
  const cache = new Map();
  const inFlight = new Map();
  const queue = [];
  let running = 0;

  async function fetchCard(agentId) {
    const source = cardSource(await within(L.timeoutMs, tokenUri(agentId), "the tokenURI read"));
    if (!source) return null;
    if (source.inline != null) return parseCard(source.inline);
    return parseCard(await within(L.timeoutMs * 2, get(source.url, { timeoutMs: L.timeoutMs, maxBytes: L.maxBytes }), "the download"));
  }

  function read(key) {
    if (inFlight.has(key)) return inFlight.get(key);
    const p = new Promise((resolve) => queue.push(resolve)).then(async () => {
      running++;
      try {
        const card = await fetchCard(key);
        cache.set(key, { card, until: now() + L.ttlMs });
        return card;
      } catch (err) {
        cache.set(key, { card: null, until: now() + L.failTtlMs });
        throw err;
      } finally {
        running--;
        inFlight.delete(key);
        pump();
      }
    });
    inFlight.set(key, p);
    pump();
    return p;
  }
  function pump() {
    while (running < L.concurrency && queue.length) queue.shift()();
  }
  const fresh = (key) => {
    const hit = cache.get(key);
    return hit && hit.until > now() ? hit : null;
  };

  return {
    async card(agentId) {
      const key = String(agentId);
      const hit = fresh(key);
      return hit ? hit.card : read(key);
    },
    peek(agentId) {
      const key = String(agentId);
      const hit = fresh(key);
      if (hit) return hit.card;
      read(key).catch(() => {}); // cached as "no card" for an hour on failure
      return cache.get(key)?.card ?? null; // a stale card beats none while it refreshes
    },
  };
}

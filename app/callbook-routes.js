/**
 * Callbook's HTTP surface, mounted by app/server.js (and so by the Vercel
 * function in api/index.js, which serves the same app).
 *
 *   GET /api/callbook               every book and caller, the totals and the feed
 *   GET /api/callbook/book/:id      one book with every period
 *   GET /api/callbook/caller/:id    one caller (an open-call book) with every call
 *   GET /api/callbook/report/:id    the canonical report a validation response
 *       ?asOf=<unix seconds>        points to; its keccak256 is the responseHash
 *                                   (cached by id and asOf; 30 a minute per client)
 *   POST /api/callbook/relay/lock   gasless lock: { account, callHash, horizon, deadline, signature }
 *   POST /api/callbook/relay/seal   gasless seal: { bookId, p, callHash, deadline, signature }
 *   POST /api/callbook/relay/reveal any reveal, with its preimage
 *   POST /api/callbook/relay/profile gasless profile: { account, bookId, name, bio, link, deadline, signature }
 *   (the relay routes answer 503 unless CALLBOOK_RELAYER_KEY is set; see app/verify/callbook-relay.js)
 *
 * Read from the network in CALLBOOK_NETWORK (see app/verify/callbook-network.js),
 * cached in memory for a minute; chain reads start from the runner's state
 * snapshot when there is one, and carry on from the last block seen. With
 * nothing configured, the index, book and caller routes redirect to the
 * static export in app/public/data, and the report route answers 404.
 *
 * Client addresses for rate limits come from req.ip, which honours the app's
 * TRUST_PROXY setting (app/server.js). On Vercel set TRUST_PROXY=1: Vercel
 * overwrites X-Forwarded-For with the real client address, and trusting one
 * hop reads exactly that. Without it every visitor shares the proxy's address.
 * IPv6 clients are limited by /64.
 */
import { existsSync, readFileSync } from "node:fs";
import { createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { readCallbook, buildCallbook, evaluateAny, stateFromSnapshot } from "./verify/callbook.js";
import { createPriceSource } from "./verify/callbook-prices.js";
import { callbookNetwork, clientFor, arenaEnv } from "./verify/callbook-network.js";
import { createRelayer, RelayError } from "./verify/callbook-relay.js";
import { createAgentCards } from "./verify/arena-agent-card.js";
import { countersFromEnv, ipBucket, brief } from "./verify/callbook-util.js";
import { artifact } from "../scripts/artifact.js";

const TTL_MS = 60_000;
const ID_RE = /^\d{1,12}$/;
const REPORT_CACHE = 200;
const REPORTS_PER_MINUTE = 30;
const VIEWS = parseAbi([
  "function identityRegistry() view returns (address)",
  "function ownerOf(uint256 agentId) view returns (address)",
  "function tokenURI(uint256 agentId) view returns (string)",
]);

export function mountCallbook(app, { env: rawEnv = process.env, source, now = () => Math.floor(Date.now() / 1000) } = {}) {
  const env = arenaEnv(rawEnv); // ARENA_X settings are read as CALLBOOK_X
  const log = (m) => console.error("[callbook]", m);
  let net = null, setupError = null;
  try {
    net = callbookNetwork(env);
    if (net?.validationOff) log(net.validationOff);
  } catch (err) {
    setupError = err.message;
    log(err.message);
  }

  const prices = source ?? createPriceSource({ log: (m) => console.error("[callbook prices]", m) });
  const counter = countersFromEnv(env, { now, log });
  let client = null, chainState = null, cache = null, building = null, identity;

  /** The runner's last snapshot, if it matches what we read: a cold start continues from there. */
  async function initialState() {
    if (!net.stateFile || !existsSync(net.stateFile)) return null;
    return stateFromSnapshot(readFileSync(net.stateFile, "utf8"), {
      address: net.address, chainId: await client.getChainId(), validationRegistry: net.registry, validator: net.validator,
    });
  }

  // One chain read at a time: two reads continuing the same state would apply the same logs twice.
  let reading = Promise.resolve();
  function chain() {
    const next = reading.then(async () => {
      client ??= clientFor(net);
      if (!chainState) chainState = await initialState().catch(() => null);
      chainState = await readCallbook({
        client, address: net.address, fromBlock: net.fromBlock, validationRegistry: net.registry ?? undefined,
        validator: net.validator ?? undefined, state: chainState,
      });
      return chainState;
    });
    reading = next.catch(() => {});
    return next;
  }

  /** The current owner of an ERC-8004 agent, to flag books whose agent has moved. */
  async function agentOwner(agentId) {
    if (identity === undefined) identity = await client.readContract({ address: net.address, abi: VIEWS, functionName: "identityRegistry" }).catch(() => null);
    if (!identity || /^0x0+$/.test(identity)) return null;
    return client.readContract({ address: identity, abi: VIEWS, functionName: "ownerOf", args: [BigInt(agentId)] });
  }

  /**
   * The name in a linked agent's ERC-8004 registration file (cached a day; see arena-agent-card.js).
   * The index only peeks: a card being read in the background shows on the next rebuild.
   */
  const agentCards = createAgentCards({
    tokenUri: async (agentId) => {
      if (identity === undefined) identity = await client.readContract({ address: net.address, abi: VIEWS, functionName: "identityRegistry" }).catch(() => null);
      if (!identity || /^0x0+$/.test(identity)) return null;
      return client.readContract({ address: identity, abi: VIEWS, functionName: "tokenURI", args: [BigInt(agentId)] });
    },
  });
  const agentCard = (agentId) => agentCards.peek(agentId);

  /** Everything, rebuilt at most once a minute; concurrent requests share one build. */
  async function current() {
    if (cache && Date.now() - cache.at < TTL_MS) return cache;
    building ??= (async () => {
      try {
        const state = await chain();
        const meta = {
          mode: net.local ? "replay" : "live", network: net.label, chainId: state.chainId, explorer: net.explorer,
          contract: net.address.toLowerCase(), validationRegistry: net.registry?.toLowerCase() ?? null,
        };
        const built = await buildCallbook({
          chain: state, source: prices, asOf: now(), meta, validator: net.validator ?? undefined, reportBase: env.CALLBOOK_REPORT_BASE,
          log, ours: net.ours, agentOwner, agentCard,
        });
        cache = { at: Date.now(), ...built };
        return cache;
      } finally {
        building = null;
      }
    })();
    return building;
  }

  const off = (res) => res.status(404).json({ error: setupError ? "Callbook is misconfigured on this server" : "Callbook isn't configured on this server" });
  const fail = (res, err) => {
    log(brief(err));
    res.status(502).json({ error: "couldn't read Callbook right now" });
  };

  // With no network configured, the routes point at the static export, so a
  // page loads it without an error in the browser's console.
  app.get("/api/callbook", async (_req, res) => {
    if (!net) return setupError ? off(res) : res.redirect(302, "/data/callbook.json");
    try {
      res.set("cache-control", "public, max-age=30").json((await current()).index);
    } catch (err) {
      fail(res, err);
    }
  });

  const detailRoute = (kind, staticName, pick) => async (req, res) => {
    if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: `a ${kind} id is a number` });
    if (!net) return setupError ? off(res) : res.redirect(302, `/data/${staticName}-${Number(req.params.id)}.json`);
    try {
      const found = pick(await current()).get(String(Number(req.params.id)));
      if (!found) return res.status(404).json({ error: `no such ${kind}` });
      res.set("cache-control", "public, max-age=30").json(found);
    } catch (err) {
      fail(res, err);
    }
  };
  app.get("/api/callbook/book/:id", detailRoute("book", "callbook-book", (c) => c.details));
  app.get("/api/callbook/caller/:id", detailRoute("caller", "callbook-caller", (c) => c.callerDetails));

  // Reports are deterministic for a given (book, asOf): keep the latest few, and
  // limit how often one client can make us build a new one.
  const reports = new Map();
  app.get("/api/callbook/report/:id", async (req, res) => {
    if (!net) return off(res);
    const asOf = Number(req.query.asOf ?? now());
    if (!ID_RE.test(req.params.id) || !Number.isInteger(asOf) || asOf <= 0 || asOf > now()) {
      return res.status(400).json({ error: "pass a book id and an asOf in the past (unix seconds)" });
    }
    const key = `${Number(req.params.id)}:${asOf}`;
    try {
      let rep = reports.get(key);
      if (!rep) {
        if ((await counter.hit(`report:${ipBucket(req.ip)}`, 60)) > REPORTS_PER_MINUTE) return res.status(429).json({ error: "too many report requests; try again in a minute" });
        const state = await chain();
        const book = state.books.get(Number(req.params.id));
        if (!book) return res.status(404).json({ error: "no such book" });
        const ev = await evaluateAny({ chain: state, book, source: prices, asOf });
        rep = { hash: ev.report.hash, text: ev.report.text };
        reports.set(key, rep);
        if (reports.size > REPORT_CACHE) reports.delete(reports.keys().next().value);
      }
      // The exact text whose keccak256 is the report hash.
      res.set("x-report-hash", rep.hash).set("cache-control", "public, max-age=3600").type("application/json").send(rep.text);
    } catch (err) {
      fail(res, err);
    }
  });

  // ---------------------------------------------------------------- the relayer
  let relayer = null, relayOff = null;
  if (!net) relayOff = "Callbook isn't configured on this server";
  else if (!/^0x[0-9a-fA-F]{64}$/.test(env.CALLBOOK_RELAYER_KEY ?? "")) relayOff = "the gasless relayer is off on this server (no relayer key configured)";
  // On Vercel each instance has its own memory: limits and the gas budget only hold with shared counters.
  else if (env.VERCEL && counter.kind !== "rest") { relayOff = "the gasless relayer is off on this server (no shared rate-limit store configured)"; log("relay off: set KV_REST_API_URL and KV_REST_API_TOKEN for shared rate limits on Vercel"); }
  const getRelayer = async () => {
    if (relayer) return relayer;
    client ??= clientFor(net);
    const wallet = createWalletClient({ account: privateKeyToAccount(env.CALLBOOK_RELAYER_KEY), chain: net.chain, transport: http(net.rpc) });
    relayer = createRelayer({
      publicClient: client, wallet, callbook: net.address, abi: artifact("Callbook").abi, chainId: await client.getChainId(),
      limits: env.CALLBOOK_RELAYER_DAILY_USDC ? { dailyBudgetUsdc: Number(env.CALLBOOK_RELAYER_DAILY_USDC) } : {}, now, counter,
      log: (m) => console.error("[callbook relay]", m),
    });
    return relayer;
  };
  for (const action of ["lock", "seal", "reveal", "profile"]) {
    app.post(`/api/callbook/relay/${action}`, async (req, res) => {
      if (relayOff) return res.status(503).json({ error: relayOff });
      try {
        const r = await getRelayer();
        res.json(await r[action](req.body ?? {}, { ip: req.ip }));
        // The next read shows the new call. A name waits for the next minute's rebuild: it's cheap to send, so it's no reason to rebuild.
        if (action !== "profile") cache = null;
      } catch (err) {
        if (err instanceof RelayError) return res.status(err.status).json({ error: err.message, ...err.extra });
        log(`relay ${action}: ${brief(err)}`);
        res.status(502).json({ error: "the relayer couldn't send that right now" });
      }
    });
  }
}

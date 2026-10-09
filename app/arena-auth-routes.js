/**
 * Google sign-in through Circle's user-controlled wallets: a wallet on Arc
 * that Circle keeps for the person, unlocked by their Google account. The
 * browser runs the Circle Web SDK (app/public/circle-auth.js); these routes
 * make the calls that need our Circle API key, and store nothing.
 *
 *   GET  /api/auth/config                                   { google, circleAppId, googleClientId }
 *   POST /api/auth/circle/device  { deviceId }              -> { deviceToken, deviceEncryptionKey }
 *   POST /api/auth/circle/wallet  { userToken }             -> { address, walletId } or { challengeId }
 *   POST /api/auth/circle/sign    { userToken, walletId, typedData } -> { challengeId }
 *
 * Off (the Google button hides) unless CIRCLE_API_KEY and CIRCLE_APP_ID are
 * set, with GOOGLE_CLIENT_ID for the button. Wallets are EOAs: their
 * signatures are plain ECDSA, which the relayer and contract check directly.
 * Only Arena's own messages (domain "Arena") are signed through here.
 */
import { randomUUID } from "node:crypto";

import { countersFromEnv, ipBucket, brief } from "./verify/callbook-util.js";
import { arenaEnv, callbookNetwork } from "./verify/callbook-network.js";

const CIRCLE = "https://api.circle.com";
const HOUR = 3_600;
export const AUTH_LIMITS = Object.freeze({ requestsPerIpHour: 120, timeoutMs: 10_000, maxTypedDataBytes: 8_192 });
/**
 * The Arena messages a Google wallet may sign here (contracts/Callbook.sol),
 * field by field. A request is rebuilt from these, never passed through, so
 * Circle only ever shows the person one of Arena's own messages.
 */
const ADDRESS = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
const UINT = (v) => (typeof v === "string" || typeof v === "number") && /^\d{1,78}$/.test(String(v));
const TEXT = (max) => (v) => typeof v === "string" && Buffer.byteLength(v) <= max;
const MESSAGES = Object.freeze({
  LinkAgent: [["agent", "address", ADDRESS], ["wallet", "address", ADDRESS], ["nonce", "uint256", UINT], ["deadline", "uint256", UINT]],
  UnlinkAgent: [["agent", "address", ADDRESS], ["nonce", "uint256", UINT], ["deadline", "uint256", UINT]],
  SetProfile: [["account", "address", ADDRESS], ["bookId", "uint256", UINT], ["name", "string", TEXT(32)], ["bio", "string", TEXT(160)],
    ["link", "string", TEXT(100)], ["nonce", "uint256", UINT], ["deadline", "uint256", UINT]],
});
export const SIGNABLE = Object.freeze(Object.keys(MESSAGES));
const DOMAIN_TYPE = [
  { name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
];

/** The typed data to sign, rebuilt from MESSAGES for this deployment's domain; throws a sentence otherwise. */
export function arenaTypedData(input, domain) {
  const fields = MESSAGES[input?.primaryType];
  if (!fields) throw new Error(`only Arena's own messages (${SIGNABLE.join(", ")}) are signed here`);
  const d = input.domain ?? {};
  if (d.name !== "Arena" || String(d.version) !== "1" || Number(d.chainId) !== domain.chainId || String(d.verifyingContract ?? "").toLowerCase() !== domain.verifyingContract.toLowerCase()) {
    throw new Error("that message isn't for this Arena contract and chain");
  }
  const m = input.message ?? {};
  const extra = Object.keys(m).filter((k) => !fields.some(([name]) => name === k));
  if (extra.length) throw new Error(`unexpected fields: ${extra.join(", ")}`);
  const message = {};
  for (const [name, , ok] of fields) {
    if (!ok(m[name])) throw new Error(`${name} is missing or malformed`);
    message[name] = typeof m[name] === "number" ? String(m[name]) : m[name];
  }
  return {
    types: { EIP712Domain: DOMAIN_TYPE, [input.primaryType]: fields.map(([name, type]) => ({ name, type })) },
    primaryType: input.primaryType,
    domain: { name: "Arena", version: "1", chainId: domain.chainId, verifyingContract: domain.verifyingContract },
    message,
  };
}
/** Circle's code for "this user already has wallets". */
const ALREADY_INITIALIZED = 155106;

class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const refuse = (m) => new AuthError(400, m);

/** opts: { env, fetchImpl?, now? } */
export function mountAuth(app, { env: rawEnv = process.env, fetchImpl = fetch, now } = {}) {
  const env = arenaEnv(rawEnv);
  // Trimmed: a value pasted into a dashboard often carries a stray tab or space, which Circle and Google refuse.
  const apiKey = String(rawEnv.CIRCLE_API_KEY || "").trim();
  const appId = String(rawEnv.CIRCLE_APP_ID || "").trim();
  const googleClientId = String(rawEnv.GOOGLE_CLIENT_ID || "").trim();
  const blockchain = env.CALLBOOK_NETWORK === "mainnet" ? "ARC" : "ARC-TESTNET";
  // Shared counters, as the relayer uses: on Vercel each instance would count alone, so without
  // a shared store Google sign-in stays off rather than let anyone spend our Circle quota.
  const counts = countersFromEnv(rawEnv, { now });
  const sharedOk = !rawEnv.VERCEL || counts.kind === "rest";
  let domain = null;
  try {
    const net = callbookNetwork(rawEnv);
    if (net) domain = { chainId: net.chain.id, verifyingContract: net.address };
  } catch { /* no Arena deployment configured: nothing can be signed */ }
  const on = Boolean(apiKey && appId && googleClientId && sharedOk);

  app.get("/api/auth/config", (_req, res) => {
    res.set("cache-control", "no-store");
    res.json(on ? { google: true, circleAppId: appId, googleClientId, blockchain } : { google: false });
  });

  /** One call to Circle's API; its error message, or ours, as an AuthError. */
  async function circle(method, path, { userToken, body } = {}) {
    let res;
    try {
      res = await fetchImpl(`${CIRCLE}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${apiKey}`, accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
          ...(userToken ? { "x-user-token": userToken } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(AUTH_LIMITS.timeoutMs),
      });
    } catch (err) {
      throw new AuthError(502, `Circle didn't answer (${brief(err)}). Try again in a moment.`);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new AuthError(res.status === 401 || res.status === 403 ? 401 : 502, json.message || `Circle refused that (HTTP ${res.status}).`);
      e.code = json.code;
      throw e;
    }
    return json.data ?? {};
  }

  const token = (t) => {
    if (typeof t !== "string" || t.length < 20 || t.length > 4_096 || /\s/.test(t)) throw refuse("userToken is missing or malformed");
    return t;
  };

  function route(path, fn) {
    app.post(path, async (req, res) => {
      if (!on) return res.status(404).json({ error: "Google sign-in isn't set up on this server." });
      res.set("cache-control", "no-store");
      try {
        const bucket = req.ip ? ipBucket(req.ip) : "none";
        if ((await counts.hit(`auth:${bucket}`, HOUR)) > AUTH_LIMITS.requestsPerIpHour) throw new AuthError(429, "Too many sign-in requests from this address; try again later.");
        res.json(await fn(req.body ?? {}));
      } catch (err) {
        if (err instanceof AuthError) return res.status(err.status).json({ error: err.message });
        res.status(500).json({ error: "Sign-in failed on our side. Try again." });
      }
    });
  }

  route("/api/auth/circle/device", async ({ deviceId }) => {
    if (typeof deviceId !== "string" || !/^[\w-]{6,200}$/.test(deviceId)) throw refuse("deviceId is missing or malformed");
    const d = await circle("POST", "/v1/w3s/users/social/token", { body: { idempotencyKey: randomUUID(), deviceId } });
    if (!d.deviceToken || !d.deviceEncryptionKey) throw new AuthError(502, "Circle didn't return a device token.");
    return { deviceToken: d.deviceToken, deviceEncryptionKey: d.deviceEncryptionKey };
  });

  /** The person's Arena wallet, or the challenge that creates it on first sign-in. */
  route("/api/auth/circle/wallet", async ({ userToken }) => {
    const t = token(userToken);
    const pick = (list) => (list ?? []).find((w) => w.blockchain === blockchain && /^0x[0-9a-fA-F]{40}$/.test(w.address ?? ""));
    const found = pick((await circle("GET", "/v1/w3s/wallets", { userToken: t })).wallets);
    if (found) return { address: found.address.toLowerCase(), walletId: found.id };
    try {
      const init = await circle("POST", "/v1/w3s/user/initialize", { userToken: t, body: { idempotencyKey: randomUUID(), accountType: "EOA", blockchains: [blockchain] } });
      if (!init.challengeId) throw new AuthError(502, "Circle didn't return a challenge.");
      return { challengeId: init.challengeId };
    } catch (err) {
      if (err.code !== ALREADY_INITIALIZED) throw err;
      // Initialized, but without an Arena wallet on this network: create one.
      const made = await circle("POST", "/v1/w3s/user/wallets", { userToken: t, body: { idempotencyKey: randomUUID(), accountType: "EOA", blockchains: [blockchain] } });
      if (!made.challengeId) throw new AuthError(502, "Circle didn't return a challenge.");
      return { challengeId: made.challengeId };
    }
  });

  /** A challenge for an EIP-712 signature of one of Arena's own messages. */
  route("/api/auth/circle/sign", async ({ userToken, walletId, typedData }) => {
    const t = token(userToken);
    if (typeof walletId !== "string" || !/^[0-9a-f-]{36}$/i.test(walletId)) throw refuse("walletId is missing or malformed");
    if (!typedData || typeof typedData !== "object") throw refuse("typedData must be an object");
    if (JSON.stringify(typedData).length > AUTH_LIMITS.maxTypedDataBytes) throw refuse("typedData is too large");
    if (!domain) throw new AuthError(503, "Arena isn't configured on this server, so there's nothing to sign.");
    let typed;
    try {
      typed = arenaTypedData(typedData, domain);
    } catch (err) {
      throw refuse(err.message);
    }
    const d = await circle("POST", "/v1/w3s/user/sign/typedData", { userToken: t, body: { walletId, data: JSON.stringify(typed), memo: `Arena: ${typed.primaryType}` } });
    if (!d.challengeId) throw new AuthError(502, "Circle didn't return a challenge.");
    return { challengeId: d.challengeId };
  });

  return { on, blockchain };
}

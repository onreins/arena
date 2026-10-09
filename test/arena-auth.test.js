// Google sign-in routes (app/arena-auth-routes.js) against a fake Circle API:
// off without settings, input checked before Circle is called, the wallet
// found or created as an EOA on Arc, and only Arena's own messages signed.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { readFileSync } from "node:fs";

import { mountAuth, SIGNABLE } from "../app/arena-auth-routes.js";

const ON = { CIRCLE_API_KEY: "TEST_API_KEY:abc:def", CIRCLE_APP_ID: "app-123", GOOGLE_CLIENT_ID: "google-client.apps.googleusercontent.com", ARENA_NETWORK: "testnet" };
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.signature";
const WALLET_ID = "0b3f9d2e-1111-4222-8333-944455556666";
const ADDR = "0x14dc79964da2c08b23698b3d3cc7ca32193d9955";
// The testnet deployment the routes read (ARENA_NETWORK=testnet): signed messages must name it.
const CONTRACT = JSON.parse(readFileSync(new URL("../deployments/callbook-testnet.json", import.meta.url), "utf8")).contracts.callbook;

/** A fake Circle: answers by path, records every call. */
function fakeCircle(routes) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: opts.method, headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : null });
    const answer = routes[`${opts.method} ${path}`];
    const [status, json] = typeof answer === "function" ? answer(calls.at(-1)) : answer ?? [404, { message: "not found" }];
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl };
}

async function serve(env, routes = {}) {
  const app = express();
  app.use(express.json());
  const circle = fakeCircle(routes);
  mountAuth(app, { env, fetchImpl: circle.fetchImpl });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => {
    const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  return { base, post, calls: circle.calls, close: () => server.close() };
}

test("off without the Circle settings: the config says so and the routes are 404", async () => {
  const s = await serve({ CIRCLE_API_KEY: "x" });
  try {
    assert.deepEqual(await (await fetch(s.base + "/api/auth/config")).json(), { google: false });
    assert.equal((await s.post("/api/auth/circle/device", { deviceId: "device-123" })).status, 404);
    assert.equal(s.calls.length, 0);
  } finally { s.close(); }
});

test("the config shares only public values, and names Arc's chain for the network", async () => {
  const s = await serve(ON);
  try {
    const c = await (await fetch(s.base + "/api/auth/config")).json();
    assert.deepEqual(c, { google: true, circleAppId: "app-123", googleClientId: ON.GOOGLE_CLIENT_ID, blockchain: "ARC-TESTNET" });
    assert.ok(!JSON.stringify(c).includes("TEST_API_KEY"), "the API key never leaves the server");
  } finally { s.close(); }
  const m = await serve({ ...ON, ARENA_NETWORK: "mainnet" });
  try { assert.equal((await (await fetch(m.base + "/api/auth/config")).json()).blockchain, "ARC"); } finally { m.close(); }
});

test("settings pasted with a stray tab or space still work", async () => {
  const s = await serve({ ...ON, CIRCLE_APP_ID: "\tapp-123 ", GOOGLE_CLIENT_ID: ` ${ON.GOOGLE_CLIENT_ID}\n`, ARENA_NETWORK: " testnet\t" });
  try {
    const c = await (await fetch(s.base + "/api/auth/config")).json();
    assert.deepEqual(c, { google: true, circleAppId: "app-123", googleClientId: ON.GOOGLE_CLIENT_ID, blockchain: "ARC-TESTNET" });
  } finally { s.close(); }
});

test("device tokens: the id is checked first, then passed to Circle with the API key", async () => {
  const s = await serve(ON, { "POST /v1/w3s/users/social/token": [201, { data: { deviceToken: "dt", deviceEncryptionKey: "dek" } }] });
  try {
    assert.equal((await s.post("/api/auth/circle/device", { deviceId: "bad id with spaces" })).status, 400);
    assert.equal(s.calls.length, 0);
    const r = await s.post("/api/auth/circle/device", { deviceId: "device-123" });
    assert.deepEqual(r.json, { deviceToken: "dt", deviceEncryptionKey: "dek" });
    assert.equal(s.calls[0].headers.authorization, `Bearer ${ON.CIRCLE_API_KEY}`);
    assert.equal(s.calls[0].body.deviceId, "device-123");
    assert.match(s.calls[0].body.idempotencyKey, /^[0-9a-f-]{36}$/);
  } finally { s.close(); }
});

test("the wallet: an existing Arc wallet is returned; a new person gets an EOA on Arc to confirm", async () => {
  const s = await serve(ON, {
    "GET /v1/w3s/wallets": (c) => (c.headers["x-user-token"] === TOKEN
      ? [200, { data: { wallets: [{ id: "other", address: "0x" + "1".repeat(40), blockchain: "ETH-SEPOLIA" }, { id: WALLET_ID, address: ADDR.toUpperCase().replace("0X", "0x"), blockchain: "ARC-TESTNET" }] } }]
      : [200, { data: { wallets: [] } }]),
    "POST /v1/w3s/user/initialize": [201, { data: { challengeId: "ch-1" } }],
  });
  try {
    assert.equal((await s.post("/api/auth/circle/wallet", { userToken: "short" })).status, 400);
    assert.deepEqual((await s.post("/api/auth/circle/wallet", { userToken: TOKEN })).json, { address: ADDR, walletId: WALLET_ID });
    const fresh = await s.post("/api/auth/circle/wallet", { userToken: TOKEN + "x" });
    assert.deepEqual(fresh.json, { challengeId: "ch-1" });
    const init = s.calls.find((c) => c.path === "/v1/w3s/user/initialize");
    assert.equal(init.body.accountType, "EOA", "plain keys: the relayer and contract check them directly");
    assert.deepEqual(init.body.blockchains, ["ARC-TESTNET"]);
  } finally { s.close(); }
});

test("already initialized without an Arc wallet: one is created", async () => {
  const s = await serve(ON, {
    "GET /v1/w3s/wallets": [200, { data: { wallets: [] } }],
    "POST /v1/w3s/user/initialize": [409, { code: 155106, message: "User already initialized" }],
    "POST /v1/w3s/user/wallets": [201, { data: { challengeId: "ch-2" } }],
  });
  try {
    assert.deepEqual((await s.post("/api/auth/circle/wallet", { userToken: TOKEN })).json, { challengeId: "ch-2" });
  } finally { s.close(); }
});

test("signing: only Arena's own messages, for this deployment, rebuilt field by field", async () => {
  const s = await serve(ON, { "POST /v1/w3s/user/sign/typedData": [201, { data: { challengeId: "ch-sign" } }] });
  const domain = { name: "Arena", version: "1", chainId: 5042002, verifyingContract: CONTRACT };
  const MESSAGES = {
    LinkAgent: { agent: ADDR, wallet: "0x" + "2".repeat(40), nonce: "0", deadline: "1999999999" },
    UnlinkAgent: { agent: ADDR, nonce: "1", deadline: "1999999999" },
    SetProfile: { account: ADDR, bookId: "0", name: "Midnight", bio: "", link: "", nonce: "0", deadline: "1999999999" },
  };
  const typed = (primaryType = "LinkAgent", over = {}) => ({ domain, primaryType, types: { anything: [] }, message: MESSAGES[primaryType], ...over });
  try {
    for (const bad of [
      typed("LinkAgent", { domain: { ...domain, name: "Uniswap" } }),
      typed("LinkAgent", { domain: { ...domain, chainId: 1 } }),
      typed("LinkAgent", { domain: { ...domain, verifyingContract: "0x" + "9".repeat(40) } }),
      typed("Permit", { message: {} }),
      typed("LinkAgent", { message: { ...MESSAGES.LinkAgent, extra: "x" } }),
      typed("LinkAgent", { message: { ...MESSAGES.LinkAgent, wallet: "not-an-address" } }),
      typed("LinkAgent", { message: { pad: "x".repeat(9_000) } }),
    ]) {
      assert.equal((await s.post("/api/auth/circle/sign", { userToken: TOKEN, walletId: WALLET_ID, typedData: bad })).status, 400);
    }
    assert.equal((await s.post("/api/auth/circle/sign", { userToken: TOKEN, walletId: "not-a-uuid", typedData: typed() })).status, 400);
    assert.equal(s.calls.length, 0, "nothing reached Circle");
    for (const primaryType of SIGNABLE) {
      const r = await s.post("/api/auth/circle/sign", { userToken: TOKEN, walletId: WALLET_ID, typedData: typed(primaryType) });
      assert.deepEqual(r.json, { challengeId: "ch-sign" });
    }
    const sent = JSON.parse(s.calls[0].body.data);
    assert.equal(s.calls[0].body.walletId, WALLET_ID);
    assert.deepEqual(Object.keys(sent.types), ["EIP712Domain", "LinkAgent"], "the caller's types are replaced by Arena's own");
    assert.deepEqual(sent.types.LinkAgent.map((f) => f.name), ["agent", "wallet", "nonce", "deadline"]);
  } finally { s.close(); }
});

test("on Vercel without a shared rate-limit store, Google sign-in stays off", async () => {
  const s = await serve({ ...ON, VERCEL: "1" });
  try {
    assert.deepEqual(await (await fetch(s.base + "/api/auth/config")).json(), { google: false });
  } finally { s.close(); }
});

test("Circle's own refusal comes back as a sentence; an expired token is a 401", async () => {
  const s = await serve(ON, { "GET /v1/w3s/wallets": [401, { code: 155104, message: "Invalid user token" }] });
  try {
    const r = await s.post("/api/auth/circle/wallet", { userToken: TOKEN });
    assert.equal(r.status, 401);
    assert.equal(r.json.error, "Invalid user token");
  } finally { s.close(); }
});

// The Arena marketplace waitlist (app/arena-waitlist-routes.js): signed-in only
// (an EIP-712 JoinWaitlist signature, the same kind of check as the profile and
// link relays), input checked at the boundary, joins idempotent, public counts,
// `mine` only with a session, rate limits, and Upstash over REST when set.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";

import { mountWaitlist, WAITLIST_TYPES, SESSION_HEADER } from "../app/arena-waitlist-routes.js";
import { memoryCounter } from "../app/verify/callbook-util.js";

// Well-known local test keys (anvil's first two accounts); never used for anything real.
const ALICE = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const BOB = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const CONTRACT = JSON.parse(readFileSync(new URL("../deployments/callbook-testnet.json", import.meta.url), "utf8")).contracts.callbook;
const DOMAIN = { name: "Arena", version: "1", chainId: 5042002, verifyingContract: CONTRACT };
const ENV = { ARENA_NETWORK: "testnet" };
const NOW = 1_800_000_000;
const DAY = 86_400;

/** The header value a signed-in browser sends: account.deadline.signature */
async function pass(who, { deadline = NOW + DAY, domain = DOMAIN, account = who.address } = {}) {
  const signature = await who.signTypedData({ domain, types: WAITLIST_TYPES, primaryType: "JoinWaitlist", message: { account, deadline: BigInt(deadline) } });
  return `${account}.${deadline}.${signature}`;
}

async function serve(opts = {}) {
  const app = express();
  app.use(express.json());
  const logs = [];
  let t = NOW;
  mountWaitlist(app, { env: ENV, now: () => t, log: (m) => logs.push(m), ...opts });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/arena/waitlist`;
  const headers = (session) => ({ "content-type": "application/json", ...(session ? { [SESSION_HEADER]: session } : {}) });
  const post = async (body, session) => {
    const res = await fetch(base, { method: "POST", headers: headers(session), body: JSON.stringify(body) });
    return { status: res.status, json: await res.json(), cache: res.headers.get("cache-control") };
  };
  const get = async (session) => {
    const res = await fetch(base, { headers: headers(session) });
    return { status: res.status, json: await res.json(), cache: res.headers.get("cache-control"), vary: res.headers.get("vary") };
  };
  return { post, get, logs, tick: (s) => { t += s; }, close: () => server.close() };
}

test("signed out, or a pass that isn't valid: 401 Sign in first.", async () => {
  const s = await serve();
  try {
    const out = await s.post({ role: "subscribe", bookId: 3 });
    assert.equal(out.status, 401);
    assert.deepEqual(out.json, { ok: false, error: "Sign in first." });
    const good = await pass(ALICE);
    for (const bad of [
      "nonsense",
      good.replace(ALICE.address, BOB.address), // someone else's address on Alice's signature
      await pass(BOB, { account: ALICE.address }), // Bob signing for Alice
      await pass(ALICE, { deadline: NOW - 1 }), // expired
      await pass(ALICE, { deadline: NOW + 8 * DAY }), // too far ahead
      await pass(ALICE, { domain: { ...DOMAIN, chainId: 1 } }), // another chain
      await pass(ALICE, { domain: { ...DOMAIN, verifyingContract: "0x" + "9".repeat(40) } }), // another contract
    ]) {
      const r = await s.post({ role: "subscribe", bookId: 3 }, bad);
      assert.equal(r.status, 401, bad.slice(0, 20));
      assert.equal(r.json.error, "Sign in first.");
    }
    assert.equal((await s.get()).json.subscribe.total, 0, "nothing was stored");
  } finally { s.close(); }
});

test("bad role or bookId: 400, and the input is never echoed back", async () => {
  const s = await serve();
  const session = await pass(ALICE);
  try {
    for (const body of [
      {}, { role: "buy", bookId: 3 }, { role: "<script>x</script>", bookId: 3 }, { role: ["subscribe"], bookId: 3 },
      { role: "subscribe" }, { role: "subscribe", bookId: 0 }, { role: "subscribe", bookId: -2 }, { role: "subscribe", bookId: 1.5 },
      { role: "subscribe", bookId: "3" }, { role: "subscribe", bookId: 2 ** 53 }, { role: "subscribe", bookId: null },
      { role: "sell", bookId: "<b>x</b>" }, { role: "sell", bookId: 0 },
    ]) {
      const r = await s.post(body, session);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json.ok, false);
      assert.ok(!/script|<b>/.test(r.json.error), "no raw input in the error");
    }
  } finally { s.close(); }
});

test("join as a subscriber and as a seller; extra fields are ignored; joins are idempotent", async () => {
  const s = await serve();
  const session = await pass(ALICE);
  try {
    const sub = await s.post({ role: "subscribe", bookId: 3, email: "a@b.c", note: "hi" }, session);
    assert.equal(sub.status, 200);
    assert.equal(sub.cache, "private, no-store");
    assert.deepEqual(sub.json, {
      ok: true, joined: true,
      counts: { subscribe: { total: 1, byBook: { 3: 1 } }, sell: { total: 0 } },
      mine: { subscribe: [3], sell: false },
    });
    const sell = await s.post({ role: "sell" }, session);
    assert.deepEqual(sell.json.counts, { subscribe: { total: 1, byBook: { 3: 1 } }, sell: { total: 1 } });
    assert.deepEqual(sell.json.mine, { subscribe: [3], sell: true });
    // Again, and again: nothing changes.
    for (const body of [{ role: "subscribe", bookId: 3 }, { role: "sell" }, { role: "sell", bookId: 3 }]) {
      const r = await s.post(body, session);
      assert.equal(r.status, 200);
      assert.deepEqual(r.json.counts, { subscribe: { total: 1, byBook: { 3: 1 } }, sell: { total: 1 } });
    }
  } finally { s.close(); }
});

test("counts by book: each book counts its subscribers; the total counts people", async () => {
  const s = await serve();
  const a = await pass(ALICE), b = await pass(BOB);
  try {
    await s.post({ role: "subscribe", bookId: 3 }, a);
    await s.post({ role: "subscribe", bookId: 7 }, a);
    await s.post({ role: "subscribe", bookId: 3 }, b);
    const r = await s.get();
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.subscribe, { total: 2, byBook: { 3: 2, 7: 1 } });
    assert.deepEqual(r.json.sell, { total: 0 });
  } finally { s.close(); }
});

test("GET: public counts cached 30s anonymously; `mine` only with a valid session, then private", async () => {
  const s = await serve();
  const a = await pass(ALICE);
  try {
    await s.post({ role: "subscribe", bookId: 7 }, a);
    await s.post({ role: "subscribe", bookId: 3 }, a);
    const anon = await s.get();
    assert.equal(anon.cache, "public, max-age=30");
    assert.match(anon.vary ?? "", new RegExp(SESSION_HEADER, "i"));
    assert.equal(anon.json.ok, true);
    assert.equal("mine" in anon.json, false);
    assert.deepEqual(anon.json.domain, DOMAIN, "what the browser signs against");

    const mine = await s.get(a);
    assert.equal(mine.cache, "private, no-store");
    assert.deepEqual(mine.json.mine, { subscribe: [3, 7], sell: false });

    const forged = await s.get(a.replace(ALICE.address, BOB.address));
    assert.equal("mine" in forged.json, false, "an invalid session reads as anonymous");
    assert.equal(forged.cache, "public, max-age=30");

    const other = await s.get(await pass(BOB));
    assert.deepEqual(other.json.mine, { subscribe: [], sell: false });
  } finally { s.close(); }
});

test("rate limits: per IP, then per address", async () => {
  const ip = await serve({ limits: { joinsPerIpHour: 2, joinsPerAddressHour: 100 } });
  const a = await pass(ALICE);
  try {
    assert.equal((await ip.post({ role: "subscribe", bookId: 1 }, a)).status, 200);
    assert.equal((await ip.post({ role: "subscribe", bookId: 2 }, a)).status, 200);
    const r = await ip.post({ role: "subscribe", bookId: 3 }, a);
    assert.equal(r.status, 429);
    assert.equal(r.json.ok, false);
    assert.equal((await ip.post({ role: "subscribe", bookId: 3 })).status, 429, "the IP limit comes before anything else");
  } finally { ip.close(); }

  const addr = await serve({ limits: { joinsPerIpHour: 100, joinsPerAddressHour: 2 } });
  try {
    assert.equal((await addr.post({ role: "subscribe", bookId: 1 }, a)).status, 200);
    assert.equal((await addr.post({ role: "subscribe", bookId: 2 }, a)).status, 200);
    assert.equal((await addr.post({ role: "subscribe", bookId: 3 }, a)).status, 429);
    // Bad signatures naming Alice don't use up Alice's quota (her limit was already reached above, so check Bob's).
    const forged = (await pass(BOB)).replace(/\.0x[0-9a-f]+$/i, "." + "0x" + "1".repeat(130));
    for (let i = 0; i < 3; i++) assert.equal((await addr.post({ role: "sell" }, forged)).status, 401);
    assert.equal((await addr.post({ role: "sell" }, await pass(BOB))).status, 200);
    addr.tick(3_600);
    assert.equal((await addr.post({ role: "subscribe", bookId: 3 }, a)).status, 200, "the window moves on");
  } finally { addr.close(); }
});

test("Arena not configured: joining is off (503); counts still answer", async () => {
  const s = await serve({ env: {} });
  try {
    const r = await s.post({ role: "sell" }, await pass(ALICE));
    assert.equal(r.status, 503);
    assert.equal(r.json.ok, false);
    const g = await s.get();
    assert.equal(g.status, 200);
    assert.equal(g.json.domain, null);
  } finally { s.close(); }
});

test("on Vercel without a shared store the waitlist is off rather than kept per instance", async () => {
  const s = await serve({ env: { ...ENV, VERCEL: "1" } });
  try {
    assert.equal((await s.get()).status, 503);
    assert.equal((await s.post({ role: "sell" }, await pass(ALICE))).status, 503);
  } finally { s.close(); }
});

/** A small Upstash REST stand-in: /pipeline with the few commands the waitlist uses. */
function fakeUpstash() {
  const sets = new Map(), hashes = new Map(), calls = [];
  const set = (k) => sets.get(k) ?? sets.set(k, new Set()).get(k);
  const hash = (k) => hashes.get(k) ?? hashes.set(k, new Map()).get(k);
  const run = ([cmd, key, ...args]) => {
    switch (cmd) {
      case "SADD": { const s = set(key); const n = s.size; args.forEach((a) => s.add(a)); return s.size - n; }
      case "SCARD": return sets.get(key)?.size ?? 0;
      case "SMEMBERS": return [...(sets.get(key) ?? [])];
      case "HSETNX": { const h = hash(key); if (h.has(args[0])) return 0; h.set(args[0], args[1]); return 1; }
      default: throw new Error(`unexpected command ${cmd}`);
    }
  };
  const fetchImpl = async (url, opts) => {
    calls.push({ url, auth: opts.headers.authorization });
    if (!url.endsWith("/pipeline")) return new Response("{}", { status: 404 });
    const body = JSON.parse(opts.body);
    return new Response(JSON.stringify(body.map((c) => ({ result: run(c) }))), { status: 200 });
  };
  return { sets, hashes, calls, fetchImpl };
}

test("Upstash over REST when configured (trimmed settings); only address, role, bookId and time are stored", async () => {
  const up = fakeUpstash();
  const env = { ...ENV, VERCEL: "1", UPSTASH_REDIS_REST_URL: " https://fake-upstash.example\t", UPSTASH_REDIS_REST_TOKEN: "\ttest-token " };
  const s = await serve({ env, fetchImpl: up.fetchImpl, counters: memoryCounter({ now: () => NOW }) });
  try {
    const a = await pass(ALICE), b = await pass(BOB);
    assert.equal((await s.post({ role: "subscribe", bookId: 3, email: "x@y.z" }, a)).status, 200);
    await s.post({ role: "subscribe", bookId: 3 }, a);
    await s.post({ role: "subscribe", bookId: 3 }, b);
    await s.post({ role: "sell", bookId: 9 }, b);
    assert.ok(up.calls.length > 0 && up.calls.every((c) => c.auth === "Bearer test-token" && c.url.startsWith("https://fake-upstash.example/")));

    const g = await s.get();
    assert.deepEqual({ subscribe: g.json.subscribe, sell: g.json.sell }, { subscribe: { total: 2, byBook: { 3: 2 } }, sell: { total: 1 } });
    assert.deepEqual((await s.get(b)).json.mine, { subscribe: [3], sell: true });

    const stored = JSON.stringify([...up.sets].map(([k, v]) => [k, [...v]]).concat([...up.hashes].map(([k, v]) => [k, [...v]])));
    assert.ok(!/x@y\.z|email/.test(stored), "extra fields are never stored");
    assert.ok(stored.includes(ALICE.address.toLowerCase()) && !stored.includes(ALICE.address), "addresses are stored lowercase");
    const times = [...up.hashes.values()].flatMap((h) => [...h.values()]);
    assert.equal(times.length, 3, "one timestamp per distinct (address, role, bookId)");
    assert.ok(times.every((v) => v === String(NOW)));
  } finally { s.close(); }
});

test("a store that fails answers 503 and logs no secrets", async () => {
  const env = { ...ENV, UPSTASH_REDIS_REST_URL: "https://fake-upstash.example", UPSTASH_REDIS_REST_TOKEN: "secret-token-value" };
  const fetchImpl = async () => { throw new Error("connect ECONNREFUSED https://fake-upstash.example/pipeline?token=secret-token-value"); };
  const s = await serve({ env, fetchImpl, counters: memoryCounter({ now: () => NOW }) });
  try {
    const r = await s.post({ role: "sell" }, await pass(ALICE));
    assert.equal(r.status, 503);
    assert.equal(r.json.ok, false);
    assert.equal((await s.get()).status, 503);
    assert.ok(s.logs.length > 0);
    assert.ok(s.logs.every((l) => !l.includes("secret-token-value")), "the token never reaches the log");
  } finally { s.close(); }
});

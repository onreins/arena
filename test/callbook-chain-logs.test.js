// readCallbook against an RPC that behaves like Arc's: at most 10 event
// signatures per getLogs ("requested range too large" past that). No chain needed.
import { test } from "node:test";
import assert from "node:assert/strict";

import { readCallbook, MAX_EVENTS_PER_QUERY } from "../app/verify/callbook-chain.js";

const ADDRESS = "0x8fde4b31ac39dc05852405dc892b724244a404cb";

function arcLikeClient() {
  const calls = [];
  return {
    calls,
    getBlockNumber: async () => 120n,
    getChainId: async () => 5042002,
    getBlock: async ({ blockNumber }) => ({ number: blockNumber, timestamp: 1_700_000_000n + blockNumber }),
    getLogs: async ({ events, fromBlock, toBlock }) => {
      calls.push({ events: events.length, fromBlock, toBlock });
      if (events.length > MAX_EVENTS_PER_QUERY) throw new Error("requested range too large");
      return [];
    },
  };
}

test("reads through an RPC that caps a getLogs at 10 event signatures", async () => {
  const client = arcLikeClient();
  const state = await readCallbook({ client, address: ADDRESS, fromBlock: 100n });
  assert.equal(state.toBlock, 120n);
  assert.equal(state.books.size, 0);
  assert.ok(client.calls.length >= 2, "the events are split over more than one query");
  assert.ok(client.calls.every((c) => c.events <= MAX_EVENTS_PER_QUERY));
  assert.ok(client.calls.every((c) => c.fromBlock === 100n && c.toBlock === 120n), "no range halving was needed");
});

test("with the validation registry too, every event is still asked for", async () => {
  const client = arcLikeClient();
  await readCallbook({ client, address: ADDRESS, fromBlock: 100n, validationRegistry: "0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58" });
  const asked = client.calls.reduce((n, c) => n + c.events, 0);
  assert.ok(asked > MAX_EVENTS_PER_QUERY);
  assert.ok(client.calls.every((c) => c.events <= MAX_EVENTS_PER_QUERY));
});

// Arc's public RPC answers a burst with -32005 "rate limit exceeded". That's not
// a range it can't serve: halving the range only makes more requests.
function rateLimited(message = "rate limit exceeded") {
  const err = new Error("Request exceeds defined limit.");
  err.code = -32005;
  err.cause = { code: -32005, message };
  return err;
}

test("a rate limit waits and asks for the same range again, without halving it", async () => {
  const client = arcLikeClient();
  const inner = client.getLogs;
  let refusals = 2;
  client.getLogs = async (q) => {
    if (refusals-- > 0) { client.calls.push({ refused: true, ...q }); throw rateLimited(); }
    return inner(q);
  };
  const waits = [];
  const state = await readCallbook({ client, address: ADDRESS, fromBlock: 100n, wait: async (ms) => { waits.push(ms); } });
  assert.equal(state.toBlock, 120n);
  assert.equal(waits.length, 2);
  assert.ok(waits[1] > waits[0], "it backs off");
  assert.ok(client.calls.every((c) => c.fromBlock === 100n && c.toBlock === 120n), "the range was never halved");
});

test("an RPC that stays rate limited fails with its own error instead of crawling", async () => {
  const client = arcLikeClient();
  let asked = 0;
  client.getLogs = async () => { asked++; throw rateLimited(); };
  await assert.rejects(
    readCallbook({ client, address: ADDRESS, fromBlock: 0n, wait: async () => {} }),
    (err) => /rate limit/i.test(err.cause?.message ?? err.message),
  );
  assert.ok(asked <= 10, `gave up after ${asked} tries`);
});

test("a range the RPC won't serve is still halved", async () => {
  const client = arcLikeClient();
  client.getLogs = async ({ fromBlock, toBlock }) => {
    client.calls.push({ fromBlock, toBlock });
    if (toBlock - fromBlock >= 8n) throw new Error("query exceeds max block range 8");
    return [];
  };
  const state = await readCallbook({ client, address: ADDRESS, fromBlock: 100n, wait: async () => { throw new Error("no wait expected"); } });
  assert.equal(state.toBlock, 120n);
});

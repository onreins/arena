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

// The MCP server ends when its client closes stdin, even with a tool call still
// waiting on the chain. Otherwise a bot that gave up on a slow call leaves the
// server running and still reading, which uses up a public RPC's rate limit
// for the bot's next run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { generatePrivateKey } from "viem/accounts";

const SERVER = fileURLToPath(new URL("../callbook/mcp-server.js", import.meta.url));
const EXIT_WITHIN_MS = 5_000;

/** An RPC that accepts connections and never answers, so a chain read hangs. */
async function blackhole() {
  const sockets = new Set();
  const server = createServer((s) => { sockets.add(s); s.on("error", () => {}); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => { for (const s of sockets) s.destroy(); server.close(); },
  };
}

const rpc = (id, method, params = {}) => JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

test("the server exits when stdin closes, even mid-call", async (t) => {
  const hole = await blackhole();
  t.after(hole.close);
  const child = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      CALLBOOK_KEY: generatePrivateKey(),
      CALLBOOK_NETWORK: "testnet",
      CALLBOOK_RPC: hole.url,
      CALLBOOK_API_URL: hole.url,
      CALLBOOK_JOURNAL: "off",
    },
  });
  t.after(() => child.kill());
  child.stdout.resume();
  child.stderr.resume();
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));

  child.stdin.write(rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } }));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  child.stdin.write(rpc(2, "tools/call", { name: "arena_status", arguments: {} }));
  await new Promise((resolve) => setTimeout(resolve, 1_000)); // the status call is now waiting on the RPC
  child.stdin.end();

  const code = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve("still running"), EXIT_WITHIN_MS))]);
  assert.equal(code, 0);
});

/**
 * Replay Callbook over the last month of real Hyperliquid prices, on a local
 * chain, and export what the Callbook pages show.
 *
 *   npm run callbook:replay                     # 30 days of books, own node on :8546
 *   npm run callbook:replay -- --days 20 --rpc http://127.0.0.1:8546 --keep-node
 *
 * What happens, all on a local Hardhat node (never a public chain):
 *   1. a node starts on port 8546 with its clock set before the window
 *      (HARDHAT_INITIAL_DATE), unless one is already there and still early enough
 *   2. MockIdentityRegistry, MockValidationRegistry and Callbook are deployed
 *   3. four sample callers start locking discretionary calls 8 days before the
 *      books open (so a lock held back long enough to count as withheld, 37
 *      days after its entry, can show up), each signing an EIP-712 LockCall
 *      that goes through the relayer's own code (app/verify/callbook-relay.js:
 *      signature check, simulation, rate limits, gas budget), and revealing
 *      through it after the horizon
 *   4. an owner key registers our three agents as ERC-8004 agents, opens a
 *      scheduled book for each (a separate agent key seals), and files a
 *      validation request per book naming a separate validator key
 *   5. time moves forward event by event. Five minutes before each 4h boundary
 *      the runner's own tick() seals each agent's call, decided from candles
 *      that had closed by then (no lookahead); a minute after the boundary it
 *      reveals what matured; once a day the validator posts each book's score.
 *      Callers look once an hour, at their own minute, at closed candles only
 *   6. labelled lapses: the Coin flip control skips one seal and holds back one
 *      reveal; the Random caller holds back its first two calls and names one
 *      coin Hyperliquid doesn't list
 *   7. app/public/data/callbook.json, callbook-book-<id>.json and
 *      callbook-caller-<id>.json are written with mode "replay"
 *
 * The keys are Hardhat's public test accounts and the secrets fixed local
 * strings: fine for a throwaway chain, useless anywhere else.
 */
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, defineChain, parseEventLogs } from "viem";
import { mnemonicToAccount } from "viem/accounts";

import { artifact } from "./artifact.js";
import { readCallbook, buildCallbook, validationRequestFor, symbolCallHash, NO_AGENT } from "../app/verify/callbook.js";
import { createPriceSource, priceBook } from "../app/verify/callbook-prices.js";
import { publishScores } from "../app/verify/callbook-publish.js";
import { createRelayer, DOMAIN, LOCK_TYPES } from "../app/verify/callbook-relay.js";
import { SAMPLE_CALLERS } from "../app/verify/callbook-agents.js";
import { tick } from "../runner/callbook.js";
import { AGENTS, UNIVERSE } from "../runner/callbook-agents.js";
import { makeCaller, seeded } from "./callbook-sample-callers.js";
import { VALIDATION_REGISTRY_ABI } from "../evaluator/abi.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_DIR = path.join(ROOT, "app", "public", "data");
const HOUR = 3_600, DAY = 86_400, PERIOD = 4 * HOUR;
const MNEMONIC = "test test test test test test test test test test test junk";
const SECRET = "callbook-local-replay-secret-not-for-any-real-chain";
/** Coin flip's labelled lapses, as period numbers of its book. */
const FLIP_MISS = 45;
const FLIP_WITHHOLD = 70;
/** Callers start this long before the books, so early held-back locks pass their 37-day limit. */
const CALLER_HEAD_START = 8 * DAY;

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : fallback;
};
const days = Number(arg("--days", 30));
const RPC = arg("--rpc", process.env.CALLBOOK_REPLAY_RPC ?? "http://127.0.0.1:8546");
const keepNode = process.argv.includes("--keep-node");
const log = (m) => console.log(`  ${m}`);

const chain = defineChain({ id: 31337, name: "Local replay", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const transport = http(RPC, { retryCount: 3 });
const publicClient = createPublicClient({ chain, transport, pollingInterval: 100 });
const walletOf = (i) => createWalletClient({ account: mnemonicToAccount(MNEMONIC, { addressIndex: i }), chain, transport, pollingInterval: 100 });
const deployer = walletOf(0), owner = walletOf(1), agentKey = walletOf(2), validator = walletOf(3), relayerKey = walletOf(4);
/** Sample callers sign with Hardhat accounts #5 to #8 (see SAMPLE_CALLERS). */
const CALLER_WALLETS = [5, 6, 7, 8].map(walletOf);

const hex = (n) => `0x${BigInt(n).toString(16)}`;
const latest = async () => Number((await publicClient.getBlock()).timestamp);
/** Mine an empty block at `t`, so the next transactions land just after it. */
async function mineAt(t) {
  if (t <= (await latest())) return;
  await publicClient.request({ method: "evm_mine", params: [hex(t)] });
}

// ------------------------------------------------------------------ the node

async function reachable() {
  try {
    await publicClient.getBlockNumber();
    return true;
  } catch {
    return false;
  }
}

async function startNode(initialDate) {
  const port = new URL(RPC).port;
  const cli = path.join(ROOT, "node_modules", "hardhat", "internal", "cli", "bootstrap.js");
  const child = spawn(process.execPath, [cli, "node", "--port", port], {
    cwd: ROOT, env: { ...process.env, HARDHAT_INITIAL_DATE: initialDate }, stdio: ["ignore", "ignore", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (d) => { err += d; });
  for (let i = 0; i < 120; i++) {
    if (await reachable()) return child;
    if (child.exitCode != null) throw new Error(`hardhat node exited: ${err.slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error("hardhat node did not come up");
}

// ------------------------------------------------------------------ setup

async function send(wallet, address, abi, functionName, args) {
  const hash = await wallet.writeContract({ address, abi, functionName, args, account: wallet.account, chain });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
  return receipt;
}
async function deploy(name, args = []) {
  const { abi, bytecode } = artifact(name);
  const hash = await deployer.deployContract({ abi, bytecode, args, account: deployer.account, chain });
  return (await publicClient.waitForTransactionReceipt({ hash })).contractAddress;
}

async function deployAll(at) {
  await mineAt(at);
  const identity = await deploy("MockIdentityRegistry");
  const registry = await deploy("MockValidationRegistry", [identity]);
  const callbook = await deploy("Callbook", [identity]);
  return { identity, registry, callbook, fromBlock: await publicClient.getBlockNumber() };
}

async function openBooks(env) {
  const ID = artifact("MockIdentityRegistry").abi, CB = artifact("Callbook").abi;
  const books = [];
  for (const agent of AGENTS) {
    const reg = await send(owner, env.identity, ID, "register", []);
    const agentId = parseEventLogs({ abi: ID, logs: reg.logs, eventName: "Transfer" })[0].args.tokenId;
    const opened = await send(owner, env.callbook, CB, "open", [agentId, agentKey.account.address, agent.strategyHash, agent.coins, agent.periodSec, agent.horizonSec]);
    const bookId = parseEventLogs({ abi: CB, logs: opened.logs, eventName: "Opened" })[0].args.bookId;
    const req = validationRequestFor({ chainId: chain.id, callbook: env.callbook, bookId, agentId });
    await send(owner, env.registry, VALIDATION_REGISTRY_ABI, "validationRequest", [validator.account.address, agentId, req.requestURI, req.requestHash]);
    books.push({ key: agent.key, name: agent.name, bookId: Number(bookId), agentId });
    log(`${agent.name}: agent #${agentId}, book #${bookId}, ${agent.coins.length} coin${agent.coins.length > 1 ? "s" : ""}`);
  }
  if (books.some((b) => b.agentId === NO_AGENT)) throw new Error("an agent failed to register");
  return books;
}

// ------------------------------------------------------------------ callers

/** Lock a sample caller's call the gasless way: sign LockCall, hand it to the relayer. */
async function lockCall({ relayer, env, wallet, call, now }) {
  const account = wallet.account.address;
  const CB = artifact("Callbook").abi;
  const nonce = await publicClient.readContract({ address: env.callbook, abi: CB, functionName: "nonces", args: [account] });
  const salt = `0x${createHmac("sha256", SECRET).update(`caller:${account.toLowerCase()}:${nonce}`).digest("hex")}`;
  const callHash = symbolCallHash({ callbook: env.callbook, chainId: chain.id, account, nonce, coin: call.coin, side: call.side, horizon: call.horizon, salt });
  const deadline = BigInt(now + 600);
  const signature = await wallet.signTypedData({
    account: wallet.account, domain: DOMAIN(chain.id, env.callbook), types: LOCK_TYPES, primaryType: "LockCall",
    message: { account, callHash, horizon: call.horizon, nonce, deadline },
  });
  const r = await relayer.lock({ account, callHash, horizon: call.horizon, deadline: deadline.toString(), signature });
  return { ...r, salt };
}

// ------------------------------------------------------------------ the replay

/** A queue of timed events, run in time order; handlers may add more. */
function timeline() {
  const q = [];
  let seq = 0;
  return {
    add(t, run) {
      const e = { t, seq: seq++, run };
      let lo = 0, hi = q.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (q[mid].t < t || (q[mid].t === t && q[mid].seq < e.seq)) lo = mid + 1; else hi = mid;
      }
      q.splice(lo, 0, e);
    },
    next: () => q.shift(),
    get size() { return q.length; },
  };
}

async function main() {
  const wallNow = Math.floor(Date.now() / 1000);
  const end = wallNow - 60; // the last moment with prices
  const firstBoundary = Math.ceil((end - days * DAY) / PERIOD) * PERIOD;
  const openAt = firstBoundary - PERIOD + 600; // period 0 then starts at firstBoundary
  const callerStart = Math.floor((firstBoundary - CALLER_HEAD_START) / HOUR) * HOUR;
  const deployAt = callerStart - HOUR;
  console.log(`\n  Callbook replay: books ${new Date(firstBoundary * 1000).toISOString()} → ${new Date(end * 1000).toISOString()}, callers from ${new Date(callerStart * 1000).toISOString()}, on ${RPC}`);

  let node = null;
  if (await reachable()) {
    const t = await latest();
    if (t >= deployAt) throw new Error(`the node at ${RPC} is already at ${new Date(t * 1000).toISOString()}, past the replay start; stop it and run again`);
    log("using the node already running");
  } else {
    node = await startNode(new Date((deployAt - 3 * HOUR) * 1000).toISOString());
    log(`started hardhat node (pid ${node.pid}) at ${new Date((await latest()) * 1000).toISOString()}`);
  }

  try {
    const source = createPriceSource({ log });
    log(`fetching hourly candles and funding for ${UNIVERSE.length} coins (cached under data/callbook-prices)…`);
    const warm = await source.load(UNIVERSE, callerStart - 4 * DAY, end, "1h");
    log(`prices ready${warm.fundingOk ? ", with funding" : ", WITHOUT funding (flat carry)"}`);

    const env = await deployAll(deployAt);
    let sim = deployAt;
    const relayer = createRelayer({
      publicClient, wallet: relayerKey, callbook: env.callbook, abi: artifact("Callbook").abi, chainId: chain.id, now: () => sim,
    });
    // Our books, as the runner and the scorer know them: owned by the owner key and on our record.
    // Filled in when the books are opened (callbook-network.js ourBooksFrom's shape).
    const ours = { owner: owner.account.address.toLowerCase(), bookIds: new Set(), byId: new Map(), order: [] };
    const ctx = { publicClient, wallet: agentKey, callbook: env.callbook, chainId: chain.id, secret: SECRET, source, fromBlock: env.fromBlock, log, ours };
    const full = { state: null };
    const readFull = async () => {
      full.state = await readCallbook({ client: publicClient, address: env.callbook, fromBlock: env.fromBlock, validationRegistry: env.registry, validator: validator.account.address, state: full.state });
      return full.state;
    };

    const tl = timeline();
    const counts = { seals: 0, reveals: 0, posts: 0, locks: 0, lockReveals: 0, held: 0 };
    let books = [];
    const skip = ({ book, p, action }) => {
      const flip = books.find((b) => b.key === "flip")?.bookId;
      return book.id === flip && ((action === "seal" && p === FLIP_MISS) || (action === "reveal" && p === FLIP_WITHHOLD));
    };
    const ticked = (actions) => { for (const a of actions) a.action === "seal" ? counts.seals++ : counts.reveals++; };

    // Our agents' books.
    tl.add(openAt, async () => {
      books = await openBooks(env);
      for (const b of books) {
        ours.bookIds.add(b.bookId);
        ours.byId.set(b.bookId, { ...b, agentId: Number(b.agentId) });
        ours.order.push(b.bookId);
      }
    });
    for (let B = firstBoundary; B - 300 <= end; B += PERIOD) {
      tl.add(B - 300, async (t) => ticked(await tick(ctx, { now: t, skip })));
      if (B + 60 <= end) tl.add(B + 60, async (t) => ticked(await tick(ctx, { now: t, skip })));
      if (B % DAY === 0 && B + 90 <= end) {
        tl.add(B + 90, async (t) => {
          const state = await readFull();
          const built = await buildCallbook({ chain: state, source, asOf: t, meta: {}, validator: validator.account.address, log, ours });
          const res = await publishScores({ chain: state, evaluated: built.evaluated, wallet: validator, publicClient, registry: env.registry, validator: validator.account.address, now: t, allow: ours.bookIds });
          counts.posts += res.filter((r) => r.tx).length;
          const callers = built.index.callers.map((c) => `${c.name.split(" ")[0]}:${c.score.value}`).join(" ");
          process.stdout.write(`  ${new Date(B * 1000).toISOString().slice(0, 10)}  ${res.map((r) => `#${r.bookId}:${r.score}`).join("  ")}   ${callers}\n`);
        });
      }
    }

    // The sample callers: one look an hour each, at their own minute.
    const views = new Map();
    const viewAt = (t) => {
      const h = Math.floor(t / HOUR);
      if (!views.has(h)) {
        views.clear();
        views.set(h, priceBook(warm, { upTo: t }));
      }
      return views.get(h);
    };
    const keys = Object.values(SAMPLE_CALLERS).map((s) => s.key);
    const callers = keys.map((key, i) => ({ ...makeCaller(key, { start: callerStart }), wallet: CALLER_WALLETS[i] }));
    const jitter = seeded(7);
    for (let H = callerStart; H < end; H += HOUR) {
      for (const c of callers) {
        const at = H + c.minute * 60;
        if (at > end - 120) continue;
        tl.add(at, async (t) => {
          const call = c.decide(viewAt(t), t);
          if (!call) return;
          const locked = await lockCall({ relayer, env, wallet: c.wallet, call, now: t });
          counts.locks++;
          if (call.withhold) {
            counts.held++;
            return;
          }
          const revealAt = locked.entryAt + call.horizon + 60 + Math.floor(jitter() * 1800);
          if (revealAt > end) return; // still pending when the replay stops
          tl.add(revealAt, async () => {
            await relayer.reveal({ kind: "symbol", bookId: locked.bookId, callId: locked.callId, coin: call.coin, side: call.side, salt: locked.salt });
            counts.lockReveals++;
          });
        });
      }
    }

    while (tl.size) {
      const e = tl.next();
      sim = Math.max(sim, e.t);
      await mineAt(e.t);
      await e.run(e.t);
    }
    log(`books: ${counts.seals} seals, ${counts.reveals} reveals, ${counts.posts} validation responses`);
    log(`callers: ${counts.locks} gasless locks through the relayer, ${counts.lockReveals} relayed reveals, ${counts.held} held back on purpose`);

    // The export, as of the last moment replayed.
    sim = end;
    await mineAt(end);
    const state = await readFull();
    const from = new Date(firstBoundary * 1000).toISOString().slice(0, 10), to = new Date(end * 1000).toISOString().slice(0, 10);
    const cFrom = new Date(callerStart * 1000).toISOString().slice(0, 10);
    const meta = {
      mode: "replay", network: "Local replay", chainId: chain.id, explorer: null,
      contract: env.callbook.toLowerCase(), validationRegistry: env.registry.toLowerCase(),
      note: `Replayed on a local chain over real Hyperliquid prices from ${from} to ${to} (sample callers from ${cFrom}); not yet live on Arc.`,
    };
    const built = await buildCallbook({ chain: state, source, asOf: end, meta, validator: validator.account.address, log, ours });
    mkdirSync(OUT_DIR, { recursive: true });
    // Old exports go first: book ids move when the set of books changes.
    for (const f of readdirSync(OUT_DIR)) if (/^callbook-(book|caller)-\d+\.json$/.test(f)) unlinkSync(path.join(OUT_DIR, f));
    writeFileSync(path.join(OUT_DIR, "callbook.json"), `${JSON.stringify(built.index)}\n`);
    for (const [id, detail] of built.details) writeFileSync(path.join(OUT_DIR, `callbook-book-${id}.json`), `${JSON.stringify(detail)}\n`);
    for (const [id, detail] of built.callerDetails) writeFileSync(path.join(OUT_DIR, `callbook-caller-${id}.json`), `${JSON.stringify(detail)}\n`);

    const pct = (x, dp = 1) => (x == null ? "—" : `${(x * 100).toFixed(dp)}%`);
    console.log("\n  book                 calls  rev  miss  held  flat   return   vsMkt    maxDD  win    score  challenge");
    for (const b of built.index.books) {
      const m = b.metrics;
      console.log(`  ${`#${b.id} ${b.name}`.padEnd(20)} ${String(m.calls).padStart(5)} ${String(m.revealed).padStart(4)} ${String(m.missed).padStart(5)} ${String(m.withheld).padStart(5)} ${pct(m.flatShare).padStart(5)} ${pct(m.totalReturn).padStart(8)} ${pct(m.vsMarket).padStart(7)} ${pct(m.maxDrawdown).padStart(7)} ${pct(m.winRate).padStart(5)} ${String(b.score.value).padStart(7)}  ${b.challenge.status}`);
    }
    console.log("\n  caller               calls  rev  held  unsc  pend   hit    mean/call  vsCoin   t      sum     maxDD   score");
    for (const c of built.index.callers) {
      const m = c.metrics;
      console.log(`  ${`#${c.id} ${c.name}`.padEnd(20)} ${String(m.calls).padStart(5)} ${String(m.revealed).padStart(4)} ${String(m.withheld).padStart(5)} ${String(m.unscorable).padStart(5)} ${String(m.pending).padStart(5)} ${pct(m.hitRate).padStart(6)} ${pct(m.meanReturn, 2).padStart(10)} ${pct(m.vsCoin, 2).padStart(7)} ${String(m.tStat).padStart(6)} ${pct(m.totalReturn).padStart(7)} ${pct(m.maxDrawdown).padStart(7)} ${String(c.score.value).padStart(6)}`);
    }
    console.log(`\n  wrote app/public/data/callbook.json, ${built.details.size} book files and ${built.callerDetails.size} caller files`);
    console.log(`  local Callbook ${env.callbook}, ValidationRegistry ${env.registry}, from block ${env.fromBlock}\n`);
  } finally {
    if (node && !keepNode) node.kill();
    else if (node) log(`node left running on ${RPC} (pid ${node.pid})`);
  }
}

main().catch((err) => {
  console.error(`\n  replay failed: ${err.shortMessage ?? err.message}\n${err.stack?.split("\n").slice(1, 4).join("\n") ?? ""}`);
  process.exit(1);
});

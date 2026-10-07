/**
 * The Callbook runner: our agents seal a call before every period and reveal
 * it once the horizon has passed.
 *
 *   node --env-file=.env runner/callbook.js            # loop
 *   node --env-file=.env runner/callbook.js --once     # one pass, then exit
 *
 * Environment (secrets are never logged):
 *   CALLBOOK_NETWORK        local | testnet | mainnet
 *   CALLBOOK_ADDRESS        the Callbook contract (or deployments/callbook-<network>.json)
 *   CALLBOOK_FROM_BLOCK     the deploy block (required off local)
 *   CALLBOOK_AGENT_KEY      0x… key that seals (each of our books' `caller`)
 *   CALLBOOK_SALT_SECRET    at least 32 characters; salts and coin flips derive from it
 *   CALLBOOK_OWNER          the address that owns our books (else the books record's owner)
 *   CALLBOOK_BOOKS_FILE     our books record (default deployments/callbook-<network>-books.json)
 *   CALLBOOK_RUNNER_DAILY_USDC   gas the runner may spend a day (default 2)
 *   CALLBOOK_VALIDATOR_KEY  optional: also post daily scores for our books
 *   CALLBOOK_PUBLISH_DAILY_USDC  gas the validator may spend a day (default 1)
 *   CALLBOOK_RPC            optional RPC URL; CALLBOOK_REPORT_BASE public URL of the app, for report URIs
 *   CALLBOOK_STATE_FILE     where the chain-state snapshot for the API is refreshed
 *
 * Which books it acts on: only books whose owner is our owner AND that are in
 * our books record AND whose caller is our key AND whose strategy is one of
 * our agents. A caller address and a strategy hash are public; anyone can
 * open a book naming them, and without the owner check our key would seal
 * (and spend gas) for theirs. At most MAX_BOOKS_PER_TICK books a pass, ours
 * in record order.
 *
 * Nothing else is stored. The call behind a seal is recovered by trying every
 * (coin, side) with the derived salt, since a call has few possible values. So
 * a restart, or a new machine with the same two secrets, picks up exactly
 * where the last one stopped, and sending twice is impossible (the contract
 * refuses a second seal or reveal, and we check the chain before sending).
 */
import { createHmac } from "node:crypto";
import { writeFileSync, renameSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { artifact } from "../scripts/artifact.js";
import { readCallbook, callHash, startOf, exitOf, GRACE, SEAL_LEAD, buildCallbook, snapshotText, stateFromSnapshot } from "../app/verify/callbook.js";
import { createPriceSource, priceBook, intervalFor } from "../app/verify/callbook-prices.js";
import { publishScores, publishSpend } from "../app/verify/callbook-publish.js";
import { callbookNetwork, clientFor, arenaEnv } from "../app/verify/callbook-network.js";
import { memoryCounter, brief } from "../app/verify/callbook-util.js";
import { agentByHash } from "./callbook-agents.js";

const CALLBOOK = artifact("Callbook");
const HOUR = 3_600;
const DAY = 86_400;
/** Seal in the last 10 minutes before a period, and never later than 2 minutes before it. */
export const SEAL_WINDOW = 600;
export const MIN_LEAD = 120;
/** At most this many books are looked at in one pass. */
export const MAX_BOOKS_PER_TICK = 8;
/** Each seal or reveal is sent with at most this much gas. */
export const RUNNER_GAS_CAP = 300_000n;
const TICK_MS = 30_000;
const SNAPSHOT_EVERY_MS = HOUR * 1000;

/** HMAC-SHA256(secret, "chainId:callbook:bookId:p"), as a bytes32. */
export function deriveSalt(secret, { chainId, callbook, bookId, p }) {
  if (!secret || secret.length < 32) throw new Error("CALLBOOK_SALT_SECRET must be at least 32 characters");
  return `0x${createHmac("sha256", secret).update(`${chainId}:${String(callbook).toLowerCase()}:${bookId}:${p}`).digest("hex")}`;
}

/** The (coinIndex, side) behind a seal, found by trying every call with the derived salt. Null if none matches. */
export function recoverCall({ hash, chainId, callbook, bookId, p, coinCount, salt }) {
  for (let coinIndex = 0; coinIndex < coinCount; coinIndex++) {
    for (const side of [1, -1, 0]) {
      if (callHash({ callbook, chainId, bookId, p, coinIndex, side, salt }) === hash) return { coinIndex, side };
    }
  }
  return null;
}

/**
 * Books we seal for: scheduled, open, owned by our owner, in our record,
 * called by our key, with one of our strategies. Record order, at most `max`.
 * ours: { owner, bookIds: Set, order: [ids] }
 */
export function ourBooks(chain, caller, ours, max = MAX_BOOKS_PER_TICK) {
  if (!ours?.owner || !ours.bookIds?.size) return [];
  const rank = (id) => ours.order?.indexOf(id) ?? 0;
  return [...chain.books.values()]
    .filter((b) => b.kind !== "free" && b.closedAt == null && b.owner === ours.owner && ours.bookIds.has(b.id) && b.caller === caller.toLowerCase())
    .map((b) => ({ book: b, agent: agentByHash(b.strategyHash) }))
    .filter((x) => x.agent)
    .sort((a, b) => rank(a.book.id) - rank(b.book.id))
    .slice(0, max);
}

/**
 * Send one transaction within the day's gas budget and a gas cap. The worst
 * case is counted before sending, so a stuck receipt can't hide spend.
 */
async function send(ctx, functionName, args) {
  const { publicClient, wallet } = ctx;
  const gas = await publicClient.estimateContractGas({ address: ctx.callbook, abi: CALLBOOK.abi, functionName, args, account: wallet.account });
  const cap = gas + gas / 5n > RUNNER_GAS_CAP ? RUNNER_GAS_CAP : gas + gas / 5n;
  if (gas > RUNNER_GAS_CAP) throw new Error(`${functionName} would need ${gas} gas, over the ${RUNNER_GAS_CAP} cap`);
  const price = await publicClient.getGasPrice();
  const worst = Number((cap * price) / 10n ** 12n) + 1; // micro-USDC
  const day = `runner:${Math.floor((ctx.clock?.() ?? Date.now() / 1000) / DAY)}`;
  const budget = Math.round((ctx.dailyUsdc ?? 2) * 1e6);
  if ((await ctx.spend.peek(day, DAY)) + worst > budget) throw new Error(`the runner's daily gas budget (${ctx.dailyUsdc ?? 2} USDC) is used up`);
  await ctx.spend.hit(day, DAY, worst);
  const hash = await wallet.writeContract({ address: ctx.callbook, abi: CALLBOOK.abi, functionName, args, gas: cap, account: wallet.account, chain: wallet.chain });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
  return hash;
}

/** Reveal every matured seal of a book that hasn't been revealed and still can be. */
async function revealMatured(ctx, book, now, skip) {
  const done = [];
  for (const s of book.seals.values()) {
    if (s.reveal || now < exitOf(book, s.p) || now > exitOf(book, s.p) + GRACE) continue;
    if (skip?.({ book, p: s.p, action: "reveal" })) continue;
    const salt = deriveSalt(ctx.secret, { chainId: ctx.chainId, callbook: ctx.callbook, bookId: book.id, p: s.p });
    const call = recoverCall({ hash: s.hash, chainId: ctx.chainId, callbook: ctx.callbook, bookId: book.id, p: s.p, coinCount: book.coins.length, salt });
    if (!call) {
      ctx.log(`book ${book.id} period ${s.p}: no call matches the seal with this secret; can't reveal`);
      continue;
    }
    const tx = await send(ctx, "reveal", [BigInt(book.id), BigInt(s.p), call.coinIndex, call.side, salt]);
    done.push({ bookId: book.id, p: s.p, action: "reveal", ...call, tx });
  }
  return done;
}

/** Seal the next period when it's inside the sealing window and not sealed yet. */
async function sealNext(ctx, book, agent, now, skip) {
  const p = now < book.start ? 0 : Math.floor((now - book.start) / book.periodSec) + 1;
  const lead = startOf(book, p) - now;
  if (lead > SEAL_WINDOW || lead < MIN_LEAD || book.seals.has(p)) return null;
  if (skip?.({ book, p, action: "seal" })) return null;

  const interval = intervalFor(book.periodSec, book.horizonSec);
  const data = await ctx.source.load(book.coins, now - 2 * DAY, now, interval);
  const view = priceBook({ ...data, interval }, { upTo: now });
  const call = await agent.decide({ coins: book.coins, view, now, secret: ctx.secret, chainId: ctx.chainId, callbook: ctx.callbook, bookId: book.id, p });
  if (!(call.coinIndex >= 0 && call.coinIndex < book.coins.length)) throw new Error(`agent ${agent.key} picked a coin outside book ${book.id}`);

  const salt = deriveSalt(ctx.secret, { chainId: ctx.chainId, callbook: ctx.callbook, bookId: book.id, p });
  const hash = callHash({ callbook: ctx.callbook, chainId: ctx.chainId, bookId: book.id, p, coinIndex: call.coinIndex, side: call.side, salt });
  if (startOf(book, p) - SEAL_LEAD < now) return null; // too late after all
  const tx = await send(ctx, "seal", [BigInt(book.id), BigInt(p), hash]);
  return { bookId: book.id, p, action: "seal", coin: book.coins[call.coinIndex], side: call.side, why: call.why, tx };
}

/**
 * One pass: read the chain, reveal what matured, seal what's due.
 * ctx: { publicClient, wallet, callbook, chainId, secret, source, fromBlock, log,
 *        ours (required), spend?, dailyUsdc?, state? }
 * opts: { now, skip?({ book, p, action }) } — `skip` lets a replay leave a seal or reveal out on purpose.
 */
export async function tick(ctx, { now = Math.floor(Date.now() / 1000), skip } = {}) {
  if (!ctx.ours?.owner) throw new Error("the runner needs our owner and books record (CALLBOOK_OWNER / the books record)");
  ctx.spend ??= memoryCounter();
  ctx.clock = () => now;
  ctx.state = await readCallbook({ client: ctx.publicClient, address: ctx.callbook, fromBlock: ctx.fromBlock, state: ctx.state });
  const actions = [];
  for (const { book, agent } of ourBooks(ctx.state, ctx.wallet.account.address, ctx.ours)) {
    try {
      actions.push(...(await revealMatured(ctx, book, now, skip)));
      const sealed = await sealNext(ctx, book, agent, now, skip);
      if (sealed) actions.push(sealed);
    } catch (err) {
      ctx.log(`book ${book.id}: ${brief(err)}`);
    }
  }
  return actions;
}

// ------------------------------------------------------------------ the loop

function configFromEnv(rawEnv = process.env) {
  const env = arenaEnv(rawEnv); // ARENA_X settings are read as CALLBOOK_X
  const problems = [];
  const key = env.CALLBOOK_AGENT_KEY;
  const secret = env.CALLBOOK_SALT_SECRET;
  const vkey = env.CALLBOOK_VALIDATOR_KEY;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? "")) problems.push("CALLBOOK_AGENT_KEY must be 0x + 64 hex");
  if (!secret || secret.length < 32) problems.push("CALLBOOK_SALT_SECRET must be at least 32 characters");
  if (vkey && !/^0x[0-9a-fA-F]{64}$/.test(vkey)) problems.push("CALLBOOK_VALIDATOR_KEY must be 0x + 64 hex");
  let net = null;
  try {
    const validator = vkey && !problems.length ? privateKeyToAccount(vkey).address : undefined;
    net = callbookNetwork({ CALLBOOK_NETWORK: "local", ...env }, validator && !env.CALLBOOK_VALIDATOR ? { validator } : {});
  } catch (err) {
    problems.push(err.message);
  }
  if (net && !net.ours) problems.push("no owner for our books: set CALLBOOK_OWNER or write the books record (npm run callbook:setup)");
  if (net?.ours && !net.ours.bookIds.size) problems.push(`the books record has no books for ${net.address} owned by ${net.ours.owner}`);
  if (problems.length) throw new Error(`runner/callbook.js can't start:\n  - ${problems.join("\n  - ")}`);
  return {
    net, key, secret, vkey, reportBase: env.CALLBOOK_REPORT_BASE,
    dailyUsdc: Number(env.CALLBOOK_RUNNER_DAILY_USDC ?? 2), publishUsdc: Number(env.CALLBOOK_PUBLISH_DAILY_USDC ?? 1),
  };
}

/** Write the snapshot the API starts from, atomically. */
export function writeSnapshot(file, state, opts) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, snapshotText(state, opts));
  renameSync(`${file}.tmp`, file);
}

async function main() {
  const cfg = configFromEnv();
  const { net } = cfg;
  const publicClient = clientFor(net);
  const transport = http(net.rpc, { retryCount: 5 });
  const wallet = createWalletClient({ account: privateKeyToAccount(cfg.key), chain: net.chain, transport });
  const validatorWallet = cfg.vkey ? createWalletClient({ account: privateKeyToAccount(cfg.vkey), chain: net.chain, transport }) : null;
  const log = (m) => console.log(`[callbook ${new Date().toISOString()}] ${m}`);
  const chainId = await publicClient.getChainId();
  const ctx = {
    publicClient, wallet, callbook: net.address, chainId, secret: cfg.secret, ours: net.ours,
    source: createPriceSource({ log }), fromBlock: net.fromBlock, log, spend: memoryCounter(), dailyUsdc: cfg.dailyUsdc,
  };
  log(`${net.name} · Callbook ${net.address} · owner ${net.ours.owner} · ${net.ours.bookIds.size} books · caller ${wallet.account.address}${validatorWallet ? ` · validator ${validatorWallet.account.address}` : ""}`);

  // The full state (with validations) starts from the last snapshot, so a restart doesn't rescan.
  const snapOpts = { validationRegistry: net.registry, validator: net.validator };
  let full = existsSync(net.stateFile) ? stateFromSnapshot(readFileSync(net.stateFile, "utf8"), { address: net.address, chainId, ...snapOpts }) : null;
  const publishLedger = publishSpend();
  const once = process.argv.includes("--once");
  let lastScoring = 0, lastSnapshot = 0;
  for (;;) {
    try {
      for (const a of await tick(ctx)) log(`book ${a.bookId} period ${a.p}: ${a.action}${a.coin ? ` ${a.coin} ${a.side}` : ""} ${a.tx}`);
      const hourly = Date.now() - lastScoring >= HOUR * 1000;
      if (hourly || Date.now() - lastSnapshot >= SNAPSHOT_EVERY_MS) {
        full = await readCallbook({ client: publicClient, address: net.address, fromBlock: net.fromBlock, validationRegistry: net.registry ?? undefined, validator: net.validator ?? undefined, state: full });
        writeSnapshot(net.stateFile, full, snapOpts);
        lastSnapshot = Date.now();
      }
      // Scores are posted at most daily per book; looking once an hour is plenty.
      if (validatorWallet && net.registry && hourly) {
        lastScoring = Date.now();
        const now = Math.floor(Date.now() / 1000);
        const built = await buildCallbook({ chain: full, source: ctx.source, asOf: now, meta: {}, validator: net.validator, reportBase: cfg.reportBase, log, ours: net.ours });
        await publishScores({
          chain: full, evaluated: built.evaluated, wallet: validatorWallet, publicClient, registry: net.registry, validator: net.validator,
          now, allow: net.ours.bookIds, budgetUsdc: cfg.publishUsdc, spend: publishLedger, log,
        });
      }
    } catch (err) {
      log(`pass failed: ${brief(err)}`);
    }
    if (once) return;
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(brief(err));
    process.exit(1);
  });
}

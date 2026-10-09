/**
 * Which Callbook to read: one place for the API, the verify script and the
 * runner to agree on network, contract, registry, RPC and which books are ours.
 *
 *   CALLBOOK_NETWORK              local | testnet | mainnet (unset: Callbook is off)
 *   CALLBOOK_ADDRESS              the contract; else deployments/callbook-<network>.json
 *   CALLBOOK_FROM_BLOCK           first block to read; required off local (the deploy
 *                                 block: scanning Arc from genesis is not an option)
 *   CALLBOOK_RPC                  RPC URL (default: the chain's public RPC; local: RATCHET_RPC or :8545)
 *   CALLBOOK_VALIDATOR            our validator's address (else the deployment record's `validator`). Off local, without a valid one
 *                                 every validation is ignored: anyone can name themselves
 *                                 validator, so unfiltered responses mean nothing
 *   CALLBOOK_VALIDATION_REGISTRY  only needed on local; Arc's are known
 *   CALLBOOK_OWNER                the address that owns our books (else the books record's owner)
 *   CALLBOOK_BOOKS_FILE           our books record (default deployments/callbook-<network>-books.json,
 *                                 written by scripts/callbook-setup.js)
 *   CALLBOOK_STATE_FILE           the chain-state snapshot (default app/data/callbook-state-<network>.json)
 *
 * A book is ours only when its owner is our owner AND it is in our books
 * record: anyone can open a book with our strategy hash and caller, but not
 * with our owner key.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineChain, createPublicClient, http, isAddress } from "viem";
import { arc, arcTestnet } from "viem/chains";

import { REGISTRIES } from "../../evaluator/abi.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const localChain = (rpc) => defineChain({
  id: 31337, name: "Local", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [rpc] } },
});

const readJson = (file) => {
  if (!file || !existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/**
 * Our books from the books record: { owner, bookIds: Set<number>, byId: Map<id, agent entry> },
 * or null. A record for another contract is ignored.
 */
export function ourBooksFrom({ record, owner, callbook }) {
  const recOwner = record?.owner;
  const who = owner ?? recOwner;
  if (!who || !isAddress(who)) return null;
  const sameContract = !record?.callbook || !callbook || record.callbook.toLowerCase() === callbook.toLowerCase();
  const sameOwner = !recOwner || recOwner.toLowerCase() === who.toLowerCase();
  const entries = sameContract && sameOwner ? (record?.agents ?? []).filter((a) => Number.isInteger(Number(a.bookId)) && a.bookId != null) : [];
  return {
    owner: who.toLowerCase(),
    bookIds: new Set(entries.map((a) => Number(a.bookId))),
    byId: new Map(entries.map((a) => [Number(a.bookId), a])),
    order: entries.map((a) => Number(a.bookId)),
  };
}

/**
 * Arena's settings under their current names: every ARENA_X is read as
 * CALLBOOK_X (Arena was called Callbook; the old names keep working).
 */
export function arenaEnv(env = process.env) {
  const out = { ...env };
  // Values pasted into a dashboard often carry a stray tab or space: Arena's settings are trimmed.
  for (const [k, v] of Object.entries(env)) if (/^(ARENA|CALLBOOK)_/.test(k) && typeof v === "string") out[k] = v.trim();
  for (const [k, v] of Object.entries(env)) if (k.startsWith("ARENA_") && v !== undefined && String(v).trim() !== "") out[`CALLBOOK_${k.slice(6)}`] = String(v).trim();
  return out;
}

/** The configured network, or null when Callbook isn't configured. Throws on a half-configured one. */
export function callbookNetwork(rawEnv = process.env, over = {}) {
  const env = arenaEnv(rawEnv);
  const name = over.network ?? env.CALLBOOK_NETWORK;
  if (!name) return null;
  // The published MCP package carries the deployments in its bundle (scripts/build-reins-mcp.mjs).
  const saved = readJson(path.join(ROOT, "deployments", `callbook-${name}.json`)) ?? globalThis.__CALLBOOK_DEPLOYMENTS__?.[name] ?? null;
  const address = over.address ?? env.CALLBOOK_ADDRESS ?? saved?.contracts?.callbook;
  if (!address || !isAddress(address)) throw new Error(`no Arena address for ${name}: set ARENA_ADDRESS`);

  let chain, registry, explorer, label;
  const rpcEnv = over.rpc ?? env.CALLBOOK_RPC;
  if (name === "mainnet") {
    chain = arc; registry = REGISTRIES[arc.id].validation; explorer = "https://explorer.arc.io"; label = "Arc mainnet";
  } else if (name === "testnet") {
    chain = arcTestnet; registry = REGISTRIES[arcTestnet.id].validation; explorer = "https://explorer.testnet.arc.io"; label = "Arc testnet";
  } else if (name === "local") {
    chain = localChain(rpcEnv ?? env.RATCHET_RPC ?? "http://127.0.0.1:8545");
    registry = null; explorer = null; label = "Local chain";
  } else {
    throw new Error("ARENA_NETWORK must be local, testnet or mainnet");
  }
  const local = name === "local";
  const fromBlock = BigInt(over.fromBlock ?? env.CALLBOOK_FROM_BLOCK ?? saved?.fromBlock ?? 0);
  if (!local && fromBlock <= 0n) throw new Error(`set ARENA_FROM_BLOCK (the Arena deploy block) for ${name}; a scan from genesis is refused`);

  registry = over.registry ?? env.CALLBOOK_VALIDATION_REGISTRY ?? registry;
  let validator = over.validator ?? env.CALLBOOK_VALIDATOR ?? saved?.validator ?? null; // the deployment record can name it (and ships in the MCP package)
  let validationOff = null;
  if (validator && !isAddress(validator)) validator = null;
  if (!local && registry && !validator) {
    validationOff = "ARENA_VALIDATOR is not set to a valid address, so validations are ignored";
    registry = null;
  }

  const booksFile = env.CALLBOOK_BOOKS_FILE ?? path.join(ROOT, "deployments", `callbook-${name}-books.json`);
  const ownerEnv = over.owner ?? env.CALLBOOK_OWNER;
  if (ownerEnv && !isAddress(ownerEnv)) throw new Error("ARENA_OWNER must be an address");
  const ours = ourBooksFrom({ record: readJson(booksFile), owner: ownerEnv, callbook: address });

  return {
    name, label, chain, rpc: rpcEnv ?? chain.rpcUrls.default.http[0], address, registry, explorer, local,
    fromBlock, validator, validationOff, ours,
    stateFile: env.CALLBOOK_STATE_FILE ?? path.join(ROOT, "app", "data", `callbook-state-${name}.json`),
  };
}

export function clientFor(net) {
  return createPublicClient({ chain: net.chain, transport: http(net.rpc, { batch: { wait: 16 }, retryCount: 5, retryDelay: 600 }) });
}

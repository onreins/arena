/**
 * The pure parts of `npm run callbook:setup`: what each of our agents
 * registers as on ERC-8004, the registration file it points to, what a book's
 * validation request is, and which steps are still to do given what the chain
 * already holds. No I/O here, so the tests can pin all of it down.
 *
 * ERC-8004 IdentityRegistry v2.0.0 (erc-8004-contracts
 * IdentityRegistryUpgradeable, live on Arc testnet and mainnet):
 *   register() / register(string agentURI) / register(string agentURI, (string,bytes)[] metadata)
 *     -> agentId, minted to msg.sender, ids count up from 0
 *   event Registered(uint256 indexed agentId, string agentURI, address indexed owner)
 *   setAgentURI(agentId, newURI), setMetadata(agentId, key, value) (owner or approved; "agentWallet" reserved)
 *   tokenURI(agentId) is the agent URI; ownerOf(agentId) the owner
 */
import { getAddress, keccak256, encodeAbiParameters, pad } from "viem";

import { validationRequestFor, SCORING_VERSION } from "../app/verify/callbook-chain.js";

export const REGISTRATION_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";
export const MCP_VERSION = "2025-06-18";
export const DEFAULT_BASE = "https://app.reins.one";
export const DEFAULT_MCP = "https://github.com/onreins/reins-mcp";
/** Where the registration files live in the app (served from app/public, so at /arena/agents/<slug>.json). */
export const CARDS_PATH = "arena/agents";

/**
 * OpenZeppelin ERC721Upgradeable's ERC-7201 storage location; `_owners` is its
 * third field. The reference IdentityRegistry keeps ownership there, so a dry
 * run can make the owner "own" an agent that isn't minted yet.
 */
export const OZ_ERC721_STORAGE = 0x80bb2b638cc20bc4d0a60d66940f3ab4a00c1d7b313497ca82fb0b4ab0079300n;
export const ownerSlot = (agentId) =>
  keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [BigInt(agentId), OZ_ERC721_STORAGE + 2n]));
/** A state override under which `owner` owns `agentId` in `identityRegistry`. */
export const ownershipOverride = (identityRegistry, agentId, owner) => ({
  address: identityRegistry,
  stateDiff: [{ slot: ownerSlot(agentId), value: pad(getAddress(owner)) }],
});

const same = (a, b) => a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase();

// ------------------------------------------------------------------ names and URIs

/** "reins/arena/hot-list/v1" -> "hot-list". */
export function slugOf(strategyId) {
  const parts = String(strategyId).split("/");
  const slug = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`can't make a slug from strategy id ${strategyId}`);
  return slug;
}

const trimBase = (base) => String(base ?? DEFAULT_BASE).replace(/\/+$/, "");

export function agentUriFor(base, slug) {
  return `${trimBase(base)}/${CARDS_PATH}/${slug}.json`;
}

export const bookPageFor = (base, bookId) => `${trimBase(base)}/arena-bot?b=${bookId}`;

/** ERC-8004's global name for a registry: "eip155:<chainId>:<address>". */
export const agentRegistryOf = (chainId, identityRegistry) => `eip155:${Number(chainId)}:${getAddress(identityRegistry)}`;

/**
 * The validation request for a book: the shared descriptor, data URI and
 * keccak256 hash. The agent id goes in too, so the request hash binds the
 * agent as well as the book (the descriptor is app/verify/callbook-chain.js's).
 */
export function requestForBook({ chainId, callbook, bookId, agentId }) {
  return validationRequestFor({ chainId, callbook, bookId, ...(agentId != null ? { agentId } : {}) });
}

// ------------------------------------------------------------------ the registration file

/**
 * One agent's ERC-8004 registration file. `registrations` and `books` cover
 * every network the agent is on (the file is hosted once, at one URI); the
 * `web` service points at the mainnet book when there is one, else testnet,
 * else the Callbook board. The `callbook` block is our own extension:
 * the strategy commitment and every book, so a reader can find the record.
 *
 * books: [{ chainId, identityRegistry, agentId, callbook, bookId, requestHash, validator }]
 */
export function registrationFile({ agent, base, mcpUrl = DEFAULT_MCP, books = [] }) {
  const sorted = [...books].sort((a, b) => Number(a.chainId) - Number(b.chainId) || Number(a.bookId) - Number(b.bookId));
  const preferred = sorted.find((b) => Number(b.chainId) === 5042) ?? sorted.find((b) => Number(b.chainId) === 5042002) ?? null;
  const registrations = [];
  for (const b of sorted) {
    const entry = { agentId: Number(b.agentId), agentRegistry: agentRegistryOf(b.chainId, b.identityRegistry) };
    if (!registrations.some((r) => r.agentRegistry === entry.agentRegistry && r.agentId === entry.agentId)) registrations.push(entry);
  }
  return {
    type: REGISTRATION_TYPE,
    name: `Arena: ${agent.name}`,
    description:
      `${agent.description} A Reins agent on Arena: it locks one call every ${agent.periodSec / 3600}h on Arc before the period starts, ` +
      `reveals it after the horizon, and asks the Reins validator to score its record on the ERC-8004 Validation Registry (${SCORING_VERSION}).`,
    image: `${trimBase(base)}/favicon.svg`,
    services: [
      { name: "web", endpoint: preferred ? bookPageFor(base, preferred.bookId) : `${trimBase(base)}/arena` },
      { name: "MCP", endpoint: mcpUrl, version: MCP_VERSION },
    ],
    x402Support: false,
    active: true,
    registrations,
    // ERC-8004 leaves the list open ("reputation", "crypto-economic", "tee-attestation" are examples);
    // this agent's trust comes from validation responses anyone can recompute.
    supportedTrust: ["validation"],
    callbook: {
      strategy: agent.strategy,
      strategyHash: agent.strategyHash,
      coins: agent.coins,
      periodSec: agent.periodSec,
      horizonSec: agent.horizonSec,
      scoring: SCORING_VERSION,
      books: sorted.map((b) => ({
        chainId: Number(b.chainId),
        callbook: getAddress(b.callbook),
        bookId: Number(b.bookId),
        agentId: Number(b.agentId),
        requestHash: b.requestHash ?? null,
        validator: b.validator ? getAddress(b.validator) : null,
        page: Number(b.chainId) === Number(preferred?.chainId) ? bookPageFor(base, b.bookId) : null,
      })),
    },
  };
}

/** Books in an existing registration file, so another network's entries survive a rewrite. */
export function booksFromFile(file, { identityRegistryByChain = {} } = {}) {
  const list = file?.callbook?.books ?? [];
  return list
    .filter((b) => b && b.chainId != null && b.callbook && b.bookId != null && b.agentId != null)
    .map((b) => {
      const reg = (file.registrations ?? []).find((r) => r.agentId === b.agentId && String(r.agentRegistry).startsWith(`eip155:${b.chainId}:`));
      const identityRegistry = reg ? reg.agentRegistry.split(":")[2] : identityRegistryByChain[b.chainId];
      return identityRegistry ? { ...b, identityRegistry } : null;
    })
    .filter(Boolean);
}

/** `existing` with `update` replacing any book on the same chain and Callbook contract. */
export function mergeBooks(existing, update) {
  const key = (b) => `${Number(b.chainId)}:${String(b.callbook).toLowerCase()}`;
  const out = existing.filter((b) => !update.some((u) => key(u) === key(b)));
  return [...out, ...update];
}

// ------------------------------------------------------------------ idempotency

/**
 * What's left to do for one agent, from what the chain says.
 *
 * facts: {
 *   agentId:        our agent's id if one is known and owned by us, else null
 *   tokenURI:       its current URI (when agentId is known)
 *   book:           our open book for this strategy and agent, else null ({ id, caller })
 *   request:        null (none), { validator, agentId } (filed)
 * }
 * want: { agentURI, caller, validator, agentId }
 *
 * Returns the ordered steps: "register", "setAgentURI", "open", "setCaller", "request".
 * Throws when the chain holds something setup must not paper over.
 */
export function planAgent(facts, want) {
  const steps = [];
  if (facts.agentId == null) steps.push("register");
  else if (facts.tokenURI !== want.agentURI) steps.push("setAgentURI");

  if (!facts.book) steps.push("open");
  else if (!same(facts.book.caller, want.caller)) steps.push("setCaller");

  if (!facts.request) steps.push("request");
  else if (!same(facts.request.validator, want.validator)) {
    throw new Error(
      `the validation request for this book already names validator ${facts.request.validator}, not ${want.validator}; ` +
        "a request hash can be filed once, so close the book and open a new one to change validators",
    );
  } else if (want.agentId != null && facts.request.agentId != null && String(facts.request.agentId) !== String(want.agentId)) {
    throw new Error(
      `the validation request for this book was filed for agent #${facts.request.agentId}, not agent #${want.agentId}; ` +
        "a request hash can be filed once, so close the book and open a new one for this agent",
    );
  }
  return steps;
}

/**
 * Our agent among candidates found on chain: a book's agent first (it proves
 * the agent is ours and in use), then a registration with our URI, newest last.
 * candidates: { fromBooks: [agentId], fromRecord: agentId|null, fromRegistered: [{ agentId, agentURI }] }
 */
export function pickAgentId({ fromBooks = [], fromRecord = null, fromRegistered = [] }, agentURI) {
  if (fromBooks.length) return fromBooks[fromBooks.length - 1];
  if (fromRecord != null) return fromRecord;
  const matches = fromRegistered.filter((r) => r.agentURI === agentURI);
  return matches.length ? matches[0].agentId : null;
}

/** Our open book for an agent: opened by `owner`, same strategy, linked to `agentId`, not closed. Newest wins. */
export function findBook(books, { owner, strategyHash, agentId }) {
  const ours = [...books]
    .filter((b) => same(b.owner, owner) && same(b.strategyHash, strategyHash) && b.closedAt == null)
    .filter((b) => agentId == null || String(b.agentId) === String(agentId));
  return ours.length ? ours[ours.length - 1] : null;
}

// ------------------------------------------------------------------ keys and costs

/** Setup refuses to run with shared roles: each key does one job (see docs/CALLBOOK-RUNBOOK.md). */
export function checkRoles({ owner, caller, validator }) {
  const problems = [];
  if (same(owner, caller)) problems.push("the owner and the caller must be different keys (the caller key lives on the runner)");
  if (same(owner, validator)) problems.push("the owner and the validator must be different keys (an agent must not validate itself)");
  if (same(caller, validator)) problems.push("the caller and the validator must be different keys");
  return problems;
}

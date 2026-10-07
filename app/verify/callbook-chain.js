/**
 * Reading Callbook and the ERC-8004 ValidationRegistry from a chain: only
 * events and block times, so anyone with an RPC gets the same record.
 *
 * Logs are read in block chunks (Arc's RPC answers about 5,000 blocks per
 * getLogs), and a previous read can be passed back in as `state` so a
 * long-running server only scans what's new. Block times are looked up once
 * per block and remembered; past blocks never change.
 *
 * How a validation request names a book: the agent's owner files
 * validationRequest(validator, agentId, requestURI, requestHash) with
 *   requestURI  = "data:application/json;base64," + base64(descriptor)
 *   requestHash = keccak256(descriptor)
 * where the descriptor is canonical JSON (sorted keys, no spaces):
 *   {"agentId":"1413","bookId":"1","callbook":"0x…","chainId":5042,"scoring":"arena-v1"}
 * (agentId binds the hash to one agent, so nobody can squat a book's request)
 * so the request is self-describing and its hash is checkable without fetching
 * anything.
 */
import { parseAbi, keccak256, toBytes, getAddress } from "viem";

/** "No ERC-8004 agent linked" in Callbook. */
export const NO_AGENT = 2n ** 256n - 1n;
export const SCORING_VERSION = "arena-v1";
export const DEFAULT_LOG_CHUNK = 5_000n;

export const CALLBOOK_EVENTS = parseAbi([
  "event Opened(uint256 indexed bookId, address indexed owner, uint256 indexed agentId, address caller, bytes32 strategyHash, string[] coins, uint32 period, uint32 horizon, uint64 start)",
  "event CallerSet(uint256 indexed bookId, address indexed caller)",
  "event Sealed(uint256 indexed bookId, uint64 indexed p, bytes32 callHash)",
  "event Revealed(uint256 indexed bookId, uint64 indexed p, uint8 coinIndex, int8 side)",
  "event Closed(uint256 indexed bookId)",
  // Open-call (free) books: calls locked whenever the caller likes.
  "event OpenedFree(uint256 indexed bookId, address indexed owner, uint256 indexed agentId, address caller, bytes32 metaHash, string[] coins, uint32 minHorizon, uint32 maxHorizon)",
  "event Locked(uint256 indexed bookId, uint64 indexed callId, bytes32 callHash, uint64 entryAt, uint32 horizon)",
  "event RevealedLocked(uint256 indexed bookId, uint64 indexed callId, uint8 coinIndex, int8 side, uint32 horizon)",
  "event RevealedLockedSymbol(uint256 indexed bookId, uint64 indexed callId, string coin, int8 side, uint32 horizon)",
  // Names: bookId 0 is the account itself; the newest event wins and an empty name clears.
  "event Profile(address indexed account, uint256 indexed bookId, string name, string bio, string link)",
]);

export const VALIDATION_EVENTS = parseAbi([
  "event ValidationRequest(address indexed validatorAddress, uint256 indexed agentId, string requestURI, bytes32 indexed requestHash)",
  "event ValidationResponse(address indexed validatorAddress, uint256 indexed agentId, bytes32 indexed requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)",
]);

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// ------------------------------------------------------------------ canonical JSON

/** JSON with object keys sorted at every level and no whitespace: one text per value. */
export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, sortKeys(v[k])]));
  }
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number" && !Number.isFinite(v)) return null;
  return v;
}
export const hashText = (text) => keccak256(toBytes(text));

// ------------------------------------------------------------------ request descriptors

/**
 * With an agent, its id is in the descriptor, so the request hash is that
 * agent's alone: someone filing first for the same book under another agent
 * gets a different hash and can't block ours.
 */
export function bookDescriptor({ chainId, callbook, bookId, agentId }) {
  return canonicalJson({
    agentId: agentId == null ? undefined : String(agentId),
    bookId: String(bookId), callbook: getAddress(callbook).toLowerCase(), chainId: Number(chainId), scoring: SCORING_VERSION,
  });
}

/** The URI and hash an agent's owner files for a book. */
export function validationRequestFor(book) {
  const text = bookDescriptor(book);
  return { requestURI: `data:application/json;base64,${Buffer.from(text).toString("base64")}`, requestHash: hashText(text), descriptor: text };
}

/** The book a request names, or null if it isn't a Callbook request (or its hash doesn't match). */
export function parseValidationRequest(requestURI, requestHash) {
  const m = /^data:application\/json;base64,([A-Za-z0-9+/=]+)$/.exec(requestURI ?? "");
  if (!m) return null;
  const text = Buffer.from(m[1], "base64").toString("utf8");
  if (requestHash && !same(hashText(text), requestHash)) return null;
  try {
    const d = JSON.parse(text);
    if (d.scoring !== SCORING_VERSION || !d.callbook || d.bookId == null) return null;
    const book = { chainId: Number(d.chainId), callbook: d.callbook.toLowerCase(), bookId: Number(d.bookId) };
    if (d.agentId != null) book.agentId = String(d.agentId);
    return book;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ logs

// Arc's RPC takes at most 10 event signatures in one getLogs and answers
// "requested range too large" for more, even over a single block.
export const MAX_EVENTS_PER_QUERY = 10;

/** Logs in unsorted order: block chunks, and event groups the RPC accepts. Callers sort. */
async function getLogsChunked(client, { address, events, fromBlock, toBlock, chunk }) {
  const out = [];
  for (let i = 0; i < events.length; i += MAX_EVENTS_PER_QUERY) {
    const group = events.slice(i, i + MAX_EVENTS_PER_QUERY);
    let size = chunk;
    for (let from = fromBlock; from <= toBlock;) {
      const to = from + size - 1n < toBlock ? from + size - 1n : toBlock;
      try {
        out.push(...(await client.getLogs({ address, events: group, fromBlock: from, toBlock: to, strict: false })));
        from = to + 1n;
      } catch (err) {
        // A range the RPC won't serve in one go: halve it and try again.
        if (size <= 1n) throw err;
        size /= 2n;
      }
    }
  }
  return out;
}

async function blockTimes(client, logs, cache) {
  const missing = [...new Set(logs.map((l) => l.blockNumber).filter((b) => !cache.has(b)))];
  for (const l of logs) if (l.blockTimestamp != null && !cache.has(l.blockNumber)) cache.set(l.blockNumber, Number(l.blockTimestamp));
  const want = missing.filter((b) => !cache.has(b));
  for (let i = 0; i < want.length; i += 50) {
    const blocks = await Promise.all(want.slice(i, i + 50).map((blockNumber) => client.getBlock({ blockNumber })));
    for (const b of blocks) cache.set(b.number, Number(b.timestamp));
  }
}

const agentOf = (id) => (id === NO_AGENT ? null : id <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(id) : id.toString());

function applyCallbookLog(books, log, at) {
  const a = log.args;
  const id = Number(a.bookId);
  if (log.eventName === "Opened") {
    books.set(id, {
      id, kind: "scheduled", owner: a.owner.toLowerCase(), agentId: agentOf(a.agentId), caller: a.caller.toLowerCase(),
      strategyHash: a.strategyHash, coins: [...a.coins], periodSec: Number(a.period), horizonSec: Number(a.horizon),
      start: Number(a.start), openedAt: at, openTx: log.transactionHash, closedAt: null, seals: new Map(),
    });
    return;
  }
  if (log.eventName === "OpenedFree") {
    // An empty coin list is an any-coin book (an account's default book): calls name their coin as text.
    books.set(id, {
      id, kind: "free", owner: a.owner.toLowerCase(), agentId: agentOf(a.agentId), caller: a.caller.toLowerCase(),
      strategyHash: a.metaHash, coins: [...a.coins], anyCoin: a.coins.length === 0,
      minHorizon: Number(a.minHorizon), maxHorizon: Number(a.maxHorizon),
      openedAt: at, openTx: log.transactionHash, closedAt: null, locks: new Map(),
    });
    return;
  }
  const book = books.get(id);
  if (!book) return; // an event for a book opened before fromBlock
  if (log.eventName === "Locked") {
    book.locks?.set(Number(a.callId), {
      callId: Number(a.callId), hash: a.callHash, lockedAt: at, entryAt: Number(a.entryAt), horizon: Number(a.horizon), lockTx: log.transactionHash, reveal: null,
    });
    return;
  }
  if (log.eventName === "RevealedLocked" || log.eventName === "RevealedLockedSymbol") {
    const l = book.locks?.get(Number(a.callId));
    if (!l) return;
    const symbol = log.eventName === "RevealedLockedSymbol" ? a.coin : book.coins[Number(a.coinIndex)];
    l.reveal = { coinIndex: a.coinIndex == null ? null : Number(a.coinIndex), symbol, side: Number(a.side), horizon: a.horizon == null ? l.horizon : Number(a.horizon), at, tx: log.transactionHash };
    return;
  }
  if (log.eventName === "CallerSet") book.caller = a.caller.toLowerCase();
  else if (log.eventName === "Closed") book.closedAt = at;
  else if (log.eventName === "Sealed") {
    book.seals?.set(Number(a.p), { p: Number(a.p), hash: a.callHash, sealedAt: at, sealTx: log.transactionHash, reveal: null });
  } else if (log.eventName === "Revealed") {
    const s = book.seals?.get(Number(a.p));
    if (s) s.reveal = { coinIndex: Number(a.coinIndex), side: Number(a.side), at, tx: log.transactionHash };
  }
}

/** The key a profile is kept under: an account, and 0 or one of its books. */
export const profileKey = (account, bookId = 0) => `${String(account).toLowerCase()}:${Number(bookId)}`;

/** The raw text as sent; arena-names.js decides what of it is shown. */
function applyProfileLog(profiles, log, at) {
  const a = log.args;
  profiles.set(profileKey(a.account, a.bookId), {
    account: a.account.toLowerCase(), bookId: Number(a.bookId), name: a.name ?? "", bio: a.bio ?? "", link: a.link ?? "", at, tx: log.transactionHash,
  });
}

/** The longest request URI kept: a book descriptor is a few hundred characters. */
export const MAX_REQUEST_URI = 8_192;

function applyValidationLog(v, log, at, validator) {
  const a = log.args;
  if (validator && !same(a.validatorAddress, validator)) return;
  if (log.eventName === "ValidationRequest") {
    // Anyone can file a request naming our validator; ours are small, so a huge URI is ignored, not kept.
    if (String(a.requestURI ?? "").length > MAX_REQUEST_URI) return;
    v.requests.set(a.requestHash, {
      requestHash: a.requestHash, validator: a.validatorAddress.toLowerCase(), agentId: agentOf(a.agentId),
      uri: a.requestURI, book: parseValidationRequest(a.requestURI, a.requestHash), at, tx: log.transactionHash,
    });
  } else {
    const list = v.responses.get(a.requestHash) ?? [];
    list.push({
      requestHash: a.requestHash, validator: a.validatorAddress.toLowerCase(), agentId: agentOf(a.agentId),
      score: Number(a.response), uri: a.responseURI, responseHash: a.responseHash, tag: a.tag, at, tx: log.transactionHash,
      block: log.blockNumber, logIndex: log.logIndex,
    });
    v.responses.set(a.requestHash, list);
  }
}

/**
 * Every book, seal, reveal and close, and (when `validationRegistry` is given)
 * every request and response naming `validator` (any validator when unset).
 *
 * opts: { client, address, fromBlock, toBlock?, validationRegistry?, validator?, state?, chunk? }
 * Returns { address, chainId, toBlock, books: Map<id, book>, profiles: Map<profileKey, profile>,
 * validation: { requests, responses }, blockTimes }
 * and is itself a valid `state` for the next call.
 */
export async function readCallbook({ client, address, fromBlock = 0n, toBlock, validationRegistry, validator, state, chunk = DEFAULT_LOG_CHUNK }) {
  const head = toBlock ?? (await client.getBlockNumber({ cacheTime: 0 })); // no cached head: a replay moves fast
  const s = state ?? {
    address: address.toLowerCase(),
    chainId: await client.getChainId(),
    toBlock: BigInt(fromBlock) - 1n,
    books: new Map(),
    profiles: new Map(),
    validation: { requests: new Map(), responses: new Map() },
    blockTimes: new Map(),
  };
  s.profiles ??= new Map(); // a snapshot saved before profiles existed
  const from = s.toBlock + 1n;
  if (from > head) return s;

  const addresses = [address, ...(validationRegistry ? [validationRegistry] : [])];
  const logs = await getLogsChunked(client, {
    address: addresses, events: [...CALLBOOK_EVENTS, ...VALIDATION_EVENTS], fromBlock: from, toBlock: head, chunk: BigInt(chunk),
  });
  logs.sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1));
  await blockTimes(client, logs, s.blockTimes);

  for (const log of logs) {
    if (!log.eventName || !log.args) continue;
    const at = s.blockTimes.get(log.blockNumber);
    if (same(log.address, address)) {
      if (log.eventName === "Profile") applyProfileLog(s.profiles, log, at);
      else if (CALLBOOK_EVENTS.some((e) => e.name === log.eventName)) applyCallbookLog(s.books, log, at);
    } else if (VALIDATION_EVENTS.some((e) => e.name === log.eventName)) {
      applyValidationLog(s.validation, log, at, validator);
    }
  }
  s.toBlock = head;
  s.blockTimes = new Map(); // only the next read's own blocks are ever needed
  return s;
}

// ------------------------------------------------------------------ snapshots

// 2: states carry profiles. A version-1 snapshot may have scanned past Profile events without keeping them, so it is read again from the start.
const SNAPSHOT_VERSION = 2;
const big = (_, v) => (typeof v === "bigint" ? `${v}n` : v instanceof Map ? { __map: [...v.entries()] } : v);
const unbig = (_, v) => {
  if (typeof v === "string" && /^\d+n$/.test(v)) return BigInt(v.slice(0, -1));
  if (v && typeof v === "object" && Array.isArray(v.__map)) return new Map(v.__map);
  return v;
};

/**
 * A read's state as text, so a cold start (a new server, a serverless
 * instance) continues from `toBlock` instead of scanning from the deploy
 * block. It records what it was read with; a snapshot read with another
 * contract, chain, registry or validator is not used.
 */
export function snapshotText(state, { validationRegistry = null, validator = null } = {}) {
  const { blockTimes, ...rest } = state;
  return JSON.stringify({
    version: SNAPSHOT_VERSION, savedAt: new Date().toISOString(),
    validationRegistry: validationRegistry?.toLowerCase() ?? null, validator: validator?.toLowerCase() ?? null, state: rest,
  }, big);
}

/** A state from snapshotText, or null when it doesn't match what we'd read. */
export function stateFromSnapshot(text, { address, chainId, validationRegistry = null, validator = null }) {
  try {
    const snap = JSON.parse(text, unbig);
    const s = snap?.state;
    if (snap?.version !== SNAPSHOT_VERSION || !s || !same(s.address, address) || Number(s.chainId) !== Number(chainId)) return null;
    if ((snap.validationRegistry ?? null) !== (validationRegistry?.toLowerCase() ?? null)) return null;
    if ((snap.validator ?? null) !== (validator?.toLowerCase() ?? null)) return null;
    return { ...s, toBlock: BigInt(s.toBlock), blockTimes: new Map() };
  } catch {
    return null;
  }
}

/** The request (naming `validator`, when given) that asks for this book to be scored, if any. */
export function requestForBook(chain, bookId, validator) {
  for (const r of chain.validation.requests.values()) {
    if (!r.book || r.book.bookId !== Number(bookId) || !same(r.book.callbook, chain.address) || r.book.chainId !== Number(chain.chainId)) continue;
    if (validator && !same(r.validator, validator)) continue;
    // A descriptor that names an agent counts only when filed by that agent.
    if (r.book.agentId != null && r.book.agentId !== String(r.agentId)) continue;
    const book = chain.books.get(Number(bookId));
    // Only the agent linked to the book can ask for it to be scored.
    if (book && book.agentId != null && String(book.agentId) === String(r.agentId)) return r;
  }
  return null;
}

/** The latest response to a request (by block and log order), or null. */
/**
 * The latest response to a request with this tag: the track record score
 * (SCORING_VERSION, the default) and the skill score (arena-skill-v1) are
 * posted to the same request under their own tags, and never stand in for each other.
 */
export function latestResponse(chain, requestHash, tag = SCORING_VERSION) {
  const list = (chain.validation.responses.get(requestHash) ?? []).filter((r) => r.tag === tag);
  return list.length ? list[list.length - 1] : null;
}

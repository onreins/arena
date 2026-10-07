/**
 * Arena SDK: everything an agent needs to keep an honest trading record
 * on Arc, with one key.
 *
 *   import { CallbookClient } from "./callbook/sdk.js";
 *   const cb = new CallbookClient({ network: "testnet", key: process.env.CALLBOOK_KEY });
 *
 *   await cb.markets();                                       // liquid Hyperliquid perps
 *   await cb.lock({ coin: "ETH", side: "long", horizon: "4h" }); // an open call; first one opens your book
 *   await cb.revealDue();                                     // reveal whatever has matured
 *   await cb.status();                                        // record, score, countdowns
 *
 *   const { bookId } = await cb.openStrategyBook({ coins: ["BTC", "ETH"], every: "4h" });
 *   await cb.seal({ book: bookId, coin: "BTC", side: "flat" });  // this round's call
 *
 * Nothing needs storing: salts derive from the key (or a separate saltSecret),
 * and every call can be recovered from its hash (see callbook/proof.js). A
 * local journal (~/.arena/<address>.json) only saves that search.
 *
 * Gas: with a relayUrl and a key holding no USDC, locks, seals and reveals go
 * through Reins' relayer (EIP-712 signatures; Reins pays the gas). Opening a
 * strategy or coin-list book is always a transaction the key pays for.
 *
 * Whose books: the client acts (seals, locks, reveals, reports status) only in
 * books this key owns, plus any listed in `books`. Anyone can open a book that
 * names your key as its caller; that alone doesn't make it yours.
 *
 * Locks from one key are serialised in this process, and each names the call
 * id (or nonce) its hash was made for, so two locks can't race into a call
 * that can never be revealed: the loser reverts with StaleId instead.
 *
 * Every error is a CallbookError whose message is a plain sentence.
 */
import { createWalletClient, http, keccak256, toHex, parseEventLogs, isAddress, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { artifact } from "../scripts/artifact.js";
import {
  readCallbook, evaluateAny, bookToApi, callerToApi, requestForBook, latestResponse, asOfFromUri,
  exitOf, startOf, GRACE, NO_AGENT,
} from "../app/verify/callbook.js";
import { callbookNetwork, clientFor } from "../app/verify/callbook-network.js";
import { createPriceSource } from "../app/verify/callbook-prices.js";
import { CallbookError, fail, explain } from "./errors.js";
import { createMarkets, MIN_VOLUME_USD } from "./markets.js";
import { Journal, defaultJournalPath } from "./journal.js";
import { relay, LOCK_TYPES, SEAL_TYPES, PROFILE_TYPES, domainOf } from "./relay.js";
import { checkProfile, profileForDisplay } from "../app/verify/arena-names.js";
import { profileKey } from "../app/verify/callbook-chain.js";
import { profileFor } from "../app/verify/callbook-agents.js";
import {
  saltSecretFromKey, sealSalt, lockSalt, symbolSalt, callHash, lockedHash, symbolHash,
  recoverSealedCall, recoverLockedCall, recoverSymbolCall, SIDES,
} from "./proof.js";
import { strategyTiming, callHorizon, parseDuration, formatDuration, countdown, utc, MAX_HORIZON, MIN_CALL_HORIZON } from "./durations.js";
import { bookLine, strategyStatus, callsStatus, sealableRound, SIDE_WORD } from "./view.js";

const CALLBOOK = artifact("Callbook");
const ABI = CALLBOOK.abi;
/** Treat a key as having gas when it can pay for this much at the current price. */
const GAS_HEADROOM = 600_000n;
const LOCK_SIG_TTL = 600;
/** One queue of locks per key in this process (see the top of the file). */
const LOCK_QUEUES = new Map();
const SALT_SECRET = /^(0x)?[0-9a-fA-F]{64}$/;
const DEFAULT_SEAL_MARGIN = 10;
const API_TIMEOUT_MS = 15_000;
export const DEFAULT_APP_URL = "https://app.reins.one";

const NETWORK_LABEL = { local: "the local chain", testnet: "Arc testnet", mainnet: "Arc mainnet" };
const same = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

/** "long" | "short" | "flat" (or up/down, buy/sell) to -1, 0, 1. */
function sideOf(side, { allowFlat }) {
  const word = String(side ?? "").trim().toLowerCase();
  const alias = { up: "long", buy: "long", down: "short", sell: "short", neutral: "flat", none: "flat" }[word] ?? word;
  if (alias === "flat" && !allowFlat) {
    fail("An open call is a position: long or short. Flat only exists in strategy books, as a round's call.", "BadSide");
  }
  if (!(alias in SIDES)) fail(`"${side}" isn't a side. Use ${allowFlat ? "long, short or flat" : "long or short"}.`, "BadSide");
  return SIDES[alias];
}

const coinList = (coins) => (Array.isArray(coins) ? coins : String(coins ?? "").split(/[,\s]+/)).map((c) => String(c).trim()).filter(Boolean);

export class CallbookClient {
  /**
   * @param {object} o
   * @param {"local"|"testnet"|"mainnet"} [o.network="testnet"]
   * @param {string} o.key              0x private key: owns and calls the books
   * @param {string} [o.address]        the Arena contract (default: deployments/callbook-<network>.json)
   * @param {string} [o.rpc]            RPC URL (default: the chain's public RPC; local: :8545)
   * @param {string} [o.relayUrl]       Reins app URL whose /api/callbook/relay/* pays gas for you
   * @param {string} [o.apiUrl]         Reins app URL for status() (default: computed locally)
   * @param {string} [o.saltSecret]     32 random bytes as hex (64 hex digits, 0x optional); default HMAC-SHA256(key, label), see callbook/proof.js
   * @param {Array<number|string>} [o.books]  other books to act in as their caller (default: only books this key owns)
   * @param {string|false} [o.journal]  journal file, or false for memory only (default ~/.arena/<address>.json)
   * @param {"auto"|"always"|"never"} [o.gasless="auto"]  auto: relay only when the key can't pay gas
   * @param {bigint|number} [o.fromBlock]  first block to read (default: the deployment's)
   * @param {string} [o.validator]      Reins' validator address, for verify()
   * @param {string} [o.validationRegistry]  only needed on a local chain
   * @param {number} [o.sealMarginSec=10]   refuse a seal this close to its deadline
   * @param {object} [o.priceSource]    a callbook-prices source (tests pass synthetic prices)
   * @param {object} [o.markets]        a markets source (tests pass a fixed list)
   * @param {Function} [o.fetch]        fetch for the relay, API and markets
   * @param {object} [o.publicClient]   an existing viem public client
   */
  constructor(o = {}) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(o.key ?? "")) fail("The key must be a 0x-prefixed 64-hex private key (ARENA_KEY). Use a fresh key that holds nothing of value.", "BadKey");
    if (o.address != null && !isAddress(o.address)) fail(`"${o.address}" isn't a contract address.`, "BadAddress");
    this.account = privateKeyToAccount(o.key);
    this.address = this.account.address;
    this.me = this.address.toLowerCase();
    this.network = o.network ?? "testnet";
    if (!NETWORK_LABEL[this.network]) fail(`"${this.network}" isn't a network: use local, testnet or mainnet.`, "BadNetwork");
    this.opts = { gasless: "auto", sealMarginSec: DEFAULT_SEAL_MARGIN, ...o };
    this.secret = o.saltSecret ?? saltSecretFromKey(o.key);
    if (!SALT_SECRET.test(String(this.secret)) || /^(0x)?(.)\2{63}$/i.test(String(this.secret))) {
      fail("saltSecret must be 32 random bytes written as 64 hex digits (for example: openssl rand -hex 32).", "BadSecret");
    }
    this.allowed = new Set((o.books ?? []).map((b) => {
      const id = Number(b);
      if (!Number.isInteger(id) || id < 1) fail(`"${b}" in books isn't a book id (a whole number from 1).`, "BadBook");
      return id;
    }));
    this.fetch = o.fetch ?? globalThis.fetch;
    this.marketsSource = o.markets ?? createMarkets({ fetch: this.fetch });
    this.journal = new Journal(o.journal === false ? null : o.journal ?? defaultJournalPath(this.address));
    this.state = null;
    this.reading = Promise.resolve();
    this.unrecoverable = new Set();
  }

  // ------------------------------------------------------------------ plumbing

  /** Network, clients and contract, resolved on first use. */
  ctx() {
    if (this._ctx) return this._ctx;
    let net;
    try {
      net = callbookNetwork({}, {
        network: this.network, address: this.opts.address, rpc: this.opts.rpc, fromBlock: this.opts.fromBlock,
        registry: this.opts.validationRegistry, validator: this.opts.validator,
      });
    } catch {
      fail(`Arena isn't deployed on ${NETWORK_LABEL[this.network]} yet (no deployments/callbook-${this.network}.json). Set ARENA_ADDRESS to its address.`, "NoDeployment");
    }
    const publicClient = this.opts.publicClient ?? clientFor(net);
    const wallet = createWalletClient({ account: this.account, chain: net.chain, transport: http(net.rpc) });
    this._ctx = { net, publicClient, wallet, callbook: getAddress(net.address), chainId: net.chain.id, label: net.label };
    return this._ctx;
  }

  /** Chain time: what the next transaction's checks will see (near enough). */
  async now() {
    return Number((await this.ctx().publicClient.getBlock()).timestamp);
  }

  /** Every book, seal and lock, read incrementally (one read at a time). */
  async read() {
    const { publicClient, callbook, net } = this.ctx();
    const next = this.reading.then(async () => {
      this.state = await readCallbook({ client: publicClient, address: callbook, fromBlock: net.fromBlock, state: this.state });
      return this.state;
    });
    this.reading = next.catch(() => {});
    try {
      return await next;
    } catch (err) {
      throw this.explain(err);
    }
  }

  explain(err, extra = {}) {
    const c = this._ctx;
    return explain(err, { network: c?.label ?? NETWORK_LABEL[this.network], address: this.address, ...extra });
  }

  view(functionName, args = []) {
    const { publicClient, callbook } = this.ctx();
    return publicClient.readContract({ address: callbook, abi: ABI, functionName, args });
  }

  async hasGas() {
    const { publicClient } = this.ctx();
    const [balance, price] = await Promise.all([publicClient.getBalance({ address: this.address }), publicClient.getGasPrice()]);
    return balance >= price * GAS_HEADROOM;
  }

  /** Whether to go through the relayer for this transaction. */
  async gasless() {
    const mode = this.opts.gasless;
    if (!this.opts.relayUrl || mode === "never") return false;
    if (mode === "always") return true;
    return !(await this.hasGas());
  }

  /** Simulate (for a readable refusal), send, and wait. Returns the receipt. */
  async send(functionName, args, ctx = {}) {
    const { publicClient, wallet, callbook } = this.ctx();
    try {
      const { request } = await publicClient.simulateContract({ address: callbook, abi: ABI, functionName, args, account: this.account });
      // Nodes word "no funds" differently (Hardhat says "invalid parameters"), so check first.
      if (!(await this.hasGas())) {
        const net = this._ctx?.label ?? NETWORK_LABEL[this.network];
        fail(`This key has no USDC for gas on ${net}. Fund ${this.address} (testnet: faucet.circle.com), or set a relay URL to go gasless.`, "NoGas");
      }
      const hash = await wallet.writeContract(request);
      return await this.receipt(hash, functionName);
    } catch (err) {
      throw this.explain(err, ctx);
    }
  }

  async receipt(hash, what) {
    const receipt = await this.ctx().publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") fail(`The ${what} transaction ${hash} reverted.`, "Reverted");
    return receipt;
  }

  events(receipt, eventName) {
    const { callbook } = this.ctx();
    return parseEventLogs({ abi: ABI, logs: receipt.logs, eventName }).filter((l) => same(l.address, callbook));
  }

  async relayed(what, body, label) {
    const tx = await relay({ relayUrl: this.opts.relayUrl, fetch: this.fetch }, what, body);
    return this.receipt(tx, label);
  }

  async sign(types, primaryType, message) {
    const { callbook, chainId } = this.ctx();
    return this.account.signTypedData({ domain: domainOf({ chainId, callbook }), types, primaryType, message });
  }

  /** A book this key may call in. */
  async myBook(bookId) {
    const id = Number(bookId);
    if (!Number.isInteger(id) || id < 1) fail(`"${bookId}" isn't a book id (a whole number from 1).`, "BadBook");
    const state = await this.read();
    const book = state.books.get(id);
    if (!book) fail(`There's no book ${id} on ${this.ctx().label} (from block ${this.ctx().net.fromBlock}).`, "UnknownBook");
    return book;
  }

  /** "owner", "caller" (only for a book listed in `books`), or null: this client doesn't act there. */
  role(book) {
    if (book.owner === this.me) return "owner";
    return this.allowed.has(book.id) && book.caller === this.me ? "caller" : null;
  }

  /** Why this key won't act in a book it doesn't own, as a sentence. */
  notMine(book, verb) {
    const asCaller = book.caller === this.me && !this.allowed.has(book.id);
    fail(asCaller
      ? `Book ${book.id} belongs to ${book.owner} and only names this key as its caller. To ${verb} in it anyway, list it in \`books\` (ARENA_BOOKS).`
      : `This key can't ${verb} in book ${book.id}: it's neither its owner nor an allowed caller.`, "NotCaller");
  }

  /** Run fn with no other lock from this key in flight (in this process). */
  async exclusive(fn) {
    const prev = LOCK_QUEUES.get(this.me) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    LOCK_QUEUES.set(this.me, tail);
    try {
      return await run;
    } finally {
      if (LOCK_QUEUES.get(this.me) === tail) LOCK_QUEUES.delete(this.me);
    }
  }

  async resolveCoin(symbol, { strict = true } = {}) {
    const raw = String(symbol ?? "").trim();
    if (!raw) fail("Name a coin, for example ETH.", "BadCoin");
    let found = null;
    try {
      found = await this.marketsSource.resolve(raw);
    } catch (err) {
      if (strict) throw err;
      return raw.toUpperCase();
    }
    if (!found) fail(`Hyperliquid has no perp called "${raw}". Ask arena_markets for the list.`, "UnknownCoin");
    return found;
  }

  // ------------------------------------------------------------------ reading

  /** Liquid Hyperliquid perps, most traded first: [{ coin, volumeUsd, price, funding }]. */
  async markets({ limit = 50, minVolumeUsd = MIN_VOLUME_USD } = {}) {
    const list = await this.marketsSource.list({ limit, minVolumeUsd });
    return list.map((p) => ({ coin: p.coin, volumeUsd: Math.round(p.volumeUsd), price: p.price, funding: p.funding }));
  }

  /** Books this key owns (or is allowed to call in), with what's due. */
  async myBooks() {
    const state = await this.read();
    const [now, defaultBook] = await Promise.all([this.now(), this.view("defaultBookOf", [this.address]).then(Number)]);
    const mine = [...state.books.values()].filter((b) => this.role(b)).sort((a, b) => a.id - b.id);
    const plain = (book, l) => this.journal.get(this.slot(book, l));
    const books = mine.map((b) => bookLine(b, { me: this.me, now, defaultBook, plain }));
    // Books that name this key as caller without being ours: listed, never acted in.
    const ignored = [...state.books.values()].filter((b) => !this.role(b) && b.caller === this.me).map((b) => b.id).sort((a, b) => a - b);
    return { address: this.address, network: this.ctx().label, defaultBook: defaultBook || null, books, ...(ignored.length ? { ignored } : {}) };
  }

  slot(book, l) {
    const { chainId, callbook } = this.ctx();
    return { chainId, callbook, bookId: book.id, callId: l.callId };
  }

  // ------------------------------------------------------------------ opening books

  async agentArg(agentId) {
    if (agentId == null || agentId === "") return NO_AGENT;
    if (!/^\d+$/.test(String(agentId))) fail(`"${agentId}" isn't an ERC-8004 agent id (a whole number).`, "BadAgent");
    return BigInt(agentId);
  }

  async checkedCoins(coins) {
    const list = coinList(coins);
    if (!list.length || list.length > 32) fail("A book takes 1 to 32 coins, for example [\"BTC\", \"ETH\"].", "BadCoins");
    const out = [];
    for (const c of list) {
      const coin = await this.resolveCoin(c, { strict: false });
      if (new TextEncoder().encode(coin).length > 16) fail(`"${coin}" is longer than 16 bytes, which a book can't hold.`, "BadCoins");
      if (out.includes(coin)) fail(`${coin} is listed twice.`, "BadCoins");
      out.push(coin);
    }
    return out;
  }

  /**
   * Open a strategy book: one call per period, every period, from the next one.
   * strategy: text whose keccak256 is the book's strategyHash (default: name, or the coins and period).
   */
  async openStrategyBook({ name, strategy, coins, every = "4h", horizon, agentId, caller } = {}) {
    const timing = this.wrap(() => strategyTiming(every, horizon));
    const list = await this.checkedCoins(coins);
    const callerAddr = caller ?? this.address;
    if (!isAddress(callerAddr)) fail(`"${caller}" isn't an address.`, "BadCaller");
    const strategyHash = keccak256(toHex(strategy ?? name ?? `${list.join(",")} every ${formatDuration(timing.periodSec)}`));
    const receipt = await this.send("open", [await this.agentArg(agentId), callerAddr, strategyHash, list, timing.periodSec, timing.horizonSec], { action: "open" });
    const ev = this.events(receipt, "Opened")[0].args;
    const start = Number(ev.start);
    return {
      bookId: Number(ev.bookId), kind: "strategy", coins: list, every: formatDuration(timing.periodSec), horizon: formatDuration(timing.horizonSec),
      strategyHash, agentId: agentId ?? null, start, firstRound: { round: 0, startsAt: start, sealBy: start - 60 }, tx: receipt.transactionHash,
      summary: `Opened strategy book ${Number(ev.bookId)}: ${list.join("/")} every ${formatDuration(timing.periodSec)}. Seal round 0 by ${utc(start - 60)}; a round with no call counts as missed.`,
    };
  }

  /**
   * Open a book of open calls. Without coins it's your any-coin book, which
   * the contract opens with your first lock (gasless), so nothing is sent here.
   */
  async openCallBook({ coins, minHorizon = "5m", maxHorizon = "30d", agentId, name, meta } = {}) {
    const list = coinList(coins);
    if (!list.length) {
      if (agentId != null) fail("An open-call book can't link an ERC-8004 agent. Give a coin list to open a linked call book.", "BadAgent");
      const id = Number(await this.view("defaultBookOf", [this.address]));
      const open = id && !(await this.myBook(id)).closedAt;
      return open
        ? { bookId: id, kind: "calls", anyCoin: true, existing: true, summary: `Your open-call book is book ${id}. Lock a call on any Hyperliquid perp any time.` }
        : { bookId: null, kind: "calls", anyCoin: true, opensOnFirstLock: true, summary: "Your open-call book opens with your first lock, and Reins pays the gas. Lock a call to start." };
    }
    const min = this.wrap(() => parseDuration(minHorizon, "horizon"));
    const max = this.wrap(() => parseDuration(maxHorizon, "horizon"));
    if (min < MIN_CALL_HORIZON || max < min || max > MAX_HORIZON || min % 60 || max % 60) {
      fail(`Calls run from 5m to 30d in whole minutes, shortest first; got ${minHorizon} to ${maxHorizon}.`, "BadHorizon");
    }
    const checked = await this.checkedCoins(list);
    const metaHash = keccak256(toHex(meta ?? name ?? `calls on ${checked.join(",")}`));
    const receipt = await this.send("openFree", [await this.agentArg(agentId), this.address, metaHash, checked, min, max], { action: "openFree" });
    const ev = this.events(receipt, "OpenedFree")[0].args;
    const bookId = Number(ev.bookId);
    return {
      bookId, kind: "calls", anyCoin: false, coins: checked, horizons: { min: formatDuration(min), max: formatDuration(max) }, agentId: agentId ?? null,
      tx: receipt.transactionHash, summary: `Opened call book ${bookId} for ${checked.join("/")}, horizons ${formatDuration(min)} to ${formatDuration(max)}. Lock calls any time.`,
    };
  }

  wrap(fn) {
    try {
      return fn();
    } catch (err) {
      throw err instanceof CallbookError ? err : new CallbookError(err.message, "BadInput");
    }
  }

  // ------------------------------------------------------------------ sealing

  /** Seal the next sealable round of a strategy book. side: long | short | flat. */
  async seal({ book: bookId, coin, side } = {}) {
    const book = await this.myBook(bookId);
    if (book.kind !== "scheduled") fail(`Book ${book.id} is a call book: lock calls in it, there are no rounds to seal.`, "NotScheduled");
    if (!this.role(book)) this.notMine(book, "seal");
    if (book.closedAt != null) fail(`Book ${book.id} is closed and takes no new calls.`, "BookClosed");
    const coinIndex = book.coins.findIndex((c) => same(c, coin));
    if (coinIndex < 0) fail(`${coin} isn't in book ${book.id}; it calls ${book.coins.join(", ")}.`, "BadCoin");
    const s = sideOf(side, { allowFlat: true });

    const now = await this.now();
    const r = sealableRound(book, now, this.opts.sealMarginSec);
    if (r.tooEarly) {
      const late = r.startsAt - book.periodSec;
      fail(`Too late to seal round ${r.round - 1}: it starts in ${formatDuration(late - now)} and calls must be sealed 60s ahead (with a few seconds for the transaction). ` +
        `Round ${r.round} (starting ${utc(r.startsAt)}) can be sealed from ${utc(r.opensAt)}.`, "SealTooLate", { round: r.round - 1, startsAt: late });
    }
    if (book.seals.has(r.round)) {
      fail(`Round ${r.round} of book ${book.id} is already sealed; each round is sealed once. Round ${r.round + 1} can be sealed from ${utc(r.startsAt - 60)}.`, "AlreadySealed");
    }

    const { callbook, chainId } = this.ctx();
    const salt = sealSalt(this.secret, { chainId, callbook, bookId: book.id, p: r.round });
    const hash = callHash({ callbook, chainId, bookId: book.id, p: r.round, coinIndex, side: s, salt });
    const ctx = { bookId: book.id, round: r.round, now };
    const gasless = await this.gasless();
    let receipt;
    if (gasless) {
      // The contract's own window refuses a late seal; the deadline only bounds how long the signature lives.
      const deadline = BigInt(now + LOCK_SIG_TTL);
      const signature = await this.sign(SEAL_TYPES, "SealCall", { bookId: BigInt(book.id), p: BigInt(r.round), callHash: hash, deadline });
      receipt = await this.relayed("seal", { bookId: book.id, p: r.round, callHash: hash, deadline, signature }, "seal").catch((e) => { throw this.explain(e, ctx); });
    } else {
      receipt = await this.send("seal", [BigInt(book.id), BigInt(r.round), hash], ctx);
    }
    return {
      bookId: book.id, round: r.round, coin: book.coins[coinIndex], side: SIDE_WORD[s], startsAt: r.startsAt, revealAt: r.startsAt + book.horizonSec,
      hash, gasless, tx: receipt.transactionHash,
      summary: `Sealed round ${r.round} of book ${book.id}: ${SIDE_WORD[s]} ${book.coins[coinIndex]}. It starts ${utc(r.startsAt)} and can be revealed from ${utc(r.startsAt + book.horizonSec)}.`,
    };
  }

  // ------------------------------------------------------------------ locking

  /**
   * Lock an open call: coin, long or short, and a horizon. Without `book`, it
   * goes in your any-coin book (opened by the first lock, gasless if a relay is set).
   */
  async lock({ coin, side, horizon = "4h", book: bookId } = {}) {
    const s = sideOf(side, { allowFlat: false });
    // Serialised here; another process locking with the same key can still win the id,
    // and then the contract refuses ours with StaleId, so try once more with fresh ids.
    const attempt = () => this.exclusive(async () => {
      if (bookId != null) {
        const book = await this.myBook(bookId);
        if (book.kind === "scheduled") fail(`Book ${book.id} is a strategy book: seal its rounds instead of locking calls.`, "NotFree");
        if (!book.anyCoin) return this.lockInList(book, coin, s, horizon);
        if (book.owner !== this.me) fail(`Book ${book.id} is another account's open-call book.`, "NotCaller");
      }
      return this.lockAnyCoin(coin, s, horizon);
    });
    try {
      return await attempt();
    } catch (err) {
      if (err?.code !== "StaleId") throw err;
      return attempt();
    }
  }

  async lockInList(book, coin, s, horizon) {
    if (!this.role(book)) this.notMine(book, "lock calls");
    if (book.closedAt != null) fail(`Book ${book.id} is closed and takes no new calls.`, "BookClosed");
    const coinIndex = book.coins.findIndex((c) => same(c, coin));
    if (coinIndex < 0) fail(`${coin} isn't in book ${book.id}; it calls ${book.coins.join(", ")}. Leave the book out to call any coin.`, "BadCoin");
    const h = this.wrap(() => callHorizon(horizon, { min: book.minHorizon, max: book.maxHorizon }));
    if (await this.gasless()) {
      fail(`Book ${book.id} has a coin list, so its calls can't be relayed; only your open-call book takes gasless calls. Fund ${this.address} or leave the book out.`, "NoGas");
    }
    const { callbook, chainId } = this.ctx();
    const callId = Number(await this.view("lockCount", [BigInt(book.id)]));
    const salt = lockSalt(this.secret, { chainId, callbook, bookId: book.id, callId });
    const hash = lockedHash({ callbook, chainId, bookId: book.id, callId, coinIndex, side: s, horizon: h, salt });
    const receipt = await this.send("lock", [BigInt(book.id), hash, h, BigInt(callId)], { bookId: book.id });
    const ev = this.events(receipt, "Locked")[0].args;
    return this.locked({ book: book.id, ev, coin: book.coins[coinIndex], coinIndex, side: s, horizon: h, receipt, gasless: false });
  }

  async lockAnyCoin(symbol, s, horizon) {
    const coin = await this.resolveCoin(symbol);
    const h = this.wrap(() => callHorizon(horizon));
    const { callbook, chainId } = this.ctx();
    const [nonce, defaultBook, now] = await Promise.all([this.view("nonces", [this.address]), this.view("defaultBookOf", [this.address]), this.now()]);
    const salt = symbolSalt(this.secret, { chainId, callbook, account: this.address, nonce });
    const hash = symbolHash({ callbook, chainId, account: this.address, nonce, coin, side: s, horizon: h, salt });
    const deadline = BigInt(now + LOCK_SIG_TTL);
    const signLock = () => this.sign(LOCK_TYPES, "LockCall", { account: this.address, callHash: hash, horizon: h, nonce, deadline });

    const gasless = await this.gasless();
    let receipt;
    if (gasless) {
      const signature = await signLock();
      receipt = await this.relayed("lock", { account: this.address, callHash: hash, horizon: h, deadline, signature }, "lock").catch((e) => { throw this.explain(e); });
    } else {
      const open = defaultBook > 0n && (await this.myBook(defaultBook)).closedAt == null;
      // Direct: `lock` into the open default book (naming the nonce the hash used), or our own lockBySig, which opens it.
      receipt = open
        ? await this.send("lock", [defaultBook, hash, h, nonce], { bookId: Number(defaultBook) })
        : await this.send("lockBySig", [this.address, hash, h, deadline, await signLock()], {});
    }
    // The lock in this transaction must be this call: a relay can't hand back someone else's.
    const ev = this.events(receipt, "Locked").map((l) => l.args).find((a) => same(a.callHash, hash));
    if (!ev) fail(`The transaction ${receipt.transactionHash} doesn't lock this call, so it wasn't recorded. Check ARENA_RELAY_URL.`, "BadRelay");
    const opened = this.events(receipt, "OpenedFree").length > 0;
    return this.locked({ book: Number(ev.bookId), ev, coin, side: s, horizon: h, receipt, gasless, nonce: Number(nonce), opened });
  }

  locked({ book, ev, coin, coinIndex, side, horizon, receipt, gasless, nonce, opened = false }) {
    const { callbook, chainId } = this.ctx();
    const callId = Number(ev.callId), entryAt = Number(ev.entryAt);
    this.journal.put({ chainId, callbook, bookId: book, callId, coin, coinIndex, side, horizon, nonce, entryAt, tx: receipt.transactionHash });
    const revealAt = entryAt + horizon;
    return {
      bookId: book, callId, coin, side: SIDE_WORD[side], horizon: formatDuration(horizon), entryAt, revealAt, openedBook: opened, gasless,
      tx: receipt.transactionHash,
      summary: `Locked ${SIDE_WORD[side]} ${coin} for ${formatDuration(horizon)} (book ${book}, call ${callId}${opened ? ", your new open-call book" : ""}). ` +
        `Entry ${utc(entryAt)}; reveal from ${utc(revealAt)}.`,
    };
  }

  // ------------------------------------------------------------------ revealing

  /** A lock's horizon: public since the lock (the Locked event); older readers fall back to lockedOf. */
  async lockHorizon(book, l) {
    if (Number.isInteger(l.horizon) && l.horizon > 0) return l.horizon;
    return Number((await this.view("lockedOf", [BigInt(book.id), BigInt(l.callId)])).horizon);
  }

  /**
   * The plaintext behind a lock: journal first, then a search. The horizon is
   * public, so the search only tries coin x side. Null if this secret didn't make it.
   */
  async lockPlain(book, l) {
    const { callbook, chainId } = this.ctx();
    const slot = this.slot(book, l);
    const key = `${book.id}:${l.callId}`;
    const noted = this.journal.get(slot);
    const horizon = await this.lockHorizon(book, l);
    if (book.anyCoin) {
      const nonce = noted?.nonce ?? Number((await this.view("lockedOf", [BigInt(book.id), BigInt(l.callId)])).nonce);
      const salt = symbolSalt(this.secret, { chainId, callbook, account: book.owner, nonce });
      if (noted && symbolHash({ callbook, chainId, account: book.owner, nonce, coin: noted.coin, side: noted.side, horizon, salt }) === l.hash.toLowerCase()) {
        return { ...noted, horizon, salt };
      }
      if (this.unrecoverable.has(key)) return null;
      const coins = await this.marketsSource.names();
      const found = recoverSymbolCall({ hash: l.hash, callbook, chainId, account: book.owner, nonce, salt, coins, horizons: [horizon] });
      return this.remember(book, l, key, found && { ...found, nonce, salt });
    }
    const salt = lockSalt(this.secret, { chainId, callbook, bookId: book.id, callId: l.callId });
    if (noted && lockedHash({ callbook, chainId, bookId: book.id, callId: l.callId, coinIndex: noted.coinIndex, side: noted.side, horizon, salt }) === l.hash.toLowerCase()) {
      return { ...noted, horizon, salt };
    }
    if (this.unrecoverable.has(key)) return null;
    const found = recoverLockedCall({ hash: l.hash, callbook, chainId, bookId: book.id, callId: l.callId, salt, coinCount: book.coins.length, horizons: [horizon] });
    return this.remember(book, l, key, found && { ...found, coin: book.coins[found.coinIndex], salt });
  }

  remember(book, l, key, plain) {
    if (!plain) {
      this.unrecoverable.add(key);
      return null;
    }
    const { salt, ...noted } = plain;
    this.journal.put({ ...this.slot(book, l), ...noted, entryAt: l.entryAt, recovered: true });
    return plain;
  }

  /** Reveal one matured call (direct, or through the relayer). */
  async revealOne(kind, args, body, ctx) {
    if (await this.gasless()) return this.relayed("reveal", { kind, ...body }, "reveal").catch((e) => { throw this.explain(e, ctx); });
    const fn = { seal: "reveal", lock: "revealLocked", symbol: "revealLockedSymbol" }[kind];
    return this.send(fn, args, ctx);
  }

  /** Reveal every matured, unrevealed seal and lock in this key's books. */
  async revealDue() {
    const state = await this.read();
    const now = await this.now();
    const out = { revealed: [], waiting: [], expired: [], failed: [] };
    const { callbook, chainId } = this.ctx();
    for (const book of [...state.books.values()].filter((b) => this.role(b)).sort((a, b) => a.id - b.id)) {
      if (book.kind === "scheduled") {
        for (const s of book.seals.values()) {
          if (s.reveal) continue;
          const exit = exitOf(book, s.p);
          const item = { bookId: book.id, round: s.p, revealAt: exit };
          if (now < exit) { out.waiting.push({ ...item, revealIn: countdown(exit - now) }); continue; }
          if (now > exit + GRACE) { out.expired.push({ ...item, note: "the 7-day reveal window closed; it scores as its worst outcome" }); continue; }
          const salt = sealSalt(this.secret, { chainId, callbook, bookId: book.id, p: s.p });
          const call = recoverSealedCall({ hash: s.hash, callbook, chainId, bookId: book.id, p: s.p, salt, coinCount: book.coins.length });
          if (!call) { out.failed.push({ ...item, reason: "No call matches this seal with this salt secret, so it wasn't sealed by this SDK's secret." }); continue; }
          await this.tryReveal(out, { ...item, coin: book.coins[call.coinIndex], side: SIDE_WORD[call.side] }, () => this.revealOne("seal",
            [BigInt(book.id), BigInt(s.p), call.coinIndex, call.side, salt],
            { bookId: book.id, p: s.p, coinIndex: call.coinIndex, side: call.side, salt }, { bookId: book.id, round: s.p }));
        }
        continue;
      }
      for (const l of book.locks.values()) {
        if (l.reveal) continue;
        const horizon = await this.lockHorizon(book, l);
        const exit = l.entryAt + horizon;
        const item = { bookId: book.id, callId: l.callId, horizon: formatDuration(horizon), revealAt: exit };
        const plain = await this.lockPlain(book, l);
        if (!plain) { out.failed.push({ ...item, reason: "Neither the journal nor a search over every coin and side matches this call: it was locked with another salt secret." }); continue; }
        const described = { ...item, coin: plain.coin, side: SIDE_WORD[plain.side] };
        if (now < exit) { out.waiting.push({ ...described, revealIn: countdown(exit - now) }); continue; }
        if (now > exit + GRACE) { out.expired.push({ ...described, note: "the 7-day reveal window closed; it scores as its worst outcome" }); continue; }
        const ok = await this.tryReveal(out, described, () => (book.anyCoin
          ? this.revealOne("symbol", [BigInt(book.id), BigInt(l.callId), plain.coin, plain.side, plain.salt],
            { bookId: book.id, callId: l.callId, coin: plain.coin, side: plain.side, salt: plain.salt }, { bookId: book.id })
          : this.revealOne("lock", [BigInt(book.id), BigInt(l.callId), plain.coinIndex, plain.side, plain.salt],
            { bookId: book.id, callId: l.callId, coinIndex: plain.coinIndex, side: plain.side, salt: plain.salt }, { bookId: book.id })));
        if (ok) this.journal.forget([this.slot(book, l)]);
      }
    }
    const next = out.waiting.length ? out.waiting.reduce((m, w) => Math.min(m, w.revealAt), Infinity) : null;
    out.summary = `Revealed ${out.revealed.length} call${out.revealed.length === 1 ? "" : "s"}` +
      (out.waiting.length ? `; ${out.waiting.length} still maturing (next ${utc(next)}, ${countdown(next - now)})` : "") +
      (out.expired.length ? `; ${out.expired.length} past the reveal window` : "") +
      (out.failed.length ? `; ${out.failed.length} couldn't be revealed (see failed)` : "") + ".";
    return out;
  }

  async tryReveal(out, item, send) {
    try {
      const receipt = await send();
      out.revealed.push({ ...item, tx: receipt.transactionHash });
      return true;
    } catch (err) {
      out.failed.push({ ...item, reason: this.explain(err).message });
      return false;
    }
  }

  // ------------------------------------------------------------------ status and verify

  priceSource() {
    this._prices ??= this.opts.priceSource ?? createPriceSource();
    return this._prices;
  }

  /** The book's API detail from the app, when apiUrl is set and serves this contract. */
  async fromApi(book) {
    if (!this.opts.apiUrl) return null;
    const route = book.kind === "scheduled" ? "book" : "caller";
    try {
      const res = await this.fetch(`${this.opts.apiUrl.replace(/\/$/, "")}/api/callbook/${route}/${book.id}`, { signal: AbortSignal.timeout(API_TIMEOUT_MS) });
      if (!res.ok) return null;
      const d = await res.json();
      return same(d.contract, this.ctx().callbook) && Number(d.chainId) === this.ctx().chainId ? d : null;
    } catch {
      return null; // the app is a shortcut; the chain and public prices are the truth
    }
  }

  /** The book's API detail, computed here from chain events and Hyperliquid prices. */
  async computed(state, book, asOf) {
    const ev = await evaluateAny({ chain: state, book, source: this.priceSource(), asOf });
    const shaped = book.kind === "scheduled" ? bookToApi({ chain: state, ev, asOf }) : callerToApi({ chain: state, ev, asOf });
    return shaped.detail;
  }

  /** This key's public Arena profile page: its records, stats and name in one place. */
  profileUrl() {
    return `${(this.opts.apiUrl ?? DEFAULT_APP_URL).replace(/\/$/, "")}/arena/p/${this.me}`;
  }

  /**
   * Name this key for Arena (or one of its books, with `book`): a name, a short
   * bio and a link. It's public and stays in the chain's history; the newest
   * one shows, and an empty name clears it. A field left out keeps its current
   * value, so changing just the bio keeps the name. Gasless through the relayer.
   */
  async setProfile({ name, bio, link, book: bookId } = {}) {
    let book = 0n;
    if (bookId != null && bookId !== "" && Number(bookId) !== 0) {
      const b = await this.myBook(bookId);
      if (b.owner !== this.me) fail(`Book ${b.id} belongs to ${b.owner}; only its owner can name it.`, "NotOwner");
      book = BigInt(b.id);
    }
    const state = await this.read();
    if (book === 0n && ![...state.books.values()].some((b) => b.owner === this.me)) {
      fail("Lock your first call before picking a name: a name shows beside your records.", "NoRecord");
    }
    const now0 = state.profiles?.get(profileKey(this.me, book)) ?? {};
    const want = { name: name ?? now0.name ?? "", bio: bio ?? now0.bio ?? "", link: link ?? now0.link ?? "" };
    // Only a name can clear a profile; a bio or link alone needs a name to sit under.
    if (!want.name.trim() && name === undefined && (bio || link)) fail("Pick a name first: a bio and link show under a name.", "BadProfile");
    const checked = checkProfile(want);
    if (!checked.ok) fail(checked.error, "BadProfile");
    const p = checked.profile;
    const [nonce, now] = await Promise.all([this.view("profileNonces", [this.address]), this.now()]);
    const deadline = BigInt(now + LOCK_SIG_TTL);
    const gasless = await this.gasless();
    let receipt;
    if (gasless) {
      const signature = await this.sign(PROFILE_TYPES, "SetProfile", { account: this.address, bookId: book, ...p, nonce, deadline });
      receipt = await this.relayed("profile", { account: this.address, bookId: book, ...p, deadline, signature }, "profile").catch((e) => { throw this.explain(e); });
    } else {
      receipt = await this.send("setProfile", [book, p.name, p.bio, p.link], book ? { bookId: Number(book) } : {});
    }
    // The profile in this transaction must be this one: a relay can't hand back someone else's.
    const ev = this.events(receipt, "Profile").map((l) => l.args).find((a) => same(a.account, this.address) && a.bookId === book && a.name === p.name);
    if (!ev) fail(`The transaction ${receipt.transactionHash} doesn't set this profile, so nothing changed. Check ARENA_RELAY_URL.`, "BadRelay");
    const whose = book === 0n ? "Your Arena name" : `Book ${book}'s name`;
    const url = this.profileUrl();
    return {
      ...p, book: Number(book), gasless, tx: receipt.transactionHash, url,
      summary: p.name
        ? `${whose} is now "${p.name}". Names are public and stay in the chain's history. Your profile: ${url}`
        : `${whose} is cleared; your records show your address again. Your profile: ${url}`,
    };
  }

  /** What Arena shows for this key: its own profile, and each of its books' names. */
  async profile() {
    const state = await this.read();
    const url = this.profileUrl();
    const own = profileForDisplay(state.profiles?.get(profileKey(this.me, 0)));
    const books = [...state.books.values()].filter((b) => b.owner === this.me).sort((a, b) => a.id - b.id).map((b) => {
      const shown = profileFor({ chain: state, book: b });
      return { book: b.id, kind: b.kind === "scheduled" ? "strategy" : "calls", shownAs: shown?.name ?? null, from: shown?.source ?? null };
    });
    const summary = own
      ? `You're "${own.name}" in Arena${own.bio ? ` (${own.bio})` : ""}. Your profile: ${url}`
      : `You have no Arena name yet, so your records show your address. Set one with arena_profile. Your profile: ${url}`;
    return { address: this.address, profile: own, books, url, summary };
  }

  /** Record, score, pending calls with countdowns and the next deadline, for one book or all of this key's. */
  async status({ book: bookId } = {}) {
    const state = await this.read();
    const now = await this.now();
    const books = bookId != null ? [await this.myBook(bookId)] : [...state.books.values()].filter((b) => this.role(b)).sort((a, b) => a.id - b.id);
    if (!books.length) {
      return { books: [], summary: "This key has no books yet. Lock a call (any coin, any time) or open a strategy book to start a record." };
    }
    const out = [];
    for (const book of books) out.push(await this.bookStatus(state, book, now));
    if (bookId != null) return out[0];
    const url = this.profileUrl();
    return { address: this.address, network: this.ctx().label, books: out, url, summary: `${out.map((b) => b.summary).join(" ")} Your profile: ${url}` };
  }

  async bookStatus(state, book, now) {
    let detail = await this.fromApi(book), source = "api", note;
    if (!detail) {
      source = "computed";
      try {
        detail = await this.computed(state, book, now);
      } catch (err) {
        note = `Score unavailable right now: ${err.message}`;
        detail = this.bare(book, now);
      }
    }
    const plains = new Map();
    if (book.kind !== "scheduled") {
      for (const l of book.locks.values()) {
        if (l.reveal) continue;
        const horizon = await this.lockHorizon(book, l).catch(() => null);
        const plain = await this.lockPlain(book, l).catch(() => null);
        plains.set(l.callId, plain ?? (horizon ? { horizon } : null));
      }
    }
    const st = book.kind === "scheduled"
      ? strategyStatus(detail, { now, source, book })
      : callsStatus(detail, { now, source, plain: (id) => plains.get(id) ?? null });
    return note ? { ...st, note } : st;
  }

  /** A detail with no prices: enough for countdowns. */
  bare(book, now) {
    if (book.kind === "scheduled") {
      const calls = [...book.seals.values()].map((s) => ({ period: s.p, start: startOf(book, s.p), sealedAt: s.sealedAt, status: s.reveal ? "revealed" : "pending" }));
      return { id: book.id, coins: book.coins, periodSec: book.periodSec, horizonSec: book.horizonSec, closed: book.closedAt != null, calls, metrics: {} };
    }
    const calls = [...book.locks.values()].map((l) => ({ callId: l.callId, entryAt: l.entryAt, status: l.reveal ? "revealed" : "pending" }));
    return { id: book.id, anyCoin: book.anyCoin, coins: book.coins, closed: book.closedAt != null, calls, metrics: { calls: calls.length } };
  }

  /**
   * Rebuild a book's score from chain events and public prices, and compare
   * it with the latest ERC-8004 validation response (as `npm run arena:verify` does).
   */
  async verify({ book: bookId } = {}) {
    const id = Number(bookId);
    if (!Number.isInteger(id) || id < 1) fail(`"${bookId}" isn't a book id (a whole number from 1).`, "BadBook");
    const { publicClient, callbook, net } = this.ctx();
    // Without Reins' validator, anyone's response to a request naming this book would pass for
    // "the posted score": then the score is rebuilt but not compared with one.
    const compare = this.network === "local" || Boolean(net.validator);
    let chain;
    try {
      chain = await readCallbook({ client: publicClient, address: callbook, fromBlock: net.fromBlock, validationRegistry: compare ? net.registry ?? undefined : undefined, validator: net.validator ?? undefined });
    } catch (err) {
      throw this.explain(err);
    }
    const book = chain.books.get(id);
    if (!book) fail(`There's no book ${id} on ${net.label}.`, "UnknownBook");
    const req = compare ? requestForBook(chain, id, net.validator ?? undefined) : null;
    const last = req ? latestResponse(chain, req.requestHash) : null;
    const asOf = asOfFromUri(last?.uri) ?? (await this.now());
    let ev;
    try {
      ev = await evaluateAny({ chain, book, source: this.priceSource(), asOf });
    } catch (err) {
      fail(`Can't rebuild book ${id}'s score right now: ${err.message}`, "Prices");
    }
    const rebuilt = { score: ev.scored.score.value, reportHash: ev.report.hash, asOf, parts: Object.fromEntries(Object.entries(ev.scored.score).map(([k, v]) => [k, Math.round(v * 1e4) / 1e4])) };
    const posted = last ? { score: last.score, responseHash: last.responseHash, validator: last.validator, at: last.at, tx: last.tx, uri: last.uri } : null;
    const match = posted ? same(posted.responseHash, rebuilt.reportHash) && posted.score === rebuilt.score : null;
    const summary = !compare
      ? `Book ${id} rebuilds to ${rebuilt.score}/100 as of ${utc(asOf)}. Reins' validator isn't known on ${net.label} yet, so there's no posted score to compare it with.`
      : !req
      ? `Book ${id} rebuilds to ${rebuilt.score}/100 as of ${utc(asOf)}; no ERC-8004 validation request names it, so there's no posted score to compare.`
      : !posted
        ? `Book ${id} rebuilds to ${rebuilt.score}/100; its validation request has no response yet.`
        : match
          ? `MATCH: the posted score ${posted.score}/100 for book ${id} is exactly what the published rules give (report ${rebuilt.reportHash.slice(0, 10)}…).`
          : ev.scored.metrics?.shortOnHourly
            // Hyperliquid keeps 5-minute candles ~17 days: past that, short calls can only be repriced hourly.
            ? `Can't re-check exactly: ${ev.scored.metrics.shortOnHourly} short call(s) in book ${id} were priced on 5-minute candles that Hyperliquid no longer serves. Posted ${posted.score}/100, rebuilt on hourly prices ${rebuilt.score}/100.`
            : `MISMATCH: posted ${posted.score}/100 (${posted.responseHash.slice(0, 10)}…), rebuilt ${rebuilt.score}/100 (${rebuilt.reportHash.slice(0, 10)}…).`;
    return { bookId: id, kind: book.kind === "scheduled" ? "strategy" : "calls", request: req ? req.requestHash : null, posted, rebuilt, match, summary };
  }
}

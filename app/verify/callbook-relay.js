/**
 * The Callbook relayer: it pays the gas so nobody needs USDC on Arc to keep a
 * record. Four things it will submit:
 *
 *   lock    lockBySig(account, callHash, horizon, deadline, signature): an
 *           EIP-712 LockCall(account, callHash, horizon, nonce, deadline)
 *           signed by the account
 *   seal    sealBySig(bookId, p, callHash, deadline, signature): an EIP-712
 *           SealCall(bookId, p, callHash, deadline) signed by the book's caller or owner
 *   reveal  any reveal with its preimage (reveals are permissionless)
 *   profile setProfileBySig(account, bookId, name, bio, link, deadline, signature):
 *           an EIP-712 SetProfile signed by the account, whose text first
 *           passes the name rules (arena-names.js), so we never pay for a
 *           name the site would hide
 *
 * Order of checks, cheapest first: shape (a 65-byte signature, a deadline at
 * least 30 seconds and at most 7 days away), the signer is a plain key (no
 * contract wallets through the relay: their ERC-1271 check runs arbitrary
 * code at our expense), the signature recovers locally against the account's
 * current nonce, then a simulation. Only a request that passes all of that
 * takes a slot of the global send limit and the gas budget; failures count
 * against a separate, cheaper limit per client and per account.
 *
 * Limits (defaults in RELAY_LIMITS):
 *   - 30 locks an hour per account; 30 seals an hour per book
 *   - 5 profile changes a day per account
 *   - 600 relayed transactions an hour in total
 *   - 120 requests an hour per client IP (IPv6 by /64), 60 refused ones
 *   - a daily gas budget (CALLBOOK_RELAYER_DAILY_USDC, default 5 USDC)
 *   - every transaction is sent with an explicit gas cap (400k)
 *   - at most 20 requests waiting to send; past that, 503
 *   - a receipt is awaited 20 seconds; past that the answer is 202 with the
 *     transaction hash, and the caller reads the outcome from the chain
 * The hard cap is the relayer wallet's balance: keep only a few days of
 * budget in it. Counters are in memory per instance unless a shared store is
 * configured (see countersFromEnv in callbook-util.js).
 */
import { isAddress, isHex, parseEventLogs, formatEther, getAddress, verifyTypedData } from "viem";

import { memoryCounter, ipBucket, brief } from "./callbook-util.js";
import { checkProfile } from "./arena-names.js";

const HOUR = 3_600;
const DAY = 86_400;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const SIG65 = /^0x[0-9a-fA-F]{130}$/;
const ZERO = "0x0000000000000000000000000000000000000000";

export const RELAY_LIMITS = Object.freeze({
  locksPerAccountHour: 30,
  sealsPerBookHour: 30,
  profilesPerAccountDay: 5,
  txPerHour: 600,
  requestsPerIpHour: 120,
  failuresPerIpHour: 60,
  failuresPerAccountHour: 60,
  // Accounts cost nothing to make, so sending is also capped per client address.
  sendsPerIpHour: 30,
  newBooksPerIpDay: 10,
  dailyBudgetUsdc: 5,
  minDeadlineAheadSec: 30,
  maxDeadlineAheadSec: 7 * DAY,
  gasCap: 400_000n,
  maxQueue: 20,
  receiptTimeoutMs: 20_000,
  minHorizon: 300,
  maxHorizon: 30 * DAY,
});

/** A relayer error with an HTTP status and a sentence for the person. */
export class RelayError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
const refuse = (m) => new RelayError(400, m);

export const DOMAIN = (chainId, callbook) => ({ name: "Arena", version: "1", chainId: Number(chainId), verifyingContract: getAddress(callbook) });
export const LOCK_TYPES = {
  LockCall: [
    { name: "account", type: "address" }, { name: "callHash", type: "bytes32" }, { name: "horizon", type: "uint32" },
    { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
  ],
};
export const PROFILE_TYPES = {
  SetProfile: [
    { name: "account", type: "address" }, { name: "bookId", type: "uint256" }, { name: "name", type: "string" },
    { name: "bio", type: "string" }, { name: "link", type: "string" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
  ],
};
export const SEAL_TYPES = { SealCall: [{ name: "bookId", type: "uint256" }, { name: "p", type: "uint64" }, { name: "callHash", type: "bytes32" }, { name: "deadline", type: "uint256" }] };

const asBigInt = (x, what) => {
  if (typeof x === "number" && !Number.isSafeInteger(x)) throw refuse(`${what} must be an integer`);
  if (typeof x !== "number" && typeof x !== "bigint" && !/^\d{1,78}$/.test(String(x ?? ""))) throw refuse(`${what} must be a non-negative integer`);
  const v = BigInt(x);
  if (v < 0n) throw refuse(`${what} must be a non-negative integer`);
  return v;
};

/**
 * p: { publicClient, wallet (the relayer's key), callbook, abi (Callbook's), chainId,
 *      limits?, counter? (default: in memory), now? () => unix seconds, log? }
 */
export function createRelayer({ publicClient, wallet, callbook, abi, chainId, limits = {}, counter, now = () => Math.floor(Date.now() / 1000), log }) {
  const L = { ...RELAY_LIMITS, ...limits };
  // Budget and spend in micro-USDC (gas is paid in 18-decimal USDC on Arc), so counters stay small integers.
  const budgetMicro = BigInt(Math.round(L.dailyBudgetUsdc * 1e6));
  const micro = (wei) => wei / 10n ** 12n + 1n;
  const counts = counter ?? memoryCounter({ now });
  let queue = Promise.resolve();
  let waiting = 0;
  const domain = DOMAIN(chainId, callbook);

  const read = (functionName, args) => publicClient.readContract({ address: callbook, abi, functionName, args });

  /** Count a hit against `key` (one-hour window); refuse past `max`. */
  async function limit(key, max, message, windowSec = HOUR) {
    if ((await counts.hit(key, windowSec)) > max) throw new RelayError(429, message);
  }
  /** A refused request: counted, and refused outright once a client has too many. */
  async function failed(ip, account) {
    if (ip) await counts.hit(`fail:ip:${ip}`, HOUR);
    if (account) await counts.hit(`fail:acct:${account.toLowerCase()}`, HOUR);
  }
  async function notTooManyFailures(ip, account) {
    if (ip && (await counts.peek(`fail:ip:${ip}`, HOUR)) >= L.failuresPerIpHour) throw new RelayError(429, "too many refused requests from this address; try again later");
    if (account && (await counts.peek(`fail:acct:${account.toLowerCase()}`, HOUR)) >= L.failuresPerAccountHour) throw new RelayError(429, "too many refused requests for this account; try again later");
  }

  /** A plain key's signature, checked locally. Contract wallets are refused (no ERC-1271 through the relay). */
  async function isPlainKey(address) {
    const code = await publicClient.getCode({ address });
    return !code || code === "0x";
  }
  const signedBy = (address, typed) => verifyTypedData({ address, ...typed }).catch(() => false);

  async function spentToday() {
    return BigInt(await counts.peek(`gas:${Math.floor(now() / DAY)}`, DAY));
  }

  /**
   * Simulate; if it passes, take a global slot and check the budget; send with
   * a gas cap; wait a short while for the receipt. One send at a time.
   */
  function submit(functionName, args, { onSimulated, bucket } = {}) {
    if (waiting >= L.maxQueue) return Promise.reject(new RelayError(503, "the relayer is busy; try again in a minute"));
    waiting++;
    const run = queue.then(async () => {
      let sim, gas;
      try {
        sim = await publicClient.simulateContract({ address: callbook, abi, functionName, args, account: wallet.account });
        gas = await publicClient.estimateContractGas({ address: callbook, abi, functionName, args, account: wallet.account });
      } catch (err) {
        const name = err?.cause?.data?.errorName ?? err?.cause?.reason ?? brief(err);
        throw new RelayError(422, `refused by the contract: ${name}`, { simulated: false });
      }
      if (gas > L.gasCap) throw new RelayError(422, `that would need ${gas} gas, over the relayer's ${L.gasCap} cap`, { simulated: false });
      await onSimulated?.();
      if (bucket) await limit(`send:ip:${bucket}`, L.sendsPerIpHour, `this address has had ${L.sendsPerIpHour} transactions relayed in the last hour; try again later`);
      await limit("global", L.txPerHour, "the relayer is busy; try again in a few minutes");
      const price = await publicClient.getGasPrice();
      const capGas = gas + gas / 5n > L.gasCap ? L.gasCap : gas + gas / 5n;
      if ((await spentToday()) + micro(capGas * price) > budgetMicro) throw new RelayError(503, "the relayer's gas budget for today is used up; try again tomorrow (UTC)");
      const hash = await wallet.writeContract({ ...sim.request, gas: capGas, account: wallet.account, chain: wallet.chain });
      // Count the worst case now; the receipt can't be waited on forever.
      await counts.hit(`gas:${Math.floor(now() / DAY)}`, DAY, Number(micro(capGas * price)));
      let receipt;
      try {
        receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: L.receiptTimeoutMs });
      } catch {
        throw new RelayError(202, "sent; the receipt isn't in yet, so read the outcome from the chain", { txHash: hash, pending: true });
      }
      if (receipt.status !== "success") throw new RelayError(502, `the transaction reverted (${hash})`);
      log?.(`${functionName} ${hash} (${formatEther(receipt.gasUsed * (receipt.effectiveGasPrice ?? price))} USDC)`);
      return { hash, receipt, result: sim.result };
    }).finally(() => { waiting--; });
    queue = run.catch(() => {});
    return run;
  }

  function checkDeadline(deadline) {
    const d = asBigInt(deadline, "deadline");
    const t = BigInt(now());
    if (d < t + BigInt(L.minDeadlineAheadSec)) throw refuse(`the deadline must be at least ${L.minDeadlineAheadSec} seconds away`);
    if (d > t + BigInt(L.maxDeadlineAheadSec)) throw refuse("the deadline is more than 7 days away");
    return d;
  }
  const checkSig = (s) => {
    if (typeof s !== "string" || !SIG65.test(s) || !isHex(s)) throw refuse("signature must be exactly 65 bytes of hex");
    return s;
  };
  const checkHash = (h) => {
    if (!BYTES32.test(h ?? "") || /^0x0+$/.test(h)) throw refuse("callHash must be a non-zero bytes32");
    return h;
  };

  /**
   * Run a request, counting it as a failure if it was refused. A failure counts
   * against the account only once its signature checked out (`ctx.verified()`):
   * anyone can name any account, and shouldn't be able to lock it out.
   */
  async function guarded(ip, account, fn) {
    const bucket = ip ? ipBucket(ip) : null;
    if (bucket) await limit(`ip:${bucket}`, L.requestsPerIpHour, "too many requests from this address; try again later");
    await notTooManyFailures(bucket, account);
    let verified = false;
    try {
      return await fn({ bucket, verified: () => { verified = true; } });
    } catch (err) {
      if (err instanceof RelayError && err.status !== 202 && err.status !== 503) await failed(bucket, verified ? account : null);
      throw err;
    }
  }

  /** POST /relay/lock: { account, callHash, horizon, deadline, signature } -> { bookId, callId, entryAt, horizon, txHash } */
  async function lock(body = {}, { ip } = {}) {
    const account = isAddress(body.account ?? "") ? getAddress(body.account) : null;
    return guarded(ip, account, async (ctx) => {
      if (!account) throw refuse("account must be an address");
      const callHash = checkHash(body.callHash);
      const signature = checkSig(body.signature);
      const horizon = Number(asBigInt(body.horizon, "horizon"));
      if (horizon < L.minHorizon || horizon > L.maxHorizon || horizon % 60 !== 0) throw refuse("horizon must be whole minutes, 5 minutes to 30 days");
      const deadline = checkDeadline(body.deadline);
      if (!(await isPlainKey(account))) throw refuse("the relayer only takes calls signed by a plain key, not a contract wallet; send it directly");

      const nonce = await read("nonces", [account]);
      const valid = await signedBy(account, { domain, types: LOCK_TYPES, primaryType: "LockCall", message: { account, callHash, horizon, nonce, deadline }, signature });
      if (!valid) throw new RelayError(401, `the signature isn't the account's LockCall for its next nonce (${nonce})`);
      ctx.verified();

      // A first lock opens the account's open-call book: those are capped per client address too.
      const opensBook = (await read("defaultBookOf", [account])) === 0n;
      const { hash, receipt } = await submit("lockBySig", [account, callHash, horizon, deadline, signature], {
        bucket: ctx.bucket,
        onSimulated: async () => {
          await limit(`lock:${account.toLowerCase()}`, L.locksPerAccountHour, "this account has locked 30 calls in the last hour; try again later");
          if (opensBook && ctx.bucket) await limit(`newbook:ip:${ctx.bucket}`, L.newBooksPerIpDay, `this address has opened ${L.newBooksPerIpDay} new books today; try again tomorrow`, DAY);
        },
      });
      const ev = parseEventLogs({ abi, logs: receipt.logs, eventName: "Locked" })[0];
      return { bookId: String(ev.args.bookId), callId: String(ev.args.callId), entryAt: Number(ev.args.entryAt), horizon: Number(ev.args.horizon), nonce: String(nonce), txHash: hash };
    });
  }

  /** POST /relay/seal: { bookId, p, callHash, deadline, signature } -> { bookId, p, txHash } */
  async function seal(body = {}, { ip } = {}) {
    return guarded(ip, null, async (ctx) => {
      const bookId = asBigInt(body.bookId, "bookId");
      const p = asBigInt(body.p, "p");
      const callHash = checkHash(body.callHash);
      const signature = checkSig(body.signature);
      const deadline = checkDeadline(body.deadline);
      let book;
      try {
        book = await read("books", [bookId]);
      } catch {
        throw refuse("no such book");
      }
      const [owner, period, , , closedAt, caller] = book;
      if (owner === ZERO) throw refuse("no such book");
      if (Number(period) === 0) throw refuse("that is an open-call book; it locks calls instead of sealing them");
      if (closedAt !== 0n) throw refuse("that book is closed");
      const message = { bookId, p, callHash, deadline };
      const typed = { domain, types: SEAL_TYPES, primaryType: "SealCall", message, signature };
      let signer = null;
      for (const who of [caller, owner]) {
        if (who === ZERO || signer) continue;
        if ((await signedBy(who, typed)) && (await isPlainKey(who))) signer = who;
      }
      if (!signer) throw new RelayError(401, "the signature isn't a plain-key SealCall by the book's caller or owner");
      const { hash } = await submit("sealBySig", [bookId, p, callHash, deadline, signature], {
        bucket: ctx.bucket,
        onSimulated: () => limit(`seal:${bookId}`, L.sealsPerBookHour, "this book has sealed 30 calls in the last hour; try again later"),
      });
      return { bookId: String(bookId), p: String(p), txHash: hash };
    });
  }

  /**
   * POST /relay/reveal, one of:
   *   { kind: "seal",   bookId, p, coinIndex, side, salt }
   *   { kind: "lock",   bookId, callId, coinIndex, side, salt }
   *   { kind: "symbol", bookId, callId, coin, side, salt }
   */
  async function reveal(body = {}, { ip } = {}) {
    return guarded(ip, null, async (ctx) => {
      const bookId = asBigInt(body.bookId, "bookId");
      const side = Number(body.side);
      if (![-1, 0, 1].includes(side)) throw refuse("side must be -1, 0 or 1");
      if (!BYTES32.test(body.salt ?? "")) throw refuse("salt must be a bytes32");
      let fn, args;
      if (body.kind === "seal") {
        fn = "reveal";
        args = [bookId, asBigInt(body.p, "p"), Number(asBigInt(body.coinIndex, "coinIndex")), side, body.salt];
      } else if (body.kind === "lock") {
        if (side === 0) throw refuse("an open call is long or short");
        fn = "revealLocked";
        args = [bookId, asBigInt(body.callId, "callId"), Number(asBigInt(body.coinIndex, "coinIndex")), side, body.salt];
      } else if (body.kind === "symbol") {
        if (side === 0) throw refuse("an open call is long or short");
        if (typeof body.coin !== "string" || !body.coin || Buffer.byteLength(body.coin) > 16) throw refuse("coin must be 1 to 16 bytes of text");
        fn = "revealLockedSymbol";
        args = [bookId, asBigInt(body.callId, "callId"), body.coin, side, body.salt];
      } else {
        throw refuse('kind must be "seal", "lock" or "symbol"');
      }
      const { hash } = await submit(fn, args, { bucket: ctx.bucket });
      return { kind: body.kind, bookId: String(bookId), txHash: hash };
    });
  }

  /**
   * POST /relay/profile: { account, bookId, name, bio, link, deadline, signature } -> { bookId, txHash }.
   * The text must already be in its cleaned form (checkProfile), since that's what was signed.
   */
  async function profile(body = {}, { ip } = {}) {
    const account = isAddress(body.account ?? "") ? getAddress(body.account) : null;
    return guarded(ip, account, async (ctx) => {
      if (!account) throw refuse("account must be an address");
      const bookId = asBigInt(body.bookId ?? 0, "bookId");
      const text = { name: body.name ?? "", bio: body.bio ?? "", link: body.link ?? "" };
      if (Object.values(text).some((v) => typeof v !== "string")) throw refuse("name, bio and link must be text");
      const checked = checkProfile(text);
      if (!checked.ok) throw refuse(checked.error);
      const p = checked.profile;
      if (p.name !== text.name || p.bio !== text.bio || p.link !== text.link) {
        throw refuse("send the profile as the name rules clean it (arena-names.js checkProfile), and sign that");
      }
      const signature = checkSig(body.signature);
      const deadline = checkDeadline(body.deadline);
      if (!(await isPlainKey(account))) throw refuse("the relayer only takes profiles signed by a plain key, not a contract wallet; send it directly");
      if (bookId !== 0n) {
        const owner = (await read("books", [bookId]))[0];
        if (owner === ZERO) throw refuse("no such book");
        if (getAddress(owner) !== account) throw refuse("only a book's owner can name it");
      } else if ((await read("booksOf", [account])).length === 0) {
        // A name shows only beside a record, so we don't pay to name an account that has none.
        throw refuse("lock your first call before picking a name: a name shows beside your records");
      }

      const nonce = await read("profileNonces", [account]);
      const message = { account, bookId, ...p, nonce, deadline };
      const valid = await signedBy(account, { domain, types: PROFILE_TYPES, primaryType: "SetProfile", message, signature });
      if (!valid) throw new RelayError(401, `the signature isn't the account's SetProfile for its next profile nonce (${nonce})`);
      ctx.verified();

      const { hash } = await submit("setProfileBySig", [account, bookId, p.name, p.bio, p.link, deadline, signature], {
        bucket: ctx.bucket,
        onSimulated: () => limit(`profile:${account.toLowerCase()}`, L.profilesPerAccountDay, `this account has changed its profile ${L.profilesPerAccountDay} times today; try again tomorrow`, DAY),
      });
      return { bookId: String(bookId), txHash: hash };
    });
  }

  return { lock, seal, reveal, profile, limits: L, address: wallet.account.address, queued: () => waiting };
}

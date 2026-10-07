/**
 * Every failure the SDK reports is a plain sentence an agent (or a person)
 * can act on: what went wrong, and what to do instead.
 */
import { BaseError, ContractFunctionRevertedError } from "viem";

import { formatDuration, utc } from "./durations.js";

export class CallbookError extends Error {
  /**
   * @param {string} message  the sentence shown to the agent
   * @param {string} [code]   a short machine-readable reason (a contract error name, or one of ours)
   * @param {object} [details]
   */
  constructor(message, code = "Error", details = {}) {
    super(message);
    this.name = "CallbookError";
    this.code = code;
    this.details = details;
  }
}

export const fail = (message, code, details) => {
  throw new CallbookError(message, code, details);
};

/** What each contract error means, given what we were doing (ctx: { action, bookId, round, now, network }). */
const SENTENCES = {
  BadConfig: () => "The Arena contract was deployed with a bad configuration.",
  UnknownBook: (a, c) => `There's no book ${a[0] ?? c.bookId} on ${c.network ?? "this network"}.`,
  NotBookOwner: (_, c) => `Only book ${c.bookId}'s owner can do that, and this key isn't it.`,
  NotCaller: (_, c) => `This key can't call in book ${c.bookId}: it's neither the book's owner nor its caller.`,
  BookClosed: (_, c) => `Book ${c.bookId} is closed: it takes no new calls (sealed calls can still be revealed).`,
  NoIdentityRegistry: () => "This network has no ERC-8004 IdentityRegistry, so a book can't link an agent here. Leave agentId out.",
  UnknownAgent: (a) => `There's no ERC-8004 agent ${a[0]}. Register it first, or leave agentId out.`,
  NotAgentOwner: (a) => `This key doesn't own ERC-8004 agent ${a[0]} and isn't approved for it, so it can't link it to a book.`,
  BadCoins: () => "A book takes 1 to 32 coins of 1 to 16 characters each.",
  BadPeriod: () => "A strategy book calls every 5m to 7d, in whole minutes.",
  BadHorizon: () => "That horizon isn't allowed in this book (whole minutes, within the book's range, at most 30d). It's checked when the call is locked.",
  EmptyCall: () => "A call's hash can't be zero.",
  ProfileTooLong: () => "That profile is too long: a name is at most 32 bytes, a bio 160 and a link 100.",
  SealTooLate: (a, c) => {
    const startsAt = Number(a[0]);
    const now = c.now ?? startsAt - 60;
    return `Too late to seal round ${c.round ?? "?"}: it starts in ${formatDuration(Math.max(0, startsAt - now))} and calls must be sealed 60s ahead. ` +
      `The next round can be sealed from ${utc(startsAt - 60)}.`;
  },
  SealTooEarly: (a) => `Too early: that round can be sealed from ${utc(Number(a[1]))}. Only the next round can be sealed.`,
  StaleId: (a) => `Another lock got there first: this call was hashed for id ${a[0]}, and the next is ${a[1]}. Nothing was recorded; lock it again.`,
  AlreadySealed: (_, c) => `Round ${c.round ?? "?"} of book ${c.bookId} is already sealed; each round is sealed once.`,
  NotSealed: (_, c) => `Round ${c.round ?? "?"} of book ${c.bookId} was never sealed, so there is nothing to reveal.`,
  AlreadyRevealed: () => "That call is already revealed.",
  RevealTooEarly: (a) => `Too early to reveal: the call matures at ${utc(Number(a[0]))}.`,
  RevealExpired: (a) => `Too late to reveal: the 7-day window closed at ${utc(Number(a[0]))}. The call now scores as its worst outcome.`,
  BadCoinIndex: () => "That coin isn't in this book.",
  BadSide: () => "A side is long or short (or flat, in a strategy book).",
  WrongPreimage: () => "The revealed call doesn't match what was sealed (wrong salt secret?).",
  NotStarted: (a) => `The book's first round starts at ${utc(Number(a[0]))}.`,
  NotScheduled: (_, c) => `Book ${c.bookId} is a call book, not a strategy book: use lock, not seal.`,
  NotFree: (_, c) => `Book ${c.bookId} is a strategy book: use seal for its rounds, not lock.`,
  NotLocked: () => "There's no such call in this book.",
  WrongCoinMode: (_, c) => `Book ${c.bookId} names its coins differently (coin list vs any coin) from what this call assumed.`,
  SignatureExpired: () => "The signature expired before the relayer sent it. Try again.",
  BadSignature: () => "The relayer's transaction was refused: the signature doesn't match (the nonce may have moved on). Try again.",
};

const textOf = (err) => `${err?.shortMessage ?? ""} ${err?.details ?? ""} ${err?.message ?? ""}`;

/** A contract revert or RPC failure as a CallbookError with a sentence. */
export function explain(err, ctx = {}) {
  if (err instanceof CallbookError) return err;
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    const name = revert?.data?.errorName;
    if (name) {
      const say = SENTENCES[name];
      return new CallbookError(say ? say(revert.data.args ?? [], ctx) : `The contract refused: ${name}.`, name, { args: revert.data.args });
    }
    const text = textOf(err);
    if (/insufficient funds|exceeds the balance|gas required exceeds/i.test(text)) {
      return new CallbookError(
        `This key has no USDC for gas on ${ctx.network ?? "this network"}. Fund ${ctx.address ?? "it"} (testnet: faucet.circle.com), or set a relay URL to go gasless.`,
        "NoGas",
      );
    }
    if (/fetch failed|ECONNREFUSED|HTTP request failed|timed out|took too long/i.test(text)) {
      return new CallbookError(`Can't reach the ${ctx.network ?? ""} RPC right now (${err.shortMessage ?? "no answer"}). Try again in a moment.`, "Rpc");
    }
    return new CallbookError(`The transaction failed: ${err.shortMessage ?? err.message}`, "Reverted");
  }
  return new CallbookError(err?.message ?? String(err), "Error");
}

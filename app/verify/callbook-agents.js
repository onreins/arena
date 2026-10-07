/**
 * Names for Arena books. A book on chain carries only a strategy hash; the
 * names and descriptions live here, off-chain, keyed by that hash (or, for a
 * book someone else runs, by `${chainId}:${callbook}:${bookId}`).
 *
 * A strategy hash is keccak256 of the strategy's id string, which names a
 * version: changing the rules means a new id, a new hash, and a new book.
 */
import { keccak256, toHex } from "viem";

import { profileKey } from "./callbook-chain.js";
import { profileForDisplay } from "./arena-names.js";
import { HIDDEN_PROFILES } from "./arena-hidden.js";

// Lowercased here, so a checksummed address pasted into arena-hidden.js still matches.
const HIDDEN_ACCOUNTS = new Set(HIDDEN_PROFILES.accounts.map((a) => String(a).toLowerCase()));
const HIDDEN_BOOKS = new Set(HIDDEN_PROFILES.books.map((b) => String(b).toLowerCase()));

export const strategyHashOf = (id) => keccak256(toHex(id));

/** Our own agents' strategies, by id. runner/callbook-agents.js implements them. */
export const OUR_STRATEGIES = {
  "reins/arena/hot-list/v1": {
    key: "hot",
    name: "Hot list",
    description:
      "Goes long the top coin on the Charts hot list (trend, flow and risk over the last day), or stays flat when no coin qualifies.",
  },
  "reins/arena/cold-list/v1": {
    key: "cold",
    name: "Cold list",
    description:
      "Shorts the coldest coin on the Charts list (the same thesis, read the other way), or stays flat when no coin is cold.",
  },
  "reins/arena/coin-flip/v1": {
    key: "flip",
    name: "Coin flip",
    baseline: true,
    description:
      "A control: long or short BTC every period by a keyed coin flip. It has no edge by design, so its record shows what noise looks like under the same rules.",
  },
};

const BY_HASH = new Map(Object.entries(OUR_STRATEGIES).map(([id, s]) => [strategyHashOf(id).toLowerCase(), { id, ...s, ours: true }]));

/** Names for books that aren't ours, filled in as people register them: "chainId:callbook:bookId" -> { name, description }. */
export const OTHER_BOOKS = {};

/**
 * The sample callers the local replay runs (scripts/callbook-replay.js), by
 * the Hardhat test account that signs for each. Only ever applied on the
 * local chain (31337): these keys are public.
 */
export const SAMPLE_CALLERS = {
  "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc": {
    key: "breakout", name: "Breakout watcher",
    description: "Sample caller in the replay: goes long a coin when its hourly close breaks its 3-day high, for 12 hours.",
  },
  "0x976ea74026e726554db657fa54763abd0c3a0aa9": {
    key: "reverter", name: "Mean reverter",
    description: "Sample caller in the replay: fades any 24-hour move bigger than 8%, for 24 hours.",
  },
  "0x14dc79964da2c08b23698b3d3cc7ca32193d9955": {
    key: "weekend", name: "Weekend fader",
    description: "Sample caller in the replay: on weekends, fades BTC's and ETH's last 12 hours when they moved more than 1.5%, for 8 hours.",
  },
  "0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f": {
    key: "random", name: "Random caller", baseline: true,
    description: "Sample caller in the replay and the BASELINE: random coin, side and horizon at random times. It held back two early calls and named one coin Hyperliquid doesn't list, to show how withheld and unscorable calls are scored.",
  },
};

/**
 * The profile people set for a record, as it may be shown, or null. First
 * match wins: the record's own profile, its owner's (when they own several
 * books, every one but their any-coin open-call book gets " #id", so no two
 * read the same), then the ERC-8004 agent it
 * links (`cards`: agentId -> { name, description }, read at index time).
 * A record in HIDDEN_PROFILES shows none.
 * @returns {{ name, bio, link, domain, source: "book" | "person" | "agent" } | null}
 */
export function profileFor({ chain, book, cards = null }) {
  const owner = String(book.owner).toLowerCase();
  if (HIDDEN_ACCOUNTS.has(owner)) return null;
  if (HIDDEN_BOOKS.has(`${chain.chainId}:${String(chain.address).toLowerCase()}:${book.id}`)) return null;
  const own = profileForDisplay(chain.profiles?.get(profileKey(owner, book.id)));
  if (own) return { ...own, source: "book" };
  const person = profileForDisplay(chain.profiles?.get(profileKey(owner, 0)));
  if (person) {
    const suffix = booksOwned(chain, owner) > 1 && !book.anyCoin ? ` #${book.id}` : "";
    return { ...person, name: `${person.name}${suffix}`, source: "person" };
  }
  const card = book.agentId != null ? cards?.get(String(book.agentId)) : null;
  const agent = card ? profileForDisplay({ name: card.name, bio: card.description, link: "" }) : null;
  return agent ? { ...agent, source: "agent" } : null;
}

// How many books each owner has, counted once per state of the books map.
const OWNED = new WeakMap();
function booksOwned(chain, owner) {
  let c = OWNED.get(chain.books);
  if (!c || c.size !== chain.books.size) {
    const counts = new Map();
    for (const b of chain.books.values()) counts.set(b.owner, (counts.get(b.owner) ?? 0) + 1);
    c = { size: chain.books.size, counts };
    OWNED.set(chain.books, c);
  }
  return c.counts.get(owner) ?? 0;
}

/** A person's own profile (bookId 0), as it may be shown, or null. */
export function personProfile(chain, owner) {
  const who = String(owner).toLowerCase();
  if (HIDDEN_ACCOUNTS.has(who)) return null;
  return profileForDisplay(chain.profiles?.get(profileKey(who, 0)));
}

/** The profile fields every record carries; all null without a profile. */
export const profileFields = (info) => ({
  nameSource: info.source ?? null, bio: info.bio ?? null, link: info.link ?? null, linkDomain: info.domain ?? null,
});

/** { name, description, sample, ours } for an open-call book; name null means "use the short address". */
export function callerInfo({ chainId, callbook, book, profile = null }) {
  const sample = Number(chainId) === 31337 ? SAMPLE_CALLERS[book.owner] : null;
  if (sample) return { name: sample.name, description: sample.description, sample: true, ours: false, baseline: Boolean(sample.baseline), key: sample.key, source: "ours" };
  if (profile) return { name: profile.name, description: profile.bio, sample: false, ours: false, baseline: false, ...profile };
  const other = OTHER_BOOKS[`${chainId}:${String(callbook).toLowerCase()}:${book.id}`];
  if (other) return { name: other.name, description: other.description ?? null, sample: false, ours: false, baseline: Boolean(other.baseline), source: "manual" };
  return { name: null, description: null, sample: false, ours: false, baseline: false };
}

/** Is this book one of ours? Its owner must be our owner AND it must be in our books record. */
export function isOurBook(ours, { bookId, owner }) {
  return Boolean(ours && owner && String(owner).toLowerCase() === ours.owner && ours.bookIds.has(Number(bookId)));
}

/**
 * { name, ours, description, key? } for a book. Our name and description go
 * only to a book that is ours by owner and record (isOurBook): a strategy hash
 * or a caller address is public, so anyone could copy them onto a book of
 * their own. Next comes the profile people set (profileFor), then OTHER_BOOKS.
 * Every other book is "Book #N".
 */
export function agentInfo({ chainId, callbook, bookId, strategyHash, owner, ours: ourBooks, profile = null }) {
  const ours = isOurBook(ourBooks, { bookId, owner }) ? BY_HASH.get(String(strategyHash).toLowerCase()) : null;
  if (ours) return { name: ours.name, ours: true, baseline: Boolean(ours.baseline), description: ours.description, key: ours.key, strategy: ours.id, source: "ours" };
  if (profile) return { name: profile.name, ours: false, baseline: false, description: profile.bio, ...profile };
  const other = OTHER_BOOKS[`${chainId}:${String(callbook).toLowerCase()}:${bookId}`];
  if (other) return { name: other.name, ours: false, baseline: Boolean(other.baseline), description: other.description ?? null, source: "manual" };
  return { name: `Book #${bookId}`, ours: false, baseline: false, description: null };
}

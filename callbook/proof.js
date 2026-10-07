/**
 * Callbook's cryptography, off-chain: the salt secret, salts, the three call
 * hashes, and recovering a call from its hash.
 *
 * Salts are never stored. Each one is HMAC-SHA256(secret, label), where the
 * label names the chain, the contract and the call's slot, so the same secret
 * on any machine recreates every salt:
 *
 *   seal in a strategy book     "chainId:callbook:bookId:p"            (runner/callbook.js's scheme)
 *   lock in a coin-list book    "chainId:callbook:bookId:lock:callId"
 *   lock in an any-coin book    "chainId:callbook:account:nonce:N"     (book and call id aren't known when signed)
 *
 * The secret defaults to HMAC-SHA256(key, "callbook salt secret v1"), so an
 * agent needs one secret, its key. Trade-off: whoever has the key can also
 * recreate the salts and so read your sealed calls before they're revealed.
 * They could also seal in your name, so that adds little, but a separate
 * `saltSecret` keeps your open calls private even if the key leaks.
 *
 * A call has few possible values, so with the salt in hand the call behind a
 * hash is found by trying them all. A lock's horizon is public (the Locked
 * event), so the search tries coin x side with that one horizon: about 230
 * Hyperliquid perps x 2 sides for an any-coin call, a few hundred hashes. The
 * search still accepts a list of horizons for a caller that doesn't know it.
 * Hashes are built in a reused buffer, so even a full miss costs milliseconds.
 */
import { createHmac } from "node:crypto";
import { keccak256, toHex, hexToBytes, getAddress } from "viem";

import { callHash, lockedHash as engineLockedHash, symbolCallHash } from "../app/verify/callbook.js";
import { LOCKED_TAG, SYMBOL_TAG } from "../app/verify/callbook-callers.js";

export { callHash, LOCKED_TAG, SYMBOL_TAG };
export const SIDES = Object.freeze({ long: 1, short: -1, flat: 0 });
export const SIDE_NAME = Object.freeze({ 1: "long", "-1": "short", 0: "flat" });

const SECRET_LABEL = "callbook salt secret v1";

/** The default salt secret: HMAC-SHA256(private key, fixed label), 64 hex characters. */
export function saltSecretFromKey(key) {
  return createHmac("sha256", String(key).toLowerCase()).update(SECRET_LABEL).digest("hex");
}

function hmac(secret, label) {
  if (!secret || String(secret).length < 32) throw new Error("The salt secret must be at least 32 characters.");
  return `0x${createHmac("sha256", secret).update(label).digest("hex")}`;
}

const lower = (a) => String(a).toLowerCase();

/** A seal's salt: exactly runner/callbook.js deriveSalt, so the runner and the SDK agree. */
export const sealSalt = (secret, { chainId, callbook, bookId, p }) => hmac(secret, `${chainId}:${lower(callbook)}:${bookId}:${p}`);

/** A lock's salt in a book with a coin list. */
export const lockSalt = (secret, { chainId, callbook, bookId, callId }) => hmac(secret, `${chainId}:${lower(callbook)}:${bookId}:lock:${callId}`);

/** A lock's salt in an any-coin book, keyed by the owner's nonce. */
export const symbolSalt = (secret, { chainId, callbook, account, nonce }) => hmac(secret, `${chainId}:${lower(callbook)}:${lower(account)}:nonce:${nonce}`);

/** Callbook.lockedHashOf and Callbook.symbolCallHashOf, from the scoring engine so both agree. */
export const lockedHash = engineLockedHash;
export const symbolHash = (call) => symbolCallHash({ ...call, horizon: Number(call.horizon) });

// ------------------------------------------------------------------ recovery

const WORD = 32;

/** A 32-byte big-endian word for a non-negative integer, an address or a bytes32. */
function word(value) {
  const out = new Uint8Array(WORD);
  if (typeof value === "string" && value.startsWith("0x")) {
    const bytes = hexToBytes(value);
    out.set(bytes, WORD - bytes.length);
    return out;
  }
  let n = BigInt(value);
  for (let i = WORD - 1; i >= 0 && n > 0n; i--, n >>= 8n) out[i] = Number(n & 0xffn);
  return out;
}

/** int8 as an abi word: -1 is 32 bytes of 0xff. */
const sideWord = (side) => (side < 0 ? new Uint8Array(WORD).fill(0xff) : word(side));

/**
 * Search a 9-word preimage: words[5] (coin), [6] (side) and [7] (horizon) vary,
 * the rest are fixed. Returns the first match or null.
 */
function search(fixed, target, { coins, sides, horizons }) {
  const buf = new Uint8Array(9 * WORD);
  fixed.forEach((w, i) => w && buf.set(w, i * WORD));
  const want = Buffer.from(hexToBytes(target));
  const sideWords = sides.map(sideWord);
  const horizonWords = horizons.map(word);
  // Horizon outermost: common horizons come first, so typical calls are found early.
  for (let h = 0; h < horizons.length; h++) {
    buf.set(horizonWords[h], 7 * WORD);
    for (let c = 0; c < coins.length; c++) {
      buf.set(coins[c].word, 5 * WORD);
      for (let s = 0; s < sides.length; s++) {
        buf.set(sideWords[s], 6 * WORD);
        if (want.equals(keccak256(buf, "bytes"))) return { coin: coins[c].value, side: sides[s], horizon: horizons[h] };
      }
    }
  }
  return null;
}

/**
 * The call behind an any-coin lock: { coin, side, horizon } or null.
 * coins: candidate symbols (every Hyperliquid perp); horizons: seconds to try, in order.
 */
export function recoverSymbolCall({ hash, callbook, chainId, account, nonce, salt, coins, horizons, sides = [1, -1] }) {
  const fixed = [word(SYMBOL_TAG), word(getAddress(callbook)), word(chainId), word(getAddress(account)), word(nonce), null, null, null, word(salt)];
  const candidates = [...new Set(coins)].map((value) => ({ value, word: hexToBytes(keccak256(toHex(value))) }));
  return search(fixed, hash, { coins: candidates, sides, horizons });
}

/** The call behind a lock in a coin-list book: { coinIndex, side, horizon } or null. */
export function recoverLockedCall({ hash, callbook, chainId, bookId, callId, salt, coinCount, horizons, sides = [1, -1] }) {
  const fixed = [word(LOCKED_TAG), word(getAddress(callbook)), word(chainId), word(bookId), word(callId), null, null, null, word(salt)];
  const candidates = Array.from({ length: coinCount }, (_, i) => ({ value: i, word: word(i) }));
  const found = search(fixed, hash, { coins: candidates, sides, horizons });
  return found && { coinIndex: found.coin, side: found.side, horizon: found.horizon };
}

/** The call behind a strategy seal: { coinIndex, side } or null. */
export function recoverSealedCall({ hash, callbook, chainId, bookId, p, salt, coinCount }) {
  for (let coinIndex = 0; coinIndex < coinCount; coinIndex++) {
    for (const side of [1, -1, 0]) {
      if (callHash({ callbook, chainId, bookId, p, coinIndex, side, salt }) === String(hash).toLowerCase()) return { coinIndex, side };
    }
  }
  return null;
}

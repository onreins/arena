/**
 * Stop-loss and take-profit on an open call, sealed inside its salt
 * (docs/CALLBOOK.md, "Exits").
 *
 * A call's salt is already bound into its hash, so the contract needs no
 * change: exits are fixed when the call is locked, hidden with it, and public
 * once it's revealed. A salt with exits is laid out as
 *
 *   bytes  0-15   secret: the first 16 bytes of the call's ordinary salt
 *   bytes 16-19   "XIT1"
 *   bytes 20-25   stop price   (6 bytes; 0 for none)
 *   bytes 26-31   target price (6 bytes; 0 for none)
 *
 * A price is 1 byte of exponent (e + 64) then 5 bytes of mantissa m:
 * price = m × 10^e, up to 12 significant digits. Any other salt has no exits.
 *
 * Scoring walks the coin's candles from entry: the first level touched closes
 * the call, and a call that touches neither closes at its horizon, as before.
 * The fills are never flattering: a stop the price gaps through fills at that
 * candle's open, a target fills at the target, and a candle that touches both
 * counts as the stop. A level already crossed at entry closes the call there.
 */

/** The longest a call with exits may run: 5-minute prices for its whole span stay available to score it. */
export const MAX_EXIT_HOLD = 7 * 86_400;
/**
 * 2026-10-08 00:00 UTC: nothing could seal exits before then, so a call locked
 * earlier has none, its salt is never read, and it scores exactly as it did.
 */
export const EXITS_SINCE = 1_791_417_600;
export const EXITS_MARKER = "58495431"; // "XIT1"

const SIG_DIGITS = 12;
const EXP_BIAS = 64;
const MANTISSA_BITS = 40n;
const hex = (n, bytes) => n.toString(16).padStart(bytes * 2, "0");

// ------------------------------------------------------------------ prices

/** A positive price (number or decimal text) as { m: BigInt, e } with m × 10^e, at most 12 significant digits. */
export function parsePrice(value) {
  const text = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : String(value ?? "").trim();
  const match = /^(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match || !(match[1] || match[2])) throw new Error(`"${value}" isn't a price.`);
  let digits = (match[1] ?? "") + (match[2] ?? "");
  let e = Number(match[3] ?? 0) - (match[2] ?? "").length;
  digits = digits.replace(/^0+/, "");
  if (!digits) throw new Error("A price must be above 0.");
  if (digits.length > SIG_DIGITS) {
    const cut = digits.length - SIG_DIGITS;
    let m = BigInt(digits.slice(0, SIG_DIGITS)) + (Number(digits[SIG_DIGITS]) >= 5 ? 1n : 0n);
    e += cut;
    if (m >= 10n ** BigInt(SIG_DIGITS)) { m /= 10n; e++; }
    digits = m.toString();
  }
  while (digits.length > 1 && digits.endsWith("0")) { digits = digits.slice(0, -1); e++; }
  if (e + EXP_BIAS < 0 || e + EXP_BIAS > 255) throw new Error(`"${value}" is out of range for a price.`);
  return { m: BigInt(digits), e };
}

/** The 6-byte encoding of a price (0n for none). */
export function encodePrice(value) {
  if (value == null || value === "") return 0n;
  const { m, e } = parsePrice(value);
  return (BigInt(e + EXP_BIAS) << MANTISSA_BITS) | m;
}

/** A 6-byte encoding back to { value: Number, text: exact decimal }, or null for 0. */
export function decodePrice(n) {
  const big = BigInt(n);
  const m = big & ((1n << MANTISSA_BITS) - 1n);
  if (m === 0n) return null;
  const e = Number(big >> MANTISSA_BITS) - EXP_BIAS;
  const digits = m.toString();
  let text;
  if (e >= 0) text = digits + "0".repeat(e);
  else {
    const padded = digits.padStart(-e + 1, "0");
    text = `${padded.slice(0, padded.length + e)}.${padded.slice(padded.length + e)}`.replace(/\.?0+$/, "");
  }
  return { value: Number(text), text };
}

/** A price as the exact decimal text it would be sealed as (12 significant digits). */
export const sealedPrice = (value) => decodePrice(encodePrice(value)).text;

const level = (v) => (v == null || v === "" ? null : Number(sealedPrice(v)));

// ------------------------------------------------------------------ salts

/** A salt with exits sealed in: the first 16 bytes of `salt`, the marker, then stop and target. */
export function withExits(salt, { stop = null, target = null } = {}) {
  const s = encodePrice(stop), t = encodePrice(target);
  if (s === 0n && t === 0n) return salt;
  const base = String(salt).toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(base)) throw new Error("A salt is 32 bytes of hex.");
  return `0x${base.slice(0, 32)}${EXITS_MARKER}${hex(s, 6)}${hex(t, 6)}`;
}

/** The exits sealed in a salt: { stop, target } (each { value, text } or null), or null for a salt without them. */
export function exitsOf(salt) {
  const s = String(salt ?? "").toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(s) || s.slice(32, 40) !== EXITS_MARKER) return null;
  const stop = decodePrice(BigInt(`0x${s.slice(40, 52)}`)), target = decodePrice(BigInt(`0x${s.slice(52, 64)}`));
  return stop || target ? { stop, target } : null;
}

/**
 * Why a call's exits are wrong, or null: levels on the right side of the
 * current `price` (below it for a long's stop, above it for its target), the
 * stop under the target for a long and over it for a short, and a horizon of
 * MAX_EXIT_HOLD at most. Without a price, the levels are checked against each other only.
 */
export function exitsProblem({ side, stop = null, target = null, price = null, horizon = null, coin = "the coin" }) {
  const s = level(stop), t = level(target);
  if (s == null && t == null) return null;
  if (horizon != null && horizon > MAX_EXIT_HOLD) return "A call with a stop or a target runs at most 7 days; shorten its horizon.";
  const long = side > 0;
  if (s != null && t != null && (long ? s >= t : s <= t)) return long ? "A long's stop must be below its target." : "A short's stop must be above its target.";
  if (price > 0) {
    const at = `${coin} is at ${price}`;
    if (s != null && (long ? s >= price : s <= price)) return `${at}: a ${long ? "long" : "short"}'s stop must be ${long ? "below" : "above"} that.`;
    if (t != null && (long ? t <= price : t >= price)) return `${at}: a ${long ? "long" : "short"}'s target must be ${long ? "above" : "below"} that.`;
  }
  return null;
}

// ------------------------------------------------------------------ the path

/**
 * Where a call with exits closed, on raw candle prices (no funding).
 * rows: the coin's candles [{ t, o, h, l }], sorted, of `step` seconds.
 * The call enters at the first open at or after `entryAt`. A level already
 * crossed by that open closes the call at entry. Each candle that opens before
 * `exitAt` is then checked: its open first (a gap past the stop fills at the
 * open, past the target at the target), then its range (both levels in one
 * candle: the stop). Untouched, it closes at the first open at or after `exitAt`.
 * Returns { entryT, entry, exitT, exit, reason: "stop" | "target" | "time" },
 * or null without an entry candle or one at the horizon.
 */
export function exitPath({ rows, step, side, entryAt, exitAt, stop = null, target = null }) {
  const firstAt = (t) => {
    let lo = 0, hi = rows.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (rows[mid].t < t) lo = mid + 1; else hi = mid; }
    return rows[lo] && rows[lo].t - t < step ? lo : -1;
  };
  const i0 = firstAt(entryAt);
  if (i0 < 0) return null;
  const entry = rows[i0];
  const out = (exitT, exit, reason) => ({ entryT: entry.t, entry: entry.o, exitT, exit, reason });
  const long = side > 0;
  const stopHit = (p) => stop != null && (long ? p <= stop : p >= stop);
  const targetHit = (p) => target != null && (long ? p >= target : p <= target);
  if (stopHit(entry.o)) return out(entry.t, entry.o, "stop");
  if (targetHit(entry.o)) return out(entry.t, entry.o, "target");
  // A missing candle is a slot with no trades: nothing could touch a level in it, and the
  // next candle's open catches any gap. Prices that end before the horizon leave it unpriced.
  const j = firstAt(exitAt);
  if (j < 0) return null;
  for (let i = i0; i < j; i++) {
    const r = rows[i];
    if (stopHit(r.o)) return out(r.t, r.o, "stop");
    if (targetHit(r.o)) return out(r.t, target, "target");
    if (stopHit(long ? r.l : r.h)) return out(r.t + step, stop, "stop");
    if (targetHit(long ? r.h : r.l)) return out(r.t + step, target, "target");
  }
  return out(rows[j].t, rows[j].o, "time");
}

// ------------------------------------------------------------------ reading a reveal's salt

/**
 * The salt a reveal used, from its transaction's input: the 32-byte window
 * that makes `matches(salt)` true (the call's own hash). A reveal sent through
 * a wallet contract or a batch still carries the salt somewhere in its input;
 * checking each candidate against the hash means a planted look-alike can't
 * pass. Null if none does.
 */
export function findSalt(input, matches) {
  const s = String(input ?? "").toLowerCase().replace(/^0x/, "");
  if (s.length < 64 || s.length % 2) return null;
  const at = (o) => { const salt = `0x${s.slice(o, o + 64)}`; return matches(salt) ? salt : null; };
  // A direct revealLocked / revealLockedSymbol call: the salt is its fifth word. One hash.
  if (s.length >= DIRECT_SALT + 64) {
    const found = at(DIRECT_SALT);
    if (found) return found;
  }
  // Anything else (a wallet contract, a batch) puts it on a word grid: 4 bytes in, or a call nested
  // in another's bytes. Each try costs a hash and the input's length is the sender's choice, so a
  // big input gets no wider search, and only a small one the byte-by-byte search too.
  if (s.length > 2 * GRID_SCAN_BYTES) return null;
  for (let o = 0; o + 64 <= s.length; o += 64) {
    const found = (o + 8 + 64 <= s.length && at(o + 8)) || at(o);
    if (found) return found;
  }
  if (s.length > 2 * FULL_SCAN_BYTES) return null;
  for (let o = 2; o + 64 <= s.length; o += 2) {
    const found = at(o);
    if (found) return found;
  }
  return null;
}

/** Inputs up to this many bytes are also searched at every byte offset. */
export const FULL_SCAN_BYTES = 1_024;
/** Inputs up to this many bytes are searched on the word grid; a bigger one only where a direct reveal puts the salt. */
export const GRID_SCAN_BYTES = 8_192;
/** Hex offset of a direct reveal's salt: the 4-byte selector, then four words (book, call, coin, side). */
const DIRECT_SALT = 8 + 4 * 64;

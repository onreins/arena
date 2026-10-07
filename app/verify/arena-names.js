/**
 * What an Arena profile may say. The contract only caps lengths in bytes; this
 * file is the rest, and the MCP (before signing), the relayer (before paying)
 * and the indexer (before showing) all use it, so they always agree.
 *
 *   name  3 to 32 characters and at most 32 bytes, with a letter or digit;
 *         not one of ours or a look-alike ("R3INS", "hot-list"). Empty clears.
 *   bio   up to 160 bytes
 *   link  an https:// address of up to 100 bytes, or nothing
 *
 * Text is NFKC-normalised, every control or invisible character becomes a
 * space, and runs of spaces collapse. Names aren't unique: the address shown
 * under every name is what tells two people apart.
 */
import { OUR_STRATEGIES } from "./callbook-agents.js";

export const PROFILE_LIMITS = Object.freeze({ nameMin: 3, nameBytes: 32, bioBytes: 160, linkBytes: 100 });

// Controls, invisible format characters (zero-width, bidi overrides, soft hyphen,
// BOM, tags), line/paragraph separators, variation selectors and blank fillers.
// Blank-looking letters too: Hangul fillers, the Braille blank, the Mongolian vowel separator.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}︀-️ᅟᅠㅤﾠ⠀᠎]/gu;
const LEET = { 0: "o", 1: "l", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b" };
// Cyrillic and Greek letters that pass for Latin ones (after lowercasing): "Rеins" with a Cyrillic е is still Reins.
const LOOKALIKE = {
  а: "a", в: "b", е: "e", ё: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x", ѕ: "s", і: "i", ї: "i", ј: "j", һ: "h", ԁ: "d", ӏ: "l",
  α: "a", β: "b", ε: "e", η: "n", ι: "i", κ: "k", μ: "u", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x", ω: "w", ɡ: "g", ı: "i",
};

// Taken outright, anywhere in a name.
const RESERVED_PARTS = ["reins", "official", "callbook"];
// Taken as the whole name, along with our bots' names.
const RESERVED_NAMES = ["arena", "admin", "support", "moderator", "team", "staff", "system"];
// "Arena" with one of these anywhere in the name reads as us: "Arena Support", "Team Arena".
const STAFF_WORDS = ["support", "admin", "team", "staff", "mod", "help", "system", "bot"];

const bytes = (s) => new TextEncoder().encode(s).length;

/** NFKC, invisible characters to spaces, spaces collapsed and trimmed. */
export function cleanProfileText(text) {
  return String(text ?? "").normalize("NFKC").replace(UNSAFE, " ").replace(/\s+/gu, " ").trim();
}

/**
 * The form names are compared in: lowercase, look-alike digits as letters, only
 * letters and digits, and i, l and 1 as one letter (they pass for each other).
 */
export function foldName(name) {
  return cleanProfileText(name).toLowerCase().replace(/./gu, (c) => LOOKALIKE[c] ?? c)
    .replace(/[0-9]/g, (d) => LEET[d] ?? d).replace(/i/g, "l").replace(/[^\p{L}\p{N}]/gu, "");
}

// Built on first use: callbook-agents.js imports this file too, so OUR_STRATEGIES
// isn't ready while these modules load.
let reserved = null;
const reservedNames = () => (reserved ??= {
  names: new Set([...RESERVED_NAMES, ...Object.values(OUR_STRATEGIES).map((s) => s.name)].map(foldName)),
  parts: RESERVED_PARTS.map(foldName),
  arena: foldName("arena"),
  staff: STAFF_WORDS.map(foldName),
});

/** True when a name is ours or looks like it. */
export function isReservedName(name) {
  const f = foldName(name);
  const r = reservedNames();
  if (r.names.has(f) || r.parts.some((p) => f.includes(p))) return true;
  return f.includes(r.arena) && r.staff.some((w) => f.replace(r.arena, "").includes(w));
}

/** "https://www.x.com/abc" → "x.com"; null for anything that isn't a plain https link. */
export function linkDomain(link) {
  try {
    const u = new URL(link);
    if (u.protocol !== "https:" || u.username || u.password || !u.hostname.includes(".")) return null;
    return u.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** A link as people type it ("x.com/me") made into https; null when it can't be one. */
function normaliseLink(link) {
  const s = cleanProfileText(link).replace(/\s/g, "");
  if (!s) return "";
  const full = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  return linkDomain(full) ? full : null;
}

/**
 * Check a profile as someone wants to set it.
 * @returns {{ ok: true, profile: { name, bio, link } } | { ok: false, error: string }}
 *          The profile is the cleaned text to sign and send. A name of "" clears.
 */
export function checkProfile({ name = "", bio = "", link = "" } = {}) {
  const n = cleanProfileText(name);
  const b = cleanProfileText(bio);
  const l = normaliseLink(link);
  if (n === "") return { ok: true, profile: { name: "", bio: "", link: "" } };
  if ([...n].length < PROFILE_LIMITS.nameMin) return { ok: false, error: `A name needs at least ${PROFILE_LIMITS.nameMin} characters.` };
  if (bytes(n) > PROFILE_LIMITS.nameBytes) return { ok: false, error: `That name is too long: at most ${PROFILE_LIMITS.nameBytes} bytes (fewer for accents or emoji).` };
  if (!/[\p{L}\p{N}]/u.test(n)) return { ok: false, error: "A name needs at least one letter or digit." };
  if (isReservedName(n)) return { ok: false, error: `"${n}" is reserved: it's Reins's own, or looks like it. Pick another name.` };
  if (bytes(b) > PROFILE_LIMITS.bioBytes) return { ok: false, error: `The bio is too long: at most ${PROFILE_LIMITS.bioBytes} bytes.` };
  if (l === null) return { ok: false, error: "The link must be an https:// web address." };
  if (bytes(l) > PROFILE_LIMITS.linkBytes) return { ok: false, error: `The link is too long: at most ${PROFILE_LIMITS.linkBytes} bytes.` };
  return { ok: true, profile: { name: n, bio: b, link: l } };
}

/**
 * A profile as read from the chain, made safe to show: null when the name
 * breaks the rules (or was cleared), else the name with whichever of bio and
 * link pass. `domain` is the link's host, for display.
 */
export function profileForDisplay(raw) {
  if (!raw) return null;
  const checked = checkProfile({ name: raw.name });
  if (!checked.ok || !checked.profile.name) return null;
  const bio = cleanProfileText(raw.bio);
  const link = linkDomain(raw.link ?? "") && bytes(raw.link) <= PROFILE_LIMITS.linkBytes ? raw.link : null;
  return {
    name: checked.profile.name,
    bio: bio && bytes(bio) <= PROFILE_LIMITS.bioBytes ? bio : null,
    link,
    domain: link ? linkDomain(link) : null,
  };
}

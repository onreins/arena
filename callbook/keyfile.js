/**
 * The agent's Arena key when CALLBOOK_KEY isn't set: made on first start and
 * kept in ~/.arena/key, so setting up Arena needs no key at all.
 *
 * The key signs calls and needs no money (the relayer pays gas). Every call's
 * salt is derived from it too, so this file is what reveals the calls it
 * locked and keeps the record yours: back it up, and copy it to another machine
 * to carry on there. It is never overwritten, and never shown to the agent.
 */
import { mkdirSync, readFileSync, writeFileSync, linkSync, unlinkSync, statSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { generatePrivateKey } from "viem/accounts";

const KEY = /^0x[0-9a-fA-F]{64}$/;
/** Errors from a filesystem that can't make hard links. */
const NO_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"]);

export const defaultKeyPath = () => path.join(homedir(), ".arena", "key");

function read(file) {
  let text;
  try {
    text = readFileSync(file, "utf8").trim();
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  if (!KEY.test(text)) throw new Error(`${file} isn't an Arena key (0x and 64 hex digits). Fix or move it: it's never overwritten.`);
  // A key copied from another machine is often readable by everyone: make it owner-only (not on Windows).
  if (process.platform !== "win32") {
    try {
      if (statSync(file).mode & 0o077) chmodSync(file, 0o600);
    } catch {
      // Not ours to change: it still works.
    }
  }
  return text;
}

/**
 * The key in `file`, made first if there isn't one.
 * @returns {{ key: string, file: string, created: boolean }}
 */
export function loadOrCreateKey(file = defaultKeyPath()) {
  const existing = read(file);
  if (existing) return { key: existing, file, created: false };

  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Written whole to a temporary file, then linked into place: the link fails if
  // another start made a key meanwhile, and nobody ever reads a half-written one.
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  const key = generatePrivateKey();
  writeFileSync(tmp, `${key}\n`, { mode: 0o600 });
  try {
    linkSync(tmp, file);
    return { key, file, created: true };
  } catch (err) {
    if (err.code === "EEXIST") return { key: read(file), file, created: false };
    if (!NO_LINKS.has(err.code)) throw err;
    // A drive without hard links (FAT, exFAT, some network mounts): create it exclusively instead.
    try {
      writeFileSync(file, `${key}\n`, { flag: "wx", mode: 0o600 });
      return { key, file, created: true };
    } catch (e) {
      if (e.code === "EEXIST") return { key: read(file), file, created: false };
      throw e;
    }
  } finally {
    unlinkSync(tmp);
  }
}

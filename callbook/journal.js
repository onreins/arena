/**
 * A tiny local journal of the plaintext behind this key's open calls, so a
 * reveal doesn't have to search for it. It's a convenience, never a
 * requirement: every call can also be recovered from its hash with the salt
 * secret (callbook/proof.js), and recovered calls are written back here.
 *
 * One JSON file per key, default ~/.arena/<address>.json, written
 * atomically with owner-only permissions. It holds no keys and no salts, only
 * what will be public at reveal anyway; until then it does say which way your
 * open calls go, so keep it private.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const defaultJournalPath = (address) => path.join(homedir(), ".arena", `${String(address).toLowerCase()}.json`);

const slot = (e) => `${e.chainId}:${String(e.callbook).toLowerCase()}:${e.bookId}:${e.callId}`;

export class Journal {
  /** @param {string|null} file  null keeps the journal in memory only */
  constructor(file) {
    this.file = file;
    this.entries = new Map();
    this.loaded = false;
  }

  load() {
    if (this.loaded) return this;
    this.loaded = true;
    if (!this.file || !existsSync(this.file)) return this;
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8"));
      for (const e of data.calls ?? []) this.entries.set(slot(e), e);
    } catch {
      // A damaged journal is ignored: every call can still be recovered from its hash.
    }
    return this;
  }

  /** The plaintext of a call, or null. */
  get({ chainId, callbook, bookId, callId }) {
    return this.load().entries.get(slot({ chainId, callbook, bookId, callId })) ?? null;
  }

  /** Remember a call ({ chainId, callbook, bookId, callId, coin, side, horizon, ... }). */
  put(entry) {
    this.load().entries.set(slot(entry), { ...entry, callbook: String(entry.callbook).toLowerCase() });
    this.save();
  }

  /** Forget calls that are revealed (the chain has them now). */
  forget(entries) {
    this.load();
    let changed = false;
    for (const e of entries) changed = this.entries.delete(slot(e)) || changed;
    if (changed) this.save();
  }

  save() {
    if (!this.file) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, calls: [...this.entries.values()] }, null, 2), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      // A read-only disk only costs a search at reveal time.
    }
  }
}

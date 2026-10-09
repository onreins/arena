/**
 * Gasless calls through Reins' relayer (app/callbook-routes.js):
 *
 *   POST {relayUrl}/api/callbook/relay/lock    { account, callHash, horizon, deadline, signature }  LockCall typed data
 *   POST {relayUrl}/api/callbook/relay/seal    { bookId, p, callHash, deadline, signature }         SealCall typed data
 *   POST {relayUrl}/api/callbook/relay/reveal  { kind: "seal", bookId, p, coinIndex, side, salt }
 *                                              { kind: "lock", bookId, callId, coinIndex, side, salt }
 *                                              { kind: "symbol", bookId, callId, coin, side, salt }
 *   POST {relayUrl}/api/callbook/relay/profile { account, bookId, name, bio, link, deadline, signature }  SetProfile typed data
 *   POST {relayUrl}/api/callbook/relay/unlink  { agent, signer, deadline, signature }                    UnlinkAgent typed data
 *   (a link is relayed by the page the person confirms it on: /arena/link)
 *
 * A lock's horizon is public (it's in the transaction and the Locked event) and
 * also inside the hash; reveals use the horizon stored at lock time.
 *
 * The relayer refuses, before spending gas: a signature that isn't exactly 65
 * bytes, a deadline less than 30 seconds (or more than 7 days) away, an
 * account with contract code (contract wallets pay their own gas through
 * lockBySig directly), and anything that fails a simulation.
 *
 * Numbers go as decimal strings. The relayer answers with the transaction hash
 * ({ txHash } or { hash } or { tx }); the SDK waits for the receipt itself and
 * reads the result from the chain, so it never has to trust the answer.
 * Signatures are EIP-712 over the domain { name: "Arena", version: "1" }.
 */
import { CallbookError } from "./errors.js";

export const LOCK_TYPES = {
  LockCall: [
    { name: "account", type: "address" },
    { name: "callHash", type: "bytes32" },
    { name: "horizon", type: "uint32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};
export const SEAL_TYPES = {
  SealCall: [
    { name: "bookId", type: "uint256" },
    { name: "p", type: "uint64" },
    { name: "callHash", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
};
export const PROFILE_TYPES = {
  SetProfile: [
    { name: "account", type: "address" },
    { name: "bookId", type: "uint256" },
    { name: "name", type: "string" },
    { name: "bio", type: "string" },
    { name: "link", type: "string" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};
export const LINK_TYPES = {
  LinkAgent: [
    { name: "agent", type: "address" },
    { name: "wallet", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};
export const UNLINK_TYPES = {
  UnlinkAgent: [
    { name: "agent", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};
export const domainOf = ({ chainId, callbook }) => ({ name: "Arena", version: "1", chainId, verifyingContract: callbook });

const RELAY_TIMEOUT_MS = 30_000;

const jsonable = (body) => JSON.parse(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

/** POST to the relayer; returns the transaction hash, or throws a sentence. */
export async function relay({ relayUrl, fetch: doFetch = globalThis.fetch }, what, body) {
  const url = `${relayUrl.replace(/\/$/, "")}/api/callbook/relay/${what}`;
  let res, data;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(jsonable(body)),
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
    data = await res.json().catch(() => ({}));
  } catch (err) {
    throw new CallbookError(`Can't reach the relayer at ${relayUrl} (${err.message}). Try again, or fund the key and send directly.`, "RelayDown");
  }
  if (res.status === 404 || res.status === 405) {
    throw new CallbookError(`The relayer at ${relayUrl} doesn't take ${what} requests (HTTP ${res.status}). Fund the key to send directly, or set another relay URL.`, "NoRelay");
  }
  if (!res.ok) {
    const why = data?.error ?? data?.message ?? `HTTP ${res.status}`;
    throw new CallbookError(`The relayer refused the ${what}: ${String(why).replace(/\.$/, "")}.`, "RelayRefused", { status: res.status });
  }
  const tx = data?.txHash ?? data?.hash ?? data?.tx;
  if (!/^0x[0-9a-fA-F]{64}$/.test(tx ?? "")) throw new CallbookError(`The relayer answered the ${what} without a transaction hash.`, "RelayBadAnswer");
  return tx;
}

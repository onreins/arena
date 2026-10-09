/**
 * The browser side of Callbook's cryptography, the same math as
 * callbook/proof.js and app/verify/callbook-callers.js: the any-coin call hash
 * (Callbook.symbolCallHashOf), the LockCall typed data the relayer checks, the
 * salt that hides a call, and recovering a call from its hash.
 *
 * Built into app/public/vendor/callbook-crypto.js (window.CallbookCrypto):
 *   npx esbuild app/client/callbook-crypto.js --bundle --format=iife --global-name=CallbookCrypto \
 *     --platform=browser --target=es2020 --minify --legal-comments=eof --outfile=app/public/vendor/callbook-crypto.js
 *
 * The salt. A browser has no key to derive salts from, so each call's salt
 * comes from a wallet signature over a fixed message naming the chain, the
 * contract, the account and the nonce the lock will use:
 *
 *   salt = keccak256(personal_sign(saltMessage({ chainId, callbook, account, nonce })))
 *
 * Wallets sign deterministically (RFC 6979), so signing the same message again
 * on any device gives the same salt, and the call can be recovered from its
 * hash by trying every coin, side and horizon. A wallet that doesn't sign
 * deterministically (some smart-contract wallets) can still lock, but only the
 * browser that kept the call can reveal it.
 */
import { keccak256, encodeAbiParameters, toHex, encodeFunctionData, decodeFunctionResult, getAddress } from "viem";

export const SYMBOL_TAG = keccak256(toHex("callbook.locked.symbol"));

const ABI = [
  { type: "function", name: "nonces", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "defaultBookOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  {
    type: "function", name: "lockedOf", stateMutability: "view",
    inputs: [{ name: "bookId", type: "uint256" }, { name: "callId", type: "uint64" }],
    outputs: [{
      type: "tuple", components: [
        { name: "callHash", type: "bytes32" }, { name: "lockedAt", type: "uint64" }, { name: "entryAt", type: "uint64" },
        { name: "horizon", type: "uint32" }, { name: "revealed", type: "bool" }, { name: "coinIndex", type: "uint8" },
        { name: "side", type: "int8" }, { name: "nonce", type: "uint64" },
      ],
    }],
  },
];

/** Callbook.symbolCallHashOf. */
export function symbolCallHash({ callbook, chainId, account, nonce, coin, side, horizon, salt }) {
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "address" }, { type: "uint64" }, { type: "bytes32" }, { type: "int8" }, { type: "uint32" }, { type: "bytes32" }],
    [SYMBOL_TAG, getAddress(callbook), BigInt(chainId), getAddress(account), BigInt(nonce), keccak256(toHex(coin)), side, horizon, salt],
  ));
}

/** The message whose signature makes a call's salt. Changing it changes every salt: it is versioned. */
export function saltMessage({ chainId, callbook, account, nonce }) {
  return [
    "Callbook: make the secret that hides call #" + String(nonce) + ".",
    "",
    "Signing is free and sends nothing. Sign the same message again on any device to reveal this call there.",
    "",
    "Version: callbook-salt-v1",
    "Chain: " + String(chainId),
    "Contract: " + String(callbook).toLowerCase(),
    "Account: " + String(account).toLowerCase(),
    "Nonce: " + String(nonce),
  ].join("\n");
}

export const saltFromSignature = (signature) => keccak256(signature);

/**
 * Everything a gasless lock signs, in one place: the call's hash and the
 * eth_signTypedData_v4 JSON for
 *   LockCall(address account,bytes32 callHash,uint32 horizon,uint256 nonce,uint256 deadline)
 * under the domain { name: "Arena", version: "1", chainId, verifyingContract }.
 * The horizon is sent in the clear (lockBySig's argument) and also bound in the hash.
 */
export function buildLock({ chainId, callbook, account, nonce, coin, side, horizon, salt, deadline }) {
  const callHash = symbolCallHash({ callbook, chainId, account, nonce, coin, side, horizon, salt });
  const typedData = {
    types: {
      EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }],
      LockCall: [
        { name: "account", type: "address" }, { name: "callHash", type: "bytes32" }, { name: "horizon", type: "uint32" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "LockCall",
    domain: { name: "Arena", version: "1", chainId: Number(chainId), verifyingContract: getAddress(callbook) },
    message: { account: getAddress(account), callHash, horizon: Number(horizon), nonce: String(nonce), deadline: String(deadline) },
  };
  return { callHash, typedData, body: { account: getAddress(account), callHash, horizon: Number(horizon), deadline: Number(deadline) } };
}

/** Calldata and decoders for the three reads the page makes through the wallet. */
export const calls = {
  nonces: (account) => encodeFunctionData({ abi: ABI, functionName: "nonces", args: [getAddress(account)] }),
  defaultBookOf: (account) => encodeFunctionData({ abi: ABI, functionName: "defaultBookOf", args: [getAddress(account)] }),
  lockedOf: (bookId, callId) => encodeFunctionData({ abi: ABI, functionName: "lockedOf", args: [BigInt(bookId), BigInt(callId)] }),
};
export function decode(functionName, data) {
  const out = decodeFunctionResult({ abi: ABI, functionName, data });
  if (functionName === "lockedOf") return { callHash: out.callHash, entryAt: Number(out.entryAt), horizon: Number(out.horizon), revealed: out.revealed, nonce: Number(out.nonce) };
  return Number(out);
}

/** The call behind an any-coin lock, by trying every coin, side and horizon: { coin, side, horizon } or null. */
export function recoverSymbolCall({ hash, callbook, chainId, account, nonce, salt, coins, horizons, sides = [1, -1] }) {
  // Locks now carry their horizon in the clear, so usually there is just one to try.
  const want = String(hash).toLowerCase();
  for (const horizon of horizons) {
    for (const coin of coins) {
      for (const side of sides) {
        if (symbolCallHash({ callbook, chainId, account, nonce, coin, side, horizon, salt }) === want) return { coin, side, horizon };
      }
    }
  }
  return null;
}

export { getAddress };

// Stop and target, sealed in the salt exactly as the SDK and the scorer read them.
export { withExits, exitsProblem, sealedPrice, MAX_EXIT_HOLD } from "../verify/callbook-exits.js";

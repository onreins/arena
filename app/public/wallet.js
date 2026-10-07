/**
 * The one path to the user's wallet. Pages ask the server for calldata and
 * hand it here to be signed; nothing in this file ever sees a key.
 */
window.ReinsWallet = (function () {
  "use strict";
  var eth = window.ethereum;
  var cfg = null;
  var account = null;

  async function config() {
    if (!cfg) cfg = await (await fetch("/api/config")).json();
    return cfg;
  }

  async function connect() {
    if (!eth) throw new Error("No wallet found. Install a browser wallet, then reload.");
    var accounts = await eth.request({ method: "eth_requestAccounts" });
    account = accounts[0];
    return account;
  }

  async function ensureChain() {
    var c = await config();
    var hex = "0x" + c.chainId.toString(16);
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    } catch (err) {
      if (!err || err.code !== 4902) throw err;
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: hex,
          chainName: "Arc " + (c.network === "testnet" ? "Testnet" : "Mainnet"),
          nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
          rpcUrls: [c.network === "testnet" ? "https://rpc.testnet.arc.network" : "https://rpc.mainnet.arc.io"],
          blockExplorerUrls: [c.explorer],
        }],
      });
    }
  }

  async function post(path, body) {
    var res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    var out = await res.json();
    if (!res.ok) throw new Error(out.error || "the server refused that");
    return out;
  }

  function send(tx) {
    return eth.request({ method: "eth_sendTransaction", params: [{ from: account, to: tx.to, data: tx.data }] });
  }

  function explain(err) {
    if (err && err.code === 4001) return "You declined in the wallet, so nothing was sent.";
    return (err && (err.shortMessage || err.message)) || "Something went wrong.";
  }

  return {
    config: config,
    connect: connect,
    ensureChain: ensureChain,
    post: post,
    send: send,
    explain: explain,
    get account() { return account; },
    get available() { return !!eth; },
  };
})();

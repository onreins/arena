/**
 * Sign in, for the whole site: browser wallets (every one the browser
 * announces through EIP-6963, else window.ethereum) and Google (a Circle wallet
 * on Arc, see circle-auth.js). One session per browser, in localStorage:
 * { kind: "injected" | "google", address, label, rdns } and never a key.
 *
 * ui.js loads this file and draws the top-bar button; this file draws the
 * sign-in panel and the account menu.
 *
 *   ReinsAuth.open()            the sign-in panel; resolves with the address, rejects if closed
 *   ReinsAuth.session()         the current session, or null
 *   ReinsAuth.signTypedData(t)  EIP-712 signature from whichever wallet is signed in
 *   ReinsAuth.signOut()
 *   ReinsAuth.onChange(fn)      fn(session or null) after every sign-in, sign-out and account switch
 */
window.ReinsAuth = (function () {
  "use strict";
  var U = window.ReinsUI, W = window.ReinsWallet, esc = U.esc;
  var KEY = "reins.session.v1";
  var ADDR = /^0x[0-9a-fA-F]{40}$/;
  var found = new Map(); // rdns -> { info, provider }
  var listeners = [];
  var googleCfg = null;

  // ---------------------------------------------------------------- wallets
  window.addEventListener("eip6963:announceProvider", function (e) {
    var d = e.detail;
    if (!d || !d.info || !d.provider || typeof d.provider.request !== "function") return;
    found.set(String(d.info.rdns || d.info.uuid), d);
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  /** Installed wallets, each { id, name, icon, provider }. The browser default when none announce. */
  function wallets() {
    var list = [];
    found.forEach(function (d, id) {
      // Wallets announce their own icon; only an image data: URI is drawn.
      var icon = typeof d.info.icon === "string" && /^data:image\/(png|svg\+xml|webp|jpeg);/.test(d.info.icon) ? d.info.icon : null;
      list.push({ id: id, name: String(d.info.name || "Wallet").slice(0, 40), icon: icon, provider: d.provider });
    });
    if (!list.length && window.ethereum) list.push({ id: "injected", name: "Browser wallet", icon: null, provider: window.ethereum });
    return list;
  }
  var walletById = function (id) { return wallets().filter(function (w) { return w.id === id; })[0] || null; };

  // ---------------------------------------------------------------- session
  function session() {
    try {
      var s = JSON.parse(localStorage.getItem(KEY) || "null");
      return s && ADDR.test(s.address || "") && (s.kind === "injected" || s.kind === "google") ? s : null;
    } catch (e) { return null; }
  }
  function save(s) {
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* storage off: this tab only */ }
    if (s.kind === "google") W.useGoogle(s.address);
    changed(s);
  }
  function changed(s) { listeners.forEach(function (fn) { try { fn(s); } catch (e) { /* a page's listener */ } }); }
  function signOut() {
    try { localStorage.removeItem(KEY); } catch (e) { /* storage off */ }
    if (window.ReinsCircle) window.ReinsCircle.forget();
    W.use(null, null);
    changed(null);
  }

  async function connectWith(id) {
    var w = walletById(id);
    if (!w) throw new Error("That wallet isn't available any more. Reload and try again.");
    var accts = await w.provider.request({ method: "eth_requestAccounts" });
    var a = accts && accts[0];
    if (!ADDR.test(a || "")) throw new Error("The wallet didn't share an address.");
    W.use(w.provider, a);
    watch(w.provider, w.id);
    save({ kind: "injected", address: a.toLowerCase(), label: w.name, rdns: w.id });
    return a.toLowerCase();
  }

  // Follow account switches in the wallet; a disconnect signs out.
  var watched = new Set();
  function watch(provider, id) {
    if (!provider || !provider.on || watched.has(provider)) return;
    watched.add(provider);
    provider.on("accountsChanged", function (accts) {
      var s = session();
      if (!s || s.kind !== "injected" || s.rdns !== id) return;
      if (!accts || !accts[0]) { signOut(); return; }
      W.use(provider, accts[0]);
      save({ kind: "injected", address: accts[0].toLowerCase(), label: s.label, rdns: s.rdns });
    });
  }

  /** On load: pick the saved session back up, silently (eth_accounts never prompts). */
  async function restore() {
    var s = session();
    if (!s) return null;
    if (s.kind === "google") { W.useGoogle(s.address); return s; }
    await new Promise(function (r) { setTimeout(r, 60); }); // let wallets announce themselves
    var w = walletById(s.rdns) || wallets()[0];
    if (!w) return s;
    try {
      var accts = await w.provider.request({ method: "eth_accounts" });
      if (accts && accts[0]) {
        W.use(w.provider, accts[0]);
        watch(w.provider, w.id);
        if (accts[0].toLowerCase() !== s.address) { s = { kind: "injected", address: accts[0].toLowerCase(), label: s.label, rdns: w.id }; save(s); }
      }
    } catch (e) { /* the wallet is locked: the session still names the address */ }
    return s;
  }

  /**
   * Wallets refuse to sign typed data for a chain other than the one they're on
   * (MetaMask: "Provided chainId must match the active chainId"), so switch first,
   * adding Arc when the wallet doesn't know it.
   */
  async function onChain(provider, chainId) {
    if (!chainId) return;
    var hex = "0x" + chainId.toString(16);
    var current = await provider.request({ method: "eth_chainId" }).catch(function () { return null; });
    if (current && parseInt(current, 16) === chainId) return;
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    } catch (err) {
      if (!err || (err.code !== 4902 && !(err.data && err.data.originalError && err.data.originalError.code === 4902))) throw err;
      var testnet = chainId === 5042002;
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: hex, chainName: testnet ? "Arc Testnet" : "Arc", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
          rpcUrls: [testnet ? "https://rpc.testnet.arc.network" : "https://rpc.mainnet.arc.io"],
          blockExplorerUrls: [testnet ? "https://explorer.testnet.arc.io" : "https://explorer.arc.io"],
        }],
      });
    }
  }

  /** An EIP-712 signature from the signed-in wallet. */
  async function signTypedData(typed) {
    var s = session();
    if (!s) throw new Error("Sign in first.");
    if (s.kind === "google") {
      await loadCircle();
      if (!window.ReinsCircle.hasLogin()) {
        toast("Signing you in with Google again, then you can confirm.");
        await google();
      }
      return window.ReinsCircle.signTypedData(s, typed);
    }
    var w = walletById(s.rdns) || wallets()[0];
    if (!w) throw new Error("Your wallet isn't available in this browser. Sign in again.");
    var accts = await w.provider.request({ method: "eth_requestAccounts" });
    if (!accts || (accts[0] || "").toLowerCase() !== s.address) throw new Error("Your wallet is on another account. Switch to " + U.short(s.address) + " and try again.");
    await onChain(w.provider, Number(typed.domain && typed.domain.chainId));
    return w.provider.request({ method: "eth_signTypedData_v4", params: [s.address, JSON.stringify(typed)] });
  }

  // ---------------------------------------------------------------- Google (Circle wallets)
  function authConfig() {
    googleCfg = googleCfg || fetch("/api/auth/config").then(function (r) { return r.ok ? r.json() : { google: false }; }).catch(function () { return { google: false }; });
    return googleCfg;
  }
  function loadCircle() {
    if (window.ReinsCircle) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = "/circle-auth.js";
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error("Google sign-in couldn't load. Try again.")); };
      document.head.appendChild(s);
    });
  }
  async function google() {
    await loadCircle();
    var r = await window.ReinsCircle.signIn(await authConfig());
    if (!r) return new Promise(function () {}); // the page is off to Google and back
    save({ kind: "google", address: r.address.toLowerCase(), label: "Google", rdns: "google", walletId: r.walletId });
    return r.address.toLowerCase();
  }
  // Google's sign-in comes back to this page; finish it on load.
  try {
    if (sessionStorage.getItem("reins.circle.pending")) {
      loadCircle().then(function () { return window.ReinsCircle.resume(); }).then(function (r) {
        if (r) save({ kind: "google", address: r.address.toLowerCase(), label: "Google", rdns: "google", walletId: r.walletId });
      }).catch(function (err) { toast(W.explain(err)); });
    }
  } catch (e) { /* storage off */ }

  // ---------------------------------------------------------------- the panel
  var G_ICON = '<svg viewBox="0 0 48 48" width="20" height="20" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';
  var open_ = null;
  var closed = function () { var e = new Error("Sign in to continue."); e.code = "closed"; return e; };

  /** The sign-in panel. Resolves with the address once signed in; rejects when closed. */
  function open() {
    if (open_) return open_.promise;
    var resolve, reject;
    var promise = new Promise(function (a, b) { resolve = a; reject = b; });
    var back = document.createElement("div");
    back.className = "auth-back";
    back.innerHTML =
      '<div class="auth-panel" role="dialog" aria-modal="true" aria-labelledby="auth-h">' +
        '<button class="auth-x" type="button" aria-label="Close">' + U.icon("x") + "</button>" +
        '<div class="auth-mark">' + U.MARK + "</div>" +
        '<h2 id="auth-h">Sign in to Reins</h2>' +
        "<p>Your profile, your agents and your records, in one place.</p>" +
        '<div class="auth-google" id="auth-google" hidden>' +
          '<button class="auth-opt auth-g" type="button" data-google>' + G_ICON + "<span><b>Continue with Google</b><small>A wallet on Arc, made for you. No extension, no gas.</small></span></button>" +
          '<div class="auth-or"><span>or a wallet you have</span></div>' +
        "</div>" +
        '<div class="auth-list" id="auth-list"></div>' +
        '<p class="auth-err" id="auth-err" role="alert" hidden></p>' +
        '<p class="auth-foot">We never see your keys. Signing in sends nothing and costs nothing.</p>' +
      "</div>";
    document.body.appendChild(back);
    document.body.classList.add("auth-on");
    var panel = back.querySelector(".auth-panel"), list = back.querySelector("#auth-list"), err = back.querySelector("#auth-err");
    var before = document.activeElement;

    function draw() {
      var ws = wallets();
      list.innerHTML = ws.length ? ws.map(function (w) {
        return '<button class="auth-opt" type="button" data-id="' + esc(w.id) + '">' +
          (w.icon ? '<img src="' + esc(w.icon) + '" alt="" width="28" height="28">' : '<span class="auth-ic">' + U.icon("wallet") + "</span>") +
          "<span><b>" + esc(w.name) + "</b><small>" + (w.id === "injected" ? "The wallet in this browser" : "Installed") + "</small></span>" + U.icon("right") + "</button>";
      }).join("") : '<div class="auth-none"><b>No wallet in this browser</b><span>Install <a href="https://metamask.io/download/" target="_blank" rel="noopener">MetaMask</a> or <a href="https://rabby.io" target="_blank" rel="noopener">Rabby</a>, then reload' +
        "</span></div>";
    }
    draw();
    var redraw = setTimeout(draw, 250); // late announcers
    authConfig().then(function (c) { back.querySelector("#auth-google").hidden = !c.google; });

    function close(reason) {
      clearTimeout(redraw);
      document.removeEventListener("keydown", onKey, true);
      back.remove();
      document.body.classList.remove("auth-on");
      open_ = null;
      if (before && before.focus) before.focus();
      if (reason instanceof Error) reject(reason);
    }
    function busy(btn, on) {
      Array.prototype.forEach.call(panel.querySelectorAll("button.auth-opt"), function (b) { b.disabled = on; });
      if (btn) btn.classList.toggle("wait", on);
    }
    panel.addEventListener("click", async function (e) {
      var b = e.target.closest("button");
      if (!b) return;
      if (b.classList.contains("auth-x")) { close(closed()); return; }
      err.hidden = true;
      busy(b, true);
      try {
        var a = b.hasAttribute("data-google") ? await google() : await connectWith(b.getAttribute("data-id"));
        close();
        resolve(a);
      } catch (ex) {
        busy(b, false);
        err.textContent = W.explain(ex);
        err.hidden = false;
      }
    });
    back.addEventListener("mousedown", function (e) { if (e.target === back) close(closed()); });
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); close(closed()); return; }
      if (e.key !== "Tab") return;
      var f = Array.prototype.filter.call(panel.querySelectorAll("button:not([disabled]), a[href]"), function (x) { return x.offsetParent !== null; });
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
    document.addEventListener("keydown", onKey, true);
    setTimeout(function () { var first = panel.querySelector(".auth-opt") || panel.querySelector(".auth-x"); if (first) first.focus(); }, 30);
    open_ = { promise: promise };
    return promise;
  }

  // ---------------------------------------------------------------- the account menu
  function menu(anchor) {
    var s = session();
    if (!s) return open();
    var old = document.querySelector(".auth-menu");
    if (old) { old.remove(); anchor.setAttribute("aria-expanded", "false"); return; }
    var m = document.createElement("div");
    m.className = "auth-menu";
    m.setAttribute("role", "menu");
    m.innerHTML =
      '<div class="auth-who">' + U.identicon(s.address, 36) + "<span><b>" + esc(U.short(s.address)) + "</b><small>" + esc(s.kind === "google" ? "Signed in with Google" : s.label || "Browser wallet") + "</small></span></div>" +
      '<a role="menuitem" href="/arena/p/' + esc(s.address) + '">' + U.icon("user") + "My Arena profile</a>" +
      '<button role="menuitem" type="button" data-act="copy">' + U.icon("copy") + "<span>Copy address</span></button>" +
      '<button role="menuitem" type="button" data-act="out">' + U.icon("logout") + "Sign out</button>";
    document.body.appendChild(m);
    var r = anchor.getBoundingClientRect();
    m.style.top = Math.round(r.bottom + 8 + window.scrollY) + "px";
    m.style.right = Math.round(document.documentElement.clientWidth - r.right) + "px";
    anchor.setAttribute("aria-expanded", "true");
    var items = m.querySelectorAll("[role=menuitem]");
    items[0].focus();
    function shut() {
      m.remove();
      anchor.setAttribute("aria-expanded", "false");
      document.removeEventListener("mousedown", away, true);
      document.removeEventListener("keydown", keys, true);
    }
    function away(e) { if (!m.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) shut(); }
    function keys(e) {
      var i = Array.prototype.indexOf.call(items, document.activeElement);
      if (e.key === "Escape") { shut(); anchor.focus(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    }
    document.addEventListener("mousedown", away, true);
    document.addEventListener("keydown", keys, true);
    m.addEventListener("click", function (e) {
      var b = e.target.closest("[data-act]");
      if (!b) return;
      if (b.getAttribute("data-act") === "copy") {
        (navigator.clipboard ? navigator.clipboard.writeText(s.address) : Promise.reject()).then(function () {
          b.querySelector("span").textContent = "Copied";
        }).catch(function () { b.querySelector("span").textContent = s.address; });
        return;
      }
      shut();
      signOut();
    });
  }

  function toast(text) {
    var t = document.createElement("div");
    t.className = "auth-toast";
    t.setAttribute("role", "status");
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 6000);
  }

  window.addEventListener("storage", function (e) { if (e.key === KEY) changed(session()); });

  return {
    open: open, menu: menu, session: session, restore: restore, signOut: signOut, signTypedData: signTypedData, wallets: wallets, onChain: onChain,
    onChange: function (fn) { listeners.push(fn); },
  };
})();

/* Lock a call from the Arena tab: coin, long or short, how long, and
 * optionally a stop and a target price, sealed in the salt
 * (app/verify/callbook-exits.js). A call with them is revealed only from the
 * browser that kept it: its prices can't be searched for.
 *
 * The flow (live mode only): connect the wallet, read the account's nonce from
 * the Arena contract, sign a fixed message to make the salt (see
 * app/client/callbook-crypto.js for why that's recoverable), hash the call
 * exactly as Callbook.symbolCallHashOf, sign LockCall (EIP-712, with the
 * horizon in the clear), and hand both to POST /api/callbook/relay/lock, which
 * pays the gas. Both come from CallbookCrypto.buildLock, the one place that
 * knows the hash and the typed data.
 *
 * Each lock is kept in this browser (localStorage "callbook.locks.v1", salt
 * included, so reveals need no signature); when a call matures, the next
 * visit reveals it through POST /api/callbook/relay/reveal. If the browser
 * forgot, "Reveal calls locked on another device" signs the salt message again
 * and finds each call by trying every coin and side against its hash (the
 * horizon is on chain in the clear).
 *
 * Outside live mode (a replay, sample data) the form is a preview: nothing is
 * signed or sent. */
(function () {
  "use strict";
  var U = window.ReinsUI, C = window.Callbook, K = window.CallbookCrypto, esc = U.esc;
  var $ = function (id) { return document.getElementById(id); };
  if (!$("lock")) return;

  var STORE = "callbook.locks.v1", COIN_KEY = "callbook.coin";
  var GRACE = 7 * 86400, LEAD = 60, UNIT = 60;
  var FALLBACK = ["BTC", "ETH", "SOL", "HYPE", "XRP", "DOGE", "SUI", "BNB", "LINK", "AVAX", "AAVE", "ENA", "LTC", "ADA", "TRX", "kPEPE"];
  // Horizons the recovery tries when a lock's own horizon can't be read: this form's four first, then the SDK's common ones.
  var HORIZONS = [3600, 14400, 86400, 604800, 300, 900, 1800, 7200, 21600, 28800, 43200, 172800, 259200, 1209600, 2592000];

  var get = function (k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } };
  var put = function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage off: the call can still be recovered */ } };
  var st = { coin: get(COIN_KEY, "BTC"), side: 1, horizon: 86400, markets: FALLBACK.map(function (n) { return { name: n }; }), busy: false };
  var D = null;

  $("ic-down").innerHTML = U.icon("down");

  // ------------------------------------------------------------- the form
  var utc = function (t, withDay) {
    var d = new Date(t * 1000), hm = d.toISOString().slice(11, 16);
    return withDay ? d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }) + ", " + hm + " UTC" : hm + " UTC";
  };
  var entryAt = function () { var t = Math.floor(Date.now() / 1000); return Math.ceil((t + LEAD) / UNIT) * UNIT; };
  function preview() {
    var e = entryAt(), r = e + st.horizon, long = st.horizon >= 86400, x = exitsIn();
    var levels = [x.stop ? "stop <b>" + esc(x.stop) + "</b>" : "", x.target ? "target <b>" + esc(x.target) + "</b>" : ""].filter(Boolean).join(" or ");
    $("lock-prev").innerHTML = "Entry <b>" + esc(utc(e)) + "</b> · " + (levels && !exitsProblem() ? "closes at " + levels + ", or by <b>" + esc(utc(r, long)) + "</b>" :
      "reveals <b>" + esc(utc(r, long)) + "</b>") + " · hidden until then";
  }
  function pick(group, attr, value) {
    Array.prototype.forEach.call($(group).querySelectorAll("button"), function (b) { b.setAttribute("aria-pressed", String(b.getAttribute(attr) === String(value))); });
  }
  $("dir").addEventListener("click", function (e) { var b = e.target.closest("button"); if (!b) return; st.side = +b.getAttribute("data-side"); pick("dir", "data-side", st.side); exitsChanged(); });
  $("hz").addEventListener("click", function (e) { var b = e.target.closest("button"); if (!b) return; st.horizon = +b.getAttribute("data-h"); pick("hz", "data-h", st.horizon); exitsChanged(); });

  // ------------------------------------------------------------- stop and target
  // Optional prices, sealed in the call's salt (CallbookCrypto.withExits), checked like the SDK checks an agent's.
  var EXITS_NOTE = $("ex-note").textContent;
  var pxOf = function () { var m = st.markets.filter(function (x) { return x.name === st.coin; })[0]; return m && m.px > 0 ? m.px : null; };
  function exitsIn() {
    var v = function (id) { var s = $(id).value.trim().replace(/[$,\s]/g, ""); return s || null; };
    return { stop: v("ex-stop"), target: v("ex-target") };
  }
  /** Why the stop and target can't be used, or null (including when there are none). */
  function exitsProblem() {
    var x = exitsIn();
    if (!x.stop && !x.target) return null;
    try {
      if (x.stop) K.sealedPrice(x.stop);
      if (x.target) K.sealedPrice(x.target);
    } catch (err) {
      return "Write prices as plain numbers, like 82000 or 0.0042.";
    }
    return K.exitsProblem({ side: st.side, stop: x.stop, target: x.target, price: pxOf(), horizon: st.horizon, coin: st.coin });
  }
  // Suggested levels a few percent either side of the price: a starting point, never filled in for you.
  var round4 = function (n) { return String(Number(n.toPrecision(4))); };
  function exitHints() {
    var px = pxOf(), up = st.side > 0;
    $("ex-stop").placeholder = px ? "e.g. " + round4(px * (up ? 0.97 : 1.03)) : "e.g. a price " + (up ? "below" : "above") + " now";
    $("ex-target").placeholder = px ? "e.g. " + round4(px * (up ? 1.05 : 0.95)) : "e.g. a price " + (up ? "above" : "below") + " now";
  }
  function exitsChanged() {
    var problem = exitsProblem();
    $("ex-note").textContent = problem || EXITS_NOTE;
    $("ex-note").classList.toggle("bad", !!problem);
    exitHints();
    preview();
  }
  $("ex-stop").addEventListener("input", exitsChanged);
  $("ex-target").addEventListener("input", exitsChanged);
  preview();
  setInterval(preview, 15000);

  // ------------------------------------------------------------- the coin
  var fmtPx = function (x) { return !C.isNum(x) ? "" : x >= 1000 ? x.toLocaleString("en-US", { maximumFractionDigits: 0 }) : x >= 1 ? x.toFixed(2) : x.toPrecision(3); };
  function setCoin(name) {
    st.coin = name;
    put(COIN_KEY, name);
    var m = st.markets.filter(function (x) { return x.name === name; })[0] || {};
    $("coin-sym").textContent = name;
    $("coin-px").textContent = m.px ? "$" + fmtPx(m.px) : "";
    exitsChanged();
  }
  function listCoins() {
    var q = $("coin-q").value.trim().toLowerCase();
    var rows = st.markets.filter(function (m) { return !q || m.name.toLowerCase().indexOf(q) >= 0; }).slice(0, 60);
    $("coin-list").innerHTML = rows.length ? rows.map(function (m, i) {
      var chg = C.isNum(m.chg) ? '<span class="' + U.dirOf(m.chg * 100) + '">' + C.pct(m.chg, 1) + "</span>" : "";
      return '<li role="option" id="coin-o' + i + '" data-c="' + esc(m.name) + '" aria-selected="' + String(m.name === st.coin) + '" tabindex="-1">' +
        "<b>" + esc(m.name) + '</b><span class="mono">' + (m.px ? "$" + esc(fmtPx(m.px)) : "") + "</span>" + chg + "</li>";
    }).join("") : '<li class="none">No coin called “' + esc(q) + '”</li>';
  }
  function openCoins(open) {
    $("coin-pop").hidden = !open;
    $("coin-btn").setAttribute("aria-expanded", String(open));
    if (open) { $("coin-q").value = ""; listCoins(); $("coin-q").focus(); }
  }
  function chooseCoin(li) { if (!li || !li.getAttribute("data-c")) return; setCoin(li.getAttribute("data-c")); openCoins(false); $("coin-btn").focus(); }
  $("coin-btn").addEventListener("click", function () { openCoins($("coin-pop").hidden); });
  $("coin-q").addEventListener("input", listCoins);
  $("coin-list").addEventListener("click", function (e) { chooseCoin(e.target.closest("li")); });
  $("coin-pop").addEventListener("keydown", function (e) {
    var items = Array.prototype.slice.call($("coin-list").querySelectorAll("li[data-c]")), i = items.indexOf(document.activeElement);
    if (e.key === "Escape") { openCoins(false); $("coin-btn").focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); (items[i + 1] || items[0]) && (items[i + 1] || items[0]).focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); if (i <= 0) $("coin-q").focus(); else items[i - 1].focus(); }
    else if (e.key === "Enter") { e.preventDefault(); chooseCoin(i >= 0 ? items[i] : items[0]); }
  });
  document.addEventListener("click", function (e) { if (!$("coin-pop").hidden && !e.target.closest(".cb-coin")) openCoins(false); });

  // Hyperliquid's perps, most traded first, from its public info API.
  fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"type":"metaAndAssetCtxs"}' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d || !d[0] || !d[1]) return;
      var list = d[0].universe.map(function (u, i) {
        var c = d[1][i] || {}, px = +c.markPx, prev = +c.prevDayPx;
        return { name: u.name, px: px, chg: prev ? px / prev - 1 : null, vol: +c.dayNtlVlm || 0, gone: u.isDelisted };
      }).filter(function (m) { return !m.gone && m.name && new TextEncoder().encode(m.name).length <= 16; });
      list.sort(function (a, b) { return b.vol - a.vol; });
      if (list.length) st.markets = list;
      if (!st.markets.some(function (m) { return m.name === st.coin; })) st.coin = "BTC";
      setCoin(st.coin);
    })
    .catch(function () { /* the short list stays; any coin can still be typed into the hash */ });
  setCoin(st.coin);

  // ------------------------------------------------------------- messages
  function say(html, tone) {
    var m = $("lock-msg");
    m.hidden = !html;
    m.className = "cb-lock-msg" + (tone ? " " + tone : "");
    m.innerHTML = html || "";
  }
  var toastEl = null, toastTimer = null;
  function toast(text, keep) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "cb-toast";
      toastEl.setAttribute("role", "status");
      toastEl.setAttribute("aria-live", "polite");
      document.body.appendChild(toastEl);
    }
    clearTimeout(toastTimer);
    toastEl.textContent = text;
    toastEl.hidden = !text;
    if (text && !keep) toastTimer = setTimeout(function () { toastEl.hidden = true; }, 5000);
  }
  function busy(on, label) {
    st.busy = on;
    $("lock-btn").disabled = on;
    $("lock-btn").textContent = on ? label || "Working…" : "Lock call to my record";
  }

  // ------------------------------------------------------------- storage
  function locks() { try { return JSON.parse(get(STORE, "[]")) || []; } catch (e) { return []; } }
  function saveLocks(list) {
    var now = Date.now() / 1000;
    put(STORE, JSON.stringify(list.filter(function (l) { return !l.revealed || now - (l.entryAt + l.horizon) < 30 * 86400; })));
  }
  function remember(entry) {
    var list = locks().filter(function (l) { return !(l.chainId === entry.chainId && l.callbook === entry.callbook && l.bookId === entry.bookId && l.callId === entry.callId); });
    list.push(entry);
    saveLocks(list);
  }
  var here = function (l) { return D && l.chainId === Number(D.chainId) && l.callbook === String(D.contract).toLowerCase(); };
  function showMine() {
    var mine = locks().filter(here);
    if (!mine.length) return;
    $("lock-mine").hidden = false;
    $("lock-mine").href = "/arena-caller?c=" + encodeURIComponent(mine[mine.length - 1].bookId);
  }

  // ------------------------------------------------------------- the wallet
  var eth = function () { return window.ethereum; };
  var req = function (method, params) { return eth().request({ method: method, params: params || [] }); };
  function utf8Hex(s) {
    var b = new TextEncoder().encode(s), h = "0x";
    for (var i = 0; i < b.length; i++) h += (b[i] < 16 ? "0" : "") + b[i].toString(16);
    return h;
  }
  /**
   * Put the wallet on Arena's chain, adding Arc (testnet or mainnet) when it
   * doesn't know it: sign-in's switch (auth.js, loaded on every page by ui.js).
   */
  async function onChain() {
    var want = Number(D.chainId);
    if (parseInt(await req("eth_chainId"), 16) === want) return;
    try {
      if (window.ReinsAuth && window.ReinsAuth.onChain) return await window.ReinsAuth.onChain(eth(), want);
      await req("wallet_switchEthereumChain", [{ chainId: "0x" + want.toString(16) }]);
    } catch (err) {
      if (err && err.code === 4001) throw err;
      throw new Error("Switch your wallet to " + (D.network || "chain " + want) + ", then try again.");
    }
  }
  var view = async function (fn, args) { return K.decode(fn, await req("eth_call", [{ to: D.contract, data: K.calls[fn].apply(null, args) }, "latest"])); };
  async function saltFor(account, nonce) {
    var msg = K.saltMessage({ chainId: D.chainId, callbook: D.contract, account: account, nonce: nonce });
    return K.saltFromSignature(await req("personal_sign", [utf8Hex(msg), account]));
  }
  async function post(path, body) {
    var res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    var out = null;
    try { out = await res.json(); } catch (e) { /* not json */ }
    return { status: res.status, ok: res.ok, body: out || {} };
  }
  var NOT_LIVE = "Locking opens when Arena is live on Arc. This is a preview: nothing was signed or sent.";
  function explain(err) {
    if (err && err.code === 4001) return "You declined in your wallet, so nothing was locked.";
    return esc((err && (err.shortMessage || err.message)) || "Something went wrong. Nothing was locked.");
  }

  // ------------------------------------------------------------- lock
  async function lock() {
    if (st.busy) return;
    var problem = exitsProblem(), x = exitsIn();
    if (problem) { $("exits").open = true; return say(esc(problem), "bad"); }
    if (!D || D.mode !== "live") return say(NOT_LIVE, "calm");
    // Locking signs with a browser wallet; a Google account (a Circle wallet) covers your profile and linking, not this yet.
    var who = window.ReinsAuth && window.ReinsAuth.session && window.ReinsAuth.session();
    if (who && who.kind === "google") return say("Locking a call needs a browser wallet, such as MetaMask or Rabby, for now. Your Google sign-in covers your profile and linking an agent.", "calm");
    if (!eth()) return say("To lock a call you need a browser wallet, such as MetaMask or Rabby.", "calm");
    var call = { coin: st.coin, side: st.side, horizon: st.horizon };
    var exits = x.stop || x.target ? { stop: x.stop && K.sealedPrice(x.stop), target: x.target && K.sealedPrice(x.target) } : null;
    try {
      say("");
      busy(true, "Connecting…");
      var account = String((await req("eth_requestAccounts"))[0] || "").toLowerCase();
      await onChain();
      var nonce = await view("nonces", [account]);
      busy(true, "Sign 1 of 2…");
      say("Sign the first message to make the secret that hides your call. It’s free and sends nothing.");
      // The stop and target ride in the salt: fixed now, hidden until the reveal.
      var salt = exits ? K.withExits(await saltFor(account, nonce), exits) : await saltFor(account, nonce);
      var lockReq = K.buildLock({ chainId: D.chainId, callbook: D.contract, account: account, nonce: nonce, coin: call.coin, side: call.side, horizon: call.horizon, salt: salt,
        deadline: Math.floor(Date.now() / 1000) + 600 });
      busy(true, "Sign 2 of 2…");
      say("Now approve the lock. Reins sends it and pays the gas.");
      var signature = await req("eth_signTypedData_v4", [account, JSON.stringify(lockReq.typedData)]);
      busy(true, "Locking…");
      say("Locking your call…");
      var r = await post("/api/callbook/relay/lock", Object.assign({}, lockReq.body, { signature: signature }));
      if (r.status === 503) return say(NOT_LIVE.replace(" This is a preview: nothing was signed or sent.", " Nothing was locked."), "calm");
      if (!r.ok) return say("Couldn’t lock that call: " + esc(r.body.error || "the relay said no") + ". Nothing was locked.", "bad");
      var e = Number(r.body.entryAt) || entryAt();
      remember({ chainId: Number(D.chainId), callbook: String(D.contract).toLowerCase(), account: account, bookId: String(r.body.bookId), callId: Number(r.body.callId),
        nonce: Number(r.body.nonce != null ? r.body.nonce : nonce), coin: call.coin, side: call.side, horizon: call.horizon, salt: salt, entryAt: e, lockedAt: Math.floor(Date.now() / 1000), revealed: false,
        exits: exits });
      var href = "/arena-caller?c=" + encodeURIComponent(r.body.bookId);
      var levels = exits ? [exits.stop ? "stop " + exits.stop : "", exits.target ? "target " + exits.target : ""].filter(Boolean).join(", ") : "";
      say("<b>Locked ✓</b> " + esc(call.coin) + " " + (call.side > 0 ? "long" : "short") + (levels ? " with " + esc(levels) : "") +
        ", reveals " + esc(utc(e + call.horizon, call.horizon >= 86400)) + '. <a href="' + esc(href) + '">See your record →</a>' +
        (exits ? "<br><small>Note its stop and target: this browser keeps them to reveal it. On another device, type them in above and use “Reveal calls locked on another device”.</small>" : ""), "ok");
      showMine();
      schedule();
    } catch (err) {
      say(explain(err), "bad");
    } finally {
      busy(false);
    }
  }
  $("lock-btn").addEventListener("click", lock);

  // ------------------------------------------------------------- reveal
  var now = function () { return Math.floor(Date.now() / 1000); };
  var due = function (l) { var t = l.entryAt + l.horizon; return !l.revealed && now() >= t + 15 && now() <= t + GRACE; };
  var revealing = false, timer = null;
  async function revealDue() {
    if (revealing || !D || D.mode !== "live") return;
    var list = locks().filter(function (l) { return here(l) && due(l); });
    if (!list.length) return schedule();
    revealing = true;
    toast("Revealing " + list.length + (list.length === 1 ? " call…" : " calls…"), true);
    var done = 0;
    try {
      for (var i = 0; i < list.length; i++) {
        var l = list[i], r;
        try {
          r = await post("/api/callbook/relay/reveal", { kind: "symbol", bookId: l.bookId, callId: l.callId, coin: l.coin, side: l.side, salt: l.salt });
        } catch (e) {
          continue; // offline or the server is down: this one waits for the next try
        }
        if (r.status === 503) break;
        if (r.ok || /AlreadyRevealed/.test((r.body && r.body.error) || "")) {
          done++;
          remember(Object.assign({}, l, { revealed: true }));
        }
      }
    } finally {
      revealing = false;
    }
    toast(done ? "Revealed " + done + (done === 1 ? " call ✓" : " calls ✓") : list.length ? "Couldn’t reveal yet. This page tries again on your next visit." : "");
    schedule();
  }
  // While the page stays open, reveal the next call when it matures.
  function schedule() {
    clearTimeout(timer);
    var next = locks().filter(function (l) { return here(l) && !l.revealed; }).map(function (l) { return l.entryAt + l.horizon + 20; })
      .filter(function (t) { return t > now(); }).sort(function (a, b) { return a - b; })[0];
    if (next && next - now() < 12 * 3600) timer = setTimeout(revealDue, (next - now()) * 1000);
  }

  // Recover calls this browser forgot: sign each salt again, then search.
  async function recover() {
    if (!D || D.mode !== "live") return say(NOT_LIVE, "calm");
    if (!eth()) return say("Connect the wallet that locked the calls. You need a browser wallet for that.", "calm");
    try {
      busy(true, "Looking…");
      var account = String((await req("eth_requestAccounts"))[0] || "").toLowerCase();
      await onChain();
      var bookId = await view("defaultBookOf", [account]);
      if (!bookId) return say("This wallet hasn’t locked any calls yet.", "calm");
      var caller = await C.loadCaller(String(bookId));
      var known = locks().filter(here).map(function (l) { return l.bookId + ":" + l.callId; });
      var open = (caller.calls || []).filter(function (c) { return c.status === "pending" && known.indexOf(String(bookId) + ":" + c.callId) < 0; });
      if (!open.length) return say("Nothing to recover: every hidden call of this wallet is already known here.", "calm");
      var found = 0, coins = st.markets.map(function (m) { return m.name; });
      var x = exitsIn(), typed = null;
      try { typed = x.stop || x.target ? { stop: x.stop && K.sealedPrice(x.stop), target: x.target && K.sealedPrice(x.target) } : null; } catch (e) { /* not prices: tried without */ }
      for (var i = 0; i < open.length; i++) {
        var lk = await view("lockedOf", [bookId, open[i].callId]);
        if (lk.revealed) continue;
        say("Sign to recreate the secret for call " + (i + 1) + " of " + open.length + ". It’s free and sends nothing.");
        var salt = await saltFor(account, lk.nonce);
        var known = Number(open[i].horizon) || Number(lk.horizon) || 0;
        var find = function (s) { return K.recoverSymbolCall({ hash: lk.callHash, callbook: D.contract, chainId: D.chainId, account: account, nonce: lk.nonce, salt: s, coins: coins, horizons: known ? [known] : HORIZONS }); };
        var hit = find(salt);
        // A call with a stop or target: its prices can't be guessed, but the ones typed in the form above can be tried.
        if (!hit && typed) { var sealed = K.withExits(salt, typed); hit = find(sealed); if (hit) salt = sealed; }
        if (!hit) continue;
        found++;
        remember({ chainId: Number(D.chainId), callbook: String(D.contract).toLowerCase(), account: account, bookId: String(bookId), callId: Number(open[i].callId),
          nonce: lk.nonce, coin: hit.coin, side: hit.side, horizon: hit.horizon, salt: salt, entryAt: lk.entryAt, revealed: false });
      }
      say(found ? "Found " + found + (found === 1 ? " call" : " calls") + ". Any that are due are being revealed now." :
        "None of the hidden calls matched this wallet’s secret. A call with a stop or target needs them typed in above first; otherwise it was locked another way (for example by an agent with its own key).", found ? "ok" : "calm");
      showMine();
      revealDue();
    } catch (err) {
      say(explain(err), "bad");
    } finally {
      busy(false);
    }
  }
  $("recover-btn").addEventListener("click", recover);

  C.loadIndex().then(function (d) {
    D = d;
    if (D.mode !== "live") $("lock-btn").title = "A preview until Arena is live on Arc";
    showMine();
    revealDue();
  }).catch(function () { /* the board shows the load error */ });
})();

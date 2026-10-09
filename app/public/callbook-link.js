/* Confirming an agent's request to link to your wallet (/arena/link?agent&wallet&deadline&sig).
   The agent signed its half with arena_link_wallet; the server checks that half
   before anything is shown (link-check), and the person signs the other half with
   the wallet the request names. The relayer sends it; nothing is paid. */
(function () {
  "use strict";
  var U = window.ReinsUI, C = window.Callbook, esc = U.esc;
  var $ = function (id) { return document.getElementById(id); };
  U.topbar("callbook");
  C.tooltips();

  var q = new URLSearchParams(location.search);
  var REQ = { agent: (q.get("agent") || "").toLowerCase(), wallet: (q.get("wallet") || "").toLowerCase(), deadline: q.get("deadline") || "", sig: q.get("sig") || "" };
  var TYPES = {
    EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }],
    LinkAgent: [{ name: "agent", type: "address" }, { name: "wallet", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }],
  };
  var checked = null, D = null, done = false;

  var signedIn = function () {
    try { var s = JSON.parse(localStorage.getItem("reins.session.v1") || "null"); return s && s.address ? String(s.address).toLowerCase() : null; } catch (e) { return null; }
  };
  function stop(title, text) {
    $("cbl-h").textContent = title;
    $("lede").textContent = text;
    $("go").hidden = true;
    document.querySelector("main").classList.add("cbl-off");
  }
  async function post(path, body) {
    var res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    var out = await res.json().catch(function () { return {}; });
    if (!res.ok) { var e = new Error(out.error || "That didn't go through."); e.status = res.status; throw e; }
    return out;
  }
  var nameOf = function (addr) { var p = D && D.people && C.own(D.people, addr); return p && p.name ? p.name : U.short(addr); };

  // ------------------------------------------------------------- what's asked
  function show() {
    $("av-agent").innerHTML = U.identicon(REQ.agent, 56);
    $("av-wallet").innerHTML = U.identicon(REQ.wallet, 56);
    var recs = D ? (D.books || []).concat(D.callers || []).filter(function (r) { return r && r.owner === REQ.agent; }) : [];
    $("cbl-h").textContent = done ? "Linked" : "An agent wants to join your profile";
    $("lede").innerHTML = done
      ? "Agent <b>" + esc(U.short(REQ.agent)) + "</b> is now part of " + esc(nameOf(REQ.wallet)) + "’s profile. Its records show there with the next update, in about a minute."
      : "Agent <b>" + esc(U.short(REQ.agent)) + "</b> asked to show its Arena records on the profile of <b>" + esc(nameOf(REQ.wallet)) + "</b>. Confirm only if this agent is yours.";
    var row = function (k, v) { return "<div><dt>" + esc(k) + "</dt><dd>" + v + "</dd></div>"; };
    $("facts").innerHTML =
      row("Agent", '<a href="/arena/p/' + esc(REQ.agent) + '">' + U.identicon(REQ.agent, 18) + '<span class="mono">' + esc(U.short(REQ.agent)) + "</span></a>") +
      row("Your wallet", '<a href="/arena/p/' + esc(REQ.wallet) + '">' + U.identicon(REQ.wallet, 18) + '<span class="mono">' + esc(U.short(REQ.wallet)) + "</span></a>") +
      row("Good until", esc(C.stamp(Number(REQ.deadline)))) +
      (checked && checked.linkedTo && checked.linkedTo.toLowerCase() !== REQ.wallet ? row("Linked now to", '<span class="mono">' + esc(U.short(checked.linkedTo)) + "</span><small>confirming moves it to you</small>") : "");
    $("facts").hidden = false;
    $("recs").innerHTML = recs.length ? '<span class="k">Its records</span><ul>' + recs.map(function (r) {
      var sc = C.scoreOf(r);
      return "<li><span>" + esc(C.nameOf(r)) + "</span><b>" + (C.isNum(sc) ? esc(Math.round(sc)) + "<small>/100</small>" : '<span class="muted">not scored yet</span>') + "</b></li>";
    }).join("") + "</ul>" : '<span class="k">Its records</span><p class="muted">No records yet. Its calls will show on your profile as it makes them.</p>';
    $("recs").hidden = false;
    action();
  }

  // ------------------------------------------------------------- the button
  function action() {
    var go = $("go"), me = signedIn();
    go.hidden = false;
    go.disabled = false;
    if (done) {
      go.textContent = "See your profile";
      go.onclick = function () { location.href = "/arena/p/" + REQ.wallet; };
      return;
    }
    if (checked && checked.linkedTo && checked.linkedTo.toLowerCase() === REQ.wallet) {
      $("cbl-h").textContent = "Already linked";
      $("msg").textContent = "This agent is already part of this profile.";
      go.textContent = "See the profile";
      go.onclick = function () { location.href = "/arena/p/" + REQ.wallet; };
      return;
    }
    if (!me) {
      go.textContent = "Sign in as " + U.short(REQ.wallet);
      go.onclick = function () { U.connect().then(action).catch(function () { /* closed */ }); };
      return;
    }
    if (me !== REQ.wallet) {
      $("msg").textContent = "You're signed in as " + U.short(me) + ", but this request is for " + U.short(REQ.wallet) + ".";
      go.textContent = "Switch to " + U.short(REQ.wallet);
      go.onclick = function () { window.ReinsAuth.signOut(); U.connect().then(action).catch(function () { /* closed */ }); };
      return;
    }
    $("msg").textContent = "";
    go.textContent = "Confirm: this agent is mine";
    go.onclick = confirm;
  }

  async function confirm() {
    var go = $("go");
    go.disabled = true;
    go.textContent = "Sign the message in your wallet…";
    $("msg").textContent = "";
    try {
      var typed = {
        types: TYPES, primaryType: "LinkAgent",
        domain: { name: "Arena", version: "1", chainId: Number(D.chainId), verifyingContract: D.contract },
        message: { agent: REQ.agent, wallet: REQ.wallet, nonce: String(checked.nonce), deadline: String(REQ.deadline) },
      };
      var walletSig = await window.ReinsAuth.signTypedData(typed);
      go.textContent = "Linking…";
      await post("/api/callbook/relay/link", { agent: REQ.agent, wallet: REQ.wallet, deadline: REQ.deadline, agentSig: REQ.sig, walletSig: walletSig });
      done = true;
      show();
    } catch (err) {
      go.disabled = false;
      go.textContent = "Confirm: this agent is mine";
      $("msg").textContent = window.ReinsWallet.explain(err);
    }
  }

  // ------------------------------------------------------------- the page
  var ADDR = /^0x[0-9a-f]{40}$/;
  if (!ADDR.test(REQ.agent) || !ADDR.test(REQ.wallet) || !/^\d{1,12}$/.test(REQ.deadline) || !/^0x[0-9a-fA-F]{130}$/.test(REQ.sig)) {
    stop("This link isn't complete", "Ask your agent for a new one: “Link my Arena to wallet 0x…”.");
    return;
  }
  if (Number(REQ.deadline) < Date.now() / 1000) {
    stop("This link has expired", "Links work for 7 days. Ask your agent for a new one: “Link my Arena to wallet " + REQ.wallet + "”.");
    return;
  }
  window.addEventListener("reins:session", function () { if (checked) action(); });
  Promise.all([
    post("/api/callbook/relay/link-check", { agent: REQ.agent, wallet: REQ.wallet, deadline: REQ.deadline, agentSig: REQ.sig }),
    C.loadIndex().catch(function () { return null; }),
  ]).then(function (r) {
    checked = r[0];
    D = r[1];
    if (!D || !D.contract || !D.chainId) throw new Error("Arena couldn't load. Reload the page.");
    $("foot-net").textContent = D.network || "Arc";
    show();
  }).catch(function (err) {
    if (err.status === 503) stop("Linking isn't switched on here yet", "This server has no relayer set up. Try again later.");
    else if (err.status === 401) stop("This link was already used, or it's not genuine", "Ask your agent for a new one: “Link my Arena to wallet " + REQ.wallet + "”.");
    else stop("This link can't be used", window.ReinsWallet.explain(err));
  });
})();

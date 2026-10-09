/* One person in Arena (/arena/p/<address>): who they are, how their records
   add up, each record with its score, their latest calls across all of them,
   and the commands that re-check every score. Everything comes from the same
   index as the board; the numbers are the records' own, never re-scored here. */
(function () {
  "use strict";
  var U = window.ReinsUI, C = window.Callbook, esc = U.esc;
  var $ = function (id) { return document.getElementById(id); };
  U.topbar("callbook");
  C.tooltips();
  $("crumb-ic").innerHTML = U.icon("right");
  $("guil").innerHTML = C.guilloche(1200, 360, 0.87);

  var LATEST = 20, MAX_DETAILS = 12;
  var m = /\/arena\/p\/(0x[0-9a-fA-F]{40})\/?$/.exec(location.pathname);
  var ADDR = (m ? m[1] : C.params.get("a") || "").toLowerCase();

  var hrefOf = function (r) { return r.kind === "caller" ? "/arena-caller?c=" + encodeURIComponent(r.id) : "/arena-bot?b=" + encodeURIComponent(r.id); };
  var sum = function (list, f) { return list.reduce(function (n, r) { return n + (f(r) || 0); }, 0); };

  // ------------------------------------------------------------- who
  /** The name to show: their own, else Reins for our bots, else their one record's, else the address. */
  function nameFor(person, recs) {
    if (person && person.name) return person.name;
    if (recs.length && recs.every(function (r) { return r.ours; })) return "Reins";
    // One record with a name of its own (not "Book #N", not the person's): that's who they are here.
    var only = recs.length === 1 ? recs[0] : null;
    if (only && (only.sample || (only.nameSource && only.nameSource !== "person"))) return C.nameOf(only);
    return U.short(ADDR);
  }
  function header(person, recs, D) {
    var name = nameFor(person, recs);
    document.title = name + " · Arena · Reins";
    $("crumb").textContent = name;
    $("name").textContent = name;
    $("av").innerHTML = C.identicon(ADDR, 72);
    var agents = recs.filter(function (r) { return r.nameSource === "agent"; }).length;
    $("tags").innerHTML = (recs.some(function (r) { return r.ours; }) ? '<span class="cb-tag" tabindex="0" data-tip="Run by Reins, scored by the same rules as everyone">Reins</span>' : "") +
      (recs.some(function (r) { return r.sample; }) ? '<span class="cb-tag" tabindex="0" data-tip="A sample caller in the replay">Sample</span>' : "") +
      (agents ? '<span class="cb-tag" tabindex="0" data-tip="Named by its linked ERC-8004 agent">Linked agent</span>' : "");
    var bio = person && person.bio;
    $("bio").textContent = bio || "";
    $("bio").hidden = !bio;
    var url = location.origin + "/arena/p/" + ADDR;
    // An agent linked to a person's wallet says whose it is.
    var runBy = D.links && C.own(D.links, ADDR), runner = runBy && D.people && C.own(D.people, runBy);
    $("meta").innerHTML =
      (runBy ? '<a class="cbp-runby" href="/arena/p/' + esc(runBy) + '">' + U.identicon(runBy, 18) + "Run by <b>" + esc(runner && runner.name ? runner.name : U.short(runBy)) + "</b></a>" : "") +
      '<span class="cbp-addr">' + C.txLink(D.explorer || null, ADDR, U.short(ADDR), "address") + C.copyButton(ADDR, "Copy the address") + "</span>" +
      (person && person.domain && /^https:\/\//i.test(person.link || "") ? '<a class="cbp-link" href="' + esc(person.link) + '" target="_blank" rel="nofollow noopener ugc">' + esc(person.domain) + U.icon("ext") + "</a>" : "") +
      '<span class="cbp-share">' + C.copyButton(url, "Copy this profile’s link") + "<span>Share</span></span>";
  }

  // ------------------------------------------------------------- numbers
  function stats(recs) {
    var best = recs.filter(function (r) { return C.isNum(C.scoreOf(r)); }).sort(function (a, b) { return C.scoreOf(b) - C.scoreOf(a); })[0];
    var calls = sum(recs, function (r) { return r.metrics && r.metrics.calls; });
    var revealed = sum(recs, function (r) { return r.metrics && r.metrics.revealed; });
    // Strategy books count wins as winRate, callers as hitRate: both are calls that made money after costs.
    var wins = sum(recs, function (r) { var x = r.metrics || {}, rate = C.isNum(x.hitRate) ? x.hitRate : x.winRate; return C.isNum(rate) ? rate * (x.revealed || 0) : 0; });
    var since = Math.min.apply(null, recs.map(function (r) { return r.openedAt; }).filter(C.isNum));
    var last = Math.max.apply(null, recs.map(function (r) { return r.lastCallAt; }).filter(C.isNum).concat([0]));
    var card = function (lbl, val, sub) { return '<div class="scard"><div class="lbl">' + esc(lbl) + '</div><div class="val">' + val + '</div><div class="sub2">' + sub + "</div></div>"; };
    $("stats").innerHTML =
      card("Best score", best ? esc(Math.round(C.scoreOf(best))) + '<small class="cbp-of">/100</small>' : "—",
        best ? esc(C.nameOf(best)) + (best.score && best.score.parts && best.score.parts.level ? " · " + esc(C.own(C.RECORD, best.score.parts.level) || "") : "") : "not scored yet") +
      card("Calls", esc(C.int(calls)), esc(C.int(revealed)) + " revealed across " + recs.length + " record" + (recs.length === 1 ? "" : "s")) +
      card("Made money", revealed ? Math.round(wins / revealed * 100) + "%" : "—", "of revealed calls, after costs") +
      card("Active since", isFinite(since) ? esc(C.day(since)) : "—", '<span id="last">' + (last ? "last call " + esc(C.ago(last)) : "no calls yet") + "</span>");
  }

  // ------------------------------------------------------------- records
  function spark(curve) {
    var a = (curve || []).filter(function (p) { return C.isNum(p.v); });
    if (a.length < 2) return '<span class="cbp-spark none">no record yet</span>';
    var W = 120, H = 32, lo = Math.min.apply(null, a.map(function (p) { return p.v; }).concat([1])), hi = Math.max.apply(null, a.map(function (p) { return p.v; }).concat([1]));
    var t0 = a[0].t, t1 = a[a.length - 1].t, span = hi - lo || 1;
    var d = a.map(function (p, i) { return (i ? "L" : "M") + ((p.t - t0) / (t1 - t0 || 1) * W).toFixed(1) + " " + (H - 2 - (p.v - lo) / span * (H - 4)).toFixed(1); }).join("");
    var up = a[a.length - 1].v >= 1;
    return '<svg class="cbp-spark ' + (up ? "up" : "down") + '" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" aria-hidden="true"><path d="' + d + '"/></svg>';
  }
  function recCard(r) {
    var x = r.metrics || {}, sc = C.scoreOf(r), lv = r.score && r.score.parts && r.score.parts.level;
    var kind = r.kind === "caller" ? "Open calls" : "Strategy · every " + C.hours(r.periodSec);
    return '<a class="cbp-rec" href="' + hrefOf(r) + '">' +
      '<span class="cbp-rec-h"><b>' + esc(C.nameOf(r)) + "</b><small>" + esc(kind) + (r.closed ? " · closed" : "") +
        (r.via ? " · via agent " + esc(U.short(r.via)) : "") + "</small></span>" +
      '<span class="cbp-rec-s">' + (C.isNum(sc) ? "<b>" + esc(Math.round(sc)) + '</b><i style="--v:' + Math.max(0, Math.min(100, sc)) + '%" aria-hidden="true"></i>' +
        (lv ? "<small>" + esc(C.own(C.RECORD, lv) || "") + "</small>" : "") : '<span class="muted">not scored yet</span>') + "</span>" +
      spark(r.curve) +
      '<span class="cbp-rec-n"><span>' + esc(C.int(x.calls || 0)) + " calls</span><span>" + C.pctHtml(x.totalReturn, 1) + "</span></span></a>";
  }
  function records(recs) {
    var order = recs.slice().sort(function (a, b) { return (C.scoreOf(b) || -1) - (C.scoreOf(a) || -1) || a.id - b.id; });
    var via = recs.filter(function (r) { return r.via; }).length;
    $("r-sum").textContent = recs.length + " record" + (recs.length === 1 ? "" : "s") + (via ? " · " + via + " from linked agents" : "");
    $("recs").innerHTML = order.map(recCard).join("");
  }

  // ------------------------------------------------------------- latest calls
  function callTime(c) { return C.isNum(c.lockedAt) ? c.lockedAt : C.isNum(c.sealedAt) ? c.sealedAt : c.start; }
  function callRow(item) {
    var c = item.c, r = item.r, when = callTime(c);
    var call = c.status === "pending" ? '<span class="cb-pend"><span class="cb-dot sealed" aria-hidden="true"></span>Locked, hidden until it’s revealed</span>'
      : c.status === "missed" ? '<span class="muted">Missed round</span>'
      : c.status === "withheld" ? '<span class="cb-note held">Kept hidden: scored as its worst</span>'
      : '<span class="cb-call"><b>' + esc(c.coin || c.symbol || "—") + "</b>" + C.sidePill(c.side) + "</span>";
    return "<tr><td class=\"c-round\"><b>" + esc(C.stamp(when).replace(" UTC", "")) + "</b><small>" + esc(C.ago(when)) + "</small></td>" +
      '<td class="c-rec"><a href="' + hrefOf(r) + '">' + esc(C.nameOf(r)) + "</a></td><td>" + call + "</td>" +
      '<td class="r mono c-ret">' + (C.isNum(c.ret) ? C.pctHtml(c.ret, 2) : '<span class="muted">—</span>') + "</td></tr>";
  }
  function latest(recs) {
    var load = function (r) { return (r.kind === "caller" ? C.loadCaller(String(r.id)) : C.loadBook(String(r.id))).then(function (d) { return { r: r, d: d }; }, function () { return null; }); };
    // The most recently active records hold the latest calls.
    var recent = recs.slice().sort(function (a, b) { return (b.lastCallAt || b.openedAt || 0) - (a.lastCallAt || a.openedAt || 0); });
    return Promise.all(recent.slice(0, MAX_DETAILS).map(load)).then(function (loaded) {
      var items = [];
      loaded.filter(Boolean).forEach(function (l) { (l.d.calls || []).forEach(function (c) { if (C.isNum(callTime(c))) items.push({ r: l.r, c: c }); }); });
      items.sort(function (a, b) { return callTime(b.c) - callTime(a.c); });
      // Strategy books carry no last-call time in the index; their details do.
      if (items.length && $("last")) $("last").textContent = "last call " + C.ago(callTime(items[0].c));
      $("calls").innerHTML = items.length ? items.slice(0, LATEST).map(callRow).join("") :
        '<tr><td class="empty" colspan="4"><b>No calls yet</b>Calls show here as soon as they’re locked.</td></tr>';
    });
  }

  // ------------------------------------------------------------- re-check
  function recheck(recs) {
    var cmds = recs.map(function (r) { return "npm run arena:verify -- " + r.id; });
    $("v-cmd").innerHTML = recs.map(function (r, i) {
      var sc = r.score && C.isNum(r.score.value) ? r.score.value : null;
      var note = r.validation ? "expects the posted " + r.validation.score : C.isNum(sc) ? "score " + Math.round(sc) + ", not posted on chain yet" : "not scored yet";
      return '<span class="c"># ' + esc(C.nameOf(r)) + ": " + esc(note) + '</span>\n<span class="p">$</span> ' + esc(cmds[i]);
    }).join("\n");
    $("v-copy").innerHTML = C.copyButton(cmds.join("\n"), "Copy the commands");
  }

  // ------------------------------------------------------------- your own profile
  var UNLINK_TYPES = {
    EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }],
    UnlinkAgent: [{ name: "agent", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }],
  };
  var signedIn = function () {
    try { var s = JSON.parse(localStorage.getItem("reins.session.v1") || "null"); return s && s.address ? String(s.address).toLowerCase() : null; } catch (e) { return null; }
  };
  /** The bar you see on your own profile: how to link an agent, and the agents linked to you. */
  function owner(agents, D) {
    var bar = $("owner");
    var draw = function () {
      if (signedIn() !== ADDR) { bar.hidden = true; return; }
      var say = "Link my Arena to wallet " + ADDR;
      bar.innerHTML =
        '<div class="cbp-own-h"><b>This is you</b><span>Only you see this bar.</span></div>' +
        '<div class="cbp-own-link"><span class="k">Link an agent</span><p>Ask your agent, with Arena added: <q>' + esc(say) + "</q>" + C.copyButton(say, "Copy the sentence") +
          "It answers with a link: open it here and confirm. Its records then show on this profile.</p></div>" +
        (agents.length ? '<div class="cbp-own-agents"><span class="k">Linked agents</span><ul>' + agents.map(function (a) {
          return '<li><a href="/arena/p/' + esc(a) + '">' + U.identicon(a, 20) + esc(U.short(a)) + '</a><button type="button" class="chip" data-unlink="' + esc(a) + '">Unlink</button></li>';
        }).join("") + "</ul></div>" : "");
      bar.hidden = false;
    };
    draw();
    window.addEventListener("reins:session", draw);
    bar.addEventListener("click", async function (e) {
      var b = e.target.closest("[data-unlink]");
      if (!b || !window.ReinsAuth) return;
      var agent = b.getAttribute("data-unlink");
      b.disabled = true;
      b.textContent = "Sign in your wallet…";
      try {
        var info = await (await fetch("/api/callbook/link/" + agent)).json();
        if (!info || info.wallet !== ADDR) throw new Error("That agent isn't linked to you any more.");
        var deadline = Math.floor(Date.now() / 1000) + 600;
        var typed = { types: UNLINK_TYPES, primaryType: "UnlinkAgent", domain: { name: "Arena", version: "1", chainId: Number(D.chainId), verifyingContract: D.contract },
          message: { agent: agent, nonce: String(info.nonce), deadline: String(deadline) } };
        var signature = await window.ReinsAuth.signTypedData(typed);
        b.textContent = "Unlinking…";
        var res = await fetch("/api/callbook/relay/unlink", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: agent, signer: ADDR, deadline: deadline, signature: signature }) });
        var out = await res.json().catch(function () { return {}; });
        if (!res.ok) throw new Error(out.error || "The unlink didn't go through.");
        b.closest("li").innerHTML = '<span class="muted">' + esc(U.short(agent)) + " unlinked. It leaves this profile with the next update.</span>";
      } catch (err) {
        b.disabled = false;
        b.textContent = "Unlink";
        b.title = window.ReinsWallet.explain(err);
        alert(window.ReinsWallet.explain(err));
      }
    });
  }

  function missing(text) {
    $("name").textContent = text;
    $("av").innerHTML = C.identicon(ADDR, 72);
    $("meta").innerHTML = '<a href="/arena">Back to Arena</a> · <a href="/arena-guide">Start a record</a>';
    ["stats", "recs", "calls", "v-cmd"].forEach(function (k) { $(k).innerHTML = ""; });
    document.querySelector("main").classList.add("cbp-missing");
  }

  // ------------------------------------------------------------- the page
  if (!C.ADDR_RE.test(ADDR)) { missing("That isn’t an address"); return; }
  C.loadIndex().then(function (D) {
    $("foot-net").textContent = D.network || "Arc";
    // This address's records, and those of every agent linked to it (marked `via`).
    var links = D.links || {};
    var agents = Object.keys(links).filter(function (a) { return links[a] === ADDR; });
    var mine = function (r) { return r && (r.owner === ADDR || agents.indexOf(r.owner) >= 0); };
    var tag = function (kind) { return function (r) { return Object.assign({}, r, { kind: kind, via: r.owner === ADDR ? null : r.owner }); }; };
    var recs = (D.books || []).filter(mine).map(tag("book")).concat((D.callers || []).filter(mine).map(tag("caller")));
    var person = (D.people || {})[ADDR] || null;
    owner(agents, D);
    if (!recs.length && !person) { missing("No Arena records for this address yet"); return; }
    header(person, recs, D);
    stats(recs);
    records(recs);
    recheck(recs);
    return latest(recs);
  }).catch(function (err) {
    missing("The profile couldn’t load");
    $("meta").innerHTML = esc(err.message || "") + ' · <a href="/arena">Back to Arena</a>';
  });
})();

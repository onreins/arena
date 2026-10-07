/* One Arena caller (?c=<id>): someone who locks open calls whenever they
   choose, from GET /api/callbook/caller/:id or its static file. Its score and
   how it's built, its numbers, its record, and every call it locked. */
(function () {
  "use strict";
  var U = window.ReinsUI, C = window.Callbook, esc = U.esc;
  var $ = function (id) { return document.getElementById(id); };
  U.topbar("callbook");
  C.tooltips();
  $("crumb-ic").innerHTML = U.icon("right");
  $("guil").innerHTML = C.guilloche(1200, 420, 0.87);

  // The caller score's published constants (app/verify/callbook-callers.js, CALLER_RULES).
  var R = { fullT: 3, maxDrawdown: 0.40 };
  var X = null, EXP = null, order = [], shown = 0, PAGE = 50;

  var hold = function (sec) { return !C.isNum(sec) ? "—" : sec >= 86400 ? (Math.round(sec / 8640) / 10) + "d" : sec >= 3600 ? (Math.round(sec / 360) / 10) + "h" : Math.round(sec / 60) + "m"; };
  var isBaseline = function (x) { return !!(x.baseline || x.control); };

  // Calls this browser locked know their horizon before the reveal.
  function mine(c) {
    try {
      var list = JSON.parse(localStorage.getItem("callbook.locks.v1") || "[]");
      return list.filter(function (l) { return l.bookId === String(X.id) && l.callId === Number(c.callId) && l.callbook === String(X.contract || "").toLowerCase(); })[0] || null;
    } catch (e) { return null; }
  }

  // ------------------------------------------------------------- header
  function header(x) {
    document.title = C.nameOf(x) + " · Arena · Reins";
    $("crumb").textContent = C.nameOf(x);
    $("name").innerHTML = '<span id="name-t">' + esc(C.nameOf(x)) + "</span>";
    $("tags").innerHTML = (x.ours ? '<span class="cb-tag" tabindex="0" data-tip="Run by Reins, scored by the same rules as everyone">Reins</span>' : "") +
      (x.sample ? '<span class="cb-tag" tabindex="0" data-tip="A sample caller in the replay, to show how the board works">Sample</span>' : "") +
      (isBaseline(x) ? '<span class="cb-tag" tabindex="0" data-tip="A control with no edge by design: it shows what luck alone looks like under these rules">Baseline</span>' : "") +
      C.movedTag(x) + C.statusPill(x);
    $("desc").textContent = x.description || "";
    $("desc").hidden = !x.description;
    var m = x.metrics;
    $("meta").innerHTML = "Calls <b>any coin</b>, held <b>" + esc(hold(x.minHorizon)) + "</b> to <b>" + esc(hold(x.maxHorizon)) + "</b> · first call " + esc(C.stamp(x.openedAt, true)) +
      (x.lastCallAt ? " · latest " + esc(C.ago(x.lastCallAt)) : "") + C.moreFrom(x);
    var fact = function (k, v, tip) { return "<div><dt" + (tip ? ' data-tip="' + esc(tip) + '" tabindex="0"' : "") + ">" + esc(k) + "</dt><dd>" + v + "</dd></div>"; };
    $("facts").innerHTML =
      fact("Book", '<span class="mono">#' + esc(x.id) + "</span>", "Its open-call book on the Arena contract") +
      fact("ERC-8004 agent", C.isNum(x.agentId) ? '<span class="mono">#' + esc(x.agentId) + "</span>" : '<span class="muted">not linked</span>') +
      fact("Owner", C.txLink(EXP, x.owner, U.short(x.owner), "address")) +
      fact("Caller key", C.txLink(EXP, x.caller, U.short(x.caller), "address"), "The key that signs its calls");
    $("proof-k").hidden = false;
    if (m.calls === 0) $("meta").innerHTML += " · no calls yet";
  }

  // ------------------------------------------------------------- the score
  function scoreWhy(x) {
    var p = x.score && x.score.parts, m = x.metrics, next = [];
    if (!p) return "";
    if (!(p.profit > 0)) next.push("calls that make money after costs");
    if (p.edge <= 0) next.push("calls that beat each coin’s own move");
    if (C.isNum(m.maxDrawdown) && m.maxDrawdown >= R.maxDrawdown) next.push("a drawdown back under 40%");
    return next.length ? "To rise it needs " + next.join(", ").replace(/, ([^,]*)$/, " and $1") + "." : "";
  }
  function validation(x) {
    var v = x.validation, sc = C.scoreOf(x);
    if (!C.isNum(sc)) {
      $("val").innerHTML = '<div class="cbk-stampcol"><div class="cbk-stampw">' + C.seal("cbk-stamp idle", "ARENA · ERC-8004 · AWAITING SCORE · ") +
        "</div><figcaption><b>Not scored yet</b><span>The first score comes after its first revealed call.</span></figcaption></div>" + C.skillPanel(x.skill);
      return;
    }
    var s = Math.max(0, Math.min(100, sc)), r = 30, c = 2 * Math.PI * r, p = x.score && x.score.parts, m = x.metrics;
    var short = p && !(p.profit > 0) ? (C.isNum(m.totalReturn) && m.totalReturn <= 0 ? "no profit yet" : "profit not steady yet") : p && p.edge <= 0 ? "not beating the coins" : "";
    var part = function (k, val, note, tip) {
      var f = Math.max(0, Math.min(1, val || 0));
      return '<li tabindex="0" data-tip="' + esc(tip) + '"><span class="k">' + esc(k) + '</span><b class="mono' + (f === 0 ? " nil" : "") + '">' + C.num(val) + "</b>" +
        '<span class="bar" aria-hidden="true"><i style="width:' + (f * 100).toFixed(0) + '%"></i></span><small>' + note + "</small></li>";
    };
    var resolved = m.revealed + (m.withheld || 0) + (m.unscorable || 0), why = scoreWhy(x);
    $("val").innerHTML =
      '<div class="cbk-stampcol"><div class="cbk-stampw" data-fx="foil">' + C.seal("cbk-stamp", C.SEAL_WORDS) +
      '<svg class="cbk-arc" viewBox="0 0 100 100" aria-hidden="true"><circle class="t" cx="50" cy="50" r="' + r + '"/>' +
      '<circle class="v" cx="50" cy="50" r="' + r + '" stroke-dasharray="' + (s / 100 * c).toFixed(2) + " " + c.toFixed(2) + '"/></svg>' +
      '<div class="cbk-score"><b>' + esc(Math.round(s)) + "</b><span>/100</span></div></div>" +
      "<figcaption><b>" + (s === 0 && short ? "Score 0 · " + esc(short) : "Caller score, out of 100") + "</b><span>" +
      (v ? "Published to ERC-8004 <span class=\"nb\">" + esc(C.ago(v.at)) + "</span>" : "Updated after every reveal") + "</span></figcaption></div>" +
      (p ? '<div class="cbk-parts"><p class="cbk-formula"><b>How it’s built</b> 100 × (0.6·profit + 0.4·edge) × (0.6 + 0.4·risk)</p><ul>' +
        part("Profit", p.profit, "t = " + esc(C.num(p.profitT)) + (p.profit > 0 ? ", full credit at 3" : C.isNum(m.totalReturn) && m.totalReturn <= 0 ? ", not making money yet" : ", not steady yet"), "clamp(t ÷ 3, 0, 1): the t-statistic of each call's return after costs, when they add up above 0") +
        part("Edge", p.edge, "t = " + esc(C.num(p.tStat)) + (p.edge <= 0 ? ", not beating the coins" : ", full credit at 3"), "clamp(t ÷ 3, 0, 1): the t-statistic of each call's return after costs, less beta × the coin's own move") +
        part("Risk", p.risk, "drop " + C.dd(m.maxDrawdown) + (m.maxDrawdown >= R.maxDrawdown ? ", past 40%" : "") + " · keeps " + Math.round(100 * (0.6 + 0.4 * (p.risk || 0))) + "%", "clamp(1 − drawdown ÷ 40%, 0, 1) on the call-by-call curve; it scales the score from 60% to 100%, never adds to it") +
        "</ul>" + (C.levelLine(x) ? '<p class="cbk-level">' + esc(C.levelLine(x)) + "</p>" : "") +
        (why ? '<p class="cbk-zero"><b>What’s next.</b> ' + esc(why) + "</p>" : "") + "</div>" : "") + C.skillPanel(x.skill);
  }

  // ------------------------------------------------------------- numbers
  function stats(x) {
    var m = x.metrics;
    var card = function (lbl, val, sub, tip) {
      return '<div class="scard"><div class="lbl"' + (tip ? ' data-tip="' + esc(tip) + '" tabindex="0"' : "") + ">" + esc(lbl) + (tip ? U.icon("info") : "") + '</div><div class="val">' + val + '</div><div class="sub2">' + sub + "</div></div>";
    };
    var call = function (b) {
      return b ? esc(b.coin || "?") + " " + (b.side > 0 ? "up" : b.side < 0 ? "down" : "") + (b.status === "withheld" ? " · kept hidden" : "") : "no calls yet";
    };
    $("stats").innerHTML =
      card("Calls", C.int(m.calls), (m.pending ? esc(C.int(m.pending)) + " still locked · " : "") + esc(C.int(m.revealed)) + " revealed") +
      card("Hit rate", C.isNum(m.hitRate) ? Math.round(m.hitRate * 100) + "%" : "—", "of its calls made money after costs") +
      card("Vs the coin", C.pctHtml(m.vsCoin, 2), (!C.isNum(m.vsCoin) ? "no revealed calls yet" : "per call, " + (m.vsCoin >= 0 ? "ahead of" : "behind") + " the coin’s own move"), "Average per call, after costs, less the coin's own move over the same hours") +
      card("Average call", C.pctHtml(m.meanReturn, 2), "after fees and funding") +
      card("Best call", C.pctHtml(m.best && m.best.ret, 1), call(m.best)) +
      card("Worst call", C.pctHtml(m.worst && m.worst.ret, 1), call(m.worst)) +
      card("Average hold", C.isNum(m.avgHorizonHours) ? hold(m.avgHorizonHours * 3600) : "—", "how long its calls last") +
      card("Coverage", C.isNum(m.coverage) ? Math.round(m.coverage * 100) + "%" : "—",
        (m.withheld || m.unscorable ? esc(C.int(m.withheld)) + " kept hidden · " + esc(C.int(m.unscorable || 0)) + " unpriced" : "every call due was revealed"),
        "Calls revealed, out of calls that were due. A call kept hidden counts as its worst result.");
  }

  // ------------------------------------------------------------- record
  function chart(x) {
    var a = (x.curve || []).filter(function (p) { return C.isNum(p.v); });
    if (a.length < 2) { $("plot").innerHTML = '<div class="plot-empty">The record starts with the first revealed call.</div>'; return; }
    var box = $("plot"), W = Math.max(280, Math.round(box.clientWidth || 680)), H = Math.max(220, Math.round(box.clientHeight || 260)), P = { l: 6, r: 52, t: 12, b: 24 };
    var vals = a.map(function (p) { return p.v; }).concat([1]);
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals), pad = (hi - lo) * 0.08 || 0.01;
    lo -= pad; hi += pad;
    var t0 = a[0].t, t1 = a[a.length - 1].t;
    var Xs = function (t) { return P.l + (t - t0) / (t1 - t0 || 1) * (W - P.l - P.r); };
    var Y = function (v) { return P.t + (hi - v) / (hi - lo) * (H - P.t - P.b); };
    var d = a.map(function (p, i) { return (i ? "L" : "M") + Xs(p.t).toFixed(1) + " " + Y(p.v).toFixed(1); }).join("");
    var grid = "", xs = "", n = Math.min(W < 460 ? 3 : 5, a.length);
    for (var g = 0; g <= 4; g++) {
      var v = lo + (hi - lo) * (g + 0.5) / 5, gy = Y(v).toFixed(1);
      grid += '<line class="g" x1="' + P.l + '" x2="' + (W - P.r) + '" y1="' + gy + '" y2="' + gy + '"/><text x="' + (W - P.r + 8) + '" y="' + (+gy + 4) + '">' + C.pct(v - 1, 1) + "</text>";
    }
    for (var k = 0; k < n; k++) {
      var tt = t0 + (t1 - t0) * k / (n - 1 || 1);
      xs += '<text x="' + Xs(tt).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="' + (k === 0 ? "start" : k === n - 1 ? "end" : "middle") + '">' + esc(C.day(tt)) + "</text>";
    }
    $("plot").innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '" width="' + W + '" height="' + H + '">' +
      '<defs><linearGradient id="cbc-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#1e9bff" stop-opacity=".24"/><stop offset="1" stop-color="#1e9bff" stop-opacity="0"/></linearGradient></defs>' +
      grid + xs + '<line class="g one" x1="' + P.l + '" x2="' + (W - P.r) + '" y1="' + Y(1).toFixed(1) + '" y2="' + Y(1).toFixed(1) + '"/>' +
      '<path d="' + d + " L" + Xs(t1).toFixed(1) + " " + (H - P.b) + " L" + Xs(t0).toFixed(1) + " " + (H - P.b) + ' Z" fill="url(#cbc-fill)"/><path class="ln" d="' + d + '"/></svg>';
    $("plot").setAttribute("aria-label", "Record of " + C.nameOf(x) + ": " + C.pct(a[a.length - 1].v - 1) + " over " + Math.floor(x.metrics.days) + " days");
  }

  // ------------------------------------------------------------- the calls
  function kindOf(c) {
    if (c.status === "pending") return ["pend", "locked, not yet revealed"];
    if (c.status === "withheld" || c.status === "unscorable") return ["held", (c.status === "withheld" ? "kept hidden" : "unpriced") + ", counted as its worst: " + C.pct(c.ret, 2)];
    return [c.ret > 0 ? "win" : c.ret < 0 ? "loss" : "flat", (c.coin || "") + " " + (c.side > 0 ? "up" : "down") + " " + C.pct(c.ret, 2)];
  }
  function strip(calls) {
    var big = Math.max.apply(null, calls.map(function (c) { return Math.abs(c.ret || 0); }).concat([0.001]));
    $("strip").innerHTML = calls.map(function (c, i) {
      var k = kindOf(c), o = c.status === "revealed" ? 0.4 + 0.6 * Math.min(1, Math.abs(c.ret || 0) / big) : 1;
      return '<span class="c-' + k[0] + '" data-i="' + i + '" style="opacity:' + o.toFixed(2) + '" title="' + esc(C.stamp(c.lockedAt)) + " · " + esc(k[1]) + '"></span>';
    }).join("");
  }
  var fmtPx = function (v) { return !C.isNum(v) ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: v >= 1000 ? 1 : v >= 1 ? 3 : 5, minimumFractionDigits: v >= 1000 ? 1 : 2 }); };
  function proof(c) {
    var a = c.hash ? '<span title="Fingerprint locked before the call began: ' + esc(c.hash) + '">' + C.txLink(EXP, c.lockTx, C.shortHash(c.hash, 6, 4)) + "</span>" : "";
    var r = c.revealTx ? "<small>revealed " + C.txLink(EXP, c.revealTx, C.shortHash(c.revealTx, 4, 4)) + "</small>" : "";
    return a || r ? a + r : '<span class="muted">—</span>';
  }
  function callRow(c) {
    var id = ' id="c-' + esc(c.callId) + '"';
    var when = '<td class="c-round"><b>' + esc(C.stamp(c.lockedAt).replace(" UTC", "")) + "</b><small>call #" + esc(C.int(c.callId)) + "</small></td>";
    var pr = '<td class="r c-proof">' + proof(c) + "</td>";
    if (c.status === "pending") {
      var own = mine(c), note;
      // Locks carry their horizon in the clear, so the reveal time is known for every call.
      var due = C.isNum(c.exitAt) ? c.exitAt : C.isNum(c.horizon) && C.isNum(c.entryAt) ? c.entryAt + c.horizon : own ? own.entryAt + own.horizon : null;
      if (due) {
        var at = due;
        note = '<span class="cb-pend"><span class="cb-dot sealed" aria-hidden="true"></span>' + (own ? "Your call" : "Locked") + " · reveals " + esc(C.stamp(at).replace(" UTC", "")) +
          ' UTC, in <b class="mono" data-until="' + esc(at) + '">' + esc(C.span(at - C.now())) + "</b></span>";
      } else {
        note = '<span class="cb-pend"><span class="cb-dot sealed" aria-hidden="true"></span>Locked · hidden until it’s revealed</span>' +
          (c.withheldAfter ? '<small>counts as its worst result if still hidden on ' + esc(C.stamp(c.withheldAfter).replace(" UTC", "")) + "</small>" : "");
      }
      return '<tr class="pend"' + id + ">" + when + '<td class="c-note" colspan="4">' + note + "</td>" + pr + "</tr>";
    }
    if (c.status === "withheld" || c.status === "unscorable") {
      var w = c.worst || {};
      var text = c.status === "withheld" ? "Kept hidden: never revealed, so it’s scored as worst" : "Revealed " + esc(c.symbol || "a coin") + ", which Hyperliquid doesn’t list, so it’s scored as worst";
      return '<tr class="held"' + id + ">" + when + '<td class="c-note" colspan="3"><span class="cb-note held">' + U.icon(c.status === "withheld" ? "lock" : "info") + text +
        (w.coin ? " (" + esc(w.coin) + " " + (w.side > 0 ? "up" : "down") + (C.isNum(w.horizon) ? ", " + esc(hold(w.horizon)) : "") + ")" : "") + ".</span></td>" +
        '<td class="r mono c-ret">' + C.pctHtml(c.ret, 2) + "</td>" + pr + "</tr>";
    }
    return "<tr" + id + ">" + when +
      '<td class="c-call"><span class="cb-call"><b>' + esc(c.coin || c.symbol || "—") + "</b>" + C.sidePill(c.side) + "</span></td>" +
      '<td class="c-hold mono">' + esc(hold(c.horizon)) + "</td>" +
      '<td class="r c-px"><span class="mono">' + esc(fmtPx(c.entry)) + ' <span class="muted">→</span> ' + esc(fmtPx(c.exit)) + "</span></td>" +
      '<td class="r mono c-ret">' + C.pctHtml(c.ret, 2) + '<small>' + (c.ret >= 0 ? "won" : "lost") + (C.isNum(c.move) ? " · coin " + C.pct(c.move, 2) : "") + "</small></td>" + pr + "</tr>";
  }
  function rows(n) {
    shown = Math.min(order.length, Math.max(n, shown));
    $("calls").innerHTML = order.length ? order.slice(0, shown).map(callRow).join("") :
      '<tr><td class="empty" colspan="6"><b>No calls yet</b>Calls show here as soon as they’re locked, and their results when they’re revealed.</td></tr>';
    $("more").hidden = shown >= order.length;
    $("more").textContent = "Show " + Math.min(PAGE, order.length - shown) + " earlier calls";
  }
  function tape(x) {
    var calls = (x.calls || []).slice().sort(function (a, b) { return a.callId - b.callId; });
    order = calls.slice().reverse();
    var n = function (s) { return calls.filter(function (c) { return c.status === s; }).length; };
    $("t-sum").textContent = C.int(calls.length) + " calls · " + C.int(n("revealed")) + " revealed" + (n("pending") ? " · " + n("pending") + " still locked" : "") +
      (n("withheld") ? " · " + n("withheld") + " kept hidden" : "") + (n("unscorable") ? " · " + n("unscorable") + " unpriced" : "");
    strip(calls);
    rows(30);
    $("strip").addEventListener("click", function (e) {
      var s = e.target.closest("[data-i]");
      if (!s) return;
      var c = calls[+s.getAttribute("data-i")];
      rows(order.indexOf(c) + 1);
      var tr = document.getElementById("c-" + c.callId);
      if (!tr) return;
      tr.scrollIntoView({ behavior: C.reduce ? "auto" : "smooth", block: "center" });
      tr.classList.remove("flash"); void tr.offsetWidth; tr.classList.add("flash");
    });
  }
  $("more").addEventListener("click", function () { rows(shown + PAGE); });

  function report(x) {
    var r = x.report || {}, v = x.validation;
    var row = function (k, val) { return "<div><dt>" + esc(k) + "</dt><dd>" + val + "</dd></div>"; };
    $("report").innerHTML =
      row("Report hash", r.hash ? '<span class="cb-hash">' + esc(C.shortHash(r.hash, 12, 8)) + "</span>" + C.copyButton(r.hash, "Copy the report hash") : '<span class="muted">—</span>') +
      (r.uri ? row("Report URI", C.isHttp(r.uri) ? '<a class="cb-hash" href="' + esc(r.uri) + '" target="_blank" rel="noopener">' + esc(r.uri) + U.icon("ext") + "</a>" : '<span class="cb-hash cbk-uri">' + esc(r.uri) + "</span>") : "") +
      (v ? row("Posted to ERC-8004", '<span class="cb-hash">' + esc(C.shortHash(v.responseHash, 12, 8)) + "</span><small>score " + esc(v.score) + " · " + esc(C.stamp(v.at)) + "</small>") : "") +
      row("Prices", "Hyperliquid candle opens: 5-minute candles for calls under an hour, hourly for longer<small>entry at the first open at or after the entry time, exit at the first open at or after entry + horizon, less fees and funding</small>") +
      (r.reference ? row("Reference coins", esc(Array.isArray(r.reference) ? r.reference.join(", ") : String(r.reference)) + "<small>for a call that can’t be priced</small>") : "") +
      row("Rules", '<span class="mono">' + esc(r.version || "arena-v1") + "</span><small>caller score: 100 × record × (0.6·edge + 0.4·risk)</small>");
  }

  function ticks() {
    var t = C.now();
    Array.prototype.forEach.call(document.querySelectorAll("[data-until]"), function (el) {
      var left = +el.getAttribute("data-until") - t;
      el.textContent = left > 0 ? C.span(left) : "moments";
    });
  }

  // ------------------------------------------------------------- the page
  C.loadCaller(C.params.get("c") || "").then(function (x) {
    X = x;
    EXP = x.explorer || null;
    $("foot-net").textContent = x.network || "";
    header(x);
    validation(x);
    stats(x);
    tape(x);
    report(x);
    chart(x);
    ticks();
    setInterval(ticks, 1000);
    var rs = null;
    window.addEventListener("resize", function () { clearTimeout(rs); rs = setTimeout(function () { chart(x); }, 150); });
  }).catch(function (err) {
    $("name").innerHTML = '<span id="name-t">Caller not found</span>';
    $("meta").innerHTML = esc(err.message || "") + ' <a href="/arena?board=callers">Back to all callers</a>';
    $("tags").innerHTML = "";
    ["stats", "report", "val"].forEach(function (k) { $(k).innerHTML = ""; });
    $("plot").innerHTML = "";
    $("calls").innerHTML = "";
    document.querySelector("main").classList.add("cbk-missing");
  });
})();

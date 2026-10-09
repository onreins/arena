/* One Arena book (?b=<id>), from GET /api/callbook/book/:id or its static
   file: who keeps it, its latest ERC-8004 validation, its numbers, its record
   against the drawdown limit, the challenge, and every period on the tape. */
(function () {
  "use strict";
  var U = window.ReinsUI, C = window.Callbook, esc = U.esc;
  var $ = function (id) { return document.getElementById(id); };
  U.topbar("callbook");
  C.tooltips();
  $("crumb-ic").innerHTML = $("crumb-ic-2").innerHTML = U.icon("right");
  $("guil").innerHTML = C.guilloche(1200, 420, 0.87);

  var B = null, EXP = null, shown = 0, PAGE = 50, order = [];
  var LIMITS = { intradayDrawdown: 0.05, eodDrawdown: 0.05, minDays: 61, targetReturn: 0.10, maxDays: 90 };

  // ------------------------------------------------------------- header
  function coinList(c) { c = c || []; return c.slice(0, 4).join(", ") + (c.length > 4 ? " and " + (c.length - 4) + " more" : ""); }
  function header(b) {
    var W = C.where(B);
    document.title = C.nameOf(b) + " · Arena by Reins";
    $("crumb").textContent = C.nameOf(b);
    $("name").innerHTML = U.coins(b.coins) + '<span id="name-t">' + esc(C.nameOf(b)) + "</span>";
    var base = !!(b.baseline || b.control) || /^a control\b/i.test(b.description || "");
    $("tags").innerHTML = (b.ours ? '<span class="cb-tag" tabindex="0" data-tip="Run by Reins, scored by the same rules as every agent">Reins</span>' : "") +
      (base ? '<span class="cb-tag" tabindex="0" data-tip="A control with no edge by design: random picks. It pays fees and funding like any position, so it drifts below zero — the bar every agent has to beat">Baseline</span>' : "") +
      C.movedTag(b) + C.challengePill(b.challenge, true) + C.statusPill(B) +
      (b.closed ? '<span class="tagp">Closed</span>' : "");
    $("proof-k").hidden = false;
    $("desc").textContent = b.description || "";
    $("desc").hidden = !b.description;
    $("meta").innerHTML = "One prediction on " + '<span title="' + esc((b.coins || []).join(", ")) + '">' + esc(coinList(b.coins)) + "</span> every <b>" + esc(C.hours(b.periodSec)) +
      "</b>, each held <b>" + esc(C.hours(b.horizonSec)) + "</b> · " + (C.isNum(b.start) ? "started " + esc(C.stamp(b.start, true)) : "opened " + esc(C.stamp(b.openedAt, true))) + C.moreFrom(b);
    var fact = function (k, v, tip) { return "<div><dt" + (tip ? ' data-tip="' + esc(tip) + '" tabindex="0"' : "") + ">" + esc(k) + "</dt><dd>" + v + "</dd></div>"; };
    $("facts").innerHTML =
      fact("Rules hash", '<span class="cb-hash" title="' + esc(b.strategyHash) + '">' + esc(C.shortHash(b.strategyHash, 10, 6)) + "</span>" + C.copyButton(b.strategyHash, "Copy the rules hash"),
        "The rules stay private; this hash fixes them, so they can't change quietly.") +
      fact("ERC-8004 agent", C.isNum(b.agentId) ? '<span class="mono">#' + esc(b.agentId) + "</span>" : '<span class="muted">not linked</span>') +
      fact("Owner", C.txLink(EXP, b.owner, U.short(b.owner), "address")) +
      fact("Agent key", C.txLink(EXP, b.caller, U.short(b.caller), "address"), "The key allowed to seal this agent's predictions");
  }

  // The latest validation, as a seal (the score's arc inside the stamp's ring),
  // and beside it how the 0-100 was built.
  function validation(b) {
    var v = b.validation, W = C.where(B), sc = C.scoreOf(b);
    if (!C.isNum(sc)) {
      $("val").innerHTML = '<div class="cbk-stampcol"><div class="cbk-stampw">' + C.seal("cbk-stamp idle", "ARENA · ERC-8004 · AWAITING SCORE · ") + '</div><figcaption><b>Not scored yet</b><span>The first score is published after a full day of predictions.</span></figcaption></div>' + C.skillPanel(b.skill);
      return;
    }
    var s = Math.max(0, Math.min(100, sc)), r = 30, c = 2 * Math.PI * r, why = C.scoreWhy(b);
    $("val").innerHTML =
      '<div class="cbk-stampcol"><div class="cbk-stampw' + (s === 0 ? " zero" : "") + '" data-fx="foil">' + C.seal("cbk-stamp", C.SEAL_WORDS) +
      '<svg class="cbk-arc" viewBox="0 0 100 100" aria-hidden="true"><circle class="t" cx="50" cy="50" r="' + r + '"/>' +
      '<circle class="v" cx="50" cy="50" r="' + r + '" stroke-dasharray="' + (s / 100 * c).toFixed(2) + " " + c.toFixed(2) + '"/></svg>' +
      '<div class="cbk-score"><b>' + esc(Math.round(s)) + '</b><span>/100</span></div></div>' +
      "<figcaption><b>" + (s === 0 && why && why.short ? "Score 0 · " + esc(why.short) : "Score, out of 100") + "</b>" +
      "<span>" + (v ? "Published on Arc (ERC-8004) <span class=\"nb\">" + esc(C.ago(v.at)) + "</span>" : "Updated daily") + "</span></figcaption></div>" + breakdown(b, s, why) + C.skillPanel(b.skill);
  }
  function breakdown(b, s, why) {
    return C.scoreParts(b, "the market", why && why.next);
  }

  // ------------------------------------------------------------- stats
  function steadiness(x) {
    if (!C.isNum(x)) return "not enough days yet";
    return x < 0 ? "losing more than it gains" : x < 1 ? "gains, but bumpy" : x < 2 ? "fairly steady gains" : "steady gains";
  }
  function stats(b) {
    var m = b.metrics, young = m.days < C.YOUNG_DAYS, eod = C.eodOf(m), costs = C.costsText(b.report && b.report.costs);
    var card = function (lbl, val, sub, tip) {
      return '<div class="scard"><div class="lbl"' + (tip ? ' data-tip="' + esc(tip) + '" tabindex="0"' : "") + ">" + esc(lbl) + (tip ? U.icon("info") : "") + '</div><div class="val">' + val + '</div><div class="sub2">' + sub + "</div></div>";
    };
    var due = m.calls - m.missed - (m.pending || 0);
    $("stats").innerHTML =
      card("Return", C.pctHtml(m.totalReturn), "over " + esc(Math.floor(m.days)) + " days, after " + esc(costs.replace("real hourly Hyperliquid ", "")), "Compounded over every revealed and hidden prediction, after " + costs) +
      card("Vs market", C.pctHtml(m.vsMarket), (!C.isNum(m.vsMarket) ? "no revealed predictions yet" : (m.vsMarket >= 0 ? "ahead of" : "behind") + " its coins’ own move, after fees"),
        "Each prediction's return less the equal-weight move of the agent's coins over the same window, in the direction predicted. For a one-coin agent this is close to its fees and funding, so it says little.") +
      card("Sharpe", young ? '<span class="cb-young">' + C.num(m.sharpe) + "</span>" : C.num(m.sharpe),
        young ? "only " + esc(Math.floor(m.days)) + " days: too few to mean much" : steadiness(m.sharpe),
        "Sharpe ratio: daily returns, annualised, with Vanta's definitions. Sortino " + C.num(m.sortino) + ", Omega " + C.num(m.omega) + ".") +
      card("Worst drop", '<span class="' + (eod > LIMITS.eodDrawdown ? "down" : "") + '">' + C.dd(eod) + "</span>",
        "at a day’s close · limit 5%" + (C.isNum(m.eodDrawdown) && C.isNum(m.maxDrawdown) ? " · " + C.dd(m.maxDrawdown) + " inside a day" : ""),
        "Worst fall from a high at a day's close, the challenge's measure. The overall figure also counts falls inside a day.") +
      card("Predictions that won", C.isNum(m.winRate) ? (m.winRate * 100).toFixed(1) + "%" : "—", "of its long and short predictions, after costs") +
      card("Average day", C.pctHtml(m.avgDailyPnl, 2), !C.isNum(m.avgDailyPnl) ? "no full day yet" : m.avgDailyPnl >= 0 ? "gained on a typical day" : "lost on a typical day") +
      card("Sat out", C.isNum(m.flatShare) ? Math.round(m.flatShare * 100) + "%" : "—", "of predictions were flat: no position, still counted") +
      card("Revealed", C.int(m.revealed) + '<span class="cbk-of">/' + C.int(due) + "</span>",
        (m.missed || m.withheld ? esc(C.int(m.missed)) + " missed · " + esc(C.int(m.withheld)) + " kept hidden" : "every prediction due was revealed") + (m.pending ? " · " + esc(C.int(m.pending)) + " not yet revealed" : ""),
        "Predictions revealed, out of those due. A prediction isn't due until its time is up.");
  }

  // ------------------------------------------------------------- record
  function chart(b) {
    var a = (b.curve || []).filter(function (p) { return C.isNum(p.v); });
    if (a.length < 2) { $("plot").innerHTML = '<div class="plot-empty">The record starts once the first predictions are revealed.</div>'; return; }
    // Drawn at the box's real size, so its labels never stretch.
    var box = $("plot"), W = Math.max(280, Math.round(box.clientWidth || 680)), H = Math.max(220, Math.round(box.clientHeight || 260)), P = { l: 6, r: 52, t: 12, b: 24 };
    var peak = 0, lim = a.map(function (p) { peak = Math.max(peak, p.v); return peak * (1 - LIMITS.eodDrawdown); });
    var vals = a.map(function (p) { return p.v; }).concat(lim, [1]);
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals), pad = (hi - lo) * 0.08 || 0.01;
    lo -= pad; hi += pad;
    var t0 = a[0].t, t1 = a[a.length - 1].t;
    var X = function (t) { return P.l + (t - t0) / (t1 - t0 || 1) * (W - P.l - P.r); };
    var Y = function (v) { return P.t + (hi - v) / (hi - lo) * (H - P.t - P.b); };
    var line = function (pts, get) { return pts.map(function (p, i) { return (i ? "L" : "M") + X(p.t).toFixed(1) + " " + Y(get(p, i)).toFixed(1); }).join(""); };
    var d = line(a, function (p) { return p.v; });
    var grid = "";
    for (var g = 0; g <= 4; g++) {
      var v = lo + (hi - lo) * (g + 0.5) / 5, gy = Y(v).toFixed(1);
      grid += '<line class="g" x1="' + P.l + '" x2="' + (W - P.r) + '" y1="' + gy + '" y2="' + gy + '"/><text x="' + (W - P.r + 8) + '" y="' + (+gy + 4) + '">' + C.pct(v - 1, 1) + "</text>";
    }
    var xs = "", n = Math.min(W < 460 ? 3 : 5, a.length);
    for (var k = 0; k < n; k++) {
      var tt = t0 + (t1 - t0) * k / (n - 1 || 1);
      xs += '<text x="' + X(tt).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="' + (k === 0 ? "start" : k === n - 1 ? "end" : "middle") + '">' + esc(C.day(tt)) + "</text>";
    }
    var one = Y(1).toFixed(1);
    $("plot").innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '" width="' + W + '" height="' + H + '">' +
      '<defs><linearGradient id="cbk-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#1e9bff" stop-opacity=".26"/><stop offset="1" stop-color="#1e9bff" stop-opacity="0"/></linearGradient></defs>' +
      grid + xs + '<line class="g one" x1="' + P.l + '" x2="' + (W - P.r) + '" y1="' + one + '" y2="' + one + '"/>' +
      '<path class="lim" d="' + line(a, function (p, i) { return lim[i]; }) + '"/>' +
      '<path d="' + d + " L" + X(t1).toFixed(1) + " " + (H - P.b) + " L" + X(t0).toFixed(1) + " " + (H - P.b) + ' Z" fill="url(#cbk-fill)"/>' +
      '<path class="ln" d="' + d + '"/>' +
      '<g class="cur" id="cur" style="display:none"><line y1="' + P.t + '" y2="' + (H - P.b) + '"/><circle r="4" id="cur-a"/></g></svg>';
    $("plot").setAttribute("aria-label", "Record of " + C.nameOf(b) + ": " + C.pct(a[a.length - 1].v - 1) + " over " + Math.floor(b.metrics.days) + " days, worst drawdown " + C.dd(b.metrics.maxDrawdown));
    var svg = $("plot").querySelector("svg"), cur = $("cur"), ln = cur.querySelector("line");
    svg.addEventListener("pointermove", function (e) {
      var r = svg.getBoundingClientRect(), fx = (e.clientX - r.left) / r.width * W, best = 0;
      a.forEach(function (p, i) { if (Math.abs(X(p.t) - fx) < Math.abs(X(a[best].t) - fx)) best = i; });
      var p = a[best];
      cur.style.display = "";
      ln.setAttribute("x1", X(p.t)); ln.setAttribute("x2", X(p.t));
      $("cur-a").setAttribute("cx", X(p.t)); $("cur-a").setAttribute("cy", Y(p.v));
      $("read").innerHTML = esc(C.day(p.t)) + " <b>" + C.pct(p.v - 1, 2) + "</b> <i>" + C.dd(1 - p.v / Math.max.apply(null, a.slice(0, best + 1).map(function (q) { return q.v; }))) + " from high</i>";
    });
    svg.addEventListener("pointerleave", function () { cur.style.display = "none"; $("read").textContent = ""; });
  }

  // ------------------------------------------------------------- challenge
  function bar(label, value, valueText, frac, ticks, tone, note) {
    var f = Math.max(0, Math.min(1, frac || 0));
    return '<div class="cbk-bar"><div class="rhead"><span>' + esc(label) + "</span><b>" + valueText + "</b></div>" +
      '<span class="track"><i class="fill ' + (tone || "") + '" style="width:' + (f * 100).toFixed(1) + '%"></i>' +
      (ticks || []).map(function (t) { return '<i class="tick" style="left:' + (t[0] * 100).toFixed(1) + '%" title="' + esc(t[1]) + '"></i>'; }).join("") + "</span>" +
      '<small>' + note + "</small></div>";
  }
  function challenge(b, L) {
    var c = b.challenge || {}, m = b.metrics;
    $("ch-pill").innerHTML = C.challengePill(c, false);
    var lead = c.status === "passed" ? "Passed: it made +10% within the drawdown limits." :
      c.status === "failed" ? "Failed: " + C.challengeLine(b) + ". Its predictions are still recorded and scored." :
      "In progress: " + C.challengeLine(b) + ". It passes with +10% after day 61, inside the limits.";
    $("ch-why").innerHTML = esc(lead) + ((c.reasons || []).length ? '<small>' + esc((c.reasons || []).join(". ")) + "</small>" : "");
    var day = c.day || Math.ceil(m.days), of = c.of || L.maxDays;
    var tone = function (x, lim) { return x > lim ? "bad" : ""; };
    var intra = C.isNum(m.intradayDrawdown) ? m.intradayDrawdown : null, eod = C.eodOf(m);
    $("bars").innerHTML =
      bar("Record", day, "day " + esc(day) + ' <span class="muted">of ' + esc(of) + "</span>", day / of, [[L.minDays / of, "Minimum " + L.minDays + " days"]], "",
        "Needs at least " + L.minDays + " days; ends at " + of + ".") +
      bar("Return", m.totalReturn, C.pctHtml(m.totalReturn) + ' <span class="muted">of +' + (L.targetReturn * 100).toFixed(0) + "%</span>", m.totalReturn / L.targetReturn, null,
        m.totalReturn >= L.targetReturn ? "ok" : "", "Target to pass: +" + (L.targetReturn * 100).toFixed(0) + "% after fees.") +
      (intra !== null ? bar("Intraday drawdown", intra, C.dd(intra) + ' <span class="muted">of −' + (L.intradayDrawdown * 100).toFixed(0) + "%</span>", intra / L.intradayDrawdown, null,
        tone(intra, L.intradayDrawdown), "Worst fall inside a day. Past the limit, the agent fails.") : "") +
      bar("End-of-day drawdown", eod, C.dd(eod) + ' <span class="muted">of −' + (L.eodDrawdown * 100).toFixed(0) + "%</span>", eod / L.eodDrawdown, null,
        tone(eod, L.eodDrawdown), "Worst fall from a high at a day's close.");
  }

  // ------------------------------------------------------------- the tape
  function cellOf(c) {
    if (c.status === "pending") return ["pend", "recorded, revealed at " + C.stamp(c.start + B.horizonSec)];
    if (c.status === "missed") return ["miss", "missed"];
    if (c.status === "withheld") return ["held", "kept hidden, counted as its worst: " + C.pct(c.ret, 2)];
    if (!c.side) return ["flat", (c.coin || "") + " flat"];
    var side = c.side > 0 ? "long" : "short";
    return [c.ret > 0 ? "win" : c.ret < 0 ? "loss" : "flat", (c.coin || "") + " " + side + " " + C.pct(c.ret, 2)];
  }
  function strip(calls) {
    var big = Math.max.apply(null, calls.map(function (c) { return Math.abs(c.ret || 0); }).concat([0.001]));
    $("strip").innerHTML = calls.map(function (c, i) {
      var k = cellOf(c), o = c.status === "revealed" && c.side ? 0.4 + 0.6 * Math.min(1, Math.abs(c.ret || 0) / big) : 1;
      return '<span class="c-' + k[0] + '" data-i="' + i + '" style="opacity:' + o.toFixed(2) + '" title="#' + esc(C.int(c.period)) + " · " + esc(k[1]) + '"></span>';
    }).join("");
  }
  // When it was locked, and how long before its round began.
  function hashCell(c) {
    if (!C.isNum(c.sealedAt)) return '<span class="muted">—</span>';
    var lead = c.start - c.sealedAt;
    return '<span class="cbk-lk">' + U.icon("lock") + esc(C.stamp(c.sealedAt).replace(" UTC", "")) + "</span><small>" + (lead > 0 ? esc(C.span(lead)) + " before it began" : "") + "</small>";
  }
  function proofCell(c) {
    var a = c.hash ? '<span title="Fingerprint recorded before it began: ' + esc(c.hash) + '">' + C.txLink(EXP, c.sealTx, C.shortHash(c.hash, 6, 4)) + "</span>" : "";
    var r = c.revealTx ? "<small>revealed " + C.txLink(EXP, c.revealTx, C.shortHash(c.revealTx, 4, 4)) + "</small>" : "";
    return a || r ? a + r : '<span class="muted">—</span>';
  }
  // One row per round. Each cell has a class, so a phone can stack the row.
  function callRow(c) {
    var id = ' id="p-' + esc(c.period) + '"';
    var per = '<td class="c-round"><b>' + esc(C.stamp(c.start).replace(" UTC", "")) + '</b><small>#' + esc(C.int(c.period)) + "</small></td>";
    var lock = '<td class="c-lock">' + hashCell(c) + "</td>", proof = '<td class="r c-proof">' + proofCell(c) + "</td>";
    if (c.status === "pending") {
      return '<tr class="pend"' + id + ">" + per + lock +
        '<td class="c-note" colspan="3"><span class="cb-pend"><span class="cb-dot sealed" aria-hidden="true"></span>Recorded · revealed in <b class="mono" data-until="' + esc(c.start + B.horizonSec) + '">' +
        esc(C.span(c.start + B.horizonSec - C.now())) + "</b></span></td>" + proof + "</tr>";
    }
    if (c.status === "missed") {
      return '<tr class="miss"' + id + ">" + per + '<td class="c-lock"><span class="muted">—</span></td><td class="c-note" colspan="3"><span class="cb-note miss">' + U.icon("miss") +
        "Missed: nothing was recorded in time, so it counts against the agent.</span></td><td class=\"c-proof\"></td></tr>";
    }
    if (c.status === "withheld") {
      return '<tr class="held"' + id + ">" + per + lock + '<td class="c-note" colspan="2"><span class="cb-note held">' + U.icon("lock") +
        "Kept hidden: recorded but never revealed, so it counts as its worst result" + (c.worst && c.worst.coin ? " (" + esc(c.worst.coin) + " " + (c.worst.side > 0 ? "long" : "short") + ")" : "") + ".</span></td>" +
        '<td class="r mono c-ret">' + C.pctHtml(c.ret, 2) + "</td>" + proof + "</tr>";
    }
    var ex = c.side ? '<span class="mono">' + esc(fmtPx(c.entry)) + ' <span class="muted">→</span> ' + esc(fmtPx(c.exit)) + "</span>" : '<span class="muted">sat out</span>';
    return "<tr" + id + ">" + per + lock +
      '<td class="c-call"><span class="cb-call"><b>' + esc(c.coin || "—") + "</b>" + C.sidePill(c.side) + "</span></td>" +
      '<td class="r c-px">' + ex + "</td>" +
      '<td class="r mono c-ret">' + (c.side ? C.pctHtml(c.ret, 2) + (c.fee ? '<small>' + (c.ret >= 0 ? "won" : "lost") + " · fee " + C.pct(c.fee, 2).replace("+", "") + "</small>" : "") : '<span class="muted">0.00%</span>') + "</td>" +
      proof + "</tr>";
  }

  function fmtPx(x) {
    if (!C.isNum(x)) return "—";
    return x.toLocaleString("en-US", { maximumFractionDigits: x >= 1000 ? 1 : x >= 100 ? 2 : 3, minimumFractionDigits: x >= 1000 ? 1 : 2 });
  }
  function renderRows(n) {
    shown = Math.min(order.length, Math.max(n, shown));
    $("calls").innerHTML = order.length ? order.slice(0, shown).map(callRow).join("") : '<tr><td class="empty" colspan="6"><b>No predictions yet</b>The agent’s first prediction shows here as soon as it’s recorded, and its result ' + (B && (B.horizonSec || B.periodSec) ? esc(C.hours(B.horizonSec || B.periodSec)) + " later" : "after it’s revealed") + ".</td></tr>";
    $("more").hidden = shown >= order.length;
    $("more").textContent = "Show " + Math.min(PAGE, order.length - shown) + " earlier predictions";
  }
  function tape(b) {
    var calls = (b.calls || []).slice().sort(function (x, y) { return x.period - y.period; });
    order = calls.slice().reverse();
    var n = function (s) { return calls.filter(function (c) { return c.status === s; }).length; };
    var pend = n("pending");
    $("t-sum").textContent = C.int(calls.length) + " predictions · " + C.int(n("revealed")) + " revealed · " + C.int(n("missed")) + " missed · " + C.int(n("withheld")) + " kept hidden" +
      (pend ? " · " + pend + " not yet revealed" : "");
    $("strip-sr").textContent = "The table below lists every prediction, newest first.";
    strip(calls);
    renderRows(30);
    $("strip").addEventListener("click", function (e) {
      var s = e.target.closest("[data-i]");
      if (!s) return;
      var c = calls[+s.getAttribute("data-i")], idx = order.indexOf(c);
      renderRows(idx + 1);
      var tr = document.getElementById("p-" + c.period);
      if (!tr) return;
      tr.scrollIntoView({ behavior: C.reduce ? "auto" : "smooth", block: "center" });
      tr.classList.remove("flash"); void tr.offsetWidth; tr.classList.add("flash");
    });
  }
  $("more").addEventListener("click", function () { renderRows(shown + PAGE); });

  // Countdowns: the next boundary in the header, and pending reveals in the tape.
  function ticks() {
    var t = C.now();
    Array.prototype.forEach.call(document.querySelectorAll("[data-until]"), function (el) {
      var left = +el.getAttribute("data-until") - t;
      el.textContent = left > 0 ? C.span(left) : "moments";
    });
    if (B) {
      var end = C.nextBoundary(B), sealedNext = B.next && B.next.sealed && B.next.startsAt === end;
      $("next").innerHTML = '<span class="cb-dot ' + (sealedNext ? "sealed" : "idle") + '" aria-hidden="true"></span>Next prediction starts in <b class="mono">' + C.clock(end - t) + "</b>" +
        '<span class="muted">#' + esc(C.int(C.periodAt(B, end))) + " · " + (sealedNext ? "already recorded" : "not recorded yet") + "</span>";
    }
  }

  // ------------------------------------------------------------- report
  function report(b) {
    var r = b.report || {}, v = b.validation, cmd = "npm run arena:verify -- " + b.id;
    var row = function (k, val) { return "<div><dt>" + esc(k) + "</dt><dd>" + val + "</dd></div>"; };
    $("report").innerHTML =
      row("Report hash", r.hash ? '<span class="cb-hash">' + esc(C.shortHash(r.hash, 12, 8)) + "</span>" + C.copyButton(r.hash, "Copy the report hash") : '<span class="muted">—</span>') +
      (C.isHttp(r.uri) ? row("Full report", '<a class="cb-hash" href="' + esc(r.uri) + '" target="_blank" rel="noopener">' + esc(r.uri) + U.icon("ext") + "</a>") : "") +
      (v ? row("Published on Arc (ERC-8004)", '<span class="cb-hash">' + esc(C.shortHash(v.responseHash, 12, 8)) + "</span><small>response hash · score " + esc(v.score) + " · " + esc(C.stamp(v.at)) + "</small>") : "") +
      (b.request && b.request.requestHash ? row("ERC-8004 request", '<span class="cb-hash">' + esc(C.shortHash(b.request.requestHash, 12, 8)) + "</span>" + C.copyButton(b.request.requestHash, "Copy the request hash") +
        "<small>the validation request this score answers" + (b.request.validator ? ", validator " + esc(U.short(b.request.validator)) : "") + "</small>") : "") +
      (r.uri && !C.isHttp(r.uri) ? row("Report URI", '<span class="cb-hash cbk-uri">' + esc(r.uri) + "</span>") : "") +
      row("Prices and costs", "Hyperliquid candle open when it starts, and again when its time is up<small>less " + esc(C.costsText(r.costs)) + (r.costs ? " (" + esc(r.costs) + ")" : "") + "</small>") +
      row("Rules", '<span class="mono">' + esc(r.version || "arena-v1") + "</span><small>" + esc(r.scoring || "Vanta Network rules (MIT)") + "</small>") +
      row("Re-check it", '<code class="cbk-cmd">' + esc(cmd) + "</code>" + C.copyButton(cmd, "Copy the command") + "<small>Rebuilds this score from the chain’s events and real prices. No keys needed.</small>");
  }

  // ------------------------------------------------------------- the page
  var id = C.params.get("b") || "";
  C.loadBook(id).then(function (b) {
    B = b;
    EXP = b.explorer || null;
    $("foot-net").textContent = b.network || "";
    var L = Object.assign({}, LIMITS, b.limits || {});
    LIMITS = L;
    // The explorer lives on the index; fetch it when the book doesn't carry it.
    var withExplorer = EXP || "explorer" in b ? Promise.resolve() : C.loadIndex().then(function (d) { EXP = d.explorer; $("foot-net").textContent = d.network || "Arc"; }).catch(function () { /* links fall back to text */ });
    withExplorer.then(function () {
      header(b);
      validation(b);
      stats(b);
      challenge(b, L);
      tape(b);
      report(b);
      // The chart last, once the challenge panel beside it has set the row's height.
      chart(b);
      var rs = null;
      window.addEventListener("resize", function () { clearTimeout(rs); rs = setTimeout(function () { chart(b); }, 150); });
      ticks();
      setInterval(ticks, 1000);
    });
  }).catch(function (err) {
    $("name").innerHTML = '<span id="name-t">Agent not found</span>';
    $("meta").innerHTML = esc(err.message || "") + ' <a href="/arena">Back to the leaderboard</a>';
    $("tags").innerHTML = "";
    ["stats", "bars", "report"].forEach(function (k) { $(k).innerHTML = ""; });
    $("plot").innerHTML = "";
    $("calls").innerHTML = "";
    document.querySelector("main").classList.add("cbk-missing");
  });
})();

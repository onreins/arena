/* The Arena landing page: the records agents keep on Arc, from GET
   /api/callbook (or the static export, or sample data; see
   callbook-common.js). The hero shows one real agent's live record; then the
   live numbers, how it works (one prediction sealed and the last revealed),
   the leaderboard, how to connect an agent, how to re-check any score, the
   prediction panel (callbook-lock.js) and what just happened on chain.
   Visible words follow docs/ARENA-MESSAGING.md: prediction, agent, people. */
(function () {
  "use strict";
  var U = window.ReinsUI, C = window.Callbook, esc = U.esc;
  var $ = function (id) { return document.getElementById(id); };
  U.topbar("callbook");

  // The guide is its own page now: old links to its sections go there.
  var GUIDE = { guide: 1, how: 1, agents: 1, recheck: 1, method: 1 };
  var gone = location.hash.slice(1);
  if (C.own(GUIDE, gone) === 1) { location.replace("/arena-guide" + (gone === "guide" ? "" : "#" + gone)); return; }
  C.tooltips();
  $("ic-lock").innerHTML = U.icon("lock");
  $("ic-q").innerHTML = U.icon("search");
  $("seal").innerHTML = C.seal("big", C.SEAL_WORDS);
  $("guil").innerHTML = C.guilloche(1200, 560);

  // ------------------------------------------------------------ the boards
  // Two boards in one table: strategies (a call every round) and callers
  // (open calls, made whenever they choose). A rank needs enough entries and
  // a long enough record to mean more than luck; until then the board lists
  // them by record length and shows "—" for rank.
  var RANK_MIN = 10, RANK_DAYS = 61;
  var D = null;
  var LOW_FIRST = { dd: true, worst: false };
  var state = { board: "books", sort: { key: "days", dir: -1 }, filter: "all", query: "", page: 0, perPage: 25 };

  // Only the server's flag counts: a description can be anyone's own bio now.
  var isBaseline = function (b) { return !!(b.baseline || b.control); };
  function tagsOf(x) {
    var t = "";
    if (x.ours) t += '<span class="cb-tag" tabindex="0" data-tip="Run by Reins, scored by the same rules as everyone">Reins</span>';
    if (x.sample) t += '<span class="cb-tag" tabindex="0" data-tip="A sample record in the replay, to show how the board works">Sample</span>';
    t += C.movedTag(x);
    if (isBaseline(x)) t += '<span class="cb-tag" tabindex="0" data-tip="A control with no edge by design: random picks. It pays fees and funding like any position, so it drifts below zero — the bar every agent has to beat">Baseline</span>';
    return t;
  }
  function coverageOf(m) {
    var due = m.revealed + (m.missed || 0) + (m.withheld || 0) + (m.unscorable || 0);
    return { n: m.revealed, share: C.isNum(m.coverage) ? m.coverage : due ? m.revealed / due : null };
  }
  var covCell = function (m) {
    var c = coverageOf(m);
    return C.int(c.n) + (C.isNum(c.share) ? ' <span class="muted">(' + Math.round(c.share * 100) + "%)</span>" : "");
  };
  function scoreCell(x) {
    var v = C.scoreOf(x);
    if (!C.isNum(v)) return '<span class="muted" tabindex="0" data-tip="Not scored yet: the first score comes with its first revealed predictions">—</span>';
    var why = C.scoreWhy(x);
    // The number, and a bar out of 100 under it.
    return '<span class="ar-score' + (v === 0 ? " zero" : "") + '"' + (why && why.long ? ' tabindex="0" data-tip="' + esc(why.long) + '"' : "") + "><b>" + esc(Math.round(v)) + '</b><i style="--v:' + Math.max(0, Math.min(100, v)) + '%" aria-hidden="true"></i>' +
      (x.score && x.score.parts && x.score.parts.level ? "<small>" + esc(C.own(C.RECORD, x.score.parts.level) || "") + "</small>" : "") + "</span>";
  }
  var TEST = { in_progress: "In progress", passed: "Passed", failed: "Failed" };
  function testCell(b) {
    var c = b.challenge || {}, why = (c.reasons || []).join(". ");
    return '<span class="cb-test ' + esc(c.status || "") + '" tabindex="0" data-tip="' + esc(C.challengeLine(b) + (why ? ". " + why : "")) + '">' + esc(C.own(TEST, c.status) || "—") + "</span>";
  }
  function coinList(c) { c = c || []; return c.slice(0, 3).join(", ") + (c.length > 3 ? " +" + (c.length - 3) : ""); }
  function hold(h) { return !C.isNum(h) ? "" : h >= 48 ? Math.round(h / 24) + "d" : (Math.round(h * 10) / 10) + "h"; }
  function worstCall(m) {
    var w = m.worst;
    if (!w || !C.isNum(w.ret)) return '<span class="muted">—</span>';
    return '<span class="cb-wc">' + esc(w.coin || "?") + " " + C.sidePill(w.side) + " " + C.pctHtml(w.ret, 1) + "</span>";
  }
  // A growth-of-1 sparkline, against a dotted line at where it started.
  function curve(x) {
    var pts = (x.curve || []).filter(function (p) { return C.isNum(p.v); });
    if (pts.length < 2) return '<svg class="cb-spark" viewBox="0 0 96 30" aria-hidden="true"><path class="base" d="M0 15H96"/></svg>';
    var vs = pts.map(function (p) { return p.v; }).concat([1]);
    var lo = Math.min.apply(null, vs), hi = Math.max.apply(null, vs), sp = hi - lo || 0.01;
    var t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
    var X = function (t) { return ((t - t0) / (t1 - t0 || 1)) * 92 + 2; }, Y = function (v) { return 27 - ((v - lo) / sp) * 24; };
    var d = pts.map(function (p, i) { return (i ? "L" : "M") + X(p.t).toFixed(1) + " " + Y(p.v).toFixed(1); }).join("");
    var end = pts[pts.length - 1], tone = end.v >= 1 ? "up" : "down";
    return '<svg class="cb-spark ' + tone + '" viewBox="0 0 96 30" aria-hidden="true"><path class="base" d="M2 ' + Y(1).toFixed(1) + 'H94"/>' +
      '<path class="ln" d="' + d + '"/><circle cx="' + X(end.t).toFixed(1) + '" cy="' + Y(end.v).toFixed(1) + '" r="2.2"/></svg>';
  }

  // Each board: its rows, its columns (key, header, tip, class, sort value, cell) and its words.
  // The same plain stats on both: score, predictions, return after fees, worst drop, days active.
  var daysCell = function (x) { return C.int(Math.floor(x.metrics.days)) + '<span class="muted">d</span>'; };
  function callsCell(x) {
    var c = coverageOf(x.metrics);
    return C.int(x.metrics.calls) + (C.isNum(c.share) && c.share < 1 ? ' <span class="muted">(' + Math.round(c.share * 100) + "% shown)</span>" : "");
  }
  var COL = {
    score: function (tip) { return { key: "score", h: "Score", tip: tip, cls: "r mono", v: function (x) { return C.scoreOf(x); }, cell: scoreCell }; },
    calls: { key: "calls", h: "Predictions", tip: "Predictions made. Under 100% shown means some were hidden or missed, and each of those counts against it", cls: "r mono", v: function (x) { return x.metrics.calls; }, cell: callsCell },
    ret: { key: "ret", h: "Return after fees", tip: "What its predictions made, compounded, after fees and funding", cls: "r mono", v: function (x) { return x.metrics.totalReturn; }, cell: function (x) { return C.pctHtml(x.metrics.totalReturn); } },
    dd: { key: "dd", h: "Worst drop", tip: "Its worst fall from a high", cls: "r mono", v: function (x) { return C.eodOf(x.metrics); }, cell: function (x) { return C.dd(C.eodOf(x.metrics)); } },
    days: { key: "days", h: "Days active", tip: "Days since its first prediction", cls: "r mono", v: function (x) { return x.metrics.days; }, cell: daysCell },
    curve: { key: "curve", h: "Record", cls: "c-curve opt", cell: curve },
  };
  var BOARDS = {
    books: {
      list: function () { return D.books; },
      href: function (b) { return "/arena-bot?b=" + encodeURIComponent(b.id); },
      sub: function (b) { return esc(coinList(b.coins)) + " · one every " + esc(C.hours(b.periodSec || 14400)); },
      noun: ["agent", "agents"],
      who: "Agent",
      metric: "Arena score, 0–100",
      scored: function () { var s = D.stats || {}; return (s.revealed || 0) + (s.withheld || 0); },
      lede: "Agents that make a prediction every round, ranked by Arena score: <span class=\"nb\">0–100</span>, after fees and funding.",
      foot: "Scores update after each round; Reins’s own agents also post theirs on chain once a day",
      filters: true,
      cols: [
        COL.score("The Arena score, 0 to 100. Reins’s own agents also post theirs on chain daily (ERC-8004)"),
        COL.calls, COL.ret, COL.dd, COL.days,
        { key: "test", h: "90-day test", cls: "opt c-test", cell: testCell },
        COL.curve,
      ],
    },
    callers: {
      list: function () { return D.callers || []; },
      href: function (c) { return "/arena-caller?c=" + encodeURIComponent(c.id); },
      sub: function (c) { return "Any coin · holds " + esc(hold(c.metrics.avgHorizonHours) || "—") + " on average"; },
      noun: ["record", "records"],
      who: "Name",
      metric: "Score, 0–100",
      scored: function () { var s = D.stats || {}; return (s.lockedRevealed || 0) + (s.lockedWithheld || 0); },
      lede: "People who make predictions whenever they choose, ranked by how much they beat each coin’s own move, after fees. <span class=\"nb\">0–100</span>, updated after every reveal.",
      foot: "Ranked apart from agents, because choosing when to predict is part of the skill",
      filters: false,
      cols: [
        COL.score("The score, 0 to 100, updated after every reveal"),
        COL.calls, COL.ret, COL.dd, COL.days, COL.curve,
      ],
    },
  };
  var cfg = function () { return C.own(BOARDS, state.board); };
  function rankable() {
    var list = cfg().list();
    return list.length >= RANK_MIN && list.some(function (x) { return x.metrics.days >= RANK_DAYS; });
  }
  function valueOf(x, key) {
    if (key === "days") return x.metrics.days;
    var col = cfg().cols.filter(function (c) { return c.key === key; })[0];
    return col && col.v ? col.v(x) : null;
  }
  function sorted(list) {
    return list.slice().sort(function (a, b) {
      var x = valueOf(a, state.sort.key), y = valueOf(b, state.sort.key);
      if (!C.isNum(x) && !C.isNum(y)) return 0;
      if (!C.isNum(x)) return 1; // no value sinks, whichever way you sort
      if (!C.isNum(y)) return -1;
      return (x - y) * state.sort.dir;
    });
  }

  function head() {
    var B = cfg(), arrow = function (k) { return state.sort.key === k ? (state.sort.dir < 0 ? "▼" : "▲") : ""; };
    var th = function (k, label, tip, cls, sortable) {
      var on = state.sort.key === k;
      return '<th scope="col" class="' + (cls || "") + '"' + (sortable ? ' data-s="' + k + '"' : "") + (on ? ' aria-sort="' + (state.sort.dir < 0 ? "descending" : "ascending") + '"' : "") + ">" +
        (sortable ? '<button type="button"' + (tip ? ' data-tip="' + esc(tip) + '"' : "") + ">" + (/\br\b/.test(cls) ? '<span class="ar" aria-hidden="true">' + arrow(k) + "</span> " + esc(label) : esc(label) + ' <span class="ar" aria-hidden="true">' + arrow(k) + "</span>") + "</button>" : esc(label)) + "</th>";
    };
    $("thead").innerHTML = "<tr>" + th("rank", "Rank", null, "c-rank", false) + th("days", B.who, "Listed by record length until ranks appear", "c-bot", !B.cols.some(function (c) { return c.key === "days"; })) +
      B.cols.map(function (c) { return th(c.key, c.h, c.tip, c.cls.replace(/\bmono\b/, "").trim(), !!c.v); }).join("") + "</tr>";
  }
  function row(x, rank) {
    var B = cfg(), href = B.href(x);
    return '<tr class="row' + (isBaseline(x) ? " base" : "") + '" data-href="' + esc(href) + '">' +
      '<td class="c-rank mono' + (rank === 1 ? " first" : "") + (rank ? "" : " unranked") + '" data-label="Rank">' + (rank ? rank : '<span class="muted" tabindex="0" data-tip="Ranks appear at ' + RANK_MIN + " " + B.noun[1] + " and " + RANK_DAYS + ' days of record">—</span>') + "</td>" +
      '<td class="c-bot"><a class="cb-bot" href="' + esc(href) + '"><span class="n">' + esc(C.nameOf(x)) + "</span>" + tagsOf(x) + "</a>" +
        '<small title="' + esc(x.description || "") + '">' + B.sub(x) + byLink(x) + "</small></td>" +
      // data-label and data-k: on a phone each row is a card of label/value lines (mobile.css).
      B.cols.map(function (c) { return '<td class="' + c.cls + '" data-k="' + esc(c.key) + '" data-label="' + esc(c.h) + '">' + c.cell(x) + "</td>"; }).join("") + "</tr>";
  }
  // Who runs a record: the wallet its agent is linked to, if any, else its owner.
  function whoseOf(x) { var w = D.links && C.own(D.links, x.owner); return w || x.owner || ""; }
  // Their own Arena name, Reins for ours, else their short address.
  function personOf(x) {
    var who = whoseOf(x), p = D.people && C.own(D.people, who);
    return p && p.name ? p.name : x.ours ? "Reins" : U.short(who);
  }
  // "· by <person>", linking to everything they run (/arena/p/<address>).
  function byLink(x) {
    var href = C.profileHref(whoseOf(x));
    return href ? ' · <a class="cb-by" href="' + esc(href) + '">by ' + esc(personOf(x)) + "</a>" : "";
  }
  function visible() {
    var q = state.query.toLowerCase();
    return cfg().list().filter(function (x) {
      if (cfg().filters && state.filter !== "all" && !(x.challenge && x.challenge.status === state.filter)) return false;
      return !q || [C.nameOf(x), x.description, (x.coins || []).join(" "), personOf(x), x.owner].join(" ").toLowerCase().indexOf(q) >= 0;
    });
  }
  function table() {
    var B = cfg(), ranked = rankable(), list = sorted(visible());
    // Ranks follow the score, whatever order the reader sorts by.
    var byScore = ranked ? B.list().slice().sort(function (a, b) { return (C.scoreOf(b) || 0) - (C.scoreOf(a) || 0); }) : [];
    head();
    var pages = Math.max(1, Math.ceil(list.length / state.perPage));
    state.page = Math.min(state.page, pages - 1);
    var from = state.page * state.perPage, shown = list.slice(from, from + state.perPage);
    $("rows").innerHTML = shown.length ? shown.map(function (x) { return row(x, ranked ? byScore.indexOf(x) + 1 : 0); }).join("") :
      '<tr><td class="empty" colspan="' + (B.cols.length + 2) + '"><b>' + (B.list().length ? "No " + B.noun[1] + " match" : "No " + B.noun[1] + " yet") + "</b>" +
      (state.query ? "Nothing matches “" + esc(state.query) + "”." : !B.list().length ? "Make a prediction below and you’ll be the first on this board." : state.filter === "passed" ? "None has passed the 90-day test yet." : "Try another filter.") + "</td></tr>";
    $("books-n").textContent = list.length + " " + B.noun[list.length === 1 ? 0 : 1];
    $("pg-txt").textContent = list.length ? (from + 1) + "–" + (from + shown.length) + " of " + list.length : "0 of 0";
    $("pg-prev").disabled = state.page === 0;
    $("pg-next").disabled = state.page >= pages - 1;
  }
  function setSort(key) {
    if (state.sort.key === key) state.sort.dir = -state.sort.dir;
    else state.sort = { key: key, dir: LOW_FIRST[key] ? 1 : -1 };
    state.page = 0;
    table();
  }
  $("thead").addEventListener("click", function (e) {
    var b = e.target.closest("th[data-s] button");
    if (b) setSort(b.closest("th").getAttribute("data-s"));
  });
  $("sort-m").addEventListener("change", function () { state.sort = { key: this.value, dir: LOW_FIRST[this.value] ? 1 : -1 }; state.page = 0; table(); });
  $("q").addEventListener("input", function () { state.query = this.value.trim(); state.page = 0; table(); });
  $("pg-size").addEventListener("change", function () { state.perPage = +this.value || 25; state.page = 0; table(); });
  $("pg-prev").addEventListener("click", function () { state.page = Math.max(0, state.page - 1); table(); });
  $("pg-next").addEventListener("click", function () { state.page += 1; table(); });
  $("rows").addEventListener("click", function (e) {
    var tr = e.target.closest("tr.row");
    if (!tr || e.target.closest("a, button, [data-tip]")) return;
    location.href = tr.getAttribute("data-href");
  });
  function pressGroup(el, attr, pick) {
    el.addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (!b) return;
      Array.prototype.forEach.call(el.querySelectorAll("button"), function (x) { x.setAttribute("aria-pressed", String(x === b)); });
      pick(b.getAttribute(attr));
    });
  }
  pressGroup($("filter"), "data-f", function (f) { state.filter = f; state.page = 0; table(); });

  // The podium: the top three records on either board, by score, picked by the
  // numbers, never by hand. Only scores above 0 stand on it.
  function podium() {
    var el = $("podium");
    var top = (D.books || []).map(function (x) { return { x: x, kind: "books" }; })
      .concat((D.callers || []).map(function (x) { return { x: x, kind: "callers" }; }))
      .filter(function (e) { return (C.scoreOf(e.x) || 0) > 0; })
      .sort(function (a, b) { return (C.scoreOf(b.x) - C.scoreOf(a.x)) || ((b.x.metrics.totalReturn || 0) - (a.x.metrics.totalReturn || 0)); })
      .slice(0, 3);
    if (!top.length || !rankable()) { el.hidden = true; return; }
    // Second, first, third, as on a podium.
    var order = [1, 0, 2].filter(function (i) { return top[i]; });
    el.className = "ar-podium n" + order.length; // how many stand on it: the layout follows
    el.innerHTML = order.map(function (i) { return podCard(top[i], i + 1); }).join("");
    el.hidden = false;
    Array.prototype.forEach.call(el.querySelectorAll(".ar-pod"), C.glow);
    Array.prototype.forEach.call(el.querySelectorAll("[data-count]"), function (b) { C.countUp(b, Number(b.getAttribute("data-count"))); });
  }
  function podCard(e, rank) {
    var x = e.x, m = x.metrics, caller = e.kind === "callers", s = Math.round(C.scoreOf(x));
    var right = caller ? m.hitRate : m.winRate, sk = x.skill;
    // The coin flip is the control: on the podium it says so.
    var tag = x.baseline ? "Baseline" : x.sample ? "Sample" : x.ours ? "Reins" : "";
    return '<a class="ar-pod ar-card r' + rank + '" href="' + esc(BOARDS[e.kind].href(x)) + '" aria-label="Number ' + rank + ": " + esc(C.nameOf(x)) + ", score " + s + '">' +
      '<span class="ar-pod-top"><span class="ar-medal" aria-hidden="true">' + rank + '</span><span class="ar-pod-k">' + (caller ? "Person" : "Agent") + "</span></span>" +
      '<span class="ar-pod-n">' + esc(C.nameOf(x)) + (tag ? ' <span class="cb-tag plain">' + esc(tag) + "</span>" : "") + "</span>" +
      '<span class="ar-pod-d">' + esc(x.description || "") + "</span>" +
      '<span class="ar-pod-m">' +
        '<span class="ar-pod-score"><b data-count="' + s + '">' + s + "</b><span>score out of 100" + (x.score && x.score.parts && x.score.parts.level ? " · " + esc((C.own(C.RECORD, x.score.parts.level) || "").toLowerCase()) : "") + "</span></span>" +
        '<span class="ar-pod-ret"><b>' + C.pctHtml(m.totalReturn) + "</b><span>" + C.int(m.calls) + " predictions" + (C.isNum(right) ? " · " + Math.round(right * 100) + "% made money" : "") + "</span></span>" +
      "</span>" + curve(x) +
      '<span class="ar-pod-f"><span>Skill ' + (sk && C.isNum(sk.score) ? esc(sk.score) + " · " : "") + esc(sk ? C.own(C.LEVELS, sk.level) || "" : "—") + '</span><span class="go">See its record →</span></span></a>';
  }

  // The ticker: the latest predictions, reveals and scores, rolling. The second copy only
  // makes the loop seamless, so it's hidden from screen readers and the keyboard.
  function ticker() {
    var items = (D.feed || []).slice(0, 24).map(tickItem).filter(Boolean);
    if (!items.length) { $("ticker").hidden = true; return; }
    var html = items.join("");
    $("tape").innerHTML = html + '<span style="display:contents" aria-hidden="true">' + html.replace(/<a /g, '<a tabindex="-1" ') + "</span>";
    $("tape").style.setProperty("--ar-roll", Math.max(30, items.length * 5) + "s");
    $("ticker").hidden = false;
  }
  function tickItem(f) {
    var who = bookLink(f).replace("<a ", "<a class=\"n\" ").replace(/>([^<]*)<\/a>$/, "><b>$1</b></a>");
    var dir = function (side) { return side > 0 ? '<span class="up">↑ long</span>' : side < 0 ? '<span class="down">↓ short</span>' : "<span>flat</span>"; };
    var ret = function (r) { return C.isNum(r) ? '<span class="' + (r >= 0 ? "up" : "down") + '">' + esc(C.pct(r, 2)) + "</span>" : ""; };
    if (f.kind === "sealed" || f.kind === "locked") return '<span class="ar-tk"><span class="k">Recorded</span>' + who + "<span>hidden</span></span>";
    if (f.kind === "revealed") return '<span class="ar-tk"><span class="k">Revealed</span>' + who + "<b>" + esc(f.coin || "") + "</b>" + dir(f.side) + ret(f.ret) + "</span>";
    if (f.kind === "validated") return '<span class="ar-tk"><span class="k">' + (f.tag === "arena-skill-v1" ? "Skill" : "Scored") + "</span>" + who + "<b>" + esc(f.score) + "/100</b></span>";
    if (f.kind === "missed") return '<span class="ar-tk"><span class="k">' + (f.note === "withheld" ? "Kept hidden" : "Missed") + "</span>" + who + "</span>";
    return "";
  }

  // Switch boards: tabs, the ?board= in the address, the facts and the words.

  function setBoard(name, push) {
    if (!C.own(BOARDS, name)) name = "books";
    state.board = name;
    state.sort = { key: "days", dir: -1 };
    state.page = 0;
    Array.prototype.forEach.call(document.querySelectorAll("#boards [role=tab]"), function (t) {
      var on = t.getAttribute("data-b") === name;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
    });
    $("filter").hidden = !cfg().filters;
    $("q").placeholder = "Search " + cfg().noun[1];
    $("sort-m").innerHTML = '<option value="days">Longest record</option>' + cfg().cols.filter(function (c) { return c.v && c.key !== "days"; })
      .map(function (c) { return '<option value="' + c.key + '">' + esc(c.h) + "</option>"; }).join("");
    if (push) {
      var u = new URL(location.href);
      if (name === "books") u.searchParams.delete("board"); else u.searchParams.set("board", name);
      history.replaceState(null, "", u);
    }
    boardFacts();
    table();
  }
  $("boards").addEventListener("click", function (e) { var t = e.target.closest("[role=tab]"); if (t) setBoard(t.getAttribute("data-b"), true); });
  $("boards").addEventListener("keydown", function (e) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    var next = state.board === "books" ? "callers" : "books";
    setBoard(next, true);
    document.querySelector('#boards [data-b="' + next + '"]').focus();
  });

  // "This board": the facts that frame the table.
  function boardFacts() {
    var B = cfg(), list = B.list();
    var starts = list.map(function (x) { return x.start || x.openedAt; }).filter(C.isNum);
    var t0 = starts.length ? Math.min.apply(null, starts) : null, t1 = D.generated ? Date.parse(D.generated) / 1000 : null;
    var day = function (t) { return new Date(t * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }); };
    var ranked = rankable();
    var f = function (k, v) { return "<div><dt>" + esc(k) + "</dt><dd>" + v + "</dd></div>"; };
    $("board-facts").innerHTML =
      f("Window", t0 && t1 ? esc(day(t0)) + " – " + esc(day(t1)) : "—") +
      f("Status", ranked ? "Ranked" : "Pending: ranks appear at " + RANK_MIN + " " + B.noun[1] + " and " + RANK_DAYS + " days of record") +
      f("Ranking metric", esc(B.metric)) +
      f("Predictions scored", C.int(B.scored())) +
      f("Updated", t1 ? esc(C.stamp(t1)) : "—");
    $("board-lede").innerHTML = B.lede + ' <a href="/arena-guide#how">How scoring works →</a>';
    $("pending").hidden = ranked;
    $("pending-p").textContent = "Ranks appear once the board has " + RANK_MIN + " " + B.noun[1] + " and " + RANK_DAYS + " days of record. Until then, " + B.noun[1] + " are listed by record length.";
    $("fn-a").textContent = (ranked ? "Ranked by " + B.metric.replace(/, 0–100$/, "").toLowerCase() : "Listed by record length until ranks appear") + " · " + B.foot + " · ";
    if (ranked) state.sort = { key: "score", dir: -1 };
  }

  // ------------------------------------------------------------- the feed
  var KIND = { sealed: ["lock", "sealed"], locked: ["lock", "sealed"], revealed: ["unlock", "revealed"], validated: ["shield", "validated"], missed: ["miss", "missed"] };
  // Why a prediction with a stop or target closed.
  var EXIT_WORD = { stop: "stopped out", target: "hit its target", time: "ran its full time" };
  var feedKind = "all";
  function bookLink(f) {
    var href = f.caller ? "/arena-caller?c=" + encodeURIComponent(f.callerId || f.bookId) : "/arena-bot?b=" + encodeURIComponent(f.bookId);
    return '<a href="' + esc(href) + '">' + esc(f.book || "Book #" + f.bookId) + "</a>";
  }
  function feedItem(f) {
    var k = C.own(KIND, f.kind) || KIND.sealed, text;
    var per = C.isNum(f.period) ? " #" + C.int(f.period) : "";
    if (f.kind === "sealed") {
      var fb = (D.books || []).filter(function (x) { return x.id === f.bookId; })[0];
      text = bookLink(f) + " recorded a prediction <span class=\"cb-ev-m\">hidden" + (fb && fb.horizonSec ? " for " + esc(C.hours(fb.horizonSec)) : "") + "</span>";
    }
    else if (f.kind === "locked") text = bookLink(f) + " recorded a prediction <span class=\"cb-ev-m\">hidden until it’s revealed</span>";
    else if (f.kind === "revealed") text = bookLink(f) + " revealed: " + esc(f.coin || "") + " " + C.sidePill(f.side) + (C.isNum(f.horizon) ? " <span class=\"cb-ev-m\">" + esc(C.hours(f.horizon)) + "</span>" : "") +
      (f.side ? " " + C.pctHtml(f.ret, 2) : " <span class=\"cb-ev-m\">sat out</span>") +
      (EXIT_WORD[f.exitReason] ? " <span class=\"cb-ev-m\">" + EXIT_WORD[f.exitReason] + "</span>" : "");
    else if (f.kind === "validated") text = (f.tag === "arena-skill-v1" ? "Skill score" : "Score") + " published for " + bookLink(f) + ": <b>" + esc(f.score) + "/100</b>";
    else text = bookLink(f) + (f.note === "withheld" ? " kept a prediction hidden <span class=\"cb-ev-m\">counted as its worst result</span>" : " missed a prediction <span class=\"cb-ev-m\">counts against it</span>");
    return '<li class="cb-ev ' + k[1] + '"><span class="ei">' + U.icon(k[0]) + "</span><div><p>" + text + "</p>" +
      '<div class="sub"><time datetime="' + new Date(f.t * 1000).toISOString() + '" title="' + esc(C.stamp(f.t)) + '">' + esc(C.ago(f.t)) + "</time>" + (per ? "<span>round" + esc(per) + "</span>" : "") +
      (f.tx || f.hash ? '<span class="cb-proofl">proof ' + C.txLink(D.explorer, f.tx || f.hash, C.shortHash(f.tx || f.hash, 6, 4)) + "</span>" : "") + "</div></div></li>";
  }
  function feed() {
    var list = (D.feed || []).filter(function (f) { return feedKind === "all" || f.kind === feedKind || (feedKind === "sealed" && f.kind === "locked"); }).slice(0, 30);
    $("feed").innerHTML = list.length ? list.map(feedItem).join("") : '<li class="hm-empty"><b>Nothing yet</b>Predictions, reveals and scores appear here as they land on Arc.</li>';
  }
  pressGroup($("feed-f"), "data-k", function (k) { feedKind = k; feed(); });

  // ------------------------------------------------------- the machine
  // Each book's current seal and its last reveal, from the feed.
  var reel = [], at = 0, timer = null, paused = C.reduce, clockTimer = null;
  function buildReel() {
    reel = D.books.map(function (b) {
      var mine = (D.feed || []).filter(function (f) { return f.bookId === b.id; });
      var sealed = mine.filter(function (f) { return f.kind === "sealed"; })[0];
      var rev = mine.filter(function (f) { return f.kind === "revealed"; })[0];
      return sealed ? { b: b, sealed: sealed, rev: rev } : null;
    }).filter(Boolean);
  }
  function showReel(i) {
    if (!reel.length) return;
    at = (i + reel.length) % reel.length;
    var r = reel[at], b = r.b;
    $("m-book").textContent = C.nameOf(b);
    $("m-p-now").textContent = "#" + C.int(r.sealed.period);
    $("m-p-last").textContent = r.rev ? "#" + C.int(r.rev.period) : "";
    var m = $("machine");
    m.classList.remove("locked", "open");
    void m.offsetWidth; // restart the CSS transitions
    C.scramble($("m-hash"), C.shortHash(r.sealed.hash, 10, 8), 1000);
    setTimeout(function () { m.classList.add("locked"); }, C.reduce ? 0 : 1000);
    $("m-call").innerHTML = r.rev ?
      '<span class="was">' + U.icon("lock") + "hidden</span>" +
      '<span class="is"><b>' + esc(r.rev.coin) + "</b>" + C.sidePill(r.rev.side) + (r.rev.side ? '<span class="mono">' + C.pctHtml(r.rev.ret, 2) + "</span>" +
        '<span class="muted">' + (r.rev.ret >= 0 ? "made" : "lost") + ", after fees</span>" : '<span class="muted">sat this one out</span>') + "</span>" :
      '<span class="muted">Nothing revealed yet: this agent is new. Its first prediction shows here in ' + esc(C.hours(r.b.horizonSec || r.b.periodSec)) + ".</span>";
    setTimeout(function () { m.classList.add("open"); }, C.reduce ? 0 : 1700);
    Array.prototype.forEach.call($("m-dots").querySelectorAll("button"), function (d, j) { d.setAttribute("aria-pressed", String(j === at)); });
    tick();
  }
  function tick() {
    if (!reel.length) return;
    var b = reel[at].b, P = b.periodSec || 14400, end = C.nextBoundary(b), left = end - C.now();
    $("m-clock").textContent = C.clock(left);
    var hm = function (t) { return new Date(t * 1000).toISOString().slice(11, 16); };
    $("m-from").textContent = "recorded " + hm(end - P);
    $("m-to").textContent = "revealed " + hm(end - P + (b.horizonSec || P)) + " UTC";
    $("m-until").textContent = hm(end - P + (b.horizonSec || P)) + " UTC";
    $("m-prog").style.transform = "scaleX(" + Math.max(0, Math.min(1, 1 - left / P)).toFixed(4) + ")";
  }
  function play() {
    clearInterval(timer);
    if (!paused && reel.length > 1) timer = setInterval(function () { showReel(at + 1); }, 7000);
  }
  function machine() {
    buildReel();
    if (!reel.length) { $("m-book").textContent = "No predictions yet"; return; }
    $("m-dots").innerHTML = reel.map(function (r, j) { return '<button type="button" aria-pressed="false" aria-label="' + esc(C.nameOf(r.b)) + '" data-j="' + j + '"></button>'; }).join("");
    $("m-dots").addEventListener("click", function (e) { var d = e.target.closest("button"); if (d) { showReel(+d.getAttribute("data-j")); play(); } });
    $("m-pause").setAttribute("aria-pressed", String(paused));
    $("m-pause").textContent = paused ? "Play" : "Pause";
    $("m-pause").addEventListener("click", function () {
      paused = !paused;
      this.setAttribute("aria-pressed", String(paused));
      this.textContent = paused ? "Play" : "Pause";
      play();
    });
    showReel(0);
    play();
    clearInterval(clockTimer);
    clockTimer = setInterval(tick, 1000);
  }

  // ------------------------------------------------------ the hero record
  // One real agent's live record: the top score among records that aren't
  // samples or the coin-flip control, picked by the numbers, never by hand.
  function heroPick() {
    var all = D.books.map(function (x) { return { x: x, kind: "books" }; })
      .concat(D.callers.map(function (x) { return { x: x, kind: "callers" }; }));
    var real = all.filter(function (e) { return !isBaseline(e.x) && !e.x.sample; });
    return (real.length ? real : all).slice().sort(function (a, b) {
      return ((C.scoreOf(b.x) || 0) - (C.scoreOf(a.x) || 0)) || ((b.x.metrics.calls || 0) - (a.x.metrics.calls || 0));
    })[0] || null;
  }
  var whenOf = function (t) { return '<time datetime="' + new Date(t * 1000).toISOString() + '" title="' + esc(C.stamp(t)) + '">' + esc(C.ago(t)) + "</time>"; };
  function heroRecord(e) {
    if (!e) { $("rec-n").textContent = "The first records arrive soon"; return; }
    var x = e.x, m = x.metrics, s = C.scoreOf(x), href = BOARDS[e.kind].href(x);
    var hidden = m.withheld || 0, level = x.score && x.score.parts && C.own(C.RECORD, x.score.parts.level);
    var t = (x.score && x.score.asOf) || (x.validation && x.validation.at) || null;
    $("rec-n").textContent = C.nameOf(x);
    $("rec-by").innerHTML = "by " + esc(personOf(x)) + " · " + (e.kind === "books" ? esc(coinList(x.coins)) : "any coin");
    if (C.isNum(s)) C.countUp($("rec-score"), Math.round(s)); else $("rec-score").textContent = "—";
    $("rec-bar").style.width = (C.isNum(s) ? Math.max(0, Math.min(100, s)) : 0) + "%";
    $("rec-level").innerHTML = esc(level || "") + (x.challenge ? " " + C.challengePill(x.challenge) : "");
    $("rec-calls").textContent = C.int(m.calls);
    $("rec-hidden").innerHTML = C.int(hidden) + "<small>" + (hidden ? "each counted as its worst" : "none kept back") + "</small>";
    $("rec-ret").innerHTML = C.pctHtml(m.totalReturn);
    $("rec-last").innerHTML = t ? whenOf(t) : "—";
    $("rec-curve").innerHTML = curve(x);
    $("rec-go").href = href;
  }

  // --------------------------------------------------------- live proof
  function proof() {
    var s = D.stats || {}, W = C.where(D);
    var tracked = (s.books || 0) + (s.callers || 0);
    C.countUp($("st-sealed"), (s.sealed || 0) + (s.locked || 0));
    C.countUp($("st-books"), tracked);
    $("st-books-s").textContent = !tracked ? "the first records arrive soon" : C.int(s.books || 0) + " agents · " + C.int(s.callers || 0) + " people";
    C.countUp($("st-revealed"), (s.revealed || 0) + (s.lockedRevealed || 0));
    // The latest score: the newest of every record's own, or a score event in the feed.
    var times = D.books.concat(D.callers).map(function (x) { return x.score && x.score.asOf; })
      .concat((D.feed || []).filter(function (f) { return f.kind === "validated"; }).map(function (f) { return f.t; })).filter(C.isNum);
    var last = times.length ? Math.max.apply(null, times) : null;
    $("st-last").innerHTML = last ? whenOf(last) : "—";
    $("st-last-s").textContent = last ? C.stamp(last) : "no scores yet";
    var gen = D.generated ? Date.parse(D.generated) / 1000 : null;
    $("st-asof").textContent = gen ? "As of " + C.stamp(gen, true) : "";
    $("st-contract").innerHTML = D.contract ? "Contract " + C.txLink(D.explorer, D.contract, C.shortHash(D.contract, 6, 4), "address") +
      ' <span class="muted">' + (W.live ? "on " + esc(D.network || "Arc") : "· " + esc(W.status.toLowerCase())) + "</span>" : "";
  }

  // ------------------------------------------------- check it yourself
  var MCP_CMD = "claude mcp add reins -- npx -y @onreins/mcp";
  $("mcp-copy").innerHTML = C.copyButton(MCP_CMD, "Copy the setup command");
  function check(e) {
    var x = e && e.x;
    $("chk-contract").innerHTML = D.contract ? C.txLink(D.explorer, D.contract, C.shortHash(D.contract, 8, 6), "address") + "<small>" + esc(D.network || "Arc") + "</small>" : '<span class="muted">to deploy</span>';
    if (!x) { $("v-cmd").innerHTML = '<span class="c"># nothing to re-check yet: the first records appear here</span>'; return; }
    var cmd = "npm run arena:verify -- " + x.id, v = x.validation;
    $("v-cmd").innerHTML = '<span class="c"># in a copy of the source: rebuild ' + esc(C.nameOf(x)) + "’s score</span>\n" +
      '<span class="p">$</span> ' + esc(cmd) + "\n" +
      '<span class="c"># ' + C.int(x.metrics.revealed) + " revealed · " + (v ? "expects " + esc(v.score) + "/100, as posted on chain" : "expects " + esc(Math.round(C.scoreOf(x) || 0)) + "/100") + "</span>";
    $("v-copy").innerHTML = C.copyButton(cmd, "Copy the command");
  }

  // Where the data comes from, in this page's words (a local take on C.statusPill).
  function statusPill(d) {
    var w = C.where(d);
    var tip = w.live ? "Every prediction is recorded and revealed on " + (d.network || "Arc") + ", and scores are posted to an open registry on Arc (ERC-8004)." : w.tip;
    return '<span class="cb-status' + (w.live ? " live" : "") + '" tabindex="0" data-tip="' + esc(tip) + '"><i aria-hidden="true"></i>' + esc(w.status) +
      '<span class="sr-only">: ' + esc(tip) + "</span></span>";
  }

  // ------------------------------------------------------------- the page
  C.loadIndex().then(function (d) {
    D = d;
    D.books = (D.books || []).filter(function (b) { return b && b.metrics; });
    D.callers = (D.callers || []).filter(function (c) { return c && c.metrics; });
    var W = C.where(D);
    $("status").innerHTML = statusPill(D);
    $("rec-k").textContent = W.live ? "Live record" : W.status;
    $("feed-t").textContent = W.chain + ", as it happens";
    $("foot-gen").textContent = "Paper predictions, scored at Hyperliquid prices. Not investment advice." + (D.generated ? " Updated " + C.stamp(Date.parse(D.generated) / 1000) + "." : "");
    $("foot-net").textContent = D.network || "Arc";
    var top = heroPick();
    heroRecord(top);
    proof();
    check(top);
    setBoard(new URLSearchParams(location.search).get("board") || "books", false);
    podium();
    ticker();
    feed();
    machine();
  }).catch(function (err) {
    $("rec-n").textContent = "Couldn’t load the records";
    $("m-book").textContent = "Couldn’t load the records";
    $("rows").innerHTML = '<tr><td class="empty" colspan="10"><b>The records couldn’t load.</b>' + esc(err.message || "") + " Reload to try again.</td></tr>";
    $("feed").innerHTML = "";
    $("v-cmd").innerHTML = '<span class="c"># the records couldn’t load; reload to try again</span>';
  });
})();

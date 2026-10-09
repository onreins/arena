/* Arena: what the list page and a book's page share. Loading (the API,
   then the static export, then the sample data), moving sample data to the
   present, formatting, and the notary seal. Escapes everything it prints. */
window.Callbook = (function () {
  "use strict";
  var U = window.ReinsUI, esc = U.esc;

  // ------------------------------------------------------------- loading
  var ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  var params = new URLSearchParams(location.search);
  var wantMock = params.get("mock") === "1";

  async function json(url) {
    var res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error("Couldn’t read " + url + " (" + res.status + ")");
    return res.json();
  }
  // The API first; then the export the runner writes; sample data only on
  // ?mock=1 or when there is no export at all.
  var indexOnce = null;
  function loadIndex() { return (indexOnce = indexOnce || loadIndexNow()); }
  async function loadIndexNow() {
    if (wantMock) return rebase(await json("/data/callbook-mock.json"));
    try { return await json("/api/callbook"); } catch (e) { /* no API here */ }
    try { return await json("/data/callbook.json"); } catch (e) { /* no export yet */ }
    return rebase(await json("/data/callbook-mock.json"));
  }
  async function loadCaller(id) {
    if (!ID_RE.test(id || "")) throw new Error("That isn’t a caller id.");
    try { return rebase(await json("/api/callbook/caller/" + encodeURIComponent(id))); } catch (e) { /* no API here */ }
    return rebase(await json("/data/callbook-caller-" + encodeURIComponent(id) + ".json"));
  }
  async function loadBook(id) {
    if (!ID_RE.test(id || "")) throw new Error("That isn’t a book id.");
    var file = "/data/callbook-book-" + encodeURIComponent(id) + ".json";
    if (wantMock || id.indexOf("mock-") === 0) return rebase(await json(file));
    try { return await json("/api/callbook/book/" + encodeURIComponent(id)); } catch (e) { /* no API here */ }
    return rebase(await json(file));
  }

  // Sample data is written once; move it so its latest period is the one
  // running now, so its countdowns count. Real data is never touched.
  function rebase(d) {
    if (!d || d.mode !== "mock") return d;
    var P = periodOf(d) || 14400;
    var gen = Math.floor(Date.parse(d.generated) / 1000) || 0;
    var dp = Math.floor(Date.now() / 1000 / P) - Math.floor(gen / P), dt = dp * P;
    if (!dp) return d;
    var t = function (x) { return typeof x === "number" ? x + dt : x; };
    var p = function (x) { return typeof x === "number" ? x + dp : x; };
    var book = function (b) {
      b.openedAt = t(b.openedAt);
      (b.curve || []).forEach(function (c) { c.t = t(c.t); });
      if (b.next) { b.next.startsAt = t(b.next.startsAt); b.next.period = p(b.next.period); }
      if (b.validation) b.validation.at = t(b.validation.at);
      (b.calls || []).forEach(function (c) { c.start = t(c.start); c.sealedAt = t(c.sealedAt); c.revealedAt = t(c.revealedAt); c.period = p(c.period); });
    };
    if (d.books) d.books.forEach(book); else book(d);
    (d.feed || []).forEach(function (f) { f.t = t(f.t); f.period = p(f.period); });
    d.generated = new Date((gen + dt) * 1000).toISOString();
    return d;
  }
  function periodOf(d) { return d.periodSec || (d.books && d.books[0] && d.books[0].periodSec) || null; }

  // ------------------------------------------------------------ formatting
  var now = function () { return Date.now() / 1000; };
  var isNum = function (x) { return typeof x === "number" && isFinite(x); };
  // A table lookup that never reaches Object.prototype ("constructor", "__proto__"…).
  var own = function (obj, k) { return Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : undefined; };
  // A book's name, or "Book #N" when the server sends none (a book that isn't one we vouch for).
  function nameOf(x) { return x && typeof x.name === "string" && x.name.trim() ? x.name : "Book #" + String(x && (x.id != null ? x.id : x.bookId)); }
  // A person’s profile page: every record one address runs, in one place.
  var ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
  function profileHref(owner) { return ADDR_RE.test(owner || "") ? "/arena/p/" + String(owner).toLowerCase() : null; }
  /** " · More from this person", for a record's meta line. */
  function moreFrom(x) {
    var href = profileHref(x && x.owner);
    return href ? ' · <a class="cb-more-from" href="' + esc(href) + '">More from this person</a>' : "";
  }
  // A person’s avatar, drawn from their address (ui.js).
  function identicon(addr, size) { return U.identicon(addr, size); }
  function movedTag(x) {
    return x && x.agentMoved ? '<span class="cb-tag" tabindex="0" data-tip="The ERC-8004 agent this book points to has changed hands since the book opened">Agent changed hands</span>' : "";
  }
  // Fractions in, percent out: 0.131 → "+13.1%".
  function pct(x, dp) { return isNum(x) ? U.pct(x * 100, dp === undefined ? 1 : dp) : "—"; }
  function pctHtml(x, dp) { return isNum(x) ? '<span class="' + U.dirOf(x * 100) + '">' + pct(x, dp) + "</span>" : '<span class="muted">—</span>'; }
  function dd(x) { return isNum(x) ? "−" + (Math.abs(x) * 100).toFixed(1) + "%" : "—"; }
  function num(x, dp) { return isNum(x) ? (x < 0 ? "−" : "") + Math.abs(x).toFixed(dp === undefined ? 2 : dp) : "—"; }
  function int(x) { return isNum(x) ? Math.round(x).toLocaleString("en-US") : "—"; }
  var HEX = /^0x[0-9a-fA-F]+$/;
  // Only http(s) links from data: never javascript: or data: URLs.
  function isHttp(u) { return typeof u === "string" && /^https?:\/\/[^\s"'<>]+$/i.test(u); }
  function shortHash(h, a, b) { if (!h) return "—"; h = String(h); return h.length > 14 ? h.slice(0, a || 6) + "…" + h.slice(-(b || 4)) : h; }
  // A hash as a link to the explorer, or as plain text when there's no tx.
  function txLink(explorer, tx, label, kind) {
    var text = esc(label || shortHash(tx));
    if (!tx || !HEX.test(tx) || !isHttp(explorer)) return '<span class="cb-hash">' + text + "</span>";
    return '<a class="cb-hash" href="' + esc(explorer.replace(/\/$/, "") + "/" + (kind || "tx") + "/" + tx) + '" target="_blank" rel="noopener" title="' + esc(tx) + '">' +
      text + U.icon("ext") + "</a>";
  }
  function ago(t) {
    var s = Math.max(0, now() - t);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }
  function stamp(t, withYear) {
    if (!isNum(t)) return "—";
    var d = new Date(t * 1000);
    return d.toLocaleString("en-GB", { day: "numeric", month: "short", year: withYear ? "numeric" : undefined, hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
  }
  function day(t) { return new Date(t * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }); }
  var two = function (n) { return (n < 10 ? "0" : "") + n; };
  // 9254 → "02:34:14"
  function clock(s) { s = Math.max(0, Math.floor(s)); return two(Math.floor(s / 3600)) + ":" + two(Math.floor(s / 60) % 60) + ":" + two(s % 60); }
  // 9254 → "2h 34m"
  function span(s) {
    s = Math.max(0, Math.floor(s));
    if (s < 60) return s + "s";
    if (s < 3600) return Math.floor(s / 60) + "m " + two(s % 60) + "s";
    if (s < 86400) return Math.floor(s / 3600) + "h " + two(Math.floor(s / 60) % 60) + "m";
    return Math.floor(s / 86400) + "d " + Math.floor(s / 3600) % 24 + "h";
  }
  function hours(sec) { return sec % 86400 === 0 ? sec / 86400 + "d" : sec % 3600 === 0 ? sec / 3600 + "h" : Math.round(sec / 60) + "m"; }

  var SIDE = { "1": ["long", "Long", "bet the price goes up"], "-1": ["short", "Short", "bet the price goes down"], "0": ["flat", "Flat", "sat this one out"] };
  function sidePill(side) { var s = own(SIDE, String(side)) || ["flat", "—", ""]; return '<span class="cb-side ' + s[0] + '" title="' + s[2] + '">' + s[1] + "</span>"; }
  // The 90-day test in a few plain words.
  function challengeLine(b) {
    var c = b.challenge || {}, m = b.metrics || {};
    if (c.status === "passed") return "made +10% inside the limits";
    if (c.status === "failed") {
      var r = (c.reasons || []).join(" ").toLowerCase();
      return r.indexOf("drawdown") >= 0 ? "dropped past the 5% limit" : r.indexOf("day") >= 0 ? "ran out of days" : "didn’t make it";
    }
    var left = Math.max(0, 61 - Math.floor(m.days || 0));
    return left ? "day " + (c.day || Math.ceil(m.days || 0)) + " of 90 · " + left + " to go" : "needs +10% by day 90";
  }
  var CH = { in_progress: ["prog", "In progress"], passed: ["pass", "Passed"], failed: ["fail", "Failed"] };
  function challengePill(c, withDay) {
    if (!c) return '<span class="muted">—</span>';
    var s = own(CH, c.status) || ["prog", String(c.status)];
    var why = (c.reasons || []).join(". ");
    return '<span class="cb-ch ' + s[0] + '"' + (why ? ' tabindex="0" data-tip="' + esc(why) + '"' : "") + ">" + '<i aria-hidden="true"></i>' + esc(s[1]) +
      (why ? '<span class="sr-only">: ' + esc(why) + "</span>" : "") + "</span>" +
      (withDay && isNum(c.day) ? '<small class="cb-day">day ' + esc(c.day) + " of " + esc(c.of || 90) + "</small>" : "");
  }
  // The next period boundary: the book's own, or the next multiple of its period.
  function nextBoundary(b) {
    var P = b.periodSec || 14400, t = now();
    if (b.next && isNum(b.next.startsAt) && b.next.startsAt > t) return b.next.startsAt;
    return Math.ceil(t / P) * P;
  }

  // ------------------------------------------------------------- the seal
  // A notary's stamp: words around a ring, a lock in the middle.
  var sealN = 0;
  function seal(cls, words) {
    var id = "cb-ring-" + sealN++;
    var text = (words || "SEALED ON ARC · ERC-8004 · CALLBOOK · ").repeat(2);
    var ticks = "";
    for (var i = 0; i < 72; i++) {
      var a = (i / 72) * Math.PI * 2, r1 = 47, r2 = i % 6 === 0 ? 43.5 : 45.5;
      ticks += "M" + (50 + r1 * Math.cos(a)).toFixed(2) + " " + (50 + r1 * Math.sin(a)).toFixed(2) + "L" + (50 + r2 * Math.cos(a)).toFixed(2) + " " + (50 + r2 * Math.sin(a)).toFixed(2);
    }
    return '<svg class="cb-seal ' + (cls || "") + '" viewBox="0 0 100 100" aria-hidden="true">' +
      '<defs><path id="' + id + '" d="M50 50m-36 0a36 36 0 1 1 72 0a36 36 0 1 1-72 0"/></defs>' +
      '<circle class="o" cx="50" cy="50" r="48.5"/><path class="tk" d="' + ticks + '"/>' +
      '<g class="spin"><text><textPath href="#' + id + '" textLength="224">' + esc(text.slice(0, 74)) + "</textPath></text></g>" +
      '<circle class="i" cx="50" cy="50" r="27"/>' +
      '<g class="lock"><path class="sh" d="M43.5 47v-4.2a6.5 6.5 0 0 1 13 0V47"/><rect x="40" y="47" width="20" height="15" rx="3"/><path class="ck" d="m45.6 54.6 3 3 5.8-5.8"/></g></svg>';
  }

  // Security-print lines for a hero's background (a guilloche), drawn once.
  function guilloche(w, h, fx) {
    var paths = "", cx = w * (fx || 0.72), cy = h * 0.5;
    [[118, 23, 61, 0.16], [152, 31, 47, 0.11], [188, 37, 71, 0.08]].forEach(function (p) {
      var R = p[0], r = p[1], d = p[2], s = "";
      for (var i = 0; i <= 1440; i++) {
        var t = (i / 1440) * Math.PI * 2 * r / gcd(R, r);
        var x = (R - r) * Math.cos(t) + d * Math.cos(((R - r) / r) * t), y = (R - r) * Math.sin(t) - d * Math.sin(((R - r) / r) * t);
        s += (i ? "L" : "M") + (cx + x).toFixed(1) + " " + (cy + y * 0.9).toFixed(1);
      }
      paths += '<path d="' + s + '" stroke-opacity="' + p[3] + '"/>';
    });
    return '<svg class="cb-guil" viewBox="0 0 ' + w + " " + h + '" preserveAspectRatio="xMidYMid slice" aria-hidden="true">' + paths + "</svg>";
  }
  function gcd(a, b) { return b ? gcd(b, a % b) : a; }

  // Scramble text into place, Vanta-style: random hex settles left to right.
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function scramble(el, final, ms) {
    if (!el) return;
    if (reduce) { el.textContent = final; return; }
    var start = performance.now(), dur = ms || 900, chars = "0123456789abcdef";
    (function frame(t) {
      var k = Math.min(1, (t - start) / dur), n = Math.floor(final.length * k), s = final.slice(0, n);
      for (var i = n; i < final.length; i++) s += final[i] === "…" || final[i] === "x" && i === 1 ? final[i] : chars[(Math.random() * 16) | 0];
      el.textContent = s;
      if (k < 1) requestAnimationFrame(frame);
    })(start);
  }

  // A shared tooltip for anything with data-tip (table cells clip their own).
  function tooltips() {
    var tip = document.createElement("div");
    tip.className = "cb-tip";
    tip.setAttribute("role", "tooltip");
    tip.hidden = true;
    document.body.appendChild(tip);
    var show = function (el) {
      tip.textContent = el.getAttribute("data-tip");
      tip.hidden = false;
      var r = el.getBoundingClientRect(), w = tip.offsetWidth;
      var x = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
      var y = r.top - tip.offsetHeight - 8;
      if (y < 8) y = r.bottom + 8;
      tip.style.left = x + "px";
      tip.style.top = y + "px";
    };
    var hide = function () { tip.hidden = true; };
    ["mouseover", "focusin"].forEach(function (ev) {
      document.addEventListener(ev, function (e) { var el = e.target.closest && e.target.closest("[data-tip]"); if (el) show(el); });
    });
    ["mouseout", "focusout"].forEach(function (ev) {
      document.addEventListener(ev, function (e) { var el = e.target.closest && e.target.closest("[data-tip]"); if (el) hide(); });
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") hide(); });
    window.addEventListener("scroll", hide, { passive: true });
  }

  function copyButton(text, label) {
    return '<button type="button" class="copy cb-copy" data-copy="' + esc(text) + '" aria-label="' + esc(label || "Copy") + '">' +
      '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/></svg></button>';
  }
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-copy]");
    if (!b) return;
    var done = function () { b.classList.add("done"); setTimeout(function () { b.classList.remove("done"); }, 1200); };
    if (navigator.clipboard) navigator.clipboard.writeText(b.getAttribute("data-copy")).then(done, function () { /* clipboard blocked */ });
  });

  var MODE = { mock: "Sample data", replay: "Replay", live: "Live" };
  function modeBadge(d) {
    if (!d || d.mode === "live") return "";
    var tip = d.mode === "mock" ? "Made-up books to show the page. No real agent sealed these calls." : "Replayed on a local chain over real past prices, not sealed live.";
    return '<span class="cb-mode ' + esc(d.mode) + '" tabindex="0" data-tip="' + esc(tip) + '">' + esc(own(MODE, d.mode) || d.mode) + "</span>";
  }

  // ------------------------------------------------------------- the score
  // Published constants (app/verify/callbook.js SCORE_RULES, callbook-callers.js CALLER_RULES):
  // score = 100 × coverage × (0.6 × profit + 0.4 × edge) × (0.6 + 0.4 × risk); callers have no coverage.
  // The record's length is its level (app/verify/callbook-skill.js, RECORD_LEVELS), shown beside the score.
  var RULES = { fullT: 3, maxDrawdown: 0.40, minExposure: 0.5, profitWeight: 0.6, edgeWeight: 0.4, riskFloor: 0.6, newDays: 14, newCalls: 30, fullDays: 61 };
  var RECORD = { "new": "New record", building: "Building record", full: "Full record" };
  /** The record's level in words, with what the next one needs: "Building record · 25 days to a full record". */
  function levelLine(b) {
    var p = b.score && b.score.parts, m = b.metrics || {}, lv = p && p.level;
    if (!lv) return "";
    var calls = (m.revealed || 0) + (m.withheld || 0) + (m.unscorable || 0), days = Math.floor(m.days || 0), need = [];
    if (lv === "new") {
      if (days < RULES.newDays) need.push((RULES.newDays - days) + " more days");
      if (calls < RULES.newCalls) need.push((RULES.newCalls - calls) + " more calls");
    } else if (lv === "building") need.push((RULES.fullDays - days) + " days to a full record");
    return RECORD[lv] + (need.length ? " · " + need.join(" and ") : "");
  }
  // The score posted to ERC-8004, or the latest computed one.
  /**
   * "How it's built", in plain words, for a record page. `vs` names what the
   * record is measured against ("the coin" for callers, "the market" for bots);
   * bots also lose score for rounds they missed or calls they kept hidden.
   * `next`: what would raise it, in a sentence, or nothing.
   */
  function scoreParts(b, vs, next) {
    var p = b.score && b.score.parts, m = b.metrics || {};
    if (!p) return "";
    var pct = function (x) { return Math.round(Math.max(0, Math.min(1, x || 0)) * 100) + "%"; };
    var row = function (k, x, note, tip) {
      var f = Math.max(0, Math.min(1, x || 0));
      return '<li tabindex="0" data-tip="' + esc(tip) + '"><span class="k">' + esc(k) + '</span><b class="mono' + (f === 0 ? " nil" : "") + '">' + pct(f) + "</b>" +
        '<span class="bar" aria-hidden="true"><i style="width:' + (f * 100).toFixed(0) + '%"></i></span><small>' + esc(note) + "</small></li>";
    };
    var losing = isNum(m.totalReturn) && m.totalReturn <= 0;
    var keep = RULES.riskFloor + (1 - RULES.riskFloor) * (p.risk || 0);
    var dd = isNum(m.maxDrawdown) ? m.maxDrawdown : 0;
    var hasCover = isNum(p.coverage);
    var formula = "100 × " + (hasCover ? "coverage × " : "") + "(0.6 × profit + 0.4 × beats " + vs + ") × (0.6 + 0.4 × drops). " +
      "Profit and beating " + vs + " get full marks when their t-statistic reaches 3.";
    return '<div class="cbk-parts"><p class="cbk-formula" tabindex="0" data-tip="' + esc(formula) + '"><b>How it’s built</b> ' +
      "Mostly steady profit, partly beating " + esc(vs) + ", then cut by big drops" + (hasCover ? " and missed calls" : "") + ".</p><ul>" +
      row("Steady profit", p.profit,
        p.profit >= 1 ? "Full marks" : p.profit > 0 ? "Making money; steadier gains raise this" : losing ? "Not making money yet" : "Making money, but not steadily yet",
        "60% of the score. Do its calls make money after fees, again and again? Full marks once the gains are clearly more than luck.") +
      row("Beats " + vs, p.edge,
        p.edge >= 1 ? "Full marks" : p.edge > 0 ? "Ahead of " + vs + "; a clearer lead raises this" : "Not yet: no better than just holding",
        "40% of the score. Does it do better than simply holding " + vs + " it called? Full marks once that's clearly more than luck.") +
      row("Big drops", keep,
        dd > 0 ? "Worst drop −" + (Math.abs(dd) * 100).toFixed(1) + "%: keeps " + pct(keep) + " of the score" : "No drops yet: keeps the whole score",
        "Its worst fall from a high cuts the score by up to 40%. A 40% fall takes the full cut; a small one barely matters.") +
      (hasCover ? row("Calls on time", p.coverage,
        m.missed || m.withheld ? int(m.missed || 0) + " missed, " + int(m.withheld || 0) + " kept hidden: keeps " + pct(p.coverage) : "Every call due was revealed",
        "A missed round or a call kept hidden lowers the score in proportion.") : "") +
      "</ul>" + (levelLine(b) ? '<p class="cbk-level">' + esc(levelLine(b)) + "</p>" : "") +
      (next ? '<p class="cbk-zero"><b>What’s next.</b> ' + esc(next) + "</p>" : "") + "</div>";
  }
  function scoreOf(b) {
    if (b.validation && isNum(b.validation.score)) return b.validation.score;
    if (b.score && isNum(b.score.value)) return b.score.value;
    return null;
  }
  // Why a score is what it is, in a few words and in a sentence.
  function scoreWhy(b) {
    var p = b.score && b.score.parts, m = b.metrics || {};
    if (!p) return null;
    var bits = [], long = [], next = [];
    var lost = isNum(m.totalReturn) && m.totalReturn <= 0;
    if (!(p.profit > 0)) {
      bits.push(lost ? "no profit yet" : "profit not steady yet");
      long.push("Profit is 0: " + (lost ? "after fees and funding its calls haven’t made money." : "its gains aren’t steady enough yet (t = " + num(p.profitT) + "; full credit at " + RULES.fullT + ")."));
      next.push("calls that make money after costs");
    }
    if (p.edge <= 0) {
      bits.push("not beating the market");
      long.push("Edge is 0: its calls don’t beat the market’s own move (t = " + num(p.tStat) + "; full credit at " + RULES.fullT + "), so it can’t pass 60.");
      next.push("calls that beat the market");
    }
    if (isNum(p.risk) && p.risk < 1 && isNum(m.maxDrawdown) && m.maxDrawdown > 0) {
      long.push("Its worst drop was " + dd(m.maxDrawdown) + ", so it keeps " + Math.round(100 * (RULES.riskFloor + (1 - RULES.riskFloor) * p.risk)) + "% of what it earned (60% past a 40% drop).");
      if (m.maxDrawdown >= RULES.maxDrawdown) next.push("a drawdown back under 40%");
    }
    if (isNum(p.coverage) && p.coverage < 1) long.push("Coverage is " + num(p.coverage) + ": missed and hidden calls cost it.");
    var lvl = levelLine(b);
    if (lvl) long.push(lvl + ".");
    var nextText = next.length ? "To rise it needs " + next.join(", ").replace(/, ([^,]*)$/, " and $1") + "." : "";
    if (nextText) long.push(nextText);
    return { short: bits.slice(0, 1).join(""), long: long.join(" "), next: nextText };
  }

  // The number of the period that opens at boundary `t`. Periods count from
  // the book's start, so they come from the data, not the clock.
  function periodAt(b, t) {
    var P = b.periodSec || 14400;
    if (b.next && isNum(b.next.period) && isNum(b.next.startsAt)) return b.next.period + Math.round((t - b.next.startsAt) / P);
    if (isNum(b.start)) return Math.round((t - b.start) / P);
    return null;
  }
  // The drawdown the challenge reads: end of day, or the overall one when that's all there is.
  function eodOf(m) { return m && isNum(m.eodDrawdown) ? m.eodDrawdown : m ? m.maxDrawdown : null; }

  // What to call where the books live. Only live data is "on Arc".
  function where(d) {
    var mode = d && d.mode;
    if (mode === "live") return { status: "Live on Arc", chain: "On Arc", live: true,
      tip: "Calls are locked and revealed on Arc, and scores are published to Arc’s ERC-8004 Validation Registry." };
    if (mode === "replay") return { status: "Replay over real prices", chain: "On chain", live: false,
      tip: d.note || "Replayed on a local chain over real Hyperliquid prices." };
    return { status: "Sample data", chain: "On chain", live: false, tip: "Sample books that show how the page works. No bot made these calls." };
  }
  // One calm pill saying where the data comes from; the detail is in its tooltip.
  function statusPill(d) {
    var w = where(d);
    return '<span class="cb-status' + (w.live ? " live" : "") + '" tabindex="0" data-tip="' + esc(w.tip) + '"><i aria-hidden="true"></i>' + esc(w.status) +
      '<span class="sr-only">: ' + esc(w.tip) + "</span></span>";
  }
  var SEAL_WORDS = "ARENA · ERC-8004 · VALIDATED · ";
  var COSTS = { "hyperliquid-funding": "fees and real hourly Hyperliquid funding", "vanta-flat-carry": "fees and Vanta’s flat carry" };
  function costsText(c) { return own(COSTS, c) || (c ? String(c) : "fees"); }

  // Under two weeks of record, ratios like Sharpe are shown but greyed.
  var YOUNG_DAYS = 14;

  /** A number that counts up from 0 the first time it scrolls into view (at once with reduced motion). */
  function countUp(el, to, fmt) {
    fmt = fmt || int;
    if (!el || !isNum(to)) return;
    if (reduce || !window.IntersectionObserver || !window.requestAnimationFrame) { el.textContent = fmt(to); return; }
    el.textContent = fmt(0);
    var io = new IntersectionObserver(function (es) {
      if (!es.some(function (e) { return e.isIntersecting; })) return;
      io.disconnect();
      var t0 = performance.now(), dur = 900;
      (function step(t) {
        var k = Math.min(1, (t - t0) / dur);
        el.textContent = fmt(to * (1 - Math.pow(1 - k, 3)));
        if (k < 1) requestAnimationFrame(step);
      })(t0);
    });
    io.observe(el);
  }
  /** A faint light that follows the pointer across a card (.ar-glow in callbook-arena.css). */
  function glow(el) {
    if (!el || reduce) return;
    el.classList.add("ar-glow");
    el.addEventListener("pointermove", function (e) {
      var r = el.getBoundingClientRect();
      el.style.setProperty("--mx", (e.clientX - r.left) + "px");
      el.style.setProperty("--my", (e.clientY - r.top) + "px");
    });
  }

  // The skill score (docs/CALLBOOK-IDENTITY-PLAN.md): how often calls beat the market's own move,
  // credible by the number of calls. Levels in order, and what each says.
  var LEVELS = { unrated: "Unrated", provisional: "Provisional", rated: "Rated", established: "Established" };
  var LEVEL_RANK = { unrated: 1, provisional: 2, rated: 3, established: 4 };
  function skillRank(s) { return s ? LEVEL_RANK[s.level] * 1000 + (isNum(s.score) ? s.score : -1) : null; }
  function skillTip(s) {
    if (!s || !s.calls) return "No calls scored yet";
    var right = isNum(s.hitRate) ? Math.round(s.hitRate * 100) + "% of calls beat the market’s own move" : "";
    var range = s.range ? " (somewhere between " + Math.round(s.range[0] * 100) + "% and " + Math.round(s.range[1] * 100) + "%)" : "";
    var basis = " over " + int(Math.floor(s.effective)) + " independent calls (calls that overlap in time share one vote).";
    var next = s.next ? s.next.days ? " Established after " + s.next.days + " days of record." :
      " " + own(LEVELS, s.next.level) + " at " + int(s.next.calls) + " independent calls over " + (s.next.spanHours >= 48 ? Math.round(s.next.spanHours / 24) + " days" : s.next.spanHours + " hours") + "." : "";
    return right + range + basis + (isNum(s.score) ? " The score is the cautious end of that range: 50% right is 0, 65% is 100." : "") + next;
  }
  /** The skill score as a panel for a bot's or caller's page: score or progress, level, and what it means. */
  function skillPanel(s) {
    if (!s) return "";
    var goal = s.next && s.next.calls ? s.next.calls : null;
    var f = goal ? Math.min(1, s.effective / goal) : 1;
    var head = s.level === "unrated"
      ? '<b class="mono">' + int(Math.floor(s.effective)) + '</b><span class="of"> of ' + int(goal || 150) + " calls</span>"
      : '<b class="mono">' + esc(s.score) + '</b><span class="of">/100</span>';
    return '<section class="cbk-skillbox" aria-label="Skill score"><p class="cbk-skill-k">Skill score <span class="cb-skill ' + esc(s.level) + '"><span class="cb-skill-l">' +
      esc(own(LEVELS, s.level)) + "</span></span></p><div class='cbk-skill-v'>" + head + "</div>" +
      (goal ? '<span class="bar" aria-hidden="true"><i style="width:' + (f * 100).toFixed(0) + '%"></i></span>' : "") +
      "<p>" + esc(skillTip(s)) + "</p></section>";
  }

  /** The skill score as a small inline badge: the score and its level, or progress while unrated. */
  function skillHtml(s) {
    if (!s) return '<span class="muted">—</span>';
    var body = s.level === "unrated" ? '<span class="cb-skill-n">' + int(Math.floor(s.effective)) + "/" + int(s.next ? s.next.calls : 150) + "</span>" :
      '<span class="cb-skill-n">' + esc(s.score) + "</span>";
    return '<span class="cb-skill ' + esc(s.level) + '" tabindex="0" data-tip="' + esc(skillTip(s)) + '">' + body + '<span class="cb-skill-l">' + esc(own(LEVELS, s.level)) + "</span></span>";
  }

  return {
    skillHtml: skillHtml, skillTip: skillTip, skillPanel: skillPanel, countUp: countUp, glow: glow, levelLine: levelLine, RECORD: RECORD, skillRank: skillRank, LEVELS: LEVELS,
    own: own, nameOf: nameOf, movedTag: movedTag, profileHref: profileHref, moreFrom: moreFrom, scoreParts: scoreParts, identicon: identicon, ADDR_RE: ADDR_RE, YOUNG_DAYS: YOUNG_DAYS, challengeLine: challengeLine, isHttp: isHttp, RULES: RULES, scoreOf: scoreOf, scoreWhy: scoreWhy, periodAt: periodAt, eodOf: eodOf, where: where, costsText: costsText, loadIndex: loadIndex, loadBook: loadBook, loadCaller: loadCaller, params: params, wantMock: wantMock, ID_RE: ID_RE,
    pct: pct, pctHtml: pctHtml, dd: dd, num: num, int: int, isNum: isNum, shortHash: shortHash, txLink: txLink,
    ago: ago, stamp: stamp, day: day, clock: clock, span: span, hours: hours, now: now,
    sidePill: sidePill, challengePill: challengePill, nextBoundary: nextBoundary,
    seal: seal, guilloche: guilloche, scramble: scramble, reduce: reduce, tooltips: tooltips, copyButton: copyButton, modeBadge: modeBadge, statusPill: statusPill, SEAL_WORDS: SEAL_WORDS,
  };
})();

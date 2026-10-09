/* "How a prediction becomes a track record", played as a story: the four steps light
   up in turn (Recorded, Revealed, Scored, Published), each card's snippet animating its
   part, like the rule-check card on the Agents page. It alternates a winning
   and a losing call so it never only shows gains.

   It only adds emphasis: every step's text is always on the page. Reduced
   motion leaves the section exactly as written. It starts when scrolled into
   view and stops off-screen and in background tabs. */
(function () {
  "use strict";
  var root = document.getElementById("how");
  if (!root) return;
  var list = root.querySelector(".cb-steps");
  var items = list ? [].slice.call(list.children).filter(function (el) { return el.tagName === "LI"; }) : [];
  if (items.length !== 4) return;
  if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  // Two example calls, alternating: one that made money, one that didn't.
  var EXAMPLES = [
    { coin: "BTC", side: "long", fp: "0x9c4e…a1f2", from: 61240, to: 61498, dp: 0, ret: 0.36, bot: "Hot list", day: 30 },
    { coin: "ETH", side: "short", fp: "0x3b7d…e90c", from: 2697.4, to: 2709.1, dp: 1, ret: -0.47, bot: "Cold list", day: 30 },
  ];
  var STEP_MS = [3600, 3200, 3600, 3600];
  var REST_MS = 1400; // all four lit, before the next call starts

  var codes = items.map(function (li) { return li.querySelector("code"); });
  var timer = 0, step = -1, ex = 0, playing = true, inView = false, holdUntil = 0, ticks = [];

  // The progress line along the timeline, and the controls in the panel's header.
  var prog = document.createElement("li");
  prog.className = "cb-prog";
  prog.setAttribute("aria-hidden", "true");
  list.appendChild(prog);

  var head = root.querySelector(".hm-panel-h");
  var ctl = document.createElement("div");
  ctl.className = "cb-how-ctl";
  ctl.innerHTML = '<button type="button" class="cb-how-pause" aria-pressed="false">Pause</button><div class="hm-dots" role="group" aria-label="Step"></div>';
  head.appendChild(ctl);
  var pauseBtn = ctl.querySelector(".cb-how-pause"), dots = ctl.querySelector(".hm-dots");
  items.forEach(function (li, i) {
    var b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-label", "Step " + (i + 1) + ": " + li.querySelector("h3").textContent.replace(/^\d+/, ""));
    b.addEventListener("click", function () { jump(i); });
    dots.appendChild(b);
    li.addEventListener("click", function () { jump(i); });
  });
  root.classList.add("anim");

  // ---------------------------------------------------------------- snippets
  var HEX = "0123456789abcdef";
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return "&#" + c.charCodeAt(0) + ";"; }); };
  var fmt = function (v, dp) { return v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }); };
  var pct = function (v) { return (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(2) + "%"; };
  function clearTicks() { ticks.forEach(clearInterval); ticks = []; }
  // Runs fn(progress 0..1) over ms, ending exactly at 1.
  function tween(ms, fn) {
    var t0 = performance.now();
    fn(0);
    var id = setInterval(function () {
      var k = Math.min(1, (performance.now() - t0) / ms);
      fn(k);
      if (k >= 1) clearInterval(id);
    }, 40);
    ticks.push(id);
  }
  function scrambled(target, k) {
    return target.split("").map(function (ch, i) {
      if (!/[0-9a-f]/i.test(ch) || i < 2 || i / target.length < k) return ch;
      return HEX[(Math.random() * 16) | 0];
    }).join("");
  }

  // A step while it plays.
  function paint(i, e) {
    var c = codes[i];
    if (i === 0) {
      c.innerHTML = '<i>Hidden:</i> <span class="cb-blur">' + esc(e.coin + " · " + e.side) + '</span><br><i>Public:</i> <b class="fp">fingerprint ' + esc(scrambled(e.fp, 0)) + "</b>";
      var fp = c.querySelector(".fp");
      tween(1500, function (k) { fp.textContent = "fingerprint " + (k >= 1 ? e.fp : scrambled(e.fp, k)); });
      ticks.push(setTimeout(function () { var h = c.querySelector(".cb-blur"); if (h) h.classList.add("on"); }, 900));
    } else if (i === 1) {
      c.innerHTML = '<span class="cb-type">' + esc(e.coin + " · " + e.side) + '</span><br><b class="cb-pop">✓ matches ' + esc(e.fp) + "</b>";
    } else if (i === 2) {
      c.innerHTML = esc(e.coin) + " " + fmt(e.from, e.dp) + ' → <span class="px2">' + fmt(e.from, e.dp) + "</span><br>" +
        '<b class="r' + (e.ret < 0 ? " neg" : "") + '">' + pct(0) + " after costs</b>";
      var px2 = c.querySelector(".px2"), r = c.querySelector(".r");
      tween(1600, function (k) {
        var q = 1 - Math.pow(1 - k, 3);
        px2.textContent = fmt(e.from + (e.to - e.from) * q, e.dp);
        r.textContent = pct(e.ret * q) + " after costs";
      });
    } else {
      c.innerHTML = esc(e.bot + " · day " + e.day) + '<br><b class="cb-stamp-in">score 0–100 · check it yourself</b>';
    }
  }
  // A step at rest: its finished text.
  function settle(i, e) {
    var c = codes[i];
    if (i === 0) c.innerHTML = "<i>Hidden:</i> " + esc(e.coin + " · " + e.side) + "<br><i>Public:</i> <b>fingerprint " + esc(e.fp) + "</b>";
    else if (i === 1) c.innerHTML = esc(e.coin + " · " + e.side) + "<br><b>✓ matches " + esc(e.fp) + "</b>";
    else if (i === 2) c.innerHTML = esc(e.coin) + " " + fmt(e.from, e.dp) + " → " + fmt(e.to, e.dp) + '<br><b class="' + (e.ret < 0 ? "neg" : "") + '">' + pct(e.ret) + " after costs</b>";
    else c.innerHTML = esc(e.bot + " · day " + e.day) + "<br><b>score 0–100 · check it yourself</b>";
  }

  // ---------------------------------------------------------------- playback
  // i = 0..3 plays that step; i = 4 is the rest with all four lit.
  function show(i) {
    clearTicks();
    step = i;
    var e = EXAMPLES[ex];
    items.forEach(function (li, j) {
      li.classList.toggle("on", j === i);
      li.classList.toggle("done", j < i);
      if (j === i) paint(j, e); else settle(j, e);
    });
    list.style.setProperty("--p", String(Math.min(i + 1, 4) / 4));
    [].forEach.call(dots.children, function (b, j) { b.setAttribute("aria-pressed", String(j === Math.min(i, 3))); });
  }
  function next() {
    timer = 0;
    if (!playing || !inView || document.hidden) return;
    var wait = holdUntil - performance.now();
    if (wait > 0) { timer = setTimeout(next, wait); return; }
    if (step === 3) { show(4); timer = setTimeout(next, REST_MS); return; }
    if (step === 4) { ex = (ex + 1) % EXAMPLES.length; show(0); }
    else show(step + 1);
    timer = setTimeout(next, STEP_MS[step]);
  }
  function resume() {
    if (timer || !playing || !inView || document.hidden) return;
    timer = setTimeout(next, step < 0 ? 300 : step === 4 ? REST_MS : STEP_MS[step]);
  }
  function stop() { clearTimeout(timer); timer = 0; }
  function jump(i) {
    stop();
    holdUntil = performance.now() + 6000; // a click holds that step for a moment
    show(i);
    resume();
  }
  pauseBtn.addEventListener("click", function () {
    playing = !playing;
    pauseBtn.textContent = playing ? "Pause" : "Play";
    pauseBtn.setAttribute("aria-pressed", String(!playing));
    if (playing) resume(); else stop();
  });
  document.addEventListener("visibilitychange", function () { if (document.hidden) stop(); else resume(); });
  if (window.IntersectionObserver) {
    new IntersectionObserver(function (es) {
      inView = es[es.length - 1].isIntersecting;
      if (inView) resume(); else stop();
    }, { threshold: 0.35 }).observe(root);
  } else {
    inView = true;
    resume();
  }
})();

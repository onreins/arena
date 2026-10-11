/* The Arena guide page: why, the agent setup, what happens to a prediction,
   re-checking any score, and a few questions.
   The records themselves are on arena.html. */
(function () {
  "use strict";
  var U = window.ReinsUI, C = window.Callbook, esc = U.esc;
  var $ = function (id) { return document.getElementById(id); };
  U.topbar("callbook");
  C.tooltips();
  agentTabs();
  // The banner's copy button, then the icons and medallions.
  if ($("gd-copy")) $("gd-copy").innerHTML = C.copyButton($("mcp-cmd").textContent, "Copy the setup command");
  if ($("gd-prompt-copy")) $("gd-prompt-copy").innerHTML = C.copyButton($("gd-prompt").textContent, "Copy the prompt");
  C.medals();
  riseIn($("gd-title"));

  // The banner headline rises in word by word (callbook-guide.css): each word becomes its own span,
  // and the highlighted promise moves as one piece so its shimmer runs across the whole phrase.
  function riseIn(h) {
    if (!h) return;
    var i = 0;
    [].slice.call(h.childNodes).forEach(function (n) {
      if (n.nodeType === 1) { n.classList.add("w"); n.style.setProperty("--i", i++); return; }
      var frag = document.createDocumentFragment();
      n.textContent.split(/(\s+)/).forEach(function (w) {
        if (!w) return;
        if (/^\s+$/.test(w)) { frag.appendChild(document.createTextNode(w)); return; }
        var s = document.createElement("span");
        s.className = "w";
        s.style.setProperty("--i", i++);
        s.textContent = w;
        frag.appendChild(s);
      });
      h.replaceChild(frag, n);
    });
  }

  // The agent setup: a command for Claude Code, a config block for every other
  // app. The copy button copies whichever is showing.
  function agentTabs() {
    var tabs = [{ tab: $("mcp-tab-code"), pane: $("mcp-pane-code"), text: $("mcp-cmd").textContent, label: "Copy the command" },
      { tab: $("mcp-tab-json"), pane: $("mcp-pane-json"), text: $("mcp-json").textContent, label: "Copy the config" }];
    function pick(i, focus) {
      tabs.forEach(function (t, j) {
        t.tab.setAttribute("aria-selected", String(j === i));
        t.tab.tabIndex = j === i ? 0 : -1;
        t.pane.hidden = j !== i;
      });
      $("mcp-copy").innerHTML = C.copyButton(tabs[i].text, tabs[i].label);
      if (focus) tabs[i].tab.focus();
    }
    tabs.forEach(function (t, i) {
      t.tab.addEventListener("click", function () { pick(i); });
      t.tab.addEventListener("keydown", function (e) {
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); pick(1 - i, true); }
      });
    });
    pick(0);
  }

  // Re-check: the command for any record, house agents and people alike.
  function verify(D) {
    var sel = $("v-book");
    var all = (D.books || []).concat(D.callers || []);
    sel.innerHTML = all.map(function (b) { return '<option value="' + esc(b.id) + '">' + esc(C.nameOf(b)) + "</option>"; }).join("");
    var draw = function () {
      var b = all.filter(function (x) { return x.id === sel.value; })[0] || all[0];
      if (!b) { $("v-cmd").innerHTML = '<span class="c"># nothing to re-check yet: the first records appear here</span>'; $("v-copy").innerHTML = ""; return; }
      var cmd = "npm run arena:verify -- " + b.id;
      $("v-cmd").innerHTML = '<span class="c"># rebuild ' + esc(C.nameOf(b)) + "’s score from the chain and real prices</span>\n" +
        '<span class="p">$</span> ' + esc(cmd) + "\n" +
        '<span class="c"># ' + C.int(b.metrics.calls - (b.metrics.missed || 0)) + " recorded · " + C.int(b.metrics.revealed) + " revealed" +
        (b.validation ? " · expects score " + esc(b.validation.score) + " (" + esc(b.validation.tag) + ")" : " · not scored yet") + "</span>";
      $("v-copy").innerHTML = C.copyButton(cmd, "Copy the command");
    };
    sel.addEventListener("change", draw);
    draw();
    var addr = function (label, a, note) {
      return "<div><dt>" + esc(label) + "</dt><dd>" + (a ? C.txLink(D.explorer, a, C.shortHash(a, 8, 6), "address") : '<span class="muted">to deploy</span>') +
        (note ? "<small>" + esc(note) + "</small>" : "") + "</dd></div>";
    };
    $("v-addr").innerHTML = addr("Arena contract", D.contract, D.network) + addr("ERC-8004 Validation Registry", D.validationRegistry, "chain " + D.chainId);
  }

  C.loadIndex().then(function (D) {
    D.books = (D.books || []).filter(function (b) { return b && b.metrics; });
    D.callers = (D.callers || []).filter(function (c) { return c && c.metrics; });
    var b = D.books[0];
    if (b && b.periodSec && $("how-p")) $("how-p").textContent = "Reins’s agents: one prediction every " + C.hours(b.periodSec) + ", each held " + C.hours(b.horizonSec || b.periodSec);
    $("foot-gen").textContent = "Paper predictions, scored at Hyperliquid prices. Not investment advice." + (D.generated ? " Updated " + C.stamp(Date.parse(D.generated) / 1000) + "." : "");
    $("foot-net").textContent = D.network || "Arc";
    verify(D);
  }).catch(function () {
    $("v-cmd").innerHTML = '<span class="c"># the records couldn’t load; reload to try again</span>';
  });
})();

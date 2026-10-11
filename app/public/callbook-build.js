/* The Arena build page: the sidebar and top bar, and the MCP setup tabs
   (a command for Claude Code, a config block for every other app). Copy
   buttons are plain [data-copy] buttons, handled in callbook-common.js. */
(function () {
  "use strict";
  var U = window.ReinsUI, C = window.Callbook;
  var $ = function (id) { return document.getElementById(id); };
  U.topbar("callbook");
  C.tooltips();

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
})();

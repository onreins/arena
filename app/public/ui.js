/**
 * Shared pieces of the Reins app: formatting, the frame (sidebar and top bar), avatars,
 * return maths and charts. Every page loads this after wallet.js; nothing
 * here ever sees a key.
 */
window.ReinsUI = (function () {
  "use strict";
  var W = window.ReinsWallet;
  var $ = function (id) { return document.getElementById(id); };

  // ------------------------------------------------------------ formatting
  var FLAT = 0.005; // under half a basis point is rounding, not a move

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  var short = function (a) { return a ? a.slice(0, 6) + "…" + a.slice(-4) : ""; };
  function money(n, dp) {
    if (n === null || n === undefined) return "—";
    var d = dp === undefined ? 2 : dp;
    return "$" + n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  // Chamber style: $14.17M, $22.4K, $1.75.
  function compact(n) {
    if (n === null || n === undefined) return "—";
    var a = Math.abs(n);
    if (a >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
    if (a >= 1e4) return "$" + (n / 1e3).toFixed(1) + "K";
    return money(n);
  }
  // The headline: whole cents full weight, sub-cent digits dimmed.
  function bigMoneyHtml(n) {
    if (n === null || n === undefined) return "—";
    if (Math.abs(n) >= 100) return esc(money(n));
    var s = money(n, 4);
    return esc(s.slice(0, -2)) + '<span class="sub-cents">' + s.slice(-2) + "</span>";
  }
  var dirOf = function (p) { return p === null || p === undefined || Math.abs(p) < FLAT ? "flat" : p > 0 ? "up" : "down"; };
  function pct(p, dp) {
    if (p === null || p === undefined || isNaN(p)) return "—";
    var d = dp === undefined ? 2 : dp;
    if (Math.abs(p) < FLAT) return (0).toFixed(d) + "%";
    return (p > 0 ? "+" : "−") + Math.abs(p).toFixed(d) + "%";
  }
  var pctHtml = function (p, dp) { return '<span class="' + dirOf(p) + '">' + pct(p, dp) + "</span>"; };
  function stateOf(r) {
    if (r.closed) return ["closed", "Closed"];
    if (r.frozen) return ["frozen", "Frozen"];
    if (r.expired) return ["expired", "Expired"];
    return ["live", "Live"];
  }
  // Risk from the one number that bounds the downside: the loss limit.
  function riskOf(r) {
    var l = r && r.rules ? r.rules.maxLossPercent : null;
    if (l === null || l === undefined) return null;
    var n = l <= 5 ? 1 : l <= 10 ? 2 : l <= 20 ? 3 : l <= 35 ? 4 : 5;
    return { n: n, html: '<span class="risk r' + n + '" title="Its loss limit is −' + l + '%">Risk: ' + n + "/5</span>" };
  }

  // ------------------------------------------------------------------ icons
  // Outline icons on a 24-unit grid, drawn with the .ic stroke (Aave Pro's set).
  var PATHS = {
    explore: '<circle cx="12" cy="12" r="8.5"/><path d="m15.2 8.8-1.9 4.5-4.5 1.9 1.9-4.5z"/>',
    strategies: '<rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="M8 16v-4M12 16V8M16 16v-6"/>',
    create: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8.5v7M8.5 12h7"/>',
    chat: '<path d="M5 5h14a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5h-7.5L7 20v-3.5H5A1.5 1.5 0 0 1 3.5 15V6.5A1.5 1.5 0 0 1 5 5z"/><path d="M8 9.5h8M8 12.5h5"/>',
    window: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9h17M7 6.8h.01M9.5 6.8h.01"/>',
    shield: '<path d="M12 3.5 19 6v5.5c0 4.3-2.9 7.6-7 9-4.1-1.4-7-4.7-7-9V6z"/><path d="m9.3 12 1.9 1.9 3.6-3.6"/>',
    deposit: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8v8M8.5 12.5 12 16l3.5-3.5"/>',
    withdraw: '<circle cx="12" cy="12" r="8.5"/><path d="M12 16V8M8.5 11.5 12 8l3.5 3.5"/>',
    ext: '<path d="M7 17 17 7M9 7h8v8"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.3-4.3"/>',
    filter: '<path d="M4.5 7h15M7.5 12h9M10.5 17h3"/>',
    updown: '<path d="m8.5 9.5 3.5-3.5 3.5 3.5M8.5 14.5l3.5 3.5 3.5-3.5"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
    back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
    more: '<path d="M6 12h.01M12 12h.01M18 12h.01" stroke-width="2.6"/>',
    right: '<path d="m9.5 6 6 6-6 6"/>',
    down: '<path d="m6 9.5 6 6 6-6"/>',
    minus: '<path d="M6 12h12"/>',
    close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
    agent: '<circle cx="12" cy="9" r="3.5"/><path d="M5.5 19.5c1.2-3.2 3.6-4.8 6.5-4.8s5.3 1.6 6.5 4.8"/>',
    freeze: '<path d="M12 3.5v17M4.6 7.8l14.8 8.4M4.6 16.2l14.8-8.4M9.5 4.8 12 7l2.5-2.2M9.5 19.2 12 17l2.5 2.2"/>',
    exit: '<path d="M14 4.5h4.5v15H14M10 16l4-4-4-4M14 12H4"/>',
    charts: '<path d="M4 19.5h16"/><path d="M7 15.5v-5M7 8v-1.5"/><rect x="5.5" y="10" width="3" height="5.5" rx=".6"/><path d="M12 13v-6M12 17.5V16"/><rect x="10.5" y="7" width="3" height="9" rx=".6"/><path d="M17 11V9M17 17.5V16"/><rect x="15.5" y="11" width="3" height="5" rx=".6"/>',
    wallet: '<rect x="3.5" y="6" width="17" height="13" rx="2.5"/><path d="M3.5 9.5h17M16 14h.01"/>',
    // Arena: a call sealed shut, with the check it gets once it's verified.
    callbook: '<rect x="4.5" y="10" width="15" height="10.5" rx="2.2"/><path d="M8 10V7.6a4 4 0 0 1 8 0V10"/><path d="m9.3 15.3 1.9 1.9 3.6-3.6"/>',
    lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
    unlock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 7.6-1.7"/><path d="M12 14.5v2"/>',
    miss: '<circle cx="12" cy="12" r="8.5" stroke-dasharray="2.6 2.4"/><path d="M9 12h6"/>',
    terminal: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="m7.5 9.5 3 2.5-3 2.5M12.5 15h4"/>',
  };
  PATHS.menu = '<path d="M4.5 7.5h15M4.5 12h15M4.5 16.5h15"/>';
  PATHS.drop = '<path d="M12 3.5s5.5 6.1 5.5 10.2a5.5 5.5 0 0 1-11 0C6.5 9.6 12 3.5 12 3.5Z"/>';
  PATHS.code ='<path d="M8.5 7.5 4 12l4.5 4.5M15.5 7.5 20 12l-4.5 4.5M13.5 5.5l-3 13"/>';
  PATHS.copy ='<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>';
  var ALIAS = { external: "ext", chev: "right", sort: "updown", trend: "strategies", gauge: "shield", coins: "wallet", x: "close", user: "agent", logout: "exit" };
  function icon(name, size) {
    return '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"' + (size ? ' style="width:' + size + "px;height:" + size + 'px"' : "") + ">" +
      (PATHS[ALIAS[name] || name] || "") + "</svg>";
  }

  // A person's avatar, drawn from their address: a mirrored 5×5 grid in one hue.
  // Nothing is fetched, so it can't track anyone or be swapped for something else.
  function identicon(addr, size) {
    var a = String(addr || "").toLowerCase().replace(/^0x/, ""), px = size || 40;
    if (!/^[0-9a-f]{40}$/.test(a)) return "";
    var hue = parseInt(a.slice(0, 4), 16) % 360, cells = "";
    for (var i = 0; i < 15; i++) {
      if (parseInt(a.charAt(4 + i), 16) % 2) continue;
      var row = Math.floor(i / 3), col = i % 3;
      cells += '<rect x="' + (col + 1) + '" y="' + (row + 1) + '" width="1" height="1"/>';
      if (col < 2) cells += '<rect x="' + (5 - col) + '" y="' + (row + 1) + '" width="1" height="1"/>';
    }
    return '<svg class="cb-avatar" viewBox="0 0 7 7" width="' + px + '" height="' + px + '" aria-hidden="true">' +
      '<rect width="7" height="7" rx="1.6" fill="hsl(' + hue + ' 45% 14%)"/><g fill="hsl(' + hue + ' 80% 66%)" shape-rendering="crispEdges">' + cells + "</g></svg>";
  }

  // ---------------------------------------------------------------- avatars
  // Agents get a disc in a colour taken from their address, with the
  // name's initial; strategies show the coins they trade.
  function seed(address) {
    var h = 0, a = String(address || "").toLowerCase();
    for (var i = 2; i < a.length; i++) h = (h * 31 + a.charCodeAt(i)) >>> 0;
    return h;
  }
  function avatar(r, cls) {
    var hue = seed(r.address) % 360, st = stateOf(r)[0];
    var bg = st === "closed" ? "#3a3939" : "linear-gradient(135deg, hsl(" + hue + " 72% 58%), hsl(" + ((hue + 40) % 360) + " 70% 36%))";
    var initial = String(r.name || "?").trim().charAt(0).toUpperCase() || "?";
    return '<span class="tok' + (cls ? " " + cls : "") + '" style="background:' + bg + '" aria-hidden="true">' + esc(initial) + "</span>";
  }
  var COIN_ICONS = { BTC: "btc", ETH: "eth", SOL: "sol", USDC: "usdc", EURC: "eurc" };
  function coinImg(sym) { return Object.prototype.hasOwnProperty.call(COIN_ICONS, sym) ? '<img src="/tokens/' + COIN_ICONS[sym] + '.svg" alt="">' : "<i>" + esc(String(sym).slice(0, 3)) + "</i>"; }
  // Up to three of a universe's coins, in the space of one avatar.
  function coins(universe, cls) {
    var list = (universe || []).filter(function (u) { return u.charAt(0) !== "+"; }).slice(0, 3);
    if (list.length === 1) return '<span class="tok' + (cls ? " " + cls : "") + '">' + coinImg(list[0]) + "</span>";
    return '<span class="tok multi' + (cls ? " " + cls : "") + '" aria-hidden="true">' + list.map(coinImg).join("") + "</span>";
  }
  // How many coins a universe covers: "BTC, ETH, SOL, +22 large coins" is 25.
  function coinCount(universe) {
    return (universe || []).reduce(function (n, u) { return n + (u.charAt(0) === "+" ? parseInt(u.slice(1), 10) || 0 : 1); }, 0);
  }
  // A ring gauge, 0..1 filled.
  function ring(share, cls) {
    var r = 6.5, c = 2 * Math.PI * r, f = Math.max(0, Math.min(1, share || 0)) * c;
    return '<svg class="ring' + (cls ? " " + cls : "") + '" viewBox="0 0 16 16" aria-hidden="true"><circle class="t" cx="8" cy="8" r="' + r + '"/>' +
      '<circle class="v" cx="8" cy="8" r="' + r + '" stroke-dasharray="' + f.toFixed(2) + " " + c.toFixed(2) + '"/></svg>';
  }

  // ---------------------------------------------------------------- frame
  // Aave Pro's frame: a sidebar with grouped links, and a top bar with search
  // and the wallet. Pages provide <aside id="side"> and <header id="top">.
  var listeners = [];
  // The Reins mark: a rounded lowercase r and its dot, white on the dark sidebar.
  var MARK = '<svg width="26" height="26" viewBox="256 256 512 512" aria-hidden="true"><g fill="#fff"><rect x="307" y="327" width="130" height="368" rx="65"/><path d="M430 396C452 352 494 327 540 327a50.5 50.5 0 0 1 0 101c-58 0-103 34-103 96H415V396z"/><circle cx="670" cy="378" r="47"/></g></svg>';
  var NAV = [
    [null, [["explore", "Agents", "/"], ["strategies", "Strategies", "/strategies"], ["callbook", "Arena", "/arena"], ["chat", "Chat", "/chat"], ["charts", "Charts", "/charts"], ["create", "Create agent", "/create"]]],
    ["ARC", [["window", "Block explorer", "#", "nav-explorer"]]],
  ];
  // On a phone the sidebar is hidden, so the main pages move to a bar along the bottom.
  var TABS = [["explore", "Agents", "/"], ["strategies", "Strategies", "/strategies"], ["callbook", "Arena", "/arena"], ["charts", "Charts", "/charts"], ["chat", "Chat", "/chat"], ["create", "Create", "/create"]];
  function topbar(page) {
    var nav = NAV.map(function (g) {
      return (g[0] ? '<div class="grp">' + g[0] + "</div>" : "") + g[1].map(function (it) {
        return '<a class="item" href="' + it[2] + '"' + (it[3] ? ' id="' + it[3] + '" target="_blank" rel="noopener"' : "") +
          (it[0] === page ? ' aria-current="page"' : "") + ">" + icon(it[0]) + it[1] + (it[3] ? icon("ext").replace('class="ic"', 'class="ic ext"') : "") + "</a>";
      }).join("");
    }).join("");
    var hidden = false;
    try { hidden = localStorage.getItem("reins-promo") === "hidden"; } catch (e) { /* storage off */ }
    var rings = '<svg class="rings" viewBox="0 0 220 220" aria-hidden="true">' + [30, 55, 80, 105].map(function (r) {
      return '<circle cx="110" cy="110" r="' + r + '" fill="none" stroke="rgba(255,255,255,.07)"/>';
    }).join("") + "</svg>";
    $("side").className = "side";
    $("side").innerHTML =
      '<div class="side-head"><a class="brand" href="/">' + MARK + 'Reins <span class="tag">BETA</span></a></div>' +
      '<nav aria-label="Main">' + nav + "</nav>" +
      (hidden ? "" : '<div class="promo" id="promo">' + rings + '<span class="badge"><img src="/tokens/arc.svg" alt=""></span>' +
        '<button class="x" id="promo-x" type="button" aria-label="Hide">' + icon("minus") + "</button><b>Tokenized stocks</b><span>Coming to Arc</span></div>");
    $("top").className = "top";
    $("top").innerHTML =
      '<a class="top-brand" href="/" aria-label="Reins home">' + MARK + '<span class="tb-name">Reins</span><span class="tag">BETA</span></a>' +
      '<label class="search">' + icon("search") + '<span class="sr-only">Search agents and strategies</span>' +
      '<input id="gsearch" type="search" placeholder="Search agents and strategies" autocomplete="off"><kbd>/</kbd></label>' +
      '<div class="top-r"><span class="net" id="net"><i></i><span id="net-text">Arc</span></span>' +
      '<button class="btn-white" id="wallet" type="button" aria-haspopup="true">Sign in</button>' +
      // On a phone: round buttons for search and the menu, as on Aave Pro (mobile.css shows them).
      '<button class="top-ic" id="m-search" type="button" aria-label="Search">' + icon("search") + "</button>" +
      '<button class="top-ic" id="m-menu" type="button" aria-label="Menu" aria-expanded="false" aria-controls="mnav">' + icon("menu") + "</button></div>" +
      '<button class="top-ic" id="m-search-x" type="button" aria-label="Close search">' + icon("close") + "</button>";
    phoneMenu(page);
    if ($("promo-x")) $("promo-x").addEventListener("click", function () {
      $("promo").remove();
      try { localStorage.setItem("reins-promo", "hidden"); } catch (e) { /* storage off */ }
    });
    // Search lives on Explore and Strategies; elsewhere, Enter takes you to Explore with the query.
    $("gsearch").value = new URLSearchParams(location.search).get("q") || "";
    $("gsearch").addEventListener("keydown", function (e) {
      if (e.key === "Enter" && page !== "explore" && page !== "strategies") location.href = "/?q=" + encodeURIComponent($("gsearch").value.trim());
    });
    document.addEventListener("keydown", function (e) {
      var t = document.activeElement && document.activeElement.tagName;
      if (e.key === "/" && t !== "INPUT" && t !== "TEXTAREA" && t !== "SELECT") { e.preventDefault(); $("gsearch").focus(); }
    });
    // Signed in, the button is your avatar and opens your menu; signed out, it opens the sign-in panel.
    drawAccount(savedSession());
    $("wallet").addEventListener("click", function () {
      withAuth().then(function (A) {
        if (A.session()) A.menu($("wallet"));
        else A.open().catch(function () { /* closed */ });
      }).catch(function (err) { $("wallet").title = W.explain(err); });
    });
    withAuth().then(function (A) {
      A.onChange(function (s) {
        drawAccount(s);
        if (s) listeners.forEach(function (fn) { fn(s.address); });
      });
      return A.restore();
    }).then(function (s) { if (s) listeners.forEach(function (fn) { fn(s.address); }); }).catch(function () { /* sign-in unavailable */ });
    W.config().then(function (c) {
      $("nav-explorer").href = c.explorer;
      setNet(true, "Arc " + c.network);
    }).catch(function () { setNet(false, "Offline"); });
  }
  // The phone menu: every page, grouped, full screen under the top bar (Aave Pro's pattern).
  // A page with its own top bar (charts) passes where its menu button goes.
  function phoneMenu(page, host) {
    if (host) host.insertAdjacentHTML("beforeend", '<button type="button" class="top-ic" id="m-menu" aria-label="Menu" aria-expanded="false" aria-controls="mnav">' + icon("menu") + "</button>");
    var menu = document.createElement("nav");
    menu.className = "mnav";
    menu.id = "mnav";
    menu.setAttribute("aria-label", "Menu");
    menu.hidden = true;
    // A sub-page (the guide, your profile) is marked current over its section.
    var path = location.pathname.toLowerCase(), onSub = false;
    var current = function (it) { return it[3] === "sub" ? path === it[2].toLowerCase() : !onSub && it[0] === page; };
    // The main pages as tiles, each with its own colour and a few words on what's there.
    var TILE = {
      explore: ["blue", "Live on Arc"], strategies: ["violet", "Backtested ideas"], callbook: ["green", "Track records"],
      chat: ["amber", "Describe a strategy"], charts: ["orange", "Live markets"], create: ["pink", "Fund it, set limits"],
    };
    var tile = function (it) {
      var t = TILE[it[0]] || ["blue", ""];
      return '<a class="tile t-' + t[0] + '" href="' + it[2] + '"' + (current(it) ? ' aria-current="page"' : "") + ">" +
        '<span class="t-ic">' + icon(it[0]) + "</span><b>" + it[1] + "</b><small>" + t[1] + "</small></a>";
    };
    // Rows: [icon, label, href, "sub", external?, caption?]
    var row = function (it) {
      return '<a class="row" href="' + it[2] + '"' + (current(it) ? ' aria-current="page"' : "") + (it[4] ? ' target="_blank" rel="noopener"' : "") + ">" +
        '<span class="r-ic">' + icon(it[0]) + '</span><span class="r-txt"><b>' + it[1] + "</b>" + (it[5] ? "<small>" + it[5] + "</small>" : "") + "</span>" +
        icon(it[4] ? "ext" : "right").replace('class="ic"', 'class="ic r-go"') + "</a>";
    };
    var group = function (title, rows) {
      return rows.length ? '<div class="grp">' + title + '</div><div class="card">' + rows.map(row).join("") + "</div>" : "";
    };
    // Who's here: your profile when signed in, the way in when not.
    var account = function (s) {
      if (!s) {
        return '<div class="acct out"><div class="a-txt"><b>Sign in to Reins</b><small>A browser wallet or Google. Then see your record and link your agent.</small></div>' +
          '<button type="button" class="btn-white" data-act="signin">Sign in</button></div>';
      }
      var href = "/arena/p/" + s.address.toLowerCase();
      return '<a class="acct" href="' + href + '"' + (path === href ? ' aria-current="page"' : "") + ">" + identicon(s.address, 40) +
        '<span class="a-txt"><b>Your account</b><small><span class="mono">' + esc(short(s.address)) + "</span>" + (s.label ? " · " + esc(s.label) : "") + "</small></span>" +
        '<span class="a-go">Profile' + icon("right") + "</span></a>";
    };
    var draw = function () {
      var s = savedSession();
      var arena = [["info", "How Arena works", "/arena-guide", "sub", false, "Lock a call, get a record"]];
      onSub = arena.some(function (it) { return path === it[2].toLowerCase(); }) || (!!s && path === "/arena/p/" + s.address.toLowerCase());
      var arc = [];
      if ($("nav-explorer")) arc.push(["window", "Block explorer", $("nav-explorer").href, "sub", true]);
      var testnet = /testnet/i.test(($("net-text") || {}).textContent || "");
      if (testnet) arc.push(["drop", "Testnet USDC faucet", "https://faucet.circle.com", "sub", true]);
      menu.innerHTML =
        account(s) +
        '<div class="tiles">' + NAV[0][1].map(tile).join("") + "</div>" +
        group("Arena", arena) +
        group("Build", [
          ["terminal", "Arena for your agent", "https://www.npmjs.com/package/@onreins/mcp", "sub", true, "MCP for Claude, Cursor and others"],
          ["code", "Source code", "https://github.com/onreins/arena", "sub", true, "Open source on GitHub"],
        ]) +
        group("Arc", arc) +
        '<div class="m-foot"><span class="net' + ($("net") && $("net").classList.contains("off") ? " off" : "") + '"><i></i>' +
        esc(($("net-text") || {}).textContent || "Arc") + "</span><span>Reins · beta</span></div>";
      // Each block rises in, one after another.
      Array.prototype.forEach.call(menu.children, function (el, i) { el.style.setProperty("--i", i); });
    };
    document.body.appendChild(menu);
    var btn = $("m-menu");
    var set = function (open) {
      if (open) draw();
      menu.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
      btn.innerHTML = icon(open ? "close" : "menu");
      document.body.classList.toggle("mnav-on", open);
    };
    btn.addEventListener("click", function () { set(menu.hidden); });
    menu.addEventListener("click", function (e) {
      if (e.target.closest("a")) set(false);
      if (e.target.closest('[data-act="signin"]')) {
        set(false);
        withAuth().then(function (A) { return A.open(); }).catch(function () { /* closed */ });
      }
    });
    // Signing in or out while the menu is open redraws its account card.
    window.addEventListener("reins:session", function () { if (!menu.hidden) draw(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !menu.hidden) { set(false); btn.focus(); } });
    window.addEventListener("resize", function () { if (window.innerWidth > 900 && !menu.hidden) set(false); });
    // Search: the round button opens the field across the whole top bar.
    var top = $("top");
    if (!top || !$("m-search")) return;
    var search = function (on) {
      top.classList.toggle("searching", on);
      if (on) { set(false); $("gsearch").focus(); }
    };
    $("m-search").addEventListener("click", function () { search(true); });
    $("m-search-x").addEventListener("click", function () { search(false); });
    $("gsearch").addEventListener("keydown", function (e) { if (e.key === "Escape") search(false); });
  }
  function setNet(ok, text) {
    $("net").classList.toggle("off", !ok);
    if (text) $("net-text").textContent = text;
  }
  // The sign-in module (auth.js) and its styles load once, on every page.
  var authLoad = null;
  function withAuth() {
    if (window.ReinsAuth) return Promise.resolve(window.ReinsAuth);
    authLoad = authLoad || new Promise(function (resolve, reject) {
      var css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "/auth.css";
      document.head.appendChild(css);
      var s = document.createElement("script");
      s.src = "/auth.js";
      s.onload = function () { resolve(window.ReinsAuth); };
      s.onerror = function () { authLoad = null; reject(new Error("Sign-in couldn't load. Reload the page.")); };
      document.head.appendChild(s);
    });
    return authLoad;
  }
  function savedSession() {
    try {
      var s = JSON.parse(localStorage.getItem("reins.session.v1") || "null");
      return s && /^0x[0-9a-fA-F]{40}$/.test(s.address || "") ? s : null;
    } catch (e) { return null; }
  }
  function drawAccount(s) {
    var b = $("wallet");
    if (!b) return;
    b.classList.toggle("signed", !!s);
    b.innerHTML = s ? identicon(s.address, 24) + '<span class="who">' + esc(short(s.address)) + "</span>" + icon("down") : "Sign in";
    b.setAttribute("aria-label", s ? "Your account, " + short(s.address) : "Sign in");
    // Pages that show something only to you (your own profile) redraw on this.
    try { window.dispatchEvent(new CustomEvent("reins:session", { detail: s || null })); } catch (e) { /* old browser */ }
  }
  /** Signed in, the address; otherwise the sign-in panel first. Pages await this before acting. */
  async function connect() {
    if (W.account) return W.account;
    var A = await withAuth();
    var s = A.session();
    if (s) {
      await A.restore();
      if (W.account) return W.account;
    }
    return A.open();
  }
  var onAccount = function (fn) { listeners.push(fn); };

  // --------------------------------------------------------------- series
  var SPAN = { "1d": 86400, "1w": 604800, "1m": 2592000 };
  var WHEN = { "1d": "past day", "1w": "past week", "1m": "past month", all: "since funding" };

  // Every point carries `index`: what $1 put in at funding is worth then.
  // The server chains it across deposits, withdrawals and unfreezes
  // (arena/returns.js), so a movement of money is never a gain or a loss and
  // an unfreeze can't wipe a loss off the record. A return over any period is
  // the ratio of two indexes.
  function growth(p) {
    if (typeof p.index === "number") return p.index;
    return p.baselineUsd > 0 ? p.equityUsd / p.baselineUsd : null;
  }

  // Same chaining, for series built in the browser (several mandates summed).
  function chain(points) {
    var idx = 1, prev = null;
    return points.map(function (p) {
      var r = p.baselineUsd > 0 ? p.equityUsd / p.baselineUsd : null;
      if (r !== null && prev !== null && !p.reset) idx *= r / prev;
      prev = r;
      return Object.assign({}, p, { index: idx });
    });
  }

  // a, z: windowed points { v, i }. pct from the indexes; diff is what the
  // period's return is worth on today's balance.
  function change(a, z) {
    var p, diff;
    if (a.i && z.i) { p = (z.i / a.i - 1) * 100; diff = z.v * (1 - a.i / z.i); }
    else { diff = z.v - a.v; p = a.v ? (diff / a.v) * 100 : 0; }
    return { diff: diff, pct: p, dir: Math.abs(diff) < 0.00005 ? "flat" : diff > 0 ? "up" : "down" };
  }

  // Cut a mandate's points to a range, carrying in the value held at its start.
  function windowed(points, range) {
    var now = Math.floor(Date.now() / 1000);
    var start = SPAN[range] ? now - SPAN[range] : points[0].t;
    var head = points[0];
    points.forEach(function (p) { if (p.t <= start) head = p; });
    var row = function (p, t) { return { t: t, v: p.equityUsd, b: p.baselineUsd, i: growth(p), events: t === p.t ? p.events || [] : [] }; };
    var out = [row(head, start)];
    points.forEach(function (p) { if (p.t > start) out.push(row(p, p.t)); });
    var tail = out[out.length - 1];
    if (tail.t < now) out.push({ t: now, v: tail.v, b: tail.b, i: tail.i, events: [] });
    return out;
  }

  // Return over each period, the leaderboard's columns.
  function periodReturns(points) {
    var out = {};
    ["1d", "1w", "1m", "all"].forEach(function (k) {
      if (!points || !points.length) { out[k] = null; return; }
      var s = windowed(points, k), a = s[0], z = s[s.length - 1];
      out[k] = a.i && z.i ? change(a, z).pct : null;
    });
    return out;
  }

  // Several mandates as one: at every moment, the sum of what each held,
  // chained the same way. A moment where any of them moved money is a reset.
  function combine(lists) {
    var ts = [];
    lists.forEach(function (l) { l.forEach(function (p) { ts.push(p.t); }); });
    ts = ts.filter(function (t, i, a) { return a.indexOf(t) === i; }).sort(function (a, b) { return a - b; });
    return chain(ts.map(function (t) {
      var v = 0, b = 0, events = [], reset = false;
      lists.forEach(function (l) {
        var last = null;
        l.forEach(function (p) { if (p.t <= t) last = p; });
        if (!last) return;
        v += last.equityUsd; b += last.baselineUsd;
        if (last.t === t) { events = events.concat(last.events || []); reset = reset || !!last.reset; }
      });
      return { t: t, equityUsd: v, baselineUsd: b, events: events, reset: reset };
    }));
  }

  // The chart's line: growth rebased to 1 at the start of the range.
  function index(series) {
    var base = null, last = 1;
    return series.map(function (s) {
      if (s.i) {
        if (base === null) base = s.i;
        last = s.i / base;
      }
      return last;
    });
  }
  // At least ±0.5% of room, so a 0.04% move looks like 0.04%.
  function domain(vals, around) {
    var c = around === undefined ? 1 : around, span = Math.abs(c) * 0.005 || 0.005;
    var lo = Math.min.apply(null, vals.concat([c - span])), hi = Math.max.apply(null, vals.concat([c + span]));
    var pad = (hi - lo) * 0.1;
    return [lo - pad, hi + pad];
  }
  function stepPath(series, vals, X, Y) {
    var d = "M" + X(series[0].t).toFixed(1) + " " + Y(vals[0]).toFixed(1);
    for (var i = 1; i < series.length; i++) d += " H" + X(series[i].t).toFixed(1) + " V" + Y(vals[i]).toFixed(1);
    return d;
  }
  var gradN = 0;
  function gradient(id, color, top) {
    return '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + color + '" stop-opacity="' + top + '"/>' +
      '<stop offset="1" stop-color="' + color + '" stop-opacity="0"/></linearGradient></defs>';
  }

  // ------------------------------------------------------------ card chart
  // Chamber's card chart: a teal performance area, no axes. A vault's value
  // only moves when it trades, so it steps; a backtest's weekly curve
  // ({ smooth: true }) is drawn point to point.
  function linePath(series, vals, X, Y) {
    return series.map(function (p, i) { return (i ? "L" : "M") + X(p.t).toFixed(1) + " " + Y(vals[i]).toFixed(1); }).join(" ");
  }
  function areaSvg(points, opts) {
    if (!points || !points.length) {
      return '<svg viewBox="0 0 300 150" aria-hidden="true"><path d="M0 75H300" stroke="#3a3939" stroke-width="2" stroke-dasharray="0.1 7" stroke-linecap="round"/></svg>';
    }
    var s = windowed(points, "all"), vals = index(s), dom = domain(vals);
    var t0 = s[0].t, t1 = s[s.length - 1].t > t0 ? s[s.length - 1].t : t0 + 1;
    var X = function (t) { return ((t - t0) / (t1 - t0)) * 300; };
    var Y = function (v) { return 8 + (1 - (v - dom[0]) / (dom[1] - dom[0])) * 134; };
    var d = (opts && opts.smooth ? linePath : stepPath)(s, vals, X, Y), id = "ag" + gradN++;
    return '<svg viewBox="0 0 300 150" preserveAspectRatio="none" aria-hidden="true">' + gradient(id, "#1e9bff", 0.28) +
      '<path d="' + d + ' V150 H0 Z" fill="url(#' + id + ')"/><path d="' + d + '" fill="none" stroke="#1e9bff" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>';
  }

  // ---------------------------------------------------------- detail chart
  /**
   * The vault chart. "performance" plots return (deposits and withdrawals
   * leave it flat); "value" plots equity in dollars. Point at it, or arrow
   * along it, and the headline reads that moment.
   *
   * @param {object} o  { plot, big, chg, when, ranges } elements
   */
  function Chart(o) {
    var points = null, range = "all", mode = "performance", st = null;
    var EV = { Frozen: "#e8716b", Deposited: "#bcbbbb", Withdrawn: "#bcbbbb", Traded: "#1e9bff", AgentChanged: "#bcbbbb" };
    var stamp = function (t, withTime) {
      return new Date(t * 1000).toLocaleString("en-GB", withTime ? { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" } : { day: "2-digit", month: "short" });
    };

    function headline(s, i, whenText) {
      var c = change(st.first, s);
      if (mode === "performance") {
        o.big.innerHTML = '<span class="' + c.dir + '">' + pct(c.pct) + "</span>";
        o.chg.innerHTML = (c.diff < 0 ? "−" : "+") + esc(money(Math.abs(c.diff), 4)) + " on " + esc(money(s.v, 2));
      } else {
        o.big.innerHTML = bigMoneyHtml(s.v);
        o.chg.innerHTML = pctHtml(c.pct);
      }
      o.when.textContent = whenText;
    }

    function draw() {
      if (!points || !points.length) return;
      var s = windowed(points, range), first = s[0], end = s[s.length - 1];
      var vals = mode === "performance" ? index(s) : s.map(function (x) { return x.v; });
      var dom = domain(vals, mode === "performance" ? 1 : vals[0]);
      var Wd = Math.max(300, Math.round(o.plot.clientWidth || 640)), H = 240, TOP = 10, BOT = 206, RIGHT = 58;
      var t0 = first.t, t1 = end.t > t0 ? end.t : t0 + 1;
      var X = function (t) { return ((t - t0) / (t1 - t0)) * (Wd - RIGHT); };
      var Y = function (v) { return TOP + (1 - (v - dom[0]) / (dom[1] - dom[0])) * (BOT - TOP); };
      var d = stepPath(s, vals, X, Y), id = "cg" + gradN++;
      var tick = function (v) { return mode === "performance" ? pct((v - 1) * 100, 2) : money(v, dom[1] - dom[0] < 0.5 ? 4 : 2); };
      var yl = "";
      for (var k = 0; k < 4; k++) {
        var v = dom[1] - ((dom[1] - dom[0]) * (k + 0.5)) / 4;
        yl += '<text x="' + Wd + '" y="' + (Y(v) + 4).toFixed(1) + '" text-anchor="end" fill="#636161" font-size="11.5" font-family="Inter, sans-serif">' + tick(v) + "</text>";
      }
      var xl = "";
      var spanDays = (t1 - t0) / 86400;
      // Fewer dates on a narrow chart, so they never overlap.
      var NX = Wd < 460 ? 3 : 5;
      for (var n = 0; n < NX; n++) {
        var tt = t0 + ((t1 - t0) * n) / (NX - 1);
        xl += '<text x="' + X(tt).toFixed(1) + '" y="' + (H - 4) + '" text-anchor="' + (n === 0 ? "start" : n === NX - 1 ? "end" : "middle") +
          '" fill="#636161" font-size="11.5" font-family="Inter, sans-serif">' + (n === NX - 1 ? "Now" : stamp(tt, spanDays < 3)) + "</text>";
      }
      var marks = s.map(function (x, i) {
        var ev = (x.events || []).filter(function (e) { return e !== "now"; });
        if (!ev.length) return "";
        var c = ev.indexOf("Frozen") >= 0 ? EV.Frozen : EV[ev[0]] || "#1e9bff";
        return '<circle cx="' + X(x.t).toFixed(1) + '" cy="' + Y(vals[i]).toFixed(1) + '" r="3.5" fill="' + c + '" stroke="#1a1919" stroke-width="1.5"><title>' + esc(ev.join(" + ")) + "</title></circle>";
      }).join("");
      var y0 = Y(vals[0]).toFixed(1);
      o.plot.innerHTML =
        '<svg viewBox="0 0 ' + Wd + " " + H + '" role="img" aria-label="' + (mode === "performance" ? "Return " : "Equity ") + esc(WHEN[range]) + ": " +
        pct(change(first, end).pct) + ', equity now ' + esc(money(end.v, 4)) + '">' + gradient(id, "#1e9bff", 0.22) + yl + xl +
        '<line x1="0" x2="' + (Wd - RIGHT) + '" y1="' + y0 + '" y2="' + y0 + '" stroke="rgba(255,255,255,.18)" stroke-width="1.5" stroke-dasharray="0.1 5" stroke-linecap="round"/>' +
        '<path d="' + d + " V" + BOT + ' H0 Z" fill="url(#' + id + ')"/>' +
        '<path d="' + d + '" fill="none" stroke="#1e9bff" stroke-width="1.8" stroke-linejoin="round"/>' + marks +
        '<g id="' + id + '-s" visibility="hidden"><line y1="' + TOP + '" y2="' + BOT + '" stroke="rgba(255,255,255,.3)" stroke-dasharray="3 3"/><circle r="5" fill="#1e9bff" stroke="#1a1919" stroke-width="2"/></g></svg>';
      st = { s: s, vals: vals, X: X, Y: Y, W: Wd, first: first, end: end, idx: -1, g: $(id + "-s") };
      headline(end, s.length - 1, WHEN[range]);
    }

    function scrubTo(i) {
      if (!st || !st.s[i]) return;
      st.idx = i;
      var x = st.X(st.s[i].t).toFixed(1), y = st.Y(st.vals[i]).toFixed(1);
      st.g.setAttribute("visibility", "visible");
      st.g.querySelector("line").setAttribute("x1", x);
      st.g.querySelector("line").setAttribute("x2", x);
      st.g.querySelector("circle").setAttribute("cx", x);
      st.g.querySelector("circle").setAttribute("cy", y);
      var ev = (st.s[i].events || []).filter(function (e, j, a) { return e !== "now" && a.indexOf(e) === j; });
      headline(st.s[i], i, stamp(st.s[i].t, true) + (ev.length ? " · " + ev.join(" + ") : ""));
    }
    function scrubEnd() {
      if (!st || st.idx < 0) return;
      st.idx = -1;
      st.g.setAttribute("visibility", "hidden");
      headline(st.end, st.s.length - 1, WHEN[range]);
    }
    function idxAt(clientX) {
      var box = o.plot.getBoundingClientRect(), x = ((clientX - box.left) / box.width) * st.W, idx = 0;
      // A step chart holds each value until the next point: take the last at or before x.
      for (var i = 0; i < st.s.length; i++) if (st.X(st.s[i].t) <= x) idx = i;
      return idx;
    }
    o.plot.addEventListener("pointermove", function (ev) { if (st) scrubTo(idxAt(ev.clientX)); });
    o.plot.addEventListener("pointerleave", scrubEnd);
    o.plot.addEventListener("blur", scrubEnd);
    o.plot.addEventListener("keydown", function (ev) {
      if (!st) return;
      var last = st.s.length - 1, cur = st.idx < 0 ? last : st.idx;
      var keys = { ArrowLeft: Math.max(0, cur - 1), ArrowRight: Math.min(last, cur + 1), Home: 0, End: last };
      if (ev.key in keys) { scrubTo(keys[ev.key]); ev.preventDefault(); } else if (ev.key === "Escape") scrubEnd();
    });
    function pressGroup(group, attr, onPick) {
      Array.prototype.forEach.call(group.querySelectorAll("button"), function (b) {
        b.addEventListener("click", function () {
          Array.prototype.forEach.call(group.querySelectorAll("button"), function (x) { x.setAttribute("aria-pressed", "false"); });
          b.setAttribute("aria-pressed", "true");
          onPick(b.getAttribute(attr));
        });
      });
    }
    pressGroup(o.ranges, "data-r", function (r) { range = r; draw(); });
    if (o.modes) pressGroup(o.modes, "data-m", function (m) { mode = m; draw(); });
    var timer = null;
    window.addEventListener("resize", function () { clearTimeout(timer); timer = setTimeout(function () { if (!st || st.idx < 0) draw(); }, 150); });

    return {
      set: function (p) { points = p; if (!st || st.idx < 0) draw(); }, // never yank the chart out from under a scrub
      empty: function (msg) { o.plot.innerHTML = '<div class="plot-empty">' + esc(msg) + "</div>"; },
    };
  }

  var RANGES = '<button type="button" data-r="1d" aria-pressed="false">1D</button><button type="button" data-r="1w" aria-pressed="false">1W</button>' +
    '<button type="button" data-r="1m" aria-pressed="false">1M</button><button type="button" data-r="all" aria-pressed="true">ALL</button>';

  async function getJson(path) {
    var res = await fetch(path);
    if (!res.ok) throw new Error("Couldn’t read " + path + " (" + res.status + ")");
    return res.json();
  }

  // --------------------------------------------------------------- sparkline
  // Hyperliquid's "Snapshot" column: a small line, green if it ends above its start.
  function spark(vals) {
    vals = (vals || []).filter(function (v) { return typeof v === "number" && isFinite(v); });
    if (vals.length < 2) return '<svg class="spark" viewBox="0 0 90 26" aria-hidden="true"><path d="M0 13H90" stroke="#3a3939" stroke-dasharray="2 4"/></svg>';
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals), span = hi - lo || Math.abs(hi) * 0.01 || 1;
    var d = vals.map(function (v, i) { return (i ? "L" : "M") + (i / (vals.length - 1) * 90).toFixed(1) + " " + (23 - ((v - lo) / span) * 20).toFixed(1); }).join("");
    var up = vals[vals.length - 1] >= vals[0];
    return '<svg class="spark" viewBox="0 0 90 26" aria-hidden="true"><path d="' + d + '" fill="none" stroke="' + (up ? "#66c399" : "#e8716b") + '" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  }
  // A growth index for a series of { t, equityUsd, baselineUsd, index } points.
  function indexOf(points) { return (points || []).map(function (p) { return typeof p.index === "number" ? p.index : p.baselineUsd > 0 ? p.equityUsd / p.baselineUsd : null; }); }

  // ------------------------------------------------------------ strategies
  // A backtested strategy's weekly growth curve ({ t, index }) in the point shape the charts read.
  function curvePoints(curve) {
    return (curve || []).map(function (p) { return { t: p.t, equityUsd: p.index, baselineUsd: 1, index: p.index }; });
  }
  // A stable stand-in address, so each strategy gets its own character.
  function pseudoAddress(id) {
    var h = 2166136261, s = String(id), out = "0x";
    for (var i = 0; out.length < 42; i++) { h = Math.imul(h ^ s.charCodeAt(i % s.length), 16777619) >>> 0; out += (h >>> 28).toString(16); }
    return out;
  }
  // Risk 1-5 from a strategy's worst backtested drop, in the same badge as an agent's.
  function strategyRisk(s) {
    var dd = Math.round(Math.abs(s.stats.max_drawdown) * 100);
    return '<span class="risk r' + s.risk + '" title="Worst backtested drop −' + dd + '%">Risk: ' + s.risk + "/5</span>";
  }

  return {
    FLAT: FLAT, esc: esc, short: short, money: money, compact: compact, bigMoneyHtml: bigMoneyHtml, dirOf: dirOf,
    pct: pct, pctHtml: pctHtml, stateOf: stateOf, riskOf: riskOf, icon: icon, identicon: identicon, avatar: avatar, coins: coins, coinCount: coinCount, ring: ring, RANGES: RANGES,
    topbar: topbar, phoneMenu: phoneMenu, TABS: TABS, MARK: MARK, setNet: setNet, connect: connect, onAccount: onAccount,
    change: change, periodReturns: periodReturns, combine: combine, areaSvg: areaSvg, Chart: Chart, getJson: getJson,
    curvePoints: curvePoints, pseudoAddress: pseudoAddress, strategyRisk: strategyRisk, spark: spark, indexOf: indexOf, windowed: windowed,
  };
})();

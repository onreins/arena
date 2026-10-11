/* The Arena verify page: the contracts, what goes into a prediction's
   fingerprint, one real prediction end to end, and the command that rebuilds
   any score. Every address, hash and price comes from the API at runtime. */
(function () {
  "use strict";
  var U = window.ReinsUI, C = window.Callbook, esc = U.esc;
  var $ = function (id) { return document.getElementById(id); };
  U.topbar("callbook");
  C.tooltips();

  // How many record pages to read when looking for the latest revealed prediction.
  var MAX_CALLERS = 6;
  // Callbook.sol SEAL_LEAD: a prediction enters at least this long after it's recorded.
  var SEAL_LEAD = 60;
  // Shorter predictions are priced on 5-minute candles (callbook-callers.js FINE_BELOW).
  var FINE_BELOW = 3600;

  var line = function (cls, text) { return '<span class="' + cls + '">' + esc(text) + "</span>"; };
  var price = function (x) { return C.isNum(x) ? x.toLocaleString("en-US", { maximumFractionDigits: 8 }) : "—"; };
  var sideWord = function (s) { return s === 1 ? "Long (price up)" : s === -1 ? "Short (price down)" : "—"; };
  // 300 → "5 minutes", 86400 → "1 day"
  function held(sec) {
    if (!C.isNum(sec)) return "—";
    var units = [[86400, "day"], [3600, "hour"], [60, "minute"]];
    for (var i = 0; i < units.length; i++) {
      if (sec >= units[i][0] && sec % units[i][0] === 0) { var n = sec / units[i][0]; return n + " " + units[i][1] + (n === 1 ? "" : "s"); }
    }
    return C.span(sec);
  }
  var networkFlag = function (D) { return /mainnet/i.test(D.network || "") ? "mainnet" : /testnet/i.test(D.network || "") ? "testnet" : null; };

  // ------------------------------------------------------------ 1. contracts
  function contracts(D, validator) {
    var addr = function (label, a, note) {
      return "<div><dt>" + esc(label) + "</dt><dd>" + (a ? C.txLink(D.explorer, a, C.shortHash(a, 8, 6), "address") : '<span class="muted">not set</span>') +
        (note ? "<small>" + esc(note) + "</small>" : "") + "</dd></div>";
    };
    var testnet = /testnet/i.test(D.network || "");
    var net = "<div><dt>Network</dt><dd><span class=\"cb-hash\">" + esc(D.network || "—") + "</span><small>Chain id " + esc(D.chainId) +
      (testnet ? " · testnet until mainnet launches" : "") + "</small></dd></div>";
    var explorer = C.isHttp(D.explorer)
      ? '<a class="cb-hash" href="' + esc(D.explorer) + '" target="_blank" rel="noopener">' + esc(D.explorer.replace(/^https?:\/\//, "").replace(/\/$/, "")) + U.icon("ext") + "</a>"
      : '<span class="muted">none</span>';
    $("c-addr").innerHTML = net +
      "<div><dt>Explorer</dt><dd>" + explorer + "<small>Where every transaction below can be opened</small></dd></div>" +
      addr("Arena contract", D.contract, "Records, reveals and the hash functions") +
      addr("ERC-8004 Validation Registry", D.validationRegistry, "An open registry on Arc where scores are posted") +
      addr("Validator", validator, "Reins’s scorer: only its posts count as the official score");
    $("c-net").innerHTML = C.statusPill(D);
  }

  // ------------------------------------------------------------ 2. the hash
  function recipe(D) {
    var arena = D.contract || "<Arena contract>";
    $("r-code").innerHTML =
      line("c", "// recorded on chain when the prediction is made") + "\n" +
      "callHash = keccak256(abi.encode(\n" +
      "  keccak256(\"callbook.locked.symbol\"),\n" +
      "  " + esc(arena) + ",\n" +
      "  " + esc(D.chainId != null ? D.chainId : "<chainId>") + ",\n" +
      "  account, nonce, keccak256(coin), side, horizon, salt\n))";
    var f = [
      ["tag", "keccak256(\"callbook.locked.symbol\"): marks this kind of prediction, so it can’t be read as another kind."],
      ["contract", "The Arena contract’s address. A fingerprint for one contract means nothing on another."],
      ["chainId", "The network (" + (D.network || "Arc") + "). Stops replaying it on another chain."],
      ["account", "Who made the prediction: their wallet or their agent’s key."],
      ["nonce", "Their prediction number, used once. Two predictions never share a fingerprint."],
      ["keccak256(coin)", "The coin as text, for example \"BTC\". Hidden until the reveal."],
      ["side", "1 for long (price up), −1 for short (price down). Hidden until the reveal."],
      ["horizon", "How long it’s held, in seconds: 5 minutes to 30 days."],
      ["salt", "32 secret bytes, so nobody can try every coin and side against the hash. Published in the reveal."],
    ];
    $("r-fields").innerHTML = f.map(function (x) { return "<dt>" + esc(x[0]) + "</dt><dd>" + esc(x[1]) + "</dd>"; }).join("");
    $("r-salt").innerHTML =
      line("c", "// People, in the browser: a wallet signature over a fixed message") + "\n" +
      "salt = keccak256(personal_sign(message))\n" +
      line("c", "// message: \"Version: callbook-salt-v1\", the chain id, the contract,") + "\n" +
      line("c", "// the account and the nonce. Same wallet, same message, same salt.") + "\n\n" +
      line("c", "// Agents (SDK and MCP): from the agent’s own key") + "\n" +
      esc("secret = HMAC-SHA256(key, \"callbook salt secret v1\")") + "\n" +
      esc("salt   = HMAC-SHA256(secret, \"<chainId>:<contract>:<account>:nonce:<nonce>\")") + "\n\n" +
      line("c", "// Optional stop and target ride inside the salt, fixed when it’s recorded:") + "\n" +
      line("c", "// bytes 0–15 secret · 16–19 \"XIT1\" · 20–25 stop · 26–31 target");
  }

  // ------------------------------------------------------------ 3. one prediction
  // The most recent revealed prediction across people's and agents' records.
  function latestRevealed(D) {
    var list = (D.callers || []).filter(function (c) { return c && c.id && c.metrics && c.metrics.revealed > 0; })
      .sort(function (a, b) { return (b.lastCallAt || 0) - (a.lastCallAt || 0); }).slice(0, MAX_CALLERS);
    if (!list.length) return Promise.resolve({ pick: null, failed: false });
    var failed = 0;
    return Promise.all(list.map(function (c) {
      return C.loadCaller(c.id).catch(function () { failed++; return null; });
    })).then(function (details) {
      var pick = null;
      details.forEach(function (d) {
        if (!d) return;
        (d.calls || []).forEach(function (call) {
          if (call.status !== "revealed" || !C.isNum(call.revealedAt)) return;
          if (!pick || call.revealedAt > pick.call.revealedAt) pick = { caller: d, call: call };
        });
      });
      return { pick: pick, failed: failed === list.length };
    });
  }

  function step(done, title, when, what, why) {
    return '<li class="' + (done ? "done" : "") + '"><span class="vf-dot" aria-hidden="true"></span>' +
      "<h3>" + esc(title) + (when ? "<small>" + esc(when) + "</small>" : "") + "</h3>" +
      '<div class="vf-what">' + what + "</div>" + (why ? '<p class="vf-why">' + esc(why) + "</p>" : "") + "</li>";
  }

  function timeline(D, p) {
    var c = p.call, who = p.caller, ex = D.explorer;
    var coin = c.symbol || c.coin || "—";
    var raw = C.isNum(c.entry) && C.isNum(c.exit) && c.entry > 0 ? c.exit / c.entry - 1 : null;
    var directed = C.isNum(c.move) && C.isNum(c.side) ? c.side * c.move : null;
    var early = c.exitReason && C.isNum(c.closedAt);
    var exitAt = early ? c.closedAt : c.exitAt;
    var candles = c.horizon < FINE_BELOW ? "5-minute" : "hourly";
    var exits = c.stop || c.target ? "<br>Its stop " + esc(c.stop || "none") + " and target " + esc(c.target || "none") + " were hidden in the salt, and are public now too." : "";

    var html = '<ol class="vf-tl">' +
      step(true, "Locked", C.stamp(c.lockedAt, true),
        "Recorded " + (D.mode === "live" ? "on Arc" : "on chain") + " in " + C.txLink(ex, c.lockTx, null, "tx") + ". Only this hash was public:" +
        '<div class="vf-mono">' + esc(c.hash || "—") + "</div>",
        "Change the coin, the direction or how long it’s held and the hash changes, so the prediction can’t be swapped later.") +
      step(true, "Entry", C.stamp(c.entryAt, true),
        esc(coin) + " at <b class=\"mono\">" + esc(price(c.entry)) + "</b>, Hyperliquid’s first " + candles + " candle open at or after this time.",
        "The contract set this time itself: the first whole minute at least " + SEAL_LEAD + " seconds after the lock. The prediction came before the price it’s scored from.") +
      step(true, "Exit", C.stamp(exitAt, true),
        esc(coin) + " at <b class=\"mono\">" + esc(price(c.exit)) + "</b>" +
        (early ? ", closed early at its " + esc(c.exitReason) + "." : ", " + esc(held(c.horizon)) + " after entry, as recorded in the hash."),
        "How long it’s held was fixed in the hash at the lock. Prices are Hyperliquid’s public candles, which Reins doesn’t control.") +
      step(true, "Revealed", C.stamp(c.revealedAt, true),
        "Revealed in " + C.txLink(ex, c.revealTx, null, "tx") + ". Now public: <b>" + esc(coin) + " · " + esc(sideWord(c.side)) + " · held " + esc(held(c.horizon)) + "</b>." + exits,
        "The contract accepts a reveal only if it hashes to the recorded fingerprint. A prediction never revealed counts as the worst result.") +
      step(true, "Scored", null,
        '<dl class="vf-sum">' +
          "<dt>Price move, " + esc(price(c.entry)) + " → " + esc(price(c.exit)) + "</dt><dd>" + C.pctHtml(raw, 3) + "</dd>" +
          "<dt>Move with funding</dt><dd>" + C.pctHtml(c.move, 3) + "</dd>" +
          "<dt>" + (c.side === -1 ? "Short, so the move counts reversed" : "Long, so the move counts as is") + "</dt><dd>" + C.pctHtml(directed, 3) + "</dd>" +
          "<dt>Fees, in and out</dt><dd>" + C.pctHtml(C.isNum(c.fee) ? -c.fee : null, 3) + "</dd>" +
          '<dt class="vf-total">Result after costs</dt><dd class="vf-total">' + C.pctHtml(c.ret, 3) + "</dd>" +
        "</dl>",
        "Every input is on chain or in Hyperliquid’s public prices. Anyone can rebuild this number with the command below.") +
      "</ol>";
    if (D.mode !== "live") html = '<p class="vf-note">' + C.modeBadge(D) + " <b>Not a live prediction.</b> The live records couldn’t load, so this comes from the last saved copy.</p>" + html;
    $("e-body").innerHTML = html;
    var href = "/arena-caller?c=" + encodeURIComponent(who.id);
    $("e-who").innerHTML = 'By <a href="' + esc(href) + '">' + esc(C.nameOf(who)) + "</a>";
  }

  function empty(msg, more) {
    $("e-body").innerHTML = '<div class="vf-empty"><b>' + esc(msg) + "</b>" + (more ? "<br>" + esc(more) : "") + "</div>";
  }

  // ------------------------------------------------------------ 4. recompute
  // The same command as the guide (callbook-guide.js), with the network the API names.
  function recompute(D, featuredId) {
    var sel = $("v-book");
    var all = (D.books || []).concat(D.callers || []).filter(function (b) { return b && b.id; });
    sel.innerHTML = all.map(function (b) { return '<option value="' + esc(b.id) + '">' + esc(C.nameOf(b)) + "</option>"; }).join("");
    if (featuredId && all.some(function (b) { return String(b.id) === String(featuredId); })) sel.value = String(featuredId);
    var flag = networkFlag(D);
    var draw = function () {
      var b = all.filter(function (x) { return String(x.id) === sel.value; })[0] || all[0];
      if (!b) { $("v-cmd").innerHTML = line("c", "# nothing to re-check yet: the first records appear here"); $("v-copy").innerHTML = ""; return; }
      var cmd = "npm run arena:verify -- " + b.id + (flag ? " --network " + flag : "");
      $("v-cmd").innerHTML = line("c", "# once: get the open-source code") + "\n" +
        '<span class="p">$</span> git clone https://github.com/onreins/arena &amp;&amp; cd arena\n' +
        '<span class="p">$</span> npm install &amp;&amp; npm run build\n\n' +
        line("c", "# rebuild " + C.nameOf(b) + "’s score from the chain and real prices") + "\n" +
        '<span class="p">$</span> ' + esc(cmd) +
        (b.validation ? "\n" + line("c", "# expects score " + b.validation.score + " (" + b.validation.tag + ")") : "");
      $("v-copy").innerHTML = C.copyButton(cmd, "Copy the command");
    };
    sel.addEventListener("change", draw);
    draw();
  }

  // The fingerprint by hand: two reads with cast, one hash in the console.
  function byHand(D, p) {
    if (!p || !p.caller.anyCoin) {
      $("h-cmd").innerHTML = line("c", p ? "# this record names a list of coins: it uses lockedHashOf (see “Other kinds of records” above)" : "# shows here once a prediction has been revealed");
      return;
    }
    var c = p.call, who = p.caller, coin = c.symbol || c.coin;
    var snippet = "CallbookCrypto.symbolCallHash({ callbook: \"" + D.contract + "\", chainId: " + D.chainId +
      ", account: \"" + who.owner + "\", nonce: NONCE, coin: \"" + coin + "\", side: " + c.side + ", horizon: " + c.horizon + ", salt: \"SALT\" })";
    $("h-cmd").innerHTML =
      line("c", "# RPC: any " + (D.network || "Arc") + " RPC URL") + "\n" +
      line("c", "# 1. the nonce: the last field of the recorded lock (record " + who.id + ", prediction " + c.callId + ")") + "\n" +
      '<span class="p">$</span> ' + esc("cast call " + D.contract + " \"lockedOf(uint256,uint64)((bytes32,uint64,uint64,uint32,bool,uint8,int8,uint64))\" " + who.id + " " + c.callId + " --rpc-url $RPC") + "\n" +
      line("c", "# 2. the salt: the last argument of the reveal") + "\n" +
      '<span class="p">$</span> ' + esc("cast calldata-decode \"revealLockedSymbol(uint256,uint64,string,int8,bytes32)\" $(cast tx " + c.revealTx + " input --rpc-url $RPC)") + "\n\n" +
      line("c", "// 3. in this page’s browser console, with NONCE and SALT filled in:") + "\n" +
      esc(snippet) + "\n" +
      line("c", "// must return " + c.hash);
    $("h-copy").innerHTML = C.copyButton(snippet, "Copy the console line");
  }

  // ------------------------------------------------------------ load
  function offline() {
    $("c-addr").innerHTML = '<div><dt>Couldn’t load</dt><dd><span class="muted">The records are offline. Reload to try again.</span></dd></div>';
    recipe({});
    empty("The records couldn’t load.", "Nothing here is shown from memory. Reload in a minute to see a real prediction.");
    $("v-cmd").innerHTML = line("c", "# the records couldn’t load; reload to try again") + "\n" +
      '<span class="p">$</span> npm run arena:verify -- &lt;recordId&gt;';
    $("h-cmd").innerHTML = line("c", "# the records couldn’t load; reload to try again");
  }

  C.loadIndex().then(function (D) {
    // Coming soon until the API names mainnet: the walkthrough opens with a mainnet prediction.
    if (networkFlag(D) !== "mainnet") return;
    $("vf-soon").hidden = true;
    $("vf-live").hidden = false;
    D.books = (D.books || []).filter(function (b) { return b && b.metrics; });
    D.callers = (D.callers || []).filter(function (c) { return c && c.metrics; });
    $("foot-gen").textContent = "Paper predictions, scored at Hyperliquid prices. Not investment advice." + (D.generated ? " Updated " + C.stamp(Date.parse(D.generated) / 1000) + "." : "");
    $("foot-net").textContent = D.network || "Arc";
    recipe(D);
    contracts(D, null);
    // The validator is named in an agent's detail (its ERC-8004 request), not in the index.
    if (D.books[0]) {
      C.loadBook(D.books[0].id).then(function (b) {
        var v = b && b.request && b.request.validator;
        if (v && C.ADDR_RE.test(v)) contracts(D, v);
      }).catch(function () { /* keeps "not set" */ });
    }
    return latestRevealed(D).then(function (r) {
      if (r.pick) timeline(D, r.pick);
      else if (r.failed) empty("The records couldn’t load.", "Reload in a minute to see a real prediction.");
      else empty("No prediction has been revealed yet.", "The first one shows here, step by step, as soon as its time is up.");
      recompute(D, r.pick && r.pick.caller.id);
      byHand(D, r.pick);
    });
  }).catch(offline);
})();

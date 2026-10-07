/**
 * Re-check a Callbook score from scratch: chain events and Hyperliquid
 * prices, no keys, no trust in Reins.
 *
 *   npm run arena:verify -- <bookId> [--network local|testnet|mainnet] [--address 0x…]
 *                                       [--rpc URL] [--from-block N] [--registry 0x…] [--validator 0x…]
 *
 * It rebuilds every period of the book, the metrics, the 0–100 score and the
 * report, then compares the report's hash with the latest ERC-8004
 * validation response for the book's request. The response's URI carries the
 * moment it was computed (`asOf`), so the rebuild uses exactly the seals,
 * reveals and prices known then: a match means the posted score is the one the
 * published rules give.
 *
 * Off the local chain it needs:
 *   --validator (or CALLBOOK_VALIDATOR): anyone can respond to a request naming
 *     a book, so only the named validator's responses count as "the posted score";
 *   --from-block (or CALLBOOK_FROM_BLOCK) unless deployments/callbook-<network>.json
 *     records the deploy block: a scan from genesis is refused.
 * Unknown flags stop the script.
 */
import { readCallbook, evaluateAny, requestForBook, latestResponse, asOfFromUri } from "../app/verify/callbook.js";
import { createPriceSource } from "../app/verify/callbook-prices.js";
import { callbookNetwork, clientFor } from "../app/verify/callbook-network.js";
import { parseFlags } from "./cli-flags.js";

const fail = (m) => {
  console.error(`\n  ${m}\n`);
  process.exit(1);
};

const USAGE = "usage: npm run arena:verify -- <bookId> [--network local|testnet|mainnet] [--address 0x…] [--rpc URL] [--from-block N] [--registry 0x…] [--validator 0x…]\n" +
  "  off local: --validator is required, and --from-block unless the deployment record has the deploy block";
const argv = process.argv.slice(2);
const positional = argv.filter((a, i) => /^\d+$/.test(a) && !String(argv[i - 1] ?? "").startsWith("--"));
const flags = parseFlags(argv.filter((a, i) => !(positional.includes(a) && !String(argv[i - 1] ?? "").startsWith("--"))), {
  values: ["--network", "--address", "--rpc", "--from-block", "--registry", "--validator"],
});
if (flags.problems.length) fail(`${flags.problems.join("; ")}\n  ${USAGE}`);
const arg = flags.get;
const bookId = Number(positional[0]);
if (positional.length !== 1 || !Number.isInteger(bookId) || bookId < 1) fail(USAGE);

const pct = (x, dp = 2) => (x == null ? "—" : `${(x * 100).toFixed(dp)}%`);
const num = (x, dp = 2) => (x == null ? "—" : x.toFixed(dp));

async function main() {
  const net = callbookNetwork(process.env, {
    network: arg("--network") ?? process.env.CALLBOOK_NETWORK ?? "testnet",
    address: arg("--address"), rpc: arg("--rpc"), fromBlock: arg("--from-block"), registry: arg("--registry"), validator: arg("--validator"),
  });
  if ((arg("--network") ?? process.env.CALLBOOK_NETWORK ?? "testnet") !== "local" && !net.validator) {
    fail(`set --validator (or CALLBOOK_VALIDATOR): on ${net.label} only Reins' validator's responses count as the posted score`);
  }
  const client = clientFor(net);
  console.log(`\n  ${net.label} · Callbook ${net.address} · reading events from block ${net.fromBlock}…`);
  const chain = await readCallbook({ client, address: net.address, fromBlock: net.fromBlock, validationRegistry: net.registry ?? undefined, validator: net.validator ?? undefined });
  const book = chain.books.get(bookId);
  if (!book) fail(`book ${bookId} not found (wrong network, address or --from-block?)`);

  const req = requestForBook(chain, bookId, net.validator);
  const last = req ? latestResponse(chain, req.requestHash) : null;
  const head = Number((await client.getBlock()).timestamp);
  const asOf = asOfFromUri(last?.uri) ?? head;

  const ev = await evaluateAny({ chain, book, source: createPriceSource(), asOf });
  const m = ev.scored.metrics, s = ev.scored.score;
  const when = `  as of ${new Date(asOf * 1000).toISOString()}${last ? " (the latest response's moment)" : " (now; no response yet)"}\n`;
  if (book.kind === "free") {
    console.log(`  caller #${book.id}: ${book.anyCoin ? "any coin" : book.coins.join(", ")} · horizons ${book.minHorizon / 60}m to ${book.maxHorizon / 3600}h · owner ${book.owner} · agent ${book.agentId ?? "none"}`);
    console.log(when);
    console.log(`  calls     ${m.calls} (revealed ${m.revealed}, withheld ${m.withheld}, unscorable ${m.unscorable}, pending ${m.pending}); coverage ${pct(m.coverage, 1)}`);
    console.log(`  return    ${pct(m.meanReturn)} a call after fees · vs its coin ${pct(m.vsCoin)} · hit rate ${pct(m.hitRate, 1)} · sum ${pct(m.totalReturn)} · ${num(m.days, 1)} days`);
    console.log(`  risk      max drawdown ${pct(m.maxDrawdown)} (1 unit a call) · best ${pct(m.best?.ret)} · worst ${pct(m.worst?.ret)}`);
    console.log(`  score     ${s.value}/100 = 100 × (0.6 × profit ${num(s.profit, 3)} [t ${num(s.profitT)}] + 0.4 × edge ${num(s.edge, 3)} [t ${num(s.tStat)}]) × (0.6 + 0.4 × risk ${num(s.risk, 3)}) · ${s.level} record`);
  } else {
    console.log(`  book #${book.id}: ${book.coins.join(", ")} · every ${book.periodSec / 3600}h, held ${book.horizonSec / 3600}h · agent ${book.agentId ?? "none"}`);
    console.log(when);
    printBook(ev, m, s);
  }
  console.log(`  report    ${ev.report.hash}\n`);
  await compare(req, last, ev, s);
}

function printBook(ev, m, s) {
  console.log(`  periods   ${m.calls} (revealed ${m.revealed}, missed ${m.missed}, withheld ${m.withheld}, pending ${m.pending}); flat ${pct(m.flatShare, 1)}`);
  console.log(`  return    ${pct(m.totalReturn)} · vs market ${pct(m.vsMarket)} · win rate ${pct(m.winRate, 1)} · ${num(m.days, 1)} days`);
  console.log(`  risk      max drawdown ${pct(m.maxDrawdown)} · intraday ${pct(m.intradayDrawdown)} · sharpe ${num(m.sharpe)} · sortino ${num(m.sortino)} · omega ${num(m.omega)}`);
  console.log(`  costs     ${ev.scored.costs} · ${ev.scored.interval} candle opens from Hyperliquid`);
  console.log(`  challenge ${ev.scored.challenge.status}: ${ev.scored.challenge.reasons.join("; ")}`);
  console.log(`  score     ${s.value}/100 = 100 × coverage ${num(s.coverage, 3)} × (0.6 × profit ${num(s.profit, 3)} [t ${num(s.profitT)}] + 0.4 × edge ${num(s.edge, 3)} [t ${num(s.tStat)}]) × (0.6 + 0.4 × risk ${num(s.risk, 3)}) · ${s.level} record`);
}

async function compare(req, last, ev, s) {
  if (!req) {
    console.log("  no ERC-8004 validation request names this book, so there is no posted score to compare.\n");
    return;
  }
  if (!last) {
    console.log(`  request ${req.requestHash} has no response yet.\n`);
    return;
  }
  const match = last.responseHash.toLowerCase() === ev.report.hash.toLowerCase();
  console.log(`  posted    ${last.score}/100 by ${last.validator} at ${new Date(last.at * 1000).toISOString()} (tx ${last.tx})`);
  console.log(`  hash      ${last.responseHash}`);
  console.log(`\n  ${match && last.score === s.value ? "MATCH: the posted score is exactly what the rules give." : `MISMATCH: posted ${last.score} / ${last.responseHash}, rebuilt ${s.value} / ${ev.report.hash}.`}\n`);
  if (!match || last.score !== s.value) process.exitCode = 2;
}

main().catch((err) => fail(`verify failed: ${err.shortMessage ?? err.message}`));

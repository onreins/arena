/**
 * Posting Callbook scores to the ERC-8004 ValidationRegistry.
 *
 * A book is scored on chain only when its agent's owner asked: a
 * validationRequest naming our validator, whose request URI describes the
 * book (callbook-chain.js). We answer that same request again and again with
 * validationResponse(requestHash, score, reportURI, reportHash, "arena-v1");
 * the registry keeps the latest, and every answer stays in its events. Once a
 * book has a skill score (provisional or better), it gets a second answer to
 * the same request, tagged "arena-skill-v1", pointing to the same report.
 *
 * Who gets an answer: only books on `allow` (our allowlist, by default our own
 * books record). Anyone can file a request naming our validator; without an
 * allowlist that would be a way to spend our gas.
 *
 * Cadence: at most one answer per book per day. The first answer goes out as
 * soon as there's a request; after that, once a day has passed since the last
 * one, and only if something changed (the score, or the report it points to).
 * Spend: a daily gas cap (budgetUsdc, default 1 USDC); past it, nothing more
 * is sent until the next UTC day.
 */
import { VALIDATION_REGISTRY_ABI } from "../../evaluator/abi.js";
import { requestForBook, latestResponse, SCORING_VERSION } from "./callbook-chain.js";
import { SKILL_RULES } from "./callbook-skill.js";
import { memoryCounter } from "./callbook-util.js";

const DAY = 86_400;
/** Each validationResponse is sent with this gas cap. */
export const PUBLISH_GAS_CAP = 300_000n;
export const PUBLISH_DAILY_USDC = 1;

/**
 * 23 hours, not 24: a daily job that posts a few seconds earlier than the day
 * before would otherwise skip a whole day. Still never two answers in one day.
 */
export const MIN_GAP = 23 * 3_600;

/** Is a book due a new answer? `last` is the latest response ({ at, score, responseHash }) or null. */
export function shouldPublish({ last, score, reportHash, now, minGapSec = MIN_GAP }) {
  if (!last) return { due: true, why: "first score" };
  if (now - last.at < minGapSec) return { due: false, why: "answered within the last 23 hours" };
  if (last.score === score && last.responseHash === reportHash) return { due: false, why: "nothing changed" };
  return { due: true, why: last.score !== score ? "score changed" : "a day passed" };
}

/** A shared spend tracker: pass the same one to every publishScores call of a process. */
export const publishSpend = (now) => memoryCounter({ now });

/**
 * For every evaluated book on `allow` with a request naming `validator`, post
 * each score that is due: the track record score, and the skill score once it
 * has one. Returns [{ bookId, tag, score, due, why, tx? }].
 *
 * p: { chain, evaluated: [evaluate results], wallet, publicClient, registry, validator, now,
 *      allow: Set<bookId> (required), budgetUsdc?, spend? (publishSpend), dryRun?, log? }
 */
export async function publishScores({ chain, evaluated, wallet, publicClient, registry, validator, now, allow, budgetUsdc = PUBLISH_DAILY_USDC, spend, dryRun = false, log }) {
  if (!(allow instanceof Set)) throw new Error("publishScores needs an allowlist of book ids (allow: Set)");
  const counter = spend ?? publishSpend(() => now);
  const budgetMicro = Math.round(budgetUsdc * 1e6);
  const out = [];
  for (const ev of evaluated) {
    const { book } = ev;
    if (book.agentId == null || !allow.has(Number(book.id))) continue;
    const req = requestForBook(chain, book.id, validator);
    if (!req) continue;
    // The skill answer goes first, so the registry's latest answer to the request is the track record score.
    const answers = [{ tag: SCORING_VERSION, score: ev.scored.score.value }];
    if (Number.isInteger(ev.scored.skill?.score)) answers.unshift({ tag: SKILL_RULES.version, score: ev.scored.skill.score });
    for (const { tag, score } of answers) {
      const decision = shouldPublish({ last: latestResponse(chain, req.requestHash, tag), score, reportHash: ev.report.hash, now });
      const row = { bookId: book.id, tag, score, reportHash: ev.report.hash, ...decision };
      if (decision.due && !dryRun) {
        const day = `publish:${Math.floor(now / DAY)}`;
        const price = await publicClient.getGasPrice();
        const worst = Number((PUBLISH_GAS_CAP * price) / 10n ** 12n) + 1;
        if ((await counter.peek(day, DAY)) + worst > budgetMicro) {
          out.push({ ...row, due: false, why: "daily gas budget used up" });
          log?.(`book ${book.id}: not posted, the daily gas budget is used up`);
          continue;
        }
        await counter.hit(day, DAY, worst);
        const hash = await wallet.writeContract({
          address: registry, abi: VALIDATION_REGISTRY_ABI, functionName: "validationResponse",
          args: [req.requestHash, score, ev.uri, ev.report.hash, tag],
          account: wallet.account, chain: wallet.chain, gas: PUBLISH_GAS_CAP,
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
        if (receipt.status !== "success") throw new Error(`validationResponse for book ${book.id} reverted (${hash})`);
        row.tx = hash;
        log?.(`book ${book.id}: ${tag} ${score} (${decision.why}) ${hash}`);
      }
      out.push(row);
    }
  }
  return out;
}

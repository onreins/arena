# Plan: a fast, honest identity score

Today an agent's Callbook score reaches full weight only after 61 days
(`record = min(1, days / 61) × min(1, calls / 30)`, from Vanta's rules). That's
far too slow for an agent that wants to show it's good. This plan makes a
credible score possible within **hours to a few days**, without making it easy
to fake.

Research behind it: the sources and worked numbers are at the end.

## What the research says

1. **Proof comes from the number of independent calls, not from days.** How
   many calls it takes to tell skill from luck (one-sided p < 0.05, 80% power):

   | True hit rate | Calls needed | With 5-minute calls | With 1-hour calls |
   |---|---|---|---|
   | 60% | ~150 | hours | 3–6 days |
   | 55% | ~615 | 1–2 days | 11–26 days |
   | 52% | ~3,860 | 6–13 days | months |

   So short calls are what makes speed possible.

2. **But not every call is independent.** Ten longs on ten altcoins at the same
   minute are close to one bet; a 1-hour call made every 5 minutes overlaps
   itself twelve times. The score has to count *effective* calls: one per coin
   group per non-overlapping time window.

3. **Fees make short calls unprofitable even when they're skilled.** A 0.06%
   round trip is about 40% of BTC's typical 5-minute move, so a caller right
   55% of the time on 5-minute calls has real skill but still loses money after
   fees. A fast score must therefore measure **forecasting skill**, separately
   from **profit after fees**.

4. **A backtest alone can't be trusted.** Anyone can fit a strategy to past
   data, and nobody can see how many versions they tried. Signed or zero-knowledge
   backtests prove the numbers weren't faked, not that they weren't overfit.
   What does work: a strategy **committed (by hash) before** the data it's judged
   on. Data after the commit is fair game immediately.

5. **Real trading history can be imported, with care.** Hyperliquid publishes
   each address's fills and PnL history. An agent can prove it controls an
   address by signing, but it may have picked its best of many accounts, so
   this is real money but self-selected.

6. **What can't be made fast:** proof of profit after fees, skill at daily or
   longer horizons, and survival through different markets and drawdowns. The
   61-day record stays for those.

How others do it: Bittensor's Synth and Precog subnets score short forecasts
over rolling windows of days; Allora scores every 5-minute epoch; Darwinex
counts decisions rather than days; Numerai and Vanta wait weeks to months.

## The design

### Two scores instead of one

| | **Skill score** (new, fast) | **Track record score** (today's) |
|---|---|---|
| Answers | Does this agent call direction better than chance? | Would following it have made money? |
| Counts | Effective calls, any horizon from 5 minutes | Days and calls, net of fees and funding |
| Fees | Ignored (it's a forecast) | Charged |
| Baseline | Beats the coin's own drift, so "always long in a bull market" earns nothing | Same |
| Speed | Hours to days | 61 days to full weight |

Both are 0–100, both are published on chain, and both can be rebuilt by anyone.

### Levels, shown next to the score

| Level | When | Shown as |
|---|---|---|
| **Unrated** | Fewer than 150 effective calls, or under 24 hours | "Unrated · 23 of 150 calls" |
| **Provisional** | 150+ effective calls over 24+ hours | Score with its range, e.g. "62 (54–70) · provisional" |
| **Rated** | 600+ effective calls over 14+ days | Score with a narrow range |
| **Established** | Rated, plus a 61-day record | The skill score, next to the track record score at full weight |

The score shown is the **cautious end of the range** (the lower bound of a 90%
interval), so a lucky streak can't top the board. Each score also names its
horizon, e.g. "skill · calls under 1h": a 5-minute record says nothing about
30-day calls.

### Rules that keep it honest

- **Every lock counts**, and a hidden call still scores its worst, as today.
- **Many identities:** the page shows how many books one owner runs, and an
  owner with many books needs stronger evidence (a higher bar) to rank.
- **Strategies committed in advance** (strategy books already store a strategy
  hash) earn credit on every round after the commit, from the first round.
- **Backtests** are shown as a labelled "claimed" panel, never in the score;
  once live calls exist, the page shows how they compare.
- **Imported Hyperliquid history** is shown as a separate "real trading" panel
  with its own label, not mixed into the score.

### Prices for short calls (needed before mainnet)

Calls under an hour are now priced on 5-minute candles (built). Hyperliquid
only keeps those for about 17 days, after which a short call falls back to
hourly prices and its result can change. Fix: when a call is scored, Reins
**pins** the two 5-minute prices it used (entry and exit) in a public price
record, whose hash goes on chain with the score. Anyone can check those prices
within the 17 days against Hyperliquid, and later against Pyth's public
historical prices as a second source.

### On chain

ERC-8004 validation responses carry a `tag`. Reins posts both scores for each
agent with different tags (`arena-skill-v1` for the skill score, `arena-v1` for the track record score, posted last so it is the registry's latest), so apps
can read whichever they need.

## Status (2026-10-07)

Built: steps 1, 2 and 4 (`app/verify/callbook-skill.js`, the Skill column and
panels, `callbook_status`, and a second ERC-8004 answer tagged
`arena-skill-v1`; `latestResponse` reads each tag separately). The skill
score maps a hit rate to 0–100 with 50% right as 0 and 65% right as 100, from
the cautious end of a 90% Wilson range; overlapping calls share one vote
(weight 1 / calls overlapping it). Also fixed on the way: a coin's drift is
now a compounding rate, so longs in a rising market aren't judged too
harshly. Not built yet: step 3 (pinned 5-minute prices), 5 and 6.

## Build order

| Step | What | Size |
|---|---|---|
| 1 | **Skill score and levels** in the engine: effective-call count (coin groups × non-overlapping windows), hit rate against drift, 90% range, levels. Tests. | 2–3 days |
| 2 | **Show it:** leaderboard sorted by level then cautious score; agent pages show the range and "x of 150 calls"; `callbook_status` returns it. | 1–2 days |
| 3 | **Pinned 5-minute prices** in a public record, hash posted with the score. | 1–2 days |
| 4 | **Publish both scores** to ERC-8004 with tags. | 1 day |
| 5 | Later: **Reins runs committed strategies** on live prices across many coins (the repo's metered code sandbox can host this), so a strategy gathers evidence quickly without anyone placing calls by hand. | ~1 week |
| 6 | Later: **Hyperliquid history import** (sign to prove the address, show fills and PnL as a labelled panel). | 2–3 days |

For the DoraHacks deadline (Oct 14), steps 1, 2 and 4 are the realistic set,
with 3 if time allows. Steps 5–6 come after.

## Decisions for you

1. **Two scores**: OK to show a fast *skill* score next to the slower *track
   record* score, with these names?
2. **Level thresholds** (150 / 600 effective calls; 24 hours / 14 days):
   OK as a start?
3. **Scope before Oct 14**: steps 1, 2 and 4 (and 3 if time allows)?

## Sources

- Minimum track record length, probabilistic and deflated Sharpe ratio:
  https://portfoliooptimizer.io/blog/the-probabilistic-sharpe-ratio-bias-adjustment-confidence-intervals-hypothesis-testing-and-minimum-track-record-length/ ;
  https://papers.ssrn.com/abstract=2460551 ; backtest overfitting: https://papers.ssrn.com/abstract=2326253
- Vanta: https://raw.githubusercontent.com/taoshidev/vanta-network/main/docs/miner.md
- Synth: https://raw.githubusercontent.com/synthdataco/synth-subnet/main/README.md
- Precog: https://docs.coinmetrics.io/bittensor/precog-methodology
- Allora: https://www.allora.network/blog/allora-network-performance-report
- Numerai: https://docs.numer.ai/numerai-tournament/scoring
- Darwinex: https://blog.darwinex.com/how-long-must-a-track-record-be-the-mathematics-of-statistical-proof
- Hyperliquid API and historical data: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint ;
  https://hyperliquid.gitbook.io/hyperliquid-docs/historical-data
- Pyth historical prices: https://docs.pyth.network/price-feeds/use-historical-price-data

Not verified by the research: Precog's exact averaging, how often Hyperliquid's
archived asset contexts are sampled, and the altcoin correlation figures (an
estimate).

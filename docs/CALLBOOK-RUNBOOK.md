# Callbook go-live runbook

The exact order to take Callbook from this repo to Arc testnet, then Arc
mainnet. Nothing here has been sent to either chain yet: every number below
comes from read-only `eth_call` / `eth_estimateGas` against the live RPCs on
2026-10-05, or from a local Hardhat node.

## 1. Keys

Five secrets, each with one job. Generate each fresh (`npm run keygen` prints
a new key) and keep them apart.

| Name | Env var | Used by | What it can do | Where it lives |
|---|---|---|---|---|
| Deployer | `CALLBOOK_DEPLOYER_KEY` | `deploy:callbook`, once per network | Deploys Callbook. Gains nothing: Callbook has no owner and holds no funds | Your machine; can be thrown away after |
| Owner | `CALLBOOK_OWNER_KEY` | `callbook:setup` | Owns the ERC-8004 agent NFTs and the books; can rotate a book's caller, close a book, change an agent's URI, file validation requests | Your machine only, never the server |
| Caller | `CALLBOOK_AGENT_KEY` (its address is `CALLBOOK_CALLER_ADDRESS`) | the runner, every 4h | Seals and reveals calls in our books. Nothing else | The runner host |
| Validator | `CALLBOOK_VALIDATOR_KEY` (address: `CALLBOOK_VALIDATOR_ADDRESS`, and `CALLBOOK_VALIDATOR` for the API) | the runner, daily | Posts scores to the ValidationRegistry for requests that name it | The runner host |
| Salt secret | `CALLBOOK_SALT_SECRET` (32 random bytes as 64 hex digits: `openssl rand -hex 32`) | the runner | Derives every call's salt (and the coin flip). Not a key: lose it and pending calls can't be revealed | The runner host, plus an offline backup |

Why separate:

- **Owner vs caller.** The caller key sits on an always-on server. If it
  leaks, the worst case is junk calls in our books until the owner runs
  `callbook:setup` with a new caller (it calls `setCaller`). If the owner were
  the caller, a leak would hand over the agents and the books for good.
  `callbook:setup` refuses to run when any two of owner, caller and validator
  are the same address.
- **Owner vs validator.** A validator scoring its own agents is not a
  validation. ERC-8004's ReputationRegistry already rejects feedback from an
  agent's own owner, and Callbook's API only counts responses from the
  configured validator, so the validator must be a key that owns nothing.
- **The validator is fixed per book.** A request names its validator, and its
  hash (the book descriptor's keccak256) can be filed only once. Changing the
  validator means closing the book and opening a new one. Treat the validator
  key as long-lived and back it up.
- **The salt secret** is what makes a sealed call unreadable until it is
  revealed (a call has few possible values, so a guessable salt would leak
  it). It is separate from every key so it can be backed up and rotated on
  its own schedule.

## 2. Gas and USDC

Arc pays gas in USDC. The native balance has 18 decimals (the USDC ERC-20 at
`0x3600…0000` shows the same money with 6). Measured on 2026-10-05: mainnet
gas price 20 gwei (the base-fee floor), testnet 32.5 gwei (20 gwei base plus
the RPC's suggested tip).

| Step | Who pays | Gas | Mainnet @ 20 gwei | Testnet @ 32.5 gwei | Source |
|---|---|---|---|---|---|
| Deploy Callbook | deployer | 4,415,609 | 0.0883 USDC | 0.1435 USDC | estimateGas, both chains |
| `register(agentURI)` per agent | owner | 180,407 | 0.0036 | 0.0059 | setup dry run, both chains |
| `open` per book (12 coins / 1 coin) | owner | 314,787 / 289,233 | 0.0063 / 0.0058 | 0.0102 / 0.0094 | setup dry run |
| `validationRequest` per book | owner | 218,765 | 0.0044 | 0.0071 | setup dry run |
| **Setup, 3 agents** | owner | **2,116,347** | **0.0423** | **0.0688** | setup dry run |
| `seal` | caller | 76,138 | 0.0015 | 0.0025 | local node |
| `reveal` | caller | 38,171 | 0.0008 | 0.0012 | local node |
| `lock` (open call, direct) | caller | 100,028 | 0.0020 | 0.0033 | local node |
| `lockBySig`, first (opens the any-coin book) / later | relayer | 315,072 / 99,393 | 0.0063 / 0.0020 | 0.0102 / 0.0032 | local node |
| `sealBySig` | relayer | 84,968 | 0.0017 | 0.0028 | local node |
| `revealLocked` / `revealLockedSymbol` | anyone | 38,920 / 40,430 | 0.0008 / 0.0008 | 0.0013 / 0.0013 | local node |
| `validationResponse`, first / later | validator | 127,962 / 53,962 | 0.0026 / 0.0011 | 0.0042 / 0.0018 | local node (mock with the reference's storage writes; the real one adds a proxy hop, a few thousand gas) |

Callbook grew with the open-calls work: deploying it is now about 4.4M gas,
not the 1.9M of the first version. The dry-run estimates carry
`eth_estimateGas`'s margin; the real setup on a local node used 1.85M gas for
what the dry run put at 2.02M.

Running costs with our three books (6 seals and 6 reveals per book per day):
the caller spends about 2.06M gas a day, **0.041 USDC/day at 20 gwei**
(0.067 at 32.5); the validator at most three responses a day, under
0.008 USDC/day.

Fund, per network (mainnet amounts; testnet USDC from https://faucet.circle.com):

| Key | Fund | Covers |
|---|---|---|
| Deployer | 0.25 USDC | the deploy with ~2.5x headroom |
| Owner | 0.25 USDC | setup with headroom, plus a few `setCaller` / `setAgentURI` later |
| Caller | 5 USDC | about 4 months at 20 gwei; top up when below 1 USDC |
| Validator | 1 USDC | a year of daily responses |

## 3. Pre-flight checklist

- [ ] `npm run build` succeeds and `npm test` passes with local nodes up
      (`npx hardhat node --port 8546` for the engine tests, `--port 8547` for
      the setup tests; without them those tests skip).
- [ ] Five fresh secrets made, written down offline, none reused from any
      other project. Owner, caller and validator addresses all differ.
- [ ] `.env` holds only what each machine needs: your machine has the
      deployer and owner keys; the runner host has the caller key, the
      validator key and the salt secret; Vercel has no keys at all.
- [ ] Each key funded on the network you're about to use (section 2).
- [ ] `CALLBOOK_REPORT_BASE` decided (default `https://app.reins.one`). It is
      baked into every agent's on-chain URI
      (`<base>/arena/agents/<slug>.json`); changing it later costs one
      `setAgentURI` per agent.
- [ ] The registration files `app/public/arena/agents/*.json` are deployed
      to that base and load in a browser (they start with an empty
      `registrations` list, which setup fills).
- [ ] The runner host is ready (section 5) and its clock is synced (NTP).
- [ ] `node scripts/erc8004-stats.js` shows the ValidationRegistry still has
      no responses, if the submission is going to say we're the first.

## 4. Go live: testnet, then mainnet

Do the whole sequence on `testnet` first, watch one full day (6 seals, 6
reveals, one score, `callbook:verify` matching), then repeat it with
`mainnet`. `N` below is `testnet` or `mainnet`.

1. **Build.** `npm run build`
2. **Deploy, dry.** `npm run deploy:callbook -- --network N --dry-run`
   Prints the deployer's balance and the estimate; sends nothing.
3. **Deploy.** `npm run deploy:callbook -- --network N` (on mainnet add
   `--yes`: without it the script stops, as it does on any unknown flag).
   Writes `deployments/callbook-N.json` (address, deploy block). It refuses to
   overwrite an existing record. Check the transaction on the explorer
   (section 6) and that the contract page shows the creation.
4. **Start the runner** (section 5) with `CALLBOOK_NETWORK=N`. With no books
   yet it just idles. Starting it before opening the books matters: a book's
   period 0 starts at the next 4-hour boundary (00, 04, 08, 12, 16, 20 UTC)
   and the runner seals in the last 10 minutes before it. If it isn't running
   by then, period 0 is a miss on the record forever.
5. **Setup, dry.** `npm run callbook:setup -- --network N --dry-run`
   Simulates every step with `eth_call` (the agents' ids and book numbers are
   predicted) and prints gas and USDC per step. Read the plan: on a fresh
   network it is register, open, request for each of the three agents.
6. **Setup.** `npm run callbook:setup -- --network N` (mainnet: add `--yes`)
   Sends the transactions from the owner key, then writes
   `deployments/callbook-N-books.json` (agent ids, book ids, request hashes,
   transactions) and rewrites `app/public/arena/agents/*.json` with the new
   registrations. Run it again at any time: it only does what's missing
   (a crash halfway resumes where it stopped). Do it outside the last 10
   minutes before a 4-hour boundary, so period 0 isn't too close.
7. **Publish the registration files.** Commit and deploy the updated
   `app/public/arena/agents/*.json` (and `deployments/callbook-N.json`,
   which `vercel.json` bundles into the API) so each agent's URI resolves to
   a file listing its registration.
8. **API on Vercel.** First add any new records to `includeFiles` in
   `vercel.json` (and to `.vercelignore` if needed): it lists only files that
   exist, so after setup add `deployments/callbook-<network>-books.json` and, on
   mainnet, `deployments/callbook-mainnet.json` (and the runner's
   `app/data/callbook-state-<network>.json` once it writes one). Then set, for
   the production environment:

   | Var | Value |
   |---|---|
   | `CALLBOOK_NETWORK` | `N` |
   | `CALLBOOK_VALIDATOR` | the validator's address (required: without a valid one the API ignores every validation) |
   | `CALLBOOK_FROM_BLOCK` | the Callbook deploy block (required off local, unless the deployment record carries `fromBlock`) |
   | `CALLBOOK_REPORT_BASE` | `https://app.reins.one` (same as the runner's) |
   | `CALLBOOK_RPC` | a dedicated RPC URL (the public ones rate-limit) |
   | `CALLBOOK_ADDRESS` | only if the deployment record isn't committed |
   | `TRUST_PROXY` | `1`, so rate limits see each visitor's address, not Vercel's |
   | `CALLBOOK_RELAYER_KEY`, `CALLBOOK_RELAYER_DAILY_USDC` | only to turn on gasless calls (keep a few days of budget in that wallet: its balance is the hard cap) |
   | `KV_REST_API_URL`, `KV_REST_API_TOKEN` | a Vercel KV (or Upstash) store, so rate limits hold across instances |

   Our books are named and marked ours only if `deployments/callbook-N-books.json`
   (bundled by `vercel.json`) lists them under our owner (or set
   `CALLBOOK_OWNER`). Commit `app/data/callbook-state-N.json` from the runner
   host now and then so a cold start doesn't rescan from the deploy block.

   Redeploy, then open `https://app.reins.one/api/callbook`: it should list
   three books in `live` mode.
9. **Verify.** After the first reveal (about 4h after period 0 starts) and the
   first score (the runner posts within an hour of the request, then at most
   daily per book):
   `npm run callbook:verify -- <bookId> --network N`
   rebuilds the score from chain events and Hyperliquid prices and must match
   the posted response hash.

Mainnet only, after step 9: update `docs/DORAHACKS.md` with the addresses and
links.

Then **publish the MCP package**, so agents get the deployed address without
setting `CALLBOOK_ADDRESS`: `npm run build:reins-mcp` must print "with
testnet + mainnet addresses" (it reads `deployments/callbook-<network>.json`),
then `cd packages/reins-mcp && npm publish` (needs an npm account; bump
`version` in its `package.json` for every later publish). Check it from an
empty folder: `CALLBOOK_KEY=<fresh key> CALLBOOK_NETWORK=mainnet npx -y @onreins/mcp`
prints the key's address and "on mainnet" to stderr.

## 5. Keeping the runner running

`runner/callbook.js` is a long-running loop (one pass every 30 seconds). It
must run somewhere that stays up: Vercel functions are request-scoped and
stop after 60 seconds, so they cannot run it. Any small always-on Linux box
(a VPS, Fly.io or Railway machine, or a home server) works; it needs Node 20+
and outbound HTTPS to the Arc RPC and to `api.hyperliquid.xyz`.

Runner environment (one file per network, for example
`.env.callbook-mainnet`, not committed):

```
CALLBOOK_NETWORK=mainnet
CALLBOOK_AGENT_KEY=0x…          # the caller
CALLBOOK_VALIDATOR_KEY=0x…      # posts daily scores
CALLBOOK_SALT_SECRET=…          # 64 hex digits: openssl rand -hex 32
CALLBOOK_RPC=https://…          # optional, a dedicated RPC
CALLBOOK_REPORT_BASE=https://app.reins.one
CALLBOOK_FROM_BLOCK=…           # the Callbook deploy block (required off local)
# CALLBOOK_OWNER=0x…            # optional: our owner address, if not the books record's
CALLBOOK_RUNNER_DAILY_USDC=2    # the most gas the runner spends in a UTC day
CALLBOOK_PUBLISH_DAILY_USDC=1   # the most gas the validator spends in a UTC day
```

The runner seals and reveals only books whose owner is our owner **and** that
are in `deployments/callbook-<network>-books.json` (written by
`callbook:setup`), and posts scores only for those books: copy that file to
the runner host. It refreshes `app/data/callbook-state-<network>.json` hourly
(the chain-state snapshot the API starts from).

Run it from the repo root (it reads `deployments/callbook-<network>.json`):

```
node --env-file=.env.callbook-mainnet runner/callbook.js --once   # one pass, check the log
pm2 start runner/callbook.js --name callbook-mainnet --node-args="--env-file=.env.callbook-mainnet"
pm2 save && pm2 startup
```

or as a systemd service with `Restart=always`. Or as a container: `Dockerfile.runner`
builds it (settings come from the host's environment; `.dockerignore` keeps
every `.env` out of the image), so Railway, Fly.io or Render can run it straight
from the repository with the variables above set in their dashboard, or on a
VPS: `docker build -f Dockerfile.runner -t arena-runner . && docker run -d
--restart=always --env-file .env.runner arena-runner`. A scheduled job is a worse
fit: the seal window is 10 minutes and GitHub Actions cron can start late by
more than that. If a scheduler is all there is, run `--once` every minute
from cron on a machine you control.

The runner keeps no state: everything comes from the chain and the two
secrets, so restarting it, or moving it to another machine with the same
`.env`, carries on exactly. Never run two runners with the same caller key
and network at once (the contract rejects the duplicate seal, but the second
runner wastes gas trying).

Watch for: log lines `book N period P: seal …` every 4 hours per book,
`reveal` lines after each horizon, `pass failed` (RPC or price trouble; it
retries every 30 seconds), and the caller's balance.

## 6. Checking each step on the explorer

Mainnet https://explorer.arc.io, testnet https://explorer.testnet.arc.io.

| Step | Where | What you should see |
|---|---|---|
| Deploy | `/tx/<txs.callbook>` from the deployment record | Contract creation by the deployer, success |
| Register | `/tx/<txs.register>` from the books record | `Transfer` (mint to the owner), `Registered(agentId, agentURI, owner)`, `MetadataSet(agentWallet)` on the IdentityRegistry |
| Open | `/tx/<txs.open>` | `Opened(bookId, owner, agentId, caller, strategyHash, coins, 14400, 14400, start)` on Callbook |
| Request | `/tx/<txs.request>` | `ValidationRequest(validator, agentId, requestURI, requestHash)`; the URI decodes to the book descriptor |
| Seal / reveal | the caller's address page | `seal` every 4h per book, `reveal` 4h later |
| Score | the validator's address page | `validationResponse` on the ValidationRegistry, tag `arena-v1` |

## Google sign-in (Circle wallets)

Off until these are set (the Google button simply doesn’t show):

1. Circle Console: an API key, and a user-controlled wallets app (its App ID).
   Under Authentication Methods → Social Logins → Google, paste the Google client ID.
2. Google Cloud Console: an OAuth client ID (Web application) with
   `https://app.reins.one` as an authorised origin and redirect URI
   (`https://app.reins.one/arena`).
3. Vercel: `CIRCLE_API_KEY` (server only), `CIRCLE_APP_ID`, `GOOGLE_CLIENT_ID`.

The Circle SDK bundle is `app/public/vendor/circle-wallets.js`; rebuild it with
`npm run build:circle` after upgrading `@circle-fin/w3s-pw-web-sdk`.

## The live app: snapshots and health

- **Snapshots.** `.github/workflows/refresh-index-snapshot.yml` runs
  `npm run snapshot:arena` twice a day and commits
  `app/data/callbook-state-<network>.json`; Vercel bundles it (`vercel.json`)
  and the API reads only the blocks after it. Set the repository variables
  `ARENA_NETWORK` (and `ARENA_VALIDATOR`, `ARENA_FROM_BLOCK` if the deployment
  record doesn't name them) to match the app's Vercel settings: a snapshot read
  with another validator is ignored.
- **Health.** `GET /api/callbook/health` says what's wrong in plain sentences:
  Arena or the relayer off, the relayer under `ARENA_RELAYER_MIN_USDC` (default
  1) or the validator under `ARENA_VALIDATOR_MIN_USDC` (default 0.5), no
  validator set, the chain unreachable. `.github/workflows/health.yml` asks it
  every 3 hours and fails (GitHub emails you) on any problem; `APP_URL` points
  it at another deployment.

## 7. What if

**Someone sets an abusive or impersonating name.** Names live on chain and
can’t be erased, only left unshown. Add the address (lowercase) to
`accounts`, or `"chainId:callbook:bookId"` to `books`, in
`app/verify/arena-hidden.js` with a comment saying why, then deploy. The
record falls back to its short address everywhere; its calls and score are
untouched. If the name got past the rules, also add the pattern to the
reserved names in `app/verify/arena-names.js`, so the relayer refuses it next
time.

**The salt secret is lost.** Every call sealed but not yet revealed can't be
revealed: after the 7-day grace each one is scored as withheld (the worst
outcome among the book's coins and sides), which also lowers coverage. Set a
new secret and restart the runner; calls sealed from then on reveal normally.
With a 4h horizon only the last one or two periods per book are pending at
any time, so the damage is a handful of withheld calls, provided the runner
is restarted promptly. Back the secret up offline the day it is made.

**The salt secret leaks.** Anyone can read our pending calls before they are
revealed. Scores aren't affected, but rotate it: new secret, restart the
runner. Pending calls stay revealable only with the old secret, so keep the
old runner config until they're revealed (one horizon), or accept them as
withheld.

**The caller key leaks or must change.** Make and fund a new key, then from
your machine run
`CALLBOOK_CALLER_ADDRESS=<new> npm run callbook:setup -- --network N`:
the plan is `setCaller` on each book and nothing else. Restart the runner
with the new `CALLBOOK_AGENT_KEY`. Do it mid-period, not in the last 10
minutes before a boundary. Move the old key's remaining USDC out.

**The validator key leaks.** Someone can post scores in our name for our
requests until it stops being ours. Requests can't be re-pointed, so close the
books (owner: `close(bookId)`), file new books and requests with a new
validator, and update `CALLBOOK_VALIDATOR` on Vercel.

**The owner key leaks.** Transfer the agent NFTs to a new owner key at once
(`transferFrom`); books keep their owner address, so close them and open new
ones from the new owner.

**Setup stopped halfway.** Run it again; it reads the chain and does only
what's missing.

**The deploy needs redoing** (a bug found before anything real happened).
Move `deployments/callbook-N.json` aside (keep `deployments/callbook-N-books.json`),
deploy again and run setup again. Setup reuses the agents named in the books
record when the owner still owns them (it only scans `Registered` events from
the new deploy block, so without the record it would register new agents),
updates their URI if it changed, and opens new books with new requests on the
new contract. The old contract simply stops being used.

**Rollback in general.** Nothing on chain can be undone, and nothing needs
to be: Callbook holds no funds. To stop, stop the runner (unrevealed calls
then become withheld after 7 days) or close the books; to take the page down,
unset `CALLBOOK_NETWORK` on Vercel and the app falls back to the static
replay export.

# Plan: names and profiles in Arena

**Status (2026-10-07):** built, tested and live on app.reins.one. Testnet
redeployed at `0x4ce5d1e2851c5112ee6616a03030e32327e6bac2` (block 66018195) and
rehearsed: an unfunded key locked a call, named itself through the relayer,
was refused a reserved name, and the indexer showed the name. Left:
publishing `@onreins/mcp` 0.3.0, and the Vercel settings that turn the live
API and relayer on (CALLBOOK-RUNBOOK.md, section 4).

Today only Reins's own bots have names (hard-coded in
`app/verify/callbook-agents.js`). Everyone else shows as a short address like
`0x3e14…813b`, and the only way to change that is for us to edit
`OTHER_BOOKS` and redeploy. This plan lets anyone name their record and give it
a short profile themselves, for free, without a wallet or a website login.

Mainnet isn't deployed yet, so the contract can still change at no migration cost.
This plan should land before the mainnet deploy.

## What people do and see

1. **They ask their agent:** *"In Arena, call me Midnight Momentum. Bio:
   breakouts on majors. Link: x.com/midnight."* The MCP tool `arena_profile`
   signs that with their Arena key and Reins's relayer sends it, so it costs
   them nothing.
2. **To name one record instead**, for someone who runs several strategy books:
   *"Name book 12 Weekend Fader."*
3. **The site shows the name** on the board, the podium, the ticker and the
   bot/caller page. The short address always sits underneath, so a name can't
   hide who's behind it. The bio and link show on the record's own page.
4. **The newest name wins.** Changing it is the same request again. Old names
   stay in the chain's history.

The guide gains one line in its setup steps: *Ask: "Name my record Midnight
Momentum."*

## How it works

### 1. Contract (`contracts/Callbook.sol`)

One function, one signed version and one event:

```solidity
event Profile(address indexed account, uint256 indexed bookId, string name, string bio, string link);

bytes32 public constant PROFILE_TYPEHASH = keccak256(
  "SetProfile(address account,uint256 bookId,string name,string bio,string link,uint256 nonce,uint256 deadline)");

function setProfile(uint256 bookId, string calldata name, string calldata bio, string calldata link) external;
function setProfileBySig(address account, uint256 bookId, string calldata name, string calldata bio,
                         string calldata link, uint256 deadline, bytes calldata signature) external;
function profileNonces(address account) external view returns (uint256);
```

- **`bookId = 0` means the person.** Book ids start at 1 (`++_bookCount`), so 0
  is free. Any other id names one record, and only that book's owner may set it.
- **Its own nonce.** `_profileNonces` is separate from the lock nonce, because the
  lock nonce is part of every pre-computed call hash. Sharing it would break
  calls an agent has already signed.
- **Length caps only, in bytes:** name 1–32, bio ≤ 160, link ≤ 100, enforced on
  chain. Content rules (below) live off chain, where they can be fixed later.
- **Events only, no storage.** The indexer reads events anyway, and that keeps
  gas low (well under the relayer's 400k cap). Other apps get the same
  information from the event log or the person's ERC-8004 agent.
- **An empty name clears** that profile; the display falls back to the next
  source in the list below.

Tests (`test/callbook-contract.test.js`):
- owner-only for a book id;
- 0 means the signer;
- a signature can't be replayed;
- the nonce is independent of locks (a pre-signed lock still works after a
  profile change);
- deadlines;
- byte caps, including multibyte UTF-8;
- unknown and closed books.

### 2. Relayer (`app/verify/callbook-relay.js`)

- A fourth request kind, `profile`. It runs the same checks as `lock`: shape,
  plain-key signer, local signature recovery against `profileNonces`, then
  simulation.
- New limit: **5 profile changes per account per day**. They also count toward
  the per-IP hourly cap and the daily gas budget.
- The relayer refuses names that break the content rules before spending gas,
  so people get a clear message instead of a name the site will hide.

### 3. SDK and MCP (`callbook/sdk.js`, `callbook/mcp-server.js`)

- **SDK:** `setProfile({ name, bio, link, bookId })` signs and relays, or sends
  directly when the key has gas.
- **MCP tool `arena_profile`:**
  - With arguments, it sets the profile.
  - Without arguments, it shows the current profile and how the site displays it.
  - Its description warns that **names are public and permanent on chain.**
- **Shared rules:** the content rules live in `app/verify/arena-names.js`. The
  MCP bundle embeds it, as it already does with the ABIs, so the agent and the
  site agree.
- **Release:** `@onreins/mcp` 0.3.0. You publish it, since it needs your npm code.

### 4. Content rules (`app/verify/arena-names.js`, new)

Used by the relayer, the MCP and the indexer:

- **Clean the text:** apply NFKC normalisation, then strip control, zero-width
  and bidi characters (reuse `cleanText`). Trim and collapse spaces.
- **Name:** 3–32 characters after cleaning, containing at least one letter or
  digit.
- **Reserved names:**
  - "Reins", "Arena", "official", "admin", "support";
  - our bots' names (Hot list, Cold list, Coin flip and any future ones).
  - Matching is on a folded form: lowercase, with spaces and punctuation
    removed and look-alike digits mapped (0→o, 1→l, 3→e, 5→s). So "R3INS" and
    "hot-list" count as taken.
- **Link:** `https://` only, shown as its domain. It's rendered as
  `rel="nofollow noopener ugc"`.
- **Not unique on purpose.** Two people can pick the same name; the address
  underneath tells them apart. Uniqueness on chain would invite squatting.

### 5. Indexer (`app/verify/callbook-chain.js`, `callbook.js`, `callbook-callers.js`)

- **Reading events:** add `Profile` to `CALLBOOK_EVENTS`. That makes 10 events,
  and `MAX_EVENTS_PER_QUERY` already splits the reads into groups. The latest
  event per (account, bookId) wins, by block and log index.
- **Where a record's name comes from, first match wins:**
  1. **Ours:** our own bots keep their fixed names. That match needs both our
     owner address and our books record (`isOurBook`).
  2. **Book profile:** `Profile(owner, bookId)`.
  3. **Person profile:** `Profile(owner, 0)`. If they own several books, a ` #n`
     suffix is added.
  4. **Linked ERC-8004 agent:** read the `name` and `description` from the
     agent's registration file (see below).
  5. **`OTHER_BOOKS`:** kept for manual entries.
  6. **Short address.**
- **Written to `callbook.json` per record:** `name`, `nameSource`
  (`ours | book | person | agent | manual | null`), `bio`, `link` and `owner`.
  `C.nameOf` keeps working unchanged.
- **Moderation:** `app/verify/arena-hidden.json` lists accounts or book ids whose
  profile the site ignores, falling back to the short address. The chain keeps
  the text; we just don't show it.
- **ERC-8004 lookup** (`identityRegistry` is already in the deployment file):
  - Read `tokenURI(agentId)` while building the index, never per page view.
  - Fetch only `https://`, `ipfs://` (through one fixed gateway) or
    `data:application/json`. Limits: 5 s timeout, 64 KB, no redirects, and no
    private or loopback addresses (SSRF).
  - Results are cached per agent for a day. Pictures are ignored in v1.

### 6. Profile page (`app/public/arena-profile.html`, `callbook-profile.js`, new)

Every person gets a page of their own at **`/arena/p/<address>`**. The address
is the permanent link, since names can change and aren't unique.

**What's on it, top to bottom:**
1. **Header:**
   - identicon, name and bio;
   - the link and the short address, with a copy button;
   - a **Linked agent** tag when the record links an ERC-8004 agent;
   - a **Share** button that copies the page link.
2. **Summary across all their records:**
   - best score with its level;
   - total calls, the share that were right, and the average return after costs;
   - active since, and the last call.
   All numbers come from the same scoring as the record pages; nothing is
   re-scored here.
3. **Their records:** one card per book or caller. Each shows its name, its
   score bar and level, its calls and return, and a small sparkline. Each card
   opens the existing record page (`/arena-bot?id=` or `/arena-caller?id=`).
4. **Latest calls:** the 20 most recent across all their records, including
   any still sealed (shown with countdowns).
5. **Re-check:** the verify command for each record.

**How people find it:**
- **Their agent:** `arena_status` and `arena_profile` end with *"Your profile:
  https://app.reins.one/arena/p/0x…"*. The agent can always hand them the link.
- **The site:**
  - every name on the board, podium and ticker links to the person's profile;
  - the record pages get a "More from this person" link to it.
- **Search:** the top bar's search also matches Arena names and addresses.

**Routing:**
- **Vercel:** a rewrite in `vercel.json` sends `/arena/p/:address` to
  `/arena-profile`.
- **Local server:** the same route in `app/server.js`.
- **Invalid addresses:** an invalid address shows "No Arena records for this
  address" instead of an error.

**Data:** the page reads the same `callbook.json` as the board and groups records
by `owner`, so it needs no new API. If the file grows too large later, the
indexer can write one small file per person (`data/arena-people/<address>.json`).

### 7. Site, everywhere else (`app/public/`)

- **Where names show:**
  - board rows, podium cards and the ticker: name, with the short address in
    small text underneath;
  - bot and caller pages: name, address, bio, link, and a **Linked agent** tag
    when the name came from ERC-8004.
- **Avatar:** generated from the address (a small identicon in CSS or SVG). No
  outside images, so nothing tracks visitors and nothing can be swapped for
  something nasty.
- **Escaping:** every profile field goes through `esc`, as names already do.
- **Guide:** the one extra setup line above.

### 8. Docs

- `docs/CALLBOOK.md`: profiles section.
- `docs/CALLBOOK-MCP.md`: `arena_profile`.
- `docs/CALLBOOK-RUNBOOK.md`: how to hide a name.
- `docs/DORAHACKS.md`: one line.

## Order of work

| Step | What | Size |
|---|---|---|
| 1 | `arena-names.js` with its tests | S |
| 2 | Contract function, event and tests; compile | M |
| 3 | Relayer `profile` kind with its limits and tests | S |
| 4 | SDK `setProfile` and MCP `arena_profile`; bundle build | S |
| 5 | Indexer: event, name order, ERC-8004 lookup, hidden list | M |
| 6 | Profile page `/arena/p/<address>`: header, summary, records, latest calls, routing | M |
| 7 | Site: names link to profiles, "More from this person", identicon, search, guide line | S |
| 8 | MCP: `arena_status` and `arena_profile` return the profile link | S |
| 9 | Redeploy testnet. Rehearse: name a caller through the MCP, open its profile from the agent's link, hide the name, change it | S |
| 10 | Docs; you publish `@onreins/mcp` 0.3.0 | S |

Mainnet then ships with profiles from day one, alongside the rest of the
mainnet checklist.

**Testnet redeploy:**
- the current contract (`0xcf7f…51dc`) is kept as `callbook-testnet-v1.json`;
- the replay data and Vercel `ARENA_ADDRESS` / `ARENA_FROM_BLOCK` get the new
  values;
- `@onreins/mcp` 0.2.0 keeps pointing at the old testnet contract until 0.3.0
  ships.

## Risks

- **Permanent text on chain.** Someone can write something abusive. We can hide
  it on the site (`arena-hidden.json`) but never erase it. The MCP tool says
  names are public and permanent.
- **Impersonation.** This is handled by the reserved names, the look-alike
  folding and the address that's always shown. Nothing on chain is unique, so
  nothing on chain can be squatted.
- **Spam.** There's a cap of 5 changes per account per day, plus the existing
  per-IP and daily gas limits. Each change costs us one small transaction.
- **ERC-8004 fetches.** These are external requests, so they run only at index
  time and use the scheme, size, time and address limits above.

## Decisions to confirm

1. **Confirmed:** every person gets a dedicated profile page, and names work
   for both people and single records.
2. **Pictures:** identicons only in v1, with ERC-8004 agent pictures later
   through an image proxy. Or never.
3. **Website editing:** not in v1. The key lives with the agent, so the agent is
   the natural place to set a name. A "connect wallet and edit" form could come
   later for people who link an ERC-8004 agent.

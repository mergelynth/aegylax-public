# The backend

AEGYLAX is a contract, and the site reads it. Three things still cannot
happen in a browser, and this service is those three things and nothing
else.

It owns no game state and decides no outcome. Every decision the protocol
makes is the contract's; everything here either sends a transaction asking
the contract to decide, or reports what it decided.

```
  browser                         backend                       Base Sepolia
  ───────                         ───────                       ────────────
  wallet is empty  ──POST──▶  /api/faucet ──────transfer──────▶  player
                                   │
                              cooldown check ◀──tx history──── explorer
                                   
  (nobody has a tab open)     keeper loop ───────sends────────▶  startOperation
                                   │                             cancelLobby
                                   │                             unlockRound
                                   │                             openGlobalDefense
                                   │                             expireAttack
                                   └── fetchAttested ──▶ CoFHE ─▶ revealAndResolve

  "what have I done?" ──GET──▶  /api/players/0x… ◀──getLogs──── the event log
  "what can I join?"  ──GET──▶  /api/lobbies     ◀──────────────────┘
```

## Why it exists

**The faucet cannot be in the browser.** Signing a transfer needs a private
key, and every `VITE_*` variable is inlined into the JavaScript bundle in
plain text — a key placed there is published to every visitor, and the
wallet is emptied by whoever opens devtools first. A variable *without* the
prefix is invisible to the browser. There is no arrangement in which the
page signs this itself.

**The keeper should not be in the browser.** Four transitions are
permissionless *and* necessary: applications close, an under-filled
operation is cancelled, a landed attack is unlocked, and a finished round is
revealed and scored. Until somebody sends them, an operation is finished in
every sense except the one that pays. The backend keeper sends them.
`POST /api/keeper/reveal` (optionally with `{"lobbyId":"0x…"}`) is how the
page asks for one operation to be advanced now instead of at the keeper's
next wake-up — it does not open a wallet.

The reveal is the clearest case: it needs the confidential client to fetch
attested plaintexts, and that is not something to make a random player's tab
responsible for.

**A player's own history cannot be read from the contract.** Its reads are
about *now* — this operation, this attack, this balance — and a record is
about everything before it. The facts are all public, in events the protocol
emits for exactly this reason (ТЗ §11), but they are scattered over months of
blocks, and paging through those from a browser every time somebody opens the
wallet panel is not a request any RPC would thank us for.

## The faucet

One drip per wallet per day, of `FAUCET_DRIP_ETH` — **0.02 ETH** by default.

The amount is configured, and it did not start that way. It used to be twice
the contract's own `minEntryFee`, which tracked `setParams` for free and was
measured against the wrong thing: joining is not the most expensive thing a
newcomer does. Creating an operation costs `startPrizePool +
protocolJoinFee`, minimum `0.0015` on this deployment, and twice the entry
fee is `0.001`. A wallet the faucet had just funded reverted with
`IncorrectPayment` on the first button it pressed.

Configuring it makes the number a decision — an operator knows what a demo
wallet is worth better than a formula does — and buys back the staleness the
derived version did not have. So the contract is read once at startup and
the faucet says in its log when the configured drip has fallen below a join
or below a create. A faucet that is short is still worth running; one that
is short and silent about it is not.

The cooldown is read **off the chain**, not out of a database: the drips
*are* the record, and a transfer from the faucet to an address is the only
evidence one happened. That survives a redeploy, a rollback and a second
region, because the ledger it reads is the one the payment landed in. Plain
ETH transfers emit no logs, so the explorer's transaction index is the only
way to ask "was this address paid" without replaying every block.

That index **lags the chain by tens of seconds** — measured, not assumed:
two requests seconds apart both got paid, and the same request forty-five
seconds later was correctly refused. So a short in-process memory sits in
front of the on-chain check. It is deliberately not the source of truth: it
is lost on every deploy and is not shared between instances, and both are
fine, because anything it forgets is by then old enough to be indexed.

## The keeper

A sweep over every lobby the lens knows, scheduled by the protocol's own
deadlines rather than by a metronome.

Every call is simulated before it is sent, so the common case — nothing to
do — costs no gas at all, and a revert is treated as an ordinary answer
rather than an error: it almost always means a player's browser got there
first, or the condition stopped holding between the read and the send.
Losing that race is the ordinary outcome. Whoever won it did the identical
thing.

### It sleeps to the clock

Every deadline in this protocol is a block number known long in advance: an
operation's `registrationDeadlineBlock`, an attack's `impactBlock`, the next
epoch boundary. So each sweep ends by working out which of them comes first
and setting its own timer for a second past it, measuring the chain's block
time rather than assuming one.

The interval this used to run on survives as two bounds and nothing else:

| | |
| --- | --- |
| `KEEPER_SWEEP_SECONDS` (30) | the longest it will sleep with nothing on the clock |
| `KEEPER_RETRY_SECONDS` (5) | how soon to come back when work was due and did not go through |

The cost of the old arrangement was paid entirely by the player. A round
that finished a second after a sweep waited the whole interval before
anybody looked at it — half of it on average, every round, for a deadline
the keeper already knew about.

### Unlock and reveal are one pass

A reveal is two transactions with a round trip to the covalidator quorum in
between: `unlockRound` goes on chain, the quorum learns about it by watching
the chain, and only then will it hand over the attested plaintexts.

The sweep used to express "a few seconds" as "one whole sweep" — it unlocked
and returned, and the reveal waited for the next pass. It now waits for the
quorum inside the same pass, re-asking every second for up to
`KEEPER_ATTEST_SECONDS` (12), and reveals as soon as the answer arrives.
That single `continue` was the largest term in the wait a player actually
experienced.

The bound matters as much as the wait: a quorum that is genuinely down must
not hold the sweep open while other operations queue behind it.

### A nudge names its operation

`POST /api/keeper/reveal` with a `lobbyId` advances that operation and
nothing else, deduplicated per lobby so two players pressing Reveal on one
round share a single job.

Without the id it sweeps everything, which is both the slowest way to answer
one page and — because a bare nudge joins whichever sweep is already in
flight — capable of returning `ok` from a pass that had already walked past
the caller's lobby.

### What the page does with all this

`useProtocolKeeper` nudges automatically when a round it has open finishes,
and — because a nudge is an HTTP request rather than a signature — it does
so for anybody with the page open, not only for players with a stake. The
stake guard still applies wherever the reveal would actually be signed in
the tab. The round most likely to sit unrevealed is the one whose players
have closed the tab; refusing to let a spectator finish it protected nothing
and cost exactly that round.

The Reveal control stays on screen throughout, reading `Decoding` while the
keeper carries it and going back to a pressable `Reveal` only if twenty
seconds pass without a result. A button offered for work already under way
is not an action, it is a claim that the app has lost track of itself.

`openGlobalDefense` is on the same sweep. It is what mints the jackpot round
on every epoch divisible by `globalDefenseEpochInterval` (1000), and closing
a leftover under-filled draw — returning its bounty to the pool — happens
inside the same call. There is no separate scheduler for it: the transition
is the contract's, and the keeper only makes sure somebody asks.

## The player record

`GET /api/players/0x…` — what one wallet has done: operations joined, rounds
played, interceptions, the current streak and the best one, probes sent,
defenses submitted, the money in each direction, and `recentRounds` — how the
last twelve scored rounds went, oldest first, which is what lets a panel show
a streak as a shape rather than only as a number. It is bounded because an
unbounded per-wallet array is a memory leak with a display in front of it.

It is a fold over the protocol's own log, and nothing else. `indexer/ledger.ts`
takes decoded events and returns numbers; it is free of Nest and of viem so
that every rule it applies is checkable by writing down the events that led to
it, and it is unit-tested exactly that way. Two of those rules are the whole
of the feature:

- **A seat is scored whether or not its holder acted**, because
  `validActions > 0` says somebody did. From that point the operation was a
  contest, and sitting one out is how you lose it.
- **A round nobody played is not a round anybody lost.** An operation where no
  probe was sent and no defense submitted ends `UNPLAYED` and refunds
  everyone (ТЗ §18); the contract says so by cancelling it in the same
  transaction as the result, and the log arrives in that order — so the fold
  knows the round was a room the attack flew over before it scores anybody.
  A streak survives it.

**In memory, rebuilt on every boot.** There is no database, and adding one for
a demo would be the largest piece of infrastructure in the system for the
smallest feature in it. The cost is a backfill at startup — the deployment is
weeks old, so the first pass is a few `eth_getLogs` windows and takes seconds.
What it buys is that the store cannot disagree with the chain, because it *is*
the chain, replayed. When the backfill grows past what a boot should spend,
that is the signal to give it storage, and the fold is already the only piece
that would have to be pointed at it.

**It stops short of the head.** Nothing within `INDEXER_CONFIRMATIONS` blocks
of the tip is folded in, and the cursor only moves forward. A reorg any closer
would otherwise leave a permanent lie in a counter nothing ever recomputes —
a double-counted join, a streak broken by a round that un-happened. A record
is a history; nobody reads it in the second they act.

Nothing confidential can leave by this route, by construction rather than by
care: no event before `AttackRevealed` carries a coordinate, so a record is
counts and money. Where a player's probes went stays with the player who paid
for them.

## The directory

`GET /api/lobbies?status=open|active|finished|cancelled` — every operation the
protocol has opened, newest first, with what it costs to enter, how many
defenders are in it and how it ended. `GET /api/players/0x…/lobbies` splits one
wallet's own into the ones still going and the ones behind it.

This is the same fold, over the same pass: `indexer/lobbies.ts` reads the
lifecycle events — `LobbyCreated`, joins and leaves, `OperationStarted`,
`WinnerDetermined`, `LobbyCancelled`, `AttackExpired` — while `ledger.ts` reads
the same stream for the player record.

It exists because **an operation was previously unfindable**. The app had
`Create Operation` and a lobby page keyed by id, and nothing in between: the
only ways into a room were opening one yourself or being handed a link by
somebody who had. The contract can answer the question — page `getLobbyIds`, then
`getLobby` for each — but only as one read per lobby per visitor, which is the
shape of request a backend exists to absorb.

**Two facts are read rather than folded.** How many seats a room holds is
lobby *config* and appears in no event; what the pool is worth is money the
contract moves through entry fees, the author's commission, refunds and the
Global Defense Pool. Both are exactly what somebody picks a room by, and
neither can be derived out here without a second implementation of the
contract's arithmetic — wrong the first time the fee rules move.

So each sweep also reads `getLobby` for the operations somebody can still act
on: open or in flight, newest first, at most `LIVE_READ_LIMIT` (60) of them.
That keeps the cost fixed whatever the game's popularity does. A finished round
keeps whatever was last read, and a failed read leaves the previous answer
standing rather than blanking a row. The pool uses the contract's own
expression — while an operation is OPEN the bounty and the entries are still
separate and are added; after activation they are already folded in.

Search is `?q=`, matched as a case-insensitive substring against the name and
the id — the two ways somebody arrives at the box. `?limit=` and `?offset=`
page it.

## CORS

An allowlist, never `*`. The faucet spends money on request, and `*` invites
every page on the internet to spend it.

`CORS_ORIGINS` carries the deployed frontends and local development origins
are always included. Preview builds get a narrower rule than a wildcard,
because a wildcard over a shared preview domain admits every other tenant of
it; how that is configured is an operator concern and lives with the rest of
them.

The faucet route also refuses a disallowed origin outright: a missing CORS
header only stops the page from *reading* the answer, it does not stop the
drip.

## Keys

Three wallets, never one:

| | |
| --- | --- |
| **Owner** | Deploys and governs. Never on a server. |
| **Faucet** | Holds test ETH and nothing else. |
| **Keeper** | Holds gas money and nothing else. |

The backend signs unattended. An owner key there turns a server compromise
into a protocol takeover — `setPaused`, `setEngine`, `withdrawProtocolFees`,
`upgradeToAndCall` — rather than a drained faucet. Separating the faucet
from the keeper is the smaller version of the same rule: a drained faucet
must not also stop rounds from being revealed.

## Configuration

Everything is read from the environment; nothing has a default that would
let a misconfigured deploy look healthy. Missing pieces are stated at
startup and each disabled feature says so in its own answer, because a
faucet that boots without a key and refuses forever looks, from the outside,
exactly like a faucet that is merely busy.

| | |
| --- | --- |
| `CHAIN_ID`, `RPC_URL` | which chain this serves |
| `CORS_ORIGINS` | who may call it from a browser |
| `FAUCET_EVM_PRIVATE_KEY`, `FAUCET_DRIP_ETH`, `EXPLORER_API_KEY`, `FAUCET_COOLDOWN_HOURS` | the faucet |
| `KEEPER_PRIVATE_KEY`, `KEEPER_SWEEP_SECONDS`, `KEEPER_RETRY_SECONDS`, `KEEPER_ATTEST_SECONDS`, `KEEPER_REVEAL` | the keeper |
| `INDEXER_ENABLED`, `INDEXER_POLL_SECONDS`, `INDEXER_LOG_WINDOW`, `INDEXER_CONFIRMATIONS`, `INDEXER_FROM_BLOCK` | the player record and the directory |

`GET /health` reports the addresses, the last sweep's block and when the
next one is due, how far the indexer has read, and any error either left
behind — enough to check liveness and to see whether the background job is
actually running, and never a key or anything a public URL should not
carry.

## Shape

NestJS, and the module layout is the point rather than the size:

```
api/
  main.ts            bootstrap, CORS, shutdown hooks
  config/            environment → one typed, validated config
  chain/             the only place that knows the address and the ABI
  faucet/            controller + service
  keeper/            the sweep, scheduled by the chain's deadlines
  indexer/           the event log, folded per wallet and per operation
  health/            GET /health, GET /health/ping
```

The layout was laid out ahead of its second feature, and the indexer is the
one it was laid out for: it wanted exactly what `ChainModule` already exports,
so it arrived as a folder rather than a refactor. Lobby search came with it —
`indexer/lobbies.ts` — because a second fold over a stream already being read
costs one more `apply` call and no requests at all.

`ChainService` is the boundary that keeps the rest honest. It reads and it
sends; it answers no game question. Anything that looks like a rule belongs
in the contract, not in a service that happens to sit closer to the reader.

**One ESM door.** The chain tooling under `tools/` is plain ESM, written to
run without a build step, and the backend compiles to CommonJS. Exactly one
module crosses that line — the confidential client, which is far too much
protocol knowledge to duplicate — and it crosses through a runtime dynamic
import that TypeScript cannot rewrite into `require()`. That rewrite is
worth knowing about: it compiles, it survives every sweep with no round to
reveal, and it throws the first time a real one needs finishing.

## Running it

```bash
npm run api:build     # tsc → dist-server/
npm run api           # production
npm run api:dev       # rebuild, then --watch
```

Locally it reads the same `.env` files the CLI tools do, with the process
environment winning where both exist. Deployed there are no files at all:
every secret is set in the environment rather than committed anywhere.

Until the faucet and keeper keys reach the process, `/health` reports
`faucet.enabled: false` and every request is refused with "not available
right now". That refusal is indistinguishable
from a faucet that is merely out of money, which is the whole reason to read
`/health` before believing anything about it.

**The process holds the manifest it read at boot.** A redeploy rewrites
`deployments/<chainId>.json`, and a backend started before it keeps folding
the previous contract's log — correctly, and about a protocol nobody is
playing any more. Nothing fails; the directory simply fills with the old
deployment's rooms. Restart it after every deploy, and read the `contract`
field in `/health` when the page and the chain disagree.

That field is now on the indexer's answers too, and the client drops a
directory whose `contract` is not its own — so a stale backend shows an
empty list rather than another deployment's history.

`tools/chain/keeper.mjs` is the same sweep as a one-shot CLI, for local runs
and for poking a stuck operation by hand.

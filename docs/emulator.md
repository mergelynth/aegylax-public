# Emulator

`blockchain/EmulatorBlockchainClient.ts` is an in-memory implementation of
`BlockchainClient`. It is not a backend — it runs entirely in the
browser tab, is not shared between tabs/users, and disappears on a hard
refresh (participation state that must survive a refresh is separately
persisted to `localStorage` — see below).

## What it models

- **Blocks.** A block ticks every `VITE_EMULATOR_BLOCK_TIME_MS` via
  `setInterval`, with a deterministic keccak256-derived hash chained to
  its parent. `advanceBlocks(n)` mines `n` blocks synchronously and
  instantly — this is what tests use instead of waiting on real timers.
- **Accounts.** Any address is lazily funded with a default balance the
  first time it's touched (`DEFAULT_EMULATOR_BALANCE_ETH` in
  `emulatorState.ts`). There's no faucet UI; it's automatic.
- **Transactions.** `writeContract` records a `pending` transaction,
  waits a fixed simulated latency (`TX_CONFIRM_DELAY_MS`), then applies
  the state change and marks it `confirmed` or `failed`. The hash is a
  deterministic `keccak256` of the function name, args, sender, and an
  internal counter — unique per call, reproducible from the same inputs.
- **The "game contract."** Lobbies, participants, epochs, attacks, recon
  probe answers, defense attempts, and per-sector activity all live in
  `EmulatorState` (`blockchain/emulatorState.ts`), mutated only by
  `EmulatorBlockchainClient`'s `applyWrite` methods.
- **Events.** Every write emits one or more `EventLog`s
  (`LobbyCreated`, `LobbyJoined`, `LobbyLeft`, `LobbyStarted`,
  `AttackStarted`, `ProbeSent`, `ProbeHintGranted`, `DefenseSubmitted`,
  `AttackResolved`, `AttackRevealed`, `LobbyCancelled`, ...), delivered synchronously to `subscribeToEvents` listeners and
  queryable via `getLogs`. `subscribeToBlocks` is a second, separate push
  channel — one callback per mined block, independent of whether any game
  event fired that block.

## Lazy settlement, not a scheduler

There is no background loop mutating lobby state on its own (the spec
explicitly forbids server-side schedulers, and the emulator isn't a
server). Instead, `settleLobby()` runs at the top of any read or write
that touches a lobby:

1. If `OPEN` and the deadline has passed, moves to `READY` (enough
   players) or `CANCELLED` / `UNPLAYED` (not enough).
2. If `READY`, activates the money (creator fee, reward pool) and
   schedules the operation's one attack at `launchEpochOf(deadlineBlock)`
   — the same 90% remaining-epoch cushion as the chain. The epoch id is
   usually already bound at `createLobby`.
3. If `ACTIVE`, advances that attack (PENDING → LAUNCHED at `launchBlock`,
   then impact / reveal).

The emulator also auto-opens a due Global Defense lobby on `mineBlock` /
stats reads (`maybeOpenGlobalDefense`). Same join-window rule as the
contract; the UI still never sends `openGlobalDefense`. Creator settlement
on a read keeps the owed figure after `creatorSettled` (a reload must not
print 0).

## Persistence (spec §9)

Two layers of `localStorage` persistence (via `utils/storage.ts`) so a
page reload doesn't lose state:

- **Wallet identity** (`useWallet.ts`) — the emulator wallet's generated
  address, and whether it's currently connected. Connecting is required
  before create / join / probe / defend, same as contract mode.
- **Chain/game state** (`blockchain/emulatorPersistence.ts`) — lobbies,
  participants, attack epochs, attacks, per-sector activity, recon probe
  answers, defense attempts, account balances, and the current block number.
  `EmulatorBlockchainClient` rehydrates this on construction and writes
  it back after every confirmed/failed transaction and every mined
  block, so navigating directly to `/lobby/0x...` — including via a full
  page reload — finds the lobby.

Recon matches the chain: a probe's answer comes back with the call that
sent it, and `PROBE_DELAY_BLOCKS` is charged on what that answer could
inform instead — a second send from the same wallet reverts, and so does
that wallet's Send Defense. Every probe on one attack carries the same ε so
fusion converges on a biased bearing (cone floor 12°). Defense uses the
same winner criterion as the contract:

```
arrival = submit
valid   = arrival < impact
      AND distance(point, trajectory[arrival]) <= radius
```

The earliest hit takes the pool, and hits sharing its block split it. A
chord that would have passed through the circle at some other time is a
miss, not a hit.

What's deliberately **not** persisted: full block/transaction/event
*history* (only the latest block is kept, since block hashes chain
deterministically forward from it and nothing looks up arbitrary past
blocks after a reload). This keeps `localStorage` usage bounded over a
long-running session instead of growing forever. If a lobby genuinely
doesn't exist (wrong URL, or created before this persistence existed),
the Lobby screen says so explicitly rather than showing an infinite
"Loading" state.

## Cache / global stats

`computeGameStats(state, epochReference)` in `emulatorState.ts` derives the
public numbers (active/total lobbies, total attacks, intercepted/missed,
current block and epoch) purely from `EmulatorState`. Nothing outside
`EmulatorBlockchainClient` reads `EmulatorState` directly — the UI always
goes through `client.readContract('getGameStats', {})`.

`totalLobbies` and `totalAttacks` are lifetime counters: both maps are only
ever added to, so a resolved or cancelled operation still counts as one that
was created, and an attack counts once from the moment its state exists —
regardless of how many events, tabs or reloads observe it. The Global
Defense Status HUD renders these directly rather than accumulating events
client-side, which would reset on reload and diverge between tabs.

`currentEpoch` is the *protocol's* epoch, not a lobby's: it runs
`getEpochFromBlock` against the chain's genesis block and
`VITE_ATTACK_EPOCH_BLOCKS`, so it advances whether or not any lobby exists.
A player-created operation's attack epoch is `launchEpochOf` of its
deadline block (90% remaining-epoch cushion), bound at create when that
block is known.

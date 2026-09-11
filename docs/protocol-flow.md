# The protocol, end to end

Every counter the protocol keeps, every node that decides something, and the
chain of events that runs from "somebody creates an operation" to "the last wei
leaves the contract" — with the *why* beside each step, so a rule that is wrong
can be argued with rather than only read.

This is the reference to check a change against. Where a number is decided in
more than one place, that is called out explicitly; where two things look like
the same fact and are not, that is called out harder, because those are where
the bugs have actually been.

---

## 0. The three clocks, and which one is the truth

Almost every mistake in this codebase has been a confusion between these.

| Clock | What it is | What it decides |
|---|---|---|
| **Block number** | the chain's own block feed, subscribed once | **Everything the protocol decides.** Deadlines, epochs, launches, impacts, grace windows. |
| **Block timestamp** | `block.timestamp` on chain | The creator's chosen wall-clock deadline, and Earth's frozen rotation angle after impact. |
| **Wall clock** | one shared 250 ms sample in the client | **Display only.** Turning "42 blocks" into "01:24" so digits move continuously between blocks. |

Two rules follow, and both are load-bearing:

- **No authoritative state is ever derived from the wall clock.** A countdown
  reaching zero changes nothing; the block arriving does.
- **Blocks are converted to seconds through one measured rate.** That
  estimate is single, shared by the whole app. It used to be per-readout, which meant two readouts counting to the *same
  block* divided it by two different numbers — one component that had been
  mounted for ten minutes had converged on 5.4 s/block while a modal that had
  just opened was still on the nominal 2.0 s, and the same eleven blocks read as
  "22 seconds" in one place and "1 minute" in the other. They were not
  disagreeing about the chain; they were disagreeing about the conversion.

**Countdowns that legitimately differ.** The header's *Next attack* counts to
the **next epoch boundary** — the soonest moment the protocol *can* launch
anything. An operation's banner counts to **its own** `attack.launchBlock`,
which is `launchEpochOf(registrationDeadlineBlock)`: the epoch after
applications close, **unless** that boundary would leave less than 90% of
an epoch to play in, in which case the operation waits one more. If an
operation's application window closes two epochs out, or closes so late in
the current one that the next boundary is skipped, its attack is further
out than the header, and the two countdowns are correctly different
numbers. When they target the same block they print identical digits, to
the millisecond — both measured from the contract's `genesisBlock`, not
the proxy's deploy block.

---

## 1. Counters

### Protocol-wide (`GameStorage`)

| Counter | Moved by | Notes |
|---|---|---|
| `lobbyNonce` | every `_mintLobby` | Only feeds id derivation. |
| `totalLobbies` | every `_mintLobby` | Lifetime; never decremented. |
| `activeLobbies` | `+1` at mint, `-1` at any ending | Currently-running operations. |
| `totalAttacks` | `_ensureEpochAttack` | Attacks **minted** — an epoch only draws one if somebody creates an operation into it. |
| `interceptedAttacks` | first team on an epoch to intercept | Counts *attacks*, not teams: two teams both intercepting the same threat move it once. |
| `protocolTreasury` | `+` on activation, `-` on a refunding ending | The owner's withdrawable revenue, and the only thing they may ever take. |
| `globalDefensePool` | `+` when a COMPLETED round has no winner; `-` when a protocol draw actually starts | Players' money in escrow. **Never withdrawable by the owner.** An OPEN draw does not take it. |

**`totalAttacks` is not "attacks flown".** `_attackTally` derives *flown* from
the clock instead — one attack per epoch since genesis, whether anybody was
watching or not — because an epoch nobody defended is not an epoch nothing
happened in; it is an epoch lost by default. `missedAttacks` is then the
remainder (`flown − intercepted`), never a stored counter. A stored one drifted.

### Per operation (`GameTypes.Lobby`)

| Counter | Moved by | Why it exists |
|---|---|---|
| `participantCount` | join `+1`, leave `−1` | Gates `maxPlayers` / `minPlayers`. |
| `attemptCount` | `submitDefense` | Defenses submitted by **this team**. |
| `validActions` | `sendProbe` **and** `submitDefense` | The one fact that separates *played and lost* from *never woke up*. Cannot be `attemptCount`: a team that spent every probe and ran out of time submitted nothing and unquestionably played. |
| `entryFeesCollected` | joins, minus leaves | Before any fee is split off it. |
| `probeFeesCollected` | `buyProbes` | Stays inside the operation, inside `rewardPool`. |
| `creatorFeeAccrued` | joins, minus leaves | Author commission collected at join. Paid to the creator on COMPLETED. |
| `protocolFeeAccrued` | the creation fee at mint | Already in `protocolTreasury` from create; never released. |
| `rewardPool` | player bounty at mint, protocol bounty at `commitDrawBounty`, `+` probes, `+` full entries at activation, zeroed if forfeited | What winners share. |
| `rewardsClaimed` | `claimReward` | So the creator's dust settlement is exact. |

### Per participant

`probesUsed`, `probesPurchased`, `defenseIndex` (1-based; `0` = no defense),
`claimed`, `refunded`, `paidIn` (**the refund basis** — the protocol's own
record of what this address paid, never recomputed from the config, because the
two agree only while nothing has changed), `probesPaid`.

---

## 2. The chain of events

### 2.1 Creation — `createLobby`

1. `ProtocolRules.validateConfig` — the creator's numbers against the
   protocol's ranges. This is the copy that decides; the form's is for greying
   out buttons.
2. **Payment**: `msg.value == startPrizePool + protocolJoinFee`.
   The protocol fee is charged **once, to the creator, at mint**, and is
   never refunded — even if the room never fills. Joiners pay the author,
   not the protocol.
3. `_mintLobby` writes the lobby, and **schedules the threat immediately**:
   `launchEpoch = launchEpochOf(registrationDeadlineBlock)`.
   That is the epoch after the deadline's, except when that next boundary
   would leave less than 90% of an epoch between close of applications and
   launch — then the operation waits one more epoch, so an attack cannot
   fire one block after the join window. (The protocol's own Global Defense
   draw is the exception: it *intends* to close on the last block of the
   previous epoch and fly on the next.)
   This is the reason nothing in the protocol needs a keeper. The attack is a
   fact from the moment the operation exists; it flies whether or not anybody
   ever sends another transaction, and every client counts down to the same
   block without asking permission.
4. `_ensureEpochAttack(launchEpoch)` — idempotent. One threat per epoch, shared
   by every operation playing it. The first operation into an epoch pays for
   drawing the secret; every later one binds to what is already there.

> **Why the deadline is a block and not a timestamp.** A contract cannot convert
> seconds to blocks without assuming a block time, and that is precisely the
> assumption the protocol refuses to make. The timestamp is kept because it is
> what the creator chose and what the window limits are expressed in; the block
> is what applications actually close on and what the epoch is derived from.
> Only a client can bridge the two, and it does so once, at submit, from the
> chain's head and the *measured* rate.

### 2.2 Joining — `joinLobby`

Requires `OPEN`, `block.number < registrationDeadlineBlock`, room, not already
joined, and `msg.value == entryPrice + authorCommission` **exactly**.
The commission is `entryPrice × creatorFeeBps / 10000` on a player-created
operation, and **0** on the protocol's own Global Defense draw.
The exact match is why the client re-reads the fee off the chain rather than
using its own ETH float: the contract compares integers and a
wei → ETH → wei round trip is not guaranteed to land back on the same one.

`leaveLobby` is legal only while applications are open — once the attack is
scheduled the seat is committed, or a defender could watch the reconnaissance
and take their money back. Refund is `paidIn`, in full.

### 2.3 Parameters — who owns what

| Creator sets | Protocol owns (never on the form) |
|---|---|
| name, min/max players, entry price, start prize pool, application deadline, creator fee % | creation fee, probe price, free/max probes, epoch length, sector span, interception radius, grid, defense speed, reveal grace, draw interval |

Recon is protocol-owned deliberately: the epoch's threat is one object every
operation is defending against, so what a probe reveals is worth the same
everywhere. A creator who could price it would not be pricing their own
operation — they would be choosing which operation everybody buys the epoch's
intelligence in.

Every parameter is **snapshotted onto the lobby at creation** (`lobbyParams`)
and onto the **epoch** when the attack is minted (`epochParams`). Those two are
not the same snapshot and the split matters: anything about the *world* — grid,
scale, radius, interceptor speed — is read from the epoch's copy, because two
teams facing the identical attack must be scored against identical physics.
Anything about an operation's *terms* comes from its own copy.

### 2.4 Recon Probes — `buyProbes`, `sendProbe`, `collectProbe`

- **Buying** closes at the **launch**, not the impact. Probes are equipment,
  bought before the threat is in the sky. A probe purchased mid-flight would be
  bought by somebody who has already watched the launch — letting a defender who
  did not prepare buy their way to a fix once the clock was running. Preparing
  for an attack and reacting to one are meant to be different things.
- **Sending** is legal between `launchBlock` and `impactBlock`, and stops the
  moment this participant submits a Defense. A second send from the same wallet
  before `lastProbeBlock + DELAY_BLOCKS` reverts (`ProbeInFlight`), and so does
  that wallet's `submitDefense` (`DefenseLockedByProbe`) — the two halves of
  one rule: a reading costs time before it can be spent.
- A probe does not choose where to look; it chooses **where it stands**, snapped
  to the playfield grid. A continuous sensor position would let a player step
  one micrometre sideways for a fresh reading — the Sybil hole in another
  costume. A finite lattice makes the total knowledge an epoch can yield finite.
  Extra cells still cannot cancel the per-attack bias ε: every probe on one
  attack shares it, so fused readings converge on `θ + ε`, never on `θ`.
- `sendProbe` computes the hint inside the confidential engine, stores the
  handle **and grants it to the sender**, all in one transaction. The
  `DELAY_BLOCKS` that used to sit between those two halves did not go away: it
  gates the two calls that can *spend* a reading — a second `sendProbe`
  (`ProbeInFlight`) and that wallet's `submitDefense`
  (`DefenseLockedByProbe`) — so a bot that decrypts in the send block gains
  nothing it can act on, and an honest player stops paying a second signature
  and a second trip through the confidential network's ingestion for the
  distinction. `collectProbe` survives as a permissionless repair for a grant
  that did not stick; on anything `sendProbe` opened it reverts
  `ProbeAlreadyGranted`.
- The hint is **two** noisy angles in one integer — `δ << 32 | θ`, microradians,
  packed by `ReconRules.packHint` because the confidential layer has no
  trigonometry. What the sender decrypts is that packed estimate, not the
  sealed path.
- The answer is readable by **its owner alone** after the grant. Nothing about
  it exists in plaintext on chain.
- Each `sendProbe` increments `lobby.validActions`. Collecting does not.

### 2.5 Defense — `submitDefense`

The coordinate is encrypted **in the browser**, against the engine's address,
before the transaction is built. The contract stores a handle; an observer sees
only that a defense was submitted. One per participant, ever — there is no path
that overwrites one. Submit also records `submitBlock`; the snapshot is
that block. Increments `attemptCount` and `validActions`.

Refused for `DELAY_BLOCKS` after this wallet's last probe
(`DefenseLockedByProbe`) — see §2.4. A player who never probed is not held up.
Sending a probe after this player's submit reverts: recon is closed for them.

The hit test is a **spacetime snapshot**, not a chord cover:

```
arrival = submit
valid   = arrival < impact
      AND distance(point, trajectory[arrival]) <= radius
```

Radius is `interceptRadiusMilliSectors / 1000` sectors (0.14 in source).
Twenty accounts may still place twenty points — that is twenty independent
bets on different moments, not coverage of the path. Submit before the
threat is at that altitude (TOO EARLY) or after it has passed (TOO LATE)
and the snapshot misses. Parking on the line does not count.

### 2.6 Activation — `_activate`

`OPEN → ACTIVE`, once, whenever somebody first needs it to have happened. Every
in-round entry point calls it, so the first probe or defense pays for the
transition as a side effect of an action the player was taking anyway — and an
operation nobody touches is activated by the reveal.

This is the only moment money changes character:

```
rewardPool        += entryFeesCollected          // 100% of entries
// creatorFeeAccrued already holds join commissions
// protocolTreasury already holds the creation fee from mint
```

The entry residual goes into the pool because that is the only destination that
neither orphans it on chain nor quietly hands the creator a second fee.

### 2.7 The flight

`launchBlock` = the epoch boundary. `impactBlock` = `launchBlock + epochBlocks`.
Both are derived, not announced: `_derivedStatus` computes PENDING / LAUNCHED /
COMPLETED from `block.number` on every read, so a client sees the launch happen
without anybody paying to say so. Speed is derived from distance ÷ flight time,
so the threat reaches its target *exactly* at impact.

### 2.8 The reveal — unlock `K`, then score

| Step | Scope | Effect |
|---|---|---|
| `completeAttack(epochId)` / `unlockRound` | epoch | Flight is over; θ, δ and the one-time pad `K` may be decrypted. **O(1).** |
| `revealEpochAttack(epochId, θ, δ, K)` | epoch | **The geometry and `K` become public.** Every Defense Point was already published as `M = P + K` at submit; `P = M − K` is a clear subtraction. |
| `resolveLobby` / `proveDefenses` + `finalizeScoring` | team | This team is scored; its pool is assigned. Geometry, not FHE ACL. |

Defense Points are never `allowGlobal`'d one-by-one at reveal. Each submit
publishes the pad `M` (globally readable, useless without `K`). Landing the
attack unlocks the three epoch handles. The map is drawable the moment `K`
is published, without waiting for every attempt to be judged.

| Transaction | Performs |
|---|---|
| `unlockRound(lobbyId)` | `completeAttack` — unlocks θ, δ, `K` |
| `revealAndResolve(lobbyId, bearing, delta, mask, defenses[])` | `revealEpochAttack` +, when the team fits in `MAX_SCORE_BATCH` (32), `resolveLobby` |

An empty `defenses` on a non-empty team publishes the map and leaves scoring
to `proveDefenses` / `finalizeScoring`. That is how a 1 000-player room
avoids a 16.7M-gas wall: display is O(1) on chain, settlement is batched
attestation of already-public pads.

**Why two and not one.** The confidential network stands between unlock and
prove: `K` has to be unlocked, mined, and only then attested. Pads do not
need that wait — they were public from submit.

> **The distinction that matters.** Publishing the epoch is one transaction
> for the whole world. Scoring is per team, and money does not move until
> `finalizeScoring` (or a one-shot `resolveLobby`). The client draws the
> trajectory as soon as `getTrajectory` answers; Defense Points appear as
> `proveDefenses` writes their coordinates. Claim still re-checks the
> on-chain verdict.
>
> **What the banner says while that read is in flight.** `intercepted === null`
> used to mean both "still sealed" and "we have not asked yet". On a reload of
> an already-scored round the second is true for the whole `getAttackReveal`
> round-trip, and the countdown announced RESULT SEALED — a false invitation to
> reveal. It now takes `Lobby.outcome` from `getLobby` as soon as that lands,
> and RESULT SEALED only after `reveal.loaded` with `scored` still false.
>
> The reveal is also de-duplicated client-side: the automatic keeper and the
> manual button share one in-flight promise, so pressing Reveal while the keeper
> is already part-way through no longer starts a second run — which is how one
> reveal turned into eight wallet prompts.

**Nobody has to press it.** The backend keeper sends unlock, publish and
scoring on its own. Players never sign to *view* the map. A Reveal button
remains only if the keeper fails. Claim is a separate, rare write and still
runs the full on-chain ranking.

### 2.9 Scoring — `resolveLobby`

Among snapshot hits (`submit` still in flight and the threat inside the
radius *then*), the **earliest** wins. Arrival is the submit block, so that
is also the highest, and what it killed never reached the interceptors
below: a later hit is recorded as `intercepted` and paid nothing. Ties are
by block — every hit in the winning block killed the same threat at the
same coordinates, so all of them win and split the pool. Submitting before
the threat is at that altitude, or after it has passed, is not in this set.

```
winners > 0  → intercepted; rewardPerWinner = rewardPool / winners
               first team on the epoch to manage it moves interceptedAttacks
```

Then the ending is decided, and this is where the three-state model lives:

```
validActions == 0            → UNPLAYED   (status CANCELLED, everything refunded)
validActions > 0, winners> 0 → COMPLETED  (pool to the winners)
validActions > 0, winners==0 → COMPLETED  (pool → globalDefensePool)
```

---

## 3. The three endings

`LobbyStatus` is a state machine with two terminal values. There are **three**
ways an operation can end, and folding them into two meant "nobody could be
bothered to play" and "the protocol failed to run the round" were the same word
on screen and the same rule in settlement. `GameTypes.Ending` is the verdict;
`LobbyStatus` stays the machine.

### COMPLETED — the round happened

At least one defender took a real action; the attack flew and landed; the team
was scored. **Zero interceptions is an ordinary COMPLETED** — the threat won.

- **No refunds.** This changed. The old rule returned the entry money after the
  Creator Fee whenever the threat got through, which made losing very nearly
  free. An entry fee that comes back when you lose is not a stake.
- **An unwon pool goes to the Global Defense Pool**, not home to the creator.
  This changed too, and it is the change with teeth: a bounty that comes back on
  a miss is a bounty that costs nothing to advertise, so the advertised prize
  meant very little.
- Creator gets `creatorFeeAccrued`, plus tie-splitting dust on an interception.
  Nothing else.

### UNPLAYED — nobody played

No valid action from anybody, or too few defenders to start at all
(`cancelLobby`). The room never woke up, so there was no contest for the pool to
be the prize of, and charging for it would be charging for a game that never
started.

- **100% back**: every participant takes `paidIn` — entry, author commission and probes. Under-filled rooms are paid in `cancelLobby` itself.
- Creator takes `startPrizePool` only.
- The protocol keeps the creation fee.

### CANCELLED — the protocol failed

`expireAttack`: the grace window passed with no reveal, so there is no
trajectory to score anybody against and no honest way to name a winner. The
players may well have fought the round; the failure is ours.

- Identical payout to UNPLAYED. Deliberately a **different name**: one of these
  is the room's doing and the other is the protocol's, and an operation's record
  should not blur that.

---

## 4. The Global Defense Pool

Every COMPLETED round the threat won sends its pool here. Every
`globalDefenseEpochInterval` epochs (`GAME_GLOBAL_DEFENSE_EPOCH_INTERVAL`,
default 1000) the protocol opens a free-to-enter operation of its own.

Opening is a side effect of ordinary play (`Lobbies.maybeOpenDraw` from
create, join, probes, defense, resolve, reveal), and only inside the join
window — 24 hours of 2-second blocks, or half the interval if that is
shorter. Permissionless `openGlobalDefense` still exists for tests; the UI
never sends it.

It mints an operation owned by the contract:

- **min/max players = live `GameParams`** (`minPlayers`/`maxPlayers`, 2–25
  on Sepolia). There is no smaller jackpot-only cap. The number is frozen on
  the lobby at mint, so a draw opened under an older params version keeps that
  version's ceiling. `maxPlayers` is `uint16` in storage (65535) and the
  rules only require `max >= min`; the live 25 is the gas of one reveal.
- the wei stay in `globalDefensePool` until the round actually starts
  (`Lobbies.commitDrawBounty` from `activate`). Mint used to drain the pile
  into the lobby, so an under-filled room hid the jackpot until somebody
  cancelled it. An OPEN protocol room is just a room: later misses land on
  the same pile the trophy already reads. Once enough defenders start the
  round the bounty moves in and freezes; misses after that wait in the idle
  pool for the next interval,
- **entry price 0** — it is already the players' own money, forfeited from
  rounds they lost; charging them to play for it back would be selling them
  their own stake twice,
- **creator fee 0** — nobody owns it, so joiners pay no author commission,
- **join is free** — sitting in a protocol-owned draw costs nothing.

**There is no "the draw failed" branch anywhere, and that is the design.**

- A draw nobody wins is a COMPLETED round with no winner, so `resolveLobby`
  returns its pool to the Global Defense Pool by the same line that filled it,
  and it waits for the next interval.
- A draw nobody joins is UNPLAYED. The bounty never left the idle pool, so
  cancel does not have to "return" it; ordinary play still closes the leftover
  room (`maybeCloseDraw`) so it does not sit OPEN forever.

The pool is **not** `protocolTreasury` and no owner call can reach it. The
treasury is revenue; this is players' money the protocol has promised back to
the game.

---

## 5. Payouts

| Call | Who | When | Amount |
|---|---|---|---|
| `claimReward` | a winner | COMPLETED + intercepted + `attempt.isWinner` | `rewardPerWinner` |
| `claimRefund` | any participant | UNPLAYED or CANCELLED | `paidIn` |
| `settleCreator` | the creator (or anybody, for the protocol's own draw) | any ending | see below |

```
creatorDue:
  UNPLAYED | CANCELLED → startPrizePool + creatorSeatFee
  COMPLETED            → creatorFeeAccrued + (intercepted ? tie dust : 0)
```

`creatorSeatFee` is passed in rather than read off the lobby, because
`protocolFeeAccrued` is the *whole room's* fees and only one seat's worth is the
creator's — and it is zero for the protocol's own draw, which was minted without
one. Reading the parameter regardless would refund a fee nobody paid, leaving
the contract short by exactly one seat on every draw that ended UNPLAYED.

**Nothing is ever pushed.** Resolution is a verdict, not a payment: an impact
block must not move anybody's money, however certainly it is owed. Every payout
is a transaction its owner sends.

---

## 6. Day X (the Event Horizon)

```
DayX = 2030-01-01 − (MISS × 0.01 d) + (INTERCEPT × 0.10 d)
```

A pure function of the same canonical `interceptedAttacks` / `missedAttacks`
every client already reads, so a tab opened just now agrees with one that has
watched every epoch, with no dedicated event or read.

The two rates are deliberately unequal — one interception buys back ten misses.
Under the single symmetric constant this replaces, only the *net* moved the
date, so a protocol running at an even hit rate showed a horizon that never
moved at all. Both halves of the game are now legible: the planet loses ground
by default, and a good run visibly buys time back.

The readout glows (never shakes) when the **date** moves, not when the clock
ticks — `targetTimestamp` changes exactly when an attack resolves, so an epoch
closing with a hit and a miss at once announces itself once, with the net
already in the digits.

---

## 7. Where the same number is decided more than once

These are the seams to check first when something disagrees with itself.

| Fact | Decided by | Mirrored by | How they stay honest |
|---|---|---|---|
| Config legality | `ProtocolRules.validateConfig` | the client's own copy, in the creation form | The chain re-validates; the frontend copy only greys out buttons. |
| Protocol limits | contract storage → deployment manifest | `appConfig.protocol` (ENV fallback) | `chain:sync` carries them; ENV is only for a build with no deployment behind it. |
| Creator settlement | `Settlement.creatorDue` | the client's read of the same lens figure | Same branches. The lens figure is what was (or is) owed — it stays after `creatorSettled`, so a reload does not print 0. The flag is whether the wei has been paid, not whether the amount vanished. |
| Ending | contract `resolveLobby` / `cancelLobby` / `expireAttack` | `EmulatorBlockchainClient` | The emulator mirrors the rules; it does **not** simulate the draw (that is a real transaction, not a lazy settlement). |
| Block → seconds | one measured rate | — | One module-level estimate for the whole app. Was per-hook; that was the bug. |

---

## 8. Rendering / cost notes

The Home page was heating the CPU. Three causes, all permanent per-frame work on
an otherwise idle page:

1. **The protocol status ring** animated `background-position` across a
   nine-stop `repeating-linear-gradient` behind a two-layer `mask-composite`.
   `background-position` is not compositable, so every frame re-rasterized the
   gradient and re-ran the mask — sixty times a second, forever, on every page.
   Now a `conic-gradient` turned by `transform`: same travelling light, zero
   per-frame cost (a ring is invariant under rotation, so the mask survives
   unchanged).
2. **`backdrop-filter: blur(8px)` on the Day X timer**, sitting directly over
   the spinning globe. A backdrop blur is recomputed whenever what is *behind*
   it changes, so it was re-blurring for every frame of Earth's rotation.
   Replaced with an opaque-enough scrim.
3. **The starfield rebuilt all 220 elements** whenever one to three of them
   twinkled. The resting field is now a `memo`'d component that renders once;
   the burst is a small overlay on top of it.

Plus two client-side reductions: the stats layer coalesces in-flight reads and
stores a result only when a figure actually changed (most blocks move nothing —
attacks resolve on epoch boundaries, and an epoch is a hundred-odd blocks), and
the Day X timer now reads the app's shared countdown clock instead of owning a
second `setInterval` sampling `Date.now()` at an unrelated moment.

---

## 9. Deployment note

These rules **are live** on Base Sepolia. The proxy, the params and the
game version are all in `deployments/84532.json`, which `chain:deploy`
writes by reading them back off the chain — this file names it rather than
repeating it, because the copy that used to sit here said `1.7.0` long
after the contract answered `1.8.0`, and nothing failed.

`version()` is a constant in the bytecode, so it identifies the
*implementation*, not the instance: redeploying the same source to a new
proxy is the same version, and only `chain:upgrade` with changed source
moves it. Changing limits is `npm run chain:params` (no redeploy). The draw
interval is `setGlobalDefenseInterval`, not a `GameParams` field.

`protocolJoinFee` is 0.0005 ETH. The frontend epoch grid is the contract's
`genesisBlock`, read from the deployment manifest — not the proxy's
`deploymentBlock`. The two coincide on a fresh instance and diverge on one
that inherited an earlier grid.

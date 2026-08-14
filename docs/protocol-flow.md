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
| **Block number** | `useEpochClock` → `subscribeToBlocks` | **Everything the protocol decides.** Deadlines, epochs, launches, impacts, grace windows. |
| **Block timestamp** | `block.timestamp` on chain | The creator's chosen wall-clock deadline, and Earth's frozen rotation angle after impact. |
| **Wall clock** | `useCountdownClock` (one 250 ms sample, shared) | **Display only.** Turning "42 blocks" into "01:24" so digits move continuously between blocks. |

Two rules follow, and both are load-bearing:

- **No authoritative state is ever derived from the wall clock.** A countdown
  reaching zero changes nothing; the block arriving does.
- **Blocks are converted to seconds through one measured rate**
  (`useBlockRate`). That estimate is module-level state, shared by the whole
  app. It used to be per-hook, which meant two readouts counting to the *same
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
| `globalDefensePool` | `+` when a COMPLETED round has no winner; `-` when a draw is opened | Players' money in escrow. **Never withdrawable by the owner.** |

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
| `creatorFeeAccrued` | fixed once, at activation | Percentage of entry fees. Earned on a hit and a miss alike. |
| `protocolFeeAccrued` | one seat fee per participant **including the creator** | Moves to `protocolTreasury` at activation; released back on a refunding ending. |
| `rewardPool` | bounty at mint, `+` probes, `+` entry residual at activation, zeroed if forfeited | What winners share. |
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
   The seat fee is charged **to the creator**, and this changed. Creating used
   to be the one way to occupy the protocol without paying it: every joiner
   paid `entry + joinFee`, the creator only their bounty — so the address that
   mints the epoch's attack, takes a fee off every entry and (previously) got
   its bounty back on a miss was the one address the treasury never saw a wei
   from. The creator holds the first seat; they pay for it.
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
joined, and `msg.value == entryPrice + seatFee` **exactly**. The seat fee is
the protocol join fee on a player-created operation, and **0** on the
protocol's own Global Defense draw (the pool is already the players' money).
The exact match is why the client re-reads the fee off the chain rather than
using its own ETH float: the contract compares integers and a
wei → ETH → wei round trip is not guaranteed to land back on the same one.

`leaveLobby` is legal only while applications are open — once the attack is
scheduled the seat is committed, or a defender could watch the reconnaissance
and take their money back. Refund is `paidIn`, in full.

### 2.3 Parameters — who owns what

| Creator sets | Protocol owns (never on the form) |
|---|---|
| name, min/max players, entry price, start prize pool, application deadline, creator fee % | seat fee, probe price, free/max probes, epoch length, sector span, interception radius, grid, defense speed, reveal grace, draw interval |

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
  before `lastProbeBlock + DELAY_BLOCKS` reverts (`ProbeInFlight`).
- A probe does not choose where to look; it chooses **where it stands**, snapped
  to the playfield grid. A continuous sensor position would let a player step
  one micrometre sideways for a fresh reading — the Sybil hole in another
  costume. A finite lattice makes the total knowledge an epoch can yield finite.
  Extra cells still cannot cancel the per-attack bias ε: every probe on one
  attack shares it, so fused readings converge on `θ + ε`, never on `θ`.
- `sendProbe` computes the hint inside the confidential engine and stores the
  handle. It does **not** grant the sender. `collectProbe` is permissionless
  (anybody may call it; the grant is always to the sender) and legal only after
  `readableAtBlock`. That delay is a protocol rule, not a client wait — a bot
  cannot decrypt the answer in the same block it sent the probe.
- The answer is readable by **its owner alone** after the grant. Nothing about
  it exists in plaintext on chain.
- Each `sendProbe` increments `lobby.validActions`. Collecting does not.

### 2.5 Defense — `submitDefense`

The coordinate is encrypted **in the browser**, against the engine's address,
before the transaction is built. The contract stores a handle; an observer sees
only that a defense was submitted. One per participant, ever — there is no path
that overwrites one. Submit also records `submitBlock`; `arrivalBlock =
submitBlock + climbTime` is derived at reveal from altitude and
`defenseSpeedKmPerBlock`. Increments `attemptCount` and `validActions`.
Sending a probe after this player's submit reverts: recon is closed for them.

The hit test is a **spacetime snapshot**, not a chord cover:

```
arrival = submit + climb
valid   = arrival < impact
      AND distance(point, trajectory[arrival]) <= radius
```

Radius is `interceptRadiusMilliSectors / 1000` sectors (0.14 in source).
Twenty accounts may still place twenty points — that is twenty independent
bets on different moments, not coverage of the path.

### 2.6 Activation — `_activate`

`OPEN → ACTIVE`, once, whenever somebody first needs it to have happened. Every
in-round entry point calls it, so the first probe or defense pays for the
transition as a side effect of an action the player was taking anyway — and an
operation nobody touches is activated by the reveal.

This is the only moment money changes character:

```
creatorFeeAccrued  = entryFeesCollected × creatorFeeBps / 10000
rewardPool        += entryFeesCollected − creatorFeeAccrued
protocolTreasury  += protocolFeeAccrued          // now non-refundable
```

The entry residual goes into the pool because that is the only destination that
neither orphans it on chain nor quietly hands the creator a second fee.

### 2.7 The flight

`launchBlock` = the epoch boundary. `impactBlock` = `launchBlock + epochBlocks`.
Both are derived, not announced: `_derivedStatus` computes PENDING / LAUNCHED /
COMPLETED from `block.number` on every read, so a client sees the launch happen
without anybody paying to say so. Speed is derived from distance ÷ flight time,
so the threat reaches its target *exactly* at impact.

### 2.8 The reveal — four steps, two transactions

| Step | Scope | Effect |
|---|---|---|
| `completeAttack(epochId)` | epoch | Flight is over; the engine may unlock decryption. |
| `revealEpochAttack(epochId, …)` | epoch | **The geometry becomes public.** With the quorum's signatures, checked against handles committed before anybody saw a probe. |
| `unlockDefenses(lobbyId)` | team | This team's Defense Points become readable. |
| `resolveLobby(lobbyId, …)` | team | This team is scored; its pool is assigned. |

Those four are the protocol's decomposition and all four still exist as
callable functions. A client does not send four transactions for them, though:
they fold into two.

| Transaction | Performs |
|---|---|
| `unlockRound(lobbyId)` | `completeAttack` + `unlockDefenses` |
| `revealAndResolve(lobbyId, bearing, delta, defenses[])` | `revealEpochAttack` + `resolveLobby` |

**Why two and not one.** The confidential network stands between the halves.
Each pair is unlock-then-prove: the contract has to tell the engine a handle may
be opened, that unlock has to be *mined* so the covalidator quorum can see it,
and only then will the quorum sign the plaintext the second transaction brings
back for checking. The client's `fetchAttested` call between the two sends is
that round trip. No ordering of the four inside a single transaction produces a
signature over a value nobody has been allowed to decrypt yet. What the two
unlocks *do* have in common is that neither needs anything from the other — and
neither do the two proofs — which is the seam the pairs fold along.

Every step is skipped when somebody has already taken it, which makes both
halves safe to retry and safe for two players to press at once. Losing the race
is the ordinary outcome, not a failure: `revealAndResolve` on an epoch another
operation already published simply scores this team.

> **The distinction that matters.** Steps 1–2 are about the *epoch* and are one
> transaction for the whole world. Steps 3–4 are per team.
> `AttackRevealData.scored` carries the difference, and
> `AegylaxLens.getEpochAttack` makes the public half addressable by epoch
> number, so anybody can ask "what happened in epoch N?" without holding an
> attack id.
>
> **What is *not* drawn from the epoch half alone.** The client waits for
> `scored` before drawing anything on the map. Where the trail stops is part of
> the verdict — an unscored round has a zeroed outcome, so
> `AttackReveal` read it as "not intercepted" and drew the beam through
> everybody's radius into Earth, with an impact marker on the planet, for an
> attack that had in fact been shot down. The scoring landed seconds later and
> redrew it correctly, which on screen is one beam drawn twice with the first
> one wrong. A trajectory drawn to the wrong endpoint is not a partial answer,
> it is a false one.
>
> **What the banner says while that read is in flight.** `intercepted === null`
> used to mean both "still sealed" and "we have not asked yet". On a reload of
> an already-scored round the second is true for the whole `getAttackReveal`
> round-trip, and the countdown announced RESULT SEALED — a false invitation to
> reveal. It now takes `Lobby.outcome` from `getLobby` as soon as that lands,
> and RESULT SEALED only after `reveal.loaded` with `scored` still false.
>
> The reveal is also de-duplicated in `useReveal`: the automatic keeper and the
> manual button share one in-flight promise, so pressing Reveal while the keeper
> is already part-way through no longer starts a second run — which is how one
> reveal turned into eight wallet prompts.

**Nobody has to press it.** `useProtocolKeeper` sends both transactions on its
own for anybody with a stake in the operation, up to three attempts per attack
spaced twelve seconds apart, and the screen picks the result up from its
ordinary per-block read. The retry budget exists because the likely failure is
the quorum not having ingested the unlock yet — transient, and clearing by
itself — where giving up on the first one left a finished round with no result
and no claimable reward until somebody noticed the manual button.

### 2.9 Scoring — `resolveLobby`

Among snapshot hits (`arrival` still in flight and the threat inside the
radius *then*), the winner set is every attempt whose arrival equals the
earliest. Exact ties split. Then:

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

- **100% back**: every participant takes `paidIn` — entry, seat fee and probes.
- Creator takes `startPrizePool + their own seat fee`.
- `protocolTreasury` gives up this operation's fees, or an owner withdrawal
  could leave the contract unable to pay refunds it has already promised.

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
`createLobby`, `joinLobby`, `_resolveLobby`), and only inside the join
window — 24 hours of 2-second blocks, or half the interval if that is
shorter. Permissionless `openGlobalDefense` still exists for tests; the UI
never sends it.

It mints an operation owned by the contract:

- **min/max players = live `GameParams`** (`minPlayers`/`maxPlayers`, 2–9999
  on Sepolia). There is no smaller jackpot-only cap. The number is frozen on
  the lobby at mint, so a draw opened under an older params version keeps that
  version's ceiling,
- bounty = the **whole** accumulated pool at mint (drained to zero as it
  moves, so the pool and the operation never both hold the same wei),
  plus any later misses that land while the draw has not launched
  (`Lobbies.topUpDraw`). Once the threat is in flight the bounty is
  frozen; later misses wait in the idle pool for the next interval,
- **entry price 0** — it is already the players' own money, forfeited from
  rounds they lost; charging them to play for it back would be selling them
  their own stake twice,
- **creator fee 0** — nobody owns it,
- **seat fee 0** — joiners pay nothing to sit in a protocol-owned draw.

**There is no "the draw failed" branch anywhere, and that is the design.**

- A draw nobody wins is a COMPLETED round with no winner, so `resolveLobby`
  returns its pool to the Global Defense Pool by the same line that filled it,
  and it waits for the next interval.
- A draw nobody joins is UNPLAYED, and `settleCreator` returns the bounty to the
  pool because the contract is its creator — permissionless in that case,
  because the money must find its way home without the owner being online.

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
| Config legality | `ProtocolRules.validateConfig` | `game/lobby.ts`, the form | The chain re-validates; the frontend copy only greys out buttons. |
| Protocol limits | contract storage → deployment manifest | `appConfig.protocol` (ENV fallback) | `chain:sync` carries them; ENV is only for a build with no deployment behind it. |
| Creator settlement | `Settlement.creatorDue` | `codec.creatorSettlementOf` | Same branches. The lens figure is what was (or is) owed — it stays after `creatorSettled`, so a reload does not print 0. The flag is whether the wei has been paid, not whether the amount vanished. |
| Ending | contract `resolveLobby` / `cancelLobby` / `expireAttack` | `EmulatorBlockchainClient` | The emulator mirrors the rules; it does **not** simulate the draw (that is a real transaction, not a lazy settlement). |
| Block → seconds | `useBlockRate` | — | One module-level estimate for the whole app. Was per-hook; that was the bug. |

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

Plus two React-side reductions: `useGlobalStats` coalesces in-flight reads and
stores a result only when a figure actually changed (most blocks move nothing —
attacks resolve on epoch boundaries, and an epoch is a hundred-odd blocks), and
the Day X timer now reads the app's shared countdown clock instead of owning a
second `setInterval` sampling `Date.now()` at an unrelated moment.

---

## 9. Deployment note

These rules **are live** on Base Sepolia (proxy in `deployments/84532.json`,
game `1.3.2`, params version 4). Changing limits is `npm run chain:params`
(no redeploy). Changing bytecode is `npm run chain:upgrade`. The draw
interval is `setGlobalDefenseInterval`, not a `GameParams` field.

`protocolJoinFee` is 0.0005 ETH. The frontend epoch grid is the contract's
`genesisBlock` 45384541, recorded in the deployment manifest — not the
proxy's `deploymentBlock`, which is later on this chain.

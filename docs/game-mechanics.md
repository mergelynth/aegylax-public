# Game Mechanics

This describes what's implemented today. Anything marked **TODO** is an
intentional placeholder — see [TODO.md](../TODO.md) for the full list.
Per the spec, uncertain mechanics are never faked; they return an
explicit "not finalized" result instead.

## Operation lifecycle

An operation has exactly **one** attack. It is created, filled, attacked
once, and ends on the result of that attack.

```
CREATED -> OPEN -> READY -> ACTIVE -> RESOLVED
             └──────────> CANCELLED
```

- **CREATED** is transient — the moment between submitting the creation
  transaction and it confirming. A `Lobby` object only exists once
  confirmed, at which point its `id` is fixed forever. **The attack is
  scheduled here**: `launchEpochOf(deadlineBlock)` is the epoch after
  applications close, skipping that boundary if less than 90% of an epoch
  would remain. Global Defense is the exception — it closes on the last
  block of the previous epoch on purpose. The epoch's threat is minted
  immediately (shared with every other operation in that epoch).
- **OPEN**: accepting joins, until the deadline *block*.
- At the deadline: the operation is under way if
  `participantCount >= minPlayers`, otherwise it can only be **CANCELLED**
  so refunds unlock.
- **OPEN -> ACTIVE** is the money and nothing else — fees stop being
  refundable and the entry residual becomes the reward pool. Nobody sends
  it: the first probe or defense of the round settles it on the way past,
  and a team that never acted is settled by the reveal. The screen follows
  the *attack* rather than the status byte, so an operation is under way
  the moment its deadline block passes.
- **ACTIVE -> RESOLVED** happens at the impact block. That pass compares
  every locked Defense Point against the real trajectory and records the
  verdict. It does *not* publish the geometry (a player asks for that —
  see [Reveal](#reveal-gameservicegetattackreveal)) and it does *not* pay
  the winner (see [Claim](#claim-reward)).

The UI never renders `LobbyStatus` directly. `game/lobbyPhase.ts` derives
the phase the player actually sees:

```
OPEN -> WAITING FOR ATTACK -> ATTACK INCOMING -> ATTACK ACTIVE -> RESULT
```

and, per player:

```
WAITING -> RECON -> SECTOR SELECTED -> POINT SELECTED -> DEFENSE SUBMITTED -> RESULT
```

Both are derived, never stored, so there is no third copy of the state
that could drift from the chain's. The operation arena stays in attack
mode for the whole flight (`ATTACK_ACTIVE`), whether or not this wallet
has already locked a Defense Point — submitting does not end the round
for everyone else.

## Operation ID = creation transaction hash

`lobby.id === lobby.creationTxHash` always. There is no separate UUID.
The emulator generates a deterministic tx hash the same shape a real
transaction hash would have; a real contract mode would use the actual
on-chain hash. See `game/gameService.ts#createLobby`.

## The playfield (`game/world.ts`)

One canonical coordinate system that every client agrees on, whatever its
screen. The field is the grid — `columns x rows` **square** sectors — with
Earth on its bottom edge as a disc whose centre sits *below* the board, so
only the cap is in play. Two properties matter:

- It is **isotropic**. One sector is one square of `sectorSpanKm` on each
  side, so a circle is a circle and an interception radius means the same
  thing along both axes.
- It is **orientation-independent**. Nothing in `world.ts` knows about the
  portrait transposition, so a player on a phone and one on a desktop
  compute the same interception from the same numbers.

The scale is **declared**, by one number: `VITE_SECTOR_SPAN_KM`, how many
kilometres a sector is across. Everything else about the board follows
from it. It has to work this way round now: an attack's length is a
property of where it happens to start and end, so there is no constant
distance left to size the world from.

There are, deliberately, **two** Earth discs. The canonical one above is
what the protocol's maths uses; `earthDiscInScene` mirrors the hero
stylesheet and is what the screen uses — the grid's clip, the console's
dock, the impact marker. They are tuned to describe the same circle on a
typical landscape scene but do not have to agree exactly, because the
stylesheet anchors the globe to the *scene's* bottom edge while the grid
is centred in the scene. Keeping them close is a matter of the picture
matching the fiction; neither is derived from the other.

## Attacks (`game/attacks.ts`)

- Launch block = the start of the scheduled epoch; impact block = the
  start of the next one. Flight duration is therefore the epoch interval
  by construction.
- The **targetPoint** is picked on the **visible cap** of Earth
  (`impactAngleFromUnit`, bounded by `MAX_IMPACT_OFFSET_RADIANS`). The
  globe's centre is below the board, so an impact further round would land
  where nobody could see or defend it.
- The **startPoint** is where the approach bearing leaves the playfield
  (`rayToFieldBoundary`) — a point on the working area's outer edge. The
  bearing is drawn from the ±55° cone around the impact normal
  (`approachAngleFromUnit`), intersected with the upward half-plane so a
  launch never comes from under the horizon. Two things fall out of
  staying under 90° off the normal: the approach is worth reading (a
  strictly radial attack would make every trajectory inferable from the
  impact sector alone) and the trajectory provably cannot clip Earth
  before reaching its target (`isApproachClearOfEarth`).
- **Speed is derived, not configured.** Because the startPoint is wherever
  the ray exits, every attack has a different length, and
  `speedKmPerBlock = lengthKm / epochBlocks`. Short trajectories therefore
  travel slowly and long ones quickly, and *every* attack in the protocol
  reaches its target at exactly the same moment: the end of the epoch.
- The trajectory also carries `impactAngleRadians`. It is redundant in the
  canonical world and kept anyway: Earth is painted as a scene object
  while sectors transpose on a portrait screen, so the reveal needs an
  orientation-free way to land the impact exactly on the drawn rim.

### Hidden state

`generateAttack` returns the attack and its trajectory as two separate
values, and the emulator stores them in two separate maps. `Attack` has
**no trajectory field at all** — there is nothing on the public record to
forget to strip. The geometry only ever travels as an `AttackRevealData`,
which the chain refuses to produce before resolution.

`speedKmPerBlock` is on the sealed half for the same reason the points
are: speed times the epoch *is* the distance from Earth to the startPoint,
so a public speed would publish half the hidden geometry.

The same applies to Defense Points: `getDefenseAttempts` fills in a point
only for its own owner, for the whole life of the operation — resolved or
not. Seeing anyone else's is what the reveal is for.

### Reveal (`gameService.revealAttack` / `getAttackReveal`)

The reveal is something a player **does**, once, on behalf of everyone.

`revealAttack` is a *write*. It is legal only on a round that actually
happened and has resolved, it may be called by anybody (including someone
who never joined — what it publishes is a fact about a finished round, not
a reward), and it writes the sealed trajectory into the operation's own
state as `Lobby.reveal`. Every later caller is rejected: there is nothing
left to open.

`getAttackReveal` is then an ordinary public read. It returns null until
that write has happened and answers every caller afterwards, forever — in
one value, because it is one event: the trajectory, the outcome, every
participant's Defense Point, and the per-attempt verdicts. There is no
argument that produces a partial reveal, and `getDefenseAttempts` stops
redacting other players' points at the same moment, because by then they
are public protocol state.

So a client opening a resolved operation a week later simply reads the
trajectory and replays the attack. Only the first visitor to a
never-revealed round is offered a button.

**TODO**: in a real deployment the sealed half must not be client-side
state at all. Here it stands in for contract storage the frontend would
have no way to read.

## Recon Probes (`game/recon.ts`)

A probe is **not aimed**. It sweeps the whole working area around Earth,
and the transaction that sends it carries no sector and no coordinate —
so the call itself discloses nothing, not even to an observer reading the
chain. What comes back is a *direction to search in*:

- `bearingDegrees` — where to look, measured from Earth's centre outward;
- `uncertaintyDegrees` — the half-width of the cone that bearing leaves;
- `confidencePercent`;
- `sectorIds` — the sectors that cone crosses.

The truth being estimated is the bearing from Earth to the trajectory's
**launch point**: the attack runs from there down to the planet, so the
whole path lies inside a cone around it. One probe reports that bearing
with triangular noise up to `BASE_CONE_DEGREES`, plus a shared offset.

### The per-attack bias ε

Every probe on one attack also carries a common-mode offset **ε**, drawn
once for that attack (from the epoch seed in the emulator; inside Inco on
chain). Extra sensor cells average away their own noise and converge on
`θ + ε`, never on `θ`. The residual is small — `ATTACK_BIAS_DEGREES` is
5° — so thinking still pays, and large enough at the launch edge that
"the highest intercept on the fused bearing" is not a unique hit. A farm
of wallets cannot cancel it: they share the attack, so they share ε.

These two numbers (`BIAS_MICRO_RAD`, `DELAY_BLOCKS`) are protocol
constants in `ReconRules`, not `GameParams`. `GameParams` packs into four
ERC-7201 slots; appending a field would shift storage under a running
operation. Changing ε or the delay is a new deployment.

### Probe delay

A probe is in flight for `PROBE_DELAY_BLOCKS` (8) after `sendProbe`. The
hint is computed in that transaction but **not** granted to the sender.
`collectProbe` opens it after `readableAtBlock`; anybody may collect, and
the grant is always to the wallet that sent it. Sending another probe
from the same wallet before that block reverts (`ProbeInFlight`). The
wait is on chain so a client cannot skip it: reconnaissance costs climb
time, not just an allowance.

### Fusing probes

Probes **combine**; they do not replace each other. `mergeReconProbes`
takes the precision-weighted circular mean of the bearings — so 350° and
10° merge to 0° rather than 180° — and the fused cone is
`1 / sqrt(Σ 1/σᵢ²)`, which for `n` equally good readings is `σ / √n`. Two
probes leave ~70% of one probe's cone, four leave half. That is a real
statistical fact rather than a tuned curve, and it is why a second probe
is worth sending.

Fusion cannot cancel ε. The cone never closes past `MIN_CONE_DEGREES`
(12°), sized at or above the bias window, so the picture that remains is
still a band: the truth is usually inside it, and one intercept radius
cannot cover the whole remaining uncertainty at the launch edge. Pinning
the exact target is what Reveal is for.

### The fog (`buildReconFog`)

`buildReconFog` turns a fix into a per-sector weight in [0, 1] — a
Gaussian in the angular distance between the fix's bearing and the
direction from Earth to that sector, with the fix's own cone as the width.
Distance from Earth deliberately plays no part: the threat is somewhere
*along* the bearing, and dimming the far cells would be inventing a range
estimate no probe produced.

The grid paints those weights as translucent patches and blurs them past
the cell size, so what the player sees is a continuous field with a
direction rather than a set of coloured squares. Weak intelligence is a
broad, soft haze; strong intelligence is a tight, brighter wedge. This is
the privacy boundary in the UI: it renders what the private computation
already returned, never triangulates several probes into a point, and
never produces anything opaque enough to read as a position.

### The recon clock (`reconNowPoint`)

While the attack is in flight and a fused estimate exists, the map also
draws a **red mark** along the corridor — where that bearing says the
threat *would* be now. It is not the sealed trajectory (ТЗ §3.3). The
path wanders inside the remaining uncertainty (`reconNowPoint`, seeded
from the estimate so a reload does not invent a new flight), interpolates
between blocks the same way the countdown does, and pulses a short local
ping. After reveal the mark is gone; the real chord is `AttackReveal`.

Switching operations drops the previous lobby, attack and reveal before
the next read lands, so the scene never keeps the last round's countdown
or trajectory under a new URL.

### Where probes live

Reconnaissance is bounded at both ends by the attack itself: it opens when
the attack **launches** — there is nothing in flight to scan before that —
and closes at the player's own Send Defense, not at impact. Probes are
therefore useful right through the flight, which is the whole of the play
between launch and submission.

`useReconProbes` keeps a player's answers in `localStorage`, keyed by
`recon:v2:{lobbyId}:{attackId}:{address}` so they survive a reload. They
are stored client-side because they are not chain-readable after the
grant: a probe's answer is delivered once, after `collectProbe`, as the
private computation's output to the wallet that sent it. Storing them
locally keeps the intelligence exactly where it already was — with the
one player who paid for it. The emulator withholds the plaintext until
the same delay, so both modes agree on when a reading exists.

`useReconFog` holds each new answer back until the blue scan wave has
crossed the board, so the sweep is what *delivers* the tightened fog
rather than decoration playing over a change that already happened. Only a
probe sent from the screen gets a wave; a reload rehydrates silently.

**TODO**: `BASE_CONE_DEGREES` and the confidence ramp are game balance,
not correctness. `MIN_CONE_DEGREES` is also a balance number, but it is
load-bearing against ε: it must stay at or above `ATTACK_BIAS_DEGREES`.
The call shapes are the stable part.

## Defense Points and interception (`game/defense.ts`)

A **Defense Point** is a sector plus a fraction along each of that
sector's own axes — `{ sector, offsetX, offsetY }`. That makes it the
same place on every device and at every grid size, and it makes the
two-step pick (choose a sector, then a point inside it) the literal shape
of the data.

Picking it is two genuinely different gestures, not one gesture with a
mode flag:

- clicking a sector that is not selected **selects** it, discarding any
  point previously placed elsewhere;
- clicking inside the selected sector **places, or moves**, the point.

"Inside this sector only" is therefore enforced by which cell was hit,
not by validating coordinates afterwards. The point can be moved freely
until Send Defense; after that it is locked forever, and the emulator
rejects any second `submitDefense` from the same participant.

### Interception is a time, not a distance

The rule is explicitly **not** a point-to-line proximity test. Two
conditions, and both are times:

1. **when** the threat enters the interception radius around the Defense
   Point (`firstEntryIntoCircle` — the nearer root of
   `|P(t) - defensePoint|² = radius²` while the threat is actually flying);
2. whether the interceptor is **already there** when it does. Arrival is
   the submit block plus the climb from Earth's surface to the point, at
   `defenseSpeedKmPerBlock`.

A `t` outside `[0, 1]` never happened while the threat was flying, which
is why "before impact" needs no separate check: `t <= 1` *is* it. A
point that the threat enters, but that the interceptor has not climbed
to yet, is a miss.

Two answers come out of resolution, and conflating them is the mistake the
model exists to rule out:

- `status: 'intercepted'` — the original chord entered this radius while
  the interceptor was on station. Several can record that geometrically.
  It is not a payout: a point further along the path never meets the
  *live* threat once an earlier circle has already stopped it.
- `isWinner` — this defender stopped it with the **earliest entry along
  the trajectory**, not the earliest transaction and not the shortest
  climb. A ring of accounts around Earth cannot collect a win for covering
  a path that was already shot down higher up. Climb time is only the
  on-station gate: still climbing when the threat enters your radius is a
  miss.

The emulator and the chain use the same ranking. The radius is
`DEFENSE_INTERCEPTION_RADIUS` (in sectors) times `sectorSpanKm`,
protocol-owned, and the same number is used by the frontend's drawing,
the private computation and the contract's verification. Exactly equal
entry times leave more than one winner: two radii the threat enters at
the same moment both actually stopped it, and submission order would
reward being early to click rather than being right.

## Economics (`game/economics.ts`)

On chain (the copy that decides):

- **Start prize pool** — funded by the creator at launch (minimum 0.001 ETH).
- **Entry** — 0.0005–0.1 ETH, paid by each joiner.
- **Protocol seat fee** — flat **0.0005 ETH** per seat, including the
  creator's. Accrues on the lobby, moves to `protocolTreasury` when the
  operation activates, and is the **only** amount `withdrawProtocolFees`
  can reach. Over-limit withdrawals revert.
- **Creator fee** — up to 15% of collected entry fees, claimed via
  `settleCreator` on a COMPLETED round whether the threat was stopped or not.
- **Entry residual** — the rest of the entries, folded into `rewardPool` at
  activation.
- **Probe purchases** — protocol price **0.0002 ETH**; proceeds stay in the
  operation's `rewardPool`.

On a hit, winners `claimReward`. On a COMPLETED miss, the unwon pool goes to
the **Global Defense Pool** — not the creator, not the owner. Cancelled and
unplayed rounds refund `paidIn` to every participant and return the bounty
to the creator (or, for a protocol-owned draw, back to the jackpot).

`game/economics.ts` is the emulator's parallel arithmetic so the UI can
preview a cost before a transaction. The contract re-checks every figure.

### Claim Reward

Resolution records an entitlement; it does not move money. The winner claims
with `claimReward`. A frontend that decides someone won changes nothing.

### Global Defense

See [protocol-flow.md](protocol-flow.md) §4. The header trophy
reads the live pool (or the open draw's bounty). Join is offered only inside
the 24-hour window before the interval epoch. The UI never calls
`openGlobalDefense`. The room size is the protocol `maxPlayers` at mint
(9999 on live Sepolia), frozen on that lobby — not a hardcoded 20.

## Map / sectors

Grid size is `VITE_MAP_GRID_COLUMNS` x `VITE_MAP_GRID_ROWS` (10x5 as
shipped, so 50 sectors A1..J5) — never hardcoded. `game/map.ts` keeps
the naming layer (`{ column: 1, row: 2 }` <-> `"B3"`); where a sector
*is* belongs to `game/world.ts`.

The grid is deliberately coarse. It is the player's orientation layer,
not the game's precision — the Defense Point carries the precision, as a
continuous position inside whichever sector it was placed in.

Public per-sector activity (`defenseAttemptCount`) is the only aggregate
exposed on the map. Reconnaissance is not in it at all: a probe has no
sector, so there is no cell it could be counted against. It never reveals the attack's
position, and it never reveals anyone's exact Defense Point — only that a
sector was defended.

### Where the grid is drawn (`game/spaceGrid.ts`)

`buildSpaceGrid` drops cells the globe swallows whole, and
`buildSceneOutsideEarthPath` produces a field-minus-planet clip path so
the remaining cells end on Earth's rim and take its curve. Clipping
rather than masking is what keeps a click on the planet from landing on
the cell technically stretched underneath it.

Earth's on-screen disc comes from `earthDiscInScene(scene)`, which mirrors
`.wrapHero` in `EarthSphere.module.css`: `clamp(320px, 46vw, 680px)`,
anchored to the scene's bottom edge and pushed 60% below it. Those four
numbers are the one thing the module and the stylesheet have to agree on —
change one side and change the other. The Operation screen draws the
identical globe the Home page does.

**Cells are always square.** A 10x5 grid is a 2:1 shape, so it cannot
fill a portrait phone without turning its cells into slivers. `placeGrid`
resolves that by *transposing* on a portrait scene — the same 50 sectors,
drawn 5 across and 10 down — and centring whatever margin is left rather
than stretching to fill. Only the arrangement on screen changes: a
sector's `{ column, row }`, its A1..J5 label, and which sector a world
coordinate falls in are identical on every device.

`cellRect`, `projectToScene`, `defensePointToScene` and
`sceneToDefensePoint` are the only places the transposition is applied,
so nothing can end up laid out against the other orientation. The recon
fog needs no transform at all: its weights are computed per *sector* in
the canonical km world and consumed by cells that already know where they
are on screen, so a portrait player sees the same intelligence over the
same sectors.

## The Operation screen

One full-bleed space scene, the same shape the Home page has, with Earth
on the horizon at the bottom. Three things live on it, and each appears
only while it has something to say:

- **the hero** — only before the operation runs. Title, the operation's
  terms, and the one action a visitor came to take: Join, or — while
  applications are still open — Leave, which returns the entry fee, the
  protocol join fee and any Recon Probes bought. Once the lobby goes
  ACTIVE the seat is committed and the control is gone.
- **the grid** — always *drawn*; it is the scene's orientation layer.
  Clickable only once the operation is running (`interactive`), because a
  cell that highlights under the mouse and does nothing is a promise the
  screen cannot keep.
- **the countdown** — once the operation is running, where the hero was.
  Bare type over the scene with no housing at all, faint, and never
  clickable: the grid and the threat outrank it, and it must not come
  between the player and a sector they are about to click.
- **mission control** — only once the operation is running, seated inside
  Earth's cap.

Everything else about the operation stays in the details drawer.

`components/arena/OperationArena.tsx` is the one place the scene is
measured. The grid, the reveal and Earth's cut-out all have to agree on
where the globe is and how big a sector is, so one component measures and
everything below is handed the result.

The details drawer *floats over* the scene rather than taking a slice out
of it, so opening or closing it never re-lays the grid, never moves Earth,
and never shifts a sector out from under the pointer. It does cover the
right-hand sectors while open — which is why its state is the player's to
keep, **per operation**. The choice is written to `localStorage` keyed by
lobby id on every toggle and read back on the next visit to that same
operation; one global flag would let a decision on one screen silently
move every other one. An operation nobody has decided about opens,
because a first-time visitor needs to see what it *is* before the
playfield means anything. Only the 50 most recently decided operations are
remembered, so the store cannot grow without bound.

The Command Center is a **compact dome** seated inside Earth's visible
cap, its top edge repeating the planet's curve. Its width is derived from
the same `clamp(320px, 46vw, 680px)` the globe is drawn at, which is what
keeps "inside the planet, with even margins, never over the grid" true at
every viewport size rather than at one.

It holds three bubbles and two buttons, and deliberately nothing else —
no operation phase, no player phase, no epoch, no prose:

- **Attack** — the countdown, or ATTACK ACTIVE, or IMPACT; after the
  window, TARGET REACHED once `Lobby.outcome` is known, RESULT SEALED only
  after `getAttackReveal` has come back empty.
- **Recon** — probes ready, probes spent.
- **Defense** — NOT SET, or the coordinate, or LOCKED once submitted.

Its hierarchy is fixed: **Submit Defense** is a large, lit bubble — the
most prominent control on the screen, and inactive until a Defense Point
exists — and **Recon Probe** is a small, cool one with the remaining
count on its badge. They are not equal siblings.

At the end it either becomes **Claim Reward** or goes away entirely; a
finished, revealed operation with nothing to claim leaves the scene to
speak for itself rather than parking a panel of dead controls on Earth.

Once the attack has landed, the planet **stops turning and holds the face
it wore at that moment**, forever, for that operation. The pin is the
impact's own block timestamp, recorded on the outcome, and the angle is
recomputed from it (`earthPosition = f(timestamp)`) on every render — so
the same globe comes back on a reload, in another browser, a month later.
Freezing an animation instead would leave whatever angle one tab happened
to render last, and the trajectory and Defense Points pinned to that globe
would quietly become a lie.

While an attack is in flight the scene shows an edge alert and
deliberately nothing positional. A marker there would be the one thing
reconnaissance is supposed to be for.

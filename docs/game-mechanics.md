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
  `participantCount >= minPlayers`, otherwise it can only be **CANCELLED**.
  `cancelLobby` pays every joiner back in that same transaction (entry,
  author commission, probes) and returns the bounty; the protocol keeps
  the creation fee.
- **OPEN -> ACTIVE** is the money and nothing else — 100% of entries
  become the reward pool, and author commissions stay accrued for the
  creator. Nobody sends it: the first probe or defense of the round
  settles it on the way past, and a team that never acted is settled by
  the reveal. The screen follows the *attack* rather than the status
  byte, so an operation is under way the moment its deadline block
  passes.
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
on-chain hash. The id is the creation transaction's own hash.

## The playfield

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

## Attacks

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

Attack generation returns the attack and its trajectory as two separate
values, kept in two separate places. `Attack` has
**no trajectory field at all** — there is nothing on the public record to
forget to strip. The geometry only ever travels as an `AttackRevealData`,
which the chain refuses to produce before resolution.

`speedKmPerBlock` is on the sealed half for the same reason the points
are: speed times the epoch *is* the distance from Earth to the startPoint,
so a public speed would publish half the hidden geometry.

The same applies to Defense Points: `getDefenseAttempts` fills in a point
only for its own owner, for the whole life of the operation — resolved or
not. Seeing anyone else's is what the reveal is for.

### Reveal (`revealAttack` / `getAttackReveal`)

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

On chain the sealed half is exactly that — handles the contract cannot
read and no client can ask for. The in-browser emulator has no
confidential network to hold them, so it keeps that half locally and
withholds it on the same rules; it is a stand-in for storage a frontend
would never have, and it is not how a deployed round works.

## Recon Probes

The first probe is **not aimed**. It sweeps the whole working area around
Earth, and the transaction that sends it carries no sector and no
coordinate — so the call itself discloses nothing, not even to an observer
reading the chain. Every probe after it is pointed into the area the fix
has already found, and how well it was aimed decides how sharp a reading
it earns. What comes back is a *corridor to search in*: a noisy launch
bearing, a noisy impact offset, and the width of the cone that reading
leaves. Not a point, and not the sealed path.

The truth being estimated is the trajectory itself, as the two angles it
is generated from: θ, the bearing from Earth to the **launch point**, and
δ, how far around the globe the impact sits from it. The attack runs from
one to the other, so the whole path lies inside a corridor around that
chord.

### The hint is two angles, not a bearing

The confidential layer cannot run trigonometry over ciphertext, so it
does not hand back a path. It packs the two noisy angles into one integer
— `δ_noisy << 32 | θ_noisy`, in microradians (`ReconRules.packHint`).
What the sender decrypts is that packed estimate. ε is added to θ alone
and drawn once per attack, so averaging cells cancels the cell noise and
never the bias.

### The per-attack bias ε

Every probe on one attack also carries a common-mode offset **ε**, drawn
once for that attack inside Inco. Extra sensor cells average away their
own noise and converge on `θ + ε`, never on `θ`. The residual is small —
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
wait is on chain so a client cannot skip it: reconnaissance costs wait
time, not just an allowance.

### Fusing probes

Probes **combine**; they do not replace each other. Independent bearings
fuse as a precision-weighted circular mean — so 350° and 10° merge to 0°
rather than 180° — and the impact offset is fused the same way, from
readings that actually carried one. The fused cone is
`1 / sqrt(Σ 1/σᵢ²)`, which for `n` equally good readings is `σ / √n`. The
opening sweep is `BASE_CONE_DEGREES` (52°). Two
probes leave ~70% of one probe's cone, four leave half. That is a real
statistical fact rather than a tuned curve, and it is why a second probe
is worth sending.

Fusion cannot cancel ε. The cone never closes past `MIN_CONE_DEGREES`
(12°), sized at or above the bias window, so the picture that remains is
still a band: the truth is usually inside it, and one intercept radius
cannot cover the whole remaining uncertainty at the launch edge. Pinning
the exact target is what Reveal is for.

### Sector weights

A fix turns into a per-sector weight in [0, 1] — a Gaussian in the
angular distance between the fix's bearing and the direction from Earth to
that sector, with the fix's own cone as the width.
Distance from Earth deliberately plays no part: the threat is somewhere
*along* the bearing, and dimming the far cells would be inventing a range
estimate no probe produced.

Those weights are the machine-readable form of the reading, and what ranks
"which cells are worth searching first". The *map* no longer paints them
cell by cell: translucent patches on a grid read as a set of coloured
squares, and the corridor below says the same thing continuously. Weak intelligence is a
broad, soft band; strong intelligence is a tight one. Extra probes sharpen
it; they never erase the 12° floor, and its centre is **not** a guaranteed
trajectory. Reveal is the only thing that draws the real chord. This is
the privacy boundary in the UI: it renders what the private computation
already returned, never triangulates several probes into a point, and
never produces anything opaque enough to read as a position.

The picture on the map is built from the **fused** fix, not from the first
probe. Anchoring it to the opening reading — which
it used to do, so a noisy third probe could not redraw the corridor — kept
the drawn cloud at its blind opening cone forever and sat it off-centre by that one
reading's whole error. Precision weighting is what makes fusing safe: a
wide reading enters the mean at `1/σ²`, so a bad probe nudges the corridor
rather than swinging it.

- the **cloud** is a corridor along the fused chord — from just past the
  launch, on the field's edge, down to where the chord meets the globe.
  Both half-widths come from the error the fix admits to
  at the launch the reading is an *angle*, so its error
  opens with range; at the impact it is a position on the rim, so the same
  error is a much shorter arc. That difference is the trapezoid, and it is
  derived rather than styled. A fix whose readings never carried δ opens
  its near end to the protocol's whole approach window. The near corners
  are projected onto Earth's rim, so the corridor wraps the horizon
  instead of cutting a straight chord across the planet.
- from the **second** probe, a **red occupancy mark** per probe, each
  placed where *that* reading's own snapshot puts the inbound and held
  inside the corridor it was read from. Sampling a random offset instead —
  which is what this used to do — drew a convincing pile whose darkest
  overlap meant nothing. Readings that agree now stack into one dark
  column and readings that disagree scatter, so the overlap is evidence.
  They stay on the board; they do not follow the flight clock.

The drawing itself is deliberately edgeless: the corridor
is stacked as several narrowing, blurred bands rather than one filled
polygon, because a single shape has a border wherever it ends and a border
on a probability claims the threat cannot be one pixel outside it. The
marks' glow is not clipped to the corridor for the same reason — their
*centres* are what the protocol claims, not the error bar around them.

The scan wave is rings from Earth: the opening probe sweeps the whole
sky, and every probe after it is cut to the cloud, because reconnaissance
searches where the earlier readings already point.

### The recon clock

The occupancy marks are static. The sealed trajectory is never drawn
until Reveal.

Once the round is answered the reconnaissance picture comes **off** the
map entirely — cloud, marks and wave — leaving the trajectory and the
Defense Points to speak alone. A guess and an answer on one board invite
the eye to compare a probability with a fact.

### Where probes live

Reconnaissance is bounded at both ends by the attack itself: it opens when
the attack **launches** — there is nothing in flight to scan before that —
and closes at the player's own Send Defense, not at impact. Probes are
therefore useful right through the flight, which is the whole of the play
between launch and submission.

An answer is delivered **once**. `collectProbe` grants decryption to the
wallet that sent the probe, and after that there is no public read that
returns it: the plaintext is the private computation's output to one
player, and the chain never held it.

**TODO**: the opening cone and the confidence ramp are game balance, not
correctness. The 12° floor is also a balance number, but it is
load-bearing against ε: it must stay at or above the 5° bias window.

## Defense Points and interception

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

### Interception is a snapshot, not a wall

Find where the attack will be. Find when it will be there. Intercept it.

The rule is explicitly **not** "the chord passed through the circle" and
not "submit first and wait." Two conditions, and both are times:

1. **submit** — the block the defense transaction lands;
2. **where the threat is at that instant** — `distance(point,
   trajectory[submit]) <= interceptionRadius`. Submit must still be
   during the flight (`submit < impact`).

Submit before the threat reaches that altitude: TOO EARLY (waiting on
station does not count). Submit after it has passed: TOO LATE. A static
line of points covering the path is twenty independent bets on different
moments, not a guaranteed intercept. The threat occupies one place at
each submit. Radius is `0.14` sectors.

Two answers come out of resolution:

- `status: 'intercepted'` — at this interceptor's submit the threat was
  inside the radius. Covering the chord at some other time is a miss
  (too early or too late).
- `isWinner` — every snapshot hit. The pool splits equally.

After reveal the Result HUD says YOU HIT for every `isWinner`. A circle
the threat passed at the wrong time is TOO LATE or TOO EARLY. WINNERS is
`outcome.winners.length`.

The player is choosing a position **and** a moment, not a circle that
covers the path. Recon → forecast → risk → submit → interception.

The emulator and the chain use the same ranking. The radius is
`DEFENSE_INTERCEPTION_RADIUS` (in sectors) times `sectorSpanKm`,
protocol-owned, and the same number is used by the frontend's drawing,
the private computation and the contract's verification.

### How the points are drawn

The grid draws the player's own Defense Point and its interception circle
in **violet**, before and after the lock. At reveal every other
participant's point is a quiet **blue-grey**, whatever it did: a full
lobby puts hundreds of them on the board, and how each one fared is not
what the viewer came to read.

Two things keep a colour of their own, because in both cases the colour is
the information. The viewer's own **wrong-time** miss stays amber — TOO
EARLY and TOO LATE are the one failure a position on the map cannot
explain, since the circle visibly caught the line. And the **winner's**
radius stays green whoever drew it, because that is the circle that ended
the attack, and it has to be findable in a board full of quiet ones.

## Economics

On chain (the copy that decides):

- **Start prize pool** — funded by the creator at launch (minimum 0.001 ETH).
- **Entry** — 0.0005–0.1 ETH, paid by each joiner.
- **Protocol creation fee** — flat **0.0005 ETH**, paid by the author at
  mint. Goes to `protocolTreasury` immediately and is **never refunded**.
  The **only** amount `withdrawProtocolFees` can reach.
- **Creator commission** — up to 15% of the entry, charged to each joiner
  on top of the entry. Claimed via `settleCreator` on a COMPLETED round
  whether the threat was stopped or not; refunded to joiners if the room
  never starts.
- **Entries** — 100% folded into `rewardPool` at activation.
- **Probe purchases** — protocol price **0.0002 ETH**; proceeds stay in the
  operation's `rewardPool`.

On a hit, winners `claimReward`. On a COMPLETED miss, the unwon pool goes to
the **Global Defense Pool** — not the creator, not the owner. Cancelled and
unplayed rounds refund `paidIn` to every participant and return the bounty
to the creator (or, for a protocol-owned draw, back to the jackpot).

The client keeps parallel arithmetic so the screen can
preview a cost before a transaction. The contract re-checks every figure.

### Claim Reward

Resolution records an entitlement; it does not move money. The winner claims
with `claimReward`. A frontend that decides someone won changes nothing.

### Global Defense

See [protocol-flow.md](protocol-flow.md) §4. The header trophy
reads the live pool (or the open draw's bounty). Misses during the join
window grow that bounty until the threat launches. Join is offered only
inside the 24-hour window before the interval epoch. The UI never calls
`openGlobalDefense`. The room size is the protocol `maxPlayers` at mint
(9999 on live Sepolia), frozen on that lobby — not a hardcoded 20.

## Map / sectors

Grid size is `VITE_MAP_GRID_COLUMNS` x `VITE_MAP_GRID_ROWS` (10x5 as
shipped, so 50 sectors A1..J5) — never hardcoded. Sector *labelling* keeps
the naming layer (`{ column: 1, row: 2 }` <-> `"B3"`); where a sector
*is* belongs to the world geometry.

The grid is deliberately coarse. It is the player's orientation layer,
not the game's precision — the Defense Point carries the precision, as a
continuous position inside whichever sector it was placed in.

Public per-sector activity (`defenseAttemptCount`) is the only aggregate
exposed on the map. Reconnaissance is not in it at all: a probe has no
sector, so there is no cell it could be counted against. It never reveals the attack's
position, and it never reveals anyone's exact Defense Point — only that a
sector was defended.

### Where the grid is drawn

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
  applications are still open — Leave, which returns the entry, the
  author's commission and any Recon Probes bought. Once the lobby goes
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

The scene is measured in exactly one place. The grid, the reveal and
Earth's cut-out all have to agree on where the globe is and how big a
sector is, so one layer measures and everything below is handed the
result.

The details drawer *floats over* the scene rather than taking a slice out
of it, so opening or closing it never re-lays the grid, never moves Earth,
and never shifts a sector out from under the pointer. It does cover the
right-hand sectors while open — which is why its state is the player's to
keep, **per operation**. The choice is remembered per lobby rather than
globally: one shared flag would let a decision on one screen silently move
every other one. An operation nobody has decided about opens,
because a first-time visitor needs to see what it *is* before the
playfield means anything. Only the 50 most recently decided operations are
remembered, so the store cannot grow without bound.

The Command Center is a **chamfered glass capsule** seated inside Earth's
visible cap. Its width and height are derived from the same
`clamp(320px, 46vw, 680px)` the globe is drawn at, which is what keeps
"inside the planet, with even margins, never over the grid" true at every
viewport size rather than at one.

Its frame is two octagons in one SVG over the glass: a static gray outer
rim, and inside it a notched track. On **`ATTACK_ACTIVE` only**, that
track carries two neon pulses — one violet, one blue — chasing it opposite
each other. The console is on screen for far longer than that phase, and
neon running through an open room, a wait for launch and a finished
operation that still owes a payout is decoration reporting nothing, so
every other phase leaves the two gray outlines bare. The pulses are not
hidden there but absent: the masks and blur filters that draw them are not
rendered at all, which is also the cheapest thing to paint on the phases
where the panel is just sitting on the planet.

It holds two readings and two verbs, and deliberately nothing else — no
operation phase, no player phase, no epoch, no prose:

- **Recon** — probes ready, probes spent.
- **Defense** — the coordinate, plus **At submit: Block N** once a
  point exists, then TOO LATE / TOO EARLY / on the pass (submit against
  the fused corridor, never the sealed trajectory). Printed in
  green: pale while the point can still be moved, saturated once it
  cannot.

Neither reading is housed: no border, no background, no radius. They are
printed on the glass rather than sat in bubbles, and the submitted lock is
not a word either — the verb below says SUBMITTED and the reading changes
tone.

There is no **Attack** reading here. The countdown and the ending words —
ATTACK ACTIVE, IMPACT, TARGET REACHED once `Lobby.outcome` is known,
RESULT SEALED only after `getAttackReveal` has come back empty — belong to
`AttackCountdown` over the scene. Printing them on the console as well put
the same fact twice on one screen.

Its hierarchy is fixed: **Defend** is the large ringed control — the most
prominent thing on the screen, and inactive until a Defense Point exists —
and **Recon Probe** is a small, cool disc with the remaining count on its
badge. They are not equal siblings. On a finished operation still waiting
for somebody to take the reveal, that same large control becomes
**Reveal**, rather than a second button arriving beside it.

At the end it either becomes **Claim** or goes away entirely; a finished,
revealed operation with nothing to claim leaves the scene to speak for
itself rather than parking a panel of dead controls on Earth.

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

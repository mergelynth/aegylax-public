# The on-chain protocol

AEGYLAX runs on two chains at once, and the split is the whole design:

- **Base** executes and settles. Lobbies, fees, deadlines, submissions,
  the winner and every payment are ordinary public state in
  `AegylaxGame`.
- **Inco Lightning** holds what the game may not see. An attack's geometry
  is *generated inside* the confidential network, a probe's answer is
  computed there on ciphertext, and a Defense Point is encrypted in the
  player's browser before it ever reaches a transaction argument.

Nothing in the frontend decides a game rule, and nothing in the game
contract can read an attack before it lands. Short jury-facing split:
[INCO_INTEGRATION.md](INCO_INTEGRATION.md).

## Contracts

| Contract | What it is |
| --- | --- |
| `AegylaxGame` | The protocol. Every state-changing function, behind a UUPS proxy. |
| `AegylaxLens` | The read surface. Runs by `delegatecall` in the proxy's storage. |
| `AegylaxStorage` | The single ERC-7201 storage layout both of the above inherit. |
| `IncoConfidentialEngine` | Production confidential layer, over Inco Lightning. |
| `MockConfidentialEngine` | Local stand-in. Not confidential; dev only. |
| `Geometry` / `Trig` | The playfield, trajectories, interception, arrival times. |
| `Epochs` | Epoch grid and `launchEpochOf` (90% remaining-epoch cushion). Internal — inlined into `Lobbies` and storage, not a deployed library. |
| `ReconRules` | Protocol constants that must not live in `GameParams`: per-attack bias ε and probe delay. Internal. |
| `Lobbies` | Minting operations, epoch attacks, Global Defense auto-open. |
| `Resolution` | Judging every defense against a revealed trajectory. |
| `Settlement` | Who is owed what after an ending. |
| `ProtocolRules` | Where a lobby configuration is judged legal. |

`Geometry`, `Lobbies`, `Resolution`, `Settlement` and `ProtocolRules` are
deployed as linked libraries: the game implementation would otherwise exceed
the EVM's 24 KB code limit. They hold no storage, and the deployment pipeline
redeploys and relinks them with every implementation.

### Why a lens

One deployed code object cannot hold both halves. Of the two, reads are
the half that can move without weakening anything: the lens has no
privileged entry point, cannot write, and runs against the proxy's own
storage, so every function that touches money or state stays in one
auditable file. Clients see one address and one merged ABI — which is
exactly what `src/contracts/generated/abi.json` ships.

## The hidden model

The confidential half of an attack is **two angles**:

- `θ` — the bearing from Earth's centre to the launch point. The launch
  point itself is derived: it is where that ray leaves the board, which is
  what makes it a point on the working area's outer edge whatever shape
  the board is.
- `δ` — how far around the globe the impact point sits from that bearing,
  constrained *inside the confidential layer* so the impact always lands
  on the visible cap.

Choosing this parametrisation rather than (impact angle, approach angle)
is what keeps the confidential layer cheap: both values are bounded
non-negative integers, so generating them, adding noise for a probe and
constraining one against the other are integer operations. No
trigonometry ever runs over encrypted data. The trigonometry runs once,
in the clear, at reveal time — on values a covalidator quorum has signed.

Life of an attack:

The epoch owns the threat and the operation owns its team, so the calls
split along that line: two of them happen once per epoch for the whole
world, and two happen once per operation.

```
createLobby         binds this operation to `launchEpochOf(deadlineBlock)`
   (per operation)  — the epoch after the deadline, skipping that boundary
                    if less than 90% of an epoch would remain — and, if
                    nobody has yet, draws that epoch's θ and δ inside Inco;
                    the contract keeps two handles -> LobbyCreated, AttackStarted

startOperation      the money only: fees stop being refundable and the
   (per operation)  entry residual becomes the pool. Nobody has to send it;
                    the first in-round action does it (`_activate`)

sendProbe           hint = θ + ε + cellNoise + cellNoise, computed on
   (per player)     ciphertext. ε is drawn once per attack; cell noise
                    is one sample per sensor cell, so a second probe
                    from the same place is the same reading. The handle
                    is stored, not granted. -> ProbeSent(hintHandle,
                    readableAtBlock)

collectProbe        after DELAY_BLOCKS, grants the hint to the sender.
   (permissionless) Anybody may collect. -> ProbeHintGranted

submitDefense       a point encrypted in the browser against the engine
   (per player)     -> DefenseSubmitted(pointHandle)

completeAttack      only after impactBlock: unlocks decryption for the
   (per epoch)      epoch's two handles -> AttackCompleted

revealEpochAttack   plaintexts + covalidator signatures, checked against
   (per epoch)      the handles committed at generation; the geometry
                    becomes public -> AttackRevealed

unlockDefenses      this team's Defense Points become decryptable
   (per operation)

resolveLobby        this team is judged against the published geometry and
   (per operation)  its winner is decided -> WinnerDetermined

claimReward         pull payment, once per winner
```

Every one of those four reveal calls is permissionless, which is what
stops a finished operation from depending on the goodwill of whoever lost
it, and `expireAttack` refunds everyone if nobody reveals within
`revealGraceBlocks`. Steps skipped because somebody else already took
them are the normal path, not a lost race: two operations on the same
epoch share the first two.

A client does not send four transactions for them. Two batching entry
points fold the pairs together, and both are idempotent for the same
reason the four are:

```
unlockRound         completeAttack + unlockDefenses, each skipped if done
   (per operation)

revealAndResolve    revealEpochAttack + resolveLobby, each skipped if done
   (per operation)
```

It cannot be folded further. The confidential network stands between the
halves: an unlock has to be *mined* before the covalidator quorum will
sign the plaintext the second call brings back for checking, so the
client's `fetchAttested` between the two sends is a round trip no single
transaction can contain. The four originals stay callable, so a script
that wants to take one step at a time still can.

`ContractBlockchainClient.performReveal` runs the two-call sequence from
the browser and `useProtocolKeeper` sends it without being asked, for
anybody with a stake, with a small retry budget for the covalidator lag
that makes a first attempt fail. `npm run chain:e2e` runs the protocol
from a script — worth keeping in step, since it is the same protocol.

## Interception and the winner

Two conditions, and both are times rather than a chord test:

1. the interceptor **arrives** (submit + climb) while the threat is still
   in flight;
2. at that instant, `distance(point, trajectory[arrival])` is inside the
   interception radius (`0.14` sectors).

Arrive **before** the threat reaches that altitude and you miss (TOO
EARLY) — waiting on station is not a hit. Arrive **after** it has passed
and you miss (TOO LATE). Among those snapshot hits, the winner is the
**earliest arrival**. A farm of wallets tiling a static line is twenty
independent bets, not a wall: at each arrival the threat is in one place.
Exact arrival ties split the pool. The emulator uses the same rule
(`resolveDefense` matches `Geometry.evaluateDefense`). There is no
"highest intercept" ranking.

```
arrival = submitBlock + climbTime
valid   = arrival < impactBlock
      AND distance(point, trajectory[arrival]) <= radius
```

An emergent consequence worth knowing: a point very close to the launch
edge is nearly undefendable, because an interceptor cannot climb that far
before the threat passes.

## Parameters

Every game-critical value lives in contract storage, is set by
`initialize()` / `setParams()` from `contracts/.env`, and is **snapshotted
onto each lobby at creation**. The frontend reads them from the deployment
manifest (`protocolLimitsFromParams`) and the client re-reads live
`getParams()` before a write.

The Global Defense **interval** is a separate storage field
(`globalDefenseEpochInterval`), not a `GameParams` member. Change it with
`setGlobalDefenseInterval`. The join window is **not** a parameter: both
Solidity (`1 days / 2` two-second blocks) and the frontend prefer 24 hours,
or half the interval if that is shorter.

### Live Base Sepolia (params version 4)

| | |
| --- | --- |
| Grid | 10 × 5, 1000 km/sector, intercept 0.14 sectors |
| Epoch | 120 blocks (~4 min at 2s) |
| Players | 2–9999 |
| Entry | 0.0005–0.1 ETH |
| Min start pool | 0.001 ETH |
| Creator fee cap | 15% |
| Probe | 3 free, 8 max, **0.0002 ETH**; 8-block delay; 5° attack bias ε |
| Seat fee | **0.0005 ETH** (creator included) |
| Jackpot interval | 1000 epochs |
| Genesis block | 45384541 (pinned; not the current proxy's deploy block) |

`withdrawProtocolFees(to, amount)` is owner-only and cannot exceed
`protocolTreasury`. Prize pools and `globalDefensePool` are unreachable.

A full room of 9999 defenders would not fit in one reveal transaction —
see TODO (chunked reveal).

## Which Inco release

Inco publishes one executor per "pepper" — `mainnet`, `testnet`, `devnet` —
and each is a different address linked into the Solidity library at compile
time, paired with its own covalidator quorum that the client SDK resolves
from the same name. Choosing them separately produces handles nothing can
decrypt, and does so silently.

So the pepper is deployment configuration: `INCO_PEPPER` decides what
`@inco-active/Lib.sol` resolves to before anything compiles, the manifest
records it, and the frontend reads it back to reach the matching quorum.
After deployment the pipeline reads `incoExecutor()` off the engine and
refuses to continue unless it matches what the SDK resolves — a mismatch
fails at deploy time rather than at some player's first Recon Probe.

> Base Sepolia currently has both lines deployed. As of this writing the
> `testnet` covalidator ingress serves a Traefik default certificate and
> answers 404, so `devnet` is what actually resolves there.

## Deployment

```bash
npm run chain:test      # forge test
npm run chain:deploy    # build, test, validate, deploy, wire, fund, manifest, sync
npm run chain:upgrade   # same proxy, new implementation, storage-checked
npm run chain:params    # push protocol rules from .env on chain (--dry-run to preview)
npm run chain:verify    # publish source for every deployed address
npm run chain:e2e       # play a whole operation on the live network, 3 wallets
npm run chain:reveal ID # finish a landed attack somebody else abandoned
npm run build           # refresh generated config, typecheck, build the UI
```

`chain:params` is worth knowing about: game rules live in contract storage,
so changing one is a transaction rather than a redeploy, and running
operations keep the snapshot they were created under.

`chain:deploy` refuses to continue if the tests fail, if the
implementation is not upgrade-safe, if the RPC reports a different chain
than `CHAIN_ID`, or if a public network is pointed at the mock engine
without an explicit override. `chain:upgrade` additionally refuses any
storage layout incompatible with the one recorded when the deployed
implementation went out (`deployments/<chainId>.storage-layout.json`).

Output is a manifest per network in `deployments/`, from which
`src/contracts/generated/` is regenerated. That directory is the only
place in the frontend where a contract address exists.

## Running against a public RPC

Two facts about public endpoints shape the pipeline, and both bit during the
first live deployment:

- **A mined receipt is not visible state.** An endpoint is several nodes
  behind one address, so a call issued right after a deployment can land on
  one that has not caught up: it answers `0x` for a contract that exists, or
  reverts a proxy constructor that delegates to a fresh implementation. The
  scripts therefore wait for *code visibility* after every deployment and
  for the *expected value* after every wiring call, rather than for a
  receipt.
- **A mined receipt is not a successful one.** A reverted transaction is
  mined like any other. Every write goes through `sendAndConfirm`, which
  reads `receipt.status` and treats a revert as a failure. (The first
  deployment reported success while `setLens` had silently reverted, which
  is exactly the failure this prevents.)

The confidential network has its own version of the same thing: it learns
about a new ciphertext, or a reveal unlock, by watching the chain, so "not
processed yet" is a normal answer for a few seconds afterwards. Both the app
and the tools retry briefly — a probe is paid for, and losing its answer to
ingestion lag would be losing something the player bought.

## Tests

### On chain

`npm run chain:e2e` plays one whole operation against the deployed contract
with three separate keys, through the real confidential network: create,
two joins, start, three probes each (wait the delay, `collectProbe`, then
decrypt — only the wallet that bought them can), two encrypted Defense
Points, complete, reveal, winner, claim, settle. It asserts the properties
the unit suite cannot reach — that a probe answer does not open for another
wallet, that no coordinate is readable before the reveal, and that a second
claim is rejected.

A run on Base Sepolia:

```
alice fuses 3 readings -> -66.8°   (raw -83.0°, -90.1°, -24.3°)
bob   fuses 3 readings -> -58.2°   (raw -37.5°, -98.0°, -41.4°)
trajectory published: (8278, 0) km -> (5257, 3564) km, 4673 km long
alice  point (6677, 1942) km  miss 34 km   arrival 45354670.6  INTERCEPTED  <- WINNER
bob    point (7710, 1482) km  miss 525 km  arrival 45354672.4  missed
```

Worth reading closely: at Alice's arrival the threat was 34 km away — inside
the radius — so the snapshot hit. At Bob's arrival it was 525 km away, so
covering a different part of the chord did not count. Earliest valid arrival
won. Bob's fused bearing was *closer* to the truth than Alice's, and he still
missed: he aimed nearer to Earth, where the trajectory has diverged from the
radial bearing a probe reports, while she aimed high, where it has not. That
is the geometry teaching a real lesson about how to play, not a quirk of the
test.

### Local

`contracts/test/` covers the lifecycle, fees and refunds, probe
allowances, commitment/reveal (including invented trajectories and
invented Defense Points), hidden-data availability, timing windows,
interception (snapshot at arrival), multiple defenders, ranking by earliest
arrival, claims and double
claims, reentrancy, access control, pausing, upgrades and storage
preservation, plus fuzzed geometry invariants — that a launch point is
always on the board's edge, that a trajectory never clips Earth, and that
speed is always distance over flight time.

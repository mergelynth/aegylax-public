# The on-chain protocol

AEGYLAX runs on two chains at once, and the split is the whole design:

- **Base** executes and settles. Lobbies, fees, deadlines, submissions,
  the winner and every payment are ordinary public state in
  `AegylaxGame`.
- **A confidential network** holds what the game may not see. An attack's
  geometry is *generated inside* it, a probe's answer is computed there on
  ciphertext, and a Defense Point is encrypted in the player's browser before
  it ever reaches a transaction argument.

Which network that is, is a deployment parameter. `AegylaxGame` holds an
`IConfidentialEngine` and opaque `bytes32` handles; the adapter behind that
interface is **Fhenix CoFHE** by default and **Inco Lightning** on request,
and neither name appears anywhere in the game, the libraries or the lens.

Nothing in the frontend decides a game rule, and nothing in the game
contract can read an attack before it lands. Short jury-facing split:
[fhenix-integration.md](fhenix-integration.md), or
[inco-integration.md](inco-integration.md) for the Inco provider.

## Contracts

| Contract | What it is |
| --- | --- |
| `AegylaxGame` | The protocol. Every state-changing function, behind a UUPS proxy. |
| `AegylaxLens` | The read surface. Runs by `delegatecall` in the proxy's storage. |
| `AegylaxStorage` | The single ERC-7201 storage layout both of the above inherit. |
| `IConfidentialEngine` | The confidential-data boundary. The game knows this and handles; never a provider. |
| `FhenixConfidentialEngine` | Production confidential layer, over Fhenix CoFHE. The default. |
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
exactly what `frontend/src/contracts/generated/abi.json` ships.

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
                    nobody has yet, draws that epoch's θ, δ and pad K
                    inside the confidential network; the contract keeps
                    three handles
                    -> LobbyCreated, AttackStarted

startOperation      the money only: every wei of entry folds into the pool;
   (per operation)  author commissions stay accrued. Nobody has to send it;
                    the first in-round action does it (`_activate`)

sendProbe           hint = (δ + noise) << 32 | (θ + ε + noise), computed
   (per player)     on ciphertext and packed by `ReconRules.packHint` —
                    a layer with no trigonometry can hand back a chord
                    only as two integers. ε is drawn once per attack and
                    only on θ; cell noise is one sample per sensor cell
                    and angle, so a second probe from the same place is
                    the same reading. The handle is granted to the sender
                    in this same call, so a probe is one transaction.
                    DELAY_BLOCKS is charged on the next probe and on
                    submitDefense instead of on the read.
                    -> ProbeSent(hintHandle, readableAtBlock)

collectProbe        re-grants a hint whose grant did not stick — a repair,
   (permissionless) not the normal path, and reverts ProbeAlreadyGranted
                    on anything sendProbe already opened.
                    -> ProbeHintGranted

submitDefense       a point encrypted in the browser against the engine;
   (per player)     engine publishes M = P + K globally -> DefenseSubmitted

completeAttack      only after impactBlock: unlocks θ, δ and K (O(1))
   (per epoch)      -> AttackCompleted

revealEpochAttack   attested θ, δ, K; geometry and the pad key become
   (per epoch)      public -> AttackRevealed

unlockDefenses      no-op kept for old clients; pads are public from submit

resolveLobby        this team is judged (≤ MAX_SCORE_BATCH) -> WinnerDetermined
proveDefenses       attest a subset, recrown
finalizeScoring     assign the pool

claimReward         pull payment, once per winner
```

Every one of those reveal calls is permissionless, which is what
stops a finished operation from depending on the goodwill of whoever lost
it, and `expireAttack` refunds everyone if nobody reveals within
`revealGraceBlocks`. Publishing the epoch is shared; scoring is per team.

A client does not send a transaction per Defense Point. Unlocking `K` is
O(1); scoring is batched attestation of pads that were already public.

```
unlockRound         completeAttack — unlocks θ, δ, K. O(1).
   (per operation)

revealAndResolve    revealEpochAttack(θ, δ, K) + resolveLobby when the team
   (per operation)  fits in MAX_SCORE_BATCH (32). Empty defenses = publish only.

proveDefenses       attest a subset of already-public pads, recrown
finalizeScoring     assign the pool (all scored, or grace elapsed)
```

It cannot be folded to one transaction. `K` has to be unlocked and mined
before the quorum will attest it. Defense Points do not join that unlock:
each submit published `M = P + K` globally, so the reveal never walks the
attempt list for FHE ACL.

`ContractBlockchainClient.performReveal` and the backend keeper run this
path. Players do not sign to view the map. Claim still verifies on chain.

## Interception and the winner

Two conditions, and both are times rather than a chord test:

1. the defense **lands** (submit block) while the threat is still
   in flight;
2. at that instant, `distance(point, trajectory[submit])` is inside the
   interception radius (`0.14` sectors).

Submit **before** the threat reaches that altitude and you miss (TOO
EARLY) — waiting on station is not a hit. Submit **after** it has passed
and you miss (TOO LATE). Among the hits, the **earliest** one wins and
takes the whole pool: arrival is the submit block, so the earliest hit is
the highest one, and the threat it killed never reached anybody below.
Those later hits stay `intercepted` on the record — the shot was good —
but `isWinner` is false. Hits that share the winning block share the pool
equally, any number of them; order within a block is the sequencer's and
never decides money. A farm of wallets tiling a static line is twenty
independent bets, not a wall: at each submit the threat is in one place.
The emulator uses the same rule (`resolveDefense` matches
`Geometry.evaluateDefense`).

```
arrival = submitBlock
valid   = arrival < impactBlock
      AND distance(point, trajectory[arrival]) <= radius
```

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
| Players | 2–25 (`uint16` allows 65535; gas of one reveal is the ceiling) |
| Entry | 0.0005–0.1 ETH |
| Min start pool | 0.001 ETH |
| Creator fee cap | 15% |
| Probe | 3 free, 8 max, **0.0002 ETH**; 8-block delay; 5° attack bias ε |
| Seat fee | **0.0005 ETH** (creator included) |
| Jackpot interval | 1000 epochs |
| Genesis block | `genesisBlock` in `deployments/84532.json` (pinned at `initialize`, no setter) |

`withdrawProtocolFees(to, amount)` is owner-only and cannot exceed
`protocolTreasury`. Prize pools and `globalDefensePool` are unreachable.

A full room is no longer one `allowGlobal` per Defense Point. Submit
publishes a one-time pad; reveal unlocks `K` in O(1); scoring is batched
attestation (`MAX_SCORE_BATCH` = 32). Live `maxPlayers` can rise without
a per-point FHE unlock wall. See `docs/protocol-flow.md` §2.8.

## Which confidential network, and which deployment of it

Two settings, and the second is the one that fails quietly.

`CONFIDENTIAL_ENGINE` picks the provider — `fhenix`, `inco`, `mock`, or an
`0x` address to reuse an engine that already exists. It decides which adapter
is deployed and what `kind` goes into the manifest; the frontend builds the
matching gateway from that field and refuses a kind it has no implementation
for. `tools/chain/confidential.mjs` is the table, and it is the only place in
the pipeline that knows a provider by name.

`CONFIDENTIAL_RELEASE` (or the provider's own spelling — `COFHE_ENVIRONMENT`,
`INCO_PEPPER`) picks *which deployment of that network*. The client SDK
resolves a whole set of services from it, so a value that disagrees with what
the engine was wired to produces handles nothing can decrypt — silently, until
the first Recon Probe. The pipeline therefore checks it at deploy time:

- **Fhenix.** CoFHE links one TaskManager address on every chain it supports,
  so there is nothing to select at compile time. The deployer reads
  `cofheTaskManager()` off the engine and refuses if there is no code at it —
  which is what "CoFHE is not on this chain" looks like.
- **Inco.** Each pepper links a *different* executor into the Solidity library
  at compile time, paired with its own covalidator quorum that the SDK
  resolves from the same name. `INCO_PEPPER` decides what
  `@inco-active/Lib.sol` resolves to before anything compiles, and after
  deployment the pipeline reads `incoExecutor()` back and refuses to continue
  unless it matches what the SDK resolves.

> Base Sepolia currently has both Inco lines deployed. As of this writing the
> `testnet` covalidator ingress serves a Traefik default certificate and
> answers 404, so `devnet` is what actually resolves there.

An engine is bound to its proxy permanently, so moving a live deployment to
another provider is `CONFIDENTIAL_ENGINE=<new> UPGRADE_ENGINE=true npm run
chain:upgrade` — which deploys a fresh adapter and re-points the game at it.
Handles minted by the old engine can only be revealed through it, so finish
the rounds in flight first.

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
`frontend/src/contracts/generated/` is regenerated. That directory is the only
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
two joins, start, three probes each (one transaction apiece; the read runs
while the wallet sits out `DELAY_BLOCKS` — only the wallet that bought them
can decrypt), two encrypted Defense
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

Worth reading closely: at Alice's submit the threat was 34 km away — inside
the radius — so the snapshot hit. At Bob's submit it was 525 km away, so
covering a different part of the chord did not count. Bob's fused bearing was
*closer* to the truth than Alice's, and he still missed: he aimed nearer to
Earth, where the trajectory has diverged from the radial bearing a probe
reports, while she aimed high, where it has not. That is the geometry teaching
a real lesson about how to play, not a quirk of the test.

### Local

`contracts/test/` covers the lifecycle, fees and refunds, probe
allowances, commitment/reveal (including invented trajectories and
invented Defense Points), hidden-data availability, timing windows,
interception (snapshot at submit), multiple defenders, split among snapshot
hits, claims and double
claims, reentrancy, access control, pausing, upgrades and storage
preservation, plus fuzzed geometry invariants — that a launch point is
always on the board's edge, that a trajectory never clips Earth, and that
speed is always distance over flight time.

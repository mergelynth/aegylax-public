# Attack Epochs

## Why epochs, not timers

Every participant in a lobby must compute the same game state from the
same reference — so nothing here uses `Date.now()` or `setTimeout` for
anything authoritative. The reference is the block number, obtained
through `BlockchainClient.getBlockNumber()` / `getBlock()`, which is the
same whether that's the emulator's simulated chain or a real Base RPC.

```
block number
    │  getEpochFromBlock(block, epochBlocks, genesisBlock)
    ▼
epoch id
    │  generateEpochSeed(lobbyId, epochId, blockHash, salt)
    ▼
epoch seed
    │  generateAttack(...)
    ▼
one attack: launch block, impact block, and a sealed trajectory
```

`genesisBlock` is the block the protocol's epoch grid is measured from —
pinned in `contracts/.env` rather than left at the deployment block, so
redeploying does not restart the count. The clock keeps advancing whether
or not any operation exists.

## Scheduled at creation, by arithmetic

An operation's application deadline is a **block**, and that single fact is
what makes an attack independent of everybody:

```
createLobby(config)
    │  launchEpoch = launchEpochOf(config.registrationDeadlineBlock)
    │  (epoch after the deadline, skipping the next boundary if
    │   less than 90% of an epoch would remain)
    ▼
the epoch's attack, minted on the spot (shared with every other
operation that launches into that epoch)
```

So the threat is a fact from the moment the operation exists. It launches
on its epoch boundary and lands on the next whether or not anybody sends
another transaction, and every client counts down to the same block. There
is no "first player to act decides which epoch we play", no keeper that has
to be online, and no transition a defender is asked to authorise.

What still has to be sent is only the *money*: closing applications moves
the Creator Fee and the protocol fee out of refundable and turns the entry
residual into the reward pool. Nobody sends it either — the first probe or
defense of the round does it as a side effect (`_activate`), and an
operation nobody acted in is settled by the reveal.

The deadline the creator *picks* is still a wall-clock time, because that
is what a person means by "applications close at six". The client converts
it to a block with the measured block rate and sends both; the timestamp is
what the screen shows and what the protocol's window limits are checked in,
the block is what closes applications and what the epoch comes from. A
contract cannot do that conversion — it would have to assume a block time,
which is the assumption §20 forbids.

## Epoch length

On chain this is `GameParams.epochBlocks` (Base Sepolia: **120** blocks,
~4 minutes at 2s). The frontend ENV `VITE_ATTACK_EPOCH_BLOCKS` is the
emulator fallback and is ignored in contract mode whenever a manifest
exists. The code never hardcodes "5 minutes." It only ever reasons in
block counts, per spec §20.

## One attack per epoch

The protocol draws **one** threat per epoch, shared by every operation whose
attack is scheduled into it. An operation still plays exactly one round: it
launches on that epoch boundary and impacts on the next, so flight duration
is the epoch length. Two rooms defending the same epoch are scored against
the same geometry. A player-created operation whose join window would close
with less than 90% of an epoch remaining until the next boundary waits one
more epoch, so the attack cannot fire a block after applications close.
The protocol's own **Global Defense** draw is exempt: it is minted to
close on the last block of the previous epoch and launch on the next.

## Determinism

Every random-looking value traces back to `game/randomness.ts`:

```
deriveSeed([...inputs]) -> keccak256(...) -> Hash
createSeededRandom(seed) -> mulberry32 PRNG seeded from that hash
```

The epoch seed itself is derived from the lobby id, epoch id, the hash of
the block at the epoch's start, and a fixed salt. Same inputs, same
seed, same attacks — every client in the lobby computes an identical
result independently. `Math.random()` does not appear anywhere in
`game/`.

On chain the trajectory is not this PRNG. `IncoConfidentialEngine`
draws θ and δ *inside* Inco Lightning; the contract stores handles, not
plaintext. The emulator still uses the seeded path above so tests stay
deterministic. Same launch/impact blocks either way — only the secret
source differs.

## Trajectory

An attack is a straight line from a `startPoint` on the playfield's outer
edge to a `targetPoint` on Earth's visible cap. Both are generated from
the epoch seed and neither is ever returned by a public read — see
[game-mechanics.md](game-mechanics.md#hidden-state).

The length is whatever that geometry produces, so it differs every time,
and **speed is derived from it**: `lengthKm / epochBlocks`. That is what
pins every attack's impact to the epoch boundary regardless of how far it
had to travel — short trajectories crawl, long ones race, and they all
land together. `getPositionAtBlock` linearly interpolates;
`getImpactPoint` / `getImpactTime` read off the endpoint.

The epoch length is the *only* attack timing input left in ENV. There is
no speed constant to configure any more, which also means there is no way
for a mis-set speed and epoch length to disagree about when an attack
arrives.

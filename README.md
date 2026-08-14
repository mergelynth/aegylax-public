# AEGYLAX — Planetary Defense (protocol)

Earth is under attack. Players open Defense Operations, buy incomplete
intelligence with Recon Probes, and commit one Defense Point against a threat
whose trajectory nobody can see until the round is over — not the players, not
the protocol owner, not a client.

The **smart contract is the game**. [Base](https://base.org) executes and
settles it. **[Inco Lightning](https://www.inco.org/)** holds the secrets until
impact.

This repository is the **public protocol surface**: documentation, Solidity
source, Foundry tests, and the live deployment record. The game client is
proprietary and is not published here.

This is a **testnet product** (Base Sepolia). It is not audited for mainnet
value.

Copyright © 2026 AEGYLAX. All rights reserved. See [LICENSE](LICENSE).

---

## What this repo is for

| Path | Why it is public |
| --- | --- |
| `contracts/` | The rules that hold funds. Anyone can read, compile, and test them. |
| `deployments/` | Addresses and params of the live UUPS proxy on Base Sepolia. |
| `docs/` | How lobbies, epochs, probes, Inco, and the jackpot actually work. |
| `LICENSE` / `SECURITY.md` | Terms and how to report a funds bug. |

There is no frontend here, no deploy keys, no emulator, and no operator
runbook. Those stay in the private product repo.

---

## How a round works

1. A creator funds a prize pool and opens an operation (entry, player limits,
   deadline, creator fee — within protocol limits). Creating and joining each
   pay a protocol **seat fee**. That fee is the only thing the owner may
   withdraw.
2. The attack is scheduled at creation from the application **deadline block**.
   It flies in the epoch after applications close, **unless** that boundary
   would leave less than 90% of an epoch to play in — then the operation waits
   one more. Countdowns use the contract's `genesisBlock` (in the deployment
   manifest), not the proxy's deploy block.
3. Defenders probe (a few free, then a priced call). Each probe is in flight
   for **8 blocks** before `collectProbe` grants the hint. Every probe on one
   attack shares a bias ε (5°), so fused readings converge on `θ + ε`, never
   on `θ`. Then each defender commits one encrypted Defense Point.
4. After impact, anyone may reveal. The earliest interceptor who was on
   station (submit + climb, not highest intercept) wins and claims. If the
   threat got through, the unwon pool goes to the **Global Defense** jackpot —
   not back to the creator.
5. Every 1000 epochs the protocol opens a free jackpot round with that pool.

Nobody needs to be online for an attack to launch or land. Keepers are
permissionless: the first in-round action closes applications; reveal and
claims are whoever is watching.

---

## Lobbies

An operation is one room, one attack, one ending.

```
create  →  applications open  →  deadline block  →  in flight  →  impact  →  claim
                └──────── under-filled: cancel / unplayed, full refunds
```

- **Create** (`createLobby`). The creator pays `startPrizePool + protocolJoinFee`
  and picks name, seats, entry, deadline, creator fee % — all checked against
  `ProtocolRules` / `GameParams`. The contract binds the room to
  `launchEpochOf(deadlineBlock)` and, if nobody has yet, draws that epoch's
  threat inside Inco.
- **Join / leave** (`joinLobby` / `leaveLobby`). Join pays `entry + seat fee`.
  Leave is legal only while applications are open. After the deadline the seat
  is committed.
- **Activate**. Not a player button. The first probe or defense of the round
  moves fees out of refundable and turns the entry residual into the reward
  pool. A room nobody acted in is settled at reveal.
- **Endings.**
  - **COMPLETED** — the attack flew and the room played. Winners claim
    `rewardPerWinner`. On a miss the unwon pool goes to Global Defense; the
    creator gets their accrued fee (not the bounty back).
  - **UNPLAYED / CANCELLED** — too few players or nobody moved. Everyone,
    including the creator, is refunded.

Creator settlement is `Settlement.creatorDue`. The figure stays readable after
`settleCreator`; `creatorSettled` is only whether the wei has been paid.

Live Sepolia ranges (see `deployments/84532.json`): 2–9999 players, entry
0.0005–0.1 ETH, min pool 0.001 ETH, creator fee ≤15%, probe 0.0002 ETH, seat
fee 0.0005 ETH, epoch 120 blocks (~4 min at 2s).

---

## Epoch clock

The protocol does not use wall-clock timers for anything authoritative.
Everything that closes, launches, or lands is a **block number**.

- `genesisBlock` pins the grid (Sepolia: **45384541**). Redeploying the proxy
  does not restart the count.
- `epochBlocks` is 120 on Sepolia.
- **One threat per epoch**, shared by every operation scheduled into it.
  Flight is one epoch: launch at the epoch start, impact at the next.
- Player lobbies use `launchEpochOf`: naive answer is `epochOf(deadline) + 1`;
  if that launch would leave less than 90% of an epoch after the deadline,
  skip one more boundary. Constants live in `Epochs.sol`, not in `GameParams`.
- **Global Defense is exempt.** The protocol's own draw is minted to close on
  the last block of the previous epoch and fly on the next.

---

## Recon

A probe does not choose where to look; it chooses **where it stands** on the
playfield grid. Same cell, same reading.

- `sendProbe` computes the hint inside Inco and stores the handle. It does
  **not** grant the sender.
- `collectProbe` (permissionless) grants after `readableAtBlock`
  (`ReconRules.DELAY_BLOCKS` = 8). A second send from the same wallet before
  that reverts (`ProbeInFlight`).
- Every probe on one attack shares a triangular bias ε
  (`ReconRules.BIAS_MICRO_RAD` = 5°). Extra cells average away their own noise
  and converge on `θ + ε`, never on `θ`. The fused cone never closes past 12°.

These two numbers are protocol constants, not governed `GameParams`. Changing
them is a new deployment.

---

## Global Defense (jackpot)

The Global Defense Pool is every unwon COMPLETED pool. It is players' money in
escrow. **The owner cannot withdraw it.**

Once every `globalDefenseEpochInterval` epochs (1000 on Sepolia) the protocol
opens its own operation: free to enter, no creator fee, the accumulated pool
as the bounty, **up to the protocol `maxPlayers` (9999 on Sepolia)** — not a
smaller jackpot-only room. The cap is frozen at mint from live `GameParams`.
Whoever intercepts that epoch's threat takes it. If nobody
wins, the same miss rule puts the pool back. If nobody joins, an UNPLAYED
ending returns the bounty to the pool because the contract is the creator.

Opening the draw is a side effect of ordinary play inside the join window
(`maybeOpenDraw`). There is no privileged `openGlobalDefense` for the UI.

---

## Inco Lightning

AEGYLAX runs on two chains at once:

- **Base** — lobbies, fees, deadlines, submissions, winner, every payment.
  Ordinary public state in `AegylaxGame`.
- **Inco Lightning** — attack geometry, probe answers, Defense Points.

The confidential half of an attack is two angles, generated *inside* Inco:

- **θ** — bearing from Earth's centre to the launch point.
- **δ** — how far around the globe the impact sits from that bearing,
  constrained so the impact always lands on the visible cap.

The game contract stores **handles**, never plaintext. A Defense Point is
encrypted in the player's client against the engine before it hits a
transaction. After impact, Inco's covalidator quorum attests the plaintext
and the contract scores the round.

`IncoConfidentialEngine` is the production adapter. `MockConfidentialEngine`
implements the same interface for Foundry tests and is not confidential.

---

## Contracts

Foundry project in `contracts/`. Node.js ≥ 20 and [Foundry](https://book.getfoundry.sh).

```bash
cd contracts
npm ci
forge test
```

Live Base Sepolia addresses are in `deployments/84532.json`. Clients talk to
the UUPS proxy; implementation, lens, engine and linked libraries are
verified on the explorer after each deploy.

| | |
| --- | --- |
| `AegylaxGame` | Lifecycle, money, probes, defense, reveal, claims, treasury |
| `AegylaxLens` | Batched views (`delegatecall` into the same storage) |
| `IncoConfidentialEngine` | Attack geometry, probe answers, Defense Points |
| `Geometry` / `Lobbies` / `ProtocolRules` / `Resolution` / `Settlement` | Linked libraries |
| `Epochs` / `ReconRules` | Internal (inlined) consensus arithmetic and recon constants |

The frontend talks to **one address**: the proxy. The lens has no privileged
entry point and cannot write.

---

## Docs

| | |
| --- | --- |
| [docs/contracts.md](docs/contracts.md) | On-chain protocol and Inco |
| [docs/protocol-flow.md](docs/protocol-flow.md) | Money, endings, jackpot |
| [docs/game-mechanics.md](docs/game-mechanics.md) | Playfield, probes, defense |
| [docs/attack-epochs.md](docs/attack-epochs.md) | Epoch grid and scheduling |
| [SECURITY.md](SECURITY.md) | Testnet scope, reporting |
| [LICENSE](LICENSE) | Proprietary — all rights reserved |

---

## License

The source in this repository is published so players can read the rules that
hold their funds. Publication is not a licence to copy, modify, distribute,
or reuse the software. Third-party dependencies remain under their own
licences.

---

## Roadmap

- Third-party audit and bug bounty before mainnet value
- Chunked reveal (`maxPlayers` is 9999; a full room will not fit in one tx)
- Base mainnet with a timelocked / multisig owner
- Dedicated keeper so reveals and Global Defense opens do not depend on a tab

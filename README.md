# AEGYLAX — Planetary Defense (protocol)

Earth is under attack. Players open Defense Operations, buy incomplete
intelligence with Recon Probes, and commit one Defense Point against a
threat **nobody can see until the round is over** — not the players, not
the protocol owner, not a client.

The **smart contract is the game**. [Base](https://base.org) executes and
settles it. **[Inco Lightning](https://www.inco.org/)** holds the secrets
until impact.

This repository is the **public protocol surface**: docs, Solidity,
Foundry tests, live addresses. The game client is proprietary and is not
published here.

> **Testnet only** (Base Sepolia). Not audited for mainnet value.
> Copyright © 2026 AEGYLAX. All rights reserved. See [LICENSE](LICENSE).

---

## What this repo is for

| Path | Why it is public |
| --- | --- |
| `contracts/` | The rules that hold funds. Read, compile, `forge test`. |
| `deployments/` | Live UUPS proxy on Base Sepolia. |
| `docs/` | Lobbies, epochs, probes, Inco, jackpot. |
| `LICENSE` / `SECURITY.md` | Terms and funds-bug reporting. |

No frontend, deploy keys, emulator, or operator runbook.

---

## What stays private

The game contract stores **handles**, never plaintext. Values live in
Inco. The frontend cannot invent a trajectory, and the contract cannot
read one before it lands.

```
mint θ, δ (Inco)  →  probes / Defense (handles)  →  impact
        →  unlock (mined)  →  covalidator attest  →  public forever
```

### Sealed until after impact

| Secret | On Base you see | Inside Inco | Opens |
| --- | --- | --- | --- |
| **Trajectory** (`θ`, `δ`) | two handles at epoch mint | generated *inside* Inco, not sent in | `revealEpochAttack` after `completeAttack` |
| **Defense Point** | `DefenseSubmitted` | encrypted in the browser against the engine | `unlockDefenses` then `resolveLobby` |
| **Speed** of the threat | nothing useful | sealed with the geometry | same as trajectory — public speed would leak launch distance |
| **Per-sector activity** | empty | — | same moment as the reveal |

`θ` is the bearing from Earth's centre to the launch point. `δ` is how
far around the globe the impact sits from that bearing, constrained
inside Inco so the hit always lands on the visible cap.

### Probe hints — private to the sender, even after impact

A probe answer is **not** the trajectory. It is a noisy bearing, computed
on ciphertext: `θ + ε + cellNoise`.

| | |
| --- | --- |
| Who can decrypt it | **Only the wallet that sent the probe** |
| When | `collectProbe`, after **8 blocks** (`ReconRules.DELAY_BLOCKS`) |
| On chain in plaintext | **Never.** The contract stores a handle; the grant is an Inco ACL. |
| Same cell twice | Same reading. The lattice is finite on purpose. |
| Many cells | Converge on **`θ + ε`**, never on `θ`. ε is **5°** (`BIAS_MICRO_RAD`), drawn once per attack. The fused cone never closes past 12°. |

`sendProbe` does not grant. A second send from the same wallet before the
delay reverts (`ProbeInFlight`). Buying probes closes at **launch**, not
impact — you cannot buy a fix after watching the sky.

### After impact — one public record

Reveal is permissionless. Anyone may do it; it publishes a fact about a
finished round, not a reward.

Two transactions, not one: an unlock must be **mined** before Inco's
covalidator quorum will sign the plaintext the second call brings back.

| Tx | Does | Scope |
| --- | --- | --- |
| `unlockRound(lobbyId)` | `completeAttack` + `unlockDefenses` | epoch + this team |
| `revealAndResolve(…)` | `revealEpochAttack` + `resolveLobby` | epoch geometry public; this team scored |

Then `getAttackReveal` is an ordinary read, forever: trajectory, every
Defense Point on the team, per-attempt verdicts. There is no partial
reveal.

If nobody reveals within **`revealGraceBlocks` (5000 on Sepolia,
~2.8 h at 2 s)**, `expireAttack` refunds everyone.

### Always public (even mid-round)

Who created / joined / left, amounts, deadline, **launch and impact block
numbers**, that a probe was **bought** or **sent**, that a Defense was
**submitted**, seat fees, pool, snapshotted params.

The payload is a handle either way — an observer sees *that* a probe or
a Defense was sent, never the hint or the coordinate.

### Technical notes

- Two bounded integers (`θ`, `δ`) keep Inco cheap: generate, add probe
  noise, constrain impact. **No trigonometry over ciphertext.** Trig
  runs once, in the clear, at reveal, on values a covalidator quorum has
  signed.
- Handles are checked against the ones committed at generation — you
  cannot swap in a different trajectory at reveal.
- `IncoConfidentialEngine` is production. `MockConfidentialEngine`
  implements the same interface for Foundry and **is not confidential**.
- The four primitive calls (`completeAttack`, `revealEpochAttack`,
  `unlockDefenses`, `resolveLobby`) stay callable; the two batches are
  the client path. Already-done steps are skipped (losing a race is
  normal).
- Two operations on the same epoch share the epoch half (one threat, one
  geometry reveal for the whole world). Scoring is per team.
- `AttackRevealData.scored` is the difference: do not draw a trail from
  the epoch half until this team is scored, or an unscored zeroed
  outcome looks like a miss.

---

## A round

```
create  →  applications  →  deadline  →  in flight  →  impact  →  reveal / claim
                 └──────── under-filled: cancel / unplayed, full refunds
```

1. **Create.** Prize pool + seat fee. Name, seats, entry, deadline,
   creator fee — all checked against `ProtocolRules` / `GameParams`.
   The room binds to `launchEpochOf(deadlineBlock)`. If nobody has yet,
   that epoch's threat is drawn inside Inco.
2. **Join / leave.** Join pays `entry + seat fee`. Leave only while
   applications are open.
3. **Activate.** Not a button. The first probe or defense moves fees out
   of refundable and turns the entry residual into the reward pool.
4. **Play.** Probe (8-block delay, one in flight per wallet; cone floor 12°),
   then one encrypted Defense Point. Recon closes after that submit.
5. **Score.** Find where. Find when. Intercept it. Snapshot at arrival
   (`submit + climb`): threat still in flight **and inside the 0.14-sector
   radius at that instant**. Covering the path and waiting is a miss
   (TOO EARLY if you arrived before it got there, TOO LATE if after).
   Earliest valid arrival wins; exact ties split. A miss sends the unwon
   pool to **Global Defense**, not back to the creator.

Nobody needs to be online for an attack to launch or land. Keepers are
permissionless.

**Endings**

| Status | What happened | Money |
| --- | --- | --- |
| **COMPLETED** | The attack flew and the room played | Winners claim `rewardPerWinner`. Miss → jackpot. Creator fee accrues (not the bounty). |
| **UNPLAYED / CANCELLED** | Too few players, or nobody moved | Everyone refunded, including the creator. |

Creator settlement is `Settlement.creatorDue`. The figure stays readable
after `settleCreator`; `creatorSettled` is only whether the wei has been
paid.

**Sepolia ranges** (`deployments/84532.json`): 2–9999 players, entry
0.0005–0.1 ETH, min pool 0.001 ETH, creator fee ≤15%, probe 0.0002 ETH,
seat fee 0.0005 ETH, epoch 120 blocks (~4 min at 2 s), intercept radius
0.14 sectors. The seat fee is the **only** thing the owner may withdraw.

---

## Epoch clock

Authoritative time is a **block number**, not a wall clock.

| | |
| --- | --- |
| `genesisBlock` | **45384541** on Sepolia. Redeploying the proxy does not restart the grid. |
| `epochBlocks` | 120 |
| Threats | **One per epoch**, shared by every operation scheduled into it |
| Flight | Launch at epoch start, impact at the next boundary |
| Player rooms | `launchEpochOf`: `epochOf(deadline) + 1`, **skip one more** if that launch would leave less than 90% of an epoch after the deadline (`Epochs.sol`, not `GameParams`) |
| Global Defense | Exempt. Minted to close on the last block of the previous epoch and fly on the next |

---

## Global Defense (jackpot)

Every unwon COMPLETED pool. Players' money in escrow. **The owner cannot
withdraw it.**

Every `globalDefenseEpochInterval` epochs (**1000** on Sepolia) the
protocol opens its own operation: free, no creator fee, the accumulated
pool as bounty, cap = live `maxPlayers` (9999), frozen at mint. Later
misses still grow that bounty until the threat launches.

- Intercept → take the pool.
- Miss → same miss rule, pool comes back.
- Nobody joins → UNPLAYED returns the bounty to the pool (the contract
  is the creator).

Opens as a side effect of ordinary play inside the join window
(`maybeOpenDraw`). There is no privileged `openGlobalDefense` for the UI.

---

## Contracts

Foundry project in `contracts/`. Node.js ≥ 20 and
[Foundry](https://book.getfoundry.sh).

```bash
cd contracts
npm ci
forge test
```

Live addresses: `deployments/84532.json`. Clients talk to **one
address** — the UUPS proxy. The lens has no privileged entry and cannot
write.

| | |
| --- | --- |
| `AegylaxGame` | Lifecycle, money, probes, defense, reveal, claims, treasury |
| `AegylaxLens` | Batched views (`delegatecall` into the same storage) |
| `IncoConfidentialEngine` | Attack geometry, probe answers, Defense Points |
| `Geometry` / `Lobbies` / `ProtocolRules` / `Resolution` / `Settlement` | Linked libraries |
| `Epochs` / `ReconRules` | Internal: consensus arithmetic and recon constants |

---

## Docs

| | |
| --- | --- |
| [docs/INCO_INTEGRATION.md](docs/INCO_INTEGRATION.md) | Why Inco, what is private, Base vs Inco, how the round uses ciphertext |
| [docs/contracts.md](docs/contracts.md) | On-chain protocol and Inco |
| [docs/protocol-flow.md](docs/protocol-flow.md) | Money, endings, jackpot |
| [docs/game-mechanics.md](docs/game-mechanics.md) | Playfield, probes, defense |
| [docs/attack-epochs.md](docs/attack-epochs.md) | Epoch grid and scheduling |
| [SECURITY.md](SECURITY.md) | Testnet scope, reporting |
| [LICENSE](LICENSE) | Proprietary — all rights reserved |

Publication is so players can read the rules that hold their funds. It is
not a licence to copy, modify, distribute, or reuse the software.

---

## Roadmap

The client is not in this repo. The items below are still the public
plan: what the protocol will do, and what players should expect next.

### Economy and mechanics

- Tune testnet numbers for real play: seat fee, probe price, jackpot
  cadence, interception radius, recon cone.
- Richer recon (not only a bearing) and more than one Defense Point /
  loadouts.
- Deadline for unclaimed rewards; USDC (or another ERC-20) as the prize
  coin — the contract still settles in native ETH.

### Audit

- Third-party security audit. The Foundry suite is not an audit.
- Bug bounty before any mainnet value.
- Chunked reveal: `maxPlayers` is 9999 on chain; a full room will not
  fit in one Base transaction. Until then, practical rooms stay far
  below that cap.
- Harden Inco under load (Sepolia e2e exists; production traffic does
  not). An unfunded engine cannot start an attack.

### Base mainnet

- New deploy on Base (`CHAIN_ID=8453`), new keys.
- Timelock + multisig owner; documented upgrade procedure.
- Monitoring: engine balance, unrevealed attacks, treasury vs escrow.

### Indexer + lobby dashboard

- Index every lobby so search and history do not depend on a live RPC
  window.
- Public dashboard: all lobbies, status, seats, pool, outcome — not only
  the one the player has open.

### Client (proprietary)

- Mobile-first operation screen; installable PWA; push for “attack
  lands” and “you can claim”.
- Telegram Mini App: same contract on Base, smaller chrome (no TON).

### Also

- A dedicated keeper so reveals, cancels, and Global Defense opens do
  not depend on someone having the tab open.
- Re-read probe answers from Inco — clearing the browser currently
  destroys paid intelligence.
- Sybil resistance on free probes is still per address. A farm cannot
  cancel the per-attack bias ε, and it cannot dump an allowance in one
  block: each probe is in flight for 8 blocks before the hint is
  readable.

# Inco integration

AEGYLAX is a planetary-defense game on **Base**. The round is a bet on a
trajectory nobody may see until impact — not the players, not an observer,
not the contract owner. **Inco Lightning** is where that secret is born,
where reconnaissance is computed, and where a Defense Point stays sealed.

## Why Inco?

If the attack coordinates existed in the client, in a backend, or as
plaintext in the game contract, the round would be a race to read them.
The gameplay *is* incomplete information: buy a noisy direction, commit
one shot, learn the truth only after the strike lands.

Inco is the confidential computer beside Base. Coordinates are generated
there as ciphertext. Probe hints are arithmetic on that ciphertext. The
player's final point is encrypted in the browser against Inco before it
is a transaction argument. Base never holds the numbers the round is
about — only handles, money, and time.

## What is private?

Until after impact:

| Secret | Who can read it mid-round |
| --- | --- |
| Attack geometry (`θ` launch bearing, `δ` impact offset) | Nobody. Drawn inside Inco; the contract stores two handles. |
| Per-attack bias `ε` | Nobody. Shared by every probe on that attack so extra wallets cannot average to the true ray. |
| Probe hint | Only the sender, after `collectProbe` grants decrypt. |
| Defense Point | Only its owner. The chain sees that a point was submitted, not where. |

Always public: who joined, amounts, deadlines, launch and impact
**blocks**, that a probe was bought or sent, that a Defense was submitted.
An observer sees *that* a secret moved, never the payload.

## What happens on Base?

`AegylaxGame` executes and settles. Ordinary public state:

- lobbies, seats, fees, prize pool, Global Defense;
- `sendProbe` — asks the engine for a hint handle, does **not** grant it;
- `collectProbe` — after 8 blocks, grants decrypt to the sender;
- `submitDefense` — stores the encrypted point handle and `submitBlock`;
- scoring and `claimReward`.

Reveal is two transactions because Inco stands between them:

1. `unlockRound` — the flight is over; handles may be opened.
2. `revealAndResolve` — attested plaintexts come back; this team is scored.

The first must be **mined** before Inco's covalidator quorum will sign.
One transaction cannot contain that round trip. Already-done steps are
skipped; two operations on the same epoch share one threat.

## What happens in Inco?

`IncoConfidentialEngine` is a stateless adapter. Only the game proxy may
ask it for handles. No trigonometry over ciphertext — two bounded
integers, integer ops:

- **Generate.** `e.randBounded` draws `θ` and `δ` (impact constrained to
  the visible cap) and the shared `ε`. No block hash, no oracle, no
  protocol key.
- **Probe.** `hint = θ + ε + cellNoise + cellNoise` via `e.add`. Noise is
  one draw per sensor cell, so a second probe from the same place is the
  same reading.
- **Grant.** `e.allow` opens exactly one handle to exactly the sender —
  and only after the delay.
- **Defense.** The coordinate is encrypted in the browser against the
  engine; Base stores the handle.
- **Reveal.** After impact, `e.reveal` plus covalidator signatures.
  `verifyDecryption` checks the plaintext against the handle committed
  at generation. You cannot swap in a different trajectory.

`MockConfidentialEngine` implements the same interface for Foundry and
**is not confidential**.

A covalidator `IsReady` of true is the process, not the indexer. Decrypt
errors that say `failed to check acl` without a delay are a grant that
has not landed yet. `out of sync: N seconds behind` is their indexer
late on Base; waiting it out in the client does not catch it up. The
SPA header compares **Privacy executor block** to the network head from
that number.

## How does the game use the private state?

Players never aim at a known path. A probe decrypts a **direction with
a cone**, not a coordinate; fusion narrows the picture toward `θ + ε`
and never past a 12° floor. The Defense Point is a sealed commit: one
per wallet, judged only after reveal.

Scoring runs in the clear on attested values. A hit is a snapshot at
**where and when**:

`arrival = submit + climb`, still before impact, and the threat at that
block inside 0.14 sectors of the point. Covering the path early and
waiting is a miss. Earliest valid arrival wins.

Private state is the round. Public state is who paid, who acted, and —
once Inco has attested — who hit.

# Guided tour — screenshots

Sixteen frames from the in-app guided tour (`/guide`), captured in order.

The tour is not a slideshow about the product: it runs the real screens —
the same `HomePage`, Create dialog, directory and operation components the
app routes to — against a sandbox chain, with one overlay card explaining
what is on screen. So these are screenshots of the actual interface, not
mock-ups of it. No wallet, no transactions, no live network.

Captured at 1600×1000 from `/guide` with the emulator client.

| | Step | What it shows |
| --- | --- | --- |
| [01](01-the-threat.png) | The threat | Home. An attack is in motion; its trajectory is sealed until impact |
| [02](02-the-global-defense-pool.png) | The Global Defense Pool | The protocol-wide jackpot and its cadence |
| [03](03-choose-your-operation.png) | Choose your operation | The fork: open a room, or join one |
| [04](04-set-the-parameters.png) | Set the parameters | Create dialog — entry price, player range, creator fee |
| [05](05-fund-the-operation.png) | Fund the operation | The starting prize pool and what the creator pays |
| [06](06-operation-active.png) | Operation active | The operation screen once a room is open |
| [07](07-how-the-pool-is-built.png) | How the pool is built | Entries, creator commission, protocol fee |
| [08](08-settlement.png) | Settlement | Who is paid, and on which ending |
| [09](09-begin-reconnaissance.png) | Begin reconnaissance | Buying a probe against the sealed trajectory |
| [10](10-threat-in-flight.png) | Threat in flight | The countdown to impact, applications closed |
| [11](11-what-a-probe-reveals.png) | What a probe reveals | What a probe answers, and what it never does |
| [12](12-first-reading-a-bearing.png) | First reading: a bearing | The cone the first probe returns |
| [13](13-every-reading-after-occupancy.png) | Every reading after: occupancy | Occupancy marks building a heat map along the bearing |
| [14](14-commit-the-defense.png) | Commit the defense | Placing the Defense Point before impact |
| [15](15-target-intercepted.png) | Target intercepted | Resolution against the revealed trajectory |
| [16](16-claim-the-reward.png) | Claim the reward | The payout |

The confidential layer is the point of steps 01 and 11-13: the trajectory is
sealed for the whole round, probes answer questions *about* it without
opening it, and the answer is only revealed at resolution. See
[../fhenix-integration.md](../fhenix-integration.md) for how that is done on
chain, and [../game-mechanics.md](../game-mechanics.md) for the playfield.

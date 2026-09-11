# Internals

Architecture, configuration, the deploy pipeline, scripts, and tests. The
product pitch and “how do I run / ship this” live in the
[README](../README.md).

---

## Architecture

```
components / pages
        │
      hooks ────────────────┐
        │                   │
  game/ (pure domain)   auth/ (AuthSession)
        │                   │
  blockchain/ (BlockchainClient)
        │
  ┌─────┴─────┐
Contract    Emulator
  client     client
```

Nothing above `blockchain/` knows which client is active. Nothing above `auth/`
knows which sign-in provider is active.

| Seam | Interface | Implementations | Selected by |
| --- | --- | --- | --- |
| Chain | `BlockchainClient` | contract client, emulator | `VITE_BLOCKCHAIN_MODE` |
| Auth / wallets | `AuthSession` | Privy, local identity, `devkey` (dev only) | `VITE_AUTH_PROVIDER` + app id |
| Confidentiality | `ConfidentialGateway` / `IConfidentialEngine` | Fhenix CoFHE (deployed), Inco Lightning (config-selectable), mock | manifest `confidentialEngine.kind` |

Each provider is one file on each side of that seam —
`frontend/src/blockchain/contract/confidential/providers/` and
`contracts/src/confidential/` — plus a row in `tools/chain/confidential.mjs`,
which is what makes `CONFIDENTIAL_ENGINE` the whole of the choice. Both SDKs
(`cofhejs`, `@inco/js`) are dynamic imports, so a build pays only for the
provider its manifest names, and an emulator build for neither.

### On-chain layout

The frontend talks to **one address**: the UUPS proxy.

- `AegylaxGame` — lifecycle, money, probes, defense, reveal, claims, treasury,
  Global Defense.
- `AegylaxLens` — batched views (`delegatecall` into the same storage).
- `AegylaxStorage` — ERC-7201 namespace.
- `FhenixConfidentialEngine` / `IncoConfidentialEngine` /
  `MockConfidentialEngine` — one is deployed, chosen by `CONFIDENTIAL_ENGINE`.
- Linked libraries: `Geometry`, `Lobbies`, `ProtocolRules`, `Resolution`,
  `Settlement`, `Trig`.
- Internal (inlined) libraries: `Epochs` (`launchEpochOf`, 90% remaining-epoch
  cushion), `ReconRules` (bias ε, probe delay).

More: [architecture.md](architecture.md), [contracts.md](contracts.md),
[protocol-flow.md](protocol-flow.md), [attack-epochs.md](attack-epochs.md),
[game-mechanics.md](game-mechanics.md), [emulator.md](emulator.md).

---

## Round, privacy, interception

```
CREATE ──▶ OPEN ──▶ ACTIVE ──▶ IN FLIGHT ──▶ RESOLVED ──▶ CLAIMED
```

The attack is scheduled at creation from the application **deadline block**.
Launch and impact are facts about the epoch grid; they happen whether or not
anybody has the page open.

An observer must not be able to tell a Recon Probe from a Defense Submit: same
call shape, same ciphertext size, one event that says an action happened.
Per-sector activity is empty until reveal. `getAttackReveal` is `null` until
someone calls `revealAttack`. Still public: sender, timing, and probe *purchases*
(a priced call). A probe hint is granted on send, in the same transaction, and
`DELAY_BLOCKS` gates the two calls that can *spend* a reading instead — a
second `sendProbe` and `submitDefense` — so dumping recon and locking a Defense
Point in the next block is still not a legal line.

A Defense Point intercepts only as a **snapshot at submit**:
`arrival = submit`, still in flight, and
`distance(point, trajectory[submit])` inside the radius. Covering the
chord at some other time is a miss — TOO EARLY if you sent it first and
waited, TOO LATE if the threat already passed. The earliest hit — the
highest, since arrival is submit — takes the pool; hits sharing that block
split it.
The emulator uses the same test (`resolveDefense` / `Geometry.evaluateDefense`).
Radius is protocol-owned (0.14 sectors on Sepolia). Every probe on one
attack shares a bias ε (5°); fused readings converge on `θ + ε`, never on `θ`.
The fused cone never closes past 12°.

Keepers are permissionless, not a server:

- applications close as a side effect of the first in-round action;
- under-filled operations can be cancelled by anyone with a stake;
- reveal is whoever is watching (`useProtocolKeeper`), with `expireAttack` as
  the grace-window backstop;
- a Global Defense lobby opens as a side effect of ordinary play inside the
  24h join window. The UI must not call `openGlobalDefense`.

---

## Configuration

Two files, two audiences:

| File | Audience | Holds |
| --- | --- | --- |
| [`.env.example`](../.env.example) | frontend | network, Privy, display |
| [`contracts/.env.example`](../contracts/.env.example) | deployment | RPC, deployer key, `GAME_*` params |

**Authority:** `contracts/.env` → `initialize()` / `setParams()` → contract
storage → snapshot on each lobby. `chain:sync` copies params into
`frontend/src/contracts/generated/`. Frontend `.env` protocol limits apply to the
emulator (and to a chain with no manifest). Change live limits with
`npm run chain:params`, not by editing the SPA `.env`.

`VITE_RPC_URL` is a comma-separated list. The app reads every block; one public
endpoint will 403. A `wss://` URL gets a real subscription.

Secrets: `.env` and `contracts/.env` are gitignored. Anything `VITE_*` ships to
the browser. `VITE_PRIVY_APP_ID` is a public app id. Never put a private key
behind `VITE_`.

`VITE_GENESIS_BLOCK` overrides the epoch-grid origin in emulator / when a
manifest has no `genesisBlock`. In contract mode the countdown uses
`deployments/<chainId>.json` → `genesisBlock` (not `deploymentBlock`).

The live value is whatever that manifest says, and this file deliberately
does not repeat it: it moved on the last redeploy and the copy written here
went stale without anything failing.

### Protocol version

The status popover's **Protocol version** is the build, not
`AegylaxGame.version()`. `package.json` is the line (`0.1.0` today — major
`0` means testnet). The patch is `git rev-list --count HEAD`, injected at
`vite` / Vercel build, so every push that ships is a new number (`0.1.40`,
`0.1.41`, …). Bump the *minor* in `package.json` (to `0.2.0`) when the
testnet line itself changes character. Bump the *major* to `1.0.0` for
mainnet; the same stamp then reads `1.0.N`. Pin with `VITE_PROTOCOL_VERSION`
only when a build must not consult git.

### Protocol status

The header shield is this tab's view of two lanes, not a global vote.
Green is both answering; yellow is a delay this tab already saw.

**RPC.** Blocks from the subscription, plus a slow `eth_blockNumber`
heartbeat. A public-RPC 403 while a fallback still dribbles blocks used
to stay green; a reported failure or a stall after a block had arrived
turns the **RPC connection** row yellow.

**Privacy.** A covalidator `IsReady` ping on every page in contract mode
(not only during a probe). Gameplay decrypt/reveal reports into the same
lane. `IsReady` is the process, not the indexer: it can read ready while
ACL is minutes behind. `out of sync: N seconds behind` on an ACL check
is that lag. The popover then shows **Privacy executor block** as the
host-chain height the executor has ingested (network head minus that
lag) against **Current block**, and yellows both the row and the shield.
A few seconds of ACL settling is not a status; tens of seconds is.
`IsReady: true` does not clear a lag this tab already measured — a
successful confidential read does. On Fhenix the same lane is fed by the ZK
verifier's `signerAddress`, the cheapest endpoint on the host the encrypt path
depends on. The emulator pings nothing.

---

## Deploy your own protocol

```bash
npm run chain:install
cp contracts/.env.example contracts/.env    # RPC, deployer key, GAME_* params
npm run chain:deploy                        # test → deploy → manifest → sync UI
```

```
contracts/.env  ──▶  chain:deploy  ──▶  deployments/<chainId>.json
                          │                       │
                     forge build                  │  chain:sync
                     forge test                   ▼
                     validate upgrade    frontend/src/contracts/generated/{abi,deployments}.json
                     deploy libraries              │
                     deploy engine (+fund)         ▼
                     deploy impl + proxy      frontend build (prebuild runs chain:sync)
                     initialize()
                     verify source on the explorer
```

| Command | |
| --- | --- |
| `npm run chain:deploy` | Full pipeline. Refuses a public network + mock engine. |
| `npm run chain:upgrade` | New implementation, same proxy; storage layout checked. Redeploys linked libraries, lens (`UPGRADE_LENS`, default on), and a fresh confidential engine (`UPGRADE_ENGINE`, default on) so the probe grant / ε match the game. |
| `npm run chain:params` | Push `GAME_*` from `contracts/.env` (`--dry-run` to preview). |
| `npm run chain:verify` | Publish source to the explorer. Also runs at the end of deploy and upgrade when `ETHERSCAN_API_KEY` is set. |
| `npm run chain:e2e` | One live round, three wallets, against whichever confidential network the manifest names. |
| `npm run chain:reveal` | Finish a landed attack nobody revealed. |
| `npm run chain:audit` | Contract ETH vs ledgered pots. |
| `npm run chain:sync` | Regenerate frontend config from manifests. |

`setGlobalDefenseInterval` is its own owner call; the cadence is not a
`GameParams` field. The join window is hardcoded as a calendar day at 2s
blocks.

---

## Scripts

| Command | |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | Sync contract config → typecheck → Vite build |
| `npm run preview` | Serve `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` / `test:watch` | Vitest |
| `npm run chain:install` | Foundry deps |
| `npm run chain:build` / `chain:test` | `forge build` / `forge test` |

---

## Tests

```bash
npm run test          # Vitest: unit, component, integration
npm run chain:test    # Foundry: lifecycle, security, geometry fuzz, payouts, Global Defense
npm run chain:e2e     # live Sepolia, ~10 min, testnet ETH
```

UI automation against a real wallet uses the **dev-only** `devkey` adapter
(`import.meta.env.DEV` — compiled out of production):

```bash
VITE_AUTH_PROVIDER=devkey npm run dev
# http://localhost:5173/?devkey=0x<testnet private key>
```

Testnet keys only. Never `VITE_DEV_PRIVATE_KEY` on Vercel.

---

## Repository and CI

Safe to commit: `deployments/<chainId>.json` (addresses + params),
`frontend/src/contracts/generated/`. Never commit: `.env`, `contracts/.env`, `dist/`,
`contracts/out/`, `contracts/broadcast/`, `.vercel/`, `node_modules/`,
coverage, `*.tsbuildinfo`. See `.gitignore`.

`vercel.json` rewrites every path to `index.html` so `/lobby/:id` survives a
refresh. GitHub Actions (`.github/workflows/ci.yml`) runs `npm test` and
`npm run typecheck` with no secrets.

Verification does **not** need a new deploy. `chain:deploy` and `chain:upgrade`
call `chain:verify` when the API key is set; the Verify contracts workflow
retries after the manifest is pushed. Set `SKIP_VERIFY=true` to skip locally.

Mainnet is a **new** `chain:deploy` on `CHAIN_ID=8453`, an audit, a
timelocked/multisig owner, and a separate Vercel project. Do not reuse Sepolia
keys. Do not point this testnet frontend at mainnet until those exist.

Live Sepolia params (version 4): players 2–25, entry 0.0005–0.1 ETH, min
pool 0.001 ETH, creator fee ≤15%, probe 0.0002 ETH, creation fee 0.0005 ETH,
epoch 120 blocks, jackpot every 1000 epochs, intercept **0.14** sectors,
genesis as recorded in `deployments/84532.json`. The frontend countdown uses
that genesis from the deployment manifest, not the proxy `deploymentBlock` —
which on a fresh instance are the same block, and on an inherited grid are
not.

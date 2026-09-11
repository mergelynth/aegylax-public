# AEGYLAX — Planetary Defense

Earth is under attack. Players open Defense Operations, buy incomplete
intelligence with Recon Probes, and commit one Defense Point against a threat
whose trajectory nobody can see until the round is over — not the players, not
the protocol owner, not the frontend.

The **smart contract is the game**. [Base](https://base.org) executes and
settles it. **[Fhenix CoFHE](https://www.fhenix.io/)** holds the secrets until
impact. The site only reads what the chain already decided.

Which confidential network that is, is configuration. The game contract talks
to `IConfidentialEngine` and never to a provider. **Fhenix CoFHE** is what
every deployment runs on and the only one with live numbers behind it; a
second adapter — [Inco Lightning](https://www.inco.org/) — sits behind the
same interface and is selected by config rather than by code. Swapping is a
deploy, not a rewrite, which is the only way anyone can tell
`IConfidentialEngine` is a boundary at all.

This is a **testnet product** (Base Sepolia). It is not audited for mainnet
value.

---

## Stack

No database. The live site is a static app talking to a contract; a small
service beside it does the three things a browser cannot — fund a demo
wallet, finish rounds nobody has a tab open for, and fold the event log into
each wallet's own record ([docs/backend.md](docs/backend.md)). It decides no
outcome: every rule is the contract's.

| | | |
| --- | --- | --- |
| UI | React 19, TypeScript, Vite | Static SPA |
| Chain | [viem](https://viem.sh) on Base | Reads and writes the game contract |
| Wallets | [Privy](https://www.privy.io) | Email / social login and managed wallets. This app never holds keys. |
| Contracts | Solidity, Foundry, OpenZeppelin UUPS | Money, deadlines, scoring, claims |
| Secrets | **Fhenix CoFHE** | Attack geometry, probe answers, Defense Points |

The confidential layer sits beside Base. The threat is generated *inside* it.
A probe answer decrypts only for the wallet that sent it. A Defense Point is
encrypted in the browser before it hits a transaction. After impact the
network releases the plaintext, the contract checks it against the handle it
committed at generation, and scores the round.

Which provider does that is `CONFIDENTIAL_ENGINE` at deploy time, recorded in
the deployment manifest and read back by the frontend. Nothing in the game,
the hooks or the UI knows the answer.

How the layers fit together, the epoch clock, and the money rules:
[docs/internals.md](docs/internals.md).

---

## Layout

| Directory | What |
| --- | --- |
| `frontend/` | React SPA (Vite). Source lives in `frontend/src/`. |
| `api/` | NestJS: faucet, keeper (finish rounds), indexer |
| `contracts/` | Solidity + Foundry tests |
| `tools/` | Deploy, upgrade and end-to-end scripts |
| `docs/` | Protocol and operator docs |
| `deployments/` | Live addresses per chain id |

One `package.json` at the repo root. `npm run dev` is the SPA; `npm run api:dev` is the backend. `contracts/` has its own Foundry tree.

---

## How a round works

1. A creator funds a prize pool and opens an operation (entry, player limits,
   deadline, creator fee — within protocol limits). Creating pays a **0.0005 ETH**
   protocol fee, kept even if the room never fills — the only thing the owner
   may withdraw. Joining pays the entry plus the author's commission (the %
   they set). If the room never starts, joiners get both back automatically.
2. The attack is scheduled at creation from the application **deadline block**.
   It flies in the epoch after applications close, **unless** that boundary
   would leave less than 90% of an epoch to play in — then the operation waits
   one more. Countdowns use the contract's `genesisBlock` (in the deployment
   manifest), not the proxy's deploy block.
3. Defenders probe (3 free, then 0.0002 ETH). One transaction: the hint —
   two noisy angles (launch bearing and impact offset) packed into one
   integer, which the client turns into a search corridor — is granted to
   the sender by `sendProbe` itself. The **8 blocks** are still charged,
   on the next probe and on that wallet's Send Defense, so reconnaissance
   costs time and not just an allowance. Every probe on one attack shares a
   bias ε (5°), so fused readings converge on `θ + ε`, never on `θ`.
   The fused cone never closes past **12°**. The opening sweep is **52°**.
   Recon for a wallet ends when that
   wallet submits Defense. Then each defender commits one encrypted Defense
   Point — one per round, locked after submit. The UI shows the snapshot
   block (`submit`), never the true trajectory.
4. After impact, anyone may reveal. A hit is the threat inside the **0.14**
   sector radius **at submit**, while still in flight.
   Earliest valid submit **is** the ranking: the highest kill takes the pool,
   and a threat destroyed above never reaches the circles waiting below —
   right point, right moment, no kill, no pay. Hits sharing the winning block
   share the pool, however many there are. A static wall is twenty
   independent bets, not coverage. If the threat got through, the unwon pool goes to the **Global Defense** jackpot — not
   back to the creator.
5. Every 1000 epochs the protocol opens a free jackpot round with that pool.

---

## Run it locally

Node.js ≥ 20. Foundry is needed only if you deploy or test contracts.

```bash
git clone <repository-url> && cd aegylax
npm install
cp .env.example .env
```

**Against the live Sepolia contract** (what you want to demo):

```
VITE_BLOCKCHAIN_MODE=contract
VITE_CHAIN_ID=84532
VITE_PRIVY_APP_ID=<public id from the Privy dashboard>
VITE_RPC_URL=<two or more Base Sepolia HTTPS RPCs, comma-separated>
```

```bash
npm run dev
```

The contract address is not pasted anywhere. It comes from
`deployments/84532.json`.

**Against the local emulator** (development only — trusts the tab, not for a
public site):

Leave `VITE_BLOCKCHAIN_MODE=emulator` as in `.env.example`, then `npm run dev`.

```bash
npm run test          # frontend
npm run chain:test    # contracts (Foundry)
npm run api:build     # NestJS backend
npm run build         # production SPA bundle
```

Deploying your own protocol, changing on-chain limits, and the full script list
are in [docs/internals.md](docs/internals.md).

---

## Deploy the demo

Three hosts, in this order: the contract on Base Sepolia, the backend on
Render, the frontend on Vercel.

| | | |
| --- | --- | --- |
| Contract | Base Sepolia | `npm run chain:deploy` · only for a new protocol instance |
| Backend | Render | `render.yaml` · faucet, keeper, indexer · secrets in the dashboard |
| Frontend | Vercel | `npm run build` → `dist` · every value is a `VITE_*` env var |

The contract address is never typed into a dashboard: it travels in
`deployments/<chainId>.json` and `frontend/src/contracts/generated/`, both
committed, so a redeploy reaches the site through a git push.

---

## Ship the frontend (GitHub + Vercel)

This repository is the full product (client + contracts + docs). Commit
everything that is not a secret or a build artifact. `.gitignore` already
drops `.env`, `contracts/.env`, `node_modules`, `dist`, Foundry
`out`/`cache`/`broadcast`, `.vercel`, coverage, and logs.

**Do commit:** `frontend/`, `deployments/84532.json`, `frontend/src/contracts/generated/`,
`.env.example`, `contracts/.env.example`. Vercel builds from that tree.

The frontend is a static Vite app. The contract is already on Base Sepolia.
**Do not put deployer keys on Vercel.**

1. Confirm `.env` and `contracts/.env` are **not** in `git status`. They are
   gitignored and hold wallet keys.
2. Push `main` to the `origin` remote.
3. Vercel → Import repo. Framework **Vite**, build `npm run build`, output
   `dist`, Node **20**.
4. Set env on Production and Preview:

   | | |
   | --- | --- |
   | `VITE_BLOCKCHAIN_MODE` | `contract` |
   | `VITE_CHAIN_ID` | `84532` |
   | `VITE_PRIVY_APP_ID` | Privy public app id |
   | `VITE_RPC_URL` | two or more public Base Sepolia HTTPS URLs |

   Never set: `DEPLOYER_PRIVATE_KEY`, `PRIVATE_KEY`, `TEST_*_PK`,
   `ETHERSCAN_API_KEY`, `VITE_DEV_PRIVATE_KEY`.

5. In the Privy dashboard, add the Vercel domain to allowed origins.
6. After deploy, open Protocol Status on the live site: Base Sepolia, address
   matching `deployments/84532.json`, not “Local emulator”.

A build without `VITE_BLOCKCHAIN_MODE=contract` ships the emulator. Redeploying
the site is a git push. It does not move the contract.

What is safe to commit, SPA rewrites, and mainnet caveats:
[docs/internals.md](docs/internals.md#repository-and-ci).

---

## Roadmap

### Economy, mechanics, UI

- Tune testnet numbers for real play: creation fee, probe price, jackpot cadence,
  interception radius, recon cone.
- More than one Defense Point / loadouts. (Richer recon has landed: the hint
  carries the impact offset as well as the launch bearing.)
- Jackpot and operation screens that explain *why* the pool moved, not only
  that it did.
- Deadline for unclaimed rewards; USDC (or another ERC-20) as the prize coin —
  the ticker is already ENV, the contract is still native ETH.
- Reveal cinematics, i18n, accessibility (focus, reduced motion, map labels).

### Audit

- Third-party security audit. The Foundry suite is not an audit.
- Bug bounty before any mainnet value.
- Batch scoring: live `maxPlayers` is still 25 on Sepolia. The protocol
  now unmasks every Defense Point from one key (`K`) rather than
  `allowGlobal` per handle; `proveDefenses` scores in batches of 32.
  Raising the live cap is a `setParams` + measurement, not a new design.
- Harden the confidential layer under load (Sepolia e2e exists; production
  traffic does not).
- Auto top-up for providers that bill a balance — an unfunded Inco engine
  cannot start an attack. CoFHE bills gas on the calling transaction and needs
  no top-up.

### Base mainnet

- New deploy on Base (`CHAIN_ID=8453`), new keys, never reuse Sepolia wallets.
- Timelock + multisig owner; documented upgrade procedure.
- Monitoring: unrevealed attacks, treasury vs escrow, and engine balance on a
  provider that bills one.
- Point a separate Vercel project at the mainnet manifest. Do not flip this
  testnet frontend onto mainnet.

### Indexer + lobby dashboard

- Index every lobby off `getLogs` so search and history do not depend on a
  live RPC window.
- Public dashboard: all lobbies, status, seats, pool, outcome — not only
  the one the player has open.

### Phones + PWA

- Mobile-first operation screen (map + command centre are desktop-first today).
- Installable PWA, offline shell, push for “attack lands” and “you can claim”.

### Telegram Mini App

- Telegram login through the existing auth adapter.
- Managed wallet on Base (no TON). Same contract, smaller chrome.

### Also worth doing

- A dedicated keeper (or Gelato / Chainlink Automation) so reveals, cancels,
  and Global Defense opens do not depend on someone having the tab open.
- Re-read probe answers from the confidential layer instead of `localStorage`
  — clearing the browser currently destroys paid intelligence.
- Practical `maxPlayers` above 25 until reveal is chunked or the gas of
  a full-room `revealAndResolve` is measured.
- Sybil resistance on free probes is still per address. What a farm cannot
  cancel is the per-attack bias ε, and it cannot dump an allowance in one
  block: each probe is in flight for 8 blocks before the hint is readable.
- Observed block time for countdowns instead of a configured 2s.

---

## Docs

| | |
| --- | --- |
| [docs/internals.md](docs/internals.md) | Architecture, config, pipeline, scripts, tests |
| [docs/fhenix-integration.md](docs/fhenix-integration.md) | Fhenix CoFHE: what is private, Base vs CoFHE, switching provider |
| [docs/inco-integration.md](docs/inco-integration.md) | The same, for the Inco Lightning provider — the alternative layer, selectable by config |
| [docs/backend.md](docs/backend.md) | The faucet, the keeper and the player record: what runs off-chain, and why |
| [docs/contracts.md](docs/contracts.md) | On-chain protocol and the confidential engine |
| [docs/protocol-flow.md](docs/protocol-flow.md) | Money, endings, jackpot |
| [docs/game-mechanics.md](docs/game-mechanics.md) | Playfield, probes, defense |
| [docs/screenshots/](docs/screenshots/) | Sixteen frames from the guided tour |
| [docs/attack-epochs.md](docs/attack-epochs.md) | The epoch grid and `launchEpochOf` |
| [docs/architecture.md](docs/architecture.md) | Layer map: components, hooks, domain, blockchain seam |
| [docs/emulator.md](docs/emulator.md) | The in-tab emulator client and its trust model |
| [SECURITY.md](SECURITY.md) | Testnet scope, keys, reporting |
| [LICENSE](LICENSE) | Proprietary — all rights reserved |

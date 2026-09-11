# Architecture

AEGYLAX is a static SPA (`frontend/`) plus a small NestJS service (`api/`)
beside the contract (`contracts/`). The API does not decide outcomes: faucet,
keeper, and indexer only do what a browser cannot.

## Layers

```
components/ , pages/          UI. Renders state, dispatches actions.
        │
        ▼
hooks/ , stores/               React glue. Tx lifecycle, polling/events,
        │                      UI-only selection state (never authoritative).
        ▼
game/                          Pure game-domain functions + gameService.ts,
        │                      the only bridge between game/ and blockchain/.
        ▼
blockchain/                    BlockchainClient interface. UI and game/
        │                      never import Emulator*/Contract* directly.
        ▼
EmulatorBlockchainClient   or   ContractBlockchainClient
(in-memory chain + game        (viem + the UUPS proxy in
 contract state)                deployments/<chainId>.json)
```

Authentication sits beside that stack rather than inside it: `auth/`
answers "who is playing, and what can sign for them", and both the UI (via
`useWallet`) and the contract client (via the signer bridge) read the
answer.

`theme/` sits beside it the same way, and answers "what does this
deployment's confidential provider look like". The answer reaches components
as CSS custom properties rather than as props, so no component takes a
theme, and none names a provider.

### `auth/`

One interface, `AuthSession`, and one adapter per provider:

```
useAuth()  ──►  AuthSession { status, user, wallet, login, logout }
                     ▲
     ┌───────────────┼───────────────┐
auth/adapters/  auth/adapters/   auth/adapters/
    privy           local            devkey
(hosted wallets; (emulator        (dev server only: signs with a
 the only file    identity: one    private key, so an automated
 importing the    random address   browser can play contract mode)
 SDK)             per browser,
                  signs nothing)
```

The third one exists because the first two cannot be driven by a test: the
hosted provider needs a human at an email, and the local identity cannot
sign. `devkey` mounts only under `import.meta.env.DEV` and only when
`VITE_AUTH_PROVIDER=devkey`, takes its key from `VITE_DEV_PRIVATE_KEY` or
`?devkey=` on the URL (so one dev server can be two different defenders at
once), and stores nothing. See [internals.md](internals.md#tests).

- **`AuthProvider`** picks the adapter from `appConfig.auth` and mounts it.
  It is the only file that knows which providers exist.
- **`AuthSession.wallet`** is an address, a chain, a `kind`
  (`managed` | `external` | `simulated`) and — for anything that can really
  sign — a function returning an EIP-1193 provider. That is the whole
  contract; no component, hook or client sees a vendor type.
- **`WalletSignerBridge`** turns that provider into a viem wallet client and
  attaches it to the `BlockchainClient` at runtime, after putting the wallet
  on the configured chain. Reads never need it, so the app is usable —
  operations, attacks, reveals — before anybody signs in.
- **`config/auth.ts`** describes the provider in vendor-neutral terms
  (login methods, whether wallets are managed for the player, modal
  appearance), all from ENV. `auth/adapters/privy/privyClientConfig.ts` is
  the one function that translates it into Privy's shape, and it is pinned
  by tests.

Today the hosted provider is [Privy](https://www.privy.io): a player signs
in with email or a social account and gets a wallet Privy manages, so they
can sign a defense transaction without ever meeting a seed phrase; a player
who already owns a wallet connects it instead. Either way the keys are the
provider's responsibility — this app never receives, derives or stores key
material, and nothing about a session is written to `localStorage` by us.
The emulator's stored address is not a key: nothing signs with it.

Replacing the provider means writing one adapter and one config mapping.
`game/`, `blockchain/`, every hook and every component stay as they are.

### `blockchain/`

Defines `BlockchainClient` — the single interface every part of the app
depends on (`getBlockNumber`, `getBlock`, `getBalance`, `readContract`,
`writeContract`, `waitForTransaction`, `getLogs`, `subscribeToEvents`,
`subscribeToBlocks`).
`createBlockchainClient(config)` in `blockchain/index.ts` is the only
place that picks between `EmulatorBlockchainClient` and
`ContractBlockchainClient`, based on `VITE_BLOCKCHAIN_MODE`.

The "game contract" — lobbies, participants, recon probes, defense — is
modeled as a fixed set of `readContract`/`writeContract` function names
(`createLobby`, `joinLobby`, `leaveLobby`, `buyProbes`, `sendProbe`,
`collectProbe`, `submitDefense`, `revealAttack`, `claimReward`,
`getGlobalDefenseDraw`, plus
read-only getters). Both clients implement the exact same call surface; only
what's behind it differs. The emulator opens a due Global Defense lobby on the
block tick; the contract opens it as a side effect of ordinary play.

### `game/`

Deterministic, pure functions with no React and no direct blockchain
imports: epoch math, seeded randomness, attack generation, recon
intelligence (`game/recon.ts`), defense/PPO scaffolding, economics, lobby state machine,
map/sector conversion. See [game-mechanics.md](game-mechanics.md) and
[attack-epochs.md](attack-epochs.md) for the mechanics themselves.

`game/gameService.ts` is the only file that calls a `BlockchainClient`.
It takes a client instance as an explicit argument, so it never depends on
which mode is active.

### `hooks/` and `stores/`

Hooks wrap `gameService` calls with the shared transaction lifecycle
(`idle -> preparing -> wallet_confirmation -> pending -> confirmed |
failed | rejected`) and subscribe to blockchain events / poll for
time-driven state (block number, deadlines). `stores/uiStore.ts` (Zustand)
holds only UI selection state — never balances, winners, or attack state.

### `config/`

All tunable values come from `VITE_*` environment variables, parsed once
in `config/env.ts` into a typed `AppConfig`. Nothing else reads
`import.meta.env` directly.

### `theme/`

Which confidential provider a deployment runs on decides how the app looks,
and nothing in the UI has to know that happened.

`theme/themes/*.ts` are the palettes — a `ProviderTheme` each, spread from
`themes/base.ts` so a provider states only the values it moves.
`theme/registry.ts` maps the deployment manifest's engine `kind` to one of
them (`fhenix-cofhe` → Fhenix, the deployed layer; `inco-lightning` → Inco,
the config-selectable alternative; `mock` → the
desaturated no-confidentiality look), and `ProviderThemeProvider` writes the
result onto `:root` as CSS custom properties.

That last step is the whole coupling. Component stylesheets ask for
`var(--color-accent)` or `var(--gradient-cta)`; the theme supplies them; no
component names a provider. `useProviderTheme` exists for the few places
that need the provider's *content* rather than its colour — its name, its
credit line, how it draws a redacted value — and the Home hero is currently
the only caller.

The same values are written statically into `app/globals.css` for the
default theme, so the first paint is correct before any JavaScript runs;
`tests/unit/theme.test.ts` checks the two do not drift.

There is no theme selector, by design. A player never picks a confidential
provider — `CONFIDENTIAL_ENGINE` does, once, at deploy time — so a player
never picks a theme. `VITE_PROVIDER_THEME` overrides the palette for
previewing another provider's look; it changes paint only, never which
network the client encrypts against.

Adding a provider is a row in `tools/chain/confidential.mjs`, an
`IConfidentialEngine` in `contracts/src/confidential/`, a
`ConfidentialGateway` in `blockchain/contract/confidential/providers/`, and
a `ProviderTheme` here. No game code, no components.

## Migration path: emulator -> real contract

Swapping `VITE_BLOCKCHAIN_MODE=emulator` for `VITE_BLOCKCHAIN_MODE=contract`
changes nothing above the `blockchain/` layer:

- React components, pages, and routing are unaffected.
- `game/` functions are unaffected — they're pure and don't know about
  either client.
- `game/gameService.ts` is unaffected — it only calls the
  `BlockchainClient` interface.

`ContractBlockchainClient` is live: it talks to the proxy in
`frontend/src/contracts/generated/`, decrypts through the confidential layer, and signs via the auth
bridge. Switching `VITE_BLOCKCHAIN_MODE=contract` is a configuration change,
not a code change. See [emulator.md](emulator.md) for the in-memory stand-in
and [README — Roadmap](../README.md#roadmap) for what is still open.

How to ship the SPA: [internals — Publishing notes](internals.md#publishing-notes).

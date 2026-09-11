# Security

This is a **testnet** product (Base Sepolia). It is not audited for mainnet
value. Do not send mainnet funds to the proxy in `deployments/`.

## Reporting

Open a GitHub issue, or contact the maintainers privately if you have found
a way to move funds that are not protocol fees.

## What is in scope

- Theft or freezing of prize pools, refunds, the Global Defense Pool, or
  the protocol treasury beyond `withdrawProtocolFees`.
- Reading an attack or another player's Defense Point before reveal.
- Privilege escalation (non-owner `setParams`, upgrades, withdrawals).
- The off-chain services in `api/` deciding an outcome the contract should
  own, or the faucet and keeper wallets being drained or steered.
- The client (`frontend/`) leaking a decrypted probe answer or a Defense
  Point to another player, or to storage that outlives the round.

## What is not a vulnerability here

- Anything the emulator does. It trusts the tab it runs in.
- Rate limits or 403s on public RPCs.
- Timing analysis of public transactions (documented; not hidden).
- `VITE_PRIVY_APP_ID` appearing in the browser bundle — it is a public id.

## Keys

Private keys live only in gitignored `contracts/.env` on the machine that
deploys. They must never be committed, pasted into a build or hosting
environment, or passed as `VITE_*`.

The `devkey` auth adapter reads a private key from the query string. It is
guarded by `import.meta.env.DEV` and compiled out of production builds; it
exists so UI automation can drive a real wallet locally, with a throwaway
testnet key. A production bundle that still resolves it is a vulnerability —
that guard is worth checking rather than taking on trust.

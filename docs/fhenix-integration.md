# Fhenix CoFHE integration

AEGYLAX is a planetary-defense game on **Base**. A round is a bet on a
trajectory nobody may see until impact — not the players, not an observer,
not the contract owner. **Fhenix CoFHE** is where that secret is born, where
reconnaissance is computed, and where a Defense Point stays sealed.

## Why a confidential layer at all?

If the attack coordinates existed in the client, in a backend, or as
plaintext in the game contract, the round would be a race to read them. The
gameplay *is* incomplete information: buy a noisy direction, commit one shot,
learn the truth only after the strike lands.

CoFHE is a fully-homomorphic **coprocessor** beside Base. Coordinates are
generated there as ciphertext. Probe hints are arithmetic on that ciphertext.
The player's final point is encrypted in the browser before it is a
transaction argument. Base never holds the numbers the round is about — only
handles, money, and time.

## What it costs, measured

Timed against CoFHE on Base Sepolia, on the deployed engine:

| | |
| --- | --- |
| Open a Defense Point handle (a ciphertext the player made; no arithmetic) | **3 s** |
| Open a probe hint (four encrypted remainders, plus packing) | **8–9 s** |
| Encrypt and prove a Defense Point in the browser | **8–9 s** |
| Full probe cycle — transaction plus read | **12–13 s** |

The three-second figure is the floor: it is the threshold network
re-encrypting under the player's key and nothing else. Everything above it
is the coprocessor computing, which is why the probe path was worth
optimising and why the numbers moved so far when it was — the same read took
**26–30 s** before the noise draws were narrowed from 128-bit to 32-bit
arithmetic (see `_boundedNoise` in `FhenixConfidentialEngine`).

This is also the reason CoFHE is the deployed layer rather than a preference:
the probe hint is bounded random draws, a 32-bit shift and a packed pair of
angles, and CoFHE offers all of it natively at several widths. Width control
*is* the latency lever.

## What is private?

Until after impact:

| Secret | Who can read it mid-round |
| --- | --- |
| Attack geometry (`θ` launch bearing, `δ` impact offset) | Nobody. Drawn inside CoFHE; the contract stores two handles. |
| Per-attack bias `ε` | Nobody. Shared by every probe on that attack so extra wallets cannot average to the true ray. |
| Probe hint (`δ_noisy << 32 \| θ_noisy`) | Only the sender. Granted by `sendProbe` itself. |
| Defense Point | Only its owner. The chain sees that a point was submitted, not where. |

Always public: who joined, amounts, deadlines, launch and impact **blocks**,
that a probe was bought or sent, that a Defense was submitted. An observer
sees *that* a secret moved, never the payload.

## What happens on Base?

`AegylaxGame` executes and settles. Ordinary public state:

- lobbies, seats, fees, prize pool, Global Defense;
- `sendProbe` — asks the engine for a hint handle **and grants decrypt to the
  sender**, in one transaction. `DELAY_BLOCKS` is charged on the next probe
  and on `submitDefense`, not on the read;
- `collectProbe` — a permissionless repair for a grant that did not stick;
  normally unused, and reverts with `ProbeAlreadyGranted`;
- `submitDefense` — stores the encrypted point handle and `submitBlock`;
- scoring and `claimReward`.

Reveal is two transactions because the coprocessor stands between them:

1. `unlockRound` — the flight is over; handles may be opened.
2. `revealAndResolve` — plaintexts come back; this team is scored.

The first must be **mined** before CoFHE will decrypt: it learns the handles
were opened by watching the chain. One transaction cannot contain that round
trip. Already-done steps are skipped; two operations on the same epoch share
one threat.

## What happens in CoFHE?

`FhenixConfidentialEngine` is a stateless adapter. Only the game proxy may
ask it for handles. No trigonometry over ciphertext — bounded integers,
integer ops, on `euint128`:

- **Generate.** `FHE.randomEuint128` draws `θ` and `δ` (impact constrained to
  the visible cap) and the shared `ε`. No block hash, no oracle, no protocol
  key.
- **Probe.** Two noisy angles, packed into one handle:
  `hint = (δ + cellNoise) << 32 | (θ + ε + cellNoise)` via `FHE.add` and
  `FHE.shl`. Noise is one draw per sensor cell **and angle**, so a second
  probe from the same place is the same reading. Packing is what lets a layer
  with no trigonometry release a corridor rather than a single bearing. The
  sender decrypts those two angles, never the sealed path.
- **Grant.** `FHE.allow` opens exactly one handle to exactly the sender — and
  only after the delay.
- **Defense.** The coordinate is encrypted in the browser; Base stores the
  handle.
- **Reveal.** After impact, `FHE.allowGlobal` plus a decryption request.
  `verifyDecryption` checks the plaintext against the handle committed at
  generation. You cannot swap in a different trajectory.

`MockConfidentialEngine` implements the same interface for Foundry and **is
not confidential**.

## Three things CoFHE does differently from Inco

Both providers implement `IConfidentialEngine` and the game cannot tell them
apart. Inside the adapter, three differences are real and each is a property
of CoFHE rather than a preference.

**`euint128`, not `euint256`.** CoFHE's widest encrypted integer is 128 bits.
Every secret here is a bounded microradian angle or a pair of them packed
into 64 bits, so this is not a constraint — it is an order of magnitude of
headroom over the widest value the protocol can form.

**Modulo, not a bounded draw.** CoFHE has no `randBounded`.
`FHE.randomEuint128` is uniform over the whole 128-bit range and the bound is
applied afterwards, on ciphertext, because the bound is itself sometimes a
secret (the `δ` window depends on `θ`). Modulo reduction is biased when the
bound does not divide the range; the size of that bias is `bound / 2^128`,
and every bound this protocol forms is an angle in microradians — under
2^23 — so the excess on the low residues is around 2^-105. Rejection
sampling is the alternative and cannot be written: rejecting means branching
on an encrypted comparison, and a loop whose trip count depends on a secret
is exactly the side channel this layer exists to remove.

**Encrypted inputs are bound to the address that made them.** This is the one
place the difference reaches the design. CoFHE's ZK verifier signs over
`(ctHash, utype, securityZone, sender, chainId)`, and `FHE.asEuint128(bytes)`
asks the TaskManager to check that signature against *its own caller*. A
Defense Point reaches the confidential layer through `submitDefense` rather
than directly, so the library path would check the ciphertext against the
game proxy and reject every blob a player ever produced. The engine therefore
calls `ITaskManager.batchVerifyInputs(inputs, player, signature)` itself.
That is not a weakening — a blob whose signature was not issued for `player`
still fails, and the handle is still granted only to the engine and to them.
What it buys is that submitting a Defense Point stays one transaction.

## Reveal, and the two proofs

`IConfidentialEngine.verifyDecryption(handle, value, signatures)` is the
commitment check, and CoFHE publishes a decryption in two places — so the
adapter accepts both, and they are the same claim by different routes:

- **Signed, off chain.** The threshold network returns the plaintext with a
  signature over it, and `verifyDecryptResult` checks that signature against
  the handle. This is the Inco-shaped path: the revealer carries the
  attestation in their transaction and nothing had to happen on chain first.
- **Published, on chain.** Somebody has already written the plaintext into
  the TaskManager and it can be read back. An empty `signatures` selects
  this, and it makes a reveal free of any off-chain fetch at all.

Either way the handle was fixed on chain when the attack was generated and
cannot be swapped afterwards.

## Switching provider

The choice is configuration, in one place, at deploy time:

```
# contracts/.env
CONFIDENTIAL_ENGINE=fhenix     # or: mock, or 0x<an engine to reuse>
                               # (inco = the alternative layer — see inco-integration.md)
COFHE_ENVIRONMENT=TESTNET      # MAINNET | TESTNET | LOCAL | MOCK
```

```bash
npm run chain:deploy
```

The deployer picks the adapter, checks it against the network it claims
(CoFHE's TaskManager must be live on `CHAIN_ID`; Inco's linked executor must
match the pepper's quorum), funds it only if that provider bills a balance,
and writes `kind` and `release` into `deployments/<chainId>.json`. The
frontend reads those two fields and builds the matching gateway. Nothing in
the game, the hooks or the UI changes.

The pieces, and where a fourth provider would go:

| | Fhenix | Inco | Mock |
| --- | --- | --- | --- |
| Engine (`contracts/src/confidential/`) | `FhenixConfidentialEngine.sol` | `IncoConfidentialEngine.sol` | `MockConfidentialEngine.sol` |
| Manifest `kind` | `fhenix-cofhe` | `inco-lightning` | `mock` |
| Client gateway | `@cofhe/sdk` | `@inco/js` (off) | chain reads |
| Engine holds a balance | no | yes | no |

Adding one is an `IConfidentialEngine` implementation, a
`ConfidentialGateway` beside it in the client, and a row in the pipeline's
provider table. Nothing in the game, the libraries, the lens, the hooks or
the UI moves.

## An existing deployment

An engine is bound to its proxy permanently and cannot be re-pointed, so
migrating a live deployment means deploying a new engine and calling
`setConfidentialEngine`:

```bash
CONFIDENTIAL_ENGINE=fhenix UPGRADE_ENGINE=true npm run chain:upgrade
```

`chain:upgrade` warns when this changes the provider, and the warning is the
important part: **handles minted by the old engine can only be revealed
through it.** Finish the rounds in flight first, or accept that their reveal
goes through the previous adapter.

## The client SDK, and the skew that used to block a round

The browser half runs on **`@cofhe/sdk`**. It replaced `cofhejs`, and the
replacement is what made a round playable at all.

`cofhejs` 0.3.1 — the last release there will be — bundled TFHE-rs 0.11.1 and
called the *plain* deserializer on the FHE parameters it fetched at startup.
The hosted testnet had moved to versioned ("safe") serialization on TFHE-rs
1.4+, so the parameters arrive with a header naming the format and the type:

```
"0.5"  "0.1"  "high_level_api::CompactPublicKey"
```

The old deserializer walked straight into that header and read eight bytes of
the type name as a length, which is where
`invalid value: integer 7809075072243073024, expected usize` came from — the
number is the ASCII of `high_l`. Measured against the live endpoints, TFHE-rs
0.11.1 could read the public key with `safe_deserialize` and could not read
the CRS *at all* (`expected variant index 0 <= i < 1`): a newer data version
with more enum variants than that build knew. So no client-side patch existed
— without a CRS there is no ZK proof, and without a proof there is no
encrypted input.

`@cofhe/sdk` carries TFHE-rs 1.5.3, which reads both. The same measurement
against the same live bytes:

| | tfhe 0.11.1 (`cofhejs`) | tfhe 1.5.3 (`@cofhe/sdk`) |
| --- | --- | --- |
| public key | `safe_deserialize` only | reads |
| CRS | **unreadable** | reads |

`isVersionSkew` and `describeInitFailure` in the gateway are kept for the
same class of failure, and should now be unreachable. They stay because the
symptom — "an internal error occurred" — points at the network and means the
opposite.

### What the migration touched

Only the client. `@fhenixprotocol/cofhe-contracts` is unchanged, the
TaskManager is the same address, and the deployed engine and its manifest
stayed valid — the wire format the engine decodes
(`uint256 ctHash, uint8 securityZone, uint8 utype, bytes signature`) is
exactly what the new SDK produces.

| | `cofhejs` | `@cofhe/sdk` |
| --- | --- | --- |
| Init | `initializeWithViem` (singleton) | `createCofheConfig` → `createCofheClient` → `connect` (an object per wallet) |
| Networks | environment name (`TESTNET`) | chain objects, built from the manifest by `cofheChain()` |
| Encrypt | `encrypt([...])` | `encryptInputs([...]).setConsumingContract(engine).setAccount(player).execute()` |
| Read your own | `unseal(handle, utype, account)` | `decryptForView(handle, FheTypes.Uint128).withACP()` |
| Credential | permit | ACP (Access Control Permission) |
| Errors | `Result<T>` with `.success` | thrown `CofheError` |
| FHE keys | fetched at init | fetched at first `encryptInputs` |

Two things are worth knowing before reading the gateway:

- **`setConsumingContract` is the engine.** The ZK verifier binds that
  address into the signature, and the contract that calls `FHE.asEuint*` is
  checked against it. In this protocol that is
  `FhenixConfidentialEngine`, not the game proxy — the same reason the
  engine calls `batchVerifyInputs(inputs, player, signature)` itself.
- **`LOCAL` is this repository's word, not the SDK's.** `@cofhe/sdk` knows
  `MOCK`, `TESTNET` and `MAINNET`; a self-hosted stack is a `TESTNET`
  pointed at localhost, and `cofheChain()` does that translation.

### Still open: there is no CoFHE mainnet

`chains` in the SDK lists `sepolia`, `arbSepolia`, `baseSepolia`, `hardhat`,
`localcofhe` and `stagingCofhe` — no production network. The
`mainnet-cofhe*.fhenix.zone` hosts do not resolve, and CoFHE's TaskManager
has no code on Base mainnet. `COFHE_ENVIRONMENT=MAINNET` is therefore not a
thing a deployment can be today, and the deployer refuses the chain rather
than deploying an engine that would revert on its first attack.

## Verified against Base Sepolia

Everything below was measured on the live deployment rather than against the
test stub, on chain 84532.

| | |
| --- | --- |
| `newAttackSecret` | accepted; 719K gas |
| `createLobby` (game → engine → coprocessor) | accepted; 1.37M gas of a 30M block |
| `newProbeHint`, including `FHE.shl` | accepted; 669K gas |
| Probe hint before / after `grantProbeHint` | not readable → readable, in CoFHE's own ACL |
| Trajectory before / after `unlockForReveal` | not public → public |
| Decrypt trigger | the TaskManager has `allowForDecryption`; `createDecryptTask` returns an empty revert, i.e. it does not exist there |
| Threshold network, no wallet and no permit | returns the plaintext and a signature over it |
| `revealEpochAttack` | accepted; 313K gas — the round is `RESOLVED` and its trajectory public |

Two things that only a live round could have shown, both now fixed:

- **CoFHE does not publish decryptions to the TaskManager on its own.**
  `getDecryptResultSafe` stayed empty for the whole grace window after
  `allowForDecryption`. The plaintext has to be fetched from the threshold
  network and carried into the reveal transaction, so that is the route both
  clients try.
- **The signature's recovery byte needs lifting.** The network signs with
  `v` of 0 or 1; `ECDSA.recover` takes only 27 or 28 and refuses the rest.
  The same handle and plaintext verified `false` at `v = 0` and `true` at
  `v = 27`. Untouched, every reveal would have failed *after* `unlockRound`
  was mined and paid for.

The decrypted geometry also reproduced exactly in the clear: `θ_raw`
392265 and `δ_raw` 820195 gave a launch bearing of −2225729 µrad and an
impact angle of −2365465 µrad, which is what `Geometry` derives from those
two shifted integers.

## Reading the health row

The Protocol Status panel names the layer and its release from the manifest
(`Fhenix CoFHE Testnet`), and links to whoever provides it
(`VITE_PRIVACY_LAYER_URL`). The shield goes yellow when the confidential lane
is slow rather than refusing — a decryption that is "not processed yet" is a
coprocessor that has not caught up with the chain, and waiting it out is the
protocol working as designed. A probe already on chain stays the player's
either way.

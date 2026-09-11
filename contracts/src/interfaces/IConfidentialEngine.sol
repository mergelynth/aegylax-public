// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

/**
 * The protocol's confidential-data boundary (ТЗ §1, §3).
 *
 * Everything the game must hide until it ends — the launch bearing, the
 * impact offset, the attack's one-time pad, every player's Defense Point,
 * and the private hint a Recon Probe computes — enters and leaves the game
 * contract through this interface and as opaque `bytes32` handles. The game
 * contract itself never holds a plaintext secret, cannot be made to emit
 * one, and does not know which confidential technology is behind the handle.
 *
 * That boundary is the reason it is an interface rather than an import.
 * The production implementation is Inco Lightning — encrypted random
 * generation, encrypted arithmetic, per-address decryption rights and
 * covalidator-attested decryption. A deterministic mock implements exactly
 * the same interface for local development and for the test suite, where
 * running against a live confidential network would make deterministic
 * assertions impossible. Swapping one for the other is a constructor
 * argument, not a code change, and the address is part of the deployment
 * manifest.
 *
 * The confidential values are all *bounded non-negative integers* — angles
 * in microradians and a packed coordinate pair — precisely so that nothing
 * here needs trigonometry or division over encrypted data. The geometry
 * runs in the clear at reveal time, on values a covalidator quorum has
 * attested to (`Geometry.sol`).
 */
interface IConfidentialEngine {
    /**
     * Draws one attack's confidential geometry.
     *
     * Returns three handles: the launch bearing θ, shifted into
     * `[0, 2·maxLaunchOffset]`; the impact offset δ, shifted into
     * `[0, 2·maxImpactDelta]` and *constrained against θ* so the impact
     * always lands on the visible cap of the globe; and a 128-bit one-time
     * pad `K` that masks every Defense Point submitted against this attack.
     *
     * The constraint on δ is applied inside the confidential layer, on
     * encrypted values, because applying it afterwards in the clear would
     * mean publishing a bound that depends on θ — a leak of half the hidden
     * geometry.
     *
     * Nobody — not the caller, not the protocol owner, not the covalidator
     * operator alone — can read any of the three before the reveal unlocks
     * them. `K` is what makes every Defense Point publicly decryptable after
     * a *single* unlock: the engine publishes `M = P + K (mod 2^128)` at
     * submit, and `P = M − K` is then a clear subtraction.
     */
    function newAttackSecret(bytes32 attackId, uint32 maxLaunchOffsetMicroRad, uint32 maxImpactDeltaMicroRad)
        external
        returns (bytes32 bearingHandle, bytes32 deltaHandle, bytes32 maskKeyHandle);

    /**
     * Publishes the one-time pad of a Defense Point.
     *
     * `pointHandle` is the player's private `P`. The returned handle is
     * `M = P + K (mod 2^128)`, granted globally: anybody may decrypt `M`
     * during the flight, and without `K` that is a pad. `P` itself is never
     * globally granted. The game calls this in the same transaction as
     * `newEncryptedPoint`, so the player pays O(1) ACL work at submit and
     * the reveal never walks the attempt list.
     */
    function maskDefensePoint(bytes32 pointHandle, bytes32 maskKeyHandle) external returns (bytes32 maskedHandle);

    /**
     * Computes one Recon Probe's private answer (ТЗ §3).
     *
     * The answer is a packed pair of noisy angles — launch bearing θ and
     * impact offset δ — and it is *not* granted to `player` here.
     * Granted to `player` in this same call, which is what keeps a Recon
     * Probe one transaction. `ReconRules.DELAY_BLOCKS` did not go away: it
     * moved onto the two calls that can act on a reading — a second
     * `sendProbe` and `submitDefense` — so decrypting in the send block
     * buys a bot nothing it can spend.
     *
     * Trigonometry cannot run on ciphertext, so the engine does not return
     * a point. It returns `δ_noisy << 32 | θ_noisy`. The client reconstructs
     * the chord in the clear and samples it at the public flight progress of
     * the send block: a shutter of where the attack is, already offset.
     *
     * The two noises on θ are different things, and both have to be there:
     *
     *   - cell noise, a deterministic function of `sensorKey`. Binding the
     *     draw to the cell is the anti-Sybil design (ТЗ §5): a second
     *     reading from the same place is the same reading, whoever pays.
     *     New knowledge costs a new position. δ gets its own per-cell draw
     *     of the same width, without ε — farms must not converge on the
     *     true chord by averaging.
     *   - attack bias ε, drawn once per attack and added to every probe's
     *     θ. Extra cells average away their own noise and converge on
     *     θ + ε, never on θ.
     *
     * Both are triangular — the sum of two draws — so a reading sits
     * near its own centre more often than at the edge of its error bar.
     * `coneMicroRad` is the half-width of each draw (`GameParams.probeConeMicroRad`).
     */
    function newProbeHint(
        bytes32 attackId,
        bytes32 bearingHandle,
        bytes32 deltaHandle,
        address player,
        bytes32 sensorKey,
        uint32 coneMicroRad
    ) external returns (bytes32 hintHandle);

    /**
     * Re-grants `player` the right to decrypt a hint `newProbeHint` already
     * computed and already granted.
     *
     * Idempotent and, on the normal path, unused: it exists because the ACL
     * belongs to the confidential network, and re-asserting a grant is the
     * only repair available if one is ever lost — including for probes sent
     * against an engine deployed before `newProbeHint` granted.
     */
    function grantProbeHint(bytes32 hintHandle, address player) external;

    /**
     * Registers a player-encrypted value (a packed Defense Point) and
     * returns the handle the protocol will hold it under.
     *
     * The ciphertext is produced in the player's browser against this
     * engine's address, so the coordinate is confidential from the moment it
     * is chosen: it is never in a transaction argument, an event, or a
     * public read.
     */
    function newEncryptedPoint(bytes calldata ciphertext, address player) external returns (bytes32 handle);

    /**
     * Makes the given handles publicly decryptable.
     *
     * Called once, by the game, when an attack has landed and its outcome no
     * longer depends on secrecy. Until this point there is no argument any
     * caller can pass that produces a plaintext; afterwards anyone can fetch
     * an attested decryption and submit it, which is what stops a reveal
     * from depending on the goodwill of the players who lost.
     */
    function unlockForReveal(bytes32[] calldata handles) external;

    /**
     * Whether `value` really is the plaintext behind `handle`, according to
     * the confidential network's own signers.
     *
     * This is the commitment check: the handle was fixed on chain when the
     * attack was generated and cannot be swapped afterwards, so an attested
     * decryption of it is the one thing that can turn a claimed coordinate
     * into protocol state.
     */
    function verifyDecryption(bytes32 handle, uint256 value, bytes[] calldata signatures)
        external
        view
        returns (bool);

    /// Human-readable identity of the implementation, for manifests and UIs.
    function engineKind() external view returns (string memory);

    /// Whether this engine is safe to run a public deployment against.
    function isProduction() external view returns (bool);
}

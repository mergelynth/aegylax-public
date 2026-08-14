// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

/**
 * The protocol's confidential-data boundary (ТЗ §1, §3).
 *
 * Everything the game must hide until it ends — the launch bearing, the
 * impact offset, every player's Defense Point, and the private hint a Recon
 * Probe computes — enters and leaves the game contract through this
 * interface and as opaque `bytes32` handles. The game contract itself never
 * holds a plaintext secret, cannot be made to emit one, and does not know
 * which confidential technology is behind the handle.
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
     * Returns two handles: the launch bearing θ, shifted into
     * `[0, 2·maxLaunchOffset]`, and the impact offset δ, shifted into
     * `[0, 2·maxImpactDelta]` and *constrained against θ* so the impact
     * always lands on the visible cap of the globe. The constraint is
     * applied inside the confidential layer, on encrypted values, because
     * applying it afterwards in the clear would mean publishing a bound
     * that depends on θ — a leak of half the hidden geometry.
     *
     * Nobody — not the caller, not the protocol owner, not the covalidator
     * operator alone — can read either value before the reveal unlocks it.
     */
    function newAttackSecret(bytes32 attackId, uint32 maxLaunchOffsetMicroRad, uint32 maxImpactDeltaMicroRad)
        external
        returns (bytes32 bearingHandle, bytes32 deltaHandle);

    /**
     * Computes one Recon Probe's private answer (ТЗ §3).
     *
     * The answer is the true launch bearing plus two noises, and it is
     * *not* granted to `player` here. `grantProbeHint` is what opens it,
     * after the probe has been in flight for `ReconRules.DELAY_BLOCKS`.
     * Computing and granting in the same call would let a bot decrypt the
     * hint in the same block it sent the probe.
     *
     * The two noises are different things, and both have to be there:
     *
     *   - cell noise, a deterministic function of `sensorKey`. Binding the
     *     draw to the cell is the anti-Sybil design (ТЗ §5): a second
     *     reading from the same place is the same reading, whoever pays.
     *     New knowledge costs a new position.
     *   - attack bias ε, drawn once per attack and added to every probe
     *     on it. Extra cells average away their own noise and converge
     *     on θ + ε, never on θ. That residual is what stops a farm of
     *     wallets from buying a solved ray.
     *
     * Both are triangular — the sum of two draws — so a reading sits
     * near its own centre more often than at the edge of its error bar.
     */
    function newProbeHint(bytes32 attackId, bytes32 bearingHandle, address player, bytes32 sensorKey, uint32 coneMicroRad)
        external
        returns (bytes32 hintHandle);

    /**
     * Grants `player` the right to decrypt a hint `newProbeHint` already
     * computed. Called by the game once the probe's delay has elapsed;
     * the engine itself does not know about blocks.
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

// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
// The Inco release a network runs is part of *that network's* identity:
// each pepper (mainnet, testnet, devnet, ...) is a different executor
// address linked at compile time, and the client SDK resolves the matching
// covalidator quorum from the same pepper. So the choice is configuration,
// not source: `INCO_PEPPER` in the deployment environment decides which
// `Lib.<pepper>.sol` this import resolves to, and the pipeline writes the
// remapping before compiling (`tools/chain/inco.mjs`).
//
// It is not taken on trust either: after deployment the pipeline reads
// `incoExecutor()` back off the engine and refuses to continue unless it
// matches what the SDK resolves for that pepper — so a mismatch fails at
// deploy time rather than at some player's first Recon Probe.
import {e, inco} from "@inco-active/Lib.sol";
import {euint256} from "@inco/lightning/src/Types.sol";
import {IConfidentialEngine} from "../interfaces/IConfidentialEngine.sol";
import {ReconRules} from "../libraries/ReconRules.sol";

/**
 * The production confidential layer: Inco Lightning.
 *
 * Base Sepolia executes and settles the game; Inco holds everything the
 * game may not see. The split is deliberate and is what the whole hidden
 * model rests on:
 *
 *   - `e.randBounded` draws the attack's angles *inside* the confidential
 *     network. No block hash, no oracle, no protocol key: there is no
 *     party — including whoever deployed this contract — who knows the
 *     trajectory while the round is being played.
 *   - `e.add` / `e.min` / `e.sub` operate on the ciphertexts, so a probe's
 *     answer is computed without the plaintext ever existing on chain.
 *   - `e.allow` gives exactly one address the right to decrypt exactly one
 *     value, which is how a probe's answer reaches the player who paid for
 *     it and nobody else.
 *   - `e.reveal` is the switch the game flips after impact, and
 *     `verifyDecryption` is how the plaintext gets back on chain: signed by
 *     the covalidator quorum, checked against the handle that was fixed
 *     when the attack was generated.
 *
 * This contract is deliberately *not* upgradeable and holds no game state.
 * It is a stateless adapter over Inco whose only privileged relationship is
 * "the game contract may ask me for handles". Replacing it — for a new Inco
 * release, or for a different confidential backend — is a parameter change
 * on the game proxy, and running operations keep working against the engine
 * they started under.
 */
contract IncoConfidentialEngine is IConfidentialEngine, Ownable {
    error NotGame();
    error GameAlreadySet();
    error InvalidBounds();

    /// The one contract allowed to mint handles here.
    address public game;

    /// keccak(attackId, sensorKey) => the encrypted offset that cell reports.
    mapping(bytes32 => bytes32) private _cellNoise;
    mapping(bytes32 => bool) private _cellNoiseSet;
    /// attackId => the encrypted bias ε every probe on that attack shares.
    mapping(bytes32 => bytes32) private _attackBias;
    mapping(bytes32 => bool) private _attackBiasSet;

    event GameSet(address indexed game);
    event Funded(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);

    modifier onlyGame() {
        if (msg.sender != game) revert NotGame();
        _;
    }

    constructor(address owner_) Ownable(owner_) {}

    /**
     * Bound to the game proxy exactly once.
     *
     * Once — because the ability to ask this engine for a probe hint is the
     * ability to learn a player's private reading, so it must not be
     * transferable by the owner after the fact.
     */
    function setGame(address game_) external onlyOwner {
        if (game != address(0)) revert GameAlreadySet();
        game = game_;
        emit GameSet(game_);
    }

    // -----------------------------------------------------------------
    // Confidential surface
    // -----------------------------------------------------------------

    /// @inheritdoc IConfidentialEngine
    function newAttackSecret(bytes32 attackId, uint32 maxLaunchOffsetMicroRad, uint32 maxImpactDeltaMicroRad)
        external
        onlyGame
        returns (bytes32 bearingHandle, bytes32 deltaHandle)
    {
        if (maxLaunchOffsetMicroRad == 0 || maxImpactDeltaMicroRad == 0) revert InvalidBounds();
        uint256 l = uint256(maxLaunchOffsetMicroRad);
        uint256 d = uint256(maxImpactDeltaMicroRad);

        // θ_raw uniform on [0, 2L].
        euint256 thetaRaw = e.randBounded(2 * l + 1);

        // δ has to keep the impact on the visible cap, so its window depends
        // on θ:  δ ∈ [max(-D, -θ), min(D, 2L - θ)].  Shifted by D to stay
        // non-negative, that is [D - min(D, θ_raw), min(2D, 2L + D - θ_raw)],
        // and every term of it is computed on ciphertext.
        euint256 loRaw = e.sub(d, e.min(thetaRaw, d));
        euint256 hiRaw = e.min(e.sub(2 * l + d, thetaRaw), 2 * d);
        euint256 width = e.add(e.sub(hiRaw, loRaw), uint256(1));
        euint256 deltaRaw = e.add(loRaw, e.randBounded(width));

        e.allowThis(thetaRaw);
        e.allowThis(deltaRaw);

        // ε is drawn here, once, so it exists before anybody sends a probe.
        // Triangular on [0, 2B] with midpoint B — the same encoding the
        // cell noise uses, so the decoder recentres both the same way.
        uint256 bias = uint256(ReconRules.BIAS_MICRO_RAD);
        euint256 attackBias = e.add(e.randBounded(bias + 1), e.randBounded(bias + 1));
        e.allowThis(attackBias);
        _attackBias[attackId] = euint256.unwrap(attackBias);
        _attackBiasSet[attackId] = true;

        return (euint256.unwrap(thetaRaw), euint256.unwrap(deltaRaw));
    }

    /// @inheritdoc IConfidentialEngine
    function newProbeHint(
        bytes32 attackId,
        bytes32 bearingHandle,
        address player,
        bytes32 sensorKey,
        uint32 coneMicroRad
    ) external onlyGame returns (bytes32 hintHandle) {
        player; // granted later, by `grantProbeHint`, after the delay.
        /*
         * One draw per sensor cell, kept for the life of the attack.
         *
         * `randBounded` per call made every probe an independent sample, so
         * ten wallets bought ten times the convergence for the same price
         * each — the Sybil hole ТЗ §5 is about. Binding the draw to the cell
         * means a second reading from the same place is the same reading,
         * and new knowledge has to be bought with a new position.
         *
         * It stays a *draw* rather than a hash of the cell: a player who
         * could compute the offset themselves would subtract it from their
         * reading and recover the bearing exactly, from one probe.
         */
        bytes32 cell = keccak256(abi.encode(attackId, sensorKey));
        euint256 noise;
        if (_cellNoiseSet[cell]) {
            noise = euint256.wrap(_cellNoise[cell]);
        } else {
            uint256 cone = uint256(coneMicroRad);
            // Triangular noise: the sum of two independent uniform draws.
            noise = e.add(e.randBounded(cone + 1), e.randBounded(cone + 1));
            e.allowThis(noise);
            _cellNoise[cell] = euint256.unwrap(noise);
            _cellNoiseSet[cell] = true;
        }

        euint256 bias = _attackBiasOf(attackId);
        euint256 hint = e.add(e.add(euint256.wrap(bearingHandle), bias), noise);

        e.allowThis(hint);
        // Deliberately not `e.allow(hint, player)`. The game calls
        // `grantProbeHint` once the probe has been in flight long enough.
        return euint256.unwrap(hint);
    }

    /// @inheritdoc IConfidentialEngine
    function grantProbeHint(bytes32 hintHandle, address player) external onlyGame {
        e.allow(euint256.wrap(hintHandle), player);
    }

    function _attackBiasOf(bytes32 attackId) private returns (euint256 bias) {
        if (_attackBiasSet[attackId]) return euint256.wrap(_attackBias[attackId]);
        // An attack minted before this engine knew about ε still needs one.
        // Drawn once and kept, same as the happy path in `newAttackSecret`.
        uint256 width = uint256(ReconRules.BIAS_MICRO_RAD);
        bias = e.add(e.randBounded(width + 1), e.randBounded(width + 1));
        e.allowThis(bias);
        _attackBias[attackId] = euint256.unwrap(bias);
        _attackBiasSet[attackId] = true;
    }

    /// @inheritdoc IConfidentialEngine
    function newEncryptedPoint(bytes calldata ciphertext, address player)
        external
        onlyGame
        returns (bytes32 handle)
    {
        euint256 value = e.newEuint256(ciphertext, player);
        e.allowThis(value);
        // The owner of a Defense Point may look at their own point at any
        // time; everybody else has to wait for the reveal.
        e.allow(value, player);
        return euint256.unwrap(value);
    }

    /// @inheritdoc IConfidentialEngine
    function unlockForReveal(bytes32[] calldata handles) external onlyGame {
        for (uint256 i = 0; i < handles.length; i++) {
            if (handles[i] == bytes32(0)) continue;
            e.reveal(euint256.wrap(handles[i]));
        }
    }

    /// @inheritdoc IConfidentialEngine
    function verifyDecryption(bytes32 handle, uint256 value, bytes[] calldata signatures)
        external
        view
        returns (bool)
    {
        return e.verifyDecryption(euint256.wrap(handle), value, signatures);
    }

    function engineKind() external pure returns (string memory) {
        return "inco-lightning";
    }

    function isProduction() external pure returns (bool) {
        return true;
    }

    /// The Inco executor this engine talks to — surfaced for the deployment manifest.
    function incoExecutor() external pure returns (address) {
        return address(inco);
    }

    // -----------------------------------------------------------------
    // Fees
    // -----------------------------------------------------------------

    /**
     * Inco charges a per-operation fee out of the calling contract's own
     * balance, so this contract has to hold ETH. It is funded by the
     * protocol rather than out of a player's transaction: a player pays a
     * probe price the operation sets, and what the protocol spends to answer
     * that probe confidentially is the protocol's own cost, not a variable
     * surcharge on the player.
     */
    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }

    function fund() external payable {
        emit Funded(msg.sender, msg.value);
    }

    function withdraw(address payable to, uint256 amount) external onlyOwner {
        (bool ok,) = to.call{value: amount}("");
        require(ok, "withdraw failed");
        emit Withdrawn(to, amount);
    }
}

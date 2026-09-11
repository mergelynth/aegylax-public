// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {FHE, euint128, TASK_MANAGER_ADDRESS} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {ITaskManager, UnsignedEncryptedInput, Utils} from "@fhenixprotocol/cofhe-contracts/ICofhe.sol";
import {IConfidentialEngine} from "../interfaces/IConfidentialEngine.sol";
import {ReconRules} from "../libraries/ReconRules.sol";

/**
 * The production confidential layer: Fhenix CoFHE.
 *
 * Base executes and settles the game; CoFHE holds everything the game may
 * not see. Nothing above this file knows that: `AegylaxGame` talks to
 * `IConfidentialEngine` and to opaque `bytes32` handles, so which
 * confidential network is behind a handle is a deployment parameter
 * (`CONFIDENTIAL_ENGINE`), not a property of the protocol.
 *
 * CoFHE is a *coprocessor* rather than a second chain. `FHE.add` and friends
 * do not compute here: they enqueue a task on the TaskManager, which returns
 * the ciphertext handle the result will have, and the FHE network fills the
 * value in afterwards. Everything this contract needs at call time is the
 * handle, so the asynchrony never reaches the game — the same way an Inco
 * handle is committed before its covalidators have been asked anything. What
 * it does mean is that a *read* can be early: the client's retry loop for
 * "not processed yet" is not an Inco quirk, it is the shape of both.
 *
 * Three things differ from the Inco adapter beside the names, and each one is
 * a property of CoFHE rather than a preference:
 *
 *   - **euint128, not euint256.** CoFHE's widest encrypted integer is 128
 *     bits. Every secret here is a bounded microradian angle or a pair of
 *     them packed into 64 bits, so 128 is not a constraint — it is an order
 *     of magnitude of headroom over the widest value the protocol can form.
 *   - **`rem` over a full-width draw, not a bounded draw.** CoFHE has no
 *     `randBounded`; see `_bounded`.
 *   - **`shl`, not thirty-two doublings.** This executor has a real shift.
 *
 * The contract is deliberately *not* upgradeable and holds no game state. It
 * is a stateless adapter whose only privileged relationship is "the game
 * contract may ask me for handles". Replacing it — for a new CoFHE release,
 * or to move a deployment back to Inco — is a parameter change on the game
 * proxy (`setConfidentialEngine`), and running operations keep working
 * against the engine they started under.
 */
contract FhenixConfidentialEngine is IConfidentialEngine, Ownable {
    error NotGame();
    error GameAlreadySet();
    error InvalidBounds();
    error InvalidCiphertext();

    /// The one contract allowed to mint handles here.
    address public game;

    /// keccak(attackId, sensorKey, angle) => the encrypted offset that cell reports.
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
        returns (bytes32 bearingHandle, bytes32 deltaHandle, bytes32 maskKeyHandle)
    {
        if (maxLaunchOffsetMicroRad == 0 || maxImpactDeltaMicroRad == 0) revert InvalidBounds();
        uint256 l = uint256(maxLaunchOffsetMicroRad);
        uint256 d = uint256(maxImpactDeltaMicroRad);

        // θ_raw uniform on [0, 2L].
        euint128 thetaRaw = _boundedPublic(2 * l + 1);

        // δ has to keep the impact on the visible cap, so its window depends
        // on θ:  δ ∈ [max(-D, -θ), min(D, 2L - θ)].  Shifted by D to stay
        // non-negative, that is [D - min(D, θ_raw), min(2D, 2L + D - θ_raw)],
        // and every term of it is computed on ciphertext. Computing it in the
        // clear afterwards would mean publishing a bound that depends on θ —
        // a leak of half the hidden geometry.
        euint128 eD = FHE.asEuint128(d);
        euint128 loRaw = FHE.sub(eD, FHE.min(thetaRaw, eD));
        euint128 hiRaw = FHE.min(FHE.sub(FHE.asEuint128(2 * l + d), thetaRaw), FHE.asEuint128(2 * d));
        euint128 width = FHE.add(FHE.sub(hiRaw, loRaw), FHE.asEuint128(1));
        euint128 deltaRaw = FHE.add(loRaw, _bounded(width));

        euint128 maskKey = FHE.randomEuint128();

        FHE.allowThis(thetaRaw);
        FHE.allowThis(deltaRaw);
        FHE.allowThis(maskKey);

        // ε is drawn here, once, so it exists before anybody sends a probe.
        _storeAttackBias(attackId);

        return (euint128.unwrap(thetaRaw), euint128.unwrap(deltaRaw), euint128.unwrap(maskKey));
    }

    /// @inheritdoc IConfidentialEngine
    function maskDefensePoint(bytes32 pointHandle, bytes32 maskKeyHandle)
        external
        onlyGame
        returns (bytes32 maskedHandle)
    {
        euint128 masked = FHE.add(euint128.wrap(pointHandle), euint128.wrap(maskKeyHandle));
        FHE.allowThis(masked);
        // The pad is public from submit. `K` stays sealed until impact.
        FHE.allowGlobal(masked);
        _requestDecrypt(uint256(euint128.unwrap(masked)));
        return euint128.unwrap(masked);
    }

    /// @inheritdoc IConfidentialEngine
    function newProbeHint(
        bytes32 attackId,
        bytes32 bearingHandle,
        bytes32 deltaHandle,
        address player,
        bytes32 sensorKey,
        uint32 coneMicroRad
    ) external onlyGame returns (bytes32 hintHandle) {
        uint256 cone = uint256(coneMicroRad);
        euint128 noiseTheta = _cellOffset(attackId, sensorKey, "theta", cone);
        euint128 noiseDelta = _cellOffset(attackId, sensorKey, "delta", cone);

        euint128 bias = _attackBiasOf(attackId);
        euint128 thetaNoisy = FHE.add(FHE.add(euint128.wrap(bearingHandle), bias), noiseTheta);
        euint128 deltaNoisy = FHE.add(euint128.wrap(deltaHandle), noiseDelta);
        // Packed `δ << 32 | θ`, the shape `ReconRules.unpackTheta` /
        // `unpackDelta` read back. `|` is an `add` because the limbs cannot
        // collide: θ_noisy < 2^32 by construction (2L + 2·cone + 2·ε is a few
        // million microradians), so the low limb never carries into δ's.
        euint128 hint = FHE.add(FHE.shl(deltaNoisy, FHE.asEuint128(32)), thetaNoisy);

        FHE.allowThis(hint);
        /*
         * Granted here, in the same transaction that computes it.
         *
         * The delay this used to be split across still exists — it moved to
         * the two calls that can *act* on a reading, `sendProbe` and
         * `submitDefense`, where `ReconRules.DELAY_BLOCKS` now gates both.
         * Reading early buys a bot nothing it can spend, and paying for the
         * separation with a second transaction cost every honest player one
         * more wallet signature and a second round trip through CoFHE's
         * ingestion — the coprocessor has to see the operations before a
         * handle opens, and splitting the grant off made it wait twice.
         *
         * Same reasoning as `newEncryptedPoint`: the check is not weakened,
         * it is asked in the place that makes the move one transaction.
         */
        FHE.allow(hint, player);
        return euint128.unwrap(hint);
    }

    /**
     * One draw per (sensor cell, angle), kept for the life of the attack.
     *
     * A fresh draw per call made every probe an independent sample, so ten
     * wallets bought ten times the convergence for the same price each — the
     * Sybil hole. Binding the draw to the cell means a second reading from
     * the same place is the same reading, and new knowledge has to be bought
     * with a new position.
     *
     * It stays a *draw* rather than a hash of the cell: a player who could
     * compute the offset themselves would subtract it from their reading and
     * recover the angles exactly, from one probe.
     *
     * Triangular — the sum of two draws — so a reading sits near its own
     * centre more often than at the edge of its error bar.
     */
    function _cellOffset(bytes32 attackId, bytes32 sensorKey, string memory kind, uint256 cone)
        private
        returns (euint128 noise)
    {
        bytes32 cell = keccak256(abi.encode(attackId, sensorKey, kind));
        if (_cellNoiseSet[cell]) return euint128.wrap(_cellNoise[cell]);
        noise = _triangular(cone);
        FHE.allowThis(noise);
        _cellNoise[cell] = euint128.unwrap(noise);
        _cellNoiseSet[cell] = true;
    }

    /// @inheritdoc IConfidentialEngine
    /// @dev Idempotent, and since `newProbeHint` grants, normally redundant.
    /// Kept because the ACL is CoFHE's and re-asserting a grant is the only
    /// repair available if one is ever lost — see `IConfidentialEngine`.
    function grantProbeHint(bytes32 hintHandle, address player) external onlyGame {
        FHE.allow(euint128.wrap(hintHandle), player);
    }

    function _attackBiasOf(bytes32 attackId) private returns (euint128 bias) {
        if (_attackBiasSet[attackId]) return euint128.wrap(_attackBias[attackId]);
        // An attack minted before this engine knew about ε still needs one.
        return _storeAttackBias(attackId);
    }

    /**
     * ε: drawn once per attack and added to every probe's θ.
     *
     * Extra cells average away their own noise and converge on θ + ε, never
     * on θ. Triangular on [0, 2B] with midpoint B — the same encoding the
     * cell noise uses, so the client's decoder recentres both the same way.
     */
    function _storeAttackBias(bytes32 attackId) private returns (euint128 bias) {
        bias = _triangular(uint256(ReconRules.BIAS_MICRO_RAD));
        FHE.allowThis(bias);
        _attackBias[attackId] = euint128.unwrap(bias);
        _attackBiasSet[attackId] = true;
    }

    /// The sum of two independent draws on [0, halfWidth]: triangular on [0, 2·halfWidth].
    function _triangular(uint256 halfWidth) private returns (euint128) {
        return FHE.add(_boundedNoise(halfWidth + 1), _boundedNoise(halfWidth + 1));
    }

    /**
     * A uniform draw on [0, bound) for the noise a probe waits on.
     *
     * Thirty-two bits, and the width is the entire point. Encrypted
     * remainder is a long-division circuit whose cost grows with the square
     * of the operand width, and it is what a player is actually waiting for
     * between pressing Send Probe and their reading opening. Measured
     * against CoFHE on Base Sepolia: a handle the coprocessor never computed
     * on — a player's own Defense Point ciphertext — opens in 3 seconds,
     * while a probe hint takes 26 to 30. That gap is these draws, four of
     * them per probe (two angles, two draws each).
     *
     * What it costs is bias. Modulo reduction is biased when the bound does
     * not divide the range, and the size of it is one part in
     * `floor(range / bound)`: for the bounds reaching this function — a
     * probe cone of 174,534 and an attack bias of 87,267 microradians — that
     * is about one part in twenty-four thousand, four hundredths of one
     * percent of excess weight on the low residues.
     *
     * That is not a quantity reconnaissance can accumulate into knowledge.
     * The draw it perturbs is noise added to an angle, its own width is ten
     * degrees, and a player would need tens of thousands of readings from
     * distinct cells to measure the skew at all — by which time they have
     * long since hit the per-attack bias ε, which no number of readings
     * cancels. What the bias would have to help with is guessing a draw
     * outright, and it does not move that.
     *
     * Two bounds deliberately do not come here. `newAttackSecret` draws θ
     * once per attack, off any path a probe waits on, so it keeps
     * `_boundedPublic` and its far tighter skew; the δ window is a
     * ciphertext and keeps `_bounded`.
     */
    function _boundedNoise(uint256 bound) private returns (euint128) {
        return FHE.asEuint128(FHE.rem(FHE.randomEuint32(), FHE.asEuint32(bound)));
    }

    /**
     * A uniform draw on [0, bound) for a public bound off the probe's path.
     *
     * Sixty-four bits: wide enough that the modulo skew is about 2^-41 for
     * the few-million-microradian bounds this protocol forms, which is
     * nothing, and there is no reason to trade that away here. The only
     * caller is θ in `newAttackSecret` — drawn once, when the attack is
     * minted, in a transaction no player is watching.
     *
     * The noise a probe waits on is `_boundedNoise`, and it makes the
     * opposite trade for the opposite reason.
     */
    function _boundedPublic(uint256 bound) private returns (euint128) {
        return FHE.asEuint128(FHE.rem(FHE.randomEuint64(), FHE.asEuint64(bound)));
    }

    /**
     * A uniform draw on [0, bound) for a bound that is itself a secret.
     *
     * CoFHE has no bounded-random primitive: `randomEuint128` is uniform over
     * the whole 128-bit range and the bound has to be applied afterwards, on
     * the ciphertext. Kept at 128 bits because the only caller is the δ
     * window in `newAttackSecret`, whose bound is a ciphertext — narrowing it
     * would mean casting a secret down and risking a silent truncation. It
     * runs once per attack, off the path a probe waits on; the public-bound
     * draws a probe does wait on are `_boundedPublic`.
     *
     * Modulo reduction is biased when the bound does not divide the range,
     * and here it does not. The size of that bias is `bound / 2^128`: every
     * bound this protocol forms is an angle in microradians — at most a few
     * million, under 2^23 — so the excess probability on the low residues is
     * on the order of 2^-105. That is not "small enough to ignore" as a
     * matter of taste; it is far below the probability of guessing the draw
     * outright, which is what the bias would have to help with to matter.
     *
     * Rejection sampling is the alternative and it cannot be written here:
     * rejecting means branching on an encrypted comparison, and a loop whose
     * trip count depends on a secret is exactly the side channel this layer
     * exists to remove.
     */
    function _bounded(euint128 bound) private returns (euint128) {
        return FHE.rem(FHE.randomEuint128(), bound);
    }

    /**
     * @inheritdoc IConfidentialEngine
     * @dev
     * The ciphertext is the ABI encoding CoFHE's own input format uses —
     * `(uint256 ctHash, uint8 securityZone, uint8 utype, bytes signature)` —
     * produced in the player's browser by `cofhejs.encrypt` and passed
     * through the game untouched.
     *
     * It is verified against `player` rather than against `msg.sender`, and
     * that distinction is the whole reason this call does not use
     * `FHE.asEuint128(bytes)`. CoFHE binds an encrypted input to the address
     * that produced it: the ZK verifier signs over `(ctHash, utype,
     * securityZone, sender, chainId)`, and `FHE.asEuint128` asks the
     * TaskManager to check that signature against *its own caller*. Its
     * caller here is the game proxy, because a Defense Point reaches the
     * confidential layer through `submitDefense` rather than directly — so
     * the library path would reject every ciphertext a player ever produced.
     *
     * Calling `batchVerifyInputs` with `player` explicitly is not a weakening
     * of that check, it is the same check asked correctly: a blob whose
     * signature was not issued for `player` still fails, and the resulting
     * handle is still granted only to this contract and to them. What it
     * buys is that submitting a Defense Point stays one transaction.
     */
    function newEncryptedPoint(bytes calldata ciphertext, address player)
        external
        onlyGame
        returns (bytes32 handle)
    {
        (uint256 ctHash, uint8 securityZone, uint8 utype, bytes memory signature) =
            abi.decode(ciphertext, (uint256, uint8, uint8, bytes));
        if (utype != Utils.EUINT128_TFHE) revert InvalidCiphertext();

        UnsignedEncryptedInput[] memory inputs = new UnsignedEncryptedInput[](1);
        inputs[0] = UnsignedEncryptedInput(ctHash, securityZone, utype);
        uint256[] memory verified = ITaskManager(TASK_MANAGER_ADDRESS).batchVerifyInputs(inputs, player, signature);

        euint128 value = euint128.wrap(bytes32(verified[0]));
        FHE.allowThis(value);
        // The owner of a Defense Point may look at their own point at any
        // time; everybody else has to wait for the reveal.
        FHE.allow(value, player);
        return euint128.unwrap(value);
    }

    /**
     * @inheritdoc IConfidentialEngine
     * @dev
     * `allowGlobal` is the switch: until the game flips it there is no
     * argument any caller can pass that produces a plaintext, and afterwards
     * anybody can ask the threshold network for one. That is what stops a
     * reveal from depending on the goodwill of the players who lost.
     *
     * The decryption itself is then requested best-effort. CoFHE's published
     * `ITaskManager` interface carries the ACL calls but not a decrypt
     * trigger — deployments have carried `createDecryptTask` and
     * `allowForDecryption` at different times — so both are attempted through
     * a low-level call and neither is allowed to revert the round. A
     * TaskManager that has neither is not a broken reveal: `allowGlobal` is
     * what authorises the plaintext, and the client asks the threshold
     * network for it directly.
     */
    function unlockForReveal(bytes32[] calldata handles) external onlyGame {
        for (uint256 i = 0; i < handles.length; i++) {
            if (handles[i] == bytes32(0)) continue;
            FHE.allowGlobal(euint128.wrap(handles[i]));
            _requestDecrypt(uint256(handles[i]));
        }
    }

    function _requestDecrypt(uint256 ctHash) private {
        (bool allowed,) = TASK_MANAGER_ADDRESS.call(abi.encodeWithSignature("allowForDecryption(uint256)", ctHash));
        if (allowed) return;
        (bool queued,) =
            TASK_MANAGER_ADDRESS.call(abi.encodeWithSignature("createDecryptTask(uint256,address)", ctHash, address(this)));
        queued; // Best effort by design — see `unlockForReveal`.
    }

    /**
     * @inheritdoc IConfidentialEngine
     * @dev
     * Two proofs are accepted and they are the same claim by two routes,
     * because CoFHE publishes a decryption in two places.
     *
     *   - **Signed, off chain.** The threshold network returns the plaintext
     *     with a signature over it, and `verifyDecryptResult` checks that
     *     signature against the handle. This is the Inco-shaped path: the
     *     revealer carries the attestation in their transaction, and nothing
     *     had to happen on chain first.
     *   - **Published, on chain.** Somebody has already put the plaintext in
     *     the TaskManager, and it can simply be read back. `signatures`
     *     empty is what selects this, and it is the path that makes a reveal
     *     free of any off-chain fetch at all once the network has settled.
     *
     * Either way the handle was fixed on chain when the attack was generated
     * and cannot be swapped afterwards, which is what turns a claimed
     * coordinate into protocol state rather than a claim.
     */
    function verifyDecryption(bytes32 handle, uint256 value, bytes[] calldata signatures)
        external
        view
        returns (bool)
    {
        if (signatures.length > 0) {
            // `Safe` returns false where the plain call reverts, and the
            // try/catch covers a TaskManager too old to carry it at all: a
            // reveal must never be unable to *ask*, only to be refused.
            try ITaskManager(TASK_MANAGER_ADDRESS).verifyDecryptResultSafe(uint256(handle), value, signatures[0])
            returns (bool verified) {
                if (verified) return true;
            } catch {}
        }
        (uint256 published, bool decrypted) = FHE.getDecryptResultSafe(handle);
        return decrypted && published == value;
    }

    function engineKind() external pure returns (string memory) {
        return "fhenix-cofhe";
    }

    function isProduction() external pure returns (bool) {
        return true;
    }

    /**
     * The CoFHE TaskManager this engine talks to — surfaced for the
     * deployment manifest, the way `IncoConfidentialEngine` surfaces Inco's
     * executor.
     *
     * It is linked at compile time as a constant of `FHE.sol`, so unlike
     * Inco's per-release executor there is nothing here for a deployment to
     * get out of step with — but it is still the address the privacy claim
     * rests on, and the pipeline records it so a player can check who can
     * decrypt an attack.
     */
    function cofheTaskManager() external pure returns (address) {
        return TASK_MANAGER_ADDRESS;
    }

    // -----------------------------------------------------------------
    // Funds
    // -----------------------------------------------------------------

    /**
     * CoFHE charges for confidential work in host-chain gas on the calling
     * transaction, so — unlike Inco, which bills a per-operation fee out of
     * the engine's own balance — this contract does not need to be funded to
     * answer a probe. `ENGINE_FUNDING_ETH` is skipped for it at deploy time.
     *
     * The receive hook and the sweep stay anyway: an operator who funds the
     * engine out of habit, or a chain that starts charging, should not mean
     * ETH that nobody can move.
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

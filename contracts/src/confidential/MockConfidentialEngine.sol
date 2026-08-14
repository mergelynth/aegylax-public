// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {IConfidentialEngine} from "../interfaces/IConfidentialEngine.sol";
import {ReconRules} from "../libraries/ReconRules.sol";

/**
 * A local stand-in for the confidential layer. **Not confidential.**
 *
 * It implements the same interface as `IncoConfidentialEngine` over plain
 * storage, which makes it exactly two things: a way to run the whole
 * protocol on a local node with no external dependency, and a way to write
 * deterministic tests about the parts of the game that are *not* the
 * cryptography — fees, timing, interception, ranking, claims. Tests that
 * assert "the winner is the defender who arrived first" need to know where
 * the attack went, and against a live confidential network they could not.
 *
 * Everything it stores is readable by anybody (`unsafePeek`), and its
 * randomness comes from block data, so a deployment using it has no hidden
 * state at all. `isProduction()` returns false and the deployment pipeline
 * refuses to point a public network at it without an explicit override.
 */
contract MockConfidentialEngine is IConfidentialEngine {
    error NotGame();
    error GameAlreadySet();
    error UnknownHandle();

    address public immutable owner;
    address public game;

    mapping(bytes32 => uint256) private _values;
    mapping(bytes32 => bool) public unlocked;
    /// keccak(attackId, sensorKey) => the offset that sensor cell always reports.
    mapping(bytes32 => uint256) private _cellNoise;
    mapping(bytes32 => bool) private _cellNoiseSet;
    /// attackId => the bias ε every probe on that attack shares.
    mapping(bytes32 => uint256) private _attackBias;
    mapping(bytes32 => bool) private _attackBiasSet;
    mapping(bytes32 => address) public reader;
    mapping(bytes32 => bool) private _hintExists;
    uint256 private _nonce;

    event GameSet(address indexed game);

    modifier onlyGame() {
        if (msg.sender != game) revert NotGame();
        _;
    }

    constructor(address owner_) {
        owner = owner_;
    }

    function setGame(address game_) external {
        if (msg.sender != owner) revert NotGame();
        if (game != address(0)) revert GameAlreadySet();
        game = game_;
        emit GameSet(game_);
    }

    function newAttackSecret(bytes32 attackId, uint32 maxLaunchOffsetMicroRad, uint32 maxImpactDeltaMicroRad)
        external
        onlyGame
        returns (bytes32 bearingHandle, bytes32 deltaHandle)
    {
        uint256 l = uint256(maxLaunchOffsetMicroRad);
        uint256 d = uint256(maxImpactDeltaMicroRad);

        uint256 thetaRaw = _draw(attackId, "theta") % (2 * l + 1);
        uint256 loRaw = d - _min(d, thetaRaw);
        uint256 hiRaw = _min(2 * d, 2 * l + d - thetaRaw);
        uint256 deltaRaw = loRaw + (_draw(attackId, "delta") % (hiRaw - loRaw + 1));

        bearingHandle = keccak256(abi.encode(attackId, "bearing"));
        deltaHandle = keccak256(abi.encode(attackId, "delta"));
        _values[bearingHandle] = thetaRaw;
        _values[deltaHandle] = deltaRaw;

        uint256 bias = uint256(ReconRules.BIAS_MICRO_RAD);
        _attackBias[attackId] = (_draw(attackId, "bias-a") % (bias + 1)) + (_draw(attackId, "bias-b") % (bias + 1));
        _attackBiasSet[attackId] = true;
    }

    function newProbeHint(
        bytes32 attackId,
        bytes32 bearingHandle,
        address player,
        bytes32 sensorKey,
        uint32 coneMicroRad
    ) external onlyGame returns (bytes32 hintHandle) {
        uint256 cone = uint256(coneMicroRad);

        /*
         * Drawn once per sensor cell and kept — not recomputed, and not
         * derived from anything a player could evaluate themselves.
         *
         * Both halves matter. Deterministic-in-the-cell is what defeats
         * Sybil: the same place answers the same thing whoever pays. But a
         * *publicly computable* function of the cell would be worse than
         * fresh noise — a player could work out the offset offline and
         * subtract it from their reading to recover the exact bearing from a
         * single probe. So it is a real draw, remembered.
         */
        bytes32 cell = keccak256(abi.encode(attackId, sensorKey));
        if (!_cellNoiseSet[cell]) {
            _cellNoise[cell] = (_draw(attackId, "noise-a") % (cone + 1)) + (_draw(attackId, "noise-b") % (cone + 1));
            _cellNoiseSet[cell] = true;
        }
        uint256 noise = _cellNoise[cell];
        uint256 bias = _attackBiasOf(attackId);

        // The handle is per reader — two players may each hold their own
        // reference — but the value behind it is the position's, not theirs.
        // The reader is *not* recorded here: `grantProbeHint` is what names
        // them, after the probe has been in flight.
        hintHandle = keccak256(abi.encode(attackId, sensorKey, player));
        _values[hintHandle] = _values[bearingHandle] + bias + noise;
        _hintExists[hintHandle] = true;
    }

    function grantProbeHint(bytes32 hintHandle, address player) external onlyGame {
        if (!_hintExists[hintHandle]) revert UnknownHandle();
        reader[hintHandle] = player;
    }

    function _attackBiasOf(bytes32 attackId) private returns (uint256) {
        if (_attackBiasSet[attackId]) return _attackBias[attackId];
        uint256 width = uint256(ReconRules.BIAS_MICRO_RAD);
        _attackBias[attackId] = (_draw(attackId, "bias-a") % (width + 1)) + (_draw(attackId, "bias-b") % (width + 1));
        _attackBiasSet[attackId] = true;
        return _attackBias[attackId];
    }

    function newEncryptedPoint(bytes calldata ciphertext, address player) external onlyGame returns (bytes32 handle) {
        uint256 value = abi.decode(ciphertext, (uint256));
        handle = keccak256(abi.encode("point", player, _nonce++));
        _values[handle] = value;
        reader[handle] = player;
    }

    function unlockForReveal(bytes32[] calldata handles) external onlyGame {
        for (uint256 i = 0; i < handles.length; i++) {
            if (handles[i] == bytes32(0)) continue;
            unlocked[handles[i]] = true;
        }
    }

    function verifyDecryption(bytes32 handle, uint256 value, bytes[] calldata) external view returns (bool) {
        if (!unlocked[handle]) return false;
        return _values[handle] == value;
    }

    function engineKind() external pure returns (string memory) {
        return "mock";
    }

    function isProduction() external pure returns (bool) {
        return false;
    }

    /// Dev only. The real engine has no equivalent and never could.
    function unsafePeek(bytes32 handle) external view returns (uint256) {
        return _values[handle];
    }

    /// Dev only: what a browser would encrypt, in the shape this engine accepts.
    function unsafeEncode(uint256 value) external pure returns (bytes memory) {
        return abi.encode(value);
    }

    function _draw(bytes32 attackId, string memory salt) private returns (uint256) {
        return uint256(
            keccak256(abi.encode(blockhash(block.number - 1), block.prevrandao, attackId, salt, address(this), _nonce++))
        );
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }
}

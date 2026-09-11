// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {
    FunctionId,
    ITaskManager,
    UnsignedEncryptedInput,
    Utils
} from "@fhenixprotocol/cofhe-contracts/ICofhe.sol";

/**
 * A CoFHE TaskManager with the ciphertexts replaced by plaintexts.
 *
 * `FhenixConfidentialEngine` talks to exactly one external address — the
 * coprocessor's TaskManager, linked as a constant of `FHE.sol` — and every
 * confidential decision it makes is a call to this interface. Etching this
 * contract at that address is therefore the whole confidential network, as
 * far as the adapter can tell, and lets the test suite assert what the
 * adapter *did*: which ciphertexts it composed, in what order, who it
 * granted them to, and what it accepted as proof of a decryption.
 *
 * It is emphatically not a model of FHE. Values are stored in the clear and
 * `peek` reads any of them, which is what makes "the impact landed on the
 * visible cap" and "the hint unpacks to θ + ε + noise" assertable at all.
 * The security properties live in CoFHE; what is under test here is that
 * this repository asks CoFHE for the right thing.
 *
 * ACL bookkeeping is real, because the adapter's correctness depends on it:
 * a handle the engine forgot to `allowThis` is unusable in the transaction
 * after the one that made it, and that failure is invisible until a player
 * sends the second probe of a round.
 */
contract StubTaskManager is ITaskManager {
    /// Plaintext behind a handle.
    mapping(uint256 => uint256) public value;
    mapping(uint256 => bool) public known;
    /// ctHash => account => may use it as an operand.
    mapping(uint256 => mapping(address => bool)) public allowedTo;
    mapping(uint256 => bool) public global;
    mapping(uint256 => bool) public published;
    mapping(uint256 => uint256) public plaintextOf;
    /// Inputs a "browser" produced, keyed the way the ZK verifier keys them.
    mapping(uint256 => uint256) private _pendingInput;
    mapping(uint256 => bool) private _pendingInputSet;

    uint256 private _nonce;
    /// Every ct the adapter asked to be opened for public decryption.
    uint256[] public decryptRequests;

    error NotAllowed(uint256 ctHash, address account);
    error UnknownOperand(uint256 ctHash);
    error BadInputSignature();

    // -- test-side helpers -------------------------------------------------

    /**
     * Registers a ciphertext as if a player's browser had produced it.
     *
     * `signature` in the real network is the ZK verifier's, over the input
     * bound to the address that made it. Here it is that address, encoded —
     * enough to reproduce the one property the adapter depends on: a blob
     * verifies for the account it was made for and for nobody else.
     */
    function preloadInput(uint256 ctHash, uint256 plaintext) external {
        _pendingInput[ctHash] = plaintext;
        _pendingInputSet[ctHash] = true;
    }

    function publishFor(uint256 ctHash, uint256 result) external {
        published[ctHash] = true;
        plaintextOf[ctHash] = result;
    }

    function peek(uint256 ctHash) external view returns (uint256) {
        return value[ctHash];
    }

    function decryptRequestCount() external view returns (uint256) {
        return decryptRequests.length;
    }

    // -- ITaskManager ------------------------------------------------------

    function createTask(uint8 returnType, FunctionId funcId, uint256[] memory encryptedInputs, uint256[] memory extraInputs)
        external
        returns (uint256)
    {
        if (funcId == FunctionId.trivialEncrypt) {
            // A constant the contract wrote in the clear: readable by anyone,
            // exactly as CoFHE treats a trivial encryption.
            return _mint(returnType, extraInputs[0], true);
        }

        uint256 lhs = _operand(encryptedInputs[0]);
        uint256 rhs = encryptedInputs.length > 1 ? _operand(encryptedInputs[1]) : 0;

        uint256 result;
        if (funcId == FunctionId.add) result = lhs + rhs;
        else if (funcId == FunctionId.sub) result = lhs - rhs;
        else if (funcId == FunctionId.min) result = lhs < rhs ? lhs : rhs;
        else if (funcId == FunctionId.max) result = lhs > rhs ? lhs : rhs;
        else if (funcId == FunctionId.rem) result = lhs % rhs;
        else if (funcId == FunctionId.mul) result = lhs * rhs;
        else if (funcId == FunctionId.shl) result = lhs << rhs;
        // A width change. Modelled as the truncation it is, so that an
        // adapter narrowing a value that does not fit fails here rather than
        // producing a hint the client silently unpacks wrong.
        else if (funcId == FunctionId.cast) result = lhs;
        else revert("StubTaskManager: unsupported op");

        // The result carries the width it was asked for: a euint64 that
        // wrapped and a euint128 that did not are different bugs, and an
        // adapter that overflowed either produces a hint nothing can unpack.
        return _mint(returnType, _narrow(returnType, result), false);
    }

    /// Uniform over the width asked for, which is what the bounded draws reduce.
    function createRandomTask(uint8 returnType, uint256 seed, int32) external returns (uint256) {
        uint256 draw = uint256(keccak256(abi.encode("stub-random", seed, _nonce, block.number, msg.sender)));
        return _mint(returnType, _narrow(returnType, draw), false);
    }

    /// A plaintext reduced to the encrypted type it is being stored as.
    function _narrow(uint8 utype, uint256 raw) private pure returns (uint256) {
        if (utype == Utils.EUINT8_TFHE) return raw % (1 << 8);
        if (utype == Utils.EUINT16_TFHE) return raw % (1 << 16);
        if (utype == Utils.EUINT32_TFHE) return raw % (1 << 32);
        if (utype == Utils.EUINT64_TFHE) return raw % (1 << 64);
        if (utype == Utils.EUINT128_TFHE) return raw % (1 << 128);
        return raw;
    }

    function batchVerifyInputs(UnsignedEncryptedInput[] memory inputs, address sender, bytes memory signature)
        external
        returns (uint256[] memory)
    {
        if (keccak256(signature) != keccak256(abi.encode(sender))) revert BadInputSignature();

        uint256[] memory handles = new uint256[](inputs.length);
        for (uint256 i = 0; i < inputs.length; i++) {
            if (!_pendingInputSet[inputs[i].ctHash]) revert UnknownOperand(inputs[i].ctHash);
            handles[i] = _mint(inputs[i].utype, _pendingInput[inputs[i].ctHash], false);
        }
        return handles;
    }

    function allow(uint256 ctHash, address account) external {
        _requireAllowed(ctHash, msg.sender);
        allowedTo[ctHash][account] = true;
    }

    function allowGlobal(uint256 ctHash) external {
        _requireAllowed(ctHash, msg.sender);
        global[ctHash] = true;
    }

    function allowTransient(uint256 ctHash, address account) external {
        _requireAllowed(ctHash, msg.sender);
        allowedTo[ctHash][account] = true;
    }

    /// The decrypt trigger `unlockForReveal` reaches for first.
    function allowForDecryption(uint256 ctHash) external {
        _requireAllowed(ctHash, msg.sender);
        global[ctHash] = true;
        decryptRequests.push(ctHash);
    }

    function isAllowed(uint256 ctHash, address account) external view returns (bool) {
        return allowedTo[ctHash][account] || global[ctHash];
    }

    function isPubliclyAllowed(uint256 ctHash) external view returns (bool) {
        return global[ctHash];
    }

    function shareCtHash(uint256, address) external {}

    function receiveCtHash(uint256, address) external {}

    function getDecryptResultSafe(uint256 ctHash) external view returns (uint256, bool) {
        if (!published[ctHash]) return (0, false);
        return (plaintextOf[ctHash], true);
    }

    function getDecryptResult(uint256 ctHash) external view returns (uint256) {
        require(published[ctHash], "not decrypted");
        return plaintextOf[ctHash];
    }

    function publishDecryptResult(uint256 ctHash, uint256 result, bytes calldata) external {
        published[ctHash] = true;
        plaintextOf[ctHash] = result;
    }

    function publishDecryptResultBatch(uint256[] calldata ctHashes, uint256[] calldata results, bytes[] calldata)
        external
    {
        for (uint256 i = 0; i < ctHashes.length; i++) {
            published[ctHashes[i]] = true;
            plaintextOf[ctHashes[i]] = results[i];
        }
    }

    /**
     * A signature over a decryption is `abi.encode(ctHash, result)` here.
     *
     * The real check is a threshold signature; what the adapter has to get
     * right is narrower and is what this reproduces — that a plaintext is
     * only accepted against the handle it was signed for, so a revealer
     * cannot move an attested value onto a different attack.
     */
    function verifyDecryptResult(uint256 ctHash, uint256 result, bytes calldata signature)
        external
        view
        returns (bool)
    {
        require(global[ctHash], "not unlocked");
        return keccak256(signature) == keccak256(abi.encode(ctHash, result));
    }

    function verifyDecryptResultSafe(uint256 ctHash, uint256 result, bytes calldata signature)
        external
        view
        returns (bool)
    {
        if (!global[ctHash]) return false;
        return keccak256(signature) == keccak256(abi.encode(ctHash, result));
    }

    function verifyDecryptResultBatch(uint256[] calldata, uint256[] calldata, bytes[] calldata)
        external
        pure
        returns (bool)
    {
        return false;
    }

    function verifyDecryptResultBatchSafe(uint256[] calldata ctHashes, uint256[] calldata, bytes[] calldata)
        external
        pure
        returns (bool[] memory)
    {
        return new bool[](ctHashes.length);
    }

    // -- internals ---------------------------------------------------------

    function _mint(uint8 utype, uint256 plaintext, bool trivial) private returns (uint256 ctHash) {
        ctHash = uint256(keccak256(abi.encode("stub-ct", utype, plaintext, _nonce++)));
        value[ctHash] = plaintext;
        known[ctHash] = true;
        // CoFHE grants the composer transient access to whatever it just
        // composed; keeping it past the transaction is what `allowThis` is
        // for, and the adapter has to do that itself.
        allowedTo[ctHash][msg.sender] = true;
        if (trivial) global[ctHash] = true;
    }

    function _operand(uint256 ctHash) private view returns (uint256) {
        if (!known[ctHash]) revert UnknownOperand(ctHash);
        _requireAllowed(ctHash, msg.sender);
        return value[ctHash];
    }

    function _requireAllowed(uint256 ctHash, address account) private view {
        if (!allowedTo[ctHash][account] && !global[ctHash]) revert NotAllowed(ctHash, account);
    }
}

/// Kept out of the stub so the type constant is asserted, not assumed.
library StubTypes {
    uint8 internal constant EUINT128 = Utils.EUINT128_TFHE;
}

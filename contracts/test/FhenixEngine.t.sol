// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TASK_MANAGER_ADDRESS} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

import {FhenixConfidentialEngine} from "../src/confidential/FhenixConfidentialEngine.sol";
import {DefenseMask} from "../src/libraries/DefenseMask.sol";
import {Geometry} from "../src/libraries/Geometry.sol";
import {ReconRules} from "../src/libraries/ReconRules.sol";
import {StubTaskManager, StubTypes} from "./StubTaskManager.t.sol";

/**
 * The Fhenix CoFHE adapter, against a TaskManager whose ciphertexts are
 * plaintexts (`StubTaskManager`).
 *
 * These tests are about the adapter, not about FHE. What they pin down is
 * the set of things that are this repository's responsibility and that no
 * amount of correctness in CoFHE would fix: that the impact stays on the
 * visible cap, that a probe hint is the packed pair the client unpacks,
 * that a second reading from one sensor cell is the same reading, that a
 * hint is not readable before `grantProbeHint`, and that a decryption is
 * only accepted against the handle it was issued for.
 *
 * `MockConfidentialEngine` covers the same ground for the rest of the
 * suite; this file exists because the Fhenix adapter reaches an external
 * contract for every one of those decisions and so can get them wrong in
 * ways a pure-storage engine cannot.
 */
contract FhenixEngineTest is Test {
    FhenixConfidentialEngine internal engine;
    StubTaskManager internal cofhe;

    address internal owner = address(0xA11CE);
    address internal game = address(0x6A3E);
    address internal alice = address(0xA1);
    address internal bob = address(0xB0B);

    uint32 internal constant L = uint32(uint256(Geometry.MAX_LAUNCH_OFFSET_MICRO_RAD));
    uint32 internal constant D = uint32(uint256(Geometry.MAX_IMPACT_DELTA_MICRO_RAD));
    /// `GAME_PROBE_CONE_MICRO_RAD` in the shipped deployment: 10°.
    uint32 internal constant CONE = 174_533;

    bytes32 internal constant ATTACK = keccak256("attack-1");

    function setUp() public {
        vm.roll(1000);
        // The TaskManager address is a compile-time constant of `FHE.sol`,
        // so the only way to stand a CoFHE deployment up locally is to put
        // code at it.
        vm.etch(TASK_MANAGER_ADDRESS, type(StubTaskManager).runtimeCode);
        cofhe = StubTaskManager(TASK_MANAGER_ADDRESS);

        engine = new FhenixConfidentialEngine(owner);
        vm.prank(owner);
        engine.setGame(game);
    }

    // -- identity ----------------------------------------------------------

    function test_engineKind_isTheManifestsIdentifier() public view {
        assertEq(engine.engineKind(), "fhenix-cofhe");
        assertTrue(engine.isProduction());
        assertEq(engine.cofheTaskManager(), TASK_MANAGER_ADDRESS);
    }

    function test_onlyTheGameMayMintHandles() public {
        vm.expectRevert(FhenixConfidentialEngine.NotGame.selector);
        engine.newAttackSecret(ATTACK, L, D);

        vm.prank(alice);
        vm.expectRevert(FhenixConfidentialEngine.NotGame.selector);
        engine.unlockForReveal(new bytes32[](0));
    }

    function test_theGameBindingIsOneWay() public {
        vm.prank(owner);
        vm.expectRevert(FhenixConfidentialEngine.GameAlreadySet.selector);
        engine.setGame(alice);
    }

    // -- attack geometry ---------------------------------------------------

    function test_attackSecret_staysInsideItsShiftedRanges() public {
        (bytes32 bearing, bytes32 delta) = _newAttack(ATTACK);

        uint256 theta = _peek(bearing);
        uint256 d = _peek(delta);
        assertLe(theta, 2 * uint256(L), "theta outside [0, 2L]");
        assertLe(d, 2 * uint256(D), "delta outside [0, 2D]");
    }

    /**
     * The impact has to land on the visible cap, and the window that keeps
     * it there depends on θ — which is why the constraint is applied on
     * ciphertext rather than clamped in the clear afterwards. In the shifted
     * encoding both angles are non-negative and the invariant reads as a
     * bound on their sum.
     */
    function test_attackSecret_constrainsTheImpactAgainstTheBearing() public {
        for (uint256 i = 0; i < 24; i++) {
            bytes32 attackId = keccak256(abi.encode("cap", i));
            vm.roll(block.number + 1);
            (bytes32 bearing, bytes32 delta) = _newAttack(attackId);

            int256 theta = int256(_peek(bearing)) - int256(uint256(L));
            int256 d = int256(_peek(delta)) - int256(uint256(D));

            assertGe(theta + d, -int256(uint256(L)), "impact fell off the near edge");
            assertLe(theta + d, int256(uint256(L)), "impact fell off the far edge");
        }
    }

    function test_attackSecret_rejectsZeroBounds() public {
        vm.prank(game);
        vm.expectRevert(FhenixConfidentialEngine.InvalidBounds.selector);
        engine.newAttackSecret(ATTACK, 0, D);
    }

    function test_attackSecret_keepsItsHandlesUsableInLaterTransactions() public {
        (bytes32 bearing, bytes32 delta) = _newAttack(ATTACK);
        assertTrue(cofhe.isAllowed(uint256(bearing), address(engine)), "bearing not kept");
        assertTrue(cofhe.isAllowed(uint256(delta), address(engine)), "delta not kept");
        // Nobody else, and not the public.
        assertFalse(cofhe.isPubliclyAllowed(uint256(bearing)));
        assertFalse(cofhe.isAllowed(uint256(bearing), alice));
    }

    // -- probe hints -------------------------------------------------------

    function test_probeHint_packsBothNoisyAnglesIntoOneHandle() public {
        (bytes32 bearing, bytes32 delta) = _newAttack(ATTACK);
        bytes32 hint = _probe(ATTACK, bearing, delta, alice, keccak256("cell-a"));

        uint256 packed = _peek(hint);
        uint256 theta = ReconRules.unpackTheta(packed);
        uint256 d = ReconRules.unpackDelta(packed);

        // Each limb is its true angle plus non-negative noise, bounded by
        // the widths the engine drew from. Reading the true values is the
        // stub's privilege; a player only ever sees `packed`.
        uint256 trueTheta = _peek(bearing);
        uint256 trueDelta = _peek(delta);
        assertGe(theta, trueTheta, "theta limb below the truth");
        assertLe(theta, trueTheta + 2 * uint256(CONE) + 2 * uint256(ReconRules.BIAS_MICRO_RAD), "theta limb too wide");
        assertGe(d, trueDelta, "delta limb below the truth");
        assertLe(d, trueDelta + 2 * uint256(CONE), "delta limb too wide");
        // The low limb must never carry into the high one.
        assertLt(theta, 1 << 32, "theta limb overflowed its 32 bits");
    }

    /**
     * A second probe from the same sensor cell is the same reading. That is
     * the anti-Sybil property: new knowledge costs a new position, not a new
     * wallet.
     */
    function test_probeHint_isTheCellsAnswerRatherThanTheWallets() public {
        (bytes32 bearing, bytes32 delta) = _newAttack(ATTACK);
        bytes32 cell = keccak256("cell-a");

        bytes32 mine = _probe(ATTACK, bearing, delta, alice, cell);
        vm.roll(block.number + 1);
        bytes32 theirs = _probe(ATTACK, bearing, delta, bob, cell);

        assertEq(_peek(mine), _peek(theirs), "two wallets bought two readings from one cell");
    }

    function test_probeHint_differsBetweenCells() public {
        (bytes32 bearing, bytes32 delta) = _newAttack(ATTACK);

        uint256 here = _peek(_probe(ATTACK, bearing, delta, alice, keccak256("cell-a")));
        vm.roll(block.number + 1);
        uint256 there = _peek(_probe(ATTACK, bearing, delta, alice, keccak256("cell-b")));

        assertTrue(here != there, "moving the sensor bought nothing");
    }

    /**
     * Every probe on one attack carries the same ε, so extra cells converge
     * on θ + ε rather than on θ. Two cells reading the same *pair* of angles
     * would mean the bias was per-probe.
     */
    function test_probeHint_sharesOneBiasAcrossTheAttack() public {
        (bytes32 bearing, bytes32 delta) = _newAttack(ATTACK);
        uint256 trueTheta = _peek(bearing);

        uint256 floor = type(uint256).max;
        for (uint256 i = 0; i < 8; i++) {
            vm.roll(block.number + 1);
            uint256 theta =
                ReconRules.unpackTheta(_peek(_probe(ATTACK, bearing, delta, alice, keccak256(abi.encode("cell", i)))));
            if (theta - trueTheta < floor) floor = theta - trueTheta;
        }
        // The cell noise can reach zero; ε cannot be averaged away, so the
        // best reading across many cells still sits above the truth by it.
        assertGt(floor, 0, "the bias washed out across cells");
    }

    /**
     * The hint opens for the player who paid for it, in the call that
     * computed it, and for nobody else.
     *
     * It used to be granted by a separate `grantProbeHint` a delay later, so
     * that a bot could not read in the send block. The delay moved to the
     * game — `sendProbe` and `submitDefense` both refuse for
     * `ReconRules.DELAY_BLOCKS` — which leaves this engine with the half it
     * can actually enforce: *who* may read, never *when*.
     */
    function test_probeHint_isReadableByItsSenderAndNobodyElse() public {
        (bytes32 bearing, bytes32 delta) = _newAttack(ATTACK);
        bytes32 hint = _probe(ATTACK, bearing, delta, alice, keccak256("cell-a"));

        assertTrue(cofhe.isAllowed(uint256(hint), alice), "sender cannot read their own hint");
        assertFalse(cofhe.isAllowed(uint256(hint), bob), "hint readable by another player");
        assertFalse(cofhe.isPubliclyAllowed(uint256(hint)), "hint is public before the reveal");
    }

    /// Re-asserting the grant is idempotent, and still opens it to nobody else.
    function test_grantProbeHint_isARepairRatherThanTheOnlyWayIn() public {
        (bytes32 bearing, bytes32 delta) = _newAttack(ATTACK);
        bytes32 hint = _probe(ATTACK, bearing, delta, alice, keccak256("cell-a"));

        vm.prank(game);
        engine.grantProbeHint(hint, alice);

        assertTrue(cofhe.isAllowed(uint256(hint), alice));
        assertFalse(cofhe.isAllowed(uint256(hint), bob), "the repair opened it to everyone");
    }

    // -- defense points ----------------------------------------------------

    function test_encryptedPoint_isVerifiedAgainstThePlayerNotTheCaller() public {
        uint256 ctHash = uint256(keccak256("alice-point"));
        cofhe.preloadInput(ctHash, 4242);

        vm.prank(game);
        bytes32 handle = engine.newEncryptedPoint(_blob(ctHash, alice), alice);

        assertEq(_peek(handle), 4242);
        assertTrue(cofhe.isAllowed(uint256(handle), alice), "owner cannot read their own point");
        assertTrue(cofhe.isAllowed(uint256(handle), address(engine)), "engine cannot keep the point");
        assertFalse(cofhe.isPubliclyAllowed(uint256(handle)), "point is public before the reveal");
        assertFalse(cofhe.isAllowed(uint256(handle), bob), "point readable by another player");
    }

    function test_maskDefensePoint_isPublicAndUnmasks() public {
        (, , bytes32 maskKey) = _newAttackFull(ATTACK);
        uint256 packed = 4242;
        uint256 ctHash = uint256(keccak256("masked-point"));
        cofhe.preloadInput(ctHash, packed);

        vm.prank(game);
        bytes32 point = engine.newEncryptedPoint(_blob(ctHash, alice), alice);
        vm.prank(game);
        bytes32 masked = engine.maskDefensePoint(point, maskKey);

        assertTrue(cofhe.isPubliclyAllowed(uint256(masked)), "the pad is public from submit");
        assertFalse(cofhe.isPubliclyAllowed(uint256(point)), "P itself stays sealed");
        assertEq(_peek(masked), DefenseMask.mask(packed, _peek(maskKey)));
        assertEq(DefenseMask.unmask(_peek(masked), _peek(maskKey)), packed);
    }

    function test_encryptedPoint_rejectsACiphertextMadeForSomebodyElse() public {
        uint256 ctHash = uint256(keccak256("bob-point"));
        cofhe.preloadInput(ctHash, 7);

        vm.prank(game);
        vm.expectRevert(StubTaskManager.BadInputSignature.selector);
        engine.newEncryptedPoint(_blob(ctHash, bob), alice);
    }

    function test_encryptedPoint_rejectsTheWrongEncryptedWidth() public {
        uint256 ctHash = uint256(keccak256("wide-point"));
        cofhe.preloadInput(ctHash, 7);
        bytes memory wrongType = abi.encode(ctHash, uint8(0), uint8(5) /* euint64 */, abi.encode(alice));

        vm.prank(game);
        vm.expectRevert(FhenixConfidentialEngine.InvalidCiphertext.selector);
        engine.newEncryptedPoint(wrongType, alice);
    }

    // -- reveal ------------------------------------------------------------

    function test_unlockForReveal_opensTheHandlesAndAsksForThePlaintexts() public {
        (bytes32 bearing, bytes32 delta) = _newAttack(ATTACK);

        bytes32[] memory handles = new bytes32[](3);
        handles[0] = bearing;
        handles[1] = bytes32(0); // A seat that never submitted; skipped, not reverted.
        handles[2] = delta;

        vm.prank(game);
        engine.unlockForReveal(handles);

        assertTrue(cofhe.isPubliclyAllowed(uint256(bearing)));
        assertTrue(cofhe.isPubliclyAllowed(uint256(delta)));
        assertEq(cofhe.decryptRequestCount(), 2, "the plaintexts were never asked for");
    }

    function test_verifyDecryption_takesAnAttestationForThatHandleOnly() public {
        (bytes32 bearing, bytes32 delta) = _newAttack(ATTACK);
        uint256 truth = _peek(bearing);
        _unlock(bearing, delta);

        bytes[] memory proof = _signature(bearing, truth);
        assertTrue(engine.verifyDecryption(bearing, truth, proof), "the real plaintext was refused");
        assertFalse(engine.verifyDecryption(bearing, truth + 1, proof), "a different value passed");
        assertFalse(engine.verifyDecryption(delta, truth, proof), "an attestation moved to another handle");
    }

    /**
     * The other half of CoFHE's reveal: once somebody has published the
     * plaintext on chain, a revealer needs no off-chain fetch at all and
     * sends no signature. An empty `signatures` is what selects that path.
     */
    function test_verifyDecryption_acceptsAPlaintextAlreadyPublishedOnChain() public {
        (bytes32 bearing, bytes32 delta) = _newAttack(ATTACK);
        uint256 truth = _peek(bearing);
        _unlock(bearing, delta);

        bytes[] memory none = new bytes[](0);
        assertFalse(engine.verifyDecryption(bearing, truth, none), "accepted before anything was published");

        cofhe.publishFor(uint256(bearing), truth);
        assertTrue(engine.verifyDecryption(bearing, truth, none), "refused a published plaintext");
        assertFalse(engine.verifyDecryption(bearing, truth + 1, none), "accepted a value nobody published");
    }

    function test_verifyDecryption_refusesWhileTheRoundIsStillSealed() public {
        (bytes32 bearing,) = _newAttack(ATTACK);
        uint256 truth = _peek(bearing);

        assertFalse(
            engine.verifyDecryption(bearing, truth, _signature(bearing, truth)),
            "a locked handle could be revealed"
        );
    }

    // -- helpers -----------------------------------------------------------

    function _newAttack(bytes32 attackId) private returns (bytes32 bearing, bytes32 delta) {
        (bearing, delta,) = _newAttackFull(attackId);
    }

    function _newAttackFull(bytes32 attackId) private returns (bytes32 bearing, bytes32 delta, bytes32 maskKey) {
        vm.prank(game);
        return engine.newAttackSecret(attackId, L, D);
    }

    function _probe(bytes32 attackId, bytes32 bearing, bytes32 delta, address player, bytes32 sensorKey)
        private
        returns (bytes32)
    {
        vm.prank(game);
        return engine.newProbeHint(attackId, bearing, delta, player, sensorKey, CONE);
    }

    function _unlock(bytes32 a, bytes32 b) private {
        bytes32[] memory handles = new bytes32[](2);
        handles[0] = a;
        handles[1] = b;
        vm.prank(game);
        engine.unlockForReveal(handles);
    }

    /// What `cofhejs.encrypt` hands the browser, in the shape the game forwards.
    function _blob(uint256 ctHash, address boundTo) private pure returns (bytes memory) {
        return abi.encode(ctHash, uint8(0), StubTypes.EUINT128, abi.encode(boundTo));
    }

    function _signature(bytes32 handle, uint256 plaintext) private pure returns (bytes[] memory proof) {
        proof = new bytes[](1);
        proof[0] = abi.encode(uint256(handle), plaintext);
    }

    function _peek(bytes32 handle) private view returns (uint256) {
        return cofhe.peek(uint256(handle));
    }
}

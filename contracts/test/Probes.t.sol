// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {AegylaxTest} from "./AegylaxTest.t.sol";
import {AegylaxGame} from "../src/AegylaxGame.sol";
import {GameTypes} from "../src/libraries/GameTypes.sol";
import {Geometry} from "../src/libraries/Geometry.sol";
import {ReconRules} from "../src/libraries/ReconRules.sol";

/// Recon Probes: allowances, purchases, the window they are usable in, and what they leak.
contract ProbesTest is AegylaxTest {
    function test_freeProbes_areUsableWithoutPaying() public {
        (bytes32 lobbyId,) = startedLobby();

        sendProbeReady(lobbyId, alice, 0, 0);
        sendProbeReady(lobbyId, alice, 0, 0);
        sendProbeReady(lobbyId, alice, 0, 0);

        GameTypes.Participant memory p = lensOf().getParticipant(lobbyId, alice);
        assertEq(p.probesUsed, 3);
        assertEq(p.probesPurchased, 0);
    }

    function test_probes_runOutAtTheFreeAllowance() public {
        (bytes32 lobbyId,) = startedLobby();

        for (uint256 i = 0; i < 3; i++) {
            sendProbeReady(lobbyId, alice, 0, 0);
        }

        waitProbeDelay();
        vm.prank(alice);
        vm.expectRevert(AegylaxGame.NoProbesLeft.selector);
        game.sendProbe(lobbyId, 0, 0);
    }

    function test_buyProbes_raisesTheAllowanceAndTheRewardPool() public {
        (bytes32 lobbyId, bytes32 attackId) = scheduledLobby();

        vm.prank(alice);
        game.buyProbes{value: PROBE_PRICE * 2}(lobbyId, 2);

        (GameTypes.Lobby memory before,,) = lensOf().getLobby(lobbyId);
        assertEq(before.probeFeesCollected, PROBE_PRICE * 2);

        vm.roll(attackOf(attackId).launchBlock);
        for (uint256 i = 0; i < 5; i++) {
            sendProbeReady(lobbyId, alice, 0, 0);
        }

        GameTypes.Participant memory p = lensOf().getParticipant(lobbyId, alice);
        assertEq(p.probesUsed, 5);
    }

    function test_buyProbes_cannotExceedTheOperationsCeiling() public {
        (bytes32 lobbyId,) = scheduledLobby();

        // 3 free + 6 bought would pass the configured maximum of 8.
        vm.prank(alice);
        vm.expectRevert(AegylaxGame.ProbeLimitReached.selector);
        game.buyProbes{value: PROBE_PRICE * 6}(lobbyId, 6);
    }

    function test_buyProbes_rejectsWrongPayment() public {
        (bytes32 lobbyId,) = scheduledLobby();
        vm.prank(alice);
        vm.expectRevert(AegylaxGame.IncorrectPayment.selector);
        game.buyProbes{value: PROBE_PRICE}(lobbyId, 2);
    }

    /**
     * ТЗ §3 — recon is equipment, bought before the threat is in the sky.
     *
     * A player may keep probing right up to their own Send Defense, so a
     * purchase allowed mid-flight would let a defender who prepared for
     * nothing simply buy a fix once the clock was running — and buy it
     * knowing the launch had already happened. The window is: applications
     * open, or scheduled but not yet airborne.
     */
    function test_buyProbes_closesAtTheLaunch() public {
        (bytes32 lobbyId, bytes32 attackId) = scheduledLobby();

        // Scheduled, still on the ground: allowed.
        vm.prank(alice);
        game.buyProbes{value: PROBE_PRICE}(lobbyId, 1);

        vm.roll(attackOf(attackId).launchBlock);
        vm.prank(alice);
        vm.expectRevert(AegylaxGame.DefenseWindowClosed.selector);
        game.buyProbes{value: PROBE_PRICE}(lobbyId, 1);

        // And still closed once the flight is over.
        vm.roll(attackOf(attackId).impactBlock + 1);
        vm.prank(alice);
        vm.expectRevert(AegylaxGame.DefenseWindowClosed.selector);
        game.buyProbes{value: PROBE_PRICE}(lobbyId, 1);
    }

    /// While applications are open there is no attack scheduled at all — still fine.
    function test_buyProbes_allowedWhileApplicationsAreOpen() public {
        bytes32 lobbyId = createLobby();
        join(lobbyId, alice);

        vm.prank(alice);
        game.buyProbes{value: PROBE_PRICE}(lobbyId, 1);

        assertEq(lensOf().getParticipant(lobbyId, alice).probesPurchased, 1);
    }

    function test_probe_rejectedFromNonParticipant() public {
        (bytes32 lobbyId,) = startedLobby();
        vm.prank(carol);
        vm.expectRevert(AegylaxGame.NotParticipant.selector);
        game.sendProbe(lobbyId, 0, 0);
    }

    function test_probe_rejectedBeforeLaunchAndAfterImpact() public {
        bytes32 lobbyId = createLobby();
        join(lobbyId, alice);
        join(lobbyId, bob);
        closeApplications();
        game.startOperation(lobbyId);

        (GameTypes.Lobby memory lobby,,) = lensOf().getLobby(lobbyId);
        GameTypes.Attack memory attack = attackOf(lobby.attackId);

        // Before launch: nothing is in the sky to scan.
        vm.prank(alice);
        vm.expectRevert(AegylaxGame.DefenseWindowClosed.selector);
        game.sendProbe(lobbyId, 0, 0);

        vm.roll(attack.impactBlock);
        vm.prank(alice);
        vm.expectRevert(AegylaxGame.DefenseWindowClosed.selector);
        game.sendProbe(lobbyId, 0, 0);
    }

    function test_probe_closesOnceThisPlayerHasDefended() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        (int256 x, int256 y) = pointOnTrajectory(attackId, 500);
        submitPoint(lobbyId, alice, x, y);

        vm.prank(alice);
        vm.expectRevert(AegylaxGame.DefenseAlreadySubmitted.selector);
        game.sendProbe(lobbyId, 0, 0);
    }

    /**
     * The privacy property, stated as a test: a probe's answer is readable
     * by the player who paid for it and by nobody else.
     *
     * The mock engine records who a handle was granted to, which is the
     * same bookkeeping Inco's ACL does on chain — so this asserts the
     * protocol asked for the right grant, which is the part the protocol
     * is responsible for.
     */
    function test_probeAnswer_isGrantedOnlyToTheProbingPlayer() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();

        vm.recordLogs();
        bytes32 handle = sendProbeReady(lobbyId, alice, 0, 0);

        assertEq(engine.reader(handle), address(0), "hint is not granted at send");
        collectReady(handle);
        assertEq(engine.reader(handle), alice);
        assertTrue(handle != bytes32(0));

        // And the answer really is the bearing plus bounded noise, not the bearing.
        // Noise is cell (0..2·cone) plus attack bias (0..2·bias).
        (uint256 thetaRaw,) = secretOf(attackId);
        uint256 hint = engine.unsafePeek(handle);
        assertGe(hint, thetaRaw);
        assertLe(
            hint,
            thetaRaw + 2 * uint256(defaultParams().probeConeMicroRad) + 2 * uint256(ReconRules.BIAS_MICRO_RAD)
        );
    }

    /// Sensors in different places disagree — that is what makes several of them narrow it down.
    function test_probes_fromDifferentSensorsDisagree() public {
        (bytes32 lobbyId,) = startedLobby();

        bytes32 first = sendProbeReady(lobbyId, alice, 0, 0);
        bytes32 second = sendProbeReady(lobbyId, alice, 7, 3);

        assertTrue(first != second);
        assertTrue(engine.unsafePeek(first) != engine.unsafePeek(second));
    }

    /**
     * The anti-Sybil property, as a test (ТЗ §5).
     *
     * A reading belongs to the place it was taken from, not to the wallet
     * that paid for it. So a second probe of the same cell — by the same
     * player or by a fresh wallet holding no history at all — returns the
     * identical answer and teaches nobody anything new.
     *
     * Without this, ten wallets buying eight probes each collected eighty
     * independent samples of the truth for the price of eighty probes, while
     * one wallet buying eight collected eight. Splitting yourself was simply
     * the better way to play.
     */
    function test_probes_fromTheSameSensorTeachNothingNew() public {
        // Carol is the second wallet of the same person, in from the start
        // and there only to buy a second look at the same place.
        bytes32 lobbyId = createLobby();
        join(lobbyId, alice);
        join(lobbyId, bob);
        join(lobbyId, carol);
        closeApplications();
        game.startOperation(lobbyId);

        (GameTypes.Lobby memory lobby,,) = lensOf().getLobby(lobbyId);
        vm.roll(attackOf(lobby.attackId).launchBlock);

        vm.prank(alice);
        bytes32 mine = game.sendProbe(lobbyId, 4, 2);

        vm.prank(carol);
        bytes32 sybil = game.sendProbe(lobbyId, 4, 2);

        assertTrue(mine != sybil, "each reader holds their own handle");
        assertEq(engine.unsafePeek(sybil), engine.unsafePeek(mine), "but the reading is the cell's");
    }

    /// A sensor has to stand on the board it is scanning.
    function test_probe_rejectsASensorOffTheBoard() public {
        (bytes32 lobbyId,) = startedLobby();

        vm.prank(alice);
        vm.expectRevert(AegylaxGame.SensorOffBoard.selector);
        game.sendProbe(lobbyId, 10, 0);
    }

    function test_probeHandles_areNotDecryptableBeforeTheAttackLands() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        vm.prank(alice);
        game.sendProbe(lobbyId, 0, 0);

        GameTypes.Attack memory attack = attackOf(attackId);
        bytes[] memory noSignatures = new bytes[](0);

        // The trajectory's own handles refuse to verify: nothing has unlocked them.
        assertFalse(engine.verifyDecryption(attack.bearingHandle, 0, noSignatures));
        assertFalse(engine.verifyDecryption(attack.deltaHandle, 0, noSignatures));

        // And the public read surface has no geometry on it at all.
        (bool revealed, GameTypes.Trajectory memory traj) = lensOf().getTrajectory(attackId);
        assertFalse(revealed);
        assertEq(traj.targetX, 0);
        assertEq(traj.targetY, 0);
        assertEq(traj.lengthWu, 0);
    }

    function test_secondProbe_revertsWhileTheFirstIsInFlight() public {
        (bytes32 lobbyId,) = startedLobby();

        vm.prank(alice);
        game.sendProbe(lobbyId, 0, 0);

        vm.prank(alice);
        vm.expectRevert(AegylaxGame.ProbeInFlight.selector);
        game.sendProbe(lobbyId, 1, 0);
    }

    function test_collectProbe_revertsBeforeTheDelay() public {
        (bytes32 lobbyId,) = startedLobby();

        vm.prank(alice);
        bytes32 handle = game.sendProbe(lobbyId, 0, 0);

        vm.expectRevert(AegylaxGame.ProbeNotReadable.selector);
        game.collectProbe(handle);
    }

    function test_collectProbe_grantsTheHintAfterTheDelay() public {
        (bytes32 lobbyId,) = startedLobby();

        vm.prank(alice);
        bytes32 handle = game.sendProbe(lobbyId, 0, 0);
        assertEq(engine.reader(handle), address(0));

        collectReady(handle);
        assertEq(engine.reader(handle), alice);

        GameTypes.ProbeFlight memory flight = lensOf().getProbeFlight(handle);
        assertTrue(flight.granted);
        assertEq(flight.player, alice);

        vm.expectRevert(AegylaxGame.ProbeAlreadyGranted.selector);
        game.collectProbe(handle);
    }

    function test_collectProbe_isPermissionless() public {
        (bytes32 lobbyId,) = startedLobby();

        vm.prank(alice);
        bytes32 handle = game.sendProbe(lobbyId, 0, 0);
        waitProbeDelay();

        // Bob collects Alice's probe; the grant is still hers.
        vm.prank(bob);
        game.collectProbe(handle);
        assertEq(engine.reader(handle), alice);
    }

    function test_unknownProbe_cannotBeCollected() public {
        vm.expectRevert(AegylaxGame.UnknownProbe.selector);
        game.collectProbe(bytes32(uint256(1)));
    }

    /**
     * The irreducible bias: two cells on the same attack share an offset
     * that averaging them cannot cancel. Their midpoint is not the
     * bearing — it is the bearing plus ε.
     */
    function test_probes_shareAnAttackBiasThatCellsCannotCancel() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();

        bytes32 a = sendProbeReady(lobbyId, alice, 0, 0);
        bytes32 b = sendProbeReady(lobbyId, alice, 7, 3);

        (uint256 thetaRaw,) = secretOf(attackId);
        uint256 hintA = engine.unsafePeek(a);
        uint256 hintB = engine.unsafePeek(b);
        uint256 mid = (hintA + hintB) / 2;

        // If there were only cell noise, two independent triangular draws
        // centred on `cone` would put the midpoint near θ + cone. With ε
        // on top, the midpoint sits `bias` further out on average — and
        // in any case it is not the bearing itself.
        assertTrue(mid != thetaRaw, "fused cells must not recover the bearing");
        assertGe(hintA, thetaRaw);
        assertGe(hintB, thetaRaw);
    }
}

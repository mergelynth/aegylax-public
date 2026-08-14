// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {AegylaxTest} from "./AegylaxTest.t.sol";
import {AegylaxGame} from "../src/AegylaxGame.sol";
import {GameTypes} from "../src/libraries/GameTypes.sol";
import {Geometry} from "../src/libraries/Geometry.sol";

/**
 * The rules the game is actually about (ТЗ §5): when a defense intercepts,
 * when it is too late, and which of several interceptors wins.
 */
contract InterceptionTest is AegylaxTest {
    function test_defense_rejectedOutsideTheFlightWindow() public {
        bytes32 lobbyId = createLobby();
        join(lobbyId, alice);
        join(lobbyId, bob);
        closeApplications();
        game.startOperation(lobbyId);

        (GameTypes.Lobby memory lobby,,) = lensOf().getLobby(lobbyId);
        GameTypes.Attack memory attack = attackOf(lobby.attackId);

        bytes memory ciphertext = engine.unsafeEncode(Geometry.packPoint(1_000_000_000, 1_000_000_000));

        vm.prank(alice);
        vm.expectRevert(AegylaxGame.DefenseWindowClosed.selector);
        game.submitDefense(lobbyId, ciphertext);

        vm.roll(attack.impactBlock);
        vm.prank(alice);
        vm.expectRevert(AegylaxGame.DefenseWindowClosed.selector);
        game.submitDefense(lobbyId, ciphertext);
    }

    function test_defense_cannotBeResent() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        (int256 x, int256 y) = pointOnTrajectory(attackId, 500);
        submitPoint(lobbyId, alice, x, y);

        bytes memory ciphertext = engine.unsafeEncode(Geometry.packPoint(uint256(x), uint256(y)));
        vm.prank(alice);
        vm.expectRevert(AegylaxGame.DefenseAlreadySubmitted.selector);
        game.submitDefense(lobbyId, ciphertext);
    }

    function test_defense_rejectedFromNonParticipant() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        (int256 x, int256 y) = pointOnTrajectory(attackId, 500);

        bytes memory ciphertext = engine.unsafeEncode(Geometry.packPoint(uint256(x), uint256(y)));
        vm.prank(carol);
        vm.expectRevert(AegylaxGame.NotParticipant.selector);
        game.submitDefense(lobbyId, ciphertext);
    }

    function test_pointOnTheTrajectory_intercepts() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        timedSubmitOnTrajectory(lobbyId, attackId, alice, 700);
        completeAndReveal(lobbyId, attackId);

        GameTypes.DefenseAttempt[] memory attempts = lensOf().getDefenseAttempts(lobbyId);
        assertTrue(attempts[0].intercepted);
        assertTrue(attempts[0].isWinner);

        (, GameTypes.Outcome memory outcome) = lensOf().getOutcome(lobbyId);
        assertTrue(outcome.intercepted);
        assertEq(outcome.winners.length, 1);
        assertEq(outcome.winners[0], alice);
    }

    function test_pointFarFromTheTrajectory_misses() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        GameTypes.Trajectory memory traj = trajectoryOf(attackId);

        // A whole sector away from the path, well outside the 0.14-sector radius.
        int256 x = traj.targetX > 3_000_000_000 ? traj.targetX - 3_000_000_000 : traj.targetX + 3_000_000_000;
        submitPoint(lobbyId, alice, x, 100_000_000);
        completeAndReveal(lobbyId, attackId);

        GameTypes.DefenseAttempt[] memory attempts = lensOf().getDefenseAttempts(lobbyId);
        assertFalse(attempts[0].intercepted);
        assertFalse(attempts[0].isWinner);
        assertGt(attempts[0].missDistanceWu, 0);

        (, GameTypes.Outcome memory outcome) = lensOf().getOutcome(lobbyId);
        assertFalse(outcome.intercepted);
        assertEq(outcome.winners.length, 0);
    }

    /**
     * Being on the path is not enough: arrival has to coincide with the
     * threat being there. Alice times the climb. Bob submits two blocks
     * before impact and is still climbing after the threat has landed.
     */
    function test_lateArrival_doesNotIntercept() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        GameTypes.Attack memory attack = attackOf(attackId);

        timedSubmitOnTrajectory(lobbyId, attackId, alice, 700);
        (int256 x, int256 y) = pointOnTrajectory(attackId, 700);

        vm.roll(attack.impactBlock - 2);
        submitPoint(lobbyId, bob, x, y);

        completeAndReveal(lobbyId, attackId);

        GameTypes.DefenseAttempt[] memory attempts = lensOf().getDefenseAttempts(lobbyId);
        assertTrue(attempts[0].intercepted, "timed defender should intercept");
        assertFalse(attempts[1].intercepted, "late defender arrives after the threat");
        assertGe(attempts[1].arrivalBlockScaled, uint256(attack.impactBlock) * GameTypes.TIME_SCALE);
    }

    /**
     * A point near Earth submitted at launch arrives while the threat is
     * still high — covering the chord is not a snapshot hit.
     */
    function test_earlyArrivalNearEarth_misses() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        (int256 x, int256 y) = pointOnTrajectory(attackId, 900);
        submitPoint(lobbyId, alice, x, y);
        completeAndReveal(lobbyId, attackId);

        GameTypes.DefenseAttempt[] memory attempts = lensOf().getDefenseAttempts(lobbyId);
        assertFalse(attempts[0].intercepted);
    }

    /**
     * Among snapshot hits, earliest arrival wins. Alice times a high
     * intercept; Bob times a low one. Bob's climb is shorter, but he
     * arrives later because the threat is not there until later.
     */
    function test_winner_isTheEarliestArrival_amongSnapshotHits() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();

        timedSubmitOnTrajectory(lobbyId, attackId, alice, 400);
        timedSubmitOnTrajectory(lobbyId, attackId, bob, 900);

        completeAndReveal(lobbyId, attackId);

        GameTypes.DefenseAttempt[] memory attempts = lensOf().getDefenseAttempts(lobbyId);
        assertTrue(attempts[0].intercepted);
        assertTrue(attempts[1].intercepted);
        assertLt(attempts[0].arrivalBlockScaled, attempts[1].arrivalBlockScaled, "alice arrives first");

        (, GameTypes.Outcome memory outcome) = lensOf().getOutcome(lobbyId);
        assertEq(outcome.winners.length, 1);
        assertEq(outcome.winners[0], alice);
        assertEq(outcome.winningArrivalBlockScaled, attempts[0].arrivalBlockScaled);
    }

    /// Identical arrivals have nothing left to rank by, so the pool splits.
    function test_exactTie_splitsBetweenBothWinners() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();

        timedSubmitOnTrajectory(lobbyId, attackId, alice, 500);
        (int256 x, int256 y) = pointOnTrajectory(attackId, 500);
        submitPoint(lobbyId, bob, x, y); // same block, same point

        completeAndReveal(lobbyId, attackId);

        (, GameTypes.Outcome memory outcome) = lensOf().getOutcome(lobbyId);
        assertTrue(outcome.intercepted);
        assertEq(outcome.winners.length, 2);

        (GameTypes.Lobby memory lobby,,) = lensOf().getLobby(lobbyId);
        assertEq(outcome.rewardPerWinner, uint256(lobby.rewardPool) / 2);
    }

    /// Several timed intercepts: all snapshot-valid, earliest arrival wins.
    function test_multipleInterceptors_allRecorded_oneWins() public {
        bytes32 lobbyId = createLobby();
        join(lobbyId, alice);
        join(lobbyId, bob);
        join(lobbyId, carol);
        closeApplications();
        game.startOperation(lobbyId);

        (GameTypes.Lobby memory lobby,,) = lensOf().getLobby(lobbyId);
        bytes32 attackId = lobby.attackId;
        vm.roll(attackOf(attackId).launchBlock);

        timedSubmitOnTrajectory(lobbyId, attackId, alice, 200);
        timedSubmitOnTrajectory(lobbyId, attackId, bob, 500);
        timedSubmitOnTrajectory(lobbyId, attackId, carol, 800);

        completeAndReveal(lobbyId, attackId);

        GameTypes.DefenseAttempt[] memory attempts = lensOf().getDefenseAttempts(lobbyId);
        uint256 interceptors;
        uint256 winners;
        for (uint256 i = 0; i < attempts.length; i++) {
            if (attempts[i].intercepted) interceptors++;
            if (attempts[i].isWinner) winners++;
        }
        assertEq(interceptors, 3, "all three timed the snapshot");
        assertEq(winners, 1, "only the earliest arrival takes it");

        (, GameTypes.Outcome memory outcome) = lensOf().getOutcome(lobbyId);
        assertEq(outcome.winners[0], alice);
    }

    function test_noDefenders_resolvesAsAMiss() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        completeAndReveal(lobbyId, attackId);

        (, GameTypes.Outcome memory outcome) = lensOf().getOutcome(lobbyId);
        assertFalse(outcome.intercepted);
        assertEq(outcome.winners.length, 0);
        assertEq(outcome.rewardPerWinner, 0);
    }
}

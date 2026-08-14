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
        (int256 x, int256 y) = pointOnTrajectory(attackId, 700);
        submitPoint(lobbyId, alice, x, y);
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

        // A whole sector away from the path, well outside the 0.32-sector radius.
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
     * ТЗ §5, the second condition: being in the right place is not enough,
     * the interceptor has to be *there* before the threat passes through.
     *
     * Both defenders here pick the same point on the trajectory; one
     * submits at launch and one submits so late that its interceptor is
     * still climbing when the threat goes by.
     */
    function test_lateArrival_doesNotIntercept() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        GameTypes.Attack memory attack = attackOf(attackId);

        // Well along the flight, so an interceptor launched now is on
        // station long before the threat gets there.
        (int256 x, int256 y) = pointOnTrajectory(attackId, 700);
        submitPoint(lobbyId, alice, x, y);

        // Bob picks the same place, but only a few blocks before impact.
        vm.roll(attack.impactBlock - 2);
        submitPoint(lobbyId, bob, x, y);

        completeAndReveal(lobbyId, attackId);

        GameTypes.DefenseAttempt[] memory attempts = lensOf().getDefenseAttempts(lobbyId);
        assertTrue(attempts[0].intercepted, "early defender should intercept");
        assertFalse(attempts[1].intercepted, "late defender cannot be on station in time");
        assertGt(attempts[1].arrivalBlockScaled, attempts[1].interceptionBlockScaled);
    }

    /**
     * ТЗ §5, the ranking rule: several defenders may intercept, and the one
     * with the earliest *arrival* wins — not the one whose transaction
     * happened to land first.
     *
     * Bob submits second, but picks a point much closer to Earth, so his
     * interceptor is on station before Alice's is. The order of the UI
     * actions and the order of the arrivals disagree, and the protocol
     * follows the arrivals.
     */
    function test_winner_isTheEarliestArrival_notTheEarliestTransaction() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();

        // Alice: high up along the trajectory, submitted first.
        (int256 farX, int256 farY) = pointOnTrajectory(attackId, 400);
        submitPoint(lobbyId, alice, farX, farY);

        // Bob: close to Earth, submitted one block later.
        vm.roll(block.number + 1);
        (int256 nearX, int256 nearY) = pointOnTrajectory(attackId, 900);
        submitPoint(lobbyId, bob, nearX, nearY);

        completeAndReveal(lobbyId, attackId);

        GameTypes.DefenseAttempt[] memory attempts = lensOf().getDefenseAttempts(lobbyId);
        assertTrue(attempts[0].intercepted);
        assertTrue(attempts[1].intercepted);
        assertLt(attempts[1].arrivalBlockScaled, attempts[0].arrivalBlockScaled, "bob's interceptor arrives first");

        (, GameTypes.Outcome memory outcome) = lensOf().getOutcome(lobbyId);
        assertEq(outcome.winners.length, 1);
        assertEq(outcome.winners[0], bob);
        assertEq(outcome.winningArrivalBlockScaled, attempts[1].arrivalBlockScaled);
    }

    /// Identical arrivals have nothing left to rank by, so the pool splits.
    function test_exactTie_splitsBetweenBothWinners() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();

        (int256 x, int256 y) = pointOnTrajectory(attackId, 500);
        submitPoint(lobbyId, alice, x, y);
        submitPoint(lobbyId, bob, x, y); // same block, same point

        completeAndReveal(lobbyId, attackId);

        (, GameTypes.Outcome memory outcome) = lensOf().getOutcome(lobbyId);
        assertTrue(outcome.intercepted);
        assertEq(outcome.winners.length, 2);

        (GameTypes.Lobby memory lobby,,) = lensOf().getLobby(lobbyId);
        assertEq(outcome.rewardPerWinner, uint256(lobby.rewardPool) / 2);
    }

    /// Several interceptors: everyone who stopped it is recorded, one of them won.
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

        (int256 x1, int256 y1) = pointOnTrajectory(attackId, 200);
        (int256 x2, int256 y2) = pointOnTrajectory(attackId, 500);
        (int256 x3, int256 y3) = pointOnTrajectory(attackId, 800);
        submitPoint(lobbyId, alice, x1, y1);
        submitPoint(lobbyId, bob, x2, y2);
        submitPoint(lobbyId, carol, x3, y3);

        completeAndReveal(lobbyId, attackId);

        GameTypes.DefenseAttempt[] memory attempts = lensOf().getDefenseAttempts(lobbyId);
        uint256 interceptors;
        uint256 winners;
        for (uint256 i = 0; i < attempts.length; i++) {
            if (attempts[i].intercepted) interceptors++;
            if (attempts[i].isWinner) winners++;
        }
        assertEq(interceptors, 3, "all three points sit on the path");
        assertEq(winners, 1, "only the earliest arrival takes it");

        // Carol placed the point nearest Earth, so her interceptor is on
        // station first even though everybody submitted in the same block.
        (, GameTypes.Outcome memory outcome) = lensOf().getOutcome(lobbyId);
        assertEq(outcome.winners[0], carol);
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

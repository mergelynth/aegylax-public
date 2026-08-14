// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {AegylaxTest} from "./AegylaxTest.t.sol";
import {AegylaxGame} from "../src/AegylaxGame.sol";
import {GameTypes} from "../src/libraries/GameTypes.sol";
import {Geometry} from "../src/libraries/Geometry.sol";
import {Resolution} from "../src/libraries/Resolution.sol";

/// Completion, commitment/reveal, and everything that must not be revealable early.
contract RevealTest is AegylaxTest {
    function test_hiddenData_isUnavailableForTheWholeFlight() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        (int256 x, int256 y) = pointOnTrajectory(attackId, 500);
        submitPoint(lobbyId, alice, x, y);

        (bool revealed, GameTypes.Trajectory memory traj) = lensOf().getTrajectory(attackId);
        assertFalse(revealed);
        assertEq(traj.startX, 0);

        // Not even the defender's own submitted point is in the public read.
        GameTypes.DefenseAttempt[] memory attempts = lensOf().getDefenseAttempts(lobbyId);
        assertEq(attempts.length, 1);
        assertFalse(attempts[0].revealed);
        assertEq(attempts[0].x, 0);
        assertEq(attempts[0].y, 0);
        assertTrue(attempts[0].pointHandle != bytes32(0));
    }

    function test_complete_rejectedBeforeImpact() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        GameTypes.Attack memory attack = attackOf(attackId);

        vm.roll(attack.impactBlock - 1);
        vm.expectRevert(AegylaxGame.AttackNotLanded.selector);
        game.completeAttack(attack.epochId);
    }

    function test_complete_isPermissionlessAndUnlocksDecryption() public {
        (, bytes32 attackId) = startedLobby();
        GameTypes.Attack memory attack = attackOf(attackId);

        vm.roll(attack.impactBlock);
        vm.prank(address(0xDEAD));
        game.completeAttack(attack.epochId);

        assertTrue(engine.unlocked(attack.bearingHandle));
        assertTrue(engine.unlocked(attack.deltaHandle));
    }

    function test_complete_cannotRunTwice() public {
        (, bytes32 attackId) = startedLobby();
        GameTypes.Attack memory attack = attackOf(attackId);
        vm.roll(attack.impactBlock);
        game.completeAttack(attack.epochId);

        vm.expectRevert(AegylaxGame.WrongAttackStatus.selector);
        game.completeAttack(attack.epochId);
    }

    function test_reveal_rejectedBeforeCompletion() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        vm.roll(attackOf(attackId).impactBlock + 1);

        (GameTypes.DecryptionProof memory bearing, GameTypes.DecryptionProof memory delta,) =
            proofsFor(lobbyId, attackId);
        // Read the epoch *before* arming the revert: `expectRevert` applies to
        // the next call, and a lens read in the argument list would be it.
        uint32 epochId = attackOf(attackId).epochId;

        vm.expectRevert(AegylaxGame.RevealNotUnlocked.selector);
        game.revealEpochAttack(epochId, bearing, delta);
    }

    /**
     * The commitment check, which is the whole security of the reveal: the
     * handles were fixed when the attack was generated, so a caller cannot
     * substitute a trajectory that suits them.
     */
    function test_reveal_rejectsAnInventedTrajectory() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        landAttack(attackId);

        (GameTypes.DecryptionProof memory bearing, GameTypes.DecryptionProof memory delta,) =
            proofsFor(lobbyId, attackId);

        uint32 epochId = attackOf(attackId).epochId;
        bearing.value = bearing.value == 0 ? 1 : bearing.value - 1;
        vm.expectRevert(abi.encodeWithSelector(AegylaxGame.InvalidDecryptionProof.selector, 0));
        game.revealEpochAttack(epochId, bearing, delta);
    }

    function test_reveal_rejectsAnInventedDefensePoint() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        timedSubmitOnTrajectory(lobbyId, attackId, alice, 400);

        landAttack(attackId);
        game.unlockDefenses(lobbyId);
        revealEpoch(lobbyId, attackId);

        (,, GameTypes.DecryptionProof[] memory defenses) = proofsFor(lobbyId, attackId);

        // A defender who lost cannot move their point onto the trajectory.
        (int256 px, int256 py) = pointOnTrajectory(attackId, 400);
        defenses[0].value = Geometry.packPoint(uint256(px), uint256(py) + 1);
        vm.expectRevert(abi.encodeWithSelector(Resolution.InvalidDecryptionProof.selector, 0));
        game.resolveLobby(lobbyId, defenses);
    }

    function test_reveal_rejectsWrongProofCount() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        timedSubmitOnTrajectory(lobbyId, attackId, alice, 400);

        landAttack(attackId);
        game.unlockDefenses(lobbyId);
        revealEpoch(lobbyId, attackId);

        GameTypes.DecryptionProof[] memory none = new GameTypes.DecryptionProof[](0);

        vm.expectRevert(AegylaxGame.ProofCountMismatch.selector);
        game.resolveLobby(lobbyId, none);
    }

    function test_reveal_publishesTheTrajectoryForEveryone() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        completeAndReveal(lobbyId, attackId);

        (bool revealed, GameTypes.Trajectory memory traj) = lensOf().getTrajectory(attackId);
        assertTrue(revealed);
        assertEq(traj.lengthWu, trajectoryOf(attackId).lengthWu);
        assertEq(traj.startX, trajectoryOf(attackId).startX);

        // ТЗ §4: the speed is derived from the distance and the flight time,
        // so the threat reaches its target exactly at impact.
        GameTypes.Attack memory attack = attackOf(attackId);
        assertEq(traj.speedWuPerBlock, traj.lengthWu / attack.flightBlocks);

        // The trajectory is published for the world whether or not this
        // particular team did anything with it — and this one did not, so it
        // ends UNPLAYED and its money goes back (ТЗ §18). What the reveal
        // publishes is a fact about the epoch, not a verdict on the room.
        (GameTypes.Lobby memory lobby,,) = lensOf().getLobby(lobbyId);
        assertEq(uint8(lobby.ending), uint8(GameTypes.Ending.UNPLAYED));
    }

    /// The first reveal is the only one; ТЗ §3 asks for exactly this.
    function test_reveal_cannotBeRepeated() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        completeAndReveal(lobbyId, attackId);

        (GameTypes.DecryptionProof memory bearing, GameTypes.DecryptionProof memory delta,) =
            proofsFor(lobbyId, attackId);
        uint32 epochId = attackOf(attackId).epochId;

        vm.expectRevert(AegylaxGame.AlreadyRevealed.selector);
        game.revealEpochAttack(epochId, bearing, delta);
    }

    function test_reveal_isPermissionless() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        landAttack(attackId);

        (GameTypes.DecryptionProof memory bearing, GameTypes.DecryptionProof memory delta,) =
            proofsFor(lobbyId, attackId);

        // Somebody with no stake in any operation on this epoch can open the
        // threat for the whole world.
        vm.prank(address(0xBEEF));
        game.revealEpochAttack(attackOf(attackId).epochId, bearing, delta);

        (bool revealed,) = lensOf().getTrajectory(attackId);
        assertTrue(revealed);
    }

    /**
     * The point of moving the attack to the epoch: two teams, one threat.
     *
     * Both operations face the same trajectory, both are scored on their own
     * defenders, and both pay out of their own pool — so both can have a
     * winner without ever having competed for the same money.
     */
    function test_reveal_servesEveryTeamOnTheEpoch() public {
        bytes32 firstLobby = createLobby();
        join(firstLobby, alice);
        join(firstLobby, bob);

        bytes32 secondLobby = createLobby();
        join(secondLobby, alice);
        join(secondLobby, bob);

        // Both close their applications in the same epoch, which is what
        // binds them to the same threat.
        closeApplications();
        game.startOperation(firstLobby);
        game.startOperation(secondLobby);

        (GameTypes.Lobby memory first,,) = lensOf().getLobby(firstLobby);
        (GameTypes.Lobby memory second,,) = lensOf().getLobby(secondLobby);
        bytes32 attackId = first.attackId;
        assertEq(second.attackId, attackId, "both teams defend the epoch's one attack");

        vm.roll(rendezvousBlock(attackId, 500));
        (int256 x, int256 y) = pointOnTrajectory(attackId, 500);
        submitPoint(firstLobby, alice, x, y);
        submitPoint(secondLobby, bob, x, y);

        landAttack(attackId);
        game.unlockDefenses(firstLobby);
        game.unlockDefenses(secondLobby);
        revealEpoch(firstLobby, attackId);

        (,, GameTypes.DecryptionProof[] memory firstProofs) = proofsFor(firstLobby, attackId);
        game.resolveLobby(firstLobby, firstProofs);
        (,, GameTypes.DecryptionProof[] memory secondProofs) = proofsFor(secondLobby, attackId);
        game.resolveLobby(secondLobby, secondProofs);

        (, GameTypes.Outcome memory firstOutcome) = lensOf().getOutcome(firstLobby);
        (, GameTypes.Outcome memory secondOutcome) = lensOf().getOutcome(secondLobby);
        assertTrue(firstOutcome.intercepted);
        assertTrue(secondOutcome.intercepted);
        assertEq(firstOutcome.winners[0], alice);
        assertEq(secondOutcome.winners[0], bob);
    }

    function test_revealedDefensePoints_becomePublic() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        (int256 x, int256 y) = pointOnTrajectory(attackId, 600);
        submitPoint(lobbyId, alice, x, y);
        completeAndReveal(lobbyId, attackId);

        GameTypes.DefenseAttempt[] memory attempts = lensOf().getDefenseAttempts(lobbyId);
        assertTrue(attempts[0].revealed);
        assertEq(attempts[0].x, x);
        assertEq(attempts[0].y, y);
    }

    /// An operation nobody reveals must not hold its players' money forever.
    function test_expire_refundsWhenNobodyReveals() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        GameTypes.Attack memory attack = attackOf(attackId);

        vm.roll(attack.impactBlock + defaultParams().revealGraceBlocks);
        game.expireAttack(lobbyId);

        (GameTypes.Lobby memory lobby,,) = lensOf().getLobby(lobbyId);
        assertEq(uint8(lobby.status), uint8(GameTypes.LobbyStatus.CANCELLED));

        uint256 before = alice.balance;
        vm.prank(alice);
        game.claimRefund(lobbyId);
        assertEq(alice.balance, before + joinCost());
    }

    /**
     * Expiry hands back everything, including the protocol's own fee — so
     * the contract must still be able to pay every refund it owes after the
     * owner has swept the treasury.
     */
    function test_expire_leavesTheContractSolvent() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        vm.roll(attackOf(attackId).impactBlock + defaultParams().revealGraceBlocks);
        game.expireAttack(lobbyId);

        (,,,,,, uint256 treasury) = lensOf().getStats();
        vm.prank(owner);
        game.withdrawProtocolFees(payable(owner), treasury);

        vm.prank(alice);
        game.claimRefund(lobbyId);
        vm.prank(bob);
        game.claimRefund(lobbyId);
        vm.prank(creator);
        game.settleCreator(lobbyId);

        assertEq(address(game).balance, 0, "every wei paid in came back out");
    }

    function test_expire_rejectedInsideTheGraceWindow() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        vm.roll(attackOf(attackId).impactBlock + 1);

        vm.expectRevert(AegylaxGame.AttackNotLanded.selector);
        game.expireAttack(lobbyId);
    }

    function test_expire_rejectedAfterAReveal() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        completeAndReveal(lobbyId, attackId);

        vm.roll(block.number + defaultParams().revealGraceBlocks);
        vm.expectRevert(AegylaxGame.AlreadyRevealed.selector);
        game.expireAttack(lobbyId);
    }

    // -----------------------------------------------------------------
    // The two-call reveal (`unlockRound` / `revealAndResolve`)
    // -----------------------------------------------------------------

    /**
     * The whole point: the same end state the four separate calls produce,
     * reached in two transactions.
     *
     * The unlock has to be its own transaction because a client fetches the
     * covalidator's attested plaintexts *between* the two — a signature over
     * a value nobody has been allowed to decrypt yet does not exist. Here the
     * mock engine plays the covalidator, and `proofsFor` is read after the
     * unlock for exactly that reason.
     */
    function test_twoCallReveal_producesTheSameResultAsFourCalls() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        timedSubmitOnTrajectory(lobbyId, attackId, alice, 400);

        vm.roll(attackOf(attackId).impactBlock + 1);

        game.unlockRound(lobbyId);
        (
            GameTypes.DecryptionProof memory bearing,
            GameTypes.DecryptionProof memory delta,
            GameTypes.DecryptionProof[] memory defenses
        ) = proofsFor(lobbyId, attackId);
        game.revealAndResolve(lobbyId, bearing, delta, defenses);

        (bool revealed, GameTypes.Trajectory memory traj) = lensOf().getTrajectory(attackId);
        assertTrue(revealed, "the epoch's geometry is public");
        assertEq(traj.startX, trajectoryOf(attackId).startX);

        (, GameTypes.Outcome memory outcome) = lensOf().getOutcome(lobbyId);
        assertTrue(outcome.resolvedAtBlock != 0, "the team is scored");
        assertTrue(outcome.intercepted, "a point on the line intercepts");
        assertEq(outcome.winners.length, 1);
        assertEq(outcome.winners[0], alice);
    }

    /// Both halves are permissionless — a passer-by can finish anybody's round.
    function test_twoCallReveal_isPermissionless() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        vm.roll(attackOf(attackId).impactBlock + 1);

        vm.prank(address(0xDEAD));
        game.unlockRound(lobbyId);

        (
            GameTypes.DecryptionProof memory bearing,
            GameTypes.DecryptionProof memory delta,
            GameTypes.DecryptionProof[] memory defenses
        ) = proofsFor(lobbyId, attackId);

        vm.prank(address(0xDEAD));
        game.revealAndResolve(lobbyId, bearing, delta, defenses);

        (, GameTypes.Outcome memory outcome) = lensOf().getOutcome(lobbyId);
        assertTrue(outcome.resolvedAtBlock != 0);
    }

    /**
     * Losing the race is the ordinary outcome, not a failure.
     *
     * Several clients send the reveal at once by design, so both halves must
     * skip what somebody else has already done rather than revert on it —
     * otherwise the second player to press gets an error for a round that
     * finished correctly.
     */
    function test_twoCallReveal_isIdempotent() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        timedSubmitOnTrajectory(lobbyId, attackId, alice, 400);

        completeAndReveal(lobbyId, attackId);
        (, GameTypes.Outcome memory first) = lensOf().getOutcome(lobbyId);

        (
            GameTypes.DecryptionProof memory bearing,
            GameTypes.DecryptionProof memory delta,
            GameTypes.DecryptionProof[] memory defenses
        ) = proofsFor(lobbyId, attackId);

        // Everything is already done; neither call may revert, and neither
        // may score the team a second time.
        game.unlockRound(lobbyId);
        game.revealAndResolve(lobbyId, bearing, delta, defenses);

        (, GameTypes.Outcome memory second) = lensOf().getOutcome(lobbyId);
        assertEq(second.resolvedAtBlock, first.resolvedAtBlock, "not re-scored");
        assertEq(second.winners.length, first.winners.length);
    }

    /**
     * A team whose epoch another operation already published still has to be
     * scored — and must not pay for republishing geometry that is public.
     */
    function test_revealAndResolve_scoresATeamOnAnAlreadyRevealedEpoch() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        vm.roll(attackOf(attackId).impactBlock + 1);

        // Somebody else landed and published the epoch first.
        game.completeAttack(attackOf(attackId).epochId);
        revealEpoch(lobbyId, attackId);

        game.unlockRound(lobbyId);
        (
            GameTypes.DecryptionProof memory bearing,
            GameTypes.DecryptionProof memory delta,
            GameTypes.DecryptionProof[] memory defenses
        ) = proofsFor(lobbyId, attackId);
        game.revealAndResolve(lobbyId, bearing, delta, defenses);

        (, GameTypes.Outcome memory outcome) = lensOf().getOutcome(lobbyId);
        assertTrue(outcome.resolvedAtBlock != 0);
    }

    /// The flight is still the flight: neither half opens anything early.
    function test_unlockRound_rejectedBeforeImpact() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        vm.roll(attackOf(attackId).impactBlock - 1);

        vm.expectRevert(AegylaxGame.AttackNotLanded.selector);
        game.unlockRound(lobbyId);
    }

    /// `resolveLobby`'s rule is unchanged when it is reached through the batch.
    function test_revealAndResolve_stillRequiresOneProofPerAttempt() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        timedSubmitOnTrajectory(lobbyId, attackId, alice, 400);

        vm.roll(attackOf(attackId).impactBlock + 1);
        game.unlockRound(lobbyId);

        (GameTypes.DecryptionProof memory bearing, GameTypes.DecryptionProof memory delta,) =
            proofsFor(lobbyId, attackId);
        GameTypes.DecryptionProof[] memory none = new GameTypes.DecryptionProof[](0);

        vm.expectRevert(AegylaxGame.ProofCountMismatch.selector);
        game.revealAndResolve(lobbyId, bearing, delta, none);
    }
}

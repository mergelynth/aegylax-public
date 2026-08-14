// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {AegylaxTest} from "./AegylaxTest.t.sol";
import {AegylaxGame} from "../src/AegylaxGame.sol";
import {GameTypes} from "../src/libraries/GameTypes.sol";

/// A contract that tries to re-enter `claimReward` while being paid.
contract ReentrantWinner {
    AegylaxGame public game;
    bytes32 public lobbyId;
    uint256 public reentryAttempts;

    function configure(AegylaxGame game_, bytes32 lobbyId_) external {
        game = game_;
        lobbyId = lobbyId_;
    }

    function join(uint256 value) external payable {
        game.joinLobby{value: value}(lobbyId);
    }

    function defend(bytes calldata ciphertext) external {
        game.submitDefense(lobbyId, ciphertext);
    }

    function claim() external {
        game.claimReward(lobbyId);
    }

    receive() external payable {
        if (reentryAttempts == 0) {
            reentryAttempts = 1;
            // Should fail: the guard is up and the claim flag is already set.
            try game.claimReward(lobbyId) {
                revert("reentered");
            } catch {}
        }
    }
}

/// Rewards, refunds, creator settlement, protocol fees — and who may take what.
contract PayoutsTest is AegylaxTest {
    function test_winner_claimsTheWholePool() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        timedSubmitOnTrajectory(lobbyId, attackId, alice, 700);
        completeAndReveal(lobbyId, attackId);

        (GameTypes.Lobby memory lobby,,) = lensOf().getLobby(lobbyId);
        uint256 before = alice.balance;

        vm.prank(alice);
        game.claimReward(lobbyId);

        assertEq(alice.balance, before + lobby.rewardPool);
    }

    function test_reward_cannotBeClaimedTwice() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        timedSubmitOnTrajectory(lobbyId, attackId, alice, 700);
        completeAndReveal(lobbyId, attackId);

        vm.prank(alice);
        game.claimReward(lobbyId);

        vm.prank(alice);
        vm.expectRevert(AegylaxGame.AlreadyClaimed.selector);
        game.claimReward(lobbyId);
    }

    function test_loser_cannotClaim() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();

        timedSubmitOnTrajectory(lobbyId, attackId, alice, 700);
        submitPoint(lobbyId, bob, 500_000_000, 500_000_000);

        completeAndReveal(lobbyId, attackId);

        vm.prank(bob);
        vm.expectRevert(AegylaxGame.NothingToClaim.selector);
        game.claimReward(lobbyId);
    }

    function test_nonParticipant_cannotClaim() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        timedSubmitOnTrajectory(lobbyId, attackId, alice, 700);
        completeAndReveal(lobbyId, attackId);

        vm.prank(carol);
        vm.expectRevert(AegylaxGame.NotParticipant.selector);
        game.claimReward(lobbyId);
    }

    function test_claim_rejectedBeforeReveal() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        timedSubmitOnTrajectory(lobbyId, attackId, alice, 700);

        landAttack(attackId);

        vm.prank(alice);
        vm.expectRevert(AegylaxGame.WrongLobbyStatus.selector);
        game.claimReward(lobbyId);
    }

    function test_claim_isNotReentrant() public {
        bytes32 lobbyId = createLobby();
        ReentrantWinner attacker = new ReentrantWinner();
        vm.deal(address(attacker), 10 ether);
        attacker.configure(game, lobbyId);

        attacker.join(joinCost());
        join(lobbyId, bob);

        closeApplications();
        game.startOperation(lobbyId);
        (GameTypes.Lobby memory lobby,,) = lensOf().getLobby(lobbyId);
        bytes32 attackId = lobby.attackId;
        vm.roll(attackOf(attackId).launchBlock);

        (int256 x, int256 y) = pointOnTrajectory(attackId, 700);
        vm.roll(rendezvousBlock(attackId, 700));
        attacker.defend(engine.unsafeEncode(uint256(x) | (uint256(y) << 128)));

        completeAndReveal(lobbyId, attackId);

        uint256 poolBefore = address(game).balance;
        attacker.claim();

        // Exactly one payout left the contract, and the re-entry was tried.
        (, GameTypes.Outcome memory outcome) = lensOf().getOutcome(lobbyId);
        assertEq(attacker.reentryAttempts(), 1);
        assertEq(address(game).balance, poolBefore - outcome.rewardPerWinner);
    }

    function test_creator_isPaidTheFeeWhateverTheOutcome() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        timedSubmitOnTrajectory(lobbyId, attackId, alice, 700);
        completeAndReveal(lobbyId, attackId);

        (GameTypes.Lobby memory lobby,,) = lensOf().getLobby(lobbyId);
        uint256 before = creator.balance;

        vm.prank(creator);
        game.settleCreator(lobbyId);

        // Fee, plus whatever dust the split left behind.
        assertGe(creator.balance, before + lobby.creatorFeeAccrued);
    }

    /**
     * A miss pays the creator their fee, their bounty and what was spent on
     * recon — but not the entry money, which goes back to the defenders
     * (ТЗ §2).
     */
    /**
     * ТЗ §17-18 — an unwon pool goes to the Global Defense Pool, not home.
     *
     * The rule this replaces gave the creator their bounty and the probe money
     * back whenever the threat got through, which made a large advertised
     * prize costless to promise: it only ever left the creator's hands if
     * somebody earned it. Now a COMPLETED round is delivered whatever its
     * result — the creator keeps the fee they earned for filling the room, and
     * the pool, having no winner, is held by the protocol to be played for
     * again.
     */
    function test_unwonPool_goesToTheGlobalDefensePool() public {
        (bytes32 lobbyId, bytes32 attackId) = scheduledLobby();

        vm.prank(alice);
        game.buyProbes{value: PROBE_PRICE}(lobbyId, 1);

        vm.roll(attackOf(attackId).launchBlock);
        submitPoint(lobbyId, alice, 100_000_000, 100_000_000);

        (GameTypes.Lobby memory before,,) = lensOf().getLobby(lobbyId);
        uint256 pooled = before.rewardPool;
        assertGt(pooled, 0);

        completeAndReveal(lobbyId, attackId);

        (, GameTypes.Outcome memory outcome) = lensOf().getOutcome(lobbyId);
        assertFalse(outcome.intercepted, "a point that far off must not intercept");

        (GameTypes.Lobby memory lobby,,) = lensOf().getLobby(lobbyId);
        assertEq(uint8(lobby.ending), uint8(GameTypes.Ending.COMPLETED), "the round was played and lost");
        // The pool left the operation entirely, so nothing can double-count it.
        assertEq(lobby.rewardPool, 0);
        assertEq(lensOf().getGlobalDefensePool(), pooled);

        // The creator is paid for filling the room and nothing else.
        uint256 creatorBefore = creator.balance;
        vm.prank(creator);
        game.settleCreator(lobbyId);
        assertEq(creator.balance, creatorBefore + lobby.creatorFeeAccrued);
    }

    /**
     * The other half of the same rule: a defender who lost gets nothing back.
     *
     * An entry fee that comes home when the threat lands is not a stake, and a
     * round whose downside is a rounding error is not a game. A COMPLETED
     * round was delivered — the sky was crossed, the probes answered, the
     * defense was scored — and there is nothing left undelivered to refund.
     */
    function test_defenders_getNothingBackWhenTheRoundWasPlayed() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        submitPoint(lobbyId, alice, 100_000_000, 100_000_000);
        completeAndReveal(lobbyId, attackId);

        vm.prank(alice);
        vm.expectRevert(AegylaxGame.NothingToClaim.selector);
        game.claimRefund(lobbyId);

        // Not even the defender who never acted: the round still ran.
        vm.prank(bob);
        vm.expectRevert(AegylaxGame.NothingToClaim.selector);
        game.claimRefund(lobbyId);
    }

    /**
     * The miss path, to the wei.
     *
     * Money moving to a *pool* rather than out to an address is exactly the
     * kind of change that strands wei or invents them, because the pool is a
     * number in storage rather than a balance the EVM keeps for you. So the
     * contract's balance afterwards has to be precisely the two things it is
     * still holding for somebody: the protocol's fees, and the Global Defense
     * Pool.
     */
    function test_solvency_whenNobodyIntercepts() public {
        // Probes are bought in the preparation window, before the launch.
        (bytes32 lobbyId, bytes32 attackId) = scheduledLobby();

        vm.prank(alice);
        game.buyProbes{value: PROBE_PRICE}(lobbyId, 1);

        vm.roll(attackOf(attackId).launchBlock);
        submitPoint(lobbyId, alice, 100_000_000, 100_000_000);
        completeAndReveal(lobbyId, attackId);

        vm.prank(creator);
        game.settleCreator(lobbyId);

        (,,,,,, uint256 treasury) = lensOf().getStats();
        assertEq(address(game).balance, treasury + lensOf().getGlobalDefensePool());
    }

    /**
     * ТЗ §18 — a room the attack flew over is not a room that lost.
     *
     * Nobody sent a probe and nobody submitted a defense, so there was no
     * contest for the pool to be the prize of. Charging for that would be
     * charging for a game that never started, so the ending is UNPLAYED and
     * every wei goes back — including the probe money, which was bought and
     * never spent.
     */
    function test_aRoundNobodyPlayed_refundsEverything() public {
        (bytes32 lobbyId, bytes32 attackId) = scheduledLobby();

        vm.prank(alice);
        game.buyProbes{value: PROBE_PRICE}(lobbyId, 1);

        vm.roll(attackOf(attackId).launchBlock);
        // Deliberately no probe and no defense from anybody.
        completeAndReveal(lobbyId, attackId);

        (GameTypes.Lobby memory lobby,,) = lensOf().getLobby(lobbyId);
        assertEq(uint8(lobby.ending), uint8(GameTypes.Ending.UNPLAYED));
        assertEq(lensOf().getGlobalDefensePool(), 0, "an unplayed round forfeits nothing");

        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        game.claimRefund(lobbyId);
        assertEq(alice.balance, aliceBefore + joinCost() + PROBE_PRICE);

        uint256 bobBefore = bob.balance;
        vm.prank(bob);
        game.claimRefund(lobbyId);
        assertEq(bob.balance, bobBefore + joinCost());

        uint256 creatorBefore = creator.balance;
        vm.prank(creator);
        game.settleCreator(lobbyId);
        assertEq(creator.balance, creatorBefore + createCost(), "the bounty and the creator's own seat fee");

        assertEq(address(game).balance, 0, "every wei paid in came back out");
    }

    function test_creatorSettlement_isOncePerOperation() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        completeAndReveal(lobbyId, attackId);

        vm.prank(creator);
        game.settleCreator(lobbyId);

        vm.prank(creator);
        vm.expectRevert(AegylaxGame.AlreadyClaimed.selector);
        game.settleCreator(lobbyId);
    }

    function test_settlement_isCreatorOnly() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        completeAndReveal(lobbyId, attackId);

        vm.prank(bob);
        vm.expectRevert(AegylaxGame.NotCreator.selector);
        game.settleCreator(lobbyId);
    }

    /// Everything that came in leaves again, and nothing more.
    function test_solvency_acrossAFullOperation() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        timedSubmitOnTrajectory(lobbyId, attackId, alice, 700);
        completeAndReveal(lobbyId, attackId);

        vm.prank(alice);
        game.claimReward(lobbyId);
        vm.prank(creator);
        game.settleCreator(lobbyId);

        (,,,,, uint256 treasury) = protocolStats();
        // Whatever is left in the contract is exactly the protocol's own fees.
        assertEq(address(game).balance, treasury);

        vm.prank(owner);
        game.withdrawProtocolFees(payable(owner), treasury);
        assertEq(address(game).balance, 0);
    }

    function test_protocolFees_areOwnerOnly() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        completeAndReveal(lobbyId, attackId);

        vm.prank(bob);
        vm.expectRevert();
        game.withdrawProtocolFees(payable(bob), 1);
    }

    function protocolStats()
        internal
        view
        returns (uint64, uint64, uint64, uint64, uint64, uint256)
    {
        (
            uint64 totalLobbies,
            uint64 activeLobbies,
            uint64 totalAttacks,
            uint64 intercepted,
            uint64 missed,
            ,
            uint256 treasury
        ) = lensOf().getStats();
        return (totalLobbies, activeLobbies, totalAttacks, intercepted, missed, treasury);
    }
}

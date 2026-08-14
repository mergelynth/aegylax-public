// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {AegylaxTest} from "./AegylaxTest.t.sol";
import {AegylaxGame} from "../src/AegylaxGame.sol";
import {GameTypes} from "../src/libraries/GameTypes.sol";
import {Lobbies} from "../src/libraries/Lobbies.sol";

/**
 * The Global Defense Pool (ТЗ §18).
 *
 * The pool is where a round the threat won sends its money: nobody in that
 * operation earned it, and the creator does not get it back. Every
 * `globalDefenseEpochInterval` epochs the protocol opens an operation of its
 * own with the whole accumulated pool as the bounty, free to enter, and
 * whoever intercepts that epoch's threat takes all of it.
 *
 * The property worth testing hardest is the one with no code behind it: there
 * is no "the draw failed" branch anywhere in the contract, because every way a
 * draw can fail is already an ordinary rule. A draw nobody wins is a COMPLETED
 * round with no winner, so its pool is forfeited back to the Global Defense
 * Pool by the same line that filled it. A draw nobody joins is UNPLAYED, and
 * its settlement returns the bounty to the pool because the protocol is its
 * creator. Both are asserted below, because a rule that works by not existing
 * is exactly the kind that quietly stops working.
 */
contract GlobalDefenseTest is AegylaxTest {
    /// Plays one ordinary round to a miss, so the pool has something in it.
    function _forfeitOnePool() internal returns (uint256 forfeited) {
        uint256 poolBefore = lensOf().getGlobalDefensePool();

        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        submitPoint(lobbyId, alice, 100_000_000, 100_000_000);

        (GameTypes.Lobby memory running,,) = lensOf().getLobby(lobbyId);
        forfeited = running.rewardPool;

        completeAndReveal(lobbyId, attackId);
        assertEq(lensOf().getGlobalDefensePool(), poolBefore + forfeited);
    }

    /// The draw is free to enter — entry is 0 and the seat fee is waived.
    function _joinDraw(bytes32 drawId, address who) internal {
        vm.prank(who);
        game.joinLobby{value: 0}(drawId);
    }

    function _closeDraw(bytes32 drawId) internal {
        (, GameTypes.LobbyConfig memory config,) = lensOf().getLobby(drawId);
        if (block.number < config.registrationDeadlineBlock) {
            uint256 delta = uint256(config.registrationDeadlineBlock) - block.number + 1;
            vm.roll(uint256(config.registrationDeadlineBlock) + 1);
            vm.warp(block.timestamp + delta * 2);
        }
    }

    function test_pool_isFedByEveryRoundTheThreatWins() public {
        // This test is about accumulation, not the draw. A player operation
        // that skips a too-close launch boundary can roll far enough that
        // `maybeOpenDraw` siphons the pool into a lobby mid-assertion.
        vm.prank(owner);
        game.setGlobalDefenseInterval(0);

        uint256 first = _forfeitOnePool();
        assertGt(first, 0);

        // A second lost round adds to it rather than replacing it.
        uint256 second = _forfeitOnePool();
        assertEq(lensOf().getGlobalDefensePool(), first + second);
    }

    /**
     * The pool is not the treasury, and no owner call can reach it.
     *
     * This is the one invariant that would be a theft rather than a bug. The
     * treasury is revenue the owner may withdraw; the pool is players' money
     * the protocol has promised back to the game.
     */
    function test_pool_isNotWithdrawableByTheOwner() public {
        uint256 pooled = _forfeitOnePool();

        (uint256 withdrawable,,) = lensOf().getTreasury();
        assertLt(withdrawable, pooled, "the pool must not be counted as protocol income");

        vm.prank(owner);
        vm.expectRevert();
        game.withdrawProtocolFees(payable(owner), withdrawable + pooled);
    }

    /**
     * The epoch is derived, not chosen.
     *
     * There is exactly one epoch this call can legally open at any moment, so
     * letting a caller name one only creates ways to name the wrong one. The
     * lens reports the same epoch the contract will use.
     */
    function test_draw_opensTheNextIntervalEpoch() public {
        _forfeitOnePool();

        (uint32 nextEpoch,,,) = lensOf().getGlobalDefenseDraw();
        assertEq(nextEpoch % DRAW_INTERVAL, 0);

        (bytes32 drawId, uint32 opened) = openDrawWhenDue();
        assertEq(opened, nextEpoch);
        (GameTypes.Lobby memory draw,,) = lensOf().getLobby(drawId);
        assertEq(draw.epochId, nextEpoch);
    }

    /// With the cadence off, the pool simply accumulates and cannot be drawn.
    function test_draw_isRefusedWhenTheCadenceIsOff() public {
        _forfeitOnePool();
        vm.prank(owner);
        game.setGlobalDefenseInterval(0);

        vm.expectRevert(Lobbies.NotADrawEpoch.selector);
        game.openGlobalDefense();
    }

    function test_draw_takesTheWholePoolAndCannotBeOpenedTwice() public {
        uint256 pooled = _forfeitOnePool();

        (uint32 nextEpoch,,,) = lensOf().getGlobalDefenseDraw();
        (bytes32 drawId, uint32 opened) = openDrawWhenDue();
        assertEq(opened, nextEpoch);

        (GameTypes.Lobby memory draw, GameTypes.LobbyConfig memory config,) = lensOf().getLobby(drawId);
        assertEq(draw.creator, address(game), "the protocol owns its own draw");
        assertEq(draw.rewardPool, pooled, "the whole pool is the bounty");
        assertEq(config.entryPrice, 0, "free to enter: it is already the players' money");
        assertEq(config.creatorFeeBps, 0, "nobody takes a cut of it");
        assertEq(config.maxPlayers, defaultParams().maxPlayers, "draw uses the protocol ceiling, not a smaller cap");
        assertEq(draw.epochId, nextEpoch);

        // Drained as it moves, so the pool and the operation never both hold it.
        assertEq(lensOf().getGlobalDefensePool(), 0);

        vm.expectRevert(Lobbies.DrawAlreadyOpen.selector);
        game.openGlobalDefense();
    }

    function test_draw_joinIsFree_seatFeeIsRefused() public {
        _forfeitOnePool();
        (bytes32 drawId,) = openDrawWhenDue();

        uint256 before = alice.balance;
        vm.prank(alice);
        game.joinLobby{value: 0}(drawId);
        assertEq(alice.balance, before, "sitting in the draw costs nothing");

        (GameTypes.Lobby memory draw,,) = lensOf().getLobby(drawId);
        assertEq(draw.protocolFeeAccrued, 0);

        vm.prank(bob);
        vm.expectRevert(AegylaxGame.IncorrectPayment.selector);
        game.joinLobby{value: defaultParams().protocolJoinFee}(drawId);
    }

    function test_draw_leaveRefundsProbesOnly() public {
        _forfeitOnePool();
        (bytes32 drawId,) = openDrawWhenDue();

        uint256 bobBefore = bob.balance;
        _joinDraw(drawId, bob);
        vm.prank(bob);
        game.leaveLobby(drawId);
        assertEq(bob.balance, bobBefore, "a free seat refunds nothing");

        _joinDraw(drawId, alice);
        vm.prank(alice);
        game.buyProbes{value: PROBE_PRICE}(drawId, 1);
        uint256 aliceAfterBuy = alice.balance;
        vm.prank(alice);
        game.leaveLobby(drawId);
        assertEq(alice.balance, aliceAfterBuy + PROBE_PRICE);
    }

    function test_draw_needsAPoolToPlayFor() public {
        vm.expectRevert(Lobbies.DrawNotFunded.selector);
        game.openGlobalDefense();
    }

    function test_draw_isRefusedBeforeTheJoinWindow() public {
        _forfeitOnePool();
        vm.expectRevert(Lobbies.DrawNotDue.selector);
        game.openGlobalDefense();
    }

    function test_draw_opensAsASideEffectOfOrdinaryPlay() public {
        _forfeitOnePool();
        warpToDrawWindow();
        (,,, bytes32 before) = lensOf().getGlobalDefenseDraw();
        assertEq(before, bytes32(0));

        createLobby();

        (,,, bytes32 drawId) = lensOf().getGlobalDefenseDraw();
        assertTrue(drawId != bytes32(0), "ordinary play should mint the draw");
        (GameTypes.Lobby memory draw,,) = lensOf().getLobby(drawId);
        assertEq(draw.creator, address(game));
    }

    /**
     * ТЗ §18 — "if the event repeats, refund back into the pool and wait for
     * the next interval", with no code that says so.
     *
     * The draw is scored by the same `resolveLobby` as any other operation, so
     * a draw with no interception is a COMPLETED round with no winner and its
     * pool is forfeited to the Global Defense Pool — which is where it came
     * from. The money is back, undiminished, waiting for the next interval.
     */
    function test_draw_nobodyWins_returnsTheWholePoolToThePool() public {
        uint256 pooled = _forfeitOnePool();

        (uint32 nextEpoch,,,) = lensOf().getGlobalDefenseDraw();
        (bytes32 drawId,) = openDrawWhenDue();
        bytes32 drawAttack = lobbyAttack(drawId);

        _joinDraw(drawId, alice);
        _joinDraw(drawId, bob);
        _closeDraw(drawId);
        vm.roll(attackOf(drawAttack).launchBlock);

        // Somebody played, and missed by a continent.
        submitPoint(drawId, alice, 100_000_000, 100_000_000);
        completeAndReveal(drawId, drawAttack);

        (GameTypes.Lobby memory ended,,) = lensOf().getLobby(drawId);
        assertEq(uint8(ended.ending), uint8(GameTypes.Ending.COMPLETED));
        // Every wei of it, back where it started. The entry fees were zero, so
        // there is nothing else in the pool to account for.
        assertEq(lensOf().getGlobalDefensePool(), pooled);
        // And it is playable again at the next interval, with no special case
        // anywhere for "the draw failed".
        (uint32 afterEpoch,, uint256 poolNow, bytes32 openLobby) = lensOf().getGlobalDefenseDraw();
        assertGt(afterEpoch, nextEpoch);
        assertEq(poolNow, pooled);
        assertEq(openLobby, bytes32(0));
    }

    /**
     * A draw nobody joins is UNPLAYED, and its bounty goes back to the pool
     * rather than to an address — because the address is this contract.
     *
     * `settleCreator` is permissionless in that case for a reason worth
     * stating: the money has to be able to find its way home without the
     * protocol's owner being online to send a transaction.
     */
    function test_draw_nobodyJoins_returnsTheBountyToThePool() public {
        uint256 pooled = _forfeitOnePool();

        (bytes32 drawId,) = openDrawWhenDue();

        _closeDraw(drawId);
        vm.roll(uint256(attackOf(lobbyAttack(drawId)).impactBlock) + 1);
        game.cancelLobby(drawId);

        (GameTypes.Lobby memory ended,,) = lensOf().getLobby(drawId);
        assertEq(uint8(ended.ending), uint8(GameTypes.Ending.UNPLAYED));

        // Anybody may settle it, and nothing is paid out to a wallet.
        uint256 balanceBefore = address(game).balance;
        vm.prank(bob);
        game.settleCreator(drawId);
        assertEq(address(game).balance, balanceBefore, "no wei left the contract");
        assertEq(lensOf().getGlobalDefensePool(), pooled);
    }
}

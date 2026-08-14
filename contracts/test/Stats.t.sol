// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {AegylaxTest} from "./AegylaxTest.t.sol";
import {AegylaxGame} from "../src/AegylaxGame.sol";
import {GameTypes} from "../src/libraries/GameTypes.sol";

/**
 * The protocol's global status line, and the treasury behind it.
 *
 * Two questions, and both used to be answered by a stored counter that could
 * not answer them:
 *
 *   - **how many attacks has the protocol flown?** One per epoch since
 *     genesis, whether or not anybody defended it. The stored counter only
 *     knew about epochs somebody started an operation into, so a protocol
 *     that had run for months with seventeen operations reported seventeen
 *     attacks — as though the sky had been empty in between.
 *   - **how many reached Earth?** Every attack that flew and was not
 *     stopped. `missedAttacks` was in storage and nothing anywhere
 *     incremented it, so it was always zero.
 */
contract StatsTest is AegylaxTest {
    function attacksFlown() internal view returns (uint64 flown) {
        (,, flown,,,,) = lensOf().getStats();
    }

    function impacts() internal view returns (uint64 missed) {
        (,,,, missed,,) = lensOf().getStats();
    }

    function epochNow() internal view returns (uint64 epoch) {
        (,,,,, epoch,) = lensOf().getStats();
    }

    /**
     * The count is the clock, not the activity.
     *
     * Nobody has created anything here; the protocol has simply existed for
     * a while, and every epoch of that is an attack that crossed the sky
     * undefended.
     */
    function test_attacksAreCountedPerEpochEvenWithNoOperations() public {
        assertEq(attacksFlown(), 0, "no epochs have elapsed yet");

        GameTypes.GameParams memory p = defaultParams();
        vm.roll(block.number + uint256(p.epochBlocks) * 7);

        assertEq(epochNow(), 7);
        assertEq(attacksFlown(), 7, "seven epochs, seven attacks");
        assertEq(impacts(), 7, "nobody defended any of them");
    }

    /**
     * An attack still in the air is not yet a result.
     *
     * It has neither been intercepted nor hit, so counting it would put an
     * impact on the board for a threat that is still flying.
     */
    function test_theAttackInFlightIsNotCountedYet() public {
        GameTypes.GameParams memory p = defaultParams();
        vm.roll(block.number + uint256(p.epochBlocks) * 5);

        uint64 beforeStart = attacksFlown();
        assertEq(beforeStart, 5);

        (, bytes32 attackId) = scheduledLobby();
        vm.roll(attackOf(attackId).launchBlock);

        // The current epoch's attack now exists and is airborne, so it drops
        // out of the tally until it lands.
        assertEq(attacksFlown(), epochNow() - 1, "the one in flight is excluded");

        vm.roll(attackOf(attackId).impactBlock);
        assertEq(attacksFlown(), epochNow(), "and counts again once it lands");
    }

    /// An interception moves the threat from the impact column to the intercepted one.
    function test_interceptionMovesTheThreatOutOfTheImpactColumn() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        (int256 x, int256 y) = pointOnTrajectory(attackId, 700);
        submitPoint(lobbyId, alice, x, y);
        completeAndReveal(lobbyId, attackId);

        (,, uint64 flown, uint64 intercepted, uint64 missed,,) = lensOf().getStats();
        assertEq(intercepted, 1);
        assertEq(missed, flown - intercepted, "impacts are the remainder, always");
    }

    /// Impacts are never counted separately — they are whatever was not stopped.
    function test_impactsAreAlwaysTheRemainder() public {
        GameTypes.GameParams memory p = defaultParams();
        vm.roll(block.number + uint256(p.epochBlocks) * 3);

        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        // Far off the path: this team does not stop it.
        submitPoint(lobbyId, alice, 100_000_000, 100_000_000);
        completeAndReveal(lobbyId, attackId);

        (,, uint64 flown, uint64 intercepted, uint64 missed,,) = lensOf().getStats();
        assertEq(intercepted, 0);
        assertEq(missed, flown);
    }

    // -----------------------------------------------------------------
    // Treasury
    // -----------------------------------------------------------------

    /**
     * The owner's reach is the join fees and nothing else (ТЗ §17).
     *
     * `getTreasury` publishes both numbers precisely so this is checkable
     * from an explorer: the withdrawable figure is fed only by the per-join
     * protocol fee, and the difference between it and the contract's balance
     * is every operation's prize pool and entry money — which is not the
     * owner's to move, however the withdrawal is called.
     */
    function test_treasuryIsOnlyEverJoinFees() public {
        (bytes32 lobbyId,) = scheduledLobby();

        (uint256 withdrawable, uint256 balance, uint128 joinFee) = lensOf().getTreasury();
        assertEq(joinFee, defaultParams().protocolJoinFee);
        // Three seats — two defenders and the creator, who pays the same
        // per-seat fee (ТЗ §17) — and applications have closed, which is when
        // the fee stops being refundable and becomes the treasury's.
        assertEq(withdrawable, uint256(joinFee) * 3);
        assertGt(balance, withdrawable, "the pool and the entry money are not the owner's");

        (GameTypes.Lobby memory lobby,,) = lensOf().getLobby(lobbyId);
        assertEq(balance, withdrawable + lobby.rewardPool + lobby.creatorFeeAccrued);
    }

    /// Not one wei past the protocol's own income, even for the owner.
    function test_withdrawalCannotExceedProtocolIncome() public {
        scheduledLobby();

        (uint256 withdrawable,,) = lensOf().getTreasury();
        assertGt(withdrawable, 0);

        vm.prank(owner);
        vm.expectRevert(AegylaxGame.NothingToClaim.selector);
        game.withdrawProtocolFees(payable(owner), withdrawable + 1);

        // And the whole of it is withdrawable, to an address of the owner's
        // choosing — the explorer path this exists for.
        uint256 before = carol.balance;
        vm.prank(owner);
        game.withdrawProtocolFees(payable(carol), withdrawable);

        assertEq(carol.balance, before + withdrawable);
        (uint256 left,,) = lensOf().getTreasury();
        assertEq(left, 0);

        // Draining it does not touch anybody's prize pool.
        assertGt(address(game).balance, 0);
    }

    function test_withdrawalIsOwnerOnly() public {
        scheduledLobby();
        (uint256 withdrawable,,) = lensOf().getTreasury();

        vm.prank(bob);
        vm.expectRevert();
        game.withdrawProtocolFees(payable(bob), withdrawable);
    }
}

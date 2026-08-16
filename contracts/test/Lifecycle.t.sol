// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {AegylaxTest} from "./AegylaxTest.t.sol";
import {AegylaxGame} from "../src/AegylaxGame.sol";
import {GameTypes} from "../src/libraries/GameTypes.sol";
import {ProtocolRules} from "../src/libraries/ProtocolRules.sol";

/// Lobby creation, joining, leaving, starting, cancelling — and the money that moves with each.
contract LifecycleTest is AegylaxTest {
    function test_createLobby_storesConfigAndFundsPool() public {
        bytes32 lobbyId = createLobby();

        (GameTypes.Lobby memory lobby, GameTypes.LobbyConfig memory config, GameTypes.GameParams memory params) =
            lensOf().getLobby(lobbyId);

        assertEq(uint8(lobby.status), uint8(GameTypes.LobbyStatus.OPEN));
        assertEq(lobby.creator, creator);
        assertEq(lobby.rewardPool, POOL);
        assertEq(config.entryPrice, ENTRY);
        // The operation carries its own copy of the rules it was made under.
        assertEq(params.epochBlocks, defaultParams().epochBlocks);
        assertEq(address(game).balance, createCost());
    }

    function test_createLobby_rejectsWrongPrizePoolPayment() public {
        vm.prank(creator);
        vm.expectRevert(AegylaxGame.IncorrectPayment.selector);
        game.createLobby{value: createCost() - 1}(defaultConfig());
    }

    /**
     * ТЗ §17 — the creator pays the protocol's per-seat fee like everybody
     * else, and paying only the bounty is now short by exactly that fee.
     *
     * Creating used to be the one way to occupy the protocol without paying
     * it: the creator schedules the epoch's attack, takes a fee off every
     * entry and gets their bounty back on a miss, and the treasury never saw
     * a wei from them.
     */
    function test_createLobby_chargesTheCreatorTheProtocolFee() public {
        vm.prank(creator);
        vm.expectRevert(AegylaxGame.IncorrectPayment.selector);
        game.createLobby{value: POOL}(defaultConfig());

        bytes32 lobbyId = createLobby();
        (GameTypes.Lobby memory lobby,,) = lensOf().getLobby(lobbyId);
        // On the operation's books as protocol money, not pool money — so it
        // reaches the treasury on activation and comes back with everything
        // else if the operation never runs.
        assertEq(lobby.protocolFeeAccrued, defaultParams().protocolJoinFee);
        assertEq(lobby.rewardPool, POOL);
    }

    function test_createLobby_rejectsConfigOutsideProtocolLimits() public {
        GameTypes.LobbyConfig memory config = defaultConfig();
        config.entryPrice = 1 ether; // above maxEntryFee

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(ProtocolRules.InvalidConfig.selector, "entryPrice"));
        game.createLobby{value: createCost()}(config);
    }

    function test_createLobby_rejectsCreatorFeeAboveProtocolCeiling() public {
        GameTypes.LobbyConfig memory config = defaultConfig();
        config.creatorFeeBps = 5000;

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(ProtocolRules.InvalidConfig.selector, "creatorFeeBps"));
        game.createLobby{value: createCost()}(config);
    }

    function test_join_collectsEntryAndProtocolFee() public {
        bytes32 lobbyId = createLobby();
        join(lobbyId, alice);

        (GameTypes.Lobby memory lobby,,) = lensOf().getLobby(lobbyId);
        assertEq(lobby.participantCount, 1);
        assertEq(lobby.entryFeesCollected, ENTRY);
        // The creator's seat plus alice's.
        assertEq(lobby.protocolFeeAccrued, defaultParams().protocolJoinFee * 2);

        GameTypes.Participant memory p = lensOf().getParticipant(lobbyId, alice);
        assertTrue(p.joined);
        assertEq(p.paidIn, joinCost());
    }

    function test_join_rejectsWrongAmount() public {
        bytes32 lobbyId = createLobby();
        vm.prank(alice);
        vm.expectRevert(AegylaxGame.IncorrectPayment.selector);
        game.joinLobby{value: ENTRY}(lobbyId);
    }

    function test_join_rejectsDuplicate() public {
        bytes32 lobbyId = createLobby();
        join(lobbyId, alice);

        vm.prank(alice);
        vm.expectRevert(AegylaxGame.AlreadyJoined.selector);
        game.joinLobby{value: joinCost()}(lobbyId);
    }

    function test_join_rejectsAfterDeadline() public {
        bytes32 lobbyId = createLobby();
        closeApplications();

        vm.prank(alice);
        vm.expectRevert(AegylaxGame.RegistrationClosed.selector);
        game.joinLobby{value: joinCost()}(lobbyId);
    }

    function test_join_rejectsWhenFull() public {
        GameTypes.LobbyConfig memory config = defaultConfig();
        config.maxPlayers = 2;
        vm.prank(creator);
        bytes32 lobbyId = game.createLobby{value: createCost()}(config);

        join(lobbyId, alice);
        join(lobbyId, bob);

        vm.prank(carol);
        vm.expectRevert(AegylaxGame.LobbyFull.selector);
        game.joinLobby{value: joinCost()}(lobbyId);
    }

    function test_leave_refundsEverythingPaidIn() public {
        bytes32 lobbyId = createLobby();
        join(lobbyId, alice);

        vm.prank(alice);
        game.buyProbes{value: PROBE_PRICE * 2}(lobbyId, 2);

        uint256 before = alice.balance;
        vm.prank(alice);
        game.leaveLobby(lobbyId);

        assertEq(alice.balance, before + joinCost() + PROBE_PRICE * 2);

        (GameTypes.Lobby memory lobby,,) = lensOf().getLobby(lobbyId);
        assertEq(lobby.participantCount, 0);
        assertEq(lobby.entryFeesCollected, 0);
        assertEq(lobby.probeFeesCollected, 0);
        // The bounty is untouched; only what the leaver put in came back.
        assertEq(lobby.rewardPool, POOL);
    }

    function test_leave_rejectsAfterStart() public {
        (bytes32 lobbyId,) = startedLobby();

        vm.prank(alice);
        vm.expectRevert(AegylaxGame.WrongLobbyStatus.selector);
        game.leaveLobby(lobbyId);
    }

    function test_leave_rejectsNonParticipant() public {
        bytes32 lobbyId = createLobby();
        vm.prank(carol);
        vm.expectRevert(AegylaxGame.NotParticipant.selector);
        game.leaveLobby(lobbyId);
    }

    /**
     * The attack is scheduled by *creating* the operation, not by starting
     * it — the property the whole deadline-in-blocks model exists for.
     *
     * Nobody has joined, nobody has sent a transition, and the deadline has
     * not passed: the epoch, the launch block and the impact block are
     * already fixed, and every client can count down to them without asking
     * anybody's permission.
     */
    function test_create_schedulesTheAttackWithNobodyPresent() public {
        uint64 deadlineBlock = uint64(block.number + REGISTRATION_BLOCKS);
        bytes32 lobbyId = createLobby();

        (GameTypes.Lobby memory lobby,,) = lensOf().getLobby(lobbyId);
        assertEq(uint8(lobby.status), uint8(GameTypes.LobbyStatus.OPEN), "still taking applications");
        assertTrue(lobby.attackId != bytes32(0), "no attack scheduled at creation");

        GameTypes.Attack memory attack = attackOf(lobby.attackId);
        // Arithmetic on the deadline block, with no transaction between the
        // two: the epoch after applications close, unless that boundary is
        // too close — then one more.
        assertEq(attack.epochId, lobby.epochId);
        assertTrue(attack.launchBlock > deadlineBlock, "launch is not past the deadline");
        // Player-created operations leave at least 90% of an epoch between
        // the join window closing and the threat launching. A one-block gap
        // is not a round.
        assertTrue(
            attack.launchBlock - deadlineBlock >= (uint64(defaultParams().epochBlocks) * 90) / 100,
            "launch too close to the deadline"
        );
        assertEq(attack.impactBlock - attack.launchBlock, defaultParams().epochBlocks);
        assertTrue(attack.bearingHandle != bytes32(0), "the epoch's secret was not drawn");
    }

    /**
     * Two operations that close applications in the same epoch face the
     * same threat — including when neither of them ever calls
     * `startOperation`. The attack belongs to the epoch, so binding it at
     * creation must not mint one per operation.
     */
    function test_create_sharesOneAttackPerEpoch() public {
        bytes32 first = createLobby();
        bytes32 second = createLobby();

        (GameTypes.Lobby memory a,,) = lensOf().getLobby(first);
        (GameTypes.Lobby memory b,,) = lensOf().getLobby(second);
        assertEq(a.attackId, b.attackId, "two threats for one epoch");
        assertEq(a.epochId, b.epochId);
    }

    /**
     * A deadline in the first tenth of an epoch still launches at the next
     * boundary: 90% of the epoch remains, so there is a round to play.
     */
    function test_create_keepsTheNextEpochWhenEnoughOfItRemains() public {
        // Genesis 1000, 150-block epochs. Epoch 0 is 1000..1149. A deadline
        // 10 blocks in leaves 140 until the next start, which is ≥ 135.
        uint64 deadlineBlock = 1010;
        bytes32 lobbyId = createLobbyWithDeadlineBlock(deadlineBlock);

        (GameTypes.Lobby memory lobby,,) = lensOf().getLobby(lobbyId);
        GameTypes.Attack memory attack = attackOf(lobby.attackId);
        assertEq(attack.launchBlock, 1150);
        assertEq(attack.epochId, 1);
    }

    /**
     * A deadline past the first tenth of an epoch skips the next boundary.
     * The naive `epochOf + 1` would still be "the epoch after", but less
     * than 90% of it would remain — and at the extreme, one block.
     */
    function test_create_skipsALaunchBoundaryTooCloseToTheDeadline() public {
        // Last block of epoch 0. Naive launch is 1150, one block later.
        vm.roll(1100);
        uint64 deadlineBlock = 1149;
        bytes32 lobbyId = createLobbyWithDeadlineBlock(deadlineBlock);

        (GameTypes.Lobby memory lobby,,) = lensOf().getLobby(lobbyId);
        GameTypes.Attack memory attack = attackOf(lobby.attackId);
        assertEq(attack.launchBlock, 1300, "must not launch on the next block");
        assertEq(attack.epochId, 2);
        assertTrue(attack.launchBlock - deadlineBlock >= (uint64(defaultParams().epochBlocks) * 90) / 100);
    }

    /**
     * Just past the 90% remaining cut: offset 16 of 150 leaves 134 blocks,
     * which is under 135, so the attack waits an extra epoch.
     */
    function test_create_skipsWhenRemainingDropsUnderNinetyPercent() public {
        uint64 deadlineBlock = 1016;
        bytes32 lobbyId = createLobbyWithDeadlineBlock(deadlineBlock);

        (GameTypes.Lobby memory lobby,,) = lensOf().getLobby(lobbyId);
        GameTypes.Attack memory attack = attackOf(lobby.attackId);
        assertEq(attack.launchBlock, 1300);
        assertEq(attack.epochId, 2);
    }

    /**
     * A round played without a single startOperation call: the first
     * defense activates the operation as a side effect, and the money lands
     * exactly where closing applications would have put it.
     */
    function test_round_runsWithoutAnyoneStartingIt() public {
        bytes32 lobbyId = createLobby();
        join(lobbyId, alice);
        join(lobbyId, bob);
        closeApplications();

        (GameTypes.Lobby memory open,,) = lensOf().getLobby(lobbyId);
        assertEq(uint8(open.status), uint8(GameTypes.LobbyStatus.OPEN), "nothing has started it yet");

        GameTypes.Attack memory attack = attackOf(open.attackId);
        vm.roll(attack.launchBlock);
        submitPoint(lobbyId, alice, 1_000 * 1e6, 1_000 * 1e6);

        (GameTypes.Lobby memory active,,) = lensOf().getLobby(lobbyId);
        assertEq(uint8(active.status), uint8(GameTypes.LobbyStatus.ACTIVE), "the defense did not activate it");

        uint256 entryFees = uint256(ENTRY) * 2;
        uint256 creatorFee = (entryFees * 500) / 10_000;
        assertEq(active.creatorFeeAccrued, creatorFee, "fees were not settled");
        assertEq(active.rewardPool, POOL + entryFees - creatorFee);
    }

    function test_start_locksFeesAndSchedulesAttack() public {
        bytes32 lobbyId = createLobby();
        join(lobbyId, alice);
        join(lobbyId, bob);

        closeApplications();
        game.startOperation(lobbyId);

        (GameTypes.Lobby memory lobby,,) = lensOf().getLobby(lobbyId);
        assertEq(uint8(lobby.status), uint8(GameTypes.LobbyStatus.ACTIVE));

        uint256 entryFees = uint256(ENTRY) * 2;
        uint256 creatorFee = (entryFees * 500) / 10_000;
        assertEq(lobby.creatorFeeAccrued, creatorFee);
        // Everything not taken as a fee stays in the operation, as the pool.
        assertEq(lobby.rewardPool, POOL + entryFees - creatorFee);

        GameTypes.Attack memory attack = attackOf(lobby.attackId);
        assertEq(attack.impactBlock - attack.launchBlock, defaultParams().epochBlocks);
        assertTrue(attack.launchBlock > block.number);
        // The geometry exists and is unreadable from here.
        assertTrue(attack.bearingHandle != bytes32(0));
        assertTrue(attack.deltaHandle != bytes32(0));
    }

    function test_start_rejectsBeforeDeadline() public {
        bytes32 lobbyId = createLobby();
        join(lobbyId, alice);
        join(lobbyId, bob);

        vm.expectRevert(AegylaxGame.RegistrationStillOpen.selector);
        game.startOperation(lobbyId);
    }

    function test_start_rejectsBelowMinimumPlayers() public {
        bytes32 lobbyId = createLobby();
        join(lobbyId, alice);
        closeApplications();

        vm.expectRevert(AegylaxGame.MinPlayersNotReached.selector);
        game.startOperation(lobbyId);
    }

    function test_start_isPermissionless() public {
        bytes32 lobbyId = createLobby();
        join(lobbyId, alice);
        join(lobbyId, bob);
        closeApplications();

        // A passer-by may pay the gas to make the protocol notice the clock.
        vm.prank(address(0xDEAD));
        game.startOperation(lobbyId);

        (GameTypes.Lobby memory lobby,,) = lensOf().getLobby(lobbyId);
        assertEq(uint8(lobby.status), uint8(GameTypes.LobbyStatus.ACTIVE));
    }

    /**
     * Starting an operation twice is a no-op, not a revert.
     *
     * The transition is reached from everywhere now — the first probe, the
     * first defense, the reveal — so it has to be safe to ask for when it
     * has already happened. What must not happen is it running *twice*: the
     * Creator Fee and the protocol's cut would be accrued a second time out
     * of entry money that has already been spent.
     */
    function test_start_isIdempotent() public {
        (bytes32 lobbyId,) = startedLobby();
        (GameTypes.Lobby memory before,,) = lensOf().getLobby(lobbyId);

        game.startOperation(lobbyId);

        (GameTypes.Lobby memory after_,,) = lensOf().getLobby(lobbyId);
        assertEq(uint8(after_.status), uint8(GameTypes.LobbyStatus.ACTIVE));
        assertEq(after_.creatorFeeAccrued, before.creatorFeeAccrued, "creator fee accrued twice");
        assertEq(after_.rewardPool, before.rewardPool, "entry residual banked twice");
        assertEq(after_.startedAtBlock, before.startedAtBlock, "start block moved");
    }

    function test_cancel_refundsParticipantsAndCreator() public {
        bytes32 lobbyId = createLobby();
        join(lobbyId, alice);
        closeApplications();

        game.cancelLobby(lobbyId);

        (GameTypes.Lobby memory lobby,,) = lensOf().getLobby(lobbyId);
        assertEq(uint8(lobby.status), uint8(GameTypes.LobbyStatus.CANCELLED));

        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        game.claimRefund(lobbyId);
        assertEq(alice.balance, aliceBefore + joinCost());

        uint256 creatorBefore = creator.balance;
        vm.prank(creator);
        game.claimRefund(lobbyId);
        assertEq(creator.balance, creatorBefore + createCost(), "creator refunds launch deposit on the same call");

        vm.prank(creator);
        vm.expectRevert(AegylaxGame.AlreadyClaimed.selector);
        game.settleCreator(lobbyId);

        // ТЗ §18 — nobody's fault but the turnout's, so UNPLAYED rather than
        // CANCELLED. The two refund identically and mean different things.
        (GameTypes.Lobby memory ended,,) = lensOf().getLobby(lobbyId);
        assertEq(uint8(ended.ending), uint8(GameTypes.Ending.UNPLAYED));
    }

    function test_cancel_rejectedWhenMinimumWasReached() public {
        bytes32 lobbyId = createLobby();
        join(lobbyId, alice);
        join(lobbyId, bob);
        closeApplications();

        vm.expectRevert(AegylaxGame.MinPlayersNotReached.selector);
        game.cancelLobby(lobbyId);
    }

    function test_refund_cannotBeClaimedTwice() public {
        bytes32 lobbyId = createLobby();
        join(lobbyId, alice);
        closeApplications();
        game.cancelLobby(lobbyId);

        vm.prank(alice);
        game.claimRefund(lobbyId);

        vm.prank(alice);
        vm.expectRevert(AegylaxGame.AlreadyClaimed.selector);
        game.claimRefund(lobbyId);
    }
}

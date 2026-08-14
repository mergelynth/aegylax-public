// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {AegylaxTest} from "./AegylaxTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {AegylaxGame} from "../src/AegylaxGame.sol";
import {AegylaxLens} from "../src/AegylaxLens.sol";
import {MockConfidentialEngine} from "../src/confidential/MockConfidentialEngine.sol";
import {GameTypes} from "../src/libraries/GameTypes.sol";
import {ProtocolRules} from "../src/libraries/ProtocolRules.sol";

/// A second implementation, used to prove an upgrade keeps every byte of state.
contract AegylaxGameV2 is AegylaxGame {
    function version() external pure override returns (string memory) {
        return "2.0.0-test";
    }

    function upgradedMarker() external pure returns (bool) {
        return true;
    }
}

/// Access control, upgrade safety, parameter immutability and replay protection.
contract SecurityTest is AegylaxTest {
    function test_upgrade_isOwnerOnly() public {
        AegylaxGameV2 next = new AegylaxGameV2();

        vm.prank(bob);
        vm.expectRevert();
        game.upgradeToAndCall(address(next), "");

        vm.prank(owner);
        game.upgradeToAndCall(address(next), "");
        assertEq(game.version(), "2.0.0-test");
    }

    /// An upgrade in the middle of a live operation must not disturb it.
    function test_upgrade_preservesEveryOperationInFlight() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        timedSubmitOnTrajectory(lobbyId, attackId, alice, 700);

        (GameTypes.Lobby memory before,,) = lensOf().getLobby(lobbyId);

        AegylaxGameV2 next = new AegylaxGameV2();
        vm.prank(owner);
        game.upgradeToAndCall(address(next), "");

        (GameTypes.Lobby memory afterUpgrade,,) = lensOf().getLobby(lobbyId);
        assertEq(afterUpgrade.rewardPool, before.rewardPool);
        assertEq(afterUpgrade.participantCount, before.participantCount);
        assertEq(afterUpgrade.attackId, before.attackId);
        assertEq(uint8(afterUpgrade.status), uint8(before.status));

        // And the round still finishes normally on the new implementation.
        completeAndReveal(lobbyId, attackId);
        (, GameTypes.Outcome memory outcome) = lensOf().getOutcome(lobbyId);
        assertEq(outcome.winners[0], alice);
    }

    function test_implementation_cannotBeInitializedDirectly() public {
        AegylaxGame implementation = new AegylaxGame();
        vm.expectRevert();
        implementation.initialize(owner, address(engine), defaultParams(), 1);
    }

    function test_proxy_cannotBeInitializedTwice() public {
        vm.expectRevert();
        game.initialize(bob, address(engine), defaultParams(), 1);
    }

    function test_governance_isOwnerOnly() public {
        GameTypes.GameParams memory p = defaultParams();

        vm.prank(bob);
        vm.expectRevert();
        game.setParams(p);

        vm.prank(bob);
        vm.expectRevert();
        game.setEngine(address(engine));

        vm.prank(bob);
        vm.expectRevert();
        game.setLens(address(lens));

        vm.prank(bob);
        vm.expectRevert();
        game.setPaused(true);
    }

    /**
     * A parameter change must not reach an operation that is already being
     * played — that is the whole reason a lobby carries a snapshot.
     */
    function test_paramChange_doesNotTouchRunningOperations() public {
        (bytes32 lobbyId,) = startedLobby();
        (,, GameTypes.GameParams memory before) = lensOf().getLobby(lobbyId);

        GameTypes.GameParams memory next = defaultParams();
        next.interceptRadiusMilliSectors = 1000;
        next.epochBlocks = 999;
        vm.prank(owner);
        game.setParams(next);

        (,, GameTypes.GameParams memory afterChange) = lensOf().getLobby(lobbyId);
        assertEq(afterChange.interceptRadiusMilliSectors, before.interceptRadiusMilliSectors);
        assertEq(afterChange.epochBlocks, before.epochBlocks);

        (, uint32 version) = lensOf().getParams();
        assertEq(version, 2);
    }

    function test_paramValidation_rejectsABoardThatCannotHostAnAttack() public {
        GameTypes.GameParams memory p = defaultParams();
        p.gridRows = 1; // globe too big for the board

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ProtocolRules.InvalidParams.selector, "gridRows"));
        game.setParams(p);
    }

    function test_engine_rejectsCallsFromAnybodyButTheGame() public {
        vm.prank(bob);
        vm.expectRevert(MockConfidentialEngine.NotGame.selector);
        engine.newAttackSecret(bytes32(uint256(1)), 1000, 1000);

        vm.prank(bob);
        vm.expectRevert(MockConfidentialEngine.NotGame.selector);
        engine.newProbeHint(bytes32(uint256(1)), bytes32(uint256(2)), bob, bytes32(uint256(3)), 1000);

        bytes32[] memory handles = new bytes32[](1);
        vm.prank(bob);
        vm.expectRevert(MockConfidentialEngine.NotGame.selector);
        engine.unlockForReveal(handles);
    }

    function test_engine_bindingIsPermanent() public {
        MockConfidentialEngine fresh = new MockConfidentialEngine(owner);
        vm.prank(owner);
        fresh.setGame(address(game));

        vm.prank(owner);
        vm.expectRevert(MockConfidentialEngine.GameAlreadySet.selector);
        fresh.setGame(bob);
    }

    /// Pausing stops new play without trapping anything already committed.
    function test_pause_blocksNewActionsButNotSettlement() public {
        (bytes32 lobbyId, bytes32 attackId) = startedLobby();
        timedSubmitOnTrajectory(lobbyId, attackId, alice, 700);

        vm.prank(owner);
        game.setPaused(true);

        vm.prank(bob);
        vm.expectRevert();
        game.sendProbe(lobbyId, 0, 0);

        // Completion, reveal and claiming stay open: they only settle what
        // was already committed before the pause.
        completeAndReveal(lobbyId, attackId);
        vm.prank(alice);
        game.claimReward(lobbyId);
    }

    function test_unknownSelector_revertsWhenNoLensIsSet() public {
        MockConfidentialEngine freshEngine = new MockConfidentialEngine(owner);
        AegylaxGame implementation = new AegylaxGame();
        bytes memory initData = abi.encodeCall(
            AegylaxGame.initialize, (owner, address(freshEngine), defaultParams(), uint64(block.number))
        );
        AegylaxGame lensless = AegylaxGame(payable(address(new ERC1967Proxy(address(implementation), initData))));

        vm.expectRevert(AegylaxGame.UnknownSelector.selector);
        AegylaxLens(address(lensless)).currentEpoch();
    }

    /**
     * The lens only ever sees game state through a delegatecall.
     *
     * Called directly it runs against its own, empty storage and answers
     * with zeros — which is the point: it holds nothing, owns nothing, and
     * a caller who reaches it outside the proxy learns nothing and can
     * corrupt nothing.
     */
    function test_lens_calledDirectly_seesNoGameState() public view {
        assertEq(lens.currentEpoch(), 0);
        assertEq(lens.getEngine(), address(0));

        (uint64 totalLobbies,,,,,,) = lens.getStats();
        assertEq(totalLobbies, 0);

        // Through the proxy, the same functions see the real thing.
        assertEq(lensOf().getEngine(), address(engine));
    }
}

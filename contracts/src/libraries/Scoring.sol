// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {AegylaxStorage} from "../AegylaxStorage.sol";
import {IAegylaxEvents} from "../interfaces/IAegylaxEvents.sol";
import {GameTypes} from "./GameTypes.sol";
import {Geometry} from "./Geometry.sol";
import {Lobbies} from "./Lobbies.sol";
import {Resolution} from "./Resolution.sol";

/**
 * Scoring one team against a published trajectory.
 *
 * Lives outside `AegylaxGame` for the same reason `Lobbies` does: the
 * implementation must fit in 24,576 bytes. The game keeps the permissionless
 * entry points; this library writes the verdict and the pool.
 */
library Scoring {
    error UnknownLobby();
    error UnknownAttack();
    error WrongLobbyStatus();
    error RevealNotUnlocked();
    error ProofCountMismatch();
    error MaskKeyNotPublished();
    error ScoringIncomplete();
    error ScoringBatchTooLarge();
    error ScoringAlreadyFinal();

    uint256 public constant MAX_BATCH = 32;

    function resolveAll(
        AegylaxStorage.GameStorage storage $,
        bytes32 lobbyId,
        GameTypes.DecryptionProof[] calldata defenseProofs
    ) public {
        if ($.attempts[lobbyId].length > MAX_BATCH) revert ScoringBatchTooLarge();
        scoreAll($, lobbyId, defenseProofs);
        finalize($, lobbyId);
    }

    function prove(
        AegylaxStorage.GameStorage storage $,
        bytes32 lobbyId,
        uint32[] calldata indices,
        GameTypes.DecryptionProof[] calldata proofs
    ) public {
        if (indices.length != proofs.length) revert ProofCountMismatch();
        if (indices.length == 0 || indices.length > MAX_BATCH) revert ScoringBatchTooLarge();

        Lobbies.maybeOpenDraw($);
        GameTypes.Lobby storage lobby = _lobby($, lobbyId);
        GameTypes.Attack storage attack = $.attacks[lobby.attackId];

        if (attack.id == bytes32(0)) revert UnknownAttack();
        if (!$.maskPublished[attack.id]) revert MaskKeyNotPublished();
        if ($.outcomes[lobbyId].resolvedAtBlock != 0) revert ScoringAlreadyFinal();

        Lobbies.activate($, lobbyId);
        if (lobby.status != GameTypes.LobbyStatus.ACTIVE) revert WrongLobbyStatus();

        Resolution.scoreSubset(
            $.engine,
            $.attempts[lobbyId],
            $.outcomes[lobbyId],
            _context($, attack),
            proofs,
            indices,
            $.publishedMaskKeys[attack.id]
        );
    }

    function finalizeIfReady(AegylaxStorage.GameStorage storage $, bytes32 lobbyId) public {
        Lobbies.maybeOpenDraw($);
        GameTypes.Lobby storage lobby = _lobby($, lobbyId);
        GameTypes.Attack storage attack = $.attacks[lobby.attackId];

        if (attack.id == bytes32(0)) revert UnknownAttack();
        if (!$.revealed[attack.id]) revert RevealNotUnlocked();
        if ($.outcomes[lobbyId].resolvedAtBlock != 0) revert ScoringAlreadyFinal();

        Lobbies.activate($, lobbyId);
        if (lobby.status != GameTypes.LobbyStatus.ACTIVE) revert WrongLobbyStatus();

        GameTypes.DefenseAttempt[] storage list = $.attempts[lobbyId];
        bool allRevealed = true;
        for (uint256 i = 0; i < list.length; i++) {
            if (!list[i].revealed) {
                allRevealed = false;
                break;
            }
        }
        GameTypes.GameParams memory p = $.epochParams[attack.epochId];
        if (!allRevealed && block.number < uint256(attack.impactBlock) + uint256(p.revealGraceBlocks)) {
            revert ScoringIncomplete();
        }

        finalize($, lobbyId);
    }

    function scoreAll(
        AegylaxStorage.GameStorage storage $,
        bytes32 lobbyId,
        GameTypes.DecryptionProof[] calldata defenseProofs
    ) internal {
        GameTypes.Lobby storage lobby = _lobby($, lobbyId);
        GameTypes.Attack storage attack = $.attacks[lobby.attackId];

        if (attack.id == bytes32(0)) revert UnknownAttack();
        if (!$.revealed[attack.id] || !$.maskPublished[attack.id]) revert MaskKeyNotPublished();

        Lobbies.activate($, lobbyId);
        if (lobby.status != GameTypes.LobbyStatus.ACTIVE) revert WrongLobbyStatus();
        if ($.outcomes[lobbyId].resolvedAtBlock != 0) revert ScoringAlreadyFinal();

        GameTypes.DefenseAttempt[] storage list = $.attempts[lobbyId];
        if (defenseProofs.length != list.length) revert ProofCountMismatch();

        Resolution.resolve(
            $.engine, list, $.outcomes[lobbyId], _context($, attack), defenseProofs, $.publishedMaskKeys[attack.id]
        );
    }

    function finalize(AegylaxStorage.GameStorage storage $, bytes32 lobbyId) internal {
        GameTypes.Lobby storage lobby = _lobby($, lobbyId);
        GameTypes.Attack storage attack = $.attacks[lobby.attackId];
        GameTypes.Outcome storage outcome = $.outcomes[lobbyId];

        outcome.interceptRadiusWu = _context($, attack).radiusWu;
        outcome.resolvedAtBlock = uint64(block.number);
        outcome.resolvedAtTimestamp = uint64(block.timestamp);
        outcome.revealedBy = msg.sender;

        uint256 winnerCount = outcome.winners.length;
        if (winnerCount > 0) {
            outcome.intercepted = true;
            outcome.rewardPerWinner = uint256(lobby.rewardPool) / winnerCount;
            if (!attack.intercepted) {
                attack.intercepted = true;
                unchecked {
                    $.interceptedAttacks += 1;
                }
            }
        }

        if (lobby.validActions == 0) {
            lobby.ending = GameTypes.Ending.UNPLAYED;
            lobby.status = GameTypes.LobbyStatus.CANCELLED;
            emit IAegylaxEvents.LobbyCancelled(lobbyId, "no defender ever acted");
        } else {
            lobby.ending = GameTypes.Ending.COMPLETED;
            lobby.status = GameTypes.LobbyStatus.RESOLVED;
            if (winnerCount == 0 && lobby.rewardPool > 0) {
                uint256 forfeited = lobby.rewardPool;
                lobby.rewardPool = 0;
                $.globalDefensePool += forfeited;
                emit IAegylaxEvents.DefensePoolFunded(lobbyId, forfeited, $.globalDefensePool);
            }
        }
        if ($.activeLobbies > 0) $.activeLobbies -= 1;

        emit IAegylaxEvents.WinnerDetermined(
            lobbyId,
            attack.id,
            outcome.intercepted,
            outcome.winners,
            outcome.rewardPerWinner,
            outcome.winningArrivalBlockScaled
        );

        Lobbies.maybeOpenDraw($);
    }

    function _context(AegylaxStorage.GameStorage storage $, GameTypes.Attack storage attack)
        private
        view
        returns (Resolution.Context memory ctx)
    {
        GameTypes.GameParams memory p = $.epochParams[attack.epochId];
        Geometry.World memory world = Geometry.buildWorld(p.gridColumns, p.gridRows, p.sectorSpanKm);
        ctx = Resolution.Context({
            world: world,
            traj: $.trajectories[attack.id],
            radiusWu: Geometry.interceptRadiusWu(world, p.interceptRadiusMilliSectors),
            launchBlock: attack.launchBlock,
            flightBlocks: attack.flightBlocks,
            defenseSpeed: p.defenseSpeedKmPerBlock
        });
    }

    function _lobby(AegylaxStorage.GameStorage storage $, bytes32 lobbyId)
        private
        view
        returns (GameTypes.Lobby storage lobby)
    {
        lobby = $.lobbies[lobbyId];
        if (lobby.status == GameTypes.LobbyStatus.NONE) revert UnknownLobby();
    }
}

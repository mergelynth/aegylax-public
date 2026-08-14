// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {GameTypes} from "../libraries/GameTypes.sol";

/**
 * Every state change the frontend is allowed to learn about, and nothing
 * else (ТЗ §11).
 *
 * Two rules govern what may appear in an argument here. Money and timing
 * are public, because a player has to be able to audit what they paid and
 * when the protocol thinks things happened. Geometry is not: no event on
 * this list carries a coordinate before `AttackRevealed`, and the handles
 * that do appear (`hintHandle`, `pointHandle`) are opaque references into
 * the confidential layer, readable only by the address the engine granted
 * them to.
 *
 * `ProbeSent` and `DefenseSubmitted` are separate events on purpose. Probe
 * allowances are enforced on chain, so a probe count is public information
 * whatever the log looks like; hiding *which* action a transaction was
 * would buy nothing and cost the frontend the ability to reason about
 * either. What stays hidden is what the probe learned and where the defense
 * went — and those are hidden by the confidential layer, not by the shape
 * of an event.
 */
interface IAegylaxEvents {
    event LobbyCreated(
        bytes32 indexed lobbyId,
        address indexed creator,
        uint128 entryPrice,
        uint128 startPrizePool,
        uint64 registrationDeadline,
        uint32 paramsVersion,
        string name
    );
    event PlayerJoined(bytes32 indexed lobbyId, address indexed player, uint256 paid, uint16 participantCount);
    event PlayerLeft(bytes32 indexed lobbyId, address indexed player, uint256 refunded, uint16 participantCount);
    event ProbesPurchased(bytes32 indexed lobbyId, address indexed player, uint16 count, uint256 paid);

    event OperationStarted(bytes32 indexed lobbyId, uint32 epochId, uint64 startedAtBlock);
    event LobbyCancelled(bytes32 indexed lobbyId, string reason);

    event AttackStarted(
        bytes32 indexed lobbyId, bytes32 indexed attackId, uint64 launchBlock, uint64 impactBlock, uint32 flightBlocks
    );
    event ProbeSent(
        bytes32 indexed lobbyId,
        address indexed player,
        bytes32 indexed attackId,
        uint16 probeIndex,
        bytes32 hintHandle,
        uint64 readableAtBlock
    );
    /// The hint is now decryptable by its owner. Permissionless: anybody may collect.
    event ProbeHintGranted(bytes32 indexed hintHandle, address indexed player, uint64 grantedAtBlock);
    event DefenseSubmitted(
        bytes32 indexed lobbyId,
        address indexed player,
        bytes32 indexed attackId,
        uint32 attemptIndex,
        bytes32 pointHandle,
        uint64 submittedAtBlock
    );
    event AttackCompleted(bytes32 indexed lobbyId, bytes32 indexed attackId, uint64 completedAtBlock);
    event AttackRevealed(
        bytes32 indexed lobbyId,
        bytes32 indexed attackId,
        address indexed revealedBy,
        GameTypes.Trajectory trajectory,
        uint64 revealedAtBlock
    );
    event WinnerDetermined(
        bytes32 indexed lobbyId,
        bytes32 indexed attackId,
        bool intercepted,
        address[] winners,
        uint256 rewardPerWinner,
        uint256 winningArrivalBlockScaled
    );
    event AttackExpired(bytes32 indexed lobbyId, bytes32 indexed attackId, string reason);

    event RewardClaimed(bytes32 indexed lobbyId, address indexed player, uint256 amount);
    event RefundClaimed(bytes32 indexed lobbyId, address indexed player, uint256 amount);
    event CreatorSettled(bytes32 indexed lobbyId, address indexed creator, uint256 amount);
    event ProtocolFeesWithdrawn(address indexed to, uint256 amount);

    /**
     * Money arriving in the Global Defense Pool, and what the pool is worth
     * afterwards (ТЗ §18).
     *
     * Emitted from both routes into it, deliberately with the same signature:
     * a COMPLETED round the threat won forfeiting its pool, and the protocol's
     * own draw operation handing an unclaimed bounty back. They are the same
     * event as far as anybody watching the pool is concerned — money that had
     * no winner, returning to the game.
     */
    event DefensePoolFunded(bytes32 indexed lobbyId, uint256 amount, uint256 poolBalance);
    /// The protocol opening its own operation to play the pool out.
    event GlobalDefenseOpened(uint32 indexed epochId, bytes32 indexed lobbyId, uint256 pool);
    /// The draw's cadence, in epochs. 0 means the draw is off.
    event GlobalDefenseIntervalUpdated(uint32 epochs);

    event ParamsUpdated(uint32 indexed version);
    event ConfidentialEngineUpdated(address indexed engine, string kind);
}

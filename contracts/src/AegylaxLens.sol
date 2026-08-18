// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {AegylaxStorage} from "./AegylaxStorage.sol";
import {GameTypes} from "./libraries/GameTypes.sol";

/**
 * The protocol's read surface.
 *
 * Every function here is a view over the same storage `AegylaxGame` writes:
 * the game delegates any selector it does not implement to this contract,
 * so a call runs in the proxy's storage context and sees exactly the state
 * the game left there. Clients talk to one address and one merged ABI, and
 * never to this contract directly.
 *
 * Splitting reads out is what keeps the deployed game inside the EVM's code
 * size limit, and it is the right half to split: nothing here can change
 * state, so the whole of the protocol's authority stays in one auditable
 * file. It also means the read surface can grow — a new query, a new
 * pagination shape — by replacing this contract alone, without touching the
 * implementation that holds the money.
 *
 * One rule governs what may be returned: `getTrajectory` and the coordinate
 * fields of `getDefenseAttempts` answer nothing until a reveal has actually
 * happened. That is not a policy this contract enforces — it is that the
 * plaintext is not in storage to return before then.
 */
contract AegylaxLens is AegylaxStorage {
    function getParams() external view returns (GameTypes.GameParams memory, uint32 paramsVersion) {
        GameStorage storage $ = _gameStorage();
        return ($.params, $.paramsVersion);
    }

    function getEngine() external view returns (address) {
        return address(_gameStorage().engine);
    }

    function genesisBlock() external view returns (uint64) {
        return _gameStorage().genesisBlock;
    }

    function getLobby(bytes32 lobbyId)
        external
        view
        returns (GameTypes.Lobby memory lobby, GameTypes.LobbyConfig memory config, GameTypes.GameParams memory params)
    {
        GameStorage storage $ = _gameStorage();
        return ($.lobbies[lobbyId], $.lobbyConfigs[lobbyId], $.lobbyParams[lobbyId]);
    }

    function getLobbyIds(uint256 offset, uint256 limit) external view returns (bytes32[] memory page, uint256 total) {
        GameStorage storage $ = _gameStorage();
        total = $.lobbyIds.length;
        if (offset >= total) return (new bytes32[](0), total);
        uint256 size = total - offset;
        if (size > limit) size = limit;
        page = new bytes32[](size);
        for (uint256 i = 0; i < size; i++) {
            page[i] = $.lobbyIds[offset + i];
        }
    }

    function getParticipants(bytes32 lobbyId) external view returns (address[] memory) {
        return _gameStorage().lobbyParticipants[lobbyId];
    }

    function getParticipant(bytes32 lobbyId, address who) external view returns (GameTypes.Participant memory) {
        return _gameStorage().participants[lobbyId][who];
    }

    /**
     * The attack's schedule — and only its schedule.
     *
     * There is no trajectory field on this return value to forget to strip:
     * the geometry lives in `getTrajectory`, which answers nothing until
     * somebody has revealed. `status` is derived from the block number so a
     * client sees the launch happen without anybody having to send a
     * transaction to announce it.
     */
    function getAttack(bytes32 attackId)
        external
        view
        returns (GameTypes.Attack memory attack, GameTypes.AttackStatus derivedStatus)
    {
        GameStorage storage $ = _gameStorage();
        attack = $.attacks[attackId];
        derivedStatus = _derivedStatus(attack);
    }

    function getTrajectory(bytes32 attackId)
        external
        view
        returns (bool revealed, GameTypes.Trajectory memory trajectory)
    {
        GameStorage storage $ = _gameStorage();
        revealed = $.revealed[attackId];
        if (revealed) trajectory = $.trajectories[attackId];
    }

    /// Whether the epoch's threat has been published. Global, like the threat.
    function isRevealed(bytes32 attackId) external view returns (bool) {
        return _gameStorage().revealed[attackId];
    }

    /**
     * The epoch's threat, addressed by the epoch.
     *
     * Everything below is already readable through `getAttack` /
     * `getTrajectory` — but only by a caller that already holds the attack's
     * id, and the id is a hash. In practice that meant a client could not ask
     * the protocol the most natural question there is about a finished round
     * ("what happened in epoch N?") without first finding an operation that
     * played it and reading the id off that. A viewer with no operation in
     * hand — a history page, an explorer, a script auditing the protocol's
     * own randomness — had no route in at all.
     *
     * The id is pure arithmetic on the epoch number, so this is not new
     * information and grants no new access: it is the same public read with a
     * key anybody can name. `revealed` stays the gate. Before the reveal there
     * is nothing here to return, because the geometry is not in this contract
     * in plaintext to be returned — the confidentiality is structural, not a
     * permission this function could have skipped (ТЗ §3).
     *
     * The attack's own timing comes back with it so a caller can place the
     * trajectory in time without a second call: a flight is only meaningful
     * against the blocks it ran between.
     */
    function getEpochAttack(uint32 epochId)
        external
        view
        returns (
            bytes32 attackId,
            GameTypes.Attack memory attack,
            GameTypes.AttackStatus derivedStatus,
            bool revealed,
            GameTypes.Trajectory memory trajectory
        )
    {
        GameStorage storage $ = _gameStorage();
        attackId = _epochAttackId(epochId);
        attack = $.attacks[attackId];
        derivedStatus = _derivedStatus(attack);
        revealed = $.revealed[attackId];
        if (revealed) trajectory = $.trajectories[attackId];
    }

    /**
     * One team's verdict.
     *
     * Keyed by the operation rather than by the attack: a single threat is
     * faced by every team playing that epoch, and each is scored on its own
     * defenders and paid out of its own pool.
     */
    function getOutcome(bytes32 lobbyId) external view returns (bool revealed, GameTypes.Outcome memory outcome) {
        GameStorage storage $ = _gameStorage();
        revealed = $.revealed[$.lobbies[lobbyId].attackId];
        outcome = $.outcomes[lobbyId];
    }

    /**
     * Every defense one team submitted.
     *
     * Before the reveal each entry carries a participant, a submission time
     * and an opaque handle — `revealed` is false and the coordinates are
     * zero, for every reader including the defender who placed it. The
     * redaction is structural: the plaintext is not in this contract to
     * return.
     */
    function getDefenseAttempts(bytes32 lobbyId) external view returns (GameTypes.DefenseAttempt[] memory) {
        return _gameStorage().attempts[lobbyId];
    }

    /**
     * The protocol's global status line, as the HUD reads it.
     *
     * `totalAttacks` and `missedAttacks` are *derived from the clock*, not
     * read from their storage counters — see `_attackTally`. One threat
     * crosses the sky per epoch since genesis whether or not anybody
     * defended it, so the honest total is the epoch count; the stored
     * counter only knows about epochs somebody started an operation into,
     * and the stored miss counter was never incremented at all.
     *
     * `totalLobbies` and `activeLobbies` stay counters, because those really
     * are things that happened rather than time passing.
     */
    function getStats()
        external
        view
        returns (
            uint64 totalLobbies,
            uint64 activeLobbies,
            uint64 totalAttacks,
            uint64 interceptedAttacks,
            uint64 missedAttacks,
            uint64 epoch,
            uint256 protocolTreasury
        )
    {
        GameStorage storage $ = _gameStorage();
        uint32 nowEpoch;
        (totalAttacks, interceptedAttacks, missedAttacks, nowEpoch) = _attackTally($);
        return ($.totalLobbies, $.activeLobbies, totalAttacks, interceptedAttacks, missedAttacks, nowEpoch, $.protocolTreasury);
    }

    /**
     * The protocol's ledger, for anyone auditing the treasury.
     *
     * `withdrawable` is the whole of what the owner may ever take out: it is
     * fed only by the per-join protocol fee, and `withdrawProtocolFees`
     * cannot exceed it (see `AegylaxGame`). Publishing it beside the
     * contract's actual balance is what lets a player confirm that the
     * difference — every operation's prize pool, entry money and unclaimed
     * reward — is not the owner's to move.
     */
    function getTreasury()
        external
        view
        returns (uint256 withdrawable, uint256 contractBalance, uint128 joinFee)
    {
        GameStorage storage $ = _gameStorage();
        return ($.protocolTreasury, address(this).balance, $.params.protocolJoinFee);
    }

    /// The four money flows of an operation, exactly as the UI reports them.
    function getPrizePool(bytes32 lobbyId)
        external
        view
        returns (
            uint256 startPrizePool,
            uint256 entryFeesCollected,
            uint256 probeFeesCollected,
            uint256 creatorFee,
            uint256 protocolFee,
            uint256 rewardPool
        )
    {
        GameStorage storage $ = _gameStorage();
        GameTypes.Lobby storage lobby = $.lobbies[lobbyId];
        GameTypes.LobbyConfig storage config = $.lobbyConfigs[lobbyId];
        startPrizePool = config.startPrizePool;
        entryFeesCollected = lobby.entryFeesCollected;
        probeFeesCollected = lobby.probeFeesCollected;
        creatorFee = lobby.creatorFeeAccrued;
        protocolFee = lobby.protocolFeeAccrued;
        // While OPEN the bounty sits in `rewardPool` and entries are still
        // separate. After activation they have already been folded in.
        rewardPool = lobby.status == GameTypes.LobbyStatus.OPEN
            ? uint256(lobby.rewardPool) + uint256(lobby.entryFeesCollected)
            : lobby.rewardPool;
    }

    function currentEpoch() external view returns (uint32) {
        GameStorage storage $ = _gameStorage();
        return _epochOf(uint64(block.number), $.params.epochBlocks, $.genesisBlock);
    }

    /**
     * The Global Defense Pool: every pool the threat has won, waiting to be
     * played for again (ТЗ §18).
     *
     * Kept apart from `getTreasury` on purpose, and the separation is the
     * point rather than a tidiness preference. The treasury is revenue and the
     * owner may withdraw it; this is players' money the protocol has promised
     * back to the game, and no owner call can reach it. Reporting the two
     * together would invite exactly the reading the split exists to refuse.
     */
    function getGlobalDefensePool() external view returns (uint256) {
        return _gameStorage().globalDefensePool;
    }

    /**
     * When the pool is next played for, and the operation for it if one is
     * already open.
     *
     * `lobbyId` is zero until somebody calls `openGlobalDefense` — the
     * protocol has no keeper, so the draw is opened by whoever gets there
     * first once the chain says it is due, and a client showing a countdown to
     * it needs to be able to tell "not yet opened" from "not scheduled".
     */
    function getGlobalDefenseDraw()
        external
        view
        returns (uint32 nextEpoch, uint32 interval, uint256 pool, bytes32 lobbyId)
    {
        GameStorage storage $ = _gameStorage();
        interval = $.globalDefenseEpochInterval;
        pool = $.globalDefensePool;
        if (interval == 0) return (0, 0, pool, bytes32(0));

        uint32 epoch = _epochOf(uint64(block.number), $.params.epochBlocks, $.genesisBlock);
        // The next multiple of the interval strictly after the current epoch:
        // the one in progress can no longer have an operation opened for it.
        nextEpoch = (epoch / interval + 1) * interval;
        lobbyId = $.globalDefenseLobby[nextEpoch];
        if (lobbyId != bytes32(0)) return (nextEpoch, interval, pool, lobbyId);

        // A previous draw may still be OPEN without holding the bounty
        // (mint no longer drains the pile). After that draw's epoch the
        // lookup above names the *next* interval. Surface the leftover so
        // a keeper can close it; the trophy reads `pool` either way.
        uint32 previous = (epoch / interval) * interval;
        if (previous == 0) return (nextEpoch, interval, pool, bytes32(0));
        bytes32 prevId = $.globalDefenseLobby[previous];
        if (prevId == bytes32(0)) return (nextEpoch, interval, pool, bytes32(0));
        GameTypes.Lobby storage prev = $.lobbies[prevId];
        if (
            prev.status == GameTypes.LobbyStatus.OPEN ||
            prev.status == GameTypes.LobbyStatus.READY ||
            prev.status == GameTypes.LobbyStatus.ACTIVE
        ) {
            lobbyId = prevId;
        }
    }

    function getProbeFlight(bytes32 hintHandle) external view returns (GameTypes.ProbeFlight memory) {
        return _gameStorage().probeFlights[hintHandle];
    }

    // -----------------------------------------------------------------
}

// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {AegylaxStorage} from "../AegylaxStorage.sol";
import {IAegylaxEvents} from "../interfaces/IAegylaxEvents.sol";
import {GameTypes} from "./GameTypes.sol";

/**
 * Who is owed what, once an operation has stopped moving.
 *
 * Every branch here answers the same question from a different seat — the
 * defender's, the creator's — and the answers have to add up to exactly what
 * was paid in, which is why they live together rather than beside the state
 * machine that calls them.
 *
 * It is an external library for the same reason `ProtocolRules` and
 * `Resolution` are — the game implementation has to fit inside the EVM's
 * contract size limit. Amounts live here; `AegylaxGame` decides whether
 * the caller may have them. The one write is the under-filled-room
 * payout, which has to move money in the same transaction as the cancel.
 *
 * **Everything here branches on `Ending`, not on `LobbyStatus`.** The status
 * is a state machine with two terminal values and there are three ways an
 * operation can end (ТЗ §18): it was played, nobody played it, or the protocol
 * failed to run it. The first pays nothing back and the other two pay
 * everything back, so folding any two of them together is not a simplification
 * — it is either taking money from people who never got a game or handing it
 * to people who played and lost.
 */
library Settlement {
    /**
     * The author's per-joiner commission, charged on top of the entry.
     *
     * `creatorFeeBps` is the lobby setting. The protocol's own draw mints
     * with 0, so sitting in the jackpot costs nothing.
     */
    function authorCommission(uint128 entryPrice, uint16 creatorFeeBps) public pure returns (uint256) {
        return (uint256(entryPrice) * uint256(creatorFeeBps)) / GameTypes.BPS;
    }

    /// What `joinLobby` demands: the entry plus the author's commission.
    function joinPayment(uint128 entryPrice, uint16 creatorFeeBps) public pure returns (uint256) {
        return uint256(entryPrice) + authorCommission(entryPrice, creatorFeeBps);
    }

    /**
     * What a defender takes back.
     *
     * UNPLAYED and CANCELLED return `paidIn` — entry, the author's
     * commission, and every probe bought. Nothing was consumed: there was no
     * round, so there is nothing the money can be said to have paid for.
     *
     * COMPLETED returns nothing at all. A round that ran is a round that was
     * delivered: the pool goes to whoever intercepted, and if nobody did it
     * goes to the Global Defense Pool to be played for again (ТЗ §17-18).
     */
    function refundDue(
        GameTypes.Ending ending,
        GameTypes.Participant storage participant
    ) public view returns (uint256) {
        if (ending == GameTypes.Ending.UNPLAYED || ending == GameTypes.Ending.CANCELLED) {
            return participant.paidIn;
        }
        return 0;
    }

    /**
     * What the creator takes back when the round never ran.
     *
     * The bounty comes home. The protocol fee they paid at mint does not —
     * that is the protocol's from the moment the operation exists, whether
     * or not the room ever filled.
     */
    function creatorRefundDue(GameTypes.Ending ending, GameTypes.LobbyConfig storage config)
        public
        view
        returns (uint256)
    {
        if (ending == GameTypes.Ending.UNPLAYED || ending == GameTypes.Ending.CANCELLED) {
            return uint256(config.startPrizePool);
        }
        return 0;
    }

    /**
     * The creator's settlement, in one figure whatever happened.
     *
     * On a round that ran, the author commission collected at join is earned
     * on a hit and on a miss alike — a creator is paid for filling an
     * operation, not for its result — and that is the whole of what they get.
     * The bounty does not come back on a miss: it is part of the pool, and an
     * unwon pool belongs to the Global Defense Pool.
     *
     * On a round that did not run — UNPLAYED or CANCELLED — the bounty comes
     * home untouched. The protocol creation fee stays with the treasury.
     */
    function creatorDue(
        GameTypes.Lobby storage lobby,
        GameTypes.LobbyConfig storage config,
        GameTypes.Outcome storage outcome
    ) public view returns (uint256 amount) {
        GameTypes.Ending ending = lobby.ending;

        if (ending == GameTypes.Ending.UNPLAYED || ending == GameTypes.Ending.CANCELLED) {
            return creatorRefundDue(ending, config);
        }
        if (ending != GameTypes.Ending.COMPLETED) return 0;

        amount = lobby.creatorFeeAccrued;
        if (outcome.intercepted) {
            // Rounding dust from splitting the pool between an exact tie: too
            // small to distribute, never left stranded.
            amount += uint256(lobby.rewardPool) - outcome.rewardPerWinner * outcome.winners.length;
        }
    }

    /**
     * Pays every defender `paidIn` and returns the bounty to the creator
     * (or to the Global Defense Pool, when this contract is the creator).
     *
     * Used when an under-filled room is cancelled: the players did not get
     * a game, so their entry and the author's commission come back in this
     * same transaction. The protocol creation fee is already in the treasury
     * and stays there.
     */
    function payoutUnplayed(AegylaxStorage.GameStorage storage $, bytes32 lobbyId) public {
        GameTypes.Lobby storage lobby = $.lobbies[lobbyId];
        GameTypes.LobbyConfig storage config = $.lobbyConfigs[lobbyId];
        address[] storage people = $.lobbyParticipants[lobbyId];
        for (uint256 i = 0; i < people.length; i++) {
            GameTypes.Participant storage participant = $.participants[lobbyId][people[i]];
            if (!participant.joined || participant.refunded) continue;
            uint256 due = participant.paidIn;
            if (due == 0) continue;
            participant.refunded = true;
            _pay(payable(people[i]), due);
            emit IAegylaxEvents.RefundClaimed(lobbyId, people[i], due);
        }

        if (lobby.creatorSettled) return;
        uint256 bounty = uint256(config.startPrizePool);
        lobby.creatorSettled = true;
        if (bounty == 0) return;

        if (lobby.creator == address(this)) {
            $.globalDefensePool += bounty;
            emit IAegylaxEvents.DefensePoolFunded(lobbyId, bounty, $.globalDefensePool);
            return;
        }

        _pay(payable(lobby.creator), bounty);
        emit IAegylaxEvents.CreatorSettled(lobbyId, lobby.creator, bounty);
    }

    error TransferFailed();

    function _pay(address payable to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}

// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {GameTypes} from "./GameTypes.sol";

/**
 * Who is owed what, once an operation has stopped moving.
 *
 * Every branch here answers the same question from a different seat — the
 * defender's, the creator's — and the answers have to add up to exactly what
 * was paid in, which is why they live together rather than beside the state
 * machine that calls them. Nothing in this library writes: it decides
 * amounts, and `AegylaxGame` decides whether the caller may have them.
 *
 * It is an external library for the same reason `ProtocolRules` and
 * `Resolution` are — the game implementation has to fit inside the EVM's
 * contract size limit, and money arithmetic is the kind of self-contained
 * branching that costs the most code for the least state.
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
     * What a defender takes back.
     *
     * UNPLAYED and CANCELLED return `paidIn` — every wei, including the seat
     * fee and every probe bought. Nothing was consumed: there was no round, so
     * there is nothing the money can be said to have paid for. The two are
     * separate endings because one is the room's fault and the other is the
     * protocol's, but the defender is owed the same thing either way and it
     * would be strange for that to depend on whose fault it was.
     *
     * COMPLETED returns nothing at all, and this is the rule that changed.
     * It used to hand back the entry money after the Creator Fee whenever the
     * threat got through — which meant a defender who watched the attack land
     * was refunded most of their stake, and an operation that lost was very
     * nearly free to have been in. An entry fee that comes back when you lose
     * is not a stake, and a game whose downside is a rounding error is not a
     * game. A round that ran is a round that was delivered: the pool goes to
     * whoever intercepted, and if nobody did it goes to the Global Defense
     * Pool to be played for again (ТЗ §17-18).
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
     * The creator's settlement, in one figure whatever happened.
     *
     * On a round that ran, the Creator Fee is earned on a hit and on a miss
     * alike — a creator is paid for filling an operation, not for its result —
     * and that is now the *whole* of what they get. The bounty does not come
     * back on a miss any more, and neither does the probe money: both are part
     * of the pool, and an unwon pool belongs to the Global Defense Pool. What
     * the old rule did was let a creator advertise a prize they only ever paid
     * out when somebody earned it, which made a large bounty costless to
     * promise and the advertised pool close to meaningless.
     *
     * On a round that did not run — UNPLAYED or CANCELLED — the bounty comes
     * home untouched, along with the creator's own seat fee, because the
     * creator pays that fee like every other participant (ТЗ §17) and
     * `refundDue` is what returns everybody else's.
     *
     * `creatorJoinFee` is passed rather than read off the lobby: the lobby's
     * `protocolFeeAccrued` is the whole room's fees, and only one seat's worth
     * of it is the creator's.
     */
    function creatorDue(
        GameTypes.Lobby storage lobby,
        GameTypes.LobbyConfig storage config,
        GameTypes.Outcome storage outcome,
        uint256 creatorJoinFee
    ) public view returns (uint256 amount) {
        GameTypes.Ending ending = lobby.ending;

        if (ending == GameTypes.Ending.UNPLAYED || ending == GameTypes.Ending.CANCELLED) {
            return uint256(config.startPrizePool) + creatorJoinFee;
        }
        if (ending != GameTypes.Ending.COMPLETED) return 0;

        amount = lobby.creatorFeeAccrued;
        if (outcome.intercepted) {
            // Rounding dust from splitting the pool between an exact tie: too
            // small to distribute, never left stranded.
            amount += uint256(lobby.rewardPool) - outcome.rewardPerWinner * outcome.winners.length;
        }
    }
}

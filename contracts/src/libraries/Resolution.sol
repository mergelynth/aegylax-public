// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {IConfidentialEngine} from "../interfaces/IConfidentialEngine.sol";
import {GameTypes} from "./GameTypes.sol";
import {Geometry} from "./Geometry.sol";

/**
 * Judging an attack (ТЗ §5).
 *
 * This is the part of the protocol that decides who won, and it is
 * deliberately the part with no discretion in it: every input is either
 * already on chain (when each defense was submitted, what the parameters
 * are) or arrives with a covalidator signature over it (the trajectory
 * angles, the coordinates). Nothing here trusts a caller.
 *
 * Two distinct facts come out of every defense, and keeping them apart is
 * the whole of the ranking rule:
 *
 *   intercepted — at this interceptor's arrival (submit + climb), the
 *                 threat was still in flight and inside the radius. A
 *                 point on the chord at some other time is not a hit:
 *                 twenty accounts on a static line are twenty independent
 *                 bets on different moments, not a wall.
 *   winner      — among those snapshot hits, the earliest *arrival*.
 *                 Exact arrival ties split the pool. Transaction order
 *                 is not a tie-break.
 */
library Resolution {
    error InvalidDecryptionProof(uint256 index);

    /// Everything one reveal needs to judge every defense, in one memory value.
    struct Context {
        Geometry.World world;
        GameTypes.Trajectory traj;
        uint256 radiusWu;
        uint64 launchBlock;
        uint32 flightBlocks;
        uint32 defenseSpeed;
    }

    function resolve(
        IConfidentialEngine engine,
        GameTypes.DefenseAttempt[] storage list,
        GameTypes.Outcome storage outcome,
        Context memory ctx,
        GameTypes.DecryptionProof[] memory proofs
    ) public {
        uint256 bestArrival = type(uint256).max;

        for (uint256 i = 0; i < list.length; i++) {
            GameTypes.DefenseAttempt storage attempt = list[i];
            if (!engine.verifyDecryption(attempt.pointHandle, proofs[i].value, proofs[i].signatures)) {
                // The index is the attempt's own. It used to carry a +2 for
                // the bearing and delta proofs that shared the call; those
                // are a separate, global transaction now.
                revert InvalidDecryptionProof(i);
            }

            Geometry.Point memory point = Geometry.unpackPoint(ctx.world, proofs[i].value);
            Geometry.DefenseEvaluation memory ev = Geometry.evaluateDefense(
                ctx.world,
                ctx.traj,
                point,
                ctx.radiusWu,
                ctx.launchBlock,
                ctx.flightBlocks,
                attempt.submittedAtBlock,
                ctx.defenseSpeed
            );

            attempt.revealed = true;
            attempt.x = point.x;
            attempt.y = point.y;
            attempt.arrivalBlockScaled = ev.arrivalBlockScaled;
            attempt.intercepted = ev.intercepted;
            attempt.interceptionBlockScaled = ev.interceptionBlockScaled;
            attempt.interceptX = ev.interceptX;
            attempt.interceptY = ev.interceptY;
            attempt.missDistanceWu = ev.missDistanceWu;

            if (ev.intercepted && ev.arrivalBlockScaled < bestArrival) {
                bestArrival = ev.arrivalBlockScaled;
            }
        }

        if (bestArrival == type(uint256).max) return;
        outcome.winningArrivalBlockScaled = bestArrival;

        for (uint256 i = 0; i < list.length; i++) {
            GameTypes.DefenseAttempt storage attempt = list[i];
            if (!attempt.intercepted || attempt.arrivalBlockScaled != bestArrival) continue;

            attempt.isWinner = true;
            outcome.winners.push(attempt.participant);
            if (
                outcome.interceptionBlockScaled == 0
                    || attempt.interceptionBlockScaled < outcome.interceptionBlockScaled
            ) {
                outcome.interceptionBlockScaled = attempt.interceptionBlockScaled;
                outcome.interceptX = attempt.interceptX;
                outcome.interceptY = attempt.interceptY;
            }
        }
    }
}

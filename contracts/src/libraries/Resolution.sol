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
 *   intercepted — the threat entered this Defense Point's radius, and the
 *                 interceptor was already on station when it did. Several
 *                 defenders can manage that geometrically. It is not a
 *                 payout: a point further along the path never meets the
 *                 live threat once an earlier circle has already stopped it.
 *   winner      — among those intercepts, the earliest *entry along the
 *                 trajectory* (`interceptionBlockScaled`). The attack ends
 *                 there. Climb time is only the on-station gate, not the
 *                 ranking: a ring of accounts around Earth with short climbs
 *                 cannot collect a win for covering a path that was already
 *                 shot down higher up.
 *
 * Exactly equal entry times leave more than one winner — two radii that
 * the threat enters at the same moment both actually stopped it. The
 * protocol has nothing further to rank by, and reaching for transaction
 * order would reward being early to the mempool rather than being right,
 * so an exact tie splits the pool.
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
        uint256 bestEntry = type(uint256).max;

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

            if (ev.intercepted && ev.interceptionBlockScaled < bestEntry) {
                bestEntry = ev.interceptionBlockScaled;
            }
        }

        if (bestEntry == type(uint256).max) return;

        for (uint256 i = 0; i < list.length; i++) {
            GameTypes.DefenseAttempt storage attempt = list[i];
            if (!attempt.intercepted || attempt.interceptionBlockScaled != bestEntry) continue;

            attempt.isWinner = true;
            outcome.winners.push(attempt.participant);
            if (
                outcome.winningArrivalBlockScaled == 0
                    || attempt.arrivalBlockScaled < outcome.winningArrivalBlockScaled
            ) {
                outcome.winningArrivalBlockScaled = attempt.arrivalBlockScaled;
            }
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

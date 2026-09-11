// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {IConfidentialEngine} from "../interfaces/IConfidentialEngine.sol";
import {DefenseMask} from "./DefenseMask.sol";
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
 * The coordinate that is verified is the *masked* word `M = P + K
 * (mod 2^128)` published at submit, not the player's private point. `K` is
 * the attack's one-time pad, published after impact. Unmasking is modular
 * subtraction in the clear. A caller who invents a nicer `P` still has to
 * produce an attestation of the handle committed at submit, and that handle
 * is `M`, not `P`.
 *
 * Two distinct facts come out of every defense:
 *
 *   intercepted — at this interceptor's submit block, the threat was
 *                 still in flight and inside the radius. A point on the
 *                 chord at some other time is not a hit: twenty accounts
 *                 on a static line are twenty independent bets on
 *                 different moments, not a wall. Submit early and wait —
 *                 miss. Submit after it passed — miss.
 *   winner      — the *earliest* snapshot hit, and only it. A threat taken
 *                 down high never reaches the interceptors waiting below,
 *                 so a later circle closed on something that was already
 *                 gone: correct point, correct moment, no kill, no pay.
 *                 Arrival is the submit block itself, so earliest hit and
 *                 highest kill are the same ordering.
 *
 * Ties are by block, and any number of defenses can share one. Every hit in
 * the winning block killed the same threat at the same coordinates, so
 * there is nothing left to rank them by and the pool splits equally among
 * all of them. Order within a block is the sequencer's choice, and it is
 * never allowed to decide money.
 *
 * Scoring can be a single pass (every attempt, one call) or a sequence of
 * subsets. Each subset writes that attempt's verdict and recrowns from
 * every attempt already revealed, so a later, earlier hit displaces a
 * previous crown before money is assigned. Finalizing is a separate step.
 */
library Resolution {
    error InvalidDecryptionProof(uint256 index);
    error UnknownAttempt(uint256 index);

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
        GameTypes.DecryptionProof[] memory proofs,
        uint256 maskKey
    ) public {
        uint32[] memory indices = new uint32[](list.length);
        for (uint256 i = 0; i < list.length; i++) {
            indices[i] = uint32(i);
        }
        scoreSubset(engine, list, outcome, ctx, proofs, indices, maskKey);
    }

    function scoreSubset(
        IConfidentialEngine engine,
        GameTypes.DefenseAttempt[] storage list,
        GameTypes.Outcome storage outcome,
        Context memory ctx,
        GameTypes.DecryptionProof[] memory proofs,
        uint32[] memory indices,
        uint256 maskKey
    ) public {
        if (proofs.length != indices.length) revert InvalidDecryptionProof(0);

        for (uint256 j = 0; j < indices.length; j++) {
            uint256 i = indices[j];
            if (i >= list.length) revert UnknownAttempt(i);

            GameTypes.DefenseAttempt storage attempt = list[i];
            if (attempt.revealed) continue;

            if (!engine.verifyDecryption(attempt.maskedHandle, proofs[j].value, proofs[j].signatures)) {
                revert InvalidDecryptionProof(i);
            }

            uint256 packed = DefenseMask.unmask(proofs[j].value, maskKey);
            Geometry.Point memory point = Geometry.unpackPoint(ctx.world, packed);
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
        }

        recrown(list, outcome);
    }

    /// Earliest revealed hit among what has been scored so far. Unrevealed
    /// attempts are ignored — they are not winners and they are not yet
    /// misses. Finalize after the grace window treats whatever is still
    /// sealed as a miss by simply never revealing it.
    function recrown(GameTypes.DefenseAttempt[] storage list, GameTypes.Outcome storage outcome) public {
        while (outcome.winners.length > 0) {
            outcome.winners.pop();
        }

        uint256 earliestHit = type(uint256).max;
        for (uint256 i = 0; i < list.length; i++) {
            GameTypes.DefenseAttempt storage attempt = list[i];
            attempt.isWinner = false;
            if (attempt.revealed && attempt.intercepted && attempt.arrivalBlockScaled < earliestHit) {
                earliestHit = attempt.arrivalBlockScaled;
            }
        }

        if (earliestHit == type(uint256).max) {
            outcome.intercepted = false;
            outcome.interceptX = 0;
            outcome.interceptY = 0;
            outcome.interceptionBlockScaled = 0;
            outcome.winningArrivalBlockScaled = 0;
            return;
        }

        for (uint256 i = 0; i < list.length; i++) {
            GameTypes.DefenseAttempt storage attempt = list[i];
            if (!attempt.revealed || !attempt.intercepted || attempt.arrivalBlockScaled != earliestHit) continue;

            attempt.isWinner = true;
            outcome.winners.push(attempt.participant);
            if (outcome.winners.length == 1) {
                outcome.interceptionBlockScaled = attempt.interceptionBlockScaled;
                outcome.interceptX = attempt.interceptX;
                outcome.interceptY = attempt.interceptY;
            }
        }

        outcome.intercepted = outcome.winners.length > 0;
        outcome.winningArrivalBlockScaled = earliestHit;
    }
}

// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

/**
 * Reconnaissance physics that must not live in `GameParams`.
 *
 * `GameParams` is packed inline in ERC-7201 storage. These two numbers are
 * protocol constants the way `Geometry.MAX_LAUNCH_OFFSET_MICRO_RAD` is:
 * changing them is a new deployment, not a governed parameter write, and
 * they do not shift a single storage slot under a running operation.
 *
 * Together they are what stops a bot farm from turning reconnaissance into
 * a solved ray:
 *
 *   - `BIAS_MICRO_RAD` is the half-width of a per-attack offset ε every
 *     probe on that attack shares. Extra sensor cells average away their
 *     own noise and converge on θ + ε, never on θ. The residual is small
 *     enough that thinking still pays, and large enough at the launch edge
 *     that "the highest point on the fused bearing" is not a unique hit.
 *   - `DELAY_BLOCKS` is how long a probe is in flight before its owner may
 *     read the hint. Sending another probe (or collecting this one) before
 *     that block reverts, so dumping an allowance in one block and locking
 *     a Defense Point in the next is not a legal line.
 */
library ReconRules {
    /// 5° in microradians. Half-width of the triangular attack bias ε.
    uint32 internal constant BIAS_MICRO_RAD = 87_266;

    /// Blocks a probe spends in flight before its hint can be granted.
    uint32 internal constant DELAY_BLOCKS = 8;
}

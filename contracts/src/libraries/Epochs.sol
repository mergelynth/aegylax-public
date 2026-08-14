// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

/**
 * The protocol's epoch grid, as pure arithmetic.
 *
 * The grid formulas and a domain tag, extracted here for one reason: the code
 * that *uses* them now lives in two places. `AegylaxStorage` needs them to
 * derive an attack's status and the protocol's counters, and `Lobbies` needs
 * them to schedule a threat — and these are the formulas every client in the
 * app independently reimplements to count down to the same block. Two copies
 * of consensus arithmetic that must agree to the block is exactly the kind of
 * duplication that stays correct until the day somebody changes one of them.
 *
 * `internal`, so it inlines into each user rather than becoming a fifth
 * deployed library and a delegatecall on the hottest read path there is.
 */
library Epochs {
    /**
     * Domain separator for an epoch attack's id.
     *
     * The id is derived rather than stored, so anybody can name the epoch's
     * attack from the epoch number alone. The tag keeps that derivation from
     * ever colliding with a lobby id, which is hashed from its own nonce.
     */
    bytes32 internal constant ATTACK_DOMAIN = keccak256("aegylax.attack.epoch");

    /**
     * Share of an epoch that must still remain after applications close
     * before the threat may launch. 90 / 100.
     *
     * Without this, a deadline on the last block of epoch N schedules the
     * attack for the first block of epoch N+1 — one block later. That is
     * not a round: there is nothing a defender can still do in one block,
     * and the join window and the launch read as the same event. If the
     * next boundary is closer than this fraction of an epoch, the
     * operation waits one more.
     *
     * Not a `GameParams` field: packing that struct is load-bearing, and
     * this is consensus arithmetic the way `epochOf` is. Changing it is a
     * new deployment.
     */
    uint32 internal constant MIN_LAUNCH_REMAINING_NUM = 90;
    uint32 internal constant MIN_LAUNCH_REMAINING_DEN = 100;

    function epochOf(uint64 blockNumber, uint32 epochBlocks, uint64 genesis) internal pure returns (uint32) {
        if (epochBlocks == 0 || blockNumber < genesis) return 0;
        return uint32((blockNumber - genesis) / epochBlocks);
    }

    function epochStart(uint32 epochId, uint32 epochBlocks, uint64 genesis) internal pure returns (uint64) {
        return genesis + uint64(epochId) * uint64(epochBlocks);
    }

    /// The epoch's attack id, derivable by anybody from the epoch number alone.
    function attackId(uint32 epochId) internal pure returns (bytes32) {
        return keccak256(abi.encode(ATTACK_DOMAIN, epochId));
    }

    /**
     * Which epoch a player-created operation's attack flies in, given the
     * block applications close on.
     *
     * The naive answer is "the epoch after the one the deadline falls in".
     * That is still the answer when that next boundary is far enough away;
     * it is not the answer when it would fire almost immediately.
     */
    function launchEpochOf(uint64 deadlineBlock, uint32 epochBlocks, uint64 genesis) internal pure returns (uint32) {
        uint32 deadlineEpoch = epochOf(deadlineBlock, epochBlocks, genesis);
        uint32 candidate = deadlineEpoch + 1;
        uint64 launchBlock = epochStart(candidate, epochBlocks, genesis);
        uint256 minGap = (uint256(epochBlocks) * MIN_LAUNCH_REMAINING_NUM) / MIN_LAUNCH_REMAINING_DEN;
        if (minGap == 0) minGap = 1;
        if (launchBlock <= deadlineBlock || uint256(launchBlock) - uint256(deadlineBlock) < minGap) {
            unchecked {
                candidate += 1;
            }
        }
        return candidate;
    }
}

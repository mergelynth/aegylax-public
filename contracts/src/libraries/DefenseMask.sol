// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

/**
 * One-time pad that makes every Defense Point publicly decryptable after a
 * *single* handle is unlocked.
 *
 * Each point stays an encrypted word `P` the player submitted. The engine
 * also publishes `M = P + K (mod 2^128)` with a global ACL the moment the
 * point is accepted. `M` is readable during the flight and is useless
 * without `K`. `K` is drawn with the attack and unlocked only after impact.
 *
 * Unmasking is then `P = M - K (mod 2^128)` — in the clear, off chain for
 * the map, on chain for a claim. No per-point `allowGlobal` at reveal.
 */
library DefenseMask {
    function mask(uint256 point, uint256 key) internal pure returns (uint256) {
        unchecked {
            return uint256(uint128(uint128(point) + uint128(key)));
        }
    }

    function unmask(uint256 masked, uint256 key) internal pure returns (uint256) {
        unchecked {
            return uint256(uint128(uint128(masked) - uint128(key)));
        }
    }
}

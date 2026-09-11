// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {DefenseMask} from "../src/libraries/DefenseMask.sol";

contract DefenseMaskTest is Test {
    function test_unmaskInvertsMask() public pure {
        uint256 p = 0x0123456789abcdef0123456789abcdef;
        uint256 k = 0xfedcba9876543210fedcba9876543210;
        assertEq(DefenseMask.unmask(DefenseMask.mask(p, k), k), p);
    }

    function test_wrapsAt128Bits(uint128 p, uint128 k) public pure {
        assertEq(DefenseMask.unmask(DefenseMask.mask(p, k), k), uint256(p));
    }

    function test_overflowWraps() public pure {
        uint256 p = type(uint128).max;
        uint256 k = 1;
        uint256 masked = DefenseMask.mask(p, k);
        assertEq(masked, 0);
        assertEq(DefenseMask.unmask(masked, k), p);
    }
}

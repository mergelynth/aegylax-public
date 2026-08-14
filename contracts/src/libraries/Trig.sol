// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

/**
 * Fixed-point sine/cosine, accurate to ~1e-9.
 *
 * The protocol needs trigonometry exactly twice per attack — placing the
 * target on Earth's surface and the launch point on the working area's
 * edge — and both happen once, inside the reveal. Everything the attack is
 * judged by afterwards (interception, arrival, winner) is pure algebra on
 * the resulting coordinates, so the accuracy that matters is the accuracy
 * of those two points, not of a per-block simulation.
 *
 * The implementation is range reduction plus a Taylor polynomial on
 * [0, π/4], where five terms land inside 2e-9 — a few millimetres at the
 * scale of a playfield measured in thousands of kilometres, and cheaper in
 * both code and gas than a lookup table of comparable accuracy.
 *
 * Nothing here is randomness: the *inputs* are the confidential angles, and
 * they arrive already decrypted and attested (ТЗ §3).
 */
library Trig {
    int256 internal constant WAD = 1e18;
    int256 internal constant PI = 3141592653589793238;
    int256 internal constant TWO_PI = 6283185307179586477;
    int256 internal constant HALF_PI = 1570796326794896619;
    int256 internal constant QUARTER_PI = 785398163397448310;

    /// Microradians -> WAD radians.
    function toWad(int256 microRad) internal pure returns (int256) {
        return microRad * 1e12;
    }

    function sinMicro(int256 microRad) internal pure returns (int256) {
        return sinWad(toWad(microRad));
    }

    function cosMicro(int256 microRad) internal pure returns (int256) {
        return sinWad(toWad(microRad) + HALF_PI);
    }

    function sinWad(int256 x) internal pure returns (int256) {
        x = x % TWO_PI;
        if (x < 0) x += TWO_PI;

        int256 sign = 1;
        if (x > PI) {
            x -= PI;
            sign = -1;
        }
        if (x > HALF_PI) {
            x = PI - x;
        }

        int256 magnitude = x <= QUARTER_PI ? _sinSmall(x) : _cosSmall(HALF_PI - x);
        return sign * magnitude;
    }

    function cosWad(int256 x) internal pure returns (int256) {
        return sinWad(x + HALF_PI);
    }

    /// sin(x) for x in [0, π/4]: x - x³/6 + x⁵/120 - x⁷/5040 + x⁹/362880.
    function _sinSmall(int256 x) private pure returns (int256) {
        int256 x2 = (x * x) / WAD;
        int256 term = x;
        int256 sum = x;
        term = (-term * x2) / WAD / 6;
        sum += term;
        term = (-term * x2) / WAD / 20;
        sum += term;
        term = (-term * x2) / WAD / 42;
        sum += term;
        term = (-term * x2) / WAD / 72;
        sum += term;
        return sum;
    }

    /// cos(x) for x in [0, π/4]: 1 - x²/2 + x⁴/24 - x⁶/720 + x⁸/40320 - x¹⁰/3628800.
    function _cosSmall(int256 x) private pure returns (int256) {
        int256 x2 = (x * x) / WAD;
        int256 term = WAD;
        int256 sum = WAD;
        term = (-term * x2) / WAD / 2;
        sum += term;
        term = (-term * x2) / WAD / 12;
        sum += term;
        term = (-term * x2) / WAD / 30;
        sum += term;
        term = (-term * x2) / WAD / 56;
        sum += term;
        term = (-term * x2) / WAD / 90;
        sum += term;
        return sum;
    }
}

// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {GameTypes} from "../src/libraries/GameTypes.sol";
import {Geometry} from "../src/libraries/Geometry.sol";
import {Trig} from "../src/libraries/Trig.sol";

/**
 * The geometry, on its own.
 *
 * These are the properties the game rests on and that no amount of
 * end-to-end testing would pin down: that the launch point really is on the
 * working area's edge whatever angle was drawn, that a trajectory never
 * passes through Earth on its way to its target, and that speed is derived
 * so an attack lands exactly at the end of its flight. They are fuzzed
 * across the whole range of confidential draws, because the whole range is
 * what the engine can produce.
 */
contract GeometryUnitTest is Test {
    uint32 constant FLIGHT = 150;

    function world() internal pure returns (Geometry.World memory) {
        return Geometry.buildWorld(10, 5, 1000);
    }

    // -----------------------------------------------------------------
    // Trigonometry
    // -----------------------------------------------------------------

    function test_sin_matchesKnownValues() public pure {
        assertApproxEqAbs(Trig.sinMicro(0), 0, 1e10);
        assertApproxEqAbs(Trig.sinMicro(1_570_796), 1e18, 1e10); // π/2
        assertApproxEqAbs(Trig.sinMicro(-1_570_796), -1e18, 1e10);
        assertApproxEqAbs(Trig.cosMicro(0), 1e18, 1e10);

        // The residual on these two is the *input* rounded to a
        // microradian, not the series: 3_141_593 µrad is π + 3.5e-7 and
        // 1_047_198 is 60° + 4.5e-7, so the answers are off by exactly the
        // sine of that. Angles reach this library already quantised by the
        // confidential layer, which makes a microradian the accuracy the
        // protocol actually works at.
        assertApproxEqAbs(Trig.cosMicro(1_047_198), 5e17, 1e12); // cos 60° = 0.5
        assertApproxEqAbs(Trig.sinMicro(3_141_593), 0, 1e12);
    }

    /// sin² + cos² = 1 everywhere, which is the whole accuracy claim in one line.
    function testFuzz_pythagoreanIdentity(int256 angle) public pure {
        angle = bound(angle, -6_283_185, 6_283_185);
        int256 s = Trig.sinMicro(angle);
        int256 c = Trig.cosMicro(angle);
        int256 sum = (s * s) / 1e18 + (c * c) / 1e18;
        assertApproxEqAbs(sum, 1e18, 1e10);
    }

    // -----------------------------------------------------------------
    // Trajectories
    // -----------------------------------------------------------------

    function testFuzz_launchPointIsAlwaysOnTheBoardsEdge(uint256 thetaRaw, uint256 deltaRaw) public pure {
        Geometry.World memory w = world();
        (thetaRaw, deltaRaw) = boundDraws(thetaRaw, deltaRaw);

        GameTypes.Trajectory memory traj = Geometry.deriveTrajectory(w, thetaRaw, deltaRaw, FLIGHT);

        int256 tolerance = 1e6; // 1 km
        bool onVertical = traj.startX <= tolerance || traj.startX >= w.widthWu - tolerance;
        bool onHorizontal = traj.startY <= tolerance || traj.startY >= w.heightWu - tolerance;
        assertTrue(onVertical || onHorizontal, "launch point must sit on the outer edge");

        assertTrue(traj.startX >= 0 && traj.startX <= w.widthWu);
        assertTrue(traj.startY >= 0 && traj.startY <= w.heightWu);
    }

    function testFuzz_targetIsAlwaysOnEarthsVisibleSurface(uint256 thetaRaw, uint256 deltaRaw) public pure {
        Geometry.World memory w = world();
        (thetaRaw, deltaRaw) = boundDraws(thetaRaw, deltaRaw);

        GameTypes.Trajectory memory traj = Geometry.deriveTrajectory(w, thetaRaw, deltaRaw, FLIGHT);

        uint256 fromCenter =
            Geometry.distance(Geometry.Point(traj.targetX, traj.targetY), Geometry.Point(w.centerX, w.centerY));
        assertApproxEqAbs(fromCenter, uint256(w.radiusWu), 1e6);

        // On the board, so a defender can actually reach it.
        assertTrue(traj.targetY >= 0 && traj.targetY <= w.heightWu);
        assertTrue(traj.targetX >= 0 && traj.targetX <= w.widthWu);
    }

    /**
     * The one property the whole attack model depends on: the threat
     * approaches its target from outside, never through the planet.
     *
     * The segment enters the disc early exactly when it arrives from the
     * inward side of the tangent plane at the target, so the test is one dot
     * product — and it holding for every draw is what makes the ±55° bound
     * on δ a guarantee rather than a hope.
     */
    function testFuzz_trajectoryNeverClipsEarth(uint256 thetaRaw, uint256 deltaRaw) public pure {
        Geometry.World memory w = world();
        (thetaRaw, deltaRaw) = boundDraws(thetaRaw, deltaRaw);

        GameTypes.Trajectory memory traj = Geometry.deriveTrajectory(w, thetaRaw, deltaRaw, FLIGHT);

        int256 normalX = traj.targetX - w.centerX;
        int256 normalY = traj.targetY - w.centerY;
        int256 dot = (traj.startX - traj.targetX) * normalX + (traj.startY - traj.targetY) * normalY;
        assertGt(dot, 0, "approach must come from outside the globe");
    }

    /// ТЗ §4: distance varies per attack, and speed is what absorbs it.
    function testFuzz_speedIsDerivedFromDistanceAndFlightTime(uint256 thetaRaw, uint256 deltaRaw) public pure {
        Geometry.World memory w = world();
        (thetaRaw, deltaRaw) = boundDraws(thetaRaw, deltaRaw);

        GameTypes.Trajectory memory traj = Geometry.deriveTrajectory(w, thetaRaw, deltaRaw, FLIGHT);

        assertGt(traj.lengthWu, 0);
        assertEq(traj.speedWuPerBlock, traj.lengthWu / FLIGHT);
        // Travelling at that speed for the whole flight covers the path.
        assertApproxEqRel(traj.speedWuPerBlock * FLIGHT, traj.lengthWu, 1e15);
    }

    // -----------------------------------------------------------------
    // Interception
    // -----------------------------------------------------------------

    function test_entryIsTheMomentTheRadiusIsCrossed() public pure {
        Geometry.Point memory a = Geometry.Point(0, 0);
        Geometry.Point memory b = Geometry.Point(1000e6, 0);
        Geometry.Point memory center = Geometry.Point(500e6, 0);

        (bool entered, uint256 t, int256 x,) = Geometry.firstEntry(a, b, center, 100e6);
        assertTrue(entered);
        // The circle starts 400 km along a 1000 km path.
        assertApproxEqAbs(t, 400_000, 1000);
        assertApproxEqAbs(uint256(x), 400e6, 1e6);
    }

    function test_pathThatMissesTheCircleNeverEnters() public pure {
        Geometry.Point memory a = Geometry.Point(0, 0);
        Geometry.Point memory b = Geometry.Point(1000e6, 0);
        Geometry.Point memory center = Geometry.Point(500e6, 300e6);

        (bool entered,,,) = Geometry.firstEntry(a, b, center, 100e6);
        assertFalse(entered);
    }

    /// A circle the path only reaches after it has landed is not an interception.
    function test_entryBeyondTheEndOfTheFlightIsNotAnInterception() public pure {
        Geometry.Point memory a = Geometry.Point(0, 0);
        Geometry.Point memory b = Geometry.Point(100e6, 0);
        Geometry.Point memory center = Geometry.Point(1000e6, 0);

        (bool entered,,,) = Geometry.firstEntry(a, b, center, 50e6);
        assertFalse(entered);
    }

    function test_snapshotAtSubmitIsTheIntercept() public pure {
        Geometry.World memory w = world();
        GameTypes.Trajectory memory traj;
        traj.startX = 0;
        traj.startY = w.heightWu / 2;
        traj.targetX = w.widthWu;
        traj.targetY = w.heightWu / 2;
        Geometry.Point memory p = Geometry.Point(w.widthWu / 2, w.heightWu / 2);
        uint256 radius = Geometry.interceptRadiusWu(w, 140);

        Geometry.DefenseEvaluation memory early =
            Geometry.evaluateDefense(w, traj, p, radius, 1000, 150, 1000, 250);
        assertFalse(early.intercepted, "submit at launch is before the threat");

        uint256 passScaled = uint256(1000) * GameTypes.TIME_SCALE + (uint256(150) * GameTypes.TIME_SCALE) / 2;
        uint64 submitAt = uint64(passScaled / GameTypes.TIME_SCALE);
        Geometry.DefenseEvaluation memory timed =
            Geometry.evaluateDefense(w, traj, p, radius, 1000, 150, submitAt, 250);
        assertTrue(timed.intercepted, "submit when the threat is there");
        assertEq(timed.interceptionBlockScaled, timed.arrivalBlockScaled);
    }

    function test_arrivalEqualsSubmitRegardlessOfAltitude() public pure {
        Geometry.World memory w = world();

        uint256 near = Geometry.arrivalBlockScaled(w, Geometry.Point(w.centerX, w.heightWu), 100, 250);
        uint256 far = Geometry.arrivalBlockScaled(w, Geometry.Point(w.centerX, 0), 100, 250);
        assertEq(near, uint256(100) * GameTypes.TIME_SCALE);
        assertEq(far, near);

        uint256 laterSubmission = Geometry.arrivalBlockScaled(w, Geometry.Point(w.centerX, 0), 110, 250);
        assertEq(laterSubmission - far, 10 * GameTypes.TIME_SCALE);
    }

    function test_packedPointsRoundTrip() public pure {
        Geometry.World memory w = world();
        uint256 packed = Geometry.packPoint(1234e6, 4321e6);
        Geometry.Point memory p = Geometry.unpackPoint(w, packed);
        assertEq(p.x, 1234e6);
        assertEq(p.y, 4321e6);
    }

    /// A point outside the board is clamped, never allowed to abort a reveal.
    function test_outOfBoundsPointsAreClamped() public pure {
        Geometry.World memory w = world();
        Geometry.Point memory p = Geometry.unpackPoint(w, Geometry.packPoint(type(uint128).max, type(uint128).max));
        assertEq(p.x, w.widthWu);
        assertEq(p.y, w.heightWu);
    }

    function boundDraws(uint256 thetaRaw, uint256 deltaRaw) internal pure returns (uint256, uint256) {
        uint256 l = uint256(Geometry.MAX_LAUNCH_OFFSET_MICRO_RAD);
        uint256 d = uint256(Geometry.MAX_IMPACT_DELTA_MICRO_RAD);

        thetaRaw = bound(thetaRaw, 0, 2 * l);
        // The same window the confidential engine samples δ inside.
        uint256 loRaw = d - (thetaRaw < d ? thetaRaw : d);
        uint256 hiRaw = 2 * l + d - thetaRaw;
        if (hiRaw > 2 * d) hiRaw = 2 * d;
        deltaRaw = bound(deltaRaw, loRaw, hiRaw);

        return (thetaRaw, deltaRaw);
    }
}

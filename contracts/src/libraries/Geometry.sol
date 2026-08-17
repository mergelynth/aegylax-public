// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {GameTypes} from "./GameTypes.sol";
import {Trig} from "./Trig.sol";

/**
 * The playfield, the attack, and interception — the protocol's whole
 * geometry, on chain.
 *
 * The field is `columns x rows` square sectors of `sectorSpanKm` each, with
 * Earth hanging off its bottom edge as a disc whose centre sits below the
 * board, so only the cap is in play. An attack is a straight line from a
 * point on the working area's outer edge to a point on that cap.
 *
 * The confidential half of an attack is two angles, and only two:
 *
 *   θ — the bearing from Earth's centre to the launch point. The launch
 *       point itself is *derived*: it is where that ray leaves the board,
 *       which is what makes it a point on the outer edge (ТЗ §4) whatever
 *       the board's shape.
 *   δ — how far around the globe the impact point sits from that bearing.
 *
 * Sampling in this parametrisation rather than (impact angle, approach
 * angle) is what lets the confidential layer stay cheap: both angles are
 * plain bounded integers, so generating them, adding noise to them for a
 * probe, and constraining δ against θ are all integer operations, and no
 * trigonometry ever has to run over encrypted data. The trigonometry runs
 * once, here, on the decrypted-and-attested angles at reveal time.
 *
 * Interception is a *spacetime* test (ТЗ §5): the threat is a point
 * travelling P_start -> P_target over the flight. A defense succeeds only
 * if, at the submit block, that moving point sits inside the radius.
 * Being on the chord at some other time is not enough — a wall of points
 * covering the path still miss unless each one is sent at the moment the
 * threat is actually there. Every snapshot hit splits the pool. An exact
 * submit tie is just another split.
 */
library Geometry {
    using Math for uint256;

    int256 internal constant WU = GameTypes.WU;
    uint256 internal constant TIME_SCALE = GameTypes.TIME_SCALE;

    /// Earth's radius and how far its centre sits below the field, in thousandths of a sector.
    int256 internal constant EARTH_RADIUS_MILLI_SECTORS = 2300;
    int256 internal constant EARTH_CENTER_BELOW_MILLI_SECTORS = 850;

    /// How far off "straight up" the launch bearing may be drawn: ±60°.
    int256 internal constant MAX_LAUNCH_OFFSET_MICRO_RAD = 1_047_198;
    /// How far around the globe the impact may sit from the launch bearing: ±55°.
    int256 internal constant MAX_IMPACT_DELTA_MICRO_RAD = 959_931;

    int256 internal constant HALF_PI_MICRO_RAD = 1_570_796;

    struct World {
        int256 widthWu;
        int256 heightWu;
        int256 sectorWu;
        int256 centerX;
        int256 centerY;
        int256 radiusWu;
    }

    struct Point {
        int256 x;
        int256 y;
    }

    /// One defense evaluated against one trajectory.
    struct DefenseEvaluation {
        bool intercepted;
        /// Block ×1e6 of the intercept — equal to arrival when it hit.
        uint256 interceptionBlockScaled;
        int256 interceptX;
        int256 interceptY;
        uint256 missDistanceWu;
        /// Block ×1e6 of the snapshot — the submit block.
        uint256 arrivalBlockScaled;
    }

    function buildWorld(uint16 columns, uint16 rows, uint32 sectorSpanKm) public pure returns (World memory w) {
        int256 sectorWu = int256(uint256(sectorSpanKm)) * WU;
        w.sectorWu = sectorWu;
        w.widthWu = int256(uint256(columns)) * sectorWu;
        w.heightWu = int256(uint256(rows)) * sectorWu;
        w.centerX = w.widthWu / 2;
        w.centerY = w.heightWu + (sectorWu * EARTH_CENTER_BELOW_MILLI_SECTORS) / 1000;
        w.radiusWu = (sectorWu * EARTH_RADIUS_MILLI_SECTORS) / 1000;
    }

    function interceptRadiusWu(World memory w, uint32 radiusMilliSectors) public pure returns (uint256) {
        return uint256((w.sectorWu * int256(uint256(radiusMilliSectors))) / 1000);
    }

    /**
     * Whether a board can host the attack model at all.
     *
     * A trajectory must reach its target without passing through Earth
     * first. With the target on the surface at angle θ+δ and the launch
     * point on the ray at θ, that holds exactly when
     * `launchDistance * cos(δ) > earthRadius`. The shortest launch distance
     * on any board is straight up, `(rows + 0.85) * sector`, so this is a
     * property of the *grid*, checked once when protocol parameters are set
     * rather than hoped for per attack.
     */
    function boardSupportsAttacks(uint16 rows, uint32 /*sectorSpanKm*/ ) public pure returns (bool) {
        int256 minLaunchMilli = (int256(uint256(rows)) * 1000) + EARTH_CENTER_BELOW_MILLI_SECTORS;
        int256 cosDelta = Trig.cosMicro(MAX_IMPACT_DELTA_MICRO_RAD); // WAD
        return (minLaunchMilli * cosDelta) / 1e18 > EARTH_RADIUS_MILLI_SECTORS;
    }

    /**
     * The trajectory behind a pair of confidential draws.
     *
     * `thetaRaw` is θ shifted into [0, 2·MAX_LAUNCH_OFFSET] and `deltaRaw`
     * is δ shifted into [0, 2·MAX_IMPACT_DELTA]; the confidential layer only
     * ever handles non-negative bounded integers, and the recentring
     * happens here, in the clear.
     */
    function deriveTrajectory(World memory w, uint256 thetaRaw, uint256 deltaRaw, uint32 flightBlocks)
        public
        pure
        returns (GameTypes.Trajectory memory traj)
    {
        int256 theta = int256(thetaRaw) - MAX_LAUNCH_OFFSET_MICRO_RAD;
        int256 delta = int256(deltaRaw) - MAX_IMPACT_DELTA_MICRO_RAD;

        // Screen convention: angles run from +x with y downward, so
        // "straight up out of the planet" is -π/2.
        int256 launchBearing = -HALF_PI_MICRO_RAD + theta;
        int256 impactAngle = launchBearing + delta;

        Point memory target = pointOnEarth(w, impactAngle);
        Point memory start = rayExit(w, launchBearing);

        uint256 lengthWu = distance(start, target);

        traj.startX = start.x;
        traj.startY = start.y;
        traj.targetX = target.x;
        traj.targetY = target.y;
        traj.impactAngleMicroRad = impactAngle;
        traj.launchBearingMicroRad = launchBearing;
        traj.lengthWu = lengthWu;
        // ТЗ §4: speed is derived, never configured — that is what makes
        // every attack reach P_target exactly at the end of its flight
        // however long its path turned out to be.
        traj.speedWuPerBlock = flightBlocks == 0 ? 0 : lengthWu / flightBlocks;
    }

    function pointOnEarth(World memory w, int256 angleMicroRad) internal pure returns (Point memory p) {
        p.x = w.centerX + (w.radiusWu * Trig.cosMicro(angleMicroRad)) / 1e18;
        p.y = w.centerY + (w.radiusWu * Trig.sinMicro(angleMicroRad)) / 1e18;
    }

    /**
     * Where the ray leaving Earth's centre on `angleMicroRad` exits the
     * board — the launch point of ТЗ §4, "a point on the outer edge of the
     * working area".
     *
     * Earth's centre is *below* the board, so the ray crosses the board and
     * the far crossing is the one on its outer edge. Slab clipping gives
     * both crossings; this takes the far one.
     */
    function rayExit(World memory w, int256 angleMicroRad) internal pure returns (Point memory p) {
        int256 dx = Trig.cosMicro(angleMicroRad); // WAD
        int256 dy = Trig.sinMicro(angleMicroRad); // WAD

        int256 tFar = type(int256).max;

        if (dx != 0) {
            int256 t1 = ((0 - w.centerX) * 1e18) / dx;
            int256 t2 = ((w.widthWu - w.centerX) * 1e18) / dx;
            int256 far = t1 > t2 ? t1 : t2;
            if (far < tFar) tFar = far;
        }
        if (dy != 0) {
            int256 t1 = ((0 - w.centerY) * 1e18) / dy;
            int256 t2 = ((w.heightWu - w.centerY) * 1e18) / dy;
            int256 far = t1 > t2 ? t1 : t2;
            if (far < tFar) tFar = far;
        }
        if (tFar == type(int256).max) tFar = 0;
        if (tFar < 0) tFar = 0;

        p.x = w.centerX + (dx * tFar) / 1e18;
        p.y = w.centerY + (dy * tFar) / 1e18;

        // Clamp away the last unit of rounding so a launch point is always
        // reported strictly on the board.
        if (p.x < 0) p.x = 0;
        if (p.x > w.widthWu) p.x = w.widthWu;
        if (p.y < 0) p.y = 0;
        if (p.y > w.heightWu) p.y = w.heightWu;
    }

    /**
     * One Defense Point against one trajectory (ТЗ §5).
     *
     * The threat is sampled at the submit block — not tested against the
     * whole chord. `intercepted` iff submit is still during the flight and
     * the moving point is inside the radius *then*. Submitting before the
     * threat reaches this altitude is a miss (TOO EARLY), the same as
     * submitting after it has passed (TOO LATE). Parking on the path and
     * waiting is not a hit. Every snapshot hit splits the pool.
     */
    function evaluateDefense(
        World memory w,
        GameTypes.Trajectory memory traj,
        Point memory p,
        uint256 radiusWu,
        uint64 launchBlock,
        uint32 flightBlocks,
        uint64 submittedAtBlock,
        uint32 defenseSpeedKmPerBlock
    ) public pure returns (DefenseEvaluation memory ev) {
        Point memory a = Point(traj.startX, traj.startY);
        Point memory b = Point(traj.targetX, traj.targetY);

        ev.arrivalBlockScaled = arrivalBlockScaled(w, p, submittedAtBlock, defenseSpeedKmPerBlock);

        uint256 launchScaled = uint256(launchBlock) * TIME_SCALE;
        uint256 impactScaled = uint256(uint256(launchBlock) + uint256(flightBlocks)) * TIME_SCALE;
        bool inFlight = flightBlocks > 0 && ev.arrivalBlockScaled >= launchScaled && ev.arrivalBlockScaled < impactScaled;

        if (inFlight) {
            uint256 tScaled = (ev.arrivalBlockScaled - launchScaled) / uint256(flightBlocks);
            if (tScaled > TIME_SCALE) tScaled = TIME_SCALE;
            Point memory threat = pointAlong(a, b, tScaled);
            ev.missDistanceWu = distance(p, threat);
            if (ev.missDistanceWu <= radiusWu) {
                ev.intercepted = true;
                ev.interceptX = threat.x;
                ev.interceptY = threat.y;
                ev.interceptionBlockScaled = ev.arrivalBlockScaled;
                return ev;
            }
        } else {
            ev.missDistanceWu = closestApproachDistance(p, a, b);
        }

        // Miss classification only — payout already returned above. A chord
        // that would have passed through this circle is TOO EARLY / TOO LATE,
        // not a spatial miss, once the snapshot has failed.
        (bool entered, uint256 entryT, int256 ex, int256 ey) = firstEntry(a, b, p, radiusWu);
        if (entered && flightBlocks > 0) {
            ev.interceptionBlockScaled = launchScaled + (entryT * uint256(flightBlocks)) / TIME_SCALE;
            ev.interceptX = ex;
            ev.interceptY = ey;
        }
    }

    function pointAlong(Point memory a, Point memory b, uint256 tScaled) internal pure returns (Point memory) {
        return Point(
            a.x + ((b.x - a.x) * int256(tScaled)) / int256(TIME_SCALE),
            a.y + ((b.y - a.y) * int256(tScaled)) / int256(TIME_SCALE)
        );
    }

    /**
     * When the snapshot is taken for a point submitted at `submittedAtBlock`.
     *
     * Arrival is the submit block itself. `w`, `p` and climb speed are kept
     * on the signature so existing callers and the GameParams layout stay
     * compatible; they do not move the clock.
     */
    function arrivalBlockScaled(World memory, Point memory, uint64 submittedAtBlock, uint32)
        internal
        pure
        returns (uint256)
    {
        return uint256(submittedAtBlock) * TIME_SCALE;
    }

    /**
     * When a moving threat first crosses a circle. Not the intercept test —
     * that is the snapshot at submit. Kept so a miss can be told apart from
     * "wrong time on a path that would have passed through".
     */
    function firstEntry(Point memory a, Point memory b, Point memory center, uint256 radius)
        internal
        pure
        returns (bool entered, uint256 tScaled, int256 x, int256 y)
    {
        int256 dx = b.x - a.x;
        int256 dy = b.y - a.y;
        int256 ox = a.x - center.x;
        int256 oy = a.y - center.y;

        int256 qa = dx * dx + dy * dy;
        int256 qb = 2 * (ox * dx + oy * dy);
        int256 qc = ox * ox + oy * oy - int256(radius) * int256(radius);

        // Already inside the radius at launch. Impossible with a launch
        // point on the board's edge, but the algebra should not depend on it.
        if (qc <= 0) return (true, 0, a.x, a.y);
        if (qa == 0) return (false, 0, 0, 0);

        int256 disc = qb * qb - 4 * qa * qc;
        if (disc < 0) return (false, 0, 0, 0);

        uint256 root = Math.sqrt(uint256(disc));
        int256 numerator = -qb - int256(root);
        if (numerator < 0) return (false, 0, 0, 0);

        uint256 t = (uint256(numerator) * TIME_SCALE) / uint256(2 * qa);
        if (t > TIME_SCALE) return (false, 0, 0, 0);

        return (true, t, a.x + (dx * int256(t)) / int256(TIME_SCALE), a.y + (dy * int256(t)) / int256(TIME_SCALE));
    }

    /// How near a miss was: the closest the trajectory ever came to the point.
    function closestApproachDistance(Point memory p, Point memory a, Point memory b) internal pure returns (uint256) {
        int256 dx = b.x - a.x;
        int256 dy = b.y - a.y;
        int256 lengthSquared = dx * dx + dy * dy;
        if (lengthSquared == 0) return distance(p, a);

        int256 tScaled = (((p.x - a.x) * dx + (p.y - a.y) * dy) * int256(TIME_SCALE)) / lengthSquared;
        if (tScaled < 0) tScaled = 0;
        if (tScaled > int256(TIME_SCALE)) tScaled = int256(TIME_SCALE);

        Point memory closest =
            Point(a.x + (dx * tScaled) / int256(TIME_SCALE), a.y + (dy * tScaled) / int256(TIME_SCALE));
        return distance(p, closest);
    }

    function distance(Point memory a, Point memory b) internal pure returns (uint256) {
        int256 dx = b.x - a.x;
        int256 dy = b.y - a.y;
        return Math.sqrt(uint256(dx * dx + dy * dy));
    }

    /**
     * Unpacks the single confidential word a defender submits.
     *
     * `x | (y << 128)`, both in wu, both non-negative because the board's
     * origin is its own corner. Out-of-board values are clamped rather than
     * rejected: the point was chosen inside a sector on a grid, so anything
     * outside is rounding or mischief, and neither should be able to abort
     * a reveal that every other player is waiting on.
     */
    function unpackPoint(World memory w, uint256 packed) public pure returns (Point memory p) {
        p.x = int256(packed & type(uint128).max);
        p.y = int256(packed >> 128);
        if (p.x > w.widthWu) p.x = w.widthWu;
        if (p.y > w.heightWu) p.y = w.heightWu;
    }

    function packPoint(uint256 x, uint256 y) internal pure returns (uint256) {
        return (x & type(uint128).max) | (y << 128);
    }
}

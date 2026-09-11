import type { DefensePoint, MapGridConfig, Point2D, Sector } from './types'

/**
 * The playfield's canonical geometry — one coordinate system that every
 * client, in either orientation, agrees on (ТЗ §16.4).
 *
 * The field is the grid: `columns x rows` square sectors, addressed by the
 * same `{ column, row }` pair the rest of the game uses. Earth sits on its
 * bottom edge as a disc whose centre is below the board — only the cap is
 * in play — and an attack is a straight line from outside the field to a
 * point on that cap (ТЗ §3.1-3.2).
 *
 * Two properties make this space worth having as its own module:
 *
 *   - It is *isotropic*. One sector is one square, `sectorSpanKm` on each
 *     side, so a circle here is a circle on screen and an interception
 *     radius means the same thing along both axes. The previous model
 *     mapped one square world range onto both a 10-column and a 5-row
 *     axis, which quietly made "distance" mean different things
 *     horizontally and vertically.
 *   - It is *orientation-independent*. Nothing here knows about the
 *     portrait transposition; `game/spaceGrid.ts` applies that when it
 *     projects to the screen. Two players on a phone and a desktop
 *     therefore compute the same interception from the same numbers
 *     (ТЗ §2.6-2.7, §16.4-16.5).
 *
 * The scale is *declared*, by one number: how many km a sector is across.
 * That inversion is what ТЗ §5 asks for. An attack starts on the field's
 * own outer edge and ends on Earth, so its length is whatever that geometry
 * gives — different every time — and speed is derived from it so that every
 * attack lands exactly at the epoch boundary. The board can therefore no
 * longer be sized from a flight distance that is no longer a constant.
 */

/**
 * Earth's radius and how far its centre sits *below* the field's bottom
 * edge, both in sectors. Only the top cap is on the board, which is why
 * the bottom row of cells is trimmed by an arc rather than cut in half.
 *
 * The two numbers are chosen so this canonical disc lines up with the one
 * `earthDiscInScene` derives from the hero stylesheet — on a typical
 * landscape scene the grid is width-limited, so one sector is a tenth of
 * the scene's width and `2.3 / 0.85` lands within a percent of
 * `clamp(320px, 46vw, 680px)` with `translate(-50%, 60%)`.
 *
 * They do not have to agree exactly, and cannot: the stylesheet anchors
 * the globe to the *scene's* bottom edge while the grid is centred in the
 * scene, so any leftover margin separates them. The division of labour is
 * what makes that safe — the drawn disc is authoritative for everything on
 * screen (the grid's clip, the Command Center, the impact marker), and the
 * canonical one is authoritative for the protocol's maths. Keeping them
 * close is a matter of the picture matching the fiction, not of
 * correctness.
 */
export const EARTH_RADIUS_SECTORS = 2.3
export const EARTH_CENTER_BELOW_FIELD_SECTORS = 0.85

/**
 * How far off "straight up" the launch bearing θ may sit.
 *
 * Matches Geometry.sol `MAX_LAUNCH_OFFSET_MICRO_RAD` (60°). The chain
 * samples this first; the impact is θ + δ, not an independent draw on the
 * cap.
 */
export const MAX_LAUNCH_OFFSET_RADIANS = (60 * Math.PI) / 180

/**
 * How far off the top of the globe a standalone impact draw may sit.
 *
 * Earth's centre is below the board, so only the upper cap is in play — an
 * impact further round would land past the board's bottom edge, where
 * nothing can be defended. Measured from "straight up" (screen -y); ±60°
 * keeps every impact strictly on the part of the cap the grid covers, with
 * room to spare. Attack generation no longer uses this: the chain samples
 * θ then δ. Kept for the helpers that still draw a point on the cap.
 */
export const MAX_IMPACT_OFFSET_RADIANS = MAX_LAUNCH_OFFSET_RADIANS

export interface WorldGeometry {
  grid: MapGridConfig
  /** Side of one sector, in km. The world's one declared scale (ТЗ §5). */
  sectorSpanKm: number
  widthKm: number
  heightKm: number
  /** Earth's disc: bottom-centre of the field, its centre below the board, in the same km units. */
  earth: { center: Point2D; radiusKm: number }
}

/**
 * Builds the field for a grid and a sector size.
 *
 * Everything else about the playfield follows from those two: the board is
 * `columns x rows` squares of `sectorSpanKm`, and Earth is a disc of fixed
 * size in sectors hanging off its bottom edge. Nothing here knows about
 * attacks — an attack is generated *into* this field (`game/attacks.ts`)
 * rather than the field being sized around an attack.
 */
export function buildWorld(grid: MapGridConfig, sectorSpanKm: number): WorldGeometry {
  const widthKm = grid.columns * sectorSpanKm
  const heightKm = grid.rows * sectorSpanKm

  return {
    grid,
    sectorSpanKm,
    widthKm,
    heightKm,
    earth: {
      // Bottom-centre of the board, dropped below its edge so only the cap
      // is on screen — the horizon the whole scene is built around.
      center: { x: widthKm / 2, y: heightKm + EARTH_CENTER_BELOW_FIELD_SECTORS * sectorSpanKm },
      radiusKm: EARTH_RADIUS_SECTORS * sectorSpanKm,
    },
  }
}

// ---------------------------------------------------------------------------
// Sectors
// ---------------------------------------------------------------------------

export interface SectorRect {
  xMin: number
  yMin: number
  xMax: number
  yMax: number
}

export function sectorRect(sector: Sector, world: WorldGeometry): SectorRect {
  const span = world.sectorSpanKm
  return {
    xMin: sector.column * span,
    yMin: sector.row * span,
    xMax: (sector.column + 1) * span,
    yMax: (sector.row + 1) * span,
  }
}

export function sectorCenterKm(sector: Sector, world: WorldGeometry): Point2D {
  const rect = sectorRect(sector, world)
  return { x: (rect.xMin + rect.xMax) / 2, y: (rect.yMin + rect.yMax) / 2 }
}

export function sectorFromWorldPoint(point: Point2D, world: WorldGeometry): Sector {
  const span = world.sectorSpanKm
  return {
    column: clamp(Math.floor(point.x / span), 0, world.grid.columns - 1),
    row: clamp(Math.floor(point.y / span), 0, world.grid.rows - 1),
  }
}

/**
 * A Defense Point is a sector plus a fraction along each of that sector's
 * own axes, so it survives a grid resize and reads the same in either
 * orientation. This is the only conversion to absolute km — nothing else
 * should re-derive it (ТЗ §7.5, §7.9).
 */
export function defensePointToWorld(point: DefensePoint, world: WorldGeometry): Point2D {
  const rect = sectorRect(point.sector, world)
  return {
    x: rect.xMin + clamp01(point.offsetX) * world.sectorSpanKm,
    y: rect.yMin + clamp01(point.offsetY) * world.sectorSpanKm,
  }
}

/** Km back to a sector-relative Defense Point, clamped into the field. */
export function worldToDefensePoint(point: Point2D, world: WorldGeometry): DefensePoint {
  const sector = sectorFromWorldPoint(point, world)
  const rect = sectorRect(sector, world)
  return {
    sector,
    offsetX: clamp01((point.x - rect.xMin) / world.sectorSpanKm),
    offsetY: clamp01((point.y - rect.yMin) / world.sectorSpanKm),
  }
}

/** Fractions along the field's own column/row axes — what `game/spaceGrid.ts` projects to pixels. */
export function worldToUnit(point: Point2D, world: WorldGeometry): { unitColumn: number; unitRow: number } {
  return { unitColumn: point.x / world.widthKm, unitRow: point.y / world.heightKm }
}

// ---------------------------------------------------------------------------
// Geometry used by attack generation and interception
// ---------------------------------------------------------------------------

export function isInsideEarth(point: Point2D, world: WorldGeometry): boolean {
  return distance(point, world.earth.center) <= world.earth.radiusKm
}

export function isInsideField(point: Point2D, world: WorldGeometry, tolerance = 0): boolean {
  return (
    point.x >= -tolerance &&
    point.x <= world.widthKm + tolerance &&
    point.y >= -tolerance &&
    point.y <= world.heightKm + tolerance
  )
}

/**
 * Turns a 0..1 draw into an impact angle on the *visible* part of the
 * globe. Angles are measured from the +x axis with y running down, so
 * "straight up out of the planet" is -90°, and the draw spreads either
 * side of it by at most `MAX_IMPACT_OFFSET_RADIANS`.
 *
 * Keeping this a single function rather than a raw `rng() * 2π` is what
 * stops an attack from being generated against the half of Earth that is
 * below the board, where no defender could see or reach it.
 */
export function impactAngleFromUnit(unit: number): number {
  return -Math.PI / 2 + (unit * 2 - 1) * MAX_IMPACT_OFFSET_RADIANS
}

/** A point on Earth's surface, at `angleRadians` measured from the +x axis. */
export function pointOnEarthSurface(angleRadians: number, world: WorldGeometry): Point2D {
  return {
    x: world.earth.center.x + Math.cos(angleRadians) * world.earth.radiusKm,
    y: world.earth.center.y + Math.sin(angleRadians) * world.earth.radiusKm,
  }
}

/**
 * How far off the launch bearing the impact may sit (δ).
 *
 * Matches Geometry.sol `MAX_IMPACT_DELTA_MICRO_RAD` (55°). Anything under
 * 90° leaves the globe immediately, so the trajectory cannot clip Earth
 * before reaching its target; 55° is well inside that and is what stops
 * the path from being inferable from the impact sector alone.
 */
export const MAX_APPROACH_OFFSET_RADIANS = (55 * Math.PI) / 180

/**
 * Keeps the launch point in the sky rather than under the horizon. The
 * approach bearing is measured from the impact point *outward*, so a
 * bearing with a downward component would send the ray straight out of the
 * board's bottom edge — a few hundred km of flight, all of it behind the
 * planet. This margin holds the ray off both horizontals.
 */
const HORIZON_MARGIN_RADIANS = (6 * Math.PI) / 180

/**
 * Turns a 0..1 draw into the bearing the attack approaches its target
 * from — measured at the target, pointing back out towards the launch
 * point.
 *
 * The window is the ±55° cone around the impact normal, *intersected* with
 * the upward half-plane. Intersecting and then sampling, rather than
 * sampling and then clamping, is what keeps the distribution flat: a clamp
 * would pile every out-of-range draw onto the two boundary bearings, and
 * those two bearings would become the likeliest approaches in the game.
 */
export function approachAngleFromUnit(impactAngleRadians: number, unit: number): number {
  const skyMin = -Math.PI + HORIZON_MARGIN_RADIANS
  const skyMax = -HORIZON_MARGIN_RADIANS
  const min = Math.max(impactAngleRadians - MAX_APPROACH_OFFSET_RADIANS, skyMin)
  const max = Math.min(impactAngleRadians + MAX_APPROACH_OFFSET_RADIANS, skyMax)
  return min + clamp01(unit) * Math.max(0, max - min)
}

/**
 * Where a ray leaves the playfield — the launch point of ТЗ §3, "a point on
 * the outer edge of the working area".
 *
 * `origin` is the impact point on Earth, which is always strictly inside
 * the board, so the ray always has exactly one forward exit: the nearest of
 * the four slab crossings. Returning that exit rather than a point a fixed
 * distance away is the whole of the new trajectory model — the length comes
 * out of the geometry, and is different for every attack (ТЗ §5).
 */
export function rayToFieldBoundary(origin: Point2D, angleRadians: number, world: WorldGeometry): Point2D {
  const dx = Math.cos(angleRadians)
  const dy = Math.sin(angleRadians)

  let travel = Number.POSITIVE_INFINITY
  if (dx > 0) travel = Math.min(travel, (world.widthKm - origin.x) / dx)
  if (dx < 0) travel = Math.min(travel, (0 - origin.x) / dx)
  if (dy > 0) travel = Math.min(travel, (world.heightKm - origin.y) / dy)
  if (dy < 0) travel = Math.min(travel, (0 - origin.y) / dy)
  if (!Number.isFinite(travel)) travel = 0

  return { x: origin.x + dx * travel, y: origin.y + dy * travel }
}

/**
 * Where the ray leaving Earth's centre on `angleRadians` exits the board —
 * the launch point the protocol derives from a bearing (Geometry.sol
 * `rayExit`).
 *
 * Earth's centre sits *below* the field, so the ray crosses the board and
 * the far crossing is the one on its outer edge. `rayToFieldBoundary` from
 * the centre would return the *near* crossing — the bottom edge, next to
 * the planet — which is the opposite of a launch.
 */
export function rayExitFromEarth(angleRadians: number, world: WorldGeometry): Point2D {
  const dx = Math.cos(angleRadians)
  const dy = Math.sin(angleRadians)
  const { x: cx, y: cy } = world.earth.center

  let tExit = Number.POSITIVE_INFINITY
  const consider = (t1: number, t2: number) => {
    const far = Math.max(t1, t2)
    if (far < tExit) tExit = far
  }
  if (dx !== 0) consider((0 - cx) / dx, (world.widthKm - cx) / dx)
  if (dy !== 0) consider((0 - cy) / dy, (world.heightKm - cy) / dy)
  if (!Number.isFinite(tExit) || tExit < 0) tExit = 0

  return {
    x: clamp(cx + dx * tExit, 0, world.widthKm),
    y: clamp(cy + dy * tExit, 0, world.heightKm),
  }
}

/**
 * Whether a trajectory reaches its target without passing through Earth
 * first.
 *
 * The target sits exactly on the globe's surface, so the segment enters the
 * disc early precisely when it arrives from the *inward* side of the
 * tangent plane there. That makes the whole test one dot product rather
 * than a segment/circle intersection — and it is why
 * `MAX_APPROACH_OFFSET_RADIANS` staying under 90° is a guarantee and not a
 * hope. Asserted by tests.
 */
export function isApproachClearOfEarth(from: Point2D, to: Point2D, world: WorldGeometry): boolean {
  const normalX = to.x - world.earth.center.x
  const normalY = to.y - world.earth.center.y
  return (from.x - to.x) * normalX + (from.y - to.y) * normalY > 0
}

/**
 * Whether a point lies on the field's outer edge (ТЗ §3.1). Tolerance is
 * relative to the world's own scale so it means the same thing at any
 * sector size. Used by tests.
 */
export function isOnFieldBoundary(point: Point2D, world: WorldGeometry): boolean {
  const tolerance = world.sectorSpanKm * 1e-6
  const onVertical = Math.abs(point.x) <= tolerance || Math.abs(point.x - world.widthKm) <= tolerance
  const onHorizontal = Math.abs(point.y) <= tolerance || Math.abs(point.y - world.heightKm) <= tolerance
  return (onVertical || onHorizontal) && isInsideField(point, world, tolerance)
}

export interface ClosestApproach {
  /** 0..1 along the segment. */
  t: number
  point: Point2D
  distanceKm: number
}

/**
 * Closest point on a segment to `point`.
 *
 * This is a *measurement*, not the interception test — ТЗ §11 rules out
 * deciding interception by point-to-line distance. It is what
 * reconnaissance reports against (how far a sector is from the threat's
 * path) and what a miss is described by after the fact.
 */
export function closestApproach(point: Point2D, from: Point2D, to: Point2D): ClosestApproach {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const lengthSquared = dx * dx + dy * dy
  const t =
    lengthSquared === 0 ? 0 : clamp01(((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared)
  const closest = { x: from.x + dx * t, y: from.y + dy * t }
  return { t, point: closest, distanceKm: distance(point, closest) }
}

/**
 * The moment a moving threat first enters a circle. Used to classify a
 * miss (too early / too late on a path that would have passed through).
 * The payout test is the snapshot at submit in `game/defense.ts`.
 */
export function firstEntryIntoCircle(
  from: Point2D,
  to: Point2D,
  center: Point2D,
  radius: number,
): { entered: boolean; t: number; point: Point2D } {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const ox = from.x - center.x
  const oy = from.y - center.y

  const a = dx * dx + dy * dy
  const b = 2 * (ox * dx + oy * dy)
  const c = ox * ox + oy * oy - radius * radius

  // A threat that starts inside the radius has already entered it. Cannot
  // happen with a launch point on the field's edge, but the geometry does
  // not depend on that and neither should the answer.
  if (c <= 0) return { entered: true, t: 0, point: from }
  if (a === 0) return { entered: false, t: Number.NaN, point: to }

  const discriminant = b * b - 4 * a * c
  if (discriminant < 0) return { entered: false, t: Number.NaN, point: to }

  const t = (-b - Math.sqrt(discriminant)) / (2 * a)
  if (t < 0 || t > 1) return { entered: false, t: Number.NaN, point: to }

  return { entered: true, t, point: { x: from.x + dx * t, y: from.y + dy * t } }
}

/** Altitude of a point above Earth's surface, in km. Zero on or inside the disc. */
export function altitudeKm(point: Point2D, world: WorldGeometry): number {
  return Math.max(0, distance(point, world.earth.center) - world.earth.radiusKm)
}

/**
 * When the snapshot is taken for a Defense Point.
 *
 * Matches `Geometry.arrivalBlockScaled`: the submit block itself. Climb
 * speed and altitude do not move the clock.
 */
export function interceptorArrivalBlock(
  _point: Point2D,
  _world: WorldGeometry,
  submittedAtBlock: number,
  _defenseSpeedKmPerBlock: number,
): number {
  return submittedAtBlock
}

export function distance(a: Point2D, b: Point2D): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

/** Eight-point compass label for a heading, used by reconnaissance readouts. */
export function bearingLabel(radians: number): string {
  const compass = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'] as const
  const normalized = ((radians % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  return compass[Math.round(normalized / (Math.PI / 4)) % 8]
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function clamp01(value: number): number {
  return clamp(value, 0, 1)
}

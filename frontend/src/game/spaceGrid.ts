import { sectorToLabel } from './map'
import type { DefensePoint, MapGridConfig, Point2D, Sector } from './types'
import type { WorldGeometry } from './world'

/**
 * Screen geometry for the playfield — the one place the canonical world of
 * `game/world.ts` becomes pixels.
 *
 * The playfield is the scene — the whole area under the header — divided
 * into `columns x rows` square sectors. Earth sits in it as an obstacle
 * rather than as the grid's substrate: it takes no part in laying the grid
 * out, and the grid never paints over it. Cells that reach the globe stop
 * at its rim and take on its curve, so the grid closes smoothly around the
 * planet instead of being pasted across it (ТЗ §2.9-2.11).
 *
 * Cells are always square (ТЗ §2.8, §16.6). A 10x5 grid is a 2:1 shape and
 * a phone held upright is roughly 1:2, so stretching cells to fill the
 * container would turn them into tall slivers; instead the grid is
 * *transposed* on a portrait scene — the same 50 sectors, drawn 5 across
 * and 10 down (ТЗ §2.4-2.5, §16.1-16.3). Only the arrangement on screen
 * changes: a sector's `{ column, row }` address, its A1..J5 label and
 * which sector a world coordinate falls in are identical on every device
 * (ТЗ §2.6-2.7, §16.4-16.5).
 *
 * Everything here is plain scene pixels — x right, y down, origin at the
 * scene's top-left — so the SVG that renders it needs no viewBox and no
 * scaling, and a cell's coordinates are the ones the browser lays out.
 */

export interface SceneSize {
  width: number
  height: number
}

export interface DiscGeometry {
  cx: number
  cy: number
  r: number
}

export interface GridPlacement {
  /** Portrait scene: sector columns run down the screen and rows run across it. */
  transposed: boolean
  /** Side of one cell, in scene pixels. Square by construction. */
  cellSize: number
  /** Top-left of the grid block. Non-zero where square cells leave a margin against the scene's aspect. */
  originX: number
  originY: number
  /** Size of the grid block itself, which is at most the scene. */
  width: number
  height: number
}

/**
 * Fits the grid into the scene with square cells.
 *
 * Orientation is chosen by the scene's own aspect — landscape draws the
 * grid as configured, portrait transposes it — because that is the choice
 * that leaves the cells closest to square, and therefore the grid closest
 * to filling the scene. Whatever margin is left over after that is centred
 * rather than absorbed by stretching the cells.
 */
export function placeGrid(grid: MapGridConfig, scene: SceneSize): GridPlacement {
  const transposed = scene.height > scene.width
  const across = transposed ? grid.rows : grid.columns
  const down = transposed ? grid.columns : grid.rows

  const cellSize = Math.min(scene.width / across, scene.height / down)
  const width = cellSize * across
  const height = cellSize * down

  return {
    transposed,
    cellSize,
    originX: (scene.width - width) / 2,
    originY: (scene.height - height) / 2,
    width,
    height,
  }
}

/**
 * Earth's size and placement, mirrored from `.wrapHero` in
 * EarthSphere.module.css: `width: clamp(320px, 46vw, 680px)`,
 * `aspect-ratio: 1/1`, `bottom: 0`, `transform: translate(-50%, 60%)`.
 *
 * These four numbers are the one thing this module and that stylesheet
 * have to agree on. The hero is itself `width: 100vw`, so 46vw is exactly
 * 46% of the scene's own width — no viewport/container mismatch to
 * account for. Change one side and change the other. The Operation screen
 * draws the identical globe the Home page does, so both read from here.
 */
export const EARTH_HERO_MIN_PX = 320
export const EARTH_HERO_WIDTH_RATIO = 0.46
export const EARTH_HERO_MAX_PX = 680
export const EARTH_HERO_TRANSLATE_Y = 0.6
/** How far the disc centre sits below the scene's bottom edge, as a fraction of diameter. */
export const EARTH_HERO_SINK = EARTH_HERO_TRANSLATE_Y - 0.5

/**
 * Where Earth's disc lands in the scene. Its centre sits *below* the
 * scene's bottom edge — only the top cap is on screen — which is why the
 * bottom row of cells is trimmed by an arc rather than cut in half.
 *
 * This is the disc everything on screen uses: the grid's clip, the
 * Command Center docked on the cap, and the impact point at the end of
 * the reveal. `game/world.ts` keeps a canonical disc in sector units for
 * the protocol's own maths, sized so the two coincide at the common
 * landscape case — see `EARTH_RADIUS_SECTORS` there.
 */
export function earthDiscInScene(scene: SceneSize): DiscGeometry {
  const size = Math.min(Math.max(EARTH_HERO_MIN_PX, scene.width * EARTH_HERO_WIDTH_RATIO), EARTH_HERO_MAX_PX)
  const radius = size / 2
  return {
    cx: scene.width / 2,
    cy: scene.height - size * (1 - EARTH_HERO_TRANSLATE_Y) + radius,
    r: radius,
  }
}

/** A point on the *drawn* globe's surface, at `angleRadians` from the +x axis. */
export function pointOnDrawnEarth(angleRadians: number, earth: DiscGeometry): Point2D {
  return {
    x: earth.cx + Math.cos(angleRadians) * earth.r,
    y: earth.cy + Math.sin(angleRadians) * earth.r,
  }
}

/**
 * First place the ray `from → toward` meets the disc's rim.
 *
 * A trajectory that is allowed to run to a grid-projected impact can already
 * be inside the *painted* globe — two Earths, and they only coincide on a
 * typical landscape scene. Stopping at this hit is what keeps the strike on
 * the surface instead of drawing through the planet.
 */
export function firstDiscHit(from: Point2D, toward: Point2D, earth: DiscGeometry): Point2D | null {
  const dx = toward.x - from.x
  const dy = toward.y - from.y
  const a = dx * dx + dy * dy
  if (a < 1e-12) return null
  const fx = from.x - earth.cx
  const fy = from.y - earth.cy
  const b = 2 * (fx * dx + fy * dy)
  const c = fx * fx + fy * fy - earth.r * earth.r
  const disc = b * b - 4 * a * c
  if (disc < 0) return null
  const root = Math.sqrt(disc)
  const tNear = (-b - root) / (2 * a)
  const tFar = (-b + root) / (2 * a)
  const t = tNear > 1e-9 ? tNear : tFar > 1e-9 ? tFar : null
  if (t === null) return null
  return { x: from.x + dx * t, y: from.y + dy * t }
}

/**
 * Where a ray leaving the painted globe on `angleRadians` exits `box` —
 * the on-screen stand-in for Geometry.sol `rayExit`.
 *
 * The reveal used to project the canonical launch through the grid and the
 * impact onto this disc. Those are two different Earths, and the chord
 * between them is not the attack the probes described.
 */
export function rayExitFromDisc(
  angleRadians: number,
  earth: DiscGeometry,
  box: { minX: number; minY: number; maxX: number; maxY: number },
): Point2D {
  const dx = Math.cos(angleRadians)
  const dy = Math.sin(angleRadians)
  const { cx, cy } = earth

  let tFar = Number.POSITIVE_INFINITY
  if (dx !== 0) {
    const far = Math.max((box.minX - cx) / dx, (box.maxX - cx) / dx)
    if (far > 0 && far < tFar) tFar = far
  }
  if (dy !== 0) {
    const far = Math.max((box.minY - cy) / dy, (box.maxY - cy) / dy)
    if (far > 0 && far < tFar) tFar = far
  }
  if (!Number.isFinite(tFar) || tFar === Number.POSITIVE_INFINITY) tFar = 0
  return { x: cx + dx * tFar, y: cy + dy * tFar }
}

/**
 * Where a sector's cell sits on screen. The one place the transposition is
 * applied — every other coordinate in the UI goes through this or
 * `projectToScene`, so nothing can end up laid out against the other
 * orientation.
 */
export function cellRect(
  sector: Sector,
  placement: GridPlacement,
): { x: number; y: number; width: number; height: number } {
  const across = placement.transposed ? sector.row : sector.column
  const down = placement.transposed ? sector.column : sector.row
  return {
    x: placement.originX + across * placement.cellSize,
    y: placement.originY + down * placement.cellSize,
    width: placement.cellSize,
    height: placement.cellSize,
  }
}

/**
 * A point given as fractions along the grid's own column and row axes,
 * mapped to scene pixels. Values outside 0..1 are fine and extrapolate —
 * an attack's launch point is outside the field by construction.
 */
export function projectToScene(unitColumn: number, unitRow: number, placement: GridPlacement): Point2D {
  // `width`/`height` are already the screen extents of the across/down
  // axes, so the transposition only has to pick which unit feeds which.
  const across = placement.transposed ? unitRow : unitColumn
  const down = placement.transposed ? unitColumn : unitRow
  return {
    x: placement.originX + across * placement.width,
    y: placement.originY + down * placement.height,
  }
}

/** Canonical km straight to scene pixels. */
export function projectWorldPoint(point: Point2D, world: WorldGeometry, placement: GridPlacement): Point2D {
  return projectToScene(point.x / world.widthKm, point.y / world.heightKm, placement)
}

/** A Defense Point's exact pixel position — sector cell plus its fractional offsets. */
export function defensePointToScene(point: DefensePoint, placement: GridPlacement): Point2D {
  const rect = cellRect(point.sector, placement)
  const across = placement.transposed ? point.offsetY : point.offsetX
  const down = placement.transposed ? point.offsetX : point.offsetY
  return { x: rect.x + across * placement.cellSize, y: rect.y + down * placement.cellSize }
}

/**
 * The inverse: a click inside a sector's cell to the sector-relative
 * Defense Point it names. Clamped to the cell, so a click on the very edge
 * still resolves inside the sector the player chose (ТЗ §7.5).
 */
export function sceneToDefensePoint(scenePoint: Point2D, sector: Sector, placement: GridPlacement): DefensePoint {
  const rect = cellRect(sector, placement)
  const across = clamp01((scenePoint.x - rect.x) / placement.cellSize)
  const down = clamp01((scenePoint.y - rect.y) / placement.cellSize)
  return {
    sector,
    offsetX: placement.transposed ? down : across,
    offsetY: placement.transposed ? across : down,
  }
}

export interface GridCell {
  /** "A1".."J5" — the same label the rest of the game addresses sectors by. */
  sectorId: string
  sector: Sector
  x: number
  y: number
  width: number
  height: number
  /** Where a label for this cell belongs: its centre, unless Earth covers that, in which case a corner still in the open. */
  labelX: number
  labelY: number
}

/**
 * The full grid of addressable sectors, minus the ones Earth has swallowed
 * whole.
 *
 * Columns and rows come straight from `MapGridConfig`, so the shipped
 * 10 x 5 = 50 sectors are a configuration, not a hardcoded layout (ТЗ §2.3,
 * §16.3). Earth changes what is *drawn* of a cell, never where the cell is.
 */
export function buildSpaceGrid(grid: MapGridConfig, placement: GridPlacement, earth: DiscGeometry): GridCell[] {
  const size = placement.cellSize
  const cells: GridCell[] = []

  for (let row = 0; row < grid.rows; row++) {
    for (let column = 0; column < grid.columns; column++) {
      const sector: Sector = { column, row }
      const { x, y } = cellRect(sector, placement)
      if (isCellCovered(x, y, size, size, earth)) continue

      const label = labelAnchor(x, y, size, size, earth)
      cells.push({
        sectorId: sectorToLabel(sector),
        sector,
        x,
        y,
        width: size,
        height: size,
        labelX: label.x,
        labelY: label.y,
      })
    }
  }

  return cells
}

/**
 * A rectangle lies entirely inside a disc exactly when all four of its
 * corners do — a disc is convex, so nothing between them can escape. Such
 * a cell has no visible area at all and is dropped rather than rendered as
 * an invisible click target sitting on top of the planet.
 */
export function isCellCovered(x: number, y: number, width: number, height: number, earth: DiscGeometry): boolean {
  return corners(x, y, width, height).every((corner) => discDistance(corner, earth) <= earth.r)
}

/**
 * SVG path data for "the grid block except Earth", to be used as a clip
 * path with `clip-rule="evenodd"`: the outer rectangle and the circle wind
 * into one path, and the even-odd rule punches the circle out as a hole.
 *
 * Clipping rather than masking is deliberate. A clip path removes the
 * covered area from hit-testing too, so a click on the planet cannot land
 * on the sector cell technically stretched underneath it — the grid stops
 * at Earth's edge for the pointer exactly as it does for the eye
 * (ТЗ §2.10-2.11).
 */
export function buildSceneOutsideEarthPath(scene: SceneSize, earth: DiscGeometry): string {
  const { cx, cy, r } = earth
  return (
    `M0 0H${round(scene.width)}V${round(scene.height)}H0Z` +
    `M${round(cx - r)} ${round(cy)}` +
    `a${round(r)} ${round(r)} 0 1 0 ${round(r * 2)} 0` +
    `a${round(r)} ${round(r)} 0 1 0 ${round(-r * 2)} 0Z`
  )
}

/**
 * Where a cell's label goes. The centre, normally; for a cell Earth has
 * eaten into, the corner furthest from the planet, pulled inward so the
 * text sits in the cell rather than on its border.
 *
 * A cell that survived `buildSpaceGrid` has at least one corner strictly
 * outside the disc, and the furthest one is necessarily it — but on a cell
 * Earth has nearly swallowed, pulling inward can cross back over the rim.
 * So the inset is reduced until the anchor is genuinely in the open, which
 * in the worst case means the bare corner.
 */
function labelAnchor(
  x: number,
  y: number,
  width: number,
  height: number,
  earth: DiscGeometry,
): Point2D {
  const center = { x: x + width / 2, y: y + height / 2 }
  if (discDistance(center, earth) > earth.r) return center

  const furthest = corners(x, y, width, height).reduce((best, corner) =>
    discDistance(corner, earth) > discDistance(best, earth) ? corner : best,
  )
  const towardsX = furthest.x === x ? 1 : -1
  const towardsY = furthest.y === y ? 1 : -1
  const maxInset = Math.min(14, width / 3, height / 3)

  for (const inset of [maxInset, maxInset / 2, maxInset / 4]) {
    const candidate = { x: furthest.x + towardsX * inset, y: furthest.y + towardsY * inset }
    if (discDistance(candidate, earth) > earth.r) return candidate
  }
  return furthest
}

function corners(x: number, y: number, width: number, height: number): Point2D[] {
  return [
    { x, y },
    { x: x + width, y },
    { x, y: y + height },
    { x: x + width, y: y + height },
  ]
}

function discDistance(point: Point2D, earth: DiscGeometry): number {
  return Math.hypot(point.x - earth.cx, point.y - earth.cy)
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function round(value: number): number {
  return Number(value.toFixed(2))
}

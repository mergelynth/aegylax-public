import { useMemo, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react'
import { sectorToLabel } from '../../game/map'
import { HORIZON_DIP, OPENING_PAINT_SCALE, SKY_OVERSHOOT, type ReconBlotch, type ReconEstimate } from '../../game/recon'
import {
  buildSceneOutsideEarthPath,
  buildSpaceGrid,
  defensePointToScene,
  firstDiscHit,
  pointOnDrawnEarth,
  rayExitFromDisc,
  sceneToDefensePoint,
  type DiscGeometry,
  type GridPlacement,
  type SceneSize,
} from '../../game/spaceGrid'
import type { DefensePoint, MapGridConfig, Point2D, Sector } from '../../game/types'
import type { WorldGeometry } from '../../game/world'
import styles from './SectorGrid.module.css'

export interface SectorGridProps {
  grid: MapGridConfig
  scene: SceneSize
  placement: GridPlacement
  earth: DiscGeometry

  /**
   * The fused reconnaissance picture as geometry (ТЗ §3) — the blue
   * uncertainty cloud, its brighter centre, and the red occupancy blotch
   * once two probes have earned one. Null before the first probe.
   */
  estimate: ReconEstimate | null
  /** The canonical world the estimate is expressed in, so it can be projected. */
  world: WorldGeometry
  /** Changes on every probe sent from this screen; remounting the wave is what replays it (ТЗ §1.4). */
  waveKey: number | null

  selectedSector: Sector | null
  stagedPoint: DefensePoint | null
  /** Set once Defense is sent. Non-null freezes the whole pick (ТЗ §9.2). */
  submittedPoint: DefensePoint | null
  /**
   * The protocol's interception radius in scene pixels (ТЗ §10.2) — drawn
   * around the Defense Point so a player can see the area they actually
   * cover instead of having to imagine it.
   */
  interceptionRadiusPx: number
  onSelectSector: (sector: Sector) => void
  onPlacePoint: (point: DefensePoint) => void
  /**
   * The operation is under way, so cells are pickable (ТЗ §7). While it is
   * false the grid still draws in full — it is the scene's orientation
   * layer — but takes no clicks, no focus and no hover: there is nothing
   * to choose yet, and a cell that highlights without doing anything is a
   * promise the screen cannot keep.
   */
  interactive: boolean
  /**
   * The round has been scored, so the reconnaissance picture comes off.
   *
   * Reconnaissance is a way of guessing where the threat is while nobody
   * can see it. Once the reveal draws the real trajectory and the Defense
   * Points it was judged against, the guess has no reader: leaving it up,
   * even faintly, puts an estimate and an answer on the same board and
   * invites the eye to compare them as if both were claims about the sky.
   * The finished operation shows what happened, and nothing else.
   */
  settled?: boolean
  /**
   * Whether the A-J / 1-5 axis labels are drawn along the grid's edges.
   * ENV-controlled and off by default (`VITE_MAP_SHOW_GRID_LABELS`) — see
   * `AppConfig.map.showGridLabels`. The hovered cell's own badge is not
   * part of this: it names what the pointer is actually on, which is the
   * only moment a sector id is worth reading.
   */
  showGridLabels?: boolean
  /**
   * 0..1 along the fused corridor — the recon clock, not the real threat.
   * Drawn only while the attack is in flight and an estimate exists.
   */
  reconProgress?: number | null
  /** Remaining flight time; with `reconFlightMs` the mark interpolates between blocks. */
  reconRemainingMs?: number | null
  reconFlightMs?: number | null
}

/**
 * The operation's sector grid (ТЗ §2).
 *
 * The playfield is the scene and Earth is an obstacle in it, so cells that
 * reach the globe end on its rim and inherit its curve — the grid wraps the
 * planet rather than lying across it, and no sector ever paints or takes a
 * click inside Earth. The grid is always *drawn*: it is orientation, not an
 * optional layer, so there is nothing to toggle and nothing that can move
 * the layout by appearing (ТЗ §2.2). Whether it can be *clicked* is a
 * separate question, and `interactive` answers it — only a running
 * operation has sectors worth choosing.
 *
 * All geometry is passed in rather than measured here. The grid, the reveal
 * and Earth's cut-out all have to agree on one placement, and the only way
 * to guarantee that is for one component upstream to measure and everything
 * below to be handed the result.
 *
 * The grid takes exactly one gesture now: the Defense pick. One click
 * places the point in the sector that was hit. A square around the cell
 * used to mark "selected, click again" — that frame is gone, so the press
 * has to be the placement.
 *
 * Reconnaissance is deliberately *not* a gesture here. A Recon Probe is not
 * aimed at anything (ТЗ §1.1), so there is nothing on this map to click for
 * it — it arrives only as fog.
 */
export function SectorGrid({
  grid,
  scene,
  placement,
  earth,
  estimate,
  world,
  waveKey,
  selectedSector,
  stagedPoint,
  submittedPoint,
  interceptionRadiusPx,
  onSelectSector,
  onPlacePoint,
  interactive,
  showGridLabels = false,
  settled = false,
  reconProgress: _reconProgress = null,
  reconRemainingMs: _reconRemainingMs = null,
  reconFlightMs: _reconFlightMs = null,
}: SectorGridProps) {
  const [hoveredSectorId, setHoveredSectorId] = useState<string | null>(null)

  const cells = useMemo(() => buildSpaceGrid(grid, placement, earth), [grid, placement, earth])
  const clipPath = useMemo(() => buildSceneOutsideEarthPath(scene, earth), [scene, earth])
  const lines = useMemo(() => gridLines(grid, placement), [grid, placement])

  const selectedSectorId = selectedSector ? sectorToLabel(selectedSector) : null

  const activePoint = submittedPoint ?? stagedPoint
  const pointPosition = activePoint ? defensePointToScene(activePoint, placement) : null

  const handleCellClick = (sector: Sector, event: ReactMouseEvent<SVGRectElement>) => {
    if (!interactive || submittedPoint) return
    const svg = event.currentTarget.ownerSVGElement
    if (!svg) return
    const box = svg.getBoundingClientRect()
    onPlacePoint(sceneToDefensePoint({ x: event.clientX - box.left, y: event.clientY - box.top }, sector, placement))
  }

  return (
    <div className={styles.layer}>
      <svg
        className={[styles.svg, interactive ? '' : styles.inert].filter(Boolean).join(' ')}
        width={scene.width}
        height={scene.height}
        viewBox={`0 0 ${scene.width} ${scene.height}`}
        preserveAspectRatio="xMidYMid meet"
        role="group"
        aria-label="Operation sector grid"
      >
        <defs>
          <clipPath id="sector-grid-clip" clipPathUnits="userSpaceOnUse">
            <path d={clipPath} clipRule="evenodd" />
          </clipPath>
          {/*
            The red marks are small and drawn in a group that is translated
            and rotated onto the inbound. A scene-sized filter region
            expressed in that group's local space clips them to a rectangle;
            a padded object box on an untransformed wrapper does not.
          */}
          <filter id="recon-blotch-blur" x="-250%" y="-250%" width="600%" height="600%" colorInterpolationFilters="sRGB">
            <feGaussianBlur stdDeviation={blotchBlurPx(estimate, placement)} />
          </filter>
          {/*
            Wide enough that neighbouring bands melt into one another —
            anything tighter and the stack reads as contour lines, which is
            a map of the estimate's own drawing rather than of the sky.
          */}
          <filter id="recon-cloud-soft" x="-45%" y="-45%" width="190%" height="190%">
            <feGaussianBlur stdDeviation={Math.max(18, earth.r * 0.12)} />
          </filter>
          {/*
            Later sweeps sit inside the corridor, but a hard clipPath is a
            knife: the ring ends where the polygon ends. A blurred mask
            lets the wave fade into the cloud instead of being cut off.
          */}
          <filter id="recon-wave-feather" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation={Math.max(16, earth.r * 0.09)} />
          </filter>
          {estimate && !settled ? (
            <mask id="recon-wave-mask" maskUnits="userSpaceOnUse">
              <rect x="0" y="0" width={scene.width} height={scene.height} fill="black" />
              <polygon
                points={cloudPoints(estimate, world, earth, scene, 1.12)}
                fill="white"
                filter="url(#recon-wave-feather)"
              />
            </mask>
          ) : null}
          {/*
            Falloff is along the search bearing, not isotropic around Earth.
            A radial wash from the planet tinted every near-sky cell the
            wide first cone touched; a beam down the corridor keeps the
            same wedge and still says "look this way".
          */}
          <ReconFades earth={earth} estimate={estimate} world={world} placement={placement} />
        </defs>

        <g clipPath="url(#sector-grid-clip)">
          {/*
            ТЗ §3 — the whole private reconnaissance picture, under the
            cells and clipped to the sky rather than to the grid block.
            `placeGrid` fits the cells by their shorter axis, so on almost
            every screen there is a letterbox the grid never reaches;
            clipping the fog to the block cut the cone off against that
            invisible edge and left a blue rectangle with a curved bottom
            instead of a searchlight running off the top of the board.
          */}
          {settled ? null : <ReconPicture estimate={estimate} world={world} earth={earth} scene={scene} />}

          {cells.map((cell) => {
            const isSelected = interactive && cell.sectorId === selectedSectorId
            return (
              <rect
                key={cell.sectorId}
                x={cell.x}
                y={cell.y}
                width={cell.width}
                height={cell.height}
                className={styles.cell}
                role={interactive ? 'button' : 'presentation'}
                tabIndex={interactive ? 0 : undefined}
                aria-label={`Sector ${cell.sectorId}`}
                aria-pressed={interactive ? isSelected : undefined}
                onClick={(event) => handleCellClick(cell.sector, event)}
                onKeyDown={(event) => {
                  if (!interactive) return
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  // Keyboard can only ever select a sector; placing a point
                  // needs a position, and the centre of the sector would be
                  // a coordinate the player never actually chose.
                  onSelectSector(cell.sector)
                }}
                onMouseEnter={() => interactive && setHoveredSectorId(cell.sectorId)}
                onMouseLeave={() => setHoveredSectorId((current) => (current === cell.sectorId ? null : current))}
              />
            )
          })}

          {/*
            Drawn once per line rather than as a border on each cell: every
            interior seam is shared by two cells, and a per-cell stroke
            would paint it twice and show up as a brighter grid over a
            fainter one.
          */}
          {lines.map((line) => (
            <line key={line.key} x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} className={styles.line} />
          ))}

          {/* ТЗ §1.4 — the scan that delivered the reading, replayed by its changing key. */}
          {waveKey === null || settled ? null : (
            <ReconWave key={waveKey} earth={earth} estimate={estimate} world={world} placement={placement} />
          )}
        </g>

        {/*
          Earth's rim, in the grid's own ink. Outside the clip on purpose —
          this is the edge the surrounding cells close against, so it
          belongs to the grid, and drawing it makes the wrap read as
          deliberate rather than as lines running out.
        */}
        <circle cx={earth.cx} cy={earth.cy} r={earth.r} className={styles.earthEdge} aria-hidden="true" />
      </svg>

      {/*
        Column letters and row numbers once each along the grid's two
        edges. Which edge each axis gets follows the transposition, so the
        letters always run alongside the columns.

        Off unless the build asks for them. Naming every column and row
        permanently is a coordinate system on display, and the screen does
        not need one: a sector is chosen by clicking it, and the cell under
        the pointer already says what it is called. What the labels cost is
        the same everywhere — a ring of small type around the playfield —
        so they are ENV-gated rather than removed outright, for the builds
        that want to talk about sectors by name.
      */}
      {showGridLabels ? (
        <div className={styles.axis} aria-hidden="true">
          {axisLabels(grid, placement).map((label) => (
            <span
              key={label.key}
              className={[styles.axisLabel, label.alongTop ? styles.axisTop : styles.axisSide].join(' ')}
              style={{ left: label.x, top: label.y }}
            >
              {label.text}
            </span>
          ))}
        </div>
      ) : null}

      {cells
        .filter((cell) => cell.sectorId === hoveredSectorId)
        .map((cell) => {
          const anchor = keepOnScene(cell.labelX, cell.labelY, scene, LABEL_MARGIN_PX)
          return (
            <span
              key={cell.sectorId}
              className={styles.cellLabel}
              style={{ left: anchor.x, top: anchor.y }}
              aria-hidden="true"
            >
              {cell.sectorId}
            </span>
          )
        })}

      {/*
        ТЗ §8, §10 — the Defense Point at the exact coordinates chosen, and
        around it the interception radius the protocol will actually judge
        it by.

        The ring is the more useful of the two: a point is a claim about one
        coordinate, but what decides the operation is whether the threat
        passes through the *area* around it. Drawing it at the configured
        radius makes the choice legible before it is committed rather than
        only in the reveal afterwards.
      */}
      {pointPosition ? (
        <>
          <span
            className={[styles.interceptionRing, submittedPoint ? styles.interceptionRingLocked : '']
              .filter(Boolean)
              .join(' ')}
            style={{
              left: pointPosition.x,
              top: pointPosition.y,
              width: interceptionRadiusPx * 2,
              height: interceptionRadiusPx * 2,
            }}
            aria-hidden="true"
          />
          <span
            className={[styles.defensePoint, submittedPoint ? styles.defensePointLocked : '']
              .filter(Boolean)
              .join(' ')}
            style={{ left: pointPosition.x, top: pointPosition.y }}
            title={
              submittedPoint
                ? 'Defense Point — locked'
                : 'Defense Point — click elsewhere in this sector to move it'
            }
          />
        </>
      ) : null}
    </div>
  )
}

/**
 * How much room a floating marker needs from the scene's edge.
 *
 * The scene is clipped (`.viewport` is `overflow: hidden`), so an anchor
 * that lands near a border does not overflow — it gets *cut*, which is
 * worse: the label for the sector under the pointer arrives half-drawn
 * against the frame. Nudging the anchor inward keeps the whole marker on
 * the board. The cell it points at is unchanged; only where its badge is
 * drawn moves.
 */
const LABEL_MARGIN_PX = 26

function keepOnScene(x: number, y: number, scene: SceneSize, margin: number): { x: number; y: number } {
  return {
    x: Math.min(Math.max(x, margin), Math.max(margin, scene.width - margin)),
    y: Math.min(Math.max(y, margin), Math.max(margin, scene.height - margin)),
  }
}

/**
 * How many contour bands one mark is drawn as.
 *
 * A single blurred ellipse says "somewhere around here" and stops. Bands
 * give the mark a readable middle, so when two marks overlap the eye can
 * see *how much* they overlap rather than just that they do — which is
 * the whole information the red stack carries.
 */
const BLOTCH_CONTOURS = 3

/**
 * Occupancy where one probe's reading puts the inbound (ТЗ §3).
 *
 * Seven shades, light to dark, one per probe after the opening sweep:
 * the later the reading, the deeper the red and the closer to Earth it
 * sits. Marks are painted plainly on top of each other, so agreement
 * between readings shows up on its own as a darker column — no separate
 * "consensus" layer to disagree with what is actually drawn.
 */
function ReconThreatBlotch({
  blotch,
  world,
  earth,
}: {
  blotch: ReconBlotch
  world: WorldGeometry
  earth: DiscGeometry
}) {
  const scene = blotchScene(blotch, world, earth)
  const { shade, weight } = blotchPaint(blotch.depth)

  return (
    <g filter="url(#recon-blotch-blur)" aria-hidden="true">
      <g
        className={styles.threatBlotch}
        transform={`translate(${scene.x} ${scene.y}) rotate(${scene.headingDeg})`}
      >
        {Array.from({ length: BLOTCH_CONTOURS }, (_, band) => {
          const scale = 1 - band / BLOTCH_CONTOURS
          return (
            <ellipse
              key={band}
              rx={scene.rx * scale}
              ry={scene.ry * scale}
              fill={shade}
              fillOpacity={blotchBandOpacity(band, weight)}
            />
          )
        })}
      </g>
    </g>
  )
}

/**
 * Seven discrete shades, light to dark. A continuous ramp collapsed to
 * near-identical pinks once it was drawn at 20% opacity over blue; these
 * steps are far enough apart that probe 3 is visibly darker than probe 2
 * even through the blur.
 *
 * Two separate things have to be true here and the first attempt at the
 * one broke the other.
 *
 * *Visible*: the ramp used to open on `rgb(255, 152, 168)` — a near-white
 * pink, laid at a fifth of full opacity, over a blue cloud, through a wide
 * blur — and the first two marks could not be found. That opening shade is
 * darker now, and `weight` starts higher.
 *
 * *Graded*: five probes have to read as five marks, each deeper than the
 * last. Raising the floor by flattening `weight` (1.00→1.36 across the
 * whole run) is what destroyed that — every mark landed at almost the same
 * strength and the pile merged into one smudge near the launch. The floor
 * and the range are separate knobs: the floor is up, and the range is
 * back where it was.
 */
const BLOTCH_SHADES = [
  'rgb(245, 122, 144)',
  'rgb(226, 76, 102)',
  'rgb(196, 32, 60)',
  'rgb(154, 8, 36)',
  'rgb(110, 0, 22)',
  'rgb(72, 0, 12)',
  'rgb(36, 0, 6)',
]

function blotchTone(depth: number): number {
  return Math.min(1, Math.max(0, depth))
}

function blotchShade(depth: number): string {
  const index = Math.min(BLOTCH_SHADES.length - 1, Math.round(blotchTone(depth) * (BLOTCH_SHADES.length - 1)))
  return BLOTCH_SHADES[index]
}

/**
 * How one mark is painted, given how deep into the run it is.
 *
 * Later marks are laid on more heavily *as well as* mixed darker. Hue
 * alone loses most of its range once a mark is drawn at a fifth opacity
 * over a blue cloud, so the two carry the grade together — which is also
 * what makes a pile of agreeing readings deepen faster than a scattered
 * one.
 *
 * Exported, and pure, because the two halves of it pull against each other
 * and a regression in either is invisible in a screenshot until five probes
 * are on the board. The floor decides whether the *first* mark can be seen;
 * the range decides whether the *fifth* can be told from it. Raising the
 * floor by flattening the range is exactly the mistake `reconBlotchPaint`
 * in the tests now pins.
 */
export function blotchPaint(depth: number): { shade: string; weight: number } {
  return { shade: blotchShade(depth), weight: 0.95 + 0.8 * blotchTone(depth) }
}

/** The fill of one contour band within a mark. */
export function blotchBandOpacity(band: number, weight: number): number {
  return (0.2 + 0.16 * band) * weight
}

/**
 * Canonical kilometres onto the *painted* globe: the same similarity the
 * cloud is built through, anchored on Earth's centre. A mark placed by the
 * grid's projection instead would drift out of the corridor it belongs to
 * on any scene where the two Earths disagree.
 */
function worldToDrawn(point: Point2D, world: WorldGeometry, earth: DiscGeometry): { x: number; y: number } {
  const scale = earth.r / world.earth.radiusKm
  return {
    x: earth.cx + (point.x - world.earth.center.x) * scale,
    y: earth.cy + (point.y - world.earth.center.y) * scale,
  }
}

function blotchScene(
  blotch: ReconBlotch,
  world: WorldGeometry,
  earth: DiscGeometry,
): { x: number; y: number; rx: number; ry: number; headingDeg: number } {
  const scale = earth.r / world.earth.radiusKm
  const center = worldToDrawn(blotch.center, world, earth)
  return {
    x: center.x,
    y: center.y,
    rx: Math.max(4, blotch.alongKm * scale),
    ry: Math.max(2, blotch.acrossKm * scale),
    headingDeg: (blotch.headingRadians * 180) / Math.PI,
  }
}

/**
 * The reconnaissance picture (ТЗ §3), in the order it was earned.
 *
 * Every layer is the *same* fused reading drawn at a different confidence,
 * which is what makes the progression legible as one thing getting better
 * rather than as new objects appearing:
 *
 *   the blue cloud — the whole area the fix still admits. It is there from
 *     the first probe and it shrinks with every one after. One wash, not
 *     a dark fan with a light fan on top of it: two layers of different
 *     blue read as two different facts, and the brighter one was the
 *     first thing a player would take for the path.
 *   the red marks — one per probe from the second onward, each where
 *     that probe's own reading puts the inbound. Not a craft and not a
 *     line to sit on. They are drawn plainly over each other, so
 *     readings that agree pile into a darker column and readings that
 *     disagree scatter across the cloud: the picture is the evidence,
 *     at the strength the evidence actually has.
 *
 * What is deliberately absent is certainty. The corridor is a probability
 * band — launch on the field's edge, down to Earth — not the real chord.
 * The bright centre is not a guaranteed trajectory. Reveal is the only
 * thing that draws the real path (ТЗ §7, §8).
 */
function ReconPicture({
  estimate,
  world,
  earth,
  scene,
}: {
  estimate: ReconEstimate | null
  world: WorldGeometry
  earth: DiscGeometry
  scene: SceneSize
}) {
  if (!estimate) return null
  const strength = estimate.probeCount <= 1 ? 0.34 : 0.24 + 0.1 * estimate.sharpness
  const openingScale = 1.28 * OPENING_PAINT_SCALE * (estimate.probeCount <= 1 ? 1 : 0.94)
  const bands = OPENING_CLOUD_BANDS

  return (
    <g key={estimate.probeCount} className={[styles.recon, styles.reconArrive].join(' ')} aria-hidden="true">
      {/*
        Nested bands rather than one filled trapezoid. A single polygon has
        an edge wherever it ends, and blurring it only moves that edge —
        the corridor read as a painted slab with a soft rim. Stacking
        narrowing copies puts the weight on the centreline and lets the
        outermost dissolve, so what the eye gets is a density that runs out
        rather than a shape: the cloud is a probability, and a hard border
        on it claims the threat cannot be one pixel further out.
      */}
      {bands.map((band) => (
        <polygon
          key={band.scale}
          points={cloudPoints(estimate, world, earth, scene, band.scale * openingScale)}
          className={styles.cloud}
          fill="url(#recon-cloud-fade)"
          filter="url(#recon-cloud-soft)"
          opacity={strength * band.weight}
        />
      ))}

      {/*
        Not cut to the corridor. Each mark's *centre* is already held inside
        the cloud it was read from, and that is the claim the protocol makes;
        the glow around it is the error bar, which does not stop at the
        corridor's own soft edge. Clipping it drew a straight rim on the one
        layer whose whole job is to be uncertain.
      */}
      {estimate.blotches.map((blotch, index) => (
        <ReconThreatBlotch
          key={`${blotch.center.x.toFixed(1)}-${blotch.center.y.toFixed(1)}-${index}`}
          blotch={blotch}
          world={world}
          earth={earth}
        />
      ))}
    </g>
  )
}

/**
 * Nested bands so the corridor dissolves at the sides rather than ending
 * on a drawn edge. Later probes use the same stack — a tighter inner set
 * is what made the second cloud look cut off.
 */
const OPENING_CLOUD_BANDS = [
  { scale: 1.18, weight: 0.28 },
  { scale: 1, weight: 0.4 },
  { scale: 0.72, weight: 0.52 },
  { scale: 0.46, weight: 0.64 },
  { scale: 0.22, weight: 0.78 },
]

/**
 * The distance falloff every reconnaissance layer is painted through.
 *
 * Along the fused bearing, in scene pixels: bright in the sky the
 * defender is looking into, softer as it meets the horizon. The globe
 * sits on top of this layer, so painting the bright stop on Earth's
 * rim hid the reading under the planet and left only a faded smear
 * on the board's edge.
 */
function ReconFades({
  earth,
  estimate,
  world,
}: {
  earth: DiscGeometry
  estimate: ReconEstimate | null
  world: WorldGeometry
  placement: GridPlacement
}) {
  const near = estimate ? worldToDrawn(estimate.axis.to, world, earth) : { x: earth.cx, y: earth.cy }
  const launch = estimate
    ? worldToDrawn(estimate.axis.from, world, earth)
    : { x: earth.cx, y: earth.cy - earth.r * 4 }
  const cloudFar = {
    x: near.x + (launch.x - near.x) * 1.08,
    y: near.y + (launch.y - near.y) * 1.08,
  }
  return (
    <>
      <linearGradient
        id="recon-cloud-fade"
        gradientUnits="userSpaceOnUse"
        x1={cloudFar.x}
        y1={cloudFar.y}
        x2={near.x}
        y2={near.y}
      >
        {/* Classes, not `stopColor=`: `var()` in an SVG presentation
            attribute is patchily substituted, and a dropped declaration
            here paints the recon cloud black over the map. */}
        <stop offset={0} className={styles.cloudStopNear} stopOpacity={estimate && estimate.probeCount <= 1 ? 0.42 : 0.3} />
        <stop offset={0.32} className={styles.cloudStopMid} stopOpacity={estimate && estimate.probeCount <= 1 ? 0.22 : 0.16} />
        <stop offset={0.78} className={styles.cloudStopMid} stopOpacity={0.07} />
        <stop offset={1} className={styles.cloudStopMid} stopOpacity={0.02} />
      </linearGradient>
    </>
  )
}

/**
 * The recon corridor as an SVG polygon, built against the *painted* globe.
 *
 * The estimate is canonical kilometres, and the planet on screen is placed
 * by a stylesheet — two Earths that only coincide on a typical landscape
 * scene. Projecting the corridor through the grid drew it at the grid's
 * idea of Earth while the horizon, the reveal's trajectory and the globe
 * itself used the painted one, so on any other scene the beam sat beside
 * the planet it was supposed to be pointing at. Only the two bearings and
 * the half-widths (as fractions of Earth's radius) cross over; every
 * coordinate below is the same disc the strike lands on.
 */
function cloudPoints(
  estimate: ReconEstimate,
  world: WorldGeometry,
  earth: DiscGeometry,
  scene: SceneSize,
  widthScale = 1,
): string {
  const center = world.earth.center
  const { axis, cloud } = estimate
  const impactAngle = Math.atan2(axis.to.y - center.y, axis.to.x - center.x)
  const launchAngle = Math.atan2(axis.from.y - center.y, axis.from.x - center.x)

  const impact = pointOnDrawnEarth(impactAngle, earth)
  const margin = earth.r
  const launch = rayExitFromDisc(launchAngle, earth, {
    minX: -margin,
    minY: -margin,
    maxX: scene.width + margin,
    maxY: scene.height + margin,
  })

  const farHalf = (cloud.halfWidthKm.far / world.earth.radiusKm) * earth.r * widthScale
  const nearHalf = (cloud.halfWidthKm.near / world.earth.radiusKm) * earth.r * widthScale

  const chord = Math.hypot(launch.x - impact.x, launch.y - impact.y) || 1
  const apex = {
    x: launch.x + ((launch.x - impact.x) / chord) * chord * SKY_OVERSHOOT,
    y: launch.y + ((launch.y - impact.y) / chord) * chord * SKY_OVERSHOOT,
  }

  // Perpendicular to the dipped chord, so the near corners fall inside the
  // disc and their rim projection hugs the horizon instead of cutting it.
  const dipped = {
    x: earth.cx + (impact.x - earth.cx) * HORIZON_DIP,
    y: earth.cy + (impact.y - earth.cy) * HORIZON_DIP,
  }
  const dx = dipped.x - apex.x
  const dy = dipped.y - apex.y
  const len = Math.hypot(dx, dy) || 1
  const nx = -dy / len
  const ny = dx / len

  const farLeft = { x: apex.x + nx * farHalf, y: apex.y + ny * farHalf }
  const farRight = { x: apex.x - nx * farHalf, y: apex.y - ny * farHalf }
  const nearLeft = { x: dipped.x + nx * nearHalf, y: dipped.y + ny * nearHalf }
  const nearRight = { x: dipped.x - nx * nearHalf, y: dipped.y - ny * nearHalf }

  const horizon = sampleSceneArc(
    firstDiscHit(farLeft, nearLeft, earth) ?? nearLeft,
    firstDiscHit(farRight, nearRight, earth) ?? nearRight,
    earth,
  )
  const farSpan = farHalf * 2
  const left = wavyEdge(farLeft, horizon[0], 12, farSpan * 0.08)
  const right = wavyEdge(horizon[horizon.length - 1], farRight, 12, farSpan * 0.08)
  const far = wavyEdge(farRight, farLeft, 8, farSpan * 0.05)
  return [...left, ...horizon, ...right.slice(1), ...far]
    .map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`)
    .join(' ')
}

function sampleSceneArc(
  left: { x: number; y: number },
  right: { x: number; y: number },
  earth: DiscGeometry,
): Array<{ x: number; y: number }> {
  const a0 = Math.atan2(left.y - earth.cy, left.x - earth.cx)
  const a1 = Math.atan2(right.y - earth.cy, right.x - earth.cx)
  let span = a1 - a0
  while (span > Math.PI) span -= 2 * Math.PI
  while (span <= -Math.PI) span += 2 * Math.PI
  const steps = 22
  const points: Array<{ x: number; y: number }> = []
  for (let i = 0; i <= steps; i++) {
    const a = a0 + (span * i) / steps
    points.push({
      x: earth.cx + Math.cos(a) * earth.r,
      y: earth.cy + Math.sin(a) * earth.r,
    })
  }
  return points
}

/**
 * Subdivide one edge so the rim is a nebula rather than a ruler line.
 * Amplitude is in scene pixels. The horizon arc is left alone — waving
 * it would undo the wrap around Earth.
 */
function wavyEdge(
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps: number,
  amplitude: number,
): Array<{ x: number; y: number }> {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const len = Math.hypot(dx, dy) || 1
  const nx = -dy / len
  const ny = dx / len
  const points: Array<{ x: number; y: number }> = []
  for (let i = 0; i < steps; i++) {
    const t = i / steps
    const envelope = Math.sin(t * Math.PI)
    const wave = Math.sin(t * Math.PI * 2.4) * 0.7 + Math.sin(t * Math.PI * 4.1 + 0.6) * 0.3
    points.push({
      x: from.x + dx * t + nx * wave * envelope * amplitude,
      y: from.y + dy * t + ny * wave * envelope * amplitude,
    })
  }
  return points
}

/**
 * Enough to take the drawn edge off the contour bands, not enough to melt
 * them together.
 *
 * That was always the intent and the arithmetic did not honour it. A mark
 * is a little over one cell across — `alongKm`/`acrossKm` are 0.82 and 0.98
 * of a sector — while the blur was up to 0.83 of a *cell*, so σ came out at
 * 77px against a mark whose radii were 115 and 137. A Gaussian carries
 * visible energy to about 3σ, so every mark was spreading over four times
 * its own area: four readings a couple of hundred pixels apart merged into
 * one shapeless wash, and the same ink spread that thin also made each of
 * them faint. Both of the things the marks are for — where each reading put
 * the inbound, and how many agree — were gone.
 *
 * A fifth of a cell instead. Soft edge, intact core, and four marks that
 * are four marks.
 */
function blotchBlurPx(estimate: ReconEstimate | null, placement: GridPlacement): number {
  if (!estimate) return 10
  return Math.max(8, placement.cellSize * (0.2 + 0.12 * (1 - estimate.sharpness)))
}

/**
 * The scan that delivered a reading (ТЗ §1.4).
 *
 * Rings peeling off Earth's rim, once, and nothing else. There is no
 * craft: a Recon Probe is not a vehicle the player launches at a target
 * and it is not aimed at anything (ТЗ §1.1), so drawing a dart flying to
 * a spot invents both an object and an aim the protocol does not have —
 * and the spot it flew to was a guess, which made the animation look
 * like an answer.
 *
 * Once a later probe has a cloud the sweep is masked to it: reconnaissance
 * searches where the earlier readings already point, not across the whole
 * sky again. The mask is feathered, so the ring dissolves at the corridor
 * rather than ending on a straight cut. The opening probe is the full
 * circle, even after its cloud has landed — that first scan is of the
 * whole working area.
 */
function ReconWave({
  earth,
  estimate,
}: {
  earth: DiscGeometry
  estimate: ReconEstimate | null
  world: WorldGeometry
  placement: GridPlacement
}) {
  const maskToCloud = Boolean(estimate && estimate.probeCount >= 2)

  return (
    <g
      className={styles.wave}
      aria-hidden="true"
      mask={maskToCloud ? 'url(#recon-wave-mask)' : undefined}
    >
      <circle cx={earth.cx} cy={earth.cy} r={earth.r} className={styles.waveFlash} />
      {[styles.waveRing, styles.waveRingEcho].map((ring, index) => (
        <circle
          key={index}
          cx={earth.cx}
          cy={earth.cy}
          r={earth.r}
          className={ring}
          vectorEffect="non-scaling-stroke"
          style={sweepOrigin(earth)}
        />
      ))}
    </g>
  )
}

/**
 * Scaling a path grows it about its own bounding box, which would walk
 * the arc off Earth. Pinning the origin to the planet's centre is what
 * keeps every frame an arc of the same cone at a larger radius.
 */
function sweepOrigin(earth: DiscGeometry): CSSProperties {
  return { transformOrigin: `${earth.cx}px ${earth.cy}px` }
}

interface AxisLabel {
  key: string
  text: string
  x: number
  y: number
  /** Runs along the grid's top edge; otherwise down its left edge. */
  alongTop: boolean
}

/**
 * A-J for the columns and 1-5 for the rows, each set placed against the
 * edge its axis runs along. Transposing swaps which edge that is, so the
 * letters stay next to the columns and a sector is still read the same way
 * round on a phone as on a desktop.
 */
function axisLabels(grid: MapGridConfig, placement: GridPlacement): AxisLabel[] {
  const { originX, originY, cellSize, transposed } = placement
  const labels: AxisLabel[] = []

  for (let column = 0; column < grid.columns; column++) {
    const offset = cellSize * (column + 0.5)
    labels.push({
      key: `c${column}`,
      text: String.fromCharCode(65 + column),
      x: transposed ? originX : originX + offset,
      y: transposed ? originY + offset : originY,
      alongTop: !transposed,
    })
  }

  for (let row = 0; row < grid.rows; row++) {
    const offset = cellSize * (row + 0.5)
    labels.push({
      key: `r${row}`,
      text: String(row + 1),
      x: transposed ? originX + offset : originX,
      y: transposed ? originY : originY + offset,
      alongTop: transposed,
    })
  }

  return labels
}

interface GridLine {
  key: string
  x1: number
  y1: number
  x2: number
  y2: number
}

/**
 * Interior seams of the grid block only — its outer edges need no line
 * drawn on them. Counted in *screen* columns and rows, so a transposed
 * grid gets 4 verticals and 9 horizontals rather than the other way round.
 */
function gridLines(grid: MapGridConfig, placement: GridPlacement): GridLine[] {
  const across = placement.transposed ? grid.rows : grid.columns
  const down = placement.transposed ? grid.columns : grid.rows
  const { originX, originY, cellSize, width, height } = placement
  const lines: GridLine[] = []

  for (let i = 1; i < across; i++) {
    const x = originX + cellSize * i
    lines.push({ key: `v${i}`, x1: x, y1: originY, x2: x, y2: originY + height })
  }
  for (let i = 1; i < down; i++) {
    const y = originY + cellSize * i
    lines.push({ key: `h${i}`, x1: originX, y1: y, x2: originX + width, y2: y })
  }

  return lines
}

import { useId, type CSSProperties } from 'react'
import {
  buildSceneOutsideEarthPath,
  defensePointToScene,
  firstDiscHit,
  pointOnDrawnEarth,
  projectWorldPoint,
  type DiscGeometry,
  type GridPlacement,
  type SceneSize,
} from '../../game/spaceGrid'
import type { AttackRevealData, DefenseResult } from '../../game/types'
import type { WorldGeometry } from '../../game/world'
import { isAlreadyDown, isTooEarly, isTooLate } from '../../game/defense'
import { positionAtProgress } from '../../game/attacks'
import { sameAddress } from '../../utils/address'
import styles from './AttackReveal.module.css'

export interface AttackRevealProps {
  reveal: AttackRevealData
  /** The viewer's own address, so their marker can be called out from the rest. */
  viewer: string | null
  world: WorldGeometry
  placement: GridPlacement
  /** The globe as actually painted — where the impact has to land. */
  earth: DiscGeometry
  scene: SceneSize
  /**
   * Whether this client is watching the reveal *happen*. False when the
   * round was already open on arrival, in which case everything lands in
   * its final state at once instead of drawing itself in — a record being
   * read, not an event being performed.
   */
  animate?: boolean
}

/**
 * Which of the five things a committed point turned out to be.
 *
 * The same four questions the marker's own styling asks, collapsed into one
 * word. Kept beside them rather than derived twice, so a marker can never be
 * painted as one outcome and labelled as another.
 */
function markerVerdict(result: DefenseResult | undefined): string {
  if (!result) return 'pending'
  if (result.isWinner) return 'hit'
  if (isAlreadyDown(result)) return 'outranked'
  if (isTooEarly(result)) return 'early'
  if (isTooLate(result)) return 'late'
  return 'miss'
}

/**
 * The reveal (ТЗ §13.5-13.9, §14.2-14.6) — everything the protocol kept
 * sealed, put on the map at once: the real startPoint, the real
 * targetPoint, the full trajectory between them, every participant's
 * Defense Point with its interception radius drawn around it, and which of
 * them the threat actually flew into.
 *
 * It renders from `AttackRevealData` and nothing else. That value only
 * exists once the player has asked the chain for it and the chain has
 * agreed to answer, so there is no path by which this component could draw
 * early even if something upstream mounted it.
 *
 * The launch point is on the field's outer edge (ТЗ §3.1). The chord is
 * projected through the same grid as the Defense Points so a ring that
 * missed in protocol space cannot sit on the line by accident, then
 * clipped to the painted globe's rim so the strike ends on the planet
 * rather than through it.
 */
export function AttackReveal({
  reveal,
  viewer,
  world,
  placement,
  earth,
  scene,
  animate = true,
}: AttackRevealProps) {
  const clipId = `attack-reveal-sky${useId().replace(/:/g, '')}`
  const { trajectory, outcome, attempts, results } = reveal

  /*
   * The chord the protocol scored, in the same space as the Defense circles,
   * then stopped on the painted globe's rim. Two Earths (grid vs hero
   * stylesheet) only coincide on a typical landscape scene; running the
   * line to the grid impact is what drew a strike through the planet with
   * the marker sitting short of the end.
   */
  const launch = projectWorldPoint(trajectory.pointA, world, placement)
  const gridImpact = projectWorldPoint(trajectory.pointB, world, placement)
  const impact =
    firstDiscHit(launch, gridImpact, earth) ??
    pointOnDrawnEarth(trajectory.impactAngleRadians, earth)
  const interception = outcome.interceptionPoint
    ? projectWorldPoint(outcome.interceptionPoint, world, placement)
    : null
  const radiusPx = (outcome.interceptionRadiusKm / world.sectorSpanKm) * placement.cellSize

  const resultByAttempt = new Map<string, DefenseResult>(results.map((result) => [result.attemptId, result]))
  const snapshot = ownTimingSnapshot(reveal, viewer, world, placement, radiusPx)

  /*
   * `interceptionPoint` is the threat at the winner's submit — inside the
   * radius, often on top of the Defense marker. Drawing the trail there
   * puts the red head *in* the shield. The contact is the rim, first hit
   * from the launch, and the line stops a hair short of it.
   */
  const intercepted = outcome.intercepted && interception !== null
  const shield = winnerShield(attempts, resultByAttempt, placement)
  const rim =
    intercepted && shield
      ? firstDiscHit(launch, interception!, { cx: shield.x, cy: shield.y, r: radiusPx }) ??
        firstDiscHit(launch, impact, { cx: shield.x, cy: shield.y, r: radiusPx })
      : null
  const contact = intercepted ? (rim ?? interception!) : impact
  const trailEnd = intercepted ? shortenTo(launch, contact, TRAIL_STANDOFF_PX) : contact

  return (
    <svg
      className={[styles.layer, animate ? '' : styles.settled].filter(Boolean).join(' ')}
      width={scene.width}
      height={scene.height}
      role="img"
      aria-label={outcome.intercepted ? 'Attack intercepted' : 'Attack reached Earth'}
    >
      <defs>
        {/*
          The trail's round cap and 10px glow would otherwise paint a few
          pixels *into* the disc even when the endpoint sits on the rim.
          The sky clip is the same hole the grid uses, so the strike can
          meet the surface without crossing it.
        */}
        <clipPath id={clipId} clipPathUnits="userSpaceOnUse">
          <path d={buildSceneOutsideEarthPath(scene, earth)} clipRule="evenodd" />
        </clipPath>
      </defs>
      {/* The path itself, doubled: a soft wide pass for glow, a hard thin one for the line. */}
      <g clipPath={`url(#${clipId})`}>
        <line
          x1={launch.x}
          y1={launch.y}
          x2={trailEnd.x}
          y2={trailEnd.y}
          className={[styles.trailGlow, intercepted ? styles.trailGlowIntercepted : ''].filter(Boolean).join(' ')}
        />
        <line
          x1={launch.x}
          y1={launch.y}
          x2={trailEnd.x}
          y2={trailEnd.y}
          className={[styles.trail, intercepted ? styles.trailIntercepted : ''].filter(Boolean).join(' ')}
        />
      </g>

      {/* ТЗ §13.3 — the actual startPoint, on the working area's edge. */}
      <g className={styles.launch}>
        <circle cx={launch.x} cy={launch.y} r={7} className={styles.launchRing} />
        <circle cx={launch.x} cy={launch.y} r={2.5} className={styles.launchCore} />
      </g>

      {/*
        ТЗ §13.4 — the actual targetPoint, on Earth's surface. Drawn only
        when the threat actually got there: on an intercepted round the
        planet was never touched, and a marker on it would be a record of
        something that did not happen.
      */}
      {intercepted ? null : (
        <g className={styles.impact}>
          <circle cx={impact.x} cy={impact.y} r={9} className={styles.impactRing} />
          <circle cx={impact.x} cy={impact.y} r={3} className={styles.impactCore} />
        </g>
      )}

      {/*
        ТЗ §11.5 — the threat ends on the rim of the circle that caught it.
        Specks of it, mixed sizes, around the hit — not a red disc sitting
        inside the shield.
      */}
      {intercepted ? (
        <g className={styles.breakup}>
          {debrisBurst(launch, contact).map((piece, index) =>
            piece.kind === 'streak' ? (
              <line
                key={`s${index}`}
                x1={piece.x1}
                y1={piece.y1}
                x2={piece.x2}
                y2={piece.y2}
                className={styles.breakupStreak}
                style={{ animationDelay: `${1.02 + index * 0.018}s` }}
              />
            ) : (
              <g
                key={`d${index}`}
                className={styles.breakupDrift}
                style={
                  {
                    '--dx': `${piece.dx}px`,
                    '--dy': `${piece.dy}px`,
                    '--drift-dur': `${piece.driftDur}s`,
                    '--drift-phase': `${piece.driftPhase}`,
                  } as CSSProperties
                }
              >
                <circle
                  cx={piece.cx}
                  cy={piece.cy}
                  r={piece.r}
                  className={styles.breakupDot}
                  style={
                    {
                      '--ox': `${contact.x - piece.cx}px`,
                      '--oy': `${contact.y - piece.cy}px`,
                      animationDelay: `${1.02 + index * 0.012}s`,
                    } as CSSProperties
                  }
                />
              </g>
            ),
          )}
          <circle cx={trailEnd.x} cy={trailEnd.y} r={1.4} className={styles.breakupCore} />
        </g>
      ) : null}

      {/*
        ТЗ §14.2-14.5 — every participant's Defense Point, each with the
        interception radius it was actually judged against drawn around it.
        Drawing the radius rather than stating it is what makes a near miss
        legible: the circle either caught the line or it did not, and the
        margin is right there.
      */}
      {attempts.map((attempt) => {
        if (!attempt.defensePoint) return null
        const position = defensePointToScene(attempt.defensePoint, placement)
        const result = resultByAttempt.get(attempt.id)
        const isWinner = result?.isWinner ?? false
        const isHit = isWinner
        // An outranked hit is drawn with the mistimed ones rather than the
        // clean misses: the circle did close on the threat, and painting it
        // as though it never came near would misreport the round.
        const wrongTime = result ? isAlreadyDown(result) || isTooLate(result) || isTooEarly(result) : false
        const isOwn = sameAddress(attempt.participant, viewer)

        return (
          <g
            key={attempt.id}
            className={isOwn ? styles.own : styles.foreign}
            /*
             * Named by its verdict so the guided tour can point at one
             * outcome at a time — the early shot, the late one, the one that
             * was never near the path. Inert in the product; see
             * `guide/script.ts` for the only reader.
             */
            data-guide={`defense-${markerVerdict(result)}`}
          >
            <circle
              cx={position.x}
              cy={position.y}
              r={radiusPx}
              className={[
                styles.radius,
                isHit ? styles.radiusHit : wrongTime ? styles.radiusLate : styles.radiusMiss,
                isWinner ? styles.radiusWinner : '',
              ]
                .filter(Boolean)
                .join(' ')}
            />
            <circle
              cx={position.x}
              cy={position.y}
              r={isOwn ? 7 : 5}
              className={[
                styles.defense,
                isHit ? styles.defenseHit : wrongTime ? styles.defenseLate : styles.defenseMiss,
              ].join(' ')}
            />
            {isWinner ? <circle cx={position.x} cy={position.y} r={13} className={styles.defenseWinner} /> : null}
            {isOwn ? <circle cx={position.x} cy={position.y} r={11} className={styles.defenseOwn} /> : null}
          </g>
        )
      })}

      {/*
        A timing miss is two places: the circle that was waiting, and where
        the threat actually was at submit. The trail alone cannot tell them
        apart — it is the whole flight. This mark is the snapshot the
        protocol scored, so TOO EARLY and TOO LATE are a picture, not a label.
      */}
      {snapshot ? (
        <g clipPath={`url(#${clipId})`}>
          <line
            x1={snapshot.from.x}
            y1={snapshot.from.y}
            x2={snapshot.at.x}
            y2={snapshot.at.y}
            className={styles.snapshotLink}
          />
          <g
            className={styles.snapshot}
            aria-label={
              snapshot.late ? 'Threat position at your submit — already past' : 'Threat position at your submit — not there yet'
            }
          >
            <circle cx={snapshot.at.x} cy={snapshot.at.y} r={18} className={styles.snapshotHalo} />
            <circle cx={snapshot.at.x} cy={snapshot.at.y} r={8} className={styles.snapshotRing} />
            <circle cx={snapshot.at.x} cy={snapshot.at.y} r={3} className={styles.snapshotCore} />
          </g>
        </g>
      ) : null}
    </svg>
  )
}

/**
 * Where the threat was at this defender's submit — the snapshot the
 * protocol scored. Only drawn for a path-but-wrong-time miss: a spatial
 * miss never came near the line, and a hit already has the breakup.
 */
function ownTimingSnapshot(
  reveal: AttackRevealData,
  viewer: string | null,
  world: WorldGeometry,
  placement: GridPlacement,
  radiusPx: number,
): { at: { x: number; y: number }; from: { x: number; y: number }; late: boolean } | null {
  if (!viewer || reveal.flightDurationBlocks <= 0) return null
  const result = reveal.results.find((entry) => sameAddress(entry.participant, viewer))
  if (!result || result.arrivalBlock === null) return null
  if (!isTooLate(result) && !isTooEarly(result)) return null
  const attempt = reveal.attempts.find((entry) => entry.id === result.attemptId)
  if (!attempt?.defensePoint) return null

  const t = (result.arrivalBlock - reveal.launchBlock) / reveal.flightDurationBlocks
  const at = projectWorldPoint(positionAtProgress(reveal.trajectory, t), world, placement)
  const origin = defensePointToScene(attempt.defensePoint, placement)
  const dx = at.x - origin.x
  const dy = at.y - origin.y
  const span = Math.hypot(dx, dy)
  if (span < radiusPx + 6) return null
  const from = {
    x: origin.x + (dx / span) * radiusPx,
    y: origin.y + (dy / span) * radiusPx,
  }
  return { at, from, late: isTooLate(result) }
}

/** Hairline air so the stroke sits on the rim, not in the fill. */
const TRAIL_STANDOFF_PX = 4
const DEBRIS_COUNT = 46
const STREAK_COUNT = 10

function shortenTo(
  from: { x: number; y: number },
  at: { x: number; y: number },
  standoff: number,
): { x: number; y: number } {
  const dx = at.x - from.x
  const dy = at.y - from.y
  const span = Math.hypot(dx, dy) || 1
  const keep = Math.max(0, span - standoff) / span
  return { x: from.x + dx * keep, y: from.y + dy * keep }
}

function winnerShield(
  attempts: AttackRevealData['attempts'],
  resultByAttempt: Map<string, DefenseResult>,
  placement: GridPlacement,
): { x: number; y: number } | null {
  const winner = attempts.find((attempt) => attempt.defensePoint && resultByAttempt.get(attempt.id)?.isWinner)
  return winner?.defensePoint ? defensePointToScene(winner.defensePoint, placement) : null
}

type DebrisPiece =
  | {
      kind: 'dot'
      cx: number
      cy: number
      r: number
      dx: number
      dy: number
      driftDur: number
      driftPhase: number
    }
  | { kind: 'streak'; x1: number; y1: number; x2: number; y2: number }

/**
 * Burst on the rim: specks and shards thrown outward, denser near the hit
 * and thinning as they fly. The cone into the shield is emptied so they
 * don't sit on the Defense marker. Each speck then hangs and drifts a
 * couple of pixels around the point it landed — still in its place, not
 * a second scatter.
 */
function debrisBurst(
  from: { x: number; y: number },
  at: { x: number; y: number },
): DebrisPiece[] {
  const heading = Math.atan2(at.y - from.y, at.x - from.x)
  const seed = Math.abs(Math.round(at.x * 13 + at.y * 17)) | 1
  const pieces: DebrisPiece[] = []

  for (let i = 0; i < DEBRIS_COUNT; i++) {
    const u = hash01(seed, i)
    const v = hash01(seed, i + 101)
    let angle = (i / DEBRIS_COUNT) * Math.PI * 2 + (u - 0.5) * 0.45
    const delta = Math.atan2(Math.sin(angle - heading), Math.cos(angle - heading))
    if (Math.abs(delta) < 0.65) {
      angle = heading + (delta >= 0 ? 0.8 : -0.8) + (v - 0.5) * 0.55
    }
    const dist = 8 + Math.pow(v, 0.42) * 56
    const r = 0.35 + (1 - v) * (0.45 + u * 2.3)
    const w = hash01(seed, i + 419)
    const p = hash01(seed, i + 523)
    const amp = 0.7 + r * 0.45 + w * 0.55
    const theta = p * Math.PI * 2
    pieces.push({
      kind: 'dot',
      cx: at.x + Math.cos(angle) * dist,
      cy: at.y + Math.sin(angle) * dist,
      r,
      dx: Math.cos(theta) * amp,
      dy: Math.sin(theta) * amp,
      driftDur: 5.4 + hash01(seed, i + 601) * 4.8,
      driftPhase: hash01(seed, i + 701),
    })
  }

  for (let i = 0; i < STREAK_COUNT; i++) {
    const u = hash01(seed, i + 200)
    const v = hash01(seed, i + 311)
    const back = heading + Math.PI + (u - 0.5) * 2.8
    const inner = 5 + v * 10
    const length = 12 + u * 26
    pieces.push({
      kind: 'streak',
      x1: at.x + Math.cos(back) * inner,
      y1: at.y + Math.sin(back) * inner,
      x2: at.x + Math.cos(back) * (inner + length),
      y2: at.y + Math.sin(back) * (inner + length),
    })
  }

  return pieces
}

function hash01(seed: number, salt: number): number {
  const x = Math.imul(seed ^ (salt * 0x9e3779b9), 0x85ebca6b)
  return ((x >>> 0) % 1000) / 1000
}

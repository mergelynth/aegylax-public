import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AttackReveal } from '../../components/space/AttackReveal'
import { earthDiscInScene, firstDiscHit, placeGrid, projectWorldPoint, defensePointToScene } from '../../game/spaceGrid'
import type {
  Address,
  AttackRevealData,
  DefenseAttempt,
  DefensePoint,
  DefenseResult,
  Hash,
  Point2D,
} from '../../game/types'
import { buildWorld, defensePointToWorld } from '../../game/world'
import { TEST_MAP_GRID as grid } from '../fixtures'

const SCENE = { width: 1200, height: 700 }
const world = buildWorld(grid, 1000)
const placement = placeGrid(grid, SCENE)
const earth = earthDiscInScene(SCENE)

const YOU = '0x00000000000000000000000000000000000000aa' as Address
const RIVAL = '0x00000000000000000000000000000000000000bb' as Address
const THIRD = '0x00000000000000000000000000000000000000cc' as Address

function attempt(participant: Address, defensePoint: DefensePoint): DefenseAttempt {
  return {
    id: `attempt-${participant}`,
    lobbyId: '0xlobby' as Hash,
    attackId: 'attack-1',
    participant,
    // Post-reveal every point is public — that is what the reveal *is*.
    defensePoint,
    sealedPoint: null,
    submittedAtBlock: 10,
    submittedAtTimestamp: 0,
    txHash: `0x${participant.slice(2)}` as Hash,
  }
}

function result(participant: Address, status: DefenseResult['status'], isWinner = false): DefenseResult {
  return {
    attemptId: `attempt-${participant}`,
    participant,
    status,
    interceptionProgress: status === 'intercepted' ? 0.4 : null,
    interceptionBlock: status === 'intercepted' ? 30 : null,
    interceptionPoint: null,
    missDistanceKm: status === 'intercepted' ? null : 800,
    arrivalBlock: status === 'intercepted' ? 28 : 30,
    isWinner,
    reason: '',
  }
}

function point(column: number, row: number): DefensePoint {
  return { sector: { column, row }, offsetX: 0.5, offsetY: 0.5 }
}

function revealData(overrides: Partial<AttackRevealData> = {}): AttackRevealData {
  const pointB: Point2D = { x: world.earth.center.x, y: world.earth.center.y - world.earth.radiusKm }
  return {
    attackId: 'attack-1',
    trajectory: {
      pointA: { x: 0, y: 0 },
      pointB,
      impactAngleRadians: -Math.PI / 2,
      launchBearingRadians: -Math.PI / 2,
      lengthKm: 5000,
      speedKmPerBlock: 250,
    },
    outcome: {
      attackId: 'attack-1',
      intercepted: true,
      interceptionPoint: defensePointToWorld(point(4, 2), world),
      interceptionBlock: 30,
      interceptionProgress: 0.4,
      interceptionRadiusKm: 320,
      winners: [RIVAL],
      rewardPerWinner: 1,
      resolvedAtBlock: 40,
      resolvedAtTimestamp: 0,
    },
    attempts: [attempt(YOU, point(1, 1)), attempt(RIVAL, point(4, 2)), attempt(THIRD, point(7, 3))],
    results: [result(YOU, 'missed'), result(RIVAL, 'intercepted', true), result(THIRD, 'missed')],
    revealedAtBlock: 41,
    launchBlock: 0,
    flightDurationBlocks: 50,
    scored: true,
    ...overrides,
  }
}

function renderReveal(viewer: Address | null = YOU, overrides: Partial<AttackRevealData> = {}) {
  return render(
    <AttackReveal
      reveal={{ ...revealData(), ...overrides }}
      viewer={viewer}
      world={world}
      placement={placement}
      earth={earth}
      scene={SCENE}
    />,
  )
}

/** A round nobody stopped: the threat reached the planet. */
function reachedEarth(): Partial<AttackRevealData> {
  const base = revealData()
  return {
    outcome: {
      ...base.outcome,
      intercepted: false,
      interceptionPoint: null,
      interceptionBlock: null,
      interceptionProgress: null,
      winners: [],
      rewardPerWinner: 0,
    },
    results: [result(YOU, 'missed'), result(RIVAL, 'missed'), result(THIRD, 'missed')],
  }
}

const trailOf = (container: HTMLElement) =>
  container.querySelector('line[class*="trail"]:not([class*="Glow"])')!

describe('<AttackReveal /> the revealed round (ТЗ §8, §9)', () => {
  it('draws the real trajectory from startPoint to the impact on Earth when nothing stopped it (ТЗ §8)', () => {
    const { container } = renderReveal(YOU, reachedEarth())
    const trail = trailOf(container)
    const data = { ...revealData(), ...reachedEarth() }
    const launch = projectWorldPoint(data.trajectory.pointA, world, placement)

    expect(trail).not.toBeNull()
    expect(Number(trail.getAttribute('x1'))).toBeCloseTo(launch.x, 6)
    expect(Number(trail.getAttribute('y1'))).toBeCloseTo(launch.y, 6)

    const impactCore = container.querySelector('circle[class*="impactCore"]')!
    const impactX = Number(impactCore.getAttribute('cx'))
    const impactY = Number(impactCore.getAttribute('cy'))
    // The line ends on the marker, on the painted rim — never through the planet.
    expect(Number(trail.getAttribute('x2'))).toBeCloseTo(impactX, 6)
    expect(Number(trail.getAttribute('y2'))).toBeCloseTo(impactY, 6)
    expect(Math.hypot(impactX - earth.cx, impactY - earth.cy)).toBeCloseTo(earth.r, 6)
    const midX = (Number(trail.getAttribute('x1')) + impactX) / 2
    const midY = (Number(trail.getAttribute('y1')) + impactY) / 2
    expect(Math.hypot(midX - earth.cx, midY - earth.cy)).toBeGreaterThan(earth.r)
  })

  /**
   * The protocol's interception point is the threat at submit — inside the
   * radius. The drawn trail has to stop on the outside of that circle, or
   * the red head sits in the shield.
   */
  it('stops the trajectory on the outside of the Defense circle that caught it', () => {
    const { container } = renderReveal()
    const trail = trailOf(container)
    const data = revealData()
    const launch = projectWorldPoint(data.trajectory.pointA, world, placement)
    const intercept = projectWorldPoint(data.outcome.interceptionPoint!, world, placement)
    const shield = defensePointToScene(point(4, 2), placement)
    const radiusPx = (data.outcome.interceptionRadiusKm / world.sectorSpanKm) * placement.cellSize
    const rim = firstDiscHit(launch, intercept, { cx: shield.x, cy: shield.y, r: radiusPx })
    const end = { x: Number(trail.getAttribute('x2')), y: Number(trail.getAttribute('y2')) }

    expect(rim).not.toBeNull()
    expect(Math.hypot(end.x - launch.x, end.y - launch.y)).toBeLessThan(
      Math.hypot(intercept.x - launch.x, intercept.y - launch.y),
    )
    expect(Math.hypot(end.x - shield.x, end.y - shield.y)).toBeGreaterThanOrEqual(radiusPx - 0.5)
    expect(Math.hypot(end.x - rim!.x, end.y - rim!.y)).toBeLessThan(8)
    expect(container.querySelector('circle[class*="impactCore"]')).toBeNull()
  })

  it('breaks the threat apart where it was stopped', () => {
    const { container } = renderReveal()

    expect(container.querySelector('circle[class*="breakupCore"]')).not.toBeNull()
    expect(container.querySelectorAll('circle[class*="breakupDot"]').length).toBeGreaterThan(20)
    expect(container.querySelectorAll('line[class*="breakupStreak"]').length).toBeGreaterThan(4)
  })

  it('throws debris outward from the hit rather than as a clump on the rim', () => {
    const { container } = renderReveal()
    const trail = trailOf(container)
    const end = { x: Number(trail.getAttribute('x2')), y: Number(trail.getAttribute('y2')) }
    const distances = [...container.querySelectorAll('circle[class*="breakupDot"]')].map((dot) =>
      Math.hypot(Number(dot.getAttribute('cx')) - end.x, Number(dot.getAttribute('cy')) - end.y),
    )
    expect(Math.max(...distances)).toBeGreaterThan(36)
    expect(new Set(distances.map((d) => Math.round(d / 8))).size).toBeGreaterThan(3)
  })

  it('hangs each speck with its own drift so the cloud does not sit frozen', () => {
    const { container } = renderReveal()
    const drifts = [...container.querySelectorAll('g[class*="breakupDrift"]')]
    const dots = [...container.querySelectorAll('circle[class*="breakupDot"]')]

    expect(drifts.length).toBe(dots.length)
    expect(drifts.length).toBeGreaterThan(20)
    expect(dots.every((dot) => dot.parentElement?.getAttribute('class')?.includes('breakupDrift'))).toBe(true)

    const styles = drifts.map((group) => group.getAttribute('style') ?? '')
    expect(styles.every((style) => /--dx:/.test(style) && /--dy:/.test(style) && /--drift-dur:/.test(style))).toBe(true)
    expect(new Set(styles).size).toBeGreaterThan(10)
  })

  /**
   * ТЗ §7 — a round that was already open on arrival is a record being
   * read, not an event being watched: the same picture, without the strike
   * drawing itself in again on every reload.
   */
  it('performs the reveal only for the client watching it happen', () => {
    const performed = render(
      <AttackReveal
        reveal={revealData()}
        viewer={YOU}
        world={world}
        placement={placement}
        earth={earth}
        scene={SCENE}
      />,
    )
    expect(performed.container.querySelector('svg')!.getAttribute('class')).not.toMatch(/settled/)
    performed.unmount()

    const readBack = render(
      <AttackReveal
        reveal={revealData()}
        viewer={YOU}
        world={world}
        placement={placement}
        earth={earth}
        scene={SCENE}
        animate={false}
      />,
    )
    expect(readBack.container.querySelector('svg')!.getAttribute('class')).toMatch(/settled/)
  })

  it('puts every defender on the map, each with the radius they were judged by (ТЗ §9)', () => {
    const { container } = renderReveal()

    expect(container.querySelectorAll('circle[class*="radius"]')).toHaveLength(3)
    expect(container.querySelectorAll('circle[class*="defense"]').length).toBeGreaterThanOrEqual(3)
  })

  it('holds other defenders back so the viewer’s own point stays clearest (ТЗ §9)', () => {
    const { container } = renderReveal(YOU)
    const own = [...container.querySelectorAll('g')].find((group) => group.className.baseVal.includes('own'))!
    const foreign = [...container.querySelectorAll('g')].filter((group) =>
      group.className.baseVal.includes('foreign'),
    )

    expect(own.className.baseVal).not.toMatch(/foreign/)
    expect(foreign).toHaveLength(2)
  })

  it('has no own marker to single out when nobody is connected', () => {
    const { container } = renderReveal(null)
    expect([...container.querySelectorAll('g')].some((g) => g.className.baseVal.includes('own'))).toBe(false)
    expect([...container.querySelectorAll('g')].filter((g) => g.className.baseVal.includes('foreign'))).toHaveLength(3)
  })

  it('calls the winner out rather than leaving it to be inferred (ТЗ §8)', () => {
    const { container } = renderReveal()
    expect(container.querySelectorAll('circle[class*="defenseWinner"]')).toHaveLength(1)
  })

  it('marks where the winning interception happened (ТЗ §8)', () => {
    const { container } = renderReveal()
    expect(container.querySelectorAll('circle[class*="breakupDot"]').length).toBeGreaterThan(20)
  })

  it('paints every hit in the winning block as a hit, not a late cover of an earlier one', () => {
    const { container } = renderReveal(YOU, {
      results: [result(YOU, 'intercepted', true), result(RIVAL, 'intercepted', true), result(THIRD, 'missed')],
      outcome: {
        ...revealData().outcome,
        winners: [YOU, RIVAL],
      },
    })
    const own = [...container.querySelectorAll('g')].find((group) => group.className.baseVal.includes('own'))!
    expect(own.querySelector('circle[class*="radiusHit"]')).not.toBeNull()
    expect(own.querySelector('circle[class*="defenseHit"]')).not.toBeNull()
    expect(own.querySelector('circle[class*="radiusLate"]')).toBeNull()
    expect(container.querySelectorAll('circle[class*="defenseWinner"]')).toHaveLength(2)
  })

  it('paints an outranked hit as late rather than as a miss in space', () => {
    const { container } = renderReveal(YOU, {
      results: [result(YOU, 'intercepted', false), result(RIVAL, 'intercepted', true), result(THIRD, 'missed')],
      outcome: {
        ...revealData().outcome,
        winners: [RIVAL],
      },
    })
    // The circle did close on the threat; what it did not do is kill it.
    const own = [...container.querySelectorAll('g')].find((group) => group.className.baseVal.includes('own'))!
    expect(own.querySelector('circle[class*="radiusLate"]')).not.toBeNull()
    expect(own.querySelector('circle[class*="radiusHit"]')).toBeNull()
    expect(container.querySelectorAll('circle[class*="defenseWinner"]')).toHaveLength(1)
  })

  it('paints a path-but-late intercept as late, not as a miss in space', () => {
    const late = result(YOU, 'missed')
    late.interceptionBlock = 28
    late.arrivalBlock = 36
    late.missDistanceKm = 10
    const { container } = renderReveal(YOU, {
      outcome: {
        ...revealData().outcome,
        intercepted: false,
        interceptionPoint: null,
        interceptionBlock: null,
        interceptionProgress: null,
        winners: [],
        rewardPerWinner: 0,
      },
      results: [late, result(RIVAL, 'missed'), result(THIRD, 'missed')],
    })
    expect(container.querySelector('circle[class*="radiusLate"]')).not.toBeNull()
    expect(container.querySelector('circle[class*="defenseLate"]')).not.toBeNull()
  })

  it('marks where the threat was at the viewer’s submit when they missed the clock', () => {
    const late = result(YOU, 'missed')
    late.interceptionBlock = 28
    late.arrivalBlock = 36
    late.missDistanceKm = 10
    const data = {
      ...reachedEarth(),
      results: [late, result(RIVAL, 'missed'), result(THIRD, 'missed')],
    }
    const { container } = renderReveal(YOU, data)
    const mark = container.querySelector('circle[class*="snapshotCore"]')
    expect(mark).not.toBeNull()
    expect(container.querySelector('line[class*="snapshotLink"]')).not.toBeNull()

    const reveal = { ...revealData(), ...data }
    const launch = projectWorldPoint(reveal.trajectory.pointA, world, placement)
    const t = 36 / 50
    const expected = projectWorldPoint(
      {
        x: reveal.trajectory.pointA.x + (reveal.trajectory.pointB.x - reveal.trajectory.pointA.x) * t,
        y: reveal.trajectory.pointA.y + (reveal.trajectory.pointB.y - reveal.trajectory.pointA.y) * t,
      },
      world,
      placement,
    )
    expect(Number(mark!.getAttribute('cx'))).toBeCloseTo(expected.x, 4)
    expect(Number(mark!.getAttribute('cy'))).toBeCloseTo(expected.y, 4)
    expect(Number(mark!.getAttribute('cx'))).not.toBeCloseTo(launch.x, 0)
  })

  it('does not invent a snapshot for a miss that never met the path', () => {
    const { container } = renderReveal(YOU, reachedEarth())
    expect(container.querySelector('circle[class*="snapshotCore"]')).toBeNull()
    expect(container.querySelector('line[class*="snapshotLink"]')).toBeNull()
  })
  /**
   * The names the guided tour points at (`guide/script.ts`).
   *
   * They are built on the fly — `data-guide={`defense-${verdict}`}` — so the
   * tour's own source scan can only check the *prefix*. This is the half
   * that scan cannot reach: that the four suffixes it names are the four a
   * reveal actually emits. Rename one of these verdicts and the highlight
   * silently stops finding anything, on a page that otherwise looks right.
   */
  it('names each committed point by its verdict, for the guided tour', () => {
    const { container } = renderReveal(YOU, {
      attempts: [
        attempt(YOU, point(1, 1)),
        attempt(RIVAL, point(4, 2)),
        attempt(THIRD, point(7, 3)),
      ],
      results: [
        // Never near the path: no interception block at all.
        { ...result(YOU, 'missed'), interceptionBlock: null },
        { ...result(RIVAL, 'intercepted', true) },
        // On the path, but the threat passed through before the commit.
        { ...result(THIRD, 'missed'), interceptionBlock: 20, arrivalBlock: 40 },
      ],
    })

    expect(container.querySelector('[data-guide="defense-hit"]')).not.toBeNull()
    expect(container.querySelector('[data-guide="defense-miss"]')).not.toBeNull()
    expect(container.querySelector('[data-guide="defense-late"]')).not.toBeNull()
  })

  it('tells an early commit from a late one', () => {
    const { container } = renderReveal(YOU, {
      attempts: [attempt(YOU, point(1, 1))],
      // On the path, but the threat had not reached it at the commit.
      results: [{ ...result(YOU, 'missed'), interceptionBlock: 40, arrivalBlock: 20 }],
    })

    expect(container.querySelector('[data-guide="defense-early"]')).not.toBeNull()
    expect(container.querySelector('[data-guide="defense-late"]')).toBeNull()
  })

})

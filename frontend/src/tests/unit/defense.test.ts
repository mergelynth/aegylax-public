import { describe, expect, it } from 'vitest'
import { checkInterception, createDefenseAttempt, formatDefenseTiming, isAlreadyDown, isLateArrival, isTooLate, previewDefenseTiming, rendezvousSubmitBlock, resolveAttackDefenses, resolveDefense } from '../../game/defense'
import type { Address, Attack, AttackTrajectory, DefenseAttempt, DefensePoint, Hash } from '../../game/types'
import { buildWorld, worldToDefensePoint } from '../../game/world'
import { TEST_MAP_GRID, TEST_PROTOCOL_LIMITS } from '../fixtures'

const speed = TEST_PROTOCOL_LIMITS.defenseSpeedKmPerBlock

const world = buildWorld(TEST_MAP_GRID, TEST_PROTOCOL_LIMITS.sectorSpanKm)
const radiusKm = TEST_PROTOCOL_LIMITS.interceptionRadiusSectors * world.sectorSpanKm

const attack: Pick<Attack, 'launchBlock' | 'flightDurationBlocks'> = {
  launchBlock: 1000,
  flightDurationBlocks: TEST_PROTOCOL_LIMITS.epochBlocks,
}

/** A path straight across the middle of the field, left to right, so "how far along" is easy to reason about. */
const trajectory: AttackTrajectory = {
  pointA: { x: 0, y: world.heightKm / 2 },
  pointB: { x: world.widthKm, y: world.heightKm / 2 },
  // Only the reveal reads this; interception is computed from the points.
  impactAngleRadians: -Math.PI / 2,
  lengthKm: world.widthKm,
  speedKmPerBlock: world.widthKm / TEST_PROTOCOL_LIMITS.epochBlocks,
}

function timedAttempt(participant: string, point: DefensePoint, path: AttackTrajectory = trajectory): DefenseAttempt {
  return attemptAt(
    participant,
    point,
    rendezvousSubmitBlock({
      point,
      world,
      launchBlock: attack.launchBlock,
      flightBlocks: attack.flightDurationBlocks,
      trajectory: path,
      defenseSpeedKmPerBlock: speed,
    }),
  )
}

function attemptAt(participant: string, point: DefensePoint, submittedAtBlock = attack.launchBlock): DefenseAttempt {
  return createDefenseAttempt({
    id: `attempt-${participant}`,
    lobbyId: '0xlobby' as Hash,
    attackId: 'attack-1',
    participant: participant as Address,
    defensePoint: point,
    submittedAtBlock,
    submittedAtTimestamp: 0,
    txHash: '0xtx' as Hash,
  })
}

/** A Defense Point `offsetKm` off the path, at the middle of the field. */
function pointOffPath(offsetKm: number): DefensePoint {
  return worldToDefensePoint({ x: world.widthKm / 2, y: world.heightKm / 2 + offsetKm }, world)
}

/** A Defense Point directly on the path, `fraction` of the way along it. */
function pointAlongPath(fraction: number): DefensePoint {
  return worldToDefensePoint({ x: world.widthKm * fraction, y: world.heightKm / 2 }, world)
}

describe('interception test (ТЗ §11.1-11.3)', () => {
  it('intercepts a point sitting on the trajectory', () => {
    const check = checkInterception(pointOffPath(0), trajectory, world, radiusKm)
    expect(check.intercepts).toBe(true)
    expect(check.missDistanceKm).toBeLessThan(1)
  })

  it('intercepts just inside the radius and misses just outside it', () => {
    expect(checkInterception(pointOffPath(radiusKm * 0.9), trajectory, world, radiusKm).intercepts).toBe(true)
    expect(checkInterception(pointOffPath(radiusKm * 1.1), trajectory, world, radiusKm).intercepts).toBe(false)
  })

  it('measures against the whole flight, not just the impact point', () => {
    // Far from where the attack lands, but directly on its approach.
    expect(checkInterception(pointAlongPath(0.1), trajectory, world, radiusKm).intercepts).toBe(true)
  })

  it('reports *when* the threat entered the radius, not how near it passed (§11.3)', () => {
    const check = checkInterception(pointAlongPath(0.5), trajectory, world, radiusKm)
    // Entry is at the near edge of the circle, so slightly before the
    // Defense Point itself — which is exactly what a proximity test could
    // not have told us.
    expect(check.interceptionProgress).toBeLessThan(0.5)
    expect(check.interceptionProgress).toBeCloseTo(0.5 - radiusKm / world.widthKm, 6)
  })

  it('gives an earlier interception time to a Defense Point further up the approach (§11.5)', () => {
    const early = checkInterception(pointAlongPath(0.2), trajectory, world, radiusKm)
    const late = checkInterception(pointAlongPath(0.8), trajectory, world, radiusKm)
    expect(early.interceptionProgress).toBeLessThan(late.interceptionProgress)
  })

  it('refuses an interception the threat would only reach after impact (§11.2)', () => {
    // A point beyond the end of the flight: the infinite line runs into its
    // radius, the flight stops before it does.
    const beyond = worldToDefensePoint(
      { x: world.widthKm, y: world.heightKm / 2 },
      world,
    )
    const short: AttackTrajectory = {
      ...trajectory,
      pointB: { x: world.widthKm - radiusKm * 4, y: world.heightKm / 2 },
    }
    expect(checkInterception(beyond, short, world, radiusKm).intercepts).toBe(false)
  })
})

describe('resolving one attempt', () => {
  it('reports pending while the trajectory is still sealed', () => {
    const result = resolveDefense(attemptAt('0xa', pointOffPath(0)), attack, null, world, radiusKm, speed)
    expect(result.status).toBe('pending')
    expect(result.interceptionBlock).toBeNull()
  })

  it('reports pending for an attempt whose point the caller may not see (ТЗ §14.1)', () => {
    const redacted = { ...attemptAt('0xa', pointOffPath(0)), defensePoint: null }
    expect(resolveDefense(redacted, attack, trajectory, world, radiusKm, speed).status).toBe('pending')
  })

  it('reports the miss distance either way, and an interception block only on a hit', () => {
    const hit = resolveDefense(timedAttempt('0xa', pointOffPath(0)), attack, trajectory, world, radiusKm, speed)
    const miss = resolveDefense(attemptAt('0xb', pointOffPath(radiusKm * 3)), attack, trajectory, world, radiusKm, speed)
    expect(hit.status).toBe('intercepted')
    expect(hit.interceptionBlock).toBeGreaterThan(attack.launchBlock)
    expect(hit.interceptionBlock).toBeLessThan(attack.launchBlock + attack.flightDurationBlocks)
    expect(miss.status).toBe('missed')
    expect(miss.missDistanceKm).toBeGreaterThan(hit.missDistanceKm ?? 0)
  })

  it('misses a path cover submitted at launch — the threat is not there yet', () => {
    const result = resolveDefense(attemptAt('0xa', pointAlongPath(0.9)), attack, trajectory, world, radiusKm, speed)
    expect(result.status).toBe('missed')
    expect(isTooLate(result) || result.reason).toBeTruthy()
  })

  it('never awards the win on its own — that is a comparison it cannot make', () => {
    expect(resolveDefense(attemptAt('0xa', pointOffPath(0)), attack, trajectory, world, radiusKm, speed).isWinner).toBe(false)
  })
})

describe('resolving an attack (ТЗ §11.5-11.7)', () => {
  function resolve(
    attempts: DefenseAttempt[],
    path: AttackTrajectory = trajectory,
  ) {
    return resolveAttackDefenses(attempts, attack, path, world, radiusKm, speed)
  }

  it('gives the win to a timed snapshot, not a later submit on the same point', () => {
    const point = pointAlongPath(0.5)
    const onTime = timedAttempt('0xontime', point)
    const resolution = resolve([
      attemptAt('0xlate', point, onTime.submittedAtBlock + 8),
      onTime,
    ])
    expect(resolution.intercepted).toBe(true)
    expect(resolution.winners).toEqual(['0xontime'])
  })

  it('splits when two interceptors arrive together at the same point', () => {
    const point = pointAlongPath(0.5)
    const submit = timedAttempt('0xa', point).submittedAtBlock
    const resolution = resolve([
      attemptAt('0xa', point, submit),
      attemptAt('0xb', point, submit),
    ])
    expect(resolution.winners).toEqual(['0xa', '0xb'])
  })

  it('records a timed low intercept as a later snapshot, not a cover of the chord', () => {
    const inbound: AttackTrajectory = {
      pointA: { x: world.widthKm / 2, y: 0 },
      pointB: { x: world.earth.center.x, y: world.earth.center.y - world.earth.radiusKm },
      impactAngleRadians: -Math.PI / 2,
      lengthKm: 0,
      speedKmPerBlock: 0,
    }
    inbound.lengthKm = Math.hypot(inbound.pointB.x - inbound.pointA.x, inbound.pointB.y - inbound.pointA.y)
    inbound.speedKmPerBlock = inbound.lengthKm / attack.flightDurationBlocks

    const along = (t: number) =>
      worldToDefensePoint(
        {
          x: inbound.pointA.x + (inbound.pointB.x - inbound.pointA.x) * t,
          y: inbound.pointA.y + (inbound.pointB.y - inbound.pointA.y) * t,
        },
        world,
      )

    const resolution = resolve(
      [timedAttempt('0xhigh', along(0.2), inbound), timedAttempt('0xlow', along(0.75), inbound)],
      inbound,
    )
    const high = resolution.results.find((result) => result.participant === '0xhigh')
    const low = resolution.results.find((result) => result.participant === '0xlow')
    expect(high?.status).toBe('intercepted')
    expect(high?.isWinner).toBe(true)
    // The low shot was on the threat at its own submit block, which is a
    // different fact from killing it: by then the threat was already down.
    expect(low?.status).toBe('intercepted')
    expect(low?.isWinner).toBe(false)
    expect(isAlreadyDown(low!)).toBe(true)
    expect(isTooLate(low!)).toBe(false)
  })

  it('pays only the highest of two timed intercepts on the same path', () => {
    const inbound: AttackTrajectory = {
      pointA: { x: world.widthKm / 2, y: 0 },
      pointB: { x: world.earth.center.x, y: world.earth.center.y - world.earth.radiusKm },
      impactAngleRadians: -Math.PI / 2,
      lengthKm: 0,
      speedKmPerBlock: 0,
    }
    inbound.lengthKm = Math.hypot(inbound.pointB.x - inbound.pointA.x, inbound.pointB.y - inbound.pointA.y)
    inbound.speedKmPerBlock = inbound.lengthKm / attack.flightDurationBlocks

    const along = (t: number) =>
      worldToDefensePoint(
        {
          x: inbound.pointA.x + (inbound.pointB.x - inbound.pointA.x) * t,
          y: inbound.pointA.y + (inbound.pointB.y - inbound.pointA.y) * t,
        },
        world,
      )

    const resolution = resolve(
      [timedAttempt('0xhigh', along(0.2), inbound), timedAttempt('0xlow', along(0.75), inbound)],
      inbound,
    )
    expect(resolution.intercepted).toBe(true)
    expect(resolution.winners).toEqual(['0xhigh'])
  })

  it('reports the winning interception as the threat position at arrival', () => {
    const point = pointAlongPath(0.5)
    const resolution = resolve([timedAttempt('0xa', point)])
    const t = resolution.interceptionProgress ?? 0
    expect(resolution.intercepted).toBe(true)
    expect(t).toBeCloseTo(0.5, 1)
    expect(resolution.interceptionPoint?.x).toBeCloseTo(world.widthKm * t, 5)
    expect(resolution.interceptionBlock).toBeCloseTo(
      attack.launchBlock + t * attack.flightDurationBlocks,
    )
  })

  it('does not pay a static wall — only the circle the threat is in at arrival', () => {
    const inbound: AttackTrajectory = {
      pointA: { x: world.widthKm / 2, y: 0 },
      pointB: { x: world.earth.center.x, y: world.earth.center.y - world.earth.radiusKm },
      impactAngleRadians: -Math.PI / 2,
      lengthKm: 0,
      speedKmPerBlock: 0,
    }
    inbound.lengthKm = Math.hypot(inbound.pointB.x - inbound.pointA.x, inbound.pointB.y - inbound.pointA.y)
    inbound.speedKmPerBlock = inbound.lengthKm / attack.flightDurationBlocks

    const wallY = inbound.pointA.y + (inbound.pointB.y - inbound.pointA.y) * 0.45
    const wall = [-3, -2, -1, 0, 1, 2, 3].map((offset, index) =>
      attemptAt(
        `0x${index}`,
        worldToDefensePoint({ x: world.widthKm / 2 + offset * world.sectorSpanKm * 0.5, y: wallY }, world),
      ),
    )
    const resolution = resolve(wall, inbound)
    expect(resolution.results.filter((result) => result.isWinner).length).toBeLessThanOrEqual(1)
    expect(resolution.results.filter((result) => result.status === 'intercepted').length).toBeLessThan(wall.length)
  })

  it('does not pay a line of untimed covers along the path', () => {
    const inbound: AttackTrajectory = {
      pointA: { x: world.widthKm / 2, y: 0 },
      pointB: { x: world.earth.center.x, y: world.earth.center.y - world.earth.radiusKm },
      impactAngleRadians: -Math.PI / 2,
      lengthKm: 0,
      speedKmPerBlock: 0,
    }
    inbound.lengthKm = Math.hypot(inbound.pointB.x - inbound.pointA.x, inbound.pointB.y - inbound.pointA.y)
    inbound.speedKmPerBlock = inbound.lengthKm / attack.flightDurationBlocks

    const along = (t: number) =>
      worldToDefensePoint(
        {
          x: inbound.pointA.x + (inbound.pointB.x - inbound.pointA.x) * t,
          y: inbound.pointA.y + (inbound.pointB.y - inbound.pointA.y) * t,
        },
        world,
      )

    const resolution = resolve(
      [0.2, 0.4, 0.6, 0.85].map((t, index) => attemptAt(`0x${index}`, along(t))),
      inbound,
    )
    expect(resolution.results.filter((result) => result.status === 'intercepted').length).toBeLessThan(4)
  })

  it('splits only among snapshot hits, not a wall of untimed covers', () => {
    const point = pointAlongPath(0.5)
    const submit = timedAttempt('0xa', point).submittedAtBlock
    const resolution = resolve([
      attemptAt('0xa', point, submit),
      attemptAt('0xb', point, submit),
    ])
    expect(resolution.winners).toEqual(['0xa', '0xb'])
  })

  it('does not split when two timed intercepts sit at different places on the path', () => {
    const resolution = resolve([
      timedAttempt('0xa', pointAlongPath(0.4)),
      timedAttempt('0xb', pointAlongPath(0.6)),
    ])
    expect(resolution.winners).toEqual(['0xa'])
    expect(resolution.results.find((result) => result.participant === '0xb')?.isWinner).toBe(false)
  })

  it('splits across every hit in the winning block, however many', () => {
    const point = pointAlongPath(0.5)
    const submit = timedAttempt('0xa', point).submittedAtBlock
    const resolution = resolve([
      attemptAt('0xa', point, submit),
      attemptAt('0xb', point, submit),
      attemptAt('0xc', point, submit),
      attemptAt('0xd', point, submit),
    ])
    expect(resolution.winners).toEqual(['0xa', '0xb', '0xc', '0xd'])
  })

  it('does not count a defender who submitted after the threat passed', () => {
    const inbound: AttackTrajectory = {
      pointA: { x: world.widthKm / 2, y: 0 },
      pointB: { x: world.earth.center.x, y: world.earth.center.y - world.earth.radiusKm },
      impactAngleRadians: -Math.PI / 2,
      lengthKm: 0,
      speedKmPerBlock: 0,
    }
    inbound.lengthKm = Math.hypot(inbound.pointB.x - inbound.pointA.x, inbound.pointB.y - inbound.pointA.y)
    inbound.speedKmPerBlock = inbound.lengthKm / attack.flightDurationBlocks
    const high = worldToDefensePoint(
      {
        x: inbound.pointA.x + (inbound.pointB.x - inbound.pointA.x) * 0.08,
        y: inbound.pointA.y + (inbound.pointB.y - inbound.pointA.y) * 0.08,
      },
      world,
    )
    const resolution = resolve(
      [attemptAt('0xlate', high, attack.launchBlock + attack.flightDurationBlocks - 2)],
      inbound,
    )
    expect(resolution.intercepted).toBe(false)
    expect(resolution.results[0]?.status).toBe('missed')
    expect(resolution.results[0]?.arrivalBlock).toBeGreaterThan(resolution.results[0]?.interceptionBlock ?? 0)
    expect(isLateArrival(resolution.results[0]!)).toBe(true)
  })

  it('reaches Earth when nothing is inside the radius', () => {
    const resolution = resolve([
      attemptAt('0xa', pointOffPath(radiusKm * 4)),
      attemptAt('0xb', pointOffPath(-radiusKm * 5)),
    ])
    expect(resolution.intercepted).toBe(false)
    expect(resolution.winners).toEqual([])
    expect(resolution.interceptionPoint).toBeNull()
    expect(resolution.interceptionBlock).toBeNull()
  })

  it('reaches Earth when nobody defended at all', () => {
    expect(resolve([]).intercepted).toBe(false)
  })

  it('ignores attempts whose point is not visible to the resolver', () => {
    const redacted = { ...attemptAt('0xa', pointOffPath(0)), defensePoint: null }
    expect(resolve([redacted]).winners).toEqual([])
  })
})

describe('defense timing preview', () => {
  it('flags a point behind the inbound as late', () => {
    const axis = { from: trajectory.pointA, to: trajectory.pointB }
    const nearImpact = pointAlongPath(0.9)
    const timing = previewDefenseTiming({
      point: nearImpact,
      world,
      nowBlock: attack.launchBlock + attack.flightDurationBlocks - 2,
      launchBlock: attack.launchBlock,
      flightBlocks: attack.flightDurationBlocks,
      defenseSpeedKmPerBlock: speed,
      axis,
    })
    expect(timing.late).toBe(true)
    expect(formatDefenseTiming(timing, attack.launchBlock + attack.flightDurationBlocks - 2)).toMatch(
      /TOO LATE .*threat already passed/,
    )
  })

  it('flags a parked low point as too early — waiting on station is a miss', () => {
    const axis = { from: trajectory.pointA, to: trajectory.pointB }
    const nearImpact = pointAlongPath(0.9)
    const timing = previewDefenseTiming({
      point: nearImpact,
      world,
      nowBlock: attack.launchBlock + 2,
      submittedAtBlock: attack.launchBlock,
      launchBlock: attack.launchBlock,
      flightBlocks: attack.flightDurationBlocks,
      defenseSpeedKmPerBlock: speed,
      axis,
    })
    expect(timing.early).toBe(true)
    expect(timing.late).toBe(false)
    expect(formatDefenseTiming(timing, attack.launchBlock + 2)).toMatch(/TOO EARLY .*threat not there yet/)
  })

  it('does not flag a point still ahead of the inbound', () => {
    const axis = { from: trajectory.pointA, to: trajectory.pointB }
    const nearLaunch = pointAlongPath(0.15)
    const timing = previewDefenseTiming({
      point: nearLaunch,
      world,
      nowBlock: attack.launchBlock + 2,
      launchBlock: attack.launchBlock,
      flightBlocks: attack.flightDurationBlocks,
      defenseSpeedKmPerBlock: speed,
      axis,
    })
    expect(timing.late).toBe(false)
    expect(formatDefenseTiming(timing, attack.launchBlock + 2)).toMatch(/Est\. submit: Block/)
  })
})

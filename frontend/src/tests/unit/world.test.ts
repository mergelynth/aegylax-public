import { describe, expect, it } from 'vitest'
import {
  buildWorld,
  closestApproach,
  defensePointToWorld,
  distance,
  impactAngleFromUnit,
  firstEntryIntoCircle,
  isApproachClearOfEarth,
  isInsideField,
  isOnFieldBoundary,
  approachAngleFromUnit,
  rayToFieldBoundary,
  rayExitFromEarth,
  pointOnEarthSurface,
  sectorCenterKm,
  sectorFromWorldPoint,
  worldToDefensePoint,
} from '../../game/world'
import { TEST_MAP_GRID } from '../fixtures'

const SECTOR_SPAN_KM = 1000
const world = buildWorld(TEST_MAP_GRID, SECTOR_SPAN_KM)

describe('world geometry (ТЗ §2, §16)', () => {
  it('lays every sector out as the same square', () => {
    expect(world.widthKm).toBeCloseTo(world.sectorSpanKm * TEST_MAP_GRID.columns)
    expect(world.heightKm).toBeCloseTo(world.sectorSpanKm * TEST_MAP_GRID.rows)
  })

  it('puts Earth on the horizon: bottom-centre, its centre below the board', () => {
    expect(world.earth.center.x).toBeCloseTo(world.widthKm / 2)
    expect(world.earth.center.y).toBeGreaterThan(world.heightKm)
  })

  it('leaves only the cap on the board, which is what the grid trims against', () => {
    const capTop = world.earth.center.y - world.earth.radiusKm
    expect(capTop).toBeGreaterThan(0)
    expect(capTop).toBeLessThan(world.heightKm)
  })

  it('takes its scale from the sector span it was given, and nothing else (ТЗ §5)', () => {
    expect(world.sectorSpanKm).toBe(SECTOR_SPAN_KM)
    expect(buildWorld(TEST_MAP_GRID, SECTOR_SPAN_KM * 2).widthKm).toBe(world.widthKm * 2)
  })

  it('reproduces the hero stylesheet’s globe, so the two never disagree on screen', () => {
    // A landscape scene is width-limited, so one sector is a tenth of it.
    const sceneWidth = 1440
    const cellSize = sceneWidth / TEST_MAP_GRID.columns
    const cssDiameter = Math.min(Math.max(320, sceneWidth * 0.46), 680)
    expect((world.earth.radiusKm / world.sectorSpanKm) * cellSize * 2).toBeCloseTo(cssDiameter, 6)
  })
})

describe('defense point addressing (ТЗ §7.5)', () => {
  it('round-trips a sector-relative point through absolute km', () => {
    const point = { sector: { column: 7, row: 3 }, offsetX: 0.25, offsetY: 0.8 }
    const back = worldToDefensePoint(defensePointToWorld(point, world), world)
    expect(back.sector).toEqual(point.sector)
    expect(back.offsetX).toBeCloseTo(point.offsetX)
    expect(back.offsetY).toBeCloseTo(point.offsetY)
  })

  it('places the centre offset at the sector centre', () => {
    const sector = { column: 2, row: 1 }
    const centre = defensePointToWorld({ sector, offsetX: 0.5, offsetY: 0.5 }, world)
    expect(centre).toEqual(sectorCenterKm(sector, world))
  })

  it('keeps every sector centre inside the field and in its own sector', () => {
    for (let column = 0; column < TEST_MAP_GRID.columns; column++) {
      for (let row = 0; row < TEST_MAP_GRID.rows; row++) {
        const centre = sectorCenterKm({ column, row }, world)
        expect(isInsideField(centre, world)).toBe(true)
        expect(sectorFromWorldPoint(centre, world)).toEqual({ column, row })
      }
    }
  })

  it('clamps a point outside the field back onto the board', () => {
    const clamped = worldToDefensePoint({ x: -5000, y: 99_000 }, world)
    expect(clamped.sector).toEqual({ column: 0, row: TEST_MAP_GRID.rows - 1 })
  })
})

describe('closest approach — a measurement, not the interception test (ТЗ §11.3)', () => {
  it('measures perpendicular distance to the segment', () => {
    const approach = closestApproach({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })
    expect(approach.distanceKm).toBeCloseTo(3)
    expect(approach.t).toBeCloseTo(0.5)
  })

  it('clamps past the segment ends rather than measuring to the infinite line', () => {
    const approach = closestApproach({ x: 20, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })
    expect(approach.t).toBe(1)
    expect(approach.distanceKm).toBeCloseTo(10)
  })

  it('reports zero for a point on the path', () => {
    expect(closestApproach({ x: 4, y: 4 }, { x: 0, y: 0 }, { x: 8, y: 8 }).distanceKm).toBeCloseTo(0)
  })
})

describe('Earth surface points (ТЗ §3.2)', () => {
  it('lands exactly on the rim at every angle', () => {
    for (const angle of [0, Math.PI / 3, Math.PI, (5 * Math.PI) / 4]) {
      const point = pointOnEarthSurface(angle, world)
      expect(distance(point, world.earth.center)).toBeCloseTo(world.earth.radiusKm)
    }
  })

  it('keeps every drawn impact angle on the cap that is actually on the board', () => {
    for (const unit of [0, 0.25, 0.5, 0.75, 0.999]) {
      const point = pointOnEarthSurface(impactAngleFromUnit(unit), world)
      expect(point.y).toBeLessThan(world.earth.center.y)
      expect(isInsideField(point, world)).toBe(true)
    }
  })

  it('puts a launch derived from a bearing on the field’s outer edge', () => {
    for (const angle of [-Math.PI / 2, -Math.PI / 2 + 0.4, -Math.PI / 2 - 0.5, -0.8]) {
      const launch = rayExitFromEarth(angle, world)
      expect(isOnFieldBoundary(launch, world)).toBe(true)
    }
  })
})

describe('launch geometry (ТЗ §3.1, §5.2)', () => {
  it('puts the launch point exactly on the working area’s outer edge', () => {
    for (const unit of [0, 0.2, 0.5, 0.8, 1]) {
      const impactAngle = impactAngleFromUnit(unit)
      const target = pointOnEarthSurface(impactAngle, world)
      for (const draw of [0, 0.33, 0.66, 1]) {
        const start = rayToFieldBoundary(target, approachAngleFromUnit(impactAngle, draw), world)
        expect(isOnFieldBoundary(start, world)).toBe(true)
      }
    }
  })

  it('never lets the approach cross Earth before it reaches its target', () => {
    for (const unit of [0, 0.25, 0.5, 0.75, 1]) {
      const impactAngle = impactAngleFromUnit(unit)
      const target = pointOnEarthSurface(impactAngle, world)
      for (const draw of [0, 0.25, 0.5, 0.75, 1]) {
        const start = rayToFieldBoundary(target, approachAngleFromUnit(impactAngle, draw), world)
        expect(isApproachClearOfEarth(start, target, world)).toBe(true)
      }
    }
  })

  it('keeps the approach bearing in the sky, so a launch never comes from under the horizon', () => {
    for (const unit of [0, 0.5, 1]) {
      const impactAngle = impactAngleFromUnit(unit)
      for (const draw of [0, 0.5, 1]) {
        const bearing = approachAngleFromUnit(impactAngle, draw)
        expect(Math.sin(bearing)).toBeLessThan(0)
      }
    }
  })

  it('produces trajectories of genuinely different lengths — the reason speed is derived (§5.5)', () => {
    const lengths = [0, 0.25, 0.5, 0.75, 1].flatMap((unit) => {
      const impactAngle = impactAngleFromUnit(unit)
      const target = pointOnEarthSurface(impactAngle, world)
      return [0, 0.5, 1].map((draw) =>
        distance(rayToFieldBoundary(target, approachAngleFromUnit(impactAngle, draw), world), target),
      )
    })
    expect(Math.max(...lengths)).toBeGreaterThan(Math.min(...lengths) * 1.5)
  })
})

describe('first entry into the interception radius (ТЗ §11.3)', () => {
  it('reports when the threat crossed the circle, not how near the line came', () => {
    // A path straight along +x passing 0 from a circle of radius 2 centred
    // at (5, 0) enters at x = 3, i.e. 30% of a 10-long flight.
    const entry = firstEntryIntoCircle({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 }, 2)
    expect(entry.entered).toBe(true)
    expect(entry.t).toBeCloseTo(0.3)
    expect(entry.point.x).toBeCloseTo(3)
  })

  it('takes the near side of the circle, so the time is an entry and not an exit', () => {
    const entry = firstEntryIntoCircle({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 }, 2)
    expect(entry.point.x).toBeLessThan(5)
  })

  it('refuses an entry that would only happen after impact', () => {
    // The circle sits past the end of the segment: the infinite line meets
    // it, the flight never does.
    expect(firstEntryIntoCircle({ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 9, y: 0 }, 2).entered).toBe(false)
  })

  it('misses cleanly when the path never reaches the radius', () => {
    expect(firstEntryIntoCircle({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 9 }, 2).entered).toBe(false)
  })

  it('treats a threat already inside the radius as having entered at once', () => {
    const entry = firstEntryIntoCircle({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0.5, y: 0 }, 2)
    expect(entry.entered).toBe(true)
    expect(entry.t).toBe(0)
  })
})

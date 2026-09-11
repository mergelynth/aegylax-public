import { describe, expect, it } from 'vitest'
import {
  buildSceneOutsideEarthPath,
  buildSpaceGrid,
  cellRect,
  defensePointToScene,
  earthDiscInScene,
  isCellCovered,
  placeGrid,
  projectToScene,
  projectWorldPoint,
  rayExitFromDisc,
  firstDiscHit,
  sceneToDefensePoint,
  EARTH_HERO_MAX_PX,
  EARTH_HERO_MIN_PX,
  EARTH_HERO_WIDTH_RATIO,
} from '../../game/spaceGrid'
import { appConfig } from '../../config/env'
import { buildWorld, sectorCenterKm, sectorFromWorldPoint } from '../../game/world'
import { TEST_MAP_GRID, TEST_PROTOCOL_LIMITS } from '../fixtures'

/** The shipped grid — 10 columns x 5 rows = the 50 sectors of ТЗ §2.3. */
const grid = TEST_MAP_GRID
const world = buildWorld(grid, TEST_PROTOCOL_LIMITS.sectorSpanKm)
const DESKTOP = { width: 1440, height: 832 }
const PHONE = { width: 390, height: 700 }
/** Far enough away that no cell is covered — isolates layout from Earth. */
const NO_EARTH = { cx: -1e6, cy: -1e6, r: 1 }

describe('the shipped map grid', () => {
  it('is 10 x 5, so the operation has exactly 50 sectors (ТЗ §2.3, §16.3)', () => {
    expect(appConfig.map).toMatchObject({ columns: 10, rows: 5 })
  })

  it('ships with the axis labels off (ТЗ §2 — the grid is orientation, not chrome)', () => {
    expect(appConfig.map.showGridLabels).toBe(false)
  })
})

describe('earthDiscInScene', () => {
  it("matches the hero stylesheet's responsive width, so both draw one planet", () => {
    expect(earthDiscInScene({ width: 1000, height: 600 }).r).toBe((1000 * EARTH_HERO_WIDTH_RATIO) / 2)
    expect(earthDiscInScene({ width: 400, height: 600 }).r).toBe(EARTH_HERO_MIN_PX / 2)
    expect(earthDiscInScene({ width: 3000, height: 600 }).r).toBe(EARTH_HERO_MAX_PX / 2)
  })

  it('centres the disc horizontally and drops its centre below the scene, leaving only a cap on screen', () => {
    const earth = earthDiscInScene(DESKTOP)
    expect(earth.cx).toBe(DESKTOP.width / 2)
    expect(earth.cy).toBeGreaterThan(DESKTOP.height)
    // Top of the cap = 40% of Earth's height above the scene's bottom edge,
    // which is what `translate(-50%, 60%)` leaves visible.
    expect(earth.cy - earth.r).toBeCloseTo(DESKTOP.height - 2 * earth.r * 0.4, 9)
  })

  it('describes the same planet the canonical world does, to within a pixel or two', () => {
    // The drawn disc is authoritative on screen and the canonical one is
    // authoritative for the maths (see `EARTH_RADIUS_SECTORS`); this only
    // guards the two from drifting far enough apart to look wrong.
    const placement = placeGrid(grid, DESKTOP)
    const earth = earthDiscInScene(DESKTOP)
    const canonicalRadius = (world.earth.radiusKm / world.sectorSpanKm) * placement.cellSize
    const canonicalCy = placement.originY + (world.earth.center.y / world.sectorSpanKm) * placement.cellSize
    expect(Math.abs(earth.r - canonicalRadius)).toBeLessThan(1)
    expect(Math.abs(earth.cy - canonicalCy)).toBeLessThan(2)
  })
})

describe('rayExitFromDisc', () => {
  it('puts a straight-up launch on the top edge of the box', () => {
    const earth = { cx: 100, cy: 200, r: 40 }
    const exit = rayExitFromDisc(-Math.PI / 2, earth, { minX: 0, minY: 0, maxX: 200, maxY: 180 })
    expect(exit.x).toBeCloseTo(100, 6)
    expect(exit.y).toBeCloseTo(0, 6)
  })
})

describe('firstDiscHit', () => {
  const earth = { cx: 100, cy: 200, r: 40 }

  it('stops a downward strike on the near rim, not through the planet', () => {
    const hit = firstDiscHit({ x: 100, y: 0 }, { x: 100, y: 400 }, earth)
    expect(hit).not.toBeNull()
    expect(hit!.x).toBeCloseTo(100, 6)
    expect(hit!.y).toBeCloseTo(160, 6)
    expect(Math.hypot(hit!.x - earth.cx, hit!.y - earth.cy)).toBeCloseTo(earth.r, 6)
  })

  it('returns null when the ray misses the disc', () => {
    expect(firstDiscHit({ x: 0, y: 0 }, { x: 10, y: 0 }, earth)).toBeNull()
  })
})

describe('placeGrid (ТЗ §2.4-2.5, §16.1-16.2)', () => {
  it('keeps cells square on a landscape scene, drawn as configured', () => {
    const placement = placeGrid(grid, DESKTOP)
    expect(placement.transposed).toBe(false)
    expect(placement.cellSize).toBe(144)
    expect(placement.width).toBe(1440)
    expect(placement.height).toBe(720)
  })

  it('keeps cells square on a portrait scene by transposing rather than stretching', () => {
    const placement = placeGrid(grid, PHONE)
    expect(placement.transposed).toBe(true)
    expect(placement.cellSize).toBe(70)
    // 5 across, 10 down — the same 50 sectors, turned to fit.
    expect(placement.width).toBe(350)
    expect(placement.height).toBe(700)
  })

  it('never produces a non-square cell, at any aspect ratio (ТЗ §2.8, §16.6)', () => {
    for (const scene of [DESKTOP, PHONE, { width: 800, height: 800 }, { width: 320, height: 1200 }]) {
      const placement = placeGrid(grid, scene)
      const rect = cellRect({ column: 3, row: 2 }, placement)
      expect(rect.width).toBe(rect.height)
    }
  })

  it('fits inside the scene and centres whatever margin is left', () => {
    for (const scene of [DESKTOP, PHONE, { width: 1000, height: 1000 }]) {
      const placement = placeGrid(grid, scene)
      expect(placement.width).toBeLessThanOrEqual(scene.width + 1e-9)
      expect(placement.height).toBeLessThanOrEqual(scene.height + 1e-9)
      expect(placement.originX).toBeCloseTo((scene.width - placement.width) / 2, 9)
      expect(placement.originY).toBeCloseTo((scene.height - placement.height) / 2, 9)
    }
  })

  it('uses most of the scene in both orientations — transposing is what makes that possible', () => {
    for (const scene of [DESKTOP, PHONE]) {
      const placement = placeGrid(grid, scene)
      const coverage = (placement.width * placement.height) / (scene.width * scene.height)
      expect(coverage).toBeGreaterThan(0.85)
    }
  })
})

describe('cellRect', () => {
  it('lays the columns across and the rows down on a landscape scene', () => {
    const placement = placeGrid(grid, DESKTOP)
    expect(cellRect({ column: 0, row: 0 }, placement)).toMatchObject({ x: 0, y: 56 })
    expect(cellRect({ column: 9, row: 4 }, placement)).toMatchObject({ x: 1296, y: 632 })
  })

  it('turns the columns down the screen on a portrait scene', () => {
    const placement = placeGrid(grid, PHONE)
    expect(cellRect({ column: 0, row: 0 }, placement)).toMatchObject({ x: 20, y: 0 })
    // Column J is now the bottom band, row 5 the rightmost.
    expect(cellRect({ column: 9, row: 4 }, placement)).toMatchObject({ x: 300, y: 630 })
  })

  it('never overlaps two sectors, in either orientation', () => {
    for (const scene of [DESKTOP, PHONE]) {
      const placement = placeGrid(grid, scene)
      const seen = new Set<string>()
      for (let row = 0; row < grid.rows; row++) {
        for (let column = 0; column < grid.columns; column++) {
          const { x, y } = cellRect({ column, row }, placement)
          expect(seen.has(`${x}:${y}`)).toBe(false)
          seen.add(`${x}:${y}`)
        }
      }
      expect(seen.size).toBe(50)
    }
  })
})

describe('projectWorldPoint', () => {
  it('lands a world point in the very cell that world point belongs to', () => {
    for (const scene of [DESKTOP, PHONE]) {
      const placement = placeGrid(grid, scene)
      for (const point of [
        { x: 10, y: 10 },
        { x: world.widthKm / 2, y: world.heightKm / 2 },
        { x: world.widthKm * 0.83, y: world.heightKm * 0.2 },
        { x: world.widthKm - 10, y: world.heightKm - 10 },
      ]) {
        const rect = cellRect(sectorFromWorldPoint(point, world), placement)
        const projected = projectWorldPoint(point, world, placement)
        expect(projected.x).toBeGreaterThanOrEqual(rect.x - 1e-9)
        expect(projected.x).toBeLessThanOrEqual(rect.x + rect.width + 1e-9)
        expect(projected.y).toBeGreaterThanOrEqual(rect.y - 1e-9)
        expect(projected.y).toBeLessThanOrEqual(rect.y + rect.height + 1e-9)
      }
    }
  })

  it('projects the world’s Earth onto the painted globe, on a landscape scene', () => {
    const placement = placeGrid(grid, DESKTOP)
    const earth = earthDiscInScene(DESKTOP)
    const projected = projectWorldPoint(world.earth.center, world, placement)
    expect(projected.x).toBeCloseTo(earth.cx, 6)
    expect(Math.abs(projected.y - earth.cy)).toBeLessThan(2)
  })

  it('extrapolates a launch point outside the field rather than clamping it', () => {
    const placement = placeGrid(grid, DESKTOP)
    expect(projectToScene(-0.5, 0.5, placement).x).toBeLessThan(placement.originX)
  })
})

describe('Defense Point placement (ТЗ §7.3-7.6)', () => {
  it('round-trips a click inside a sector back to the same point', () => {
    for (const scene of [DESKTOP, PHONE]) {
      const placement = placeGrid(grid, scene)
      const point = { sector: { column: 6, row: 1 }, offsetX: 0.2, offsetY: 0.7 }
      const scenePoint = defensePointToScene(point, placement)
      const back = sceneToDefensePoint(scenePoint, point.sector, placement)
      expect(back.offsetX).toBeCloseTo(point.offsetX, 9)
      expect(back.offsetY).toBeCloseTo(point.offsetY, 9)
    }
  })

  it('always lands inside the chosen sector’s own cell (ТЗ §7.5)', () => {
    const placement = placeGrid(grid, PHONE)
    const sector = { column: 3, row: 2 }
    const rect = cellRect(sector, placement)
    for (const offsets of [
      { offsetX: 0, offsetY: 0 },
      { offsetX: 1, offsetY: 1 },
      { offsetX: 0.5, offsetY: 0.5 },
    ]) {
      const point = defensePointToScene({ sector, ...offsets }, placement)
      expect(point.x).toBeGreaterThanOrEqual(rect.x - 1e-9)
      expect(point.x).toBeLessThanOrEqual(rect.x + rect.width + 1e-9)
      expect(point.y).toBeGreaterThanOrEqual(rect.y - 1e-9)
      expect(point.y).toBeLessThanOrEqual(rect.y + rect.height + 1e-9)
    }
  })

  it('clamps a click that strayed past the cell edge back into the sector', () => {
    const placement = placeGrid(grid, DESKTOP)
    const sector = { column: 1, row: 1 }
    const rect = cellRect(sector, placement)
    const clamped = sceneToDefensePoint({ x: rect.x - 400, y: rect.y + 9999 }, sector, placement)
    expect(clamped.offsetX).toBeGreaterThanOrEqual(0)
    expect(clamped.offsetX).toBeLessThanOrEqual(1)
    expect(clamped.offsetY).toBeGreaterThanOrEqual(0)
    expect(clamped.offsetY).toBeLessThanOrEqual(1)
  })

  it('agrees with the canonical world: the sector centre is the same place on screen either way', () => {
    for (const scene of [DESKTOP, PHONE]) {
      const placement = placeGrid(grid, scene)
      const sector = { column: 8, row: 3 }
      const viaOffsets = defensePointToScene({ sector, offsetX: 0.5, offsetY: 0.5 }, placement)
      const viaWorld = projectWorldPoint(sectorCenterKm(sector, world), world, placement)
      expect(viaOffsets.x).toBeCloseTo(viaWorld.x, 6)
      expect(viaOffsets.y).toBeCloseTo(viaWorld.y, 6)
    }
  })
})

describe('isCellCovered', () => {
  const earth = { cx: 100, cy: 100, r: 50 }

  it('is true only when the whole cell is inside the disc', () => {
    expect(isCellCovered(90, 90, 20, 20, earth)).toBe(true)
    expect(isCellCovered(0, 0, 20, 20, earth)).toBe(false)
    // Straddling the rim: part of it is still in the open.
    expect(isCellCovered(40, 90, 30, 20, earth)).toBe(false)
  })
})

describe('buildSpaceGrid', () => {
  it('addresses all 50 sectors as A1..J5 in either orientation (ТЗ §2.7, §16.4)', () => {
    for (const scene of [DESKTOP, PHONE]) {
      const ids = buildSpaceGrid(grid, placeGrid(grid, scene), NO_EARTH).map((c) => c.sectorId)
      expect(new Set(ids).size).toBe(50)
      for (const id of ids) expect(id).toMatch(/^[A-J][1-5]$/)
    }
  })

  it('is a pure function of grid + placement + disc, so every client draws the same map', () => {
    const placement = placeGrid(grid, DESKTOP)
    const earth = earthDiscInScene(DESKTOP)
    expect(buildSpaceGrid(grid, placement, earth)).toEqual(buildSpaceGrid(grid, placement, earth))
  })

  it('drops only the cells Earth has swallowed whole — nothing else is lost (ТЗ §2.10)', () => {
    const placement = placeGrid(grid, DESKTOP)
    const earth = earthDiscInScene(DESKTOP)
    const cells = buildSpaceGrid(grid, placement, earth)

    for (let row = 0; row < grid.rows; row++) {
      for (let column = 0; column < grid.columns; column++) {
        const rect = cellRect({ column, row }, placement)
        const covered = isCellCovered(rect.x, rect.y, rect.width, rect.height, earth)
        const present = cells.some((cell) => cell.sector.column === column && cell.sector.row === row)
        expect(present).toBe(!covered)
      }
    }
  })

  it('leaves most of the grid playable around the planet', () => {
    for (const scene of [DESKTOP, PHONE]) {
      const placement = placeGrid(grid, scene)
      const cells = buildSpaceGrid(grid, placement, earthDiscInScene(scene))
      expect(cells.length).toBeGreaterThanOrEqual(40)
      expect(cells.length).toBeLessThan(50)
    }
  })

  it('keeps every label anchor out of Earth, so a trimmed cell still labels its visible part', () => {
    for (const scene of [DESKTOP, PHONE]) {
      const placement = placeGrid(grid, scene)
      const earth = earthDiscInScene(scene)
      for (const cell of buildSpaceGrid(grid, placement, earth)) {
        expect(Math.hypot(cell.labelX - earth.cx, cell.labelY - earth.cy)).toBeGreaterThan(earth.r)
      }
    }
  })

  it('puts the anchor at the centre of a cell Earth does not reach', () => {
    const open = buildSpaceGrid(grid, placeGrid(grid, DESKTOP), NO_EARTH).find((c) => c.sectorId === 'A1')!
    expect(open.labelX).toBe(open.x + open.width / 2)
    expect(open.labelY).toBe(open.y + open.height / 2)
  })
})

describe('buildSceneOutsideEarthPath', () => {
  it('is the scene rectangle with the planet punched out as a hole', () => {
    const path = buildSceneOutsideEarthPath({ width: 200, height: 100 }, { cx: 100, cy: 100, r: 40 })
    // Two subpaths: the outer rectangle, then the circle that even-odd
    // turns into a hole. Both closed.
    expect(path.match(/M/g)).toHaveLength(2)
    expect(path.startsWith('M0 0H200V100H0Z')).toBe(true)
    expect(path).toContain('a40 40 0 1 0 80 0')
    expect(path.endsWith('Z')).toBe(true)
  })
})

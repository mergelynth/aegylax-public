import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SectorGrid, type SectorGridProps } from '../../components/map/SectorGrid'
import { buildReconEstimate, type ReconFix } from '../../game/recon'
import { cellRect, earthDiscInScene, isCellCovered, placeGrid } from '../../game/spaceGrid'
import type { Sector } from '../../game/types'
import { buildWorld } from '../../game/world'
import { TEST_MAP_GRID as grid } from '../fixtures'

const LANDSCAPE = { width: 1200, height: 700 }
const PORTRAIT = { width: 390, height: 700 }
const world = buildWorld(grid, 1000)

function geometry(scene: { width: number; height: number }) {
  return { scene, placement: placeGrid(grid, scene), earth: earthDiscInScene(scene) }
}

/**
 * The grid takes its geometry as props rather than measuring anything, so
 * these tests hand it the same placement a browser would compute — no
 * layout stubs, and the assertions are about behaviour rather than about
 * jsdom.
 */
function renderGrid(overrides: Partial<SectorGridProps> = {}) {
  const scene = overrides.scene ?? LANDSCAPE
  const props: SectorGridProps = {
    ...geometry(scene),
    grid,
    estimate: null,
    world,
    waveKey: null,
    selectedSector: null,
    stagedPoint: null,
    submittedPoint: null,
    interceptionRadiusPx: 24,
    onSelectSector: vi.fn(),
    onPlacePoint: vi.fn(),
    interactive: true,
    ...overrides,
  }
  const view = render(<SectorGrid {...props} />)
  return { ...view, props }
}

function fix(overrides: Partial<ReconFix> = {}): ReconFix {
  return {
    bearingDegrees: 200,
    direction: 'W',
    uncertaintyDegrees: 40,
    confidencePercent: 45,
    probeCount: 1,
    ...overrides,
  }
}

/** The reconnaissance picture a fix of this quality would produce (ТЗ §3). */
function estimateFrom(overrides: Partial<ReconFix> = {}) {
  return buildReconEstimate(fix(overrides), world)
}

describe('<SectorGrid /> layout (ТЗ §2)', () => {
  it('covers the field with sectors labelled A1..J5, minus the ones Earth covers', () => {
    renderGrid()
    const { placement, earth } = geometry(LANDSCAPE)
    let covered = 0
    for (let row = 0; row < grid.rows; row++) {
      for (let column = 0; column < grid.columns; column++) {
        const rect = cellRect({ column, row }, placement)
        if (isCellCovered(rect.x, rect.y, rect.width, rect.height, earth)) covered++
      }
    }

    const cells = screen.getAllByRole('button')
    expect(cells).toHaveLength(grid.columns * grid.rows - covered)
    for (const cell of cells) {
      expect(cell.getAttribute('aria-label')).toMatch(/^Sector [A-J][1-5]$/)
    }
  })

  it('is always on — there is no toggle and nothing to reveal (ТЗ §2.2)', () => {
    renderGrid()
    expect(screen.getByRole('group', { name: 'Operation sector grid' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /grid/i })).not.toBeInTheDocument()
  })

  it('cuts Earth out so no sector paints or is clickable on the planet (ТЗ §2.10-2.11)', () => {
    const { container } = renderGrid()
    const { earth } = geometry(LANDSCAPE)
    const clip = container.querySelector('#sector-grid-clip path')
    expect(clip).not.toBeNull()
    expect(clip).toHaveAttribute('clip-rule', 'evenodd')
    expect(clip!.getAttribute('d')).toContain(`M0 0H${LANDSCAPE.width}V${LANDSCAPE.height}H0Z`)
    expect(clip!.getAttribute('d')).toContain(`a${earth.r} ${earth.r} 0 1 0 ${earth.r * 2} 0`)
  })

  it('lets the reconnaissance cloud fill the sky rather than the grid block', () => {
    const { container } = renderGrid({ estimate: estimateFrom({ probeCount: 1 }) })
    const { placement } = geometry(LANDSCAPE)
    // `placeGrid` fits the cells by their shorter axis, so the block stops
    // short of the scene. Clipping the fog to it cut the cone off against
    // that invisible edge and left a blue rectangle with a curved bottom.
    expect(placement.originY).toBeGreaterThan(0)
    expect(container.querySelector('#recon-fog-clip')).toBeNull()
    const clip = container.querySelector('#sector-grid-clip path')
    expect(clip!.getAttribute('d')).toContain(`M0 0H${LANDSCAPE.width}`)
  })

  it('pins the SVG coordinate system to the measured scene so a resize cannot stretch the fog', () => {
    const { container } = renderGrid()
    const svg = container.querySelector('svg')
    expect(svg).toHaveAttribute('viewBox', `0 0 ${LANDSCAPE.width} ${LANDSCAPE.height}`)
  })

  it('turns the grid on a portrait scene instead of stretching its cells (ТЗ §16.2, §16.6)', () => {
    const { container } = renderGrid({ ...geometry(PORTRAIT) })

    // Square cells: 5 across, 10 down, 70px a side.
    const cell = container.querySelector('rect')!
    expect(cell.getAttribute('width')).toBe(cell.getAttribute('height'))
    expect(cell.getAttribute('width')).toBe('70')

    // 4 vertical seams and 9 horizontal ones — the transposed arrangement.
    const lines = [...container.querySelectorAll('line')]
    const vertical = lines.filter((l) => l.getAttribute('x1') === l.getAttribute('x2'))
    expect(vertical).toHaveLength(4)

    // Same 50 sectors, same labels — only their arrangement moved (ТЗ §2.6-2.7).
    expect(screen.getByLabelText('Sector J5')).toBeInTheDocument()
  })

  /**
   * The axis labels are ENV-gated and off by default
   * (`VITE_MAP_SHOW_GRID_LABELS`): a sector is picked by clicking it and
   * the cell under the pointer already names itself, so the permanent ring
   * of letters and numbers around the board is opt-in.
   */
  it('draws no axis labels unless the build asks for them', () => {
    const { container } = renderGrid()
    expect(container.querySelectorAll('[class*="axisLabel"]')).toHaveLength(0)
    // The grid itself is untouched — only its labelling is gone.
    expect(screen.getByLabelText('Sector J5')).toBeInTheDocument()
  })

  it('labels the columns A-J and the rows 1-5 when it is', () => {
    const { container } = renderGrid({ showGridLabels: true })
    const axis = [...container.querySelectorAll('[class*="axisLabel"]')].map((el) => el.textContent)
    expect(axis).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', '1', '2', '3', '4', '5'])
  })
})

describe('<SectorGrid /> Defense Point pick (ТЗ §7)', () => {
  const c2: Sector = { column: 2, row: 1 }

  it('places the point on the first click — there is no selected-sector frame', () => {
    const { props } = renderGrid()
    fireEvent.click(screen.getByLabelText('Sector C2'), { clientX: 0, clientY: 0 })
    expect(props.onPlacePoint).toHaveBeenCalledOnce()
    expect(props.onPlacePoint).toHaveBeenCalledWith(expect.objectContaining({ sector: c2 }))
  })

  it('does not paint a selection outline on the sector that was hit', () => {
    const { container } = renderGrid({ selectedSector: c2 })
    expect(container.querySelector('[aria-label="Sector C2"]')!.getAttribute('class')).not.toMatch(/selected/)
  })

  it('places the point in the sector that was clicked, whatever the click coordinates (§7.5)', () => {
    const { props } = renderGrid()
    fireEvent.click(screen.getByLabelText('Sector C2'), { clientX: 99999, clientY: -99999 })
    const point = vi.mocked(props.onPlacePoint).mock.calls[0][0]
    expect(point.sector).toEqual(c2)
    expect(point.offsetX).toBeGreaterThanOrEqual(0)
    expect(point.offsetX).toBeLessThanOrEqual(1)
    expect(point.offsetY).toBeGreaterThanOrEqual(0)
    expect(point.offsetY).toBeLessThanOrEqual(1)
  })

  it('moves the point when a different sector is clicked', () => {
    const { props } = renderGrid({ selectedSector: c2, stagedPoint: { sector: c2, offsetX: 0.5, offsetY: 0.5 } })
    fireEvent.click(screen.getByLabelText('Sector G4'))
    expect(props.onPlacePoint).toHaveBeenCalledWith(expect.objectContaining({ sector: { column: 6, row: 3 } }))
  })

  it('refuses every pick once Defense has been submitted (§7.13-7.14)', () => {
    const submitted = { sector: c2, offsetX: 0.5, offsetY: 0.5 }
    const { props } = renderGrid({ selectedSector: c2, submittedPoint: submitted })
    fireEvent.click(screen.getByLabelText('Sector C2'))
    fireEvent.click(screen.getByLabelText('Sector A1'))
    expect(props.onPlacePoint).not.toHaveBeenCalled()
    expect(props.onSelectSector).not.toHaveBeenCalled()
  })

  it('takes no clicks at all outside a running operation (ТЗ: grid is orientation, not a control)', () => {
    const { props } = renderGrid({ selectedSector: c2, interactive: false })
    fireEvent.click(screen.getByLabelText('Sector C2'))
    fireEvent.click(screen.getByLabelText('Sector A1'))
    expect(props.onPlacePoint).not.toHaveBeenCalled()
    expect(props.onSelectSector).not.toHaveBeenCalled()
  })

  it('is still fully drawn when inert — every sector is there, none is a button', () => {
    const { container } = renderGrid({ interactive: false })
    expect(container.querySelectorAll('[aria-label^="Sector "]').length).toBeGreaterThan(40)
    expect(screen.queryAllByRole('button', { name: /^Sector / })).toHaveLength(0)
  })

  it('drops the sector highlight once there is nothing left to pick (ТЗ §2)', () => {
    const selected = { column: 2, row: 1 }
    const point = { sector: selected, offsetX: 0.5, offsetY: 0.5 }
    const live = renderGrid({ selectedSector: selected })
    const highlightClass = live.container.querySelector('[aria-label="Sector C2"]')!.getAttribute('class')!
    expect(highlightClass).not.toMatch(/selected/)
    live.unmount()

    // ТЗ §2 — once the Defense is locked the grid stops being a picker, so
    // the outline goes with it. What stays on the board is the record of
    // the choice: the point and the radius the protocol will judge it by.
    const locked = renderGrid({ selectedSector: selected, submittedPoint: point, interactive: false })
    expect(locked.container.querySelector('[aria-label="Sector C2"]')!.getAttribute('class')).not.toMatch(/selected/)
    expect(
      [...locked.container.querySelectorAll('span')].some((el) => el.className.includes('defensePoint')),
    ).toBe(true)
    locked.unmount()

    // And the same after the round ends, for the same reason.
    const ended = renderGrid({ selectedSector: selected, interactive: false })
    expect(ended.container.querySelector('[aria-label="Sector C2"]')!.getAttribute('class')).not.toMatch(/selected/)
  })

  it('only ever selects a sector from the keyboard, since a key press carries no position', () => {
    const { props } = renderGrid({ selectedSector: { column: 0, row: 0 } })
    fireEvent.keyDown(screen.getByLabelText('Sector A1'), { key: 'Enter' })
    expect(props.onSelectSector).toHaveBeenCalledWith({ column: 0, row: 0 })
    expect(props.onPlacePoint).not.toHaveBeenCalled()
  })
})

describe('<SectorGrid /> the reconnaissance picture (ТЗ §3)', () => {
  const cloud = (container: HTMLElement) => container.querySelector('polygon[class*="cloud"]')
  const blotch = (container: HTMLElement) => container.querySelector('g[class*="threatBlotch"]')
  const blotches = (container: HTMLElement) => [...container.querySelectorAll('g[class*="threatBlotch"]')]

  /** How dark a mark is painted — the seven grades run light to dark. */
  function shadeOf(mark: Element): number {
    const fill = mark.querySelector('ellipse')!.getAttribute('fill')!
    const [r, g, b] = fill.match(/\d+/g)!.map(Number)
    return r + g + b
  }

  /**
   * How wide the painted region is, in scene pixels — the far-arc chord of
   * a pizza, or the wider end of a corridor quad.
   */
  function paintedWidth(polygon: Element): number {
    const points = polygon
      .getAttribute('points')!
      .split(' ')
      .map((pair) => pair.split(',').map(Number)) as Array<[number, number]>
    let max = 0
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        max = Math.max(max, Math.hypot(points[j][0] - points[i][0], points[j][1] - points[i][1]))
      }
    }
    return max
  }

  /*
   * The corridor is a probability, so it must not have a border. One filled
   * trapezoid has an edge wherever it stops — and a drawn edge says the
   * threat cannot be a pixel outside it, which is the one claim
   * reconnaissance is never allowed to make (ТЗ §3.3).
   */
  it('paints the corridor as fog rather than a shape with a boundary', () => {
    const { container } = renderGrid({ estimate: estimateFrom({ probeCount: 2 }) })
    const bands = [...container.querySelectorAll('polygon[class*="cloud"]')]
    expect(bands.length).toBeGreaterThan(2)

    for (const band of bands) {
      expect(band).toHaveAttribute('filter', 'url(#recon-cloud-soft)')
      expect(band.getAttribute('stroke')).toBeNull()
      // Nothing is laid on heavily enough to read as a filled area.
      expect(Number(band.getAttribute('opacity'))).toBeLessThan(0.25)
    }

    // Narrowing inward, so the weight is on the centreline and the
    // outermost band is the one that dissolves. Area rather than the
    // longest chord: every band runs the same corridor, so only how much
    // sky it covers tells them apart.
    const areas = bands.map(paintedArea)
    expect(areas).toEqual([...areas].sort((a, b) => b - a))
    expect(areas[areas.length - 1]).toBeLessThan(areas[0] * 0.6)
  })

  /** How much sky a painted band actually covers, in square scene pixels. */
  function paintedArea(polygon: Element): number {
    const points = polygon
      .getAttribute('points')!
      .split(' ')
      .map((pair) => pair.split(',').map(Number)) as Array<[number, number]>
    let twice = 0
    for (let i = 0; i < points.length; i++) {
      const [x1, y1] = points[i]
      const [x2, y2] = points[(i + 1) % points.length]
      twice += x1 * y2 - x2 * y1
    }
    return Math.abs(twice) / 2
  }

  /*
   * The corridor holds each mark's centre; the glow around it is the error
   * bar, and cutting that to the cloud drew a straight rim on the one layer
   * whose whole point is that it has no edge.
   */
  it('lets a mark’s glow spill past the corridor rather than cutting it', () => {
    const { container } = renderGrid({ estimate: estimateFrom({ probeCount: 3, uncertaintyDegrees: 32 }) })
    const mark = blotch(container)!
    expect(mark.closest('[clip-path*="recon-cloud-clip"]')).toBeNull()
  })

  it('offers nothing on the map to aim a probe at (ТЗ §1.1)', () => {
    // A probe scans the whole area, so the grid has no recon gesture at
    // all — no target marker, no confirmation, no second mode.
    renderGrid()
    expect(screen.queryByRole('button', { name: /confirm recon probe/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /recon/i })).not.toBeInTheDocument()
  })

  it('paints nothing until a probe has reported', () => {
    const { container } = renderGrid({ estimate: null })
    expect(cloud(container)).toBeNull()
    expect(blotch(container)).toBeNull()
  })

  it('gives one probe a cloud, and no heatmap (ТЗ §3)', () => {
    const { container } = renderGrid({ estimate: estimateFrom({ probeCount: 1 }), reconProgress: 0.4 })

    expect(cloud(container)).not.toBeNull()
    expect(container.querySelector('polygon[class*="cloudCore"]')).toBeNull()
    expect(blotch(container)).toBeNull()
    expect(container.querySelector('#recon-cloud-fade')?.tagName.toLowerCase()).toBe('lineargradient')
    expect(cloud(container)!.getAttribute('points')!.split(' ').length).toBeGreaterThan(4)
  })

  it('adds a red occupancy blotch from the second probe (ТЗ §3)', () => {
    const { container } = renderGrid({
      estimate: estimateFrom({ probeCount: 2, uncertaintyDegrees: 32 }),
    })

    expect(cloud(container)).not.toBeNull()
    const mark = blotch(container)
    expect(mark).not.toBeNull()
    // Wider across the corridor than along it, so consecutive marks meet
    // and the overlap between agreeing readings is legible.
    const outer = mark!.querySelector('ellipse')!
    expect(Number(outer.getAttribute('ry'))).toBeGreaterThan(Number(outer.getAttribute('rx')))
    // Bands rather than one flat ellipse: the overlap has to show *how
    // much* two readings agree, not merely that they do.
    expect(mark!.querySelectorAll('ellipse').length).toBeGreaterThan(1)
  })

  it('keeps the cloud and stacks darker blotches as probes accumulate', () => {
    const weak = renderGrid({
      estimate: estimateFrom({ probeCount: 2, uncertaintyDegrees: 40 }),
    })
    const weakCloudSpan = paintedWidth(cloud(weak.container)!)
    const weakShade = shadeOf(blotch(weak.container)!)
    const weakCount = blotches(weak.container).length
    weak.unmount()

    const strong = renderGrid({
      estimate: estimateFrom({ probeCount: 5, uncertaintyDegrees: 40 }),
    })

    // The cloud is the first reading and does not move; only marks accrue.
    expect(paintedWidth(cloud(strong.container)!)).toBeCloseTo(weakCloudSpan, 0)
    const marks = blotches(strong.container)
    expect(marks.length).toBeGreaterThan(weakCount)
    expect(shadeOf(marks[marks.length - 1])).toBeLessThan(weakShade)
  })

  /*
   * The estimate is canonical kilometres and the globe is placed by a
   * stylesheet, and the two only agree on a roomy landscape scene: below
   * `EARTH_HERO_MIN_PX` the painted planet stops shrinking while the grid
   * keeps going. Drawing the corridor through the grid put it beside the
   * planet it was pointing at, and beside the reveal's own trajectory,
   * which is projected onto the painted disc.
   */
  it('meets the painted globe, not the grid’s idea of it, on a scene where the two differ', () => {
    const cramped = { width: 560, height: 420 }
    const { earth } = geometry(cramped)
    const { placement } = geometry(cramped)
    // The floor has kicked in: the drawn planet is wider than the grid's.
    expect(earth.r).toBeGreaterThan(2.3 * placement.cellSize * 1.1)

    const { container } = renderGrid({ ...geometry(cramped), estimate: estimateFrom({ probeCount: 2 }) })
    const points = cloud(container)!
      .getAttribute('points')!
      .split(' ')
      .map((pair) => pair.split(',').map(Number)) as Array<[number, number]>
    const onRim = points.filter(
      ([x, y]) => Math.abs(Math.hypot(x - earth.cx, y - earth.cy) - earth.r) < earth.r * 0.02,
    )
    expect(onRim.length).toBeGreaterThan(8)
  })

  it('takes no clicks — the sectors underneath stay pickable through it', () => {
    const { container, props } = renderGrid({ estimate: estimateFrom({ probeCount: 3 }) })
    expect(container.querySelector('g[class*="recon"]')).toHaveAttribute('aria-hidden', 'true')

    fireEvent.click(screen.getByLabelText('Sector A1'))
    expect(props.onPlacePoint).toHaveBeenCalled()
  })

  it('sweeps a wave out of Earth on the first probe, and only then (ТЗ §1.4)', () => {
    const quiet = renderGrid({ waveKey: null })
    expect(quiet.container.querySelectorAll('circle[class*="waveRing"]')).toHaveLength(0)
    quiet.unmount()

    const { container } = renderGrid({ waveKey: 1 })
    const { earth } = geometry(LANDSCAPE)
    const rings = [...container.querySelectorAll('circle[class*="waveRing"]')]
    expect(rings).toHaveLength(2)
    // It leaves the planet, not the board's edge or any one sector.
    expect(rings[0].getAttribute('cx')).toBe(String(earth.cx))
    expect(rings[0].getAttribute('r')).toBe(String(earth.r))
  })

  it('never draws a craft — a probe is not a vehicle aimed at a place (ТЗ §1.1)', () => {
    const { container } = renderGrid({ waveKey: 2, estimate: estimateFrom({ probeCount: 2 }) })
    // Flying a dart to a spot invents both an object and an aim the
    // protocol does not have, and the spot it flew to was a guess — which
    // made the animation read as an answer.
    expect(container.querySelector('[class*="probeCraft"]')).toBeNull()
    expect(container.querySelector('[class*="probeBeam"]')).toBeNull()
  })

  it('keeps the first-probe sweep over the whole sky, even after the cloud lands', () => {
    const { container } = renderGrid({ waveKey: 1, estimate: estimateFrom({ probeCount: 1 }) })
    const wave = container.querySelector('g[class*="wave"]')
    expect(wave).not.toHaveAttribute('mask')
    expect(wave).not.toHaveAttribute('clip-path')
    expect(container.querySelectorAll('circle[class*="waveRing"]')).toHaveLength(2)
  })

  it('feathers later sweeps into the corridor rather than cutting them (ТЗ §1.4)', () => {
    const { container } = renderGrid({
      waveKey: 2,
      estimate: estimateFrom({ probeCount: 2 }),
    })
    const { earth } = geometry(LANDSCAPE)
    expect(container.querySelector('#recon-wave-mask')).not.toBeNull()
    expect(container.querySelector('#recon-cloud-clip')).toBeNull()
    const wave = container.querySelector('g[class*="wave"]')
    expect(wave).toHaveAttribute('mask', 'url(#recon-wave-mask)')
    expect(wave).not.toHaveAttribute('clip-path')
    const rings = [...container.querySelectorAll('circle[class*="waveRing"]')] as SVGElement[]
    expect(rings).toHaveLength(2)
    expect(rings[0].style.transformOrigin).toBe(`${earth.cx}px ${earth.cy}px`)
  })

  it('marks occupancy along the inbound while the attack is in flight', () => {
    const { container } = renderGrid({ estimate: estimateFrom({ probeCount: 2, uncertaintyDegrees: 32 }) })
    expect(blotch(container)).not.toBeNull()
  })

  /*
   * A guess and an answer must not share the board. Once the reveal draws
   * the real trajectory and the Defense Points it was judged against, the
   * corridor has nothing left to tell anyone — and left up, even faintly,
   * it invites the eye to read the estimate as a second claim about where
   * the threat went (ТЗ §7, §8).
   */
  it('takes the whole reconnaissance picture off a settled round', () => {
    const { container } = renderGrid({
      estimate: estimateFrom({ probeCount: 2, uncertaintyDegrees: 32 }),
      reconProgress: 0.4,
      waveKey: 3,
      settled: true,
    })
    expect(blotch(container)).toBeNull()
    expect(cloud(container)).toBeNull()
    expect(container.querySelectorAll('circle[class*="waveRing"]')).toHaveLength(0)
  })
})


describe('<SectorGrid /> interception radius (ТЗ §10)', () => {
  it('draws the configured radius around the Defense Point, not just the point', () => {
    const point = { sector: { column: 2, row: 1 }, offsetX: 0.5, offsetY: 0.5 }
    const { container } = renderGrid({ stagedPoint: point, interceptionRadiusPx: 30 })

    // Diameter, so twice the radius — the ring is the area the protocol
    // will actually judge the point by.
    const ring = [...container.querySelectorAll('span')].find(
      (el) => el.style.width === '60px' && el.style.height === '60px',
    )
    expect(ring).toBeTruthy()
  })

  it('draws no radius when there is no point to draw one around', () => {
    const { container } = renderGrid({ stagedPoint: null, submittedPoint: null, interceptionRadiusPx: 30 })
    const ring = [...container.querySelectorAll('span')].find((el) => el.style.width === '60px')
    expect(ring).toBeUndefined()
  })
})

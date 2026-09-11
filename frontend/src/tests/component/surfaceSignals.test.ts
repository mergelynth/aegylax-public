import { describe, expect, it } from 'vitest'
import {
  CAP_MAX_R,
  CAP_MAX_Y,
  CAP_MIN_Y,
  SIGNAL_SPACING,
  bridgeIslands,
  nearestLinks,
  scatterSignals,
} from '../../components/earth/SurfaceSignals'

/** How far a marker's centre sits from the middle of the disc. */
function radius(mark: { x: number; y: number }): number {
  return Math.hypot(mark.x - 50, mark.y - 50)
}

/**
 * The planet's surface markers are scattered fresh on every page load, so
 * there is no table of coordinates left to eyeball. What has to hold are
 * the properties the sampler guarantees — and those are worth pinning,
 * because every one of them is invisible until it fails on somebody's
 * reload rather than on this machine.
 */
describe('surface signal scatter', () => {
  const runs = Array.from({ length: 24 }, () => scatterSignals())

  it('forms a different constellation every time', () => {
    const shapes = new Set(runs.map((run) => run.map((m) => `${m.x.toFixed(2)},${m.y.toFixed(2)}`).join('|')))
    expect(shapes.size).toBe(runs.length)
  })

  /**
   * Only the top 40% of the globe is ever on screen — the rest is pushed
   * below the fold by `.wrapHero`'s transform. A marker outside the cap is
   * a marker nobody will ever see, and the run that places six of them
   * there just looks like a sparse planet.
   */
  it('never places a marker where it cannot be seen', () => {
    for (const run of runs) {
      for (const mark of run) {
        expect(mark.y).toBeGreaterThanOrEqual(CAP_MIN_Y)
        expect(mark.y).toBeLessThanOrEqual(CAP_MAX_Y)
        expect(radius(mark)).toBeLessThanOrEqual(CAP_MAX_R)
      }
    }
  })

  /** The reason it is Poisson-disk and not `Math.random()` twice. */
  it('never lets two markers clump', () => {
    for (const run of runs) {
      for (let i = 0; i < run.length; i++) {
        for (let j = i + 1; j < run.length; j++) {
          const gap = Math.hypot(run[i].x - run[j].x, run[i].y - run[j].y)
          expect(gap).toBeGreaterThanOrEqual(SIGNAL_SPACING)
        }
      }
    }
  })

  /**
   * Coverage, stated as the thing that was actually wrong before: the old
   * fixed table stopped 4 units short of the limb and left the planet
   * looking like it had a patch of instrumentation in the middle. Every run
   * must reach the rim and must fill the cap, not a disc inside it.
   */
  it('fills the cap out to the rim on every run', () => {
    for (const run of runs) {
      expect(run.length).toBeGreaterThanOrEqual(44)
      expect(run.length).toBeLessThanOrEqual(64)
      expect(Math.max(...run.map(radius))).toBeGreaterThan(CAP_MAX_R - 6)
      expect(Math.max(...run.map((m) => m.y))).toBeGreaterThan(CAP_MAX_Y - 6)
      expect(Math.min(...run.map((m) => m.y))).toBeLessThan(CAP_MIN_Y + 8)
    }
  })

  /**
   * Reaching the rim is not the same as covering what is inside it, and the
   * difference is what the layer looked like before: at a spacing of 7 a
   * maximal Poisson set could leave a hole ~9.6 units across, which is
   * wider than the distance between neighbours and reads as sea between
   * islands of instrumentation rather than as one covered planet.
   *
   * So this measures the thing directly — the emptiest point in the visible
   * cap, on a half-unit lattice — rather than trusting that a spacing
   * implies a coverage.
   *
   * 7.6 is not a taste call: `fillGaps` leaves no sample of its own sweep
   * further than `SIGNAL_SPACING` from a marker, so the worst any point
   * between samples can manage is a spacing plus half a lattice diagonal,
   * 6 + 1.06. This is that bound, with a little room, and it is a bound
   * rather than an observation — which is the whole reason the gap pass
   * exists.
   *
   * It was, for a while, a bound the sweep did not actually meet. The
   * lattice was filtered by `insideCap`, so it held nothing *on* the
   * boundary: the samples that would have covered a rim point were the ones
   * just outside it, and those were discarded. The corners where the rim
   * meets a y-limit sat 1.97 from the nearest candidate rather than 1.06,
   * which put the real worst case at 7.97 and failed this assertion about
   * one run in eight — a genuine gap on the planet's edge, arriving as an
   * intermittent test. The threshold was right about what the sweep should
   * guarantee and wrong about what it could; `gapCandidates` now samples the
   * boundary too, and 600 runs put the worst at 6.53.
   */
  it('leaves no empty island anywhere in the cap', () => {
    for (const run of runs) {
      let emptiest = 0
      for (let y = CAP_MIN_Y; y <= CAP_MAX_Y; y += 0.5) {
        for (let x = 0; x <= 100; x += 0.5) {
          if (Math.hypot(x - 50, y - 50) > CAP_MAX_R) continue
          const nearest = Math.min(...run.map((m) => Math.hypot(m.x - x, m.y - y)))
          if (nearest > emptiest) emptiest = nearest
        }
      }
      expect(emptiest).toBeLessThan(7.6)
    }
  })

  /** Sorted top to bottom, because the wake-up stagger reads down the planet. */
  it('hands the markers back in wake order', () => {
    for (const run of runs) {
      const ys = run.map((m) => m.y)
      expect(ys).toEqual([...ys].sort((a, b) => a - b))
    }
  })

  /** A run of static markers in a row leaves a visibly dead patch. */
  it('keeps live and static markers interleaved', () => {
    for (const run of runs) {
      const pulsing = run.filter((m) => m.period > 0).length
      expect(Math.abs(pulsing - run.length / 2)).toBeLessThanOrEqual(1)
      for (const mark of run) {
        if (mark.period > 0) {
          expect(mark.period).toBeGreaterThanOrEqual(6.1)
          expect(mark.period).toBeLessThanOrEqual(11)
          expect(mark.phase).toBeLessThanOrEqual(mark.period)
        }
      }
    }
  })
})

/**
 * ТЗ §22 — the mesh over the markers.
 *
 * One property, and it is the one the nearest-k rule does not actually
 * promise: the web is in one piece. A graph built from purely local rules
 * comes apart into separate clumps every so often — roughly one run in
 * twenty at these settings — and a planet wearing two disconnected halves
 * of a network reads as broken rather than as sparse.
 */
describe('surface signal mesh', () => {
  /** How many pieces the graph is in. */
  function pieces(count: number, links: Array<{ from: number; to: number }>): number {
    const parent = Array.from({ length: count }, (_, i) => i)
    const find = (a: number): number => {
      while (parent[a] !== a) {
        parent[a] = parent[parent[a]]
        a = parent[a]
      }
      return a
    }
    for (const link of links) parent[find(link.from)] = find(link.to)
    return new Set(Array.from({ length: count }, (_, i) => find(i))).size
  }

  it('joins every marker into a single web', () => {
    for (let run = 0; run < 24; run++) {
      const marks = scatterSignals()
      const pairs = nearestLinks(marks)
      bridgeIslands(marks, pairs)
      expect(pieces(marks.length, [...pairs.values()])).toBe(1)
    }
  })

  /**
   * And it stays a mesh rather than becoming a cobweb: under two segments
   * per marker, which is what keeps the lines reading as connections
   * between instruments instead of as a net thrown over the planet.
   */
  it('keeps the web sparse', () => {
    for (let run = 0; run < 24; run++) {
      const marks = scatterSignals()
      const pairs = nearestLinks(marks)
      bridgeIslands(marks, pairs)
      expect(pairs.size).toBeLessThan(marks.length * 2)
    }
  })
})

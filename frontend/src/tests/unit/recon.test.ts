import { describe, expect, it } from 'vitest'
import {
  angularDistance,
  BASE_CONE_DEGREES,
  BEAM_MAX_FIELD_FRACTION,
  buildReconEstimate,
  buildReconFog,
  corridorHalfWidthRadians,
  elevatedSectors,
  generateReconProbeResult,
  MIN_CONE_DEGREES,
  mergeReconProbes,
  normalizeDegrees,
  RECON_BLOTCH_GRADES,
  reconBlotchDepth,
  ATTACK_BIAS_DEGREES,
  HINT_JITTER_DEGREES,
  MARK_JITTER_SECTORS,
  occupancyAlongInbound,
  OPENING_PAINT_SCALE,
  paintedConeDegrees,
  TRAIL_MIN_PROBES,
  threatBearingRadians,
  attackBiasRadians,
  type ReconEstimate,
  type ReconFix,
} from '../../game/recon'
import { generateAttack } from '../../game/attacks'
import type { AttackTrajectory, Hash, ReconProbeResult } from '../../game/types'
import { buildWorld, pointOnEarthSurface, rayExitFromEarth } from '../../game/world'
import { TEST_MAP_GRID } from '../fixtures'

const SEED = '0xseed' as Hash
const world = buildWorld(TEST_MAP_GRID, 1000)

/** An attack coming in from the board's top-left, down to the planet. */
function trajectory(): AttackTrajectory {
  const target = { x: world.earth.center.x - 400, y: world.earth.center.y - world.earth.radiusKm }
  return {
    pointA: { x: 0, y: 0 },
    pointB: target,
    impactAngleRadians: -Math.PI / 2,
    lengthKm: 5000,
    speedKmPerBlock: 250,
  }
}

function probe(index: number, path = trajectory()): ReconProbeResult {
  return generateReconProbeResult(path, 4, index, world, SEED, 100)
}

function degreesBetween(a: number, b: number): number {
  return (angularDistance((a * Math.PI) / 180, (b * Math.PI) / 180) * 180) / Math.PI
}

describe('one Recon Probe (ТЗ §1.2)', () => {
  it('answers with a direction, a cone, and a jittered snapshot of where the attack is', () => {
    const result = probe(0)

    expect(result.bearingDegrees).toBeGreaterThanOrEqual(0)
    expect(result.bearingDegrees).toBeLessThan(360)
    expect(result.uncertaintyDegrees).toBe(BASE_CONE_DEGREES)
    expect(result.confidencePercent).toBeGreaterThan(0)
    expect(result.confidencePercent).toBeLessThan(100)
    expect(result.mark).toBeDefined()
    expect(Number.isFinite(result.mark!.x)).toBe(true)
    expect(Number.isFinite(result.mark!.y)).toBe(true)
    expect(Object.keys(result).sort()).toEqual(
      [
        'bearingDegrees',
        'confidencePercent',
        'direction',
        'epochId',
        'generatedAtBlock',
        'impactBearingDegrees',
        'mark',
        'sectorIds',
        'uncertaintyDegrees',
      ].sort(),
    )
  })

  it('points somewhere within its own stated error of the biased bearing', () => {
    const path = trajectory()
    const biased = (threatBearingRadians(path, world) + attackBiasRadians(SEED)) * 180 / Math.PI

    for (let index = 0; index < 8; index++) {
      expect(degreesBetween(probe(index, path).bearingDegrees, biased)).toBeLessThanOrEqual(BASE_CONE_DEGREES)
    }
  })

  it('names the sectors its own cone crosses', () => {
    const result = probe(0)
    expect(result.sectorIds.length).toBeGreaterThan(1)
  })

  it('gives a different reading each time, so repeat probes are worth sending', () => {
    expect(probe(0).bearingDegrees).not.toBe(probe(1).bearingDegrees)
  })

  it('is deterministic for the same probe index — the answer is not re-rolled', () => {
    expect(probe(2)).toEqual(probe(2))
  })
})

describe('fusing probes (ТЗ §1.3)', () => {
  it('has nothing to say before the first probe', () => {
    expect(mergeReconProbes([])).toBeNull()
  })

  it('narrows the cone with every further probe', () => {
    const results = [probe(0), probe(1), probe(2), probe(3)]
    const widths = [1, 2, 3, 4].map((n) => mergeReconProbes(results.slice(0, n))!.uncertaintyDegrees)

    expect(widths[0]).toBeGreaterThan(widths[1])
    expect(widths[1]).toBeGreaterThan(widths[2])
    expect(widths[2]).toBeGreaterThan(widths[3])
    // Four equally good readings leave half the cone of one — the √n the
    // model is built on.
    expect(widths[3]).toBeCloseTo(widths[0] / 2, 5)
  })

  it('never closes the cone, however many probes are spent (ТЗ §1.3)', () => {
    const many = Array.from({ length: 200 }, (_, index) => probe(index))
    expect(mergeReconProbes(many)!.uncertaintyDegrees).toBe(MIN_CONE_DEGREES)
  })

  it('converges on the biased bearing rather than on the truth', () => {
    // |ε| has to be large enough that θ and θ+ε are distinct attractors —
    // a near-zero draw would make "closer to bias" the same claim as
    // "closer to truth". Probe noise is unaimed (BASE_CONE), so a few
    // dozen readings still leave a several-degree residual; pick a seed
    // whose bias sits well outside that.
    let seed = SEED
    let biasDeg = (attackBiasRadians(seed) * 180) / Math.PI
    for (let i = 0; i < 200 && Math.abs(biasDeg) < 3.5; i++) {
      seed = `0xseed-bias-${i}` as Hash
      biasDeg = (attackBiasRadians(seed) * 180) / Math.PI
    }
    expect(Math.abs(biasDeg)).toBeGreaterThanOrEqual(3.5)

    const path = trajectory()
    const truth = (threatBearingRadians(path, world) * 180) / Math.PI
    const biased = truth + biasDeg
    const results = Array.from({ length: 80 }, (_, index) =>
      generateReconProbeResult(path, 4, index, world, seed, 100),
    )
    const fused = mergeReconProbes(results)!

    expect(degreesBetween(fused.bearingDegrees, biased)).toBeLessThan(degreesBetween(fused.bearingDegrees, truth))
    expect(degreesBetween(fused.bearingDegrees, biased)).toBeLessThan(MIN_CONE_DEGREES)
  })

  it('averages bearings the short way round, so 350° and 10° meet at 0°', () => {
    const at = (bearingDegrees: number): ReconProbeResult => ({
      ...probe(0),
      bearingDegrees,
      uncertaintyDegrees: BASE_CONE_DEGREES,
    })
    expect(mergeReconProbes([at(350), at(10)])!.bearingDegrees).toBe(0)
  })

  it('raises confidence with each probe but stops short of certainty', () => {
    const results = Array.from({ length: 12 }, (_, index) => probe(index))
    const one = mergeReconProbes(results.slice(0, 1))!.confidencePercent
    const twelve = mergeReconProbes(results)!.confidencePercent

    expect(twelve).toBeGreaterThan(one)
    expect(twelve).toBeLessThan(100)
  })
})

describe('the fog it paints (ТЗ §1.2)', () => {
  it('is empty with no probes at all', () => {
    const fog = buildReconFog([], world)
    expect(fog.fix).toBeNull()
    expect(fog.weights.size).toBe(0)
  })

  it('weights sectors by how far off the search bearing they are', () => {
    const fog = buildReconFog([probe(0)], world)
    expect(fog.fix).not.toBeNull()
    for (const weight of fog.weights.values()) {
      expect(weight).toBeGreaterThan(0)
      expect(weight).toBeLessThanOrEqual(1)
    }
  })

  /*
   * The map draws the fused fix, not the opening sweep. Holding the first
   * reading kept the picture pinned to the one probe taken blind — it
   * never lost a degree of its opening cone however much was spent on it.
   */
  it('sharpens the drawn fix as probes arrive, and floors it (ТЗ §1.3)', () => {
    const results = Array.from({ length: 5 }, (_, index) => probe(index))
    const one = buildReconFog(results.slice(0, 1), world)
    const five = buildReconFog(results, world)

    expect(one.fix!.uncertaintyDegrees).toBe(BASE_CONE_DEGREES)
    expect(five.fix!.uncertaintyDegrees).toBeLessThan(one.fix!.uncertaintyDegrees)
    expect(five.fix!.uncertaintyDegrees).toBeGreaterThanOrEqual(MIN_CONE_DEGREES)
    expect(five.fix!.probeCount).toBe(5)
  })

  it('still leaves a search area rather than a single sector (ТЗ §1.3)', () => {
    const many = Array.from({ length: 40 }, (_, index) => probe(index))
    expect(elevatedSectors(buildReconFog(many, world)).length).toBeGreaterThan(1)
  })
})

describe('the reconnaissance picture (ТЗ §3)', () => {
  /** The estimate `count` probes of ordinary quality would leave. */
  function estimate(count: number) {
    const results = Array.from({ length: count }, (_, i) => probe(i))
    return buildReconEstimate(mergeReconProbes(results), world, results)!
  }

  /**
   * Whether a point is inside the blue beam — within the interpolated
   * half-width of the corridor, at that point's position along it.
   */
  function insideCloud(point: { x: number; y: number }, picture: ReconEstimate): boolean {
    const { from, to } = picture.axis
    const dx = to.x - from.x
    const dy = to.y - from.y
    const len = Math.hypot(dx, dy) || 1
    const along = ((point.x - from.x) * dx + (point.y - from.y) * dy) / (len * len)
    const t = Math.min(1, Math.max(0, along))
    const half = picture.cloud.halfWidthKm.far * (1 - t) + picture.cloud.halfWidthKm.near * t
    return distanceToSegment(point, from, to) <= half + 1e-6
  }

  /** Range from the planet's centre — what "closer to Earth" means for a mark. */
  function rangeFromEarth(point: { x: number; y: number }): number {
    return Math.hypot(point.x - world.earth.center.x, point.y - world.earth.center.y)
  }

  function distanceToSegment(
    point: { x: number; y: number },
    from: { x: number; y: number },
    to: { x: number; y: number },
  ): number {
    const dx = to.x - from.x
    const dy = to.y - from.y
    const length = Math.hypot(dx, dy) || 1
    return Math.abs((point.x - from.x) * dy - (point.y - from.y) * dx) / length
  }

  it('has nothing to draw before the first probe', () => {
    expect(buildReconEstimate(null, world)).toBeNull()
  })

  it('is a trapezoid the board can still be seen under, at every probe count', () => {
    for (const count of [1, 2, 4, 12]) {
      const picture = estimate(count)
      // Capped against the field rather than against the planet: a first
      // cone is genuinely wider than Earth, and drawing it Earth-wide made
      // "somewhere in this quarter of the sky" look like a measurement.
      expect(picture.cloud.halfWidthKm.far).toBeLessThanOrEqual(world.widthKm * BEAM_MAX_FIELD_FRACTION + 1e-9)
      expect(picture.cloud.halfWidthKm.near).toBeLessThanOrEqual(world.widthKm * BEAM_MAX_FIELD_FRACTION + 1e-9)
      expect(picture.cloud.halfWidthKm.far).toBeGreaterThan(picture.cloud.halfWidthKm.near)
    }
  })

  it('opens as a searchlight rather than as a band with tidy edges', () => {
    const opening = estimate(1)
    /*
     * The first reading flares: one probe knows a direction, not a path.
     * Capped at Earth's radius the two ends came out within a quarter of
     * each other, which drew a straight corridor for a 52° cone.
     */
    expect(opening.cloud.halfWidthKm.far).toBeGreaterThan(opening.cloud.halfWidthKm.near * 2)
    expect(opening.cloud.halfWidthKm.far).toBeGreaterThan(world.earth.radiusKm)
    expect(opening.cloud.halfWidthKm.near).toBeGreaterThan(world.sectorSpanKm)
  })

  it('gives the opening sweep no occupancy mark on the map, and later probes a jittered one', () => {
    expect(probe(0).mark).toBeDefined()
    expect(probe(1).mark).toBeDefined()
  })

  it('keeps the true inbound inside a noisy first-probe cloud', () => {
    for (let attackIndex = 0; attackIndex < 80; attackIndex++) {
      const seed = `0x${(attackIndex + 40).toString(16)}` as Hash
      const { trajectory: path } = generateAttack(
        '0xlobby' as Hash,
        { epochId: 1, startBlock: 10, seed },
        { epochBlocks: 20 },
        world,
        { blockNumber: 1, timestamp: 0, avgBlockTimeMs: 2000 },
      )
      const first = generateReconProbeResult(path, 4, 0, world, seed, 100, null)
      const picture = buildReconEstimate(mergeReconProbes([first]), world, [first])!
      expect(insideCloud(path.pointA, picture)).toBe(true)
      expect(insideCloud(path.pointB, picture)).toBe(true)
      const mid = {
        x: path.pointA.x + (path.pointB.x - path.pointA.x) * 0.5,
        y: path.pointA.y + (path.pointB.y - path.pointA.y) * 0.5,
      }
      expect(insideCloud(mid, picture)).toBe(true)
    }
  })

  it('gives one probe a cloud and no red occupancy (ТЗ §3)', () => {
    const one = estimate(1)

    expect(one.cloud.ring).toHaveLength(4)
    expect(one.blotches).toEqual([])
    expect(TRAIL_MIN_PROBES).toBe(2)
    expect(one.cloud.halfWidthKm.far).toBeGreaterThan(one.cloud.halfWidthKm.near)
  })

  /*
   * The launch is an angle seen from far away and the impact is a position
   * on the rim, so the same error is worth kilometres at one end and an arc
   * at the other. Probes buy that difference: the corridor closes on the
   * planet faster than it closes in the sky.
   */
  it('opens as a flashlight and closes in kilometres as probes arrive', () => {
    const one = estimate(1)
    const many = estimate(12)
    expect(one.cloud.halfWidthKm.far / one.cloud.halfWidthKm.near).toBeGreaterThan(2)
    expect(many.cloud.halfWidthKm.far / many.cloud.halfWidthKm.near).toBeGreaterThan(1.5)
    expect(one.cloud.halfWidthKm.near).toBeGreaterThan(many.cloud.halfWidthKm.near)
    expect(many.cloud.halfWidthKm.far).toBeGreaterThan(one.cloud.halfWidthKm.far * 0.85)
  })

  it('keeps the opening search at the full cone — side scatter is a drawing scale', () => {
    const one = mergeReconProbes([probe(0)])!
    expect(paintedConeDegrees(one)).toBeCloseTo(
      Math.max(one.uncertaintyDegrees, BASE_CONE_DEGREES) + ATTACK_BIAS_DEGREES,
      5,
    )
    expect(OPENING_PAINT_SCALE).toBe(0.75)
  })

  it('keeps later probes as the same flashlight, not the old strip', () => {
    const oneFix = mergeReconProbes([probe(0)])!
    const twoFix = mergeReconProbes([probe(0), probe(1)])!
    const fourFix = mergeReconProbes(Array.from({ length: 4 }, (_, i) => probe(i)))!
    const one = estimate(1)
    const two = estimate(2)
    expect(paintedConeDegrees(twoFix)).toBeGreaterThan(BASE_CONE_DEGREES * 0.55)
    expect(paintedConeDegrees(twoFix)).toBeLessThan(paintedConeDegrees(oneFix))
    expect(paintedConeDegrees(fourFix)).toBeGreaterThan(paintedConeDegrees(twoFix) * 0.8)
    expect(two.cloud.halfWidthKm.far / two.cloud.halfWidthKm.near).toBeGreaterThan(1.5)
    expect(two.cloud.halfWidthKm.far).toBeGreaterThan(one.cloud.halfWidthKm.far * 0.7)
  })

  /*
   * An operation whose probes answered before the packed hint existed
   * reports no δ at all. Drawing a chord from that is drawing a reading
   * nobody made — the corridor has to open to the whole approach window
   * the protocol allows, or the real trajectory sits outside its own scan.
   */
  it('opens the cloud to the whole approach window when no reading carried an impact', () => {
    const readings = Array.from({ length: 4 }, (_, i) => ({ ...probe(i), impactBearingDegrees: undefined }))
    const fused = mergeReconProbes(readings)!
    expect(fused.impactBearingDegrees).toBeUndefined()

    const blind = buildReconEstimate(fused, world, readings)!
    const seeing = estimate(4)
    expect(blind.cloud.halfWidthKm.near).toBeGreaterThanOrEqual(seeing.cloud.halfWidthKm.near)
    expect(blind.cloud.halfWidthKm.near).toBeGreaterThan(world.earth.radiusKm * 0.2)
    expect(blind.cloud.halfWidthKm.far).toBeGreaterThanOrEqual(blind.cloud.halfWidthKm.near)
  })

  it('keeps the bright middle strictly inside the cloud it brightens', () => {
    for (const count of [1, 2, 4, 12]) {
      const picture = estimate(count)
      expect(picture.core.halfWidthKm.far).toBeLessThan(picture.cloud.halfWidthKm.far)
      expect(picture.core.halfWidthKm.near).toBeLessThan(picture.cloud.halfWidthKm.near)
      expect(picture.core.apex).toEqual(picture.cloud.apex)
    }
  })

  it('leaves a static red blotch on the second probe, inside the first cloud', () => {
    const two = estimate(2)
    expect(two.blotches).toHaveLength(1)
    const mark = two.blotches[0]
    expect(insideCloud(mark.center, two)).toBe(true)
    expect(rangeFromEarth(mark.center)).toBeGreaterThan(rangeFromEarth(two.axis.to))
    expect(rangeFromEarth(mark.center)).toBeLessThan(rangeFromEarth(two.axis.from))
  })

  it('keeps every blotch inside the same cloud, and later ones darker', () => {
    const picture = estimate(4)
    expect(picture.blotches).toHaveLength(3)
    expect(picture.blotches[2].depth).toBeGreaterThan(picture.blotches[0].depth)
    expect(reconBlotchDepth(4)).toBeGreaterThan(reconBlotchDepth(2))
    const { from, to } = picture.axis
    const cap = picture.cloud.halfWidthKm.far
    for (const mark of picture.blotches) {
      expect(distanceToSegment(mark.center, from, to)).toBeLessThanOrEqual(cap)
    }
  })

  /*
   * A mark is a reading, and a reading that disagrees is information. It
   * used to be dragged onto the fused corridor so the picture stayed
   * tidy, which meant the pile of marks agreed with itself by
   * construction — decoration wearing the clothes of evidence. Now a
   * probe that points somewhere else is drawn somewhere else.
   */
  it('draws a wildly disagreeing reading where it disagrees, not inside the fused cloud', () => {
    const first = probe(0)
    const results = [
      { ...first, mark: undefined },
      { ...first, bearingDegrees: (first.bearingDegrees + 170) % 360, mark: undefined },
    ]
    const picture = buildReconEstimate(mergeReconProbes(results), world, results)!
    expect(insideCloud(picture.blotches[0].center, picture)).toBe(false)
  })

  /*
   * The bug this asserts against: every mark was rebuilt against the
   * *current* fused axis and clamped into the *current* cloud, so buying a
   * probe slid readings taken minutes earlier hundreds of kilometres
   * across the board. A snapshot is a fact with a timestamp.
   */
  it('never moves a mark a later probe knows nothing about', () => {
    const results = [probe(0), probe(1)]
    const before = buildReconEstimate(mergeReconProbes(results), world, results)!

    const withThird = [...results, { ...probe(2), bearingDegrees: (probe(2).bearingDegrees + 40) % 360 }]
    const after = buildReconEstimate(mergeReconProbes(withThird), world, withThird)!

    expect(after.blotches[0].center).toEqual(before.blotches[0].center)
  })

  it('draws each mark where its own probe reported it', () => {
    const results = [probe(0), probe(1), probe(2)]
    const picture = buildReconEstimate(mergeReconProbes(results), world, results)!

    picture.blotches.forEach((blotch, index) => {
      expect(blotch.center).toEqual(results[index + 1].mark)
    })
  })

  it('has one shade per probe a player can still buy, light to dark', () => {
    expect(RECON_BLOTCH_GRADES).toBe(5)
    const grades = Array.from({ length: RECON_BLOTCH_GRADES }, (_, i) => reconBlotchDepth(TRAIL_MIN_PROBES + i))
    expect(new Set(grades).size).toBe(RECON_BLOTCH_GRADES)
    expect(grades[0]).toBe(0)
    expect(grades[RECON_BLOTCH_GRADES - 1]).toBe(1)
    // Past the last grade the ramp holds rather than running off into black.
    expect(reconBlotchDepth(TRAIL_MIN_PROBES + RECON_BLOTCH_GRADES)).toBe(1)
  })

  it('closes the cloud as probes arrive (ТЗ §1.3)', () => {
    const one = estimate(1)
    const four = estimate(4)
    expect(four.cloud.halfWidthKm.near).toBeLessThan(one.cloud.halfWidthKm.near)
    expect(four.cloud.halfWidthKm.far).toBeLessThanOrEqual(one.cloud.halfWidthKm.far)
  })

  /*
   * The beam has a floor in kilometres so it cannot collapse onto a line
   * one intercept radius covers — which is what keeps the exact target a
   * question only Reveal answers (ТЗ §4).
   */
  it('never sharpens the cloud into the answer, however many probes are spent', () => {
    const many = estimate(60)

    expect(many.cloud.halfWidthKm.far).toBeGreaterThanOrEqual(0.33 * world.earth.radiusKm)
    expect(many.blotches.length).toBe(59)
    expect(many.sharpness).toBeLessThanOrEqual(1)
  })

  it('starts the estimated route at the launch, not at the planet’s centre', () => {
    const picture = estimate(3)
    const fromCentre = Math.hypot(
      picture.axis.from.x - world.earth.center.x,
      picture.axis.from.y - world.earth.center.y,
    )
    const toCentre = Math.hypot(
      picture.axis.to.x - world.earth.center.x,
      picture.axis.to.y - world.earth.center.y,
    )

    // Incoming path: field edge → Earth's rim. A fan from the centre shares
    // the slope and misses the coordinates.
    expect(fromCentre).toBeGreaterThan(world.earth.radiusKm * 1.5)
    expect(toCentre).toBeCloseTo(world.earth.radiusKm, 6)
  })

  it('draws the cloud as a beam from the sky down to Earth, not a fan from the centre', () => {
    const picture = estimate(1)
    expect(picture.cloud.ring).toHaveLength(4)
    const earth = world.earth.center
    const far = picture.cloud.apex
    expect(Math.hypot(far.x - earth.x, far.y - earth.y)).toBeGreaterThan(world.earth.radiusKm * 2)
    // The near end sits on Earth's rim so the sky clip bites a horizon
    // arc — a tangent chord across the cap was the straight cut.
    for (const point of picture.cloud.arc) {
      const range = Math.hypot(point.x - earth.x, point.y - earth.y)
      expect(range).toBeGreaterThan(world.earth.radiusKm * 0.99)
      expect(range).toBeLessThan(world.earth.radiusKm * 1.03)
    }
  })

  it('runs the cloud just past the launch rather than closing it across the sky', () => {
    const picture = estimate(1)
    const { from, to } = picture.axis
    const apex = picture.cloud.apex
    const pastLaunch = (apex.x - from.x) * (from.x - to.x) + (apex.y - from.y) * (from.y - to.y)
    // The far end is beyond the launch, so the corridor does not end as a
    // ruler line on the board's edge. It is not so far that the wide end
    // of the trapezoid happens off-screen.
    expect(pastLaunch).toBeGreaterThan(0)
    expect(Math.hypot(apex.x - from.x, apex.y - from.y)).toBeGreaterThan(world.sectorSpanKm * 0.2)
    expect(Math.hypot(apex.x - from.x, apex.y - from.y)).toBeLessThan(
      Math.hypot(from.x - to.x, from.y - to.y) * 0.5,
    )
  })

  it('spreads later probes across the cloud rather than stacking them on the centreline', () => {
    const picture = estimate(6)
    const { from, to } = picture.axis
    const offsets = picture.blotches.map((mark) => distanceToSegment(mark.center, from, to))
    expect(Math.max(...offsets)).toBeGreaterThan(Math.min(...offsets))
  })

  it('offsets occupancy left or right of the inbound, not along a ruler', () => {
    const path = trajectory()
    const left = occupancyAlongInbound(path, 2, world, () => 0)
    const right = occupancyAlongInbound(path, 2, world, () => 1)
    const leftOffset = distanceToSegment(left, path.pointA, path.pointB)
    const rightOffset = distanceToSegment(right, path.pointA, path.pointB)
    expect(leftOffset).toBeGreaterThan(world.sectorSpanKm * 0.2)
    expect(rightOffset).toBeGreaterThan(world.sectorSpanKm * 0.2)
    expect(left.x).not.toBeCloseTo(right.x, 4)
  })

  /*
   * Each probe is a shutter on a noisy chord. A later bearing that
   * disagrees must not throw the opening snapshot out of the cloud —
   * the mark stays the shutter, pulled only far enough to remain a
   * reading inside the fused corridor.
   */
  it('keeps a snapshot mark on its chord even when a later bearing disagrees (ТЗ §3)', () => {
    const first = probe(0)
    const results = [first, { ...first, bearingDegrees: first.bearingDegrees + 16 }]
    const picture = buildReconEstimate(mergeReconProbes(results), world, results)!
    expect(first.mark).toBeDefined()
    expect(insideCloud(picture.blotches[0].center, picture)).toBe(true)
  })

  /*
   * Occupancy marks land on a noisy reconstruction of the chord, sampled
   * at flight time. Residual ε and cell jitter keep them off the exact
   * path; they still have to sit near it, or the pile would be a second
   * picture beside Reveal's trajectory.
   */
  it('puts occupancy marks near the true inbound, within the protocol jitter', () => {
    for (let attackIndex = 0; attackIndex < 80; attackIndex++) {
      const seed = `0x${attackIndex.toString(16)}` as Hash
      const { trajectory: path } = generateAttack(
        '0xlobby' as Hash,
        { epochId: 1, startBlock: 10, seed },
        { epochBlocks: 20 },
        world,
        { blockNumber: 1, timestamp: 0, avgBlockTimeMs: 2000 },
      )

      const results: ReconProbeResult[] = []
      for (let probeIndex = 0; probeIndex < 4; probeIndex++) {
        const aim = results.length === 0 ? null : mergeReconProbes(results)!.bearingDegrees
        results.push(generateReconProbeResult(path, 4, probeIndex, world, seed, 100, aim))
      }

      const picture = buildReconEstimate(mergeReconProbes(results), world, results)!
      const chordKm = Math.hypot(path.pointB.x - path.pointA.x, path.pointB.y - path.pointA.y)
      const jitterCap =
        Math.tan(((HINT_JITTER_DEGREES + ATTACK_BIAS_DEGREES) * Math.PI) / 180) * chordKm +
        world.sectorSpanKm * (0.2 + MARK_JITTER_SECTORS)
      for (const blotch of picture.blotches) {
        expect(distanceToSegment(blotch.center, path.pointA, path.pointB)).toBeLessThanOrEqual(jitterCap)
      }
      const mid = {
        x: path.pointA.x + (path.pointB.x - path.pointA.x) * 0.45,
        y: path.pointA.y + (path.pointB.y - path.pointA.y) * 0.45,
      }
      expect(insideCloud(mid, picture)).toBe(true)
    }
  })
})

/**
 * Aiming (ТЗ §4).
 *
 * The opening probe is a sweep — wide, but centred on the truth, so it turns
 * "somewhere out there" into a direction. Every probe after it is pointed,
 * and what it is worth depends on how well it was pointed. A good aim
 * sharpens the picture; a bad one is a reading so vague that fusion, which
 * weights each by 1/σ², quietly declines to move the fix.
 */
describe('aiming a probe (ТЗ §4)', () => {
  const path = trajectory()

  /** The bearing a player would be aiming at if they had guessed perfectly. */
  function trueBearing(): number {
    // The sweep is unbiased, so a large sample of sweeps centres on the truth.
    const sweeps = Array.from({ length: 400 }, (_, i) => generateReconProbeResult(path, 4, i, world, SEED, 100))
    const fix = mergeReconProbes(sweeps)!
    return fix.bearingDegrees
  }

  it('opens with a wide sweep, since there is nothing to aim at yet', () => {
    const sweep = generateReconProbeResult(path, 4, 0, world, SEED, 100, null)
    expect(sweep.uncertaintyDegrees).toBe(BASE_CONE_DEGREES)
  })

  it('repays a probe aimed into the right area with a sharper reading', () => {
    const aimed = generateReconProbeResult(path, 4, 1, world, SEED, 100, trueBearing())
    expect(aimed.uncertaintyDegrees).toBeLessThan(BASE_CONE_DEGREES)
  })

  it('gives a probe pointed the wrong way nothing the sweep had not already said', () => {
    const wrong = generateReconProbeResult(path, 4, 1, world, SEED, 100, trueBearing() + 90)
    expect(wrong.uncertaintyDegrees).toBeGreaterThanOrEqual(BASE_CONE_DEGREES)
  })

  /**
   * The property the whole mechanic rests on: a wasted probe must not be
   * able to drag the picture off the truth. Precision weighting already
   * guarantees it — this pins that it stays true.
   */
  it('lets a well-aimed probe move the fix while a badly aimed one barely does', () => {
    const sweep = generateReconProbeResult(path, 4, 0, world, SEED, 100, null)
    const truth = trueBearing()

    const withGoodAim = mergeReconProbes([sweep, generateReconProbeResult(path, 4, 1, world, SEED, 100, truth)])!
    const withBadAim = mergeReconProbes([sweep, generateReconProbeResult(path, 4, 1, world, SEED, 100, truth + 120)])!

    expect(withGoodAim.uncertaintyDegrees).toBeLessThan(withBadAim.uncertaintyDegrees)
    // And the wasted one leaves the picture roughly where the sweep left it.
    expect(withBadAim.uncertaintyDegrees).toBeGreaterThan(sweep.uncertaintyDegrees / 2)
  })

  it('never lets good aim close the cone to an answer', () => {
    const perfect = generateReconProbeResult(path, 4, 3, world, SEED, 100, trueBearing())
    expect(perfect.uncertaintyDegrees).toBeGreaterThan(0)

    const many = Array.from({ length: 12 }, (_, i) =>
      generateReconProbeResult(path, 4, i, world, SEED, 100, trueBearing()),
    )
    expect(mergeReconProbes(many)!.uncertaintyDegrees).toBeGreaterThanOrEqual(MIN_CONE_DEGREES)
  })
})

describe('the incoming corridor', () => {
  function along(path: AttackTrajectory, t: number) {
    return {
      x: path.pointA.x + (path.pointB.x - path.pointA.x) * t,
      y: path.pointA.y + (path.pointB.y - path.pointA.y) * t,
    }
  }

  function insideCorridor(path: AttackTrajectory, uncertaintyDegrees: number): boolean {
    const bearing = threatBearingRadians(path, world)
    const fix: ReconFix = {
      bearingDegrees: normalizeDegrees((bearing * 180) / Math.PI),
      direction: 'N',
      uncertaintyDegrees,
      confidencePercent: 50,
      probeCount: 2,
    }
    const launch = rayExitFromEarth(bearing, world)
    const inward = bearing + Math.PI
    const spread = corridorHalfWidthRadians(fix, world)
    return [0.2, 0.5, 0.8].every((t) => {
      const point = along(path, t)
      const fromLaunch = Math.atan2(point.y - launch.y, point.x - launch.x)
      return angularDistance(fromLaunch, inward) <= spread
    })
  }

  it('contains a contract-style chord: radial launch, offset impact', () => {
    const theta = -Math.PI / 2 + 0.35
    const delta = 0.7
    const path: AttackTrajectory = {
      pointA: rayExitFromEarth(theta, world),
      pointB: pointOnEarthSurface(theta + delta, world),
      impactAngleRadians: theta + delta,
      lengthKm: 5000,
      speedKmPerBlock: 250,
    }
    expect(insideCorridor(path, 12)).toBe(true)
  })

  it('contains an emulator-style approach from the impact normal', () => {
    const { trajectory: path } = generateAttack(
      '0xlobby' as Hash,
      { epochId: 1, startBlock: 10, seed: SEED },
      { epochBlocks: 20 },
      world,
      { blockNumber: 1, timestamp: 0, avgBlockTimeMs: 2000 },
    )
    expect(insideCorridor(path, 12)).toBe(true)
  })

  it('paints a first-probe cloud that covers the true inbound, not a smear on another edge', () => {
    const theta = -Math.PI / 2 + 0.35
    const delta = 0.7
    const path: AttackTrajectory = {
      pointA: rayExitFromEarth(theta, world),
      pointB: pointOnEarthSurface(theta + delta, world),
      impactAngleRadians: theta + delta,
      lengthKm: 5000,
      speedKmPerBlock: 250,
    }
    const fix: ReconFix = {
      bearingDegrees: normalizeDegrees((theta * 180) / Math.PI),
      impactBearingDegrees: normalizeDegrees(((theta + delta) * 180) / Math.PI),
      direction: 'N',
      uncertaintyDegrees: BASE_CONE_DEGREES,
      confidencePercent: 45,
      probeCount: 1,
    }
    const picture = buildReconEstimate(fix, world)!
    const { from, to } = picture.axis
    const dx = to.x - from.x
    const dy = to.y - from.y
    const length = Math.hypot(dx, dy) || 1
    const offsetOf = (point: { x: number; y: number }) =>
      Math.abs((point.x - from.x) * dy - (point.y - from.y) * dx) / length
    expect(offsetOf(path.pointA)).toBeLessThan(picture.cloud.halfWidthKm.far)
    expect(offsetOf(path.pointB)).toBeLessThan(picture.cloud.halfWidthKm.near + world.earth.radiusKm * 0.2)
    const mid = {
      x: path.pointA.x + (path.pointB.x - path.pointA.x) * 0.5,
      y: path.pointA.y + (path.pointB.y - path.pointA.y) * 0.5,
    }
    expect(offsetOf(mid)).toBeLessThan(picture.cloud.halfWidthKm.far)
  })

  it('aims the cloud along the inbound chord, not the radial through Earth', () => {
    const theta = -Math.PI / 2 + 0.35
    const delta = 0.7
    const path: AttackTrajectory = {
      pointA: rayExitFromEarth(theta, world),
      pointB: pointOnEarthSurface(theta + delta, world),
      impactAngleRadians: theta + delta,
      lengthKm: 5000,
      speedKmPerBlock: 250,
    }
    const fix: ReconFix = {
      bearingDegrees: normalizeDegrees((theta * 180) / Math.PI),
      impactBearingDegrees: normalizeDegrees(((theta + delta) * 180) / Math.PI),
      direction: 'N',
      uncertaintyDegrees: BASE_CONE_DEGREES,
      confidencePercent: 45,
      probeCount: 1,
    }
    const picture = buildReconEstimate(fix, world)!
    const { from, to } = picture.axis
    const dx = to.x - from.x
    const dy = to.y - from.y
    const length = Math.hypot(dx, dy) || 1
    const offsetOf = (point: { x: number; y: number }) =>
      Math.abs((point.x - from.x) * dy - (point.y - from.y) * dx) / length
    expect(offsetOf(picture.cloud.apex)).toBeLessThan(1)
    expect(offsetOf(path.pointA)).toBeLessThan(world.sectorSpanKm)
    expect(offsetOf(path.pointB)).toBeLessThan(world.earth.radiusKm * 0.05)
  })
})

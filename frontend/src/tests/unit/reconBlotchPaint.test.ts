import { describe, expect, it } from 'vitest'
import { blotchBandOpacity, blotchPaint } from '../../components/map/SectorGrid'
import { RECON_BLOTCH_GRADES, TRAIL_MIN_PROBES, reconBlotchDepth } from '../../game/recon'

/**
 * The red occupancy marks, as a *graded* run rather than a pile.
 *
 * Two properties pull against each other and both have been broken by an
 * honest attempt to fix the other:
 *
 *   - the first mark has to be visible at all — it opened on a near-white
 *     pink at a fifth opacity over a blue cloud, through a wide blur, and
 *     could not be found;
 *   - the fifth has to be tellable from the first — raising the floor by
 *     flattening the range put every mark within a few percent of every
 *     other, and five probes merged into one smudge near the launch.
 *
 * Neither shows up in a screenshot until five probes are on the board, so
 * they are pinned here instead.
 */
const PROBES = Array.from(
  { length: RECON_BLOTCH_GRADES },
  (_, step) => TRAIL_MIN_PROBES + step,
)

describe('the red occupancy marks (ТЗ §3)', () => {
  it('opens on a mark that can actually be seen', () => {
    const first = blotchPaint(reconBlotchDepth(PROBES[0]))
    expect(blotchBandOpacity(0, first.weight)).toBeGreaterThan(0.17)
    // Not a near-white pink: the opening shade has to be a red.
    const [r, g, b] = first.shade.match(/\d+/g)!.map(Number)
    expect(r).toBeGreaterThan(g + 80)
    expect(r).toBeGreaterThan(b + 60)
  })

  it('deepens on every probe, in weight and in hue', () => {
    const run = PROBES.map((probe) => blotchPaint(reconBlotchDepth(probe)))

    for (let i = 1; i < run.length; i += 1) {
      expect(run[i].weight).toBeGreaterThan(run[i - 1].weight)
      const before = Number(run[i - 1].shade.match(/\d+/g)![0])
      const after = Number(run[i].shade.match(/\d+/g)![0])
      expect(after).toBeLessThan(before)
    }
  })

  it('keeps enough range that the last mark is not the first', () => {
    const first = blotchPaint(reconBlotchDepth(PROBES[0]))
    const last = blotchPaint(reconBlotchDepth(PROBES[PROBES.length - 1]))
    // The flattened ramp that merged the pile spanned 1.00 → 1.36.
    expect(last.weight / first.weight).toBeGreaterThan(1.6)
  })
})

import { describe, expect, it, vi } from 'vitest'
import { RUNES, RUNE_VIEWBOX } from '../../motion/runes'

/** Every coordinate in a path, in order. */
function points(path: string): number[] {
  return (path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
}

describe('runes — a script that does not exist', () => {
  /**
   * Size is a visual property here rather than a detail. The line scrambles
   * nineteen characters at once and seals five or six of them for two and a
   * half seconds; against the six block elements this replaced, the same
   * form landed in three places in a frame and the effect stopped reading
   * as random.
   */
  it('carries enough distinct forms that a frame can be collision-free', () => {
    expect(RUNES.length).toBeGreaterThanOrEqual(48)
    expect(new Set(RUNES).size).toBe(RUNES.length)
  })

  /**
   * Seeded, so the alphabet is the same on every load. A "script" whose
   * letterforms are different each time the page opens is not a script —
   * half the reason this reads as writing is that the same forms come back.
   */
  it('generates the same alphabet every time it is loaded', async () => {
    vi.resetModules()
    // A second execution of the module, not a second reference to the first.
    const again = await import('../../motion/runes')

    expect(again.RUNES).not.toBe(RUNES)
    expect(again.RUNES).toEqual(RUNES)
  })

  /**
   * Inside the box, so nothing is clipped and no form is a different size
   * from the others — the two ways a drawn glyph could reintroduce exactly
   * the defect it was brought in to remove.
   */
  it('draws every form inside the lattice its viewBox is sized for', () => {
    const [minX, minY, width, height] = points(RUNE_VIEWBOX)

    for (const rune of RUNES) {
      const coordinates = points(rune)
      expect(coordinates.length % 2).toBe(0)

      for (let at = 0; at < coordinates.length; at += 2) {
        expect(coordinates[at]).toBeGreaterThanOrEqual(0)
        expect(coordinates[at]).toBeLessThanOrEqual(6)
        expect(coordinates[at + 1]).toBeGreaterThanOrEqual(0)
        expect(coordinates[at + 1]).toBeLessThanOrEqual(10)
      }

      // The box has room around the lattice for a square cap at the edge.
      expect(minX).toBeLessThan(0)
      expect(minY).toBeLessThan(0)
      expect(width + minX).toBeGreaterThan(6)
      expect(height + minY).toBeGreaterThan(10)
    }
  })

  /**
   * Every form spans the full band — a spine from the top row to the bottom
   * one — and carries at least one mark off it. A form that stopped short
   * would read as a smaller glyph beside the capitals; one with no marks is
   * a stem, and there are only three of those to go round.
   */
  it('spans the full height and hangs at least one mark off the spine', () => {
    for (const rune of RUNES) {
      const [spine, ...marks] = rune.split('M').filter(Boolean)
      const spinePoints = points(spine)

      expect(spinePoints[1]).toBe(0)
      expect(spinePoints[spinePoints.length - 1]).toBe(10)
      expect(marks.length).toBeGreaterThanOrEqual(1)
    }
  })
})

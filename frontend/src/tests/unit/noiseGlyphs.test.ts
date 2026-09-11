import { describe, expect, it } from 'vitest'
import { ASCII_GLYPHS, DIGIT_NOISE, LETTER_NOISE, RUNE_NOISE, pickGlyph } from '../../motion/noiseGlyphs'

describe('noise glyphs — what the decode is allowed to paint', () => {
  /**
   * The rule the hero title's noise broke twice over: a glyph the page's
   * own font cannot draw, or one that is not the height of the text it
   * stands in for. Both showed up on screen as the same defect — something
   * in the middle of the headline that was visibly not part of it.
   *
   * This pool is the one that still has to be characters, because its
   * hosts paint a whole string at once (`useScramble`).
   */
  it('keeps the character pool to cap-height printable ASCII', () => {
    for (const glyph of ASCII_GLYPHS) {
      expect(glyph).toMatch(/[\x21-\x7e]/)
    }

    // The short marks sit mid-band and leave a hole in the line; the block
    // and geometric characters are in none of the fonts in the stack.
    for (const glyph of '-_*=+<>.,~^`\'"█▓▒░■◼▣') {
      expect(ASCII_GLYPHS).not.toContain(glyph)
    }

    expect(new Set(ASCII_GLYPHS).size).toBe(ASCII_GLYPHS.length)
  })

  /** `I` and `O` are the digits either side of them at a glance. */
  it('keeps the letters that read as digits out of the last churn pool', () => {
    expect(LETTER_NOISE.map((glyph) => glyph.text)).not.toContain('I')
    expect(LETTER_NOISE.map((glyph) => glyph.text)).not.toContain('O')
    expect(DIGIT_NOISE).toHaveLength(10)
  })

  /** Drawn forms carry a path and no text; characters, the reverse. */
  it('separates the drawn forms from the typed ones', () => {
    for (const glyph of RUNE_NOISE) {
      expect(glyph.rune).toBeTruthy()
      expect(glyph.text).toBe('')
    }

    for (const glyph of [...DIGIT_NOISE, ...LETTER_NOISE]) {
      expect(glyph.rune).toBeNull()
      expect(glyph.text).toHaveLength(1)
    }
  })

  /**
   * The complaint that produced all of this: three of the same glyph on the
   * line at once, which no amount of "it is random" makes look random.
   * Drawing from what is left is what makes that impossible rather than
   * unlikely — a re-roll is only ever probably fresh.
   */
  it('never returns a glyph the frame is already showing', () => {
    const taken = new Set(RUNE_NOISE.slice(0, RUNE_NOISE.length - 1))

    for (let attempt = 0; attempt < 200; attempt += 1) {
      expect(pickGlyph(RUNE_NOISE, taken)).toBe(RUNE_NOISE[RUNE_NOISE.length - 1])
    }
  })

  /**
   * Bounded, not exhaustive: asked for a glyph when every one is spoken for
   * — ten digits against nineteen boxes — it paints a repeat rather than
   * failing inside a frame.
   */
  it('gives up rather than hanging when the pool is exhausted', () => {
    expect(DIGIT_NOISE).toContain(pickGlyph(DIGIT_NOISE, new Set(DIGIT_NOISE)))
  })
})

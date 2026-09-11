import { useEffect, useRef, useState } from 'react'
import { prefersReducedMotion } from './prefersReducedMotion'
import { ASCII_GLYPHS, pickGlyph } from './noiseGlyphs'

/**
 * The glyphs a character cycles through before it locks.
 *
 * Deliberately not the alphabet: the effect has to read as a *readout
 * resolving*, not as letters shuffling. The pool itself, and the two
 * constraints on what may go in it — cap height, and a glyph the page's own
 * font can draw — live in `noiseGlyphs`.
 *
 * This hook stays on characters where the hero title's decode paints a
 * script that is drawn rather than typed (`runes`), and the reason is
 * structural rather than stylistic: it paints a whole string at once, so it
 * has nowhere to put a drawn form and no way to size one.
 */
const NOISE = [...ASCII_GLYPHS]

export interface ScrambleOptions {
  /** The string to resolve to. */
  text: string
  /** Whether to play at all. `false` renders `text` immediately and does nothing. */
  enabled: boolean
  /** ms before the first frame of noise. */
  delay?: number
  /** ms from first noise to the last character locking. */
  duration?: number
}

/**
 * ТЗ §4, §9, §16 — "Scramble text: stagger from center", rebuilt on
 * primitives.
 *
 * The pattern this is named after is a Motion+ example (ТЗ §34), so this is
 * the behaviour rather than the source: every character starts as noise and
 * they lock **outward from the middle of the string**, so the word resolves
 * from its centre instead of typing itself left to right. That direction is
 * the whole reason the effect suits AEGYLAX — a value arriving all at once
 * and coming into focus, which is what the product claims to do with the
 * numbers it hides.
 *
 * Each character gets its own lock time from its distance to the centre,
 * and spends a fixed slice of the run still cycling before it settles, so
 * there is always noise somewhere on the line until the very end. Spaces
 * are never scrambled: they hold the word shapes still, and a line whose
 * word boundaries move is a line that reads as broken rather than as
 * decoding.
 *
 * Returns the string to paint. Callers render it inside an `aria-hidden`
 * layer with the real text on the label — noise must never reach a screen
 * reader (see `ScrambleText`).
 */
export function useScramble({ text, enabled, delay = 0, duration = 600 }: ScrambleOptions): string {
  const [display, setDisplay] = useState(() => (enabled && !prefersReducedMotion() ? '' : text))
  // The run is keyed to the text it was started for, so a value that changes
  // mid-flight (a counter, a re-themed credit) does not leave the previous
  // string's noise on screen.
  const frame = useRef(0)

  useEffect(() => {
    if (!enabled || prefersReducedMotion()) {
      setDisplay(text)
      return
    }

    const characters = [...text]
    /*
     * Distance from the centre, normalised to 0..1 — the one number that
     * decides this effect's shape. `centre` is a *fractional* index so an
     * even-length string resolves from the seam between its two middle
     * characters rather than favouring one of them.
     */
    const centre = (characters.length - 1) / 2
    const reach = Math.max(centre, 1)
    /*
     * How long a character cycles once its turn comes. The rest of the run
     * is the wave travelling outward, so a bigger settle means more of the
     * line is noisy at once and a smaller one makes it a sharper front.
     */
    const settle = duration * 0.45
    const travel = duration - settle

    const start = performance.now() + delay
    const lockAt = characters.map((_, index) => (Math.abs(index - centre) / reach) * travel + settle)

    const tick = (now: number) => {
      const elapsed = now - start

      if (elapsed < 0) {
        // Still inside the delay: hold the line empty rather than showing
        // either noise or the answer early.
        setDisplay('')
        frame.current = requestAnimationFrame(tick)
        return
      }

      let settled = true
      // No glyph twice in one frame while the pool can afford it: independent
      // draws put the same character in three places often enough that the
      // line reads as cycling a handful of glyphs rather than as noise.
      const drawn = new Set<string>()
      const next = characters
        .map((character, index) => {
          if (character === ' ') return character
          if (elapsed >= lockAt[index]) return character
          settled = false
          const glyph = pickGlyph(NOISE, drawn)
          drawn.add(glyph)
          return glyph
        })
        .join('')

      setDisplay(next)
      if (!settled) frame.current = requestAnimationFrame(tick)
    }

    frame.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame.current)
  }, [text, enabled, delay, duration])

  return display
}

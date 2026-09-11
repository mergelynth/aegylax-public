import { useEffect, useState } from 'react'
import { prefersReducedMotion } from './prefersReducedMotion'
import { DIGIT_NOISE, LETTER_NOISE, RUNE_NOISE, pickGlyph, type NoiseGlyph } from './noiseGlyphs'

/**
 * The three things a held character cycles through, in the order it cycles
 * them: an unreadable form, a digit, a letter. That order is the effect —
 * "cipher, then data, then something that looks like it might be the
 * answer" reads as a slot still being worked on, where a single pool of
 * noise reads as decoration that has not stopped yet.
 *
 * The first pool used to be six block elements, and that was two bugs in
 * one line: none of them are in the product's system-sans type, so they
 * came out of some other font on the machine or as an empty tofu box; and
 * six forms across five or six sealed slots meant two slots showing the
 * same one most of the time. It is now the drawn script (`runes`), which
 * can neither fail to render nor come out the wrong height, and there are
 * forty-eight of them.
 */
const CHURN_POOLS = [RUNE_NOISE, DIGIT_NOISE, LETTER_NOISE] as const

export type CipherCellState =
  /** Inside the delay: the box is held, nothing is painted. */
  | 'blank'
  /** Ordinary scramble noise, on its way to locking with the rest. */
  | 'noise'
  /** Held back from the decode, still churning. */
  | 'cipher'
  /** Just resolved — one flash, then it is ordinary text. */
  | 'solved'
  /** The real character. */
  | 'real'

export interface CipherCell {
  /** What to paint. Empty while blank; the real character once resolved. */
  glyph: string
  /**
   * The fabricated glyph to draw instead, when this cell is painting noise
   * rather than a character (`runes`). `null` for everything else.
   */
  rune: string | null
  state: CipherCellState
}

export interface CipherRevealOptions {
  text: string
  /** Whether this mount is a document load (`useBootEntrance`). */
  enabled: boolean
  /** ms before the first frame of noise. */
  delay?: number
  /** ms from first noise to the last *unheld* character locking. */
  duration?: number
  /** How many characters to hold back from the decode. */
  hold?: number
  /** ms the held characters spend churning before any of them resolves. */
  churn?: number
  /** ms between one held character resolving and the next. */
  unlock?: number
  /** ms a character stays lit after it resolves. */
  flash?: number
}

function cell(glyph: string, state: CipherCellState): CipherCell {
  return { glyph, rune: null, state }
}

/** The same, for a glyph out of one of the noise pools. */
function noiseCell(noise: NoiseGlyph, state: CipherCellState): CipherCell {
  return { glyph: noise.text, rune: noise.rune, state }
}

/**
 * The line before the first frame of noise: every box held at its final
 * width, nothing painted in any of them.
 *
 * It has to exist as cells rather than as an empty array, because this is
 * what the very first render puts on screen — and a heading that renders
 * nothing for its first 320ms is a heading whose height is zero, which
 * moves every line of the hero underneath it.
 */
function blank(text: string): CipherCell[] {
  return [...text].map((character) => cell(character === ' ' ? ' ' : '', character === ' ' ? 'real' : 'blank'))
}

/**
 * Which characters stay unsolved, scattered rather than sampled.
 *
 * A uniform sample of six indices out of seventeen clumps often enough to
 * matter, and three sealed slots in a row stop reading as "six characters
 * are still encrypted" and start reading as "this word is missing". So each
 * pick also removes its immediate neighbours from the pool, which spreads
 * the sealed slots across the line — and, because the pool runs down faster than
 * it is drawn from, naturally lands on five or six rather than always the
 * number asked for.
 */
function pickHeld(indices: number[], count: number): Set<number> {
  const pool = [...indices]
  const held = new Set<number>()

  while (held.size < count && pool.length > 0) {
    const index = pool[Math.floor(Math.random() * pool.length)]
    held.add(index)
    for (let at = pool.length - 1; at >= 0; at -= 1) {
      if (Math.abs(pool[at] - index) <= 1) pool.splice(at, 1)
    }
  }

  return held
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * ТЗ §9 — the hero title's decode, in three movements instead of one.
 *
 * The first is `useScramble`'s: every character starts as noise and they
 * lock outward from the middle of the string. The difference begins where
 * that one ends — a handful of characters, picked at random on every load,
 * *do not* lock. They stay behind as sealed slots and go on churning
 * cipher → digit → letter for a couple of seconds while the rest of the
 * line sits there readable, and only then does the line finish, one
 * character at a time, each flashing as it gives itself up.
 *
 * The reason for the shape: a scramble that resolves cleanly says "the
 * page loaded". This says something closer to what the product claims —
 * most of the message is in the clear, a few values are still sealed, and
 * they come out one by one because they are being worked on. It is the
 * same claim the trajectory line makes further down the hero, made once at
 * headline size.
 *
 * Returns one cell per character, or `null` once the line has fully
 * resolved — at which point the caller has nothing left to animate and
 * should render the string plainly (see `CipherTitle`).
 */
export function useCipherReveal({
  text,
  enabled,
  delay = 0,
  duration = 600,
  hold = 6,
  churn = 2400,
  unlock = 280,
  flash = 420,
}: CipherRevealOptions): CipherCell[] | null {
  const [cells, setCells] = useState<CipherCell[] | null>(() =>
    enabled && !prefersReducedMotion() ? blank(text) : null,
  )

  useEffect(() => {
    if (!enabled || prefersReducedMotion()) {
      setCells(null)
      return
    }

    const characters = [...text]
    const letters = characters.flatMap((character, index) => (character === ' ' ? [] : [index]))
    const held = pickHeld(letters, hold)

    /*
     * Phase one, unchanged from `useScramble`: distance from the centre,
     * normalised, is what makes the line resolve outward from its middle
     * rather than typing itself left to right.
     */
    const centre = (characters.length - 1) / 2
    const reach = Math.max(centre, 1)
    const settle = duration * 0.45
    const travel = duration - settle
    const lockAt = characters.map((_, index) => (Math.abs(index - centre) / reach) * travel + settle)

    // Phase three: the held characters give themselves up in a random order,
    // so the line does not resolve left to right at the end either.
    const unlockAt = new Map<number, number>(
      shuffle([...held]).map((index, position) => [index, duration + churn + position * unlock]),
    )
    const done = duration + churn + held.size * unlock + flash

    // Each held character keeps its own flip clock, so the sealed slots are
    // never in step with one another — a row of glyphs changing on the same frame
    // reads as one animation rather than as several slots working.
    const flips = new Map<number, { noise: NoiseGlyph; cell: CipherCell; kind: number; at: number }>()

    /*
     * What the sealed slots are showing right now, minus the one about to
     * flip. Five slots drawing independently out of one pool land on the
     * same glyph constantly — and unlike the scramble, where a collision is
     * gone in 16ms, these hold theirs for about 150ms, which is long enough
     * to read three identical forms across the line and conclude the effect
     * is cycling four of them.
     */
    function showing(except: number): Set<NoiseGlyph> {
      const glyphs = new Set<NoiseGlyph>()
      for (const [index, flip] of flips) {
        if (index !== except) glyphs.add(flip.noise)
      }
      return glyphs
    }

    function churnCell(index: number, now: number): CipherCell {
      const current = flips.get(index)
      if (current && now < current.at) return current.cell

      const kind = current ? (current.kind + 1) % CHURN_POOLS.length : 0
      const taken = showing(index)
      // Its own previous glyph too: a slot that redraws the one it was
      // already holding looks like it stopped rather than like it flipped.
      if (current) taken.add(current.noise)

      const noise = pickGlyph(CHURN_POOLS[kind], taken)
      const next = { noise, cell: noiseCell(noise, 'cipher'), kind, at: now + 90 + Math.random() * 110 }
      flips.set(index, next)
      return next.cell
    }

    const start = performance.now() + delay
    let frame = 0
    // Cheap change detection. The churn only moves every ~150ms and most of
    // the line is settled text by then, so without this the whole heading
    // re-renders sixty times a second for two seconds to paint nothing new.
    let painted = ''

    const tick = (now: number) => {
      const elapsed = now - start
      frame = requestAnimationFrame(tick)

      // No form twice in one frame while the pool can afford it — see
      // `pickGlyph`. Held per frame rather than per run: the point is that
      // the line never shows a repeat at a glance, not that a form is spent
      // once and never drawn again.
      const drawn = new Set<NoiseGlyph>()
      const noise = () => {
        const glyph = pickGlyph(RUNE_NOISE, drawn)
        drawn.add(glyph)
        return glyph
      }

      const next = characters.map((character, index) => {
        if (character === ' ') return cell(' ', 'real')
        if (elapsed < 0) return cell('', 'blank')

        const resolvesAt = unlockAt.get(index)
        if (resolvesAt === undefined) {
          return elapsed >= lockAt[index] ? cell(character, 'real') : noiseCell(noise(), 'noise')
        }
        if (elapsed >= resolvesAt) {
          return cell(character, elapsed < resolvesAt + flash ? 'solved' : 'real')
        }
        return elapsed >= duration ? churnCell(index, now) : noiseCell(noise(), 'noise')
      })

      if (elapsed >= done) {
        cancelAnimationFrame(frame)
        setCells(null)
        return
      }

      const key = next.map((item) => item.state + item.glyph + (item.rune ?? '')).join('')
      if (key !== painted) {
        painted = key
        setCells(next)
      }
    }

    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [text, enabled, delay, duration, hold, churn, unlock, flash])

  return cells
}

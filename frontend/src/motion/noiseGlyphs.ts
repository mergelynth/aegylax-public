import { RUNES } from './runes'

/**
 * The vocabularies the decode paints noise in.
 *
 * One rule governs all of them, and it is the rule the hero title broke
 * three times: the noise stands *over* settled text at headline size, so
 * anything the page's own font cannot draw, or that is not the height of
 * the letters it stands among, reads as a broken line rather than as an
 * encrypted one.
 */

/**
 * The pool for noise that has to be *text*, because its host paints a whole
 * string at once and cannot size or draw one glyph inside it
 * (`useScramble`, and so the seal and the counters).
 *
 * Printable ASCII, all of it cap height. The shorter marks (`-`, `_`, `*`,
 * `=`, `<`) are deliberately absent — they sit mid-band and leave a hole in
 * the line. So are box-drawing and geometric characters (`█▓▒░■`), which no
 * font in the product's system-sans stack carries: the browser goes looking
 * for some other font on the machine for them, and what lands in the line
 * is either a glyph at foreign metrics or an empty tofu box.
 */
export const ASCII_GLYPHS = '#@%&$?/\\XKZQVWNM0123456789'

/**
 * One item of noise: either a character to print, or a form to draw.
 *
 * The hero title renders one element per character, which is what lets it
 * carry the second kind — see `runes` for why the noise there is drawn
 * rather than typed.
 */
export interface NoiseGlyph {
  /** The character to paint. Empty when this is a drawn form. */
  text: string
  /** The path of a fabricated glyph. `null` when this is a character. */
  rune: string | null
}

function characters(pool: string): readonly NoiseGlyph[] {
  return [...pool].map((text) => ({ text, rune: null }))
}

/** The unreadable script the title's noise and its sealed slots are in. */
export const RUNE_NOISE: readonly NoiseGlyph[] = RUNES.map((rune) => ({ text: '', rune }))

export const DIGIT_NOISE = characters('0123456789')

/** No `I` or `O`: at a glance they are the digits either side of them. */
export const LETTER_NOISE = characters('ABCDEFGHJKLMNPQRSTUVWXYZ')

/**
 * One glyph out of a pool, never one the frame is already showing.
 *
 * Uniform random is not what the eye reads as random here: nineteen
 * independent draws from one pool put the same glyph in three places often
 * enough that the line looks like it is cycling a handful of forms. The fix
 * is to draw from what is left rather than to re-roll until the collision
 * goes away — re-rolling is only *probably* fresh, and at the tail of a
 * frame, where most of the pool is spoken for, probably is not often
 * enough.
 *
 * Exhausted, it paints a repeat rather than failing: the caller may be
 * asking for more distinct glyphs than the pool has (the digits are ten
 * against nineteen boxes), and a frame is not the place to run out of
 * anything.
 */
export function pickGlyph<T>(pool: readonly T[], avoid?: ReadonlySet<T>): T {
  const free = avoid && avoid.size > 0 ? pool.filter((glyph) => !avoid.has(glyph)) : pool
  const from = free.length > 0 ? free : pool

  return from[Math.floor(Math.random() * from.length)]
}

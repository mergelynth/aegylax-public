/**
 * A script that does not exist, drawn rather than typed.
 *
 * Every earlier version of this line's noise was a *character* — block
 * elements, then ASCII marks — and both carried the same two problems,
 * because they are problems of using text as a picture. A character is
 * drawn by whatever font on the machine happens to have it, so it can
 * arrive at foreign metrics or as an empty tofu box; and it is drawn at
 * that font's proportions, so it is only ever approximately the height of
 * the letters it stands among.
 *
 * These are strokes on a lattice. Nothing looks them up, nothing can fail
 * to find them, and they are sized in `cap` units — so a fabricated glyph
 * is *exactly* as tall as the capitals beside it, on every machine, in
 * every font the stack falls back to.
 *
 * They also read as what the effect claims: not letters shuffling, not
 * symbols from some other keyboard, but something in a writing system the
 * page has not decoded yet.
 */

/**
 * The lattice: three columns, five rows, in a box a little wider than the
 * strokes so a square cap at the edge is not clipped.
 */
const COLUMNS = [0, 3, 6]
const ROWS = [0, 2.5, 5, 7.5, 10]
export const RUNE_VIEWBOX = '-1.2 -1.2 8.4 12.4'

/**
 * A fixed seed, so the alphabet is the same on every load and in every
 * test. It matters more than it looks: a "script" whose letterforms are
 * different every time the page opens is not a script, and half the reason
 * this reads as writing rather than as scribble is that the same forms come
 * back.
 */
function seeded(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function build(): string[] {
  const random = seeded(0x41454759)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]

  const alphabet: string[] = []
  const seen = new Set<string>()

  // Bounded rather than `while (alphabet.length < 48)`: the lattice is
  // finite and a generator that cannot find a fresh form must stop looking
  // rather than spin at module load.
  for (let attempt = 0; attempt < 2000 && alphabet.length < 48; attempt += 1) {
    /*
     * The spine: top row to bottom row, one row at a time, stepping at most
     * one column at each. The step limit is what makes these read as
     * written rather than as scribble — a stroke free to jump the full
     * width every row sweeps corner to corner and every form comes out the
     * same zigzag, where a stroke that can only lean produces uprights,
     * leaning stems and shallow angles the way a pen would.
     */
    let column = Math.floor(random() * COLUMNS.length)
    const spine = ROWS.map((y) => {
      column = Math.min(COLUMNS.length - 1, Math.max(0, column + Math.floor(random() * 3) - 1))
      return [COLUMNS[column], y] as const
    })
    const segments = spine.slice(1).map((point, index) => [spine[index], point] as const)

    /*
     * One to three marks hung off the spine — a bar to the side, a
     * diagonal, a stub. These are what make two forms with a similar spine
     * legibly different from one another.
     */
    const branches = 1 + Math.floor(random() * 3)
    for (let branch = 0; branch < branches; branch += 1) {
      const [x, y] = pick(spine)
      const toX = pick(COLUMNS.filter((column) => column !== x))
      const toY = pick(ROWS.filter((row) => Math.abs(row - y) <= 2.5))
      segments.push([[x, y], [toX, toY]] as const)
    }

    /*
     * Deduplicated as a *set of segments*, not as a path string. Two
     * branches can land on the same pair of points, and a branch can retrace
     * a length of spine; drawn twice it is invisible, but it costs the form
     * one of the two or three marks that were meant to tell it apart from
     * the others. Same reason the signature is sorted: two forms built from
     * the same strokes in a different order are one form.
     */
    const drawn = new Map<string, readonly [readonly [number, number], readonly [number, number]]>()
    for (const [from, to] of segments) {
      if (from[0] === to[0] && from[1] === to[1]) continue
      const ends = [`${from[0]} ${from[1]}`, `${to[0]} ${to[1]}`].sort()
      drawn.set(ends.join('-'), [from, to])
    }

    const signature = [...drawn.keys()].sort().join('|')
    if (drawn.size < 5 || seen.has(signature)) continue
    seen.add(signature)

    /*
     * The spine is emitted as one polyline so its corners join as corners;
     * the branches follow as their own subpaths.
     */
    const spineRun = `M${spine[0][0]} ${spine[0][1]}` + spine.slice(1).map(([x, y]) => `L${x} ${y}`).join('')
    const marks = [...drawn.values()]
      .slice(spine.length - 1)
      .map(([from, to]) => `M${from[0]} ${from[1]}L${to[0]} ${to[1]}`)

    alphabet.push(spineRun + marks.join(''))
  }

  return alphabet
}

/**
 * The alphabet itself: forty-odd forms, generated once at module load.
 *
 * Size is a visual property here rather than a detail. The line scrambles
 * nineteen characters at once and seals five or six of them for two and a
 * half seconds — against a pool of six, which is what the block elements
 * were, the same form lands in three places in a frame and the effect stops
 * reading as random. Against forty-eight, with `pickGlyph` refusing what is
 * already on screen, it never does.
 */
export const RUNES: readonly string[] = build()

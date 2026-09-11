import { motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { prefersReducedMotion } from '../../motion/prefersReducedMotion'
import { SEAL_BLOCKS_SCRAMBLE } from '../../motion/timeline'
import { useScramble } from '../../motion/useScramble'
import styles from './CipherBlocks.module.css'

export interface CipherBlocksProps {
  /** The theme's redaction glyph — `███ ███ ███` for Fhenix, dots elsewhere. */
  glyph: string
  /** Whether this mount is a document load, i.e. whether to decode first. */
  entering: boolean
  className?: string
}

/**
 * How the redaction is chunked, as the indices a gap follows.
 *
 * A fixed cycle rather than a shuffle, because this runs for as long as the
 * page is open and ТЗ is explicit that the trajectory block stays
 * predictable and calm — random re-chunking is the flashing it is supposed
 * not to be. Every arrangement holds the same nine glyphs in three groups,
 * so the line is exactly as wide in all four: only the seams move.
 */
const CHUNKINGS = [
  [2, 5],
  [1, 5],
  [2, 6],
  [3, 5],
] as const

/** How long each arrangement holds. Deliberately slower than the signal wave. */
const RECHUNK_MS = 3200

/**
 * Where the theme put its own gaps, as the block indices they follow.
 *
 * Used when the re-chunk is off — no seams to move, or motion declined — so
 * a resting line is drawn exactly as the theme wrote it rather than as
 * whichever arrangement happens to be first in the cycle.
 */
function themeSeams(glyph: string): number[] {
  const seams: number[] = []
  let blocks = 0
  for (const character of glyph) {
    if (/\s/.test(character)) {
      if (blocks > 0 && seams.at(-1) !== blocks - 1) seams.push(blocks - 1)
    } else {
      blocks++
    }
  }
  return seams
}

/**
 * ТЗ §12-§16 — the redacted trajectory, and the two things it does forever.
 *
 * **Once**, on a document load, the blocks resolve out of noise like every
 * other value in the hero — except that what they resolve *into* is a
 * redaction rather than a reading.
 *
 * **Then, forever**, two motions run at once and say different halves of
 * the same thing:
 *
 *   the *wave* — a signal travelling along the line, in CSS (see the
 *   stylesheet), which says ciphertext is being processed;
 *
 *   the *re-chunk* — the block boundaries themselves moving, which says the
 *   ciphertext has no fixed shape to read.
 *
 * The re-chunk is Motion's layout animation, and this is the one place in
 * the product where that earns its keep. Nine blocks, each a `motion.span`
 * with a stable key; changing which of them carries a trailing gap changes
 * every subsequent block's position, and `layout` springs each one from
 * where it was to where it now belongs. Nothing is measured, tweened or
 * positioned by hand — the blocks are laid out by the browser exactly as
 * before and Motion animates the difference.
 *
 * Reordering *identical* items is the trap here: nine indistinguishable
 * blocks swapped among themselves would animate perfectly and look like
 * nothing at all. What moves is the seams, which is why the arrangements
 * above are partitions rather than permutations.
 *
 * The glyph stays the theme's: same characters, same count, same three
 * groups, same width in every arrangement. A theme whose redaction has no
 * spaces in it renders as one block and simply never re-chunks.
 *
 * The one thing that does change is *how* the gaps are drawn. They were
 * space characters and are now a `1ch` margin on the block before them,
 * because a space cannot animate — it is text, and text either is or is not
 * there. As a margin the seam is a box the layout animation can carry, and
 * `1ch` in this line's mono face is exactly the width of the space it
 * replaces.
 */
export function CipherBlocks({ glyph, entering, className }: CipherBlocksProps) {
  const display = useScramble({
    text: glyph,
    enabled: entering,
    delay: SEAL_BLOCKS_SCRAMBLE.delay,
    duration: SEAL_BLOCKS_SCRAMBLE.duration,
  })

  const blocks = [...glyph.replace(/\s+/g, '')]
  const gapCount = glyph.split(/\s+/).filter(Boolean).length - 1
  /*
   * Only re-chunk a redaction that actually has seams to move, and only
   * when motion is wanted. Both are decided here rather than inside the
   * effect so the first render already draws the resting arrangement.
   */
  const canRechunk = gapCount > 0 && !prefersReducedMotion()
  const [chunking, setChunking] = useState(0)

  useEffect(() => {
    if (!canRechunk) return
    const timer = setInterval(() => setChunking((current) => (current + 1) % CHUNKINGS.length), RECHUNK_MS)
    return () => clearInterval(timer)
  }, [canRechunk])

  /*
   * Hidden from assistive tech in its entirety, in both phases. The line's
   * meaning is carried by the words around it — "Trajectory", "encrypted" —
   * and a screen reader reading nine block characters learns nothing except
   * that there are nine of them.
   */
  if (display !== glyph) {
    return (
      <span className={className} aria-hidden="true">
        {display}
      </span>
    )
  }

  // The theme's own seams when there is nothing to animate; the current
  // arrangement when there is.
  const seams: readonly number[] = canRechunk ? CHUNKINGS[chunking] : themeSeams(glyph)

  return (
    <span className={className} aria-hidden="true">
      {blocks.map((block, index) => (
        <motion.span
          key={index}
          layout
          /*
           * Stiff and well damped: the seams should arrive, not glide. A
           * loose spring on a line of mono type reads as the text being
           * dragged rather than as data being re-chunked.
           */
          transition={{ type: 'spring', stiffness: 420, damping: 34, mass: 0.7 }}
          className={styles.block}
          /*
            Position in the signal wave, kept on the block's *index* rather
            than on which group it currently sits in — so the wave goes on
            sweeping left to right at a steady rate while the seams move
            underneath it. Three blocks to a step, which leaves steps 3 and 4
            for the ENCRYPTED badge and the provider credit (`app/motion.css`).
          */
          style={{
            ['--wave-step' as string]: Math.floor((index * 3) / blocks.length),
            marginRight: seams.includes(index) ? '1ch' : undefined,
          }}
        >
          {block}
        </motion.span>
      ))}
    </span>
  )
}

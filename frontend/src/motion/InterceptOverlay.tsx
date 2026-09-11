import { motion, type Variants } from 'motion/react'
import type { InterceptPhase } from './useInterceptPass'
import styles from './InterceptOverlay.module.css'

/**
 * Where the character under the pass actually is, in pixels relative to the
 * heading — measured from the DOM by `CipherTitle`, never assumed.
 *
 * Everything drawn here is geometry the text half cannot express. The
 * heading is centred, wraps at two different sizes and is set in whatever
 * font the machine resolved, so the only honest source for "where is that
 * letter" is the letter's own box.
 */
export interface InterceptFrame {
  x: number
  y: number
  width: number
  height: number
  /** The heading's own width — the run the interceptor has to cross. */
  hostWidth: number
  /** The heading's computed font size, in px. Everything drawn here is a
      fraction of it — see `TYPE` below. */
  fontSize: number
}

/**
 * The instrument's proportions, as fractions of the heading's own type.
 *
 * Sized against the font rather than against the measured box, and that is
 * the whole reason the font size is measured at all. A character's box is a
 * *line* box: it is as tall as the line-height, which is leading the letter
 * does not fill. Bracketing that box puts a reticle around a letter with a
 * finger of empty space above and below it, and how much depends on a
 * line-height set three files away. A cap is the letter.
 *
 * `cap` is 0.72em for the grotesques in the product's stack, which is the
 * same approximation `.rune` carries as its own fallback.
 */
const TYPE = {
  cap: 0.72,
  /** Clear air between the character and the bracket that holds it. */
  gap: 0.1,
  /** How far the bracket's arms reach in over the character. */
  arm: 0.16,
  /**
   * The em box is centred in the line box by half-leading, and the cap band
   * sits a little above the em box's own middle — it has no descender under
   * it. Without this the reticle rides low on the letter.
   */
  rise: 0.05,
} as const

/**
 * The reticle, per beat.
 *
 * `custom` is the bracket's own reach: the side it is on (-1 left, +1
 * right) times the heading's em, so one set of variants draws both
 * brackets, they converge symmetrically, and everything they do is a
 * fraction of the type they are closing on rather than a pixel count that
 * is a shrug at 1.6rem and a lurch at 2.6.
 *
 * They come in from outside the character, sit hard on it while it is
 * sealed, and are thrown outwards by the impact rather than fading politely
 * — the burst is what ends the lock, so the lock has to look like it was
 * ended. The one spring in the set is the moment they close: a lock lands,
 * it does not arrive.
 */
const BRACKET: Variants = {
  hidden: (reach: number) => ({ x: reach * 0.62, opacity: 0 }),
  sweep: (reach: number) => ({
    x: reach * 0.12,
    opacity: 0.62,
    transition: { duration: 0.5, ease: 'easeOut' },
  }),
  lock: { x: 0, opacity: 1, transition: { type: 'spring', stiffness: 420, damping: 24 } },
  strike: { x: 0, opacity: 1, transition: { duration: 0.12 } },
  burst: (reach: number) => ({
    x: reach * 0.42,
    opacity: 0,
    transition: { duration: 0.34, ease: 'easeOut' },
  }),
  cool: (reach: number) => ({ x: reach * 0.42, opacity: 0, transition: { duration: 0.2 } }),
}

/**
 * The interceptor's run and the impact ring — one linear tween and one
 * expanding circle, both on `transform` and `opacity` alone.
 *
 * These are Motion's rather than CSS keyframes' for one reason: their
 * geometry is measured. The interceptor's travel is "from the edge of the
 * heading to *this* letter", which is a pixel distance that exists only
 * after layout, and a keyframe cannot be written against a number the
 * stylesheet has never seen. Motion takes it as a prop, and because both
 * animations are a single transform component it can still hand them to the
 * browser to run off the main thread (see `BusySweep` for the same rule).
 */
const RUN = { duration: 0.28, ease: 'circIn' } as const
const RING = { duration: 0.9, ease: [0.16, 0.84, 0.3, 1] } as const

export interface InterceptOverlayProps {
  phase: InterceptPhase
  frame: InterceptFrame | null
}

/**
 * The HUD half of the hero title's pass: everything that is drawn *around*
 * the character rather than painted into it.
 *
 * It is a sibling of the text inside the heading, absolutely positioned and
 * `aria-hidden`, so nothing here can move a letter, add a break opportunity
 * or reach a screen reader. The character itself is painted by
 * `CipherTitle.module.css`; the two halves share only the phase name.
 */
export function InterceptOverlay({ phase, frame }: InterceptOverlayProps) {
  if (!frame) return null

  const em = frame.fontSize
  const centre = frame.x + frame.width / 2
  const middle = frame.y + frame.height / 2 - em * TYPE.rise
  // Whichever side has more room, so the run reads as a run rather than as
  // a spark appearing beside the letter.
  const fromLeft = centre >= frame.hostWidth / 2
  const gap = em * TYPE.gap
  const arm = em * TYPE.arm
  const band = em * TYPE.cap + gap * 2
  const ring = em * 1.05

  return (
    <span className={styles.layer} aria-hidden="true">
      {[-1, 1].map((side) => (
        <motion.span
          key={side}
          className={`${styles.bracket} ${side < 0 ? styles.left : styles.right}`}
          style={{
            left: side < 0 ? frame.x - gap - arm : frame.x + frame.width + gap,
            top: middle,
            width: arm,
            height: band,
            y: '-50%',
          }}
          custom={side * em}
          variants={BRACKET}
          initial="hidden"
          animate={phase}
        />
      ))}

      {phase === 'strike' ? (
        <motion.span
          className={`${styles.run} ${fromLeft ? styles.inbound : styles.inboundFlipped}`}
          style={
            fromLeft
              ? { left: 0, width: centre, top: middle }
              : { left: centre, width: Math.max(0, frame.hostWidth - centre), top: middle }
          }
          initial={{ x: fromLeft ? '-100%' : '100%' }}
          animate={{ x: 0 }}
          transition={RUN}
        />
      ) : null}

      {phase === 'burst' || phase === 'cool' ? (
        <motion.span
          className={styles.ring}
          style={{ left: centre, top: middle, width: ring, height: ring, x: '-50%', y: '-50%' }}
          initial={{ scale: 0.3, opacity: 0.9 }}
          animate={{ scale: 3.4, opacity: 0 }}
          transition={RING}
        />
      ) : null}
    </span>
  )
}

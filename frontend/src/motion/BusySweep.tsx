import { motion } from 'motion/react'
import { prefersReducedMotion } from './prefersReducedMotion'
import styles from './BusySweep.module.css'

/**
 * ТЗ §8-§10 — the wait, and the only way this product shows one.
 *
 * Every control that can be waited on wears this and nothing else: the
 * primary CTA in a modal, the icon-only probe on the console, the Defend
 * and Reveal controls beside it. Before, each of them had invented its own
 * — three breathing dots after a label, a charge ring pinging out of the
 * probe, a glyph pulsing inside it, and a label that simply changed word —
 * so "working" looked like four unrelated events depending on which button
 * you had pressed.
 *
 * A band of light crossing the control is the one idiom that survives every
 * shape it has to live in, which is what makes it the one that can be
 * shared. A ring pinging outwards cannot: `scale` is proportional, so the
 * same ping that travels eight pixels around a 44px circle travels forty
 * across a 200px pill, and the two stop looking like the same event. A
 * sweep is measured in the host's own width, so it reads identically on
 * both — and on a console whose whole vocabulary is scanning for a hidden
 * trajectory, it is also the honest picture of what the button is doing.
 *
 * Nothing here moves the label or changes the control's size: the layer is
 * absolutely positioned and clipped to the host's own silhouette, so a
 * pressed button neither reflows its row nor loses its wording.
 */

/**
 * Percentages of the beam's own width, so the travel is stated in the same
 * unit the beam is drawn in: it starts fully clear of one edge and ends
 * fully clear of the other whatever the host is shaped like.
 *
 * Written as whole `transform` strings rather than Motion's `x` shorthand,
 * and that is not a style choice. `x` is one component of a transform
 * Motion has to compose itself, so it drives the element from the main
 * thread every frame; `transform` is a value the browser can own outright,
 * and it is the name Motion checks before handing an animation to WAAPI.
 * Same pixels, none of the per-frame work.
 */
const TRAVEL = { transform: ['translateX(-135%)', 'translateX(135%)'] }

/**
 * One linear pass, restarted forever, and deliberately nothing more.
 *
 * A plain two-keyframe `linear` tween on a single transform value is what
 * keeps this on Motion's accelerated path: Motion hands it to the browser
 * as a WAAPI animation, so it runs off the main thread and a wait that
 * lasts a minute costs no React renders and no per-frame JavaScript at all.
 * Everything that would forfeit that has been kept out — a spring, an
 * `onUpdate`, a second transform component to compose (the beam's rake is a
 * gradient angle in CSS for exactly this reason), or any property that is
 * not `transform` or `opacity`.
 */
const CYCLE = { duration: 1.15, repeat: Infinity, ease: 'linear' } as const

export function BusySweep() {
  /*
   * ТЗ §20 — with motion off the wait is still *shown*, it just stops
   * moving: the band parks across the middle of the control at a lower
   * opacity. Rendering nothing at all would take the state away from
   * exactly the people who cannot see it announced any other way.
   */
  if (prefersReducedMotion()) {
    return (
      <span className={styles.sweep} aria-hidden="true">
        <span className={[styles.beam, styles.still].join(' ')} />
      </span>
    )
  }

  return (
    <span className={styles.sweep} aria-hidden="true">
      <motion.span className={styles.beam} animate={TRAVEL} transition={CYCLE} />
    </span>
  )
}

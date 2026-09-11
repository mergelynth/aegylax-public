import type { Ripple } from './useRipple'
import styles from './RippleLayer.module.css'

/**
 * The ink, painted inside whatever pressed. Purely decorative and
 * pointer-transparent — it must never come between the surface and the
 * click it is acknowledging.
 *
 * The host needs `position: relative` and `overflow: hidden` (and, if it is
 * rounded, its own radius) for the circle to be clipped to its shape.
 */
export function RippleLayer({ ripples }: { ripples: Ripple[] }) {
  if (ripples.length === 0) return null

  return (
    <span className={styles.layer} aria-hidden="true">
      {ripples.map((ripple) => (
        <span
          key={ripple.id}
          className={styles.ink}
          style={{ left: `${ripple.x}%`, top: `${ripple.y}%`, width: ripple.size, height: ripple.size }}
        />
      ))}
    </span>
  )
}

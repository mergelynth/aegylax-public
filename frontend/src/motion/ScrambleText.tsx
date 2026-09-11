import type { CSSProperties } from 'react'
import { useScramble } from './useScramble'
import styles from './ScrambleText.module.css'

export interface ScrambleTextProps {
  /** The real string. This is what a screen reader gets, always. */
  text: string
  /** Whether this mount is a document load (`useBootEntrance`). */
  enabled: boolean
  delay?: number
  duration?: number
  className?: string
  /**
   * Passed through to the rendered element, settled or not — which matters
   * because a caller may be feeding it a custom property that some *other*
   * animation reads (the trajectory line's `--wave-step`, for one). Dropping
   * it once the scramble finished would silently stop that animation at
   * exactly the moment the element started resting.
   */
  style?: CSSProperties
  /** Element to render as. Defaults to a span. */
  as?: 'span' | 'h1'
}

/**
 * ТЗ §4, §9, §16 — a string that decodes into place.
 *
 * Two things this component exists to get right, both of which a bare hook
 * would leave to every call site:
 *
 * **The noise never reaches assistive tech.** The animating layer is
 * `aria-hidden` and the real string sits on `aria-label`, so what is
 * announced is "SOMETHING IS COMING" from the first frame while the eye
 * still sees `#4/K@`. A scramble that reached a screen reader would emit a
 * new line of garbage sixty times a second.
 *
 * **The layout never moves.** A ghost copy of the real text, hidden with
 * `visibility` rather than removed, sets the box; the scrambling layer is
 * painted over it and takes no space. Without that, a proportional font
 * makes every frame a different width — and on a centred hero title, a
 * width that changes per frame is a title that visibly shivers. The ghost
 * costs one extra text node and removes the entire class of problem.
 */
export function ScrambleText({
  text,
  enabled,
  delay,
  duration,
  className,
  style,
  as = 'span',
}: ScrambleTextProps) {
  const display = useScramble({ text, enabled, delay, duration })
  const Tag = as
  const settled = display === text

  /*
    Once it has resolved there is nothing left to hide or to measure, so the
    component gets out of the way and renders the string plainly — no ghost,
    no aria-label shadowing the content, nothing for the rest of the page to
    have to reason about.
  */
  if (settled)
    return (
      <Tag className={className} style={style}>
        {text}
      </Tag>
    )

  return (
    <Tag className={className} style={style} aria-label={text}>
      <span className={styles.frame}>
        <span className={styles.ghost} aria-hidden="true">
          {text}
        </span>
        <span className={styles.live} aria-hidden="true">
          {display}
        </span>
      </span>
    </Tag>
  )
}

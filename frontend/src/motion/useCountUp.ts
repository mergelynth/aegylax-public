import { useEffect, useRef, useState } from 'react'
import { prefersReducedMotion } from './prefersReducedMotion'

/** ms the roll takes. ТЗ §5 asks for 300–500ms — short enough to read as initialization. */
const COUNT_MS = 420

/**
 * How long after mount a first figure still counts as "arriving with the
 * page".
 *
 * The counters are fed by the chain, and the chain answers when it answers
 * (ТЗ §32 keeps the visual sequence off the network). A figure that lands
 * inside this window is part of the boot and rolls up; one that lands eight
 * seconds later is just data arriving, and rolling it then would draw the
 * eye to the header long after the page settled.
 */
const ARRIVAL_GRACE_MS = 3000

/** Ease-out cubic — the same curve the CSS half of the sequence uses. */
function easeOut(t: number): number {
  return 1 - (1 - t) ** 3
}

/**
 * ТЗ §5 — "Number trend", as an initialization rather than an ornament.
 *
 * The referenced example is Motion+ (ТЗ §34), so this is its behaviour on
 * primitives: the first figure a metric ever shows is run up to from zero
 * over a few hundred milliseconds, and after that the number is simply the
 * number. That distinction is the entire point of the rule — a HUD whose
 * digits roll every time the chain pushes an update is an arcade cabinet,
 * and this one is meant to read as telemetry coming online once.
 *
 * Values are passed through untouched whenever they are not a number, which
 * is how the "—" every metric starts at survives: there is nothing to count
 * to until the chain answers.
 */
export function useCountUp(value: number | string, enabled: boolean): number | string {
  const [display, setDisplay] = useState<number | string>(value)
  /*
   * One roll per mount, ever. Latched rather than derived, because the
   * condition that starts the roll (a number appearing) is true again on
   * every later update, and this is what makes it fire only the first time.
   */
  const spent = useRef(false)
  const mountedAt = useRef(performance.now())
  const frame = useRef(0)

  useEffect(() => {
    const late = performance.now() - mountedAt.current > ARRIVAL_GRACE_MS
    if (spent.current || !enabled || late || typeof value !== 'number' || prefersReducedMotion()) {
      setDisplay(value)
      return
    }

    spent.current = true
    const target = value
    const start = performance.now()

    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / COUNT_MS)
      // Rounded, never truncated: the last frame has to land exactly on the
      // target, and `Math.floor` on an eased progress can leave it a digit
      // short at 0.999.
      setDisplay(Math.round(easeOut(progress) * target))
      if (progress < 1) frame.current = requestAnimationFrame(tick)
    }

    frame.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame.current)
  }, [value, enabled])

  return display
}

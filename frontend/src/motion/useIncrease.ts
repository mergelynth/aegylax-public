import { useEffect, useRef, useState } from 'react'

/**
 * A pulse whenever a number goes *up*.
 *
 * The product is full of counters that are fed by the chain — players in an
 * operation, probes a wallet owns — and every one of them used to change the
 * way a variable changes: the old digit was there, then the new one was.
 * Somebody joining an operation you are sitting in is an event, and an event
 * that reaches the screen as a silently different character is one the player
 * finds by re-reading rather than by noticing.
 *
 * Returns a number that changes each time the value rises. Used as a `key`,
 * that restarts the element's CSS animation — which is the whole trick, and
 * why this hook has no timers, no state machine and nothing to clean up: the
 * hook decides *that* something arrived, the stylesheet decides what arriving
 * looks like, and neither knows about the other.
 *
 * Only upward. A count that falls is a probe being spent or a player leaving
 * — a consequence of something the player just did, which does not need to be
 * announced back to them.
 */
export function useIncrease(value: number): number {
  const previous = useRef(value)
  const [pulse, setPulse] = useState(0)

  useEffect(() => {
    // The first value a component ever sees is not an arrival: it is what was
    // already true when the panel opened.
    if (value > previous.current) setPulse((count) => count + 1)
    previous.current = value
  }, [value])

  return pulse
}

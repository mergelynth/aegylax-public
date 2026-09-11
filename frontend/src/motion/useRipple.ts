import { useCallback, useRef, useState, type PointerEvent } from 'react'
import { prefersReducedMotion } from './prefersReducedMotion'

export interface Ripple {
  id: number
  /** Percent of the host's box, so the ink stays put if the host resizes mid-animation. */
  x: number
  y: number
  /** Diameter in px: far enough to reach the corner furthest from the press. */
  size: number
}

/** Must outlast the `ripple-ink` keyframes in `Ripple.module.css`. */
const RIPPLE_MS = 560

/**
 * ТЗ §14, §28 — "Material Design: Ripple", kept to the one thing a ripple
 * is for.
 *
 * It answers *where you pressed*. That is the whole of its job here: a
 * circle leaves the press point, reaches the far corner, and is gone. No
 * bounce, no rotation, no scale beyond the small compression the button
 * does in CSS — ТЗ §14 rules all three out, and they are what turn a
 * confirmation into a toy.
 *
 * On `pointerdown` rather than `click`, which is what makes it read as
 * acknowledgement instead of aftermath: the ink is already travelling
 * while the finger is still down, and the action it belongs to runs on the
 * click as it always did. Nothing here touches the handler — see `Button`.
 */
export function useRipple() {
  const [ripples, setRipples] = useState<Ripple[]>([])
  const nextId = useRef(0)

  const spawnRipple = useCallback((event: PointerEvent<HTMLElement>) => {
    if (prefersReducedMotion()) return

    const box = event.currentTarget.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) return

    const x = event.clientX - box.left
    const y = event.clientY - box.top
    /*
     * The circle has to cover the whole surface however off-centre the
     * press was, so its radius is the distance to the furthest corner —
     * which is the furthest x edge and the furthest y edge, together.
     */
    const reachX = Math.max(x, box.width - x)
    const reachY = Math.max(y, box.height - y)
    const size = 2 * Math.hypot(reachX, reachY)

    const id = nextId.current++
    setRipples((current) => [...current, { id, x: (x / box.width) * 100, y: (y / box.height) * 100, size }])
    // Self-cleaning rather than waiting for an `animationend` that never
    // arrives if the button unmounts or the tab is backgrounded mid-press.
    setTimeout(() => setRipples((current) => current.filter((ripple) => ripple.id !== id)), RIPPLE_MS)
  }, [])

  return { ripples, spawnRipple }
}

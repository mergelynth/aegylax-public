import { motion } from 'motion/react'
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { prefersReducedMotion } from '../../motion/prefersReducedMotion'
import styles from './ArcControl.module.css'

/*
 * The arc's geometry, in the SVG's own units.
 *
 * A half circle opening downwards: 180° is the left end, 270° the top, 360°
 * the right end. Deliberately not a full rotary knob — a knob asks which way
 * round it is wound and needs a pointer to answer, while a cap arc is read
 * left-to-right like everything else on the screen and cannot be ambiguous.
 */
const CX = 40
const CY = 40
const R = 33
const START_ANGLE = 180
const SWEEP = 180
/** Gap between segments, in degrees — small enough to read as one arc, wide enough to count. */
const GAP = 2.4
/** Above this a segment per step stops reading as calibration and starts reading as noise. */
const MAX_SEGMENTS = 20

function pointOnArc(angleDegrees: number): [number, number] {
  const radians = (angleDegrees * Math.PI) / 180
  return [CX + R * Math.cos(radians), CY + R * Math.sin(radians)]
}

/** One segment of the arc, as an SVG path. */
function segmentPath(fromAngle: number, toAngle: number): string {
  const [x1, y1] = pointOnArc(fromAngle)
  const [x2, y2] = pointOnArc(toAngle)
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${R} ${R} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`
}

/**
 * Pointer capture, where it exists.
 *
 * Capture is what keeps a drag attached once the pointer leaves the arc —
 * most fee adjustments overshoot. It is an enhancement rather than a
 * requirement: without it the element's own events still drive the value
 * for as long as the pointer is over the dial. Throwing here would take
 * the whole press with it, which is how a click used to stick: the
 * capture was taken, the release threw, and the next field's pointer
 * events kept being retargeted at a fee that thought it was still held.
 */
function capture(element: Element, pointerId: number, held: boolean): void {
  try {
    if (held) element.releasePointerCapture(pointerId)
    else element.setPointerCapture(pointerId)
  } catch {
    // No capture available; the drag falls back to the arc's own events.
  }
}

export interface ArcControlProps {
  label: string
  value: number
  onChange: (value: number) => void
  min: number
  max: number
  step?: number
  /** The live figure, drawn inside the arc — the thing being read. */
  readout: ReactNode
  startLabel?: ReactNode
  endLabel?: ReactNode
  /** Spoken value, when the raw number is not the whole story ("15 percent"). */
  valueText?: string
  hint?: ReactNode
  /** Replaces the hint and switches the control to its error state. */
  error?: string
}

/**
 * A share of an allowance, drawn as a lit arc and set by dragging along it.
 *
 * This is the creator fee's control, and the choice is about what the value
 * *is*. A fee is not an amount, it is a fraction of a ceiling the protocol
 * set — so the question a creator is actually answering is "how much of what
 * I'm allowed am I taking", and an arc filling towards its end answers that
 * before the number is read. A number field answers it with arithmetic
 * against a limit written underneath.
 *
 * Segmented rather than a smooth sweep, because the value is whole percents:
 * the segments are the steps, so the control cannot suggest a precision it
 * does not have.
 *
 * **The readout is never the decoration.** ТЗ's own rule for this screen is
 * that the *interaction* is futuristic and the *reading* is not — so the
 * figure sits in the middle of the arc at full contrast, and the arc is what
 * dims at rest. Somebody who never touches it still just sees 15%.
 *
 * It is an ARIA slider rather than a styled `<input type="range">`: a range
 * input's drag is linear along one axis, which is the one thing this control
 * is not. Everything that costs — the role, the value semantics, arrow keys,
 * Home/End, Page Up/Down — is implemented here rather than inherited, and
 * that is the price of the geometry.
 */
export function ArcControl({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  readout,
  startLabel,
  endLabel,
  valueText,
  hint,
  error,
}: ArcControlProps) {
  const id = useId()
  const describedById = `${id}-description`
  const arcRef = useRef<SVGSVGElement>(null)
  /**
   * Whether a press is currently a drag. A ref, not state: `pointerup`
   * often lands in the same tick as `pointerdown`, and a `useState` gate
   * would still read `false` on that up — capture stays held, and the
   * next field the pointer visits keeps moving the fee.
   */
  const draggingRef = useRef(false)
  const releaseRef = useRef<(() => void) | null>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => () => releaseRef.current?.(), [])

  const span = Math.max(1, max - min)
  const fraction = Math.min(1, Math.max(0, (value - min) / span))
  const steps = Math.max(1, Math.round(span / step))
  const segments = Math.min(steps, MAX_SEGMENTS)
  const filled = Math.round(fraction * segments)

  const commit = useCallback(
    (next: number) => {
      const snapped = min + Math.round((next - min) / step) * step
      const decimals = (String(step).split('.')[1] ?? '').length
      onChange(Number(Math.min(max, Math.max(min, snapped)).toFixed(decimals)))
    },
    [min, max, step, onChange],
  )

  /**
   * Where on the arc the pointer is, as a value.
   *
   * Anything below the arc's diameter has no angle on it, so it resolves to
   * whichever end it is nearest — which is what lets a drag run past the end
   * and stay pinned there instead of snapping to the far side.
   */
  const valueAtPointer = useCallback(
    (clientX: number, clientY: number): number => {
      const svg = arcRef.current
      if (!svg) return value
      const box = svg.getBoundingClientRect()
      const scale = box.width / 80
      const dx = (clientX - box.left) / scale - CX
      const dy = (clientY - box.top) / scale - CY
      if (dy > 0) return dx < 0 ? min : max

      const degrees = (Math.atan2(dy, dx) * 180) / Math.PI + 360
      return min + ((degrees - START_ANGLE) / SWEEP) * span
    },
    [value, min, max, span],
  )

  const stopDrag = (element: Element, pointerId: number) => {
    if (!draggingRef.current) return
    draggingRef.current = false
    setDragging(false)
    capture(element, pointerId, true)
  }

  const endDrag = (event: PointerEvent<SVGSVGElement>) => {
    stopDrag(event.currentTarget, event.pointerId)
  }

  const handlePointerDown = (event: PointerEvent<SVGSVGElement>) => {
    // Secondary and middle presses are not drags; a pointer event with no
    // `button` at all (a synthesised one) is treated as primary.
    if (event.button > 0) return
    const target = event.currentTarget
    const pointerId = event.pointerId
    releaseRef.current?.()
    draggingRef.current = true
    setDragging(true)
    capture(target, pointerId, false)
    commit(valueAtPointer(event.clientX, event.clientY))

    // Window, not the SVG: a click that lands on the neighbouring field
    // (the deadline picker beside this fee) used to never deliver `pointerup`
    // back to the arc, so the capture stayed and the fee kept tracking.
    const up = (upEvent: globalThis.PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return
      releaseRef.current?.()
    }
    releaseRef.current = () => {
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      releaseRef.current = null
      stopDrag(target, pointerId)
    }
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const handlePointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (!draggingRef.current) return
    // A missed `pointerup` used to leave this tracking forever. No buttons
    // down means the press is over, even if the up never reached us.
    if (event.buttons === 0) {
      endDrag(event)
      return
    }
    commit(valueAtPointer(event.clientX, event.clientY))
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const jump = step * 5
    const next =
      event.key === 'ArrowRight' || event.key === 'ArrowUp'
        ? value + step
        : event.key === 'ArrowLeft' || event.key === 'ArrowDown'
          ? value - step
          : event.key === 'PageUp'
            ? value + jump
            : event.key === 'PageDown'
              ? value - jump
              : event.key === 'Home'
                ? min
                : event.key === 'End'
                  ? max
                  : null
    if (next === null) return
    event.preventDefault()
    commit(next)
  }

  const perSegment = SWEEP / segments

  return (
    <div className={`${styles.field} ${error ? styles.invalid : ''} ${dragging ? styles.dragging : ''}`}>
      <span className={styles.label} id={`${id}-label`}>
        {label}
      </span>
      <div className={styles.row}>
        {startLabel ? <span className={styles.end}>{startLabel}</span> : null}
        <div
          className={styles.dial}
          role="slider"
          tabIndex={0}
          aria-labelledby={`${id}-label`}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          aria-valuetext={valueText}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedById}
          onKeyDown={handleKeyDown}
        >
          <svg
            ref={arcRef}
            className={styles.arc}
            viewBox="0 0 80 44"
            aria-hidden="true"
            focusable="false"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onLostPointerCapture={endDrag}
          >
            {Array.from({ length: segments }, (_, index) => {
              const from = START_ANGLE + index * perSegment + GAP / 2
              const to = START_ANGLE + (index + 1) * perSegment - GAP / 2
              const lit = index < filled
              return (
                <motion.path
                  key={index}
                  className={lit ? styles.segmentLit : styles.segment}
                  d={segmentPath(from, to)}
                  initial={false}
                  /*
                   * ТЗ §1 — the arc lights up rather than snapping on, and
                   * each segment carries its own light. Opacity alone, so a
                   * fee dragged from 0 to 15 is fifteen cheap crossfades
                   * rather than a re-layout.
                   */
                  animate={{ opacity: lit ? 1 : 0.28 }}
                  transition={prefersReducedMotion() ? { duration: 0 } : { duration: 0.14, ease: 'easeOut' }}
                />
              )
            })}
          </svg>
          {/* The value, at full contrast, inside the bowl the arc makes. */}
          <span className={styles.readout}>{readout}</span>
        </div>
        {endLabel ? <span className={styles.end}>{endLabel}</span> : null}
      </div>
      <span id={describedById} className={styles.note} role={error ? 'alert' : undefined}>
        {error ?? hint}
      </span>
    </div>
  )
}

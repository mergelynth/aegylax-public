import { motion } from 'motion/react'
import { useCallback, useId, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { prefersReducedMotion } from '../../motion/prefersReducedMotion'
import styles from './CapacityRange.module.css'

/**
 * ТЗ §15 — the handle follows the value on a spring rather than jumping to
 * it. Stiff enough that a drag never feels behind the pointer; the give is
 * only visible on a click that lands somewhere else on the rail, on a
 * keyboard step, or on a clamp against the other handle — which is exactly
 * where it reads as a control rather than an animation.
 */
const THUMB_SPRING = { type: 'spring', stiffness: 700, damping: 40, mass: 0.5 } as const

/**
 * Above this, a tick per player stops being calibration and becomes a
 * hatched bar. The band and the two figures still say everything; the ticks
 * are what make it read as an instrument rather than a slider, and they
 * only do that while they can be counted.
 */
const MAX_TICKS = 32

/** Movement below this is still the press that started it, not a direction. */
const DRAG_THRESHOLD = 2

/**
 * Pointer capture, where it exists.
 *
 * Capture is what keeps a drag attached to the rail once the pointer leaves
 * it, which is most drags — people overshoot. It is an enhancement rather
 * than a requirement though: without it the element's own pointer events
 * still drive the handle for as long as the pointer is over the rail, so a
 * platform that refuses the call (or does not implement it at all) gets a
 * slightly shorter leash rather than a control that does nothing. Throwing
 * here would take the whole press with it.
 */
function capture(element: Element, pointerId: number, held: boolean): void {
  try {
    if (held) element.releasePointerCapture(pointerId)
    else element.setPointerCapture(pointerId)
  } catch {
    // No capture available; the drag falls back to the rail's own events.
  }
}

type Handle = 'lower' | 'upper'

function percentOf(value: number, min: number, max: number): number {
  if (max <= min) return 0
  return ((Math.min(max, Math.max(min, value)) - min) / (max - min)) * 100
}

export interface CapacityRangeProps {
  label: string
  /** Names the two handles for assistive tech, e.g. `['Min players', 'Max players']`. */
  handleLabels: [string, string]
  lower: number
  upper: number
  onChange: (lower: number, upper: number) => void
  min: number
  max: number
  step?: number
  /** The live figures, rendered opposite the label (ТЗ §13). */
  readout: ReactNode
  startLabel?: ReactNode
  endLabel?: ReactNode
  hint?: ReactNode
  /** Replaces the hint and switches the control to its error state. */
  error?: string
}

/**
 * ТЗ §2, §4 — a capacity band: two handles on one segmented rail, with the
 * span between them lit.
 *
 * The parameter is a *range*, and this is the only drawing of it that says
 * so. Two number fields state two figures and leave the reader to notice
 * they constrain each other; a band with a lit middle says "between these,
 * out of this" in one shape, before anything is read.
 *
 * Segmented rather than smooth because players are whole and discrete. The
 * ticks are the actual positions the handles can occupy, so the rail is a
 * calibration scale rather than a continuous slider pretending the value
 * could land anywhere — and counting them answers "how much room is left"
 * without a second number.
 *
 * **The rail owns the pointer; the inputs own the keyboard.**
 *
 * The two native `<input type="range">` elements are still here and still
 * carry everything that costs to reproduce — the slider role, the value
 * semantics, arrow keys, Home and End, and the focus ring assistive tech
 * follows. What they no longer do is receive presses. Stacked inputs can
 * only be made to work by disabling pointer events on the input and
 * re-enabling them on its native thumb, and that arrangement has a hole in
 * it: a press anywhere on the *track* lands on nothing at all, so the rail
 * could be dragged but not clicked, which is the one thing every slider a
 * player has ever used does.
 *
 * So the press is handled here, from the scale's own box, and it does the
 * thing a click on a rail should do: the nearer handle moves to where you
 * pressed, takes focus, and keeps following the pointer if the press turns
 * into a drag. The arc control beside this one pays the same price for a
 * different reason, and says so.
 *
 * The handles cannot cross: each clamps against the other, so "max below
 * min" is a state this control has no way to express. The validator still
 * rejects it, because a config can arrive from somewhere other than this
 * screen — but nobody will meet that error by dragging.
 */
export function CapacityRange({
  label,
  handleLabels,
  lower,
  upper,
  onChange,
  min,
  max,
  step = 1,
  readout,
  startLabel,
  endLabel,
  hint,
  error,
}: CapacityRangeProps) {
  const id = useId()
  const describedById = `${id}-description`
  const lowerPercent = percentOf(lower, min, max)
  const upperPercent = percentOf(upper, min, max)

  const positions = Math.floor((max - min) / step) + 1
  const ticks = positions > 1 && positions <= MAX_TICKS ? positions : 0

  /**
   * The coordinate space every position on this control is measured in.
   *
   * Inset from the rail by the handle's own radius, so a handle at the
   * minimum sits with its centre on the first tick rather than half of it
   * hanging off the end — and so the value the pointer resolves to is the
   * value the handle under it is drawn at. Ticks, band, handles and the
   * pointer maths all read this one box; measuring any of them separately is
   * how a rail ends up where a click lands a step away from the mark it
   * appeared to hit.
   */
  const scaleRef = useRef<HTMLSpanElement>(null)
  const lowerRef = useRef<HTMLInputElement>(null)
  const upperRef = useRef<HTMLInputElement>(null)
  /** The press in progress: which handle it grabbed, and where it started. */
  const grab = useRef<{ handle: Handle | null; startX: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  const valueAt = useCallback(
    (clientX: number): number => {
      const box = scaleRef.current?.getBoundingClientRect()
      if (!box || box.width === 0) return min
      const fraction = Math.min(1, Math.max(0, (clientX - box.left) / box.width))
      const snapped = min + Math.round((fraction * (max - min)) / step) * step
      return Math.min(max, Math.max(min, snapped))
    },
    [min, max, step],
  )

  const move = (handle: Handle, next: number) =>
    handle === 'lower' ? onChange(Math.min(next, upper), upper) : onChange(lower, Math.max(next, lower))

  /**
   * Which handle a press at this value should take.
   *
   * `null` only when both handles are on the same value *and* the press
   * landed on them — there is no nearer one, and no direction to infer yet,
   * so the choice waits for the first movement. Deciding it eagerly is what
   * used to leave a collided pair with one handle that could never travel
   * again: whichever was picked clamps immediately against the other.
   */
  const handleAt = (value: number): Handle | null => {
    if (value < lower) return 'lower'
    if (value > upper) return 'upper'
    if (lower === upper) return null
    return value - lower <= upper - value ? 'lower' : 'upper'
  }

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    // Secondary and middle presses are not drags; a pointer event with no
    // `button` at all (a synthesised one) is treated as primary.
    if (event.button > 0) return
    capture(event.currentTarget, event.pointerId, false)
    setDragging(true)

    const at = valueAt(event.clientX)
    const handle = handleAt(at)
    grab.current = { handle, startX: event.clientX }
    if (!handle) return

    move(handle, at)
    // The handle a press took is the one the arrow keys should continue.
    ;(handle === 'lower' ? lowerRef : upperRef).current?.focus()
  }

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const press = grab.current
    if (!press) return

    let handle = press.handle
    if (!handle) {
      // The collided pair, resolved by where the drag is going: away from
      // the pile in either direction moves the handle that has room.
      const dx = event.clientX - press.startX
      if (Math.abs(dx) < DRAG_THRESHOLD) return
      handle = dx > 0 ? 'upper' : 'lower'
      grab.current = { ...press, handle }
      ;(handle === 'lower' ? lowerRef : upperRef).current?.focus()
    }

    move(handle, valueAt(event.clientX))
  }

  const endPress = (event: PointerEvent<HTMLDivElement>) => {
    if (!grab.current) return
    grab.current = null
    setDragging(false)
    capture(event.currentTarget, event.pointerId, true)
  }

  const spring = prefersReducedMotion() ? { duration: 0 } : THUMB_SPRING

  return (
    <div className={`${styles.field} ${error ? styles.invalid : ''}`}>
      <div className={styles.head}>
        <span className={styles.label} id={`${id}-label`}>
          {label}
        </span>
        <span className={styles.readout}>{readout}</span>
      </div>
      <div className={styles.row}>
        {startLabel ? <span className={styles.end}>{startLabel}</span> : null}
        <div
          className={`${styles.rail} ${dragging ? styles.dragging : ''}`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endPress}
          onPointerCancel={endPress}
        >
          <span className={styles.scale} ref={scaleRef}>
            {/* The calibration: one mark per position a handle can land on. */}
            {ticks > 0
              ? Array.from({ length: ticks }, (_, index) => {
                  const at = (index / (ticks - 1)) * 100
                  return (
                    <span
                      key={index}
                      className={at >= lowerPercent && at <= upperPercent ? styles.tickLit : styles.tick}
                      style={{ left: `${at}%` }}
                      aria-hidden="true"
                    />
                  )
                })
              : null}
            <span
              className={styles.band}
              style={{ left: `${lowerPercent}%`, right: `${100 - upperPercent}%` }}
              aria-hidden="true"
            />
            {/*
              Each input is followed immediately by the handle it drives, so
              the focus trace can be written as `input:focus-visible + .thumb`
              and light exactly one of them. Ordered any other way, a sibling
              selector reaches both handles and tabbing to one lights the pair.
            */}
            <input
              ref={lowerRef}
              className={styles.input}
              type="range"
              min={min}
              max={max}
              step={step}
              value={lower}
              aria-label={handleLabels[0]}
              aria-invalid={error ? true : undefined}
              aria-describedby={describedById}
              onChange={(event) => onChange(Math.min(Number(event.target.value), upper), upper)}
            />
            <motion.span
              className={styles.thumb}
              aria-hidden="true"
              initial={false}
              animate={{ left: `${lowerPercent}%` }}
              transition={spring}
            />
            <input
              ref={upperRef}
              className={styles.input}
              type="range"
              min={min}
              max={max}
              step={step}
              value={upper}
              aria-label={handleLabels[1]}
              aria-invalid={error ? true : undefined}
              aria-describedby={describedById}
              onChange={(event) => onChange(lower, Math.max(Number(event.target.value), lower))}
            />
            <motion.span
              className={styles.thumb}
              aria-hidden="true"
              initial={false}
              animate={{ left: `${upperPercent}%` }}
              transition={spring}
            />
          </span>
        </div>
        {endLabel ? <span className={styles.end}>{endLabel}</span> : null}
      </div>
      <span id={describedById} className={styles.note} role={error ? 'alert' : undefined}>
        {error ?? hint}
      </span>
    </div>
  )
}

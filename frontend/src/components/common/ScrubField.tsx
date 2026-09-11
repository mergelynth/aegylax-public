import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react'
import styles from './ScrubField.module.css'

/** How far the pointer travels for one step while scrubbing. */
const PX_PER_STEP = 8
/** Movement below this is a click, above it a drag. */
const DRAG_THRESHOLD = 3

export interface ScrubFieldProps {
  label: string
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  /** Muted unit beside the figure, never part of the editable text. */
  suffix?: string
  hint?: ReactNode
  /** Replaces the hint and switches the control to its error state. */
  error?: string
}

/** Decimal places implied by the step, so scrubbing 0.0001s leaves no float tail. */
function decimalsOf(step: number): number {
  return (String(step).split('.')[1] ?? '').length
}

/**
 * ТЗ §5 — an amount as a figure you manipulate directly, not a form field
 * with a stepper bolted to it.
 *
 * Three ways in, in the order they are reached for:
 *
 *   - **drag** across the figure and it scrubs, one step per 8px. This is
 *     the one the interface is built around: an entry fee is chosen by
 *     feel, against the other numbers on the screen, and a drag is the only
 *     input that lets somebody *look for* a value rather than commit to one;
 *   - **click** and it is an ordinary text field, because a creator who
 *     already knows they want 0.0025 should not have to drag there;
 *   - **arrows** step it, for anybody on a keyboard.
 *
 * The −/+ pair stays, deliberately small and to one side: a secondary
 * affordance for a fine correction, rather than the primary way to move a
 * value the way the old stepper was.
 *
 * It is a text input carrying `role="spinbutton"` rather than
 * `<input type="number">`, for the reason the form has always needed: a
 * native number input formats through the *browser's* locale, so `0.01`
 * renders as `0,01` for anyone on a comma locale — wrong for an ETH amount
 * and out of CSS's reach. Driving the text ourselves keeps one canonical
 * format, and the ARIA role keeps the semantics.
 */
export function ScrubField({ label, value, onChange, min, max, step = 1, suffix, hint, error }: ScrubFieldProps) {
  const id = useId()
  const describedById = `${id}-description`
  const inputRef = useRef<HTMLInputElement>(null)
  /**
   * How far the pointer has travelled in the current scrub, in pixels.
   *
   * `null` when nothing is being scrubbed. While it holds a number the
   * calibration strip is out and shifted by it, so the ticks slide under
   * the figure at exactly the rate the value is changing — the drag reads
   * as a measurement being taken rather than a number being nudged.
   */
  const [scrubOffset, setScrubOffset] = useState<number | null>(null)
  const scrubbing = scrubOffset !== null

  /**
   * The text being edited. Resynced when the value changes from outside — a
   * scrub, a step, a clamp — but left alone while the creator types, so a
   * half-finished "0." is not rewritten under the cursor.
   */
  const [draft, setDraft] = useState(() => String(value))
  useEffect(() => {
    setDraft((current) => (Number(current) === value && current.trim() !== '' ? current : String(value)))
  }, [value])

  const clamp = useCallback(
    (next: number): number => {
      if (min !== undefined && next < min) return min
      if (max !== undefined && next > max) return max
      return next
    },
    [min, max],
  )

  const commit = useCallback(
    (next: number) => onChange(clamp(Number(next.toFixed(decimalsOf(step))))),
    [clamp, onChange, step],
  )

  const stepBy = (direction: 1 | -1) => commit(value + direction * step)

  /**
   * The press that might become a drag.
   *
   * Nothing is decided here: the listeners live on the window until the
   * pointer either travels far enough to be a scrub or is released as a
   * click. Deciding on `pointerdown` is what makes controls like this
   * impossible to type into — the caret never lands because the press was
   * already claimed.
   */
  const handlePointerDown = (event: PointerEvent<HTMLInputElement>) => {
    // Secondary and middle presses are not scrubs; a pointer event with no
    // `button` at all (a synthesised one) is treated as primary.
    if (event.button > 0) return
    const startX = event.clientX
    const startValue = value
    let dragging = false

    const move = (moveEvent: globalThis.PointerEvent) => {
      const dx = moveEvent.clientX - startX
      if (!dragging) {
        if (Math.abs(dx) < DRAG_THRESHOLD) return
        dragging = true
        // A scrub is not a text edit: take the caret away so the figure
        // reads as a value being moved rather than a string being typed.
        inputRef.current?.blur()
      }
      setScrubOffset(dx)
      commit(startValue + Math.round(dx / PX_PER_STEP) * step)
    }

    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setScrubOffset(null)
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const handleText = (text: string) => {
    // Only what can grow into a number, so a stray character never reaches
    // the config as NaN.
    if (text !== '' && !/^-?\d*\.?\d*$/.test(text)) return
    setDraft(text)
    const parsed = Number(text)
    onChange(text === '' || Number.isNaN(parsed) ? 0 : parsed)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    stepBy(event.key === 'ArrowUp' ? 1 : -1)
  }

  const atMin = min !== undefined && value <= min
  const atMax = max !== undefined && value >= max

  return (
    <div className={`${styles.field} ${error ? styles.invalid : ''} ${scrubbing ? styles.scrubbing : ''}`}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <div className={styles.control} style={{ '--scrub': scrubOffset ?? 0 } as CSSProperties}>
        <input
          id={id}
          ref={inputRef}
          className={styles.input}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          role="spinbutton"
          value={draft}
          aria-valuenow={value}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedById}
          onPointerDown={handlePointerDown}
          onChange={(event) => handleText(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        {suffix ? <span className={styles.suffix}>{suffix}</span> : null}
        <span className={styles.stepper}>
          <button
            type="button"
            className={styles.step}
            onClick={() => stepBy(-1)}
            disabled={atMin}
            aria-label={`Decrease ${label}`}
          >
            −
          </button>
          <button
            type="button"
            className={styles.step}
            onClick={() => stepBy(1)}
            disabled={atMax}
            aria-label={`Increase ${label}`}
          >
            +
          </button>
        </span>
        {/*
          ТЗ §3, §10 — the calibration line, out only while the value is
          being scrubbed. It is the difference between "a number went up"
          and "a measurement was taken": the ticks travel with the pointer,
          so the figure has a visible scale behind it for exactly as long as
          somebody is moving along one, and none of the retro-HUD clutter
          that comes from leaving ticks under every field permanently.
        */}
        <span className={styles.calibration} aria-hidden="true" />
        <span className={styles.edge} aria-hidden="true" />
      </div>
      <span id={describedById} className={styles.note} role={error ? 'alert' : undefined}>
        {error ?? hint}
      </span>
    </div>
  )
}

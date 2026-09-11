import { useId, type ReactNode } from 'react'
import { formatDeadlineParts } from '../../utils/format'
import styles from './DeadlineField.module.css'

export interface DeadlineFieldProps {
  label: string
  /** The moment, in ms. */
  value: number
  onChange: (ms: number) => void
  hint?: ReactNode
  /** Replaces the hint and switches the control to its error state. */
  error?: string
}

/**
 * What a `datetime-local` input holds for an instant, in local time.
 *
 * The guard is load-bearing rather than defensive: `toISOString` *throws*
 * on an invalid date, and a throw during render unmounts the tree. That is
 * how clearing the picker used to blank the entire page — not a styling
 * failure, a crash.
 */
function toDatetimeLocalValue(ms: number): string {
  if (!Number.isFinite(ms)) return ''
  return new Date(ms - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

/**
 * ТЗ §9 — the deadline as a readout with a picker behind it, rather than a
 * SaaS date box.
 *
 * The native input is still the control: it is stretched over the whole
 * field at zero opacity, so a click opens the platform's own date-time
 * picker, the keyboard reaches it, and the value it produces is the one the
 * browser validated. What the creator sees is the moment set in the
 * interface's own type — `02 SEP 2026` over `11:12` — instead of the
 * browser's segmented widget, which is the one part of a form no stylesheet
 * can reach.
 *
 * A transparent input rather than a custom calendar because a hand-rolled
 * picker would have to re-earn everything the platform already gives away:
 * locale, time zone, touch, screen readers, and the mobile date wheel.
 */
export function DeadlineField({ label, value, onChange, hint, error }: DeadlineFieldProps) {
  const id = useId()
  const describedById = `${id}-description`
  const { date, time } = formatDeadlineParts(value)

  return (
    <div className={`${styles.field} ${error ? styles.invalid : ''}`}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <div className={styles.control}>
        <span className={styles.readout} aria-hidden="true">
          <span className={styles.date}>{date}</span>
          <span className={styles.time}>{time}</span>
        </span>
        {/* A calendar, drawn rather than typed: the glyph fonts disagree on. */}
        <svg className={styles.glyph} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <rect x="1.5" y="3" width="13" height="11" rx="1.5" />
          <path d="M1.5 6.5h13M5 1.5v3M11 1.5v3" />
        </svg>
        <input
          id={id}
          className={styles.input}
          type="datetime-local"
          value={toDatetimeLocalValue(value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedById}
          onChange={(event) => {
            const next = new Date(event.target.value).getTime()
            if (Number.isFinite(next)) {
              onChange(next)
              return
            }
            /*
             * The picker's own Clear button, and any partial entry the
             * browser hands over mid-edit.
             *
             * Both produce an empty string, and `new Date('').getTime()` is
             * `NaN` — which every downstream comparison silently accepts,
             * every formatter renders as "NaN undefined NaN", and
             * `toISOString` throws on. So the edit is refused here, at the
             * only place that can tell an empty picker from a real moment.
             *
             * An operation has no deadline-less state to clear *to*: the
             * config types it as a number and the contract closes
             * applications on a block derived from it. Offering an empty
             * one is the platform widget's idea, not the model's.
             *
             * Written straight back to the DOM rather than left for the next
             * render, because refusing the edit means no state changed and
             * there may not *be* a next render — the input would sit empty
             * while the readout above it still showed the real deadline.
             */
            event.target.value = toDatetimeLocalValue(value)
          }}
        />
        <span className={styles.edge} aria-hidden="true" />
      </div>
      <span id={describedById} className={styles.note} role={error ? 'alert' : undefined}>
        {error ?? hint}
      </span>
    </div>
  )
}

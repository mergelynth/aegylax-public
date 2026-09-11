import { motion, type HTMLMotionProps } from 'motion/react'
import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { BusySweep } from '../../motion/BusySweep'
import { RippleLayer } from '../../motion/RippleLayer'
import { useRipple } from '../../motion/useRipple'
import { prefersReducedMotion } from '../../motion/prefersReducedMotion'
import styles from './Button.module.css'

/**
 * ТЗ §10 — what a button is doing, in the three states its motion cares
 * about.
 *
 * Deliberately not `TxLifecycleStatus`. That type has five members and two
 * of them (`preparing` and `pending`) look identical from here — both mean
 * "waiting, do not press again" — while `failed` means "idle, and there is
 * an error message somewhere else on screen". Mapping the lifecycle down to
 * these three is the call site's job, because only the call site knows
 * which of its states deserves which label (ТЗ §9).
 */
export type ButtonActivity = 'idle' | 'busy' | 'success'

export interface ButtonProps extends Omit<HTMLMotionProps<'button'>, 'children'> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
  size?: 'medium' | 'small'
  fullWidth?: boolean
  children?: ReactNode
  /** ТЗ §8-§10 — drives the busy sweep, the completion tick, and disabling. */
  activity?: ButtonActivity
  /**
   * What to say while busy. ТЗ §9 wants the wait *narrated* — "Preparing…",
   * then "Confirming" — rather than the label freezing in place, so
   * this is usually derived from the caller's own transaction status.
   */
  busyLabel?: ReactNode
  /**
   * ТЗ §9 — how long the press must be held before it counts, in ms.
   *
   * Reserved for the irreversible ones: Launch Operation spends a start pool
   * plus the protocol's creation fee, and a hold is the difference between
   * a decision and a stray click on a dialog somebody was reading. Zero or
   * omitted keeps the ordinary click, and callers are expected to drop back
   * to zero when the press cannot succeed anyway — being made to hold for
   * two seconds only to be told a field is wrong is a worse confirmation
   * than none.
   */
  holdMs?: number
  /** What the button says while it is being held. */
  holdLabel?: ReactNode
}

/**
 * How long an abandoned hold keeps its instruction on the button.
 *
 * The hold itself is a wait the player has to mean — two seconds on
 * Launch, with a bar filling the button for the whole of it. A click that
 * fails the hold used to snap the label back the instant the pointer came
 * up, which made "Hold to launch" a flash too brief to read. The action
 * still does not fire; the words stay until they can be understood.
 */
const HOLD_HINT_MS = 1600

/**
 * ТЗ §6-§7 — hover and press as Motion gestures.
 *
 * `whileHover` and `whileTap` rather than `:hover` / `:active` because they
 * are *gesture* state rather than selector state, and the difference shows
 * in the cases selectors get wrong: `whileTap` releases when the pointer is
 * dragged off the button or the gesture is cancelled, and it fires for a
 * keyboard activation too, which `:active` does not do consistently across
 * browsers. The spring on the way back is the other half — a press that
 * eases back reads as an animation, one that springs reads as a control.
 *
 * The amounts are ТЗ's: 1.02 on hover, 0.97 on press. Both are small enough
 * to be felt rather than watched, which is the entire brief.
 */
const HOVER = { scale: 1.02 }
const PRESS = { scale: 0.97 }
const SPRING = { type: 'spring', stiffness: 520, damping: 30, mass: 0.6 } as const

/**
 * ТЗ §10 — one interaction system for every button in the product.
 *
 * Idle, hover, press, loading and completion all live here rather than at
 * the call sites, so a button added next year behaves like the ones added
 * today without anybody having to remember how. The ripple (ТЗ §14 of the
 * motion spec) is part of the same bargain.
 *
 * Everything is additive: the gestures never call `preventDefault`, the
 * ripple schedules its own cleanup, and the `onClick` that actually does
 * something is untouched. A button is exactly as functional mid-animation
 * as it is at rest.
 */
export function Button({
  variant = 'secondary',
  size = 'medium',
  fullWidth,
  className,
  children,
  activity = 'idle',
  busyLabel,
  holdMs = 0,
  holdLabel,
  onPointerDown,
  onPointerUp,
  onPointerLeave,
  onClick,
  disabled,
  ...props
}: ButtonProps) {
  const { ripples, spawnRipple } = useRipple()
  const busy = activity === 'busy'
  // A busy button must not accept a second press, and a caller that already
  // disables its own button must not have that undone.
  const inert = disabled || busy

  /**
   * ТЗ §9 — the hold, and the one place it is implemented.
   *
   * `holding` drives the signal progression across the button; the timer is
   * what actually fires the action. A release, a pointer leaving the button,
   * or the button going inert cancels both — a hold that has been abandoned
   * must not complete after the fact, which is the failure this pattern
   * exists to prevent in the first place.
   *
   * An abandoned hold still *says* it was a hold. `holdHint` keeps the
   * instruction on the button after the press, so a click that was too
   * short to count is not also too short to read. The progression bar does
   * not linger with it: a frozen half-fill looks like a stall, and the
   * words are the part that has to be understood.
   *
   * **The keyboard never has to hold.** Requiring a timed press to reach an
   * action puts it out of range for anybody using switch access, voice
   * control or a keyboard, so `onClick` still fires on activation there.
   * The hold is a guard against the *slip* — a stray click on a dialog
   * somebody was reading — not an authentication, and it buys nothing worth
   * locking people out for.
   */
  const [holding, setHolding] = useState(false)
  const [holdHint, setHoldHint] = useState(false)
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const holds = holdMs > 0 && !inert
  const showHoldLabel = (holding || holdHint) && holdLabel

  const clearHint = useCallback(() => {
    if (hintTimer.current !== null) {
      clearTimeout(hintTimer.current)
      hintTimer.current = null
    }
    setHoldHint(false)
  }, [])

  const cancelHold = useCallback(
    (linger = false) => {
      const abandoned = holdTimer.current !== null
      if (holdTimer.current !== null) {
        clearTimeout(holdTimer.current)
        holdTimer.current = null
      }
      setHolding(false)
      if (!linger || !abandoned || !holdLabel) return
      setHoldHint(true)
      if (hintTimer.current !== null) clearTimeout(hintTimer.current)
      hintTimer.current = setTimeout(() => {
        hintTimer.current = null
        setHoldHint(false)
      }, HOLD_HINT_MS)
    },
    [holdLabel],
  )

  // A button that goes busy or disabled mid-hold takes the hold with it.
  useEffect(() => {
    if (!inert) return
    cancelHold()
    clearHint()
  }, [inert, cancelHold, clearHint])

  useEffect(
    () => () => {
      cancelHold()
      clearHint()
    },
    [cancelHold, clearHint],
  )

  const classes = [
    styles.button,
    variant === 'primary' ? styles.primary : '',
    variant === 'danger' ? styles.danger : '',
    variant === 'ghost' ? styles.ghost : '',
    size === 'small' ? styles.small : '',
    fullWidth ? styles.fullWidth : '',
    busy ? styles.busy : '',
    activity === 'success' ? styles.success : '',
    className,
  ]
    .filter(Boolean)
    .join(' ')

  /*
   * ТЗ §20 — with motion off the gestures simply do not exist. Passing
   * `undefined` leaves the element with no gesture state at all, which is a
   * different and better thing from animating it to a scale of 1: there is
   * no transform on the element, so nothing to promote and nothing to
   * interpolate.
   */
  const still = prefersReducedMotion()

  return (
    <motion.button
      className={classes}
      disabled={inert}
      aria-busy={busy || undefined}
      whileHover={still || inert ? undefined : HOVER}
      whileTap={still || inert ? undefined : PRESS}
      transition={SPRING}
      onPointerDown={(event) => {
        if (!inert) spawnRipple(event)
        /*
         * Anything that is not a secondary or middle press starts the hold.
         * Written this way rather than `=== 0` because `button` is absent on
         * a synthesised pointer event — jsdom has no `PointerEvent`, and a
         * platform that omits it should still be able to hold a button down.
         */
        if (holds && !(event.button > 0)) {
          clearHint()
          setHolding(true)
          holdTimer.current = setTimeout(() => {
            holdTimer.current = null
            setHolding(false)
            onClick?.(event as unknown as Parameters<NonNullable<typeof onClick>>[0])
          }, holdMs)
        }
        onPointerDown?.(event)
      }}
      onPointerUp={(event) => {
        cancelHold(true)
        onPointerUp?.(event)
      }}
      onPointerLeave={(event: PointerEvent<HTMLButtonElement>) => {
        cancelHold(true)
        onPointerLeave?.(event)
      }}
      /*
       * With a hold configured, the pointer's click is the hold's to grant:
       * the timer above fires the action, so a plain press that was released
       * early must do nothing. Keyboard activation still arrives here as a
       * click with no preceding pointer sequence, and is passed straight
       * through — see the note on `holding`.
       */
      onClick={holds ? (event) => (event.detail === 0 ? onClick?.(event) : undefined) : onClick}
      {...props}
    >
      <span className={styles.label}>
        {showHoldLabel ? holdLabel : busy && busyLabel ? busyLabel : children}
      </span>
      {/*
        ТЗ §9 — the hold, shown as a bar filling the button rather than a
        second control appearing. It is drawn behind the label and clipped to
        the button's own silhouette, so nothing about the row moves while it
        runs. The bar unmounts the moment the hold is abandoned — a frozen
        half-fill would look stalled — and the label is what lingers.
      */}
      {holding ? (
        <motion.span
          className={styles.holdProgress}
          data-hold-progress=""
          aria-hidden="true"
          initial={{ scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ duration: holdMs / 1000, ease: 'linear' }}
        />
      ) : null}
      {/*
        ТЗ §8, §10 — the wait, shown rather than implied, and shown the same
        way every other waitable control in the app shows it. It sits behind
        the label rather than after it, so a button that switches to
        "Confirming" is still the width it was and the row it lives
        in does not reflow the moment somebody presses something.
      */}
      {busy ? <BusySweep /> : null}
      <RippleLayer ripples={ripples} />
    </motion.button>
  )
}

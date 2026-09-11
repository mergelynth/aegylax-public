import { useState, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { prefersReducedMotion } from '../../motion/prefersReducedMotion'
import styles from './Modal.module.css'

export interface ModalProps {
  title: string
  /**
   * Status element rendered beside the title (e.g. a live countdown).
   * Deliberately outside the heading and outside `aria-label`: the
   * dialog's accessible name must stay stable while it ticks.
   */
  headerAccessory?: ReactNode
  onClose: () => void
  /**
   * Locks the × while a spend is in flight. Cancel in the content is the
   * caller's to disable; this is the other way out of the same dialog, and
   * dismissing it mid-confirm would hide a wallet prompt the player still
   * has to answer.
   */
  closeDisabled?: boolean
  children: ReactNode
}

/**
 * How far the dialog is allowed to travel from whatever opened it.
 *
 * A third of the distance, not all of it. A dialog that flies the whole way
 * from a control in the corner of the screen to the middle of it is a long
 * diagonal for the eye to follow and the form arrives already late; a third
 * is enough to say *this came from there* and is over before the reader has
 * finished moving their eyes. The uniform scale is the other half of that
 * sentence: it opens slightly small, but never squashed — a box tweened
 * from a button's exact proportions distorts every line of type inside it,
 * which is the classic way this effect goes wrong.
 */
const REACH = 0.32

/**
 * Where the dialog comes from: the control that opened it.
 *
 * Read from `document.activeElement` during the first render, which is
 * exactly the moment it is still the button that was pressed — no origin
 * has to be threaded through the store, and every trigger in the product
 * gets this for free, including ones that do not exist yet.
 *
 * It fails softly and deliberately in the two cases where that is not true:
 * Safari does not focus a button on click, and a modal opened after a route
 * change (the docs CTA) has no live trigger left. Both land on `null`, and
 * a null origin opens from the middle of the screen — which is where the
 * dialog is, so it simply scales up in place.
 */
function openedFrom(): { x: number; y: number } | null {
  if (typeof document === 'undefined' || prefersReducedMotion()) return null

  const trigger = document.activeElement
  if (!(trigger instanceof HTMLElement) || trigger === document.body) return null

  const box = trigger.getBoundingClientRect()
  if (box.width === 0 && box.height === 0) return null

  return {
    x: (box.left + box.width / 2 - window.innerWidth / 2) * REACH,
    y: (box.top + box.height / 2 - window.innerHeight / 2) * REACH,
  }
}

/**
 * Closes only on an explicit choice — the × here, or whatever actions the
 * content itself provides (Cancel, submit). Clicking the backdrop does
 * nothing on purpose: these dialogs hold work in progress, such as a
 * half-filled Defense Setup, and a stray click outside is not an intent to
 * throw it away.
 *
 * It opens *from the control that opened it* rather than appearing: the
 * backdrop fades and the dialog rises out of the button's direction on a
 * spring. That is the one thing a fade cannot say — a dialog that
 * materialises in the middle of the screen is a new context, where this is
 * the same control the reader just pressed, continued. The dialog's own
 * entrance is `transform` alone and never opacity, so the form is readable
 * on every frame of it, including the first.
 *
 * Exit is animated only where the caller wraps this in Motion's
 * `AnimatePresence` (see `HomePage`); without it the dialog is removed the
 * moment its state flips, exactly as before.
 */
export function Modal({ title, headerAccessory, onClose, closeDisabled, children }: ModalProps) {
  // Captured once, on the first render, and never recomputed: the origin is
  // a fact about the press that opened this dialog, not about where the
  // focus has wandered since.
  const [origin] = useState(openedFrom)

  /*
   * The scrim fades *in* from the stylesheet and *out* from here, and that
   * split is deliberate. An entrance written as `initial={{ opacity: 0 }}`
   * puts a real `opacity: 0` on the element until the first frame runs,
   * which is a state the dialog is genuinely invisible in — fine in a
   * browser, wrong anywhere frames do not run: a test, a print, a bot. A CSS
   * keyframe fades the same 180ms without ever leaving the element
   * transparent in its computed style. Exit has no such problem, because by
   * then the dialog is on its way out anyway.
   */
  return (
    <motion.div
      className={styles.overlay}
      role="presentation"
      initial={false}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
    >
      <motion.div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        initial={{ scale: 0.94, x: origin?.x ?? 0, y: origin?.y ?? 0 }}
        animate={{ scale: 1, x: 0, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.14, ease: 'easeIn' } }}
        transition={{ type: 'spring', stiffness: 380, damping: 32, mass: 0.9 }}
      >
        <div className={styles.header}>
          <h2 className={styles.title}>{title}</h2>
          {headerAccessory ? <div className={styles.accessory}>{headerAccessory}</div> : null}
          <button
            type="button"
            className={styles.closeButton}
            onClick={onClose}
            disabled={closeDisabled}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        {children}
      </motion.div>
    </motion.div>
  )
}

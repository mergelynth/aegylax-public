import type { ReactNode } from 'react'

/**
 * ТЗ §13, §15, §27 — "Rolling text button", as a label rather than a
 * button.
 *
 * The referenced pattern replaces one string with a second on hover. This
 * one deliberately does not: the label climbs out of its window and an
 * identical copy climbs in behind it, so the text appears to roll *in
 * place*. ТЗ §13 is explicit that the words must not change — a CTA whose
 * label swaps under the pointer is a CTA the player has to re-read before
 * pressing, and the whole value of a roll here is that it acknowledges the
 * pointer without costing a single moment of comprehension.
 *
 * The second copy is `aria-hidden` for the same reason: there is one label
 * on this control, however many times it rolls.
 *
 * The host element supplies `motion-roll-host` (the hover trigger) and the
 * window's mechanics live in `app/motion.css`, so this component is only
 * the markup shape the effect needs.
 */
export function RollingLabel({ children }: { children: ReactNode }) {
  return (
    <span className="motion-roll">
      <span className="motion-roll-track">
        <span>{children}</span>
        <span aria-hidden="true">{children}</span>
      </span>
    </span>
  )
}

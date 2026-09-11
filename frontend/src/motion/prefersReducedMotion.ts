/**
 * ТЗ — the one place the motion system asks whether it is wanted.
 *
 * The CSS half of the system answers this in a media query; the
 * JavaScript half (scrambles, counters, the magnetic signal field) has to
 * ask in code, and it has to ask the *same* question, or the page ends up
 * half still and half moving for the people who asked for it to be still.
 *
 * Queried live rather than cached in a module constant: the setting can be
 * changed while the tab is open, and a cached answer would leave this
 * session animating for someone who has just turned motion off.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

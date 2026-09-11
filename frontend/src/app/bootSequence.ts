/**
 * ТЗ §15 — the page-load entrance, and the one rule that decides when it plays.
 *
 * The sequence itself is entirely CSS (`globals.css`, "Page-load sequence").
 * All this module does is put the document into the state those rules key
 * off — `<html data-boot>` — and take it back out once the last element has
 * landed.
 *
 * Why an attribute on the document rather than state in a component: the
 * entrance belongs to the *document load*, not to any component's mount. A
 * CSS animation on a mounting element replays every time that element
 * mounts, so a hero animated on mount alone would re-run its whole sequence
 * on Docs -> Home, which is exactly what ТЗ §15 forbids. `startBootSequence`
 * is called once from `main.tsx`, which runs once per document — a reload, a
 * hard refresh, a new tab — and never on a client-side route change. Between
 * the two, the window below is the only time the rules are live.
 *
 * The elements are visible with no boot attribute present at all: the
 * keyframes only *play them in*, they never supply the resting state. So a
 * build whose JavaScript never reaches this line still shows a complete
 * page rather than an invisible one (ТЗ §14, §16).
 */

/**
 * How long the attribute stays on, in ms.
 *
 * The last things gated on the attribute are Earth's dawn, which runs
 * 400ms + 1500ms = 1900ms, and the countdown that settles on it at 1920ms;
 * this is that plus a margin. It has to outlast them — removing the
 * attribute mid-flight would cancel the fade and snap the planet to full
 * opacity.
 *
 * The wordmark deliberately runs on well past this, typing until ~3.9s. It
 * is not gated on `[data-boot]`: `NeonType` decides once, at mount, whether
 * this mount is a document load, and its letters then carry their own
 * animations. So the window can close underneath it — and should, because
 * what the window really controls is how long "this mount belongs to a
 * document load" stays true, and stretching that to four seconds to cover
 * an animation that does not need covering would mean a round trip to How
 * to Play and back replayed the whole entrance.
 */
export const BOOT_SEQUENCE_MS = 2100

/** Arms the entrance for exactly one document load. Call once, before render. */
export function startBootSequence(): void {
  const root = document.documentElement
  root.setAttribute('data-boot', '')
  window.setTimeout(() => root.removeAttribute('data-boot'), BOOT_SEQUENCE_MS)
}

/**
 * Whether the entrance is currently live — i.e. whether this is the opening
 * moment of a document load rather than an ordinary re-render.
 *
 * The CSS steps need no such check: they are scoped to `[data-boot]` and
 * simply stop applying when the attribute goes. The *JavaScript* ones do —
 * a scramble, a counter rolling up to its value, a staggered wake-up — and
 * they have to make that decision once, when they mount, not on every
 * render. Read it into state with `motion/useBootEntrance` rather than
 * calling it from a render body.
 */
export function isBootWindowOpen(): boolean {
  return typeof document !== 'undefined' && document.documentElement.hasAttribute('data-boot')
}

import { useSyncExternalStore } from 'react'

/**
 * ТЗ §7 — park work the player is not looking at.
 *
 * A background tab is suspended. A window that still has `visibilityState
 * === 'visible'` but is not focused (another app in front, two browsers
 * side by side) would otherwise keep compositing the HUD, fifty surface
 * pulses and Motion loops — that is what boils the CPU. `blur` parks
 * those. Earth's spin is exempt: it is one compositor transform, and it
 * has to keep the same face as every other client.
 */

const HIDDEN_ATTRIBUTE = 'data-hidden'

let listening = false
let lastVisible: boolean | null = null
const subscribers = new Set<(visible: boolean) => void>()

function windowHasFocus(): boolean {
  if (typeof document === 'undefined') return true
  if (typeof document.hasFocus !== 'function') return true
  return document.hasFocus()
}

/** Whether this window is the one being looked at. True outside a browser. */
export function isPageVisible(): boolean {
  if (typeof document === 'undefined') return true
  return document.visibilityState === 'visible' && windowHasFocus()
}

function publish(): void {
  const visible = isPageVisible()
  if (visible === lastVisible) return
  lastVisible = visible

  if (visible) document.documentElement.removeAttribute(HIDDEN_ATTRIBUTE)
  else document.documentElement.setAttribute(HIDDEN_ATTRIBUTE, '')

  subscribers.forEach((notify) => notify(visible))
}

/**
 * Starts watching, once per document.
 *
 * Called from `main.tsx` so the attribute is correct before the first
 * paint — a document that loads into a background tab (a restored session,
 * a middle-click, a link opened in a new tab and not switched to) should
 * never play its entrance to nobody and then be found finished. Subscribing
 * calls this too, so a consumer that mounts in a context where `main.tsx`
 * did not run still gets told.
 */
export function startVisibilityTracking(): void {
  if (listening || typeof document === 'undefined') return
  listening = true
  document.addEventListener('visibilitychange', publish)
  window.addEventListener('focus', publish)
  window.addEventListener('blur', publish)
  publish()
}

/**
 * Notifies on every change, with the new visibility.
 *
 * Deliberately not fired on subscribe: a consumer knows its own starting
 * state from `isPageVisible()` and generally has to act on it differently
 * from a change — the countdown clock, for instance, starts its interval on
 * subscribe but must also force a sample the moment the page comes back,
 * and running the same branch for both would make it sample twice on mount.
 */
export function subscribeToPageVisibility(onChange: (visible: boolean) => void): () => void {
  startVisibilityTracking()
  subscribers.add(onChange)
  return () => {
    subscribers.delete(onChange)
  }
}

function subscribeStore(onChange: () => void): () => void {
  return subscribeToPageVisibility(() => onChange())
}

/** React: whether this tab is currently on screen. */
export function usePageVisible(): boolean {
  return useSyncExternalStore(subscribeStore, isPageVisible, () => true)
}

import { useState } from 'react'
import { isBootWindowOpen } from '../app/bootSequence'

/**
 * ТЗ §32 — "does *this* mount belong to a document load?", answered once.
 *
 * Every JavaScript-driven step of the entrance (the scrambles, the counters,
 * the signals waking up) asks this, and they all have to agree: an element
 * that decides it is booting must go on believing that for the whole of its
 * animation, even though the window closes underneath it partway through.
 * Reading the attribute in a state initialiser pins the answer to mount and
 * makes it stable for the life of the component.
 *
 * It is also what keeps a route change quiet. Home -> How to Play -> Home
 * re-mounts all of this; by then the attribute is long gone, so every one of
 * these components mounts already finished and simply renders its text.
 */
export function useBootEntrance(): boolean {
  const [entering] = useState(isBootWindowOpen)
  return entering
}
